/**
 * Authoritative Zero-Dependency Node.js HTTP & RFC 6455 WebSocket Server
 * Part of RPM Multiplayer - Feature 8 (Multiplayer WebSocket Relay & Room Synchronization)
 *
 * Specification: SPEC-RPM-RELAY-008
 *
 * Core Capabilities:
 * - RFC 6455 WebSocket Framing & Upgrade Engine (zero external dependencies)
 * - Crockford Base32 Collision-Free Room Code Generator (INV-RELAY-1)
 * - Monotonic Action Sequencer (INV-RELAY-2)
 * - Decoupled Clocks & 90s Disconnect Bank Manager (INV-RELAY-3)
 * - 256-bit Cryptographic Anti-Hijack Seat Tokens (INV-RELAY-4)
 * - Dynamic Active Priority Ring & CR 800.4a Elimination Engine (INV-RING-1, INV-RING-2)
 * - Zero-Knowledge Fog-of-War Projection (INV-FOW-1)
 * - Clean Teardown & Process Leak Guards (INV-HARNESS-2)
 *
 * @module relay
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { TabletopStateManager, projectState } from './TabletopStateManager.js';
import { PriorityStateMachine, PriorityViolationError } from './PriorityStateMachine.js';
import { StackAlarmManager } from './StackAlarmManager.js';
import { LobbyManager, LOBBY_STATUS } from './LobbyManager.js';
import { MatchmakingQueue } from './MatchmakingQueue.js';
import { TurnRollOffManager } from './TurnRollOffManager.js';

/**
 * Crockford Base32 31-symbol alphabet for room codes.
 * Excludes ambiguous glyphs: 0, O, 1, I, L.
 */
export const CROCKFORD_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Generates a collision-free 6-character Crockford Base32 room code.
 *
 * @param {Map<string, any>|Set<string>} existingRoomsMap
 * @returns {string} 6-character room code matching ^[2-9A-HJKMNP-Z]{6}$
 */
export function generateRoomCode(existingRoomsMap = new Map()) {
  let code = '';
  let attempts = 0;
  const isTaken = (c) => {
    if (typeof existingRoomsMap.has === 'function') {
      return existingRoomsMap.has(c);
    }
    return Boolean(existingRoomsMap[c]);
  };

  do {
    code = '';
    const randomBytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
      code += CROCKFORD_ALPHABET[randomBytes[i] % CROCKFORD_ALPHABET.length];
    }
    attempts++;
    if (attempts > 50) {
      throw new Error('Room code collision exhaustion limit reached');
    }
  } while (isTaken(code));

  return code;
}

/**
 * Constant-time safe string comparator.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * RFC 6455 WebSocket Connection wrapping a raw net.Socket / Duplex stream.
 */
export class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.isClosed = false;
    this.roomCode = null;
    this.slotId = null;

    // Rate limiting tracking
    this.actionTimestamps = [];

    this._boundOnData = (chunk) => this._onData(chunk);
    this._boundOnClose = () => this._onClose();
    this._boundOnError = (err) => {
      this.emit('error', err);
      this._onClose();
    };

    socket.on('data', this._boundOnData);
    socket.on('close', this._boundOnClose);
    socket.on('end', this._boundOnClose);
    socket.on('error', this._boundOnError);
  }

  /**
   * Asserts and records rate limiting (max 25 actions / sec).
   *
   * @returns {boolean} True if within limit, false if exceeded.
   */
  checkRateLimit(maxPerSecond = 25) {
    const now = Date.now();
    this.actionTimestamps = this.actionTimestamps.filter(t => now - t < 1000);
    if (this.actionTimestamps.length >= maxPerSecond) {
      return false;
    }
    this.actionTimestamps.push(now);
    return true;
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this._parseFrames();
  }

  _parseFrames() {
    while (this.buffer.length >= 2) {
      const byte0 = this.buffer[0];
      const byte1 = this.buffer[1];

      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;

      let offset = 2;
      if (payloadLen === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLen = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (this.buffer.length < offset + 8) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + payloadLen) {
        // Frame not fully received yet
        return;
      }

      const rawPayload = this.buffer.subarray(offset, offset + payloadLen);
      const payload = Buffer.allocUnsafe(payloadLen);
      if (masked && maskKey) {
        for (let i = 0; i < payloadLen; i++) {
          payload[i] = rawPayload[i] ^ maskKey[i % 4];
        }
      } else {
        rawPayload.copy(payload);
      }

      // Advance buffer past this frame
      this.buffer = this.buffer.subarray(offset + payloadLen);

      // Handle opcodes
      if (opcode === 0x1) {
        // Text frame
        const text = payload.toString('utf8');
        this.emit('message', text);
      } else if (opcode === 0x8) {
        // Close frame
        let code = 1000;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          if (payload.length > 2) {
            reason = payload.subarray(2).toString('utf8');
          }
        }
        this.close(code, reason);
        return;
      } else if (opcode === 0x9) {
        // Ping -> respond with Pong
        this._sendFrame(0x0a, payload);
      } else if (opcode === 0x0a) {
        // Pong
        this.emit('pong');
      }
    }
  }

  /**
   * Transmits an unmasked UTF-8 text frame to client (RFC 6455).
   *
   * @param {string|Object} data
   */
  send(data) {
    if (this.isClosed || !this.socket || !this.socket.writable) return;
    const payload = Buffer.isBuffer(data)
      ? data
      : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
    this._sendFrame(0x1, payload);
  }

  _sendFrame(opcode, payload = Buffer.alloc(0)) {
    if (this.isClosed || !this.socket || !this.socket.writable) return;
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = len; // Mask bit is 0 for server->client
    } else if (len <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Closes the WebSocket connection with an RFC 6455 close frame.
   *
   * @param {number} [code=1000]
   * @param {string} [reason='']
   */
  close(code = 1000, reason = '') {
    if (this.isClosed) return;
    this.isClosed = true;

    try {
      const reasonBuf = Buffer.from(reason, 'utf8');
      const payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);

      this._sendFrame(0x8, payload);
      this.socket.end();
    } catch (e) {
      // Socket may already be dead
    }

    this.emit('close', code, reason);
  }

  _onClose() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit('close', 1006, 'Connection terminated abnormally');
  }
}

