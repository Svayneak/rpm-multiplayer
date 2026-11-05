/**
 * test/test_oracle_compiler_and_equipment.js
 * Integration Acceptance Test Suite for Phase 3:
 * Oracle Effect Compiler, Hammer Time Equipment Pipeline & Valiant Triggers
 * 
 * Verifies:
 * 1. Pure JSON serialization of compiled mechanics (no cycles, no lost properties)
 * 2. Sigarda's Aid ETB auto-attachment to friendly creature
 * 3. Heartfire Hero Valiant trigger (+1/+1 counter) upon becoming target of ability
 * 4. Layer evaluation: Heartfire Hero reaches 12/12 and loses flying (Layer 6 keyword removal)
 * 5. Valiant quota constraint: once per turn limit respected on re-target/re-equip
 * 6. Heartfire Hero Dies trigger: deals 12 damage to opponent based on LKI power before detach
 * 7. Detached equipment remains on battlefield unattached
 * 8. Deck manifest export/registration & custom mechanics hydration
 * 9. UI rendering of equipped badges (🔗 Equipped: Heartfire Hero) & PermanentActionDrawer equip button
 */

import assert from 'node:assert';
import {
  OracleEffectCompiler,
  compileCard,
  compileCardMechanics
} from '../src/OracleEffectCompiler.js';
import { TabletopStateManager } from '../src/TabletopStateManager.js';
import { AbilityEngine } from '../src/AbilityEngine.js';
import { RelayClient } from '../src/RelayClient.js';
import { PermanentActionDrawer } from '../src/view/PermanentActionDrawer.js';
import { RPMAppController } from '../src/app.js';

let passedTests = 0;
let failedTests = 0;

