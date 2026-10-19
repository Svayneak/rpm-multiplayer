/**
 * MatchmakingQueue.js
 * 1v1 FIFO Matchmaking Engine & 45-Second Perkins Watchdog
 * 
 * Part of RPM Multiplayer - Feature 14
 * Document ID: SPEC-RPM-PLATFORM-014
 * Enforces Architectural Invariants:
 * - INV-QUEUE-1: FIFO 1v1 Queue & 45s Watchdog
 * 
 * @module MatchmakingQueue
 */

export const CROCKFORD_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Generates a 6-character room code matching ^[2-9A-HJKMNP-Z]{6}$ without Node.js dependencies.
 * @param {Map<string, any>|Set<string>|Object} [existingRoomsMap]
 * @returns {string}
 */
export function generateRoomCode(existingRoomsMap = new Map()) {
  let code = '';
  let attempts = 0;
  const isTaken = (c) => {
    if (typeof existingRoomsMap?.has === 'function') {
      return existingRoomsMap.has(c);
    }
    return Boolean(existingRoomsMap?.[c]);
  };

  do {
    code = '';
    const bytes = new Uint8Array(6);
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    for (let i = 0; i < 6; i++) {
      code += CROCKFORD_ALPHABET[bytes[i] % CROCKFORD_ALPHABET.length];
    }
    attempts++;
    if (attempts > 50) {
      throw new Error('Room code collision exhaustion limit reached');
    }
  } while (isTaken(code));

  return code;
}

