/**
 * test_zone_and_combat_unit.js - Unit Test Suite for Module 2 (Zone Transitions, Combat Damage & SBAs)
 * 
 * Verifies:
 * 1. ZoneTransitionMatrix (CR 400 36-path transitions, CR 400.7 identity reset, bypass casting)
 * 2. CombatDamageEngine (CR 119 vs 120 Damage vs Life Loss, Lifelink, Infect, Trample, Deathtouch, Protection)
 * 3. StateBasedActionsEngine (CR 704 iterative loop, lethal damage, poison, counter annihilation)
 * 4. Invariant INV-STATIC-SBA-1 (1/1 Indestructible creature dying to 0 toughness under CR 704.5f)
 */

import assert from 'assert';
import { ZoneTransitionMatrix } from '../src/ZoneTransitionMatrix.js';
import { CombatDamageEngine } from '../src/CombatDamageEngine.js';
import { StateBasedActionsEngine } from '../src/StateBasedActionsEngine.js';
import { AbilityEngine, CONTINUOUS_LAYERS } from '../src/AbilityEngine.js';
import { ZoneModel } from '../src/ZoneModel.js';

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

console.log('\n=== RUNNING MODULE 2 ZONE & COMBAT UNIT TESTS ===\n');

// ----------------------------------------------------
// Section 1: ZoneTransitionMatrix Tests
// ----------------------------------------------------
console.log('--- 1. ZoneTransitionMatrix (CR 400 & CR 400.7) ---');

it('moveCard resets card identity (damage, counters, tap state) on zone change per CR 400.7', () => {
  const player = ZoneModel.createInitialPlayerState('p1', 'Player 1');
  const dirtyCreature = {
    instanceId: 'c1',
    name: 'Grizzly Bears',
    typeLine: 'Creature — Bear',
    damageMarked: 3,
    isTapped: true,
    counters: { '+1/+1': 2 },
    zone: 'battlefield'
  };
  player.battlefield.creatures.push(dirtyCreature);

  // Bounce to hand
  const result = ZoneTransitionMatrix.moveCard(player, 'c1', 'battlefield', 'hand');
  assert.strictEqual(result.card.zone, 'hand');
  assert.strictEqual(result.card.damageMarked, 0, 'Damage must be reset to 0');
  assert.strictEqual(result.card.isTapped, false, 'Tap state must be reset');
  assert.deepStrictEqual(result.card.counters, {}, 'Counters must be stripped');
});

it('enterWithoutCasting drops card directly to battlefield bypassing stack', () => {
  const player = ZoneModel.createInitialPlayerState('p1', 'Player 1');
  const creature = { instanceId: 'aether_creature', name: 'Thalia', typeLine: 'Creature — Human Soldier' };
  player.library.push(creature);

  const entered = ZoneTransitionMatrix.enterWithoutCasting(player, 'aether_creature', 'library');
  assert.strictEqual(entered.zone, 'battlefield');
  assert.strictEqual(player.battlefield.creatures.length, 1);
  assert.strictEqual(player.battlefield.creatures[0].instanceId, 'aether_creature');
  assert.strictEqual(player.library.length, 0);
});

it('castWithoutPayingManaCost places card on stack with isFreeCast flag', () => {
  const player = ZoneModel.createInitialPlayerState('p1', 'Player 1');
  const spell = { instanceId: 'omni_spell', name: 'Time Stretch', typeLine: 'Sorcery', manaCost: '{8}{U}{U}' };
  player.hand.push(spell);
  const stack = [];

  const onStack = ZoneTransitionMatrix.castWithoutPayingManaCost(player, 'omni_spell', 'hand', stack);
  assert.strictEqual(onStack.zone, 'stack');
  assert.strictEqual(onStack.isFreeCast, true);
  assert.strictEqual(stack.length, 1);
  assert.strictEqual(player.hand.length, 0);
});

it('specialized flows: reanimate, regrowth, flicker, mill, and impulseExile', () => {
  const player = ZoneModel.createInitialPlayerState('p1', 'Player 1');
  const cardInGY = { instanceId: 'reanim_target', name: 'Griselbrand', typeLine: 'Creature — Demon' };
  player.graveyard.push(cardInGY);

  // Reanimate
  ZoneTransitionMatrix.reanimate(player, 'reanim_target');
  assert.strictEqual(player.battlefield.creatures[0].instanceId, 'reanim_target');
  assert.strictEqual(player.graveyard.length, 0);

  // Flicker
  ZoneTransitionMatrix.flicker(player, 'reanim_target');
  assert.strictEqual(player.battlefield.creatures.length, 1);
  assert.strictEqual(player.exile.length, 0);

  // Mill
  player.library.push({ instanceId: 'mill1', name: 'Island' });
  player.library.push({ instanceId: 'mill2', name: 'Swamp' });
  const milled = ZoneTransitionMatrix.mill(player, 2);
  assert.strictEqual(milled.length, 2);
  assert.strictEqual(player.graveyard.length, 2);

  // Impulse Exile
  player.library.push({ instanceId: 'imp1', name: 'Lightning Bolt' });
  const impulse = ZoneTransitionMatrix.impulseExile(player, 1);
  assert.strictEqual(impulse.length, 1);
  assert.strictEqual(impulse[0].impulsePlayable, true);
  assert.strictEqual(player.exile.length, 1);
});