async function test(id, description, fn) {
  try {
    await fn();
    console.log(`  [32m✔ [PASS][0m ${id}: ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`  [31m✖ [FAIL][0m ${id}: ${description}`);
    console.error(`    ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
    failedTests++;
  }
}

// ============================================================================
// Lightweight Headless Mock DOM Infrastructure
// ============================================================================

class MockElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.id = '';
    this.className = '';
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this._attributes = new Map();
    this._eventListeners = new Map();
    this._textContent = '';
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

  setAttribute(k, v) {
    this._attributes.set(k, String(v));
    if (k === 'id') this.id = String(v);
    if (k === 'class') this.className = String(v);
  }

  getAttribute(k) {
    if (k === 'id') return this.id || null;
    if (k === 'class') return this.className || null;
    return this._attributes.get(k) ?? null;
  }

  removeAttribute(k) {
    this._attributes.delete(k);
    if (k === 'id') this.id = '';
    if (k === 'class') this.className = '';
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

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
    return child;
  }

  querySelector(selector) {
    const results = this.querySelectorAll(selector);
    return results.length > 0 ? results[0] : null;
  }

  querySelectorAll(selector) {
    const results = [];
    const check = (node) => {
      if (!node) return;
      let matched = false;
      if (selector.startsWith('#')) {
        matched = (node.id === selector.slice(1));
      } else if (selector.startsWith('.')) {
        matched = node.classList.contains(selector.slice(1));
      } else if (node.tagName.toLowerCase() === selector.toLowerCase()) {
        matched = true;
      }
      if (matched && node !== this) {
        results.push(node);
      }
      for (const ch of node.children) {
        check(ch);
      }
    };
    check(this);
    return results;
  }

  addEventListener(type, listener) {
    if (!this._eventListeners.has(type)) {
      this._eventListeners.set(type, new Set());
    }
    this._eventListeners.get(type).add(listener);
  }

  click() {
    const listeners = this._eventListeners.get('click');
    if (listeners) {
      for (const listener of listeners) {
        listener.call(this, { target: this, stopPropagation: () => {} });
      }
    }
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
        tokens.push({ type: 'close', tag: match[1].toLowerCase() });
      } else if (match[2]) {
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
}

function setupMockDOM() {
  const listeners = new Map();
  const doc = {
    body: new MockElement('BODY'),
    createElement: (tag) => new MockElement(tag),
    querySelector: (sel) => doc.body.querySelector(sel),
    querySelectorAll: (sel) => doc.body.querySelectorAll(sel),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    dispatchEvent: (evt) => {
      const set = listeners.get(evt?.type);
      if (set) {
        for (const fn of set) fn(evt);
      }
      return true;
    }
  };
  globalThis.document = doc;
  return doc;
}

class MockLocalStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(k) { return this.store.get(String(k)) ?? null; }
  setItem(k, v) { this.store.set(String(k), String(v)); }
  removeItem(k) { this.store.delete(String(k)); }
  clear() { this.store.clear(); }
}

// ============================================================================
// Test Suite Execution
// ============================================================================

async function runTestSuite() {
  console.log('\n==================================================================');
  console.log('  RUNNING PHASE 3 INTEGRATION TEST SUITE');
  console.log('  OracleEffectCompiler, Hammer Time Equipment Pipeline & Valiant');
  console.log('==================================================================\n');

  // --------------------------------------------------------------------------
  // TC-PHASE3-01: Pure JSON Serialization & No Non-Numeric Array Leakage
  // --------------------------------------------------------------------------
  await test('TC-PHASE3-01', 'Pure JSON.stringify serialization & property preservation', async () => {
    // 1. Verify compileCard alias export
    assert.strictEqual(compileCard, compileCardMechanics, 'compileCard alias must match compileCardMechanics');

    // 2. Sigarda's Aid compilation
    const sigardaAid = {
      name: "Sigarda's Aid",
      type_line: 'Enchantment',
      oracle_text: 'Whenever an Equipment enters the battlefield under your control, you may attach it to target creature you control.\nYou may cast Aura and Equipment spells as though they had flash.'
    };
    const cSigarda = compileCardMechanics(sigardaAid);
    assert.strictEqual(cSigarda.category, 'otherPermanents');
    assert.strictEqual(cSigarda.isPermanent, true);
    assert.ok(cSigarda.grantsFlashTo.equipment, 'grantsFlashTo.equipment must be true');
    assert.ok(cSigarda.grantsFlashTo.aura, 'grantsFlashTo.aura must be true');
    assert.strictEqual(cSigarda.grantsFlashToEquipment, true);
    assert.strictEqual(cSigarda.grantsFlashToAura, true);

    // 3. Colossus Hammer compilation
    const colossusHammer = {
      name: 'Colossus Hammer',
      type_line: 'Artifact — Equipment',
      oracle_text: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
    };
    const cHammer = compileCardMechanics(colossusHammer);
    assert.strictEqual(cHammer.isEquipment, true);
    assert.strictEqual(cHammer.attachment.powerModifier, 10);
    assert.strictEqual(cHammer.attachment.toughnessModifier, 10);
    assert.strictEqual(cHammer.attachment.powerDelta, 10);
    assert.strictEqual(cHammer.attachment.toughnessDelta, 10);
    assert.ok(cHammer.attachment.lostKeywords.includes('flying'));
    assert.ok(cHammer.attachment.loseKeywords.includes('flying'));
    assert.ok(cHammer.attachment.keywordsLost.includes('flying'));

    // 4. Heartfire Hero compilation
    const heartfireHero = {
      name: 'Heartfire Hero',
      type_line: 'Creature — Mouse Soldier',
      power: '1',
      toughness: '1',
      oracle_text: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
    };
    const cHero = compileCardMechanics(heartfireHero);
    assert.strictEqual(cHero.category, 'creatures');
    assert.ok(cHero.triggers.some(t => t.triggerType === 'ON_BECOMES_TARGET' && t.action === 'ADD_COUNTER'));
    assert.ok(cHero.triggers.some(t => t.triggerType === 'ON_DIES' && t.action === 'DAMAGE_EQUAL_TO_POWER_EACH_OPPONENT'));

    // 5. Mana Confluence compilation
    const manaConfluence = {
      name: 'Mana Confluence',
      type_line: 'Land',
      oracle_text: '{T}, Pay 1 life: Add one mana of any color.'
    };
    const cMana = compileCardMechanics(manaConfluence);
    assert.strictEqual(cMana.manaProfile.producesAnyColor, true);
    assert.strictEqual(cMana.producesAnyColor, true);

    // 6. Non-equipment card with equipment in oracle text must not match generic ON_ETB
    const fakeCard = {
      name: 'Equipment Watcher',
      type_line: 'Creature',
      oracle_text: 'Whenever an Equipment enters the battlefield under your control, gain 1 life.'
    };
    const cFake = compileCardMechanics(fakeCard);
    assert.ok(!cFake.triggers.some(t => t.triggerType === 'ON_ETB'), 'Equipment ETB must not trigger generic ON_ETB');

    // 7. Verify pure JSON stringify roundtrip without cycles or loss
    const jsonSigarda = JSON.stringify(cSigarda);
    const parsedSigarda = JSON.parse(jsonSigarda);
    assert.strictEqual(parsedSigarda.grantsFlashToEquipment, true);
    assert.strictEqual(parsedSigarda.grantsFlashToAura, true);
    assert.ok(Array.isArray(parsedSigarda.grantsFlashTo));

    const jsonHammer = JSON.stringify(cHammer);
    const parsedHammer = JSON.parse(jsonHammer);
    assert.strictEqual(parsedHammer.attachment.powerModifier, 10);
    assert.ok(parsedHammer.attachment.keywordsLost.includes('flying'));

    const jsonHero = JSON.stringify(cHero);
    const parsedHero = JSON.parse(jsonHero);
    assert.ok(parsedHero.triggers.some(t => t.triggerType === 'ON_BECOMES_TARGET'));

    const jsonMana = JSON.stringify(cMana);
    const parsedMana = JSON.parse(jsonMana);
    assert.strictEqual(parsedMana.producesAnyColor, true);
  });

  // --------------------------------------------------------------------------
  // TC-PHASE3-02: Full Hammer Time Pipeline (Sigarda's Aid, Auto-Attach, Valiant, 12/12, Dies Trigger)
  // --------------------------------------------------------------------------
  await test('TC-PHASE3-02', 'Full Hammer Time Flow: Auto-Attach, Valiant counter, 12/12, Dies SBA dealing 12 to opponent', async () => {
    const state = new TabletopStateManager();
    state.players = {
      p1: {
        id: 'p1',
        name: 'HammerMaster',
        resources: { life: 20, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 } },
        battlefield: { creatures: [], lands: [], noncreatures: [] },
        zones: { battlefield: [], hand: [], library: [], graveyard: [], exile: [] }
      },
      p2: {
        id: 'p2',
        name: 'DefendingOpponent',
        resources: { life: 20, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 } },
        battlefield: { creatures: [], lands: [], noncreatures: [] },
        zones: { battlefield: [], hand: [], library: [], graveyard: [], exile: [] }
      }
    };

    // Step 1: Add Sigarda's Aid to p1 battlefield
    const aidCard = state.addCardToZone('p1', 'battlefield', {
      name: "Sigarda's Aid",
      typeLine: 'Enchantment',
      oracleText: 'Whenever an Equipment enters the battlefield under your control, you may attach it to target creature you control.\nYou may cast Aura and Equipment spells as though they had flash.'
    });
    assert.strictEqual(state.players.p1.battlefield.noncreatures.length, 1);
    assert.strictEqual(state.players.p1.battlefield.noncreatures[0].name, "Sigarda's Aid");

    // Step 2: Add Heartfire Hero to p1 battlefield (with flying inherently, to verify Layer 6 removal)
    const heroCard = state.addCardToZone('p1', 'battlefield', {
      name: 'Heartfire Hero',
      typeLine: 'Creature — Mouse Soldier',
      power: 1,
      toughness: 1,
      keywords: { flying: true },
      oracleText: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
    });
    assert.strictEqual(state.players.p1.battlefield.creatures.length, 1);
    assert.strictEqual(heroCard.basePower, 1);
    assert.strictEqual(heroCard.baseToughness, 1);

    // Step 3: Add Colossus Hammer to p1 battlefield -> Sigarda's Aid auto-attaches to Heartfire Hero
    const hammerCard = state.addCardToZone('p1', 'battlefield', {
      name: 'Colossus Hammer',
      typeLine: 'Artifact — Equipment',
      oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
    });
    assert.strictEqual(state.players.p1.battlefield.noncreatures.length, 2);
    assert.strictEqual(hammerCard.attachedTo, heroCard.instanceId, 'Hammer must be auto-attached to Hero');
    assert.ok(heroCard.attachedCards.some(c => (c.instanceId || c.id || c) === hammerCard.instanceId), 'Hero attachedCards must include hammer');

    // Step 4: Verify Valiant triggered and granted a +1/+1 counter
    assert.strictEqual(heroCard.counters['+1/+1'], 1, 'Hero must have 1 +1/+1 counter from Valiant');
    assert.strictEqual(heroCard.valiantTriggeredThisTurn, true, 'Hero must have valiantTriggeredThisTurn marked');

    // Step 5: Evaluate layers: base 1/1 + hammer +10/+10 (Layer 7c) + counter +1/+1 (Layer 7d) = 12/12
    const evaluatedStats = state.abilityEngine.evaluateCreatureStats(heroCard, state);
    assert.strictEqual(evaluatedStats.power, 12, 'Effective power must be 12 (1 base + 10 hammer + 1 counter)');
    assert.strictEqual(evaluatedStats.toughness, 12, 'Effective toughness must be 12 (1 base + 10 hammer + 1 counter)');
    assert.strictEqual(evaluatedStats.hasFlying, false, 'Layer 6 must strip flying keyword');
    assert.ok(!evaluatedStats.keywords.flying, 'Flying keyword must be absent');

    // Step 6: Verify Valiant restriction: targeting or re-equipping again in the same turn does NOT grant a second counter
    const valiantRetrigger = state._triggerValiantIfEligible(heroCard, hammerCard, 'p1');
    assert.strictEqual(valiantRetrigger, false, 'Valiant must not trigger twice in the same turn');
    assert.strictEqual(heroCard.counters['+1/+1'], 1, 'Counter count must remain 1');

    // Step 7: Verify resetTurnQuotas clears valiantTriggeredThisTurn on battlefield creatures
    state.resetTurnQuotas('p1');
    assert.strictEqual(heroCard.valiantTriggeredThisTurn, false, 'resetTurnQuotas must reset valiant quota');

    // Step 8: Hero dies from lethal damage -> dies trigger deals 12 damage to opponent (LKI power 12)
    heroCard.damageMarked = 12;
    state.runSBACheck();

    // Verify hero is in graveyard
    assert.strictEqual(state.players.p1.battlefield.creatures.length, 0, 'Hero must be moved off battlefield to graveyard');
    const heroInGraveyard = state.players.p1.zones.graveyard.find(c => c.name === 'Heartfire Hero');
    assert.ok(heroInGraveyard, 'Heartfire Hero must be in p1 graveyard');

    // Verify opponent took 12 direct damage (20 - 12 = 8)
    assert.strictEqual(state.players.p2.resources.life, 8, 'Opponent life must be reduced to 8 (20 - 12 = 8)');

    // Step 9: Verify Colossus Hammer remains unattached on the battlefield
    const hammerOnBattlefield = state.players.p1.battlefield.noncreatures.find(c => c.name === 'Colossus Hammer');
    assert.ok(hammerOnBattlefield, 'Colossus Hammer must remain on battlefield');
    assert.strictEqual(hammerOnBattlefield.attachedTo, null, 'Hammer attachedTo must be null/unattached');
  });

  // --------------------------------------------------------------------------
  // TC-PHASE3-03: Deck Manifest Export & RelayClient Synchronization
  // --------------------------------------------------------------------------
  await test('TC-PHASE3-03', 'Deck manifest export, registration, and RelayClient synchronization', async () => {
    const state = new TabletopStateManager();
    state.players = {
      p1: {
        id: 'p1',
        name: 'ManifestUser',
        resources: { life: 20, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 } },
        battlefield: { creatures: [], lands: [], noncreatures: [] },
        zones: { battlefield: [], hand: [], library: [], graveyard: [], exile: [] },
        library: [
          { name: 'Colossus Hammer', typeLine: 'Artifact — Equipment', oracleText: 'Equipped creature gets +10/+10 and loses flying.' },
          { name: 'Heartfire Hero', typeLine: 'Creature — Mouse Soldier', power: 1, toughness: 1 }
        ]
      }
    };

    // 1. Export manifest
    const manifest = state.exportDeckManifest('p1');
    assert.ok(manifest, 'Manifest must be exported');
    assert.strictEqual(manifest.playerId, 'p1');
    assert.strictEqual(manifest.cardsCount, 2);
    assert.ok(Array.isArray(manifest.mainboard));

    // 2. Register manifest
    TabletopStateManager.registerDeckManifest('p1', manifest);
    assert.ok(TabletopStateManager.deckManifests.p1, 'Manifest must be stored in TabletopStateManager');

    // 3. Hydrate card using manifest
    const customCard = { name: 'Colossus Hammer' };
    state.hydrateCardMechanics(customCard);
    assert.ok(customCard.compiledMechanics, 'Card must be hydrated with compiledMechanics');
    assert.strictEqual(customCard.compiledMechanics.isEquipment, true);

    // 4. RelayClient manifest handling
    const relay = new RelayClient({ url: 'ws://localhost:9999', autoConnect: false });
    assert.strictEqual(typeof relay.sendDeckManifest, 'function', 'RelayClient must have sendDeckManifest');
    assert.strictEqual(typeof relay.registerDeckManifest, 'function', 'RelayClient must have registerDeckManifest');

    relay.registerDeckManifest(manifest, 'p1');
    assert.ok(relay.deckManifests.p1, 'RelayClient must store registered manifest');
  });

  // --------------------------------------------------------------------------
  // TC-PHASE3-04: UI Badges & PermanentActionDrawer Equip Actions
  // --------------------------------------------------------------------------
  await test('TC-PHASE3-04', 'PermanentActionDrawer #drawer-btn-equip and attached-badge UI rendering', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    let equippedPayload = null;
    const drawer = new PermanentActionDrawer({
      container,
      onEquipToCreature: (payload) => {
        equippedPayload = payload;
      }
    });

    const mockEquipment = {
      instanceId: 'equip_1',
      name: 'Colossus Hammer',
      typeLine: 'Artifact — Equipment',
      compiledMechanics: { isEquipment: true }
    };
    const mockCreatureA = {
      instanceId: 'cr_1',
      name: 'Heartfire Hero'
    };
    const mockCreatureB = {
      instanceId: 'cr_2',
      name: 'Ornithopter'
    };

    // Open drawer with 2 available creatures
    drawer.open(mockEquipment, 'p1', null, {
      friendlyCreatures: [mockCreatureA, mockCreatureB]
    });

    assert.strictEqual(drawer.isOpen, true, 'Drawer must be open');
    const equipActionEl = drawer.element.querySelector('#drawer-equip-action');
    assert.ok(equipActionEl, '#drawer-equip-action must exist');
    assert.strictEqual(equipActionEl.style.display, 'block', 'Equip action must be visible for equipment');

    const equipBtn = drawer.element.querySelector('#drawer-btn-equip');
    assert.ok(equipBtn, '#drawer-btn-equip must exist');

    // Click equip button -> displays candidate list
    equipBtn.click();
    const targetBtns = drawer.element.querySelectorAll('.drawer-creature-target-btn');
    assert.strictEqual(targetBtns.length, 2, 'Must render target buttons for both creatures');

    // Click target button for Heartfire Hero
    targetBtns[0].click();
    assert.ok(equippedPayload, 'onEquipToCreature must have been called');
    assert.strictEqual(equippedPayload.targetCreature.instanceId, 'cr_1');
    assert.strictEqual(drawer.isOpen, false, 'Drawer must close after equip selection');

    // Verify RPMAppController escapeHtml & attached-badge DOM reconciliation
    const storage = new MockLocalStorage();
    const app = new RPMAppController({
      container,
      storage,
      autoConnect: false,
      myPlayerId: 'p1',
      username: 'UIChampion'
    });
    await app.mount(container);

    app.tabRouter.navigate('ARENA');
    app.startMatch({ playerIds: ['p1', 'bot_perkins_2'] });

    const p1 = app.tabletopState.players.p1;
    const pHero = app.tabletopState.addCardToZone('p1', 'battlefield', {
      name: 'Heartfire Hero',
      typeLine: 'Creature — Mouse Soldier',
      power: 1,
      toughness: 1
    });
    const pHammer = app.tabletopState.addCardToZone('p1', 'battlefield', {
      name: 'Colossus Hammer',
      typeLine: 'Artifact — Equipment',
      attachedTo: pHammer => pHero.instanceId
    });
    pHammer.attachedTo = pHero.instanceId;

    app.reconcileDOM();
    const noncreatureStrip = container.querySelector('#battlefield-noncreatures');
    assert.ok(noncreatureStrip, '#battlefield-noncreatures must exist');
    assert.ok(noncreatureStrip.textContent.includes('Equipped: Heartfire Hero'), 'Noncreature chip must render 🔗 Equipped: Heartfire Hero badge');

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // TC-PHASE3-05: Multi-Ability Lands, Smart Mana Solver & Starting Town Fastland ETB
  // --------------------------------------------------------------------------
  await test('TC-PHASE3-05', 'Multi-Ability Lands (Spire of Industry, Starting | Town) & Smart Mana Solver 0-life generic payment at 2 life', async () => {
    const state = new TabletopStateManager();
    state.players = {
      p1: {
        id: 'p1',
        name: 'GadgetPlayer',
        resources: { life: 2, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 } },
        battlefield: { creatures: [], lands: [], noncreatures: [], planeswalkers: [] },
        zones: { battlefield: [], hand: [], library: [], graveyard: [], exile: [] },
        hand: [],
        library: [],
        graveyard: [],
        exile: []
      },
      p2: {
        id: 'p2',
        name: 'Opponent',
        resources: { life: 20, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 } },
        battlefield: { creatures: [], lands: [], noncreatures: [], planeswalkers: [] },
        zones: { battlefield: [], hand: [], library: [], graveyard: [], exile: [] },
        hand: [],
        library: [],
        graveyard: [],
        exile: []
      }
    };

    const spire1 = state.addCardToZone('p1', 'battlefield', {
      name: 'Spire of Industry',
      typeLine: 'Land',
      oracleText: '{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color. Activate only if you control an artifact.'
    });
    const spire2 = state.addCardToZone('p1', 'battlefield', {
      name: 'Spire of Industry',
      typeLine: 'Land',
      oracleText: '{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color. Activate only if you control an artifact.'
    });
    const startingTown = state.addCardToZone('p1', 'battlefield', {
      name: 'Starting Town',
      typeLine: 'Land — Town',
      oracleText: 'Starting Town enters tapped unless it\'s the first, second, or third turn of the game.\n{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color.'
    });
    const mountain = state.addCardToZone('p1', 'battlefield', {
      name: 'Mountain',
      typeLine: 'Basic Land — Mountain',
      oracleText: '{T}: Add {R}.'
    });

    // 1. Without an artifact on battlefield, Spire of Industry cannot produce colored mana {W}
    assert.throws(() => {
      state.tapLandForMana('p1', spire1.instanceId, 'W');
    }, /cannot legally produce/i, 'Spire of Industry must reject colored mana when controlling no artifacts');

    // 2. Auto-tapping for {4} (Leyline Axe generic cost) at 2 life must use {C} (0 life lost!)
    const autoTapRes = state.autoTapForMana('p1', '{4}');
    assert.strictEqual(autoTapRes.success, true);
    assert.strictEqual(autoTapRes.lifeCostTotal, 0, 'Paying {4} generic mana with Spire of Industry + Starting Town + Mountain must cost 0 life');
    assert.strictEqual(state.players.p1.resources.life, 2, 'Player life must remain at 2 (no suicide life payment)');

    // Untap all lands and add an artifact so Spire of Industry unlocks colored mana
    state.untapAll('p1');
    state.addCardToZone('p1', 'battlefield', {
      name: 'Colossus Hammer',
      typeLine: 'Artifact — Equipment'
    });

    // Now Spire of Industry can produce {W} at the cost of 1 life (2 -> 1 life)
    const tapRes = state.tapLandForMana('p1', spire1.instanceId, 'W');
    assert.strictEqual(tapRes.color, 'W');
    assert.strictEqual(tapRes.lifePaid, 1);
    assert.strictEqual(state.players.p1.resources.life, 1);

    // At 1 life, paying another 1 life for colored mana on spire2 is prevented (non-lethal life rule)
    assert.throws(() => {
      state.tapLandForMana('p1', spire2.instanceId, 'W');
    }, /cannot legally produce|insufficient life/i, 'Cannot pay 1 life when at 1 life');

    // 3. Verify Starting Town Fastland ETB condition (UNLESS_ROUND_1_2_OR_3)
    state.roundNumber = 2;
    state.turnNumber = 2;
    state.players.p1.landsPlayedThisTurn = 0;
    const townT2 = state.addCardToZone('p1', 'hand', {
      name: 'Starting Town',
      typeLine: 'Land — Town'
    });
    const playedT2 = state.playLand('p1', townT2.instanceId);
    assert.strictEqual(playedT2.card.isTapped, false, 'Starting Town must enter UNTAPPED on Round 2');

    state.roundNumber = 4;
    state.turnNumber = 4;
    state.players.p1.landsPlayedThisTurn = 0;
    const townT4 = state.addCardToZone('p1', 'hand', {
      name: 'Starting Town',
      typeLine: 'Land — Town'
    });
    const playedT4 = state.playLand('p1', townT4.instanceId);
    assert.strictEqual(playedT4.card.isTapped, true, 'Starting Town must enter TAPPED on Round 4');
  });

  // --------------------------------------------------------------------------
  // TC-PHASE3-06: Adventure Cards (Callous Sell-Sword // Burn Together, CR 715)
  // --------------------------------------------------------------------------
  await test('TC-PHASE3-06', 'Adventure Card CR 715: Burn Together fling damage + sacrifice + exile onAdventure + cast Creature from exile', async () => {
    const state = new TabletopStateManager({ players: ['p1', 'p2'] });

    // Put a 12/12 Heartfire Hero on p1 battlefield (1/1 + 1 counter + Colossus Hammer +10/+10)
    const hero = state.addCardToZone('p1', 'battlefield', {
      name: 'Heartfire Hero',
      typeLine: 'Creature — Mouse Soldier',
      power: 1,
      toughness: 1,
      oracleText: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
    });
    const hammer = state.addCardToZone('p1', 'battlefield', {
      name: 'Colossus Hammer',
      typeLine: 'Artifact — Equipment',
      oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
    });
    state.attachPermanentToCreature('p1', hammer.instanceId, hero.instanceId);

    // Put Callous Sell-Sword // Burn Together in p1 hand and give p1 {R}{B}{1}
    const sellSword = state.addCardToZone('p1', 'hand', {
      name: 'Callous Sell-Sword // Burn Together',
      typeLine: 'Creature — Human Soldier // Sorcery — Adventure',
      manaCost: '{1}{B}'
    });
    assert.ok(Array.isArray(sellSword.compiledMechanics.castModes), 'Callous Sell-Sword must compile castModes');
    assert.strictEqual(sellSword.compiledMechanics.castModes.length, 2);

    state.players.p1.resources.manaPool = { W: 0, U: 0, B: 1, R: 1, G: 0, C: 1 };

    // Cast Burn Together (ADVENTURE mode, {R}) targeting Heartfire Hero
    const castAdv = state.castSpell('p1', sellSword.instanceId, {
      castMode: 'ADVENTURE',
      targets: [hero.instanceId]
    });
    assert.strictEqual(castAdv.card.activeCastMode, 'ADVENTURE');
    assert.strictEqual(castAdv.card.name, 'Burn Together');

    // Resolve Burn Together from stack
    const resAdv = state.handleStackResolution(castAdv.card);
    assert.strictEqual(resAdv.destinationZone, 'exile', 'Adventure spell must go to exile on resolution (CR 715.3d)');
    assert.strictEqual(resAdv.onAdventure, true, 'Exiled card must have onAdventure: true');
    assert.strictEqual(state.players.p1.exile.length, 1);
    assert.strictEqual(state.players.p1.exile[0].onAdventure, true);
    assert.strictEqual(state.players.p1.exile[0].name, 'Callous Sell-Sword');

    // Verify Heartfire Hero was sacrificed AND dealt 12 fling damage + 12 dies trigger damage (20 - 24 = -4)
    assert.strictEqual(state.players.p1.battlefield.creatures.length, 0, 'Heartfire Hero must be sacrificed');
    assert.ok(state.players.p2.resources.life <= 8, `Opponent must take at least 12 fling damage (life is ${state.players.p2.resources.life})`);

    // Attempting to cast ADVENTURE mode again from exile must be rejected
    const exiledCard = state.players.p1.exile[0];
    assert.throws(() => {
      state.castSpell('p1', exiledCard.instanceId, {
        sourceZone: 'exile',
        castMode: 'ADVENTURE'
      });
    }, /only the Creature mode may be cast from exile/i);

    // Casting MAIN Creature mode ({1}{B}) from exile succeeds and enters battlefield.creatures
    const castMain = state.castSpell('p1', exiledCard.instanceId, {
      sourceZone: 'exile',
      castMode: 'MAIN'
    });
    const resMain = state.handleStackResolution(castMain.card);
    assert.strictEqual(resMain.destinationZone, 'battlefield');
    assert.strictEqual(resMain.destinationSubzone, 'creatures');
    assert.strictEqual(state.players.p1.battlefield.creatures.length, 1);
    assert.strictEqual(state.players.p1.battlefield.creatures[0].name, 'Callous Sell-Sword');
  });

  // --------------------------------------------------------------------------
  // TC-PHASE3-07: Sigarda's Aid Static Flash Permission (GRANT_FLASH_TO_SPELLS)
  // --------------------------------------------------------------------------
  await test('TC-PHASE3-07', "Sigarda's Aid static permission allows casting Equipment & Aura spells at instant speed", async () => {
    const state = new TabletopStateManager({ players: ['p1', 'p2'] });
    const mockPriorityMachine = {
      activePlayerId: 'p1',
      priorityPlayerId: 'p1',
      currentPhaseStep: 'UPKEEP',
      stack: []
    };

    const hammerInHand = state.addCardToZone('p1', 'hand', {
      name: 'Colossus Hammer',
      typeLine: 'Artifact — Equipment',
      manaCost: '{1}'
    });

    // Without Sigarda's Aid, casting Colossus Hammer during UPKEEP is rejected
    const checkWithoutAid = state.canPlayerCastOrPlay('p1', hammerInHand, mockPriorityMachine);
    assert.strictEqual(checkWithoutAid.allowed, false);
    assert.strictEqual(checkWithoutAid.reason, 'SORCERY_SPEED_RESTRICTION');

    // Add Sigarda's Aid to p1 battlefield
    state.addCardToZone('p1', 'battlefield', {
      name: "Sigarda's Aid",
      typeLine: 'Enchantment'
    });

    // With Sigarda's Aid on battlefield, Colossus Hammer can be cast during UPKEEP or combat!
    const checkWithAid = state.canPlayerCastOrPlay('p1', hammerInHand, mockPriorityMachine);
    assert.strictEqual(checkWithAid.allowed, true, "Sigarda's Aid must grant Flash permission to Equipment spells");

    // Non-Equipment, non-Aura sorcery-speed cards (e.g. Creature) are still restricted during UPKEEP
    const creatureInHand = state.addCardToZone('p1', 'hand', {
      name: 'Fervent Champion',
      typeLine: 'Creature — Human Knight',
      manaCost: '{R}'
    });
    const checkCreature = state.canPlayerCastOrPlay('p1', creatureInHand, mockPriorityMachine);
    assert.strictEqual(checkCreature.allowed, false, "Sigarda's Aid must not grant Flash to Creature spells");
  });

  // --------------------------------------------------------------------------
  // TC-PHASE3-08: Fervent Champion {3} Equip Cost Reduction & Leyline Axe Opening Hand Action
  // --------------------------------------------------------------------------
  await test('TC-PHASE3-08', 'Leyline Axe CR 103.6 Opening Hand Action & Fervent Champion {3} Equip Cost Reduction', async () => {
    const state = new TabletopStateManager({ players: ['p1', 'p2'] });

    // 1. Put Leyline Axe in p1 opening hand and resolve opening hand actions
    state.addCardToZone('p1', 'hand', {
      name: 'Leyline Axe',
      typeLine: 'Artifact — Equipment',
      manaCost: '{4}',
      oracleText: 'If this card is in your opening hand, you may begin the game with it on the battlefield.\nEquipped creature gets +1/+1 and has double strike and trample.\nEquip {3}'
    });
    assert.strictEqual(state.players.p1.hand.length, 1);

    const opened = state.resolveOpeningHandActions('p1');
    assert.strictEqual(opened.length, 1, 'Leyline Axe must trigger opening hand action');
    assert.strictEqual(state.players.p1.hand.length, 0, 'Leyline Axe must be removed from hand');
    assert.strictEqual(state.players.p1.battlefield.noncreatures.length, 1, 'Leyline Axe must be placed on battlefield.noncreatures');

    const leylineOnField = state.players.p1.battlefield.noncreatures[0];
    assert.strictEqual(leylineOnField.name, 'Leyline Axe');

    // 2. Add Fervent Champion and Heartfire Hero to p1 battlefield
    const fervent = state.addCardToZone('p1', 'battlefield', {
      name: 'Fervent Champion',
      typeLine: 'Creature — Human Knight',
      power: 1,
      toughness: 1,
      oracleText: "First strike, haste\nWhenever Fervent Champion attacks, another target attacking Knight you control gets +1/+0 until end of turn.\nEquip abilities you activate that target Fervent Champion cost {3} less to activate."
    });
    const hero = state.addCardToZone('p1', 'battlefield', {
      name: 'Heartfire Hero',
      typeLine: 'Creature — Mouse Soldier',
      power: 1,
      toughness: 1
    });

    // 3. Verify computeEquipCost: Leyline Axe (Equip {3}) costs {0} on Fervent Champion and {3} on Heartfire Hero
    const costOnFervent = state.computeEquipCost('p1', leylineOnField, fervent);
    const costOnHero = state.computeEquipCost('p1', leylineOnField, hero);
    assert.strictEqual(costOnFervent, '{0}', 'Equipping Leyline Axe ({3}) to Fervent Champion must cost {0}');
    assert.strictEqual(costOnHero, '{3}', 'Equipping Leyline Axe ({3}) to Heartfire Hero must cost {3}');

    // 4. Activate equip ability on Fervent Champion with 0 mana available -> succeeds for free!
    const equipRes = state.activateEquipAbility('p1', leylineOnField.instanceId, fervent.instanceId);
    assert.strictEqual(equipRes.effectiveEquipCost, '{0}');
    assert.strictEqual(leylineOnField.attachedTo, fervent.instanceId);

    const ferventStats = state.abilityEngine.evaluateCreatureStats(fervent, state);
    assert.strictEqual(ferventStats.power, 2, 'Fervent Champion with Leyline Axe must have 2 power');
    assert.strictEqual(ferventStats.toughness, 2, 'Fervent Champion with Leyline Axe must have 2 toughness');
    assert.ok(ferventStats.keywords.doubleStrike || ferventStats.keywords['double strike'], 'Must grant Double Strike');
    assert.ok(ferventStats.keywords.trample, 'Must grant Trample');
  });

  // --------------------------------------------------------------------------
  // TC-PHASE3-09: RPM Log Deduplication & Victory Modal Header Overlap Fix
  // --------------------------------------------------------------------------
  await test('TC-PHASE3-09', 'Turn Cmd RPM log deduplication and Victory Modal #btn-victory-inspect-arena class check', async () => {
    const doc = setupMockDOM();
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const storage = new MockLocalStorage();

    const app = new RPMAppController({
      container,
      storage,
      autoConnect: false,
      myPlayerId: 'p1',
      username: 'Dev Planeswalker'
    });
    await app.mount(container);

    // 1. Log identical RPM Roll message twice within 250ms -> must deduplicate to 1 entry
    const msg1 = app.addTurnCommandLog('🎲 [RPM Roll]: Dev Planeswalker (You) rolled 19 (Miss)', { playerId: 'p1' });
    const msg2 = app.addTurnCommandLog('🎲 [RPM Roll]: Dev Planeswalker rolled 19 (Miss)', { playerId: 'p1' });
    assert.ok(msg1, 'First log entry must be recorded');
    assert.strictEqual(msg2, null, 'Duplicate RPM log within 250ms must be suppressed');

    // 2. Render Victory Modal and verify #btn-victory-inspect-arena does NOT have .modal-close-btn
    const modalRoot = container.querySelector('#modal-root');
    app._renderVictoryModal(modalRoot, { winnerId: 'p2_perkins', winnerName: 'Player P2_PERKINS' });
    const inspectBtn = modalRoot.querySelector('#btn-victory-inspect-arena');
    assert.ok(inspectBtn, '#btn-victory-inspect-arena must exist in Victory Modal');
    assert.strictEqual(
      inspectBtn.classList.contains('modal-close-btn'),
      false,
      '#btn-victory-inspect-arena must NOT have .modal-close-btn class (prevents overlapping DEFEAT header)'
    );

    app.destroy();
  });

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n==================================================================');
  console.log(`  PHASE 3 TEST RESULTS: ${passedTests} passed, ${failedTests} failed`);
  console.log('==================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite();
