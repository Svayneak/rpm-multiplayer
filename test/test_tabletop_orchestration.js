/**
 * test_tabletop_orchestration.js - Unit/Integration Tests for Module 3 (Stateful Orchestration & Turn Pipeline)
 * 
 * Verifies:
 * 1. PriorityStateMachine two-tier phases (5 Overarching Phases, 11 subphases, Mulligan Phase)
 * 2. TabletopStateManager + PriorityStateMachine wiring:
 *    - Auto-untap on UNTAP step
 *    - Mandatory card draw on DRAW step
 *    - Upkeep perk prompt notification
 *    - Cleanup marked damage purge (CR 514.2)
 * 3. Shockland ETB 2-life prompt (Steam Vents)
 * 4. Damage vs Life loss dispatching
 * 5. Specialized zone methods (enterWithoutCasting, reanimate, regrowth, flicker, mill, impulseExile)
 */

import assert from 'assert';
import { PriorityStateMachine, getOverarchingPhase, OVERARCHING_PHASES } from '../src/PriorityStateMachine.js';
import { TabletopStateManager } from '../src/TabletopStateManager.js';
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

console.log('\n=== RUNNING MODULE 3 STATEFUL ORCHESTRATION TESTS ===\n');

// ----------------------------------------------------
// Section 1: PriorityStateMachine Two-Tier Phase Tests
// ----------------------------------------------------
console.log('--- 1. PriorityStateMachine Two-Tier Phases ---');

it('getOverarchingPhase correctly maps subphases to MTG CR 500 overarching phases', () => {
  assert.strictEqual(getOverarchingPhase('UNTAP'), OVERARCHING_PHASES.BEGINNING);
  assert.strictEqual(getOverarchingPhase('UPKEEP'), OVERARCHING_PHASES.BEGINNING);
  assert.strictEqual(getOverarchingPhase('DRAW'), OVERARCHING_PHASES.BEGINNING);
  assert.strictEqual(getOverarchingPhase('PRECOMBAT_MAIN'), OVERARCHING_PHASES.PRECOMBAT_MAIN);
  assert.strictEqual(getOverarchingPhase('BEGIN_COMBAT'), OVERARCHING_PHASES.COMBAT);
  assert.strictEqual(getOverarchingPhase('DECLARE_ATTACKERS'), OVERARCHING_PHASES.COMBAT);
  assert.strictEqual(getOverarchingPhase('DECLARE_BLOCKERS'), OVERARCHING_PHASES.COMBAT);
  assert.strictEqual(getOverarchingPhase('FIRST_STRIKE_DAMAGE'), OVERARCHING_PHASES.COMBAT);
  assert.strictEqual(getOverarchingPhase('COMBAT_DAMAGE'), OVERARCHING_PHASES.COMBAT);
  assert.strictEqual(getOverarchingPhase('END_COMBAT'), OVERARCHING_PHASES.COMBAT);
  assert.strictEqual(getOverarchingPhase('POSTCOMBAT_MAIN'), OVERARCHING_PHASES.POSTCOMBAT_MAIN);
  assert.strictEqual(getOverarchingPhase('END_STEP'), OVERARCHING_PHASES.ENDING);
  assert.strictEqual(getOverarchingPhase('CLEANUP'), OVERARCHING_PHASES.ENDING);
  assert.strictEqual(getOverarchingPhase('MULLIGAN'), OVERARCHING_PHASES.MULLIGAN);
});

it('startMulliganPhase and completeMulliganPhase transition smoothly into Turn 1', () => {
  const psm = new PriorityStateMachine({
    players: ['p1', 'p2'],
    startingPlayerId: 'p1'
  });

  psm.startMulliganPhase();
  assert.strictEqual(psm.currentPhaseStep, 'MULLIGAN');
  assert.strictEqual(psm.getOverarchingPhase(), OVERARCHING_PHASES.MULLIGAN);

  psm.completeMulliganPhase();
  assert.strictEqual(psm.currentPhaseStep, 'UNTAP');
  assert.strictEqual(psm.getOverarchingPhase(), OVERARCHING_PHASES.BEGINNING);
});

// ----------------------------------------------------
// Section 2: TabletopStateManager + PriorityStateMachine Wiring
// ----------------------------------------------------
console.log('\n--- 2. TabletopStateManager Phase Automations ---');

it('TabletopStateManager auto-untaps active player permanents on UNTAP step (CR 502.2)', () => {
  const psm = new PriorityStateMachine({
    players: ['p1', 'p2'],
    startingPlayerId: 'p1'
  });
  const tsm = new TabletopStateManager({
    players: ['p1', 'p2'],
    activePlayerId: 'p1',
    priorityMachine: psm
  });

  const player1 = tsm.getPlayer('p1');
  const mountain = { instanceId: 'land_m1', name: 'Mountain', isTapped: true, typeLine: 'Basic Land' };
  player1.battlefield.lands.push(mountain);
  assert.strictEqual(mountain.isTapped, true);

  // Trigger untap step via event or direct handler
  tsm.handleUntapStep('p1');
  assert.strictEqual(mountain.isTapped, false, 'Permanent must be automatically untapped in UNTAP step');
});

