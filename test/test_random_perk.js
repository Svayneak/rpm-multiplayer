/**
 * Acceptance & Verification Test Suite for Feature 9: Random Perk Upkeep Emblem & Two-Step Stack Flow
 * Specification: SPEC-RPM-PERK-009
 * 
 * Validates all 14 Acceptance Test Vectors:
 * - VEC-01: Command Zone Emblem Presence
 * - VEC-02: Turn Scaling 1v1 (Turn 4 unlock)
 * - VEC-03: Turn Scaling 3+ Players (Turn 2 unlock)
 * - VEC-04: Turn Scaling Immutability after Mid-Game Elimination
 * - VEC-05: Step 1 Stack Placement & 15s Stack Alarm
 * - VEC-06: Authoritative CSPRNG Roll & Injected Deterministic PRNG
 * - VEC-07: Roll Miss & Zero Stack Push
 * - VEC-08: CR 603.3d Target Legality Guard (Empty Board Fizzle)
 * - VEC-09: Step 2 Stack Push with Declared Targets & Alarm
 * - VEC-10: Step 2 Resolution & State Mutation (Perk #55)
 * - VEC-11: CR 608.2c Partial Execution on Perk #13
 * - VEC-12: Birthday Match (RPBD) Resolution
 * - VEC-13: APNAP Trigger Ordering
 * - VEC-14: Engine Teardown & Event Listener Cleanup
 */

import assert from 'node:assert/strict';
import {
  TabletopStateManager,
  PriorityStateMachine,
  StackAlarmManager,
  PerkCatalog,
  RandomPerkEngine,
  PERK_KEYS,
  RPBD_OPTIONS,
  getPerkDefinition,
  resolveRoll,
  hasLegalTargets,
  getLegalTargets,
  executePerkEffect,
  executeAuthoritativeRoll
} from '../src/index.js';

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(err);
    failed++;
  }
}

console.log('=== RUNNING FEATURE 9: RANDOM PERK ACCEPTANCE TEST SUITE (SPEC-RPM-PERK-009) ===\n');

