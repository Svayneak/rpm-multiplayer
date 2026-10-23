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

  const res = tsm.enterWithoutCasting('p1', 'vial_creature', 'library');
  assert.strictEqual(p1.battlefield.creatures.length, 1);
  assert.strictEqual(p1.battlefield.creatures[0].instanceId, res.card.instanceId);
  assert.strictEqual(p1.battlefield.creatures[0].lineageId, 'vial_creature');
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

// ------------------------------------------------------------------
// Section: CR 400.7 Zone Transition & Idempotency Tests
// ------------------------------------------------------------------
console.log('--- CR 400.7 Zone Transition & Idempotency ---');

it('CR 400.7: creature resolving from stack arrives on battlefield with counters reset and new instanceId', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');

  const creatureOnStack = {
    instanceId: 'grizzly_001',
    name: 'Grizzly Bears',
    typeLine: 'Creature — Bear',
    power: 2,
    toughness: 2,
    ownerId: 'p1',
    controllerId: 'p1',
    counters: { '+1/+1': 2 },
    damageMarked: 3,
    grantedAbilities: ['hexproof'],
    isTapped: true,
    zone: 'stack'
  };

  // Place card on the internal stack
  tsm.stack.push(creatureOnStack);
  assert.strictEqual(tsm.stack.length, 1, 'Stack should have 1 item');

  const result = tsm.handleStackResolution({ card: creatureOnStack, controllerId: 'p1' });

  // Card should be on the battlefield
  assert.ok(result, 'handleStackResolution should return a result');
  assert.strictEqual(result.destinationZone, 'battlefield');
  assert.strictEqual(result.destinationSubzone, 'creatures');

  // Stack should be empty
  assert.strictEqual(tsm.stack.length, 0, 'Stack must be empty after resolution');

  // The card on the battlefield must have a NEW instanceId (CR 400.7 — new game object)
  const bf = p1.battlefield.creatures;
  assert.strictEqual(bf.length, 1, 'Exactly 1 creature on battlefield');
  const resolved = bf[0];
  assert.notStrictEqual(resolved.instanceId, 'grizzly_001', 'instanceId must change after zone transition');
  assert.ok(resolved.instanceId.includes('grizzly_001'), 'New instanceId should carry lineage');

  // Counters must be reset (CR 400.7 — no state carries across zones)
  assert.deepStrictEqual(resolved.counters, {}, 'Counters must be reset to {} on zone change');
  assert.strictEqual(resolved.damageMarked, 0, 'Damage must be cleared');
  assert.deepStrictEqual(resolved.grantedAbilities, [], 'Granted abilities must be cleared');
});

it('Idempotency: calling handleStackResolution twice with the same item produces exactly 1 creature', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');

  const creature = {
    instanceId: 'bear_002',
    name: 'Runeclaw Bear',
    typeLine: 'Creature — Bear',
    power: 2,
    toughness: 2,
    ownerId: 'p1',
    controllerId: 'p1',
    counters: {},
    zone: 'stack'
  };

  tsm.stack.push(creature);

  const resolvedPayload = { card: creature, controllerId: 'p1' };

  // First call — should resolve normally
  const result1 = tsm.handleStackResolution(resolvedPayload);
  assert.ok(result1, 'First call should return a result');
  assert.strictEqual(p1.battlefield.creatures.length, 1, 'Exactly 1 creature after first call');
  assert.strictEqual(tsm.stack.length, 0, 'Stack empty after first call');

  // Second call — item is no longer on the stack; should be a no-op
  const result2 = tsm.handleStackResolution(resolvedPayload);
  assert.strictEqual(result2, null, 'Second call must return null (idempotent)');
  assert.strictEqual(p1.battlefield.creatures.length, 1, 'Still exactly 1 creature after second call');
});

