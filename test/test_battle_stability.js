/**
 * test/test_battle_stability.js
 * Exhaustive 16-Vector Acceptance Test Suite for Feature 17:
 * Battle Stability, Opponent Land Field, Auto-Tap Mana Engine, Stack Resolution, and Card Inspection
 *
 * Document ID: SPEC-RPM-STABILITY-017
 * Formal Invariants Verified:
 * - INV-OPP-LAND-1: Dedicated Opponent Land Strip, Tapped Rotation, Mana Identity Pips
 * - INV-MANA-1: MTG Arena Auto-Tap Mana Engine, Direct Land Tapping, Perkins Pre-Cast Tapping
 * - INV-PRIORITY-AUTO-1: APNAP CR 117.3b Auto-Pass, 15s Stack Alarm, Friendly Names, CR 608.2 Resolution
 * - INV-DRAW-1: MTG CR 103.7a Skip on Turn 1 (1v1) & CR 504.1 Automatic Draw Step Engine
 * - INV-INSPECT-1: Starter Archetypes Pre-Hydration & Live Scryfall Fetch Fallback with Skeleton Loader
 * - INV-HEADER-1: Contextual Friendly Player/Bot Name Header Resolution (No Raw UUIDs)
 * - INV-LAND-QUOTA-2: Synchronized priorityMachine & Granular Diagnostics (Not Active, Phase, Limit)
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
} from '../src/index.js';

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

// ============================================================================
// Acceptance Test Suite (16 Vectors)
// ============================================================================

async function runTestSuite() {
  console.log('\n==================================================================');
  console.log('  RUNNING FEATURE 17 ACCEPTANCE TEST SUITE');
  console.log('  Specification: SPEC-RPM-STABILITY-017');
  console.log('==================================================================\n');

  // --------------------------------------------------------------------------
  // TC-STABILITY-01: Opponent Land Strip Rendering & Pip Identity (INV-OPP-LAND-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-01', 'Opponent Land Strip Rendering & Pip Identity (INV-OPP-LAND-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      myPlayerId: 'p1',
      playerIds: ['p1', 'p2_perkins']
    });
    await app.mount(container);

    app.tabletopState.registerPlayer('p1', 'Player 1');
    app.tabletopState.registerPlayer('p2_perkins', 'Perkins AI (Bot)');

    // Seed Perkins with 2 Mountains on battlefield
    const p2 = app.tabletopState.getPlayer('p2_perkins');
    p2.battlefield = p2.battlefield || { lands: [], creatures: [] };
    p2.battlefield.lands = [
      { instanceId: 'land_m1', name: 'Mountain', colors: ['R'], isTapped: false },
      { instanceId: 'land_m2', name: 'Mountain', colors: ['R'], isTapped: false }
    ];

    app._reconcileOpponents();

    const landStrip = container.querySelector('.opponent-lands-strip');
    assert.ok(landStrip, '.opponent-lands-strip must exist on opponent board');

    const landCards = container.querySelectorAll('.opponent-lands-strip .opponent-land-card');
    assert.strictEqual(landCards.length, 2, 'Must render exactly 2 opponent land cards');

    for (const card of landCards) {
      assert.ok(card.textContent.includes('Mountain'), 'Card name must display Mountain');
      assert.ok(card.innerHTML.includes('ms-r'), 'Mana pip must display ms-r glyph');
    }

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-02: Opponent Land Tap Visual State Rotation (INV-OPP-LAND-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-02', 'Opponent Land Tap Visual State Rotation (INV-OPP-LAND-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      myPlayerId: 'p1',
      playerIds: ['p1', 'p2']
    });
    await app.mount(container);

    app.tabletopState.registerPlayer('p1', 'Player 1');
    app.tabletopState.registerPlayer('p2', 'Player 2');

    const p2 = app.tabletopState.getPlayer('p2');
    p2.battlefield = {
      lands: [
        { instanceId: 'f_untapped', name: 'Forest', colors: ['G'], isTapped: false },
        { instanceId: 'f_tapped', name: 'Forest', colors: ['G'], isTapped: true }
      ],
      creatures: []
    };

    app._reconcileOpponents();

    const landCards = container.querySelectorAll('.opponent-lands-strip .opponent-land-card');
    assert.strictEqual(landCards.length, 2);

    const untappedCard = landCards[0];
    const tappedCard = landCards[1];

    assert.strictEqual(untappedCard.classList.contains('is-tapped'), false, 'Untapped land must not have .is-tapped');
    assert.ok(tappedCard.classList.contains('is-tapped'), 'Tapped land must have .is-tapped class');

    const styleStr = (tappedCard.getAttribute('style') || '').toLowerCase();
    const textContent = tappedCard.textContent || '';
    assert.ok(textContent.includes('(Tapped)') || styleStr.includes('rotate(90deg)'), 'Tapped card must display (Tapped) badge or rotation');
    assert.ok(styleStr.includes('0.62') || styleStr.includes('0.58') || tappedCard.classList.contains('is-tapped'), 'Tapped card must be dimmed or have is-tapped');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-03: Direct Land Tapping floats Mana to Pool (INV-MANA-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-03', 'Direct Land Tapping floats Mana to Pool (INV-MANA-1)', async () => {
    const tsm = new TabletopStateManager({ sessionId: 'spec_stability_s03' });
    tsm.registerPlayer('p1', 'Player 1');
    tsm.registerPlayer('p2', 'Player 2');

    const p1 = tsm.getPlayer('p1');
    p1.battlefield = {
      lands: [{ instanceId: 'm_01', name: 'Mountain', colors: ['R'], isTapped: false, zone: 'battlefield' }],
      creatures: []
    };
    p1.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

    let tappedEventFired = false;
    tsm.on('PERMANENT_TAPPED', (evt) => {
      if (evt.instanceId === 'm_01') tappedEventFired = true;
    });

    const result = tsm.tapLandForMana('p1', 'm_01');

    assert.ok(result, 'tapLandForMana must return success result');
    assert.strictEqual(p1.battlefield.lands[0].isTapped, true, 'Mountain must be tapped');
    assert.strictEqual(p1.resources.manaPool.R, 1, 'Mana pool must have 1 Red mana');
    assert.strictEqual(tappedEventFired, true, 'PERMANENT_TAPPED event must be emitted');
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-04: Rejection of Already Tapped Land (INV-MANA-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-04', 'Rejection of Already Tapped Land (INV-MANA-1)', async () => {
    const tsm = new TabletopStateManager({ sessionId: 'spec_stability_s04' });
    tsm.registerPlayer('p1', 'Player 1');
    tsm.registerPlayer('p2', 'Player 2');

    const p1 = tsm.getPlayer('p1');
    p1.battlefield = {
      lands: [{ instanceId: 'm_tapped', name: 'Mountain', colors: ['R'], isTapped: true, zone: 'battlefield' }],
      creatures: []
    };
    p1.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

    assert.throws(() => {
      tsm.tapLandForMana('p1', 'm_tapped');
    }, (err) => {
      return err instanceof PermanentAlreadyTappedError || err.name === 'PermanentAlreadyTappedError';
    }, 'Must throw PermanentAlreadyTappedError when tapping an already tapped land');

    assert.strictEqual(p1.resources.manaPool.R, 0, 'Mana pool must remain 0');
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-05: Greedy Auto-Tap Engine Satisfies Spell Mana (INV-MANA-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-05', 'Greedy Auto-Tap Engine Satisfies Spell Mana (INV-MANA-1)', async () => {
    const tsm = new TabletopStateManager({ sessionId: 'spec_stability_s05' });
    tsm.registerPlayer('p1', 'Player 1');
    tsm.registerPlayer('p2', 'Player 2');

    const p1 = tsm.getPlayer('p1');
    p1.battlefield = {
      lands: [
        { instanceId: 'm_1', name: 'Mountain', colors: ['R'], isTapped: false, zone: 'battlefield' },
        { instanceId: 'm_2', name: 'Mountain', colors: ['R'], isTapped: false, zone: 'battlefield' }
      ],
      creatures: []
    };
    p1.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

    const autoTapResult = tsm.autoTapForMana('p1', '{R}{R}');

    assert.ok(autoTapResult, 'Auto-tap must succeed');
    assert.strictEqual(p1.battlefield.lands[0].isTapped, true, 'Mountain 1 must be tapped');
    assert.strictEqual(p1.battlefield.lands[1].isTapped, true, 'Mountain 2 must be tapped');
    assert.strictEqual(autoTapResult.tappedLandIds.length, 2, 'Must record 2 tapped land IDs');
    assert.strictEqual(p1.resources.manaPool.R, 0, 'Mana pool must be fully consumed by the spell');
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-06: Auto-Tap Atomic Rollback on Insufficient Mana (INV-MANA-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-06', 'Auto-Tap Atomic Rollback on Insufficient Mana (INV-MANA-1)', async () => {
    const tsm = new TabletopStateManager({ sessionId: 'spec_stability_s06' });
    tsm.registerPlayer('p1', 'Player 1');
    tsm.registerPlayer('p2', 'Player 2');

    const p1 = tsm.getPlayer('p1');
    p1.battlefield = {
      lands: [
        { instanceId: 'm_only1', name: 'Mountain', colors: ['R'], isTapped: false, zone: 'battlefield' }
      ],
      creatures: []
    };
    p1.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

    assert.throws(() => {
      tsm.autoTapForMana('p1', '{R}{R}');
    }, (err) => {
      return err instanceof InsufficientManaError || err.name === 'InsufficientManaError';
    }, 'Must throw InsufficientManaError when lands cannot satisfy cost');

    // Rollback validation: Mountain must remain UNTAPPED
    assert.strictEqual(p1.battlefield.lands[0].isTapped, false, 'Mountain must be restored to untapped via atomic rollback');
    assert.strictEqual(p1.resources.manaPool.R, 0, 'Mana pool must remain 0');
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-07: Perkins AI Explicit Land Tapping before Cast (INV-MANA-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-07', 'Perkins AI Explicit Land Tapping before Cast (INV-MANA-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      myPlayerId: 'p1',
      playerIds: ['p1', 'perkins_ai']
    });
    await app.mount(container);

    app.tabletopState.registerPlayer('p1', 'Player 1');
    app.tabletopState.registerPlayer('perkins_ai', 'Perkins AI (Bot)');

    const psm = app.priorityMachine;
    psm.activePlayerId = 'perkins_ai';
    psm.priorityPlayerId = 'perkins_ai';
    psm.currentPhaseStep = 'PRECOMBAT_MAIN';

    const pPerkins = app.tabletopState.getPlayer('perkins_ai');
    pPerkins.battlefield = {
      lands: [{ instanceId: 'pk_mountain', name: 'Mountain', colors: ['R'], isTapped: false, zone: 'battlefield' }],
      creatures: []
    };
    pPerkins.hand = [
      { instanceId: 'gg_01', name: 'Goblin Guide', manaCost: '{R}', typeLine: 'Creature — Goblin Scout' }
    ];
    pPerkins.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

    const agent = new PerkinsAgent({
      slotId: 'perkins_ai',
      app
    });

    const actionProposal = await agent.evaluateTurnPhase('PRECOMBAT_MAIN', app.tabletopState);

    assert.ok(actionProposal, 'Perkins must formulate an action proposal');
    assert.strictEqual(actionProposal.type, 'CAST_SPELL', 'Perkins proposal must be CAST_SPELL');
    assert.strictEqual(actionProposal.card?.name, 'Goblin Guide', 'Must cast Goblin Guide');
    assert.strictEqual(pPerkins.battlefield.lands[0].isTapped, true, 'Perkins must tap Mountain on battlefield');

    agent.destroy();
    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-08: Spell Cast Priority Rotation (MTG CR 117.3b) (INV-PRIORITY-AUTO-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-08', 'Spell Cast Priority Rotation (MTG CR 117.3b) (INV-PRIORITY-AUTO-1)', async () => {
    const psm = new PriorityStateMachine({
      players: ['p1', 'p2'],
      startingPlayerId: 'p1'
    });

    psm.activePlayerId = 'p1';
    psm.priorityPlayerId = 'p1';
    psm.consecutivePassCount = 1;

    let rotatedEvent = null;
    psm.on('SPELL_CAST_PRIORITY_ROTATED', (evt) => {
      rotatedEvent = evt;
    });

    psm.pushStack({
      id: 'spell_bolt',
      name: 'Lightning Bolt',
      sourcePlayerId: 'p1',
      controllerId: 'p1',
      controllerName: 'Alice'
    });

    assert.strictEqual(psm.priorityPlayerId, 'p2', 'Priority must rotate to P2 per CR 117.3b');
    assert.strictEqual(psm.consecutivePassCount, 0, 'consecutivePassCount must reset to 0');
    assert.ok(rotatedEvent, 'SPELL_CAST_PRIORITY_ROTATED event must be emitted');
    assert.strictEqual(rotatedEvent.nextPriorityPlayerId, 'p2');
    assert.strictEqual(rotatedEvent.controllerName, 'Alice');
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-09: Priority Hand-off Alarm & Toast (INV-PRIORITY-AUTO-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-09', 'Priority Hand-off Alarm & Toast (INV-PRIORITY-AUTO-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      myPlayerId: 'p1',
      playerIds: ['p1', 'p2_perkins']
    });
    await app.mount(container);

    app.tabletopState.registerPlayer('p1', 'Player 1');
    app.tabletopState.registerPlayer('p2_perkins', 'Perkins AI (Bot)');

    const psm = app.priorityMachine;
    psm.players = ['p1', 'p2_perkins'];
    psm.activePlayerId = 'p1';
    psm.priorityPlayerId = 'p1';

    let alarmStarted = false;
    let alarmTarget = null;
    if (app.alarmManager) {
      const origStart = app.alarmManager.start.bind(app.alarmManager);
      app.alarmManager.start = (target, stackId, duration) => {
        alarmStarted = true;
        alarmTarget = target;
        return origStart(target, stackId, duration);
      };
    }

    // P1 pushes a spell to stack
    psm.pushStack({
      id: 'spell_test',
      name: 'Lightning Bolt',
      sourcePlayerId: 'p1',
      controllerId: 'p1',
      controllerName: 'You'
    });

    assert.strictEqual(alarmStarted, true, 'Stack alarm must start on spell cast');
    assert.strictEqual(alarmTarget, 'p2_perkins', 'Alarm must target opponent');

    const toast = container.querySelector('#arena-toast-notification');
    const toastText = toast?.textContent || app.lastToast || '';
    assert.ok(toastText.includes('Spell cast! Priority passed to Perkins AI (Bot)'),
      `Toast must notify friendly priority pass, got: "${toastText}"`);

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-10: Priority Timeout Permanent Resolution (MTG CR 608.2) (INV-PRIORITY-AUTO-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-10', 'Priority Timeout Permanent Resolution (MTG CR 608.2) (INV-PRIORITY-AUTO-1)', async () => {
    const psm = new PriorityStateMachine({
      players: ['p1', 'p2'],
      startingPlayerId: 'p1'
    });
    const tsm = new TabletopStateManager({ sessionId: 'spec_stability_s10' });
    tsm.registerPlayer('p1', 'Player 1');
    tsm.registerPlayer('p2', 'Player 2');

    psm.tabletopState = tsm;
    tsm.priorityMachine = psm;

    const p1 = tsm.getPlayer('p1');
    p1.battlefield = { lands: [], creatures: [], noncreatures: [], planeswalkers: [] };

    const goblinCard = {
      instanceId: 'inst_goblin_99',
      name: 'Goblin Guide',
      typeLine: 'Creature — Goblin Scout',
      type: 'Creature'
    };

    // P1 casts Goblin Guide; priority auto-passes to P2
    psm.pushStack({
      id: 'stack_goblin',
      sourcePlayerId: 'p1',
      controllerId: 'p1',
      card: goblinCard,
      name: 'Goblin Guide'
    });

    assert.strictEqual(psm.priorityPlayerId, 'p2');
    assert.strictEqual(psm.stack.length, 1);

    // Opponent priority timer expires -> onTimeout executes PASS_PRIORITY
    psm.alarmManager.onTimeout('p2', 'stack_goblin');

    // Consensus reached -> Goblin Guide resolves directly to battlefield (CR 608.2)
    assert.strictEqual(psm.stack.length, 0, 'Stack must be empty after resolution');
    assert.strictEqual(p1.battlefield.creatures.length, 1, 'Creature must enter P1 battlefield');
    assert.strictEqual(p1.battlefield.creatures[0].name, 'Goblin Guide');
    assert.strictEqual(p1.battlefield.creatures[0].isSummoningSick, true, 'Creature must have summoning sickness');
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-11: 1v1 Starting Player Skips Turn 1 Draw (MTG CR 103.7a) (INV-DRAW-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-11', '1v1 Starting Player Skips Turn 1 Draw (MTG CR 103.7a) (INV-DRAW-1)', async () => {
    const psm = new PriorityStateMachine({
      players: ['p1', 'p2'],
      startingPlayerId: 'p1'
    });

    let drawEvent = null;
    psm.on('DRAW_STEP', (evt) => {
      drawEvent = evt;
    });

    // P1 in Round 1 advances to DRAW step
    psm.roundNumber = 1;
    psm.activePlayerId = 'p1';
    psm.setPhaseStep('DRAW');

    assert.ok(drawEvent, 'DRAW_STEP event must be emitted');
    assert.strictEqual(drawEvent.shouldSkipDraw, true, 'Starting player in 1v1 must skip Turn 1 draw per CR 103.7a');
    assert.strictEqual(drawEvent.activePlayerId, 'p1');
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-12: 1v1 Player 2 Turn 1 Mandatory Draw (MTG CR 504.1) (INV-DRAW-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-12', '1v1 Player 2 Turn 1 Mandatory Draw (MTG CR 504.1) (INV-DRAW-1)', async () => {
    const psm = new PriorityStateMachine({
      players: ['p1', 'p2'],
      startingPlayerId: 'p1'
    });

    let drawEvent = null;
    psm.on('DRAW_STEP', (evt) => {
      drawEvent = evt;
    });

    // P2 taking turn in Round 1 (Turn 2)
    psm.roundNumber = 1;
    psm.activePlayerId = 'p2';
    psm.setPhaseStep('DRAW');

    assert.ok(drawEvent, 'DRAW_STEP event must be emitted');
    assert.strictEqual(drawEvent.shouldSkipDraw, false, 'Player 2 on Turn 1 must draw a card per CR 504.1');
    assert.strictEqual(drawEvent.activePlayerId, 'p2');
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-13: Multiplayer Pod All Players Draw on Turn 1 (INV-DRAW-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-13', 'Multiplayer Pod All Players Draw on Turn 1 (INV-DRAW-1)', async () => {
    // 3-Player Pod
    const psm = new PriorityStateMachine({
      players: ['p1', 'p2', 'p3'],
      startingPlayerId: 'p1'
    });

    let drawEvent = null;
    psm.on('DRAW_STEP', (evt) => {
      drawEvent = evt;
    });

    // P1 starting player in a 3-player pod
    psm.roundNumber = 1;
    psm.activePlayerId = 'p1';
    psm.setPhaseStep('DRAW');

    assert.ok(drawEvent, 'DRAW_STEP event must be emitted');
    assert.strictEqual(drawEvent.shouldSkipDraw, false, 'In multiplayer pods (3+), starting player draws on Turn 1 (CR 103.7a pod exception)');
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-14: Pre-Hydrated Starter Archetype Instant Inspection (INV-INSPECT-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-14', 'Pre-Hydrated Starter Archetype Instant Inspection (INV-INSPECT-1)', async () => {
    setupMockDOM();
    const goblinMeta = getHydratedCardMetadata('Goblin Guide');

    assert.ok(goblinMeta, 'Pre-hydrated metadata for Goblin Guide must exist');
    assert.ok(goblinMeta.imageUri, 'Must possess high-res imageUri');
    assert.ok(goblinMeta.oracleText, 'Must possess full oracleText');
    assert.strictEqual(goblinMeta.manaCost, '{R}', 'Must possess mana cost');
    assert.strictEqual(goblinMeta.power, 2, 'Power must be 2');
    assert.strictEqual(goblinMeta.toughness, 2, 'Toughness must be 2');

    let networkCallMade = false;
    const mockScryfall = {
      fetchCardByName: async () => {
        networkCallMade = true;
        return goblinMeta;
      }
    };

    const modal = new CardOverlayModal({ scryfallService: mockScryfall });
    modal.show(goblinMeta);

    assert.strictEqual(networkCallMade, false, 'Pre-hydrated card must render instantly with 0 network calls');
    const dialog = modal.element?.querySelector('.modal-card-dialog');
    assert.strictEqual(dialog?.classList.contains('card-modal-skeleton-shimmer'), false, 'Should not show skeleton shimmer');

    modal.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-15: Uncached Stub Card Dynamic Scryfall Fetch Fallback (INV-INSPECT-1)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-15', 'Uncached Stub Card Dynamic Scryfall Fetch Fallback (INV-INSPECT-1)', async () => {
    setupMockDOM();
    const stubCard = { name: 'Ragavan, Nimble Pilferer' };

    let scryfallFetchCalledWith = null;
    const richRagavan = {
      name: 'Ragavan, Nimble Pilferer',
      manaCost: '{R}',
      typeLine: 'Legendary Creature — Monkey Pirate',
      oracleText: 'Whenever Ragavan deals combat damage to a player, create a Treasure token...',
      imageUri: 'https://cards.scryfall.io/normal/ragavan.jpg',
      power: 2,
      toughness: 1
    };

    const mockScryfall = {
      fetchCardByName: async (name) => {
        scryfallFetchCalledWith = name;
        return richRagavan;
      }
    };

    const modal = new CardOverlayModal({ scryfallService: mockScryfall });
    modal.show(stubCard);

    // Initial state: skeleton shimmer active
    const dialog = modal.element?.querySelector('.modal-card-dialog');
    assert.strictEqual(dialog?.classList.contains('card-modal-skeleton-shimmer'), true, 'Skeleton shimmer must be shown while fetching');

    // Await async fetch resolution
    if (modal.fetchPromise) {
      await modal.fetchPromise;
    }

    assert.strictEqual(scryfallFetchCalledWith, 'Ragavan, Nimble Pilferer', 'Scryfall fetch must be invoked with card name');
    assert.strictEqual(dialog?.classList.contains('card-modal-skeleton-shimmer'), false, 'Skeleton shimmer must be removed upon resolution');
    assert.strictEqual(stubCard.oracleText, richRagavan.oracleText, 'Card metadata must be hydrated');

    modal.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-STABILITY-16: Contextual Header Friendly Names & Land Quota Rejection Messages (INV-HEADER-1, INV-LAND-QUOTA-2)
  // --------------------------------------------------------------------------
  await test('TC-STABILITY-16', 'Contextual Header Friendly Names & Land Quota Rejection Messages (INV-HEADER-1, INV-LAND-QUOTA-2)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      myPlayerId: 'p1',
      playerIds: ['p1', 'perkins-bot-001']
    });
    await app.mount(container);

    app.tabletopState.registerPlayer('p1', 'Player 1');
    app.tabletopState.registerPlayer('perkins-bot-001', 'Perkins AI (Bot)');

    // Assertion 1: Header shows friendly bot name when active player is bot
    app.priorityMachine.activePlayerId = 'perkins-bot-001';
    app._reconcileHeader();

    const activeHeader = container.querySelector('#active-player-name');
    assert.ok(activeHeader, 'Active player header element must exist');
    assert.ok(activeHeader.textContent.includes('Turn: Perkins AI (Bot)'),
      `Header must display "Turn: Perkins AI (Bot)", got: "${activeHeader.textContent}"`);
    assert.strictEqual(/perkins-bot-001/i.test(activeHeader.textContent), false, 'Header must not display raw UUID/id');

    // Assertion 2: P1 attempts to play land on P2 turn -> "⚠️ It is not your turn"
    const p1 = app.tabletopState.getPlayer('p1');
    p1.hand = [{ instanceId: 'land_p1', name: 'Mountain', typeLine: 'Basic Land — Mountain' }];
    app.playLandFromHand(p1.hand[0]);

    assert.ok((app.lastToast || app.lastWarning || '').includes('It is not your turn'),
      `Toast must notify "⚠️ It is not your turn", got: "${app.lastToast}"`);

    // Assertion 3: P1 attempts to play second land in Main 1 -> "⚠️ You have already played a land this turn (1/1)"
    app.priorityMachine.activePlayerId = 'p1';
    app.priorityMachine.priorityPlayerId = 'p1';
    app.priorityMachine.setPhaseStep('PRECOMBAT_MAIN');

    p1.landsPlayedThisTurn = 1;
    p1.hand = [{ instanceId: 'land_p2', name: 'Mountain', typeLine: 'Basic Land — Mountain' }];
    app.playLandFromHand(p1.hand[0]);

    assert.ok((app.lastToast || app.lastWarning || '').includes('already played a land this turn (1/1)'),
      `Toast must notify "⚠️ You have already played a land this turn (1/1)", got: "${app.lastToast}"`);

    app.destroy();
  });

  console.log('\n==================================================================');
  console.log(`  FEATURE 17 TEST RESULTS: ${totalPassed} passed, ${totalFailed} failed`);
  console.log('==================================================================\n');

  if (totalFailed > 0) {
    process.exit(1);
  }
}

runTestSuite();
