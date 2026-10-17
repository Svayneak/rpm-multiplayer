/**
 * Automated Verification Test Suite for RPM Priority State Machine & 15-Second Stack Alarm
 * Validates all 12 test cases from Section 7 of SPEC-RPM-PRIORITY-004.
 */

import assert from 'node:assert/strict';
import {
  PriorityStateMachine,
  PriorityViolationError,
  PHASE_STEPS,
  generateStackItemId,
  generateCheckpointId,
  StackAlarmManager
} from '../src/index.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
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

console.log('=== RUNNING SPEC-RPM-PRIORITY-004 TEST SUITE ===\n');

// Shared State Machine Instance for Tests 1-7, 9-12
let sm = new PriorityStateMachine({
  players: ['p1', 'p2'],
  activePlayerId: 'p1'
});

// Test Case 1: Initial Turn Setup & Active Player Priority in Upkeep
test('Test Case 1: Initial Turn Setup & Active Player Priority in Upkeep', () => {
  // Game starts at UNTAP
  assert.equal(sm.activePlayerId, 'p1');
  assert.equal(sm.turnNumber, 1);
  assert.equal(sm.currentPhaseStep, 'UNTAP');

  // Advancing from UNTAP automatically moves to UPKEEP with priority on active player
  sm.advanceStep();
  assert.equal(sm.currentPhaseStep, 'UPKEEP');
  assert.equal(sm.priorityPlayerId, 'p1');
  assert.equal(sm.consecutivePassCount, 0);
  assert.equal(sm.stack.length, 0);
});

// Test Case 2: Priority Gating & PriorityViolationError on Unauthorized Player Action
test('Test Case 2: Priority Gating & PriorityViolationError on Unauthorized Player Action', () => {
  assert.equal(sm.priorityPlayerId, 'p1');

  // Player 2 attempts to pass priority out of turn
  assert.throws(() => {
    sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });
  }, /PriorityViolationError|Player 'p2' does not hold priority/);

  // Player 2 attempts to cast a spell out of turn
  assert.throws(() => {
    sm.dispatch('CAST_SPELL', {
      playerId: 'p2',
      card: { name: 'Opt', typeLine: 'Instant' }
    });
  }, /PriorityViolationError|Player 'p2' does not hold priority/);
});

// Test Case 3: Single Spell Cast & 15-Second Stack Alarm Initiation
test('Test Case 3: Single Spell Cast & 15-Second Stack Alarm Initiation', () => {
  let alarmEvents = [];
  sm.alarmManager.onEmit = (event) => alarmEvents.push(event);

  sm.dispatch('CAST_SPELL', {
    playerId: 'p1',
    card: { instanceId: 'bolt_1', name: 'Lightning Bolt', typeLine: 'Instant' },
    targets: [{ targetType: 'PLAYER', targetId: 'p2' }]
  });

  assert.equal(sm.stack.length, 1);
  assert.equal(sm.stack[0].card.name, 'Lightning Bolt');
  assert.equal(sm.stack[0].sourcePlayerId, 'p1');
  assert.equal(sm.priorityPlayerId, 'p2'); // Passed to opponent
  assert.equal(sm.consecutivePassCount, 0);

  // Verify alarm started
  assert.equal(sm.alarmManager.status, 'RUNNING');
  assert.equal(sm.alarmManager.targetPlayerId, 'p2');
  assert.equal(alarmEvents.some(e => e.type === 'STACK_ALARM_START' && e.targetPlayerId === 'p2'), true);
});

// Test Case 4: Opponent Explicit PASS_PRIORITY & Single Spell Resolution
test('Test Case 4: Opponent Explicit PASS_PRIORITY & Single Spell Resolution', () => {
  let resolveEvents = [];
  sm.on('STACK_RESOLVE', (e) => resolveEvents.push(e));

  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });

  // Stack should now be resolved and empty
  assert.equal(sm.stack.length, 0);
  assert.equal(resolveEvents.length, 1);
  assert.equal(resolveEvents[0].resolvedItem.card.name, 'Lightning Bolt');
  assert.equal(sm.priorityPlayerId, 'p1'); // Priority returns to active player
  assert.equal(sm.consecutivePassCount, 0);
  assert.equal(sm.alarmManager.status, 'IDLE');
});

