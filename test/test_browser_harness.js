/**
 * test/test_browser_harness.js
 * Comprehensive Acceptance Test Suite for Feature 12: Playable Browser Integration Harness
 * Document ID: SPEC-RPM-HARNESS-012
 * 
 * Verifies all 16 Acceptance Test Vectors:
 * - TC-HARNESS-01: DOM Mounting & Structural Element Verification (INV-HARNESS-1)
 * - TC-HARNESS-02: Hermetic Teardown & Zero Event/Timer Leakage (INV-HARNESS-1, INV-HARNESS-2)
 * - TC-HARNESS-03: Unidirectional Action Flow — Local Action Transmission (INV-HARNESS-2)
 * - TC-HARNESS-04: Circular Broadcast Storm Elimination — Remote Action Suppression (INV-HARNESS-2)
 * - TC-HARNESS-05: Dynamic Multi-Player Pod Scaling (2 to 6 Players) (INV-HARNESS-3, Audio Note 7)
 * - TC-HARNESS-06: Player Elimination Gray-Out Rendering & Invalidation (INV-HARNESS-3, INV-RING-1, DEC-013)
 * - TC-HARNESS-07: Dual-Channel Priority Lockout Enforcement (INV-HARNESS-5, DEC-011)
 * - TC-HARNESS-08: 15-Second Stack Alarm Visual Reconciliation (INV-HARNESS-4, Audio Note 3)
 * - TC-HARNESS-09: Random Perk Upkeep Emblem & 2 d10 Dice Display (INV-PERK-3, INV-PERK-7, DEC-014)
 * - TC-HARNESS-10: 10-Point Guideline Memory & Quota Gauge (INV-STORAGE-1, INV-STORAGE-2, DEC-013)
 * - TC-HARNESS-11: Beginner Starter Deck Generator & Top 10 Showcase (INV-STORAGE-4, INV-STORAGE-5, Audio Note 9)
 * - TC-HARNESS-12: Card Overlay Modal Inspection & Escape Trapping (INV-HARNESS-6, DEC-012)
 * - TC-HARNESS-13: Victory Fanfare Overlay & Autoplay Fallback Banner (INV-AUDIO-1, INV-AUDIO-2, DEC-013)
 * - TC-HARNESS-14: WebSocket Connection Status Pill Reconciliation (INV-RELAY-3)
 * - TC-HARNESS-15: Keyboard Shortcut Acceleration (Space/P and H) (User Experience, Audio Note 1)
 * - TC-HARNESS-16: Sub-16ms Frame Budget Reconciliation Benchmark (60 FPS Performance Gate)
 */

import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import { RPMAppController } from '../src/app.js';
import { RelayClient } from '../src/RelayClient.js';
import { TabletopStateManager } from '../src/TabletopStateManager.js';
import { PriorityStateMachine } from '../src/PriorityStateMachine.js';
import { StackAlarmManager } from '../src/StackAlarmManager.js';
import { RandomPerkEngine } from '../src/RandomPerkEngine.js';
import { DualChannelChat } from '../src/DualChannelChat.js';

// ============================================================================
// Lightweight Mock DOM Environment for Node.js
// ============================================================================

const VOID_ELEMENTS = new Set(['img', 'input', 'hr', 'br', 'meta', 'link']);

class MockEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = options.bubbles ?? true;
    this.cancelable = options.cancelable ?? true;
    this.target = options.target || null;
    this.defaultPrevented = false;
  }
  stopPropagation() {}
  preventDefault() { this.defaultPrevented = true; }
}

class MockKeyboardEvent extends MockEvent {
  constructor(type, options = {}) {
    super(type, options);
    this.key = options.key || '';
    this.code = options.code || '';
    this.keyCode = options.keyCode || 0;
  }
}

class MockMouseEvent extends MockEvent {
  constructor(type, options = {}) {
    super(type, options);
  }
}

