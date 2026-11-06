/**
 * src/PerkinsAgent.js
 * Primary Autonomous Agent Class, Heuristic Engine & Bilingual Coach.
 * 
 * Implements:
 * - INV-PERKINS-1: Forge-Style Sub-Millisecond Decision Tree (<1ms)
 * - INV-PERKINS-2: Dual-Mode Transport Adapter ('LOCAL_BOT' & RelayClient)
 * - INV-PERKINS-3: Strict Zero-Knowledge Fog-of-War Projection
 * - INV-PERKINS-4: 15-Second Stack Alarm Reaction Engine
 * - INV-PERKINS-5: Random Perk Upkeep & Anti-Sabotage Targeting
 * - INV-PERKINS-6: Combat Trade & Lethal Block Heuristics
 * - INV-PERKINS-7: Bilingual Tutorial Coach & 8s Debounce Gate
 * - INV-SAFE-1: Anti-Hang Phase Action Throttling Guard
 * - INV-SAFE-2: CR 104.3c Empty Library Deckout Concession
 * - INV-SAFE-3: Hermetic Lifecycle & Timer Leak Guard
 * 
 * Specification: SPEC-RPM-PERKINS-013
 * @module PerkinsAgent
 */

import { projectState, TabletopStateManager } from './TabletopStateManager.js';
import { getPerkDefinition, resolveRoll } from './PerkCatalog.js';
import { BEGINNER_DECKS } from './DeckbuilderAI.js';
import { evaluatePerkinsMulligan, selectPerkinsBottomCards } from './MulliganEngine.js';
import { CombatDamageEngine } from './CombatDamageEngine.js';
import { TargetSelectorModal } from './view/TargetSelectorModal.js';

/**
 * Canonical Bilingual Coach Dialogues for the 6 Onboarding Milestones
 */
export const PERKINS_COACH_DIALOGUES = Object.freeze({
  MS_WELCOME: {
    es: '🤖 ¡Hola! Soy Perkins, tu oponente y coach. Puedes jugar tus cartas o pasar turno. ¡Buena suerte!',
    en: "🤖 Hello! I'm Perkins, your opponent and coach. Feel free to play cards or pass priority. Good luck!"
  },
  MS_PRIORITY_HOTKEY: {
    es: '💡 Tip: Puedes presionar la barra espaciadora o la tecla [P] para ceder prioridad rápidamente.',
    en: '💡 Tip: You can press Spacebar or [P] on your keyboard to quickly pass priority.'
  },
  MS_ALARM_HOLD: {
    es: '⚡ ¡Alarma de Pila activa! Tienes 15 segundos para responder. Presiona [H] si necesitas más tiempo.',
    en: '⚡ Stack Alarm active! You have 15s to respond. Press [H] to hold if you need to think.'
  },
  MS_SCRYFALL_OVERLAY: {
    es: '🔍 Tip: Haz clic en cualquier carta de la mesa o pila para ver su arte oficial de Scryfall.',
    en: '🔍 Tip: Click on any card on the battlefield or stack to view its official Scryfall details.'
  },
  MS_PERK_EMBLEM: {
    es: '🔮 ¡Emblema RPM activado! Tiramos 2 d10 (violeta y aguamarina). Si sacas dobles, obtienes un Perk.',
    en: '🔮 RPM Perk Emblem triggered! Rolling 2 d10 dice. Matching doubles awards a unique game Perk.'
  },
  MS_DECKBUILDER_HINT: {
    es: '📚 Tip: Abre el mazo en la barra superior para explorar la IA Deckbuilder y mazos de inicio.',
    en: '📚 Tip: Open the Decks menu in the header to explore the AI Deckbuilder and starter lists.'
  }
});

/**
 * Default Configuration for PerkinsAgent
 */
export const PERKINS_DEFAULT_CONFIG = Object.freeze({
  slotId: 'p2',
  name: 'Perkins AI',
  mode: 'LOCAL',
  thinkingDelayMs: 1200,
  coachEnabled: true,
  language: 'es'
});

/**
 * Perkins AI Opponent & Companion Coach
 */
export class PerkinsAgent {
  /**
   * @param {Object} [options={}]
   */
  constructor(options = {}) {
    this.slotId = options.slotId || options.playerId || PERKINS_DEFAULT_CONFIG.slotId;
    this.name = options.name || PERKINS_DEFAULT_CONFIG.name;
    this.mode = options.mode || PERKINS_DEFAULT_CONFIG.mode; // 'LOCAL' | 'REMOTE'
    this.thinkingDelayMs = options.thinkingDelayMs !== undefined
      ? options.thinkingDelayMs
      : PERKINS_DEFAULT_CONFIG.thinkingDelayMs;
    this.coachEnabled = options.coachEnabled !== undefined
      ? Boolean(options.coachEnabled)
      : PERKINS_DEFAULT_CONFIG.coachEnabled;
    this.language = options.language || PERKINS_DEFAULT_CONFIG.language;
    this.assignedDeck = options.assignedDeck || options.customDeck || options.starterDeck || null;
    this.starterDeck = this.assignedDeck;

    // Subsystem bindings
    this.app = options.app || null;
    this.relayClient = options.relayClient || null;

    // Safety and lifecycle trackers (INV-SAFE-3)
    this.isDestroyed = false;
    this._activeTimers = new Set();
    this._unsubscribers = [];
    this._phaseActionCount = 0;
    this._lastPhaseStep = null;
    this._lastCoachTimestamp = 0;
    this._completedMilestones = new Set();
    this._spacebarTipShown = false;
    this._hasPlayedLandThisTurn = false;
    this._alarmActionCount = 0;
    this._isEvaluating = false;
    this._currentEvaluationPromise = null;

    if (options.app) {
      this.attach(options.app);
    }
  }

  /**
   * Alias for slotId
   * @returns {string}
   */
  get playerId() {
    return this.slotId;
  }

  set playerId(val) {
    this.slotId = val;
  }

  /**
   * Attaches agent to local in-memory RPMAppController for solo play.
   * Enforces INV-PERKINS-2.
   * 
   * @param {Object} app - RPMAppController instance
   */
  attach(app) {
    if (!app || this.isDestroyed) return;
    this.app = app;
    this.mode = 'LOCAL';
    this._bindAppListeners();
    this.triggerMilestone('MS_WELCOME');
  }

  /**
   * Attaches agent to a headless WebSocket RelayClient for online multiplayer.
   * Enforces INV-PERKINS-2.
   * 
   * @param {Object} relayClient - RelayClient instance
   */
  attachRelay(relayClient) {
    if (!relayClient || this.isDestroyed) return;
    this.relayClient = relayClient;
    this.mode = 'REMOTE';
    this._bindRelayListeners();
  }

  /**
   * Reference to tabletop state manager.
   * @returns {Object|null}
   */
  get tabletopState() {
    return this._tabletopState || this.app?.tabletopState || null;
  }

  set tabletopState(state) {
    this._tabletopState = state;
    if (state && typeof state.on === 'function') {
      const onTriggerTarget = (payload) => {
        if (this.isDestroyed || !payload) return;
        if (payload.controllerId === this.slotId) {
          this.handleTriggerTargetRequired(payload);
        }
      };
      state.on('TRIGGER_TARGET_REQUIRED', onTriggerTarget);
      this._unsubscribers.push(() => {
        try { state.off?.('TRIGGER_TARGET_REQUIRED', onTriggerTarget); } catch (_) {}
      });
    }
  }

  /**
   * Auto-resolves pending trigger choice targeting Perkins's strongest own creature (CR 603).
   * 
   * @param {Object} payload
   */
  handleTriggerTargetRequired(payload) {
    if (!payload || !payload.triggerId) return;
    try {
      const state = this.tabletopState || this.app?.tabletopState;
      if (!state || typeof state.resolvePendingTriggerChoice !== 'function') return;

      let bestId = 'DECLINE';
      const candidates = Array.isArray(payload.candidates) ? [...payload.candidates] : [];
      if (candidates.length > 0) {
        // Target Perkins's strongest own creature (power, then toughness)
        candidates.sort((a, b) => {
          const pA = Number(a.power ?? a.card?.power ?? 0);
          const pB = Number(b.power ?? b.card?.power ?? 0);
          if (pB !== pA) return pB - pA;
          const tA = Number(a.toughness ?? a.card?.toughness ?? 0);
          const tB = Number(b.toughness ?? b.card?.toughness ?? 0);
          return tB - tA;
        });
        bestId = candidates[0].id || candidates[0].instanceId || 'DECLINE';
      }
      state.resolvePendingTriggerChoice(payload.triggerId, bestId);
    } catch (err) {
      console.warn('[PerkinsAgent] Error resolving pending trigger target:', err.message);
    }
  }

  /**
   * Obtains safe Fog-of-War projected state for Perkins (INV-PERKINS-3).
   * @returns {Object|null}
   */
  getProjectedState() {
    if (this.app?.tabletopState) {
      if (typeof this.app.tabletopState.projectState === 'function') {
        return this.app.tabletopState.projectState(this.slotId);
      }
      return projectState(this.app.tabletopState, this.slotId);
    }
    return null;
  }

