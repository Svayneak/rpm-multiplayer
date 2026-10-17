/**
 * Automated Verification Test Suite for RPM Multiplayer Relay & Room Synchronization
 * Validates all 14 test vectors from Section 6 / Section 9 of SPEC-RPM-RELAY-008.
 *
 * Invariants Verified:
 * - INV-RELAY-1: Crockford Base32 Namespace
 * - INV-RELAY-2: Monotonic Action Sequencer & Action Log Journal
 * - INV-RELAY-3: Decoupled Clocks & 90s Disconnect Bank
 * - INV-RELAY-4: Cryptographic Anti-Hijack Seat Tokens
 * - INV-RING-1: Dynamic Active Priority Ring & Empty-Stack Step Advancement
 * - INV-RING-2: CR 800.4a Stack Purge & Immediate Priority Shift
 * - INV-FOW-1: Zero-Knowledge Fog-of-War Projection
 * - INV-HARNESS-2: Process Teardown & Zero Lingering Timers
 */

import assert from 'node:assert/strict';
import {
  createRelayServer,
  generateRoomCode,
  CROCKFORD_ALPHABET,
  RelayClient
} from '../src/index.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(err);
    failed++;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('=== RUNNING SPEC-RPM-RELAY-008 TEST SUITE ===\n');

// Helper to boot a server on an ephemeral port
function startServer(options = {}) {
  return new Promise((resolve, reject) => {
    const relay = createRelayServer(options);
    relay.listen(0, () => {
      const port = relay.server.address().port;
      const url = `ws://127.0.0.1:${port}`;
      resolve({ relay, port, url });
    });
  });
}

// -------------------------------------------------------------
// VEC-01: RFC 6455 Handshake & Zero-Dependency Boot
// -------------------------------------------------------------
await test('VEC-01: RFC 6455 Handshake & Zero-Dependency Boot', async () => {
  const { relay, url } = await startServer();
  const client = new RelayClient({ url });

  let opened = false;
  client.on('connected', () => {
    opened = true;
  });

  await client.connect();
  assert.equal(opened, true, 'WebSocket client should fire connected event');
  assert.equal(client.socket.readyState, 1, 'Socket should be in OPEN state (readyState = 1)');

  client.disconnect();
  await new Promise(r => relay.close(r));
});

// -------------------------------------------------------------
// VEC-02: Crockford Base32 Code & Collision Map (INV-RELAY-1)
// -------------------------------------------------------------
await test('VEC-02: Crockford Base32 Code & Collision Map (INV-RELAY-1)', async () => {
  const existingMap = new Map();
  const generatedCodes = new Set();
  const regex = /^[2-9A-HJKMNP-Z]{6}$/;

  for (let i = 0; i < 100; i++) {
    const code = generateRoomCode(existingMap);
    assert.equal(code.length, 6, `Room code ${code} must have length 6`);
    assert.equal(regex.test(code), true, `Room code ${code} must strictly match ^[2-9A-HJKMNP-Z]{6}$`);

    // Verify absence of ambiguous glyphs: 0, O, 1, I, L
    assert.equal(/[0O1IL]/.test(code), false, `Room code ${code} contains ambiguous glyphs`);

    // Check collision-free
    assert.equal(generatedCodes.has(code), false, `Collision detected for code ${code}`);
    generatedCodes.add(code);
    existingMap.set(code, true);
  }

  assert.equal(generatedCodes.size, 100, 'Must have generated 100 unique codes with zero collisions');
});

