/**
 * test/test_onboarding_lobby.js
 * Comprehensive Acceptance Test Suite for Feature 15:
 * Player Registration, Onboarding Lifecycle, Perkins Pod Seating & Telemetry Engine
 * 
 * Document ID: SPEC-RPM-ONBOARD-015
 * Enforces Architectural Invariants:
 * - INV-AUTH-1: Authentication Gate & Session Persistence
 * - INV-ONBOARD-1: Mandatory Deck Creator Gate
 * - INV-LOBBY-4: 1-Player = 1-Seat Invariant (Atomic Vacate on Seat Hopping)
 * - INV-LOBBY-5: Perkins Bot Pod Seating & Dynamic Readiness
 * - INV-LOBBY-6: Multi-Bot Autonomous Arena Execution & Zero Phantom Opponents
 * - INV-ROUTER-2: Lobby Hub Default Routing
 * - INV-TELEMETRY-1: Event Logging & Non-Blocking Audit Trail
 */

import assert from 'node:assert';
import {
  AuthManager,
  STARTER_ARCHETYPES,
  STARTER_ALIASES,
  getStarterDeck,
  calculateAge,
  generateUUID,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  RPMAppController,
  TabRouter,
  TABS,
  LobbyManager,
  DeckValidator,
  TabletopStateManager,
  PerkinsAgent
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
// Acceptance Test Vectors: TC-ONBOARD-01 through TC-ONBOARD-14
// ============================================================================

async function runTestSuite() {
  console.log('\n==================================================================');
  console.log('  RUNNING FEATURE 15 ACCEPTANCE TEST SUITE');
  console.log('  Specification: SPEC-RPM-ONBOARD-015');
  console.log('==================================================================\n');

  // --------------------------------------------------------------------------
  // TC-ONBOARD-01: Unauthenticated User Trapped in Auth Gate (INV-AUTH-1)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-01', 'Unauthenticated User Trapped in Auth Gate (INV-AUTH-1)', async () => {
    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });
    const router = new TabRouter({ initialTab: 'AUTH' });
    const context = {
      isAuthenticated: auth.isAuthenticated(),
      isOnboarded: auth.isOnboarded()
    };

    assert.strictEqual(auth.isAuthenticated(), false, 'AuthManager must start unauthenticated');
    assert.strictEqual(router.canNavigate('LOBBY', context), false, 'Lobby navigation must be blocked for unauthenticated users');
    assert.strictEqual(router.canNavigate('ARENA', context), false, 'Arena navigation must be blocked for unauthenticated users');
    assert.strictEqual(router.canNavigate('DECKBUILDER', context), false, 'Deckbuilder navigation must be blocked for unauthenticated users');
    assert.strictEqual(router.canNavigate('AUTH', context), true, 'Auth view must be permitted');

    const navAttempt = router.navigate('LOBBY', context);
    assert.strictEqual(navAttempt.success, false, 'Navigation to LOBBY must fail');
    assert.strictEqual(navAttempt.reason, 'AUTH_REQUIRED', 'Failure reason must be AUTH_REQUIRED');
    assert.strictEqual(router.getCurrentTab(), 'AUTH', 'Router must remain on AUTH tab');
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-02: Supabase Magic Link OTP Request & Verification (INV-AUTH-1)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-02', 'Supabase Magic Link OTP Request & Verification (INV-AUTH-1)', async () => {
    const storage = new MockLocalStorage();
    let requestedOtp = null;
    let verifiedOtp = null;

    const mockFetch = async (url, opts) => {
      if (url.includes('/auth/v1/otp')) {
        requestedOtp = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ message: 'OTP sent' })
        };
      }
      if (url.includes('/auth/v1/verify')) {
        verifiedOtp = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'supabase_mock_jwt_token',
            user: { id: 'usr_supabase_123', email: verifiedOtp.email }
          })
        };
      }
      if (url.includes('/rest/v1/player_profiles')) {
        if (opts.method === 'POST') {
          return { ok: true, status: 201, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ([{
            id: 'usr_supabase_123',
            email: 'player@test.com',
            username: 'player',
            dob: '1998-05-20',
            elo: 1200,
            active_deck_id: null
          }])
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const auth = new AuthManager({ storage, fetch: mockFetch });

    const otpRes = await auth.sendMagicLink('player@test.com');
    assert.strictEqual(otpRes.success, true, 'Magic link request must succeed');
    assert.strictEqual(requestedOtp.email, 'player@test.com', 'Requested email must match');

    const verifyRes = await auth.verifyOtp('player@test.com', '123456');
    assert.strictEqual(verifyRes.success, true, 'OTP verification must succeed');
    assert.strictEqual(auth.isAuthenticated(), true, 'User must be authenticated');
    assert.strictEqual(auth.getCurrentUser().email, 'player@test.com', 'Email must match profile');
    assert.strictEqual(auth.getCurrentUser().id, 'usr_supabase_123', 'User ID must match profile');
    assert.strictEqual(auth.hasActiveDeck(), false, 'Initial user has no active deck');
    assert.strictEqual(auth.isOnboarded(), false, 'Initial user is not yet onboarded');
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-03: Instant Dev Bypass Login & Profile Persistence (INV-AUTH-1)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-03', 'Instant Dev Bypass Login & Profile Persistence (INV-AUTH-1)', async () => {
    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });

    // 1. Underage rejection (< 13 years old)
    let underAgeError = null;
    try {
      await auth.instantDevLogin('kid@tabletop.com', 'Kid', '2020-01-01');
    } catch (err) {
      underAgeError = err;
    }
    assert.ok(underAgeError, 'Underage login must throw error');
    assert.match(underAgeError.message, /13/, 'Error message must cite 13 years requirement');

    // 2. Invalid email format rejection
    let emailError = null;
    try {
      await auth.instantDevLogin('invalid-email-address', 'DevGuy', '1995-10-12');
    } catch (err) {
      emailError = err;
    }
    assert.ok(emailError, 'Invalid email format must throw error');

    // 3. Valid login
    const res = await auth.instantDevLogin('dev@tabletop.com', 'DevPlayer', '1995-10-12');
    assert.strictEqual(res.success, true, 'Instant dev login must succeed');
    assert.strictEqual(auth.isAuthenticated(), true, 'User must be authenticated');
    assert.strictEqual(auth.getCurrentUser().email, 'dev@tabletop.com');
    assert.strictEqual(auth.getCurrentUser().username, 'DevPlayer');
    assert.strictEqual(auth.getCurrentUser().dob, '1995-10-12');

    // 4. Persistence across reloads
    const reloadedAuth = new AuthManager({ storage });
    assert.strictEqual(reloadedAuth.isAuthenticated(), true, 'Reloaded manager must detect session');
    assert.strictEqual(reloadedAuth.getCurrentUser().email, 'dev@tabletop.com', 'Hydrated email must match');
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-04: Mandatory Deck Creator Gate Lockout (INV-ONBOARD-1)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-04', 'Mandatory Deck Creator Gate Lockout (INV-ONBOARD-1)', async () => {
    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });
    await auth.instantDevLogin('newbie@tabletop.com', 'Newbie', '1999-01-01');

    assert.strictEqual(auth.isAuthenticated(), true);
    assert.strictEqual(auth.hasActiveDeck(), false);
    assert.strictEqual(auth.isOnboarded(), false);

    const router = new TabRouter({ initialTab: 'AUTH' });
    const context = {
      isAuthenticated: auth.isAuthenticated(),
      isOnboarded: auth.isOnboarded()
    };

    assert.strictEqual(router.canNavigate('LOBBY', context), false, 'Lobby must be blocked without active deck');
    assert.strictEqual(router.canNavigate('ARENA', context), false, 'Arena must be blocked without active deck');
    assert.strictEqual(router.canNavigate('DECKBUILDER', context), true, 'Deckbuilder must be accessible');

    const navRes = router.navigate('LOBBY', context);
    assert.strictEqual(navRes.success, false, 'Navigation to LOBBY must be rejected');
    assert.strictEqual(navRes.reason, 'DECK_ONBOARDING_REQUIRED', 'Rejection reason must be DECK_ONBOARDING_REQUIRED');
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-05: Starter Deck Selection Transitions to Onboarded (INV-ONBOARD-1)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-05', 'Starter Deck Selection Transitions to Onboarded (INV-ONBOARD-1)', async () => {
    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });
    const email = `starter_${Date.now()}@tabletop.com`;
    await auth.instantDevLogin(email, 'StarterUser', '1996-03-15');
    assert.strictEqual(auth.isOnboarded(), false);

    const starter = STARTER_ARCHETYPES.MODERN_BURN_R;
    await auth.saveActiveDeck('MODERN_BURN_R', starter);

    assert.strictEqual(auth.hasActiveDeck(), true, 'User must have active deck');
    assert.strictEqual(auth.isOnboarded(), true, 'User must now be onboarded');
    assert.strictEqual(auth.getCurrentUser().activeDeckId, 'MODERN_BURN_R');

    const router = new TabRouter({ initialTab: 'DECKBUILDER' });
    const context = {
      isAuthenticated: auth.isAuthenticated(),
      isOnboarded: auth.isOnboarded()
    };
    assert.strictEqual(router.canNavigate('LOBBY', context), true, 'Lobby must unlock once onboarded');
    const navRes = router.navigate('LOBBY', context);
    assert.strictEqual(navRes.success, true);
    assert.strictEqual(router.getCurrentTab(), 'LOBBY');
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-06: Custom Decklist Validation & Onboarding Unlock (INV-ONBOARD-1)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-06', 'Custom Decklist Validation & Onboarding Unlock (INV-ONBOARD-1)', async () => {
    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });
    const email = `builder_${Date.now()}@tabletop.com`;
    await auth.instantDevLogin(email, 'DeckCrafter', '1994-07-22');
    assert.strictEqual(auth.isOnboarded(), false);

    const customDeck = `4 Lightning Bolt\n56 Mountain`;
    const report = DeckValidator.validateDeck(customDeck, { format: 'modern' });
    assert.strictEqual(report.isValid, true, 'Deck validation must pass for 60-card legal list');
    assert.strictEqual(report.mainCount, 60);

    const deckId = `deck_custom_${Date.now()}`;
    await auth.saveActiveDeck(deckId, report);

    assert.strictEqual(auth.hasActiveDeck(), true);
    assert.strictEqual(auth.isOnboarded(), true);

    const router = new TabRouter({ initialTab: 'DECKBUILDER' });
    const context = {
      isAuthenticated: auth.isAuthenticated(),
      isOnboarded: auth.isOnboarded()
    };
    assert.strictEqual(router.canNavigate('LOBBY', context), true, 'Lobby must unlock for custom deck');
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-07: 1-Player = 1-Seat Invariant on Seat Hop (INV-LOBBY-4)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-07', '1-Player = 1-Seat Invariant on Seat Hop (Screenshot 0 Fix) (INV-LOBBY-4)', async () => {
    const lobby = new LobbyManager({ roomCode: 'ROOM07', maxCapacity: 6 });
    lobby.claimSeat('p1', 'Alice', 1);
    assert.strictEqual(lobby.slots.get(1).playerId, 'p1');

    lobby.setReady('p1', true);
    assert.strictEqual(lobby.slots.get(1).isReady, true);

    // Alice hops to Seat 2
    lobby.claimSeat('p1', 'Alice', 2);

    // Invariant: Seat 1 is atomically vacated
    assert.strictEqual(lobby.slots.get(1), undefined, 'Seat 1 must be atomically vacated');
    assert.strictEqual(lobby.slots.get(2).playerId, 'p1', 'Seat 2 must be occupied by Alice');
    assert.strictEqual(lobby.slots.get(2).playerName, 'Alice');

    // Invariant: strictly 1 slot occupied by 'p1'
    const p1Slots = lobby.getSeatedSlots().filter(s => s.playerId === 'p1');
    assert.strictEqual(p1Slots.length, 1, 'Alice must occupy exactly one seat');

    // Invariant: readiness state reset on hopping
    assert.strictEqual(lobby.slots.get(2).isReady, false, 'Readiness must reset upon seat hopping');
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-08: Seat Perkins AI in Open Pod Slot (INV-LOBBY-5)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-08', 'Seat Perkins AI in Open Pod Slot (INV-LOBBY-5)', async () => {
    const lobby = new LobbyManager({ roomCode: 'ROOM08', maxCapacity: 6 });
    lobby.claimSeat('p1', 'Alice', 1);

    const bot2 = lobby.seatBot(2);
    const bot3 = lobby.seatBot(3);

    assert.strictEqual(bot2.isBot, true, 'Slot 2 must be marked as bot');
    assert.strictEqual(bot2.isReady, true, 'Bot slot 2 must default to ready');
    assert.strictEqual(bot2.playerId, 'bot_perkins_2');
    assert.strictEqual(bot2.playerName, 'Perkins AI #2');

    assert.strictEqual(bot3.isBot, true, 'Slot 3 must be marked as bot');
    assert.strictEqual(bot3.isReady, true, 'Bot slot 3 must default to ready');
    assert.strictEqual(bot3.playerId, 'bot_perkins_3');
    assert.strictEqual(bot3.playerName, 'Perkins AI #3');

    assert.strictEqual(lobby.getSeatedCount(), 3, 'Total seated count must be 3');
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-09: Bot Removal Resets Lobby Readiness (INV-LOBBY-1, INV-LOBBY-5)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-09', 'Bot Removal Resets Lobby Readiness (INV-LOBBY-1, INV-LOBBY-5)', async () => {
    const lobby = new LobbyManager({ roomCode: 'ROOM09', maxCapacity: 6 });
    lobby.claimSeat('p1', 'Alice', 1);
    lobby.seatBot(2);

    lobby.setReady('p1', true);
    assert.strictEqual(lobby.slots.get(1).isReady, true);

    // Remove bot from Slot 2
    lobby.removeBot(2);
    assert.strictEqual(lobby.slots.get(2), undefined, 'Slot 2 must be vacated');

    // Human ready state must be invalidated
    assert.strictEqual(lobby.slots.get(1).isReady, false, 'Host readiness must be invalidated when bot is removed');
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-10: Multi-Bot Arena Initialization & Zero Phantom Opponents (INV-LOBBY-6)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-10', 'Multi-Bot Arena Initialization & Zero Phantom Opponents (Screenshot 1 Fix) (INV-LOBBY-6)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      myPlayerId: 'p1',
      username: 'HostAlice'
    });
    await app.mount(container);

    app.lobbyManager.claimSeat('p1', 'HostAlice', 1);
    app.lobbyManager.seatBot(2);
    app.lobbyManager.seatBot(3);

    // Start match with seated slots
    app.startMatch({
      playerIds: ['p1', 'bot_perkins_2', 'bot_perkins_3']
    });

    const registeredKeys = Object.keys(app.tabletopState.players);

    // Invariant: Legacy 'p2' phantom opponent is strictly absent
    assert.strictEqual(registeredKeys.includes('p2'), false, 'Legacy default p2 must not exist in state');
    assert.deepStrictEqual(registeredKeys.sort(), ['bot_perkins_2', 'bot_perkins_3', 'p1'].sort(), 'Players registered must match seated pod exactly');

    // Distinct Perkins agents instantiated for seated bots
    assert.strictEqual(app.botAgents.size, 2, 'Exactly 2 Perkins agents must be active');
    assert.strictEqual(app.botAgents.has('bot_perkins_2'), true);
    assert.strictEqual(app.botAgents.has('bot_perkins_3'), true);

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-11: Hub Routing to Lobby on Boot (INV-ROUTER-2)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-11', 'Hub Routing to Lobby on Boot (INV-ROUTER-2)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });
    await auth.instantDevLogin('hubplayer@tabletop.com', 'HubPlayer', '1993-02-14');
    await auth.saveActiveDeck('MODERN_BURN_R');

    const app = new RPMAppController({
      container,
      authManager: auth,
      autoConnect: false,
      requireAuth: true
    });
    await app.mount(container);

    // Hub defaults to LOBBY
    assert.strictEqual(app.tabRouter.getCurrentTab(), 'LOBBY', 'Default hub tab must be LOBBY');

    // Arena is disabled when match is not active
    assert.strictEqual(app.tabRouter.canNavigate('ARENA', app.getMatchState()), false, 'Arena tab navigation must be locked before match start');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-12: Scryfall Ruling Inspection Telemetry Dispatch (INV-TELEMETRY-1)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-12', 'Scryfall Ruling Inspection Telemetry Dispatch (INV-TELEMETRY-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });
    await auth.instantDevLogin('telemetry1@tabletop.com', 'TelemetryUser1', '1990-01-01');

    let interceptedEvent = null;
    auth.on('telemetry', (e) => {
      if (e.event_type === 'RULING_INSPECT') interceptedEvent = e;
    });

    const app = new RPMAppController({
      container,
      authManager: auth,
      autoConnect: false
    });
    await app.mount(container);

    app.openModal('CARD_OVERLAY', {
      name: 'Murktide Regent',
      id: 'scryfall_murktide_123',
      rulings_count: 3
    });

    assert.ok(interceptedEvent, 'RULING_INSPECT event must be emitted');
    assert.strictEqual(interceptedEvent.card_name, 'Murktide Regent');
    assert.strictEqual(interceptedEvent.details.scryfall_id, 'scryfall_murktide_123');
    assert.ok(interceptedEvent.created_at, 'Event must include timestamp');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-13: Perk Upkeep Dice Roll Telemetry Dispatch (INV-TELEMETRY-1)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-13', 'Perk Upkeep Dice Roll Telemetry Dispatch (INV-TELEMETRY-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const storage = new MockLocalStorage();
    const auth = new AuthManager({ storage });
    await auth.instantDevLogin('telemetry2@tabletop.com', 'TelemetryUser2', '1990-01-01');

    let perkEvent = null;
    auth.on('telemetry', (e) => {
      if (e.event_type === 'PERK_ACTIVATION') perkEvent = e;
    });

    const app = new RPMAppController({
      container,
      authManager: auth,
      autoConnect: false
    });
    await app.mount(container);

    app.handlePerkRolled({
      tens: 5,
      ones: 5,
      matchedKey: '55',
      perk_key: 55,
      effect_name: 'Twin Bolt',
      isMiss: false
    });

    assert.ok(perkEvent, 'PERK_ACTIVATION event must be emitted');
    assert.strictEqual(perkEvent.details.tens, 5);
    assert.strictEqual(perkEvent.details.ones, 5);
    assert.strictEqual(perkEvent.details.perk_key, 55);
    assert.strictEqual(perkEvent.details.effect_name, 'Twin Bolt');
    assert.strictEqual(perkEvent.details.is_match, true);

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-14: Offline Telemetry Buffer & Fire-and-Forget Resilience (INV-TELEMETRY-1)
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-14', 'Offline Telemetry Buffer & Fire-and-Forget Resilience (INV-TELEMETRY-1)', async () => {
    const storage = new MockLocalStorage();
    let failNetwork = true;
    let postedPayloads = [];

    const mockFetch = async (url, opts) => {
      if (url.includes('/rest/v1/player_events')) {
        if (failNetwork) {
          throw new Error('Network failure: 503 Service Unavailable');
        }
        postedPayloads.push(JSON.parse(opts.body));
        return { ok: true, status: 201, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const auth = new AuthManager({ storage, fetch: mockFetch });
    await auth.instantDevLogin('telemetry3@tabletop.com', 'TelemetryUser3', '1990-01-01');

    // Dispatch 3 events while offline
    auth.dispatchTelemetry('LAND_PLAY', 'Mountain', { playerId: 'p1' });
    auth.dispatchTelemetry('SPELL_CAST', 'Lightning Bolt', { playerId: 'p1' });
    auth.dispatchTelemetry('MATCH_CONCEDE', null, { playerId: 'p1' });

    // Yield macro-task for async catch handling
    await new Promise(r => setTimeout(r, 20));

    // Verify buffer has 3 items
    const buffered = auth.getBufferedTelemetry();
    assert.strictEqual(buffered.length, 3, 'Buffered telemetry must contain 3 items');
    assert.strictEqual(buffered[0].event_type, 'LAND_PLAY');
    assert.strictEqual(buffered[1].event_type, 'SPELL_CAST');
    assert.strictEqual(buffered[2].event_type, 'MATCH_CONCEDE');

    // Restore network connectivity
    failNetwork = false;

    // Flush offline buffer
    const flushedCount = await auth.flushTelemetryBuffer();
    assert.strictEqual(flushedCount, 3, 'Must successfully flush all 3 items');
    assert.strictEqual(auth.getBufferedTelemetry().length, 0, 'Buffer must be empty after successful flush');
    assert.strictEqual(postedPayloads.length, 1, 'Supabase must have received 1 batch');
    assert.strictEqual(postedPayloads[0].length, 3, 'Batch must contain all 3 events');
  });

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n==================================================================');
  console.log(`  FEATURE 15 TEST RESULTS: ${passedTests} passed, ${failedTests} failed`);
  console.log('==================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite();