  /**
   * Binds event listeners when attached to local RPMAppController.
   * @private
   */
  _bindAppListeners() {
    if (!this.app) return;

    // 1. StackAlarmManager listening
    if (this.app.alarmManager) {
      const prevOnEmit = this.app.alarmManager.onEmit;
      const alarmHandler = (event) => {
        if (typeof prevOnEmit === 'function') {
          prevOnEmit(event);
        }
        if (this.isDestroyed) return;
        if (event && event.type === 'STACK_ALARM_START') {
          if (event.targetPlayerId === this.slotId) {
            const hasStackItem = (this.app?.priorityMachine?.stack?.length > 0) || Boolean(event.stackItemId && !event.stackItemId.startsWith('stack_alarm_'));
            if (hasStackItem) {
              this.onStackAlarm(event);
            }
          } else if (event.targetPlayerId === this.app.myPlayerId) {
            this.triggerMilestone('MS_ALARM_HOLD');
          }
        }
      };
      this.app.alarmManager.onEmit = alarmHandler;
      this._unsubscribers.push(() => {
        if (this.app?.alarmManager?.onEmit === alarmHandler) {
          this.app.alarmManager.onEmit = prevOnEmit;
        }
      });
    }

    // 2. PriorityStateMachine listening
    if (this.app.priorityMachine && typeof this.app.priorityMachine.on === 'function') {
      const onPriorityChange = (event) => {
        if (this.isDestroyed) return;
        if (event?.priorityPlayerId === this.slotId) {
          const depth = typeof this.app.priorityMachine.getStackDepth === 'function'
            ? this.app.priorityMachine.getStackDepth()
            : (this.app.priorityMachine.stack?.length || 0);

          if (depth > 0) {
            const top = typeof this.app.priorityMachine.peekStack === 'function'
              ? this.app.priorityMachine.peekStack()
              : (this.app.priorityMachine.stack?.[this.app.priorityMachine.stack.length - 1]);
            this.onStackAlarm({ targetPlayerId: this.slotId, stackItemId: top?.id });
          } else {
            this._handleStackEmpty();
            this.evaluateTurnPhase(this.app.priorityMachine.currentPhaseStep);
          }
        } else if (event?.priorityPlayerId === this.app.myPlayerId) {
          this.triggerMilestone('MS_PRIORITY_HOTKEY');
        }
      };
      this.app.priorityMachine.on('PRIORITY_CHANGED', onPriorityChange);
      this._unsubscribers.push(() => this.app.priorityMachine.off('PRIORITY_CHANGED', onPriorityChange));

      const onPhaseStepChange = (event) => {
        if (this.isDestroyed) return;
        this._handleStackEmpty();
        const currentPhase = event?.currentPhaseStep || event?.phaseStep;
        if (event?.priorityPlayerId === this.slotId || this.app.priorityMachine.priorityPlayerId === this.slotId) {
          this.evaluateTurnPhase(currentPhase);
        } else if (
          currentPhase === 'DECLARE_BLOCKERS' &&
          event?.activePlayerId !== this.slotId &&
          (this.app?.tabletopState?.combatState?.attackers?.length || 0) > 0 &&
          !this.app?.tabletopState?.combatState?.blockersDeclared
        ) {
          const allAttackers = this.app?.tabletopState?.combatState?.attackers || [];
          const hasAttackerAgainstMe = allAttackers.some(a => {
            const defId = a?.defendingPlayerId || a?.creature?.defendingPlayerId;
            return !defId || defId === this.slotId;
          });
          if (hasAttackerAgainstMe) {
            this.evaluateTurnPhase(currentPhase);
          }
        }
      };
      this.app.priorityMachine.on('PHASE_STEP_CHANGED', onPhaseStepChange);
      this._unsubscribers.push(() => this.app.priorityMachine.off('PHASE_STEP_CHANGED', onPhaseStepChange));

      const onStackResolve = (event) => {
        if (this.isDestroyed) return;
        const psm = this.app?.priorityMachine;
        if (event?.remainingStackSize === 0 || (psm?.stack?.length || 0) === 0) {
          this._handleStackEmpty();
          if (psm && psm.priorityPlayerId === this.slotId) {
            if (this._isEvaluating) {
              this._pendingEvaluation = true;
            } else {
              this.evaluateTurnPhase(psm.currentPhaseStep);
            }
          }
        }
      };
      this.app.priorityMachine.on('STACK_RESOLVE', onStackResolve);
      this._unsubscribers.push(() => this.app.priorityMachine.off('STACK_RESOLVE', onStackResolve));

      const onStackCleared = () => {
        if (this.isDestroyed) return;
        this._handleStackEmpty();
      };
      this.app.priorityMachine.on('STACK_CLEARED', onStackCleared);
      this._unsubscribers.push(() => this.app.priorityMachine.off('STACK_CLEARED', onStackCleared));
    }

    // 3. RandomPerkEngine listening
    if (this.app.randomPerk && typeof this.app.randomPerk.on === 'function') {
      const onPerkRolled = (roll) => {
        if (this.isDestroyed) return;
        if (!roll?.isMiss) {
          this.triggerMilestone('MS_PERK_EMBLEM');
        }
      };
      this.app.randomPerk.on('PERK_ROLLED', onPerkRolled);
      this._unsubscribers.push(() => this.app.randomPerk.off('PERK_ROLLED', onPerkRolled));
    }

    // 4. TabletopStateManager listening (TRIGGER_TARGET_REQUIRED)
    const state = this.tabletopState;
    if (state && typeof state.on === 'function') {
      const onTriggerTarget = (payload) => {
        if (this.isDestroyed || !payload) return;
        if (payload.controllerId === this.slotId) {
          this.handleTriggerTargetRequired(payload);
        }
      };
      state.on('TRIGGER_TARGET_REQUIRED', onTriggerTarget);
      this._unsubscribers.push(() => {
        try { state.off?.('TRIGGER_TARGET_REQUIRED', onTriggerTarget); } catch (_) {}
      });
    }
  }

  /**
   * Binds event listeners when attached to remote RelayClient.
   * @private
   */
  _bindRelayListeners() {
    if (!this.relayClient) return;

    const onAction = (msg) => {
      if (this.isDestroyed) return;
      const action = msg?.action || msg;
      if (!action) return;

      if (action.type === 'STACK_ALARM_START' && action.targetPlayerId === this.slotId) {
        this.onStackAlarm(action);
      }
    };

    if (typeof this.relayClient.on === 'function') {
      this.relayClient.on('action', onAction);
      this._unsubscribers.push(() => this.relayClient.off?.('action', onAction));
    }
  }

  /**
   * Dispatches an action according to active transport mode (INV-PERKINS-2).
   * In Local Mode: dispatches to app with origin 'LOCAL_BOT' (suppresses external broadcast).
   * In Remote Mode: sends frame through relayClient.
   * 
   * @param {Object} action - Action descriptor
   * @returns {Promise<void>}
   */
  async dispatchAction(action) {
    if (this.isDestroyed || !action) return;

    if (this.mode === 'LOCAL' && this.app && typeof this.app.dispatchAction === 'function') {
      await this.app.dispatchAction(action, { origin: 'LOCAL_BOT' });
    } else if (this.mode === 'REMOTE' && this.relayClient && typeof this.relayClient.sendAction === 'function') {
      this.relayClient.sendAction(action);
    }
  }

  /**
   * Emits a tutorial coaching tip to Chit-Chat with 8s debounce (INV-PERKINS-7).
   * 
   * @param {string} milestoneKey - Milestone identifier
   * @returns {boolean} Whether message was successfully emitted
   */
  triggerMilestone(milestoneKey) {
    if (!this.coachEnabled || this.isDestroyed) return false;
    if (milestoneKey === 'MS_PRIORITY_HOTKEY' && this._spacebarTipShown) {
      return false;
    }

    const now = Date.now();
    if (this._lastCoachTimestamp && (now - this._lastCoachTimestamp < 8000)) {
      return false; // Suppressed by 8s debounce gate
    }

    const dialogue = PERKINS_COACH_DIALOGUES[milestoneKey];
    if (!dialogue) return false;

    const text = dialogue[this.language] || dialogue['es'];
    this._lastCoachTimestamp = now;
    this._completedMilestones.add(milestoneKey);
    if (milestoneKey === 'MS_PRIORITY_HOTKEY') {
      this._spacebarTipShown = true;
    }

    if (this.app?.dualChat && typeof this.app.dualChat.sendChitChat === 'function') {
      this.app.dualChat.sendChitChat(text, 'perkins_coach', 'Perkins Coach');
    } else if (this.app && typeof this.app.dispatchAction === 'function') {
      this.app.dispatchAction({
        type: 'SEND_CHIT_CHAT',
        payload: {
          text,
          senderId: 'perkins_coach',
          senderName: 'Perkins Coach'
        }
      }, { origin: 'LOCAL_BOT' });
    }

    return true;
  }

  _handleStackEmpty() {
    this._alarmActionCount = 0;
    this._currentEvaluationPromise = null;
  }