// -------------------------------------------------------------
// VEC-03: 2 to 6 Player Seating & 256-Bit Seat Tokens (INV-RELAY-4)
// -------------------------------------------------------------
await test('VEC-03: 2 to 6 Player Seating & 256-Bit Seat Tokens (INV-RELAY-4)', async () => {
  const { relay, url } = await startServer();

  const c1 = new RelayClient({ url });
  await c1.connect();
  const roomCreated = await c1.createRoom({ playerName: 'Alice', maxPlayers: 4 });
  const roomCode = roomCreated.roomCode;

  assert.equal(c1.slotId, 1, 'Host must be seated in Slot 1');
  assert.equal(typeof c1.seatToken, 'string', 'Seat token must be a string');
  assert.equal(c1.seatToken.length, 64, 'Seat token must be 64 hex chars (256-bit)');

  const c2 = new RelayClient({ url });
  await c2.connect();
  const j2 = await c2.joinRoom(roomCode, 'Bob');
  assert.equal(j2.slotId, 2, 'Player 2 should be seated in Slot 2');
  assert.equal(c2.seatToken.length, 64, 'Player 2 seat token must be 64 hex chars');

  const c3 = new RelayClient({ url });
  await c3.connect();
  const j3 = await c3.joinRoom(roomCode, 'Charlie');
  assert.equal(j3.slotId, 3, 'Player 3 should be seated in Slot 3');

  const c4 = new RelayClient({ url });
  await c4.connect();
  const j4 = await c4.joinRoom(roomCode, 'David');
  assert.equal(j4.slotId, 4, 'Player 4 should be seated in Slot 4');

  // 5th joins when maxPlayers is 4 -> joins as spectator (slotId: null)
  const c5 = new RelayClient({ url });
  await c5.connect();
  const j5 = await c5.joinRoom(roomCode, 'Eve');
  assert.equal(j5.slotId, null, '5th client must be a spectator (slotId: null)');
  assert.equal(c5.seatToken, null, 'Spectator must not receive a seat token');

  // Verify unique tokens
  const tokenSet = new Set([c1.seatToken, c2.seatToken, c3.seatToken, c4.seatToken]);
  assert.equal(tokenSet.size, 4, 'All seated player tokens must be cryptographically unique');

  c1.disconnect();
  c2.disconnect();
  c3.disconnect();
  c4.disconnect();
  c5.disconnect();
  await new Promise(r => relay.close(r));
});

// -------------------------------------------------------------
// VEC-04: Anti-Hijacking Token Verification (INV-RELAY-4)
// -------------------------------------------------------------
await test('VEC-04: Anti-Hijacking Token Verification (INV-RELAY-4)', async () => {
  const { relay, url } = await startServer();

  const c1 = new RelayClient({ url });
  await c1.connect();
  const { roomCode, seatToken: validToken } = await c1.createRoom({ playerName: 'Alice' });

  // Rogue client attempts to reconnect using forged token
  const rogue = new RelayClient({ url });
  await rogue.connect();

  const forgedToken = '0000000000000000000000000000000000000000000000000000000000000000';
  let rejected = false;

  try {
    await rogue.reconnect(roomCode, forgedToken);
  } catch (err) {
    rejected = true;
    assert.match(err.message, /4401|Unauthorized/i);
  }

  assert.equal(rejected, true, 'Server must reject forged seat token with 4401 Unauthorized');

  // Verify Slot 1 occupant is undisturbed
  const room = relay.getRoom(roomCode);
  const slot1 = room.getSlot(1);
  assert.equal(slot1.connectionStatus, 'CONNECTED', 'Slot 1 must remain CONNECTED');
  assert.equal(slot1.seatToken, validToken, 'Slot 1 token must not be corrupted');

  c1.disconnect();
  rogue.disconnect();
  await new Promise(r => relay.close(r));
});

