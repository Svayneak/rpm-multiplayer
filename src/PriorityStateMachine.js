/**
 * PriorityStateMachine - MTG CR 117 Priority & LIFO Stack State Machine
 * 
 * Part of RPM Multiplayer - Feature 4 (Stack & Priority Flow State Machine)
 * Document ID: SPEC-RPM-PRIORITY-004
 * 
 * Coordinates:
 * - Turn phases & steps (CR 500-514)
 * - APNAP priority ordering and passing algorithm
 * - Priority gating and invariant enforcement (PriorityViolationError)
 * - LIFO Stack management (spells & activated abilities)
 * - 15-second Stack Alarm orchestration (StackAlarmManager)
 * - Checkpoint & Rollback Bus (immutable state snapshots)
 * - Observer pattern event emission
 * 
 * @module PriorityStateMachine
 */

import { StackAlarmManager } from './StackAlarmManager.js';

/**
 * Canonical MTG Turn Phases and Steps
 */
export const SEVEN_PHASE_STEPS = Object.freeze([
  'UNTAP',
  'UPKEEP',
  'DRAW',
  'PRECOMBAT_MAIN',
  'COMBAT',
  'POSTCOMBAT_MAIN',
  'END'
]);

export const TWELVE_PHASE_STEPS = Object.freeze([
  'UNTAP',              // CR 502: Untap step (Active player untaps all permanents, no priority)
  'UPKEEP',             // CR 503: Upkeep step (Active player receives priority)
  'DRAW',               // CR 504: Draw step (Active player draws 1 card, receives priority)
  'PRECOMBAT_MAIN',     // CR 505: Pre-combat Main phase (Sorcery speed permitted)
  'BEGIN_COMBAT',       // CR 507: Beginning of combat step
  'DECLARE_ATTACKERS',  // CR 508: Declare attackers step
  'DECLARE_BLOCKERS',   // CR 509: Declare blockers step
  'COMBAT_DAMAGE',      // CR 510: Combat damage step
  'END_COMBAT',         // CR 511: End of combat step
  'POSTCOMBAT_MAIN',    // CR 505: Post-combat Main phase (Sorcery speed permitted)
  'END_STEP',           // CR 513: End of turn step
  'CLEANUP'             // CR 514: Cleanup step (Discard to hand size, damage removed)
]);

export const OVERARCHING_PHASES = Object.freeze({
  MULLIGAN: 'MULLIGAN',
  BEGINNING: 'BEGINNING',
  PRECOMBAT_MAIN: 'PRECOMBAT_MAIN',
  COMBAT: 'COMBAT',
  POSTCOMBAT_MAIN: 'POSTCOMBAT_MAIN',
  ENDING: 'ENDING'
});

/**
 * Maps any subphase step to its MTG CR 500 Overarching Phase.
 * 
 * @param {string} subphase
 * @returns {string} One of OVERARCHING_PHASES
 */
export function getOverarchingPhase(subphase) {
  if (subphase === 'MULLIGAN') return OVERARCHING_PHASES.MULLIGAN;
  if (['UNTAP', 'UPKEEP', 'DRAW'].includes(subphase)) return OVERARCHING_PHASES.BEGINNING;
  if (subphase === 'PRECOMBAT_MAIN' || subphase === 'MAIN_1') return OVERARCHING_PHASES.PRECOMBAT_MAIN;
  if ([
    'COMBAT', 'BEGIN_COMBAT', 'DECLARE_ATTACKERS', 'DECLARE_BLOCKERS', 
    'FIRST_STRIKE_DAMAGE', 'COMBAT_DAMAGE', 'END_COMBAT'
  ].includes(subphase)) return OVERARCHING_PHASES.COMBAT;
  if (subphase === 'POSTCOMBAT_MAIN' || subphase === 'MAIN_2') return OVERARCHING_PHASES.POSTCOMBAT_MAIN;
  if (['END', 'END_STEP', 'CLEANUP'].includes(subphase)) return OVERARCHING_PHASES.ENDING;
  return OVERARCHING_PHASES.PRECOMBAT_MAIN;
}

export const PHASE_STEPS = SEVEN_PHASE_STEPS;

/**
 * Generates an RFC-compliant Stack Item ID
 * Format: `stack_${timestamp}_${hex8}`
 * 
 * @returns {string}
 */
export function generateStackItemId() {
  const timestamp = Date.now();
  const hex = Math.random().toString(36).substring(2, 10);
  return `stack_${timestamp}_${hex}`;
}

/**
 * Generates an RFC-compliant Checkpoint ID
 * Format: `ckpt_${sequenceId}_${hex6}`
 * 
 * @param {number} sequenceId Monotonically increasing sequence number
 * @returns {string}
 */
export function generateCheckpointId(sequenceId) {
  const hex = Math.random().toString(36).substring(2, 8);
  return `ckpt_${sequenceId}_${hex}`;
}

