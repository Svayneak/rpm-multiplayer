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
 * - TC-RULES-17: Cleanup Step Damage Purge (CR 514.2)
 * - TC-RULES-18: Legend Rule SBA Enforcement (CR 704.5j)
 * - TC-RULES-19: CostModificationEngine Integration in TabletopStateManager (CR 601.2f)
 * - TC-RULES-20: Token Ceases to Exist Outside Battlefield (CR 704.5d)
 * - TC-RULES-21: Spell Resolution with Damage Effect and SBA Destruction (CR 608.2, CR 704.5g)
 * - TC-RULES-22: Spell Fizzle on Resolution when all targets become illegal (CR 400.7, CR 608.2b)
 * - TC-RULES-23: Automatic Lifecycle of Static Continuous Effects on Entry and Exit (CR 604, CR 613)
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
  const r1 = ZoneTransitionMatrix.moveCard(player, 'z1', 'hand', 'stack');
  // Stack -> Graveyard
  const r2 = ZoneTransitionMatrix.moveCard(player, r1.card.instanceId, 'stack', 'graveyard');
  // Graveyard -> Hand (Regrowth)
  const r3Card = ZoneTransitionMatrix.regrowth(player, r2.card.instanceId);
  assert.strictEqual(player.hand[0].instanceId, r3Card.instanceId);
  assert.strictEqual(player.hand[0].lineageId, 'z1');

  // Hand -> Exile
  const r4 = ZoneTransitionMatrix.moveCard(player, r3Card.instanceId, 'hand', 'exile');
  // Exile -> Hand
  const r5 = ZoneTransitionMatrix.moveCard(player, r4.card.instanceId, 'exile', 'hand');
  assert.strictEqual(player.hand[0].instanceId, r5.card.instanceId);
  assert.strictEqual(player.hand[0].lineageId, 'z1');
});

it('TC-RULES-06: Zone-Change Card Identity Reset (CR 400.7, INV-ZONE-MATRIX-1)', () => {
  const player = ZoneModel.createInitialPlayerState('p1', 'Player 1');
  const originalInstanceId = 'c_reset';
  const originalCardRef = {
    instanceId: originalInstanceId,
    name: 'Creature',
    typeLine: 'Creature',
    damageMarked: 4,
    isTapped: true,
    counters: { '+1/+1': 3 }
  };
  player.battlefield.creatures.push(originalCardRef);

  const result = ZoneTransitionMatrix.moveCard(player, originalInstanceId, 'battlefield', 'graveyard');
  const movedCard = result.card;

  assert.notStrictEqual(movedCard.instanceId, originalInstanceId);
  assert.notStrictEqual(movedCard, originalCardRef);

  const inGY = player.graveyard.find(c => c.instanceId === movedCard.instanceId);
  assert.strictEqual(inGY, movedCard);
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

it('TC-RULES-17: Layer System (CR 613) - Non-creature animated in Layer 4 receives Layer 7 P/T modifications', () => {
  const engine = new AbilityEngine();

  // Layer 4: Turn Artifact into Artifact Creature
  engine.registerStaticEffect({
    id: 'animate_artifact',
    layer: CONTINUOUS_LAYERS.LAYER_4_TYPE,
    apply: (card) => {
      card.typeLine = 'Artifact Creature';
      card.power = 0;
      card.toughness = 0;
    }
  });

  // Layer 7b: Set base P/T to 5/5 (e.g. Ensoul Artifact)
  engine.registerStaticEffect({
    id: 'ensoul_pt',
    layer: CONTINUOUS_LAYERS.LAYER_7B_SET_PT,
    setPower: 5,
    setToughness: 5
  });

  // Layer 7c: Modify P/T (+2/+2)
  engine.registerStaticEffect({
    id: 'anthem_buff',
    layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
    powerMod: 2,
    toughnessMod: 2
  });

  // Non-creature artifact
  const ornithopter = {
    instanceId: 'artifact_1',
    name: 'Mox Opal',
    typeLine: 'Legendary Artifact'
  };

  const evaluated = engine.evaluatePermanentLayers(ornithopter);
  assert.strictEqual(evaluated.typeLine, 'Artifact Creature');
  assert.strictEqual(evaluated.effectivePower, 7); // 5 + 2
  assert.strictEqual(evaluated.effectiveToughness, 7); // 5 + 2
});

it('TC-RULES-18: Legend Rule (CR 704.5j) - Duplicate legendary permanent moved to graveyard on runSBACheck', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');

  // Place 2 copies of Thalia, Guardian of Thraben onto battlefield
  const thalia1 = {
    instanceId: 'thalia_1',
    name: 'Thalia, Guardian of Thraben',
    typeLine: 'Legendary Creature — Human Soldier',
    power: 2,
    toughness: 1
  };
  const thalia2 = {
    instanceId: 'thalia_2',
    name: 'Thalia, Guardian of Thraben',
    typeLine: 'Legendary Creature — Human Soldier',
    power: 2,
    toughness: 1
  };

  p1.battlefield.creatures.push(thalia1, thalia2);
  assert.strictEqual(p1.battlefield.creatures.length, 2);

  const sbaResult = StateBasedActionsEngine.runSBACheck(tsm);
  assert.ok(sbaResult.totalActionsApplied >= 1);
  const legendAction = sbaResult.actions.find(a => a.type === 'LEGEND_RULE_APPLIED');
  assert.ok(legendAction, 'Must have recorded LEGEND_RULE_APPLIED action');
  assert.strictEqual(legendAction.rule, 'CR 704.5j');
  assert.strictEqual(legendAction.cardName, 'Thalia, Guardian of Thraben');

  // Only one copy remains on the battlefield, the duplicate was moved to graveyard
  assert.strictEqual(p1.battlefield.creatures.length, 1);
  assert.strictEqual(p1.graveyard.length, 1);
});

it('TC-RULES-19: CostModificationEngine Integration in TabletopStateManager (CR 601.2f)', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');

  // Card costing {2}{U}
  const spell = {
    instanceId: 'spell_divination',
    name: 'Divination',
    typeLine: 'Sorcery',
    manaCost: '{2}{U}'
  };
  p1.hand.push(spell);

  // Set mana pool: { U: 1, C: 2 } (total 3 mana)
  p1.resources.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 2 };

  // Cast spell with generic reduction of 1 (e.g. Goblin Electromancer)
  // Total cost becomes {1}{U}
  const result = tsm.dispatch('CAST_SPELL', {
    playerId: 'p1',
    instanceId: 'spell_divination',
    genericReduction: 1
  });

  assert.strictEqual(tsm.stack.length, 1);
  assert.ok(result.card.costBreakdown, 'Spell on stack must contain calculated costBreakdown');
  assert.strictEqual(result.card.costBreakdown.finalCostString, '{1}{U}');
  assert.strictEqual(result.card.costBreakdown.finalVector.total, 2);

  // Mana pool deduction verification: U paid 1 (0 remaining), generic 1 paid from C (1 remaining)
  assert.strictEqual(p1.resources.manaPool.U, 0);
  assert.strictEqual(p1.resources.manaPool.C, 1);
});