  /**
   * Evaluates stack alarm reaction within thinkingDelayMs (INV-PERKINS-4).
   * Evaluates whether to respond with instant or pass priority.
   * 
   * @param {Object} alarmState - State emitted by StackAlarmManager
   * @returns {Promise<Object|void>} Action dispatched
   */
  async onStackAlarm(alarmState) {
    if (this.isDestroyed) return;
    if (this.app?.pregameActive || this.app?.isRollOffActive) return;
    if (alarmState?.targetPlayerId && alarmState.targetPlayerId !== this.slotId) return;

    // Await an already running evaluation if one is in flight
    if (this._currentEvaluationPromise) {
      return await this._currentEvaluationPromise;
    }

    // 1. Concurrency Lock: Prevent parallel re-entrant executions (INV-BOT-THROTTLE-1)
    if (this._isEvaluating) {
      this._pendingAlarmEvent = alarmState || { targetPlayerId: this.slotId };
      return;
    }

    // 2. Throttle Guard: Maximum 1 instant reaction per stack event chain (INV-BOT-THROTTLE-1)
    if (this._alarmActionCount >= 1) {
      const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(passAction);
      return passAction;
    }

    this._isEvaluating = true;
    this._currentEvaluationPromise = (async () => {
      try {
        const executeAlarmReaction = async () => {
          if (this.isDestroyed) return;
          const state = this.getProjectedState();
          const myPlayer = state?.players?.[this.slotId];
          if (!myPlayer) {
            const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
            await this.dispatchAction(passAction);
            return passAction;
          }

          const handCards = Array.isArray(myPlayer.hand?.cards) ? myPlayer.hand.cards : (
            Array.isArray(myPlayer.hand) ? myPlayer.hand : []
          );
          const lands = myPlayer.battlefield?.lands || [];
          const untappedLands = lands.filter(l => !l.isTapped);
          const manaPool = myPlayer.resources?.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

          const topItem = state?.stack?.[state.stack.length - 1] || this.app?.priorityMachine?.peekStack() || null;
          if (!topItem) {
            return null;
          }

          // 1. Counterspell check: Top stack item is opponent spell & bot has Counterspell + {U}{U}
          const hasUU = (manaPool.U >= 2) || (untappedLands.length >= 2);
          const counterCard = handCards.find(c => c && !c.isHidden && /counterspell/i.test(c.name || ''));
          const isOpponentStackItem = topItem && (
            (topItem.sourcePlayerId && topItem.sourcePlayerId !== this.slotId) ||
            (topItem.controllerId && topItem.controllerId !== this.slotId) ||
            (topItem.ownerId && topItem.ownerId !== this.slotId)
          );

          if (counterCard && hasUU && isOpponentStackItem) {
            if ((manaPool.U || 0) < 2) {
              const neededU = 2 - (manaPool.U || 0);
              const landsToTap = untappedLands.slice(0, neededU);
              for (const land of landsToTap) {
                if (this.app?.tabletopState && typeof this.app.tabletopState.tapLandForMana === 'function') {
                  try { this.app.tabletopState.tapLandForMana(this.slotId, land.instanceId || land.id); } catch (_) {}
                }
                land.isTapped = true;
                await this.dispatchAction({
                  type: 'TAP_PERMANENT',
                  playerId: this.slotId,
                  instanceId: land.instanceId || land.id,
                  payload: { playerId: this.slotId, instanceId: land.instanceId || land.id }
                });
              }
            }

            this._alarmActionCount++;
            const castAction = {
              type: 'CAST_SPELL',
              playerId: this.slotId,
              controllerId: this.slotId,
              controllerName: this.playerName || 'Perkins AI (Bot)',
              card: counterCard,
              cardName: counterCard.name,
              targetId: topItem.id || topItem.instanceId || alarmState?.stackItemId,
              payload: {
                playerId: this.slotId,
                controllerId: this.slotId,
                controllerName: this.playerName || 'Perkins AI (Bot)',
                card: counterCard,
                cardName: counterCard.name,
                targetId: topItem.id || topItem.instanceId || alarmState?.stackItemId
              }
            };
            await this.dispatchAction(castAction);
            return castAction;
          }

        // 2. Lightning Bolt check: {R} available & opponent life <= 3 or creature toughness <= 3
        const hasR = (manaPool.R >= 1) || (untappedLands.length >= 1);
        const boltCard = handCards.find(c => c && !c.isHidden && /lightning bolt/i.test(c.name || ''));

        if (boltCard && hasR) {
          let boltTargetId = null;
          for (const [pId, p] of Object.entries(state.players || {})) {
            if (pId === this.slotId || p.isEliminated) continue;
            if ((p.resources?.life ?? 20) <= 3) {
              boltTargetId = pId;
              break;
            }
            const creatures = p.battlefield?.creatures || [];
            const killableCreature = creatures.find(c => (Number(c.toughness) || 0) <= 3);
            if (killableCreature) {
              boltTargetId = killableCreature.instanceId;
              break;
            }
          }

          if (boltTargetId) {
            if ((manaPool.R || 0) < 1 && untappedLands.length > 0) {
              const land = untappedLands[0];
              if (this.app?.tabletopState && typeof this.app.tabletopState.tapLandForMana === 'function') {
                try { this.app.tabletopState.tapLandForMana(this.slotId, land.instanceId || land.id); } catch (_) {}
              }
              land.isTapped = true;
              await this.dispatchAction({
                type: 'TAP_PERMANENT',
                playerId: this.slotId,
                instanceId: land.instanceId || land.id,
                payload: { playerId: this.slotId, instanceId: land.instanceId || land.id }
              });
            }

            this._alarmActionCount++;
            const castAction = {
              type: 'CAST_SPELL',
              playerId: this.slotId,
              controllerId: this.slotId,
              controllerName: this.playerName || 'Perkins AI (Bot)',
              card: boltCard,
              cardName: boltCard.name,
              targetId: boltTargetId,
              payload: {
                playerId: this.slotId,
                controllerId: this.slotId,
                controllerName: this.playerName || 'Perkins AI (Bot)',
                card: boltCard,
                cardName: boltCard.name,
                targetId: boltTargetId
              }
            };
            await this.dispatchAction(castAction);
            return castAction;
          }
        }

        // 3. Fatal Push check: {B} available & opponent creature CMC <= 2
        const hasB = (manaPool.B >= 1) || (untappedLands.length >= 1);
        const pushCard = handCards.find(c => c && !c.isHidden && /fatal push/i.test(c.name || ''));

        if (pushCard && hasB) {
          let pushTargetId = null;
          for (const [pId, p] of Object.entries(state.players || {})) {
            if (pId === this.slotId || p.isEliminated) continue;
            const creatures = p.battlefield?.creatures || [];
            const pushable = creatures.find(c => (Number(c.cmc ?? this._parseCmc(c.manaCost)) || 0) <= 2);
            if (pushable) {
              pushTargetId = pushable.instanceId;
              break;
            }
          }

          if (pushTargetId) {
            if ((manaPool.B || 0) < 1 && untappedLands.length > 0) {
              const land = untappedLands[0];
              if (this.app?.tabletopState && typeof this.app.tabletopState.tapLandForMana === 'function') {
                try { this.app.tabletopState.tapLandForMana(this.slotId, land.instanceId || land.id); } catch (_) {}
              }
              land.isTapped = true;
              await this.dispatchAction({
                type: 'TAP_PERMANENT',
                playerId: this.slotId,
                instanceId: land.instanceId || land.id,
                payload: { playerId: this.slotId, instanceId: land.instanceId || land.id }
              });
            }

            this._alarmActionCount++;
            const castAction = {
              type: 'CAST_SPELL',
              playerId: this.slotId,
              controllerId: this.slotId,
              controllerName: this.playerName || 'Perkins AI (Bot)',
              card: pushCard,
              cardName: pushCard.name,
              targetId: pushTargetId,
              payload: {
                playerId: this.slotId,
                controllerId: this.slotId,
                controllerName: this.playerName || 'Perkins AI (Bot)',
                card: pushCard,
                cardName: pushCard.name,
                targetId: pushTargetId
              }
            };
            await this.dispatchAction(castAction);
            return castAction;
          }
        }

        // 4. Default Clean Pass
        const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
        await this.dispatchAction(passAction);
        return passAction;
      };

      if (this.thinkingDelayMs > 0) {
        return await new Promise((resolve) => {
          const timerId = setTimeout(async () => {
            this._activeTimers.delete(timerId);
            const res = await executeAlarmReaction();
            resolve(res);
          }, this.thinkingDelayMs);
          this._activeTimers.add(timerId);
        });
      } else {
        return await executeAlarmReaction();
      }
    } finally {
      this._isEvaluating = false;
      this._currentEvaluationPromise = null;
      this._schedulePendingIfNeeded();
    }
    })();

    return await this._currentEvaluationPromise;
  }

  /**
   * Schedules any queued phase evaluation or stack alarm reaction once current evaluation yields (INV-TURN-ROTATION-3).
   * @private
   */
  _schedulePendingIfNeeded() {
    if (this.isDestroyed || this._isEvaluating) return;
    const psm = this.app?.priorityMachine;
    if (!psm || psm.priorityPlayerId !== this.slotId) {
      this._pendingEvaluation = false;
      this._pendingAlarmEvent = null;
      return;
    }
    const stackDepth = typeof psm.getStackDepth === 'function' ? psm.getStackDepth() : (psm.stack?.length || 0);
    if (stackDepth > 0) {
      const evt = this._pendingAlarmEvent || { targetPlayerId: this.slotId, stackItemId: psm.peekStack?.()?.id };
      this._pendingAlarmEvent = null;
      this._pendingEvaluation = false;
      const t = setTimeout(() => {
        this._activeTimers.delete(t);
        if (!this.isDestroyed && psm.priorityPlayerId === this.slotId && (psm.stack?.length || 0) > 0) {
          this.onStackAlarm(evt);
        }
      }, 0);
      this._activeTimers.add(t);
    } else if (stackDepth === 0) {
      this._pendingEvaluation = false;
      this._pendingAlarmEvent = null;
      const t = setTimeout(() => {
        this._activeTimers.delete(t);
        if (!this.isDestroyed && psm.priorityPlayerId === this.slotId && (psm.stack?.length || 0) === 0) {
          this.evaluateTurnPhase(psm.currentPhaseStep);
        }
      }, 0);
      this._activeTimers.add(t);
    }
  }

  /**
   * Returns an array of mana symbols (['W', 'U', 'B', 'R', 'G', 'C']) that `land` can produce.
   *
   * @param {Object} land
   * @param {Object} [myState=null]
   * @returns {string[]}
   */
  getLandProducedColors(land, myState = null) {
    if (!land) return [];
    const produced = new Set();

    if (Array.isArray(land.producedMana)) {
      for (const m of land.producedMana) if (m) produced.add(String(m).toUpperCase());
    }
    if (Array.isArray(land.colors)) {
      for (const c of land.colors) if (c) produced.add(String(c).toUpperCase());
    }

    const tLine = String(land.typeLine || land.type || land.name || '').toLowerCase();
    const oText = String(land.oracleText || land.text || '').toLowerCase();
    const name = String(land.name || '').toLowerCase();

    // Mana Confluence / Starting Town = any color
    if (/mana confluence|starting town/i.test(name) || /mana confluence|starting town/i.test(tLine) || /any color/i.test(oText)) {
      return ['W', 'U', 'B', 'R', 'G', 'C'];
    }

    // Spire of Industry = {C} or any color if you control an artifact
    if (/spire of industry/i.test(name) || /spire of industry/i.test(tLine)) {
      const state = myState || this.getProjectedState();
      const me = state?.players?.[this.slotId] || state;
      const noncreatures = me?.battlefield?.noncreatures || [];
      const creatures = me?.battlefield?.creatures || [];
      const hasArtifact = [...noncreatures, ...creatures].some(c =>
        c && c !== land && /artifact/i.test(String(c.typeLine || c.type || ''))
      );
      if (hasArtifact) {
        return ['W', 'U', 'B', 'R', 'G', 'C'];
      }
      return ['C'];
    }

    // Inkmoth Nexus = {C}
    if (/inkmoth nexus/i.test(name) || /inkmoth nexus/i.test(tLine)) {
      produced.add('C');
      return Array.from(produced);
    }

    // Basic subtypes
    if (/plains/i.test(tLine)) produced.add('W');
    if (/island/i.test(tLine)) produced.add('U');
    if (/swamp/i.test(tLine)) produced.add('B');
    if (/mountain/i.test(tLine)) produced.add('R');
    if (/forest/i.test(tLine)) produced.add('G');
    if (/wastes/i.test(tLine)) produced.add('C');

    // Duals via oracle {T}: Add {X} or {Y}
    if (oText.includes('add')) {
      if (/add\s+[^.]*\{w\}/i.test(oText)) produced.add('W');
      if (/add\s+[^.]*\{u\}/i.test(oText)) produced.add('U');
      if (/add\s+[^.]*\{b\}/i.test(oText)) produced.add('B');
      if (/add\s+[^.]*\{r\}/i.test(oText)) produced.add('R');
      if (/add\s+[^.]*\{g\}/i.test(oText)) produced.add('G');
      if (/add\s+[^.]*\{c\}/i.test(oText)) produced.add('C');
    }

    if (produced.size === 0) {
      if (/plains/i.test(name)) produced.add('W');
      else if (/island/i.test(name)) produced.add('U');
      else if (/swamp/i.test(name)) produced.add('B');
      else if (/mountain/i.test(name)) produced.add('R');
      else if (/forest/i.test(name)) produced.add('G');
      else if (/wastes/i.test(name)) produced.add('C');
      else {
        // Fallback for test mock lands without explicit subtype/colors
        return ['W', 'U', 'B', 'R', 'G', 'C'];
      }
    }

    return Array.from(produced);
  }

  /**
   * Computes a payment plan for `card`, assigning untapped lands to colored symbols first
   * (most constrained first), then generic mana.
   *
   * @param {Object} card
   * @param {Object} [myState=null]
   * @returns {{ affordable: boolean, landsToTap: Object[] }}
   */
  getPaymentPlan(card, myState = null) {
    if (!card) return { affordable: false, landsToTap: [] };

    const state = myState || this.getProjectedState()?.players?.[this.slotId] || this.getProjectedState();
    const rawPool = state?.resources?.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    const pool = {
      W: Number(rawPool.W) || 0,
      U: Number(rawPool.U) || 0,
      B: Number(rawPool.B) || 0,
      R: Number(rawPool.R) || 0,
      G: Number(rawPool.G) || 0,
      C: Number(rawPool.C) || 0
    };

    const lands = Array.isArray(state?.battlefield?.lands) ? state.battlefield.lands : [];
    const availableLands = lands.filter(l => l && !l.isTapped);

    const costStr = String(card.manaCost || '');
    const symbols = (costStr.match(/\{([^}]+)\}/g) || []).map(s => s.slice(1, -1).toUpperCase());