/**
 * Authoritative Room Session Subsystem.
 */
export class RoomSession {
  /**
   * @param {string} roomCode
   * @param {Object} [options={}]
   */
  constructor(roomCode, options = {}) {
    this.roomCode = roomCode;
    this.sessionId = options.sessionId || crypto.randomUUID();
    this.maxPlayers = Math.min(6, Math.max(2, options.maxPlayers || 4));
    this.roomType = options.roomType || (this.maxPlayers === 2 ? 'DUEL_1V1' : 'POD_MULTIPLAYER');
    this.lifecycleStatus = options.lifecycleStatus || LOBBY_STATUS.LOBBY_WAITING;
    this.startingLife = options.startingLife || 20;
    this.alarmDurationSeconds = options.alarmDurationSeconds || 15;
    this.disconnectBankTotalMs = options.disconnectBankTotalMs || 90000;

    /** @type {Map<number, Object>} slotId -> PlayerSlot */
    this.slots = new Map();
    /** @type {Set<WebSocketConnection>} */
    this.spectators = new Set();

    this.currentSeq = 0;
    /** @type {Array<Object>} */
    this.actionLog = [];
    this.isClosed = false;

    // Feature 14 Lobby & Roll-Off Managers
    this.lobbyManager = new LobbyManager({
      roomCode: this.roomCode,
      maxPlayers: this.maxPlayers,
      roomType: this.roomType,
      minPlayersToStart: options.minPlayersToStart
    });
    this.turnRollOffManager = null;

    this.lobbyManager.on('readiness_reset', (evt) => {
      this.broadcast({
        type: 'LOBBY_READY_RESET',
        ...evt
      });
    });

    this.lobbyManager.on('match_ready', () => {
      this.transitionToRollOff();
    });

    this.lobbyManager.on('auto_start', () => {
      this.transitionToRollOff();
    });

    // Subsystem instances
    this.tabletopStateManager = new TabletopStateManager({
      sessionId: this.sessionId,
      activePlayerId: null,
      turnNumber: 1
    });

    this.priorityStateMachine = new PriorityStateMachine({
      sessionId: this.sessionId,
      players: ['player_1'],
      activePlayerId: 'player_1',
      priorityPlayerId: 'player_1',
      defaultDurationSeconds: this.alarmDurationSeconds,
      alarmManager: new StackAlarmManager({
        defaultDurationSeconds: this.alarmDurationSeconds,
        onTimeout: (expiredPlayerId, expiredStackItemId) => {
          this._handleAlarmTimeout(expiredPlayerId, expiredStackItemId);
        }
      })
    });

    // Disconnect tick loop (1000ms, unref enabled for clean harness exit)
    this.lastTickTime = Date.now();
    this.disconnectTimer = setInterval(() => {
      this._tickDisconnects();
    }, 1000);
    if (this.disconnectTimer && typeof this.disconnectTimer.unref === 'function') {
      this.disconnectTimer.unref();
    }
  }

  /**
   * Transitions room to pre-game d20 roll-off phase (INV-TURNSORT-1).
   */
  transitionToRollOff() {
    this.lifecycleStatus = LOBBY_STATUS.ROLL_OFF_PHASE;
    const seatedPlayerIds = Array.from(this.slots.values()).map(s => s.playerId);
    this.turnRollOffManager = new TurnRollOffManager(seatedPlayerIds.length > 0 ? seatedPlayerIds : ['player_1']);

    this.broadcast({
      type: 'ROOM_LIFECYCLE_CHANGE',
      roomCode: this.roomCode,
      status: LOBBY_STATUS.ROLL_OFF_PHASE,
      seatedPlayers: seatedPlayerIds,
      timestamp: Date.now()
    });
  }