// -------------------------------------------------------------------------------------------------
// VEC-01: Command Zone Emblem Presence (INV-PERK-7)
// -------------------------------------------------------------------------------------------------
runTest('VEC-01: Command Zone Emblem Presence (INV-PERK-7)', () => {
  const ttsm = new TabletopStateManager({
    players: ['p1', 'p2', 'p3', 'p4']
  });
  const psm = new PriorityStateMachine({
    players: ['p1', 'p2', 'p3', 'p4'],
    activePlayerId: 'p1'
  });

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 4
  });

  // Verify Emblem in Command Zone on TabletopStateManager
  assert.ok(Array.isArray(ttsm.commandZone), 'TabletopStateManager should have commandZone array');
  const emblem = ttsm.commandZone.find(e => e.id === 'emblem_random_perk');
  assert.ok(emblem, 'Emblem must exist in Command Zone');
  assert.equal(emblem.type, 'EMBLEM');
  assert.equal(emblem.name, 'Random Perk Emblem');
  assert.equal(emblem.zone, 'command');
  assert.equal(emblem.isStatic, true);
  assert.equal(emblem.isIndestructible, true);

  // Verify players also reflect the command zone emblem
  assert.ok(ttsm.players.p1.commandZone.some(e => e.id === 'emblem_random_perk'));
  assert.equal(engine.isEmblemActive, true);

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-02: Turn Scaling 1v1 (Turn 4 unlock) (INV-PERK-4)
// -------------------------------------------------------------------------------------------------
runTest('VEC-02: Turn Scaling 1v1 (Turn 4 unlock) (INV-PERK-4)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2
  });

  // 1v1 must be anchored at Turn 4
  assert.equal(engine.perkUnlockTurn, 4, '1v1 matches must unlock at Turn 4');

  let dormantEvents = [];
  engine.on('PERK_EMBLEM_DORMANT', (e) => dormantEvents.push(e));

  // Turn 1 Upkeep -> Dormant
  psm.turnNumber = 1;
  psm.roundNumber = 1;
  psm.setPhaseStep('UPKEEP');
  assert.equal(psm.stack.length, 0, 'Stack must remain empty on Turn 1');
  assert.equal(dormantEvents.length, 1);
  assert.equal(dormantEvents[0].turnNumber, 1);

  // Turn 2 Upkeep -> Dormant
  psm.turnNumber = 2;
  psm.roundNumber = 2;
  psm.setPhaseStep('UPKEEP');
  assert.equal(psm.stack.length, 0, 'Stack must remain empty on Turn 2');
  assert.equal(dormantEvents.length, 2);

  // Turn 3 Upkeep -> Dormant
  psm.turnNumber = 3;
  psm.roundNumber = 3;
  psm.setPhaseStep('UPKEEP');
  assert.equal(psm.stack.length, 0, 'Stack must remain empty on Turn 3');
  assert.equal(dormantEvents.length, 3);

  // Turn 4 Upkeep -> Unlocks & triggers Step 1
  psm.turnNumber = 4;
  psm.roundNumber = 4;
  psm.setPhaseStep('UPKEEP');
  assert.equal(psm.stack.length, 1, 'Stack must receive Step 1 trigger on Turn 4');
  assert.equal(psm.stack[0].type, 'PERK_UPKEEP_TRIGGER');

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-03: Turn Scaling 3+ Players (Turn 2 unlock) (INV-PERK-4)
// -------------------------------------------------------------------------------------------------
runTest('VEC-03: Turn Scaling 3+ Players (Turn 2 unlock) (INV-PERK-4)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2', 'p3', 'p4'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2', 'p3', 'p4'], activePlayerId: 'p1' });

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 4
  });

  // 4-player Commander-style match must unlock at Turn 2
  assert.equal(engine.perkUnlockTurn, 2, '3+ player matches must unlock at Turn 2');

  let dormantCount = 0;
  engine.on('PERK_EMBLEM_DORMANT', () => dormantCount++);

  // Turn 1 Upkeep -> Dormant
  psm.turnNumber = 1;
  psm.roundNumber = 1;
  psm.setPhaseStep('UPKEEP');
  assert.equal(psm.stack.length, 0, 'Stack must remain empty on Turn 1');
  assert.equal(dormantCount, 1);

  // Turn 2 Upkeep -> Triggers Step 1
  psm.turnNumber = 2;
  psm.roundNumber = 2;
  psm.setPhaseStep('UPKEEP');
  assert.equal(psm.stack.length, 1, 'Stack must receive Step 1 trigger on Turn 2');
  assert.equal(psm.stack[0].type, 'PERK_UPKEEP_TRIGGER');

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-04: Turn Scaling Immutability after Mid-Game Elimination (INV-PERK-4)
// -------------------------------------------------------------------------------------------------
runTest('VEC-04: Turn Scaling Immutability after Mid-Game Elimination (INV-PERK-4)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2', 'p3', 'p4'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2', 'p3', 'p4'], activePlayerId: 'p1' });

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 4
  });

  assert.equal(engine.perkUnlockTurn, 2);

  // Mid-game elimination on Turn 1: 2 players eliminated, living count drops to 2
  ttsm.players.p3.isEliminated = true;
  ttsm.players.p4.isEliminated = true;

  // Verify perkUnlockTurn remains strictly 2 (immutable constant)
  assert.equal(engine.perkUnlockTurn, 2, 'Threshold must remain invariant when players drop mid-game');

  // Advance to Turn 2 Upkeep
  psm.turnNumber = 2;
  psm.roundNumber = 2;
  psm.setPhaseStep('UPKEEP');
  assert.equal(psm.stack.length, 1, 'Emblem must trigger on Turn 2 despite only 2 living players remaining');
  assert.equal(psm.stack[0].type, 'PERK_UPKEEP_TRIGGER');

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-05: Step 1 Stack Placement & 15s Stack Alarm (INV-PERK-2, INV-PERK-6)
// -------------------------------------------------------------------------------------------------
runTest('VEC-05: Step 1 Stack Placement & 15s Stack Alarm (INV-PERK-2, INV-PERK-6)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });
  const alarmManager = psm.alarmManager;

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2
  });

  let alarmEvents = [];
  alarmManager.onEmit = (e) => alarmEvents.push(e);

  // Advance to Turn 4 Upkeep
  psm.turnNumber = 4;
  psm.roundNumber = 4;
  psm.setPhaseStep('UPKEEP');

  assert.equal(psm.stack.length, 1);
  const triggerItem = psm.stack[0];
  assert.equal(triggerItem.type, 'PERK_UPKEEP_TRIGGER');
  assert.equal(triggerItem.sourcePlayerId, 'p1');

  // Priority must have passed to opponent ('p2')
  assert.equal(psm.priorityPlayerId, 'p2');

  // 15-second Stack Alarm must be running for 'p2'
  assert.equal(alarmManager.status, 'RUNNING');
  assert.equal(alarmManager.targetPlayerId, 'p2');
  assert.equal(alarmManager.durationSeconds, 15);
  assert.ok(alarmEvents.some(e => e.type === 'STACK_ALARM_START' && e.targetPlayerId === 'p2'));

  alarmManager.cancel();
  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-06: Authoritative CSPRNG Roll & Injected Deterministic PRNG (INV-PERK-3)