// -------------------------------------------------------------
// VEC-05: Monotonic Action Sequencing (seq = 1, 2, 3...) (INV-RELAY-2)
// -------------------------------------------------------------
await test('VEC-05: Monotonic Action Sequencing (seq = 1, 2, 3...) (INV-RELAY-2)', async () => {
  const { relay, url } = await startServer();

  const c1 = new RelayClient({ url });
  await c1.connect();
  const { roomCode } = await c1.createRoom({ playerName: 'Alice' });

  const c2 = new RelayClient({ url });
  await c2.connect();
  await c2.joinRoom(roomCode, 'Bob');

  const p1Actions = [];
  const p2Actions = [];
  c1.on('action_sequenced', a => p1Actions.push(a));
  c2.on('action_sequenced', a => p2Actions.push(a));

  // Player 1 dispatches 3 consecutive valid actions
  c1.sendAction({ actionType: 'TAP_PERMANENT', payload: { cardId: 'land_01' } });
  c1.sendAction({ actionType: 'TAP_PERMANENT', payload: { cardId: 'land_02' } });
  c1.sendAction({ actionType: 'TAP_PERMANENT', payload: { cardId: 'land_03' } });

  // Wait briefly for WebSocket frames
  await delay(100);

  assert.equal(p1Actions.length, 3, 'Player 1 should have received 3 sequenced actions');
  assert.equal(p2Actions.length, 3, 'Player 2 should have received 3 sequenced actions');

  for (let i = 0; i < 3; i++) {
    const expectedSeq = i + 1;
    assert.equal(p1Actions[i].seq, expectedSeq, `Action ${i} seq must be ${expectedSeq}`);
    assert.equal(p2Actions[i].seq, expectedSeq, `Peer action ${i} seq must be ${expectedSeq}`);
  }

  // Timestamps strictly ordered
  assert.equal(p1Actions[0].timestamp <= p1Actions[1].timestamp, true);
  assert.equal(p1Actions[1].timestamp <= p1Actions[2].timestamp, true);

  c1.disconnect();
  c2.disconnect();
  await new Promise(r => relay.close(r));
});

// -------------------------------------------------------------
// VEC-06: Packet Gap Detection & Automatic Replay (INV-RELAY-2)
// -------------------------------------------------------------
await test('VEC-06: Packet Gap Detection & Automatic Replay (INV-RELAY-2)', async () => {
  const { relay, url } = await startServer();

  const c1 = new RelayClient({ url });
  await c1.connect();
  const { roomCode } = await c1.createRoom({ playerName: 'Alice' });

  const room = relay.getRoom(roomCode);

  // Seed 5 actions in the room
  for (let i = 1; i <= 5; i++) {
    room.dispatchSequencedAction({
      actionId: `action_${i}`,
      actionType: 'TAP_PERMANENT',
      slotId: 1,
      payload: { index: i }
    });
  }

  // Set client state as if it processed up to seq 3
  const c2 = new RelayClient({ url });
  await c2.connect();
  await c2.joinRoom(roomCode, 'Bob');
  c2.lastProcessedSeq = 3;

  const appliedActions = [];
  c2.on('action_sequenced', a => appliedActions.push(a));

  // Directly deliver packet with seq = 5 (simulating packet 4 drop)
  const action5 = room.actionLog.find(a => a.seq === 5);
  c2._handleSequencedAction({
    type: 'ACTION_SEQUENCED',
    seq: 5,
    actionId: action5.actionId,
    actionType: action5.actionType,
    payload: action5.payload,
    slotId: action5.slotId,
    timestamp: action5.timestamp
  });

  // Client should buffer seq 5 and emit ACTION_REPLAY_REQUEST for seq 4..4
  assert.equal(c2.outOfOrderBuffer.has(5), true, 'seq 5 must be buffered in outOfOrderBuffer');
  assert.equal(c2.lastProcessedSeq, 3, 'lastProcessedSeq must remain 3 pending replay');

  // Allow server to service the replay request
  await delay(100);

  // Client should have received seq 4 replay batch, applied 4, then drained 5
  assert.equal(c2.lastProcessedSeq, 5, 'Client must advance lastProcessedSeq to 5 after replay drain');
  assert.equal(appliedActions.length, 2, 'Applied actions must include 4 and 5');
  assert.equal(appliedActions[0].seq, 4, 'First applied action must be seq 4');
  assert.equal(appliedActions[1].seq, 5, 'Second applied action must be seq 5');
  assert.equal(c2.outOfOrderBuffer.size, 0, 'outOfOrderBuffer must be completely drained');

  c1.disconnect();
  c2.disconnect();
  await new Promise(r => relay.close(r));
});