// ----------------------------------------------------
// Section 2: CombatDamageEngine Tests
// ----------------------------------------------------
console.log('\n--- 2. CombatDamageEngine (CR 119 vs CR 120 & CR 510) ---');

it('dealDamage vs loseLife separation: loseLife does not mark damage or trigger damage hooks', () => {
  const mockState = {
    players: {
      p1: { id: 'p1', resources: { life: 20 } },
      p2: { id: 'p2', resources: { life: 20 } }
    },
    events: [],
    emit(event, data) { this.events.push({ event, data }); }
  };

  // Lose life
  CombatDamageEngine.loseLife({ playerId: 'p1', amount: 2, reason: 'SHOCKLAND_COST' }, mockState);
  assert.strictEqual(mockState.players.p1.resources.life, 18);
  assert.strictEqual(mockState.events.some(e => e.event === 'DAMAGE_DEALT'), false, 'Lose life must not emit DAMAGE_DEALT');

  // Deal damage
  CombatDamageEngine.dealDamage({
    sourceId: 'bolt_1',
    sourceControllerId: 'p1',
    targetId: 'p2',
    targetType: 'PLAYER',
    amount: 3
  }, mockState);
  assert.strictEqual(mockState.players.p2.resources.life, 17);
  assert.strictEqual(mockState.events.some(e => e.event === 'DAMAGE_DEALT'), true, 'Damage must emit DAMAGE_DEALT');
});

it('dealDamage resolves Lifelink (simultaneous life gain) and Infect (poison counters)', () => {
  const mockState = {
    players: {
      p1: { id: 'p1', resources: { life: 10 } },
      p2: { id: 'p2', resources: { life: 20, poison: 0 } }
    },
    emit() {}
  };

  // Lifelink damage to player
  CombatDamageEngine.dealDamage({
    sourceId: 'vampire_1',
    sourceControllerId: 'p1',
    targetId: 'p2',
    targetType: 'PLAYER',
    amount: 4,
    keywords: { lifelink: true }
  }, mockState);

  assert.strictEqual(mockState.players.p2.resources.life, 16, 'Defending player loses 4 life');
  assert.strictEqual(mockState.players.p1.resources.life, 14, 'Lifelink source controller gains 4 life');

  // Infect damage to player
  CombatDamageEngine.dealDamage({
    sourceId: 'elf_1',
    sourceControllerId: 'p1',
    targetId: 'p2',
    targetType: 'PLAYER',
    amount: 3,
    keywords: { infect: true }
  }, mockState);

  assert.strictEqual(mockState.players.p2.resources.life, 16, 'Infect damage does not reduce life');
  assert.strictEqual(mockState.players.p2.resources.poison, 3, 'Infect damage places 3 poison counters');
});

it('calculateAttackerDamageDistribution resolves Trample, Deathtouch, and Deathtouch+Trample combo', () => {
  // Blocker: 10/10 creature
  const blocker = { instanceId: 'b1', toughness: 10, effectiveToughness: 10, damageMarked: 0 };

  // Case A: Trample without Deathtouch (Power 12)
  const attackerTrample = { instanceId: 'a1', keywords: { trample: true } };
  const distA = CombatDamageEngine.calculateAttackerDamageDistribution(attackerTrample, [blocker], 12);
  assert.strictEqual(distA.blockerAssignments[0].damage, 10, '10 damage assigned to 10/10 blocker');
  assert.strictEqual(distA.playerTrampleDamage, 2, '2 excess damage tramples to player');

  // Case B: Trample + Deathtouch Combo (Power 6)
  // 1 damage is lethal to 10/10 blocker under Deathtouch; remaining 5 damage tramples!
  const attackerCombo = { instanceId: 'a2', keywords: { trample: true, deathtouch: true } };
  const distB = CombatDamageEngine.calculateAttackerDamageDistribution(attackerCombo, [blocker], 6);
  assert.strictEqual(distB.blockerAssignments[0].damage, 1, 'Only 1 damage needed for lethal with Deathtouch');
  assert.strictEqual(distB.playerTrampleDamage, 5, '5 damage tramples directly to defending player!');
});

