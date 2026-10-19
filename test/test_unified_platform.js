/**
 * test/test_unified_platform.js
 * Comprehensive Acceptance Test Suite for Feature 14:
 * Unified Decoupled Platform, Lobby & Matchmaking, Oracle Deckbuilder & Bilingual Interaction
 * 
 * Document ID: SPEC-RPM-PLATFORM-014
 * Enforces Architectural Invariants:
 * - INV-LOCKOUT-1: Tab Lockout Invariant (Arena Active = Non-Battle Tabs Disabled)
 * - INV-LOBBY-1: Dynamic Readiness Invalidation
 * - INV-LOBBY-2: Room Seating & Capacity Scaling (2 for Duel, 3 for Pod, 6 Auto-Start)
 * - INV-LOBBY-3: Pre-Game 20s Lobby Disconnect Grace Timer
 * - INV-QUEUE-1: FIFO 1v1 Queue & 45s Perkins Watchdog
 * - INV-DECK-1: Oracle 4-Of Override Resolution & Modern Banlist
 * - INV-PERK-UI-1: Upkeep Dormancy & Dice Flow
 * - INV-TURNSORT-1: Pre-Game d20 Roll-Off & Tie-Break Turn Sorting
 */

import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import {
  RPMAppController,
  TabRouter,
  TABS,
  LOCKED_TABS_DURING_MATCH,
  LobbyManager,
  MatchmakingQueue,
  DeckValidator,
  TurnRollOffManager,
  ActionLexer,
  evaluateDeckSlots
} from '../src/index.js';

// ============================================================================
// Lightweight Headless Mock DOM Infrastructure
// ============================================================================

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
    this.tagName = tagName.toUpperCase();
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this._attributes = new Map();
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

  setAttribute(name, val) {
    this._attributes.set(name, String(val));
    if (name === 'id') this.id = String(val);
    if (name === 'class') this.className = String(val);
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return this._attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this._attributes.delete(name);
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentElement) {
      child.parentElement.removeChild(child);
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(newChild, refChild) {
    if (!newChild) return newChild;
    if (newChild.parentElement) {
      newChild.parentElement.removeChild(newChild);
    }
    const idx = this.children.indexOf(refChild);
    if (idx === -1) {
      return this.appendChild(newChild);
    }
    newChild.parentElement = this;
    this.children.splice(idx, 0, newChild);
    return newChild;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
    return child;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.removeChild(this);
    }
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

  get innerHTML() {
    return this.textContent;
  }

  set innerHTML(html) {
    this.children = [];
    this.textContent = '';
    if (!html || typeof html !== 'string') return;

    const tagRegex = /<([a-z0-9-]+)([^>]*)>([\s\S]*?)<\/\1>|<([a-z0-9-]+)([^>]*)\/?>/gi;
    let match;
    let lastIndex = 0;

    while ((match = tagRegex.exec(html)) !== null) {
      const isVoid = !match[3] && !match[1];
      const tag = (match[1] || match[4]).toLowerCase();
      const rawAttrs = match[2] || match[5] || '';
      const inner = match[3] || '';

      const elem = new MockElement(tag);

      const attrRegex = /([a-z0-9-_]+)(?:=(?:"([^"]*)"|'([^']*)'|([^>\s]+)))?/gi;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
        const k = attrMatch[1];
        const v = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
        elem.setAttribute(k, v);
      }

      if (inner && !isVoid) {
        elem.innerHTML = inner;
      }

      this.appendChild(elem);
      lastIndex = tagRegex.lastIndex;
    }

    if (this.children.length === 0) {
      this.textContent = html.replace(/<[^>]*>/g, '').trim();
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
  if (!elem || !selector) return false;
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
    return this.querySelector(`#${id}`);
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    if (this._listeners.has(type)) {
      this._listeners.delete(type);
    }
  }

  dispatchEvent(event) {
    if (this._listeners.has(event.type)) {
      for (const listener of this._listeners.get(event.type)) {
        listener.call(this, event);
      }
    }
    return !event.defaultPrevented;
  }
}

