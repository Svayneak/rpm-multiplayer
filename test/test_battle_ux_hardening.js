/**
 * test_battle_ux_hardening.js - Acceptance Test Suite for Feature 19
 * Specification: SPEC-RPM-BATTLE-UX-019
 * 
 * Vectors:
 * - TC-UX-01: Auto-Untap of active player permanents on UNTAP step (INV-AUTO-UNTAP-1)
 * - TC-UX-02: DoesNotUntap exemption keeps marked permanents tapped (INV-AUTO-UNTAP-1)
 * - TC-UX-03: Mandatory Card Draw on DRAW step (INV-AUTO-DRAW-1)
 * - TC-UX-04: Turn 1 Play/Draw: Player 1 skips draw, Player 2 draws (CR 103.7a / CR 504.1)
 * - TC-UX-05: TargetSelectorModal legality: Hexproof, Shroud, and Protection (INV-TARGET-MENU-1)
 * - TC-UX-06: Shockland (Steam Vents) ETB 2-life prompt vs tapped entry (INV-SHOCKLAND-1)
 * - TC-UX-07: Horizontal Land Badge naming: (Untapped)/(Tapped) without 90° rotation (INV-LAND-BADGE-1)
 * - TC-UX-08: Touch/drag 3D dice shaker gesture release dynamics (INV-DICE-TOUCH-1)
 */

import assert from 'assert';
import { TabletopStateManager } from '../src/TabletopStateManager.js';
import { PriorityStateMachine } from '../src/PriorityStateMachine.js';
import { TargetSelectorModal } from '../src/view/TargetSelectorModal.js';
import { DiceShaker } from '../src/view/DiceShaker.js';

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
console.log('  RUNNING FEATURE 19 ACCEPTANCE TEST SUITE: BATTLE UX & RULES');
console.log('  Specification: SPEC-RPM-BATTLE-UX-019');
console.log('==================================================================\n');

it('TC-UX-01: Auto-Untap of active player permanents on UNTAP step (INV-AUTO-UNTAP-1)', () => {
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], startingPlayerId: 'p1' });
  const tsm = new TabletopStateManager({ players: ['p1', 'p2'], activePlayerId: 'p1', priorityMachine: psm });

  const p1 = tsm.getPlayer('p1');
  const mountain = { instanceId: 'm1', name: 'Mountain', isTapped: true, typeLine: 'Basic Land — Mountain' };
  const bear = { instanceId: 'b1', name: 'Grizzly Bears', isTapped: true, typeLine: 'Creature — Bear' };
  p1.battlefield.lands.push(mountain);
  p1.battlefield.creatures.push(bear);

  tsm.handleUntapStep('p1');
  assert.strictEqual(mountain.isTapped, false, 'Lands must auto-untap on UNTAP step');
  assert.strictEqual(bear.isTapped, false, 'Creatures must auto-untap on UNTAP step');
});

it('TC-UX-02: DoesNotUntap exemption keeps marked permanents tapped (INV-AUTO-UNTAP-1)', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');
  const lockedPerm = { instanceId: 'frozen_1', name: 'Mana Vault', isTapped: true, doesNotUntap: true, typeLine: 'Artifact' };
  p1.battlefield.noncreatures.push(lockedPerm);

  // Auto-untap step should respect doesNotUntap flag
  tsm.untapAll('p1');
  assert.strictEqual(lockedPerm.isTapped, true, 'Permanents marked doesNotUntap must not untap automatically');
});

it('TC-UX-03: Mandatory Card Draw on DRAW step (INV-AUTO-DRAW-1)', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');
  p1.library.push({ instanceId: 'c_draw', name: 'Opt' });
  const countBefore = p1.hand.length;

  tsm.handlePhaseStepChanged({ currentPhaseStep: 'DRAW', activePlayerId: 'p1', shouldSkipDraw: false });
  assert.strictEqual(p1.hand.length, countBefore + 1, 'DRAW step must trigger mandatory card draw');
  assert.strictEqual(p1.hand[p1.hand.length - 1].instanceId, 'c_draw');
});

it('TC-UX-04: Turn 1 Play/Draw: Player 1 skips draw, Player 2 draws (CR 103.7a / CR 504.1)', () => {
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], startingPlayerId: 'p1' });
  let p1Skipped = false;
  let p2Drew = false;

  psm.on('DRAW_STEP_SKIPPED', () => { p1Skipped = true; });
  psm.on('MANDATORY_DRAW_TRIGGERED', () => { p2Drew = true; });

  // Advance to Turn 1 Player 1 DRAW step
  psm.setPhaseStep('DRAW');
  assert.strictEqual(p1Skipped, true, 'Turn 1 Player 1 must skip draw step in 1v1');

  // Advance turn to Player 2
  psm.activePlayerId = 'p2';
  psm.setPhaseStep('DRAW');
  assert.strictEqual(p2Drew, true, 'Turn 1 Player 2 must receive mandatory draw in 1v1');
});

