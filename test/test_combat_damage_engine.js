/**
 * test_combat_damage_engine.js - Acceptance Test Suite for Feature 20
 * Specification: SPEC-RPM-COMBAT-DAMAGE-020
 * 
 * Vectors:
 * - TC-COMBAT-01: Damage vs. Life Loss Separation (CR 119 vs CR 120, INV-DMG-LIFE-1)
 * - TC-COMBAT-02: Lifelink Simultaneous Life Gain (CR 702.15, CR 120.3f)
 * - TC-COMBAT-03: Infect Deals Damage as Poison Counters to Players (CR 702.90, CR 120.3b)
 * - TC-COMBAT-04: Infect Deals Damage as -1/-1 Counters to Creatures (CR 702.90, CR 120.3d)
 * - TC-COMBAT-05: Trample Excess Damage Assigned to Defending Player (CR 702.19, CR 510.1c)
 * - TC-COMBAT-06: Deathtouch 1-Point Lethal Damage Assignment (CR 702.2)
 * - TC-COMBAT-07: Deathtouch + Trample Lethal Remainder Trample (CR 702.2 + CR 702.19)
 * - TC-COMBAT-08: Protection Damage Prevention to 0 (CR 702.16e)
 * - TC-COMBAT-09: Indestructible Lethal Damage Destruction Immunity (CR 702.12 vs CR 704.5g)
 * - TC-COMBAT-10: Indestructible Dies to Zero Toughness (CR 704.5f vs CR 704.5g, INV-STATIC-SBA-1)
 * - TC-COMBAT-11: First Strike / Double Strike Combat Distribution (CR 702.7 & CR 702.4)
 * - TC-COMBAT-12: Cleanup Step Marked Damage Purge Loop (CR 514.2)
 */

import assert from 'assert';
import { CombatDamageEngine } from '../src/CombatDamageEngine.js';
import { StateBasedActionsEngine } from '../src/StateBasedActionsEngine.js';
import { AbilityEngine, CONTINUOUS_LAYERS } from '../src/AbilityEngine.js';
import { TabletopStateManager } from '../src/TabletopStateManager.js';
import { PriorityStateMachine } from '../src/PriorityStateMachine.js';
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
console.log('  RUNNING FEATURE 20 ACCEPTANCE TEST SUITE: COMBAT DAMAGE & SBAS');
console.log('  Specification: SPEC-RPM-COMBAT-DAMAGE-020');
console.log('==================================================================\n');

it('TC-COMBAT-01: Damage vs. Life Loss Separation (CR 119 vs CR 120, INV-DMG-LIFE-1)', () => {
  const tsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const p1 = tsm.getPlayer('p1');
  const p2 = tsm.getPlayer('p2');
  p1.resources.life = 20;
  p2.resources.life = 20;

  let damageDealtEmitted = false;
  tsm.on('DAMAGE_DEALT', () => { damageDealtEmitted = true; });

  // 1. Lose Life: modifies life directly, no DAMAGE_DEALT event
  tsm.loseLife('p1', 4, 'PAYMENT');
  assert.strictEqual(p1.resources.life, 16);
  assert.strictEqual(damageDealtEmitted, false, 'loseLife must never emit DAMAGE_DEALT');

  // 2. Deal Damage: modifies life, emits DAMAGE_DEALT
  tsm.dealDamage({
    sourceId: 'src_1',
    sourceControllerId: 'p1',
    targetId: 'p2',
    targetType: 'PLAYER',
    amount: 5
  });
  assert.strictEqual(p2.resources.life, 15);
  assert.strictEqual(damageDealtEmitted, true, 'dealDamage must emit DAMAGE_DEALT');
});

it('TC-COMBAT-02: Lifelink Simultaneous Life Gain (CR 702.15, CR 120.3f)', () => {
  const tsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const p1 = tsm.getPlayer('p1');
  const p2 = tsm.getPlayer('p2');
  p1.resources.life = 10;
  p2.resources.life = 20;

  tsm.dealDamage({
    sourceId: 'vampire_bat',
    sourceControllerId: 'p1',
    targetId: 'p2',
    targetType: 'PLAYER',
    amount: 3,
    keywords: { lifelink: true }
  });

  assert.strictEqual(p2.resources.life, 17, 'Defending player loses 3 life');
  assert.strictEqual(p1.resources.life, 13, 'Lifelink source controller gains 3 life simultaneously');
});