// -------------------------------------------------------------------------------------------------
runTest('VEC-06: Authoritative CSPRNG Roll & Injected Deterministic PRNG (INV-PERK-3)', () => {
  // Test default authoritative CSPRNG
  for (let i = 0; i < 20; i++) {
    const roll = executeAuthoritativeRoll();
    assert.ok(roll.tens >= 0 && roll.tens <= 9, 'Tens digit must be between 0 and 9');
    assert.ok(roll.ones >= 0 && roll.ones <= 9, 'Ones digit must be between 0 and 9');
    assert.equal(roll.rollString, `${roll.tens}${roll.ones}`);
  }

  // Test injected deterministic PRNG
  let calls = 0;
  const mockPrng = (min, max) => {
    calls++;
    return 5; // always rolls 5
  };

  const deterministicRoll = executeAuthoritativeRoll(mockPrng);
  assert.equal(deterministicRoll.tens, 5);
  assert.equal(deterministicRoll.ones, 5);
  assert.equal(deterministicRoll.rollString, '55');
  assert.equal(calls, 2);

  // Test engine integration with injected PRNG
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2,
    prng: () => 7
  });

  let rolledEvent = null;
  engine.on('PERK_ROLLED', (e) => { rolledEvent = e; });

  const roll = engine.rollDice();
  assert.equal(roll.tens, 7);
  assert.equal(roll.ones, 7);
  assert.equal(roll.rollString, '77');

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-07: Roll Miss & Zero Stack Push (INV-PERK-8)
// -------------------------------------------------------------------------------------------------
runTest('VEC-07: Roll Miss & Zero Stack Push (INV-PERK-8)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2
  });

  let missEvent = null;
  engine.on('PERK_ROLL_MISS', (e) => { missEvent = e; });

  // Simulate Step 1 resolution with a roll of "23" (not in catalog, not birthday)
  psm.clearStack();
  const rollResult = engine.handleStep1Resolution({ tens: 2, ones: 3, rollString: '23' }, 'p1');

  assert.equal(rollResult.isMiss, true);
  assert.equal(rollResult.matchedKey, null);
  assert.ok(missEvent, 'PERK_ROLL_MISS event must be emitted');
  assert.equal(missEvent.activePlayerId, 'p1');
  assert.equal(missEvent.roll.rollString, '23');

  // Stack must remain empty (no Step 2 pushed)
  assert.equal(psm.stack.length, 0, 'No Step 2 trigger should be on stack after miss');

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-08: CR 603.3d Target Legality Guard (Empty Board Fizzle) (INV-PERK-1)
// -------------------------------------------------------------------------------------------------
runTest('VEC-08: CR 603.3d Target Legality Guard (Empty Board Fizzle) (INV-PERK-1)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2
  });

  // Verify that empty battlefield has 0 legal targets for perk "55"
  assert.equal(hasLegalTargets('55', ttsm, 'p1'), false);
  assert.equal(getLegalTargets('55', ttsm, 'p1').length, 0);

  let fizzleEvent = null;
  engine.on('PERK_TRIGGER_FIZZLED_NO_LEGAL_TARGETS', (e) => { fizzleEvent = e; });

  // Simulate roll of "55" on completely empty board
  psm.clearStack();
  const rollResult = engine.handleStep1Resolution({ tens: 5, ones: 5, rollString: '55' }, 'p1');

  assert.equal(rollResult.matchedKey, '55');
  assert.ok(fizzleEvent, 'Fizzle event must be emitted');
  assert.equal(fizzleEvent.perkKey, '55');
  assert.equal(fizzleEvent.reason, 'NO_LEGAL_TARGETS');

  // Invariant INV-PERK-1: Ability is NOT put on the stack
  assert.equal(psm.stack.length, 0, 'Trigger must not be pushed to stack when targets == 0');

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-09: Step 2 Stack Push with Declared Targets & Alarm (INV-PERK-1, INV-PERK-6)
// -------------------------------------------------------------------------------------------------
runTest('VEC-09: Step 2 Stack Push with Declared Targets & Alarm (INV-PERK-1, INV-PERK-6)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });
  const alarmManager = psm.alarmManager;

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2
  });

  // Add 1 creature to opponent's battlefield to serve as a legal target
  const creature = ttsm.addCardToZone('p2', 'battlefield', {
    name: 'Grizzly Bears',
    typeLine: 'Creature — Bear',
    subzone: 'creatures'
  });

  assert.equal(hasLegalTargets('55', ttsm, 'p1'), true);

  let placedEvent = null;
  engine.on('PERK_EFFECT_TRIGGER_PLACED', (e) => { placedEvent = e; });

  // Resolve roll "55"
  psm.clearStack();
  engine.handleStep1Resolution({ tens: 5, ones: 5, rollString: '55' }, 'p1');

  // Step 2 must be pushed with declared targets
  assert.equal(psm.stack.length, 1);
  const step2Item = psm.stack[0];
  assert.equal(step2Item.type, 'PERK_EFFECT_TRIGGER');
  assert.equal(step2Item.perkKey, '55');
  assert.equal(step2Item.targets.length, 1);
  assert.equal(step2Item.targets[0].targetId, creature.instanceId);

  // Fresh 15-second Stack Alarm must be running for opponent ('p2')
  assert.equal(alarmManager.status, 'RUNNING');
  assert.equal(alarmManager.targetPlayerId, 'p2');
  assert.equal(alarmManager.stackItemId, step2Item.id);

  alarmManager.cancel();
  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-10: Step 2 Resolution & State Mutation (Perk #55) (INV-PERK-5)
// -------------------------------------------------------------------------------------------------
runTest('VEC-10: Step 2 Resolution & State Mutation (Perk #55) (INV-PERK-5)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2
  });

  // Add an indestructible/hexproof creature to p2's battlefield
  const targetCreature = ttsm.addCardToZone('p2', 'battlefield', {
    name: 'Darksteel Colossus',
    typeLine: 'Artifact Creature — Golem',
    subzone: 'creatures',
    indestructible: true,
    hexproof: true
  });

  // Construct and resolve Step 2 trigger
  const step2Item = {
    id: 'stack_perk_55',
    sourcePlayerId: 'p1',
    type: 'PERK_EFFECT_TRIGGER',
    perkKey: '55',
    perkName: 'Cataclysmic Ruin',
    targets: [{ targetType: 'PERMANENT', targetId: targetCreature.instanceId, ownerId: 'p2' }],
    timestamp: Date.now()
  };

  let resolvedEvent = null;
  engine.on('PERK_EFFECT_RESOLVED', (e) => { resolvedEvent = e; });

  const executionResult = engine.handleStep2Resolution(step2Item);

  assert.equal(executionResult.success, true);
  assert.ok(executionResult.mutationsApplied.permanentsDestroyed.includes(targetCreature.instanceId));

  // Creature must now reside in p2's graveyard
  assert.equal(ttsm.players.p2.battlefield.creatures.length, 0);
  assert.equal(ttsm.players.p2.graveyard.length, 1);
  assert.equal(ttsm.players.p2.graveyard[0].instanceId, targetCreature.instanceId);

  // Events emitted
  assert.ok(resolvedEvent);
  assert.equal(resolvedEvent.perkKey, '55');

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-11: CR 608.2c Partial Execution on Perk #13 (INV-PERK-5)
// -------------------------------------------------------------------------------------------------
runTest('VEC-11: CR 608.2c Partial Execution on Perk #13 (INV-PERK-5)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2
  });

  // Player 1 has hand size = 0 and creature count = 0
  ttsm.players.p1.hand = [];
  ttsm.players.p1.battlefield.creatures = [];

  // Perk #13 specifies: "Discard a card and sacrifice a creature."
  // Under CR 608.2c, it must partially execute cleanly without throwing errors
  const step2Item = {
    id: 'stack_perk_13',
    sourcePlayerId: 'p1',
    type: 'PERK_EFFECT_TRIGGER',
    perkKey: '13',
    perkName: 'Dark Misfortune',
    targets: [],
    timestamp: Date.now()
  };

  const result = engine.handleStep2Resolution(step2Item);

  assert.equal(result.success, true);
  assert.equal(ttsm.players.p1.hand.length, 0);
  assert.equal(ttsm.players.p1.battlefield.creatures.length, 0);
  assert.equal(ttsm.players.p1.graveyard.length, 0);

  // Test partial execution: Hand = 1, Creature = 0
  const cardInHand = ttsm.addCardToZone('p1', 'hand', { name: 'Lightning Bolt', typeLine: 'Instant' });
  const result2 = executePerkEffect('13', ttsm, { activePlayerId: 'p1' });
  assert.equal(result2.success, true);
  assert.equal(ttsm.players.p1.hand.length, 0);
  assert.equal(ttsm.players.p1.graveyard.length, 1);

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-12: Birthday Match (RPBD) Resolution (Domain Rules)
// -------------------------------------------------------------------------------------------------
runTest('VEC-12: Birthday Match (RPBD) Resolution (Domain Rules)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2', 'p3'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2', 'p3'], activePlayerId: 'p1' });

  // Set p1's birthday to "24"
  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 3,
    birthdayMap: { p1: '24' }
  });

  // Roll "24" (matches p1's birthday!)
  const match = resolveRoll(2, 4, '24');
  assert.equal(match.perkKey, 'RPBD');
  assert.equal(match.isBirthday, true);
  assert.equal(match.isMiss, false);

  // Initial life totals: all at 20
  ttsm.players.p1.resources.life = 20;
  ttsm.players.p2.resources.life = 20;
  ttsm.players.p3.resources.life = 20;

  // Resolve Mode 4 (Life Leech): Each opponent loses 3 life; active player gains equal life
  const step2Item = {
    id: 'stack_perk_rpbd',
    sourcePlayerId: 'p1',
    type: 'PERK_EFFECT_TRIGGER',
    perkKey: 'RPBD',
    perkName: 'Birthday Match',
    birthdayOptionIndex: 4, // Mode 4: Life Leech
    targets: [],
    timestamp: Date.now()
  };

  const result = engine.handleStep2Resolution(step2Item);

  assert.equal(result.success, true);
  assert.equal(result.selectedOptionId, 'RPBD_LIFE_LEECH');

  // p2 and p3 each lose 3 life (20 - 3 = 17)
  assert.equal(ttsm.players.p2.resources.life, 17);
  assert.equal(ttsm.players.p3.resources.life, 17);

  // p1 gains 6 life (20 + 6 = 26)
  assert.equal(ttsm.players.p1.resources.life, 26);

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-13: APNAP Trigger Ordering (CR 101.4 / INV-PERK-2)
// -------------------------------------------------------------------------------------------------
runTest('VEC-13: APNAP Trigger Ordering (CR 101.4 / INV-PERK-2)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });

  let rollToggle = 0;
  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2,
    prng: () => (rollToggle++ % 2 === 0 ? 2 : 3) // Deterministic '23' roll (miss) so Step 2 is not pushed
  });

  // Suppose active player 'p1' already had an upkeep trigger on the stack (e.g. Phyrexian Arena)
  const existingTrigger = {
    id: 'arena_trigger_1',
    sourcePlayerId: 'p1',
    type: 'ABILITY',
    name: 'Phyrexian Arena Trigger'
  };
  psm.pushStack(existingTrigger);
  assert.equal(psm.stack.length, 1);

  // When RandomPerkEngine triggers Step 1 Upkeep Trigger:
  // Under CR 101.4 / DEC-013, RPM trigger is placed at the top so it resolves first
  const step1 = engine.triggerStep1('p1');

  assert.equal(psm.stack.length, 2);
  assert.equal(psm.peekStack().id, step1.id, 'RPM Upkeep Trigger must be on top of stack');
  assert.equal(psm.peekStack().type, 'PERK_UPKEEP_TRIGGER');

  // Resolving the top resolves the RPM trigger first
  const resolved = psm.resolveTop();
  assert.equal(resolved.id, step1.id);
  assert.equal(psm.stack.length, 1);
  assert.equal(psm.peekStack().id, existingTrigger.id, 'Existing trigger remains under RPM trigger');

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-14: Engine Teardown & Event Listener Cleanup (INV-HARNESS-2)
// -------------------------------------------------------------------------------------------------
runTest('VEC-14: Engine Teardown & Event Listener Cleanup (INV-HARNESS-2)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2
  });

  assert.equal(engine.isEmblemActive, true);

  let upkeepEventCount = 0;
  engine.on('PERK_UPKEEP_TRIGGER_PLACED', () => upkeepEventCount++);

  // Fire upkeep once while active
  psm.turnNumber = 4;
  psm.roundNumber = 4;
  psm.setPhaseStep('UPKEEP');
  assert.equal(upkeepEventCount, 1);
  psm.clearStack();

  // Call destroy()
  engine.destroy();
  assert.equal(engine.isEmblemActive, false);
  assert.equal(engine.listenerCount('PERK_UPKEEP_TRIGGER_PLACED'), 0);

  // Fire upkeep again: destroyed engine must NOT respond
  psm.setPhaseStep('DRAW');
  psm.setPhaseStep('UPKEEP');
  assert.equal(upkeepEventCount, 1, 'Destroyed engine must not process phase step changes');
  assert.equal(psm.stack.length, 0, 'No triggers should be pushed after engine destruction');
});