  /**
   * Submits a d20 roll from a player and evaluates tie-breakers or establishes strict turn order (INV-TURNSORT-1).
   * 
   * @param {string} playerId 
   * @param {number} [forcedValue] 
   * @returns {number} The roll value
   */
  handleD20Roll(playerId, forcedValue = null) {
    if (!this.turnRollOffManager) {
      this.transitionToRollOff();
    }

    const roll = this.turnRollOffManager.submitRoll(playerId, forcedValue);

    this.broadcast({
      type: 'D20_ROLL_SUBMITTED',
      playerId,
      roll,
      round: this.turnRollOffManager.round,
      timestamp: Date.now()
    });

    if (this.turnRollOffManager.isRoundComplete()) {
      const result = this.turnRollOffManager.evaluateRound();
      if (result.isComplete) {
        this.lifecycleStatus = LOBBY_STATUS.MATCH_ACTIVE;
        this.priorityStateMachine.players = result.sortedPlayers;
        this.priorityStateMachine.activePlayerId = result.sortedPlayers[0];
        this.priorityStateMachine.priorityPlayerId = result.sortedPlayers[0];

        this.broadcast({
          type: 'TURN_ORDER_RESOLVED',
          sortedPlayers: result.sortedPlayers,
          activePlayerId: result.sortedPlayers[0],
          rankings: result.sortedPlayers.map((pid, idx) => ({
            rank: idx + 1,
            playerId: pid,
            playerName: this.getSlotByPlayerId(pid)?.playerName || pid
          })),
          timestamp: Date.now()
        });

        this.broadcast({
          type: 'ROOM_LIFECYCLE_CHANGE',
          roomCode: this.roomCode,
          status: LOBBY_STATUS.MATCH_ACTIVE,
          activePlayerId: result.sortedPlayers[0],
          timestamp: Date.now()
        });
      } else {
        this.broadcast({
          type: 'TIE_BREAKER_ROUND',
          round: result.round,
          tiedPlayerIds: result.tiedPlayerIds,
          timestamp: Date.now()
        });
      }
    }

    return roll;
  }

  /**
   * Finds a seated slot by playerId.
   *
   * @param {string} playerId
   * @returns {Object|null}
   */
  getSlotByPlayerId(playerId) {
    for (const slot of this.slots.values()) {
      if (slot.playerId === playerId) {
        return slot;
      }
    }
    return null;
  }

  /**
   * Finds a seated slot by slotId.
   *
   * @param {number} slotId
   * @returns {Object|null}
   */
  getSlot(slotId) {
    return this.slots.get(slotId) || null;
  }

  /**
   * Authenticates a reconnect attempt against 256-bit seat tokens.
   *
   * @param {string} seatToken
   * @returns {Object|null} PlayerSlot or null if invalid
   */
  authenticateSeatToken(seatToken) {
    if (!seatToken || typeof seatToken !== 'string') return null;
    for (const slot of this.slots.values()) {
      if (timingSafeEqualString(slot.seatToken, seatToken)) {
        return slot;
      }
    }
    return null;
  }

  /**
   * Computes the next active player in clockwise seat order (INV-RING-1).
   *
   * @param {string} fromPlayerId
   * @returns {string|null}
   */
  getNextActivePlayer(fromPlayerId) {
    const allSlots = Array.from(this.slots.values()).sort((a, b) => a.slotId - b.slotId);
    const activeSlots = allSlots.filter(s => !s.isEliminated);
    if (activeSlots.length === 0) return null;

    const currentIndex = allSlots.findIndex(s => s.playerId === fromPlayerId);
    if (currentIndex === -1) {
      return activeSlots[0].playerId;
    }

    for (let i = 1; i <= allSlots.length; i++) {
      const nextSlot = allSlots[(currentIndex + i) % allSlots.length];
      if (!nextSlot.isEliminated) {
        return nextSlot.playerId;
      }
    }

    return activeSlots[0].playerId;
  }

  /**
   * Updates ActiveRing on PriorityStateMachine to maintain phase advancement invariants.
   */
  _syncActiveRing() {
    const allSlots = Array.from(this.slots.values()).sort((a, b) => a.slotId - b.slotId);
    const activePlayerIds = allSlots.filter(s => !s.isEliminated).map(s => s.playerId);
    this.priorityStateMachine.players = activePlayerIds;

    if (!activePlayerIds.includes(this.priorityStateMachine.priorityPlayerId)) {
      this.priorityStateMachine.priorityPlayerId = activePlayerIds[0] || null;
    }
    if (!activePlayerIds.includes(this.priorityStateMachine.activePlayerId)) {
      this.priorityStateMachine.activePlayerId = activePlayerIds[0] || null;
    }
  }

  /**
   * Handles 15-second Stack Alarm expiry.
   * Decoupled clock rule (INV-RELAY-3): If expired player is offline, dispatches AUTO_PASS_DISCONNECTED.
   *
   * @param {string} expiredPlayerId
   * @param {string} expiredStackItemId
   */
  _handleAlarmTimeout(expiredPlayerId, expiredStackItemId) {
    if (this.isClosed) return;
    const slot = this.getSlotByPlayerId(expiredPlayerId);

    if (slot && slot.connectionStatus === 'DISCONNECTED') {
      // Authoritative decoupled auto-pass
      this.dispatchSequencedAction({
        actionId: crypto.randomUUID(),
        type: 'AUTO_PASS_DISCONNECTED',
        actionType: 'AUTO_PASS_DISCONNECTED',
        slotId: slot.slotId,
        payload: { reason: 'STACK_ALARM_EXPIRED_WHILE_OFFLINE', expiredStackItemId }
      });
    } else {
      // Player was connected or standard timeout
      if (this.priorityStateMachine.priorityPlayerId === expiredPlayerId) {
        this.dispatchSequencedAction({
          actionId: crypto.randomUUID(),
          type: 'PASS_PRIORITY',
          actionType: 'PASS_PRIORITY',
          slotId: slot ? slot.slotId : 1,
          payload: { isTimeout: true }
        });
      }
    }
  }

