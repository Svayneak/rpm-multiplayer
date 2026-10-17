/**
 * Resilient Browser & Node.js WebSocket Client with Gap-Detection Buffer
 * Part of RPM Multiplayer - Feature 8 (Multiplayer WebSocket Relay & Room Synchronization)
 *
 * Specification: SPEC-RPM-RELAY-008
 *
 * Capabilities:
 * - Works in browser (window.WebSocket) and Node.js (globalThis.WebSocket).
 * - Exponential backoff reconnection engine (1s, 2s, 4s, max 10s) with +/-20% jitter.
 * - Out-of-order packet buffer & gap-detection engine (INV-RELAY-2).
 * - Automatic ACTION_REPLAY_REQUEST emission and ACTION_REPLAY_BATCH drain.
 * - Reactive event-driven architecture (EventEmitter).
 * - Zero lingering timers on disconnect() (INV-HARNESS-2).
 *
 * @module RelayClient
 */

import { EventEmitter } from 'node:events';

/**
 * Universal WebSocket Relay Client.
 */
export class RelayClient extends EventEmitter {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.url]
   * @param {number} [options.maxReconnectBackoffMs=10000]
   */
  constructor(options = {}) {
    super();
    this.url = options.url || null;
    this.socket = null;
    this.roomCode = null;
    this.slotId = null;
    this.seatToken = null;
    this.sessionId = null;
    this.lastProcessedSeq = 0;
    this.outOfOrderBuffer = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectBackoffMs = options.maxReconnectBackoffMs || 10000;
    this.reconnectTimer = null;
    this.isExplicitDisconnect = false;
    this.projectedState = null;
    this.activeSlots = [];

    // Internal promise handlers for request-response flows
    this._pendingCreate = null;
    this._pendingJoin = null;
    this._pendingReconnect = null;
    this._pendingConnect = null;
  }

  /**
   * Connects to the WebSocket relay server.
   *
   * @param {string} [url]
   * @returns {Promise<void>}
   */
  async connect(url) {
    if (url) {
      this.url = url;
    }
    if (!this.url) {
      throw new Error('WebSocket URL must be provided');
    }

    if (this.socket && (this.socket.readyState === 1 || this.socket.readyState === 0)) {
      if (this.socket.readyState === 1) return;
      return new Promise((resolve, reject) => {
        this._pendingConnect = { resolve, reject };
      });
    }

    this.isExplicitDisconnect = false;

    return new Promise((resolve, reject) => {
      this._pendingConnect = { resolve, reject };

      try {
        const WebSocketImpl = globalThis.WebSocket;
        if (!WebSocketImpl) {
          throw new Error('No WebSocket implementation found in global scope');
        }

        const ws = new WebSocketImpl(this.url);
        this.socket = ws;

        ws.onopen = () => {
          this.reconnectAttempts = 0;
          if (this._pendingConnect) {
            this._pendingConnect.resolve();
            this._pendingConnect = null;
          }
          this.emit('connected');
        };

        ws.onmessage = (event) => {
          let text = event.data;
          if (typeof text !== 'string') {
            if (Buffer.isBuffer(text)) {
              text = text.toString('utf8');
            } else if (text instanceof ArrayBuffer) {
              text = Buffer.from(text).toString('utf8');
            } else {
              text = String(text);
            }
          }
          this._handleMessage(text);
        };

        ws.onclose = (event) => {
          this._handleClose(event);
        };

        ws.onerror = (err) => {
          if (this._pendingConnect) {
            this._pendingConnect.reject(err);
            this._pendingConnect = null;
          }
          this._emitError(err);
        };
      } catch (err) {
        this._pendingConnect = null;
        reject(err);
      }
    });
  }

  /**
   * Initiates room creation and seating as host (Slot 1).
   *
   * @param {Object} [options={}]
   * @returns {Promise<{ roomCode: string, slotId: number, seatToken: string, sessionId: string }>}
   */
  async createRoom(options = {}) {
    return new Promise((resolve, reject) => {
      this._pendingCreate = { resolve, reject };
      this.send({
        type: 'CREATE_ROOM',
        playerName: options.playerName || 'Host',
        maxPlayers: options.maxPlayers || 4,
        startingLife: options.startingLife || 20,
        alarmDurationSeconds: options.alarmDurationSeconds || 15
      });
    });
  }

  /**
   * Joins an existing room.
   *
   * @param {string} roomCode
   * @param {string} [playerName='Player']
   * @param {number} [seatPreference]
   * @param {boolean} [isSpectator=false]
   * @returns {Promise<Object>} StateReconcileSnapshot
   */
  async joinRoom(roomCode, playerName = 'Player', seatPreference = undefined, isSpectator = false) {
    return new Promise((resolve, reject) => {
      this._pendingJoin = { resolve, reject };
      this.send({
        type: 'JOIN_ROOM',
        roomCode,
        playerName,
        seatPreference,
        isSpectator: Boolean(isSpectator)
      });
    });
  }

  /**
   * Reclaims a slot using a stored cryptographic seat token.
   *
   * @param {string} roomCode
   * @param {string} seatToken
   * @returns {Promise<Object>} StateReconcileSnapshot
   */
  async reconnect(roomCode, seatToken) {
    return new Promise((resolve, reject) => {
      this._pendingReconnect = { resolve, reject };
      this.send({
        type: 'RECONNECT_ROOM',
        roomCode,
        seatToken,
        lastSeenSeq: this.lastProcessedSeq
      });
    });
  }

  /**
   * Submits a state-mutating game action to the authoritative sequencer.
   *
   * @param {Object} action
   */
  sendAction(action = {}) {
    this.send({
      type: 'DISPATCH_ACTION',
      actionId: action.actionId || (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `act_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`),
      actionType: action.actionType || action.type,
      payload: action.payload || {}
    });
  }

  /**
   * Concedes the ongoing match.
   */
  concede() {
    this.send({
      type: 'CONCEDE_MATCH'
    });
  }

  /**
   * Serializes and writes a JSON payload to the active socket.
   *
   * @param {Object} data
   */
  send(data) {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error('Cannot send frame: WebSocket is not open');
    }
    this.socket.send(typeof data === 'string' ? data : JSON.stringify(data));
  }

  /**
   * Safe error emitter that does not throw ERR_UNHANDLED_ERROR if no error listener is attached.
   *
   * @param {Error|any} err
   */
  _emitError(err) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  /**
   * Cleanly closes socket and cancels all reconnection backoff timers (INV-HARNESS-2).
   */
  disconnect() {
    this.isExplicitDisconnect = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      try {
        this.socket.onopen = null;
        this.socket.onmessage = null;
        this.socket.onclose = null;
        this.socket.onerror = null;
        this.socket.close(1000, 'Client disconnected');
      } catch (e) {}
      this.socket = null;
    }
  }

  /**
   * Central message dispatcher.
   *
   * @param {string} rawText
   */
  _handleMessage(rawText) {
    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch (e) {
      this._emitError(new Error(`Failed to parse incoming frame: ${rawText}`));
      return;
    }

    const type = msg.type;

    if (type === 'ROOM_CREATED') {
      this.roomCode = msg.roomCode;
      this.sessionId = msg.sessionId;
      this.slotId = msg.slotId;
      this.seatToken = msg.seatToken;

      if (this._pendingCreate) {
        this._pendingCreate.resolve(msg);
        this._pendingCreate = null;
      }
      return;
    }

    if (type === 'STATE_RECONCILE_SNAPSHOT') {
      this.roomCode = msg.roomCode;
      this.sessionId = msg.sessionId;
      this.slotId = msg.slotId;
      if (msg.seatToken) {
        this.seatToken = msg.seatToken;
      }
      this.lastProcessedSeq = msg.seq || this.lastProcessedSeq;
      this.projectedState = msg.projectedState;
      this.activeSlots = msg.activeSlots || [];
      this.outOfOrderBuffer.clear();

      this.emit('state_sync', msg);

      if (this._pendingJoin) {
        this._pendingJoin.resolve(msg);
        this._pendingJoin = null;
      }
      if (this._pendingReconnect) {
        this._pendingReconnect.resolve(msg);
        this._pendingReconnect = null;
      }
      return;
    }

    if (type === 'ACTION_SEQUENCED') {
      this._handleSequencedAction(msg);
      return;
    }

    if (type === 'ACTION_REPLAY_BATCH') {
      this._handleReplayBatch(msg.actions || []);
      return;
    }

    if (type === 'PLAYER_JOINED') {
      this.emit('player_joined', msg);
      return;
    }

    if (type === 'PLAYER_DISCONNECTED') {
      this.emit('player_disconnected', msg);
      return;
    }

    if (type === 'PLAYER_RECONNECTED') {
      this.emit('player_reconnected', msg);
      return;
    }

    if (type === 'PLAYER_ELIMINATED') {
      this.emit('player_eliminated', msg);
      return;
    }

    if (type === 'MATCH_VICTORY') {
      this.emit('match_victory', msg);
      return;
    }

    if (type === 'ERROR') {
      const err = new Error(msg.message || 'Server error');
      err.code = msg.code;
      err.errorType = msg.errorType;

      if (this._pendingCreate) {
        this._pendingCreate.reject(err);
        this._pendingCreate = null;
      }
      if (this._pendingJoin) {
        this._pendingJoin.reject(err);
        this._pendingJoin = null;
      }
      if (this._pendingReconnect) {
        this._pendingReconnect.reject(err);
        this._pendingReconnect = null;
      }

      this._emitError(err);
      return;
    }
  }

  /**
   * Processes a sequenced action frame through the gap-detection state machine (INV-RELAY-2).
   *
   * @param {Object} action
   */
  _handleSequencedAction(action) {
    const seq = action.seq;

    if (seq <= this.lastProcessedSeq) {
      // Duplicate or old frame; ignore
      return;
    }

    if (seq === this.lastProcessedSeq + 1) {
      this._applyAction(action);
      this.lastProcessedSeq = seq;

      // Drain buffer if consecutive frames are waiting
      while (this.outOfOrderBuffer.has(this.lastProcessedSeq + 1)) {
        const nextAction = this.outOfOrderBuffer.get(this.lastProcessedSeq + 1);
        this.outOfOrderBuffer.delete(this.lastProcessedSeq + 1);
        this._applyAction(nextAction);
        this.lastProcessedSeq++;
      }
    } else {
      // Gap detected! Stash current packet
      this.outOfOrderBuffer.set(seq, action);

      // Request missing span from server
      this.send({
        type: 'ACTION_REPLAY_REQUEST',
        fromSeq: this.lastProcessedSeq + 1,
        toSeq: seq - 1
      });
    }
  }

  /**
   * Applies and emits a sequenced action.
   *
   * @param {Object} action
   */
  _applyAction(action) {
    this.emit('action_sequenced', action);
  }

  /**
   * Drains an ACTION_REPLAY_BATCH and any buffered out-of-order packets.
   *
   * @param {Array<Object>} actions
   */
  _handleReplayBatch(actions) {
    const sorted = [...actions].sort((a, b) => a.seq - b.seq);
    for (const act of sorted) {
      if (act.seq === this.lastProcessedSeq + 1) {
        this._applyAction(act);
        this.lastProcessedSeq = act.seq;
      }
    }

    while (this.outOfOrderBuffer.has(this.lastProcessedSeq + 1)) {
      const nextAction = this.outOfOrderBuffer.get(this.lastProcessedSeq + 1);
      this.outOfOrderBuffer.delete(this.lastProcessedSeq + 1);
      this._applyAction(nextAction);
      this.lastProcessedSeq++;
    }
  }

  /**
   * Handles unexpected socket closure and schedules backoff reconnection.
   *
   * @param {Object} event
   */
  _handleClose(event) {
    if (this._pendingConnect) {
      this._pendingConnect.reject(new Error(`WebSocket closed during connect (code: ${event?.code})`));
      this._pendingConnect = null;
    }

    if (this._pendingReconnect && event?.code === 4401) {
      this._pendingReconnect.reject(new Error('4401 Unauthorized Seat Token'));
      this._pendingReconnect = null;
    }

    if (this.isExplicitDisconnect) return;

    this.emit('disconnected', event);

    // If authorization failed with 4401, do not continue backoff loop
    if (event?.code === 4401) {
      return;
    }

    this._scheduleReconnect();
  }

  /**
   * Schedules next reconnect attempt with exponential backoff & jitter.
   */
  _scheduleReconnect() {
    if (this.isExplicitDisconnect || this.reconnectTimer) return;

    const attempt = this.reconnectAttempts;
    const baseDelay = Math.min(this.maxReconnectBackoffMs, 1000 * Math.pow(2, attempt));
    const jitter = 1 + (Math.random() * 0.4 - 0.2); // +/- 20%
    const delay = Math.round(baseDelay * jitter);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;

      try {
        await this.connect(this.url);
        if (this.roomCode && this.seatToken) {
          await this.reconnect(this.roomCode, this.seatToken);
        }
        this.reconnectAttempts = 0;
      } catch (err) {
        if (!this.isExplicitDisconnect) {
          this._scheduleReconnect();
        }
      }
    }, delay);

    if (this.reconnectTimer && typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }
}

export default RelayClient;
