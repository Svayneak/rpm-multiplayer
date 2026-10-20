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
    this.starterDeck = options.starterDeck || null;

    // Subsystem bindings
    this.app = null;
    this.relayClient = null;

    // Safety and lifecycle trackers (INV-SAFE-3)
    this.isDestroyed = false;
    this._activeTimers = new Set();
    this._unsubscribers = [];
    this._phaseActionCount = 0;
    this._lastPhaseStep = null;
    this._lastCoachTimestamp = 0;
    this._completedMilestones = new Set();
    this._hasPlayedLandThisTurn = false;

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
            this.onStackAlarm(event);
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
        const currentPhase = event?.currentPhaseStep || event?.phaseStep;
        if (event?.priorityPlayerId === this.slotId || this.app.priorityMachine.priorityPlayerId === this.slotId) {
          this.evaluateTurnPhase(currentPhase);
        }
      };
      this.app.priorityMachine.on('PHASE_STEP_CHANGED', onPhaseStepChange);
      this._unsubscribers.push(() => this.app.priorityMachine.off('PHASE_STEP_CHANGED', onPhaseStepChange));
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

    const now = Date.now();
    if (this._lastCoachTimestamp && (now - this._lastCoachTimestamp < 8000)) {
      return false; // Suppressed by 8s debounce gate
    }

    const dialogue = PERKINS_COACH_DIALOGUES[milestoneKey];
    if (!dialogue) return false;

    const text = dialogue[this.language] || dialogue['es'];
    this._lastCoachTimestamp = now;
    this._completedMilestones.add(milestoneKey);

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

  /**
   * Evaluates stack alarm reaction within thinkingDelayMs (INV-PERKINS-4).
   * Evaluates whether to respond with instant or pass priority.
   * 
   * @param {Object} alarmState - State emitted by StackAlarmManager
   * @returns {Promise<Object|void>} Action dispatched
   */
  async onStackAlarm(alarmState) {
    if (this.isDestroyed) return;
    if (alarmState?.targetPlayerId && alarmState.targetPlayerId !== this.slotId) return;

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
            land.isTapped = true;
            await this.dispatchAction({
              type: 'TAP_PERMANENT',
              playerId: this.slotId,
              instanceId: land.instanceId || land.id,
              payload: { playerId: this.slotId, instanceId: land.instanceId || land.id }
            });
            if (this.app?.tabletopState && typeof this.app.tabletopState.tapLandForMana === 'function') {
              try { this.app.tabletopState.tapLandForMana(this.slotId, land.instanceId || land.id); } catch (_) {}
            }
          }
        }

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
            land.isTapped = true;
            await this.dispatchAction({
              type: 'TAP_PERMANENT',
              playerId: this.slotId,
              instanceId: land.instanceId || land.id,
              payload: { playerId: this.slotId, instanceId: land.instanceId || land.id }
            });
            if (this.app?.tabletopState && typeof this.app.tabletopState.tapLandForMana === 'function') {
              try { this.app.tabletopState.tapLandForMana(this.slotId, land.instanceId || land.id); } catch (_) {}
            }
          }

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
            land.isTapped = true;
            await this.dispatchAction({
              type: 'TAP_PERMANENT',
              playerId: this.slotId,
              instanceId: land.instanceId || land.id,
              payload: { playerId: this.slotId, instanceId: land.instanceId || land.id }
            });
            if (this.app?.tabletopState && typeof this.app.tabletopState.tapLandForMana === 'function') {
              try { this.app.tabletopState.tapLandForMana(this.slotId, land.instanceId || land.id); } catch (_) {}
            }
          }

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
      return new Promise((resolve) => {
        const timerId = setTimeout(async () => {
          this._activeTimers.delete(timerId);
          const res = await executeAlarmReaction();
          resolve(res);
        }, this.thinkingDelayMs);
        this._activeTimers.add(timerId);
      });
    } else {
      return executeAlarmReaction();
    }
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

    // Handle injected TabletopStateManager instance
    let state = injectedState;
    if (state instanceof TabletopStateManager || (state && typeof state.projectState === 'function')) {
      state = state.projectState(this.slotId);
    } else if (!state) {
      state = this.getProjectedState();
    }

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

      // 1. Play Land if not yet played this turn
      if (!this._hasPlayedLandThisTurn) {
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
          return playLandAction;
        }
      }

      // 2. Cast Creatures / Sorceries if affordable
      const manaPool = myState?.resources?.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      const lands = myState?.battlefield?.lands || [];
      const untappedLands = lands.filter(l => !l.isTapped);
      const totalAvailableMana = Object.values(manaPool).reduce((sum, n) => sum + (Number(n) || 0), 0) + untappedLands.length;

      const castableCreatures = handCards.filter(c => {
        if (!c || c.isHidden) return false;
        const type = String(c.typeLine || c.type || '');
        if (!/creature|sorcery/i.test(type)) return false;
        const cmc = c.cmc ?? c.manaValue ?? this._parseCmc(c.manaCost);
        return cmc <= totalAvailableMana;
      });

      if (castableCreatures.length > 0) {
        castableCreatures.sort((a, b) => {
          const cmcA = a.cmc ?? this._parseCmc(a.manaCost);
          const cmcB = b.cmc ?? this._parseCmc(b.manaCost);
          return cmcB - cmcA;
        });
        const cardToCast = castableCreatures[0];

        // Explicitly tap matching lands before casting (INV-MANA-1)
        const cmc = cardToCast.cmc ?? this._parseCmc(cardToCast.manaCost);
        const landsNeeded = Math.min(cmc, untappedLands.length);
        for (let i = 0; i < landsNeeded; i++) {
          const landToTap = untappedLands[i];
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
          if (this.app?.tabletopState && typeof this.app.tabletopState.tapLandForMana === 'function') {
            try { this.app.tabletopState.tapLandForMana(this.slotId, landToTap.instanceId || landToTap.id); } catch (_) {}
          }
        }

        const castAction = {
          type: 'CAST_SPELL',
          playerId: this.slotId,
          controllerId: this.slotId,
          controllerName: this.playerName || 'Perkins AI (Bot)',
          card: cardToCast,
          cardName: cardToCast.name,
          payload: {
            playerId: this.slotId,
            controllerId: this.slotId,
            controllerName: this.playerName || 'Perkins AI (Bot)',
            card: cardToCast,
            cardName: cardToCast.name,
            instanceId: cardToCast.instanceId
          }
        };
        await this.dispatchAction(castAction);
        return castAction;
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

      if (isActive) {
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
          return attackAction;
        }
      }
      const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(passAction);
      return passAction;
    }

    if (phaseStep === 'DECLARE_BLOCKERS') {
      const isDefending = (state?.activePlayerId !== this.slotId);
      if (isDefending) {
        const incomingAttackers = state?.combat?.attackers || [];
        const blocks = this.evaluateCombatBlocks(state, incomingAttackers);
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
          return blockAction;
        }
      }
      const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(passAction);
      return passAction;
    }

    // Phase 6: END_STEP & CLEANUP (CR 513-514)
    if (phaseStep === 'END_STEP' || phaseStep === 'CLEANUP') {
      this._hasPlayedLandThisTurn = false;
      const passAction = { type: 'PASS_PRIORITY', playerId: this.slotId };
      await this.dispatchAction(passAction);
      return passAction;
    }

    // Default fallback pass
    const defaultPass = { type: 'PASS_PRIORITY', playerId: this.slotId };
    await this.dispatchAction(defaultPass);
    return defaultPass;
  }

  async _executePrecombatMainPhase(state = null) {
    return this.evaluateTurnPhase('PRECOMBAT_MAIN', state);
  }

  async _executePostcombatMainPhase(state = null) {
    return this.evaluateTurnPhase('POSTCOMBAT_MAIN', state);
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
    const eligibleAttackers = myCreatures.filter(c => !c.isTapped && !c.isSummoningSick);
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

    const maxBlockerPower = Math.max(...oppBlockers.map(b => Number(b.power) || 0));
    const minBlockerToughness = Math.min(...oppBlockers.map(b => Number(b.toughness) || 1));
    const minBlockerCmc = Math.min(...oppBlockers.map(b => Number(b.cmc ?? this._parseCmc(b.manaCost)) || 0));

    const declaredAttackers = [];
    for (const c of eligibleAttackers) {
      const power = Number(c.power) || 0;
      const toughness = Number(c.toughness) || 0;
      const cmc = Number(c.cmc ?? this._parseCmc(c.manaCost)) || 0;

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
   * Evaluates combat block declarations (INV-PERKINS-6).
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

    // Calculate total incoming unblocked damage
    const totalDamage = incomingAttackers.reduce((sum, a) => sum + (Number(a.power) || 0), 0);
    const currentLife = myPlayer.resources?.life ?? 20;

    const assignments = [];
    const availableBlockers = [...untappedBlockers];

    // Helper to sort creatures by value ascending: toughness, power, cmc
    const compareCreatureValueAscending = (a, b) => {
      const tA = Number(a.toughness) || 0;
      const tB = Number(b.toughness) || 0;
      if (tA !== tB) return tA - tB;
      const pA = Number(a.power) || 0;
      const pB = Number(b.power) || 0;
      if (pA !== pB) return pA - pB;
      const cA = Number(a.cmc ?? this._parseCmc(a.manaCost)) || 0;
      const cB = Number(b.cmc ?? this._parseCmc(b.manaCost)) || 0;
      return cA - cB;
    };

    // Case 1: Lethal damage incoming -> Mandatory Chump Block Mode
    if (totalDamage >= currentLife) {
      // Sort attackers descending by power
      const sortedAttackers = [...incomingAttackers].sort((a, b) => (Number(b.power) || 0) - (Number(a.power) || 0));
      // Sort blockers ascending by value
      availableBlockers.sort(compareCreatureValueAscending);

      let damageRemaining = totalDamage;
      for (const attacker of sortedAttackers) {
        if (availableBlockers.length === 0) break;
        if (damageRemaining < currentLife) break;

        const blocker = availableBlockers.shift();
        assignments.push({
          blockerId: blocker.instanceId,
          attackerId: attacker.instanceId
        });
        damageRemaining -= (Number(attacker.power) || 0);
      }

      return assignments;
    }

    // Case 2: Non-lethal -> Profitable trade only
    // blocker.power >= attacker.toughness && blocker.toughness > attacker.power
    for (const attacker of incomingAttackers) {
      const aPower = Number(attacker.power) || 0;
      const aToughness = Number(attacker.toughness) || 0;

      const blockerIndex = availableBlockers.findIndex(b => {
        const bPower = Number(b.power) || 0;
        const bToughness = Number(b.toughness) || 0;
        return bPower >= aToughness && bToughness > aPower;
      });

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
   * Cleanly destroys the agent, cancels all timers, and unbinds listeners (INV-SAFE-3).
   */
  destroy() {
    this.isDestroyed = true;
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