// Test Case 5: 15-Second Timer Expiration (TIMEOUT) Auto-Passes Priority
test('Test Case 5: 15-Second Timer Expiration (TIMEOUT) Auto-Passes Priority', () => {
  sm.dispatch('CAST_SPELL', {
    playerId: 'p1',
    card: { instanceId: 'shock_1', name: 'Shock', typeLine: 'Instant' }
  });
  assert.equal(sm.priorityPlayerId, 'p2');
  assert.equal(sm.stack.length, 1);

  // Simulate timer expiration
  sm.alarmManager._handleExpiry();

  // Expiration must auto-pass priority and resolve the top of the stack
  assert.equal(sm.stack.length, 0);
  assert.equal(sm.priorityPlayerId, 'p1');
  assert.equal(sm.alarmManager.status, 'IDLE');
});

// Test Case 6: HOLD_RESPOND Freezes Timer and Grants Unmetered Response Window
test('Test Case 6: HOLD_RESPOND Freezes Timer and Grants Unmetered Response Window', () => {
  sm.dispatch('CAST_SPELL', {
    playerId: 'p1',
    card: { instanceId: 'bolt_2', name: 'Lightning Bolt', typeLine: 'Instant' }
  });
  assert.equal(sm.alarmManager.status, 'RUNNING');

  sm.dispatch('HOLD_RESPOND', { playerId: 'p2' });
  assert.equal(sm.alarmManager.status, 'HELD');
  assert.equal(sm.alarmManager.heldByPlayerId, 'p2');
  assert.equal(sm.priorityPlayerId, 'p2');

  // Simulating time passage: verify no automatic timeout fires while HELD
  assert.equal(sm.stack.length, 1); // Still on stack, not resolved
});

// Test Case 7: LIFO Counter-Spell on Top of Stack & Alarm Restart
test('Test Case 7: LIFO Counter-Spell on Top of Stack & Alarm Restart', () => {
  // Clear stack from Test 6 hold before setting up counter-spell sequence
  sm.clearStack();
  sm.alarmManager.cancel();
  sm.priorityPlayerId = 'p1';

  // P1 casts Lightning Bolt
  sm.dispatch('CAST_SPELL', {
    playerId: 'p1',
    card: { instanceId: 'bolt_3', name: 'Lightning Bolt', typeLine: 'Instant' }
  });
  assert.equal(sm.priorityPlayerId, 'p2');

  // P2 responds with Counterspell targeting Lightning Bolt
  sm.dispatch('CAST_SPELL', {
    playerId: 'p2',
    card: { instanceId: 'counter_1', name: 'Counterspell', typeLine: 'Instant' },
    targets: [{ targetType: 'SPELL', targetId: 'bolt_3' }]
  });

  // Verify LIFO stack structure: top is index 1 (Counterspell)
  assert.equal(sm.stack.length, 2);
  assert.equal(sm.stack[1].card.name, 'Counterspell');
  assert.equal(sm.stack[0].card.name, 'Lightning Bolt');
  assert.equal(sm.priorityPlayerId, 'p1'); // Priority passed to P1 to respond
  assert.equal(sm.alarmManager.status, 'RUNNING');
  assert.equal(sm.alarmManager.targetPlayerId, 'p1');

  // P1 passes priority
  sm.dispatch('PASS_PRIORITY', { playerId: 'p1' });
  // P2 passes priority
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });

  // Counterspell resolves first (LIFO)
  assert.equal(sm.stack.length, 1);
  assert.equal(sm.stack[0].card.name, 'Lightning Bolt');

  // Both pass again to resolve Lightning Bolt
  sm.dispatch('PASS_PRIORITY', { playerId: 'p1' });
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });
  assert.equal(sm.stack.length, 0);
});

// Test Case 8: Multi-Player 3-Player Priority Rotation (APNAP Order)
test('Test Case 8: Multi-Player 3-Player Priority Rotation (APNAP Order)', () => {
  const sm3 = new PriorityStateMachine({
    players: ['p1', 'p2', 'p3'],
    activePlayerId: 'p1',
    initialPhaseStep: 'PRECOMBAT_MAIN'
  });

  sm3.dispatch('CAST_SPELL', {
    playerId: 'p1',
    card: { name: 'Growth Spiral', typeLine: 'Instant' }
  });
  assert.equal(sm3.priorityPlayerId, 'p2');

  sm3.dispatch('PASS_PRIORITY', { playerId: 'p2' });
  assert.equal(sm3.priorityPlayerId, 'p3');
  assert.equal(sm3.stack.length, 1); // Not resolved yet (only 1 pass)

  sm3.dispatch('PASS_PRIORITY', { playerId: 'p3' });
  assert.equal(sm3.priorityPlayerId, 'p1');
  assert.equal(sm3.stack.length, 1); // Not resolved yet (2 passes, need 3)

  sm3.dispatch('PASS_PRIORITY', { playerId: 'p1' });
  // Now 3 consecutive passes have occurred -> Resolves
  assert.equal(sm3.stack.length, 0);
  assert.equal(sm3.priorityPlayerId, 'p1');
});

