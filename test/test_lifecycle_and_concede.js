/**
 * test/test_lifecycle_and_concede.js
 * Acceptance Test Suite: Match Lifecycle, Concession, Multiplayer Turn Ring & Lockout
 *
 * Verifies:
 * - Test 1: 4-Player Pod Concession & Immediate Turn/Priority Hand-off to Next Alive Player
 * - Test 2: Sequential Concession to Last Player Standing -> Automatic GAME_OVER & Winner Detection
 * - Test 3: TabRouter Lockout Guard during Match & Post-Concede / Post-Game Unlock
 * - Test 4: Boot State & Header Active Player Badge Hidden in Lobby
 * - Test 5: Multiplayer 2 to 6 Player Dice Roll-Off Turn Ring Initialization
 */

import assert from 'node:assert';
import {
  TabletopStateManager,
  PriorityStateMachine,
  RPMAppController,
  TabRouter,
  TABS,
  TurnRollOffManager
} from '../src/index.js';

// ============================================================================
// Lightweight Mock DOM
// ============================================================================

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

class MockElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.id = '';
    this.className = '';
    this.classList = {
      _classes: new Set(),
      add: (...cls) => cls.forEach(c => this.classList._classes.add(c)),
      remove: (...cls) => cls.forEach(c => this.classList._classes.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (this.classList._classes.has(c)) this.classList._classes.delete(c);
          else this.classList._classes.add(c);
        } else if (force) {
          this.classList._classes.add(c);
        } else {
          this.classList._classes.delete(c);
        }
      },
      contains: (c) => this.classList._classes.has(c)
    };
    this.style = {};
    this.attributes = new Map();
    this.childNodes = [];
    this.children = [];
    this.parentNode = null;
    this.parentElement = null;
    this._listeners = new Map();
    this.disabled = false;
    this._textContent = '';
  }

  get textContent() {
    if (this.childNodes.length === 0) return this._textContent;
    return this.childNodes.map(c => c.textContent || '').join('');
  }

  set textContent(val) {
    this._textContent = String(val);
    this.childNodes = [];
    this.children = [];
  }

  setAttribute(name, value) {
    const val = String(value);
    this.attributes.set(name, val);
    if (name === 'id') this.id = val;
    if (name === 'class') {
      this.className = val;
      this.classList._classes = new Set(val.split(/\s+/).filter(Boolean));
    }
    if (name === 'style') {
      val.split(';').forEach(rule => {
        const [k, v] = rule.split(':').map(s => s && s.trim());
        if (k && v) this.style[k] = v;
      });
    }
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return Array.from(this.classList._classes).join(' ') || null;
    return this.attributes.get(name) || null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.parentElement = this;
    this.childNodes.push(child);
    if (child.nodeType === 1) this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) this.childNodes.splice(idx, 1);
    const cIdx = this.children.indexOf(child);
    if (cIdx !== -1) this.children.splice(cIdx, 1);
    child.parentNode = null;
    child.parentElement = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  insertBefore(newNode, refNode) {
    if (!refNode) return this.appendChild(newNode);
    const idx = this.childNodes.indexOf(refNode);
    if (idx === -1) return this.appendChild(newNode);
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    newNode.parentNode = this;
    newNode.parentElement = this;
    this.childNodes.splice(idx, 0, newNode);
    const cIdx = this.children.indexOf(refNode);
    if (cIdx !== -1 && newNode.nodeType === 1) this.children.splice(cIdx, 0, newNode);
    return newNode;
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    if (this._listeners.has(type)) this._listeners.get(type).delete(fn);
  }

  dispatchEvent(evt) {
    if (this._listeners.has(evt.type)) {
      for (const fn of this._listeners.get(evt.type)) fn.call(this, evt);
    }
    return !evt.defaultPrevented;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }

  querySelectorAll(selector) {
    const results = [];
    const match = (elem) => {
      if (selector.startsWith('#') && elem.id === selector.slice(1)) return true;
      if (selector.startsWith('.') && elem.classList.contains(selector.slice(1))) return true;
      if (elem.tagName.toLowerCase() === selector.toLowerCase()) return true;
      return false;
    };
    const walk = (node) => {
      if (node.nodeType === 1 && match(node)) results.push(node);
      for (const ch of node.children) walk(ch);
    };
    for (const ch of this.children) walk(ch);
    return results;
  }

  set innerHTML(html) {
    this.childNodes = [];
    this.children = [];
    if (!html || typeof html !== 'string') return;
    this._parseAndPopulate(html);
  }

  _parseAndPopulate(html) {
    let current = this;
    const tagRegex = /<(\/)?([a-zA-Z0-9\-]+)([^>]*)>|([^<]+)/g;
    let match;
    while ((match = tagRegex.exec(html)) !== null) {
      if (match[4]) {
        current.childNodes.push({
          nodeType: 3,
          textContent: match[4],
          parentNode: current,
          parentElement: current
        });
      } else {
        const isClose = Boolean(match[1]);
        const tagName = match[2];
        const attrStr = match[3] || '';
        if (isClose) {
          if (current.parentNode) current = current.parentNode;
        } else {
          const isVoid = VOID_TAGS.has(tagName.toLowerCase()) || attrStr.trim().endsWith('/');
          const elem = new MockElement(tagName);
          const attrRegex = /([a-zA-Z0-9\-_:@]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
          let aMatch;
          while ((aMatch = attrRegex.exec(attrStr)) !== null) {
            const aName = aMatch[1];
            const aVal = aMatch[2] !== undefined ? aMatch[2] : (aMatch[3] !== undefined ? aMatch[3] : (aMatch[4] !== undefined ? aMatch[4] : ''));
            elem.setAttribute(aName, aVal);
          }
          current.appendChild(elem);
          if (!isVoid) current = elem;
        }
      }
    }
  }
}

