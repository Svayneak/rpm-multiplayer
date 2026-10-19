/**
 * LobbyManager.js
 * Multiplayer Seating Manager, Readiness Protocol & 20s Disconnect Grace
 * 
 * Part of RPM Multiplayer - Feature 14
 * Document ID: SPEC-RPM-PLATFORM-014
 * Enforces Architectural Invariants:
 * - INV-LOBBY-1: Dynamic Readiness Invalidation
 * - INV-LOBBY-2: Room Seating & Capacity Scaling (2 for Duel, 3 for Pod, 6 Auto-Start)
 * - INV-LOBBY-3: Pre-Game 20s Lobby Disconnect Grace Timer
 * 
 * @module LobbyManager
 */

import { EventEmitter } from './EventEmitter.js';

function generateSeatToken() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const arr = new Uint8Array(32);
    globalThis.crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2) + Date.now().toString(36);
}

export const LOBBY_STATUS = Object.freeze({
  LOBBY_WAITING: 'LOBBY_WAITING',
  READY_CHECK: 'READY_CHECK',
  ROLL_OFF_PHASE: 'ROLL_OFF_PHASE',
  MATCH_ACTIVE: 'MATCH_ACTIVE',
  MATCH_COMPLETED: 'MATCH_COMPLETED'
});

export const DEFAULT_DISCONNECT_GRACE_MS = 20000;

/**
 * LobbyManager
 * Manages seating 1..6, readiness state synchronization, and dynamic invalidation.
 */
