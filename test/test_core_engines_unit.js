/**
 * test_core_engines_unit.js - Unit Test Suite for Module 1 (Pure Core Rules Engines)
 * 
 * Tests:
 * 1. MulliganEngine (CSPRNG Shuffling, Perkins Bot Heuristics, London Mulligan tracker)
 * 2. CostModificationEngine (CR 601.2f Total Cost math, taxes, reductions, Delve, Convoke, Trinisphere)
 * 3. AbilityEngine (CR 602 Activated, CR 603 Triggered APNAP, CR 604 & CR 613 7-Layer Continuous Engine)
 * 4. Invariant INV-STATIC-SBA-1 Grounding: 1/1 Indestructible entering under -1/-1 static debuff has toughness 0!
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

let passed = 0;
let failed = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('\n=== RUNNING MODULE 1 CORE ENGINES UNIT TESTS ===\n');

// ----------------------------------------------------
// Section 1: MulliganEngine Unit Tests
// ----------------------------------------------------
console.log('--- 1. MulliganEngine (CR 103.2 & CR 103.4) ---');

it('shuffleLibrary uniformly randomizes elements while preserving array identity and contents', () => {
  const original = Array.from({ length: 60 }, (_, i) => ({ id: `card_${i}`, name: `Card ${i}` }));
  const deck = [...original];
  shuffleLibrary(deck);
  assert.strictEqual(deck.length, 60, 'Deck length must be preserved');
  const originalIds = new Set(original.map(c => c.id));
  const shuffledIds = new Set(deck.map(c => c.id));
  assert.strictEqual(shuffledIds.size, 60, 'All unique cards must remain in deck');
  // Order should differ in virtually 100% of cases for 60 elements
  const exactMatch = deck.every((c, i) => c.id === original[i].id);
  assert.strictEqual(exactMatch, false, 'Shuffled deck order must differ from sorted original');
});

it('evaluatePerkinsMulligan mulligans on 0, 1, 6, 7 lands and keeps 2-5 lands', () => {
  const makeHand = (landCount) => {
    const hand = [];
    for (let i = 0; i < 7; i++) {
      if (i < landCount) {
        hand.push({ id: `l_${i}`, name: 'Mountain', typeLine: 'Basic Land — Mountain' });
      } else {
        hand.push({ id: `s_${i}`, name: 'Lightning Bolt', typeLine: 'Instant', manaCost: '{R}' });
      }
    }
    return hand;
  };

  assert.strictEqual(evaluatePerkinsMulligan(makeHand(0)).keep, false, '0 lands must mulligan');
  assert.strictEqual(evaluatePerkinsMulligan(makeHand(1)).keep, false, '1 land must mulligan');
  assert.strictEqual(evaluatePerkinsMulligan(makeHand(6)).keep, false, '6 lands must mulligan');
  assert.strictEqual(evaluatePerkinsMulligan(makeHand(7)).keep, false, '7 lands must mulligan');

  assert.strictEqual(evaluatePerkinsMulligan(makeHand(2)).keep, true, '2 lands must keep');
  assert.strictEqual(evaluatePerkinsMulligan(makeHand(3)).keep, true, '3 lands must keep');
  assert.strictEqual(evaluatePerkinsMulligan(makeHand(4)).keep, true, '4 lands must keep');
  assert.strictEqual(evaluatePerkinsMulligan(makeHand(5)).keep, true, '5 lands must keep');

  // Depth threshold check (keep on 3+ mulligans even if imperfect)
  assert.strictEqual(evaluatePerkinsMulligan(makeHand(1), 3).keep, true, 'At 3 mulligans, must keep to avoid card loss');
});

it('selectPerkinsBottomCards selects high-cost spells or excess lands for bottoming', () => {
  const hand = [
    { id: '1', name: 'Mountain', typeLine: 'Basic Land — Mountain' },
    { id: '2', name: 'Mountain', typeLine: 'Basic Land — Mountain' },
    { id: '3', name: 'Mountain', typeLine: 'Basic Land — Mountain' },
    { id: '4', name: 'Mountain', typeLine: 'Basic Land — Mountain' },
    { id: '5', name: 'Ragavan', typeLine: 'Creature', cmc: 1, manaCost: '{R}' },
    { id: '6', name: 'Lightning Bolt', typeLine: 'Instant', cmc: 1, manaCost: '{R}' },
    { id: '7', name: 'Inferno Titan', typeLine: 'Creature', cmc: 6, manaCost: '{4}{R}{R}' }
  ];

  const bottom1 = selectPerkinsBottomCards(hand, 1);
  assert.strictEqual(bottom1.length, 1);
  assert.strictEqual(bottom1[0].name, 'Inferno Titan', 'Highest CMC card must be bottomed first');

  const bottom2 = selectPerkinsBottomCards(hand, 2);
  assert.strictEqual(bottom2.length, 2);
  assert.strictEqual(bottom2[0].name, 'Inferno Titan');
  assert.strictEqual(bottom2[1].name, 'Mountain', 'Excess 4th land should be bottomed second');
});

it('MulliganTracker tracks multi-player London Mulligan decisions', () => {
  const tracker = new MulliganTracker(['p1', 'p2']);
  assert.strictEqual(tracker.isAllDecided(), false);

  tracker.incrementMulligan('p1');
  assert.strictEqual(tracker.getMulliganCount('p1'), 1);

  tracker.setDecided('p1', true);
  assert.strictEqual(tracker.isAllDecided(), false);

  tracker.setDecided('p2', true);
  assert.strictEqual(tracker.isAllDecided(), true);
});

// ----------------------------------------------------
// Section 2: CostModificationEngine Unit Tests
// ----------------------------------------------------
console.log('\n--- 2. CostModificationEngine (CR 601.2f) ---');

it('parseManaCost and formatManaCost accurately parse and serialize mana pips', () => {
  const parsed = parseManaCost('{2}{U}{U}');
  assert.strictEqual(parsed.generic, 2);
  assert.strictEqual(parsed.U, 2);
  assert.strictEqual(parsed.total, 4);

  const formatted = formatManaCost(parsed);
  assert.strictEqual(formatted, '{2}{U}{U}');
});

it('calculateTotalCost supports "without paying mana cost" (Omniscience/Cascade)', () => {
  const card = { name: 'Karn Liberated', manaCost: '{7}' };
  const cost = CostModificationEngine.calculateTotalCost(card, { isWithoutPayingManaCost: true });
  assert.strictEqual(cost.finalCostString, '{0}');
  assert.strictEqual(cost.totalCMC, 0);
  assert.strictEqual(cost.isWithoutPayingManaCost, true);
});

it('calculateTotalCost calculates taxes, reductions, and respects colored pip preservation', () => {
  const card = { name: 'Archmage\'s Charm', manaCost: '{U}{U}{U}' };
  // Reductions should NOT reduce colored pips
  const cost1 = CostModificationEngine.calculateTotalCost(card, { genericReduction: 2 });
  assert.strictEqual(cost1.finalCostString, '{U}{U}{U}', 'Generic reductions cannot reduce colored pips');

  const spell = { name: 'Lightning Bolt', manaCost: '{R}' };
  // Thalia tax (+1 generic)
  const cost2 = CostModificationEngine.calculateTotalCost(spell, { genericTax: 1 });
  assert.strictEqual(cost2.finalCostString, '{1}{R}');

  // Electromancer reduction on {1}{U} Instant
  const counterspell = { name: 'Counterspell', manaCost: '{1}{U}' };
  const cost3 = CostModificationEngine.calculateTotalCost(counterspell, { genericReduction: 1 });
  assert.strictEqual(cost3.finalCostString, '{U}');
});

it('calculateTotalCost calculates Delve, Convoke, and Trinisphere rules', () => {
  // Delve: Gurmag Angler {6}{B} with 5 cards exiled
  const angler = { name: 'Gurmag Angler', manaCost: '{6}{B}' };
  const delveCost = CostModificationEngine.calculateTotalCost(angler, { delveCardsExiled: 5 });
  assert.strictEqual(delveCost.finalCostString, '{1}{B}');

  // Convoke: Chord of Calling {X}{G}{G}{G} -> test with {2}{G}{G} tapped with 1 G creature
  const spell = { name: 'Verdant Force', manaCost: '{5}{G}{G}{G}' };
  const convokeCost = CostModificationEngine.calculateTotalCost(spell, { convokeTaps: ['G', 'W'] });
  // 1 green pip paid, 1 generic paid
  assert.strictEqual(convokeCost.finalVector.G, 2);
  assert.strictEqual(convokeCost.finalVector.generic, 4);

  // Trinisphere: {R} with Trinisphere becomes {2}{R} (3 total mana)
  const bolt = { name: 'Lightning Bolt', manaCost: '{R}' };
  const triniCost = CostModificationEngine.calculateTotalCost(bolt, { applyTrinisphere: true });
  assert.strictEqual(triniCost.totalCMC, 3);
  assert.strictEqual(triniCost.finalCostString, '{2}{R}');
});

it('canAffordCost accurately validates available mana pool', () => {
  const cost = parseManaCost('{1}{U}{U}');
  const poolSuff = { U: 2, R: 1, W: 0, B: 0, G: 0, C: 0, colorless: 0 };
  const res1 = CostModificationEngine.canAffordCost(cost, poolSuff);
  assert.strictEqual(res1.canAfford, true);

  const poolInsuff = { U: 1, R: 2, W: 0, B: 0, G: 0, C: 0, colorless: 0 };
  const res2 = CostModificationEngine.canAffordCost(cost, poolInsuff);
  assert.strictEqual(res2.canAfford, false);
  assert.strictEqual(res2.missing.U, 1);
});

// ----------------------------------------------------
// Section 3: AbilityEngine & Layer Engine Unit Tests
// ----------------------------------------------------
console.log('\n--- 3. AbilityEngine (CR 602, 603, 604 & CR 613) ---');

it('canActivateAbility checks tap status, summoning sickness, and life payment', () => {
  const creature = {
    instanceId: 'creature_1',
    name: 'Llanowar Elves',
    typeLine: 'Creature — Elf Druid',
    isTapped: false,
    hasSummoningSickness: true,
    keywords: {}
  };
  const tapAbility = { cost: { tap: true }, isManaAbility: true };

  // Fails with summoning sickness
  const check1 = AbilityEngine.canActivateAbility(creature, tapAbility);
  assert.strictEqual(check1.canActivate, false);
  assert.strictEqual(check1.error, 'SUMMONING_SICKNESS');

  // Passes if creature has Haste
  creature.keywords.haste = true;
  const check2 = AbilityEngine.canActivateAbility(creature, tapAbility);
  assert.strictEqual(check2.canActivate, true);

  // Life payment check
  const payLifeAbility = { cost: { life: 4 } };
  const contextLowLife = { player: { resources: { life: 2 } } };
  const check3 = AbilityEngine.canActivateAbility(creature, payLifeAbility, contextLowLife);
  assert.strictEqual(check3.canActivate, false);
  assert.strictEqual(check3.error, 'INSUFFICIENT_LIFE');
});

it('flushTriggersAPNAP stacks Active Player triggers first so Non-Active resolves first (CR 603.3b)', () => {
  const engine = new AbilityEngine();
  engine.queueTrigger({ sourceId: 't1', controllerId: 'activePlayer', text: 'Active Player ETB' });
  engine.queueTrigger({ sourceId: 't2', controllerId: 'nonActivePlayer', text: 'Non-Active Player ETB' });

  const stack = engine.flushTriggersAPNAP('activePlayer', ['activePlayer', 'nonActivePlayer']);
  assert.strictEqual(stack.length, 2);
  // Active Player trigger pushed first, Non-Active pushed second
  assert.strictEqual(stack[0].controllerId, 'activePlayer');
  assert.strictEqual(stack[1].controllerId, 'nonActivePlayer');
  // On LIFO Stack: stack.pop() will resolve stack[1] (Non-Active Player) first!
});

it('evaluatePermanentLayers enforces INV-STATIC-SBA-1: 1/1 Indestructible under -1/-1 static debuff has 0 Toughness', () => {
  const engine = new AbilityEngine();

  // Register static -1/-1 enchantment effect (e.g. Night of Souls' Betrayal or Elesh Norn)
  engine.registerStaticEffect({
    id: 'static_debuff_night_of_souls',
    sourceId: 'enchantment_1',
    layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
    powerMod: -1,
    toughnessMod: -1,
    appliesTo: (card) => /creature/i.test(card.typeLine || card.type || '')
  });

  // Create 1/1 creature with Indestructible (e.g. Darksteel Myr / Toski)
  const indestructibleCreature = {
    instanceId: 'myr_1',
    name: 'Darksteel Myr',
    typeLine: 'Artifact Creature — Myr',
    power: 1,
    toughness: 1,
    basePower: 1,
    baseToughness: 1,
    isIndestructible: true,
    keywords: { indestructible: true },
    text: 'Indestructible'
  };

  const evaluated = engine.evaluatePermanentLayers(indestructibleCreature);

  // Invariant verification:
  assert.strictEqual(evaluated.keywords.indestructible, true, 'Indestructible keyword is preserved');
  assert.strictEqual(evaluated.effectivePower, 0, 'Effective power is 0 (1 - 1)');
  assert.strictEqual(evaluated.effectiveToughness, 0, 'Effective toughness is 0 (1 - 1)');
  console.log(`    \x1b[34mℹ Invariant Confirmed: 1/1 Indestructible creature evaluated to Toughness: ${evaluated.effectiveToughness} (CR 704.5f ready)\x1b[0m`);
});

console.log(`\n=================================================`);
console.log(`MODULE 1 TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log(`=================================================\n`);

if (failed > 0) {
  process.exit(1);
}