it('TC-COMBAT-03: Infect Deals Damage as Poison Counters to Players (CR 702.90, CR 120.3b)', () => {
  const tsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const p2 = tsm.getPlayer('p2');
  p2.resources.life = 20;
  p2.resources.poison = 0;

  tsm.dealDamage({
    sourceId: 'glister_elf',
    sourceControllerId: 'p1',
    targetId: 'p2',
    targetType: 'PLAYER',
    amount: 4,
    keywords: { infect: true }
  });

  assert.strictEqual(p2.resources.life, 20, 'Life total is untouched by infect');
  assert.strictEqual(p2.resources.poison, 4, 'Target player receives 4 poison counters');
});

it('TC-COMBAT-04: Infect Deals Damage as -1/-1 Counters to Creatures (CR 702.90, CR 120.3d)', () => {
  const tsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const p2 = tsm.getPlayer('p2');
  const golem = { instanceId: 'golem_1', name: 'Golem', power: 4, toughness: 4, counters: {} };
  p2.battlefield.creatures.push(golem);

  tsm.dealDamage({
    sourceId: 'infect_rat',
    sourceControllerId: 'p1',
    targetId: 'golem_1',
    targetType: 'CREATURE',
    amount: 2,
    keywords: { infect: true }
  });

  assert.strictEqual(golem.counters['-1/-1'], 2, 'Creature receives two -1/-1 counters');
  assert.strictEqual(golem.damageMarked || 0, 0, 'No temporary damage is marked for infect');
});

it('TC-COMBAT-05: Trample Excess Damage Assigned to Defending Player (CR 702.19, CR 510.1c)', () => {
  const attacker = { instanceId: 'colossus', keywords: { trample: true } };
  const blocker = { instanceId: 'bear', toughness: 2, effectiveToughness: 2, damageMarked: 0 };

  const dist = CombatDamageEngine.calculateAttackerDamageDistribution(attacker, [blocker], 7);
  assert.strictEqual(dist.blockerAssignments[0].damage, 2, 'Lethal damage (2) assigned to blocker');
  assert.strictEqual(dist.playerTrampleDamage, 5, 'Remaining excess (5) tramples to player');
});

it('TC-COMBAT-06: Deathtouch 1-Point Lethal Damage Assignment (CR 702.2)', () => {
  const attacker = { instanceId: 'snake', keywords: { deathtouch: true } };
  const hugeBlocker = { instanceId: 'giant', toughness: 10, effectiveToughness: 10, damageMarked: 0 };

  const dist = CombatDamageEngine.calculateAttackerDamageDistribution(attacker, [hugeBlocker], 3);
  assert.strictEqual(dist.blockerAssignments[0].damage, 1, 'Only 1 damage needed for legal lethal assignment under deathtouch');
});

it('TC-COMBAT-07: Deathtouch + Trample Lethal Remainder Trample (CR 702.2 + CR 702.19)', () => {
  const attacker = { instanceId: 'trample_snake', keywords: { trample: true, deathtouch: true } };
  const hugeBlocker = { instanceId: 'giant_2', toughness: 10, effectiveToughness: 10, damageMarked: 0 };

  const dist = CombatDamageEngine.calculateAttackerDamageDistribution(attacker, [hugeBlocker], 6);
  assert.strictEqual(dist.blockerAssignments[0].damage, 1, '1 damage satisfies lethal blocker requirement');
  assert.strictEqual(dist.playerTrampleDamage, 5, 'Remaining 5 damage tramples directly to defending player!');
});