class MockDocument extends MockElement {
  constructor() {
    super('#document');
    this.body = new MockElement('BODY');
    this.head = new MockElement('HEAD');
    this.appendChild(this.head);
    this.appendChild(this.body);
  }
  createElement(tag) { return new MockElement(tag); }
}

function setupMockDOM() {
  const doc = new MockDocument();
  globalThis.document = doc;
  globalThis.window = {
    document: doc,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { host: 'localhost:3000', protocol: 'http:' }
  };
  return doc;
}

// ============================================================================
// Test Suite Runner
// ============================================================================

async function runTests() {
  console.log('==================================================================');
  console.log('  RUNNING MATCH LIFECYCLE & CONCESSION ACCEPTANCE TEST SUITE');
  console.log('==================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  \x1b[32m✔ [PASS]\x1b[0m ${name}`);
      passed++;
    } catch (err) {
      console.error(`  \x1b[31m✖ [FAIL]\x1b[0m ${name}`);
      console.error(err);
      failed++;
    }
  }

  // --------------------------------------------------------------------------
  // Test 1: 4-Player Pod Turn Rotation & Priority Hand-off on Concede
  // --------------------------------------------------------------------------
  await test('Test 1: 4-Player pod concession by active player rotates turn and priority to next alive player (P2)', async () => {
    const players = ['p1', 'p2', 'p3', 'p4'];
    const tabletopState = new TabletopStateManager({ players });
    const priorityMachine = new PriorityStateMachine({
      players,
      activePlayerId: 'p1',
      priorityPlayerId: 'p1',
      startingPlayerId: 'p1'
    });
    tabletopState.priorityMachine = priorityMachine;

    // Verify initial preconditions
    assert.strictEqual(priorityMachine.activePlayerId, 'p1', 'P1 must start as active player');
    assert.strictEqual(priorityMachine.priorityPlayerId, 'p1', 'P1 must hold priority');

    // Track events
    let eliminatedEvent = null;
    tabletopState.on('PLAYER_ELIMINATED', (evt) => { eliminatedEvent = evt; });

    // P1 concedes
    const result = tabletopState.eliminatePlayer('p1', 'CONCEDED');

    // Assertions
    assert.ok(result, 'eliminatePlayer must return an elimination summary');
    assert.strictEqual(result.eliminatedPlayerId, 'p1');
    assert.strictEqual(result.gameOver, false, 'Game must not be over with 3 remaining players');
    assert.strictEqual(result.winnerId, null, 'Winner must be null while match continues');

    assert.strictEqual(tabletopState.players.p1.isEliminated, true, 'P1 must be marked as eliminated in tabletopState');
    assert.strictEqual(priorityMachine.isPlayerEliminated('p1'), true, 'P1 must be recognized as eliminated in priorityMachine');

    // Turn and priority should have immediately rotated to P2 (next alive in clockwise ring)
    assert.strictEqual(priorityMachine.activePlayerId, 'p2', 'Turn must immediately advance to P2');
    assert.strictEqual(priorityMachine.priorityPlayerId, 'p2', 'Priority must immediately pass to P2');
    assert.strictEqual(priorityMachine.currentPhaseStep, 'UNTAP', 'New turn must begin at UNTAP');

    // Event verification
    assert.ok(eliminatedEvent, 'PLAYER_ELIMINATED event must be emitted');
    assert.strictEqual(eliminatedEvent.playerId, 'p1');
    assert.strictEqual(eliminatedEvent.reason, 'CONCEDED');

    // Living players count
    const living = Object.values(tabletopState.players).filter(p => !p.isEliminated);
    assert.strictEqual(living.length, 3, 'Must have exactly 3 players alive');
  });

  // --------------------------------------------------------------------------
  // Test 2: Sequential Concession to Last Player Standing -> Automatic GAME_OVER
  // --------------------------------------------------------------------------
  await test('Test 2: Sequential concessions leaving 1 player triggers automatic GAME_OVER & sets winner', async () => {
    const players = ['p1', 'p2', 'p3', 'p4'];
    const tabletopState = new TabletopStateManager({ players });
    const priorityMachine = new PriorityStateMachine({
      players,
      activePlayerId: 'p1',
      priorityPlayerId: 'p1',
      startingPlayerId: 'p1'
    });
    tabletopState.priorityMachine = priorityMachine;

    let gameOverEvent = null;
    tabletopState.on('GAME_OVER', (evt) => { gameOverEvent = evt; });

    // P1 concedes -> P2 becomes active
    tabletopState.eliminatePlayer('p1', 'CONCEDED');
    assert.strictEqual(priorityMachine.activePlayerId, 'p2');
    assert.strictEqual(tabletopState.isGameOver, false);

    // P2 concedes -> P3 becomes active
    const resP2 = tabletopState.eliminatePlayer('p2', 'CONCEDED');
    assert.strictEqual(resP2.gameOver, false);
    assert.strictEqual(priorityMachine.activePlayerId, 'p3');
    assert.strictEqual(tabletopState.players.p2.isEliminated, true);

    // P3 concedes -> only P4 remains alive
    const resP3 = tabletopState.eliminatePlayer('p3', 'CONCEDED');
    assert.strictEqual(resP3.gameOver, true, 'Match must be gameOver when 1 player survives');
    assert.strictEqual(resP3.winnerId, 'p4', 'Winner must be surviving player P4');

    assert.strictEqual(tabletopState.isGameOver, true, 'tabletopState.isGameOver must be true');
    assert.strictEqual(tabletopState.winnerId, 'p4', 'tabletopState.winnerId must be p4');

    // Verify GAME_OVER event payload
    assert.ok(gameOverEvent, 'GAME_OVER event must have been dispatched');
    assert.strictEqual(gameOverEvent.winnerId, 'p4');
    assert.ok(gameOverEvent.survivingPlayer, 'survivingPlayer must be attached to GAME_OVER');
  });

  // --------------------------------------------------------------------------
  // Test 3: TabRouter Lockout & Post-Concede / Post-Game Unlock
  // --------------------------------------------------------------------------
  await test('Test 3: TabRouter locks navigation to LOBBY during match, unlocks after concession', async () => {
    let lockoutBlockedTab = null;
    const router = new TabRouter({
      initialTab: TABS.ARENA,
      onLockoutBlocked: (tab) => { lockoutBlockedTab = tab; }
    });

    const activeContext = { isMatchActive: true, status: 'ACTIVE' };
    const idleContext = { isMatchActive: false, status: 'IDLE' };

    // While match is active, non-arena tabs are strictly locked
    assert.strictEqual(router.canNavigate(TABS.LOBBY, activeContext), false, 'Lobby must be blocked while match is active');
    assert.strictEqual(lockoutBlockedTab, TABS.LOBBY, 'onLockoutBlocked callback must have fired for LOBBY');
    assert.strictEqual(router.canNavigate(TABS.DECKBUILDER, activeContext), false, 'Deckbuilder must be blocked');
    assert.strictEqual(router.canNavigate(TABS.ARENA, activeContext), true, 'Arena must remain accessible during match');

    // Attempting navigation returns failure
    const navResult = router.navigate(TABS.LOBBY, activeContext);
    assert.strictEqual(navResult.success, false, 'Navigation to LOBBY must fail during match');
    assert.strictEqual(navResult.reason, 'TAB_LOCKED_ACTIVE_MATCH');

    // Spectator bypass check (INV-SPEC-1)
    assert.strictEqual(router.canNavigate(TABS.LOBBY, activeContext, true), true, 'Spectators are exempt from lockout');

    // After concession or match end:
    router.unlockAll();
    assert.strictEqual(router.canNavigate(TABS.LOBBY, idleContext), true, 'Lobby must be accessible when match is not active');
    const exitResult = router.navigate(TABS.LOBBY, idleContext);
    assert.strictEqual(exitResult.success, true, 'Navigation to LOBBY must succeed once match is idle');
    assert.strictEqual(router.getCurrentTab(), TABS.LOBBY);
  });

  // --------------------------------------------------------------------------
  // Test 4: Boot State & Header Active Player Badge Hidden in Lobby
  // --------------------------------------------------------------------------
  await test('Test 4: Header badge #active-player-badge is hidden on boot in Lobby without active match', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      initialTab: 'LOBBY',
      username: 'Bob',
      userId: 'user_bob_123'
    });
    await app.mount(container);

    // Verify Tab is LOBBY and match is not active
    assert.strictEqual(app.tabRouter.getCurrentTab(), 'LOBBY');
    assert.strictEqual(app.isMatchActive(), false, 'Match must not be active at boot in Lobby');

    const badge = container.querySelector('#active-player-badge');
    assert.ok(badge, '#active-player-badge element must exist');
    assert.strictEqual(badge.style.display, 'none', '#active-player-badge must be hidden (display: none) in Lobby');

    const activeName = container.querySelector('#active-player-name');
    assert.ok(activeName, '#active-player-name element must exist');
    assert.strictEqual(
      activeName.textContent.includes('Round 1 • Turn: Opponent'),
      false,
      'Header must not display phantom active turn in Lobby'
    );
    assert.ok(
      activeName.textContent.includes('Bob') || activeName.textContent.includes('You'),
      `Header in Lobby must show local user info, got: "${activeName.textContent}"`
    );

    // Verify that when match activates in ARENA, the badge becomes visible
    app.tabRouter.reset('ARENA');
    app.startMatch({ playerIds: ['user_bob_123', 'p2'] });
    app.reconcileDOM();

    assert.strictEqual(app.isMatchActive(), true, 'Match must now be active');
    assert.strictEqual(app.tabRouter.getCurrentTab(), 'ARENA');
    assert.strictEqual(badge.style.display, 'flex', '#active-player-badge must be visible (display: flex) during match in Arena');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // Test 5: Multiplayer 2 to 6 Player Dice Roll-Off Turn Ring Initialization
  // --------------------------------------------------------------------------
  await test('Test 5: Multiplayer roll-off establishes circular clockwise seating ring starting at winner', async () => {
    const initialSeats = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const manager = new TurnRollOffManager(initialSeats);

    // Force rolls such that p4 rolls 20, p1 rolls 15, others lower
    manager.submitRoll('p1', 15);
    manager.submitRoll('p2', 10);
    manager.submitRoll('p3', 12);
    manager.submitRoll('p4', 20); // Winner!
    manager.submitRoll('p5', 8);
    manager.submitRoll('p6', 5);

    assert.strictEqual(manager.isRoundComplete(), true);
    const evalRes = manager.evaluateRound();
    assert.strictEqual(evalRes.isComplete, true);
    assert.strictEqual(evalRes.sortedPlayers[0], 'p4', 'p4 must win the d20 roll-off');

    const winnerId = evalRes.sortedPlayers[0];
    const idx = initialSeats.indexOf(winnerId);
    const orderedRing = [...initialSeats.slice(idx), ...initialSeats.slice(0, idx)];

    // Expected circular ring starting with p4: [p4, p5, p6, p1, p2, p3]
    assert.deepStrictEqual(orderedRing, ['p4', 'p5', 'p6', 'p1', 'p2', 'p3']);

    const priorityMachine = new PriorityStateMachine({
      players: orderedRing,
      activePlayerId: winnerId,
      priorityPlayerId: winnerId,
      startingPlayerId: winnerId
    });

    assert.strictEqual(priorityMachine.activePlayerId, 'p4');
    assert.strictEqual(priorityMachine.priorityPlayerId, 'p4');
    assert.strictEqual(priorityMachine.startingPlayerId, 'p4');
    assert.strictEqual(priorityMachine.nextPlayer('p4'), 'p5');
    assert.strictEqual(priorityMachine.nextPlayer('p6'), 'p1');
  });

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n==================================================================');
  console.log(`LIFECYCLE & CONCEDE TEST RESULTS: ${passed} passed, ${failed} failed`);
  console.log('==================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Unhandled rejection in test runner:', err);
  process.exit(1);
});
