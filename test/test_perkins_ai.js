/**
 * test/test_perkins_ai.js
 * Comprehensive Acceptance Test Suite for Feature 13: Perkins AI Opponent & Companion Coach
 * Document ID: SPEC-RPM-PERKINS-013
 * 
 * Verifies all 12 Acceptance Test Vectors:
 * - TC-PERKINS-01: Agent Instantiation & Hermetic Lifecycle (INV-HARNESS-1, INV-SAFE-3)
 * - TC-PERKINS-02: Forge-Style Sub-Millisecond Decision Benchmark (INV-PERKINS-1)
 * - TC-PERKINS-03: Dual-Mode Transport Operation ('LOCAL_BOT' & RelayClient) (INV-PERKINS-2)
 * - TC-PERKINS-04: Strict Zero-Knowledge Fog-of-War Compliance (INV-PERKINS-3, INV-FOW-1)
 * - TC-PERKINS-05: 15-Second Stack Alarm Instant Response & Auto-Pass (INV-PERKINS-4)
 * - TC-PERKINS-06: Perk #55 Upkeep Targeting Hierarchy (INV-PERKINS-5)
 * - TC-PERKINS-07: Perk #99 High-Threat Opponent Targeting (INV-PERKINS-5)
 * - TC-PERKINS-08: Combat Attack Declaration & Power/Toughness Heuristics (INV-PERKINS-6)
 * - TC-PERKINS-09: Combat Block Declaration & Lethal Chump Block Defense (INV-PERKINS-6)
 * - TC-PERKINS-10: Bilingual Tutorial Coach & 8s Debounce Gate (INV-PERKINS-7)
 * - TC-PERKINS-11: Anti-Hang Phase Action Throttling Guard (INV-SAFE-1)
 * - TC-PERKINS-12: Empty Library Concession / Deckout Guard (CR 104.3c) (INV-SAFE-2)
 */

import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import { RPMAppController } from '../src/app.js';
import { PerkinsAgent, PERKINS_COACH_DIALOGUES } from '../src/PerkinsAgent.js';
import { TabletopStateManager, projectState } from '../src/TabletopStateManager.js';
import { PriorityStateMachine } from '../src/PriorityStateMachine.js';
import { StackAlarmManager } from '../src/StackAlarmManager.js';
import { DualChannelChat } from '../src/DualChannelChat.js';
import { ActionLexer } from '../src/ActionLexer.js';

// ============================================================================
// Lightweight Mock DOM Environment for Node.js
// ============================================================================

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