/**
 * Error thrown when a player attempts an action without holding priority,
 * or violates timing restrictions.
 */
export class PriorityViolationError extends Error {
  /**
   * @param {string} message
   * @param {Object} [details={}]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'PriorityViolationError';
    this.details = details;
  }
}

/**
 * Safely extracts pure domain properties from PriorityStateMachine state
 * to avoid circular references during JSON serialization.
 * 
 * @param {Object} state
 * @returns {Object}
 */
function extractDomainState(state) {
  return {
    sessionId: state.sessionId,
    players: [...(state.players || [])],
    activePlayerId: state.activePlayerId,
    priorityPlayerId: state.priorityPlayerId,
    currentPhaseStep: state.currentPhaseStep,
    turnNumber: state.turnNumber,
    consecutivePassCount: state.consecutivePassCount,
    stack: state.stack ? JSON.parse(JSON.stringify(state.stack)) : [],
    isTurnEnded: Boolean(state.isTurnEnded)
  };
}

/**
 * CheckpointJournal manages the in-memory chronological ring buffer of state snapshots.
 */
export class CheckpointJournal {
  /**
   * @param {number} [maxSnapshots=50]
   */
  constructor(maxSnapshots = 50) {
    this.maxSnapshots = maxSnapshots;
    this.snapshots = []; // Ordered array: newest at end
    this.sequenceCounter = 0;
  }

  /**
   * Captures an immutable checkpoint snapshot.
   * 
   * @param {string} triggerAction
   * @param {Object} state
   * @returns {Object} Snapshot
   */
  captureSnapshot(triggerAction, state) {
    this.sequenceCounter++;
    const checkpointId = generateCheckpointId(this.sequenceCounter);
    const domainState = extractDomainState(state);

    const snapshot = {
      checkpointId,
      sequenceId: this.sequenceCounter,
      timestamp: Date.now(),
      triggerAction,
      activePlayerId: state.activePlayerId,
      priorityPlayerId: state.priorityPlayerId,
      currentPhaseStep: state.currentPhaseStep,
      turnNumber: state.turnNumber,
      consecutivePassCount: state.consecutivePassCount,
      stack: domainState.stack,
      serializedState: JSON.stringify(domainState)
    };

    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift(); // Evict oldest
    }

    return snapshot;
  }

  /**
   * Retrieves a checkpoint by its ID.
   * 
   * @param {string} checkpointId
   * @returns {Object|null}
   */
  getSnapshot(checkpointId) {
    return this.snapshots.find(s => s.checkpointId === checkpointId) || null;
  }

  /**
   * Returns list of recent checkpoints (newest first).
   * 
   * @param {number} [count=10]
   * @returns {Object[]}
   */
  getRecentCheckpoints(count = 10) {
    return this.snapshots.slice(-count).reverse();
  }
}

/**
 * PriorityStateMachine coordinates MTG CR 117 turn priority, phases/steps, LIFO stack,
 * response alarms, and rollback journal snapshots.
 */