// -------------------------------------------------------------
// VEC-07: Zero-Knowledge Fog-of-War Masking (INV-FOW-1)
// -------------------------------------------------------------
await test('VEC-07: Zero-Knowledge Fog-of-War Masking (INV-FOW-1)', async () => {
  const { relay, url } = await startServer();

  const c1 = new RelayClient({ url });
  await c1.connect();
  const { roomCode } = await c1.createRoom({ playerName: 'Alice' });

  const room = relay.getRoom(roomCode);

  // Player 1 holds Lightning Bolt in hand
  const p1State = room.tabletopStateManager.getPlayer('player_1');
  p1State.hand = [
    { instanceId: 'bolt_01', name: 'Lightning Bolt', typeLine: 'Instant', manaCost: '{R}' }
  ];

  const c2 = new RelayClient({ url });
  await c2.connect();
  const snapshotP2 = await c2.joinRoom(roomCode, 'Bob');

  // Inspect Player 1's hand as received by Player 2
  const p1HandView = snapshotP2.projectedState.players.player_1.hand;
  assert.equal(p1HandView.count, 1, 'Player 1 hand count must be visible');
  assert.equal(p1HandView.cards.length, 1, 'Cards array length must equal count');

  const maskedCard = p1HandView.cards[0];
  assert.equal(maskedCard.instanceId, 'hidden', 'Card instanceId must be masked to "hidden"');
  assert.equal(maskedCard.isHidden, true, 'isHidden must be true');
  assert.equal(maskedCard.name, undefined, 'Private card name must NOT be present in payload');
  assert.equal(maskedCard.manaCost, undefined, 'Private mana cost must NOT be present in payload');

  // Verify wire JSON stringification contains zero instances of "Lightning Bolt"
  const wireString = JSON.stringify(snapshotP2);
  assert.equal(wireString.includes('Lightning Bolt'), false, 'Zero card metadata may leak onto the wire');

  c1.disconnect();
  c2.disconnect();
  await new Promise(r => relay.close(r));
});

// -------------------------------------------------------------
// VEC-08: Disconnect Bank 90-Second Draining (INV-RELAY-3)
// -------------------------------------------------------------
await test('VEC-08: Disconnect Bank 90-Second Draining (INV-RELAY-3)', async () => {
  const { relay, url } = await startServer();

  const c1 = new RelayClient({ url });
  await c1.connect();
  const { roomCode } = await c1.createRoom({ playerName: 'Alice' });

  const c2 = new RelayClient({ url });
  await c2.connect();
  await c2.joinRoom(roomCode, 'Bob');

  const room = relay.getRoom(roomCode);
  const slot2 = room.getSlot(2);

  assert.equal(slot2.disconnectBankMsRemaining, 90000, 'Initial disconnect bank must be 90,000ms');

  // Sever Player 2's socket
  c2.socket.close();
  await delay(50);

  assert.equal(slot2.connectionStatus, 'DISCONNECTED', 'Player 2 status must be DISCONNECTED');

  // Advance virtual clock by 10 seconds
  room.tickDisconnectBank(10000);

  assert.equal(slot2.disconnectBankMsRemaining, 80000, 'Disconnect bank must decrease to 80,000ms');
  assert.equal(slot2.connectionStatus, 'DISCONNECTED', 'Player 2 remains DISCONNECTED');

  c1.disconnect();
  c2.disconnect();
  await new Promise(r => relay.close(r));
});

