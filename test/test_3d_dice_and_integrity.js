/**
 * test/test_3d_dice_and_integrity.js
 * Exhaustive 16-Vector Acceptance Test Suite for Feature 18:
 * 3D Dice Engine Integration, Bot Spell Cast Integrity, and Perk Activation Normalization
 * 
 * Document ID: SPEC-RPM-DICE-018
 * Formal Invariants Verified:
 * - INV-BOT-CAST-1: Bot Hand Card Splicing & Mana Pool / Land Auto-Tap Synchronization
 * - INV-BOT-THROTTLE-1: Perkins AI Stack Alarm Throttling, Counter Reset & Concurrency Guard
 * - INV-PERK-PAYLOAD-1: Upkeep Roll Miss Payload Unpacking & Non-Zero Display
 * - INV-PERK-KEY-1: Key Normalization for 0/00/100 and Manual triggerDiceRoll Resolution
 * - INV-DICE-3D-1: 3D DiceBox Integration, Ammo.js WASM MIME, and Headless Test Bypass
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RPMAppController,
  TabletopStateManager,
  PriorityStateMachine,
  StackAlarmManager,
  PerkinsAgent,
  PerkCatalog,
  getPerkDefinition,
  resolveRoll,
  executePerkEffect,
  DiceCanvas,
  diceCanvas,
  is3DSupported,
  DiceShaker,
  diceShaker,
  RandomPerkEngine
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

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
  if (selector.startsWith('#')) return elem.id === selector.slice(1);
  if (selector.startsWith('.')) return elem.classList.contains(selector.slice(1));
  return elem.tagName.toLowerCase() === selector.toLowerCase();
}

class MockDocument {
  constructor() {
    this.body = new MockElement('body');
    this._listeners = new Map();
  }
  createElement(tagName) { return new MockElement(tagName); }
  getElementById(id) { return this.body.querySelector(`#${id}`); }
  querySelector(selector) { return this.body.querySelector(selector); }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
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

export async function runTestSuite() {
  console.log('\n==================================================================');
  console.log('  RUNNING FEATURE 18 ACCEPTANCE TEST SUITE');
  console.log('  3D Dice Engine Integration, Bot Cast Integrity & Perk Normalization');
  console.log('  Specification: SPEC-RPM-DICE-018');
  console.log('==================================================================\n');

  // --------------------------------------------------------------------------
  // TC-DICE-01: Bot Hand Card Splicing on CAST_SPELL (INV-BOT-CAST-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-01', 'Bot Hand Card Splicing on CAST_SPELL (INV-BOT-CAST-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      myPlayerId: 'p1',
      playerIds: ['p1', 'bot_perkins']
    });
    await app.mount();

    app.tabletopState.registerPlayer('p1', 'Player 1');
    app.tabletopState.registerPlayer('bot_perkins', 'Perkins AI (Bot)');

    const botId = 'bot_perkins';
    const bot = app.tabletopState.getPlayer(botId);
    assert.ok(bot, 'Bot player must exist in tabletopState');

    bot.zones = bot.zones || {};
    bot.zones.hand = [
      { instanceId: 'card_angel_1', name: 'Serra Angel', manaCost: '{3}{W}{W}' },
      { instanceId: 'card_angel_2', name: 'Serra Angel', manaCost: '{3}{W}{W}' },
      { instanceId: 'card_bolt_1', name: 'Lightning Bolt', manaCost: '{R}' }
    ];
    bot.hand = [...bot.zones.hand];

    assert.strictEqual(bot.hand.length, 3, 'Initial hand must have 3 cards');

    // Bot dispatches CAST_SPELL via action pipeline
    await app.dispatchAction({
      type: 'CAST_SPELL',
      playerId: botId,
      controllerId: botId,
      card: { instanceId: 'card_angel_1', name: 'Serra Angel', manaCost: '{3}{W}{W}' }
    });

    assert.strictEqual(bot.zones.hand.length, 2, 'Hand zone must have 2 cards remaining after splicing');
    assert.strictEqual(bot.hand.length, 2, 'Hand alias must be synchronized with zones.hand');
    assert.strictEqual(bot.zones.hand.some(c => c.instanceId === 'card_angel_1'), false, 'Cast card instanceId must be removed');
    assert.strictEqual(bot.zones.hand[0].instanceId, 'card_angel_2', 'Second Serra Angel must remain intact in hand');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-DICE-02: Bot Mana Pool Deduction & Land Tap on CAST_SPELL (INV-BOT-CAST-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-02', 'Bot Mana Pool Deduction & Land Tap on CAST_SPELL (INV-BOT-CAST-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      myPlayerId: 'p1',
      playerIds: ['p1', 'bot_perkins']
    });
    await app.mount();

    app.tabletopState.registerPlayer('p1', 'Player 1');
    app.tabletopState.registerPlayer('bot_perkins', 'Perkins AI (Bot)');

    const botId = 'bot_perkins';
    const bot = app.tabletopState.getPlayer(botId);

    // Setup bot battlefield lands: 3 Plains, 2 Islands
    bot.battlefield = {
      lands: [
        { instanceId: 'land_p1', name: 'Plains', isTapped: false },
        { instanceId: 'land_p2', name: 'Plains', isTapped: false },
        { instanceId: 'land_p3', name: 'Plains', isTapped: false },
        { instanceId: 'land_i1', name: 'Island', isTapped: false },
        { instanceId: 'land_i2', name: 'Island', isTapped: false }
      ]
    };
    bot.zones = bot.zones || {};
    bot.zones.hand = [
      { instanceId: 'card_angel', name: 'Serra Angel', manaCost: '{3}{W}{W}' }
    ];
    bot.hand = [...bot.zones.hand];

    // Dispatch cast spell requiring {3}{W}{W} (5 mana: 2 white + 3 generic)
    await app.dispatchAction({
      type: 'CAST_SPELL',
      playerId: botId,
      controllerId: botId,
      card: bot.zones.hand[0]
    });

    // Verify all 5 lands were tapped by autoTapForMana
    const tappedCount = bot.battlefield.lands.filter(l => l.isTapped).length;
    assert.strictEqual(tappedCount, 5, 'All 5 lands must be tapped to pay for Serra Angel');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-DICE-03: Single Creature Cast Per Mana Availability (INV-BOT-CAST-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-03', 'Single Creature Cast Per Mana Availability (INV-BOT-CAST-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      myPlayerId: 'p1',
      playerIds: ['p1', 'bot_perkins']
    });
    await app.mount();

    app.tabletopState.registerPlayer('p1', 'Player 1');
    app.tabletopState.registerPlayer('bot_perkins', 'Perkins AI (Bot)');

    const botId = 'bot_perkins';
    const bot = app.tabletopState.getPlayer(botId);

    // Bot has only 2 Plains
    bot.battlefield = {
      lands: [
        { instanceId: 'l1', name: 'Plains', isTapped: false },
        { instanceId: 'l2', name: 'Plains', isTapped: false }
      ]
    };
    bot.zones = bot.zones || {};
    bot.zones.hand = [
      { instanceId: 'c1', name: 'Knight of Grace', manaCost: '{1}{W}' },
      { instanceId: 'c2', name: 'Knight of Grace', manaCost: '{1}{W}' }
    ];
    bot.hand = [...bot.zones.hand];

    // Cast first creature: consumes 2 Plains
    await app.dispatchAction({
      type: 'CAST_SPELL',
      playerId: botId,
      controllerId: botId,
      card: bot.zones.hand[0]
    });

    assert.strictEqual(bot.zones.hand.length, 1, 'First creature must be removed from hand');
    assert.strictEqual(bot.battlefield.lands.filter(l => !l.isTapped).length, 0, 'No untapped lands left');

    // Attempting to cast second creature: autoTap throws or warns, lands remain tapped
    assert.throws(() => {
      app.tabletopState.autoTapForMana(botId, '{1}{W}');
    }, /Insufficient.*mana/i, 'Auto-tap must throw on second cast due to insufficient mana');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-DICE-04: Perkins Stack Alarm Single Reaction Throttling (INV-BOT-THROTTLE-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-04', 'Perkins Stack Alarm Single Reaction Throttling (INV-BOT-THROTTLE-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false, myPlayerId: 'p1' });
    await app.mount(container);

    const agent = await app.startPerkinsMatch({ thinkingDelayMs: 0 });
    const botPlayer = app.tabletopState.players[agent.slotId];
    botPlayer.resources = { manaPool: { W: 0, U: 2, B: 0, R: 2, G: 0, C: 0 }, life: 20 };
    botPlayer.hand = [
      { instanceId: 'cs1', name: 'Counterspell', typeLine: 'Instant', manaCost: '{U}{U}', isHidden: false },
      { instanceId: 'lb1', name: 'Lightning Bolt', typeLine: 'Instant', manaCost: '{R}', isHidden: false }
    ];
    botPlayer.battlefield = {
      lands: [
        { instanceId: 'island_1', name: 'Island', isTapped: false, typeLine: 'Land' },
        { instanceId: 'island_2', name: 'Island', isTapped: false, typeLine: 'Land' },
        { instanceId: 'mountain_1', name: 'Mountain', isTapped: false, typeLine: 'Land' }
      ],
      creatures: [],
      noncreatures: [],
      planeswalkers: []
    };

    let lastDispatchedAction = null;
    const origDispatch = app.dispatchAction.bind(app);
    app.dispatchAction = async (action, ctx) => {
      lastDispatchedAction = action;
      return origDispatch(action, ctx);
    };

    app.priorityMachine.pushStack({
      id: 'spell_lotus',
      name: 'Gilded Lotus',
      sourcePlayerId: app.myPlayerId,
      controllerId: app.myPlayerId
    });

    // Await microtasks from pushStack priority change
    await new Promise(r => setTimeout(r, 10));

    // 1. First Stack Alarm: Perkins fires Counterspell reaction
    lastDispatchedAction = null;
    await agent.onStackAlarm({ targetPlayerId: agent.slotId, stackItemId: 'spell_lotus' });
    assert.strictEqual(lastDispatchedAction?.type, 'CAST_SPELL', 'First alarm must cast instant reaction');
    assert.strictEqual(lastDispatchedAction?.card?.name, 'Counterspell', 'Must counter opposing spell');
    assert.strictEqual(agent._alarmActionCount, 1, 'Reaction counter must increment to 1');

    // 2. Second Stack Alarm in same exchange: Must be throttled to PASS_PRIORITY
    lastDispatchedAction = null;
    await agent.onStackAlarm({ targetPlayerId: agent.slotId, stackItemId: 'spell_lotus' });
    assert.strictEqual(lastDispatchedAction?.type, 'PASS_PRIORITY', 'Second alarm must be throttled and emit PASS_PRIORITY');
    assert.strictEqual(agent._alarmActionCount, 1, 'Reaction counter remains capped');

    agent.destroy();
    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-DICE-05: Alarm Counter Reset on Stack Empty (INV-BOT-THROTTLE-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-05', 'Alarm Counter Reset on Stack Empty (INV-BOT-THROTTLE-1)', async () => {
    const agent = new PerkinsAgent({ slotId: 'p2' });
    agent._alarmActionCount = 1;

    // Reset via _handleStackEmpty
    agent._handleStackEmpty();
    assert.strictEqual(agent._alarmActionCount, 0, '_alarmActionCount must reset to 0');

    agent.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-DICE-06: Concurrency Lock Re-entrancy Rejection (INV-BOT-THROTTLE-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-06', 'Concurrency Lock Re-entrancy Rejection (INV-BOT-THROTTLE-1)', async () => {
    const agent = new PerkinsAgent({ slotId: 'p2' });
    agent._isEvaluating = true;

    let dispatched = false;
    agent.dispatchAction = async () => { dispatched = true; };

    // When _isEvaluating is true, onStackAlarm yields immediately
    const res = await agent.onStackAlarm({ targetPlayerId: 'p2' });
    assert.strictEqual(res, undefined, 'Re-entrant call must return immediately without action');
    assert.strictEqual(dispatched, false, 'No action may be dispatched while evaluating');

    agent._isEvaluating = false;
    agent.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-DICE-07: Roll Miss Nested Payload Unpacking in app.js (INV-PERK-PAYLOAD-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-07', 'Roll Miss Nested Payload Unpacking in app.js (INV-PERK-PAYLOAD-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ container, autoConnect: false, myPlayerId: 'p1' });
    await app.mount();

    // Emit PERK_ROLL_MISS from RandomPerkEngine with nested roll result (e.g. 4 and 7)
    app.randomPerk.emit('PERK_ROLL_MISS', {
      activePlayerId: 'p1',
      roll: { tens: 4, ones: 7, total: 47, rollString: '47' },
      turnNumber: 3
    });

    assert.ok(app._lastRoll, '_lastRoll must be recorded on app');
    assert.strictEqual(app._lastRoll.tens, 4, 'Unpacked tens digit must equal 4');
    assert.strictEqual(app._lastRoll.ones, 7, 'Unpacked ones digit must equal 7');
    assert.strictEqual(app._lastRoll.isMiss, true, 'isMiss flag must be true');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-DICE-08: Non-Zero Roll Miss Correctly Displays Rolled Digits (INV-PERK-PAYLOAD-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-08', 'Non-Zero Roll Miss Correctly Displays Rolled Digits (INV-PERK-PAYLOAD-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    container.innerHTML = `
      <div id="perk-dice-container" style="display: none;">
        <div id="dice-tens"><span class="dice-value">0</span></div>
        <div id="dice-ones"><span class="dice-value">0</span></div>
        <span id="perk-roll-key"></span>
        <p id="perk-effect-description"></p>
      </div>
    `;
    doc.body.appendChild(container);

    const app = new RPMAppController({ container, autoConnect: false, myPlayerId: 'p1' });
    await app.mount();

    // Call handlePerkRolled with unpacked miss payload
    app.handlePerkRolled({
      tens: 4,
      ones: 7,
      total: 47,
      isMiss: true
    });

    const badge = container.querySelector('#perk-roll-key');
    const tensVal = container.querySelector('#dice-tens .dice-value');
    const onesVal = container.querySelector('#dice-ones .dice-value');

    assert.strictEqual(tensVal.textContent, '4', 'Tens element must display 4');
    assert.strictEqual(onesVal.textContent, '7', 'Ones element must display 7');
    assert.strictEqual(badge.textContent, 'ROLL 47 ➔ Roll Miss (No Perk)', 'Badge text must display actual rolled digits 47 instead of 00');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-DICE-09: True 00 Roll Triggers Perk #00 Genesis Surge (INV-PERK-KEY-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-09', 'True 00 Roll Triggers Perk #00 Genesis Surge (INV-PERK-KEY-1)', async () => {
    const res = resolveRoll(0, 0);
    assert.strictEqual(res.isMiss, false, 'Double zero must not be a miss');
    assert.strictEqual(res.perkKey, '00', 'Resolved perk key must be "00"');

    const def = getPerkDefinition('00');
    assert.ok(def, 'Genesis Surge definition must exist');
    assert.strictEqual(def.name, 'Genesis Surge');

    // Execute effect on state
    const state = new TabletopStateManager({ sessionId: 'test_session_dice' });
    state.registerPlayer('p1', 'Player 1');
    state.registerPlayer('p2', 'Player 2');
    state.initializeDeck('p1', Array(20).fill({ name: 'Forest', typeLine: 'Basic Land' }));
    const p1 = state.players['p1'];
    p1.resources.life = 20;
    const initialHandCount = p1.hand.length;

    const execRes = executePerkEffect('00', state, { activePlayerId: 'p1' });
    assert.strictEqual(execRes.success, true, 'Genesis Surge must execute successfully');
    assert.strictEqual(p1.resources.life, 30, 'Player must gain 10 life (20 -> 30)');
    assert.strictEqual(p1.hand.length, initialHandCount + 3, 'Player must draw 3 cards');
  });

  // --------------------------------------------------------------------------
  // TC-DICE-10: Key Normalization for 0, "0", 100, "100" (INV-PERK-KEY-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-10', 'Key Normalization for 0, "0", 100, "100" (INV-PERK-KEY-1)', async () => {
    const inputs = [0, '0', 100, '100', '00'];
    for (const input of inputs) {
      const def = getPerkDefinition(input);
      assert.ok(def, `getPerkDefinition must resolve for input: ${input}`);
      assert.strictEqual(def.name, 'Genesis Surge', `Input ${input} must resolve to Genesis Surge`);
    }

    // Single digit normalization
    const def5 = getPerkDefinition('5');
    assert.ok(def5, 'Single digit "5" must resolve to double "55"');
    assert.strictEqual(def5.key, '55');
  });

  // --------------------------------------------------------------------------
  // TC-DICE-11: Manual triggerDiceRoll Evaluates Legal Perks (INV-PERK-KEY-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-11', 'Manual triggerDiceRoll Evaluates Legal Perks (INV-PERK-KEY-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ container, autoConnect: false, myPlayerId: 'p1' });
    await app.mount();

    const roll = await app.triggerDiceRoll('dice');
    assert.ok(roll, 'Roll result must be generated');
    assert.ok(Number.isInteger(roll.tens), 'Tens digit must be an integer');
    assert.ok(Number.isInteger(roll.ones), 'Ones digit must be an integer');
    assert.strictEqual(typeof app._lastRoll.isMiss, 'boolean', 'isMiss must be resolved as boolean');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-DICE-12: 3D Dice Engine Asset Integrity & WASM MIME Header (INV-DICE-3D-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-12', '3D Dice Engine Asset Integrity & WASM MIME Header (INV-DICE-3D-1)', async () => {
    // 1. Verify filesystem assets
    const files = [
      'assets/lib/dice-box/dice-box.es.min.js',
      'assets/dice-box/ammo/ammo.wasm.wasm',
      'assets/dice-box/themes/smooth/smoothDice.json',
      'assets/sounds/roll.mp3'
    ];

    for (const f of files) {
      const fullPath = path.join(PROJECT_ROOT, f);
      assert.ok(fs.existsSync(fullPath), `Asset file must exist on disk: ${f}`);
      const stat = fs.statSync(fullPath);
      assert.ok(stat.size > 0, `Asset file must not be empty: ${f}`);
    }

    // 2. Verify server.js contains .wasm: application/wasm
    const serverPath = path.join(PROJECT_ROOT, 'server.js');
    const serverContent = fs.readFileSync(serverPath, 'utf8');
    assert.ok(serverContent.includes("'.wasm': 'application/wasm'"), 'server.js must define application/wasm MIME type');
  });

  // --------------------------------------------------------------------------
  // TC-DICE-13: is3DSupported() Headless Test Bypass Non-Throwing Invariant (INV-DICE-3D-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-13', 'is3DSupported() Headless Test Bypass Non-Throwing Invariant (INV-DICE-3D-1)', async () => {
    assert.strictEqual(is3DSupported(), false, 'is3DSupported() must return false in Node.js test environment');
    assert.strictEqual(diceCanvas.is3DSupported(), false, 'diceCanvas.is3DSupported() must match');

    // Methods must not throw in headless mode
    await diceCanvas.init();
    diceCanvas.clear();
    diceCanvas.teardown();
  });

  // --------------------------------------------------------------------------
  // TC-DICE-14: Percentile 2d10 Roll Return Array Order & Value Range (INV-DICE-3D-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-14', 'Percentile 2d10 Roll Return Array Order & Value Range (INV-DICE-3D-1)', async () => {
    for (let i = 0; i < 50; i++) {
      const res = await diceCanvas.rollPercentile();
      assert.ok(Array.isArray(res), 'Return value must be an array');
      assert.strictEqual(res.length, 2, 'Array must contain exactly 2 elements [tens, ones]');
      const [tens, ones] = res;
      assert.ok(Number.isInteger(tens) && tens >= 0 && tens <= 9, `Tens digit out of 0..9 range: ${tens}`);
      assert.ok(Number.isInteger(ones) && ones >= 0 && ones <= 9, `Ones digit out of 0..9 range: ${ones}`);
    }
  });

  // --------------------------------------------------------------------------
  // TC-DICE-15: d20 Roll-Off Single & Multi-Player Integration (INV-DICE-3D-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-15', 'd20 Roll-Off Single & Multi-Player Integration (INV-DICE-3D-1)', async () => {
    // Single d20 roll
    for (let i = 0; i < 20; i++) {
      const roll = await diceCanvas.rollD20('player_1');
      assert.ok(Number.isInteger(roll), 'd20 roll must return integer');
      assert.ok(roll >= 1 && roll <= 20, `d20 roll out of 1..20 bounds: ${roll}`);
    }

    // Multi-player d20 roll
    const players = [{ playerId: 'p1' }, { playerId: 'p2' }, { playerId: 'p3' }];
    const multiRes = await diceCanvas.rollMultiD20(players);
    assert.strictEqual(typeof multiRes, 'object', 'Multi-roll must return an object dictionary');
    for (const p of players) {
      const val = multiRes[p.playerId];
      assert.ok(Number.isInteger(val) && val >= 1 && val <= 20, `Multi d20 value invalid for ${p.playerId}: ${val}`);
    }
  });

  // --------------------------------------------------------------------------
  // TC-DICE-16: Full Upkeep & Roll-Off Regression Invariant Integrity (INV-DICE-3D-1)
  // --------------------------------------------------------------------------
  await test('TC-DICE-16', 'Full Upkeep & Roll-Off Regression Invariant Integrity (INV-DICE-3D-1)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({
      container,
      autoConnect: false,
      myPlayerId: 'p1',
      playerIds: ['p1', 'p2']
    });
    await app.mount();

    // 1. Roll-Off Initiation & d20 roll
    app.startRollOff(['p1', 'p2']);
    assert.strictEqual(app.isRollOffActive, true, 'Roll-off must be active');
    await app.triggerDiceRoll('d20');

    // 2. Start match & Upkeep step 1 dice throw
    app.startMatch();
    assert.strictEqual(app.isRollOffActive, false, 'Roll-off completed');

    const upkeepRoll = await app.triggerDiceRoll('dice');
    assert.ok(upkeepRoll, 'Upkeep roll completed');
    assert.ok(app._lastRoll, 'Perk evaluated');

    // 3. DiceShaker interaction test
    diceShaker.start(100, 100, { isD20: false });
    diceShaker.update(120, 140);
    const shakeResult = diceShaker.release(150, 180);
    assert.ok(shakeResult.throwForce >= 3.2, 'Throw force calculated');

    app.destroy();
  });

  console.log('\n==================================================================');
  console.log(`  FEATURE 18 TEST RESULTS: ${totalPassed} passed, ${totalFailed} failed`);
  console.log('==================================================================\n');

  if (totalFailed > 0) {
    process.exit(1);
  }
}

// Direct execution guard
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTestSuite().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
}