export class PriorityStateMachine {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.sessionId]
   * @param {string[]} [options.players=['p1', 'p2']]
   * @param {string} [options.activePlayerId]
   * @param {string} [options.priorityPlayerId]
   * @param {string} [options.initialPhaseStep='UNTAP']
   * @param {string} [options.currentPhaseStep]
   * @param {number} [options.turnNumber=1]
   * @param {number} [options.maxCheckpoints=50]
   * @param {boolean} [options.strictTiming=false]
   * @param {StackAlarmManager} [options.alarmManager]
   * @param {CheckpointJournal} [options.checkpointJournal]
   */
  constructor(options = {}) {
    this.sessionId = options.sessionId || `psm_${Date.now()}`;
    this.players = options.players && options.players.length > 0
      ? [...options.players]
      : ['p1', 'p2'];

    this.activePlayerId = options.activePlayerId || this.players[0];
    this.priorityPlayerId = options.priorityPlayerId || this.activePlayerId;
    this.currentPhaseStep = options.initialPhaseStep || options.currentPhaseStep || 'UNTAP';
    this.turnNumber = typeof options.turnNumber === 'number' ? options.turnNumber : 1;
    this.roundNumber = typeof options.roundNumber === 'number' ? options.roundNumber : 1;
    this.startingPlayerId = options.startingPlayerId || this.players[0] || 'p1';
    this.playerTurnCounts = new Map();
    for (const pid of this.players) {
      this.playerTurnCounts.set(pid, pid === this.activePlayerId ? 1 : 0);
    }
    this.phaseSteps = options.phaseSteps
      ? [...options.phaseSteps]
      : (options.use7Steps ? [...SEVEN_PHASE_STEPS] : [...TWELVE_PHASE_STEPS]);

    this.consecutivePassCount = 0;
    this.stack = [];
    this.isTurnEnded = false;
    this.strictTiming = Boolean(options.strictTiming);

    // Event listeners & subscribers
    this._listeners = new Map();
    this._subscribers = new Set();

    // Checkpoint Journal
    this.checkpointJournal = options.checkpointJournal || new CheckpointJournal(options.maxCheckpoints || 50);

    // Stack Alarm Manager integration
    this.alarmManager = options.alarmManager || new StackAlarmManager({
      defaultDurationSeconds: options.defaultDurationSeconds || 15,
      onTimeout: (expiredPlayerId, expiredStackItemId) => {
        // Auto-pass priority when countdown expires
        if (this.priorityPlayerId === expiredPlayerId) {
          this.dispatch('PASS_PRIORITY', { playerId: expiredPlayerId, isTimeout: true });
        }
      },
      onEmit: (alarmEvent) => {
        this.emit(alarmEvent.type, alarmEvent);
      }
    });
  }

  // ==========================================
  // Event & Observer Pattern Methods
  // ==========================================

  /**
   * Registers a specific event type handler.
   * 
   * @param {string} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (typeof handler !== 'function') return;
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(handler);
  }

  /**
   * Removes a specific event type handler.
   * 
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    if (!this._listeners.has(event)) return;
    const list = this._listeners.get(event).filter(fn => fn !== handler);
    this._listeners.set(event, list);
  }

  /**
   * Subscribes an observer callback to all state machine events.
   * 
   * @param {Function} listener
   * @returns {Function} Unsubscribe function
   */
  subscribe(listener) {
    if (typeof listener === 'function') {
      this._subscribers.add(listener);
    }
    return () => {
      this._subscribers.delete(listener);
    };
  }

  /**
   * Dispatches an event to registered listeners and global subscribers.
   * 
   * @param {string} type
   * @param {Object} [payload={}]
   */
  emit(type, payload = {}) {
    const eventObject = {
      type,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      ...payload
    };

    // Specific listeners
    const handlers = this._listeners.get(type);
    if (handlers && handlers.length > 0) {
      for (const fn of handlers) {
        try {
          fn(eventObject);
        } catch (err) {
          console.error(`Error in event listener for ${type}:`, err);
        }
      }
    }

    // Global subscribers
    for (const sub of this._subscribers) {
      try {
        sub(eventObject);
      } catch (err) {
        console.error('Error in PriorityStateMachine subscriber:', err);
      }
    }
  }

  // ==========================================
  // APNAP Priority & Validation Helpers
  // ==========================================

  /**
   * Computes the next player in clockwise turn order.
   * 
   * @param {string} playerId
   * @returns {string} Next player ID
   */
  nextPlayer(playerId) {
    const currentIndex = this.players.indexOf(playerId);
    if (currentIndex === -1) {
      return this.players[0];
    }
    return this.players[(currentIndex + 1) % this.players.length];
  }

  /**
   * Asserts that the specified player currently holds priority.
   * Throws PriorityViolationError if the player does not hold priority.
   * 
   * @param {string} playerId
   * @throws {PriorityViolationError}
   */
  assertHasPriority(playerId) {
    if (this.priorityPlayerId !== playerId) {
      throw new PriorityViolationError(
        `Player '${playerId}' does not hold priority. Current priority holder is '${this.priorityPlayerId}'.`,
        { playerId, priorityPlayerId: this.priorityPlayerId }
      );
    }
  }

  /**
   * Validates whether an action is permissible given priority and timing restrictions.
   * 
   * @param {string} playerId
   * @param {string} actionType
   * @param {Object} [details={}]
   * @throws {PriorityViolationError}
   */
  validateAction(playerId, actionType, details = {}) {
    this.assertHasPriority(playerId);

    const isSorcerySpeed =
      actionType === 'SORCERY_SPEED' ||
      (this.strictTiming &&
        (details.speed === 'SORCERY' ||
          details.typeLine?.includes('Sorcery') ||
          details.typeLine?.includes('Creature') ||
          details.typeLine?.includes('Artifact') ||
          details.typeLine?.includes('Enchantment') ||
          details.typeLine?.includes('Planeswalker')));

    if (isSorcerySpeed) {
      if (!['PRECOMBAT_MAIN', 'POSTCOMBAT_MAIN'].includes(this.currentPhaseStep)) {
        throw new PriorityViolationError(
          `Sorcery speed actions are only permitted during Main phases (current: ${this.currentPhaseStep}).`,
          { playerId, currentPhaseStep: this.currentPhaseStep }
        );
      }
      if (this.stack.length > 0) {
        throw new PriorityViolationError(
          'Sorcery speed actions require an empty stack.',
          { playerId, stackLength: this.stack.length }
        );
      }
      if (this.activePlayerId !== playerId) {
        throw new PriorityViolationError(
          `Only the active player ('${this.activePlayerId}') may perform sorcery speed actions.`,
          { playerId, activePlayerId: this.activePlayerId }
        );
      }
    }
  }

  /**
   * Returns the player ID currently holding priority.
   * @returns {string}
   */
  getPriorityPlayerId() {
    return this.priorityPlayerId;
  }

  /**
   * Returns the current consecutive pass count.
   * @returns {number}
   */
  getConsecutivePassCount() {
    return this.consecutivePassCount;
  }

  /**
   * Returns the current depth/size of the stack.
   * @returns {number}
   */
  getStackDepth() {
    return this.stack.length;
  }

  // ==========================================
  // LIFO Stack Methods
  // ==========================================

  /**
   * Pushes an item onto the top of the stack.
   * Enforces INV-PRIORITY-AUTO-1: preserves controller metadata and rotates
   * priority immediately to next opponent per APNAP CR 117.3b.
   * 
   * @param {Object} item
   * @returns {Object} Pushed item
   */
  pushStack(item) {
    if (item) {
      item.controllerId = item.controllerId || item.sourcePlayerId || this.activePlayerId;
      item.sourcePlayerId = item.sourcePlayerId || item.controllerId;
      item.cardName = item.cardName || item.name || item.card?.name || 'Spell';
      item.name = item.name || item.cardName;
      item.controllerName = item.controllerName || item.playerName || item.sourcePlayerName || (item.controllerId?.toLowerCase().includes('perkins') ? 'Perkins AI (Bot)' : item.controllerId);

      const casterId = item.sourcePlayerId || item.controllerId || this.activePlayerId;
      const nextPriorityPlayerId = this.nextPlayer(casterId);
      this.priorityPlayerId = nextPriorityPlayerId;
      this.consecutivePassCount = 0;

      this.emit('SPELL_CAST_PRIORITY_ROTATED', {
        nextPriorityPlayerId,
        casterId,
        spellName: item.cardName,
        controllerName: item.controllerName
      });
    }
    this.stack.push(item);
    return item;
  }

  /**
   * Pops and returns the top item from the stack.
   * 
   * @returns {Object|null} Popped item or null if stack was empty
   */
  popStack() {
    if (this.stack.length === 0) return null;
    return this.stack.pop();
  }

  /**
   * Returns the top item on the stack without removing it.
   * 
   * @returns {Object|null} Top item or null if stack is empty
   */
  peekStack() {
    if (this.stack.length === 0) return null;
    return this.stack[this.stack.length - 1];
  }

  /**
   * Clears all items from the stack.
   */
  clearStack() {
    this.stack = [];
  }

  // ==========================================
  // Phase / Step Progression Methods
  // ==========================================

  /**
   * Sets the phase step directly (useful for tests and setup).
   * 
   * @param {string} step
   */
  setPhaseStep(step) {
    if (!this.phaseSteps.includes(step)) {
      if (TWELVE_PHASE_STEPS.includes(step)) {
        this.phaseSteps = [...TWELVE_PHASE_STEPS];
      } else if (SEVEN_PHASE_STEPS.includes(step)) {
        this.phaseSteps = [...SEVEN_PHASE_STEPS];
      } else {
        throw new Error(`Invalid phase/step: ${step}`);
      }
    }
    const previousStep = this.currentPhaseStep;
    this.currentPhaseStep = step;
    this.priorityPlayerId = this.activePlayerId;
    this.consecutivePassCount = 0;

    this.emit('PHASE_STEP_CHANGED', {
      previousStep,
      currentPhaseStep: this.currentPhaseStep,
      overarchingPhase: getOverarchingPhase(this.currentPhaseStep),
      roundNumber: this.roundNumber,
      playerTurnNumber: this.playerTurnCounts.get(this.activePlayerId) || 1,
      turnNumber: this.turnNumber,
      activePlayerId: this.activePlayerId,
      priorityPlayerId: this.priorityPlayerId
    });

    // Specific Step Invariant Hooks
    if (this.currentPhaseStep === 'UNTAP') {
      this.emit('UNTAP_STEP_ENTERED', {
        activePlayerId: this.activePlayerId,
        turnNumber: this.turnNumber
      });
    } else if (this.currentPhaseStep === 'UPKEEP') {
      this.emit('UPKEEP_STEP_ENTERED', {
        activePlayerId: this.activePlayerId,
        turnNumber: this.turnNumber
      });
    } else if (this.currentPhaseStep === 'CLEANUP') {
      this.emit('CLEANUP_STEP_ENTERED', {
        activePlayerId: this.activePlayerId,
        turnNumber: this.turnNumber
      });
    }

    this._evaluateDrawStep();
  }

  /**
   * Advances to the next phase/step according to MTG CR 500-514.
   * If advancing past the final step, hands turn over to next active player.
   * 
   * @returns {string} New phase step
   */
  advanceStep() {
    const currentIndex = this.phaseSteps.indexOf(this.currentPhaseStep);
    if (currentIndex === -1) {
      throw new Error(`Unknown phase/step: ${this.currentPhaseStep}`);
    }

    // Capture checkpoint snapshot before phase advance
    this.checkpointJournal.captureSnapshot(`BEFORE_PHASE_ADVANCE_${this.currentPhaseStep}`, this);

    const previousStep = this.currentPhaseStep;
    const nextIndex = currentIndex + 1;

    if (nextIndex >= this.phaseSteps.length) {
      // Turn ends -> Advance to next player's UNTAP step
      const previousPlayerId = this.activePlayerId;
      const nextPlayerId = this.nextPlayer(this.activePlayerId);
      this.activePlayerId = nextPlayerId;
      this.currentPhaseStep = this.phaseSteps[0]; // 'UNTAP'
      this.priorityPlayerId = this.activePlayerId;
      this.consecutivePassCount = 0;
      this.turnNumber++;

      const nextTurnCount = (this.playerTurnCounts.get(nextPlayerId) || 0) + 1;
      this.playerTurnCounts.set(nextPlayerId, nextTurnCount);

      if (nextPlayerId === this.startingPlayerId) {
        this.roundNumber++;
      }

      this.emit('TURN_ROTATED', {
        roundNumber: this.roundNumber,
        activePlayerId: nextPlayerId,
        playerTurnCount: nextTurnCount,
        previousPlayerId
      });

      this.emit('TURN_ADVANCED', {
        turnNumber: this.turnNumber,
        roundNumber: this.roundNumber,
        activePlayerId: this.activePlayerId,
        playerTurnCount: nextTurnCount
      });
    } else {
      this.currentPhaseStep = this.phaseSteps[nextIndex];
      this.priorityPlayerId = this.activePlayerId;
      this.consecutivePassCount = 0;
    }

    this.emit('PHASE_STEP_CHANGED', {
      previousStep,
      currentPhaseStep: this.currentPhaseStep,
      overarchingPhase: getOverarchingPhase(this.currentPhaseStep),
      roundNumber: this.roundNumber,
      playerTurnNumber: this.playerTurnCounts.get(this.activePlayerId) || 1,
      turnNumber: this.turnNumber,
      activePlayerId: this.activePlayerId,
      priorityPlayerId: this.priorityPlayerId
    });

    // Specific Step Invariant Hooks
    if (this.currentPhaseStep === 'UNTAP') {
      this.emit('UNTAP_STEP_ENTERED', {
        activePlayerId: this.activePlayerId,
        turnNumber: this.turnNumber
      });
    } else if (this.currentPhaseStep === 'UPKEEP') {
      this.emit('UPKEEP_STEP_ENTERED', {
        activePlayerId: this.activePlayerId,
        turnNumber: this.turnNumber
      });
    } else if (this.currentPhaseStep === 'CLEANUP') {
      this.emit('CLEANUP_STEP_ENTERED', {
        activePlayerId: this.activePlayerId,
        turnNumber: this.turnNumber
      });
    }

    this._evaluateDrawStep();

    return this.currentPhaseStep;
  }

  /**
   * Enforces MTG CR 103.7a & CR 504.1 Draw Step rules (INV-DRAW-1).
   * @private
   */
  _evaluateDrawStep() {
    if (this.currentPhaseStep === 'DRAW') {
      const is1v1 = (this.players.length === 2);
      const isFirstTurnOfStartingPlayer = (this.roundNumber === 1 && this.activePlayerId === this.startingPlayerId);
      const shouldSkipDraw = is1v1 && isFirstTurnOfStartingPlayer;

      if (shouldSkipDraw) {
        this.emit('DRAW_STEP_SKIPPED', {
          activePlayerId: this.activePlayerId,
          roundNumber: this.roundNumber,
          rule: 'CR 103.7a: Starting player in 1v1 skips first turn draw step'
        });
      } else {
        this.emit('MANDATORY_DRAW_TRIGGERED', {
          activePlayerId: this.activePlayerId,
          roundNumber: this.roundNumber,
          rule: 'CR 504.1: Normal turn draw'
        });
      }

      this.emit('DRAW_STEP', {
        activePlayerId: this.activePlayerId,
        roundNumber: this.roundNumber,
        shouldSkipDraw,
        reason: shouldSkipDraw
          ? 'CR 103.7a: Starting player in 1v1 skips first turn draw step'
          : 'CR 504.1: Normal turn draw'
      });
    }
  }

  /**
   * 1-Tap shortcut to advance to next phase if priority is held and stack is empty.
   * 
   * @param {string} [playerId]
   * @returns {string} New phase step
   */
  nextPhase(playerId) {
    if (playerId && this.activePlayerId !== playerId) {
      throw new PriorityViolationError(`Only active player '${this.activePlayerId}' may advance phase.`);
    }
    if (this.stack.length > 0) {
      throw new PriorityViolationError('Cannot advance phase while stack is not empty.');
    }
    if (this.currentPhaseStep === 'PRECOMBAT_MAIN') {
      this.setPhaseStep('COMBAT');
      return this.currentPhaseStep;
    }
    return this.advanceStep();
  }

  /**
   * Alias for advanceStep()
   */
  advancePhaseStep() {
    return this.advanceStep();
  }

  /**
   * Returns turn summary: roundNumber and playerTurnCount.
   * 
   * @param {string} [playerId]
   * @returns {{ roundNumber: number, playerTurnCount: number, activePlayerId: string }}
   */
  getTurnSummary(playerId = this.activePlayerId) {
    return {
      roundNumber: this.roundNumber,
      playerTurnCount: this.getPlayerTurnCount(playerId),
      activePlayerId: this.activePlayerId
    };
  }

  /**
   * Returns current overarching phase according to MTG CR 500.1.
   * 
   * @param {string} [subphase]
   * @returns {string} One of OVERARCHING_PHASES
   */
  getOverarchingPhase(subphase = this.currentPhaseStep) {
    return getOverarchingPhase(subphase);
  }

  /**
   * Returns structured information about current phase and subphase.
   * 
   * @returns {Object}
   */
  getCurrentPhaseInfo() {
    const overarching = this.getOverarchingPhase();
    return {
      overarchingPhase: overarching,
      currentPhaseStep: this.currentPhaseStep,
      isMain: overarching === OVERARCHING_PHASES.PRECOMBAT_MAIN || overarching === OVERARCHING_PHASES.POSTCOMBAT_MAIN,
      isCombat: overarching === OVERARCHING_PHASES.COMBAT,
      isBeginning: overarching === OVERARCHING_PHASES.BEGINNING,
      isEnding: overarching === OVERARCHING_PHASES.ENDING,
      turnNumber: this.turnNumber,
      roundNumber: this.roundNumber,
      activePlayerId: this.activePlayerId
    };
  }

  /**
   * Initializes Pre-Game London Mulligan Phase (CR 103).
   */
  startMulliganPhase() {
    this.currentPhaseStep = 'MULLIGAN';
    this.emit('MULLIGAN_PHASE_STARTED', {
      players: [...this.players],
      activePlayerId: this.activePlayerId
    });
    return this.currentPhaseStep;
  }

  /**
   * Concludes Mulligan Phase and initiates Turn 1 UNTAP step.
   */
  completeMulliganPhase() {
    this.currentPhaseStep = this.phaseSteps[0] || 'UNTAP';
    this.priorityPlayerId = this.activePlayerId;
    this.emit('MULLIGAN_PHASE_COMPLETED', {
      startingPlayerId: this.startingPlayerId,
      currentPhaseStep: this.currentPhaseStep
    });
    this.emit('PHASE_STEP_CHANGED', {
      previousStep: 'MULLIGAN',
      currentPhaseStep: this.currentPhaseStep,
      overarchingPhase: this.getOverarchingPhase(),
      activePlayerId: this.activePlayerId,
      turnNumber: this.turnNumber
    });
    return this.currentPhaseStep;
  }

  /**
   * Inserts FIRST_STRIKE_DAMAGE combat step if first strike combatants exist.
   */
  enableFirstStrikeStep() {
    if (!this.phaseSteps.includes('FIRST_STRIKE_DAMAGE')) {
      const idx = this.phaseSteps.indexOf('COMBAT_DAMAGE');
      if (idx !== -1) {
        this.phaseSteps.splice(idx, 0, 'FIRST_STRIKE_DAMAGE');
      }
    }
  }

  /**
   * Returns current player turn count (T_player).
   * 
   * @param {string} [playerId]
   * @returns {number}
   */
  getPlayerTurnCount(playerId = this.activePlayerId) {
    const count = this.playerTurnCounts.get(playerId);
    return (count === undefined || count === 0) ? 1 : count;
  }

  // ==========================================
  // Checkpoint & Rollback Bus
  // ==========================================

  /**
   * Creates an on-demand immutable checkpoint snapshot.
   * 
   * @param {string} [label='USER_CHECKPOINT']
   * @returns {Object} Snapshot
   */
  createCheckpoint(label = 'USER_CHECKPOINT') {
    const snapshot = this.checkpointJournal.captureSnapshot(label, this);
    this.emit('CHECKPOINT_CAPTURED', {
      checkpointId: snapshot.checkpointId,
      triggerAction: label
    });
    return snapshot;
  }

  /**
   * Rolls back the game state to an exact historical checkpoint.
   * 
   * @param {string} checkpointId
   * @returns {Object} Restored snapshot
   */
  rollbackToCheckpoint(checkpointId) {
    const snapshot = this.checkpointJournal.getSnapshot(checkpointId);
    if (!snapshot) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    // Cancel any active countdown timers
    if (this.alarmManager) {
      this.alarmManager.cancel();
    }

    // Restore state from snapshot
    this.activePlayerId = snapshot.activePlayerId;
    this.priorityPlayerId = snapshot.priorityPlayerId;
    this.currentPhaseStep = snapshot.currentPhaseStep;
    this.turnNumber = snapshot.turnNumber;
    this.consecutivePassCount = snapshot.consecutivePassCount;
    this.stack = JSON.parse(JSON.stringify(snapshot.stack));

    this.emit('CHECKPOINT_RESTORED', {
      checkpointId: snapshot.checkpointId,
      restoredToTrigger: snapshot.triggerAction,
      activePlayerId: this.activePlayerId,
      priorityPlayerId: this.priorityPlayerId,
      stackSize: this.stack.length
    });

    return snapshot;
  }

  // ==========================================
  // Stack Resolution
  // ==========================================

  /**
   * Resolves the top item of the stack and restores priority to active player.
   * 
   * @returns {Object|null} Resolved item
   */
  resolveTop() {
    if (this.stack.length === 0) {
      return null;
    }

    this.checkpointJournal.captureSnapshot('BEFORE_STACK_RESOLVE', this);

    const resolvedItem = this.popStack();
    this.consecutivePassCount = 0;
    this.priorityPlayerId = this.activePlayerId;

    if (this.alarmManager) {
      this.alarmManager.cancel();
    }

    const card = resolvedItem.card || resolvedItem;
    const controllerId = resolvedItem.sourcePlayerId || resolvedItem.controllerId || card.controllerId || card.ownerId || this.activePlayerId;

    if (this.tabletopState && typeof this.tabletopState.handleStackResolution === 'function') {
      try {
        this.tabletopState.handleStackResolution(resolvedItem);
      } catch (err) {
        console.warn('Error in tabletopState.handleStackResolution:', err);
      }
    }

    this.emit('STACK_RESOLVE', {
      resolvedItem,
      card,
      controllerId,
      remainingStackSize: this.stack.length
    });

    this.emit('PRIORITY_CHANGED', {
      activePlayerId: this.activePlayerId,
      priorityPlayerId: this.priorityPlayerId,
      currentPhaseStep: this.currentPhaseStep,
      consecutivePassCount: this.consecutivePassCount
    });

    return resolvedItem;
  }

  // ==========================================
  // Command Dispatcher
  // ==========================================

  /**
   * Dispatches inbound actions and mutates priority/stack/phase state.
   * 
   * @param {string} actionType
   * @param {Object} [payload={}]
   * @returns {any} Result of action
   */
  dispatch(actionType, payload = {}) {
    switch (actionType) {
      case 'CAST_SPELL':
      case 'CAST_SPELL_TO_STACK': {
        const playerId = payload.playerId;
        this.validateAction(playerId, actionType, payload.card || {});

        // Capture snapshot before stack mutation
        this.checkpointJournal.captureSnapshot('CAST_SPELL', this);

        const cardObj = payload.card || {};
        const cardName = payload.cardName || payload.name || cardObj.name || 'Spell';
        const controllerId = payload.controllerId || playerId;
        const controllerName = payload.controllerName || (controllerId?.toLowerCase().includes('perkins') ? 'Perkins AI (Bot)' : controllerId);

        const stackItem = {
          id: payload.id || generateStackItemId(),
          sourcePlayerId: playerId,
          controllerId,
          controllerName,
          card: cardObj,
          cardName,
          name: cardName,
          type: payload.type || 'SPELL',
          targets: payload.targets || [],
          manaCostPaid: payload.manaCostPaid || {},
          timestamp: Date.now()
        };

        this.pushStack(stackItem);
        this.consecutivePassCount = 0;

        // Turn priority passes to the next player
        this.priorityPlayerId = this.nextPlayer(playerId);

        // Start 15-second response alarm for the opponent receiving priority
        if (this.alarmManager) {
          this.alarmManager.start(
            this.priorityPlayerId,
            stackItem.id,
            payload.durationSeconds || 15
          );
        }

        this.emit('STACK_PUSH', {
          stackItem,
          stackSize: this.stack.length
        });

        this.emit('PRIORITY_CHANGED', {
          activePlayerId: this.activePlayerId,
          priorityPlayerId: this.priorityPlayerId,
          currentPhaseStep: this.currentPhaseStep,
          consecutivePassCount: this.consecutivePassCount
        });

        return stackItem;
      }

      case 'ACTIVATE_ABILITY':
      case 'ACTIVATE_ABILITY_TO_STACK': {
        const playerId = payload.playerId;
        this.validateAction(playerId, actionType, payload);

        this.checkpointJournal.captureSnapshot('ACTIVATE_ABILITY', this);

        const stackItem = {
          id: payload.id || generateStackItemId(),
          sourcePlayerId: playerId,
          card: payload.card || {},
          type: 'ABILITY',
          ability: payload.ability || {},
          targets: payload.targets || [],
          manaCostPaid: payload.manaCostPaid || {},
          timestamp: Date.now()
        };

        this.pushStack(stackItem);
        this.consecutivePassCount = 0;
        this.priorityPlayerId = this.nextPlayer(playerId);

        if (this.alarmManager) {
          this.alarmManager.start(
            this.priorityPlayerId,
            stackItem.id,
            payload.durationSeconds || 15
          );
        }

        this.emit('STACK_PUSH', {
          stackItem,
          stackSize: this.stack.length
        });

        this.emit('PRIORITY_CHANGED', {
          activePlayerId: this.activePlayerId,
          priorityPlayerId: this.priorityPlayerId,
          currentPhaseStep: this.currentPhaseStep,
          consecutivePassCount: this.consecutivePassCount
        });

        return stackItem;
      }

      case 'PASS_PRIORITY': {
        const playerId = payload.playerId;
        this.assertHasPriority(playerId);

        this.consecutivePassCount++;

        // Clear active response alarm
        if (this.alarmManager) {
          this.alarmManager.cancel();
        }

        if (this.stack.length > 0) {
          // Check resolution conditions:
          // 1. All players in match passed consecutively (CR 117.4)
          // 2. In a 2-player match with a freshly cast spell where the active player
          //    cast on empty stack and opponent yields/passes/times-out without responding.
          const allPlayersPassed = this.consecutivePassCount >= this.players.length;
          const opponentYieldedOnSingleSpell =
            this.stack.length === 1 &&
            this.players.length === 2 &&
            this.stack[0].sourcePlayerId === this.activePlayerId &&
            playerId !== this.activePlayerId;

          if (allPlayersPassed || opponentYieldedOnSingleSpell) {
            return this.resolveTop();
          } else {
            // Priority rotates to next player in turn order
            this.priorityPlayerId = this.nextPlayer(this.priorityPlayerId);

            if (this.alarmManager && this.peekStack()) {
              this.alarmManager.start(this.priorityPlayerId, this.peekStack().id);
            }

            this.emit('PRIORITY_CHANGED', {
              activePlayerId: this.activePlayerId,
              priorityPlayerId: this.priorityPlayerId,
              currentPhaseStep: this.currentPhaseStep,
              consecutivePassCount: this.consecutivePassCount
            });

            return { status: 'PRIORITY_PASSED', priorityPlayerId: this.priorityPlayerId };
          }
        } else {
          // Empty stack: advance phase/step when all players pass consecutively
          if (this.consecutivePassCount >= this.players.length) {
            this.advanceStep();
            return { status: 'PHASE_ADVANCED', currentPhaseStep: this.currentPhaseStep };
          } else {
            this.priorityPlayerId = this.nextPlayer(this.priorityPlayerId);

            this.emit('PRIORITY_CHANGED', {
              activePlayerId: this.activePlayerId,
              priorityPlayerId: this.priorityPlayerId,
              currentPhaseStep: this.currentPhaseStep,
              consecutivePassCount: this.consecutivePassCount
            });

            return { status: 'PRIORITY_PASSED', priorityPlayerId: this.priorityPlayerId };
          }
        }
      }

      case 'HOLD_RESPOND': {
        const playerId = payload.playerId;
        this.assertHasPriority(playerId);

        if (this.alarmManager) {
          this.alarmManager.hold(playerId);
        }

        this.emit('STACK_ALARM_HELD', {
          heldByPlayerId: playerId,
          priorityPlayerId: this.priorityPlayerId,
          stackItemId: this.peekStack()?.id || null
        });

        return { status: 'HELD', heldByPlayerId: playerId };
      }

      case 'RESOLVE_TOP': {
        return this.resolveTop();
      }

      case 'NEXT_PHASE':
      case 'ADVANCE_PHASE_STEP': {
        return this.advanceStep();
      }

      case 'ROLLBACK_TO_CHECKPOINT': {
        return this.rollbackToCheckpoint(payload.checkpointId);
      }

      default:
        throw new Error(`Unsupported actionType: ${actionType}`);
    }
  }

  /**
   * Dispatches spell casting with automatic priority pass per CR 117.3b.
   * 
   * @param {string} playerId
   * @param {Object} card
   * @param {Object} [options={}]
   * @returns {Object} StackItem
   */
  castSpell(playerId, card, options = {}) {
    return this.dispatch('CAST_SPELL', { playerId, card, ...options });
  }

  /**
   * Returns a serializable snapshot of the current state machine state.
   * 
   * @returns {Object}
   */
  getState() {
    return extractDomainState(this);
  }
}

export default PriorityStateMachine;