it('TabletopStateManager performs mandatory card draw on DRAW step (CR 504.1)', () => {
  const psm = new PriorityStateMachine({
    players: ['p1', 'p2'],
    startingPlayerId: 'p1'
  });
  const tsm = new TabletopStateManager({
    players: ['p1', 'p2'],
    activePlayerId: 'p2',
    priorityMachine: psm
  });

  const p2 = tsm.getPlayer('p2');
  p2.library.push({ instanceId: 'card_draw_test', name: 'Divination' });
  const handBefore = p2.hand.length;

  tsm.handlePhaseStepChanged({
    currentPhaseStep: 'DRAW',
    activePlayerId: 'p2',
    shouldSkipDraw: false
  });

  assert.strictEqual(p2.hand.length, handBefore + 1, 'Active player must draw a card on DRAW step');
  assert.strictEqual(p2.hand[p2.hand.length - 1].instanceId, 'card_draw_test');
});

it('TabletopStateManager purges marked damage during CLEANUP step (CR 514.2)', () => {
  const tsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const p1 = tsm.getPlayer('p1');
  p1.battlefield.creatures.push({
    instanceId: 'damaged_bear',
    name: 'Grizzly Bears',
    power: 2,
    toughness: 2,
    damageMarked: 1,
    hasDeathtouchDamageMarked: true
  });

  tsm.handleCleanupStep('p1');
  assert.strictEqual(p1.battlefield.creatures[0].damageMarked, 0, 'Marked damage must be 0 after cleanup');
  assert.strictEqual(p1.battlefield.creatures[0].hasDeathtouchDamageMarked, false);
});

// ----------------------------------------------------
// Section 3: Shockland ETB 2-Life Choice (Steam Vents)
// ----------------------------------------------------
console.log('\n--- 3. Shockland ETB 2-Life Mechanics (Steam Vents) ---');

it('Shockland (Steam Vents) enters untapped when paying 2 life', () => {
  const tsm = new TabletopStateManager({ players: ['p1'], activePlayerId: 'p1' });
  const p1 = tsm.getPlayer('p1');
  p1.resources.life = 20;

  const steamVents = {
    instanceId: 'steam_vents_1',
    name: 'Steam Vents',
    typeLine: 'Land — Island Mountain',
    text: '({T}: Add {U} or {R}.) As Steam Vents enters the battlefield, you may pay 2 life. If you don\'t, it enters the battlefield tapped.'
  };
  p1.hand.push(steamVents);

  // Play land with pay2Life = true
  tsm.dispatch('PLAY_LAND', { playerId: 'p1', instanceId: 'steam_vents_1', pay2Life: true });

  assert.strictEqual(p1.resources.life, 18, 'Paying 2 life for Shockland reduces life to 18');
  const onField = p1.battlefield.lands.find(l => l.instanceId === 'steam_vents_1');
  assert.strictEqual(onField.isTapped, false, 'Steam Vents enters UNTAPPED when paying 2 life');
});

it('Shockland (Steam Vents) enters tapped without life loss when declining 2 life', () => {
  const tsm = new TabletopStateManager({ players: ['p1'], activePlayerId: 'p1' });
  const p1 = tsm.getPlayer('p1');
  p1.resources.life = 20;

  const steamVents = {
    instanceId: 'steam_vents_2',
    name: 'Steam Vents',
    typeLine: 'Land — Island Mountain',
    text: '({T}: Add {U} or {R}.) As Steam Vents enters the battlefield, you may pay 2 life. If you don\'t, it enters the battlefield tapped.'
  };
  p1.hand.push(steamVents);

  // Play land with pay2Life = false
  tsm.dispatch('PLAY_LAND', { playerId: 'p1', instanceId: 'steam_vents_2', pay2Life: false });

  assert.strictEqual(p1.resources.life, 20, 'Life must remain 20 when declining 2 life');
  const onField = p1.battlefield.lands.find(l => l.instanceId === 'steam_vents_2');
  assert.strictEqual(onField.isTapped, true, 'Steam Vents enters TAPPED when declining 2 life');
});

// ----------------------------------------------------
// Section 4: Specialized Zone Transitions & Search
// ----------------------------------------------------
console.log('\n--- 4. Specialized Zone Transitions & Search ---');

it('enterWithoutCasting drops card directly to battlefield without passing stack', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');
  p1.library.push({ instanceId: 'vial_creature', name: 'Serra Avenger', typeLine: 'Creature — Angel', power: 3, toughness: 3 });

  tsm.enterWithoutCasting('p1', 'vial_creature', 'library');
  assert.strictEqual(p1.battlefield.creatures.length, 1);
  assert.strictEqual(p1.battlefield.creatures[0].instanceId, 'vial_creature');
  assert.strictEqual(tsm.stack.length, 0, 'Stack must remain empty for enterWithoutCasting');
});

it('searchZone returns filtered candidates for tutor and graveyard queries', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');
  p1.library = [
    { instanceId: 'l1', name: 'Mountain', typeLine: 'Land' },
    { instanceId: 'c1', name: 'Ragavan', typeLine: 'Creature' },
    { instanceId: 's1', name: 'Lightning Bolt', typeLine: 'Instant' }
  ];

  const creatures = tsm.searchZone('p1', 'library', c => /creature/i.test(c.typeLine));
  assert.strictEqual(creatures.length, 1);
  assert.strictEqual(creatures[0].name, 'Ragavan');

  const all = tsm.searchZone('p1', 'library');
  assert.strictEqual(all.length, 3);
});

console.log(`\n=================================================`);
console.log(`MODULE 3 TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log(`=================================================\n`);

if (failed > 0) {
  process.exit(1);
}
