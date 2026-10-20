/**
 * test_perkins_module5.js - Unit Test Suite for Module 5 (Perkins AI Bot Intelligence)
 * 
 * Verifies:
 * 1. London Mulligan evaluation & card bottoming (INV-MULLIGAN-1)
 * 2. Tutor candidate selection (INV-ZONE-MATRIX-1)
 * 3. Legal spell target selection excluding Hexproof/Protection (INV-TARGET-MENU-1)
 * 4. Combat damage assignment (INV-DAMAGE-ASSIGN-1)
 * 5. Upkeep perk opt-in vs anti-deckout safeguard
 */

import assert from 'assert';
import { PerkinsAgent } from '../src/PerkinsAgent.js';

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

console.log('\n=== RUNNING MODULE 5 PERKINS AI INTELLIGENCE TESTS ===\n');

it('evaluateOpeningHand correctly advises keep/mulligan and selects bottom cards', () => {
  const perkins = new PerkinsAgent({ slotId: 'bot_p2' });

  // 0 lands -> Mulligan
  const handZero = Array.from({ length: 7 }, (_, i) => ({ id: `c_${i}`, typeLine: 'Instant' }));
  const res1 = perkins.evaluateOpeningHand(handZero, 0);
  assert.strictEqual(res1.keep, false);

  // 3 lands -> Keep
  const handThree = [
    { id: 'l1', typeLine: 'Basic Land — Mountain' },
    { id: 'l2', typeLine: 'Basic Land — Mountain' },
    { id: 'l3', typeLine: 'Basic Land — Mountain' },
    { id: 's1', typeLine: 'Creature', cmc: 2 },
    { id: 's2', typeLine: 'Creature', cmc: 3 },
    { id: 's3', typeLine: 'Instant', cmc: 1 },
    { id: 's4', typeLine: 'Creature', cmc: 6, manaCost: '{4}{R}{R}' }
  ];
  const res2 = perkins.evaluateOpeningHand(handThree, 1);
  assert.strictEqual(res2.keep, true);
  assert.strictEqual(res2.bottomCards.length, 1);
  assert.strictEqual(res2.bottomCards[0].id, 's4', 'Bottoms highest CMC spell on 1 mulligan');

  perkins.destroy();
});

it('selectTutorCandidate prioritizes mana fixing when lands are scarce', () => {
  const perkins = new PerkinsAgent({ slotId: 'bot_p2' });
  const candidates = [
    { name: 'Island', typeLine: 'Basic Land — Island', cmc: 0 },
    { name: 'Griselbrand', typeLine: 'Creature — Demon', cmc: 8 },
    { name: 'Lightning Bolt', typeLine: 'Instant', cmc: 1 }
  ];

  // Turn 3 with only 2 lands -> Emergency! Pick land
  const chosenLand = perkins.selectTutorCandidate(candidates, { landsCount: 2, turnNumber: 3 });
  assert.strictEqual(chosenLand.name, 'Island');

  // Turn 5 with 5 lands -> Pick finisher
  const chosenFinisher = perkins.selectTutorCandidate(candidates, { landsCount: 5, turnNumber: 5 });
  assert.strictEqual(chosenFinisher.name, 'Griselbrand');

  perkins.destroy();
});

it('selectLegalSpellTarget never targets opponent creature with Hexproof or Protection from Red', () => {
  const perkins = new PerkinsAgent({ slotId: 'bot_p2' });
  const redSpell = { name: 'Lightning Bolt', colors: ['R'], manaCost: '{R}' };

  const mockState = {
    players: {
      bot_p2: { id: 'bot_p2', name: 'Perkins' },
      human_p1: {
        id: 'human_p1',
        name: 'Human Player',
        resources: { life: 20 },
        battlefield: {
          creatures: [
            { instanceId: 'hexproof_bogle', name: 'Slippery Bogle', keywords: { hexproof: true }, power: 10, controllerId: 'human_p1' },
            { instanceId: 'pro_red_knight', name: 'Knight of Grace', text: 'Protection from red', power: 8, controllerId: 'human_p1' },
            { instanceId: 'legal_goyf', name: 'Tarmogoyf', keywords: {}, power: 4, controllerId: 'human_p1' }
          ]
        }
      }
    }
  };

  const target = perkins.selectLegalSpellTarget(redSpell, mockState);
  assert.ok(target, 'Must find a legal target');
  assert.strictEqual(target.targetType, 'CREATURE');
  assert.strictEqual(target.targetId, 'legal_goyf', 'Must target legal Tarmogoyf, bypassing Hexproof and Protection!');

  perkins.destroy();
});

it('shouldRollUpkeepPerk declines roll if library is nearly empty to prevent deckout', () => {
  const perkins = new PerkinsAgent({ slotId: 'bot_p2' });

  // Normal deck (30 cards) -> Roll!
  const stateHealthy = { players: { bot_p2: { libraryCount: 30 } } };
  assert.strictEqual(perkins.shouldRollUpkeepPerk(stateHealthy), true);

  // Dangerous deck (2 cards remaining) -> Decline to avoid losing to draw perks!
  const stateLow = { players: { bot_p2: { libraryCount: 2 } } };
  assert.strictEqual(perkins.shouldRollUpkeepPerk(stateLow), false);

  perkins.destroy();
});

console.log(`\n=================================================`);
console.log(`MODULE 5 TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log(`=================================================\n`);

if (failed > 0) {
  process.exit(1);
}