function matchesSelector(elem, selector) {
  if (!elem || !selector || typeof selector !== 'string') return false;
  let remaining = selector.trim();

  // Tag name
  const tagMatch = remaining.match(/^[a-zA-Z0-9\-]+/);
  if (tagMatch) {
    if (elem.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
    remaining = remaining.slice(tagMatch[0].length);
  }

  // ID
  const idMatch = remaining.match(/^#([a-zA-Z0-9\-_]+)/);
  if (idMatch) {
    if (elem.id !== idMatch[1]) return false;
    remaining = remaining.slice(idMatch[1].length + 1);
  }

  // Classes
  const classMatches = remaining.matchAll(/\.([a-zA-Z0-9\-_]+)/g);
  for (const cm of classMatches) {
    if (!elem.classList.contains(cm[1])) return false;
  }
  remaining = remaining.replace(/\.([a-zA-Z0-9\-_]+)/g, '');

  // Attributes
  const attrMatches = remaining.matchAll(/\[([a-zA-Z0-9\-_]+)(?:=[\"\']?([^\x22\x27\]]*)[\"\']?)?\]/g);
  for (const am of attrMatches) {
    const attrName = am[1];
    const attrVal = am[2];
    if (attrVal !== undefined) {
      if (elem.getAttribute(attrName) !== attrVal) return false;
    } else {
      if (!elem.hasAttribute(attrName)) return false;
    }
  }

  return true;
}

class MockClassList {
  constructor(element) {
    this.element = element;
    this._classes = new Set();
  }

  _syncFromClassName(className = '') {
    this._classes.clear();
    className.split(/\s+/).filter(Boolean).forEach(c => this._classes.add(c));
  }

  _syncToClassName() {
    this.element.attributes['class'] = [...this._classes].join(' ');
  }

  add(...classes) {
    classes.forEach(c => c && this._classes.add(c));
    this._syncToClassName();
  }

  remove(...classes) {
    classes.forEach(c => this._classes.delete(c));
    this._syncToClassName();
  }

  contains(c) {
    return this._classes.has(c);
  }

  toggle(c, force) {
    if (force !== undefined) {
      if (force) this.add(c);
      else this.remove(c);
      return force;
    }
    if (this.contains(c)) {
      this.remove(c);
      return false;
    } else {
      this.add(c);
      return true;
    }
  }

  toString() {
    return [...this._classes].join(' ');
  }
}

class MockElement {
  constructor(tagName = 'div') {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = {};
    this.children = [];
    this.childNodes = [];
    this.parentNode = null;
    this._eventListeners = new Map();
    this.classList = new MockClassList(this);
    this.style = {};
  }

  get id() { return this.attributes['id'] || ''; }
  set id(val) { this.attributes['id'] = val; }

  get className() { return this.attributes['class'] || ''; }
  set className(val) {
    this.attributes['class'] = val;
    this.classList._syncFromClassName(val);
  }

  get disabled() {
    return this.attributes['disabled'] === 'true' || this.attributes['disabled'] === true || this.attributes['disabled'] === '';
  }
  set disabled(val) {
    if (val) this.attributes['disabled'] = 'true';
    else delete this.attributes['disabled'];
  }

  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'TEXTAREA') return this.textContent;
    return this.attributes['value'] || '';
  }
  set value(val) {
    this._value = String(val);
  }

  getAttribute(name) {
    return this.attributes[name] !== undefined ? this.attributes[name] : null;
  }

  setAttribute(name, val) {
    this.attributes[name] = String(val);
    if (name === 'class') this.classList._syncFromClassName(String(val));
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'class') this.classList._syncFromClassName('');
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    if (child.nodeType === 1) this.children.push(child);
    return child;
  }

  removeChild(child) {
    if (!child) return child;
    const cnIdx = this.childNodes.indexOf(child);
    if (cnIdx !== -1) this.childNodes.splice(cnIdx, 1);
    const cIdx = this.children.indexOf(child);
    if (cIdx !== -1) this.children.splice(cIdx, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
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
        parentNode: this
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
          parentNode: current
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
          elem.parentNode = current;

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

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    if (this._eventListeners.has(event.type)) {
      for (const listener of this._eventListeners.get(event.type)) {
        listener.call(this, event);
      }
    }
    if (event.bubbles && this.parentNode && typeof this.parentNode.dispatchEvent === 'function') {
      this.parentNode.dispatchEvent(event);
    }
    return !event.defaultPrevented;
  }
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
      this._listeners.get(type).delete(listener);
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

// Setup global mock DOM environment
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
  globalThis.KeyboardEvent = MockKeyboardEvent;
  globalThis.MouseEvent = MockMouseEvent;
  return doc;
}

// ============================================================================
// Acceptance Test Suite (TC-HARNESS-01 to TC-HARNESS-16)
// ============================================================================

async function runTestSuite() {
  console.log('==================================================================');
  console.log('Running Acceptance Test Suite: Feature 12 Playable Browser Harness');
  console.log('Document ID: SPEC-RPM-HARNESS-012');
  console.log('==================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      failed++;
    }
  }

  // --------------------------------------------------------------------------
  // TC-HARNESS-01: DOM Mounting & Structural Element Verification
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-01: DOM Mounting & Structural Element Verification (INV-HARNESS-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    // Verify all 6 required semantic regions
    const header = container.querySelector('#header-bar');
    assert.ok(header, '#header-bar must exist');
    assert.strictEqual(header.getAttribute('role'), 'banner');

    const opponents = container.querySelector('#opponents-container');
    assert.ok(opponents, '#opponents-container must exist');
    assert.strictEqual(opponents.getAttribute('aria-label'), 'Opponent Player Zones');

    const arena = container.querySelector('#center-arena');
    assert.ok(arena, '#center-arena must exist');
    assert.strictEqual(arena.getAttribute('aria-label'), 'Battlefield and Priority Stack');

    const dashboard = container.querySelector('#player-dashboard');
    assert.ok(dashboard, '#player-dashboard must exist');
    assert.strictEqual(dashboard.getAttribute('aria-label'), 'Active Player Dashboard');

    const chat = container.querySelector('#chat-drawer');
    assert.ok(chat, '#chat-drawer must exist');
    assert.strictEqual(chat.getAttribute('aria-label'), 'Chat and Turn Commands');

    const modalRoot = container.querySelector('#modal-root');
    assert.ok(modalRoot, '#modal-root must exist');
    assert.strictEqual(modalRoot.getAttribute('aria-hidden'), 'true');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-02: Hermetic Teardown & Zero Event/Timer Leakage
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-02: Hermetic Teardown & Zero Event/Timer Leakage (INV-HARNESS-1, INV-HARNESS-2)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    // Start 15s alarm timer
    app.alarmManager.start('p1', 'spell_123', 15);
    assert.strictEqual(app.alarmManager.isRunning, true, 'Alarm must be running');

    // Destroy harness
    app.destroy();

    // Verification
    assert.strictEqual(app.alarmManager.isRunning, false, 'Alarm must be stopped on destroy');
    assert.strictEqual(container.childNodes.length, 0, 'Container DOM must be completely cleared');
    assert.strictEqual(app.isDestroyed, true, 'isDestroyed flag must be set');
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-03: Unidirectional Action Flow — Local Action Transmission
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-03: Unidirectional Action Flow — Local Action Transmission (INV-HARNESS-2)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    let sendActionCalls = 0;
    let sentActionPayload = null;

    app.relayClient.sendAction = (action) => {
      sendActionCalls++;
      sentActionPayload = action;
    };

    // Dispatch local action
    const localAction = { type: 'PASS_PRIORITY', payload: { player: 'p1' } };
    await app.dispatchAction(localAction, { origin: 'LOCAL' });

    assert.strictEqual(sendActionCalls, 1, 'sendAction must be called exactly once for LOCAL action');
    assert.strictEqual(sentActionPayload.type, 'PASS_PRIORITY');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-04: Circular Broadcast Storm Elimination — Remote Action Suppression
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-04: Circular Broadcast Storm Elimination — Remote Action Suppression (INV-HARNESS-2)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    let sendActionCalls = 0;
    app.relayClient.sendAction = () => {
      sendActionCalls++;
    };

    // Simulate incoming WebSocket message triggering dispatch with origin: REMOTE
    const remoteAction = { type: 'PASS_PRIORITY', payload: { player: 'p2' } };
    await app.dispatchAction(remoteAction, { origin: 'REMOTE' });

    // Under INV-HARNESS-2, remote actions MUST NOT be re-broadcast over the socket
    assert.strictEqual(sendActionCalls, 0, 'sendAction must be called 0 times for REMOTE action');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-05: Dynamic Multi-Player Pod Scaling (2 to 6 Players)
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-05: Dynamic Multi-Player Pod Scaling (2 to 6 Players) (INV-HARNESS-3, Audio Note 7)', async () => {
    const doc = setupMockDOM();

    // Verify 2, 3, 4, 6 players
    for (const podSize of [2, 3, 4, 6]) {
      const container = doc.createElement('div');
      doc.body.appendChild(container);

      const players = Array.from({ length: podSize }, (_, i) => `p${i + 1}`);
      const app = new RPMAppController({ players, autoConnect: false });
      await app.mount(container);

      const oppBoards = container.querySelectorAll('#opponents-container .opponent-board');
      const expectedOpponents = podSize - 1;

      assert.strictEqual(
        oppBoards.length,
        expectedOpponents,
        `For pod size ${podSize}, expected exactly ${expectedOpponents} opponent boards`
      );

      app.destroy();
      container.remove();
    }
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-06: Player Elimination Gray-Out Rendering & Invalidation
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-06: Player Elimination Gray-Out Rendering & Invalidation (INV-HARNESS-3, INV-RING-1, DEC-013)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ players: ['p1', 'p2', 'p3'], autoConnect: false });
    await app.mount(container);

    // Initial check: p2 is not eliminated
    const p2BoardBefore = container.querySelector('#opponent-board-p2');
    assert.ok(p2BoardBefore, 'p2 board must exist');
    assert.strictEqual(p2BoardBefore.classList.contains('player-eliminated'), false);

    // Dispatch player eliminated action for p2
    await app.dispatchAction({
      type: 'PLAYER_ELIMINATED',
      payload: { playerId: 'p2' }
    }, { origin: 'REMOTE' });

    // Verify p2 card receives player-eliminated class and overlay with skull badge
    const p2BoardAfter = container.querySelector('#opponent-board-p2');
    assert.strictEqual(p2BoardAfter.classList.contains('player-eliminated'), true);

    const overlay = p2BoardAfter.querySelector('.player-eliminated-overlay');
    assert.ok(overlay, 'Eliminated overlay must be rendered');
    assert.ok(overlay.textContent.includes('💀 ELIMINATED'), 'Overlay must contain skull badge');

    // Interactive buttons disabled
    const handBtn = p2BoardAfter.querySelector('.btn-drawer-hand');
    assert.strictEqual(handBtn.disabled, true, 'Interactive buttons must be disabled');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-07: Dual-Channel Priority Lockout Enforcement
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-07: Dual-Channel Priority Lockout Enforcement (INV-HARNESS-5, DEC-011)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ players: ['p1', 'p2'], userId: 'p1', autoConnect: false });
    await app.mount(container);

    // Set priority to opponent p2
    app.priorityMachine.priorityPlayerId = 'p2';
    app.activeChatTab = 'TURN_COMMAND';
    app.reconcileDOM();

    // Turn Command input must be disabled and red lock badge visible
    const inputWhenLocked = container.querySelector('#turn-command-input');
    assert.strictEqual(inputWhenLocked.disabled, true, 'Turn command input must be disabled when priority not held');

    const lockBadge = container.querySelector('.priority-lock-pill');
    assert.ok(lockBadge, 'Red lock badge must be rendered');

    // Switch priority back to local player p1
    app.priorityMachine.priorityPlayerId = 'p1';
    app.reconcileDOM();

    const inputWhenUnlocked = container.querySelector('#turn-command-input');
    assert.strictEqual(inputWhenUnlocked.disabled, false, 'Turn command input must be enabled when holding priority');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-08: 15-Second Stack Alarm Visual Reconciliation
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-08: 15-Second Stack Alarm Visual Reconciliation (INV-HARNESS-4, Audio Note 3)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    app.alarmManager.start('p1', 'spell_1', 15);

    // 1. Safe window (> 7.0s): e.g. 10.0s remaining
    app.alarmManager.remainingMs = 10000;
    app.reconcileDOM();
    const barGreen = container.querySelector('#stack-alarm-progress-bar');
    assert.strictEqual(barGreen.classList.contains('alarm-state-green'), true, 'Must have alarm-state-green at 10s');

    // 2. Warning window (3.0s - 7.0s): e.g. 5.0s remaining
    app.alarmManager.remainingMs = 5000;
    app.reconcileDOM();
    const barAmber = container.querySelector('#stack-alarm-progress-bar');
    assert.strictEqual(barAmber.classList.contains('alarm-state-amber'), true, 'Must have alarm-state-amber at 5s');

    // 3. Danger window (< 3.0s): e.g. 1.0s remaining
    app.alarmManager.remainingMs = 1000;
    app.reconcileDOM();
    const barRed = container.querySelector('#stack-alarm-progress-bar');
    assert.strictEqual(barRed.classList.contains('alarm-state-red'), true, 'Must have alarm-state-red at 1s');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-09: Random Perk Upkeep Emblem & 2 d10 Dice Display
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-09: Random Perk Upkeep Emblem & 2 d10 Dice Display (INV-PERK-3, INV-PERK-7, DEC-014)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ players: ['p1', 'p2', 'p3'], autoConnect: false });
    await app.mount(container);

    // Simulate roll of 55 (Overload Surge)
    await app.dispatchAction({
      type: 'PERK_ROLLED',
      payload: { tens: 5, ones: 5, matchedKey: '55', isMiss: false }
    }, { origin: 'REMOTE' });

    const diceTens = container.querySelector('#dice-tens .dice-value');
    const diceOnes = container.querySelector('#dice-ones .dice-value');
    const rollBadge = container.querySelector('#perk-roll-key');

    assert.strictEqual(diceTens.textContent, '5', 'Tens die must show 5');
    assert.strictEqual(diceOnes.textContent, '5', 'Ones die must show 5');
    assert.ok(rollBadge.textContent.includes('Perk #55'), 'Roll badge must match Perk #55');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-10: 10-Point Guideline Memory & Quota Gauge
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-10: 10-Point Guideline Memory & Quota Gauge (INV-STORAGE-1, INV-STORAGE-2, DEC-013)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    // Open Deckbuilder modal
    app.openModal('DECKBUILDER');

    // Add a custom guideline
    const input = container.querySelector('#guideline-input');
    const addBtn = container.querySelector('#btn-add-guideline');
    input.value = 'Prefer artifact ramp';
    addBtn.dispatchEvent(new MockMouseEvent('click'));

    // Verify guideline added to list
    const items = container.querySelectorAll('.guideline-item');
    assert.ok(items.length >= 1, 'Guideline must be added to list');

    // Upvote guideline
    const upBtn = items[0].querySelector('.btn-guideline-upvote');
    upBtn.dispatchEvent(new MockMouseEvent('click'));

    // Check quota gauge
    const quotaBar = container.querySelector('#guideline-quota-bar');
    assert.ok(quotaBar, 'Quota progress bar must exist');

    app.closeModal();
    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-11: Beginner Starter Deck Generator & Top 10 Showcase
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-11: Beginner Starter Deck Generator & Top 10 Showcase (INV-STORAGE-4, INV-STORAGE-5, Audio Note 9)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    // Open Deckbuilder modal on starters tab
    app.openModal('DECKBUILDER', { tab: 'starters' });

    // Click Red starter button
    const btnRed = container.querySelector('.btn-starter-r');
    assert.ok(btnRed, 'Red starter deck button must exist');
    btnRed.dispatchEvent(new MockMouseEvent('click'));

    // Check export text
    const exportOutput = container.querySelector('#deck-export-output');
    assert.ok(exportOutput, 'Deck export output textarea must exist');
    assert.ok(exportOutput.value.includes('Lightning Bolt'), 'Must contain staple red burn cards');

    // Switch to Showcase tab
    app.openModal('DECKBUILDER', { tab: 'showcase' });
    const showcaseList = container.querySelector('#showcase-list');
    assert.ok(showcaseList, 'Showcase list container must exist');

    app.closeModal();
    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-12: Card Overlay Modal Inspection & Escape Trapping
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-12: Card Overlay Modal Inspection & Escape Trapping (INV-HARNESS-6, DEC-012)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    // Open Card Overlay Modal
    app.openModal('CARD_OVERLAY', {
      name: 'Counterspell',
      mana_cost: '{U}{U}',
      type_line: 'Instant',
      oracle_text: 'Counter target spell.'
    });

    assert.strictEqual(app.activeModalType, 'CARD_OVERLAY');
    const legalBadge = container.querySelector('.badge-modern-legal');
    assert.ok(legalBadge, 'Modern Legal badge must be present');

    // Press Escape key
    const escEvent = new MockKeyboardEvent('keydown', { key: 'Escape' });
    doc.dispatchEvent(escEvent);

    assert.strictEqual(app.activeModalType, 'NONE', 'Escape key must close the modal');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-13: Victory Fanfare Overlay & Autoplay Fallback Banner
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-13: Victory Fanfare Overlay & Autoplay Fallback Banner (INV-AUDIO-1, INV-AUDIO-2, DEC-013)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    // Mock suspended audio context
    app.victoryFanfare.audioContext = { state: 'suspended', resume: async () => {} };
    await app.mount(container);

    // Trigger match victory
    app.handleMatchVictory({
      winner: 'p1',
      winnerName: 'Alice'
    });

    // Fallback banner must render
    const fallbackBanner = container.querySelector('.fallback-banner');
    assert.ok(fallbackBanner, 'Fallback banner must render when audio context is suspended');

    const fallbackBtn = container.querySelector('.btn-fallback-fanfare');
    assert.ok(fallbackBtn, '1-tap fallback button must exist');
    assert.ok(fallbackBtn.textContent.includes('TAP TO PLAY VICTORY FANFARE'));

    // Clicking fallback button clears banner
    fallbackBtn.dispatchEvent(new MockMouseEvent('click'));
    assert.strictEqual(container.querySelector('.fallback-banner'), null);

    app.closeModal();
    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-14: WebSocket Connection Status Pill Reconciliation
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-14: WebSocket Connection Status Pill Reconciliation (INV-RELAY-3)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    const pill = container.querySelector('#connection-status-pill');

    // Emit connected
    app.relayClient.emit('connected');
    assert.strictEqual(pill.classList.contains('status-connected'), true, 'Must transition to status-connected');

    // Emit reconnecting
    app.relayClient.emit('reconnecting');
    assert.strictEqual(pill.classList.contains('status-reconnecting'), true, 'Must transition to status-reconnecting');

    // Emit disconnected
    app.relayClient.emit('disconnected');
    assert.strictEqual(pill.classList.contains('status-offline'), true, 'Must transition to status-offline');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-15: Keyboard Shortcut Acceleration (Space/P and H)
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-15: Keyboard Shortcut Acceleration (Space/P and H) (User Experience, Audio Note 1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    let dispatchedActions = [];
    app.dispatchAction = async (action, ctx) => {
      dispatchedActions.push({ action, ctx });
    };

    // Press Space (Pass Priority)
    doc.dispatchEvent(new MockKeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    assert.strictEqual(dispatchedActions.length, 1);
    assert.strictEqual(dispatchedActions[0].action.type, 'PASS_PRIORITY');

    // Press KeyH (Hold Priority)
    doc.dispatchEvent(new MockKeyboardEvent('keydown', { code: 'KeyH', key: 'h' }));
    assert.strictEqual(dispatchedActions.length, 2);
    assert.strictEqual(dispatchedActions[1].action.type, 'HOLD_RESPOND');

    // Dispatched keydown inside an input element should be ignored
    const inputMock = doc.createElement('input');
    doc.dispatchEvent(new MockKeyboardEvent('keydown', { code: 'Space', key: ' ', target: inputMock }));
    assert.strictEqual(dispatchedActions.length, 2, 'Keydown inside input must not fire hotkey action');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-HARNESS-16: Sub-16ms Frame Budget Reconciliation Benchmark
  // --------------------------------------------------------------------------
  await test('TC-HARNESS-16: Sub-16ms Frame Budget Reconciliation Benchmark (60 FPS Performance Gate)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ players: ['p1', 'p2', 'p3', 'p4'], autoConnect: false });
    await app.mount(container);

    const iterations = 100;
    const tStart = performance.now();

    for (let i = 0; i < iterations; i++) {
      app.reconcileDOM();
    }

    const tEnd = performance.now();
    const totalMs = tEnd - tStart;
    const avgMs = totalMs / iterations;

    console.log(`    -> Sub-16ms Benchmark: ${iterations} reconciliations in ${totalMs.toFixed(2)}ms (Avg: ${avgMs.toFixed(3)}ms/frame)`);
    assert.ok(avgMs <= 16.0, `Average frame execution (${avgMs.toFixed(3)}ms) must be <= 16.0ms`);

    app.destroy();
  });

  console.log('\n==================================================================');
  console.log(`Summary: ${passed} passed, ${failed} failed.`);
  console.log('==================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite();
