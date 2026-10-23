/**
 * test/test_pregame_turns_combat.js
 * Regression suite: CR 103 pre-game state machine, strict turn/round rotation vs Perkins AI,
 * Haste-aware attack eligibility (canDeclareAsAttacker), blocker restrictions (CR 509) and attack triggers.
 */
import assert from 'node:assert';
import {
  RPMAppController,
  TabletopStateManager,
  PriorityStateMachine,
  StackAlarmManager,
  PerkinsAgent,
  CardOverlayModal,
  ScryfallService,
  StorageAdapter,
  STARTER_DECKS,
  getHydratedCardMetadata,
  dealStartingHands,
  PermanentAlreadyTappedError,
  InsufficientManaError,
  LandLimitExceededError,
  PhaseTimingError,
  PriorityViolationError
  , PregameStateMachine, PREGAME_STATES
} from '../src/index.js';
import { canDeclareAsAttacker } from '../src/CombatDamageEngine.js';

// ============================================================================
// Robust Stack-Based Mock DOM Infrastructure
// ============================================================================

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

class MockEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.cancelable = init.cancelable ?? true;
    this.defaultPrevented = false;
    this.target = null;
    Object.assign(this, init);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}

class MockElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.id = '';
    this.className = '';
    this.value = '';
    this.disabled = false;
    this.style = {};
    this.children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.parentNode = null;
    this.attributes = {};
    this._eventListeners = new Map();
  }

  get classList() {
    return {
      add: (...cls) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        cls.forEach(c => set.add(c));
        this.className = Array.from(set).join(' ');
      },
      remove: (...cls) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        cls.forEach(c => set.delete(c));
        this.className = Array.from(set).join(' ');
      },
      toggle: (c, force) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        if (force === undefined) {
          if (set.has(c)) set.delete(c); else set.add(c);
        } else if (force) {
          set.add(c);
        } else {
          set.delete(c);
        }
        this.className = Array.from(set).join(' ');
      },
      contains: (c) => this.className.split(/\s+/).filter(Boolean).includes(c)
    };
  }

  get dataset() {
    const handler = {
      get: (_, prop) => this.getAttribute(`data-${prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}`),
      set: (_, prop, val) => {
        this.setAttribute(`data-${prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}`, val);
        return true;
      }
    };
    return new Proxy({}, handler);
  }

  setAttribute(name, val) {
    const sVal = String(val);
    this.attributes[name] = sVal;
    if (name === 'id') this.id = sVal;
    if (name === 'class') this.className = sVal;
    if (name === 'style' && typeof val === 'string') {
      const declarations = val.split(';').map(s => s.trim()).filter(Boolean);
      for (const d of declarations) {
        const [k, v] = d.split(':').map(s => s.trim());
        if (k && v) {
          const camelKey = k.replace(/-([a-z])/g, (_, m) => m.toUpperCase());
          this.style[camelKey] = v;
          this.style[k] = v;
        }
      }
    }
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return this.attributes[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'id') this.id = '';
    if (name === 'class') this.className = '';
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.parentElement = this;
    this.childNodes.push(child);
    if (child.nodeType === 1) this.children.push(child);
    return child;
  }

  prepend(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.parentElement = this;
    this.childNodes.unshift(child);
    if (child.nodeType === 1) this.children.unshift(child);
    return child;
  }

  removeChild(child) {
    const idxNode = this.childNodes.indexOf(child);
    if (idxNode !== -1) {
      this.childNodes.splice(idxNode, 1);
      child.parentNode = null;
      child.parentElement = null;
    }
    const idxChild = this.children.indexOf(child);
    if (idxChild !== -1) {
      this.children.splice(idxChild, 1);
    }
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (curr.matches && curr.matches(selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  get textContent() {
    let text = '';
    for (const node of this.childNodes) {
      text += node.textContent || '';
    }
    return text;
  }

  set textContent(val) {
    this.childNodes = [];
    this.children = [];
    if (val !== undefined && val !== null && val !== '') {
      this.childNodes.push({
        nodeType: 3,
        textContent: String(val),
        parentNode: this,
        parentElement: this
      });
    }
  }

  get innerHTML() {
    let out = '';
    for (const node of this.childNodes) {
      if (node.nodeType === 3) {
        out += node.textContent;
      } else if (node.nodeType === 1) {
        const tag = node.tagName.toLowerCase();
        let attrs = '';
        for (const [k, v] of Object.entries(node.attributes)) {
          attrs += ` ${k}="${v}"`;
        }
        if (VOID_ELEMENTS.has(tag)) {
          out += `<${tag}${attrs} />`;
        } else {
          out += `<${tag}${attrs}>${node.innerHTML}</${tag}>`;
        }
      }
    }
    return out;
  }

  set innerHTML(htmlStr) {
    this.childNodes = [];
    this.children = [];
    if (!htmlStr || typeof htmlStr !== 'string') return;
    this._parseAndPopulate(htmlStr);
  }

  _parseAndPopulate(html) {
    let current = this;
    const tagRegex = /<(\/)?([a-zA-Z0-9\-]+)([^>]*)>|([^<]+)/g;
    let match;
    while ((match = tagRegex.exec(html)) !== null) {
      if (match[4]) {
        const text = match[4];
        current.childNodes.push({
          nodeType: 3,
          textContent: text,
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
          const isVoid = VOID_ELEMENTS.has(tagName.toLowerCase()) || attrStr.trim().endsWith('/');
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

  querySelector(selector) {
    const list = this.querySelectorAll(selector);
    return list.length > 0 ? list[0] : null;
  }

  querySelectorAll(selector) {
    if (!selector || typeof selector !== 'string') return [];
    const parts = selector.trim().split(/\s+/);

    if (parts.length === 1) {
      const results = [];
      const search = (node) => {
        if (!node || !node.children) return;
        for (const child of node.children) {
          if (matchesSelector(child, parts[0])) results.push(child);
          search(child);
        }
      };
      search(this);
      return results;
    }

    const firstMatches = this.querySelectorAll(parts[0]);
    const restSelector = parts.slice(1).join(' ');
    const results = [];
    for (const fm of firstMatches) {
      const sub = fm.querySelectorAll(restSelector);
      for (const s of sub) {
        if (!results.includes(s)) results.push(s);
      }
    }
    return results;
  }

  addEventListener(type, listener) {
    if (!this._eventListeners.has(type)) {
      this._eventListeners.set(type, new Set());
    }
    this._eventListeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    if (this._eventListeners.has(type)) {
      this._eventListeners.get(type).delete(listener);
    }
  }

  click() {
    this.dispatchEvent(new MockEvent('click', { bubbles: true }));
  }

  dispatchEvent(event) {
    event.target = this;
    if (this._eventListeners.has(event.type)) {
      for (const listener of this._eventListeners.get(event.type)) {
        listener.call(this, event);
      }
    }
    if (event.bubbles && this.parentElement) {
      this.parentElement.dispatchEvent(event);
    }
    return !event.defaultPrevented;
  }
}

function matchesSelector(elem, selector) {
  if (!elem || !selector || elem.nodeType !== 1) return false;
  if (selector.startsWith('#')) {
    return elem.id === selector.slice(1);
  }
  if (selector.startsWith('.')) {
    return elem.classList.contains(selector.slice(1));
  }
  const attrMatch = selector.match(/^([a-z0-9-]+)?\[([a-z0-9-_]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/i);
  if (attrMatch) {
    const [, tag, attr, v1, v2, v3] = attrMatch;
    if (tag && elem.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    const expectedVal = v1 ?? v2 ?? v3;
    if (expectedVal !== undefined) {
      return elem.getAttribute(attr) === expectedVal;
    }
    return elem.getAttribute(attr) !== null;
  }
  return elem.tagName.toLowerCase() === selector.toLowerCase();
}

class MockDocument {
  constructor() {
    this.body = new MockElement('body');
    this._listeners = new Map();
  }

  createElement(tagName) {
    return new MockElement(tagName);
  }

  getElementById(id) {
    return this.body.querySelector(`#${id}`);
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    if (this._listeners.has(type)) this._listeners.get(type).delete(listener);
  }
}

function setupMockDOM() {
  const doc = new MockDocument();
  globalThis.document = doc;
  globalThis.window = {
    document: doc,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: {
      _data: new Map(),
      getItem(k) { return this._data.get(k) || null; },
      setItem(k, v) { this._data.set(k, String(v)); },
      removeItem(k) { this._data.delete(k); },
      clear() { this._data.clear(); }
    }
  };
  return doc;
}

// ============================================================================
// Test Runner Harness
// ============================================================================

let totalPassed = 0;
let totalFailed = 0;

async function test(tcId, name, fn) {
  try {
    await fn();
    console.log(`  ✔ [PASS] ${tcId}: ${name}`);
    totalPassed++;
  } catch (err) {
    console.error(`  ✖ [FAIL] ${tcId}: ${name}`);
    console.error(`    ${err.message}`);
    if (err.stack) {
      const frames = err.stack.split('\n').slice(1, 4).join('\n');
      console.error(`    ${frames}`);
    }
    totalFailed++;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mkCard = (id, name, extra = {}) => ({ instanceId: id, name, typeLine: 'Creature — Test', power: 2, toughness: 2, ...extra });

async function run() {
  // ---------------- SPEC 1: Pre-game ----------------
  await test('TC-PREGAME-01', 'Roll -> choose order -> mulligan -> GAME_ACTIVE (CR 103)', async () => {
    const psm = new PriorityStateMachine({ players: ['p1', 'p2'] });
    const tsm = new TabletopStateManager({ players: ['p1', 'p2'], priorityMachine: psm });
    psm.tabletopState = tsm; tsm.priorityMachine = psm;
    for (const pid of ['p1', 'p2']) {
      const p = tsm.getPlayer(pid);
      for (let i = 0; i < 40; i++) p.library.push({ instanceId: `${pid}_c${i}`, name: `C${i}`, typeLine: 'Land' });
    }
    const pg = new PregameStateMachine({ players: ['p1', 'p2'], tabletopState: tsm, priorityMachine: psm });
    assert.strictEqual(pg.state, PREGAME_STATES.PREGAME_ROLL);
    const roll = pg.dispatch('EXECUTE_STARTING_ROLL', { rolls: { p1: 5, p2: 17 } });
    assert.strictEqual(roll.winnerId, 'p2');
    assert.strictEqual(pg.state, PREGAME_STATES.PREGAME_CHOOSE_ORDER);
    assert.throws(() => pg.dispatch('SELECT_PLAY_OR_DRAW', { playerId: 'p1', choice: 'PLAY' }), /choicePriority/);
    pg.dispatch('SELECT_PLAY_OR_DRAW', { playerId: 'p2', choice: 'DRAW' });
    assert.strictEqual(pg.startingPlayerId, 'p1', 'Winner chose DRAW -> opponent starts');
    assert.strictEqual(psm.activePlayerId, 'p1');
    assert.strictEqual(pg.state, PREGAME_STATES.PREGAME_MULLIGAN);
    assert.strictEqual(tsm.getPlayer('p1').hand.length, 7);
    assert.strictEqual(tsm.getPlayer('p2').hand.length, 7);
    assert.strictEqual(pg.currentDecidingPlayerId, 'p1', 'Starting player decides first');
    assert.throws(() => pg.dispatch('DECIDE_MULLIGAN', { playerId: 'p2', keep: true }));
    // P1 mulligans once, must bottom exactly 1
    const r = pg.dispatch('DECIDE_MULLIGAN', { playerId: 'p1', keep: false });
    assert.strictEqual(r.mulliganCount, 1);
    assert.strictEqual(tsm.getPlayer('p1').hand.length, 7);
    assert.throws(() => pg.dispatch('DECIDE_MULLIGAN', { playerId: 'p1', keep: true }), /PUT_ON_BOTTOM/);
    assert.throws(() => pg.dispatch('PUT_ON_BOTTOM', { playerId: 'p1', cardIds: [] }));
    pg.dispatch('PUT_ON_BOTTOM', { playerId: 'p1', cardIds: [tsm.getPlayer('p1').hand[0].instanceId] });
    assert.strictEqual(tsm.getPlayer('p1').hand.length, 6);
    pg.dispatch('DECIDE_MULLIGAN', { playerId: 'p1', keep: true });
    assert.strictEqual(pg.currentDecidingPlayerId, 'p2');
    const done = pg.dispatch('DECIDE_MULLIGAN', { playerId: 'p2', keep: true });
    assert.strictEqual(done.state, PREGAME_STATES.GAME_ACTIVE);
    assert.strictEqual(psm.turnNumber, 1);
    assert.strictEqual(psm.roundNumber, 1);
    assert.strictEqual(psm.activePlayerId, 'p1');
    assert.strictEqual(psm.currentPhaseStep, 'PRECOMBAT_MAIN');
    assert.strictEqual(tsm.getPlayer('p1').hand.length, 6, 'Starting player skips turn-1 draw (CR 103.8a)');
  });

  await test('TC-PREGAME-02', 'Roll ties are re-rolled; seeded rng is deterministic', async () => {
    const seq = [10, 10, 3, 9];
    const mk = () => { let i = 0; return () => (seq[i++ % seq.length] - 1) / 20 + 0.001; };
    const a = new PregameStateMachine({ players: ['p1', 'p2'], rng: mk() }).dispatch('EXECUTE_STARTING_ROLL');
    const b = new PregameStateMachine({ players: ['p1', 'p2'], rng: mk() }).dispatch('EXECUTE_STARTING_ROLL');
    assert.notStrictEqual(a.rolls.p1, a.rolls.p2);
    assert.deepStrictEqual(a.rolls, b.rolls);
  });

  // ---------------- SPEC 2: Turn pointers ----------------
  await test('TC-TURN-01', 'Strict alternation, 1 land/turn and turn/round invariants vs Perkins AI', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div'); doc.body.appendChild(container);
    const app = new RPMAppController({ container, autoConnect: false, myPlayerId: 'p1', playerIds: ['p1', 'p2_perkins'] });
    await app.mount(container);
    await app.startPerkinsMatch({ thinkingDelayMs: 0, coachEnabled: false });
    const psm = app.priorityMachine, tsm = app.tabletopState;
    for (let i = 0; i < 20; i++) tsm.getPlayer('p1').library.push({ instanceId: `h_lib_${i}`, name: 'Mountain', typeLine: 'Basic Land — Mountain' });
    const seen = []; let lastTurn = psm.turnNumber; let lastActive = psm.activePlayerId; seen.push(lastActive);
    const landsAtTurnStart = {};
    for (let i = 0; i < 400 && psm.turnNumber < 7; i++) {
      await sleep(psm.activePlayerId === 'p1' ? 5 : 40);
      if (psm.turnNumber !== lastTurn) {
        assert.strictEqual(psm.turnNumber, lastTurn + 1, 'turnNumber increments by exactly 1');
        assert.notStrictEqual(psm.activePlayerId, lastActive, 'activePlayerId must alternate');
        assert.strictEqual(psm.roundNumber, Math.ceil(psm.turnNumber / 2));
        lastTurn = psm.turnNumber; lastActive = psm.activePlayerId; seen.push(lastActive);
        landsAtTurnStart[lastTurn] = { p1: tsm.getPlayer('p1').battlefield.lands.length, bot: tsm.getPlayer('p2_perkins').battlefield.lands.length };
      }
      if (psm.priorityPlayerId === 'p1') {
        const p1 = tsm.getPlayer('p1');
        if (psm.currentPhaseStep === 'PRECOMBAT_MAIN') {
          const land = p1.hand.find(c => /land/i.test(c.typeLine || ''));
          if (land) { try { await app.dispatchAction({ type: 'PLAY_LAND', playerId: 'p1', card: land, payload: { playerId: 'p1', card: land, instanceId: land.instanceId } }, { origin: 'LOCAL' }); } catch (_) {} }
        }
        try { await app.dispatchAction({ type: 'PASS_PRIORITY', playerId: 'p1' }, { origin: 'LOCAL' }); } catch (_) {}
      }
    }
    assert.ok(psm.turnNumber >= 7, `match must progress through turns (reached ${psm.turnNumber}, active=${psm.activePlayerId}, prio=${psm.priorityPlayerId}, step=${psm.currentPhaseStep}, stack=${psm.stack.length})`);
    seen.forEach((pid, idx) => { if (idx > 0) assert.notStrictEqual(pid, seen[idx - 1]); });
    for (const t of Object.keys(landsAtTurnStart).map(Number)) {
      const prev = landsAtTurnStart[t - 1];
      if (!prev) continue;
      assert.ok(landsAtTurnStart[t].bot - prev.bot <= 1, `bot gained more than 1 land during turn ${t - 1}`);
      assert.ok(landsAtTurnStart[t].p1 - prev.p1 <= 1, `p1 gained more than 1 land during turn ${t - 1}`);
    }
    app.perkinsAgent?.destroy(); app.destroy();
  });

  // ---------------- SPEC 3: Combat ----------------
  await test('TC-COMBAT-01', 'canDeclareAsAttacker honours Haste, summoning sickness, tapped and Defender', async () => {
    const st = { activePlayerId: 'p1', currentPhaseStep: 'DECLARE_ATTACKERS' };
    const base = { controllerId: 'p1', typeLine: 'Creature' };
    assert.strictEqual(canDeclareAsAttacker({ ...base, name: 'Bear' }, st), true);
    assert.strictEqual(canDeclareAsAttacker({ ...base, name: 'Bear', isSummoningSick: true }, st), false);
    assert.strictEqual(canDeclareAsAttacker({ ...base, name: 'Goblin Guide', isSummoningSick: true, keywords: { haste: true } }, st), true);
    assert.strictEqual(canDeclareAsAttacker({ ...base, name: 'X', summoningSick: true, keywords: ['HASTE'] }, st), true);
    assert.strictEqual(canDeclareAsAttacker({ ...base, name: 'X', summoningSick: true, abilities: ['Haste'] }, st), true);
    assert.strictEqual(canDeclareAsAttacker({ ...base, name: 'Bear', isTapped: true }, st), false);
    assert.strictEqual(canDeclareAsAttacker({ ...base, name: 'Wall', keywords: ['DEFENDER'] }, st), false);
    assert.strictEqual(canDeclareAsAttacker({ ...base, name: 'Bear', controllerId: 'p2' }, st), false);
    assert.strictEqual(canDeclareAsAttacker({ ...base, name: 'Bear' }, { ...st, currentPhaseStep: 'PRECOMBAT_MAIN' }), false);
  });

  await test('TC-COMBAT-02', 'Goblin Guide cast via stack stays summoning-sick but can attack (Haste); attack trigger fires', async () => {
    const psm = new PriorityStateMachine({ players: ['p1', 'p2'], startingPlayerId: 'p1' });
    const tsm = new TabletopStateManager({ players: ['p1', 'p2'], priorityMachine: psm });
    psm.tabletopState = tsm; tsm.priorityMachine = psm;
    const p1 = tsm.getPlayer('p1'), p2 = tsm.getPlayer('p2');
    p2.library.push({ instanceId: 'p2_top', name: 'Island', typeLine: 'Basic Land — Island' }, { instanceId: 'p2_next', name: 'Bolt', typeLine: 'Instant' });
    psm.pushStack({ id: 's1', sourcePlayerId: 'p1', controllerId: 'p1', name: 'Goblin Guide', card: { instanceId: 'gg1', name: 'Goblin Guide', typeLine: 'Creature — Goblin Scout', power: 2, toughness: 2 } });
    psm.alarmManager.onTimeout('p2', 's1');
    const gg = p1.battlefield.creatures[0];
    assert.ok(gg, 'Goblin Guide on battlefield');
    assert.strictEqual(gg.isSummoningSick, true, 'summoning sick flag kept (TC-STABILITY-10)');
    let trig = null; tsm.on('ATTACK_TRIGGER_RESOLVED', (e) => { trig = e; });
    const res = tsm.declareAttackers('p1', [gg.instanceId]);
    assert.strictEqual(res.attackers.length, 1);
    assert.strictEqual(gg.isTapped, true, 'attacker taps on declaration');
    assert.ok(trig && trig.movedToHand, 'revealed land goes to defender hand');
    assert.strictEqual(p2.hand.some(c => c.instanceId === 'p2_top'), true);
    assert.strictEqual(p2.library[0].instanceId, 'p2_next');
  });

  await test('TC-COMBAT-03', 'Blocker restrictions: Flying, Unblockable, Fear, Menace', async () => {
    const mk = () => {
      const tsm = new TabletopStateManager({ players: ['p1', 'p2'] });
      return { tsm, p1: tsm.getPlayer('p1'), p2: tsm.getPlayer('p2') };
    };
    const attempt = (attackerExtra, blockers, attackerCount = 1) => {
      const { tsm, p1, p2 } = mk();
      p1.battlefield.creatures.push(mkCard('att', 'Attacker', { controllerId: 'p1', ...attackerExtra }));
      blockers.forEach((b, i) => p2.battlefield.creatures.push({ ...mkCard(`blk${i}`, 'Blocker', { controllerId: 'p2' }), ...b }));
      tsm.declareAttackers('p1', ['att']);
      return () => tsm.declareBlockers('p2', blockers.map((_, i) => ({ blockerId: `blk${i}`, attackerId: 'att' })));
    };
    assert.throws(attempt({ keywords: { flying: true } }, [{}]), /Flying/);
    assert.doesNotThrow(attempt({ keywords: { flying: true } }, [{ keywords: { reach: true } }]));
    assert.throws(attempt({ keywords: { unblockable: true } }, [{}]), /unblockable/i);
    assert.throws(attempt({ keywords: ['FEAR'] }, [{ colors: ['G'] }]), /FEAR/i);
    assert.doesNotThrow(attempt({ keywords: ['FEAR'] }, [{ colors: ['B'] }]));
    assert.throws(attempt({ keywords: { menace: true } }, [{}]), /Menace/);
    assert.doesNotThrow(attempt({ keywords: { menace: true } }, [{}, {}]));
  });

  await test('TC-COMBAT-04', 'UI candidate click + Confirm Attackers button taps Haste Goblin Guide in DECLARE_ATTACKERS', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div'); doc.body.appendChild(container);
    const app = new RPMAppController({ container, autoConnect: false, myPlayerId: 'p1', playerIds: ['p1', 'p2'] });
    await app.mount(container);
    app.startMatch({ playerIds: ['p1', 'p2'] });
    const p1 = app.tabletopState.getPlayer('p1');
    const p2 = app.tabletopState.getPlayer('p2');
    p2.library = [{ instanceId: 'p2_land_top', name: 'Mountain', typeLine: 'Basic Land — Mountain' }];
    p1.battlefield.creatures.push({
      instanceId: 'gg_ui_1',
      name: 'Goblin Guide',
      typeLine: 'Creature — Goblin Scout',
      power: 2,
      toughness: 2,
      controllerId: 'p1',
      isTapped: false,
      isSummoningSick: true,
      hasSummoningSickness: true,
      keywords: { haste: true, Haste: true }
    });
    app.priorityMachine.activePlayerId = 'p1';
    app.priorityMachine.priorityPlayerId = 'p1';
    app.priorityMachine.currentPhaseStep = 'DECLARE_ATTACKERS';
    app.reconcileDOM();

    const chip = container.querySelector('.attack-candidate');
    assert.ok(chip, 'Goblin Guide must render with .attack-candidate class');
    chip.click();

    const selectedChip = container.querySelector('.attack-selected');
    assert.ok(selectedChip, 'Clicking Goblin Guide must mark it .attack-selected');
    const confirmBtn = container.querySelector('#btn-confirm-attackers');
    assert.ok(confirmBtn, 'Confirm Attackers button must render');

    confirmBtn.click();
    assert.strictEqual(p1.battlefield.creatures[0].isTapped, true, 'Goblin Guide must tap on confirmation');
    assert.strictEqual(p1.battlefield.creatures[0].isAttacking, true, 'Goblin Guide must be marked isAttacking');
    assert.strictEqual(app.tabletopState.combatState.attackers.length, 1);
    assert.strictEqual(p2.hand.some(c => c.instanceId === 'p2_land_top'), true, 'Goblin Guide attack trigger revealed land to defender hand');
    app.destroy();
  });

  await test('TC-PREGAME-03', 'Consecutive London Mulligans (keep: false x2) with UUID seat, P1 alias resolution, and real-time telemetry log', async () => {
    const uuid = '7b51d073-9b47-4ffd-9af3-dfe6691c4541';
    const doc = setupMockDOM();
    const container = doc.createElement('div'); doc.body.appendChild(container);
    const app = new RPMAppController({
      container,
      autoConnect: false,
      myPlayerId: uuid,
      username: 'Svayneak',
      playerIds: [uuid, 'p2_perkins'],
      pregame: false
    });
    await app.mount(container);

    // Verify P1 alias resolution in TabletopStateManager
    assert.strictEqual(app.tabletopState.resolvePlayerId('p1'), uuid);
    assert.strictEqual(app.tabletopState.resolvePlayerId('P1'), uuid);
    assert.strictEqual(app.tabletopState.getPlayer('P1').playerId, uuid);

    // Ensure full 60-card deck (7 hand + 53 library) dealt by dealStartingHands
    app.dealStartingHands();
    for (const pid of [uuid, 'p2_perkins']) {
      const p = app.tabletopState.getPlayer(pid);
      assert.strictEqual(p.hand.length, 7);
      assert.strictEqual(p.library.length, 53);
      assert.ok(p.hand[0].imageUri && p.hand[0].imageUrl, 'Both imageUri and imageUrl populated');
    }

    // Start pregame deterministically where UUID player wins roll and plays first
    const pg = new PregameStateMachine({
      players: [uuid, 'p2_perkins'],
      tabletopState: app.tabletopState,
      priorityMachine: app.priorityMachine
    });
    app.pregameMachine = pg;
    app.tabletopState.pregameMachine = pg;
    app.pregameActive = true;

    assert.strictEqual(pg.resolvePlayerId('P1'), uuid);
    pg.dispatch('EXECUTE_STARTING_ROLL', { rolls: { [uuid]: 19, p2_perkins: 4 } });
    pg.dispatch('SELECT_PLAY_OR_DRAW', { playerId: 'P1', choice: 'PLAY' });
    assert.strictEqual(pg.currentDecidingPlayerId, uuid);

    // Mulligan #1 via UI handler
    assert.doesNotThrow(() => app.handleMulliganTake({ nextMulliganCount: 1 }));
    assert.strictEqual(pg.mulliganCount[uuid], 1);
    assert.strictEqual(pg.pendingBottomCount[uuid], 1);
    assert.strictEqual(app.tabletopState.getPlayer(uuid).hand.length, 7);

    // Mulligan #2 via UI handler (previously threw at PregameStateMachine.js:282!)
    assert.doesNotThrow(() => app.handleMulliganTake({ nextMulliganCount: 2 }));
    assert.strictEqual(pg.mulliganCount[uuid], 2);
    assert.strictEqual(pg.pendingBottomCount[uuid], 2);
    assert.strictEqual(app.tabletopState.getPlayer(uuid).hand.length, 7);

    // Confirm bottoming 2 cards and keeping 5-card hand
    const handNow = app.tabletopState.getPlayer(uuid).hand;
    const bottomedCards = [handNow[0], handNow[1]];
    app.handleMulliganConfirmBottom({ bottomedCards });

    assert.strictEqual(app.tabletopState.getPlayer(uuid).hand.length, 5, '5 cards in hand after 2 mulligans');
    assert.strictEqual(pg.state, PREGAME_STATES.GAME_ACTIVE, 'Pregame completed after bot auto-keeps');
    assert.strictEqual(app.pregameActive, false);

    // Verify real-time execution telemetry log populated and scrubbed of raw UUIDs
    assert.ok(app.executionLog.length >= 3, 'Execution telemetry log populated');
    assert.ok(app.dualChat.turnCommandMessages.length >= 3, 'Turn command feed populated');
    for (const entry of app.executionLog) {
      assert.strictEqual(entry.text.includes(uuid), false, `Telemetry log must not leak raw UUID: ${entry.text}`);
    }
    app.destroy();
  });

  // ---------------- SPEC 4: Exact Auto-Tap & Floating Mana Pool ----------------
  await test('TC-MANA-01', 'Exact Auto-Tap: casting 1-CMC {R} spell with Mountain + Steam Vents taps ONLY Mountain and logs 0 warnings', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div'); doc.body.appendChild(container);
    const app = new RPMAppController({ container, autoConnect: false, myPlayerId: 'p1', playerIds: ['p1', 'p2'] });
    await app.mount(container);
    app.startMatch({ playerIds: ['p1', 'p2'] });
    const p1 = app.tabletopState.getPlayer('p1');
    p1.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    const steamVents = {
      instanceId: 'land_sv_1',
      name: 'Steam Vents',
      typeLine: 'Land — Island Mountain',
      isShockland: true,
      isTapped: false,
      colors: ['U', 'R']
    };
    const mountain = {
      instanceId: 'land_mtn_1',
      name: 'Mountain',
      typeLine: 'Basic Land — Mountain',
      isTapped: false,
      colors: ['R']
    };
    p1.battlefield.lands = [steamVents, mountain];
    p1.zones.battlefield = [steamVents, mountain];

    const goblinGuide = {
      instanceId: 'spell_gg_1',
      name: 'Goblin Guide',
      typeLine: 'Creature — Goblin Scout',
      manaCost: '{R}',
      cmc: 1,
      power: 2,
      toughness: 2
    };
    p1.hand = [goblinGuide];
    p1.zones.hand = [goblinGuide];

    app.priorityMachine.activePlayerId = 'p1';
    app.priorityMachine.priorityPlayerId = 'p1';
    app.priorityMachine.currentPhaseStep = 'PRECOMBAT_MAIN';

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      app.castSpellToStack(goblinGuide);
    } finally {
      console.warn = origWarn;
    }

    assert.strictEqual(mountain.isTapped, true, 'Single-color basic Mountain must be tapped first');
    assert.strictEqual(steamVents.isTapped, false, 'Dual land Steam Vents must remain untapped');
    assert.strictEqual(p1.resources.manaPool.R, 0, 'Mana pool R must be 0 after paying {R}');
    assert.strictEqual(warnings.some(w => w.includes('autoTapForMana warning')), false, `Must emit 0 autoTapForMana warnings, got: ${warnings.join('; ')}`);
    assert.ok(globalThis.__PROCESS_TRACE__.getEntries({ category: 'MANA_TRACE', action: 'AUTO_TAP_COMMITTED' }).length >= 1, 'ProcessTraceLogger recorded AUTO_TAP_COMMITTED');
    app.destroy();
  });

  await test('TC-MANA-02', 'Floating Mana Respected: manually tapping Mountain into manaPool.R=1 then casting {R} spell taps 0 extra lands', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div'); doc.body.appendChild(container);
    const app = new RPMAppController({ container, autoConnect: false, myPlayerId: 'p1', playerIds: ['p1', 'p2'] });
    await app.mount(container);
    app.startMatch({ playerIds: ['p1', 'p2'] });
    const p1 = app.tabletopState.getPlayer('p1');
    p1.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    const mountain = {
      instanceId: 'land_mtn_float',
      name: 'Mountain',
      typeLine: 'Basic Land — Mountain',
      isTapped: false,
      colors: ['R']
    };
    const steamVents = {
      instanceId: 'land_sv_untapped',
      name: 'Steam Vents',
      typeLine: 'Land — Island Mountain',
      isShockland: true,
      isTapped: false,
      colors: ['U', 'R']
    };
    p1.battlefield.lands = [mountain, steamVents];
    p1.zones.battlefield = [mountain, steamVents];

    // Manually tap Mountain first -> manaPool.R === 1
    app.tabletopState.tapLandForMana('p1', 'land_mtn_float');
    assert.strictEqual(mountain.isTapped, true);
    assert.strictEqual(p1.resources.manaPool.R, 1);

    const lavaSpike = {
      instanceId: 'spell_ls_1',
      name: 'Lava Spike',
      typeLine: 'Sorcery — Arcane',
      manaCost: '{R}',
      cmc: 1
    };
    p1.hand = [lavaSpike];
    p1.zones.hand = [lavaSpike];

    app.priorityMachine.activePlayerId = 'p1';
    app.priorityMachine.priorityPlayerId = 'p1';
    app.priorityMachine.currentPhaseStep = 'PRECOMBAT_MAIN';

    app.castSpellToStack(lavaSpike);
    const targetItem = container.querySelector('.legal') || container.querySelector('.target-candidate-item');
    if (targetItem) targetItem.click();

    assert.strictEqual(p1.resources.manaPool.R, 0, 'Floating R mana in manaPool must be consumed');
    assert.strictEqual(steamVents.isTapped, false, 'Second land (Steam Vents) must NOT be auto-tapped when floating mana covers cost');
    app.destroy();
  });

  // ---------------- SPEC 5: Interactive Human Blocker Pause & Assignment ----------------
  await test('TC-COMBAT-05', 'Interactive DECLARE_BLOCKERS when defending against Perkins AI allows human blocker assignment and prevents player damage', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div'); doc.body.appendChild(container);
    const app = new RPMAppController({ container, autoConnect: false, myPlayerId: 'p1', playerIds: ['p1', 'p2_perkins'] });
    await app.mount(container);
    app.startMatch({ playerIds: ['p1', 'p2_perkins'] });

    const p1 = app.tabletopState.getPlayer('p1');
    const bot = app.tabletopState.getPlayer('p2_perkins');
    p1.resources.life = 20;
    bot.resources.life = 20;

    const botAttacker = {
      instanceId: 'bot_att_1',
      name: 'Goblin Guide',
      typeLine: 'Creature — Goblin Scout',
      power: 2,
      toughness: 2,
      controllerId: 'p2_perkins',
      isTapped: false,
      isSummoningSick: false
    };
    bot.battlefield.creatures = [botAttacker];
    bot.zones.battlefield = [botAttacker];

    const humanBlocker = {
      instanceId: 'hum_blk_1',
      name: 'Monastery Swiftspear',
      typeLine: 'Creature — Human Monk',
      power: 1,
      toughness: 2,
      controllerId: 'p1',
      isTapped: false,
      isSummoningSick: false
    };
    p1.battlefield.creatures = [humanBlocker];
    p1.zones.battlefield = [humanBlocker];

    // Bot is active player in DECLARE_ATTACKERS and declares 1 attacker
    app.priorityMachine.activePlayerId = 'p2_perkins';
    app.priorityMachine.priorityPlayerId = 'p2_perkins';
    app.priorityMachine.currentPhaseStep = 'DECLARE_ATTACKERS';
    await app.dispatchAction({
      type: 'DECLARE_ATTACKERS',
      playerId: 'p2_perkins',
      attackers: ['bot_att_1'],
      payload: { playerId: 'p2_perkins', attackers: ['bot_att_1'] }
    }, { origin: 'LOCAL_BOT' });

    // Advance to DECLARE_BLOCKERS where Perkins passes priority to human defender p1
    app.priorityMachine.setPhaseStep('DECLARE_BLOCKERS');
    app.priorityMachine.passPriority('p2_perkins');
    assert.strictEqual(app.priorityMachine.currentPhaseStep, 'DECLARE_BLOCKERS');
    assert.strictEqual(app.priorityMachine.priorityPlayerId, 'p1', 'Priority in DECLARE_BLOCKERS must wait on human defender p1');
    app.reconcileDOM();

    // Human UI renders .blocker-candidate and #btn-confirm-blockers
    const blockerChip = container.querySelector('.blocker-candidate');
    assert.ok(blockerChip, 'Untapped human creature must render with .blocker-candidate in DECLARE_BLOCKERS');
    blockerChip.click();

    const selectedBlocker = container.querySelector('.blocker-selected');
    assert.ok(selectedBlocker, 'Clicking human blocker candidate must mark it .blocker-selected');

    const confirmBlockBtn = container.querySelector('#btn-confirm-blockers');
    assert.ok(confirmBlockBtn, 'Confirm Blockers button must render in DECLARE_BLOCKERS');
    confirmBlockBtn.click();

    // Confirming blockers dispatches DECLARE_BLOCKERS and advances to COMBAT_DAMAGE, resolving combat
    assert.strictEqual(p1.resources.life, 20, 'Blocked attacker must deal 0 combat damage to defending player p1');
    assert.strictEqual(botAttacker.damageMarked, 1, '1/2 blocker deals 1 damage to 2/2 attacker');
    app.destroy();
  });

  // ---------------- SPEC 6: Single Turn Handover Emission ----------------
  await test('TC-TURN-02', 'Advancing from Turn N to Turn N+1 emits and logs turn handover strictly once', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div'); doc.body.appendChild(container);
    const app = new RPMAppController({ container, autoConnect: false, myPlayerId: 'p1', playerIds: ['p1', 'p2'] });
    await app.mount(container);
    app.startMatch({ playerIds: ['p1', 'p2'] });

    const psm = app.priorityMachine;
    psm.activePlayerId = 'p1';
    psm.priorityPlayerId = 'p1';
    psm.turnNumber = 1;
    app.executionLog = [];

    // End Turn 1 -> rotates to Turn 2 (p2 active)
    psm.endTurn('p1');

    const turn2Logs = app.executionLog.filter(e => e.text.includes('Turn 2:') && e.text.includes('is now active'));
    assert.strictEqual(turn2Logs.length, 1, `Turn 2 handover must be logged strictly once, got ${turn2Logs.length}`);
    app.destroy();
  });

  console.log(`\n  PREGAME/TURNS/COMBAT RESULTS: ${totalPassed} passed, ${totalFailed} failed\n`);
  process.exit(totalFailed > 0 ? 1 : 0);
}
run();