  /**
   * Manually triggers alarm expiry for deterministic fast-path unit testing.
   */
  triggerAlarmExpiry() {
    if (this.priorityStateMachine.alarmManager && this.priorityStateMachine.alarmManager.status === 'RUNNING') {
      const target = this.priorityStateMachine.alarmManager.targetPlayerId;
      const stackItem = this.priorityStateMachine.alarmManager.stackItemId;
      this.priorityStateMachine.alarmManager.cancel();
      this._handleAlarmTimeout(target, stackItem);
    }
  }

  /**
   * Drains disconnect bank for disconnected players by deltaMs.
   *
   * @param {number} [deltaMs]
   */
  tickDisconnectBank(deltaMs) {
    const elapsed = typeof deltaMs === 'number' ? deltaMs : (Date.now() - this.lastTickTime);
    this.lastTickTime = Date.now();

    if (this.lobbyManager && (this.lifecycleStatus === LOBBY_STATUS.LOBBY_WAITING || this.lifecycleStatus === LOBBY_STATUS.READY_CHECK)) {
      this.lobbyManager.tickGrace(elapsed);
    }

    for (const slot of this.slots.values()) {
      if (slot.connectionStatus === 'DISCONNECTED' && !slot.isEliminated) {
        slot.disconnectBankMsRemaining = Math.max(0, slot.disconnectBankMsRemaining - elapsed);

        if (slot.disconnectBankMsRemaining <= 0) {
          slot.connectionStatus = 'ABANDONED';
          this.eliminatePlayer(slot.slotId, 'DISCONNECT_TIMEOUT');
        }
      }
    }
  }

  _tickDisconnects() {
    this.tickDisconnectBank();
  }

