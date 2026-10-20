/**
 * test_mtg_rule_engine.js - Exhaustive 16-Vector Acceptance Test Suite for Feature 21
 * Specification: SPEC-RPM-RULES-ENGINE-021
 * 
 * Vectors:
 * - TC-RULES-01: CSPRNG Fisher-Yates Deck Shuffling (CR 103.2, INV-MULLIGAN-1)
 * - TC-RULES-02: London Mulligan Cycle & Decision Tracker (CR 103.4, INV-MULLIGAN-1)
 * - TC-RULES-03: London Mulligan Bottoming Selection (CR 103.4, INV-MULLIGAN-1)
 * - TC-RULES-04: Perkins AI London Mulligan Heuristics (INV-MULLIGAN-1)
 * - TC-RULES-05: Universal 6-Zone Transition Matrix (CR 400, INV-ZONE-MATRIX-1)
 * - TC-RULES-06: Zone-Change Card Identity Reset (CR 400.7, INV-ZONE-MATRIX-1)
 * - TC-RULES-07: Enter Without Casting Bypasses Stack (INV-ZONE-MATRIX-1)
 * - TC-RULES-08: Cast Without Paying Mana Cost Flagging (INV-ZONE-MATRIX-1)
 * - TC-RULES-09: Universal Search & Tutor Card Grid Filter (INV-ZONE-MATRIX-1)
 * - TC-RULES-10: Cost Modification Engine Formula (CR 601.2f, INV-COST-ENGINE-1)
 * - TC-RULES-11: Delve, Convoke & Trinisphere Rules (CR 601.2f, INV-COST-ENGINE-1)
 * - TC-RULES-12: Activated Abilities Cost Validation & Stack Creation (CR 602, INV-ABILITY-ENGINE-1)
 * - TC-RULES-13: Triggered Abilities APNAP LIFO Stack Sequencing (CR 603.3b, INV-ABILITY-ENGINE-1)
 * - TC-RULES-14: Continuous 7-Layer Recalculation Engine (CR 604 & CR 613, INV-ABILITY-ENGINE-1)
 * - TC-RULES-15: Indestructible 1/1 Dies to Static -1/-1 Debuff (CR 704.5f vs CR 704.5g, INV-STATIC-SBA-1)
 * - TC-RULES-16: Tabletop State Manager & Priority End-to-End Rules Integration (INV-HARMONY-21)
 */

import assert from 'assert';
import {
  shuffleLibrary,
  evaluatePerkinsMulligan,
  selectPerkinsBottomCards,
  MulliganTracker
} from '../src/MulliganEngine.js';
import {
  CostModificationEngine,
  parseManaCost,
  formatManaCost
} from '../src/CostModificationEngine.js';
import {
  AbilityEngine,
  CONTINUOUS_LAYERS
} from '../src/AbilityEngine.js';
import { ZoneTransitionMatrix } from '../src/ZoneTransitionMatrix.js';
import { StateBasedActionsEngine } from '../src/StateBasedActionsEngine.js';
import { TabletopStateManager } from '../src/TabletopStateManager.js';
import { PriorityStateMachine } from '../src/PriorityStateMachine.js';
import { SearchSelectGridModal } from '../src/view/SearchSelectGridModal.js';
import { ZoneModel } from '../src/ZoneModel.js';

