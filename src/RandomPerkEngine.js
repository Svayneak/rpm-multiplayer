/**
 * RPM Multiplayer - Random Perk Upkeep Engine & Two-Step Stack Flow
 * Stateful lifecycle, Upkeep Emblem controller, and PriorityStateMachine coordinator.
 * 
 * Specification: SPEC-RPM-PERK-009
 * @module RandomPerkEngine
 */

import { EventEmitter } from './EventEmitter.js';
import { generateStackItemId } from './PriorityStateMachine.js';
import PerkCatalog, {
  getPerkDefinition,
  resolveRoll,
  hasLegalTargets,
  getLegalTargets,
  executePerkEffect
} from './PerkCatalog.js';

/**
 * Executes a server-authoritative 2xd10 roll.
 * Violet Die (tens digit) + Aquamarine Die (ones digit).
 * 
 * @param {Function|null} [prng=null] Deterministic PRNG injection for testing
 * @returns {{ tens: number, ones: number, rollString: string }}
 */
export function executeAuthoritativeRoll(prng = null) {
  let tens, ones;
  if (typeof prng === 'function') {
    tens = prng(0, 9);
    ones = prng(0, 9);
  } else if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const buf = new Uint32Array(2);
    globalThis.crypto.getRandomValues(buf);
    tens = buf[0] % 10;
    ones = buf[1] % 10;
  } else {
    tens = Math.floor(Math.random() * 10);
    ones = Math.floor(Math.random() * 10);
  }
  const rollString = `${tens}${ones}`;
  return { tens, ones, rollString };
}

/**
 * Stateful coordinator of the Random Perk Upkeep Emblem and Two-Step Stack Flow.
 */
export class RandomPerkEngine extends EventEmitter {
  /**
   * @param {Object} [options={}]
   * @param {TabletopStateManager} [options.tabletopState]
   * @param {TabletopStateManager} [options.stateManager]
   * @param {PriorityStateMachine} [options.priorityStateMachine]
   * @param {PriorityStateMachine} [options.priorityMachine]
   * @param {StackAlarmManager} [options.stackAlarmManager]
   * @param {StackAlarmManager} [options.alarmManager]
   * @param {number} [options.initialPlayerCount]
   * @param {Object} [options.birthdayMap]
   * @param {Function} [options.prng]
   * @param {Function} [options.prngFn]
   * @param {number} [options.alarmDurationSeconds=15]
   */
  constructor(options = {}) {
    super();

    this.sessionId = options.sessionId || `rpe_${Date.now()}`;
    this.tabletopState = options.tabletopState || options.stateManager || null;
    this.stateManager = this.tabletopState;

    this.priorityStateMachine = options.priorityStateMachine || options.priorityMachine || null;
    this.priorityMachine = this.priorityStateMachine;

    this.stackAlarmManager = options.stackAlarmManager || options.alarmManager || this.priorityStateMachine?.alarmManager || null;
    this.alarmManager = this.stackAlarmManager;

    // Invariant INV-PERK-4: Turn Unlock Scaling Anchor
    // T_unlock = 2 if N_initial >= 3, else 4.
    // Immutable threshold permanently anchored at room creation.
    const calculatedPlayerCount = options.initialPlayerCount !== undefined
      ? options.initialPlayerCount
      : (
          this.priorityStateMachine?.players?.length ||
          Object.keys(this.tabletopState?.players || {}).length ||
          2
        );

    this.initialPlayerCount = calculatedPlayerCount;
    this.perkUnlockTurn = (this.initialPlayerCount >= 3) ? 2 : 4;

    this.birthdayMap = options.birthdayMap || {};
    this.prng = options.prng || options.prngFn || null;
    this.alarmDurationSeconds = options.alarmDurationSeconds || 15;

    this.isEmblemActive = false;
    this.emblem = null;
    this.currentStep = 'IDLE'; // 'IDLE' | 'STEP_1' | 'STEP_2'
    this.activeStep1Item = null;
    this.activeStep2Item = null;
    this.lastRollResult = null;

    // Bound listeners for clean teardown
    this._boundPhaseStepChanged = this.onPhaseStepChanged.bind(this);
    this._boundStackResolve = this.onStackResolved.bind(this);

    // Auto-initialize if dependencies are provided
    if (this.tabletopState || this.priorityStateMachine) {
      this.initialize();
    }
  }