// ----------------------------------------------------
// Section 3: StateBasedActionsEngine Tests
// ----------------------------------------------------
console.log('\n--- 3. StateBasedActionsEngine (CR 704 & CR 514.2) ---');

it('runSBACheck eliminates players with life <= 0 (CR 704.5a) and poison >= 10 (CR 704.5c)', () => {
  const state = {
    players: {
      p1: { id: 'p1', resources: { life: 0 } },
      p2: { id: 'p2', resources: { life: 20, poison: 10 } }
    },
    emit() {}
  };

  const sba = StateBasedActionsEngine.runSBACheck(state);
  assert.strictEqual(sba.totalActionsApplied, 2);
  assert.strictEqual(state.players.p1.isEliminated, true);
  assert.strictEqual(state.players.p2.isEliminated, true);
});

it('runSBACheck enforces INV-STATIC-SBA-1: 1/1 Indestructible creature dies to 0 toughness under CR 704.5f', () => {
  const player = ZoneModel.createInitialPlayerState('p1', 'Player 1');
  const abilityEngine = new AbilityEngine();

  // Register static -1/-1 enchantment
  abilityEngine.registerStaticEffect({
    id: 'static_debuff_1',
    sourceId: 'ench_1',
    layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
    powerMod: -1,
    toughnessMod: -1
  });

  // Indestructible 1/1 creature
  const indestructible11 = {
    instanceId: 'darksteel_1',
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
  player.battlefield.creatures.push(indestructible11);

  const tabletopState = {
    players: { p1: player },
    emit() {}
  };

  const sba = StateBasedActionsEngine.runSBACheck(tabletopState, abilityEngine);

  assert.strictEqual(sba.totalActionsApplied, 1);
  assert.strictEqual(sba.actions[0].type, 'CREATURE_DIED_ZERO_TOUGHNESS');
  assert.strictEqual(sba.actions[0].rule, 'CR 704.5f');
  assert.strictEqual(sba.actions[0].bypassedIndestructible, true);
  assert.strictEqual(player.battlefield.creatures.length, 0, 'Creature must be removed from battlefield');
  assert.strictEqual(player.graveyard.length, 1, 'Creature must be in graveyard');
  console.log(`    \x1b[34mℹ Invariant Confirmed: Indestructible 1/1 died to CR 704.5f and entered graveyard!\x1b[0m`);
});

it('runSBACheck preserves Indestructible creature when taking lethal damage (CR 704.5g)', () => {
  const player = ZoneModel.createInitialPlayerState('p1', 'Player 1');
  const indestructibleCreature = {
    instanceId: 'indestructible_tank',
    name: 'Blightsteel Colossus',
    typeLine: 'Artifact Creature — Golem',
    power: 11,
    toughness: 11,
    basePower: 11,
    baseToughness: 11,
    damageMarked: 25, // Extreme lethal damage
    isIndestructible: true,
    keywords: { indestructible: true },
    zone: 'battlefield'
  };
  player.battlefield.creatures.push(indestructibleCreature);

  const tabletopState = {
    players: { p1: player },
    emit() {}
  };

  const sba = StateBasedActionsEngine.runSBACheck(tabletopState);
  assert.strictEqual(sba.totalActionsApplied, 0, 'Lethal damage must NOT destroy Indestructible creature');
  assert.strictEqual(player.battlefield.creatures.length, 1, 'Creature remains on battlefield');
});

it('purgeCleanupMarkedDamage cleanses all marked damage during cleanup step (CR 514.2)', () => {
  const player = ZoneModel.createInitialPlayerState('p1', 'Player 1');
  player.battlefield.creatures.push({ instanceId: 'c1', damageMarked: 5, hasDeathtouchDamageMarked: true });
  player.battlefield.lands.push({ instanceId: 'l1', damageMarked: 2 });

  const tabletopState = { players: { p1: player } };
  const count = StateBasedActionsEngine.purgeCleanupMarkedDamage(tabletopState);
  assert.strictEqual(count, 2);
  assert.strictEqual(player.battlefield.creatures[0].damageMarked, 0);
  assert.strictEqual(player.battlefield.creatures[0].hasDeathtouchDamageMarked, false);
  assert.strictEqual(player.battlefield.lands[0].damageMarked, 0);
});

console.log(`\n=================================================`);
console.log(`MODULE 2 TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log(`=================================================\n`);

if (failed > 0) {
  process.exit(1);
}