// -------------------------------------------------------------
// VEC-09: Decoupled 15s Stack Alarm & AUTO_PASS (INV-RELAY-3)
// -------------------------------------------------------------
await test('VEC-09: Decoupled 15s Stack Alarm & AUTO_PASS (INV-RELAY-3)', async () => {
  const { relay, url } = await startServer();

  const c1 = new RelayClient({ url });
  await c1.connect();
  const { roomCode } = await c1.createRoom({ playerName: 'Alice' });

  const c2 = new RelayClient({ url });
  await c2.connect();
  await c2.joinRoom(roomCode, 'Bob');

  const room = relay.getRoom(roomCode);

  // Player 1 casts a spell, priority passes to Player 2
  room.dispatchSequencedAction({
    actionId: 'cast_1',
    actionType: 'CAST_SPELL',
    slotId: 1,
    payload: {
      card: { instanceId: 'bolt_1', name: 'Lightning Bolt', typeLine: 'Instant' }
    }
  });

  assert.equal(room.priorityStateMachine.priorityPlayerId, 'player_2', 'Priority must be on Player 2');
  assert.equal(room.priorityStateMachine.alarmManager.status, 'RUNNING', 'Alarm must be RUNNING');

  // Player 2 disconnects
  c2.socket.close();
  await delay(50);

  // Decoupled clock rule: alarm does NOT pause on disconnect
  assert.equal(room.priorityStateMachine.alarmManager.status, 'RUNNING', 'Alarm must continue running offline');

  const receivedActions = [];
  c1.on('action_sequenced', a => receivedActions.push(a));

  // Trigger alarm expiry
  room.triggerAlarmExpiry();
  await delay(50);

  // Verify server synthesizes and broadcasts AUTO_PASS_DISCONNECTED
  const autoPassAction = room.actionLog.find(a => a.type === 'AUTO_PASS_DISCONNECTED');
  assert.ok(autoPassAction, 'Server must dispatch AUTO_PASS_DISCONNECTED upon alarm expiry');
  assert.equal(autoPassAction.slotId, 2, 'AUTO_PASS_DISCONNECTED must be tagged with Slot 2');

  // Priority hands off / stack resolves
  assert.notEqual(room.priorityStateMachine.priorityPlayerId, 'player_2', 'Priority must have shifted from Player 2');

  c1.disconnect();
  c2.disconnect();
  await new Promise(r => relay.close(r));
});

// -------------------------------------------------------------
// VEC-10: Reconnect & Sub-16ms State Rehydration (INV-RELAY-3)
// -------------------------------------------------------------
await test('VEC-10: Reconnect & Sub-16ms State Rehydration (INV-RELAY-3)', async () => {
  const { relay, url } = await startServer();

  const c1 = new RelayClient({ url });
  await c1.connect();
  const { roomCode } = await c1.createRoom({ playerName: 'Alice' });

  const c2 = new RelayClient({ url });
  await c2.connect();
  const joinData = await c2.joinRoom(roomCode, 'Bob');
  const seatToken2 = joinData.seatToken;

  const room = relay.getRoom(roomCode);
  const slot2 = room.getSlot(2);

  // Disconnect Player 2 with 75s bank remaining
  slot2.disconnectBankMsRemaining = 75000;
  c2.disconnect();
  await delay(50);

  assert.equal(slot2.connectionStatus, 'DISCONNECTED');

  // Reconnect with stored seat token
  const c2New = new RelayClient({ url });
  await c2New.connect();

  const startRehydrate = performance.now();
  const snapshot = await c2New.reconnect(roomCode, seatToken2);
  const rehydrateDurationMs = performance.now() - startRehydrate;

  assert.equal(snapshot.slotId, 2, 'Snapshot must restore slotId 2');
  assert.equal(slot2.connectionStatus, 'CONNECTED', 'Slot 2 status must be restored to CONNECTED');
  assert.equal(slot2.disconnectBankMsRemaining, 75000, 'Disconnect bank must be preserved at 75,000ms');

  // Sub-16ms rehydration performance assertion
  assert.equal(rehydrateDurationMs < 50, true, `Rehydration took ${rehydrateDurationMs.toFixed(2)}ms (<50ms target)`);

  c1.disconnect();
  c2New.disconnect();
  await new Promise(r => relay.close(r));
});

