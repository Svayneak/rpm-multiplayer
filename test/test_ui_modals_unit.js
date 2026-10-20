/**
 * test_ui_modals_unit.js - Unit Test Suite for Module 4 (UI Modals & View Components)
 * 
 * Verifies:
 * 1. TargetSelectorModal legality evaluator (Hexproof, Shroud, Protection from Color)
 * 2. DamageAssignmentModal damage distribution and power balance math
 * 3. MulliganModal decision and bottoming logic
 * 4. SearchSelectGridModal filtering logic
 */

import assert from 'assert';
import { TargetSelectorModal } from '../src/view/TargetSelectorModal.js';
import { DamageAssignmentModal } from '../src/view/DamageAssignmentModal.js';
import { MulliganModal } from '../src/view/MulliganModal.js';
import { SearchSelectGridModal } from '../src/view/SearchSelectGridModal.js';

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

console.log('\n=== RUNNING MODULE 4 UI MODALS UNIT TESTS ===\n');

// ----------------------------------------------------
// Section 1: TargetSelectorModal Legality Tests
// ----------------------------------------------------
console.log('--- 1. TargetSelectorModal Legality (INV-TARGET-MENU-1) ---');

it('evaluates legal target when creature has no protection, hexproof, or shroud', () => {
  const redSpell = { name: 'Lightning Bolt', colors: ['R'], manaCost: '{R}' };
  const target = {
    id: 'bear_1',
    type: 'CREATURE',
    card: { instanceId: 'bear_1', controllerId: 'p2', keywords: {} }
  };

  const legality = TargetSelectorModal.evaluateTargetLegality(target, redSpell, 'p1');
  assert.strictEqual(legality.isLegal, true);
});

it('rejects target when opponent creature has Hexproof', () => {
  const redSpell = { name: 'Lightning Bolt', colors: ['R'], manaCost: '{R}' };
  const target = {
    id: 'bogle_1',
    type: 'CREATURE',
    card: { instanceId: 'bogle_1', controllerId: 'p2', keywords: { hexproof: true }, text: 'Hexproof' }
  };

  // Cast by opponent 'p1' -> Illegal!
  const legalityOpponent = TargetSelectorModal.evaluateTargetLegality(target, redSpell, 'p1');
  assert.strictEqual(legalityOpponent.isLegal, false);
  assert.strictEqual(legalityOpponent.reason, 'HEXPROOF');

  // Cast by controller 'p2' -> Legal! (Hexproof allows controller targeting)
  const legalityController = TargetSelectorModal.evaluateTargetLegality(target, redSpell, 'p2');
  assert.strictEqual(legalityController.isLegal, true);
});

it('rejects target when creature has Shroud (illegal for everyone)', () => {
  const spell = { name: 'Giant Growth', colors: ['G'], manaCost: '{G}' };
  const target = {
    id: 'scryb_1',
    type: 'CREATURE',
    card: { instanceId: 'scryb_1', controllerId: 'p1', keywords: { shroud: true }, text: 'Shroud' }
  };

  // Illegal even for controller!
  const legality = TargetSelectorModal.evaluateTargetLegality(target, spell, 'p1');
  assert.strictEqual(legality.isLegal, false);
  assert.strictEqual(legality.reason, 'SHROUD');
});

it('rejects target when creature has Protection from Spell\'s Color', () => {
  const redSpell = { name: 'Lightning Bolt', colors: ['R'], manaCost: '{R}' };
  const target = {
    id: 'crusader_1',
    type: 'CREATURE',
    card: { instanceId: 'crusader_1', controllerId: 'p2', keywords: {}, text: 'Protection from red' }
  };

  const legality = TargetSelectorModal.evaluateTargetLegality(target, redSpell, 'p1');
  assert.strictEqual(legality.isLegal, false);
  assert.strictEqual(legality.reason, 'PROTECTION_FROM_R');
});

// ----------------------------------------------------
// Section 2: DamageAssignmentModal Tests
// ----------------------------------------------------
console.log('\n--- 2. DamageAssignmentModal Logic (INV-DAMAGE-ASSIGN-1) ---');

it('DamageAssignmentModal tracks total power and enforces balance constraint', () => {
  const modal = new DamageAssignmentModal();
  const attacker = { instanceId: 'dragon_1', power: 5 };
  const blockers = [
    { instanceId: 'b1', name: 'Wall of Omens', toughness: 4 },
    { instanceId: 'b2', name: 'Birds of Paradise', toughness: 1 }
  ];

  modal.open({ attacker, blockers, attackerPower: 5 });
  assert.strictEqual(modal.totalPower, 5);
  assert.strictEqual(modal.getTotalAssigned(), 0);

  modal.updateDamage('b1', 4);
  assert.strictEqual(modal.assignments.get('b1'), 4);
  assert.strictEqual(modal.getTotalAssigned(), 4);

  // Remaining power is 1, so assigning +2 to b2 would exceed total power (5) and should be ignored
  modal.updateDamage('b2', 2);
  assert.strictEqual(modal.assignments.get('b2'), 0, 'Cannot exceed total attacker power');

  // Assign exactly remaining 1 to b2
  modal.updateDamage('b2', 1);
  assert.strictEqual(modal.assignments.get('b2'), 1);
  assert.strictEqual(modal.getTotalAssigned(), 5, 'Total assigned matches attacker power exactly');
});

// ----------------------------------------------------
// Section 3: Mulligan & Search Modal Logic
// ----------------------------------------------------
console.log('\n--- 3. Mulligan & Search Modals Logic ---');

it('MulliganModal handles bottoming count tracking', () => {
  const modal = new MulliganModal();
  modal.cards = [
    { instanceId: 'c1', name: 'Mountain' },
    { instanceId: 'c2', name: 'Island' }
  ];
  modal.mulliganCount = 1;
  modal.mode = 'BOTTOMING';

  modal.handleCardClick('c1');
  assert.strictEqual(modal.selectedBottomCards.length, 1);
  assert.strictEqual(modal.selectedBottomCards[0], 'c1');

  // Deselect on second click
  modal.handleCardClick('c1');
  assert.strictEqual(modal.selectedBottomCards.length, 0);
});

it('SearchSelectGridModal filter logic categorizes cards correctly', () => {
  const modal = new SearchSelectGridModal();
  modal.allCards = [
    { instanceId: '1', name: 'Ragavan', typeLine: 'Legendary Creature — Monkey Pirate' },
    { instanceId: '2', name: 'Scalding Tarn', typeLine: 'Land — Fetchland' },
    { instanceId: '3', name: 'Counterspell', typeLine: 'Instant' },
    { instanceId: '4', name: 'Mox Opal', typeLine: 'Legendary Artifact' }
  ];

  modal.activeCategory = 'CREATURE';
  modal.applyFilter();
  assert.strictEqual(modal.filteredCards.length, 1);
  assert.strictEqual(modal.filteredCards[0].name, 'Ragavan');

  modal.activeCategory = 'SPELL';
  modal.applyFilter();
  assert.strictEqual(modal.filteredCards.length, 1);
  assert.strictEqual(modal.filteredCards[0].name, 'Counterspell');

  modal.activeCategory = 'ALL';
  modal.searchQuery = 'mox';
  modal.applyFilter();
  assert.strictEqual(modal.filteredCards.length, 1);
  assert.strictEqual(modal.filteredCards[0].name, 'Mox Opal');
});

console.log(`\n=================================================`);
console.log(`MODULE 4 TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log(`=================================================\n`);

if (failed > 0) {
  process.exit(1);
}