it('Instant spell resolves to graveyard with identity reset', () => {
  const tsm = new TabletopStateManager({ players: ['p1'] });
  const p1 = tsm.getPlayer('p1');

  const instant = {
    instanceId: 'bolt_001',
    name: 'Lightning Bolt',
    typeLine: 'Instant',
    ownerId: 'p1',
    controllerId: 'p1',
    counters: { 'charge': 1 },
    zone: 'stack'
  };

  tsm.stack.push(instant);
  const result = tsm.handleStackResolution({ card: instant, controllerId: 'p1' });

  assert.ok(result, 'Should return a result');
  assert.strictEqual(result.destinationZone, 'graveyard');
  assert.strictEqual(p1.graveyard.length, 1);
  assert.notStrictEqual(p1.graveyard[0].instanceId, 'bolt_001', 'instanceId must change for graveyard');
  assert.deepStrictEqual(p1.graveyard[0].counters, {}, 'Counters must be reset');
});

it('End-to-End: casting a creature spell and resolving via PriorityStateMachine.resolveTop() puts creature on battlefield', () => {
  const psm = new PriorityStateMachine({
    players: ['p1', 'p2'],
    startingPlayerId: 'p1'
  });
  const tsm = new TabletopStateManager({
    players: ['p1', 'p2'],
    activePlayerId: 'p1',
    priorityMachine: psm
  });
  psm.tabletopState = tsm;
  tsm.priorityMachine = psm;
  psm.currentPhaseStep = 'PRECOMBAT_MAIN';
  psm.priorityPlayerId = 'p1';
  psm.activePlayerId = 'p1';

  const p1 = tsm.getPlayer('p1');
  const creatureCard = {
    instanceId: 'grizzly_bear_e2e_1',
    name: 'Grizzly Bears',
    typeLine: 'Creature — Bear',
    manaCost: '{1}{G}',
    power: 2,
    toughness: 2,
    controllerId: 'p1',
    ownerId: 'p1'
  };

  p1.hand.push(creatureCard);
  if (p1.zones?.hand) p1.zones.hand.push(creatureCard);
  p1.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 2, C: 0 };

  // 1. Cast creature spell
  tsm.castSpell('p1', 'grizzly_bear_e2e_1');

  // Verify it exists on stack
  assert.strictEqual(tsm.stack.length, 1, 'TSM stack must contain the cast creature spell');
  assert.strictEqual(psm.stack.length, 1, 'PSM stack must contain the cast creature spell');

  // 2. Resolve via PriorityStateMachine.resolveTop()
  const resolved = psm.resolveTop();
  assert.ok(resolved, 'resolveTop must return resolved item');

  // 3. Verify final state per CR 608.2 / CR 400.7
  assert.strictEqual(tsm.stack.length, 0, 'TSM stack must be empty after resolution');
  assert.strictEqual(psm.stack.length, 0, 'PSM stack must be empty after resolution');
  assert.strictEqual(p1.battlefield.creatures.length, 1, 'player.battlefield.creatures.length must be exactly 1');
  assert.strictEqual(p1.battlefield.creatures[0].name, 'Grizzly Bears');
  assert.strictEqual(p1.battlefield.creatures[0].power, 2);
  assert.strictEqual(p1.battlefield.creatures[0].toughness, 2);
  // 4. Verify that casting a creature with residual targets does NOT falsely fizzle (CR 302.1 / CR 608.2b)
  const bearCard2 = {
    instanceId: 'grizzly_bear_e2e_2',
    name: 'Grizzly Bears',
    typeLine: 'Creature — Bear',
    manaCost: '{1}{G}',
    power: 2,
    toughness: 2,
    controllerId: 'p1',
    ownerId: 'p1'
  };
  p1.hand.push(bearCard2);
  p1.resources.manaPool.G = 2;

  tsm.castSpell('p1', 'grizzly_bear_e2e_2', { targets: ['some_illegal_stale_target_id'] });
  assert.strictEqual(tsm.stack.length, 1);
  const resolved2 = psm.resolveTop();
  assert.ok(resolved2);
  assert.strictEqual(p1.battlefield.creatures.length, 2, 'Creature with residual targets must resolve to battlefield without fizzling');
});

// ----------------------------------------------------
// Section 5: Turn Sequence, Second Player Draw & Damage
// ----------------------------------------------------
console.log('\n--- 5. Second Player Draw & Spell Damage Integration ---');