  /**
   * Initializes engine state, mounts Command Zone Emblem, and attaches listeners.
   */
  initialize() {
    if (this.isEmblemActive) return;

    // Mount Command Zone Emblem (INV-PERK-7)
    this.emblem = {
      id: 'emblem_random_perk',
      type: 'EMBLEM',
      name: 'Random Perk Emblem',
      zone: 'command',
      isStatic: true,
      isIndestructible: true,
      ownerId: 'SYSTEM'
    };

    if (this.stateManager) {
      this.stateManager.commandZone = this.stateManager.commandZone || [];
      if (!this.stateManager.commandZone.some(e => e.id === this.emblem.id)) {
        this.stateManager.commandZone.push(this.emblem);
      }
      for (const player of Object.values(this.stateManager.players || {})) {
        player.commandZone = player.commandZone || [];
        if (!player.commandZone.some(e => e.id === this.emblem.id)) {
          player.commandZone.push(this.emblem);
        }
      }
    }

    // Attach event listeners to PriorityStateMachine
    if (this.priorityStateMachine) {
      this.priorityStateMachine.on('PHASE_STEP_CHANGED', this._boundPhaseStepChanged);
      this.priorityStateMachine.on('STACK_RESOLVE', this._boundStackResolve);
    }

    this.isEmblemActive = true;
    this.emit('ENGINE_INITIALIZED', {
      perkUnlockTurn: this.perkUnlockTurn,
      initialPlayerCount: this.initialPlayerCount,
      emblem: this.emblem
    });
  }

  /**
   * Alias for initialize() conforming to SPEC-RPM-PERK-009 Section 9.2
   */
  init() {
    return this.initialize();
  }

  /**
   * Destroys engine subscriptions and cancels active alarms.
   */
  destroy() {
    if (this.priorityStateMachine) {
      this.priorityStateMachine.off('PHASE_STEP_CHANGED', this._boundPhaseStepChanged);
      this.priorityStateMachine.off('STACK_RESOLVE', this._boundStackResolve);
    }

    if (this.stackAlarmManager) {
      this.stackAlarmManager.cancel();
    }

    this.isEmblemActive = false;
    this.currentStep = 'IDLE';
    this.activeStep1Item = null;
    this.activeStep2Item = null;
    this.removeAllListeners();
  }

  /**
   * Handler for PriorityStateMachine PHASE_STEP_CHANGED.
   * 
   * @param {Object} event
   */
  onPhaseStepChanged(event) {
    if (!event || event.currentPhaseStep !== 'UPKEEP') {
      return;
    }

    const currentTurn = event.turnNumber !== undefined
      ? event.turnNumber
      : (this.priorityStateMachine?.turnNumber || 1);

    const activePlayerId = event.activePlayerId || this.priorityStateMachine?.activePlayerId;
    this.handleUpkeepStep(activePlayerId, currentTurn);
  }

  /**
   * Evaluates upkeep step progression and triggers Step 1 if turn >= perkUnlockTurn.
   * 
   * @param {string} activePlayerId
   * @param {number} [turnNumber]
   */
  handleUpkeepStep(activePlayerId, turnNumber) {
    const currentTurn = turnNumber !== undefined
      ? turnNumber
      : (this.priorityStateMachine?.turnNumber || 1);

    const targetPlayerId = activePlayerId || this.priorityStateMachine?.activePlayerId;

    if (currentTurn < this.perkUnlockTurn) {
      this.emit('PERK_EMBLEM_DORMANT', {
        turnNumber: currentTurn,
        perkUnlockTurn: this.perkUnlockTurn,
        activePlayerId: targetPlayerId
      });
      return null;
    }

    return this.triggerStep1(targetPlayerId);
  }