function generateTicketId() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `ticket_${Date.now()}_${hex}`;
  }
  return `ticket_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

export const WATCHDOG_THRESHOLD_SECONDS = 45;

/**
 * MatchmakingQueue
 * Thread-safe / mutex-atomic FIFO queue for 1v1 pairing with watchdog age tracking.
 */
export class MatchmakingQueue {
  /**
   * @param {Object} [options={}]
   * @param {number} [options.watchdogSeconds=45]
   */
  constructor(options = {}) {
    this.watchdogSeconds = options.watchdogSeconds || WATCHDOG_THRESHOLD_SECONDS;
    /** @type {Array<Object>} */
    this.queue = [];
  }

  /**
   * Adds a player ticket to the queue.
   * 
   * @param {Object} ticket
   * @param {string} [ticket.ticketId]
   * @param {string} ticket.playerId
   * @param {string} [ticket.playerName='Player']
   * @param {'MODERN'|'FREE'} [ticket.format='MODERN']
   * @param {string} [ticket.deckId='default_deck']
   * @param {any} [ticket.socket=null]
   * @returns {Object} Stored ticket
   */
  enqueue(ticket) {
    if (!ticket || !ticket.playerId) {
      throw new Error('Queue ticket must have a valid playerId');
    }

    // Purge any existing ticket for this player ID to prevent duplicates
    this.removeTicket(ticket.playerId);

    const ticketId = ticket.ticketId || generateTicketId();
    const entry = {
      ticketId,
      playerId: ticket.playerId,
      playerName: ticket.playerName || `Player_${ticket.playerId.slice(-4)}`,
      joinedAt: ticket.joinedAt || Date.now(),
      format: (ticket.format || 'MODERN').toUpperCase(),
      deckId: ticket.deckId || 'default_deck',
      socket: ticket.socket || null
    };

    this.queue.push(entry);
    return entry;
  }

  /**
   * Removes and returns the head ticket from the queue.
   * @returns {Object|null}
   */
  dequeue() {
    return this.queue.shift() || null;
  }

  /**
   * Finds ticket by ticketId or playerId.
   * @param {string} id 
   * @returns {Object|null}
   */
  getTicket(id) {
    if (!id) return null;
    return this.queue.find(t => t.ticketId === id || t.playerId === id) || null;
  }

  /**
   * Removes a ticket by ticketId or playerId.
   * @param {string} id 
   * @returns {boolean} True if removed
   */
  removeTicket(id) {
    if (!id) return false;
    const initialLen = this.queue.length;
    this.queue = this.queue.filter(t => t.ticketId !== id && t.playerId !== id);
    return this.queue.length < initialLen;
  }

  /**
   * Atomic Head Pairing (INV-QUEUE-1):
   * Pairs the first two compatible players in FIFO order and generates a match.
   * Eliminates duplicate pairings by immediately extracting tickets.
   * 
   * @param {string} [format='MODERN']
   * @param {Map<string, any>} [existingRooms]
   * @returns {Object|null} Match details or null if insufficient players
   */
  findMatch(format = 'MODERN', existingRooms = new Map()) {
    const targetFormat = (format || 'MODERN').toUpperCase();
    
    // Find first matching candidate index
    const firstIdx = this.queue.findIndex(t => t.format === targetFormat);
    if (firstIdx === -1) return null;

    // Find second matching candidate index after the first
    const secondIdx = this.queue.findIndex((t, idx) => idx > firstIdx && t.format === targetFormat);
    if (secondIdx === -1) return null;

    // Extract tickets atomically in reverse index order
    const [p2] = this.queue.splice(secondIdx, 1);
    const [p1] = this.queue.splice(firstIdx, 1);

    const roomCode = generateRoomCode(existingRooms);
    return {
      roomCode,
      format: targetFormat,
      player1: p1,
      player2: p2,
      createdAt: Date.now()
    };
  }

  /**
   * Returns wait time for a player in milliseconds.
   * @param {string} id - ticketId or playerId
   * @returns {number}
   */
  getWaitTime(id) {
    const ticket = this.getTicket(id);
    if (!ticket) return -1;
    return Date.now() - ticket.joinedAt;
  }

  /**
   * Checks whether a ticket has exceeded the 45-second watchdog threshold (INV-QUEUE-1).
   * @param {string} [id] - ticketId or playerId (optional; if omitted, checks all tickets)
   * @param {number} [thresholdSeconds]
   * @returns {Object|Array<Object>}
   */
  checkWatchdog(id, thresholdSeconds = this.watchdogSeconds) {
    if (id === undefined) {
      const now = Date.now();
      const flagged = [];
      for (const ticket of this.queue) {
        const waitTimeMs = now - ticket.joinedAt;
        if (waitTimeMs >= (thresholdSeconds * 1000)) {
          flagged.push({
            ticketId: ticket.ticketId,
            playerId: ticket.playerId,
            waitTimeMs,
            shouldPromptPerkins: true,
            ticket
          });
        }
      }
      return flagged;
    }

    const ticket = this.getTicket(id);
    if (!ticket) {
      return { timedOut: false, waitTimeMs: 0, ticket: null, shouldPromptPerkins: false };
    }
    const waitTimeMs = Date.now() - ticket.joinedAt;
    const timedOut = waitTimeMs >= (thresholdSeconds * 1000);
    return {
      timedOut,
      waitTimeMs,
      ticket,
      shouldPromptPerkins: timedOut
    };
  }

  /**
   * Returns current count of waiting players (alias for getQueueLength).
   * @param {string} [format]
   * @returns {number}
   */
  size(format) {
    return this.getQueueLength(format);
  }

  /**
   * Returns current count of waiting players.
   * @param {string} [format]
   * @returns {number}
   */
  getQueueLength(format) {
    if (!format) return this.queue.length;
    const target = format.toUpperCase();
    return this.queue.filter(t => t.format === target).length;
  }

  /**
   * Returns copy of waiting tickets.
   * @param {string} [format]
   * @returns {Array<Object>}
   */
  getAllTickets(format) {
    if (!format) return [...this.queue];
    const target = format.toUpperCase();
    return this.queue.filter(t => t.format === target);
  }

  /**
   * Clears all tickets in queue.
   */
  clear() {
    this.queue = [];
  }
}

export default MatchmakingQueue;
