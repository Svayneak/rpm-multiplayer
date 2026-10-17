import assert from 'node:assert/strict';
import {
  PriorityStateMachine,
  PriorityViolationError,
  CheckpointJournal,
  PHASE_STEPS,
  generateStackItemId,
  generateCheckpointId,
  StackAlarmManager
} from '../src/index.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function runAuditTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  [AUDIT PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [AUDIT FAIL] ${name}`);
    console.error(err);
    failedTests++;
  }
}

async function runAuditTestAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  [AUDIT PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [AUDIT FAIL] ${name}`);
    console.error(err);
    failedTests++;
  }
}

console.log('================================================================');
console.log('INDEPENDENT VERIFICATION AUDIT: SPEC-RPM-PRIORITY-004');
console.log('================================================================\n');

// -------------------------------------------------------------------------
// SECTION A: INVARIANT AUDIT
// -------------------------------------------------------------------------
console.log('--- AUDITING FORMAL MATHEMATICAL INVARIANTS ---');

// Invariant I1: Unique Priority Holder Invariant
runAuditTest('Invariant I1: Exactly one player holds priority during priority steps', () => {
  const sm = new PriorityStateMachine({ players: ['alice', 'bob', 'charlie'], activePlayerId: 'alice' });
  sm.setPhaseStep('UPKEEP');
  assert.equal(sm.priorityPlayerId, 'alice');
  assert.ok(sm.players.includes(sm.priorityPlayerId), 'Priority holder must belong to players set');

  sm.dispatch('PASS_PRIORITY', { playerId: 'alice' });
  assert.equal(sm.priorityPlayerId, 'bob');
  assert.ok(sm.players.includes(sm.priorityPlayerId));

  sm.dispatch('PASS_PRIORITY', { playerId: 'bob' });
  assert.equal(sm.priorityPlayerId, 'charlie');
  assert.ok(sm.players.includes(sm.priorityPlayerId));
});

// Invariant I2: LIFO Stack Invariant
runAuditTest('Invariant I2: Strict Last-In, First-Out (LIFO) resolution order', () => {
  const sm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });
  sm.setPhaseStep('PRECOMBAT_MAIN');

  // Push Spell 1
  sm.dispatch('CAST_SPELL', { playerId: 'p1', card: { name: 'Spell 1 (Bottom)' } });
  // Push Spell 2
  sm.dispatch('CAST_SPELL', { playerId: 'p2', card: { name: 'Spell 2 (Middle)' } });
  // Push Spell 3
  sm.dispatch('CAST_SPELL', { playerId: 'p1', card: { name: 'Spell 3 (Top)' } });

  assert.equal(sm.stack.length, 3);
  assert.equal(sm.stack[0].card.name, 'Spell 1 (Bottom)');
  assert.equal(sm.stack[1].card.name, 'Spell 2 (Middle)');
  assert.equal(sm.stack[2].card.name, 'Spell 3 (Top)');

  // All pass priority to resolve Top (Spell 3)
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });
  sm.dispatch('PASS_PRIORITY', { playerId: 'p1' });
  assert.equal(sm.stack.length, 2);
  assert.equal(sm.peekStack().card.name, 'Spell 2 (Middle)');

  // All pass to resolve Spell 2
  sm.dispatch('PASS_PRIORITY', { playerId: 'p1' });
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });
  assert.equal(sm.stack.length, 1);
  assert.equal(sm.peekStack().card.name, 'Spell 1 (Bottom)');

  // All pass to resolve Spell 1
  sm.dispatch('PASS_PRIORITY', { playerId: 'p1' });
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });
  assert.equal(sm.stack.length, 0);
});

// Invariant I3: APNAP Rotation Order
runAuditTest('Invariant I3: APNAP clockwise priority rotation', () => {
  const sm = new PriorityStateMachine({ players: ['p1', 'p2', 'p3', 'p4'], activePlayerId: 'p1' });
  assert.equal(sm.nextPlayer('p1'), 'p2');
  assert.equal(sm.nextPlayer('p2'), 'p3');
  assert.equal(sm.nextPlayer('p3'), 'p4');
  assert.equal(sm.nextPlayer('p4'), 'p1');

  sm.setPhaseStep('UPKEEP');
  assert.equal(sm.priorityPlayerId, 'p1');
  sm.dispatch('PASS_PRIORITY', { playerId: 'p1' });
  assert.equal(sm.priorityPlayerId, 'p2');
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });
  assert.equal(sm.priorityPlayerId, 'p3');
  sm.dispatch('PASS_PRIORITY', { playerId: 'p3' });
  assert.equal(sm.priorityPlayerId, 'p4');
  sm.dispatch('PASS_PRIORITY', { playerId: 'p4' });
  // All passed on empty stack -> advances to DRAW
  assert.equal(sm.currentPhaseStep, 'DRAW');
  assert.equal(sm.priorityPlayerId, 'p1');
});

// Invariant I4: Quorum Resolution Rule
runAuditTest('Invariant I4: Item resolves if and only if all players pass consecutively', () => {
  const sm = new PriorityStateMachine({ players: ['p1', 'p2', 'p3'], activePlayerId: 'p1' });
  sm.setPhaseStep('PRECOMBAT_MAIN');
  sm.dispatch('CAST_SPELL', { playerId: 'p1', card: { name: 'Divination' } });
  assert.equal(sm.stack.length, 1);

  // P2 passes (count = 1)
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });
  assert.equal(sm.stack.length, 1);
  assert.equal(sm.consecutivePassCount, 1);

  // P3 passes (count = 2)
  sm.dispatch('PASS_PRIORITY', { playerId: 'p3' });
  assert.equal(sm.stack.length, 1);
  assert.equal(sm.consecutivePassCount, 2);

  // Before P1 passes, suppose P1 casts an instant! Action must reset consecutive passes to 0
  sm.dispatch('CAST_SPELL', { playerId: 'p1', card: { name: 'Brainstorm', typeLine: 'Instant' } });
  assert.equal(sm.stack.length, 2);
  assert.equal(sm.consecutivePassCount, 0); // Interrupted!
  assert.equal(sm.priorityPlayerId, 'p2');

  // Now all must pass for Brainstorm
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });
  sm.dispatch('PASS_PRIORITY', { playerId: 'p3' });
  sm.dispatch('PASS_PRIORITY', { playerId: 'p1' });
  // Brainstorm resolved!
  assert.equal(sm.stack.length, 1);
  assert.equal(sm.stack[0].card.name, 'Divination');
  assert.equal(sm.consecutivePassCount, 0);
});

// Invariant I5: Checkpoint Fidelity
runAuditTest('Invariant I5: Restored state is identical in value and reference-independent', () => {
  const sm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });
  sm.setPhaseStep('PRECOMBAT_MAIN');
  sm.dispatch('CAST_SPELL', {
    playerId: 'p1',
    card: { name: 'Opt', instanceId: 'c1' },
    targets: [{ targetType: 'PLAYER', targetId: 'p1' }]
  });

  const snapshot = sm.createCheckpoint('AUDIT_SNAPSHOT');
  assert.equal(snapshot.stack.length, 1);
  assert.equal(snapshot.stack[0].card.name, 'Opt');

  // Mutate current state: push another spell and resolve
  sm.dispatch('CAST_SPELL', { playerId: 'p2', card: { name: 'Spell Pierce' } });
  assert.equal(sm.stack.length, 2);

  // Verify snapshot stack was NOT mutated (Reference Independence on capture)
  assert.equal(snapshot.stack.length, 1, 'Snapshot stack must remain immutable');

  // Rollback to checkpoint
  sm.rollbackToCheckpoint(snapshot.checkpointId);
  assert.equal(sm.stack.length, 1);
  assert.equal(sm.stack[0].card.name, 'Opt');

  // Mutate restored state (mutate sm.stack)
  sm.stack[0].card.name = 'MUTATED';
  // Check snapshot stack is still 'Opt' (Reference Independence on restore)
  const freshRetrieval = sm.checkpointJournal.getSnapshot(snapshot.checkpointId);
  assert.equal(freshRetrieval.stack[0].card.name, 'Opt', 'Snapshot in journal must remain immutable after restore');
});

// -------------------------------------------------------------------------
// SECTION B: EDGE CASES AUDIT
// -------------------------------------------------------------------------
console.log('\n--- AUDITING EDGE CASES ---');

// Edge Case 1: Cast instant without priority -> PriorityViolationError
runAuditTest('Edge Case 1: Casting instant without priority throws PriorityViolationError', () => {
  const sm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });
  sm.setPhaseStep('UPKEEP');
  assert.equal(sm.priorityPlayerId, 'p1');

  // Player 2 attempts to cast instant while Player 1 has priority
  let thrown = false;
  try {
    sm.dispatch('CAST_SPELL', {
      playerId: 'p2',
      card: { name: 'Lightning Bolt', typeLine: 'Instant' }
    });
  } catch (err) {
    thrown = true;
    assert.ok(err instanceof PriorityViolationError, 'Error must be instance of PriorityViolationError');
    assert.equal(err.name, 'PriorityViolationError');
    assert.ok(err.message.includes("Player 'p2' does not hold priority"));
    assert.equal(err.details.playerId, 'p2');
    assert.equal(err.details.priorityPlayerId, 'p1');
  }
  assert.ok(thrown, 'Must throw PriorityViolationError');
});

// Edge Case 2: Sorcery-speed timing restrictions (combat, end step, non-empty stack, non-active player)
runAuditTest('Edge Case 2A: Sorcery-speed action rejected during Combat Phase (strictTiming)', () => {
  const sm = new PriorityStateMachine({
    players: ['p1', 'p2'],
    activePlayerId: 'p1',
    strictTiming: true
  });
  sm.setPhaseStep('BEGIN_COMBAT');
  assert.equal(sm.priorityPlayerId, 'p1');

  assert.throws(() => {
    sm.dispatch('CAST_SPELL', {
      playerId: 'p1',
      card: { name: 'Grizzly Bears', typeLine: 'Creature' }
    });
  }, (err) => {
    assert.ok(err instanceof PriorityViolationError);
    assert.ok(err.message.includes('Sorcery speed actions are only permitted during Main phases'));
    return true;
  });
});

runAuditTest('Edge Case 2B: Sorcery-speed action rejected during END_STEP (strictTiming)', () => {
  const sm = new PriorityStateMachine({
    players: ['p1', 'p2'],
    activePlayerId: 'p1',
    strictTiming: true
  });
  sm.setPhaseStep('END_STEP');

  assert.throws(() => {
    sm.dispatch('CAST_SPELL', {
      playerId: 'p1',
      card: { name: 'Divination', typeLine: 'Sorcery' }
    });
  }, (err) => {
    assert.ok(err instanceof PriorityViolationError);
    assert.ok(err.message.includes('Sorcery speed actions are only permitted during Main phases'));
    return true;
  });
});

runAuditTest('Edge Case 2C: Sorcery-speed action rejected when stack is non-empty (strictTiming)', () => {
  const sm = new PriorityStateMachine({
    players: ['p1', 'p2'],
    activePlayerId: 'p1',
    strictTiming: true
  });
  sm.setPhaseStep('PRECOMBAT_MAIN');

  // P1 casts an Instant (Opt) -> priority passes to P2
  sm.dispatch('CAST_SPELL', {
    playerId: 'p1',
    card: { name: 'Opt', typeLine: 'Instant' }
  });
  assert.equal(sm.priorityPlayerId, 'p2');

  // P2 responds with an Instant (Spell Pierce) -> priority passes back to P1!
  sm.dispatch('CAST_SPELL', {
    playerId: 'p2',
    card: { name: 'Spell Pierce', typeLine: 'Instant' }
  });
  assert.equal(sm.priorityPlayerId, 'p1');
  assert.equal(sm.stack.length, 2);

  // P1 now holds priority, but the stack is NOT empty (2 spells on stack)
  // P1 attempts to cast a Sorcery-speed card (Ponder)
  assert.throws(() => {
    sm.dispatch('CAST_SPELL', {
      playerId: 'p1',
      card: { name: 'Ponder', typeLine: 'Sorcery' }
    });
  }, (err) => {
    assert.ok(err instanceof PriorityViolationError);
    assert.ok(err.message.includes('Sorcery speed actions require an empty stack'));
    return true;
  });
});

runAuditTest('Edge Case 2D: Sorcery-speed action with explicit actionType SORCERY_SPEED', () => {
  const sm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });
  sm.setPhaseStep('UPKEEP');

  assert.throws(() => {
    sm.validateAction('p1', 'SORCERY_SPEED');
  }, (err) => {
    assert.ok(err instanceof PriorityViolationError);
    assert.ok(err.message.includes('Sorcery speed actions are only permitted during Main phases'));
    return true;
  });
});

// Edge Case 3: Timer expiration in StackAlarmManager & auto-pass priority without hanging timers
await runAuditTestAsync('Edge Case 3: Timer expiration cleanly auto-passes priority without hanging timers', async () => {
  let timeoutCalled = false;
  let emittedEvents = [];

  const sm = new PriorityStateMachine({
    players: ['p1', 'p2'],
    activePlayerId: 'p1'
  });
  sm.setPhaseStep('PRECOMBAT_MAIN');

  // Attach listener
  sm.alarmManager.onEmit = (e) => emittedEvents.push(e);

  // P1 casts spell, starting timer for P2 with a very small duration (50ms)
  sm.dispatch('CAST_SPELL', {
    playerId: 'p1',
    card: { name: 'Bolt', typeLine: 'Instant' },
    durationSeconds: 0.05 // 50 ms for live async test
  });

  assert.equal(sm.alarmManager.status, 'RUNNING');
  assert.equal(sm.priorityPlayerId, 'p2');
  assert.equal(sm.stack.length, 1);

  // Wait 80ms for setTimeout to fire naturally
  await new Promise(resolve => setTimeout(resolve, 80));

  // Timer must have expired and auto-passed priority to resolve spell
  assert.equal(sm.alarmManager.status, 'IDLE');
  assert.equal(sm.alarmManager.timer, null, 'Timer reference must be cleared');
  assert.equal(sm.stack.length, 0, 'Spell should have resolved on auto-pass');
  assert.equal(sm.priorityPlayerId, 'p1', 'Priority should return to active player');
  assert.ok(emittedEvents.some(e => e.type === 'STACK_ALARM_EXPIRED'), 'STACK_ALARM_EXPIRED event emitted');
});

// Edge Case 4: HOLD_RESPOND freezes remaining time, enters HELD status, clears on response
await runAuditTestAsync('Edge Case 4: HOLD_RESPOND freezes timer, prevents timeout, resumes/clears on action', async () => {
  const sm = new PriorityStateMachine({
    players: ['p1', 'p2'],
    activePlayerId: 'p1'
  });
  sm.setPhaseStep('PRECOMBAT_MAIN');

  // P1 casts spell with 200ms duration
  sm.dispatch('CAST_SPELL', {
    playerId: 'p1',
    card: { name: 'Fatal Push', typeLine: 'Instant' },
    durationSeconds: 0.2
  });

  assert.equal(sm.alarmManager.status, 'RUNNING');

  // Wait 50ms then HOLD
  await new Promise(resolve => setTimeout(resolve, 50));
  const holdRes = sm.dispatch('HOLD_RESPOND', { playerId: 'p2' });

  assert.equal(holdRes.status, 'HELD');
  assert.equal(sm.alarmManager.status, 'HELD');
  assert.equal(sm.alarmManager.heldByPlayerId, 'p2');
  assert.equal(sm.alarmManager.timer, null, 'Timer must be cleared while held');
  const remainingAtHold = sm.alarmManager.remainingMs;
  assert.ok(remainingAtHold > 0 && remainingAtHold < 200, `Remaining ms (${remainingAtHold}) properly decremented`);

  // Wait 250ms (well past original 200ms expiration): must NOT have expired!
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(sm.alarmManager.status, 'HELD', 'Must remain HELD without expiring');
  assert.equal(sm.stack.length, 1, 'Spell still on stack');

  // P2 responds with Counterspell: alarm should be cleared / restarted for P1
  sm.dispatch('CAST_SPELL', {
    playerId: 'p2',
    card: { name: 'Spell Pierce', typeLine: 'Instant' },
    durationSeconds: 0.1
  });

  assert.equal(sm.stack.length, 2);
  assert.equal(sm.priorityPlayerId, 'p1');
  assert.equal(sm.alarmManager.status, 'RUNNING');
  assert.equal(sm.alarmManager.targetPlayerId, 'p1');

  // Clean up
  sm.alarmManager.cancel();
  assert.equal(sm.alarmManager.status, 'IDLE');
});

// Edge Case 5: Rapid cancel and restart of StackAlarmManager
runAuditTest('Edge Case 5: Multiple rapid start/cancel cycles in StackAlarmManager', () => {
  const am = new StackAlarmManager({ defaultDurationSeconds: 15 });
  for (let i = 0; i < 20; i++) {
    am.start(`p_${i}`, `stack_${i}`, 15);
    assert.equal(am.status, 'RUNNING');
    assert.equal(am.targetPlayerId, `p_${i}`);
    am.cancel();
    assert.equal(am.status, 'IDLE');
    assert.equal(am.timer, null);
  }
});

// Edge Case 6: Checkpoint Ring Buffer Overflow (maxSnapshots = 50 eviction)
runAuditTest('Edge Case 6: Checkpoint Journal ring buffer evicts oldest after exceeding maxSnapshots', () => {
  const journal = new CheckpointJournal(5);
  const dummyState = { activePlayerId: 'p1', priorityPlayerId: 'p1', currentPhaseStep: 'UPKEEP', turnNumber: 1, consecutivePassCount: 0, stack: [] };

  for (let i = 1; i <= 8; i++) {
    journal.captureSnapshot(`ACTION_${i}`, dummyState);
  }

  assert.equal(journal.snapshots.length, 5, 'Must clamp to max 5 snapshots');
  assert.equal(journal.snapshots[0].triggerAction, 'ACTION_4', 'Oldest snapshots 1-3 must be evicted');
  assert.equal(journal.snapshots[4].triggerAction, 'ACTION_8', 'Latest snapshot is ACTION_8');
  assert.equal(journal.getSnapshot('non_existent_id'), null);
});

// Edge Case 7: Invalid phase advance or unknown action rejection
runAuditTest('Edge Case 7: Unsupported actionType or invalid phase throws descriptive error', () => {
  const sm = new PriorityStateMachine();
  assert.throws(() => {
    sm.dispatch('INVALID_ACTION_TYPE');
  }, /Unsupported actionType: INVALID_ACTION_TYPE/);

  assert.throws(() => {
    sm.setPhaseStep('INVALID_STEP_NAME');
  }, /Invalid phase\/step: INVALID_STEP_NAME/);

  assert.throws(() => {
    sm.rollbackToCheckpoint('ckpt_invalid_999');
  }, /Checkpoint not found: ckpt_invalid_999/);
});

// Edge Case 8: Observer pattern event emission coverage
runAuditTest('Edge Case 8: Observer pattern emits all lifecycle events', () => {
  const sm = new PriorityStateMachine({ players: ['p1', 'p2'], activePlayerId: 'p1' });
  const observedEvents = [];
  const unsubscribe = sm.subscribe((event) => {
    observedEvents.push(event.type);
  });

  sm.setPhaseStep('UPKEEP');
  sm.createCheckpoint('CUSTOM_SNAP');
  sm.dispatch('CAST_SPELL', { playerId: 'p1', card: { name: 'Opt', typeLine: 'Instant' } });
  sm.dispatch('HOLD_RESPOND', { playerId: 'p2' });
  sm.alarmManager.cancel();
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' }); // resolves

  assert.ok(observedEvents.includes('PHASE_STEP_CHANGED'));
  assert.ok(observedEvents.includes('CHECKPOINT_CAPTURED'));
  assert.ok(observedEvents.includes('STACK_PUSH'));
  assert.ok(observedEvents.includes('PRIORITY_CHANGED'));
  assert.ok(observedEvents.includes('STACK_ALARM_START'));
  assert.ok(observedEvents.includes('STACK_ALARM_HELD'));
  assert.ok(observedEvents.includes('STACK_ALARM_CANCELLED'));
  assert.ok(observedEvents.includes('STACK_RESOLVE'));

  unsubscribe();
  const countBefore = observedEvents.length;
  sm.setPhaseStep('DRAW');
  assert.equal(observedEvents.length, countBefore, 'Unsubscribed observer should not receive events');
});

console.log('\n================================================================');
console.log(`AUDIT SUMMARY: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests.`);
console.log('================================================================\n');

if (failedTests > 0) {
  process.exit(1);
}