it('TC-RULES-20: Token Ceases to Exist Outside Battlefield (CR 704.5d)', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');

  // Token created in graveyard and exile
  p1.graveyard.push({
    instanceId: 'token_spirit_1',
    name: 'Spirit Token',
    isToken: true
  });
  p1.exile.push({
    instanceId: 'token_goblin_1',
    name: 'Goblin Token',
    isToken: true
  });

  const sbaResult = StateBasedActionsEngine.runSBACheck(tsm);
  const tokenActions = sbaResult.actions.filter(a => a.type === 'TOKEN_CEASED_TO_EXIST');
  assert.strictEqual(tokenActions.length, 2);
  assert.strictEqual(p1.graveyard.length, 0);
  assert.strictEqual(p1.exile.length, 0);
});

it('TC-RULES-21: Spell Resolution with Damage Effect and SBA Destruction (CR 608.2, CR 704.5g)', () => {
  const tsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const p1 = tsm.getPlayer('p1');
  const p2 = tsm.getPlayer('p2');

  const creature = {
    instanceId: 'creature_bear_p2',
    name: 'Grizzly Bears',
    typeLine: 'Creature — Bear',
    power: 2,
    toughness: 2,
    damageMarked: 0,
    ownerId: 'p2',
    controllerId: 'p2'
  };
  p2.battlefield.creatures.push(creature);

  const bolt = {
    instanceId: 'bolt_p1',
    name: 'Lightning Bolt',
    typeLine: 'Instant',
    ownerId: 'p1',
    controllerId: 'p1',
    targets: [{ instanceId: creature.instanceId }],
    effect: {
      type: 'DEAL_DAMAGE',
      amount: 3,
      targetId: creature.instanceId
    }
  };
  tsm.stack.push(bolt);

  const res = tsm.handleStackResolution({
    card: bolt,
    controllerId: 'p1',
    targets: [creature.instanceId],
    effect: bolt.effect
  });

  // Verify bolt resolved to graveyard of p1
  assert.ok(res, 'Resolution result should exist');
  assert.strictEqual(res.destinationZone, 'graveyard');
  assert.strictEqual(p1.graveyard.length, 1);
  assert.strictEqual(p1.graveyard[0].name, 'Lightning Bolt');

  // Verify damage was applied and runSBACheck destroyed creature (CR 704.5g)
  assert.strictEqual(p2.battlefield.creatures.length, 0, 'Creature should be destroyed and removed from battlefield');
  assert.strictEqual(p2.graveyard.length, 1, 'Creature should be moved to p2 graveyard');
  assert.strictEqual(p2.graveyard[0].name, 'Grizzly Bears');
});