function setupMockDOM() {
  const doc = new MockDocument();
  globalThis.document = doc;
  globalThis.window = {
    document: doc,
    addEventListener: doc.addEventListener.bind(doc),
    removeEventListener: doc.removeEventListener.bind(doc),
    dispatchEvent: doc.dispatchEvent.bind(doc)
  };
  globalThis.Event = MockEvent;
  return doc;
}

// ============================================================================
// Test Suite Harness
// ============================================================================

let passedTests = 0;
let failedTests = 0;

async function test(id, description, fn) {
  try {
    await fn();
    console.log(`  ✓ ${id}: ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${id}: ${description}`);
    console.error(err);
    failedTests++;
  }
}

async function runTestSuite() {
  console.log('\n==================================================================');
  console.log('Running Acceptance Test Suite: Feature 14 Unified Platform');
  console.log('Document ID: SPEC-RPM-PLATFORM-014');
  console.log('==================================================================\n');

  // --------------------------------------------------------------------------
  // TC-PLATFORM-01: Tab Navigation Initial State (INV-LOCKOUT-1)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-01', 'Tab Navigation Initial State (INV-LOCKOUT-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    // Verify all 5 tab buttons exist
    const tabArena = container.querySelector('#tab-btn-arena');
    const tabDeckbuilder = container.querySelector('#tab-btn-deckbuilder');
    const tabLobby = container.querySelector('#tab-btn-lobby');
    const tabProfile = container.querySelector('#tab-btn-profile');
    const tabLeaderboard = container.querySelector('#tab-btn-leaderboard');

    assert.ok(tabArena, '#tab-btn-arena must exist');
    assert.ok(tabDeckbuilder, '#tab-btn-deckbuilder must exist');
    assert.ok(tabLobby, '#tab-btn-lobby must exist');
    assert.ok(tabProfile, '#tab-btn-profile must exist');
    assert.ok(tabLeaderboard, '#tab-btn-leaderboard must exist');

    // In initial idle state, zero tabs are locked
    const lockedTabs = container.querySelectorAll('.tab-locked');
    assert.strictEqual(lockedTabs.length, 0, 'No tabs should be locked initially');

    // Navigate to LOBBY
    const navResult = app.tabRouter.navigate('LOBBY', app.getMatchState(), app.isSpectator());
    assert.strictEqual(navResult.success, true);
    assert.strictEqual(app.tabRouter.getCurrentTab(), 'LOBBY');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-02: Tab Lockout During Active Match (INV-LOCKOUT-1)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-02', 'Tab Lockout During Active Match (INV-LOCKOUT-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    // Start match -> enters ACTIVE state
    app.startMatch();
    assert.strictEqual(app.isMatchActive(), true, 'Match must be active');

    // Attempt navigating to Deckbuilder -> blocked by INV-LOCKOUT-1
    const res = app.tabRouter.navigate('DECKBUILDER', app.getMatchState(), app.isSpectator());
    assert.strictEqual(res.success, false, 'Navigation to Deckbuilder must be blocked during match');
    assert.strictEqual(res.reason, 'TAB_LOCKED_ACTIVE_MATCH');

    // Attempt navigating to Profile -> blocked
    const resProf = app.tabRouter.navigate('PROFILE', app.getMatchState(), app.isSpectator());
    assert.strictEqual(resProf.success, false, 'Navigation to Profile must be blocked');

    // Tab buttons in DOM reflect locked state
    const tabDeckbuilder = container.querySelector('#tab-btn-deckbuilder');
    assert.ok(tabDeckbuilder.classList.contains('tab-locked'), 'Deckbuilder tab must have .tab-locked class');

    // Concede modal should be surfaced on blocked attempt
    const concedeModal = container.querySelector('#concede-modal');
    assert.ok(concedeModal, 'Concede warning modal must be surfaced');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-03: Concede Exits Lockout (INV-LOCKOUT-1)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-03', 'Concede Exits Lockout (INV-LOCKOUT-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    app.startMatch();
    assert.strictEqual(app.isMatchActive(), true);

    // Confirm concede
    app.concedeMatch();
    assert.strictEqual(app.isMatchActive(), false, 'Match must no longer be active after concede');

    // Navigation is now unlocked
    const navRes = app.tabRouter.navigate('DECKBUILDER', app.getMatchState(), app.isSpectator());
    assert.strictEqual(navRes.success, true, 'Navigation to Deckbuilder permitted after concede');
    assert.strictEqual(app.tabRouter.getCurrentTab(), 'DECKBUILDER');

    const tabDeck = container.querySelector('#tab-btn-deckbuilder');
    assert.strictEqual(tabDeck.classList.contains('tab-locked'), false, 'Deckbuilder tab must be unlocked');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-04: Spectator Exemption (INV-LOCKOUT-1)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-04', 'Spectator Exemption (INV-LOCKOUT-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    // Spectator in an active match room
    const app = new RPMAppController({
      isSpectator: true,
      isMatchActive: true,
      autoConnect: false
    });
    await app.mount(container);

    assert.strictEqual(app.isSpectator(), true);
    assert.strictEqual(app.isMatchActive(), true);

    // Spectator can freely switch tabs without lockout
    const resDeck = app.tabRouter.navigate('DECKBUILDER', app.getMatchState(), app.isSpectator());
    assert.strictEqual(resDeck.success, true, 'Spectator must be permitted to navigate to Deckbuilder');

    const resProf = app.tabRouter.navigate('PROFILE', app.getMatchState(), app.isSpectator());
    assert.strictEqual(resProf.success, true, 'Spectator must be permitted to navigate to Profile');

    const resLead = app.tabRouter.navigate('LEADERBOARD', app.getMatchState(), app.isSpectator());
    assert.strictEqual(resLead.success, true, 'Spectator must be permitted to navigate to Leaderboard');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-05: 2-Player Private Room Mutual Ready (INV-LOBBY-2)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-05', '2-Player Private Room Mutual Ready (INV-LOBBY-2)', async () => {
    const lobby = new LobbyManager({ roomCode: 'DUEL_1', maxPlayers: 2 });

    assert.strictEqual(lobby.canStart(), false, 'Empty lobby cannot start');
    assert.strictEqual(lobby.minPlayersToStart, 2, '2-player room requires 2 players');

    // Seat player 1
    lobby.claimSeat(1, { playerId: 'p1', playerName: 'Alice' });
    assert.strictEqual(lobby.canStart(), false, '1 seated player cannot start');

    // Seat player 2
    lobby.claimSeat(2, { playerId: 'p2', playerName: 'Bob' });
    assert.strictEqual(lobby.canStart(), true, '2 seated players satisfy min capacity');
    assert.strictEqual(lobby.isAllReady(), false, 'Neither player ready yet');

    // Player 1 ready
    lobby.setReady('p1', true);
    assert.strictEqual(lobby.isAllReady(), false, 'Only 1/2 ready');

    // Player 2 ready -> all ready!
    lobby.setReady('p2', true);
    assert.strictEqual(lobby.isAllReady(), true, 'Both players ready');
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-06: 3-Player Multiplayer Pod Start (INV-LOBBY-2)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-06', '3-Player Multiplayer Pod Start (INV-LOBBY-2)', async () => {
    const lobby = new LobbyManager({ roomCode: 'POD_6', maxPlayers: 6 });

    assert.strictEqual(lobby.minPlayersToStart, 3, 'Multiplayer pod requires min 3 players');

    lobby.claimSeat(1, { playerId: 'p1', playerName: 'Alice' });
    lobby.claimSeat(2, { playerId: 'p2', playerName: 'Bob' });
    assert.strictEqual(lobby.canStart(), false, '2 players in pod cannot start');

    // 3rd player claims seat
    lobby.claimSeat(3, { playerId: 'p3', playerName: 'Charlie' });
    assert.strictEqual(lobby.canStart(), true, '3 players in pod can start');
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-07: Dynamic Arrival Invalidation (INV-LOBBY-1)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-07', 'Dynamic Arrival Invalidation (INV-LOBBY-1)', async () => {
    const lobby = new LobbyManager({ roomCode: 'POD_INV', maxPlayers: 6 });

    lobby.claimSeat(1, { playerId: 'p1', playerName: 'Alice' });
    lobby.claimSeat(2, { playerId: 'p2', playerName: 'Bob' });
    lobby.claimSeat(3, { playerId: 'p3', playerName: 'Charlie' });

    // Alice and Bob confirm ready
    lobby.setReady('p1', true);
    lobby.setReady('p2', true);
    assert.strictEqual(lobby.getReadyCount(), 2);

    let resetEmitted = false;
    lobby.on('LOBBY_READY_RESET', (evt) => {
      resetEmitted = true;
      assert.strictEqual(evt.reason, 'NEW_PLAYER_ARRIVED');
    });

    // 4th player arrives
    lobby.claimSeat(4, { playerId: 'p4', playerName: 'Dave' });

    assert.strictEqual(resetEmitted, true, 'LOBBY_READY_RESET must be emitted');
    assert.strictEqual(lobby.getReadyCount(), 0, 'All readiness confirmations must be revoked');
    assert.strictEqual(lobby.slots.get(1).isReady, false);
    assert.strictEqual(lobby.slots.get(2).isReady, false);
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-08: Full Capacity 6/6 Auto-Start (INV-LOBBY-2)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-08', 'Full Capacity 6/6 Auto-Start (INV-LOBBY-2)', async () => {
    const lobby = new LobbyManager({ roomCode: 'POD_FULL', maxPlayers: 6 });

    let matchTriggered = false;
    lobby.on('MATCH_START_TRIGGERED', () => {
      matchTriggered = true;
    });

    for (let i = 1; i <= 5; i++) {
      lobby.claimSeat(i, { playerId: `p${i}`, playerName: `Player ${i}` });
    }
    assert.strictEqual(matchTriggered, false, '5 players must not auto-start');

    // Claim 6th seat (full capacity)
    lobby.claimSeat(6, { playerId: 'p6', playerName: 'Player 6' });
    assert.strictEqual(matchTriggered, true, '6/6 capacity must trigger auto-start');
    assert.strictEqual(lobby.status, 'ROLL_OFF_PHASE');
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-09: Pre-Game 20s Disconnect Grace (INV-LOBBY-3)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-09', 'Pre-Game 20s Disconnect Grace (INV-LOBBY-3)', async () => {
    const lobby = new LobbyManager({ roomCode: 'GRACE', maxPlayers: 4, disconnectGraceMs: 20000 });

    const slot = lobby.claimSeat(1, { playerId: 'p1', playerName: 'Alice' });
    assert.strictEqual(slot.connectionStatus, 'CONNECTED');

    // Simulate drop
    lobby.handleDisconnect('p1');
    assert.strictEqual(lobby.slots.get(1).connectionStatus, 'DISCONNECTED');
    assert.ok(lobby.slots.get(1).graceTimerRemainingMs > 0);

    // Reconnect with seat token before expiration
    const recRes = lobby.handleReconnect('p1', slot.seatToken);
    assert.strictEqual(recRes.success, true);
    assert.strictEqual(lobby.slots.get(1).connectionStatus, 'CONNECTED');

    // Drop and expire grace timer
    lobby.handleDisconnect('p1');
    lobby.expireGracePeriod(1);
    assert.strictEqual(lobby.slots.has(1), false, 'Slot 1 vacated after grace timeout');
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-10: 1v1 Queue FIFO Pairing (INV-QUEUE-1)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-10', '1v1 Queue FIFO Pairing (INV-QUEUE-1)', async () => {
    const queue = new MatchmakingQueue();

    queue.enqueue({ playerId: 'p1', playerName: 'Alice', format: 'MODERN' });
    queue.enqueue({ playerId: 'p2', playerName: 'Bob', format: 'MODERN' });

    assert.strictEqual(queue.size(), 2);

    const match = queue.findMatch();
    assert.ok(match, 'Match must be created');
    assert.strictEqual(match.player1.playerId, 'p1');
    assert.strictEqual(match.player2.playerId, 'p2');
    assert.strictEqual(queue.size(), 0, 'Queue must be empty after pair extraction');
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-11: 1v1 Queue 45s Perkins Watchdog (INV-QUEUE-1)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-11', '1v1 Queue 45s Perkins Watchdog (INV-QUEUE-1)', async () => {
    const queue = new MatchmakingQueue({ watchdogSeconds: 45 });

    // Ticket joined 50 seconds ago
    queue.enqueue({
      playerId: 'solo_player',
      playerName: 'Alice',
      format: 'MODERN',
      joinedAt: Date.now() - 50000
    });

    const flagged = queue.checkWatchdog();
    assert.strictEqual(flagged.length, 1);
    assert.strictEqual(flagged[0].playerId, 'solo_player');
    assert.strictEqual(flagged[0].shouldPromptPerkins, true);
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-12: Free Construct 4-Of Scryfall Oracle Override (INV-DECK-1)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-12', 'Free Construct 4-Of Scryfall Oracle Override (INV-DECK-1)', async () => {
    // 20 copies of Relentless Rats (exempt via canonical rule)
    const ratsDeck = `
      20 Relentless Rats
      20 Swamp
      20 Mountain
    `;
    const resRats = DeckValidator.validateDeck(ratsDeck, { format: 'FREE_CONSTRUCT' });
    assert.strictEqual(resRats.isValid, true, 'Relentless Rats must be exempt from 4-of limit');

    // 5 copies of Lightning Bolt (not exempt)
    const boltDeck = `
      5 Lightning Bolt
      20 Mountain
      35 Forest
    `;
    const resBolt = DeckValidator.validateDeck(boltDeck, { format: 'FREE_CONSTRUCT' });
    assert.strictEqual(resBolt.isValid, false, '5 Lightning Bolt must exceed 4-of limit');
    assert.ok(resBolt.errors.some(e => e.cardName === 'Lightning Bolt' && e.reason.includes('exceeds 4 copies')));
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-13: Ranked Construct Modern Banlist Enforcement (INV-DECK-1)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-13', 'Ranked Construct Modern Banlist Enforcement (INV-DECK-1)', async () => {
    const deckWithBanned = `
      1 The One Ring
      1 Black Lotus
      20 Mountain
      38 Forest
    `;

    // Free Construct permits banned cards
    const resFree = DeckValidator.validateDeck(deckWithBanned, { format: 'FREE_CONSTRUCT' });
    assert.strictEqual(resFree.isValid, true, 'Free Construct does not enforce banlist');

    // Ranked Construct (Modern) rejects banned cards
    const resRanked = DeckValidator.validateDeck(deckWithBanned, { format: 'RANKED_CONSTRUCT' });
    assert.strictEqual(resRanked.isValid, false, 'Ranked Construct enforces Modern banlist');
    assert.ok(resRanked.errors.some(e => e.cardName === 'The One Ring' || e.cardName === 'Black Lotus'));
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-14: Milestone Deck Slot Capacity (INV-AUDIO-6)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-14', 'Milestone Deck Slot Capacity (INV-AUDIO-6)', async () => {
    assert.strictEqual(evaluateDeckSlots(0, 0), 1, 'Default starting profile has 1 slot');
    assert.strictEqual(evaluateDeckSlots(5, 0), 2, '5 wins unlocks Slot 2');
    assert.strictEqual(evaluateDeckSlots(0, 10), 2, '10 perks unlocks Slot 2');
    assert.strictEqual(evaluateDeckSlots(15, 0), 3, '15 wins unlocks Slot 3');
    assert.strictEqual(evaluateDeckSlots(30, 0), 4, '30 wins unlocks Slot 4');
    assert.strictEqual(evaluateDeckSlots(50, 0), 5, '50 wins unlocks Slot 5');
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-15: Random Perk Upkeep Dormancy Display (INV-PERK-UI-1)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-15', 'Random Perk Upkeep Dormancy Display (INV-PERK-UI-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      players: ['p1', 'p2'],
      autoConnect: false
    });
    await app.mount(container);

    // Turn 1 in 1v1 -> Dormant until Turn 4
    app.priorityMachine.turnNumber = 1;
    app.reconcileDOM();

    const emblemTurn1 = container.querySelector('#command-emblem-text');
    assert.ok(emblemTurn1, '#command-emblem-text must exist');
    assert.ok(emblemTurn1.textContent.includes('Dormant until Turn 4'), 'Turn 1 must display dormancy until Turn 4');

    // Turn 4 arrives
    app.priorityMachine.turnNumber = 4;
    app.priorityMachine.currentPhaseStep = 'upkeep';
    app.reconcileDOM();

    const emblemTurn4 = container.querySelector('#command-emblem-text');
    assert.ok(emblemTurn4.textContent.includes('Active'), 'Turn 4 must display Perk Emblem: Active');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-16: Spanish Vernacular Action Lexing (Sub-2ms SLA)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-16', 'Spanish Vernacular Action Lexing (Sub-2ms SLA)', async () => {
    const pPantano = ActionLexer.parse('bajo pantano');
    assert.strictEqual(pPantano.actionType, 'PLAY_LAND');
    assert.strictEqual(pPantano.params.canonicalLandName, 'Swamp');

    const pTierraNegra = ActionLexer.parse('bajo una tierra negra');
    assert.strictEqual(pTierraNegra.actionType, 'PLAY_LAND');
    assert.strictEqual(pTierraNegra.params.canonicalLandName, 'Swamp');

    const pDice = ActionLexer.parse('roll dice');
    assert.strictEqual(pDice.actionType, 'ROLL_DICE');

    // Benchmark 100 parses for sub-2ms SLA
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      ActionLexer.parse('bajo pantano');
      ActionLexer.parse('bajo una tierra negra');
      ActionLexer.parse('roll dice');
    }
    const t1 = performance.now();
    const avgMs = (t1 - t0) / 300;
    console.log(`    -> ActionLexer Benchmark: 300 parses in ${(t1 - t0).toFixed(2)}ms (Avg: ${avgMs.toFixed(4)}ms/parse)`);
    assert.ok(avgMs < 2.0, 'SLA must be strictly sub-2ms per parse');
  });

  // --------------------------------------------------------------------------
  // TC-PLATFORM-17: Pre-Game d20 Roll-Off, Tie-Break Loop & Turn Sorting (INV-TURNSORT-1)
  // --------------------------------------------------------------------------
  await test('TC-PLATFORM-17', 'Pre-Game d20 Roll-Off, Tie-Break Loop & Turn Sorting (INV-TURNSORT-1)', async () => {
    const rollOff = new TurnRollOffManager(['alice', 'bob', 'charlie']);

    // Round 1: Alice: 18, Bob: 18 (tie!), Charlie: 10
    rollOff.submitRoll('alice', 18);
    rollOff.submitRoll('bob', 18);
    rollOff.submitRoll('charlie', 10);

    const r1 = rollOff.evaluateRound();
    assert.strictEqual(r1.isComplete, false, 'Tie detected on round 1');
    assert.strictEqual(r1.hasTies, true);
    assert.deepStrictEqual(r1.tiedPlayerIds.sort(), ['alice', 'bob']);

    // Round 2 (Tie-break round between Alice and Bob): Alice: 19, Bob: 12
    rollOff.submitRoll('alice', 19);
    rollOff.submitRoll('bob', 12);

    const r2 = rollOff.evaluateRound();
    assert.strictEqual(r2.isComplete, true, 'Strict total order established on round 2');
    assert.deepStrictEqual(r2.sortedPlayers, ['alice', 'bob', 'charlie']);
    assert.strictEqual(r2.sortedPlayers[0], 'alice', 'Highest roller takes Turn 1');
  });

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log('\n==================================================================');
  console.log(`Summary: ${passedTests} passed, ${failedTests} failed.`);
  console.log('==================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite();