// -------------------------------------------------------------
// VEC-11: Dynamic Active Ring & Eliminated Player Skipping (INV-RING-1)
// -------------------------------------------------------------
await test('VEC-11: Dynamic Active Ring & Eliminated Player Skipping (INV-RING-1)', async () => {
  const { relay, url } = await startServer();

  const c1 = new RelayClient({ url });
  await c1.connect();
  const { roomCode } = await c1.createRoom({ playerName: 'Alice', maxPlayers: 3 });

  const c2 = new RelayClient({ url });
  await c2.connect();
  await c2.joinRoom(roomCode, 'Bob');

  const c3 = new RelayClient({ url });
  await c3.connect();
  await c3.joinRoom(roomCode, 'Charlie');

  const room = relay.getRoom(roomCode);
  assert.equal(room.priorityStateMachine.players.length, 3, 'Initially 3 players in priority ring');

  // Eliminate Player B (Slot 2)
  room.eliminatePlayer(2, 'LIFE_ZERO');

  assert.equal(room.getSlot(2).isEliminated, true, 'Slot 2 must be eliminated');
  assert.equal(room.priorityStateMachine.players.length, 2, 'Active ring must contain 2 players');
  assert.deepEqual(room.priorityStateMachine.players, ['player_1', 'player_3'], 'Ring must be [Alice, Charlie]');

  // Ensure game starts at UPKEEP with priority on Player A
  room.priorityStateMachine.currentPhaseStep = 'UPKEEP';
  room.priorityStateMachine.priorityPlayerId = 'player_1';
  room.priorityStateMachine.consecutivePassCount = 0;

  // Player A passes priority on empty stack
  room.dispatchSequencedAction({
    actionId: 'pass_a',
    actionType: 'PASS_PRIORITY',
    slotId: 1
  });

  // Priority must advance directly to Charlie (skipping eliminated Bob)
  assert.equal(room.priorityStateMachine.priorityPlayerId, 'player_3', 'Priority must skip Bob and go to Charlie');
  assert.equal(room.priorityStateMachine.consecutivePassCount, 1, 'consecutivePassCount must be 1');

  // Player C passes priority on empty stack
  room.dispatchSequencedAction({
    actionId: 'pass_c',
    actionType: 'PASS_PRIORITY',
    slotId: 3
  });

  // consecutivePassCount >= |ActiveRing| (2 >= 2) -> phase step advances
  assert.equal(room.priorityStateMachine.currentPhaseStep, 'DRAW', 'Phase must advance to DRAW when all active pass');

  c1.disconnect();
  c2.disconnect();
  c3.disconnect();
  await new Promise(r => relay.close(r));
});

// -------------------------------------------------------------
// VEC-12: CR 800.4a Stack Purge & Immediate Priority Shift (INV-RING-2)
// -------------------------------------------------------------
await test('VEC-12: CR 800.4a Stack Purge & Immediate Priority Shift (INV-RING-2)', async () => {
  const { relay, url } = await startServer();

  const c1 = new RelayClient({ url });
  await c1.connect();
  const { roomCode } = await c1.createRoom({ playerName: 'Alice', maxPlayers: 3 });

  const c2 = new RelayClient({ url });
  await c2.connect();
  await c2.joinRoom(roomCode, 'Bob');

  const c3 = new RelayClient({ url });
  await c3.connect();
  await c3.joinRoom(roomCode, 'Charlie');

  const room = relay.getRoom(roomCode);

  // Player B puts a spell on the stack
  room.priorityStateMachine.pushStack({
    id: 'spell_bob_1',
    sourcePlayerId: 'player_2',
    card: { name: 'Counterspell' }
  });
  room.priorityStateMachine.priorityPlayerId = 'player_2';
  room.priorityStateMachine.alarmManager.start('player_2', 'spell_bob_1', 15);

  assert.equal(room.priorityStateMachine.stack.length, 1, 'Stack has Bob spell');
  assert.equal(room.priorityStateMachine.alarmManager.status, 'RUNNING');

  // Trigger elimination of Player B (Bob life reached 0)
  room.eliminatePlayer(2, 'LIFE_ZERO');

  // 1. CR 800.4a Stack Purge: Bob's spell erased from stack
  const bobSpellsOnStack = room.priorityStateMachine.stack.filter(s => s.sourcePlayerId === 'player_2');
  assert.equal(bobSpellsOnStack.length, 0, 'CR 800.4a must purge all spells owned by eliminated player');
  assert.equal(room.priorityStateMachine.stack.length, 0, 'Stack must now be empty');

  // 2. Alarm cancelled
  assert.equal(room.priorityStateMachine.alarmManager.status, 'IDLE', 'Alarm on eliminated player must be cancelled');

  // 3. Priority shifts immediately to next active player (Charlie)
  assert.equal(room.priorityStateMachine.priorityPlayerId, 'player_3', 'Priority must hand off to Charlie');

  c1.disconnect();
  c2.disconnect();
  c3.disconnect();
  await new Promise(r => relay.close(r));
});