    const neededColors = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    let neededGeneric = 0;

    for (const sym of symbols) {
      if (neededColors[sym] !== undefined) {
        neededColors[sym]++;
      } else {
        const num = parseInt(sym, 10);
        if (!isNaN(num)) {
          neededGeneric += num;
        }
      }
    }

    let computedX = null;
    const isSecureTheWastes = /secure the wastes/i.test(card.name || '');
    if (isSecureTheWastes || symbols.includes('X')) {
      const totalAvailableMana = availableLands.length + Object.values(pool).reduce((s, v) => s + (Number(v) || 0), 0);
      computedX = card.xValue !== undefined ? Number(card.xValue) : Math.max(1, totalAvailableMana - 1);
      neededGeneric += computedX;
    }

    // 1. Pay colored requirements from existing floating mana pool first
    for (const color of ['W', 'U', 'B', 'R', 'G', 'C']) {
      if (neededColors[color] > 0 && pool[color] > 0) {
        const paid = Math.min(neededColors[color], pool[color]);
        neededColors[color] -= paid;
        pool[color] -= paid;
      }
    }

    const landsToTap = [];
    const remainingLands = [...availableLands];

    // Helper: list of colors each remaining land can produce
    const landColorMap = new Map();
    for (const land of remainingLands) {
      landColorMap.set(land, this.getLandProducedColors(land, state));
    }

    // 2. Pay remaining colored requirements from lands: most constrained first
    while (Object.values(neededColors).some(n => n > 0)) {
      const activeColors = Object.keys(neededColors).filter(c => neededColors[c] > 0);
      if (activeColors.length === 0) break;

      const colorCandidateCounts = activeColors.map(c => {
        const count = remainingLands.filter(l => landColorMap.get(l).includes(c)).length;
        return { color: c, count };
      });

      // Sort by fewest candidates first (most constrained)
      colorCandidateCounts.sort((a, b) => a.count - b.count);
      const targetColor = colorCandidateCounts[0].color;

      const matchingLands = remainingLands.filter(l => landColorMap.get(l).includes(targetColor));
      if (matchingLands.length === 0) {
        return { affordable: false, landsToTap: [] };
      }

      matchingLands.sort((a, b) => landColorMap.get(a).length - landColorMap.get(b).length);
      const chosenLand = matchingLands[0];

      landsToTap.push(chosenLand);
      const idx = remainingLands.indexOf(chosenLand);
      if (idx !== -1) remainingLands.splice(idx, 1);
      neededColors[targetColor]--;
    }

    // 3. Pay generic mana requirement: first from remaining pool, then remaining lands
    if (neededGeneric > 0) {
      const remainingPoolTotal = Object.values(pool).reduce((sum, n) => sum + (Number(n) || 0), 0);
      const fromPool = Math.min(neededGeneric, remainingPoolTotal);
      neededGeneric -= fromPool;

      if (neededGeneric > 0) {
        if (remainingLands.length < neededGeneric) {
          return { affordable: false, landsToTap: [] };
        }
        for (let i = 0; i < neededGeneric; i++) {
          landsToTap.push(remainingLands[i]);
        }
      }
    }

