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
  PerkinsAgent,
  getHydratedCardMetadata,
  OracleEffectCompiler,
  StateBasedActionsEngine
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
    this._textContent = '';
    this.value = '';
    this.disabled = false;
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this._attributes = new Map();
    this._eventListeners = new Map();
  }

  get textContent() {
    if (this.children && this.children.length > 0) {
      return this.children.map(c => c.textContent).join(' ');
    }
    return this._textContent || '';
  }

  set textContent(val) {
    this._textContent = String(val);
    this.children = [];
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
    this._textContent = '';
    if (!html || typeof html !== 'string') return;

    const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
    const tokens = [];
    const tokenRegex = /<!--[\s\S]*?-->|<(?:\/([a-z0-9-]+)|([a-z0-9-]+)([^>]*?))\/?>|([^<]+)/gi;
    let match;
    while ((match = tokenRegex.exec(html)) !== null) {
      if (match[0].startsWith('<!--')) continue;
      if (match[1]) {
        // closing tag </tag>
        tokens.push({ type: 'close', tag: match[1].toLowerCase() });
      } else if (match[2]) {
        // opening tag <tag attrs>
        const tag = match[2].toLowerCase();
        const rawAttrs = match[3] || '';
        const selfClosing = match[0].endsWith('/>') || VOID_TAGS.has(tag);
        tokens.push({ type: 'open', tag, rawAttrs, selfClosing });
      } else if (match[4]) {
        tokens.push({ type: 'text', text: match[4] });
      }
    }

    const stack = [this];
    for (const token of tokens) {
      const current = stack[stack.length - 1];
      if (!current) break;

      if (token.type === 'text') {
        const trimmed = token.text.trim();
        if (trimmed) {
          const textNode = new MockElement('span');
          textNode._textContent = trimmed;
          current.appendChild(textNode);
        }
      } else if (token.type === 'open') {
        const elem = new MockElement(token.tag);
        const attrRegex = /([a-z0-9-_]+)(?:=(?:"([^"]*)"|'([^']*)'|([^>\s]+)))?/gi;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(token.rawAttrs)) !== null) {
          elem.setAttribute(attrMatch[1], attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '');
        }
        current.appendChild(elem);
        if (!token.selfClosing) {
          stack.push(elem);
        }
      } else if (token.type === 'close') {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tagName.toLowerCase() === token.tag) {
            stack.length = i;
            break;
          }
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
    return this.dispatchEvent(new MockEvent('click', { bubbles: true }));
  }

  dispatchEvent(event) {
    event.target = this;
    const promises = [];
    if (this._eventListeners.has(event.type)) {
      for (const listener of this._eventListeners.get(event.type)) {
        const res = listener.call(this, event);
        if (res && typeof res.then === 'function') {
          promises.push(res);
        }
      }
    }
    if (event.bubbles && this.parentElement) {
      const parentRes = this.parentElement.dispatchEvent(event);
      if (parentRes && typeof parentRes.then === 'function') {
        promises.push(parentRes);
      }
    }
    if (promises.length > 0) {
      return Promise.all(promises).then(() => !event.defaultPrevented);
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
  // TC-ONBOARD-15: DeckValidator Sideboard Separation, Parse Errors & Breakdown
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-15', 'DeckValidator.validateDeck Sideboard Separation, Parse Errors, & Breakdown Structure', async () => {
    // 1. Deck with Mainboard and Sideboard
    const deckText = `
4 Lightning Bolt
4 Monastery Swiftspear
4 Goblin Guide
4 Lava Spike
20 Mountain
Sideboard
3 Smash to Smithereens
2 Roiling Vortex
`;
    const report = DeckValidator.validateDeck(deckText, { format: 'FREE_CONSTRUCT' });
    assert.strictEqual(report.isValid, true, 'Deck should be valid');
    assert.strictEqual(report.mainCount, 36);
    assert.strictEqual(report.sideboardCount, 5);
    assert.strictEqual(report.mainboard.length, 5);
    assert.strictEqual(report.sideboard.length, 2);
    assert.deepStrictEqual(report.colorIdentity, ['R']);
    assert.strictEqual(report.breakdown.creatures, 8); // 4 Goblin Guide + 4 Monastery Swiftspear
    assert.strictEqual(report.breakdown.spells, 8); // 4 Lightning Bolt + 4 Lava Spike
    assert.strictEqual(report.breakdown.lands, 20); // 20 Mountain
    assert.strictEqual(report.breakdown.sideboard, 5); // 5 in sideboard

    // 2. Multi-color and Colorless
    const izzetDeck = `
4 Lightning Bolt
4 Counterspell
2 Steam Vents
10 Mountain
10 Island
Sideboard
2 Flusterstorm
`;
    const repIzzet = DeckValidator.validateDeck(izzetDeck, { format: 'FREE_CONSTRUCT' });
    assert.strictEqual(repIzzet.isValid, true);
    assert.deepStrictEqual(repIzzet.colorIdentity, ['U', 'R']);

    // 3. Parse errors propagation
    const invalidText = `
4 Lightning Bolt
THIS IS INVALID CARD SYNTAX WITHOUT COUNT
20 Mountain
`;
    const repInvalid = DeckValidator.validateDeck(invalidText, { format: 'FREE_CONSTRUCT' });
    assert.strictEqual(repInvalid.isValid, false);
    assert.ok(repInvalid.errors.some(e => e.isParseError === true), 'Must report line parse error');

    // 4. enforceMinimum option
    const repEnforce = DeckValidator.validateDeck(deckText, { format: 'RANKED_CONSTRUCT', enforceMinimum: true });
    assert.strictEqual(repEnforce.isValid, false, '36 cards must fail 60-card minimum for Ranked Construct');
    assert.ok(repEnforce.errors.some(e => e.cardName === 'Mainboard' && e.reason.includes('at least 60 cards')));
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-16: getHydratedCardMetadata & hydrateCardMechanics Keywords
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-16', 'getHydratedCardMetadata & hydrateCardMechanics Lands & 14 Standard Keywords Hydration', async () => {
    // 1. Basic Lands
    const plains = getHydratedCardMetadata('Plains');
    assert.ok(plains, 'Plains metadata must exist');
    assert.strictEqual(plains.type, 'Land');
    assert.strictEqual(plains.isBasicLand, true);
    assert.deepStrictEqual(plains.colors, ['W']);

    const wastes = getHydratedCardMetadata('Wastes');
    assert.ok(wastes, 'Wastes metadata must exist');
    assert.strictEqual(wastes.isBasicLand, true);
    assert.deepStrictEqual(wastes.colors, ['C']);

    // 2. Shocklands, Fetchlands, Checklands
    const steamVents = getHydratedCardMetadata('Steam Vents');
    assert.ok(steamVents, 'Steam Vents metadata must exist');
    assert.strictEqual(steamVents.isShockland, true);

    const delta = getHydratedCardMetadata('Polluted Delta');
    assert.ok(delta, 'Polluted Delta metadata must exist');
    assert.strictEqual(delta.isFetchland, true);

    const sulfur = getHydratedCardMetadata('Sulfur Falls');
    assert.ok(sulfur, 'Sulfur Falls metadata must exist');
    assert.strictEqual(sulfur.isCheckland, true);

    // 3. 14 Standard Keywords Hydration on TabletopStateManager
    const testCard = {
      name: 'Ultra Chimera',
      oracleText: 'Flying, haste, vigilance, trample, lifelink, deathtouch, reach, flash, prowess, first strike, double strike, menace, hexproof, indestructible.'
    };
    TabletopStateManager.hydrateCardMechanics(testCard);

    const standardKeywords = [
      'flying', 'haste', 'vigilance', 'trample', 'lifelink',
      'deathtouch', 'reach', 'flash', 'prowess', 'firstStrike',
      'doubleStrike', 'menace', 'hexproof', 'indestructible'
    ];

    for (const kw of standardKeywords) {
      assert.strictEqual(testCard.keywords[kw], true, `Card must have keyword ${kw}`);
    }
    // Haste must reset summoning sickness
    assert.strictEqual(testCard.hasSummoningSickness, false);
    assert.strictEqual(testCard.isSummoningSick, false);
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-17: Deckbuilder Slot Persistence, Name Input, & Preview Panel
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-17', 'Deckbuilder Slot Persistence, Name Input, Save Confirmation Banner, & Preview Panel', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const storage = new MockLocalStorage();
    const app = new RPMAppController({
      container,
      storage,
      autoConnect: false,
      myPlayerId: 'p1',
      username: 'DeckCrafter'
    });
    await app.mount(container);

    // Navigate to DECKBUILDER
    app.tabRouter.navigate('DECKBUILDER');
    app.reconcileDOM();

    const view = container.querySelector('#view-deckbuilder');
    assert.ok(view, 'Deckbuilder view must exist');

    // 1. Name input exists
    const nameInput = view.querySelector('#deckbuilder-name-input');
    assert.ok(nameInput, '#deckbuilder-name-input must exist');

    // 2. Set deck name and cards
    nameInput.value = 'Red Deck Wins';
    const textarea = view.querySelector('#deckbuilder-text-input');
    assert.ok(textarea, '#deckbuilder-text-input must exist');
    textarea.value = `4 Goblin Guide\n4 Monastery Swiftspear\n4 Lightning Bolt\n20 Mountain`;

    // 3. Save Active Deck
    const btnSave = view.querySelector('#btn-save-active-deck');
    assert.ok(btnSave, '#btn-save-active-deck must exist');
    await btnSave.click();

    // Must stay on DECKBUILDER
    assert.strictEqual(app.tabRouter.getCurrentTab(), 'DECKBUILDER', 'Must stay on DECKBUILDER after saving');

    // Confirmation banner must be displayed
    const banner = view.querySelector('#deck-save-confirmation-banner');
    assert.ok(banner, '#deck-save-confirmation-banner must exist');
    assert.strictEqual(banner.style.display, 'flex');
    assert.ok(banner.textContent.includes('Red Deck Wins'), 'Banner must mention deck name');

    // Active deck preview panel must be populated
    const previewPanel = view.querySelector('#active-deck-preview-panel');
    assert.ok(previewPanel, '#active-deck-preview-panel must exist');
    assert.ok(previewPanel.textContent.includes('Red Deck Wins'));
    assert.ok(previewPanel.textContent.includes('Creatures'));
    assert.ok(previewPanel.textContent.includes('Spells'));
    assert.ok(previewPanel.textContent.includes('Lands'));

    // Check localStorage persistence
    const savedBySlotRaw = storage.getItem('rpm_saved_decks_by_slot');
    assert.ok(savedBySlotRaw, 'rpm_saved_decks_by_slot must be stored in localStorage');
    const savedBySlot = JSON.parse(savedBySlotRaw);
    assert.strictEqual(savedBySlot[1].name, 'Red Deck Wins');

    // Click Go to Lobby button
    const btnGoLobby = view.querySelector('#btn-deck-go-to-lobby');
    assert.ok(btnGoLobby, '#btn-deck-go-to-lobby must exist');
    btnGoLobby.click();
    assert.strictEqual(app.tabRouter.getCurrentTab(), 'LOBBY', 'Clicking Go to Lobby must navigate to LOBBY');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-18: Lobby Equipped Deck Badge & Match Start Deck Hydration
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-18', 'Lobby Equipped Deck Badge & Match Start Deck Hydration', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const storage = new MockLocalStorage();
    const customDeckData = {
      slot: 1,
      name: 'Custom Burn Supreme',
      rawText: '4 Goblin Guide\n4 Lightning Bolt\n20 Mountain',
      format: 'FREE_CONSTRUCT',
      mainboard: [
        { name: 'Goblin Guide', count: 4 },
        { name: 'Lightning Bolt', count: 4 },
        { name: 'Mountain', count: 20 }
      ],
      sideboard: [],
      colorIdentity: ['R'],
      breakdown: { creatures: 4, spells: 4, otherPermanents: 0, lands: 20, sideboard: 0 },
      mainCount: 28,
      sideboardCount: 0
    };

    storage.setItem('rpm_active_deck_slot', '1');
    storage.setItem('rpm_saved_decks_by_slot', JSON.stringify({ 1: customDeckData }));

    const app = new RPMAppController({
      container,
      storage,
      autoConnect: false,
      myPlayerId: 'p1',
      username: 'EquippedPlayer'
    });
    await app.mount(container);

    // 1. Lobby equipped deck badge
    app.tabRouter.navigate('LOBBY');
    app.reconcileDOM();

    const lobbyView = container.querySelector('#view-lobby');
    const equippedBadge = lobbyView.querySelector('#lobby-equipped-deck-badge');
    assert.ok(equippedBadge, '#lobby-equipped-deck-badge must exist in Lobby header');
    assert.ok(equippedBadge.textContent.includes('Custom Burn Supreme'), 'Badge must display equipped deck name');
    assert.ok(equippedBadge.textContent.includes('28 cards'), 'Badge must display card count');
    assert.ok(equippedBadge.textContent.includes('Slot 1'), 'Badge must display slot number');

    // 2. Match Start Deck Hydration
    app.lobbyManager.claimSeat('p1', 'EquippedPlayer', 1);
    app.startMatch({ playerIds: ['p1'] });

    const p1 = app.tabletopState.players.p1;
    assert.ok(p1, 'Player p1 must exist in Tabletop state');
    assert.strictEqual(p1.zones.hand.length, 7, 'Opening hand must contain 7 cards');
    assert.strictEqual(p1.zones.library.length, 21, 'Remaining 21 cards must be in library (28 total)');

    const allP1CardNames = [...p1.zones.hand, ...p1.zones.library].map(c => c.name);
    assert.strictEqual(allP1CardNames.filter(n => n === 'Goblin Guide').length, 4);
    assert.strictEqual(allP1CardNames.filter(n => n === 'Lightning Bolt').length, 4);
    assert.strictEqual(allP1CardNames.filter(n => n === 'Mountain').length, 20);

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-19: OracleEffectCompiler & Modern Hammer/Boros Card Compilation Smoke Tests
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-19', 'OracleEffectCompiler & Modern Card Smoke Tests (Sigarda Aid, Colossus Hammer, Heartfire Hero, Mana Confluence, Surge, Swiftfoot)', async () => {
    // 1. Sigarda's Aid
    const sigardaAid = {
      name: "Sigarda's Aid",
      type_line: 'Enchantment',
      oracle_text: 'Whenever an Equipment enters the battlefield under your control, you may attach it to target creature you control.\nYou may cast Aura and Equipment spells as though they had flash.'
    };
    const r1 = OracleEffectCompiler.smokeTestCard(sigardaAid);
    assert.strictEqual(r1.valid, true, "Sigarda's Aid smoke test must pass");
    assert.strictEqual(sigardaAid.compiledMechanics.category, 'otherPermanents');
    assert.strictEqual(sigardaAid.compiledMechanics.isPermanent, true);
    assert.ok(sigardaAid.compiledMechanics.grantsFlashTo.equipment, 'Must grant flash to equipment');
    assert.ok(sigardaAid.compiledMechanics.grantsFlashTo.aura, 'Must grant flash to auras');
    assert.ok(sigardaAid.compiledMechanics.triggers.some(t => t.triggerType === 'ON_EQUIPMENT_ETB' && t.action === 'AUTO_ATTACH_EQUIPMENT'), 'Must have ON_EQUIPMENT_ETB trigger');

    // 2. Colossus Hammer
    const colossusHammer = {
      name: 'Colossus Hammer',
      type_line: 'Artifact — Equipment',
      oracle_text: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
    };
    const r2 = OracleEffectCompiler.smokeTestCard(colossusHammer);
    assert.strictEqual(r2.valid, true, 'Colossus Hammer smoke test must pass');
    assert.strictEqual(colossusHammer.compiledMechanics.category, 'otherPermanents');
    assert.strictEqual(colossusHammer.compiledMechanics.isEquipment, true);
    assert.strictEqual(colossusHammer.compiledMechanics.attachment.powerModifier, 10);
    assert.strictEqual(colossusHammer.compiledMechanics.attachment.toughnessModifier, 10);
    assert.ok(colossusHammer.compiledMechanics.attachment.lostKeywords.includes('flying'), 'Must lose flying');
    assert.strictEqual(colossusHammer.compiledMechanics.attachment.equipCost, '{8}');

    // 3. Heartfire Hero
    const heartfireHero = {
      name: 'Heartfire Hero',
      type_line: 'Creature — Mouse Soldier',
      power: '1',
      toughness: '1',
      oracle_text: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
    };
    const r3 = OracleEffectCompiler.smokeTestCard(heartfireHero);
    assert.strictEqual(r3.valid, true, 'Heartfire Hero smoke test must pass');
    assert.strictEqual(heartfireHero.compiledMechanics.category, 'creatures');
    assert.ok(heartfireHero.compiledMechanics.triggers.some(t => t.triggerType === 'ON_BECOMES_TARGET' && t.action === 'ADD_COUNTER'), 'Must have Valiant trigger');
    assert.ok(heartfireHero.compiledMechanics.triggers.some(t => t.triggerType === 'ON_DIES' && t.action === 'DAMAGE_EQUAL_TO_POWER_EACH_OPPONENT'), 'Must have Dies trigger');

    // 4. Mana Confluence
    const manaConfluence = {
      name: 'Mana Confluence',
      type_line: 'Land',
      oracle_text: '{T}, Pay 1 life: Add one mana of any color.'
    };
    const r4 = OracleEffectCompiler.smokeTestCard(manaConfluence);
    assert.strictEqual(r4.valid, true, 'Mana Confluence smoke test must pass');
    assert.strictEqual(manaConfluence.compiledMechanics.category, 'lands');
    assert.strictEqual(manaConfluence.compiledMechanics.isPermanent, true);
    assert.strictEqual(manaConfluence.compiledMechanics.manaLifeCost, 1);
    assert.strictEqual(manaConfluence.compiledMechanics.manaProfile.producesAnyColor, true);

    // 5. Surge of Salvation
    const surgeOfSalvation = {
      name: 'Surge of Salvation',
      type_line: 'Instant',
      oracle_text: 'You and permanents you control gain hexproof until end of turn. Prevent all damage that red and/or black sources would deal to you and/or permanents you control this turn.'
    };
    const r5 = OracleEffectCompiler.smokeTestCard(surgeOfSalvation);
    assert.strictEqual(r5.valid, true, 'Surge of Salvation smoke test must pass');
    assert.strictEqual(surgeOfSalvation.compiledMechanics.category, 'spells');
    const surgeEffect = surgeOfSalvation.compiledMechanics.spellEffects.find(e => e.action === 'PUMP_PT_AND_KEYWORDS');
    assert.ok(surgeEffect, 'Surge must compile PUMP_PT_AND_KEYWORDS');
    assert.strictEqual(surgeEffect.scope, 'CONTROLLER_PERMANENTS');
    assert.ok(surgeEffect.keywordsGranted.includes('hexproof'));

    // 6. Swiftfoot Boots
    const swiftfootBoots = {
      name: 'Swiftfoot Boots',
      type_line: 'Artifact — Equipment',
      oracle_text: 'Equipped creature has hexproof and haste.\nEquip {1}'
    };
    const r6 = OracleEffectCompiler.smokeTestCard(swiftfootBoots);
    assert.strictEqual(r6.valid, true, 'Swiftfoot Boots smoke test must pass');
    assert.ok(swiftfootBoots.compiledMechanics.attachment.keywordsGranted.includes('hexproof'));
    assert.ok(swiftfootBoots.compiledMechanics.attachment.keywordsGranted.includes('haste'));
    assert.strictEqual(swiftfootBoots.compiledMechanics.attachment.equipCost, '{1}');

    // 7. DeckValidator 3-Pass Hydrator
    const mockDecklist = `
4 Heartfire Hero
4 Colossus Hammer
4 Sigarda's Aid
4 Swiftfoot Boots
4 Surge of Salvation
4 Mana Confluence
16 Plains
`;
    const hydratedDeck = await DeckValidator.validateAndHydrateDeck(mockDecklist, {
      format: 'FREE_CONSTRUCT',
      enrichWithScryfall: false
    });
    assert.strictEqual(hydratedDeck.isValid, true, 'Deck validation must succeed');
    assert.strictEqual(hydratedDeck.mainCount, 40);
    assert.strictEqual(hydratedDeck.cards.length, 7);
    const heroInDeck = hydratedDeck.cards.find(c => c.name === 'Heartfire Hero');
    assert.ok(heroInDeck.compiledMechanics, 'Heartfire Hero must have compiledMechanics');
    assert.strictEqual(heroInDeck.compiledMechanics.category, 'creatures');
  });

  // --------------------------------------------------------------------------
  // TC-ONBOARD-20: Arena Battlefield Noncreature Strip, Sigarda Auto-Attach & Heartfire Hero Dies SBA
  // --------------------------------------------------------------------------
  await test('TC-ONBOARD-20', 'Arena Battlefield Noncreature Strip, Sigarda Aid Auto-Attach & Heartfire Hero Dies SBA Engine', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const storage = new MockLocalStorage();
    const app = new RPMAppController({
      container,
      storage,
      autoConnect: false,
      myPlayerId: 'p1',
      username: 'ArenaChampion'
    });
    await app.mount(container);

    app.tabRouter.navigate('ARENA');
    app.lobbyManager.claimSeat('p1', 'ArenaChampion', 1);
    app.lobbyManager.seatBot(2);
    app.startMatch({ playerIds: ['p1', 'bot_perkins_2'] });

    const p1 = app.tabletopState.players.p1;
    const p2 = app.tabletopState.players.bot_perkins_2;
    assert.ok(p1 && p2, 'Both players must exist');
    p2.resources.life = 20;

    // 1. Play Sigarda's Aid into p1 battlefield
    const aidCard = app.tabletopState.addCardToZone('p1', 'battlefield', {
      name: "Sigarda's Aid",
      typeLine: 'Enchantment',
      oracleText: 'Whenever an Equipment enters the battlefield under your control, you may attach it to target creature you control.'
    });
    assert.strictEqual(p1.battlefield.noncreatures.length, 1);
    assert.strictEqual(p1.battlefield.noncreatures[0].name, "Sigarda's Aid");

    // 2. Play Heartfire Hero into p1 battlefield
    const heroCard = app.tabletopState.addCardToZone('p1', 'battlefield', {
      name: 'Heartfire Hero',
      typeLine: 'Creature — Mouse Soldier',
      power: 1,
      toughness: 1,
      oracleText: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
    });
    assert.strictEqual(p1.battlefield.creatures.length, 1);

    // 3. Play Colossus Hammer into p1 battlefield -> Sigarda's Aid triggers auto-attach
    const hammerCard = app.tabletopState.addCardToZone('p1', 'battlefield', {
      name: 'Colossus Hammer',
      typeLine: 'Artifact — Equipment',
      oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
    });
    assert.strictEqual(p1.battlefield.noncreatures.length, 2);
    assert.strictEqual(hammerCard.attachedTo, heroCard.instanceId, 'Sigarda Aid must auto-attach Hammer to Hero');
    assert.ok(heroCard.attachedCards.includes(hammerCard), 'Hero attachedCards must include hammer');

    // 4. Evaluate creature stats: base 1/1 + hammer 10/10 = 11/11 (or 12/12 with Valiant trigger)
    const evaluatedStats = app.tabletopState.abilityEngine.evaluateCreatureStats(heroCard, app.tabletopState);
    assert.ok(evaluatedStats.power === 11 || evaluatedStats.power === 12, 'Evaluated power must be 11 or 12');
    assert.ok(evaluatedStats.toughness === 11 || evaluatedStats.toughness === 12, 'Evaluated toughness must be 11 or 12');

    // 5. Test Mana Confluence tap & 1 life deduction
    const confluenceCard = app.tabletopState.addCardToZone('p1', 'battlefield', {
      name: 'Mana Confluence',
      typeLine: 'Land',
      oracleText: '{T}, Pay 1 life: Add one mana of any color.'
    });
    const lifeBefore = p1.resources.life;
    app.tabletopState.tapLandForMana('p1', confluenceCard.instanceId, 'W');
    assert.strictEqual(p1.resources.life, lifeBefore - 1, 'Tapping Mana Confluence must deduct 1 life');
    assert.strictEqual(confluenceCard.isTapped, true, 'Mana Confluence must be tapped');
    assert.strictEqual(p1.resources.manaPool.W, 1, 'Mana pool must have 1 W');

    // 6. Test Heartfire Hero Dies SBA Trigger
    // Deal lethal damage to Heartfire Hero (marked damage = toughness)
    heroCard.damageMarked = evaluatedStats.toughness;
    app.tabletopState.runSBACheck();

    // Hero died, dies trigger deals power damage to p2
    assert.strictEqual(p1.battlefield.creatures.length, 0, 'Hero must be moved off battlefield to graveyard');
    assert.ok(p1.zones.graveyard.some(c => c.name === 'Heartfire Hero' || c.previousInstanceId === heroCard.instanceId || c.instanceId === heroCard.instanceId), 'Hero must be in graveyard');
    assert.ok(p2.resources.life === 9 || p2.resources.life === 8, 'Heartfire Hero dies trigger must deal damage to p2');

    // 7. Add opponent noncreature and verify Arena DOM UI Rendering
    app.tabletopState.addCardToZone('bot_perkins_2', 'battlefield', {
      name: 'Soul-Guide Lantern',
      typeLine: 'Artifact'
    });

    app.reconcileDOM();
    const arenaView = container.querySelector('#view-arena');
    assert.ok(arenaView, 'Arena view must exist');
    const noncreaturesStrip = container.querySelector('#battlefield-noncreatures');
    assert.ok(noncreaturesStrip, '#battlefield-noncreatures strip must exist');
    const chips = noncreaturesStrip.querySelectorAll('.noncreature-chip');
    assert.strictEqual(chips.length, 2, 'Must render 2 noncreature chips (Sigarda Aid and Colossus Hammer)');

    const oppNoncreatures = container.querySelectorAll('.opponent-noncreatures-container');
    assert.ok(oppNoncreatures.length >= 1, 'Opponent noncreatures container must exist');

    app.destroy();
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