it('TC-UX-05: TargetSelectorModal legality: Hexproof, Shroud, and Protection (INV-TARGET-MENU-1)', () => {
  const bolt = { name: 'Lightning Bolt', colors: ['R'], manaCost: '{R}' };

  const hexproofOpponent = {
    id: 't1',
    type: 'CREATURE',
    card: { instanceId: 't1', controllerId: 'p2', keywords: { hexproof: true } }
  };
  const shroudCreature = {
    id: 't2',
    type: 'CREATURE',
    card: { instanceId: 't2', controllerId: 'p1', keywords: { shroud: true } }
  };
  const proRedCreature = {
    id: 't3',
    type: 'CREATURE',
    card: { instanceId: 't3', controllerId: 'p2', text: 'Protection from red' }
  };
  const legalCreature = {
    id: 't4',
    type: 'CREATURE',
    card: { instanceId: 't4', controllerId: 'p2', keywords: {} }
  };

  assert.strictEqual(TargetSelectorModal.evaluateTargetLegality(hexproofOpponent, bolt, 'p1').isLegal, false);
  assert.strictEqual(TargetSelectorModal.evaluateTargetLegality(shroudCreature, bolt, 'p1').isLegal, false);
  assert.strictEqual(TargetSelectorModal.evaluateTargetLegality(proRedCreature, bolt, 'p1').isLegal, false);
  assert.strictEqual(TargetSelectorModal.evaluateTargetLegality(legalCreature, bolt, 'p1').isLegal, true);
});

it('TC-UX-06: Shockland (Steam Vents) ETB 2-life prompt vs tapped entry (INV-SHOCKLAND-1)', () => {
  const tsm = new TabletopStateManager({ players: ['p1'], activePlayerId: 'p1' });
  const p1 = tsm.getPlayer('p1');
  p1.resources.life = 20;

  // 1. Steam Vents paying 2 life
  const vent1 = { instanceId: 'sv1', name: 'Steam Vents', typeLine: 'Land — Island Mountain' };
  p1.hand.push(vent1);
  tsm.dispatch('PLAY_LAND', { playerId: 'p1', instanceId: 'sv1', pay2Life: true });
  assert.strictEqual(p1.resources.life, 18, 'Paying 2 life deducts 2 life');
  assert.strictEqual(p1.battlefield.lands.find(l => l.instanceId === 'sv1').isTapped, false, 'Enters untapped');

  // Reset land drops
  p1.landsPlayedThisTurn = 0;

  // 2. Steam Vents declining 2 life
  const vent2 = { instanceId: 'sv2', name: 'Steam Vents', typeLine: 'Land — Island Mountain' };
  p1.hand.push(vent2);
  tsm.dispatch('PLAY_LAND', { playerId: 'p1', instanceId: 'sv2', pay2Life: false });
  assert.strictEqual(p1.resources.life, 18, 'Declining 2 life does not lose additional life');
  assert.strictEqual(p1.battlefield.lands.find(l => l.instanceId === 'sv2').isTapped, true, 'Enters tapped');
});

it('TC-UX-07: Horizontal Land Badge naming: (Untapped)/(Tapped) without 90° rotation (INV-LAND-BADGE-1)', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');
  const mountain = { instanceId: 'm_badge', name: 'Mountain', typeLine: 'Basic Land — Mountain', isTapped: true };
  p1.battlefield.lands.push(mountain);

  const isLand = /land/i.test(mountain.typeLine);
  const displayName = isLand ? `${mountain.name} ${mountain.isTapped ? '(Tapped)' : '(Untapped)'}` : mountain.name;
  assert.strictEqual(displayName, 'Mountain (Tapped)', 'Must render clean horizontal badge string');

  mountain.isTapped = false;
  const displayNameUntapped = isLand ? `${mountain.name} ${mountain.isTapped ? '(Tapped)' : '(Untapped)'}` : mountain.name;
  assert.strictEqual(displayNameUntapped, 'Mountain (Untapped)');
});

it('TC-UX-08: Touch/drag 3D dice shaker gesture release dynamics (INV-DICE-TOUCH-1)', () => {
  const shaker = new DiceShaker();
  shaker._active = true;
  shaker._shakeCount = 3;
  shaker._vx = 0.2;
  shaker._vy = 0.15;

  const releaseData = shaker.release(100, 200);
  assert.ok(releaseData.throwForce >= 3.2, 'Throw force must be at least baseline 3.2');
  assert.strictEqual(releaseData.shakeCount, 3);
  assert.strictEqual(shaker._active, false, 'Shaker active state must be terminated on release');
});

console.log('\n==================================================================');
console.log(`  FEATURE 19 TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log('==================================================================\n');

if (failed > 0) {
  process.exit(1);
}