class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.id = '';
    this.className = '';
    this.attributes = {};
    this.children = [];
    this.parentNode = null;
    this._listeners = new Map();
    this._style = {};
  }

  get style() {
    return this._style;
  }

  get classList() {
    const self = this;
    return {
      add(...classes) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        classes.forEach(c => set.add(c));
        self.className = [...set].join(' ');
      },
      remove(...classes) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        classes.forEach(c => set.delete(c));
        self.className = [...set].join(' ');
      },
      contains(cls) {
        return self.className.split(/\s+/).includes(cls);
      },
      toggle(cls, force) {
        if (force !== undefined) {
          if (force) this.add(cls);
          else this.remove(cls);
          return force;
        }
        if (this.contains(cls)) {
          this.remove(cls);
          return false;
        } else {
          this.add(cls);
          return true;
        }
      }
    };
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) {
    if (name === 'id') return this.id;
    if (name === 'class') return this.className;
    return this.attributes[name] ?? null;
  }

  hasAttribute(name) {
    return name in this.attributes || (name === 'id' && !!this.id) || (name === 'class' && !!this.className);
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'id') this.id = '';
    if (name === 'class') this.className = '';
  }

  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      child.parentNode = null;
      this.children.splice(idx, 1);
    }
    return child;
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
    event.target = this;
    if (this._listeners.has(event.type)) {
      for (const listener of this._listeners.get(event.type)) {
        listener.call(this, event);
      }
    }
    return !event.defaultPrevented;
  }

  querySelector(selector) {
    return this._matchSelector(selector, this);
  }

  querySelectorAll(selector) {
    const matches = [];
    this._matchAllSelector(selector, this, matches);
    return matches;
  }

  _matchSelector(selector, current) {
    if (this._elementMatches(current, selector)) return current;
    for (const child of current.children) {
      const match = this._matchSelector(selector, child);
      if (match) return match;
    }
    return null;
  }

  _matchAllSelector(selector, current, results) {
    if (this._elementMatches(current, selector)) {
      results.push(current);
    }
    for (const child of current.children) {
      this._matchAllSelector(selector, child, results);
    }
  }

  _elementMatches(elem, selector) {
    if (!elem || !selector || typeof selector !== 'string') return false;
    let s = selector.trim();
    if (s.startsWith('#')) {
      return elem.id === s.slice(1);
    }
    if (s.startsWith('.')) {
      return elem.classList.contains(s.slice(1));
    }
    return elem.tagName.toLowerCase() === s.toLowerCase();
  }

  get textContent() {
    let text = this._text || '';
    for (const child of this.children) {
      text += child.textContent;
    }
    return text;
  }

  set textContent(val) {
    this._text = String(val);
    this.children = [];
  }

  get innerHTML() {
    return this._html || '';
  }

  set innerHTML(html) {
    this._html = String(html);
    this.children = [];
    // Extract simple IDs and classes from HTML string to simulate DOM hierarchy
    const idRegex = /id=["']([^"']+)["']/g;
    let match;
    while ((match = idRegex.exec(html)) !== null) {
      const child = new MockElement('div');
      child.id = match[1];
      this.appendChild(child);
    }
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
// Acceptance Test Suite (TC-PERKINS-01 through TC-PERKINS-12)
// ============================================================================

async function runTestSuite() {
  console.log('\n==================================================================');
  console.log('Running Acceptance Test Suite: Feature 13 Perkins AI Opponent & Coach');
  console.log('Document ID: SPEC-RPM-PERKINS-013');
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
  // TC-PERKINS-01: Agent Instantiation & Hermetic Lifecycle
  // --------------------------------------------------------------------------
  await test('TC-PERKINS-01: Agent Instantiation & Hermetic Lifecycle (INV-HARNESS-1, INV-SAFE-3)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    const agent = await app.startPerkinsMatch({ thinkingDelayMs: 0 });
    assert.strictEqual(agent.slotId, 'p2_perkins', 'Agent slot ID must be p2_perkins');
    assert.strictEqual(agent.mode, 'LOCAL', 'Agent mode must be LOCAL');
    assert.strictEqual(agent.isDestroyed, false, 'Agent should be active initially');

    // Simulate 3 pending timeouts
    const t1 = setTimeout(() => {}, 10000);
    const t2 = setTimeout(() => {}, 10000);
    const t3 = setTimeout(() => {}, 10000);
    agent._activeTimers.add(t1);
    agent._activeTimers.add(t2);
    agent._activeTimers.add(t3);

    assert.strictEqual(agent._activeTimers.size, 3, 'Should hold 3 active timers before teardown');

    // Clean teardown
    agent.destroy();
    app.destroy();

    assert.strictEqual(agent.isDestroyed, true, 'Agent must be marked destroyed');
    assert.strictEqual(agent._activeTimers.size, 0, 'Active timers set must be cleared');
    assert.strictEqual(agent._unsubscribers.length, 0, 'Unsubscribers array must be cleared');
    assert.strictEqual(app.perkinsAgent, null, 'App reference to bot must be cleared');
  });

  // --------------------------------------------------------------------------
  // TC-PERKINS-02: Forge-Style Sub-Millisecond Decision Benchmark
  // --------------------------------------------------------------------------
  await test('TC-PERKINS-02: Forge-Style Sub-Millisecond Decision Benchmark (INV-PERKINS-1)', async () => {
    const agent = new PerkinsAgent({ slotId: 'p2', thinkingDelayMs: 0 });

    // Mock rich tabletop state: 7 cards in hand, 10 permanents on battlefield
    const mockState = {
      activePlayerId: 'p2',
      turnNumber: 3,
      stack: [],
      players: {
        p1: {
          playerId: 'p1',
          resources: { life: 20 },
          battlefield: {
            lands: [{ instanceId: 'l1', isTapped: false, typeLine: 'Plains' }],
            creatures: [{ instanceId: 'c1', power: 2, toughness: 2, isTapped: false, typeLine: 'Creature' }],
            noncreatures: [],
            planeswalkers: []
          },
          hand: { count: 4, cards: [{ instanceId: 'hidden', isHidden: true }] }
        },
        p2: {
          playerId: 'p2',
          resources: { life: 20, manaPool: { W: 0, U: 0, B: 0, R: 2, G: 0, C: 0 } },
          battlefield: {
            lands: [
              { instanceId: 'm1', isTapped: false, typeLine: 'Mountain' },
              { instanceId: 'm2', isTapped: false, typeLine: 'Mountain' }
            ],
            creatures: [
              { instanceId: 'p2_c1', power: 3, toughness: 3, isTapped: false, isSummoningSick: false, typeLine: 'Creature' },
              { instanceId: 'p2_c2', power: 2, toughness: 2, isTapped: false, isSummoningSick: false, typeLine: 'Creature' }
            ],
            noncreatures: [],
            planeswalkers: []
          },
          hand: {
            cards: [
              { instanceId: 'h1', name: 'Mountain', typeLine: 'Land', cmc: 0 },
              { instanceId: 'h2', name: 'Goblin Guide', typeLine: 'Creature', cmc: 1, manaCost: '{R}' },
              { instanceId: 'h3', name: 'Lightning Bolt', typeLine: 'Instant', cmc: 1, manaCost: '{R}' },
              { instanceId: 'h4', name: 'Monastery Swiftspear', typeLine: 'Creature', cmc: 1, manaCost: '{R}' },
              { instanceId: 'h5', name: 'Eidolon of the Great Revel', typeLine: 'Creature', cmc: 2, manaCost: '{1}{R}' },
              { instanceId: 'h6', name: 'Searing Blaze', typeLine: 'Instant', cmc: 2, manaCost: '{R}{R}' },
              { instanceId: 'h7', name: 'Rift Bolt', typeLine: 'Sorcery', cmc: 3, manaCost: '{2}{R}' }
            ]
          }
        }
      }
    };

    const phases = ['PRECOMBAT_MAIN', 'COMBAT', 'POSTCOMBAT_MAIN'];
    const iterations = 100;

    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      const phase = phases[i % phases.length];
      const action = await agent.evaluateTurnPhase(phase, mockState);
      assert.ok(action, `Iteration ${i} must produce a valid action proposal`);
      assert.ok(typeof action.type === 'string', 'Action must have string type');
    }
    const t1 = performance.now();

    const meanDurationMs = (t1 - t0) / iterations;
    console.log(`    -> Heuristic Decision Benchmark: ${iterations} evaluations in ${(t1 - t0).toFixed(3)}ms (Avg: ${meanDurationMs.toFixed(4)}ms/eval)`);
    assert.ok(meanDurationMs < 1.0, `Mean evaluation duration must be <1.0ms, got ${meanDurationMs}ms`);

    agent.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PERKINS-03: Dual-Mode Transport Operation ('LOCAL_BOT' & RelayClient)
  // --------------------------------------------------------------------------
  await test('TC-PERKINS-03: Dual-Mode Transport Operation (\'LOCAL_BOT\' & RelayClient) (INV-PERKINS-2)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    let sentSocketFrames = 0;
    const mockSocket = {
      readyState: 1,
      send: () => { sentSocketFrames++; },
      close: () => {}
    };

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);
    app.relayClient.ws = mockSocket;

    let receivedActionOrigin = null;
    const origDispatch = app.dispatchAction.bind(app);
    app.dispatchAction = async (action, context) => {
      receivedActionOrigin = context?.origin;
      return origDispatch(action, context);
    };

    // 1. Local Mode Dispatch
    const localAgent = await app.startPerkinsMatch({ thinkingDelayMs: 0 });
    await localAgent.dispatchAction({ type: 'PASS_PRIORITY' });

    assert.strictEqual(receivedActionOrigin, 'LOCAL_BOT', 'Local bot action must bear LOCAL_BOT origin tag');
    assert.strictEqual(sentSocketFrames, 0, 'LOCAL_BOT action must NEVER be broadcast over WebSocket');

    // 2. Remote Mode Dispatch
    let relaySentActionCount = 0;
    const mockRelayClient = {
      sendAction: () => { relaySentActionCount++; },
      on: () => {},
      off: () => {}
    };

    const remoteAgent = new PerkinsAgent({ slotId: 'p3', mode: 'REMOTE' });
    remoteAgent.attachRelay(mockRelayClient);

    await remoteAgent.dispatchAction({ type: 'PASS_PRIORITY' });
    assert.strictEqual(relaySentActionCount, 1, 'Remote bot action must route strictly through RelayClient.sendAction');

    localAgent.destroy();
    remoteAgent.destroy();
    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PERKINS-04: Strict Zero-Knowledge Fog-of-War Compliance
  // --------------------------------------------------------------------------
  await test('TC-PERKINS-04: Strict Zero-Knowledge Fog-of-War Compliance (INV-PERKINS-3, INV-FOW-1)', async () => {
    const stateManager = new TabletopStateManager({ players: ['p1', 'p2_perkins'] });
    const p1 = stateManager.players.p1;
    const p2 = stateManager.players.p2_perkins;

    p1.hand = [
      { instanceId: 'card_bolt', name: 'Lightning Bolt', manaCost: '{R}', typeLine: 'Instant' },
      { instanceId: 'card_lotus', name: 'Black Lotus', manaCost: '{0}', typeLine: 'Artifact' }
    ];
    p2.hand = [
      { instanceId: 'card_mountain', name: 'Mountain', manaCost: '', typeLine: 'Land' }
    ];

    // Project state from Perkins' perspective
    const projected = projectState(stateManager, 'p2_perkins');
    const projectedP1Hand = projected.players.p1.hand.cards;

    assert.strictEqual(projectedP1Hand.length, 2, 'P1 hand count must be preserved');
    assert.ok(projectedP1Hand.every(c => c.instanceId === 'hidden' && c.isHidden === true), 'All opponent cards must be hidden');
    assert.strictEqual(projectedP1Hand[0].name, undefined, 'Hidden card name must not be disclosed');
    assert.strictEqual(projectedP1Hand[0].manaCost, undefined, 'Hidden card manaCost must not be disclosed');

    // Feed masked projected state to Perkins
    const agent = new PerkinsAgent({ slotId: 'p2_perkins', thinkingDelayMs: 0 });
    const action = await agent.evaluateTurnPhase('PRECOMBAT_MAIN', projected);

    assert.ok(action, 'Perkins must evaluate phase without error on masked state');
    assert.notStrictEqual(action.type, undefined);

    agent.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PERKINS-05: 15-Second Stack Alarm Instant Response & Auto-Pass
  // --------------------------------------------------------------------------
  await test('TC-PERKINS-05: 15-Second Stack Alarm Instant Response & Auto-Pass (INV-PERKINS-4)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    const agent = await app.startPerkinsMatch({ thinkingDelayMs: 0 });

    // Precondition A: Bot holds Counterspell and {U}{U} open
    const botPlayer = app.tabletopState.players[agent.slotId];
    botPlayer.hand = [
      { instanceId: 'c_counter', name: 'Counterspell', typeLine: 'Instant', manaCost: '{U}{U}', cmc: 2 }
    ];
    botPlayer.battlefield = {
      lands: [
        { instanceId: 'island_1', name: 'Island', isTapped: false, typeLine: 'Land' },
        { instanceId: 'island_2', name: 'Island', isTapped: false, typeLine: 'Land' }
      ],
      creatures: [],
      noncreatures: [],
      planeswalkers: []
    };

    // Human player casts Gilded Lotus
    app.priorityMachine.pushStack({
      id: 'spell_lotus',
      name: 'Gilded Lotus',
      sourcePlayerId: app.myPlayerId,
      controllerId: app.myPlayerId
    });

    let lastDispatchedAction = null;
    const origDispatch = app.dispatchAction.bind(app);
    app.dispatchAction = async (action, ctx) => {
      lastDispatchedAction = action;
      return origDispatch(action, ctx);
    };

    // Trigger stack alarm targeting Perkins
    await agent.onStackAlarm({ targetPlayerId: agent.slotId, stackItemId: 'spell_lotus' });

    assert.ok(lastDispatchedAction, 'Action must be dispatched in response to alarm');
    assert.strictEqual(lastDispatchedAction.type, 'CAST_SPELL', 'Bot must cast Counterspell');
    assert.strictEqual(lastDispatchedAction.card?.name, 'Counterspell', 'Dispatched card must be Counterspell');
    assert.strictEqual(lastDispatchedAction.targetId, 'spell_lotus', 'Counterspell must target Gilded Lotus');

    // Precondition B: Empty bot hand -> Auto-pass priority cleanly
    botPlayer.hand = [];
    lastDispatchedAction = null;

    await agent.onStackAlarm({ targetPlayerId: agent.slotId, stackItemId: 'spell_lotus' });

    assert.ok(lastDispatchedAction, 'Action must be dispatched when hand is empty');
    assert.strictEqual(lastDispatchedAction.type, 'PASS_PRIORITY', 'Bot must pass priority when unable to counter');

    agent.destroy();
    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PERKINS-06: Perk #55 Upkeep Targeting Hierarchy
  // --------------------------------------------------------------------------
  await test('TC-PERKINS-06: Perk #55 Upkeep Targeting Hierarchy (INV-PERKINS-5)', async () => {
    const agent = new PerkinsAgent({ slotId: 'p2_perkins' });

    const mockState = {
      players: {
        p1: {
          playerId: 'p1',
          isEliminated: false,
          battlefield: {
            lands: [{ instanceId: 'land_p1', name: 'Forest', typeLine: 'Land' }],
            creatures: [{ instanceId: 'bear_p1', name: 'Grizzly Bears', typeLine: 'Creature', power: 2, toughness: 2, cmc: 2 }],
            noncreatures: [],
            planeswalkers: [{ instanceId: 'jace_pw', name: 'Jace, the Mind Sculptor', typeLine: 'Planeswalker', cmc: 4 }]
          }
        },
        p2_perkins: {
          playerId: 'p2_perkins',
          isEliminated: false,
          battlefield: {
            lands: [
              { instanceId: 'land_bot1', name: 'Mountain', typeLine: 'Land' },
              { instanceId: 'land_bot2', name: 'Mountain', typeLine: 'Land' },
              { instanceId: 'land_bot3', name: 'Mountain', typeLine: 'Land' }
            ],
            creatures: [{ instanceId: 'dragon_bot', name: 'Shivan Dragon', typeLine: 'Creature', power: 5, toughness: 5, cmc: 6, ownerId: 'p2_perkins' }],
            noncreatures: [],
            planeswalkers: []
          }
        }
      }
    };

    const targets = agent.evaluatePerkTargets('55', mockState);

    assert.ok(Array.isArray(targets), 'Target evaluation must return array of target IDs');
    assert.strictEqual(targets.length, 1, 'Perk #55 must declare exactly 1 target');
    assert.strictEqual(targets[0], 'jace_pw', 'Planeswalker must take top targeting precedence');
    assert.notStrictEqual(targets[0], 'bear_p1', 'Bear must not be chosen over Planeswalker');
    assert.notStrictEqual(targets[0], 'land_p1', 'Land must not be chosen over Planeswalker');
    assert.notStrictEqual(targets[0], 'dragon_bot', 'Perkins must NEVER self-sabotage own Dragon');

    agent.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PERKINS-07: Perk #99 High-Threat Opponent Targeting
  // --------------------------------------------------------------------------
  await test('TC-PERKINS-07: Perk #99 High-Threat Opponent Targeting (INV-PERKINS-5)', async () => {
    const agent = new PerkinsAgent({ slotId: 'p2_perkins' });

    // 3-player pod: p1 Threat = 12*0.5 + 1*2 + 2 = 10; p3 Threat = 20*0.5 + 4*2 + 5 = 23
    const mockState = {
      players: {
        p1: {
          playerId: 'p1',
          isEliminated: false,
          resources: { life: 12 },
          battlefield: { creatures: [{ instanceId: 'c1' }] },
          hand: { count: 2 }
        },
        p2_perkins: {
          playerId: 'p2_perkins',
          isEliminated: false,
          resources: { life: 20 },
          battlefield: { creatures: [] },
          hand: { count: 4 }
        },
        p3: {
          playerId: 'p3',
          isEliminated: false,
          resources: { life: 20 },
          battlefield: { creatures: [{ instanceId: 'c2' }, { instanceId: 'c3' }, { instanceId: 'c4' }, { instanceId: 'c5' }] },
          hand: { count: 5 }
        }
      }
    };

    const targets = agent.evaluatePerkTargets('99', mockState);

    assert.ok(Array.isArray(targets), 'Target evaluation must return array');
    assert.strictEqual(targets.length, 1, 'Perk #99 declares 1 target opponent');
    assert.strictEqual(targets[0], 'p3', 'Perkins must target p3 (highest threat score: 23 vs 10)');
    assert.notStrictEqual(targets[0], 'p2_perkins', 'Perkins must NEVER target itself');

    agent.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PERKINS-08: Combat Attack Declaration & Power/Toughness Heuristics
  // --------------------------------------------------------------------------
  await test('TC-PERKINS-08: Combat Attack Declaration & Power/Toughness Heuristics (INV-PERKINS-6)', async () => {
    const agent = new PerkinsAgent({ slotId: 'p2' });

    const mockState = {
      activePlayerId: 'p2',
      players: {
        p1: {
          playerId: 'p1',
          isEliminated: false,
          battlefield: {
            creatures: [
              { instanceId: 'knight_p1', name: 'Knight', power: 2, toughness: 2, isTapped: false, cmc: 2 }
            ]
          }
        },
        p2: {
          playerId: 'p2',
          isEliminated: false,
          battlefield: {
            creatures: [
              { instanceId: 'beast_33', name: 'Beast', power: 3, toughness: 3, isTapped: false, isSummoningSick: false, cmc: 3 },
              { instanceId: 'goblin_11', name: 'Goblin', power: 1, toughness: 1, isTapped: false, isSummoningSick: false, cmc: 1 }
            ]
          }
        }
      }
    };

    const declaredAttackers = agent.evaluateCombatAttacks(mockState);

    assert.ok(Array.isArray(declaredAttackers), 'Attack evaluation must return array of IDs');
    assert.ok(declaredAttackers.includes('beast_33'), '3/3 Beast can safely attack into 2/2 (toughness > maxBlockerPower)');
    assert.ok(!declaredAttackers.includes('goblin_11'), '1/1 Goblin must be held back (would die to 2/2 blocker)');

    agent.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PERKINS-09: Combat Block Declaration & Lethal Chump Block Defense
  // --------------------------------------------------------------------------
  await test('TC-PERKINS-09: Combat Block Declaration & Lethal Chump Block Defense (INV-PERKINS-6)', async () => {
    const agent = new PerkinsAgent({ slotId: 'p2' });

    const mockState = {
      activePlayerId: 'p1',
      players: {
        p1: { playerId: 'p1', isEliminated: false },
        p2: {
          playerId: 'p2',
          isEliminated: false,
          resources: { life: 4 }, // 4 Life left
          battlefield: {
            creatures: [
              { instanceId: 'saproling_11', name: 'Saproling', power: 1, toughness: 1, isTapped: false, cmc: 1 }
            ]
          }
        }
      }
    };

    // Opponent attacks with lethal 6/6 Beast
    const incomingAttackers = [
      { instanceId: 'beast_66', name: 'Colossal Dreadmaw', power: 6, toughness: 6 }
    ];

    const blockAssignments = agent.evaluateCombatBlocks(mockState, incomingAttackers);

    assert.ok(Array.isArray(blockAssignments), 'Block evaluation must return array of assignments');
    assert.strictEqual(blockAssignments.length, 1, 'Mandatory chump block must be declared');
    assert.strictEqual(blockAssignments[0].blockerId, 'saproling_11');
    assert.strictEqual(blockAssignments[0].attackerId, 'beast_66');

    agent.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PERKINS-10: Bilingual Tutorial Coach & 8s Debounce Gate
  // --------------------------------------------------------------------------
  await test('TC-PERKINS-10: Bilingual Tutorial Coach & 8s Debounce Gate (INV-PERKINS-7)', async () => {
    const priorityMachine = new PriorityStateMachine({ players: ['p1', 'p2'] });
    const actionLexer = new ActionLexer();
    const dualChat = new DualChannelChat({ priorityMachine, lexer: actionLexer, myPlayerId: 'p1' });

    const mockApp = {
      myPlayerId: 'p1',
      dualChat,
      dispatchAction: async () => {}
    };

    const agent = new PerkinsAgent({ slotId: 'p2', language: 'es' });
    agent.app = mockApp;

    // 1. Initial Milestone in Spanish
    const emitted1 = agent.triggerMilestone('MS_WELCOME');
    assert.strictEqual(emitted1, true, 'First coach milestone must be emitted');

    const chitMessages = dualChat.chitChatFeed;
    assert.strictEqual(chitMessages.length, 1, 'Chit-Chat feed must contain 1 message');
    assert.ok(chitMessages[0].text.includes('Soy Perkins'), 'Spanish welcome text expected');
    assert.strictEqual(dualChat.turnCommandFeed.length, 0, 'Turn command channel must have 0 messages');

    // 2. Immediate second milestone attempt (<8000ms)
    const emitted2 = agent.triggerMilestone('MS_PRIORITY_HOTKEY');
    assert.strictEqual(emitted2, false, 'Debounce gate must suppress message within 8000ms');
    assert.strictEqual(chitMessages.length, 1, 'No new message should appear in chat feed');

    // 3. Advance clock by 8,001ms and switch to English
    agent._lastCoachTimestamp -= 8001;
    agent.language = 'en';

    const emitted3 = agent.triggerMilestone('MS_PRIORITY_HOTKEY');
    assert.strictEqual(emitted3, true, 'Milestone must succeed after 8000ms debounce interval');
    assert.strictEqual(chitMessages.length, 2, 'Chat feed must now contain 2 messages');
    assert.ok(chitMessages[1].text.includes('Spacebar or [P]'), 'English priority hotkey tip expected');
    assert.strictEqual(dualChat.turnCommandFeed.length, 0, 'Turn command channel must remain untouched');

    agent.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PERKINS-11: Anti-Hang Phase Action Throttling Guard
  // --------------------------------------------------------------------------
  await test('TC-PERKINS-11: Anti-Hang Phase Action Throttling Guard (INV-SAFE-1)', async () => {
    const agent = new PerkinsAgent({ slotId: 'p2', thinkingDelayMs: 0 });

    const mockState = {
      activePlayerId: 'p2',
      players: {
        p2: {
          playerId: 'p2',
          battlefield: { lands: [], creatures: [], noncreatures: [], planeswalkers: [] },
          hand: { cards: [] }
        }
      }
    };

    let passCount = 0;
    agent.dispatchAction = async (action) => {
      if (action.type === 'PASS_PRIORITY') passCount++;
    };

    // Invoke evaluateTurnPhase 11 times in same phase
    for (let i = 1; i <= 11; i++) {
      const action = await agent.evaluateTurnPhase('PRECOMBAT_MAIN', mockState);
      assert.strictEqual(action.type, 'PASS_PRIORITY');
    }

    assert.ok(agent._phaseActionCount >= 10, 'Action count must track actions in the phase');
    assert.strictEqual(passCount, 11, 'All iterations must produce clean pass priority without hanging');

    agent.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PERKINS-12: Empty Library Concession / Deckout Guard (CR 104.3c)
  // --------------------------------------------------------------------------
  await test('TC-PERKINS-12: Empty Library Concession / Deckout Guard (CR 104.3c) (INV-SAFE-2)', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const app = new RPMAppController({ autoConnect: false });
    await app.mount(container);

    const agent = await app.startPerkinsMatch({ thinkingDelayMs: 0 });

    // Set bot library count to 0
    const botPlayer = app.tabletopState.players[agent.slotId];
    botPlayer.library = [];
    botPlayer.zones.library = [];

    let dispatchedConcede = null;
    const origDispatch = app.dispatchAction.bind(app);
    app.dispatchAction = async (action, ctx) => {
      if (action.type === 'PLAYER_CONCEDED' || action.type === 'PLAYER_ELIMINATED') {
        dispatchedConcede = action;
      }
      return origDispatch(action, ctx);
    };

    // Invoke DRAW step
    const action = await agent.evaluateTurnPhase('DRAW');

    assert.ok(dispatchedConcede, 'Bot must dispatch concession action upon empty library draw');
    assert.strictEqual(dispatchedConcede.reason || dispatchedConcede.payload?.reason, 'DECKOUT_EMPTY_LIBRARY');
    assert.strictEqual(action.type, 'PLAYER_CONCEDED');

    // Verify player is marked eliminated in tabletopState
    assert.strictEqual(botPlayer.isEliminated, true, 'Bot must be marked eliminated');

    agent.destroy();
    app.destroy();
  });

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n==================================================================');
  console.log(`Summary: ${passed} passed, ${failed} failed.`);
  console.log('==================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite();