it('TC-RULES-22: Spell Fizzle on Resolution when all targets become illegal (CR 400.7, CR 608.2b)', () => {
  const tsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const p1 = tsm.getPlayer('p1');
  const p2 = tsm.getPlayer('p2');

  const creature = {
    instanceId: 'inst_c1',
    name: 'Target Creature',
    typeLine: 'Creature — Soldier',
    power: 2,
    toughness: 2,
    damageMarked: 0,
    ownerId: 'p2',
    controllerId: 'p2'
  };
  p2.battlefield.creatures.push(creature);

  let effectExecuted = false;
  const spell = {
    instanceId: 'spell_kill',
    name: 'Murder',
    typeLine: 'Instant',
    ownerId: 'p1',
    controllerId: 'p1',
    targets: ['inst_c1'],
    effect: (state, item) => {
      effectExecuted = true;
    }
  };
  tsm.stack.push(spell);

  // Flicker creature on p2 battlefield -> changes instanceId per CR 400.7
  tsm.dispatch('FLICKER', { playerId: 'p2', instanceId: 'inst_c1' });

  // Verify old instanceId no longer exists on battlefield
  const oldCard = p2.battlefield.creatures.find(c => c.instanceId === 'inst_c1');
  assert.strictEqual(oldCard, undefined, 'Old instanceId should no longer exist after flicker');
  assert.strictEqual(p2.battlefield.creatures.length, 1, 'Flickered creature returned with fresh ID');

  // Resolve spell from stack
  const res = tsm.handleStackResolution({
    card: spell,
    controllerId: 'p1',
    targets: ['inst_c1'],
    effect: spell.effect
  });

  // Verify spell fizzled per CR 608.2b
  assert.ok(res, 'Resolution result should exist');
  assert.strictEqual(res.fizzled, true, 'Spell must fizzle when all targets are illegal');
  assert.strictEqual(res.reason, 'ALL_TARGETS_ILLEGAL');
  assert.strictEqual(effectExecuted, false, 'Spell effect must NOT be executed on fizzle');

  // Spell must be put into p1 graveyard
  assert.strictEqual(p1.graveyard.length, 1, 'Spell should be moved to graveyard on fizzle');
  assert.strictEqual(p1.graveyard[0].name, 'Murder');

  // Flickered creature is alive and untouched on p2 battlefield
  assert.strictEqual(p2.battlefield.creatures.length, 1);
  assert.strictEqual(p2.graveyard.length, 0);

  // Verify SPELL_FIZZLED event logged in actionLog
  const fizzledLog = tsm.actionLog.find(l => l.actionType === 'SPELL_FIZZLED');
  assert.ok(fizzledLog, 'SPELL_FIZZLED action must be recorded in actionLog');
  assert.strictEqual(fizzledLog.rule, 'CR 608.2b');
});

it('TC-RULES-23: Automatic Lifecycle of Static Continuous Effects on Entry and Exit (CR 604, CR 613)', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');

  const creature = {
    instanceId: 'creature_soldier',
    name: 'Soldier',
    typeLine: 'Creature — Soldier',
    power: 1,
    toughness: 1,
    ownerId: 'p1',
    controllerId: 'p1'
  };
  p1.battlefield.creatures.push(creature);

  // Baseline evaluation: 1/1
  const initialEval = tsm.abilityEngine.evaluatePermanentLayers(creature, tsm);
  assert.strictEqual(initialEval.effectivePower, 1);
  assert.strictEqual(initialEval.effectiveToughness, 1);

  // Glorious Anthem enchantment enters battlefield via handleStackResolution
  const anthem = {
    instanceId: 'anthem_01',
    name: 'Glorious Anthem',
    typeLine: 'Enchantment',
    isPermanent: true,
    ownerId: 'p1',
    controllerId: 'p1',
    staticEffects: [{
      layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
      powerMod: 1,
      toughnessMod: 1
    }]
  };
  tsm.stack.push(anthem);

  const resolveRes = tsm.handleStackResolution({ card: anthem, controllerId: 'p1' });
  assert.ok(resolveRes);
  assert.strictEqual(resolveRes.destinationZone, 'battlefield');
  const anthemOnBf = resolveRes.card;

  // Creature must now receive +1/+1 (becomes 2/2)
  const buffedEval = tsm.abilityEngine.evaluatePermanentLayers(creature, tsm);
  assert.strictEqual(buffedEval.effectivePower, 2, 'Effective power should be buffed to 2');
  assert.strictEqual(buffedEval.effectiveToughness, 2, 'Effective toughness should be buffed to 2');

  // Move Glorious Anthem to graveyard via MOVE_ZONE
  tsm.dispatch('MOVE_ZONE', {
    playerId: 'p1',
    instanceId: anthemOnBf.instanceId,
    fromZone: 'battlefield',
    toZone: 'graveyard'
  });

  // Verify static effect was automatically unregistered and creature returns to base 1/1
  const revertedEval = tsm.abilityEngine.evaluatePermanentLayers(creature, tsm);
  assert.strictEqual(revertedEval.effectivePower, 1, 'Effective power should revert to base 1');
  assert.strictEqual(revertedEval.effectiveToughness, 1, 'Effective toughness should revert to base 1');
  assert.strictEqual(tsm.abilityEngine.staticEffects.length, 0, 'Static effects array should be empty');
});

console.log('\n==================================================================');
console.log(`  FEATURE 21 TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log('==================================================================\n');

if (failed > 0) {
  process.exit(1);
}