  /**
   * Eliminates a player slot under CR 800.4a rules (INV-RING-1 & INV-RING-2).
   *
   * @param {number} slotId
   * @param {'LIFE_ZERO'|'POISON_TEN'|'DECKOUT'|'CONCEDED'|'DISCONNECT_TIMEOUT'} [reason='LIFE_ZERO']
   */
  eliminatePlayer(slotId, reason = 'LIFE_ZERO') {
    const slot = this.slots.get(slotId);
    if (!slot || slot.isEliminated) return;

    slot.isEliminated = true;
    slot.eliminationReason = reason;

    // 1. CR 800.4a Stack Purge
    this.priorityStateMachine.stack = (this.priorityStateMachine.stack || []).filter(
      item => item.sourcePlayerId !== slot.playerId
    );

    // 2. Cancel Stack Alarm if running on eliminated player
    if (this.priorityStateMachine.alarmManager) {
      if (this.priorityStateMachine.alarmManager.targetPlayerId === slot.playerId) {
        this.priorityStateMachine.alarmManager.cancel();
      }
    }

    // 3. Priority Hand-off
    const wasPriorityPlayer = (this.priorityStateMachine.priorityPlayerId === slot.playerId);
    const wasActivePlayer = (this.priorityStateMachine.activePlayerId === slot.playerId);

    this._syncActiveRing();
    const activeSlots = Array.from(this.slots.values()).filter(s => !s.isEliminated);

    if (wasPriorityPlayer && activeSlots.length > 0) {
      const nextPlayer = this.getNextActivePlayer(slot.playerId);
      this.priorityStateMachine.priorityPlayerId = nextPlayer;
      this.priorityStateMachine.consecutivePassCount = 0;
    }

    if (wasActivePlayer && activeSlots.length > 0) {
      this.priorityStateMachine.activePlayerId = this.getNextActivePlayer(slot.playerId);
    }

    // 4. Broadcast Elimination
    this.broadcast({
      type: 'PLAYER_ELIMINATED',
      slotId,
      playerId: slot.playerId,
      reason,
      timestamp: Date.now()
    });

    // 5. Check Victory Condition (|ActiveRing| == 1)
    if (activeSlots.length === 1) {
      const winner = activeSlots[0];
      this.broadcast({
        type: 'MATCH_VICTORY',
        winnerSlotId: winner.slotId,
        winnerPlayerId: winner.playerId,
        winnerPlayerName: winner.playerName,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Generates a zero-knowledge Fog-of-War sanitized snapshot for a viewer (INV-FOW-1).
   *
   * @param {number|null} viewerSlotId
   * @param {string|null} [seatToken=null]
   * @returns {Object} StateReconcileSnapshot
   */
  createStateSnapshot(viewerSlotId = null, seatToken = null) {
    const viewerPlayerId = viewerSlotId
      ? (this.slots.get(viewerSlotId)?.playerId || 'spectator')
      : 'spectator';

    const projectedState = this.tabletopStateManager.projectState(viewerPlayerId);

    let remainingAlarmMs = 0;
    if (this.priorityStateMachine.alarmManager && this.priorityStateMachine.alarmManager.status === 'RUNNING') {
      const endTime = this.priorityStateMachine.alarmManager.endTime;
      if (endTime) {
        remainingAlarmMs = Math.max(0, endTime - Date.now());
      }
    }

    let disconnectBankRemainingMs = this.disconnectBankTotalMs;
    if (viewerSlotId && this.slots.has(viewerSlotId)) {
      disconnectBankRemainingMs = this.slots.get(viewerSlotId).disconnectBankMsRemaining;
    }

    const allSlots = Array.from(this.slots.values()).sort((a, b) => a.slotId - b.slotId);
    const activeSlots = allSlots.map(s => ({
      slotId: s.slotId,
      playerId: s.playerId,
      playerName: s.playerName,
      isEliminated: s.isEliminated,
      connectionStatus: s.connectionStatus
    }));

    const snapshot = {
      type: 'STATE_RECONCILE_SNAPSHOT',
      roomCode: this.roomCode,
      sessionId: this.sessionId,
      slotId: viewerSlotId || null,
      seq: this.currentSeq,
      projectedState,
      priorityPlayerId: this.priorityStateMachine.priorityPlayerId,
      activePlayerId: this.priorityStateMachine.activePlayerId,
      currentPhaseStep: this.priorityStateMachine.currentPhaseStep,
      turnNumber: this.priorityStateMachine.turnNumber,
      stack: (this.priorityStateMachine.stack || []).map(item => ({ ...item })),
      remainingAlarmMs,
      disconnectBankRemainingMs,
      activeSlots,
      lifecycleStatus: this.lifecycleStatus,
      lobbyState: this.lobbyManager ? this.lobbyManager.getState() : null
    };

    if (seatToken) {
      snapshot.seatToken = seatToken;
    }

    return snapshot;
  }

  /**
   * Handles an incoming join request.
   *
   * @param {WebSocketConnection} ws
   * @param {Object} payload
   * @returns {Object} Allocated slot or spectator info
   */
  handleJoin(ws, payload = {}) {
    const isSpectator = Boolean(payload.isSpectator);
    const requestedSlot = payload.seatPreference;

    // Check if seats are available
    let allocatedSlotId = null;
    if (!isSpectator) {
      if (requestedSlot && typeof requestedSlot === 'number' && requestedSlot >= 1 && requestedSlot <= this.maxPlayers) {
        if (!this.slots.has(requestedSlot)) {
          allocatedSlotId = requestedSlot;
        }
      }

      if (!allocatedSlotId) {
        for (let i = 1; i <= this.maxPlayers; i++) {
          if (!this.slots.has(i)) {
            allocatedSlotId = i;
            break;
          }
        }
      }
    }

    if (!allocatedSlotId) {
      // Join as spectator
      this.spectators.add(ws);
      ws.roomCode = this.roomCode;
      ws.slotId = null;

      const snapshot = this.createStateSnapshot(null);
      ws.send(snapshot);
      return { slotId: null, isSpectator: true };
    }

    // Allocate player slot
    const seatToken = crypto.randomBytes(32).toString('hex');
    const slotId = allocatedSlotId;
    const playerId = payload.playerId || `player_${slotId}`;
    const playerName = payload.playerName || `Player ${slotId}`;

    const slot = {
      slotId,
      playerId,
      playerName,
      seatToken,
      connectionStatus: 'CONNECTED',
      socket: ws,
      isEliminated: false,
      eliminationReason: undefined,
      disconnectBankMsRemaining: this.disconnectBankTotalMs,
      disconnectedAt: null,
      joinedAt: Date.now()
    };

    this.slots.set(slotId, slot);
    ws.roomCode = this.roomCode;
    ws.slotId = slotId;

    try {
      this.lobbyManager.claimSeat(slotId, {
        playerId,
        playerName,
        seatToken
      });
    } catch (e) {}

    // Register in engines
    this.tabletopStateManager.registerPlayer(playerId, playerName);
    const psmPlayer = this.tabletopStateManager.players[playerId];
    if (psmPlayer && psmPlayer.resources) {
      psmPlayer.resources.life = this.startingLife;
    }

    this._syncActiveRing();
    if (!this.priorityStateMachine.activePlayerId) {
      this.priorityStateMachine.activePlayerId = playerId;
      this.priorityStateMachine.priorityPlayerId = playerId;
    }

    // Send snapshot unicast to new occupant
    const snapshot = this.createStateSnapshot(slotId, seatToken);
    ws.send(snapshot);

    // Broadcast PLAYER_JOINED to other connected sockets (omit seat token!)
    this.broadcastToOthers(ws, {
      type: 'PLAYER_JOINED',
      slotId,
      playerId,
      playerName,
      timestamp: Date.now()
    });

    return { slotId, seatToken, playerId, playerName };
  }

  /**
   * Reconnects a player socket using their cryptographic seat token (INV-RELAY-4).
   *
   * @param {WebSocketConnection} ws
   * @param {string} seatToken
   * @returns {Object|null}
   */
  handleReconnect(ws, seatToken) {
    const slot = this.authenticateSeatToken(seatToken);
    if (!slot) {
      return null;
    }

    slot.connectionStatus = 'CONNECTED';
    slot.socket = ws;
    slot.disconnectedAt = null;

    ws.roomCode = this.roomCode;
    ws.slotId = slot.slotId;

    const snapshot = this.createStateSnapshot(slot.slotId);
    ws.send(snapshot);

    this.broadcastToOthers(ws, {
      type: 'PLAYER_RECONNECTED',
      slotId: slot.slotId,
      playerId: slot.playerId,
      playerName: slot.playerName,
      timestamp: Date.now()
    });

    return slot;
  }

  /**
   * Sequences, logs, applies, and broadcasts an action (INV-RELAY-2).
   *
   * @param {Object} action
   * @returns {Object} Sequenced action
   */
  dispatchSequencedAction(action) {
    this.currentSeq++;
    const sequencedAction = {
      seq: this.currentSeq,
      actionId: action.actionId || crypto.randomUUID(),
      type: action.type || action.actionType,
      actionType: action.actionType || action.type,
      payload: action.payload || {},
      timestamp: action.timestamp || Date.now(),
      slotId: action.slotId
    };

    this.actionLog.push(sequencedAction);
    this._applyDomainAction(sequencedAction);

    this.broadcast({
      type: 'ACTION_SEQUENCED',
      seq: sequencedAction.seq,
      actionId: sequencedAction.actionId,
      actionType: sequencedAction.actionType,
      payload: sequencedAction.payload,
      slotId: sequencedAction.slotId,
      timestamp: sequencedAction.timestamp
    });

    return sequencedAction;
  }

  /**
   * Applies action to internal domain managers.
   *
   * @param {Object} sequencedAction
   */
  _applyDomainAction(sequencedAction) {
    const type = sequencedAction.actionType || sequencedAction.type;
    const slot = this.slots.get(sequencedAction.slotId);
    const playerId = slot ? slot.playerId : this.priorityStateMachine.priorityPlayerId;

    try {
      if (['CAST_SPELL', 'CAST_SPELL_TO_STACK'].includes(type)) {
        this.priorityStateMachine.dispatch('CAST_SPELL', {
          playerId,
          ...sequencedAction.payload
        });
      } else if (['PASS_PRIORITY', 'AUTO_PASS_DISCONNECTED'].includes(type)) {
        this.priorityStateMachine.dispatch('PASS_PRIORITY', {
          playerId,
          ...sequencedAction.payload
        });
      } else if (type === 'HOLD_RESPOND') {
        this.priorityStateMachine.dispatch('HOLD_RESPOND', {
          playerId,
          ...sequencedAction.payload
        });
      } else if (type === 'RESOLVE_TOP') {
        this.priorityStateMachine.dispatch('RESOLVE_TOP', sequencedAction.payload);
      } else if (type === 'ADVANCE_PHASE_STEP') {
        this.priorityStateMachine.dispatch('ADVANCE_PHASE_STEP', sequencedAction.payload);
      }
    } catch (err) {
      // Re-throw priority violations if needed
      if (err instanceof PriorityViolationError) {
        throw err;
      }
    }

    try {
      if (['ADJUST_LIFE', 'SET_LIFE'].includes(type)) {
        this.tabletopStateManager.dispatch('ADJUST_LIFE', {
          playerId,
          ...sequencedAction.payload
        });
        // Check for 0 life elimination
        const life = this.tabletopStateManager.getPlayerLife(playerId);
        if (life <= 0 && slot) {
          this.eliminatePlayer(slot.slotId, 'LIFE_ZERO');
        }
      } else if (['DRAW_CARD', 'PLAY_LAND', 'TAP_PERMANENT', 'UNTAP_PERMANENT', 'UNTAP_ALL'].includes(type)) {
        this.tabletopStateManager.dispatch(type, {
          playerId,
          ...sequencedAction.payload
        });
      }
    } catch (err) {
      // Non-fatal domain error
    }
  }

  /**
   * Broadcasts a JSON message to all connected player slots and spectators.
   *
   * @param {Object} message
   */
  broadcast(message) {
    const data = JSON.stringify(message);
    for (const slot of this.slots.values()) {
      if (slot.socket && slot.connectionStatus === 'CONNECTED') {
        slot.socket.send(data);
      }
    }
    for (const ws of this.spectators) {
      if (!ws.isClosed) {
        ws.send(data);
      }
    }
  }

  /**
   * Broadcasts a message to all sockets except the sender.
   *
   * @param {WebSocketConnection} senderWs
   * @param {Object} message
   */
  broadcastToOthers(senderWs, message) {
    const data = JSON.stringify(message);
    for (const slot of this.slots.values()) {
      if (slot.socket && slot.socket !== senderWs && slot.connectionStatus === 'CONNECTED') {
        slot.socket.send(data);
      }
    }
    for (const ws of this.spectators) {
      if (ws !== senderWs && !ws.isClosed) {
        ws.send(data);
      }
    }
  }

  /**
   * Cleanly closes all sockets and cancels timers in room (INV-HARNESS-2).
   */
  close() {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this.disconnectTimer) {
      clearInterval(this.disconnectTimer);
      this.disconnectTimer = null;
    }

    if (this.priorityStateMachine.alarmManager) {
      this.priorityStateMachine.alarmManager.cancel();
    }

    for (const slot of this.slots.values()) {
      if (slot.socket) {
        try {
          slot.socket.close(1000, 'Room closed');
        } catch (e) {}
        slot.socket = null;
      }
    }

    for (const ws of this.spectators) {
      try {
        ws.close(1000, 'Room closed');
      } catch (e) {}
    }
    this.spectators.clear();
  }
}

/**
 * Creates and configures the Authoritative Relay Server.
 *
 * @param {Object} [options={}]
 * @returns {{ server: http.Server, rooms: Map<string, RoomSession>, listen: Function, close: Function, getRoom: Function }}
 */
export function createRelayServer(options = {}) {
  const rooms = new Map();
  const rawSockets = new Set();
  const matchmakingQueue = new MatchmakingQueue(options);

  const server = options.server || http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'rpm-multiplayer-relay', status: 'OK' }));
  });

  server.on('connection', (socket) => {
    rawSockets.add(socket);
    socket.on('close', () => rawSockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    const upgradeHeader = req.headers.upgrade;
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );

    const ws = new WebSocketConnection(socket);
    if (head && head.length > 0) {
      ws._onData(head);
    }
    _setupWebSocketRouting(ws, rooms, matchmakingQueue, options);
  });

  function _setupWebSocketRouting(ws, roomsMap, queue, serverOptions) {
    ws.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        ws.send({ type: 'ERROR', code: 4000, message: 'Invalid JSON frame' });
        return;
      }

      const msgType = msg.type;

      if (msgType === 'QUEUE_JOIN') {
        const ticket = queue.enqueue({
          playerId: msg.playerId || crypto.randomUUID(),
          playerName: msg.playerName,
          format: msg.format || 'MODERN',
          deckId: msg.deckId,
          socket: ws
        });
        ws.ticketId = ticket.ticketId;
        ws.send({
          type: 'QUEUE_JOINED',
          ticketId: ticket.ticketId,
          playerId: ticket.playerId,
          format: ticket.format,
          waitTimeMs: 0
        });

        const match = queue.findMatch(msg.format, roomsMap);
        if (match) {
          const room = new RoomSession(match.roomCode, {
            ...serverOptions,
            maxPlayers: 2,
            roomType: 'DUEL_1V1'
          });
          roomsMap.set(match.roomCode, room);

          const p1Join = room.handleJoin(match.player1.socket, {
            playerId: match.player1.playerId,
            playerName: match.player1.playerName,
            seatPreference: 1
          });
          match.player1.socket?.send?.({
            type: 'MATCH_FOUND',
            roomCode: match.roomCode,
            slotId: p1Join.slotId,
            seatToken: p1Join.seatToken,
            opponentName: match.player2.playerName
          });

          const p2Join = room.handleJoin(match.player2.socket, {
            playerId: match.player2.playerId,
            playerName: match.player2.playerName,
            seatPreference: 2
          });
          match.player2.socket?.send?.({
            type: 'MATCH_FOUND',
            roomCode: match.roomCode,
            slotId: p2Join.slotId,
            seatToken: p2Join.seatToken,
            opponentName: match.player1.playerName
          });
        }
        return;
      }

      if (msgType === 'QUEUE_LEAVE') {
        const ticketId = msg.ticketId || ws.ticketId || msg.playerId;
        queue.removeTicket(ticketId);
        ws.send({ type: 'QUEUE_LEFT', ticketId });
        return;
      }

      if (msgType === 'QUEUE_CHECK_WATCHDOG') {
        const ticketId = msg.ticketId || ws.ticketId || msg.playerId;
        const watchdog = queue.checkWatchdog(ticketId, msg.thresholdSeconds || 45);
        ws.send({
          type: 'QUEUE_WATCHDOG_STATUS',
          ...watchdog
        });
        return;
      }

      if (msgType === 'CREATE_ROOM') {
        const roomCode = generateRoomCode(roomsMap);
        const room = new RoomSession(roomCode, {
          ...serverOptions,
          ...msg
        });
        roomsMap.set(roomCode, room);

        // Host allocates Slot 1
        const hostJoin = room.handleJoin(ws, {
          playerName: msg.playerName || 'Host',
          seatPreference: 1,
          isSpectator: false
        });

        ws.send({
          type: 'ROOM_CREATED',
          roomCode,
          sessionId: room.sessionId,
          slotId: hostJoin.slotId,
          seatToken: hostJoin.seatToken
        });
        return;
      }

      if (msgType === 'JOIN_ROOM') {
        const roomCode = msg.roomCode;
        const room = roomsMap.get(roomCode);
        if (!room) {
          ws.send({ type: 'ERROR', code: 4404, message: 'Room not found' });
          return;
        }

        room.handleJoin(ws, msg);
        return;
      }

      if (msgType === 'RECONNECT_ROOM') {
        const roomCode = msg.roomCode;
        const seatToken = msg.seatToken;
        const room = roomsMap.get(roomCode);

        if (!room) {
          ws.send({ type: 'ERROR', code: 4404, message: 'Room not found' });
          ws.close(4404, 'Room not found');
          return;
        }

        const slot = room.handleReconnect(ws, seatToken);
        if (!slot) {
          ws.send({ type: 'ERROR', code: 4401, message: 'Unauthorized Seat Token' });
          ws.close(4401, 'Unauthorized Seat Token');
        }
        return;
      }

      // Remaining messages require an active room
      const room = roomsMap.get(ws.roomCode);
      if (!room) {
        ws.send({ type: 'ERROR', code: 4404, message: 'Not connected to a room' });
        return;
      }

      if (msgType === 'LOBBY_TOGGLE_READY') {
        if (ws.slotId && room.lobbyManager) {
          const res = room.lobbyManager.setPlayerReady(ws.slotId, msg.isReady);
          room.broadcast({
            type: 'LOBBY_READY_TOGGLED',
            slotId: ws.slotId,
            isReady: res.slot.isReady,
            allReady: res.allReady,
            canStart: res.canStart
          });
        }
        return;
      }

      if (msgType === 'SUBMIT_D20_ROLL') {
        const slot = room.getSlot(ws.slotId);
        if (slot) {
          room.handleD20Roll(slot.playerId, msg.value);
        }
        return;
      }

      if (msgType === 'DISPATCH_ACTION') {
        if (!ws.slotId) {
          ws.send({ type: 'ERROR', code: 4003, message: 'Spectators cannot dispatch game actions' });
          return;
        }

        if (!ws.checkRateLimit()) {
          ws.close(1008, 'Policy Violation: Rate limit exceeded');
          return;
        }

        const slot = room.getSlot(ws.slotId);
        if (!slot || slot.socket !== ws) {
          ws.send({ type: 'ERROR', code: 4401, message: 'Unauthorized' });
          return;
        }

        const actionType = msg.actionType || msg.action?.type || msg.payload?.type;

        // If priority check is required for turn actions:
        if (['CAST_SPELL', 'PASS_PRIORITY', 'HOLD_RESPOND'].includes(actionType)) {
          try {
            room.priorityStateMachine.assertHasPriority(slot.playerId);
          } catch (err) {
            ws.send({
              type: 'ERROR',
              code: 4003,
              errorType: 'PRIORITY_VIOLATION_ERROR',
              message: err.message
            });
            return;
          }
        }

        room.dispatchSequencedAction({
          actionId: msg.actionId || crypto.randomUUID(),
          type: actionType,
          actionType,
          slotId: ws.slotId,
          payload: msg.payload || {}
        });
        return;
      }

      if (msgType === 'ACTION_REPLAY_REQUEST') {
        const fromSeq = msg.fromSeq || 1;
        const toSeq = msg.toSeq || room.currentSeq;
        const actions = room.actionLog.filter(a => a.seq >= fromSeq && a.seq <= toSeq);
        ws.send({
          type: 'ACTION_REPLAY_BATCH',
          actions
        });
        return;
      }

      if (msgType === 'CONCEDE_MATCH') {
        if (ws.slotId) {
          room.eliminatePlayer(ws.slotId, 'CONCEDED');
        }
        return;
      }
    });

    ws.on('close', () => {
      if (ws.ticketId) {
        queue.removeTicket(ws.ticketId);
      }

      if (!ws.roomCode) return;
      const room = roomsMap.get(ws.roomCode);
      if (!room) return;

      if (ws.slotId) {
        const slot = room.getSlot(ws.slotId);
        if (slot && slot.socket === ws) {
          slot.connectionStatus = 'DISCONNECTED';
          slot.socket = null;
          slot.disconnectedAt = Date.now();
          if (room.lobbyManager && (room.lifecycleStatus === LOBBY_STATUS.LOBBY_WAITING || room.lifecycleStatus === LOBBY_STATUS.READY_CHECK)) {
            room.lobbyManager.handleDisconnect(slot.slotId);
          }
          room.broadcast({
            type: 'PLAYER_DISCONNECTED',
            slotId: slot.slotId,
            playerId: slot.playerId,
            playerName: slot.playerName,
            timestamp: Date.now()
          });
        }
      } else {
        room.spectators.delete(ws);
      }
    });
  }

  function listen(...args) {
    return server.listen(...args);
  }

  function close(cb) {
    for (const room of rooms.values()) {
      room.close();
    }
    rooms.clear();
    matchmakingQueue.clear();

    for (const sock of rawSockets) {
      try {
        sock.destroy();
      } catch (e) {}
    }
    rawSockets.clear();

    server.close((err) => {
      if (typeof cb === 'function') {
        cb(err);
      }
    });
  }

  function getRoom(code) {
    return rooms.get(code) || null;
  }

  return {
    server,
    rooms,
    matchmakingQueue,
    listen,
    close,
    getRoom
  };
}

export default {
  CROCKFORD_ALPHABET,
  generateRoomCode,
  timingSafeEqualString,
  WebSocketConnection,
  RoomSession,
  createRelayServer
};