    return { affordable: true, landsToTap, xValue: computedX };
  }

  /**
   * Checks if Perkins can afford the colors and generic cost of `card`.
   *
   * @param {Object} card
   * @param {Object} [myState=null]
   * @returns {boolean}
   */
  canAffordCardColors(card, myState = null) {
    return this.getPaymentPlan(card, myState).affordable;
  }

  /**
   * Core turn phase evaluator. Executes in <1ms (INV-PERKINS-1).
   * Enforces Fog-of-War (INV-PERKINS-3), anti-hang (INV-SAFE-1), and deckout concession (INV-SAFE-2).
   * 
   * @param {string} phaseStep - Current MTG phase/step
   * @param {Object} [injectedState=null] - Optional injected state (for benchmarking/testing)
   * @returns {Promise<Object|null>} Action taken or null
   */
  async evaluateTurnPhase(phaseStep, injectedState = null) {
    if (this.isDestroyed) return null;
    if (this.app?.pregameActive || this.app?.isRollOffActive) return null;
    if (this._isEvaluating) {
      // Re-entrancy (e.g. our own PASS_PRIORITY rotated the turn synchronously): do not drop the
      // new phase; remember it and re-evaluate once the current evaluation yields (INV-TURN-ROTATION-3).
      this._pendingEvaluation = true;
      return null;
    }
    this._isEvaluating = true;
    try {
      // Handle injected TabletopStateManager instance
      let state = injectedState;
    if (state instanceof TabletopStateManager || (state && typeof state.projectState === 'function')) {
      state = state.projectState(this.slotId);
    } else if (!state) {
      state = this.getProjectedState();
    }

    const activePlayerId = state?.activePlayerId || this.app?.priorityMachine?.activePlayerId || this.slotId;
    const isMyTurn = (activePlayerId === this.slotId);

    // Anti-hang guard: INV-SAFE-1 (max 10 actions per phase)
    if (this._lastPhaseStep !== phaseStep) {
      this._phaseActionCount = 0;
      this._lastPhaseStep = phaseStep;
      if (phaseStep === 'CLEANUP') {
        this._hasPlayedLandThisTurn = false;
      }
    }

    this._phaseActionCount++;
    if (this._phaseActionCount >= 10) {
      const forcedPass = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(forcedPass);
      return forcedPass;
    }

    // Phase 1: UNTAP (CR 502)
    if (phaseStep === 'UNTAP') {
      if (isMyTurn) {
        this._hasPlayedLandThisTurn = false;
        const myPlayer = this.app?.tabletopState?.players?.[this.slotId];
        if (myPlayer) {
          const bf = myPlayer.battlefield || {};
          for (const subzone of ['lands', 'creatures', 'noncreatures', 'planeswalkers']) {
            for (const card of (bf[subzone] || [])) {
              card.isTapped = false;
              card.isSummoningSick = false;
            }
          }
        }
      }
      const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(passAction);
      return passAction;
    }

    // Phase 2: UPKEEP (CR 503)
    if (phaseStep === 'UPKEEP') {
      const turnNumber = state?.turnNumber || this.app?.priorityMachine?.turnNumber || 1;
      const initialPlayers = this.app?.playerIds?.length || Object.keys(state?.players || {}).length || 2;
      const unlockTurn = initialPlayers >= 3 ? 2 : 4;

      if (turnNumber >= unlockTurn && this.app?.randomPerk) {
        this.triggerMilestone('MS_PERK_EMBLEM');
      }
      const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(passAction);
      return passAction;
    }

    // Phase 3: DRAW (CR 504 & INV-SAFE-2 Deckout Concession)
    if (phaseStep === 'DRAW') {
      const myState = state?.players?.[this.slotId];
      const libraryCount = myState?.library?.count ?? (
        Array.isArray(myState?.zones?.library) ? myState.zones.library.length : (
          Array.isArray(myState?.library) ? myState.library.length : 0
        )
      );

      if (libraryCount === 0) {
        const concedeAction = {
          type: 'PLAYER_CONCEDED',
          playerId: this.slotId,
          reason: 'DECKOUT_EMPTY_LIBRARY',
          payload: {
            playerId: this.slotId,
            player: this.slotId,
            reason: 'DECKOUT_EMPTY_LIBRARY'
          }
        };
        await this.dispatchAction(concedeAction);
        return concedeAction;
      }

      const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(passAction);
      return passAction;
    }

    // Phase 4: PRECOMBAT_MAIN / POSTCOMBAT_MAIN (CR 505)
    if (phaseStep === 'PRECOMBAT_MAIN' || phaseStep === 'POSTCOMBAT_MAIN') {
      const myState = state?.players?.[this.slotId];
      const handCards = Array.isArray(myState?.hand?.cards) ? myState.hand.cards : (
        Array.isArray(myState?.hand) ? myState.hand : (
          Array.isArray(myState?.zones?.hand) ? myState.zones.hand : []
        )
      );

      if (isMyTurn) {
        // 1. Play Land if not yet played this turn
        const canPlayLand = !this._hasPlayedLandThisTurn &&
          (myState?.resources?.landsPlayedThisTurn ?? 0) < 1 &&
          (myState?.landsPlayedThisTurn ?? 0) < 1;

        if (canPlayLand) {
          const landCard = handCards.find(c => c && !c.isHidden && /land/i.test(c.typeLine || c.type || ''));
          if (landCard) {
            this._hasPlayedLandThisTurn = true;
            const playLandAction = {
              type: 'PLAY_LAND',
              playerId: this.slotId,
              card: landCard,
              payload: {
                playerId: this.slotId,
                card: landCard,
                instanceId: landCard.instanceId
              }
            };
            await this.dispatchAction(playLandAction);
            // Still holding priority with an empty stack: continue the phase (cast or pass) instead of stalling.
            this._pendingEvaluation = true;
            return playLandAction;
          }
        }

        // 2. Cast Spells (Creatures, Artifacts, Equipment, Enchantments, Sorceries, Instants)
        const castableSpells = [];
        for (const card of handCards) {
          if (!card || card.isHidden) continue;
          const type = String(card.typeLine || card.type || '');
          if (!/creature|sorcery|instant|artifact|enchantment|equipment/i.test(type)) continue;

          const plan = this.getPaymentPlan(card, myState);
          if (!plan.affordable) continue;

          let target = null;
          if (/instant|sorcery/i.test(type)) {
            const needsTarget = Boolean(
              (card.groundedEffects && card.groundedEffects.length > 0) ||
              card.action ||
              /target/i.test(card.oracleText || card.text || '')
            );
            if (needsTarget) {
              target = this.selectLegalSpellTarget(card, this.tabletopState || this.app?.tabletopState);
              if (!target) continue;
            }
          }

          castableSpells.push({ card, plan, target });
        }

        if (castableSpells.length > 0) {
          castableSpells.sort((a, b) => {
            const cmcA = a.card.cmc ?? this._parseCmc(a.card.manaCost);
            const cmcB = b.card.cmc ?? this._parseCmc(b.card.manaCost);
            return cmcB - cmcA;
          });
          const { card: cardToCast, plan, target: chosenTarget } = castableSpells[0];
          const isSecureTheWastes = /secure the wastes/i.test(cardToCast.name || '');
          const computedX = plan.xValue !== undefined && plan.xValue !== null
            ? plan.xValue
            : (isSecureTheWastes ? Math.max(1, ((myState?.battlefield?.lands || []).filter(l => !l.isTapped).length || 1) - 1) : null);

          // Tap chosen lands via engine
          for (const landToTap of plan.landsToTap) {
            if (this.app?.tabletopState && typeof this.app.tabletopState.tapLandForMana === 'function') {
              try { this.app.tabletopState.tapLandForMana(this.slotId, landToTap.instanceId || landToTap.id); } catch (_) {}
            }
            landToTap.isTapped = true;
            await this.dispatchAction({
              type: 'TAP_PERMANENT',
              playerId: this.slotId,
              instanceId: landToTap.instanceId || landToTap.id,
              payload: {
                playerId: this.slotId,
                instanceId: landToTap.instanceId || landToTap.id
              }
            });
          }

          const castAction = {
            type: 'CAST_SPELL',
            playerId: this.slotId,
            controllerId: this.slotId,
            controllerName: this.playerName || 'Perkins AI (Bot)',
            card: cardToCast,
            cardName: cardToCast.name,
            manaAlreadyPaid: true,
            targetId: chosenTarget?.targetId || null,
            targetType: chosenTarget?.targetType || null,
            ...(computedX !== null ? { xValue: computedX } : {}),
            payload: {
              playerId: this.slotId,
              controllerId: this.slotId,
              controllerName: this.playerName || 'Perkins AI (Bot)',
              card: cardToCast,
              cardName: cardToCast.name,
              instanceId: cardToCast.instanceId,
              manaAlreadyPaid: true,
              targetId: chosenTarget?.targetId || null,
              targetType: chosenTarget?.targetType || null,
              target: chosenTarget?.targetId || null,
              ...(computedX !== null ? { xValue: computedX } : {})
            }
          };
          await this.dispatchAction(castAction);
          this._pendingEvaluation = true;
          return castAction;
        }

        // 3. Activate Equip in main phase when Perkins has an unattached Equipment + creature and can afford it
        const noncreatures = myState?.battlefield?.noncreatures || [];
        const myCreatures = (myState?.battlefield?.creatures || []).filter(c => c && !c.isDead);

        if (myCreatures.length > 0) {
          const unattachedEquipment = noncreatures.filter(card => {
            if (!card) return false;
            const isEquip = /equipment/i.test(card.typeLine || card.type || '') || card.subtype === 'Equipment';
            if (!isEquip) return false;
            return !card.attachedTo && !card.attachedToCreatureId && !card.isAttached;
          });

          if (unattachedEquipment.length > 0) {
            const sortedCreatures = [...myCreatures].sort((a, b) => {
              const pA = Number(a.power ?? 0);
              const pB = Number(b.power ?? 0);
              if (pB !== pA) return pB - pA;
              return Number(b.toughness ?? 0) - Number(a.toughness ?? 0);
            });
            const targetCreature = sortedCreatures[0];

            for (const equip of unattachedEquipment) {
              const stateRef = this.tabletopState || this.app?.tabletopState;
              let effectiveCostStr = '{0}';
              if (stateRef && typeof stateRef.computeEquipCost === 'function') {
                try {
                  effectiveCostStr = stateRef.computeEquipCost(this.slotId, equip, targetCreature);
                } catch (_) {
                  effectiveCostStr = equip.compiledMechanics?.equipCost || equip.equipCost || '{1}';
                }
              } else {
                effectiveCostStr = equip.compiledMechanics?.equipCost || equip.equipCost || '{1}';
              }

              const isFree = effectiveCostStr === '{0}';
              const equipPlan = isFree ? { affordable: true, landsToTap: [] } : this.getPaymentPlan({ manaCost: effectiveCostStr }, myState);

              if (equipPlan.affordable) {
                const equipAction = {
                  type: 'ACTIVATE_EQUIP',
                  playerId: this.slotId,
                  equipmentId: equip.instanceId || equip.id,
                  targetCreatureId: targetCreature.instanceId || targetCreature.id,
                  payload: {
                    playerId: this.slotId,
                    equipmentId: equip.instanceId || equip.id,
                    targetCreatureId: targetCreature.instanceId || targetCreature.id,
                    isFree
                  }
                };

                if (stateRef && typeof stateRef.activateEquipAbility === 'function') {
                  try {
                    stateRef.activateEquipAbility(this.slotId, equip.instanceId || equip.id, targetCreature.instanceId || targetCreature.id, { isFree });
                  } catch (_) {}
                }
                await this.dispatchAction(equipAction);
                this._pendingEvaluation = true;
                return equipAction;
              }
            }
          }
        }

        // 4. Caretaker's Talent Level Up
        const talent = noncreatures.find(c => /caretaker's talent/i.test(c?.name || ''));
        const stateRef = this.tabletopState || this.app?.tabletopState;
        if (talent) {
          const currentLvl = talent.classLevel || talent.level || 1;
          const levelCost = currentLvl === 1 ? '{W}' : (currentLvl === 2 ? '{3}{W}' : null);
          if (levelCost) {
            const levelPlan = this.getPaymentPlan({ manaCost: levelCost }, myState);
            if (levelPlan.affordable) {
              for (const landToTap of levelPlan.landsToTap) {
                if (stateRef && typeof stateRef.tapLandForMana === 'function') {
                  try { stateRef.tapLandForMana(this.slotId, landToTap.instanceId || landToTap.id); } catch (_) {}
                }
                landToTap.isTapped = true;
                await this.dispatchAction({
                  type: 'TAP_PERMANENT',
                  playerId: this.slotId,
                  instanceId: landToTap.instanceId || landToTap.id,
                  payload: { playerId: this.slotId, instanceId: landToTap.instanceId || landToTap.id }
                });
              }
              if (stateRef && typeof stateRef.levelUpClass === 'function') {
                try { stateRef.levelUpClass(this.slotId, talent.instanceId || talent.id); } catch (_) {}
              }
              const levelAction = {
                type: 'LEVEL_UP_CLASS',
                playerId: this.slotId,
                instanceId: talent.instanceId || talent.id,
                payload: {
                  playerId: this.slotId,
                  instanceId: talent.instanceId || talent.id,
                  targetLevel: currentLvl + 1
                }
              };
              await this.dispatchAction(levelAction);
              this._pendingEvaluation = true;
              return levelAction;
            }
          }
        }

        // 5. Castle Ardenvale Activation (main phase)
        const myLands = myState?.battlefield?.lands || [];
        const castle = myLands.find(l => !l.isTapped && /castle ardenvale/i.test(l?.name || ''));
        if (castle) {
          const otherLands = myLands.filter(l => !l.isTapped && (l.instanceId || l.id) !== (castle.instanceId || castle.id));
          const totalOtherMana = otherLands.length + Object.values(myState?.resources?.manaPool || {}).reduce((s, v) => s + (Number(v) || 0), 0);
          if ((handCards.length === 0 || totalOtherMana >= 4) && totalOtherMana >= 4) {
            const ardenPlan = this.getPaymentPlan({ manaCost: '{2}{W}{W}' }, {
              ...myState,
              battlefield: { ...myState.battlefield, lands: otherLands }
            });
            if (ardenPlan.affordable) {
              castle.isTapped = true;
              await this.dispatchAction({
                type: 'TAP_PERMANENT',
                playerId: this.slotId,
                instanceId: castle.instanceId || castle.id,
                payload: { playerId: this.slotId, instanceId: castle.instanceId || castle.id }
              });
              for (const landToTap of ardenPlan.landsToTap) {
                if (stateRef && typeof stateRef.tapLandForMana === 'function') {
                  try { stateRef.tapLandForMana(this.slotId, landToTap.instanceId || landToTap.id); } catch (_) {}
                }
                landToTap.isTapped = true;
                await this.dispatchAction({
                  type: 'TAP_PERMANENT',
                  playerId: this.slotId,
                  instanceId: landToTap.instanceId || landToTap.id,
                  payload: { playerId: this.slotId, instanceId: landToTap.instanceId || landToTap.id }
                });
              }
              if (stateRef) {
                if (typeof stateRef.activateCastleArdenvale === 'function') {
                  try { stateRef.activateCastleArdenvale(this.slotId, castle.instanceId || castle.id); } catch (_) {}
                } else if (typeof stateRef.activateAbility === 'function') {
                  try { stateRef.activateAbility(this.slotId, castle.instanceId || castle.id, 'token'); } catch (_) {}
                } else if (typeof stateRef.addCardToZone === 'function') {
                  try {
                    stateRef.addCardToZone(this.slotId, 'battlefield', {
                      instanceId: `token_human_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                      name: 'Human Token',
                      typeLine: 'Creature — Human',
                      power: 1,
                      toughness: 1,
                      isToken: true,
                      colors: ['W']
                    });
                  } catch (_) {}
                }
              }
              const ardenvaleAction = {
                type: 'ACTIVATE_ABILITY',
                playerId: this.slotId,
                sourceId: castle.instanceId || castle.id,
                abilityName: 'Create 1/1 white Human creature token',
                payload: {
                  playerId: this.slotId,
                  sourceId: castle.instanceId || castle.id,
                  abilityName: 'Create 1/1 white Human creature token'
                }
              };
              await this.dispatchAction(ardenvaleAction);
              this._pendingEvaluation = true;
              return ardenvaleAction;
            }
          }
        }
      }

      // If no sorcery speed actions, pass priority
      const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(passAction);
      return passAction;
    }

    // Phase 5: COMBAT PHASES (CR 507-511)
    if (phaseStep === 'BEGIN_COMBAT' || phaseStep === 'COMBAT_DAMAGE' || phaseStep === 'END_COMBAT') {
      const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(passAction);
      return passAction;
    }

    if (phaseStep === 'COMBAT' || phaseStep === 'DECLARE_ATTACKERS') {
      const isActive = (state?.activePlayerId === this.slotId) ||
        (this.app?.priorityMachine?.activePlayerId === this.slotId);

      const alreadyDeclared = (this.app?.tabletopState?.combatState?.attackers?.length || 0) > 0;
      if (isActive && !alreadyDeclared) {
        const attackers = this.evaluateCombatAttacks(state);
        if (attackers.length > 0) {
          const attackAction = {
            type: 'DECLARE_ATTACKERS',
            playerId: this.slotId,
            attackers,
            payload: {
              playerId: this.slotId,
              attackers
            }
          };
          await this.dispatchAction(attackAction);
          this._pendingEvaluation = true;
          return attackAction;
        }
      }
      const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(passAction);
      return passAction;
    }

    if (phaseStep === 'DECLARE_BLOCKERS') {
      const isDefending = (state?.activePlayerId !== this.slotId);
      const alreadyBlocked = Boolean(this.app?.tabletopState?.combatState?.blockersDeclared) ||
        (this.app?.tabletopState?.combatState?.blockers?.length || 0) > 0;
      if (isDefending && !alreadyBlocked) {
        const allRawAttackers = state?.combat?.attackers ||
          (this.app?.tabletopState?.combatState?.attackers || []).map(a => a?.creature || a).filter(Boolean);
        const rawAttackers = allRawAttackers.filter(a => !a.defendingPlayerId || a.defendingPlayerId === this.slotId);
        if (rawAttackers.length > 0) {
          const blocks = this.evaluateCombatBlocks(state, rawAttackers);
          if (blocks.length > 0) {
            const blockAction = {
              type: 'DECLARE_BLOCKERS',
              playerId: this.slotId,
              blocks,
              payload: {
                playerId: this.slotId,
                blocks
              }
            };
            await this.dispatchAction(blockAction);
            this._pendingEvaluation = true;
            return blockAction;
          }
        }
      }
      if (this.app?.priorityMachine && this.app.priorityMachine.priorityPlayerId !== this.slotId) {
        return null;
      }
      const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(passAction);
      return passAction;
    }

    // Phase 6: END_STEP & CLEANUP (CR 513-514)
    if (phaseStep === 'END_STEP' || phaseStep === 'CLEANUP') {
      this._hasPlayedLandThisTurn = false;
      if (phaseStep === 'END_STEP') {
        const myState = state?.players?.[this.slotId];
        const myLands = myState?.battlefield?.lands || [];
        const castle = myLands.find(l => !l.isTapped && /castle ardenvale/i.test(l?.name || ''));
        if (castle) {
          const otherLands = myLands.filter(l => !l.isTapped && (l.instanceId || l.id) !== (castle.instanceId || castle.id));
          const totalOtherMana = otherLands.length + Object.values(myState?.resources?.manaPool || {}).reduce((s, v) => s + (Number(v) || 0), 0);
          if (totalOtherMana >= 4) {
            const ardenPlan = this.getPaymentPlan({ manaCost: '{2}{W}{W}' }, {
              ...myState,
              battlefield: { ...myState.battlefield, lands: otherLands }
            });
            if (ardenPlan.affordable) {
              const stateRef = this.tabletopState || this.app?.tabletopState;
              castle.isTapped = true;
              await this.dispatchAction({
                type: 'TAP_PERMANENT',
                playerId: this.slotId,
                instanceId: castle.instanceId || castle.id,
                payload: { playerId: this.slotId, instanceId: castle.instanceId || castle.id }
              });
              for (const landToTap of ardenPlan.landsToTap) {
                if (stateRef && typeof stateRef.tapLandForMana === 'function') {
                  try { stateRef.tapLandForMana(this.slotId, landToTap.instanceId || landToTap.id); } catch (_) {}
                }
                landToTap.isTapped = true;
                await this.dispatchAction({
                  type: 'TAP_PERMANENT',
                  playerId: this.slotId,
                  instanceId: landToTap.instanceId || landToTap.id,
                  payload: { playerId: this.slotId, instanceId: landToTap.instanceId || landToTap.id }
                });
              }
              if (stateRef) {
                if (typeof stateRef.activateCastleArdenvale === 'function') {
                  try { stateRef.activateCastleArdenvale(this.slotId, castle.instanceId || castle.id); } catch (_) {}
                } else if (typeof stateRef.activateAbility === 'function') {
                  try { stateRef.activateAbility(this.slotId, castle.instanceId || castle.id, 'token'); } catch (_) {}
                } else if (typeof stateRef.addCardToZone === 'function') {
                  try {
                    stateRef.addCardToZone(this.slotId, 'battlefield', {
                      instanceId: `token_human_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                      name: 'Human Token',
                      typeLine: 'Creature — Human',
                      power: 1,
                      toughness: 1,
                      isToken: true,
                      colors: ['W']
                    });
                  } catch (_) {}
                }
              }
              const ardenvaleAction = {
                type: 'ACTIVATE_ABILITY',
                playerId: this.slotId,
                sourceId: castle.instanceId || castle.id,
                abilityName: 'Create 1/1 white Human creature token',
                payload: {
                  playerId: this.slotId,
                  sourceId: castle.instanceId || castle.id,
                  abilityName: 'Create 1/1 white Human creature token'
                }
              };
              await this.dispatchAction(ardenvaleAction);
              this._pendingEvaluation = true;
              return ardenvaleAction;
            }
          }
        }
      }
      const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(passAction);
      return passAction;
    }

    // Default fallback pass
    const defaultPass = { type: 'PASS_PRIORITY', playerId: this.slotId };
    await this.dispatchAction(defaultPass);
    return defaultPass;
    } finally {
      this._isEvaluating = false;
      this._schedulePendingIfNeeded();
    }
  }

  async _executePrecombatMainPhase(state = null) {
    return this.evaluateTurnPhase('PRECOMBAT_MAIN', state);
  }

  async _executePostcombatMainPhase(state = null) {
    return this.evaluateTurnPhase('POSTCOMBAT_MAIN', state);
  }

   /**
   * Assigns a custom or preconstructed deck to this Perkins Bot instance [P39].
   * @param {Object|null} deckData
   * @returns {Object|null}
   */
  setAssignedDeck(deckData) {
    this.assignedDeck = deckData || null;
    this.starterDeck = this.assignedDeck;
    return this.assignedDeck;
  }

  /**
   * Selects the optimal opponent to attack or target in multiplayer [P41].
   * Prioritizes living opponent who:
   * 1) Is in imminent lethal range (life <= totalAttackPower or poison + totalInfectPower >= 10)
   * 2) Has lowest defense / highest threat on board.
   * 
   * @param {Object} [state=null]
   * @param {Array<Object|string>} [attackers=[]]
   * @returns {string|null} Target opponent playerId
   */
  selectBestAttackTargetPlayer(state = null, attackers = []) {
    if (!state) state = this.getProjectedState();
    const livingOpponents = Object.entries(state?.players || {}).filter(([pId, p]) =>
      pId !== this.slotId && !p.isEliminated
    );
    if (livingOpponents.length === 0) return null;
    if (livingOpponents.length === 1) return livingOpponents[0][0];

    let totalAttackPower = 0;
    let totalInfectPower = 0;
    const myPlayer = state?.players?.[this.slotId];
    const myCreatures = myPlayer?.battlefield?.creatures || [];

    for (const a of attackers) {
      const card = typeof a === 'object'
        ? a
        : myCreatures.find(c => c && (c.instanceId === a || c.id === a));
      if (!card) continue;
      const p = Number(card.effectivePower ?? card.power) || 0;
      const isInfect = Boolean(
        card.keywords?.infect ||
        card.keywords?.Infect ||
        /infect/i.test(card.oracleText || card.text || '') ||
        /inkmoth nexus/i.test(card.name || '')
      );
      if (isInfect) {
        totalInfectPower += p;
      } else {
        totalAttackPower += p;
      }
    }

    // 1) Imminent lethal range check
    for (const [oppId, opp] of livingOpponents) {
      const life = opp.resources?.life ?? 20;
      const poison = opp.resources?.poison ?? opp.poisonCounters ?? 0;
      const isLethalLife = totalAttackPower > 0 && life <= totalAttackPower;
      const isLethalPoison = totalInfectPower > 0 && (poison + totalInfectPower) >= 10;
      if (isLethalLife || isLethalPoison) {
        return oppId;
      }
    }

    // 2) Score opponents by threat on board and defense
    let bestOppId = livingOpponents[0][0];
    let bestScore = -Infinity;

    for (const [oppId, opp] of livingOpponents) {
      const life = opp.resources?.life ?? 20;
      const poison = opp.resources?.poison ?? opp.poisonCounters ?? 0;
      const creatures = opp.battlefield?.creatures || [];
      const untappedBlockers = creatures.filter(c => !c.isTapped);

      const blockerDefense = untappedBlockers.reduce((sum, b) => sum + (Number(b.effectiveToughness ?? b.toughness) || 0), 0);
      const boardThreat = creatures.reduce((sum, c) => sum + (Number(c.effectivePower ?? c.power) || 0), 0);

      const score = (boardThreat * 2) + (30 - life) + (poison * 2) - (blockerDefense * 1.5);
      if (score > bestScore) {
        bestScore = score;
        bestOppId = oppId;
      }
    }

    return bestOppId;
  }

  /**
   * Evaluates combat attack declarations (INV-PERKINS-6).
   * 
   * @param {Object} [state=null] - Sanitized tabletop state
   * @returns {Array<string>} Array of attacking creature instanceIds
   */
  evaluateCombatAttacks(state = null) {
    if (!state) state = this.getProjectedState();
    const myPlayer = state?.players?.[this.slotId];
    if (!myPlayer) return [];

    const myCreatures = myPlayer.battlefield?.creatures || [];
    const eligibleAttackers = myCreatures.filter(c => {
      const check = CombatDamageEngine.canCreatureAttack(c, this.tabletopState);
      return check.canAttack;
    });
    if (eligibleAttackers.length === 0) return [];

    // Find all opponent untapped blockers
    const oppBlockers = [];
    for (const [pId, p] of Object.entries(state?.players || {})) {
      if (pId === this.slotId || p.isEliminated) continue;
      const creatures = p.battlefield?.creatures || [];
      for (const c of creatures) {
        if (!c.isTapped) {
          oppBlockers.push(c);
        }
      }
    }

    // If opponent has 0 untapped blockers, all eligible creatures attack
    if (oppBlockers.length === 0) {
      return eligibleAttackers.map(c => c.instanceId);
    }

    const maxBlockerPower = Math.max(...oppBlockers.map(b => Number(b.effectivePower ?? b.power) || 0));
    const minBlockerToughness = Math.min(...oppBlockers.map(b => Number(b.effectiveToughness ?? b.toughness) || 1));
    const minBlockerCmc = Math.min(...oppBlockers.map(b => Number(b.cmc ?? this._parseCmc(b.manaCost)) || 0));

    const hasIntangibleVirtue = (myPlayer.battlefield?.noncreatures || []).some(
      nc => /intangible virtue/i.test(nc?.name || '')
    );

    const declaredAttackers = [];
    for (const c of eligibleAttackers) {
      const power = Number(c.effectivePower ?? c.power) || 0;
      const toughness = Number(c.effectiveToughness ?? c.toughness) || 0;
      const cmc = Number(c.cmc ?? this._parseCmc(c.manaCost)) || 0;

      const isToken = Boolean(c.isToken || /token/i.test(c.typeLine || '') || String(c.instanceId || '').startsWith('token_'));
      const hasVigilance = Boolean(
        c.vigilance ||
        c.hasVigilance ||
        (c.keywords && (Array.isArray(c.keywords) ? c.keywords.includes('vigilance') : c.keywords.vigilance)) ||
        (hasIntangibleVirtue && isToken)
      );

      // Rule C: Tokens with Vigilance (e.g. Intangible Virtue) attack aggressively:
      // They don't tap to attack, remain available for blocking, and push face damage.
      if (hasVigilance && isToken && power > 0) {
        declaredAttackers.push(c.instanceId);
        continue;
      }

      // Rule A: c.toughness > maxBlockerPower (can attack and survive any single blocker)
      if (toughness > maxBlockerPower) {
        declaredAttackers.push(c.instanceId);
        continue;
      }

      // Rule B: c.power >= minBlockerToughness and attacker CMC <= minBlockerCmc (favorable or even trade)
      if (power >= minBlockerToughness && cmc <= minBlockerCmc) {
        declaredAttackers.push(c.instanceId);
        continue;
      }
    }

    return declaredAttackers;
  }

  /**
   * Evaluates combat block declarations (INV-PERKINS-6 & [P42]).
   * 
   * @param {Object} [state=null] - Sanitized tabletop state
   * @param {Array<Object>} [incomingAttackers=[]] - Attackers declared against Perkins
   * @returns {Array<{ blockerId: string, attackerId: string }>} Block assignments
   */
  evaluateCombatBlocks(state = null, incomingAttackers = []) {
    if (!state) state = this.getProjectedState();
    const myPlayer = state?.players?.[this.slotId];
    if (!myPlayer) return [];

    const myCreatures = myPlayer.battlefield?.creatures || [];
    const untappedBlockers = myCreatures.filter(c => !c.isTapped);
    if (untappedBlockers.length === 0 || !incomingAttackers || incomingAttackers.length === 0) {
      return [];
    }

    const hasInfect = (a) => Boolean(
      a.keywords?.infect ||
      a.keywords?.Infect ||
      /infect/i.test(a.oracleText || a.text || '') ||
      /inkmoth nexus/i.test(a.name || '')
    );

    let totalDamage = 0;
    let totalInfectDamage = 0;
    for (const a of incomingAttackers) {
      const p = Number(a.effectivePower ?? a.power) || 0;
      if (hasInfect(a)) {
        totalInfectDamage += p;
      } else {
        totalDamage += p;
      }
    }

    const currentLife = myPlayer.resources?.life ?? 20;
    const currentPoison = myPlayer.resources?.poison ?? myPlayer.poisonCounters ?? 0;

    const isLethalLife = totalDamage >= currentLife;
    const isLethalPoison = (currentPoison + totalInfectDamage) >= 10;
    const isLethalIncoming = isLethalLife || isLethalPoison;

    const assignments = [];
    const availableBlockers = [...untappedBlockers];

    // Helper to sort creatures by value ascending: toughness, power, cmc
    const compareCreatureValueAscending = (a, b) => {
      const tA = Number(a.effectiveToughness ?? a.toughness) || 0;
      const tB = Number(b.effectiveToughness ?? b.toughness) || 0;
      if (tA !== tB) return tA - tB;
      const pA = Number(a.effectivePower ?? a.power) || 0;
      const pB = Number(b.effectivePower ?? b.power) || 0;
      if (pA !== pB) return pA - pB;
      const cA = Number(a.cmc ?? this._parseCmc(a.manaCost)) || 0;
      const cB = Number(b.cmc ?? this._parseCmc(b.manaCost)) || 0;
      return cA - cB;
    };

    // Case 1: Lethal damage or lethal infect poison incoming -> Mandatory Chump Block Mode [P42]
    if (isLethalIncoming) {
      const sortedAttackers = [...incomingAttackers].sort((a, b) => {
        const aInf = hasInfect(a);
        const bInf = hasInfect(b);
        const aPow = Number(a.effectivePower ?? a.power) || 0;
        const bPow = Number(b.effectivePower ?? b.power) || 0;

        if (isLethalPoison && !isLethalLife) {
          if (aInf !== bInf) return aInf ? -1 : 1;
        } else if (isLethalLife && !isLethalPoison) {
          if (aInf !== bInf) return aInf ? 1 : -1;
        } else if (isLethalPoison && isLethalLife) {
          const poisonMargin = (currentPoison + totalInfectDamage) - 10;
          const lifeMargin = totalDamage - currentLife;
          if (poisonMargin >= lifeMargin) {
            if (aInf !== bInf) return aInf ? -1 : 1;
          } else {
            if (aInf !== bInf) return aInf ? 1 : -1;
          }
        }
        return bPow - aPow;
      });

      availableBlockers.sort(compareCreatureValueAscending);

      let remainingDamage = totalDamage;
      let remainingInfect = totalInfectDamage;

      for (const attacker of sortedAttackers) {
        if (availableBlockers.length === 0) break;
        const safeFromLife = remainingDamage < currentLife;
        const safeFromPoison = (currentPoison + remainingInfect) < 10;
        if (safeFromLife && safeFromPoison) break;

        const aPow = Number(attacker.effectivePower ?? attacker.power) || 0;
        const blockerIndex = availableBlockers.findIndex(b =>
          CombatDamageEngine.canCreatureBlock(b, attacker, this.tabletopState).canBlock
        );
        if (blockerIndex === -1) continue;

        const blocker = availableBlockers.splice(blockerIndex, 1)[0];
        assignments.push({
          blockerId: blocker.instanceId,
          attackerId: attacker.instanceId
        });

        if (hasInfect(attacker)) {
          remainingInfect -= aPow;
        } else {
          remainingDamage -= aPow;
        }
      }

      return assignments;
    }

    // Case 2: Non-lethal -> Profitable or even trade
    for (const attacker of incomingAttackers) {
      const aPower = Number(attacker.effectivePower ?? attacker.power) || 0;
      const aToughness = Number(attacker.effectiveToughness ?? attacker.toughness) || 0;

      // 1. Strictly profitable blocker
      let blockerIndex = availableBlockers.findIndex(b => {
        const canBlock = CombatDamageEngine.canCreatureBlock(b, attacker, this.tabletopState).canBlock;
        if (!canBlock) return false;
        const bPower = Number(b.effectivePower ?? b.power) || 0;
        const bToughness = Number(b.effectiveToughness ?? b.toughness) || 0;
        return bPower >= aToughness && bToughness > aPower;
      });

      // 2. Even-trade blocker
      if (blockerIndex === -1) {
        blockerIndex = availableBlockers.findIndex(b => {
          const canBlock = CombatDamageEngine.canCreatureBlock(b, attacker, this.tabletopState).canBlock;
          if (!canBlock) return false;
          const bPower = Number(b.effectivePower ?? b.power) || 0;
          const bToughness = Number(b.effectiveToughness ?? b.toughness) || 0;
          const isEvenTrade = bPower >= aToughness && aPower >= bToughness;
          const isWorthyTrade = (aPower >= bPower || aPower >= 2 || Number(attacker.cmc ?? 0) >= Number(b.cmc ?? 0));
          return isEvenTrade && isWorthyTrade;
        });
      }

      if (blockerIndex !== -1) {
        const blocker = availableBlockers.splice(blockerIndex, 1)[0];
        assignments.push({
          blockerId: blocker.instanceId,
          attackerId: attacker.instanceId
        });
      }
    }

    return assignments;
  }

  /**
   * Evaluates Random Perk targeting and ensures zero self-sabotage (INV-PERKINS-5).
   * 
   * @param {string} perkKey - Canonical perk key ('55', '99', etc.)
   * @param {Object} [state=null] - Sanitized tabletop state
   * @returns {Array<string>|null} Legal opponent targets
   */
  evaluatePerkTargets(perkKey, state = null) {
    if (!state) state = this.getProjectedState();
    if (!state) return null;

    if (perkKey === '55') {
      // Perk #55: Cataclysmic Ruin
      // Destroy target permanent (Planeswalker > Threat > Land; exclude self)
      const opponentPermanents = [];

      for (const [pId, player] of Object.entries(state.players || {})) {
        if (pId === this.slotId || player.isEliminated) continue;

        const bf = player.battlefield || {};
        for (const subzone of ['planeswalkers', 'creatures', 'noncreatures', 'lands']) {
          for (const card of (bf[subzone] || [])) {
            if (card.ownerId === this.slotId || card.controllerId === this.slotId) continue;
            opponentPermanents.push({
              instanceId: card.instanceId,
              card,
              subzone,
              ownerId: pId
            });
          }
        }
      }

      if (opponentPermanents.length === 0) {
        return null;
      }

      // Hierarchy: Planeswalkers (Tier 1) > Non-lands (Tier 2) > Lands (Tier 3)
      const getTier = (p) => {
        const type = String(p.card?.typeLine || p.card?.type || '').toLowerCase();
        if (p.subzone === 'planeswalkers' || type.includes('planeswalker')) return 1;
        if (p.subzone === 'lands' || type.includes('land')) return 3;
        return 2;
      };

      opponentPermanents.sort((a, b) => {
        const tierA = getTier(a);
        const tierB = getTier(b);
        if (tierA !== tierB) return tierA - tierB;

        // Within Tier 2: sort by CMC descending, then power descending
        const cmcA = a.card?.cmc ?? this._parseCmc(a.card?.manaCost);
        const cmcB = b.card?.cmc ?? this._parseCmc(b.card?.manaCost);
        if (cmcB !== cmcA) return cmcB - cmcA;

        const powerA = Number(a.card?.power) || 0;
        const powerB = Number(b.card?.power) || 0;
        return powerB - powerA;
      });

      return [opponentPermanents[0].instanceId];
    }

    if (perkKey === '99') {
      // Perk #99: Torment
      // ThreatScore(p) = (life * 0.5) + (creatures * 2.0) + (hand * 1.0)
      const opponents = [];

      for (const [pId, player] of Object.entries(state.players || {})) {
        if (pId === this.slotId || player.isEliminated) continue;

        const life = player.resources?.life ?? 20;
        const creatures = (player.battlefield?.creatures || []).length;
        const hand = player.hand?.count ?? (
          Array.isArray(player.hand?.cards) ? player.hand.cards.length : (
            Array.isArray(player.hand) ? player.hand.length : 0
          )
        );

        const threatScore = (life * 0.5) + (creatures * 2.0) + (hand * 1.0);
        opponents.push({
          playerId: pId,
          threatScore
        });
      }

      if (opponents.length === 0) return null;

      opponents.sort((a, b) => b.threatScore - a.threatScore);
      return [opponents[0].playerId];
    }

    return null;
  }

  /**
   * Helper to parse converted mana cost from mana string.
   * @private
   */
  _parseCmc(manaCost) {
    if (!manaCost || typeof manaCost !== 'string') return 0;
    let cmc = 0;
    const genericMatch = manaCost.match(/\{(\d+)\}/);
    if (genericMatch) {
      cmc += parseInt(genericMatch[1], 10);
    }
    const colorMatches = manaCost.match(/\{[WUBRGC]\}/g);
    if (colorMatches) {
      cmc += colorMatches.length;
    }
    return cmc;
  }

  /**
   * Evaluates opening hand for London Mulligan (INV-MULLIGAN-1).
   * 
   * @param {Array<Object>} hand
   * @param {number} [currentMulliganCount=0]
   * @returns {{ keep: boolean, reason: string, bottomCards: Array<Object> }}
   */
  evaluateOpeningHand(hand, currentMulliganCount = 0) {
    const evalResult = evaluatePerkinsMulligan(hand, currentMulliganCount);
    let bottomCards = [];
    if (evalResult.keep && currentMulliganCount > 0) {
      bottomCards = selectPerkinsBottomCards(hand, currentMulliganCount);
    }
    return {
      keep: evalResult.keep,
      reason: evalResult.reason,
      bottomCards
    };
  }

  /**
   * Intelligently selects candidate card for Tutor / Search effects.
   * 
   * @param {Array<Object>} candidates
   * @param {Object} [context={}]
   * @returns {Object|null}
   */
  selectTutorCandidate(candidates = [], context = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    const { landsCount = 2, turnNumber = 3 } = context;

    // Emergency mana screw: find a land
    if (landsCount <= 2 && turnNumber >= 3) {
      const land = candidates.find(c => /land/i.test(c.typeLine || c.type || ''));
      if (land) return land;
    }

    // High impact finisher or removal
    const sorted = [...candidates].sort((a, b) => {
      const cmcA = a.cmc ?? this._parseCmc(a.manaCost);
      const cmcB = b.cmc ?? this._parseCmc(b.manaCost);
      return cmcB - cmcA;
    });

    return sorted[0] || candidates[0];
  }

  /**
   * Selects legal target for targeted spell, filtering out Hexproof, Shroud, and Protection (INV-TARGET-MENU-1).
   * 
   * @param {Object} spell
   * @param {Object} tabletopState
   * @returns {{ targetId: string, targetType: 'PLAYER'|'CREATURE' } | null}
   */
  /**
   * Selects legal target for targeted spell, filtering out Hexproof, Shroud, and Protection (INV-TARGET-MENU-1).
   * 
   * Specific heuristics (SPEC A):
   * - removal / DESTROY_TARGET -> strongest opponent creature (power, then toughness)
   * - PUMP_PT_EOT -> own attacking/unblocked creature (else strongest own)
   * - DEAL_DAMAGE -> killable opponent creature else opponent face
   * - Fallback -> strongest legal opponent creature else opponent player
   * 
   * @param {Object} spell
   * @param {Object} tabletopState
   * @returns {{ targetId: string, targetType: 'PLAYER'|'CREATURE' } | null}
   */
  selectLegalSpellTarget(spell, tabletopState) {
    if (!spell || !tabletopState) return null;

    const groundedEffects = Array.isArray(spell.groundedEffects) ? spell.groundedEffects : (
      Array.isArray(spell.compiledMechanics?.effects) ? spell.compiledMechanics.effects : []
    );

    const isGroundedPump = groundedEffects.some(e => e.action === 'PUMP_PT_EOT' || e.type === 'PUMP_PT_EOT') ||
      spell.action === 'PUMP_PT_EOT' ||
      /\+\d+\/\+\d+\s+until end of turn|target creature gets \+/i.test(spell.oracleText || spell.text || '');

    const isGroundedDestroy = groundedEffects.some(e => e.action === 'DESTROY_TARGET' || e.type === 'DESTROY_TARGET') ||
      spell.action === 'DESTROY_TARGET' ||
      /destroy target|exile target/i.test(spell.oracleText || spell.text || '');

    const damageEffect = groundedEffects.find(e => e.action === 'DEAL_DAMAGE' || e.type === 'DEAL_DAMAGE') ||
      (spell.action === 'DEAL_DAMAGE' ? spell : null);
    const isGroundedDamage = Boolean(damageEffect) || (/deals \d+ damage/i.test(spell.oracleText || spell.text || ''));

    const isPlayerHexproof = (pid, player) => {
      if (typeof tabletopState.playerHasHexproof === 'function' && tabletopState.playerHasHexproof(pid)) {
        return true;
      }
      if (this.app?.tabletopState && typeof this.app.tabletopState.playerHasHexproof === 'function' && this.app.tabletopState.playerHasHexproof(pid)) {
        return true;
      }
      if (player?.hasHexproof || player?.keywords?.hexproof) {
        return true;
      }
      const noncreatures = player?.battlefield?.noncreatures || [];
      if (noncreatures.some(c => /leyline of sanctity/i.test(c?.name || ''))) {
        return true;
      }
      const allPermanents = [
        ...(player?.battlefield?.creatures || []),
        ...(player?.battlefield?.noncreatures || []),
        ...(player?.battlefield?.lands || [])
      ];
      if (allPermanents.some(c => /leyline of sanctity/i.test(c?.name || ''))) {
        return true;
      }
      return false;
    };

    const checkLegality = (targetCandidate) => {
      if (targetCandidate.type === 'PLAYER') {
        const pid = targetCandidate.id || targetCandidate.player?.id;
        const player = targetCandidate.player || tabletopState.players?.[pid];
        if (isPlayerHexproof(pid, player)) {
          return false;
        }
      }
      if (TargetSelectorModal && typeof TargetSelectorModal.evaluateTargetLegality === 'function') {
        try {
          return TargetSelectorModal.evaluateTargetLegality(targetCandidate, spell, this.slotId).isLegal;
        } catch (_) {
          return true;
        }
      }
      return true;
    };

    // 1. PUMP_PT_EOT: Target own creature (unblocked attacker first, else strongest own)
    if (isGroundedPump) {
      const myPlayer = tabletopState.players?.[this.slotId];
      const myCreatures = (myPlayer?.battlefield?.creatures || []).filter(card => {
        return checkLegality({ id: card.instanceId, type: 'CREATURE', card });
      });

      if (myCreatures.length > 0) {
        const combat = tabletopState.combatState;
        const attackers = Array.isArray(combat?.attackers) ? combat.attackers : [];
        const blockers = Array.isArray(combat?.blockers) ? combat.blockers : [];
        const blockedAttackerIds = new Set(blockers.map(b => b.attackerId || b.targetAttackerId));

        const unblockedMyAttackers = myCreatures.filter(c => {
          const isAttacking = attackers.some(a => (a.attackerId || a.creature?.instanceId || a.instanceId) === c.instanceId);
          return isAttacking && !blockedAttackerIds.has(c.instanceId);
        });

        if (unblockedMyAttackers.length > 0) {
          unblockedMyAttackers.sort((a, b) => (Number(b.power) || 0) - (Number(a.power) || 0) || (Number(b.toughness) || 0) - (Number(a.toughness) || 0));
          return { targetId: unblockedMyAttackers[0].instanceId, targetType: 'CREATURE' };
        }

        myCreatures.sort((a, b) => (Number(b.power) || 0) - (Number(a.power) || 0) || (Number(b.toughness) || 0) - (Number(a.toughness) || 0));
        return { targetId: myCreatures[0].instanceId, targetType: 'CREATURE' };
      }
      return null;
    }

    // Collect legal opponent creatures
    const opponentCreatures = [];
    for (const [pid, player] of Object.entries(tabletopState.players || {})) {
      if (pid === this.slotId) continue;
      const creatures = player.battlefield?.creatures || [];
      for (const card of creatures) {
        if (checkLegality({ id: card.instanceId, type: 'CREATURE', card })) {
          opponentCreatures.push(card);
        }
      }
    }

    // Collect legal opponent players
    const opponentPlayers = [];
    for (const [pid, player] of Object.entries(tabletopState.players || {})) {
      if (pid === this.slotId) continue;
      if (checkLegality({ id: pid, type: 'PLAYER', player })) {
        opponentPlayers.push({ id: pid, player });
      }
    }

    // Player-only spells (e.g. Thoughtseize, Lava Spike): strictly player targets, respecting Hexproof
    const isPlayerOnly = /target player|target opponent/i.test(spell.oracleText || spell.text || '') &&
      !/target creature|any target/i.test(spell.oracleText || spell.text || '');

    if (isPlayerOnly) {
      if (opponentPlayers.length > 0) {
        return { targetId: opponentPlayers[0].id, targetType: 'PLAYER' };
      }
      return null;
    }

    // 2. DEAL_DAMAGE: Killable opponent creature else opponent face
    if (isGroundedDamage) {
      const dmg = Number(damageEffect?.amount || damageEffect?.damage || (String(spell.oracleText || spell.text || '').match(/deals (\d+) damage/i)?.[1]) || 3);
      const killable = opponentCreatures.filter(c => {
        if (c.toughness !== undefined) {
          return Number(c.toughness) <= dmg;
        }
        return false;
      });

      if (killable.length > 0) {
        killable.sort((a, b) => (Number(b.power) || 0) - (Number(a.power) || 0) || (Number(b.toughness) || 0) - (Number(a.toughness) || 0));
        return { targetId: killable[0].instanceId, targetType: 'CREATURE' };
      }

      if (opponentPlayers.length > 0) {
        return { targetId: opponentPlayers[0].id, targetType: 'PLAYER' };
      }

      if (opponentCreatures.length > 0) {
        opponentCreatures.sort((a, b) => (Number(b.power) || 0) - (Number(a.power) || 0) || (Number(b.toughness) || 0) - (Number(a.toughness) || 0));
        return { targetId: opponentCreatures[0].instanceId, targetType: 'CREATURE' };
      }
      return null;
    }

    // 3. DESTROY_TARGET or generic removal: Strongest opponent creature
    if (opponentCreatures.length > 0) {
      opponentCreatures.sort((a, b) => (Number(b.power) || 0) - (Number(a.power) || 0) || (Number(b.toughness) || 0) - (Number(a.toughness) || 0));
      return { targetId: opponentCreatures[0].instanceId, targetType: 'CREATURE' };
    }

    // Opponent player fallback
    if (opponentPlayers.length > 0) {
      return { targetId: opponentPlayers[0].id, targetType: 'PLAYER' };
    }

    return null;
  }

  /**
   * Distributes combat damage for attacker (INV-DAMAGE-ASSIGN-1).
   * 
   * @param {Object} attacker
   * @param {Array<Object>} blockers
   * @param {number} attackerPower
   * @returns {Object}
   */
  assignCombatDamage(attacker, blockers = [], attackerPower) {
    return CombatDamageEngine.calculateAttackerDamageDistribution(attacker, blockers, attackerPower);
  }

  /**
   * Determines whether Perkins AI opts into the Upkeep Random Perk roll.
   * Prevents rolling if library is nearly empty (anti-deckout safeguard).
   * 
   * @param {Object} state
   * @returns {boolean}
   */
  shouldRollUpkeepPerk(state = null) {
    const myState = state?.players?.[this.slotId] || this.tabletopState?.getPlayer?.(this.slotId);
    const libraryCount = myState?.library?.length ?? myState?.libraryCount ?? 40;

    // If deck has 3 or fewer cards, decline to roll to prevent deckout loss
    if (libraryCount <= 3) {
      return false;
    }
    return true;
  }

  /**
   * Cleanly destroys the agent, cancels all timers, and unbinds listeners (INV-SAFE-3).
   */
  destroy() {
    this.isDestroyed = true;
    this._spacebarTipShown = false;
    for (const timer of this._activeTimers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this._activeTimers.clear();

    for (const unsub of this._unsubscribers) {
      try { unsub(); } catch (_) {}
    }
    this._unsubscribers = [];
  }
}

export default PerkinsAgent;