export class LobbyManager extends EventEmitter {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.roomCode]
   * @param {number} [options.maxPlayers=6]
   * @param {'DUEL_1V1'|'POD_MULTIPLAYER'} [options.roomType]
   * @param {number} [options.minPlayersToStart]
   * @param {number} [options.disconnectGraceMs=20000]
   */
  constructor(options = {}) {
    super();
    this.roomCode = options.roomCode || 'LOBBY1';
    this.maxPlayers = options.maxPlayers || 6;
    this.roomType = options.roomType || (this.maxPlayers === 2 ? 'DUEL_1V1' : 'POD_MULTIPLAYER');
    this.minPlayersToStart = options.minPlayersToStart || (this.roomType === 'DUEL_1V1' || this.maxPlayers === 2 ? 2 : 3);
    this.disconnectGraceMs = options.disconnectGraceMs || DEFAULT_DISCONNECT_GRACE_MS;

    this.status = LOBBY_STATUS.LOBBY_WAITING;

    /** @type {Map<number, Object>} slotId -> PlayerSlot */
    this.slots = new Map();
  }

  /**
   * Returns count of seated players (CONNECTED or in GRACE).
   * @returns {number}
   */
  getSeatedCount() {
    return this.slots.size;
  }

  /**
   * Returns count of players who have confirmed ready.
   * @returns {number}
   */
  getReadyCount() {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.isReady && slot.connectionStatus === 'CONNECTED') {
        count++;
      }
    }
    return count;
  }

  /**
   * Checks if minimum seating capacity to start is satisfied (INV-LOBBY-2).
   * @returns {boolean}
   */
  canStart() {
    return this.getSeatedCount() >= this.minPlayersToStart;
  }

  /**
   * Checks if all seated players have confirmed ready.
   * @returns {boolean}
   */
  isAllReady() {
    const seated = this.getSeatedCount();
    return seated >= this.minPlayersToStart && this.getReadyCount() === seated;
  }

  /**
   * Invalidates and revokes all player readiness confirmations (INV-LOBBY-1).
   * 
   * @param {string} reason - 'NEW_PLAYER_ARRIVED' | 'PLAYER_LEFT' | 'GRACE_EXPIRED'
   * @param {Object} [metadata={}]
   */
  invalidateReadiness(reason, metadata = {}) {
    let anyReset = false;
    for (const slot of this.slots.values()) {
      if (!slot.isBot && slot.isReady) {
        slot.isReady = false;
        anyReset = true;
      }
    }

    if (this.status === LOBBY_STATUS.READY_CHECK && !this.canStart()) {
      this.status = LOBBY_STATUS.LOBBY_WAITING;
    }

    const payload = {
      reason,
      ...metadata,
      timestamp: Date.now()
    };
    this.emit('readiness_reset', payload);
    this.emit('LOBBY_READY_RESET', payload);

    return anyReset;
  }

  /**
   * Claims an open seat slot (1..maxPlayers).
   * Enforces INV-LOBBY-4: Automatically vacates any seat previously held by player.playerId.
   * Enforces INV-LOBBY-1: Revokes human readiness states when seating changes.
   * Enforces INV-LOBBY-2: Auto-starts when 6th player sits (full capacity).
   * 
   * @param {number|string|Object} arg1 
   * @param {Object|string|number} [arg2] 
   * @param {string|number} [arg3] 
   * @returns {Object} Claimed slot
   */
  claimSeat(arg1, arg2, arg3) {
    let slotId, player;
    if (typeof arg1 === 'number') {
      slotId = arg1;
      player = typeof arg2 === 'string'
        ? { playerId: arg2, playerName: typeof arg3 === 'string' ? arg3 : arg2 }
        : (arg2 || {});
    } else if (typeof arg1 === 'string') {
      const pid = arg1;
      const pname = typeof arg2 === 'string' ? arg2 : pid;
      slotId = typeof arg3 === 'number' ? arg3 : (typeof arg2 === 'number' ? arg2 : 1);
      player = { playerId: pid, playerName: pname };
    } else if (arg1 && typeof arg1 === 'object') {
      player = arg1;
      slotId = typeof arg2 === 'number' ? arg2 : (player.slotId || 1);
    } else {
      player = {};
      slotId = 1;
    }

    if (!slotId || slotId < 1 || slotId > this.maxPlayers) {
      throw new Error(`Invalid slotId: ${slotId}. Must be between 1 and ${this.maxPlayers}.`);
    }

    if (!player || !player.playerId) {
      throw new Error('Player must provide a valid playerId.');
    }

    if (this.slots.has(slotId)) {
      const existing = this.slots.get(slotId);
      if (existing.playerId === player.playerId) {
        existing.playerName = player.playerName || existing.playerName;
        return { ...existing };
      }
      throw new Error(`Seat slot ${slotId} is already occupied.`);
    }

    // INV-LOBBY-4: 1-Player = 1-Seat Invariant & Moving Seats
    let priorSlotId = null;
    for (const [existingSlotId, existingSlot] of this.slots.entries()) {
      if (existingSlot.playerId === player.playerId) {
        priorSlotId = existingSlotId;
        break;
      }
    }

    if (priorSlotId !== null) {
      if (priorSlotId === slotId) {
        return this.slots.get(slotId);
      }
      // Vacate prior seat cleanly without ghost duplication
      this.slots.delete(priorSlotId);
      this.invalidateReadiness('PLAYER_MOVED_SEAT', {
        playerId: player.playerId,
        fromSlotId: priorSlotId,
        toSlotId: slotId
      });
    }

    const seatToken = player.seatToken || generateSeatToken();
    const isBot = Boolean(player.isBot);
    const slot = {
      slotId,
      playerId: player.playerId,
      playerName: player.playerName || (isBot ? `Perkins AI #${slotId}` : `Player ${slotId}`),
      isHost: slotId === 1 || Boolean(player.isHost),
      isReady: isBot ? true : Boolean(player.isReady),
      isBot,
      starterDeckId: player.starterDeckId || (isBot ? 'R' : null),
      connectionStatus: 'CONNECTED',
      joinedAt: Date.now(),
      seatToken,
      graceTimerRemainingMs: 0
    };

    this.slots.set(slotId, slot);

    if (priorSlotId === null) {
      this.invalidateReadiness(isBot ? 'BOT_SEATED' : 'NEW_PLAYER_ARRIVED', {
        slotId,
        playerId: slot.playerId,
        playerName: slot.playerName,
        isBot
      });
    }

    // Update state to READY_CHECK if min players reached
    if (this.canStart() && this.status === LOBBY_STATUS.LOBBY_WAITING) {
      this.status = LOBBY_STATUS.READY_CHECK;
    }

    // Full Capacity Auto-Start (INV-LOBBY-2)
    if (this.getSeatedCount() === this.maxPlayers) {
      this.status = LOBBY_STATUS.ROLL_OFF_PHASE;
      const autoStartEvt = {
        reason: 'FULL_CAPACITY',
        seatedCount: this.getSeatedCount()
      };
      this.emit('auto_start', autoStartEvt);
      this.emit('MATCH_START_TRIGGERED', autoStartEvt);
    }

    return slot;
  }

  /**
   * Seats a Perkins AI agent into an open slot (INV-LOBBY-5).
   * 
   * @param {number} slotId - Must be between 2 and maxPlayers
   * @param {Object} [options={}]
   * @returns {Object} Seated bot slot
   */
  seatBot(slotId, options = {}) {
    if (slotId < 2 || slotId > this.maxPlayers) {
      throw new Error(`Bots can only be seated in slots 2 to ${this.maxPlayers}.`);
    }

    const botPlayerId = options.playerId || `bot_perkins_${slotId}`;
    const botPlayerName = options.playerName || `Perkins AI #${slotId}`;

    const botSlot = this.claimSeat(slotId, {
      playerId: botPlayerId,
      playerName: botPlayerName,
      isBot: true,
      isReady: true,
      starterDeckId: options.starterDeckId || 'R',
      ...options
    });

    this.emit('bot_seated', { slotId, botSlot });
    return botSlot;
  }

  /**
   * Removes a bot from a seated slot (INV-LOBBY-5).
   * 
   * @param {number} slotId 
   * @returns {boolean} True if removed
   */
  removeBot(slotId) {
    const slot = this.slots.get(slotId);
    if (!slot || !slot.isBot) {
      return false;
    }
    const result = this.vacateSeat(slotId);
    this.emit('bot_removed', { slotId });
    return result;
  }

  /**
   * Vacates seat for a human player (voluntary leave).
   * 
   * @param {number} slotId 
   * @returns {boolean}
   */
  leaveSeat(slotId) {
    return this.vacateSeat(slotId);
  }

  /**
   * Returns array of all currently seated slots (humans and bots).
   * @returns {Array<Object>}
   */
  getSeatedSlots() {
    return Array.from(this.slots.values());
  }

  /**
   * Vacates a seat slot (player voluntary leave or kick).
   * Enforces INV-LOBBY-1: Revokes all confirmations when a player leaves.
   * 
   * @param {number} slotId 
   * @returns {boolean} True if vacated
   */
  vacateSeat(slotId) {
    const slot = this.slots.get(slotId);
    if (!slot) return false;

    this.slots.delete(slotId);

    // Dynamic Departure Invalidation (INV-LOBBY-1)
    this.invalidateReadiness('PLAYER_LEFT', {
      slotId,
      playerId: slot.playerId,
      playerName: slot.playerName
    });

    if (!this.canStart()) {
      this.status = LOBBY_STATUS.LOBBY_WAITING;
    }

    return true;
  }

  /**
   * Helper to resolve a slot by slotId (number) or playerId (string).
   * @param {number|string} identifier 
   * @returns {Object|null}
   */
  _resolveSlot(identifier) {
    if (typeof identifier === 'number') {
      return this.slots.get(identifier) || null;
    }
    if (typeof identifier === 'string') {
      for (const slot of this.slots.values()) {
        if (slot.playerId === identifier) {
          return slot;
        }
      }
    }
    return null;
  }

  /**
   * Alias for setPlayerReady accepting either slotId or playerId (INV-LOBBY-2).
   * 
   * @param {number|string} identifier 
   * @param {boolean} [isReady] 
   * @returns {{ slot: Object, allReady: boolean, canStart: boolean }}
   */
  setReady(identifier, isReady) {
    return this.setPlayerReady(identifier, isReady);
  }

  /**
   * Toggles or sets player ready status (INV-LOBBY-2).
   * 
   * @param {number|string} identifier - slotId or playerId
   * @param {boolean} [isReady] 
   * @returns {{ slot: Object, allReady: boolean, canStart: boolean }}
   */
  setPlayerReady(identifier, isReady) {
    const slot = this._resolveSlot(identifier);
    if (!slot) {
      throw new Error(`Slot ${identifier} not found.`);
    }

    if (slot.connectionStatus !== 'CONNECTED') {
      throw new Error(`Cannot set ready state for disconnected slot ${identifier}.`);
    }

    slot.isReady = (isReady !== undefined) ? Boolean(isReady) : !slot.isReady;

    const canStart = this.canStart();
    const allReady = this.isAllReady();

    if (canStart) {
      this.status = LOBBY_STATUS.READY_CHECK;
    }

    if (canStart && allReady) {
      this.status = LOBBY_STATUS.ROLL_OFF_PHASE;
      const readyPayload = {
        seatedCount: this.getSeatedCount(),
        readyCount: this.getReadyCount()
      };
      this.emit('match_ready', readyPayload);
      this.emit('MATCH_START_TRIGGERED', readyPayload);
    }

    return {
      slot,
      allReady,
      canStart
    };
  }

  /**
   * Handles player disconnection with 20-second grace timer (INV-LOBBY-3).
   * 
   * @param {number|string} identifier - slotId or playerId
   * @param {number} [graceMs]
   */
  handleDisconnect(identifier, graceMs = this.disconnectGraceMs) {
    const slot = this._resolveSlot(identifier);
    if (!slot) return;

    slot.connectionStatus = 'DISCONNECTED';
    slot.graceTimerRemainingMs = graceMs;
    slot.isReady = false; // Disconnected players drop ready state

    this.emit('player_grace_started', {
      slotId: slot.slotId,
      playerId: slot.playerId,
      graceMs
    });
  }

  /**
   * Restores a disconnected slot if reconnected within grace timer (INV-LOBBY-3).
   * 
   * @param {number|string} identifier - slotId or playerId
   * @param {string} seatToken 
   * @returns {{ success: boolean, slot?: Object, error?: string }}
   */
  handleReconnect(identifier, seatToken) {
    const slot = this._resolveSlot(identifier);
    if (!slot) return { success: false, error: 'Slot not found' };

    if (slot.seatToken !== seatToken) {
      return { success: false, error: 'Invalid seat token' };
    }

    slot.connectionStatus = 'CONNECTED';
    slot.graceTimerRemainingMs = 0;

    this.emit('player_reconnected', {
      slotId: slot.slotId,
      playerId: slot.playerId
    });

    return { success: true, slot };
  }

  /**
   * Manually expires grace period for a slot (INV-LOBBY-3).
   * 
   * @param {number|string} identifier 
   * @returns {boolean}
   */
  expireGracePeriod(identifier) {
    const slot = this._resolveSlot(identifier);
    if (!slot) return false;

    const slotId = slot.slotId;
    this.slots.delete(slotId);

    this.emit('player_grace_expired', {
      slotId,
      playerId: slot.playerId
    });

    this.invalidateReadiness('GRACE_EXPIRED', { slotId });

    if (!this.canStart()) {
      this.status = LOBBY_STATUS.LOBBY_WAITING;
    }

    return true;
  }

  /**
   * Ticks down grace timers for disconnected slots.
   * If a slot's grace timer expires, vacates the seat and triggers INV-LOBBY-1.
   * 
   * @param {number} deltaMs 
   */
  tickGrace(deltaMs) {
    const expiredSlots = [];

    for (const slot of this.slots.values()) {
      if (slot.connectionStatus === 'DISCONNECTED') {
        slot.graceTimerRemainingMs = Math.max(0, slot.graceTimerRemainingMs - deltaMs);
        if (slot.graceTimerRemainingMs <= 0) {
          expiredSlots.push(slot.slotId);
        }
      }
    }

    for (const slotId of expiredSlots) {
      const slot = this.slots.get(slotId);
      this.slots.delete(slotId);

      this.emit('player_grace_expired', {
        slotId,
        playerId: slot?.playerId
      });

      // Dynamic Arrival/Departure Invalidation (INV-LOBBY-1)
      this.invalidateReadiness('GRACE_EXPIRED', { slotId });
    }
  }

  /**
   * Returns current RoomLobbyState.
   * @returns {Object}
   */
  getState() {
    const slotsObj = {};
    for (let i = 1; i <= this.maxPlayers; i++) {
      slotsObj[i] = this.slots.get(i) || null;
    }

    return {
      roomCode: this.roomCode,
      status: this.status,
      roomType: this.roomType,
      maxPlayers: this.maxPlayers,
      minPlayersToStart: this.minPlayersToStart,
      slots: slotsObj,
      seatedCount: this.getSeatedCount(),
      readyCount: this.getReadyCount(),
      canStart: this.canStart(),
      isAllReady: this.isAllReady()
    };
  }
}

export default LobbyManager;