it('TC-COMBAT-08: Protection Damage Prevention to 0 (CR 702.16e)', () => {
  const tsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const p2 = tsm.getPlayer('p2');
  p2.resources.life = 20;

  const res = tsm.dealDamage({
    sourceId: 'red_source',
    sourceControllerId: 'p1',
    targetId: 'p2',
    targetType: 'PLAYER',
    amount: 6,
    keywords: { protectionBlocked: true }
  });

  assert.strictEqual(res.damageDealt, 0);
  assert.strictEqual(res.prevented, true);
  assert.strictEqual(p2.resources.life, 20, 'Protected target takes 0 damage');
});

it('TC-COMBAT-09: Indestructible Lethal Damage Destruction Immunity (CR 702.12 vs CR 704.5g)', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');
  const indestructibleGolem = {
    instanceId: 'golem_indestructible',
    name: 'Blightsteel',
    power: 11,
    toughness: 11,
    damageMarked: 0,
    isIndestructible: true,
    keywords: { indestructible: true },
    zone: 'battlefield'
  };
  p1.battlefield.creatures.push(indestructibleGolem);

  // Deal 15 damage (lethal!)
  tsm.dealDamage({
    sourceId: 'bolt_barrage',
    targetId: 'golem_indestructible',
    targetType: 'CREATURE',
    amount: 15
  });

  assert.strictEqual(p1.battlefield.creatures.length, 1, 'Indestructible creature must not be destroyed by lethal damage');
  assert.strictEqual(p1.battlefield.creatures[0].damageMarked, 15, 'Damage is marked but does not destroy it');
});

it('TC-COMBAT-10: Indestructible Dies to Zero Toughness (CR 704.5f vs CR 704.5g, INV-STATIC-SBA-1)', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');

  // Register static -1/-1 effect (Layer 7c)
  tsm.abilityEngine.registerStaticEffect({
    id: 'static_debuff',
    sourceId: 'enchantment_1',
    layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
    powerMod: -1,
    toughnessMod: -1
  });

  // Indestructible 1/1 enters battlefield
  const myr = {
    instanceId: 'darksteel_myr_1',
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
  p1.battlefield.creatures.push(myr);

  // Run SBA check loop
  const sba = tsm.runSBACheck();
  assert.strictEqual(sba.totalActionsApplied, 1);
  assert.strictEqual(sba.actions[0].type, 'CREATURE_DIED_ZERO_TOUGHNESS');
  assert.strictEqual(sba.actions[0].rule, 'CR 704.5f');
  assert.strictEqual(sba.actions[0].bypassedIndestructible, true);
  assert.strictEqual(p1.battlefield.creatures.length, 0, 'Indestructible 1/1 MUST die to 0 toughness');
  assert.strictEqual(p1.graveyard.length, 1, 'Creature is put into graveyard');
});

it('TC-COMBAT-11: First Strike / Double Strike Combat Distribution (CR 702.7 & CR 702.4)', () => {
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'] });
  assert.strictEqual(psm.phaseSteps.includes('FIRST_STRIKE_DAMAGE'), false);

  psm.enableFirstStrikeStep();
  assert.strictEqual(psm.phaseSteps.includes('FIRST_STRIKE_DAMAGE'), true);
  const fsIdx = psm.phaseSteps.indexOf('FIRST_STRIKE_DAMAGE');
  const regIdx = psm.phaseSteps.indexOf('COMBAT_DAMAGE');
  assert.strictEqual(fsIdx < regIdx, true, 'First strike damage step must precede regular combat damage');
});

it('TC-COMBAT-12: Cleanup Step Marked Damage Purge Loop (CR 514.2)', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');
  p1.battlefield.creatures.push({
    instanceId: 'wounded_1',
    name: 'Tough Wall',
    typeLine: 'Creature — Wall',
    power: 0,
    toughness: 10,
    damageMarked: 7,
    hasDeathtouchDamageMarked: true
  });

  tsm.handleCleanupStep('p1');
  assert.strictEqual(p1.battlefield.creatures[0].damageMarked, 0, 'Damage marked must be purged to 0 in cleanup');
  assert.strictEqual(p1.battlefield.creatures[0].hasDeathtouchDamageMarked, false);
});

console.log('\n==================================================================');
console.log(`  FEATURE 20 TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log('==================================================================\n');

if (failed > 0) {
  process.exit(1);
}