// -------------------------------------------------------------------------------------------------
// VEC-15: Stack Resolution Excludes Emblem Triggers from Graveyard (CR 113.3b / CR 608.2)
// -------------------------------------------------------------------------------------------------
runTest('VEC-15: Stack Resolution Excludes Emblem Triggers from Graveyard (CR 113.3b / CR 608.2)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1', tabletopState: ttsm });
  ttsm._priorityMachine = psm;

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2
  });

  // Step 1: Upkeep Trigger placed onto stack
  psm.turnNumber = 4;
  psm.roundNumber = 4;
  psm.setPhaseStep('UPKEEP');
  assert.equal(psm.stack.length, 1);
  assert.equal(psm.peekStack().type, 'PERK_UPKEEP_TRIGGER');

  // Resolving Step 1 trigger via PSM resolveTop
  psm.resolveTop();
  assert.equal(ttsm.players.p1.graveyard.length, 0, 'PERK_UPKEEP_TRIGGER must never enter p1 graveyard');
  assert.equal(ttsm.players.p2.graveyard.length, 0, 'PERK_UPKEEP_TRIGGER must never enter p2 graveyard');

  // Step 2: Push effect trigger and resolve
  psm.clearStack();
  const step2Item = engine.triggerStep2('22', [], undefined, 'p1');
  assert.equal(psm.stack.length, 1);
  assert.equal(psm.peekStack().type, 'PERK_EFFECT_TRIGGER');

  psm.resolveTop();
  assert.equal(ttsm.players.p1.graveyard.length, 0, 'PERK_EFFECT_TRIGGER must never enter p1 graveyard');
  assert.equal(ttsm.players.p2.graveyard.length, 0, 'PERK_EFFECT_TRIGGER must never enter p2 graveyard');

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-16: Perk #44 (Exploration) Additional Land Drop Limit & Turn Reset
// -------------------------------------------------------------------------------------------------
runTest('VEC-16: Perk #44 (Exploration) Additional Land Drop Limit & Turn Reset', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1', tabletopState: ttsm });
  ttsm._priorityMachine = psm;

  // Set to PRECOMBAT_MAIN where lands are legally played
  psm.setPhaseStep('PRECOMBAT_MAIN');

  // Add 3 lands and 1 card to library
  ttsm.players.p1.library = [{ instanceId: 'c_lib', name: 'Lightning Bolt', typeLine: 'Instant' }];
  ttsm.addCardToZone('p1', 'hand', { instanceId: 'land_1', name: 'Forest', typeLine: 'Basic Land — Forest', isPermanent: true });
  ttsm.addCardToZone('p1', 'hand', { instanceId: 'land_2', name: 'Mountain', typeLine: 'Basic Land — Mountain', isPermanent: true });
  ttsm.addCardToZone('p1', 'hand', { instanceId: 'land_3', name: 'Island', typeLine: 'Basic Land — Island', isPermanent: true });

  // Baseline: Play 1st land succeeds
  ttsm.playLand('p1', 'land_1');
  assert.equal(ttsm.players.p1.landsPlayedThisTurn, 1);

  // Playing 2nd land without perk fails
  assert.throws(() => ttsm.playLand('p1', 'land_2'));

  // Resolve Perk #44
  const result = executePerkEffect('44', ttsm, { activePlayerId: 'p1' });
  assert.equal(result.success, true);
  assert.equal(ttsm.players.p1.resources.additionalLandsAllowed, 1);
  assert.equal(ttsm.players.p1.maxLandsPerTurn, 2);

  // Now playing 2nd land must succeed
  ttsm.playLand('p1', 'land_2');
  assert.equal(ttsm.players.p1.landsPlayedThisTurn, 2);

  // Playing 3rd land must fail
  assert.throws(() => ttsm.playLand('p1', 'land_3'));

  // Advance turn / untap: quotas must reset to 1
  ttsm.resetTurnQuotas('p1');
  assert.equal(ttsm.players.p1.landsPlayedThisTurn, 0);
  assert.equal(ttsm.players.p1.maxLandsPerTurn, 1);
  assert.equal(ttsm.players.p1.resources.additionalLandsAllowed, 0);
  assert.equal(ttsm.players.p1.resources.maxLandsPerTurn, 1);
});

