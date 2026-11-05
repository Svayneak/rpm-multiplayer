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
    const stateCount = Object.keys(this.tabletopState?.players || options.stateManager?.players || {}).length;
    const psmCount = this.priorityStateMachine?.players?.length;
    const calculatedPlayerCount = options.initialPlayerCount !== undefined
      ? options.initialPlayerCount
      : (
          (stateCount >= 3 ? stateCount : 0) ||
          (psmCount >= 3 ? psmCount : 0) ||
          stateCount ||
          psmCount ||
          2
        );

    this.initialPlayerCount = calculatedPlayerCount;
    // Invariant INV-PERK-4: T_unlock = 2 if N_initial >= 3, else 4.
    this.perkUnlockTurn = (this.initialPlayerCount >= 3) ? 2 : 4;

    this.birthdayMap = options.birthdayMap || {};
    this.prng = options.prng || options.prngFn || null;
    this.alarmDurationSeconds = options.alarmDurationSeconds || 15;

    // Interactive human roll confirmation gating (Step 1 RPM Emblem pause)
    this.awaitHumanRollConfirmation = Boolean(options.awaitHumanRollConfirmation);
    this.humanPlayerId = options.humanPlayerId || null;

    this.isEmblemActive = false;
    this.emblem = null;
    this.currentStep = 'IDLE'; // 'IDLE' | 'STEP_1' | 'STEP_2'
    this.activeStep1Item = null;
    this.activeStep2Item = null;
    this.lastRollResult = null;
    this.rollState = null;
    this.rollHistory = [];

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
   * Reconfigures engine player scaling anchor dynamically when player count changes.
   * In 3-6 player games, perkUnlockTurn is anchored to Round 2 (INV-PERK-4).
   * 
   * @param {number} [playerCount]
   * @returns {{ initialPlayerCount: number, perkUnlockTurn: number }}
   */
  reconfigure(playerCount) {
    const stateCount = Object.keys(this.tabletopState?.players || this.stateManager?.players || {}).length;
    const psmCount = this.priorityStateMachine?.players?.length;
    const count = typeof playerCount === 'number'
      ? playerCount
      : (
          (stateCount >= 3 ? stateCount : 0) ||
          (psmCount >= 3 ? psmCount : 0) ||
          stateCount ||
          psmCount ||
          this.initialPlayerCount ||
          2
        );

    this.initialPlayerCount = count;
    this.perkUnlockTurn = (count >= 3) ? 2 : 4;

    this.emit('ENGINE_RECONFIGURED', {
      initialPlayerCount: this.initialPlayerCount,
      perkUnlockTurn: this.perkUnlockTurn
    });

    return {
      initialPlayerCount: this.initialPlayerCount,
      perkUnlockTurn: this.perkUnlockTurn
    };
  }

  /**
   * Evaluates upkeep perk trigger eligibility for activePlayerId.
   * Checks if the active player is in Round >= 2 (state.priorityMachine.roundNumber >= 2
   * or player.turnsTaken >= 2), firing PERK_UPKEEP_TRIGGER for each player on their Round 2 UPKEEP.
   * 
   * @param {TabletopStateManager|Object} [stateManager]
   * @param {string} [activePlayerId]
   * @returns {Object|null} StackItemUpkeepTrigger or null if dormant
   */
  evaluateUpkeepPerks(stateManager = null, activePlayerId = null) {
    const sm = stateManager || this.stateManager || this.tabletopState;
    const psm = this.priorityStateMachine || sm?.priorityMachine || sm?._priorityMachine;
    const targetPlayerId = activePlayerId || psm?.activePlayerId || sm?.activePlayerId;
    if (!targetPlayerId) return null;

    // Dynamically sync scaling with active game's player count
    const activeCount = Object.keys(sm?.players || {}).length || psm?.players?.length || this.initialPlayerCount || 2;
    if (activeCount >= 3 && this.perkUnlockTurn > 2) {
      this.initialPlayerCount = activeCount;
      this.perkUnlockTurn = 2;
    }

    const currentTurn = psm?.turnNumber ?? sm?.turnNumber ?? 1;
    let currentRound = psm?.roundNumber ?? sm?.roundNumber;
    if (currentRound === undefined) {
      currentRound = Math.floor((currentTurn - 1) / (this.initialPlayerCount || 2)) + 1;
    }

    const player = sm?.players?.[targetPlayerId] || (typeof sm?.getPlayer === 'function' ? sm.getPlayer(targetPlayerId) : null);
    const turnsTaken = player?.turnsTaken ?? player?.turnsPlayed ?? psm?.playerTurnCounts?.get(targetPlayerId) ?? 1;

    // Check if player is in Round >= perkUnlockTurn (or turnsTaken >= perkUnlockTurn)
    const isEligible = (currentRound >= this.perkUnlockTurn) || (turnsTaken >= this.perkUnlockTurn);

    // In 1v1 (2 players), Round 4 corresponds to global turnNumber >= 7
    const is1v1Round4 = (this.initialPlayerCount === 2 && currentTurn >= 7);

    if (isEligible || is1v1Round4) {
      return this.triggerStep1(targetPlayerId);
    }

    this.emit('PERK_EMBLEM_DORMANT', {
      turnNumber: currentTurn,
      roundNumber: currentRound,
      perkUnlockTurn: this.perkUnlockTurn,
      activePlayerId: targetPlayerId,
      turnsTaken
    });
    return null;
  }

  /**
   * Static convenience evaluator for evaluateUpkeepPerks.
   */
  static evaluateUpkeepPerks(stateManager, activePlayerId, engine = null) {
    if (engine && typeof engine.evaluateUpkeepPerks === 'function') {
      return engine.evaluateUpkeepPerks(stateManager, activePlayerId);
    }
    const eng = stateManager?.randomPerkEngine || stateManager?._randomPerkEngine;
    if (eng && typeof eng.evaluateUpkeepPerks === 'function') {
      return eng.evaluateUpkeepPerks(stateManager, activePlayerId);
    }
    return null;
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

    // In production, PriorityStateMachine emits event.roundNumber.
    // If event.roundNumber is present, use it. Otherwise derive or check machine.
    let currentRound = event.roundNumber;
    if (currentRound === undefined) {
      currentRound = this.priorityStateMachine?.roundNumber ?? this.tabletopState?.roundNumber;
    }
    if (currentRound === undefined) {
      const pCount = this.initialPlayerCount || 2;
      currentRound = Math.floor((currentTurn - 1) / pCount) + 1;
    }

    const activePlayerId = event.activePlayerId || this.priorityStateMachine?.activePlayerId;
    this.handleUpkeepStep(activePlayerId, currentTurn, currentRound);
  }

  /**
   * Evaluates upkeep step progression and triggers Step 1 if round/turn >= perkUnlockTurn.
   * 
   * @param {string} activePlayerId
   * @param {number} [turnNumber]
   * @param {number} [roundNumber]
   */
  handleUpkeepStep(activePlayerId, turnNumber, roundNumber) {
    let targetPlayerId;
    let currentTurn;
    let effectiveRound;

    if (activePlayerId && typeof activePlayerId === 'object' && typeof turnNumber === 'string') {
      // Called with (stateManager, activePlayerId)
      targetPlayerId = turnNumber;
      currentTurn = typeof roundNumber === 'number' ? roundNumber : (activePlayerId.turnNumber || this.priorityStateMachine?.turnNumber || 1);
      effectiveRound = (typeof roundNumber === 'number') ? roundNumber : (activePlayerId.roundNumber ?? this.priorityStateMachine?.roundNumber);
    } else {
      targetPlayerId = (typeof activePlayerId === 'string' ? activePlayerId : null) || this.priorityStateMachine?.activePlayerId;
      currentTurn = (turnNumber !== undefined && turnNumber !== null && typeof turnNumber === 'number')
        ? turnNumber
        : (this.priorityStateMachine?.turnNumber || 1);
      if (roundNumber !== undefined && roundNumber !== null) {
        effectiveRound = roundNumber;
      } else if (this.priorityStateMachine?.roundNumber !== undefined) {
        effectiveRound = this.priorityStateMachine.roundNumber;
      } else if (typeof turnNumber === 'number') {
        effectiveRound = turnNumber;
      } else {
        effectiveRound = 1;
      }
    }

    const player = this.stateManager?.players?.[targetPlayerId] || this.tabletopState?.players?.[targetPlayerId];
    const turnsTaken = player?.turnsTaken ?? this.priorityStateMachine?.playerTurnCounts?.get(targetPlayerId) ?? 1;

    // In 1v1 (2 players), Round 4 corresponds to global turnNumber >= 7
    if (this.initialPlayerCount === 2 && currentTurn >= 7 && effectiveRound < 4) {
      effectiveRound = 4;
    }

    // For 3-6 players, Round >= 2 or turnsTaken >= 2 triggers perk
    const isEligible = (effectiveRound >= this.perkUnlockTurn) || (turnsTaken >= this.perkUnlockTurn);

    if (!isEligible) {
      this.emit('PERK_EMBLEM_DORMANT', {
        turnNumber: currentTurn,
        roundNumber: effectiveRound,
        perkUnlockTurn: this.perkUnlockTurn,
        activePlayerId: targetPlayerId,
        turnsTaken
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
      isTrigger: true,
      isEmblemTrigger: true,
      targets: [],
      timestamp: Date.now()
    };

    this.activeStep1Item = step1Item;
    this.currentStep = 'STEP_1';

    let nextPlayerId = targetActivePlayer;
    if (this.priorityStateMachine) {
      // Pushing onto stack ensures APNAP top placement so it resolves first
      this.priorityStateMachine.pushStack(step1Item);
      this.priorityStateMachine.consecutivePassCount = 0;

      // Rotate priority to opponent
      nextPlayerId = this.priorityStateMachine.nextPlayer(targetActivePlayer);
      this.priorityStateMachine.priorityPlayerId = nextPlayerId;

      // Start 15s Stack Alarm for the opponent receiving priority
      if (this.stackAlarmManager) {
        this.stackAlarmManager.start(nextPlayerId, step1Item.id, this.alarmDurationSeconds);
      }

      this.priorityStateMachine.emit('PRIORITY_CHANGED', {
        activePlayerId: targetActivePlayer,
        priorityPlayerId: nextPlayerId,
        currentPhaseStep: this.priorityStateMachine.currentPhaseStep,
        consecutivePassCount: 0,
        stackSize: this.priorityStateMachine.stack.length
      });
    }

    const pName = this.stateManager?.getPlayer?.(targetActivePlayer)?.playerName || targetActivePlayer;
    const step1Log = `🔮 [RPM Step 1]: Upkeep Emblem Trigger on stack for ${pName}. Priority open.`;
    this.stateManager?.recordTrace?.('PERK_TRACE', 'PERK_STEP1_TRIGGERED', {
      activePlayerId: targetActivePlayer,
      priorityPlayerId: nextPlayerId,
      stackItemId: step1Item.id,
      summary: step1Log
    });

    this.emit('PERK_UPKEEP_TRIGGER', {
      stackItem: step1Item,
      activePlayerId: targetActivePlayer,
      priorityPlayerId: nextPlayerId,
      logMessage: step1Log
    });
    this.emit('PERK_UPKEEP_TRIGGER_PLACED', {
      stackItem: step1Item,
      activePlayerId: targetActivePlayer,
      priorityPlayerId: nextPlayerId,
      logMessage: step1Log
    });
    this.emit('PERK_STEP1_TRIGGERED', {
      stackItem: step1Item,
      activePlayerId: targetActivePlayer,
      priorityPlayerId: nextPlayerId,
      logMessage: step1Log
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
   * Resolves Step 1 Upkeep Trigger:
   * a) If awaitHumanRollConfirmation is active and it is the human player's turn (not bot),
   *    pauses and emits 'RPM_AWAIT_PLAYER_ROLL' with callback for human decision (ROLL or SKIP).
   * b) In headless/test mode, or bot turns, or when injectedRoll is provided: resolves immediately.
   * 
   * @param {Object|null} [injectedRoll=null]
   * @param {string} [playerId]
   * @returns {Object|Promise<Object>} DiceRollResult or Promise resolving upon decision
   */
  handleStep1Resolution(injectedRoll = null, playerId = null) {
    const activePlayerId = playerId || this.activeStep1Item?.sourcePlayerId || this.priorityStateMachine?.activePlayerId;

    const playerObj = this.tabletopState?.players?.[activePlayerId] || this.tabletopState?.getPlayer?.(activePlayerId);
    const isHumanTurn = (activePlayerId === this.humanPlayerId || (playerObj && !playerObj.isBot && activePlayerId !== 'p2_perkins' && !activePlayerId?.startsWith('bot_') && !activePlayerId?.includes('perkins')));

    const isBot = !isHumanTurn || Boolean(
      playerObj?.isBot ||
      activePlayerId?.startsWith('bot_') ||
      activePlayerId?.includes('perkins')
    );

    // Interactive pause for human player confirmation if enabled
    if (this.awaitHumanRollConfirmation && isHumanTurn && !isBot && !injectedRoll) {
      const turnNumber = this.priorityStateMachine?.turnNumber || 1;
      let roundNumber = this.priorityStateMachine?.roundNumber;
      if (roundNumber === undefined) {
        roundNumber = Math.floor((turnNumber - 1) / (this.initialPlayerCount || 2)) + 1;
      }

      return new Promise((resolve) => {
        let settled = false;

        const callback = (decision) => {
          if (settled) return;
          settled = true;

          const action = (typeof decision === 'string') ? decision : decision?.action;
          if (action === 'SKIP') {
            this.currentStep = 'IDLE';
            this.activeStep1Item = null;
            const pName = this.stateManager?.getPlayer?.(activePlayerId)?.playerName || activePlayerId;
            const declineLog = `🛑 [RPM Step 1]: ${pName} declined to roll the RPM Emblem dice.`;
            this.stateManager?.recordTrace?.('PERK_TRACE', 'PERK_ROLL_DECLINED', {
              activePlayerId,
              summary: declineLog
            });
            const declinePayload = {
              activePlayerId,
              playerId: activePlayerId,
              turnNumber,
              roundNumber,
              declined: true,
              logMessage: declineLog
            };
            this.emit('PERK_ROLL_DECLINED', declinePayload);
            resolve(declinePayload);
            return declinePayload;
          }

          // Otherwise action === 'ROLL'
          // Single Synchronized Roll: check if decision?.roll is already provided with valid { tens, ones, rollString }
          let forcedRoll = null;
          if (decision?.roll && typeof decision.roll.tens === 'number' && typeof decision.roll.ones === 'number') {
            const t = Number(decision.roll.tens) % 10;
            const o = Number(decision.roll.ones) % 10;
            forcedRoll = {
              tens: t,
              ones: o,
              rollString: String(decision.roll.rollString ?? `${t}${o}`).padStart(2, '0'),
              timestamp: Date.now()
            };
          } else if (decision?.injectedRoll) {
            forcedRoll = decision.injectedRoll;
          }

          const deferStep2 = Boolean(decision?.deferStep2);
          const rollResult = this._finishStep1Resolution(forcedRoll, activePlayerId, {
            deferStep2,
            impulse: decision?.impulse
          });
          resolve(rollResult);
          return rollResult;
        };

        this.emit('RPM_AWAIT_PLAYER_ROLL', {
          activePlayerId,
          playerId: activePlayerId,
          turnNumber,
          roundNumber,
          callback
        });
      });
    }

    return this._finishStep1Resolution(injectedRoll, activePlayerId);
  }

  /**
   * Finalizes Step 1: executes authoritative roll, resolves match/miss, checks legality,
   * and triggers Step 2 onto the stack.
   * 
   * @param {Object|null} [injectedRoll=null]
   * @param {string|null} [activePlayerId=null]
   * @param {Object} [options={}]
   * @returns {Object} DiceRollResult
   * @private
   */
  _finishStep1Resolution(injectedRoll = null, activePlayerId = null, options = {}) {
    const targetPlayerId = activePlayerId || this.activeStep1Item?.sourcePlayerId || this.priorityStateMachine?.activePlayerId;
    const roll = (injectedRoll && typeof injectedRoll.tens === 'number' && typeof injectedRoll.ones === 'number')
      ? {
          tens: injectedRoll.tens,
          ones: injectedRoll.ones,
          rollString: String(injectedRoll.rollString ?? `${injectedRoll.tens}${injectedRoll.ones}`).padStart(2, '0'),
          timestamp: injectedRoll.timestamp || Date.now()
        }
      : this.rollDice();

    const playerObj = this.stateManager?.players?.[targetPlayerId] || this.tabletopState?.players?.[targetPlayerId];
    const rawBday =
      options.birthday ??
      options.birthDay ??
      this.birthdayMap?.[targetPlayerId] ??
      this.playerBirthdays?.[targetPlayerId] ??
      playerObj?.birthDay ??
      playerObj?.birthday ??
      playerObj?.dob ??
      playerObj?.profile?.birthday ??
      null;

    let playerBirthdayRoll = '69';
    if (rawBday !== null && rawBday !== undefined && String(rawBday).trim() !== '') {
      const strBday = String(rawBday).trim();
      const isoMatch = strBday.match(/-(\d{1,2})$/);
      if (isoMatch) {
        playerBirthdayRoll = isoMatch[1].padStart(2, '0');
      } else {
        playerBirthdayRoll = strBday.padStart(2, '0').slice(-2);
      }
    }

    const rollNum = parseInt(roll.rollString, 10);
    const bdayNum = parseInt(playerBirthdayRoll, 10);
    const isBirthdayDayOverride = (
      rawBday !== null &&
      rawBday !== undefined &&
      rollNum >= 1 &&
      rollNum <= 31 &&
      bdayNum === rollNum &&
      roll.rollString === playerBirthdayRoll
    );

    const match = isBirthdayDayOverride
      ? {
          perkKey: 'RPBD',
          matchedKey: 'RPBD',
          tens: roll.tens,
          ones: roll.ones,
          rollString: roll.rollString,
          isBirthday: true,
          isBirthdayMatch: true,
          isMiss: false
        }
      : resolveRoll(roll.tens, roll.ones, playerBirthdayRoll);

    const perkName = match.isMiss ? 'Miss' : (getPerkDefinition(match.perkKey)?.name || match.perkKey);

    const rollResult = {
      tens: roll.tens,
      ones: roll.ones,
      rollString: roll.rollString,
      matchedKey: match.perkKey,
      perkName,
      isBirthday: match.isBirthday,
      isMiss: match.isMiss,
      timestamp: roll.timestamp || Date.now()
    };

    this.lastRollResult = rollResult;
    this.rollState = rollResult;
    if (!this.rollHistory) this.rollHistory = [];
    this.rollHistory.push(rollResult);
    this.activeStep1Item = null;

    const pName = this.stateManager?.getPlayer?.(targetPlayerId)?.playerName || targetPlayerId;
    const rollLog = `🎲 [RPM Roll]: ${pName} rolled ${roll.rollString} (${perkName})`;

    this.stateManager?.recordTrace?.('PERK_TRACE', 'PERK_DICE_ROLLED', {
      activePlayerId: targetPlayerId,
      roll: rollResult,
      perkName,
      summary: rollLog
    });

    this.emit('PERK_DICE_ROLLED', {
      activePlayerId: targetPlayerId,
      roll: rollResult,
      perkName,
      logMessage: rollLog
    });
    this.emit('PERK_ROLLED', rollResult);
    this.emit('DICE_ROLLED', rollResult);

    // Roll Miss Branch (INV-PERK-8)
    if (match.isMiss || !match.perkKey) {
      this.currentStep = 'IDLE';
      this.emit('PERK_ROLL_MISS', {
        activePlayerId: targetPlayerId,
        roll: rollResult,
        turnNumber: this.priorityStateMachine?.turnNumber || 1,
        logMessage: rollLog
      });
      return {
        ...rollResult,
        queueStep2: () => null
      };
    }

    const perkKey = match.perkKey;
    const perkDef = getPerkDefinition(perkKey);

    // CR 603.3d Target Legality Pre-Check (INV-PERK-1)
    if (perkDef?.requiresTargets) {
      const legal = hasLegalTargets(perkKey, this.stateManager, targetPlayerId);
      if (!legal) {
        this.currentStep = 'IDLE';
        this.emit('PERK_TRIGGER_FIZZLED_NO_LEGAL_TARGETS', {
          activePlayerId: targetPlayerId,
          perkKey,
          perkName: perkDef.name,
          roll: rollResult,
          reason: 'NO_LEGAL_TARGETS'
        });
        return {
          ...rollResult,
          queueStep2: () => null
        };
      }
    }

    // Step 2 Target Declaration & Stack Push (DEC-014)
    let declaredTargets = [];
    if (perkDef?.requiresTargets) {
      const availableTargets = getLegalTargets(perkKey, this.stateManager, targetPlayerId);
      if (availableTargets.length > 0) {
        declaredTargets = [availableTargets[0]];
      }
    }

    const queueStep2 = () => {
      return this.triggerStep2(perkKey, declaredTargets, match.isBirthday ? 0 : undefined, targetPlayerId);
    };

    if (options.deferStep2) {
      return {
        ...rollResult,
        queueStep2
      };
    }

    queueStep2();
    return {
      ...rollResult,
      queueStep2
    };
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
      isTrigger: true,
      isEmblemTrigger: true,
      perkKey,
      perkName: perkDef?.name || perkKey,
      targets: targets || [],
      birthdayOptionIndex,
      timestamp: Date.now()
    };

    this.activeStep2Item = step2Item;
    this.currentStep = 'STEP_2';

    let nextPlayerId = targetPlayerId;
    if (this.priorityStateMachine) {
      this.priorityStateMachine.pushStack(step2Item);
      this.priorityStateMachine.consecutivePassCount = 0;

      // Priority passes to opponent with fresh 15s Stack Alarm
      nextPlayerId = this.priorityStateMachine.nextPlayer(targetPlayerId);
      this.priorityStateMachine.priorityPlayerId = nextPlayerId;

      if (this.stackAlarmManager) {
        this.stackAlarmManager.start(nextPlayerId, step2Item.id, this.alarmDurationSeconds);
      }

      this.priorityStateMachine.emit('PRIORITY_CHANGED', {
        activePlayerId: targetPlayerId,
        priorityPlayerId: nextPlayerId,
        currentPhaseStep: this.priorityStateMachine.currentPhaseStep,
        consecutivePassCount: 0,
        stackSize: this.priorityStateMachine.stack.length
      });
    }

    const pName = this.stateManager?.getPlayer?.(targetPlayerId)?.playerName || targetPlayerId;
    const step2Log = `🔮 [RPM Step 2]: Perk Effect Trigger (${step2Item.perkName}) on stack for ${pName}. Priority open.`;
    this.stateManager?.recordTrace?.('PERK_TRACE', 'PERK_STEP2_TRIGGERED', {
      activePlayerId: targetPlayerId,
      priorityPlayerId: nextPlayerId,
      perkKey,
      stackItemId: step2Item.id,
      summary: step2Log
    });

    this.emit('PERK_EFFECT_TRIGGER_PLACED', {
      stackItem: step2Item,
      activePlayerId: targetPlayerId,
      priorityPlayerId: nextPlayerId,
      perkKey,
      targets,
      logMessage: step2Log
    });
    this.emit('PERK_STEP2_TRIGGERED', {
      stackItem: step2Item,
      activePlayerId: targetPlayerId,
      priorityPlayerId: nextPlayerId,
      perkKey,
      targets,
      logMessage: step2Log
    });

    return step2Item;
  }

  /**
   * Executes perk mutation upon Step 2 resolution under MTG CR 608.2c.
   * 
   * @param {Object} [perkStackItem]
   * @param {Object} [options={}]
   * @returns {Object} PerkExecutionResult
   */
  handleStep2Resolution(perkStackItem, options = {}) {
    const item = perkStackItem || this.activeStep2Item;
    if (!item) {
      throw new Error('No active Step 2 Perk Trigger to resolve');
    }

    const mergedOptions = {
      activePlayerId: item.sourcePlayerId,
      targets: item.targets,
      birthdayOptionIndex: item.birthdayOptionIndex,
      ...(item.options || {}),
      ...(options || {})
    };

    if (item.perkKey === '66' || item.perkName === 'Mutual Sacrifice') {
      this._handleMutualSacrificeChoices(item, mergedOptions);
    }

    const executionResult = executePerkEffect(
      item.perkKey,
      this.stateManager,
      mergedOptions
    );

    this.currentStep = 'IDLE';
    this.activeStep2Item = null;

    const summary = executionResult?.logSummary || `Resolved Perk #${item.perkKey}`;
    const resolvedLog = `✨ [RPM #${item.perkKey} Resolved]: ${summary}`;

    this.stateManager?.recordTrace?.('PERK_TRACE', 'PERK_RESOLVED', {
      activePlayerId: item.sourcePlayerId,
      perkKey: item.perkKey,
      perkName: item.perkName,
      result: executionResult,
      summary: resolvedLog
    });

    const payload = {
      activePlayerId: item.sourcePlayerId,
      perkKey: item.perkKey,
      perkName: item.perkName,
      result: executionResult,
      logMessage: resolvedLog,
      timestamp: Date.now()
    };

    this.emit('PERK_EFFECT_RESOLVED', payload);
    this.emit('PERK_RESOLVED', payload);

    return executionResult;
  }

  /**
   * Helper to resolve sacrifice selections for Perk #66 (Mutual Sacrifice)
   * under MTG CR 608.2c.
   * 
   * @param {Object} item
   * @param {Object} options
   * @private
   */
  _handleMutualSacrificeChoices(item, options = {}) {
    const sm = this.stateManager || this.tabletopState;
    if (!sm) return;

    const sacrificeChoices = options.sacrificeChoices || item.sacrificeChoices || item.options?.sacrificeChoices || {};
    const allPlayerIds = Object.keys(sm.players || {});
    const activePid = options.activePlayerId || item.sourcePlayerId || this.priorityStateMachine?.activePlayerId || allPlayerIds[0];
    const startIdx = Math.max(0, allPlayerIds.indexOf(activePid));
    const apnapPlayerIds = [
      ...allPlayerIds.slice(startIdx),
      ...allPlayerIds.slice(0, startIdx)
    ];

    for (const pId of apnapPlayerIds) {
      const player = sm.players[pId];
      if (!player || player.isEliminated) continue;
      const creatures = player.battlefield?.creatures || [];
      if (creatures.length === 0) continue;

      let chosenCreature = null;
      const explicitChoice = sacrificeChoices[pId];
      if (explicitChoice) {
        chosenCreature = creatures.find(c => c && (c.instanceId === explicitChoice || c.id === explicitChoice));
      }

      const isBot = Boolean(
        player.isBot ||
        pId.startsWith('bot_') ||
        pId.includes('perkins') ||
        (this.humanPlayerId && pId !== this.humanPlayerId)
      );

      if (!chosenCreature && creatures.length >= 2 && !isBot) {
        this.emit('AWAIT_PLAYER_SACRIFICE_CHOICE', {
          playerId: pId,
          candidateCreatures: creatures.map(c => ({
            instanceId: c.instanceId || c.id,
            name: c.name,
            power: c.power,
            toughness: c.toughness,
            manaCost: c.manaCost
          }))
        });
      }

      if (!chosenCreature) {
        // Bot or fallback: lowest value (power + toughness)
        let lowestVal = Infinity;
        chosenCreature = creatures[0];
        for (const c of creatures) {
          if (!c) continue;
          const stats = (sm.abilityEngine && typeof sm.abilityEngine.evaluateCreatureStats === 'function')
            ? sm.abilityEngine.evaluateCreatureStats(c, sm)
            : (sm.evaluateCreatureStats
                ? sm.evaluateCreatureStats(c, pId)
                : { power: Number(c.power || 0), toughness: Number(c.toughness || 0) });
          const val = Number(stats?.power ?? c.power ?? 0) + Number(stats?.toughness ?? c.toughness ?? 0);
          if (val < lowestVal) {
            lowestVal = val;
            chosenCreature = c;
          }
        }
      }

      if (chosenCreature) {
        const idx = creatures.findIndex(c => c === chosenCreature || (c && chosenCreature.instanceId && c.instanceId === chosenCreature.instanceId));
        if (idx > 0) {
          const [selected] = creatures.splice(idx, 1);
          creatures.unshift(selected);
        }
      }
    }
  }

  /**
   * Alias for handleStep2Resolution()
   */
  resolveStep2Trigger(item) {
    return this.handleStep2Resolution(item);
  }
}

export default RandomPerkEngine;