  /**
   * Pushes Step 1 Upkeep Trigger onto the MTG Stack.
   * By default (DEC-013 / INV-PERK-2), RPM trigger is placed to resolve first (top of stack).
   * 
   * @param {string} [activePlayerId]
   * @returns {Object} StackItemUpkeepTrigger
   */
  triggerStep1(activePlayerId) {
    const targetActivePlayer = activePlayerId || this.priorityStateMachine?.activePlayerId;

    const step1Item = {
      id: generateStackItemId(),
      sourcePlayerId: targetActivePlayer,
      type: 'PERK_UPKEEP_TRIGGER',
      name: 'Random Perk Upkeep Trigger',
      targets: [],
      timestamp: Date.now()
    };

    this.activeStep1Item = step1Item;
    this.currentStep = 'STEP_1';

    if (this.priorityStateMachine) {
      // Pushing onto stack ensures APNAP top placement so it resolves first
      this.priorityStateMachine.pushStack(step1Item);
      this.priorityStateMachine.consecutivePassCount = 0;

      // Rotate priority to opponent
      const nextPlayerId = this.priorityStateMachine.nextPlayer(targetActivePlayer);
      this.priorityStateMachine.priorityPlayerId = nextPlayerId;

      // Start 15s Stack Alarm for the opponent receiving priority
      if (this.stackAlarmManager) {
        this.stackAlarmManager.start(nextPlayerId, step1Item.id, this.alarmDurationSeconds);
      }
    }

    this.emit('PERK_UPKEEP_TRIGGER_PLACED', {
      stackItem: step1Item,
      activePlayerId: targetActivePlayer
    });

    return step1Item;
  }

  /**
   * Intercepts stack item resolutions from PriorityStateMachine.
   * 
   * @param {Object} event
   */
  onStackResolved(event) {
    const resolvedItem = event?.resolvedItem;
    if (!resolvedItem) return;

    if (resolvedItem.type === 'PERK_UPKEEP_TRIGGER') {
      this.handleStep1Resolution(null, resolvedItem.sourcePlayerId);
    } else if (resolvedItem.type === 'PERK_EFFECT_TRIGGER') {
      this.handleStep2Resolution(resolvedItem);
    }
  }

  /**
   * Rolls the authoritative 2xd10 dice.
   * 
   * @returns {{ tens: number, ones: number, rollString: string }}
   */
  rollDice() {
    return executeAuthoritativeRoll(this.prng);
  }

  /**
   * Alias for rollDice()
   */
  executeRoll() {
    return this.rollDice();
  }

  /**
   * Resolves Step 1 Upkeep Trigger: rolls dice, evaluates hit/miss, checks CR 603.3d target legality,
   * and pushes Step 2 if legal.
   * 
   * @param {Object|null} [injectedRoll=null]
   * @param {string} [playerId]
   * @returns {Object} DiceRollResult
   */
  handleStep1Resolution(injectedRoll = null, playerId = null) {
    const activePlayerId = playerId || this.activeStep1Item?.sourcePlayerId || this.priorityStateMachine?.activePlayerId;
    const roll = injectedRoll || this.rollDice();

    const playerBirthdayRoll = this.birthdayMap[activePlayerId] || '69';
    const match = resolveRoll(roll.tens, roll.ones, playerBirthdayRoll);

    const rollResult = {
      tens: roll.tens,
      ones: roll.ones,
      rollString: roll.rollString,
      matchedKey: match.perkKey,
      isBirthday: match.isBirthday,
      isMiss: match.isMiss,
      timestamp: Date.now()
    };

    this.lastRollResult = rollResult;
    this.activeStep1Item = null;

    this.emit('PERK_ROLLED', rollResult);

    // Roll Miss Branch (INV-PERK-8)
    if (match.isMiss || !match.perkKey) {
      this.currentStep = 'IDLE';
      this.emit('PERK_ROLL_MISS', {
        activePlayerId,
        roll: rollResult,
        turnNumber: this.priorityStateMachine?.turnNumber || 1
      });
      return rollResult;
    }

    const perkKey = match.perkKey;
    const perkDef = getPerkDefinition(perkKey);

    // CR 603.3d Target Legality Pre-Check (INV-PERK-1)
    if (perkDef?.requiresTargets) {
      const legal = hasLegalTargets(perkKey, this.stateManager, activePlayerId);
      if (!legal) {
        this.currentStep = 'IDLE';
        this.emit('PERK_TRIGGER_FIZZLED_NO_LEGAL_TARGETS', {
          activePlayerId,
          perkKey,
          perkName: perkDef.name,
          roll: rollResult,
          reason: 'NO_LEGAL_TARGETS'
        });
        return rollResult;
      }
    }

    // Step 2 Target Declaration & Stack Push (DEC-014)
    let declaredTargets = [];
    if (perkDef?.requiresTargets) {
      const availableTargets = getLegalTargets(perkKey, this.stateManager, activePlayerId);
      if (availableTargets.length > 0) {
        declaredTargets = [availableTargets[0]];
      }
    }

    this.triggerStep2(perkKey, declaredTargets, match.isBirthday ? 0 : undefined, activePlayerId);
    return rollResult;
  }

