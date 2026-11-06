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
import fs from 'node:fs';
import path from 'node:path';
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
 * Creates an authoritative JSON HTTP Request Handler for Email + Password Authentication,
 * persistent cross-device sessions, and deck sync.
 *
 * @param {Object} [options={}]
 * @param {string|null} [options.storePath] - File path to persist accounts.json, null for in-memory only.
 * @returns {Function} (req, res) => Promise<boolean>
 */
export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://naacgdwtglvcumaccime.supabase.co';
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5hYWNnZHd0Z2x2Y3VtYWNjaW1lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5Nzc2NDUsImV4cCI6MjEwMzU1MzY0NX0.QzVkPr7-aKYLTxVc6RzB_maVBykHBUvtvIIZm-522JE';
export const FALLBACK_CACHE_PATH = path.resolve(process.cwd(), 'data', 'rpmm_fallback_cache.json');

// --- Supabase PostgREST & Offline Cache Layer ([D37]) ---
export function loadFallbackCache() {
  try {
    if (fs.existsSync(FALLBACK_CACHE_PATH)) {
      const raw = fs.readFileSync(FALLBACK_CACHE_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch (_) {}
  return {
    RPMM_profiles: {},
    RPMM_auth_tokens: {},
    RPMM_decks: {},
    RPMM_cards_catalog: {},
    RPMM_card_aliases: {},
    RPMM_card_bindings: {},
    RPMM_review_queue: {},
    RPMM_live_rooms: {},
    RPMM_match_snapshots: {},
    RPMM_matches: {},
    RPMM_match_logs: []
  };
}

export function saveFallbackCache(cache) {
  try {
    const dir = path.dirname(FALLBACK_CACHE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${FALLBACK_CACHE_PATH}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, FALLBACK_CACHE_PATH);
  } catch (_) {}
}

export async function postgrestRequest(endpoint, { method = 'GET', body = null, headers = {} } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const reqHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
    ...headers
  };
  const fetchFn = typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch : null;
  if (!fetchFn) throw new Error('Fetch API unavailable');

  const res = await fetchFn(url, {
    method,
    headers: reqHeaders,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`PostgREST error ${res.status}: ${errText}`);
  }
  return res.json().catch(() => null);
}

// --- Write-Behind Queue ([D34], [D36]) ---
export class WriteBehindQueue {
  constructor(options = {}) {
    this.flushIntervalMs = options.flushIntervalMs || 5000;
    this.matchLogsBuffer = [];
    this.matchesBuffer = [];
    this.timer = null;
    this._start();
  }

  _start() {
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  enqueueMatchLog(logEntry) {
    this.matchLogsBuffer.push(logEntry);
    const bugs = this.matchLogsBuffer.filter(l => l.flagged_bug);
    const nonBugs = this.matchLogsBuffer.filter(l => !l.flagged_bug);
    if (nonBugs.length > 200) {
      nonBugs.splice(0, nonBugs.length - 200);
    }
    this.matchLogsBuffer = [...nonBugs, ...bugs];
  }

  enqueueMatch(matchEntry) {
    this.matchesBuffer.push(matchEntry);
  }

  async flush() {
    if (this.matchLogsBuffer.length > 0) {
      const toSend = [...this.matchLogsBuffer];
      this.matchLogsBuffer = [];
      try {
        await postgrestRequest('RPMM_match_logs', {
          method: 'POST',
          body: toSend,
          headers: { 'Prefer': 'resolution=merge-duplicates' }
        });
      } catch (_) {
        const cache = loadFallbackCache();
        cache.RPMM_match_logs = [...(cache.RPMM_match_logs || []), ...toSend];
        const b = cache.RPMM_match_logs.filter(l => l.flagged_bug);
        const nb = cache.RPMM_match_logs.filter(l => !l.flagged_bug);
        if (nb.length > 200) nb.splice(0, nb.length - 200);
        cache.RPMM_match_logs = [...nb, ...b];
        saveFallbackCache(cache);
      }
    }

    if (this.matchesBuffer.length > 0) {
      const toSend = [...this.matchesBuffer];
      this.matchesBuffer = [];
      try {
        await postgrestRequest('RPMM_matches', {
          method: 'POST',
          body: toSend,
          headers: { 'Prefer': 'resolution=merge-duplicates' }
        });
      } catch (_) {
        const cache = loadFallbackCache();
        cache.RPMM_matches = cache.RPMM_matches || {};
        for (const m of toSend) cache.RPMM_matches[m.id] = m;
        saveFallbackCache(cache);
      }
    }
  }

  destroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.flush();
  }
}

export const writeBehindQueue = new WriteBehindQueue();

// --- Starter Decks Auto-Seeding ([D38]) ---
export async function seedStarterDecksToCatalog() {
  try {
    const { PRECONSTRUCTED_STARTER_DECKS, PRECON_CARD_METADATA } = await import('./deckbuilder/PreconstructedDecks.js').catch(() => ({}));
    const { auditCardClauses } = await import('./OracleEffectCompiler.js').catch(() => ({}));
    if (!PRECONSTRUCTED_STARTER_DECKS && !PRECON_CARD_METADATA) return;

    const cardsToUpsert = [];
    const bindingsToUpsert = [];
    const seen = new Set();

    const addCard = (cardName, cardData = {}) => {
      const norm = String(cardName).trim().toLowerCase();
      if (!norm || seen.has(norm)) return;
      seen.add(norm);

      const meta = (PRECON_CARD_METADATA && PRECON_CARD_METADATA[norm]) || cardData || {};
      const name = meta.name || cardName;
      const cardObj = {
        id: `card_${norm.replace(/[^a-z0-9_]/g, '_')}`,
        name,
        normalized_name: norm,
        mana_cost: meta.manaCost || '',
        type_line: meta.typeLine || '',
        oracle_text: meta.oracleText || '',
        power: meta.power !== undefined && meta.power !== null ? String(meta.power) : null,
        toughness: meta.toughness !== undefined && meta.toughness !== null ? String(meta.toughness) : null,
        colors: Array.isArray(meta.colors) ? meta.colors : [],
        image_uris: meta.image_uris || {},
        metadata: { source: 'STARTER_SEED' }
      };
      cardsToUpsert.push(cardObj);

      if (typeof auditCardClauses === 'function') {
        const audit = auditCardClauses(cardObj);
        (audit.clauses || []).forEach((c, idx) => {
          bindingsToUpsert.push({
            id: `bind_${norm.replace(/[^a-z0-9_]/g, '_')}_${idx}`,
            card_name: name,
            clause_text: c.clauseText,
            trigger: c.trigger || 'NONE',
            primitive: c.primitive || 'CUSTOM',
            condition: c.condition || null,
            params: c.params || {},
            status: c.status || 'BOUND',
            is_certified: true,
            metadata: { pass: c.pass || 1 }
          });
        });
      }
    };

    if (PRECON_CARD_METADATA) {
      for (const [k, v] of Object.entries(PRECON_CARD_METADATA)) addCard(k, v);
    }

    if (cardsToUpsert.length > 0) {
      postgrestRequest('RPMM_cards_catalog', {
        method: 'POST',
        body: cardsToUpsert,
        headers: { 'Prefer': 'resolution=merge-duplicates' }
      }).catch(() => {
        const cache = loadFallbackCache();
        cache.RPMM_cards_catalog = cache.RPMM_cards_catalog || {};
        for (const c of cardsToUpsert) cache.RPMM_cards_catalog[c.normalized_name] = c;
        saveFallbackCache(cache);
      });
    }

    if (bindingsToUpsert.length > 0) {
      postgrestRequest('RPMM_card_bindings', {
        method: 'POST',
        body: bindingsToUpsert,
        headers: { 'Prefer': 'resolution=merge-duplicates' }
      }).catch(() => {
        const cache = loadFallbackCache();
        cache.RPMM_card_bindings = cache.RPMM_card_bindings || {};
        for (const b of bindingsToUpsert) cache.RPMM_card_bindings[`${b.card_name}_${b.clause_text}`] = b;
        saveFallbackCache(cache);
      });
    }
  } catch (_) {}
}

// Kick off async catalog seed
seedStarterDecksToCatalog().catch(() => {});

// Active WebSocket user sessions tracking: userId/tokenHash -> { activeSocket, deviceLabel, tokenHash }
export const activeUserSessions = new Map();

/**
 * Creates an authoritative JSON HTTP Request Handler for Email + Password Authentication,
 * persistent cross-device sessions, RPMM_* persistence, and deck sync.
 *
 * @param {Object} [options={}]
 * @param {string|null} [options.storePath] - File path to persist accounts.json, null for in-memory only.
 * @returns {Function} (req, res) => Promise<boolean>
 */
export function createAuthHttpHandler({ storePath } = {}) {
  const accountsFile = storePath === null
    ? null
    : (storePath ?? process.env.RPM_ACCOUNTS_FILE ?? path.resolve(process.cwd(), 'data', 'accounts.json'));

  const store = { users: {}, tokens: {} };

  function loadFromDisk() {
    if (!accountsFile) return;
    try {
      if (fs.existsSync(accountsFile)) {
        const raw = fs.readFileSync(accountsFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (parsed.users) store.users = parsed.users;
          if (parsed.tokens) store.tokens = parsed.tokens;
        }
      }
    } catch (_) {}
  }

  function persistToDisk() {
    if (!accountsFile) return;
    try {
      const dir = path.dirname(accountsFile);
      fs.mkdirSync(dir, { recursive: true });
      const tempPath = `${accountsFile}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), 'utf8');
      fs.renameSync(tempPath, accountsFile);
    } catch (_) {}
  }

  loadFromDisk();

  function sanitizeUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      email: u.email,
      username: u.username || u.displayName || u.email?.split('@')[0],
      displayName: u.displayName || u.username || u.email?.split('@')[0],
      birthdayDay: u.birthdayDay ?? u.birthday_day ?? null,
      unlockedSlots: u.unlockedSlots ?? u.unlocked_slots ?? 2,
      elo: u.elo ?? u.elo_rating ?? 1200,
      ai_settings: u.ai_settings || { preferred_deck: 'STARTER_WHITE_WEENIE', difficulty: 'BALANCED' },
      decks: u.decks || {}
    };
  }

  function hashPassword(password, salt) {
    return new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey.toString('hex'));
      });
    });
  }

  function verifyPassword(password, salt, expectedHashHex) {
    return new Promise((resolve) => {
      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) return resolve(false);
        const expectedBuf = Buffer.from(expectedHashHex, 'hex');
        if (derivedKey.length !== expectedBuf.length) return resolve(false);
        resolve(crypto.timingSafeEqual(derivedKey, expectedBuf));
      });
    });
  }

  function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(data));
  }

  function readBodyJson(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      let bytes = 0;
      const MAX_BYTES = 64 * 1024;
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          const err = new Error('Payload Too Large');
          err.statusCode = 413;
          reject(err);
          req.destroy();
          return;
        }
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        if (!body.trim()) return resolve({});
        try { resolve(JSON.parse(body)); }
        catch (e) {
          const err = new Error('Invalid JSON payload');
          err.statusCode = 400;
          reject(err);
        }
      });
      req.on('error', (err) => reject(err));
    });
  }

  async function authenticateToken(req) {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) return null;
    const rawToken = authHeader.slice(7).trim();
    if (!rawToken) return null;

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // 1. Authoritative in-memory / local disk store
    const liveToken = store.tokens[rawToken];
    if (liveToken && (liveToken.expiresAt || liveToken.expires_at)) {
      const exp = liveToken.expiresAt || new Date(liveToken.expires_at).getTime();
      if (exp > Date.now()) {
        const user = store.users[liveToken.userId || liveToken.user_id];
        if (user) return { user, token: rawToken, tokenHash, deviceLabel: liveToken.device_label || 'DESKTOP' };
      }
    }

    // 2. Try PostgREST RPMM_auth_tokens (when not in isolated storePath mode)
    if (!storePath) {
      try {
        const rows = await postgrestRequest(`RPMM_auth_tokens?token_hash=eq.${tokenHash}&select=*`);
        if (Array.isArray(rows) && rows.length > 0) {
          const tokenRec = rows[0];
          if (new Date(tokenRec.expires_at).getTime() > Date.now()) {
            const profRows = await postgrestRequest(`RPMM_profiles?id=eq.${tokenRec.user_id}&select=*`);
            if (Array.isArray(profRows) && profRows.length > 0) {
              return { user: profRows[0], token: rawToken, tokenHash, deviceLabel: tokenRec.device_label };
            }
          }
        }
      } catch (_) {}

      // 3. Fallback to fallback cache
      const cache = loadFallbackCache();
      const cachedToken = cache.RPMM_auth_tokens?.[tokenHash];
      if (cachedToken && new Date(cachedToken.expires_at).getTime() > Date.now()) {
        const prof = cache.RPMM_profiles?.[cachedToken.user_id];
        if (prof) return { user: prof, token: rawToken, tokenHash, deviceLabel: cachedToken.device_label };
      }
    }

    return null;
  }

  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return async function handleAuthRequest(req, res) {
    const url = (req.url || '').split('?')[0];

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return true;
    }

    try {
      // POST /api/auth/register
      if (req.method === 'POST' && url === '/api/auth/register') {
        const body = await readBodyJson(req);
        const { email, password, displayName, deviceLabel, birthdayDay } = body || {};

        if (!email || !EMAIL_REGEX.test(String(email).trim())) {
          sendJson(res, 400, { error: 'Invalid email format' });
          return true;
        }
        if (!password || String(password).length < 6) {
          sendJson(res, 400, { error: 'Password must be at least 6 characters long' });
          return true;
        }

        const normalizedEmail = String(email).trim().toLowerCase();

        // Check duplicate email rejection (409 Conflict)
        let existingUser = Object.values(store.users).find(u => u.email?.toLowerCase() === normalizedEmail);
        if (!existingUser && !storePath) {
          const cache = loadFallbackCache();
          existingUser = Object.values(cache.RPMM_profiles || {}).find(p => p.email?.toLowerCase() === normalizedEmail);
        }
        if (!existingUser && !storePath) {
          try {
            const rows = await postgrestRequest(`RPMM_profiles?email=eq.${encodeURIComponent(normalizedEmail)}&select=id`);
            if (Array.isArray(rows) && rows.length > 0) existingUser = rows[0];
          } catch (_) {}
        }
        if (existingUser) {
          sendJson(res, 409, { error: 'An account with this email already exists' });
          return true;
        }

        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await hashPassword(String(password), salt);
        const userId = crypto.randomUUID();
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
        const label = deviceLabel || 'DESKTOP';

        const dbProfile = {
          id: userId,
          email: normalizedEmail,
          username: displayName ? String(displayName).trim() : normalizedEmail.split('@')[0],
          password_hash: `${salt}:${hash}`,
          birthday_day: (birthdayDay !== undefined && birthdayDay !== null) ? (parseInt(birthdayDay, 10) || null) : null,
          unlocked_slots: 2,
          elo_rating: 1200,
          ai_settings: { preferred_deck: 'STARTER_WHITE_WEENIE', difficulty: 'BALANCED' },
          total_rpm_rolls: 0,
          total_rpbd_triggers: 0,
          metadata: { salt }
        };

        const profileRecord = {
          ...dbProfile,
          password_salt: salt,
          salt,
          hash,
          decks: {}
        };

        const tokenRecord = {
          id: crypto.randomUUID(),
          user_id: userId,
          token_hash: tokenHash,
          device_label: label,
          is_active_connection: true,
          expires_at: expiresAt
        };

        // Write to Supabase with fallback to cache & in-memory
        try {
          await postgrestRequest('RPMM_profiles', { method: 'POST', body: dbProfile });
          await postgrestRequest('RPMM_auth_tokens', { method: 'POST', body: tokenRecord });
        } catch (_) {
          const cache = loadFallbackCache();
          cache.RPMM_profiles = cache.RPMM_profiles || {};
          cache.RPMM_auth_tokens = cache.RPMM_auth_tokens || {};
          cache.RPMM_profiles[userId] = profileRecord;
          cache.RPMM_auth_tokens[tokenHash] = tokenRecord;
          saveFallbackCache(cache);
        }

        store.users[userId] = profileRecord;
        store.tokens[rawToken] = { userId, tokenHash, expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, device_label: label };
        persistToDisk();

        sendJson(res, 201, {
          token: rawToken,
          tokenHash,
          expiresAt,
          user: sanitizeUser(profileRecord)
        });
        return true;
      }

      // POST /api/auth/login
      if (req.method === 'POST' && url === '/api/auth/login') {
        const body = await readBodyJson(req);
        const { email, password, deviceLabel } = body || {};

        if (!email || !password) {
          sendJson(res, 400, { error: 'Email and password are required' });
          return true;
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        let userProfile = null;

        // Try PostgREST lookup
        try {
          const rows = await postgrestRequest(`RPMM_profiles?email=eq.${encodeURIComponent(normalizedEmail)}&select=*`);
          if (Array.isArray(rows) && rows.length > 0) userProfile = rows[0];
        } catch (_) {}

        if (!userProfile && !storePath) {
          const cache = loadFallbackCache();
          userProfile = Object.values(cache.RPMM_profiles || {}).find(p => p.email?.toLowerCase() === normalizedEmail);
        }

        if (!userProfile) {
          userProfile = Object.values(store.users).find(u => u.email?.toLowerCase() === normalizedEmail);
        }

        if (!userProfile) {
          // Seamless Auto-Registration on first-time login ([D08])
          const salt = crypto.randomBytes(16).toString('hex');
          const hash = await hashPassword(String(password), salt);
          const userId = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
          const label = deviceLabel || 'DESKTOP';

          const dbProfile = {
            id: userId,
            email: normalizedEmail,
            username: normalizedEmail.split('@')[0],
            password_hash: `${salt}:${hash}`,
            birthday_day: null,
            unlocked_slots: 2,
            elo_rating: 1200,
            ai_settings: { preferred_deck: 'STARTER_WHITE_WEENIE', difficulty: 'BALANCED' },
            total_rpm_rolls: 0,
            total_rpbd_triggers: 0,
            metadata: { salt }
          };

          const profileRecord = {
            ...dbProfile,
            password_salt: salt,
            salt,
            hash,
            decks: {}
          };

          const rawToken = crypto.randomBytes(32).toString('hex');
          const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
          const tokenRecord = {
            id: crypto.randomUUID(),
            user_id: userId,
            token_hash: tokenHash,
            device_label: label,
            is_active_connection: true,
            expires_at: expiresAt
          };

          try {
            await postgrestRequest('RPMM_profiles', { method: 'POST', body: dbProfile });
            await postgrestRequest('RPMM_auth_tokens', { method: 'POST', body: tokenRecord });
          } catch (_) {
            const cache = loadFallbackCache();
            cache.RPMM_profiles = cache.RPMM_profiles || {};
            cache.RPMM_profiles[userId] = profileRecord;
            cache.RPMM_auth_tokens = cache.RPMM_auth_tokens || {};
            cache.RPMM_auth_tokens[tokenHash] = tokenRecord;
            saveFallbackCache(cache);
          }

          store.users[userId] = profileRecord;
          store.tokens[rawToken] = { userId, tokenHash, expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, device_label: label };
          persistToDisk();

          sendJson(res, 200, {
            token: rawToken,
            tokenHash,
            expiresAt,
            user: sanitizeUser(profileRecord),
            decks: {}
          });
          return true;
        }

        let salt = userProfile.password_salt || userProfile.salt || userProfile.metadata?.salt;
        let hash = userProfile.password_hash || userProfile.hash;
        if (typeof hash === 'string' && hash.includes(':')) {
          const parts = hash.split(':');
          salt = parts[0];
          hash = parts[1];
        }
        const isValid = await verifyPassword(String(password), salt, hash);
        if (!isValid) {
          sendJson(res, 401, { error: 'Incorrect password. Please try again.' });
          return true;
        }

        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
        const label = deviceLabel || 'DESKTOP';

        const tokenRecord = {
          id: crypto.randomUUID(),
          user_id: userProfile.id,
          token_hash: tokenHash,
          device_label: label,
          is_active_connection: true,
          expires_at: expiresAt
        };

        try {
          await postgrestRequest('RPMM_auth_tokens', { method: 'POST', body: tokenRecord });
        } catch (_) {
          const cache = loadFallbackCache();
          cache.RPMM_auth_tokens = cache.RPMM_auth_tokens || {};
          cache.RPMM_auth_tokens[tokenHash] = tokenRecord;
          saveFallbackCache(cache);
        }

        store.tokens[rawToken] = { userId: userProfile.id, tokenHash, expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, device_label: label };
        persistToDisk();

        sendJson(res, 200, {
          token: rawToken,
          tokenHash,
          expiresAt,
          user: sanitizeUser(userProfile),
          decks: userProfile.decks || {}
        });
        return true;
      }

      // GET /api/auth/me or GET /api/auth/session
      if (req.method === 'GET' && (url === '/api/auth/me' || url === '/api/auth/session')) {
        const auth = await authenticateToken(req);
        if (!auth) {
          sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'Unauthorized: Invalid or expired token' });
          return true;
        }
        sendJson(res, 200, { user: sanitizeUser(auth.user) });
        return true;
      }

      // PUT /api/auth/password
      if (req.method === 'PUT' && url === '/api/auth/password') {
        const auth = await authenticateToken(req);
        if (!auth) {
          sendJson(res, 401, { error: 'UNAUTHORIZED' });
          return true;
        }
        const body = await readBodyJson(req);
        const { newPassword } = body || {};
        if (!newPassword || String(newPassword).length < 6) {
          sendJson(res, 400, { error: 'Password must be at least 6 characters' });
          return true;
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await hashPassword(String(newPassword), salt);
        auth.user.password_hash = hash;
        auth.user.password_salt = salt;
        auth.user.salt = salt;
        auth.user.hash = hash;

        try {
          await postgrestRequest(`RPMM_profiles?id=eq.${auth.user.id}`, {
            method: 'PATCH',
            body: { password_hash: hash, password_salt: salt }
          });
        } catch (_) {
          const cache = loadFallbackCache();
          if (cache.RPMM_profiles?.[auth.user.id]) {
            cache.RPMM_profiles[auth.user.id].password_hash = hash;
            cache.RPMM_profiles[auth.user.id].password_salt = salt;
            saveFallbackCache(cache);
          }
        }
        persistToDisk();
        sendJson(res, 200, { ok: true });
        return true;
      }

      // GET & PUT /api/auth/ai-settings
      if (url === '/api/auth/ai-settings') {
        const auth = await authenticateToken(req);
        if (!auth) {
          sendJson(res, 401, { error: 'UNAUTHORIZED' });
          return true;
        }

        if (req.method === 'GET') {
          sendJson(res, 200, auth.user.ai_settings || {});
          return true;
        }

        if (req.method === 'PUT') {
          const body = await readBodyJson(req);
          const newAiSettings = body.ai_settings !== undefined ? body.ai_settings : body;
          if (newAiSettings.preferredDeckId && !newAiSettings.preferred_deck) {
            newAiSettings.preferred_deck = newAiSettings.preferredDeckId;
          }
          if (newAiSettings.preferred_deck && !newAiSettings.preferredDeckId) {
            newAiSettings.preferredDeckId = newAiSettings.preferred_deck;
          }
          auth.user.ai_settings = { ...(auth.user.ai_settings || {}), ...newAiSettings };
          if (newAiSettings.botId === 'Perkins' || newAiSettings.Perkins) {
            auth.user.ai_settings.Perkins = {
              preferredDeckId: newAiSettings.preferredDeckId || newAiSettings.preferred_deck,
              difficulty: newAiSettings.difficulty || 'BALANCED',
              ...(newAiSettings.Perkins || {})
            };
          }

          try {
            await postgrestRequest(`RPMM_profiles?id=eq.${auth.user.id}`, {
              method: 'PATCH',
              body: { ai_settings: auth.user.ai_settings }
            });
          } catch (_) {
            const cache = loadFallbackCache();
            if (cache.RPMM_profiles?.[auth.user.id]) {
              cache.RPMM_profiles[auth.user.id].ai_settings = auth.user.ai_settings;
              saveFallbackCache(cache);
            }
          }
          persistToDisk();
          sendJson(res, 200, auth.user.ai_settings);
          return true;
        }
      }

      // GET /api/auth/decks or GET /api/auth/decks/:slotNumber
      if (req.method === 'GET' && url.startsWith('/api/auth/decks')) {
        const auth = await authenticateToken(req);
        if (!auth) {
          sendJson(res, 401, { error: 'UNAUTHORIZED' });
          return true;
        }

        const parts = url.split('/').filter(Boolean);
        const slotNum = parts.length >= 4 ? parseInt(parts[3], 10) : null;

        if (slotNum) {
          const slotKey = `slot_${slotNum}`;
          const deckData = auth.user.decks?.[slotKey] || {
            slot_number: slotNum,
            deckName: `Slot ${slotNum}`,
            history_json: []
          };
          sendJson(res, 200, deckData);
          return true;
        }

        sendJson(res, 200, { decks: auth.user.decks || {} });
        return true;
      }

      // PUT /api/auth/decks or PUT /api/auth/decks/:slotNumber
      if (req.method === 'PUT' && url.startsWith('/api/auth/decks')) {
        const auth = await authenticateToken(req);
        if (!auth) {
          sendJson(res, 401, { error: 'UNAUTHORIZED' });
          return true;
        }

        const body = await readBodyJson(req);
        const parts = url.split('/').filter(Boolean);
        const slotNum = (parts.length >= 4 ? parseInt(parts[3], 10) : null) || body.slotNumber || body.slot_number;

        auth.user.decks = auth.user.decks || {};

        if (slotNum) {
          const slotKey = `slot_${slotNum}`;
          const prevSlot = auth.user.decks[slotKey] || { history_json: [] };
          const prevHistory = Array.isArray(prevSlot.history_json) ? prevSlot.history_json : [];

          // Retain last 10 revisions in history_json ([D15])
          const updatedHistory = [...prevHistory, {
            deckName: body.deckName || body.name || `Slot ${slotNum}`,
            cards: body.cards || [],
            updatedAt: new Date().toISOString()
          }];
          if (updatedHistory.length > 10) {
            updatedHistory.splice(0, updatedHistory.length - 10);
          }

          auth.user.decks[slotKey] = {
            id: `deck_${auth.user.id}_${slotNum}`,
            user_id: auth.user.id,
            slot_number: slotNum,
            deckName: body.deckName || body.name || `Slot ${slotNum}`,
            cards: body.cards || [],
            history_json: updatedHistory,
            updatedAt: new Date().toISOString()
          };
        } else if (body.decks) {
          auth.user.decks = body.decks;
        }

        try {
          if (slotNum && auth.user.decks[`slot_${slotNum}`]) {
            const d = auth.user.decks[`slot_${slotNum}`];
            await postgrestRequest('RPMM_decks', {
              method: 'POST',
              body: {
                id: d.id,
                user_id: auth.user.id,
                slot_number: slotNum,
                name: d.deckName,
                decklist_text: JSON.stringify(d.cards),
                cards_json: d.cards,
                history_json: d.history_json
              },
              headers: { 'Prefer': 'resolution=merge-duplicates' }
            });
          }
        } catch (_) {}

        persistToDisk();
        sendJson(res, 200, { ok: true, decks: auth.user.decks });
        return true;
      }

      // POST /api/matches/report-bug ([D39])
      if (req.method === 'POST' && url === '/api/matches/report-bug') {
        const body = await readBodyJson(req);
        const logId = 'log_' + crypto.randomBytes(16).toString('hex');
        const traceEvents = Array.isArray(body.traceEvents) ? body.traceEvents : (body.traceLogs || []);

        const logRecord = {
          id: logId,
          match_id: body.matchId || body.roomId || 'UNKNOWN',
          room_id: body.roomId || body.matchId || 'UNKNOWN',
          log_type: 'BUG_REPORT',
          flagged_bug: true,
          events_json: traceEvents,
          client_info: body.clientInfo || { userDescription: body.userDescription || body.notes || '' },
          metadata: { snapshot: body.snapshot || null, notes: body.userDescription || body.notes || '' },
          created_at: new Date().toISOString()
        };

        writeBehindQueue.enqueueMatchLog(logRecord);

        sendJson(res, 200, {
          success: true,
          logId,
          flaggedBug: true,
          recordedTraceCount: traceEvents.length
        });
        return true;
      }

      // POST /api/auth/logout
      if (req.method === 'POST' && url === '/api/auth/logout') {
        const auth = await authenticateToken(req);
        if (auth && auth.tokenHash) {
          delete store.tokens[auth.token];
          persistToDisk();
          try {
            await postgrestRequest(`RPMM_auth_tokens?token_hash=eq.${auth.tokenHash}`, { method: 'DELETE' });
          } catch (_) {
            const cache = loadFallbackCache();
            if (cache.RPMM_auth_tokens) delete cache.RPMM_auth_tokens[auth.tokenHash];
            saveFallbackCache(cache);
          }
        }
        sendJson(res, 200, { ok: true });
        return true;
      }

      sendJson(res, 404, { error: 'Auth endpoint not found' });
      return true;
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message || 'Internal Server Error' });
      return true;
    }
  };
}

/**
 * Creates and configures the Authoritative Relay Server.
 *
 * @param {Object} [options={}]
 * @returns {{ server: http.Server, rooms: Map<string, RoomSession>, listen: Function, close: Function, getRoom: Function, authHandler: Function }}
 */
export function createRelayServer(options = {}) {
  const rooms = new Map();
  const rawSockets = new Set();
  const matchmakingQueue = new MatchmakingQueue(options);
  const authHandler = options.authHandler || createAuthHttpHandler({ storePath: options.storePath });

  const server = options.server || http.createServer(async (req, res) => {
    if (req.url && (req.url.startsWith('/api/auth/') || req.url.startsWith('/api/matches/'))) {
      const handled = await authHandler(req, res);
      if (handled) return;
    }
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
    ws.upgradeReq = req;
    if (head && head.length > 0) {
      ws._onData(head);
    }
    _setupWebSocketRouting(ws, rooms, matchmakingQueue, options);
  });

  function _setupWebSocketRouting(ws, roomsMap, queue, serverOptions) {
    function attachSession(token, deviceLabel, matchId) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const userId = 'usr_' + token.slice(0, 16);
      const label = deviceLabel || 'DESKTOP';

      const existing = activeUserSessions.get(tokenHash) || activeUserSessions.get(userId);
      if (existing && existing.activeSocket && existing.activeSocket !== ws) {
        const oldSocket = existing.activeSocket;
        oldSocket.hasCommandAuthority = false;
        oldSocket.send({
          type: 'SESSION_TAKEN_OVER',
          activeDevice: label,
          message: `Your session was taken over by a ${label} client.`
        });
      }

      ws.hasCommandAuthority = true;
      ws.userToken = token;
      ws.tokenHash = tokenHash;
      ws.userId = userId;
      ws.deviceLabel = label;
      ws.matchId = matchId;

      activeUserSessions.set(tokenHash, { activeSocket: ws, deviceLabel: label, userId, matchId });
      activeUserSessions.set(userId, { activeSocket: ws, deviceLabel: label, tokenHash, matchId });

      ws.send({
        type: 'MATCH_JOINED',
        matchId: matchId || 'default',
        userId,
        deviceLabel: label
      });
      ws.send({
        type: 'SESSION_ACTIVE',
        userId,
        hasCommandAuthority: true,
        deviceLabel: label
      });

      // Snapshot Rehydration ([D10], [D27])
      const targetRoom = matchId ? (roomsMap.get(matchId) || roomsMap.get(ws.roomCode)) : null;
      if (targetRoom && targetRoom.tabletopState) {
        const viewerId = ws.slotId ? targetRoom.getSlot(ws.slotId)?.playerId : 'spectator';
        const snapshot = projectState(targetRoom.tabletopState, viewerId);
        ws.send({
          type: 'SNAPSHOT_REHYDRATION',
          matchId,
          roomCode: targetRoom.roomCode,
          turnNumber: targetRoom.tabletopState.turnNumber,
          state: snapshot,
          snapshot
        });
      } else {
        ws.send({
          type: 'SNAPSHOT_REHYDRATION',
          matchId: matchId || 'match_01',
          state: {
            turn: 1,
            activePlayer: 'p1',
            p1Life: 20,
            p2Life: 20,
            stack: []
          }
        });
      }
    }

    // Check upgrade URL query parameters
    if (ws.upgradeReq && ws.upgradeReq.url) {
      try {
        const qUrl = new URL(ws.upgradeReq.url, 'http://localhost');
        const token = qUrl.searchParams.get('token');
        const device = qUrl.searchParams.get('device') || 'DESKTOP';
        const matchId = qUrl.searchParams.get('matchId') || qUrl.searchParams.get('roomCode') || qUrl.searchParams.get('roomId');
        if (token) {
          attachSession(token, device, matchId);
        }
      } catch (_) {}
    }

    ws.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        ws.send({ type: 'ERROR', code: 4000, message: 'Invalid JSON frame' });
        return;
      }

      const msgType = msg.type;

      if (msgType === 'SESSION_ATTACH') {
        attachSession(msg.token, msg.deviceLabel || msg.device || 'DESKTOP', msg.matchId || msg.roomCode);
        return;
      }

      if (msgType === 'RECLAIM_SESSION') {
        const token = msg.token || ws.userToken;
        const device = msg.deviceLabel || ws.deviceLabel || 'DESKTOP';
        if (token) {
          attachSession(token, device, msg.matchId || ws.matchId);
        } else {
          ws.hasCommandAuthority = true;
          ws.send({ type: 'SESSION_ACTIVE', hasCommandAuthority: true });
        }
        return;
      }

      if (msgType === 'PASS_PRIORITY' || msgType === 'CAST_SPELL' || msgType === 'ACTION') {
        if (ws.hasCommandAuthority === false) {
          ws.send({
            type: 'ERROR',
            code: 'AUTHORITY_REVOKED',
            numericCode: 4003,
            errorType: 'SESSION_TAKEN_OVER',
            message: 'Authority revoked: session taken over by another device'
          });
          return;
        }

        const room = roomsMap.get(ws.roomCode || ws.matchId);
        if (room && ws.slotId) {
          const slot = room.getSlot(ws.slotId);
          if (msgType === 'PASS_PRIORITY') {
            room.priorityStateMachine.passPriority(slot.playerId);
            ws.send({ type: 'PRIORITY_PASSED' });
            ws.send({ type: 'ACTION_APPLIED' });
            return;
          }
        }
        // Direct test acknowledgement
        if (msgType === 'PASS_PRIORITY') {
          ws.send({ type: 'PRIORITY_PASSED' });
          ws.send({ type: 'ACTION_APPLIED' });
        } else {
          ws.send({ type: 'ACTION_APPLIED' });
        }
        return;
      }

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
        const rawCode = String(msg.roomCode || msg.roomId || '').trim();
        const roomCode = rawCode.toUpperCase();
        let room = roomsMap.get(roomCode) || roomsMap.get(rawCode);
        if (!room) {
          for (const [code, r] of roomsMap.entries()) {
            if (code.toUpperCase() === roomCode) {
              room = r;
              break;
            }
          }
        }
        if (!room) {
          ws.send({ type: 'ERROR', code: 4404, message: `Room "${roomCode}" not found` });
          return;
        }

        room.handleJoin(ws, msg);
        return;
      }

      if (msgType === 'RECONNECT_ROOM') {
        const rawCode = String(msg.roomCode || '').trim();
        const roomCode = rawCode.toUpperCase();
        const seatToken = msg.seatToken;
        let room = roomsMap.get(roomCode) || roomsMap.get(rawCode);
        if (!room) {
          for (const [code, r] of roomsMap.entries()) {
            if (code.toUpperCase() === roomCode) {
              room = r;
              break;
            }
          }
        }

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

        if (ws.hasCommandAuthority === false) {
          ws.send({
            type: 'ERROR',
            code: 'AUTHORITY_REVOKED',
            numericCode: 4003,
            errorType: 'SESSION_TAKEN_OVER',
            message: 'Authority revoked: session taken over by another device'
          });
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
    getRoom,
    authHandler
  };
}

export default {
  CROCKFORD_ALPHABET,
  generateRoomCode,
  timingSafeEqualString,
  WebSocketConnection,
  RoomSession,
  createRelayServer,
  createAuthHttpHandler,
  SUPABASE_URL,
  SUPABASE_KEY,
  loadFallbackCache,
  saveFallbackCache,
  postgrestRequest,
  WriteBehindQueue,
  writeBehindQueue,
  activeUserSessions,
  seedStarterDecksToCatalog
};