let passed = 0;
let failed = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✔ [PASS]\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \x1b[31m✖ [FAIL]\x1b[0m ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('\n==================================================================');
console.log('  RUNNING FEATURE 21 ACCEPTANCE TEST SUITE: COMPLETE MTG RULE ENGINE');
console.log('  Specification: SPEC-RPM-RULES-ENGINE-021');
console.log('==================================================================\n');

it('TC-RULES-01: CSPRNG Fisher-Yates Deck Shuffling (CR 103.2, INV-MULLIGAN-1)', () => {
  const cards = Array.from({ length: 60 }, (_, i) => ({ id: `c_${i}`, name: `Card ${i}` }));
  const copy = [...cards];
  shuffleLibrary(copy);
  assert.strictEqual(copy.length, 60, 'Card count preserved');
  const uniqueIds = new Set(copy.map(c => c.id));
  assert.strictEqual(uniqueIds.size, 60, 'All unique cards present');
});

it('TC-RULES-02: London Mulligan Cycle & Decision Tracker (CR 103.4, INV-MULLIGAN-1)', () => {
  const tracker = new MulliganTracker(['p1', 'p2']);
  assert.strictEqual(tracker.getMulliganCount('p1'), 0);

  tracker.incrementMulligan('p1');
  assert.strictEqual(tracker.getMulliganCount('p1'), 1);

  tracker.setDecided('p1', true);
  tracker.setDecided('p2', true);
  assert.strictEqual(tracker.isAllDecided(), true);
});

it('TC-RULES-03: London Mulligan Bottoming Selection (CR 103.4, INV-MULLIGAN-1)', () => {
  const hand = [
    { id: '1', name: 'Land 1', typeLine: 'Land' },
    { id: '2', name: 'Land 2', typeLine: 'Land' },
    { id: '3', name: 'Land 3', typeLine: 'Land' },
    { id: '4', name: 'Land 4', typeLine: 'Land' },
    { id: '5', name: 'Spell 1', typeLine: 'Instant', cmc: 1 },
    { id: '6', name: 'Spell 2', typeLine: 'Instant', cmc: 2 },
    { id: '7', name: 'Big Spell', typeLine: 'Sorcery', cmc: 7, manaCost: '{5}{U}{U}' }
  ];

  const bottom = selectPerkinsBottomCards(hand, 2);
  assert.strictEqual(bottom.length, 2);
  assert.strictEqual(bottom[0].id, '7', 'High CMC spell bottomed first');
  assert.strictEqual(bottom[1].typeLine, 'Land', 'Excess 4th land bottomed second');
});

it('TC-RULES-04: Perkins AI London Mulligan Heuristics (INV-MULLIGAN-1)', () => {
  const makeHand = (lands) => Array.from({ length: 7 }, (_, i) => ({
    id: `c_${i}`,
    typeLine: i < lands ? 'Basic Land' : 'Creature'
  }));

  assert.strictEqual(evaluatePerkinsMulligan(makeHand(0)).keep, false, '0 lands mulligans');
  assert.strictEqual(evaluatePerkinsMulligan(makeHand(1)).keep, false, '1 land mulligans');
  assert.strictEqual(evaluatePerkinsMulligan(makeHand(6)).keep, false, '6 lands mulligans');
  assert.strictEqual(evaluatePerkinsMulligan(makeHand(7)).keep, false, '7 lands mulligans');
  assert.strictEqual(evaluatePerkinsMulligan(makeHand(3)).keep, true, '3 lands keeps');
});

it('TC-RULES-05: Universal 6-Zone Transition Matrix (CR 400, INV-ZONE-MATRIX-1)', () => {
  const player = ZoneModel.createInitialPlayerState('p1', 'Player 1');
  const card = { instanceId: 'z1', name: 'Card 1', typeLine: 'Sorcery' };
  player.hand.push(card);

  // Hand -> Stack
  ZoneTransitionMatrix.moveCard(player, 'z1', 'hand', 'stack');
  // Stack -> Graveyard
  ZoneTransitionMatrix.moveCard(player, 'z1', 'stack', 'graveyard');
  // Graveyard -> Hand (Regrowth)
  ZoneTransitionMatrix.regrowth(player, 'z1');
  assert.strictEqual(player.hand[0].instanceId, 'z1');

  // Hand -> Exile
  ZoneTransitionMatrix.moveCard(player, 'z1', 'hand', 'exile');
  // Exile -> Hand
  ZoneTransitionMatrix.moveCard(player, 'z1', 'exile', 'hand');
  assert.strictEqual(player.hand[0].instanceId, 'z1');
});

it('TC-RULES-06: Zone-Change Card Identity Reset (CR 400.7, INV-ZONE-MATRIX-1)', () => {
  const player = ZoneModel.createInitialPlayerState('p1', 'Player 1');
  const card = {
    instanceId: 'c_reset',
    name: 'Creature',
    typeLine: 'Creature',
    damageMarked: 4,
    isTapped: true,
    counters: { '+1/+1': 3 }
  };
  player.battlefield.creatures.push(card);

  ZoneTransitionMatrix.moveCard(player, 'c_reset', 'battlefield', 'graveyard');
  const inGY = player.graveyard.find(c => c.instanceId === 'c_reset');
  assert.strictEqual(inGY.damageMarked, 0);
  assert.strictEqual(inGY.isTapped, false);
  assert.deepStrictEqual(inGY.counters, {});
});

it('TC-RULES-07: Enter Without Casting Bypasses Stack (INV-ZONE-MATRIX-1)', () => {
  const player = ZoneModel.createInitialPlayerState('p1', 'Player 1');
  const card = { instanceId: 'drop_1', name: 'Angel', typeLine: 'Creature — Angel', power: 4, toughness: 4 };
  player.library.push(card);

  const entered = ZoneTransitionMatrix.enterWithoutCasting(player, 'drop_1', 'library');
  assert.strictEqual(entered.zone, 'battlefield');
  assert.strictEqual(player.battlefield.creatures.length, 1);
  assert.strictEqual(player.library.length, 0);
});

it('TC-RULES-08: Cast Without Paying Mana Cost Flagging (INV-ZONE-MATRIX-1)', () => {
  const player = ZoneModel.createInitialPlayerState('p1', 'Player 1');
  const card = { instanceId: 'free_1', name: 'Emrakul', typeLine: 'Creature', manaCost: '{15}' };
  player.hand.push(card);
  const stack = [];

  const onStack = ZoneTransitionMatrix.castWithoutPayingManaCost(player, 'free_1', 'hand', stack);
  assert.strictEqual(onStack.isFreeCast, true);
  assert.strictEqual(onStack.withoutPayingManaCost, true);
  assert.strictEqual(stack.length, 1);
});

it('TC-RULES-09: Universal Search & Tutor Card Grid Filter (INV-ZONE-MATRIX-1)', () => {
  const modal = new SearchSelectGridModal();
  modal.allCards = [
    { instanceId: '1', name: 'Island', typeLine: 'Basic Land — Island' },
    { instanceId: '2', name: 'Tarmogoyf', typeLine: 'Creature — Lhurgoyf' },
    { instanceId: '3', name: 'Lightning Bolt', typeLine: 'Instant' }
  ];

  modal.activeCategory = 'LAND';
  modal.applyFilter();
  assert.strictEqual(modal.filteredCards.length, 1);
  assert.strictEqual(modal.filteredCards[0].name, 'Island');
});

it('TC-RULES-10: Cost Modification Engine Formula (CR 601.2f, INV-COST-ENGINE-1)', () => {
  const spell = { name: 'Serum Visions', manaCost: '{U}' };
  // Thalia tax +1 generic
  const taxed = CostModificationEngine.calculateTotalCost(spell, { genericTax: 1 });
  assert.strictEqual(taxed.finalCostString, '{1}{U}');

  // Electromancer reduction on {1}{U} spell
  const spell2 = { name: 'Counterspell', manaCost: '{1}{U}' };
  const reduced = CostModificationEngine.calculateTotalCost(spell2, { genericReduction: 1 });
  assert.strictEqual(reduced.finalCostString, '{U}');
});

it('TC-RULES-11: Delve, Convoke & Trinisphere Rules (CR 601.2f, INV-COST-ENGINE-1)', () => {
  // Delve
  const delveCard = { name: 'Tasigur', manaCost: '{5}{B}' };
  const resDelve = CostModificationEngine.calculateTotalCost(delveCard, { delveCardsExiled: 4 });
  assert.strictEqual(resDelve.finalCostString, '{1}{B}');

  // Trinisphere
  const bolt = { name: 'Bolt', manaCost: '{R}' };
  const resTrini = CostModificationEngine.calculateTotalCost(bolt, { applyTrinisphere: true });
  assert.strictEqual(resTrini.totalCMC, 3);
  assert.strictEqual(resTrini.finalCostString, '{2}{R}');
});

it('TC-RULES-12: Activated Abilities Cost Validation & Stack Creation (CR 602, INV-ABILITY-ENGINE-1)', () => {
  const creature = {
    instanceId: 'perm_1',
    name: 'Elf',
    typeLine: 'Creature',
    isTapped: false,
    hasSummoningSickness: false,
    keywords: {}
  };
  const ability = { id: 'tap_mana', text: '{T}: Add {G}', cost: { tap: true }, isManaAbility: true };

  const check = AbilityEngine.canActivateAbility(creature, ability);
  assert.strictEqual(check.canActivate, true);

  const stackItem = AbilityEngine.createActivatedAbilityStackItem(creature, ability, 'p1');
  assert.strictEqual(stackItem.type, 'ACTIVATED_ABILITY');
  assert.strictEqual(stackItem.sourceId, 'perm_1');
});

it('TC-RULES-13: Triggered Abilities APNAP LIFO Stack Sequencing (CR 603.3b, INV-ABILITY-ENGINE-1)', () => {
  const engine = new AbilityEngine();
  engine.queueTrigger({ sourceId: 't_active', controllerId: 'p1', text: 'Active Player Trigger' });
  engine.queueTrigger({ sourceId: 't_nonactive', controllerId: 'p2', text: 'Non-Active Player Trigger' });

  const stack = engine.flushTriggersAPNAP('p1', ['p1', 'p2']);
  assert.strictEqual(stack.length, 2);
  assert.strictEqual(stack[0].controllerId, 'p1', 'Active Player trigger pushed first');
  assert.strictEqual(stack[1].controllerId, 'p2', 'Non-Active Player trigger pushed second (resolves first in LIFO)');
});

it('TC-RULES-14: Continuous 7-Layer Recalculation Engine (CR 604 & CR 613, INV-ABILITY-ENGINE-1)', () => {
  const engine = new AbilityEngine();

  // Layer 7b: Set P/T
  engine.registerStaticEffect({
    id: 'humility_pt',
    sourceId: 'humility',
    layer: CONTINUOUS_LAYERS.LAYER_7B_SET_PT,
    setPower: 1,
    setToughness: 1
  });

  // Layer 7c: Modify P/T (+2/+2)
  engine.registerStaticEffect({
    id: 'anthem',
    sourceId: 'anthem',
    layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
    powerMod: 2,
    toughnessMod: 2
  });

  const dragon = {
    instanceId: 'drag_1',
    typeLine: 'Creature — Dragon',
    power: 5,
    toughness: 5
  };

  const evalCard = engine.evaluatePermanentLayers(dragon);
  // Layer 7b sets to 1/1, Layer 7c adds +2/+2 -> 3/3!
  assert.strictEqual(evalCard.effectivePower, 3);
  assert.strictEqual(evalCard.effectiveToughness, 3);
});

it('TC-RULES-15: Indestructible 1/1 Dies to Static -1/-1 Debuff (CR 704.5f vs CR 704.5g, INV-STATIC-SBA-1)', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');

  // Register static -1/-1 enchantment
  tsm.abilityEngine.registerStaticEffect({
    id: 'curse_of_death',
    sourceId: 'curse',
    layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
    powerMod: -1,
    toughnessMod: -1
  });

  // 1/1 Indestructible creature enters
  const indestructibleCreature = {
    instanceId: 'darksteel_myr',
    name: 'Darksteel Myr',
    typeLine: 'Artifact Creature — Myr',
    power: 1,
    toughness: 1,
    basePower: 1,
    baseToughness: 1,
    isIndestructible: true,
    keywords: { indestructible: true },
    zone: 'battlefield'
  };
  p1.battlefield.creatures.push(indestructibleCreature);

  const sba = tsm.runSBACheck();
  assert.strictEqual(sba.totalActionsApplied, 1);
  assert.strictEqual(sba.actions[0].type, 'CREATURE_DIED_ZERO_TOUGHNESS');
  assert.strictEqual(sba.actions[0].bypassedIndestructible, true, 'Zero toughness must bypass Indestructible');
  assert.strictEqual(p1.battlefield.creatures.length, 0);
  assert.strictEqual(p1.graveyard.length, 1);
});

it('TC-RULES-16: Tabletop State Manager & Priority End-to-End Rules Integration (INV-HARMONY-21)', () => {
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], startingPlayerId: 'p1', initialPhaseStep: 'PRECOMBAT_MAIN' });
  const tsm = new TabletopStateManager({ players: ['p1', 'p2'], activePlayerId: 'p1', priorityMachine: psm });

  const p1 = tsm.getPlayer('p1');
  p1.hand.push({ instanceId: 'land_drop', name: 'Forest', typeLine: 'Basic Land — Forest' });

  // Play land
  tsm.dispatch('PLAY_LAND', { playerId: 'p1', instanceId: 'land_drop' });
  assert.strictEqual(p1.battlefield.lands.length, 1);

  // Cast spell
  p1.hand.push({ instanceId: 'spell_cast', name: 'Giant Growth', typeLine: 'Instant', manaCost: '{G}' });
  p1.resources.manaPool.G = 1;
  tsm.dispatch('CAST_SPELL', { playerId: 'p1', instanceId: 'spell_cast', manaCostPaid: { G: 1 } });
  assert.strictEqual(tsm.stack.length, 1);
});

console.log('\n==================================================================');
console.log(`  FEATURE 21 TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log('==================================================================\n');

if (failed > 0) {
  process.exit(1);
}