  /**
   * Alias for handleStep1Resolution()
   */
  resolveStep1Trigger(injectedRoll = null, playerId = null) {
    return this.handleStep1Resolution(injectedRoll, playerId);
  }

  /**
   * Pushes Step 2 Perk Trigger onto the stack with declared targets and starts fresh 15s alarm.
   * 
   * @param {string} perkKey
   * @param {Array<Object>} [targets=[]]
   * @param {number|string} [birthdayOptionIndex]
   * @param {string} [activePlayerId]
   * @returns {Object} StackItemPerkTrigger
   */
  triggerStep2(perkKey, targets = [], birthdayOptionIndex, activePlayerId) {
    const targetPlayerId = activePlayerId || this.priorityStateMachine?.activePlayerId;
    const perkDef = getPerkDefinition(perkKey);

    const step2Item = {
      id: generateStackItemId(),
      sourcePlayerId: targetPlayerId,
      type: 'PERK_EFFECT_TRIGGER',
      perkKey,
      perkName: perkDef?.name || perkKey,
      targets: targets || [],
      birthdayOptionIndex,
      timestamp: Date.now()
    };

    this.activeStep2Item = step2Item;
    this.currentStep = 'STEP_2';

    if (this.priorityStateMachine) {
      this.priorityStateMachine.pushStack(step2Item);
      this.priorityStateMachine.consecutivePassCount = 0;

      // Priority passes to opponent with fresh 15s Stack Alarm
      const nextPlayerId = this.priorityStateMachine.nextPlayer(targetPlayerId);
      this.priorityStateMachine.priorityPlayerId = nextPlayerId;

      if (this.stackAlarmManager) {
        this.stackAlarmManager.start(nextPlayerId, step2Item.id, this.alarmDurationSeconds);
      }
    }

    this.emit('PERK_EFFECT_TRIGGER_PLACED', {
      stackItem: step2Item,
      activePlayerId: targetPlayerId,
      perkKey,
      targets
    });

    return step2Item;
  }

  /**
   * Executes perk mutation upon Step 2 resolution under MTG CR 608.2c.
   * 
   * @param {Object} perkStackItem
   * @returns {Object} PerkExecutionResult
   */
  handleStep2Resolution(perkStackItem) {
    const item = perkStackItem || this.activeStep2Item;
    if (!item) {
      throw new Error('No active Step 2 Perk Trigger to resolve');
    }

    const executionResult = executePerkEffect(
      item.perkKey,
      this.stateManager,
      {
        activePlayerId: item.sourcePlayerId,
        targets: item.targets,
        birthdayOptionIndex: item.birthdayOptionIndex
      }
    );

    this.currentStep = 'IDLE';
    this.activeStep2Item = null;

    const payload = {
      activePlayerId: item.sourcePlayerId,
      perkKey: item.perkKey,
      perkName: item.perkName,
      result: executionResult,
      timestamp: Date.now()
    };

    this.emit('PERK_EFFECT_RESOLVED', payload);
    this.emit('PERK_RESOLVED', payload);

    return executionResult;
  }

  /**
   * Alias for handleStep2Resolution()
   */
  resolveStep2Trigger(item) {
    return this.handleStep2Resolution(item);
  }
}

export default RandomPerkEngine;
