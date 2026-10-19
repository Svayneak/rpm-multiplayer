/**
 * test/test_battle_spectator.js
 * Acceptance Test Suite for Feature 16:
 * Lobby Hub & Spectator Directory, Battle Mechanics Enforcement, and Phase Step Tracker
 * 
 * Document ID: SPEC-RPM-BATTLE-016
 * Formal Invariants Verified:
 * - INV-HUB-1: Universal Lobby Landing & Mode Selector Hub
 * - INV-SPEC-1: Zero-Auth Spectator Directory & Read-Only Viewing
 * - INV-AUTH-GATE-2: Contextual Participant Auth & Mandatory Deck Gate
 * - INV-COUNTDOWN-1: Synchronized 3-Second Start Countdown with Atomic Abort
 * - INV-PHASE-1: Turn Phase Marker Strip, 1-Tap Advance & Consensus Flow
 * - INV-TURN-LAYER-1: Two-Layer Turn (T_player) and Round (R_table) System
 * - INV-LAND-1: 1 Land Per Turn Mechanics (CR 305.1 & CR 305.2)
 * - INV-STACK-RESOLVE-1: Permanent Spell Resolution to Battlefield (CR 608.3 & CR 608.2k)
 */

import assert from 'node:assert';
import {
  AuthManager,
  RPMAppController,
  TabRouter,
  TABS,
  LobbyManager,
  LOBBY_STATUS,
  TabletopStateManager,
  PriorityStateMachine,
  SEVEN_PHASE_STEPS,
  TWELVE_PHASE_STEPS,
  LandLimitExceededError,
  PhaseTimingError,
  PriorityViolationError,
  SpectatorPermissionError,
  DualChannelChat
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
    if (name === 'id') this.id = '';
    if (name === 'class') this.className = '';
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

class MockLocalStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, val) {
    this.store.set(key, String(val));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
  get length() {
    return this.store.size;
  }
  key(index) {
    return Array.from(this.store.keys())[index] || null;
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
    console.log(`  \x1b[32m✔\x1b[0m [PASS] \x1b[1m${id}\x1b[0m: ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`  \x1b[31m✖\x1b[0m [FAIL] \x1b[1m${id}\x1b[0m: ${description}`);
    console.error(`    \x1b[31m${err.message}\x1b[0m`);
    if (err.stack) {
      const lines = err.stack.split('\n').slice(1, 4).join('\n');
      console.error(`    \x1b[90m${lines}\x1b[0m`);
    }
    failedTests++;
  }
}

// ============================================================================
// Acceptance Test Suite (TC-BATTLE-01 through TC-BATTLE-16)
// ============================================================================

async function runTestSuite() {
  console.log('\n==================================================================');
  console.log('  RUNNING FEATURE 16 ACCEPTANCE TEST SUITE');
  console.log('  Specification: SPEC-RPM-BATTLE-016');
  console.log('==================================================================\n');

  // --------------------------------------------------------------------------
  // TC-BATTLE-01: Universal Lobby Landing & Mode Selector Hub (INV-HUB-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-01', 'Universal Lobby Landing & Mode Selector Hub (INV-HUB-1)', async () => {
    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      authManager: auth,
      autoConnect: false,
      requireAuth: true
    });
    await app.mount(container);

    // Initial boot tab must be LOBBY
    assert.strictEqual(app.tabRouter.getCurrentTab(), 'LOBBY', 'Initial tab must be LOBBY under INV-HUB-1');

    // Mode Selector Hub rendered
    const modeSelector = container.querySelector('#lobby-mode-selector') || container.querySelector('.mode-selector-grid');
    assert.ok(modeSelector, 'Mode Selector Hub must be rendered on lobby landing');

    // Spectator directory rendered
    const spectatorSection = container.querySelector('#spectator-directory-table') || container.querySelector('.spectator-directory-section');
    assert.ok(spectatorSection, 'Spectator Directory section must be rendered');

    // Assert zero blocking auth modal
    const authModal = container.querySelector('#contextual-auth-modal') || container.querySelector('#auth-modal');
    const isAuthModalOpen = authModal && authModal.style.display !== 'none';
    assert.strictEqual(Boolean(isAuthModalOpen), false, 'Universal landing must not be blocked by auth modal');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-02: Zero-Auth Ongoing Match Directory Rendering (INV-SPEC-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-02', 'Zero-Auth Ongoing Match Directory Rendering (INV-SPEC-1)', async () => {
    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      authManager: auth,
      autoConnect: false,
      requireAuth: true
    });
    await app.mount(container);

    const mockMatches = [
      {
        roomCode: 'POD-1',
        roomType: 'POD_MULTIPLAYER',
        format: 'Commander',
        status: 'MATCH_ACTIVE',
        roundNumber: 3,
        activePlayerTurnNumber: 2,
        activePlayerName: 'Alice',
        seatedPlayers: [{ playerName: 'Alice' }, { playerName: 'Bob' }],
        spectatorCount: 4
      },
      {
        roomCode: 'DUEL-2',
        roomType: 'DUEL_1V1',
        format: 'Modern',
        status: 'MATCH_ACTIVE',
        roundNumber: 5,
        activePlayerTurnNumber: 5,
        activePlayerName: 'Gideon',
        seatedPlayers: [{ playerName: 'Gideon' }, { playerName: 'Jace' }],
        spectatorCount: 12
      },
      {
        roomCode: 'PRIV-3',
        roomType: 'CUSTOM_ROOM',
        format: 'Casual',
        status: 'MATCH_ACTIVE',
        roundNumber: 1,
        activePlayerTurnNumber: 1,
        activePlayerName: 'Carlos',
        seatedPlayers: [{ playerName: 'Carlos' }],
        spectatorCount: 1
      }
    ];

    app.setSpectatorMatches(mockMatches);

    const dirBody = container.querySelector('#spectator-matches-tbody') || container.querySelector('#spectator-matches-body');
    assert.ok(dirBody, 'Spectator directory table body must exist');
    const rows = dirBody.querySelectorAll('tr');
    assert.strictEqual(rows.length, 3, 'Must render exactly 3 match rows in directory');
    assert.strictEqual(auth.isAuthenticated(), false, 'Guest user must remain unauthenticated with zero login prompt');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-03: Zero-Auth Spectator Route & Read-Only Viewing (INV-SPEC-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-03', 'Zero-Auth Spectator Route & Read-Only Viewing (INV-SPEC-1)', async () => {
    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      authManager: auth,
      autoConnect: false,
      requireAuth: true
    });
    await app.mount(container);

    // Watch DUEL-2 without authenticating
    app.watchMatch('DUEL-2');

    assert.strictEqual(app.isSpectator(), true, 'isSpectator must be true');
    assert.strictEqual(app.tabRouter.getCurrentTab(), 'ARENA', 'Spectator must navigate to ARENA tab');

    // Controls must be disabled or hidden for spectator
    const btnPass = container.querySelector('#btn-pass-priority');
    if (btnPass) {
      assert.ok(btnPass.disabled || btnPass.style.display === 'none', 'Pass priority must be disabled or hidden');
    }
    const btnHold = container.querySelector('#btn-hold-respond');
    if (btnHold) {
      assert.ok(btnHold.disabled || btnHold.style.display === 'none', 'Hold priority must be disabled or hidden');
    }
    const btnNext = container.querySelector('#btn-next-phase');
    if (btnNext) {
      assert.ok(btnNext.disabled || btnNext.style.display === 'none', 'Next phase button must be hidden for spectator');
    }

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-04: Spectator Chat Tag & Command Permission Gate (INV-SPEC-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-04', 'Spectator Chat Tag & Command Permission Gate (INV-SPEC-1)', async () => {
    const chat = new DualChannelChat({
      myPlayerId: 'spectator_user_1',
      username: 'CasualWatcher',
      isSpectator: true
    });

    // Casual chat is permitted and tagged
    const casualMsg = chat.sendChitChat('Incredible match!');
    assert.ok(
      (casualMsg.senderName && casualMsg.senderName.includes('[Spectator]')) ||
      (casualMsg.text && casualMsg.text.includes('[Spectator]')),
      'Casual chit-chat must be tagged with [Spectator]'
    );

    // Gameplay commands must be strictly rejected
    assert.throws(() => {
      chat.sendTurnCommand('CAST Lightning Bolt');
    }, SpectatorPermissionError, 'Sending turn command as spectator must throw SpectatorPermissionError');
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-05: Contextual Participant Auth Gate Interception (INV-AUTH-GATE-2)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-05', 'Contextual Participant Auth Gate Interception (INV-AUTH-GATE-2)', async () => {
    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      authManager: auth,
      autoConnect: false,
      requireAuth: true
    });
    await app.mount(container);

    assert.strictEqual(auth.isAuthenticated(), false);

    // Unauthenticated user attempts to claim seat 1
    const claimed = app.claimLobbySeat(1);
    assert.strictEqual(claimed, false, 'Unauthenticated seat claim must be intercepted');

    // Contextual auth modal opens
    const authModal = container.querySelector('#contextual-auth-modal') || container.querySelector('.auth-modal-backdrop');
    assert.ok(authModal, 'Contextual auth modal must open upon asserting participant intent');

    // Seat remains open
    assert.strictEqual(app.lobbyManager.slots.get(1), undefined, 'Seat must remain open until authentication completes');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-06: Contextual Mandatory Deck Creator Gate Interception (INV-AUTH-GATE-2)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-06', 'Contextual Mandatory Deck Creator Gate Interception (INV-AUTH-GATE-2)', async () => {
    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });
    const email = `pilot_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@tabletop.com`;
    await auth.instantDevLogin(email, 'Pilot', '1995-05-05');
    assert.strictEqual(auth.isAuthenticated(), true);
    assert.strictEqual(auth.isOnboarded(), false);

    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      authManager: auth,
      autoConnect: false,
      requireAuth: true
    });
    await app.mount(container);

    // Attempt to queue for 1v1 Ranked Matchmaking
    const queued = app.startMatchmaking();
    assert.strictEqual(queued, false, 'Queue entry must be blocked when user has no active deck');

    // Deck Creator modal opens
    const deckModal = container.querySelector('#contextual-deck-modal') || container.querySelector('.deck-modal-backdrop');
    assert.ok(deckModal, 'Mandatory Deck Creator modal must open');

    // Complete onboarding by saving active deck
    await app.authManager.saveActiveDeck('MODERN_BURN_R');
    assert.strictEqual(app.authManager.isOnboarded(), true, 'Pilot is now onboarded');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-07: Synchronized 3-Second Start Countdown Engine (INV-COUNTDOWN-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-07', 'Synchronized 3-Second Start Countdown Engine (INV-COUNTDOWN-1)', async () => {
    const lobby = new LobbyManager({ roomCode: 'POD_7', minPlayers: 3, maxCapacity: 6 });
    lobby.claimSeat('p1', 'Alice', 1);
    lobby.claimSeat('p2', 'Bob', 2);
    lobby.claimSeat('p3', 'Charlie', 3);

    let tickReceived = false;
    lobby.on('COUNTDOWN_TICK', (evt) => {
      if (evt.secondsRemaining === 3) tickReceived = true;
    });

    lobby.setReady('p1', true);
    lobby.setReady('p2', true);
    lobby.setReady('p3', true);

    assert.strictEqual(lobby.status, LOBBY_STATUS.LOBBY_COUNTDOWN, 'Status must transition to LOBBY_COUNTDOWN');
    assert.strictEqual(lobby.countdownSecondsRemaining, 3, 'Countdown must start at 3 seconds');
    assert.strictEqual(tickReceived, true, 'COUNTDOWN_TICK event must be dispatched');

    lobby.abortCountdown('test_cleanup');
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-08: Synchronized Countdown Atomic Abort on Mutation (INV-COUNTDOWN-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-08', 'Synchronized Countdown Atomic Abort on Mutation (INV-COUNTDOWN-1)', async () => {
    const lobby = new LobbyManager({ roomCode: 'POD_8', minPlayers: 3, maxCapacity: 6 });
    lobby.claimSeat('p1', 'Alice', 1);
    lobby.claimSeat('p2', 'Bob', 2);
    lobby.claimSeat('p3', 'Charlie', 3);

    lobby.setReady('p1', true);
    lobby.setReady('p2', true);
    lobby.setReady('p3', true);
    assert.strictEqual(lobby.status, LOBBY_STATUS.LOBBY_COUNTDOWN);

    let abortReason = null;
    lobby.on('COUNTDOWN_ABORTED', (evt) => {
      abortReason = evt.reason;
    });

    // Player 2 un-confirms readiness
    lobby.setReady('p2', false);

    assert.strictEqual(lobby.status, LOBBY_STATUS.READY_CHECK, 'Lobby must revert to READY_CHECK');
    assert.strictEqual(lobby.countdownSecondsRemaining, null, 'Countdown timer must be cleared');
    assert.strictEqual(abortReason, 'PLAYER_UNREADY', 'Abort reason must indicate player unready');
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-09: Synchronized Countdown Completion to Roll-Off (INV-COUNTDOWN-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-09', 'Synchronized Countdown Completion to Roll-Off (INV-COUNTDOWN-1)', async () => {
    const lobby = new LobbyManager({ roomCode: 'POD_9', minPlayers: 3, maxCapacity: 6 });
    lobby.claimSeat('p1', 'Alice', 1);
    lobby.claimSeat('p2', 'Bob', 2);
    lobby.claimSeat('p3', 'Charlie', 3);

    lobby.setReady('p1', true);
    lobby.setReady('p2', true);
    lobby.setReady('p3', true);

    // Fast-forward countdown by launching 1s duration
    lobby.startCountdown(1);

    await new Promise(r => setTimeout(r, 1150));

    assert.strictEqual(lobby.status, LOBBY_STATUS.ROLL_OFF_PHASE, 'Room must transition to ROLL_OFF_PHASE on countdown zero');
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-10: Turn Phase Marker Strip Rendering (INV-PHASE-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-10', 'Turn Phase Marker Strip Rendering (INV-PHASE-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      use7Steps: true,
      myPlayerId: 'p1',
      username: 'Alice'
    });
    await app.mount(container);

    app.priorityMachine.setPhaseStep('PRECOMBAT_MAIN');
    app.reconcileDOM();

    const track = container.querySelector('#arena-phase-track');
    assert.ok(track, 'Phase track container must exist');

    const pills = track.querySelectorAll('.phase-step');
    assert.strictEqual(pills.length, 7, 'Must render exactly 7 canonical phase steps');

    const activePill = track.querySelector('.phase-step.active') || track.querySelector('.phase-active-step');
    assert.ok(activePill, 'Active phase pill must have .active / .phase-active-step class');
    assert.strictEqual(activePill.getAttribute('data-step'), 'MAIN 1', 'Active step must match MAIN 1');

    const activePlayerBadge = container.querySelector('#active-player-name');
    assert.ok(activePlayerBadge && activePlayerBadge.textContent.includes('P1'), 'Active player badge must display P1');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-11: 1-Tap [⏭️ Next Phase] Manual Dispatch (INV-PHASE-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-11', '1-Tap [⏭️ Next Phase] Manual Dispatch (INV-PHASE-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      use7Steps: true,
      myPlayerId: 'p1'
    });
    await app.mount(container);

    app.priorityMachine.setPhaseStep('PRECOMBAT_MAIN');

    let phaseChangedEvt = null;
    app.priorityMachine.on('PHASE_STEP_CHANGED', (evt) => {
      phaseChangedEvt = evt;
    });

    // 1-Tap shortcut
    const nextStep = app.priorityMachine.nextPhase('p1');
    assert.strictEqual(nextStep, 'COMBAT', 'Tapping next phase from PRECOMBAT_MAIN must transition directly to COMBAT');
    assert.strictEqual(app.priorityMachine.currentPhaseStep, 'COMBAT');
    assert.ok(phaseChangedEvt, 'PHASE_STEP_CHANGED event must be emitted');

    app.reconcileDOM();
    const activePill = container.querySelector('.phase-step.active') || container.querySelector('.phase-active-step');
    assert.strictEqual(activePill?.getAttribute('data-step'), 'COMBAT', 'Phase track active step must highlight COMBAT');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-12: Empty-Stack Consecutive Pass Consensus Auto-Advance (INV-PHASE-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-12', 'Empty-Stack Consecutive Pass Consensus Auto-Advance (INV-PHASE-1)', async () => {
    const psm = new PriorityStateMachine({
      players: ['p1', 'p2'],
      activePlayerId: 'p1',
      priorityPlayerId: 'p1',
      initialPhaseStep: 'UPKEEP',
      use7Steps: true
    });

    assert.strictEqual(psm.currentPhaseStep, 'UPKEEP');
    assert.strictEqual(psm.getStackDepth(), 0);

    // P1 passes priority to P2
    psm.dispatch('PASS_PRIORITY', { playerId: 'p1' });
    assert.strictEqual(psm.priorityPlayerId, 'p2');
    assert.strictEqual(psm.currentPhaseStep, 'UPKEEP');

    // P2 passes priority consecutively -> Consensus reached on empty stack
    const res = psm.dispatch('PASS_PRIORITY', { playerId: 'p2' });
    assert.strictEqual(res.status, 'PHASE_ADVANCED');
    assert.strictEqual(psm.currentPhaseStep, 'DRAW', 'Phase must automatically advance to DRAW (CR 500.2)');
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-13: Two-Layer Turn & Round Counter System (INV-TURN-LAYER-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-13', 'Two-Layer Turn & Round Counter System (INV-TURN-LAYER-1)', async () => {
    const psm = new PriorityStateMachine({
      players: ['p1', 'p2', 'p3', 'p4'],
      activePlayerId: 'p1',
      startingPlayerId: 'p1',
      phaseSteps: ['UNTAP', 'CLEANUP']
    });

    assert.strictEqual(psm.roundNumber, 1, 'Initial table round must be 1');
    assert.strictEqual(psm.getPlayerTurnCount('p1'), 1, 'P1 initial turn must be 1');
    assert.strictEqual(psm.getPlayerTurnCount('p2'), 1, 'P2 initial turn must be 1');
    assert.strictEqual(psm.getPlayerTurnCount('p3'), 1, 'P3 initial turn must be 1');
    assert.strictEqual(psm.getPlayerTurnCount('p4'), 1, 'P4 initial turn must be 1');

    // P1 completes Turn 1
    psm.setPhaseStep('CLEANUP');
    psm.advanceStep();
    assert.strictEqual(psm.activePlayerId, 'p2');
    assert.strictEqual(psm.roundNumber, 1, 'Round must remain 1 on P2 turn');
    assert.strictEqual(psm.getPlayerTurnCount('p2'), 1);

    // P2 completes Turn 1
    psm.setPhaseStep('CLEANUP');
    psm.advanceStep();
    assert.strictEqual(psm.activePlayerId, 'p3');
    assert.strictEqual(psm.roundNumber, 1, 'Round must remain 1 on P3 turn');
    assert.strictEqual(psm.getPlayerTurnCount('p3'), 1);

    // P3 completes Turn 1
    psm.setPhaseStep('CLEANUP');
    psm.advanceStep();
    assert.strictEqual(psm.activePlayerId, 'p4');
    assert.strictEqual(psm.roundNumber, 1, 'Round must remain 1 on P4 turn');
    assert.strictEqual(psm.getPlayerTurnCount('p4'), 1);

    // P4 completes Turn 1 -> Turn rotates back to P1 (starting player)
    psm.setPhaseStep('CLEANUP');
    psm.advanceStep();

    assert.strictEqual(psm.activePlayerId, 'p1');
    assert.strictEqual(psm.roundNumber, 2, 'Table round R_table must increment to 2 when turn hands back to starting player');
    assert.strictEqual(psm.getPlayerTurnCount('p1'), 2, 'Player turn T_player(P1) must increment to 2 upon UNTAP');
    assert.strictEqual(psm.getPlayerTurnCount('p2'), 1, 'P2 has not yet untaped for Turn 2');
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-14: 1 Land Per Turn Limit & Rejection (INV-LAND-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-14', '1 Land Per Turn Limit & Rejection (INV-LAND-1)', async () => {
    const tabletop = new TabletopStateManager({ players: ['p1', 'p2'] });
    const p1 = tabletop.getPlayer('p1');

    const forest1 = { instanceId: 'forest_1', name: 'Forest', typeLine: 'Basic Land — Forest' };
    const forest2 = { instanceId: 'forest_2', name: 'Forest', typeLine: 'Basic Land — Forest' };
    p1.hand.push(forest1, forest2);

    assert.strictEqual(p1.landsPlayedThisTurn, 0);

    // Play 1st land successfully
    const res1 = tabletop.playLand('p1', forest1);
    assert.strictEqual(res1.landsPlayedThisTurn, 1);
    assert.strictEqual(p1.battlefield.lands.length, 1);
    assert.strictEqual(p1.hand.length, 1);

    // Attempt to play 2nd land in same turn -> Must throw LandLimitExceededError
    assert.throws(() => {
      tabletop.playLand('p1', forest2);
    }, LandLimitExceededError, 'Playing a 2nd land must throw LandLimitExceededError');

    // 2nd land remains safely in hand, battlefield unchanged
    assert.strictEqual(p1.battlefield.lands.length, 1);
    assert.strictEqual(p1.hand.length, 1);
    assert.strictEqual(p1.hand[0].instanceId, 'forest_2');
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-15: Land Limit Quota Reset on UNTAP Step (INV-LAND-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-15', 'Land Limit Quota Reset on UNTAP Step (INV-LAND-1)', async () => {
    const tabletop = new TabletopStateManager({ players: ['p1', 'p2'] });
    const p1 = tabletop.getPlayer('p1');

    const forest1 = { instanceId: 'forest_1', name: 'Forest', typeLine: 'Basic Land — Forest' };
    const forest2 = { instanceId: 'forest_2', name: 'Forest', typeLine: 'Basic Land — Forest' };
    p1.hand.push(forest1, forest2);

    tabletop.playLand('p1', forest1);
    assert.strictEqual(p1.landsPlayedThisTurn, 1);

    // Simulate turn ending and rotating back to P1 UNTAP step
    tabletop.resetTurnQuotas('p1');
    assert.strictEqual(p1.landsPlayedThisTurn, 0, 'Lands played counter must reset to 0 upon UNTAP');

    // P1 can now play their 2nd land for Turn 2
    const res2 = tabletop.playLand('p1', forest2);
    assert.strictEqual(res2.landsPlayedThisTurn, 1);
    assert.strictEqual(p1.battlefield.lands.length, 2);
    assert.strictEqual(p1.hand.length, 0);
  });

  // --------------------------------------------------------------------------
  // TC-BATTLE-16: Permanent Spell Resolution to Battlefield (INV-STACK-RESOLVE-1)
  // --------------------------------------------------------------------------
  await test('TC-BATTLE-16', 'Permanent Spell Resolution to Battlefield (INV-STACK-RESOLVE-1)', async () => {
    const tabletop = new TabletopStateManager({ players: ['p1', 'p2'] });
    const p1 = tabletop.getPlayer('p1');

    const bearCard = {
      instanceId: 'bear_1',
      name: 'Grizzly Bears',
      typeLine: 'Creature — Bear',
      isPermanent: true,
      ownerId: 'p1',
      controllerId: 'p1'
    };

    const resolved = tabletop.handleStackResolution({
      id: 'stack_item_bear',
      sourcePlayerId: 'p1',
      controllerId: 'p1',
      card: bearCard
    });

    assert.strictEqual(resolved.destinationZone, 'battlefield', 'Creature spell must resolve to battlefield');
    assert.strictEqual(resolved.destinationSubzone, 'creatures', 'Creature must be routed to creatures subzone');

    assert.strictEqual(p1.battlefield.creatures.length, 1, 'battlefield.creatures must contain Grizzly Bears');
    assert.strictEqual(p1.battlefield.creatures[0].name, 'Grizzly Bears');
    assert.strictEqual(p1.battlefield.creatures[0].summoningSickness, true, 'Summoning sickness must be applied on entry');
    assert.strictEqual(p1.graveyard.length, 0, 'Grizzly Bears must NOT be placed in the graveyard');

    // Instant spell resolution test
    const boltCard = {
      instanceId: 'bolt_1',
      name: 'Lightning Bolt',
      typeLine: 'Instant',
      isPermanent: false,
      ownerId: 'p1',
      controllerId: 'p1'
    };

    const resolvedBolt = tabletop.handleStackResolution({
      id: 'stack_item_bolt',
      sourcePlayerId: 'p1',
      controllerId: 'p1',
      card: boltCard
    });

    assert.strictEqual(resolvedBolt.destinationZone, 'graveyard', 'Instant spell must resolve to graveyard (CR 608.2m)');
    assert.strictEqual(p1.graveyard.length, 1);
    assert.strictEqual(p1.graveyard[0].name, 'Lightning Bolt');
  });

  // ==========================================================================
  // Test Run Summary
  // ==========================================================================
  console.log('\n==================================================================');
  console.log(`  FEATURE 16 TEST RESULTS: ${passedTests} passed, ${failedTests} failed`);
  console.log('==================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite();