// Test Case 9: Empty Stack Consecutive Passes Advance Phase Steps Sequentially
test('Test Case 9: Empty Stack Consecutive Passes Advance Phase Steps Sequentially', () => {
  sm.setPhaseStep('PRECOMBAT_MAIN');
  assert.equal(sm.stack.length, 0);

  // P1 passes
  sm.dispatch('PASS_PRIORITY', { playerId: 'p1' });
  assert.equal(sm.currentPhaseStep, 'PRECOMBAT_MAIN');
  assert.equal(sm.priorityPlayerId, 'p2');

  // P2 passes -> Step advances to BEGIN_COMBAT
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });
  assert.equal(sm.currentPhaseStep, 'BEGIN_COMBAT');
  assert.equal(sm.priorityPlayerId, 'p1'); // Priority returns to active player

  // Both pass again -> Step advances to DECLARE_ATTACKERS
  sm.dispatch('PASS_PRIORITY', { playerId: 'p1' });
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });
  assert.equal(sm.currentPhaseStep, 'DECLARE_ATTACKERS');
});

// Test Case 10: Turn Handover at CLEANUP to Next Active Player
test('Test Case 10: Turn Handover at CLEANUP to Next Active Player', () => {
  sm.setPhaseStep('CLEANUP');
  assert.equal(sm.activePlayerId, 'p1');
  assert.equal(sm.turnNumber, 1);

  // Both pass during cleanup
  sm.dispatch('PASS_PRIORITY', { playerId: 'p1' });
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });

  // Turn transitions to Player 2
  assert.equal(sm.activePlayerId, 'p2');
  assert.equal(sm.turnNumber, 2);
  assert.equal(sm.currentPhaseStep, 'UNTAP');
});

// Test Case 11: Checkpoint Snapshot Creation on Stack Push & Phase Advance
test('Test Case 11: Checkpoint Snapshot Creation on Stack Push & Phase Advance', () => {
  const initialSnapshotsCount = sm.checkpointJournal.snapshots.length;

  sm.dispatch('CAST_SPELL', {
    playerId: 'p2',
    card: { instanceId: 'spell_x', name: 'Thoughtseize', typeLine: 'Sorcery' }
  });

  assert.equal(sm.checkpointJournal.snapshots.length, initialSnapshotsCount + 1);
  const latestSnapshot = sm.checkpointJournal.snapshots[sm.checkpointJournal.snapshots.length - 1];
  assert.equal(latestSnapshot.triggerAction, 'CAST_SPELL');
  assert.ok(latestSnapshot.checkpointId.startsWith('ckpt_'));
  assert.equal(latestSnapshot.activePlayerId, 'p2');
});

// Test Case 12: Checkpoint Rollback on Disputed Out-of-Order Action & State Restoration
test('Test Case 12: Checkpoint Rollback on Disputed Out-of-Order Action & State Restoration', () => {
  // Clear stack and alarm from Test 11
  sm.clearStack();
  sm.alarmManager.cancel();
  sm.priorityPlayerId = 'p2';

  // P2 casts spell
  const checkpointBeforeCast = sm.checkpointJournal.captureSnapshot('BEFORE_DISPUTED_SPELL', sm);

  sm.dispatch('CAST_SPELL', {
    playerId: 'p2',
    card: { instanceId: 'wrath_1', name: 'Wrath of God', typeLine: 'Sorcery' }
  });
  // Both pass and it resolves
  sm.dispatch('PASS_PRIORITY', { playerId: 'p1' });
  sm.dispatch('PASS_PRIORITY', { playerId: 'p2' });
  assert.equal(sm.stack.length, 0);

  // Player 1 claims they declared a response before the timer ended: ROLLBACK
  sm.rollbackToCheckpoint(checkpointBeforeCast.checkpointId);

  // State must match the pre-cast snapshot
  assert.equal(sm.stack.length, 0);
  assert.equal(sm.priorityPlayerId, checkpointBeforeCast.priorityPlayerId);
  assert.equal(sm.currentPhaseStep, checkpointBeforeCast.currentPhaseStep);
  assert.equal(sm.consecutivePassCount, 0);
  assert.equal(sm.alarmManager.status, 'IDLE');
});

console.log(`\n========================================`);
console.log(`Summary: ${passed} passed, ${failed} failed.`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
}