// -------------------------------------------------------------------------------------------------
// VEC-17: Next Phase Invariant: Stack Non-Empty Stops Fast-Forward at UPKEEP
// -------------------------------------------------------------------------------------------------
runTest('VEC-17: Next Phase Invariant: Stack Non-Empty Stops Fast-Forward at UPKEEP', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1', tabletopState: ttsm });
  ttsm._priorityMachine = psm;

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2
  });

  // On Turn 4 (1v1 unlock), start at UNTAP and advance
  psm.turnNumber = 4;
  psm.roundNumber = 4;
  psm.setPhaseStep('UNTAP');

  const step = psm.nextPhase('p1');
  assert.equal(step, 'UPKEEP', 'nextPhase from UNTAP must stop at UPKEEP when stack is non-empty');
  assert.equal(psm.currentPhaseStep, 'UPKEEP');
  assert.equal(psm.stack.length, 1);
  assert.equal(psm.peekStack().type, 'PERK_UPKEEP_TRIGGER');

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// VEC-18: 1v1 Full Round Progression Dormancy (Rounds 1-3 Dormant, Round 4 / Turn 7 Unlock)
// -------------------------------------------------------------------------------------------------
runTest('VEC-18: 1v1 Full Round Progression Dormancy (Rounds 1-3 Dormant, Round 4 / Turn 7 Unlock)', () => {
  const ttsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const psm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1', tabletopState: ttsm });
  ttsm._priorityMachine = psm;

  const engine = new RandomPerkEngine({
    tabletopState: ttsm,
    priorityStateMachine: psm,
    initialPlayerCount: 2
  });

  const dormantTurns = [];
  engine.on('PERK_EMBLEM_DORMANT', (evt) => {
    dormantTurns.push(evt);
  });

  // Turns 1 to 6 (Rounds 1, 2, 3 in 1v1):
  // T1: P1, Round 1
  // T2: P2, Round 1
  // T3: P1, Round 2
  // T4: P2, Round 2
  // T5: P1, Round 3
  // T6: P2, Round 3
  for (let turn = 1; turn <= 6; turn++) {
    const round = Math.ceil(turn / 2);
    const activePid = (turn % 2 === 1) ? 'p1' : 'p2';
    psm.turnNumber = turn;
    psm.roundNumber = round;
    psm.activePlayerId = activePid;
    psm.clearStack();
    psm.setPhaseStep('UPKEEP');

    assert.equal(psm.stack.length, 0, `Turn ${turn} (Round ${round}) must not trigger PERK_UPKEEP_TRIGGER`);
  }

  assert.equal(dormantTurns.length, 6, 'All 6 individual turns across Rounds 1-3 must be dormant');

  // Turn 7: P1, Round 4 (Player 1's 4th turn) -> Triggers!
  psm.turnNumber = 7;
  psm.roundNumber = 4;
  psm.activePlayerId = 'p1';
  psm.clearStack();
  psm.setPhaseStep('UPKEEP');

  assert.equal(psm.stack.length, 1, 'Turn 7 (Round 4) must trigger PERK_UPKEEP_TRIGGER');
  assert.equal(psm.peekStack().type, 'PERK_UPKEEP_TRIGGER');
  assert.equal(psm.peekStack().sourcePlayerId, 'p1');

  // Turn 8: P2, Round 4 (Player 2's 4th turn) -> Also triggers!
  psm.clearStack();
  psm.turnNumber = 8;
  psm.roundNumber = 4;
  psm.activePlayerId = 'p2';
  psm.setPhaseStep('UPKEEP');

  assert.equal(psm.stack.length, 1, 'Turn 8 (Round 4) must trigger PERK_UPKEEP_TRIGGER');
  assert.equal(psm.peekStack().type, 'PERK_UPKEEP_TRIGGER');
  assert.equal(psm.peekStack().sourcePlayerId, 'p2');

  engine.destroy();
});

// -------------------------------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------------------------------
console.log(`\n==============================================`);
console.log(`ACCEPTANCE TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log(`==============================================`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