it('CR 103.7a & CR 103.8a: Player 1 skips draw on Turn 1; Player 2 draws on Turn 2 increasing hand from 7 to 8', () => {
  const psm = new PriorityStateMachine({
    players: ['p1', 'p2'],
    startingPlayerId: 'p1'
  });
  const tsm = new TabletopStateManager({
    players: ['p1', 'p2'],
    activePlayerId: 'p1',
    startingPlayerId: 'p1',
    priorityMachine: psm
  });
  psm.tabletopState = tsm;
  tsm.priorityMachine = psm;

  const p1 = tsm.getPlayer('p1');
  const p2 = tsm.getPlayer('p2');

  for (let i = 1; i <= 7; i++) {
    p1.hand.push({ instanceId: `p1_h_${i}`, name: `Card ${i}` });
    p2.hand.push({ instanceId: `p2_h_${i}`, name: `Card ${i}` });
  }
  for (let i = 1; i <= 20; i++) {
    p1.library.push({ instanceId: `p1_lib_${i}`, name: `Lib ${i}` });
    p2.library.push({ instanceId: `p2_lib_${i}`, name: `Lib ${i}` });
  }

  assert.strictEqual(p1.hand.length, 7);
  assert.strictEqual(p2.hand.length, 7);

  // Turn 1: P1 advances to DRAW step -> skips draw per CR 103.7a
  psm.setPhaseStep('DRAW');
  assert.strictEqual(p1.hand.length, 7, 'P1 must skip Turn 1 draw in 1v1');

  // P1 finishes turn -> advance to Turn 2 (P2's turn)
  psm.setPhaseStep('CLEANUP');
  psm.advanceStep(); // advances to P2's turn UNTAP

  assert.strictEqual(psm.activePlayerId, 'p2');
  assert.strictEqual(psm.turnNumber, 2);

  // Advancing nextPhase from UNTAP towards MAIN 1 must run DRAW hook
  psm.nextPhase('p2');
  assert.strictEqual(psm.currentPhaseStep, 'PRECOMBAT_MAIN', 'nextPhase from UNTAP must reach PRECOMBAT_MAIN');
  assert.strictEqual(p2.hand.length, 8, 'P2 hand must increase from 7 to 8 on their first turn');
});

it('Deal Damage Effect (Lava Spike / Lightning Bolt): Resolving without explicit target in 1v1 damages opponent and notifies subscribers', () => {
  const psm = new PriorityStateMachine({
    players: ['p1', 'p2'],
    startingPlayerId: 'p1'
  });
  const tsm = new TabletopStateManager({
    players: ['p1', 'p2'],
    activePlayerId: 'p1',
    startingPlayerId: 'p1',
    priorityMachine: psm
  });
  psm.tabletopState = tsm;
  tsm.priorityMachine = psm;

  let subscriberNotified = false;
  let notifiedLife = null;
  tsm.subscribe((evt) => {
    if (evt?.actionType === 'DAMAGE_DEALT') {
      subscriberNotified = true;
      notifiedLife = evt?.result?.newLife ?? evt?.payload?.newLife;
    }
  });

  const p2 = tsm.getPlayer('p2');
  p2.resources.life = 20;

  const lavaSpike = {
    instanceId: 'lava_spike_01',
    name: 'Lava Spike',
    typeLine: 'Sorcery — Arcane',
    effect: { type: 'DEAL_DAMAGE', amount: 3 },
    controllerId: 'p1',
    ownerId: 'p1'
  };

  tsm.stack.push(lavaSpike);
  const result = tsm.handleStackResolution({ card: lavaSpike, controllerId: 'p1' });

  assert.ok(result);
  assert.strictEqual(p2.resources.life, 17, 'Opponent life must drop from 20 to 17');
  assert.strictEqual(subscriberNotified, true, '_notifySubscribers must be invoked on spell damage');
  assert.strictEqual(notifiedLife, 17);
});

console.log(`\n=================================================`);
console.log(`MODULE 3 TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log(`=================================================\n`);

if (failed > 0) {
  process.exit(1);
}
