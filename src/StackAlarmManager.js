/**
 * StackAlarmManager - 15-Second Response Countdown Timer Engine
 * 
 * Part of RPM Multiplayer - Feature 4 (Stack & Priority Flow State Machine)
 * Document ID: SPEC-RPM-PRIORITY-004
 * 
 * Provides deterministic, non-blocking countdown timer windows for opponent responses
 * when spells/abilities are placed onto the stack. Supports pausing/holding (HOLD_RESPOND)
 * and auto-pass on timeout.
 * 
 * @module StackAlarmManager
 */

/**
 * @typedef {'IDLE' | 'RUNNING' | 'HELD' | 'EXPIRED' | 'CANCELLED'} StackAlarmStatus
 */

/**
 * Coordinates the 15-second response countdown timer.
 */
export class StackAlarmManager {
  /**
   * @param {Object} [options={}]
   * @param {number} [options.defaultDurationSeconds=15] Default countdown duration in seconds
   * @param {Function} [options.onTimeout] Callback invoked on timer expiry (targetPlayerId, stackItemId)
   * @param {Function} [options.onEmit] Callback invoked on alarm lifecycle events
   * @param {Function} [options.onPass] Callback invoked on explicit alarm pass
   */
  constructor(options = {}) {
    this.defaultDurationSeconds = options.defaultDurationSeconds || 15;
    this.onTimeout = options.onTimeout || (() => {});
    this.onEmit = options.onEmit || (() => {});
    this.onPass = options.onPass || (() => {});

    this.timer = null;
    this.tickInterval = null;
    this.status = 'IDLE'; // 'IDLE' | 'RUNNING' | 'HELD' | 'EXPIRED' | 'CANCELLED'
    this.durationSeconds = this.defaultDurationSeconds;
    this.remainingMs = 0;
    this.targetPlayerId = null;
    this.stackItemId = null;
    this.heldByPlayerId = null;
    this.startTime = null;
    this.endTime = null;
  }

  /**
   * Initiates a countdown for targetPlayerId responding to a stack item.
   * 
   * @param {string} targetPlayerId Player under the timer
   * @param {string} stackItemId Stack item triggering the countdown
   * @param {number} [durationSeconds=this.defaultDurationSeconds]
   */
  start(targetPlayerId, stackItemId, durationSeconds = this.defaultDurationSeconds) {
    this.cancel(); // Clear any existing active timer

    this.status = 'RUNNING';
    this.durationSeconds = durationSeconds;
    this.remainingMs = durationSeconds * 1000;
    this.targetPlayerId = targetPlayerId;
    this.stackItemId = stackItemId;
    this.heldByPlayerId = null;
    this.startTime = Date.now();
    this.endTime = this.startTime + this.remainingMs;

    this.onEmit({
      type: 'STACK_ALARM_START',
      duration: this.durationSeconds,
      remainingMs: this.remainingMs,
      targetPlayerId: this.targetPlayerId,
      stackItemId: this.stackItemId
    });

    this.timer = setTimeout(() => {
      this._handleExpiry();
    }, this.remainingMs);

    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Alias for start()
   */
  startAlarm(targetPlayerId, stackItemId, durationSeconds) {
    return this.start(targetPlayerId, stackItemId, durationSeconds);
  }

  /**
   * Pauses the timer and enters HELD state (HOLD_RESPOND).
   * 
   * @param {string} playerId
   * @returns {boolean} True if successfully held
   */
  hold(playerId) {
    if (this.status !== 'RUNNING') {
      return false;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    const elapsed = Date.now() - (this.startTime || Date.now());
    this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    this.status = 'HELD';
    this.heldByPlayerId = playerId;

    this.onEmit({
      type: 'STACK_ALARM_HELD',
      heldByPlayerId: playerId,
      remainingMs: this.remainingMs,
      stackItemId: this.stackItemId
    });

    return true;
  }

  /**
   * Alias for hold()
   */
  holdAlarm(playerId) {
    return this.hold(playerId);
  }

  /**
   * Explicitly passes priority and clears the alarm.
   * 
   * @param {string} playerId
   * @returns {boolean}
   */
  passAlarm(playerId) {
    if (this.status === 'RUNNING' || this.status === 'HELD') {
      this.cancel();
      this.onPass(playerId);
      return true;
    }
    return false;
  }

  /**
   * Cancels the active alarm.
   */
  cancel() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    const previousStackItemId = this.stackItemId;
    if (this.status !== 'IDLE' && this.status !== 'EXPIRED') {
      this.status = 'CANCELLED';
      this.onEmit({
        type: 'STACK_ALARM_CANCELLED',
        stackItemId: previousStackItemId
      });
    }

    this.status = 'IDLE';
    this.targetPlayerId = null;
    this.stackItemId = null;
    this.heldByPlayerId = null;
    this.startTime = null;
    this.endTime = null;
  }

  /**
   * Alias for cancel()
   */
  cancelAlarm() {
    return this.cancel();
  }

  /**
   * Internal timeout handler invoked when countdown expires.
   * Emits STACK_ALARM_EXPIRED and invokes onTimeout callback.
   * 
   * @private
   */
  _handleExpiry() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    this.status = 'EXPIRED';
    const expiredPlayerId = this.targetPlayerId;
    const expiredStackItemId = this.stackItemId;

    this.onEmit({
      type: 'STACK_ALARM_EXPIRED',
      targetPlayerId: expiredPlayerId,
      stackItemId: expiredStackItemId
    });

    this.onTimeout(expiredPlayerId, expiredStackItemId);
    this.status = 'IDLE';
    this.targetPlayerId = null;
    this.stackItemId = null;
    this.heldByPlayerId = null;
  }

  /**
   * Returns current snapshot of alarm manager state.
   * 
   * @returns {Object}
   */
  getState() {
    return {
      status: this.status,
      durationSeconds: this.durationSeconds,
      remainingMs: this.remainingMs,
      targetPlayerId: this.targetPlayerId,
      stackItemId: this.stackItemId,
      heldByPlayerId: this.heldByPlayerId,
      startTime: this.startTime,
      endTime: this.endTime
    };
  }
}

export default StackAlarmManager;