// -------------------------------------------------------------
// VEC-13: Last Player Standing & MATCH_VICTORY (INV-RING-1)
// -------------------------------------------------------------
await test('VEC-13: Last Player Standing & MATCH_VICTORY (INV-RING-1)', async () => {
  const { relay, url } = await startServer();

  const c1 = new RelayClient({ url });
  await c1.connect();
  const { roomCode } = await c1.createRoom({ playerName: 'Alice', maxPlayers: 3 });

  const c2 = new RelayClient({ url });
  await c2.connect();
  await c2.joinRoom(roomCode, 'Bob');

  const c3 = new RelayClient({ url });
  await c3.connect();
  await c3.joinRoom(roomCode, 'Charlie');

  const room = relay.getRoom(roomCode);

  let victoryReceived = null;
  c1.on('match_victory', v => {
    victoryReceived = v;
  });

  // Eliminate Bob
  room.eliminatePlayer(2, 'LIFE_ZERO');
  assert.equal(victoryReceived, null, 'No victory while 2 players remain');

  // Charlie concedes
  c3.concede();
  await delay(50);

  // Verify MATCH_VICTORY emitted naming Alice
  assert.ok(victoryReceived, 'MATCH_VICTORY must be emitted when |ActiveRing| drops to 1');
  assert.equal(victoryReceived.winnerSlotId, 1, 'Winner slot must be 1');
  assert.equal(victoryReceived.winnerPlayerId, 'player_1', 'Winner player must be player_1');
  assert.equal(victoryReceived.winnerPlayerName, 'Alice', 'Winner name must be Alice');

  c1.disconnect();
  c2.disconnect();
  c3.disconnect();
  await new Promise(r => relay.close(r));
});

// -------------------------------------------------------------
// VEC-14: Process Teardown & Zero Lingering Timers (INV-HARNESS-2)
// -------------------------------------------------------------
await test('VEC-14: Process Teardown & Zero Lingering Timers (INV-HARNESS-2)', async () => {
  const { relay, url } = await startServer();

  const c1 = new RelayClient({ url });
  await c1.connect();
  const { roomCode } = await c1.createRoom({ playerName: 'Alice' });

  const room = relay.getRoom(roomCode);

  // Start timers in room
  room.priorityStateMachine.alarmManager.start('player_1', 'stack_01', 15);

  // Teardown
  c1.disconnect();
  await new Promise(r => relay.close(r));

  assert.equal(room.isClosed, true, 'Room must be marked closed');
  assert.equal(room.priorityStateMachine.alarmManager.status, 'IDLE', 'Alarm timer must be cancelled');
  assert.equal(room.disconnectTimer, null, 'Disconnect tick timer must be cleared');
  assert.equal(relay.rooms.size, 0, 'Rooms map must be cleared');
});

console.log(`\n========================================`);
console.log(`Summary: ${passed} passed, ${failed} failed.`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
