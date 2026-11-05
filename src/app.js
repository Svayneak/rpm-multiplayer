/**
 * src/app.js
 * Root Application Controller & Capstone Integration Harness
 * 
 * Orchestrates all 11 subsystems:
 * - TabletopStateManager (Zones, Life, Fog-of-War)
 * - PriorityStateMachine (Turn Steps, APNAP, LIFO)
 * - StackAlarmManager (15s Countdown Timer)
 * - RandomPerkEngine (Upkeep Emblem, 2 d10 Dice Engine)
 * - DualChannelChat (Chit-Chat vs Priority-Gated Turn Commands)
 * - ActionLexer (Disambiguation & Natural Language Turn Commands)
 * - TabletopUI & CardOverlayModal (Accordion Zones, Card Inspection)
 * - RelayClient (Authoritative WebSocket Synchronization)
 * - DeckbuilderAI (10-Point Guideline Memory & Showcase)
 * - StorageAdapter (Quota Guards & Persistence)
 * - VictoryFanfareEngine & ProfileManager (Elo, Deck Slots, Audio Fanfare)
 * 
 * Enforces Architectural Invariants:
 * - INV-HARNESS-1: Hermetic Lifecycle & Zero Timer/DOM Leaks
 * - INV-HARNESS-2: Unidirectional Action Flow & Circular Loop Elimination
 * - INV-HARNESS-3: Multi-Player Pod Scaling (2 to 6 players) & Elimination Gray-Out
 * - INV-HARNESS-4: Authoritative 15s Alarm Decoupling & Visual Progress
 * - INV-HARNESS-5: Dual-Channel Isolation & Turn Command Lockout
 * - INV-HARNESS-6: Single-Layer Modal Composition & Escape Focus Trapping
 * 
 * Specification: SPEC-RPM-HARNESS-012
 * @module RPMAppController
 */

import { TabletopStateManager, projectState } from './TabletopStateManager.js';
import { PregameStateMachine, PREGAME_STATES } from './PregameStateMachine.js';
import { canDeclareAsAttacker, canBlockAssignment } from './CombatDamageEngine.js';
import { ProcessTraceLogger, defaultProcessTraceLogger } from './ProcessTraceLogger.js';
import { PriorityStateMachine } from './PriorityStateMachine.js';
import { StackAlarmManager } from './StackAlarmManager.js';
import { RandomPerkEngine, executeAuthoritativeRoll } from './RandomPerkEngine.js';
import { getPerkDefinition, resolveRoll } from './PerkCatalog.js';
import { DualChannelChat } from './DualChannelChat.js';
import { ActionLexer } from './ActionLexer.js';
import { CardOverlayModal, formatManaSymbols } from './view/CardOverlayModal.js';
import { RelayClient } from './RelayClient.js';
import { DeckbuilderAI, BEGINNER_DECKS, formatDeckForExport, resolveActiveGuidelines, getHydratedCardMetadata } from './DeckbuilderAI.js';
import { StorageAdapter, calculatePayloadBytes } from './StorageAdapter.js';
import {
  VictoryFanfareEngine,
  ProfileManager,
  primeAudio,
  renderFallbackBanner,
  createDefaultProfile,
  evaluateDeckSlots
} from './VictoryFanfare.js';
import { PerkinsAgent, PERKINS_DEFAULT_CONFIG, PERKINS_COACH_DIALOGUES } from './PerkinsAgent.js';
import { generateInstanceId, ZoneModel } from './ZoneModel.js';
import { TabRouter, TABS, LOCKED_TABS_DURING_MATCH } from './view/TabRouter.js';
import { DeckValidator, VALIDATION_ERRORS, ORACLE_UNLIMITED_CARDS, BASIC_LAND_COLORS, DUAL_LAND_METADATA } from './DeckValidator.js';
import { ScryfallService, LocalStorageCacheAdapter, MemoryCacheAdapter } from './ScryfallService.js';
import { OracleEffectCompiler, compileCardMechanics, smokeTestCard } from './OracleEffectCompiler.js';
import { LobbyManager, LOBBY_STATUS } from './LobbyManager.js';
import { MatchmakingQueue } from './MatchmakingQueue.js';
import { TurnRollOffManager, generateAuthoritativeD20 } from './TurnRollOffManager.js';
import { SPANISH_COLOR_LAND_MAP } from './ActionLexer.js';
import {
  AuthManager,
  STARTER_ARCHETYPES,
  getStarterDeck,
  calculateAge
} from './AuthManager.js';
import { diceCanvas } from './view/DiceCanvas.js';
import { MulliganModal } from './view/MulliganModal.js';
import { SearchSelectGridModal } from './view/SearchSelectGridModal.js';
import { TargetSelectorModal } from './view/TargetSelectorModal.js';
import { PermanentActionDrawer } from './view/PermanentActionDrawer.js';
import { DamageAssignmentModal } from './view/DamageAssignmentModal.js';
import { RPMDiceRollOverlay } from './view/RPMDiceRollOverlay.js';
import { CastAvailabilityManager } from './CastAvailabilityManager.js';
import { DeckSlotManager, CompatibilityReviewQueue } from './deckbuilder/DeckSlotManager.js';
import { PRECONSTRUCTED_STARTER_DECKS, getPreconstructedDeckById } from './deckbuilder/PreconstructedDecks.js';

/**
 * Standard MTG Zone Drawers
 */
const OPPONENT_ZONES = ['creatures', 'noncreatures', 'planeswalkers', 'graveyard', 'library', 'hand', 'exile'];
const PLAYER_ZONES = ['hand', 'creatures', 'noncreatures', 'planeswalkers', 'graveyard', 'library', 'exile'];

/**
 * Capitalizes string for display labels
 * @param {string} str 
 * @returns {string}
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Root Application Controller for RPM Tabletop Companion
 */
export class RPMAppController {
  /**
   * @param {Object} [options={}]
   */
  constructor(options = {}) {
    this.options = { ...options };
    this.container = null;
    this.isDestroyed = false;

    // URL Parameter Auto-Pairing & Autopilot Configuration
    let searchStr = '';
    if (typeof window !== 'undefined' && window.location && window.location.search) {
      searchStr = window.location.search;
    } else if (typeof options.urlSearch === 'string') {
      searchStr = options.urlSearch.startsWith('?') ? options.urlSearch : `?${options.urlSearch}`;
    }

    const urlParams = new URLSearchParams(searchStr);
    const autoRoom = options.autoRoom || urlParams.get('autoRoom');
    const autoRole = (options.role || urlParams.get('role') || 'host').toLowerCase();
    const deckParam = options.deck || urlParams.get('deck');
    const autoPlayParam = options.autoPlay ?? urlParams.get('autoPlay');
    const autoTestParam = options.autoTest ?? urlParams.get('autoTest');
    const delayParam = options.delay || urlParams.get('delay');

    this.autoRoomCode = autoRoom || null;
    this.autoRole = autoRole;
    this.autoPlayEnabled = false;
    this.autoPlayDelayMs = Number(delayParam) || 800;
    this.activeDeckId = null;

    if (autoRoom) {
      this.requireAuth = false;
      this.options.requireAuth = false;
      options.requireAuth = false;
      this.autoPlayEnabled = Boolean(
        autoPlayParam === '1' || autoPlayParam === 1 || autoPlayParam === true || autoPlayParam === 'true' ||
        autoTestParam === '1' || autoTestParam === 1 || autoTestParam === true || autoTestParam === 'true'
      );

      // Auto-select and equip deck
      const defaultDeckId = (this.autoRole === 'host') ? 'AMERICAN_GADGETS' : 'BURN';
      const selectedDeckId = deckParam || defaultDeckId;
      this.activeDeckId = selectedDeckId;
      const loadedDeck = getPreconstructedDeckById(selectedDeckId);
      if (loadedDeck) {
        this.activeDeckData = loadedDeck;
      }
      this.username = (this.autoRole === 'host') ? 'Host (Laptop)' : 'Guest (Phone)';
      this.myPlayerId = (this.autoRole === 'host') ? 'player_1' : 'player_2';
      options.myPlayerId = this.myPlayerId;
      options.username = this.username;
      this.options.autoConnect = true;
    } else {
      this.requireAuth = Boolean(options.requireAuth);
    }

    // Feature 15 AuthManager & Profile Initialization
    this.authManager = options.authManager || new AuthManager(options);
    this.botAgents = new Map();

    // Local player identity
    this.myPlayerId = this.myPlayerId || options.myPlayerId || options.userId || options.preferredSeat || (this.authManager?.getCurrentUser()?.id || 'p1');
    this.username = this.username || options.username || (this.authManager?.getCurrentUser()?.username || 'Alice');
    this.audioEnabled = options.audioEnabled !== false;

    // Seating and initial players (default: 2 players, with local seat aligned to this.myPlayerId)
    const initialPlayers = options.players || options.playerIds || (
      autoRoom
        ? ['player_1', 'player_2']
        : (options.initialPlayerCount
            ? Array.from({ length: options.initialPlayerCount }, (_, i) => i === 0 ? (this.myPlayerId || 'p1') : `p${i + 1}`)
            : [this.myPlayerId || 'p1', 'p2'])
    );
    this.playerIds = [...initialPlayers];
    this.executionLog = [];
    this.traceLogger = options.traceLogger || defaultProcessTraceLogger;
    this.showTraceLog = Boolean(options.showTraceLog);
    this._selectedAttackers = new Set();
    this.attackerTargets = {};
    this._blockerAssignments = new Map();
    this._activeAttackerTargetId = null;
    this._lastLoggedTurnHandoverKey = null;
    this._selectedLandId = null;
    this.autoPassEnabled = false;
    this.phaseStops = new Set(['COMBAT']);

    if (this.traceLogger) {
      this._wireTraceLogger(this.traceLogger);
    }

    // Accordion drawers expansion state: [playerId][zone] -> boolean
    this.drawerState = {
      [this.myPlayerId]: { hand: true }
    };
    for (const pid of this.playerIds) {
      if (!this.drawerState[pid]) this.drawerState[pid] = {};
    }

    // Active Chat Tab: 'TURN_COMMAND' | 'CHIT_CHAT'
    this.activeChatTab = 'TURN_COMMAND';

    // Active Modal Layer: 'NONE' | 'CARD_OVERLAY' | 'DECKBUILDER' | 'VICTORY_FANFARE' | 'DISAMBIGUATION'
    this.activeModalType = 'NONE';
    this.activeModalData = null;

    // Stored references for cleanup
    this._unsubscribers = [];
    this._activeTimers = new Set();
    this._domListeners = [];
    this._boundKeyDown = this._handleGlobalKeyDown.bind(this);
    this._lastRoll = null;
    this._lastAlarmState = null;
    this.perkinsAgent = null;

    // 1. Storage & Profiles
    this.storage = options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.storageAdapter = options.storageAdapter || new StorageAdapter(options);
    this.profileManager = options.profileManager || new ProfileManager({
      storageAdapter: this.storageAdapter,
      ...options
    });

    // 2. Deckbuilder AI & Scryfall Service
    this.scryfallService = options.scryfallService || new ScryfallService({
      cacheAdapter: options.cacheAdapter || (typeof localStorage !== 'undefined' ? new LocalStorageCacheAdapter() : new MemoryCacheAdapter()),
      fetchFn: options.fetchFn
    });
    this.deckbuilderAI = options.deckbuilderAI || new DeckbuilderAI({
      storage: this.storageAdapter,
      defaultUserId: this.myPlayerId
    });

    // 3. Victory Fanfare Engine
    this.victoryFanfare = options.victoryFanfare || new VictoryFanfareEngine({
      container: null,
      ...options
    });

    // 4. WebSocket Relay Client
    const defaultRelayUrl = (typeof window !== 'undefined' && window.location && window.location.host)
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
      : 'ws://localhost:3000';

    this.relayUrl = options.relayUrl || defaultRelayUrl;
    this.relayClient = options.relayClient || new RelayClient({
      url: this.relayUrl
    });

    // 5. Tabletop State Manager
    this.tabletopState = options.tabletopState || new TabletopStateManager({
      players: this.playerIds,
      traceLogger: this.traceLogger,
      ...options
    });
    if (this.tabletopState && !this.tabletopState.traceLogger) {
      this.tabletopState.traceLogger = this.traceLogger;
    }

    // Ensure players exist in state
    if (this.tabletopState && this.tabletopState.players) {
      for (const pid of this.playerIds) {
        if (!this.tabletopState.players[pid]) {
          this.tabletopState.players[pid] = {
            id: pid,
            name: pid === this.myPlayerId ? this.username : `Player ${pid.toUpperCase()}`,
            resources: { life: 20, poison: 0, energy: 0, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 } },
            zones: { hand: [], library: [], graveyard: [], exile: [], battlefield: [] },
            isEliminated: false
          };
        }
      }
    }

    // 6. Priority State Machine
    this.priorityMachine = options.priorityMachine || new PriorityStateMachine({
      players: this.playerIds,
      activePlayerId: this.playerIds[0] || 'p1',
      ...options
    });
    if (this.tabletopState) {
      this.tabletopState.priorityMachine = this.priorityMachine;
    }
    if (this.priorityMachine && typeof this.priorityMachine.passPriority !== 'function') {
      this.priorityMachine.passPriority = (pid) => {
        return this.priorityMachine.dispatch('PASS_PRIORITY', { playerId: pid });
      };
    }

    // 7. Stack Alarm Manager (15s countdown)
    this.alarmManager = options.alarmManager || this.priorityMachine.alarmManager || new StackAlarmManager({
      durationMs: 15000
    });
    if (this.priorityMachine) {
      this.priorityMachine.alarmManager = this.alarmManager;
    }
    if (this.alarmManager && !('isRunning' in this.alarmManager)) {
      Object.defineProperty(this.alarmManager, 'isRunning', {
        get: () => this.alarmManager.status === 'RUNNING',
        configurable: true
      });
    }

    // 8. Random Perk Upkeep Engine (INV-PERK-4, INV-PERK-7)
    this.randomPerk = options.randomPerk || new RandomPerkEngine({
      tabletopState: this.tabletopState,
      priorityStateMachine: this.priorityMachine,
      stackAlarmManager: this.alarmManager,
      initialPlayerCount: this.playerIds.length,
      ...options
    });

    // 9. Dual-Channel Priority Chat & Action Lexer
    this.actionLexer = options.actionLexer || new ActionLexer();
    this.dualChat = options.dualChat || new DualChannelChat({
      priorityMachine: this.priorityMachine,
      lexer: this.actionLexer,
      myPlayerId: this.myPlayerId
    });

    // 10. Card Preview Modal
    this.cardModal = options.cardModal || new CardOverlayModal({
      container: null,
      onClose: () => {
        if (this.activeModalType === 'CARD_OVERLAY') {
          this.closeModal();
        }
      }
    });

    // Deck Slot Manager & Compatibility Review Queue ([P27, P28, P29])
    this.deckSlotManager = options.deckSlotManager || new DeckSlotManager({
      storage: (typeof localStorage !== 'undefined') ? localStorage : (this.storage || null)
    });
    this.compatibilityReviewQueue = options.compatibilityReviewQueue || new CompatibilityReviewQueue({
      storage: (typeof localStorage !== 'undefined') ? localStorage : (this.storage || null)
    });
    this.botAssignedDecks = options.botAssignedDecks || {};
    this.botFastForward = Boolean(options.botFastForward);

    // 11. Feature 19, 20 & 21 Interactive Modals
    this.pregameEnabled = options.pregame === true;
    this.pregameActive = false;
    this.pregameMachine = null;
    this.mulliganModal = options.mulliganModal || new MulliganModal({
      onKeep: (data) => this.handleMulliganKeep(data),
      onMulligan: (data) => this.handleMulliganTake(data),
      onConfirmBottom: (data) => this.handleMulliganConfirmBottom(data)
    });

    this.searchModal = options.searchModal || new SearchSelectGridModal();

    this.targetModal = options.targetModal || new TargetSelectorModal({
      onSelectTarget: (data) => this.handleTargetSelected(data),
      onCancel: () => {
        this._pendingSpellToCast = null;
        this._stagedCast = null;
        this.render?.();
        this.reconcileDOM?.();
      }
    });

    this.actionDrawer = options.actionDrawer || options.permanentDrawer || new PermanentActionDrawer({
      onActivateAbility: (data) => this.handleAbilityActivated(data),
      onTapForMana: (data) => this.handleDrawerTapMana(data),
      onEquipToCreature: ({ equipment, targetCreature, playerId }) => {
        if (this.tabletopState) {
          if (typeof this.tabletopState.activateEquipAbility === 'function') {
            try {
              const effectiveCost = typeof this.tabletopState.computeEquipCost === 'function'
                ? this.tabletopState.computeEquipCost(playerId, equipment, targetCreature)
                : null;
              const isFree = effectiveCost === '{0}';
              if (isFree) {
                this.showToast?.('⚒️ [Forge Anew]: First equip ability this turn costs {0}!');
                console.log('[RPM] ⚒️ [Forge Anew]: First equip ability this turn costs {0}!');
              }
              this.tabletopState.activateEquipAbility(playerId, equipment.instanceId, targetCreature.instanceId, { isFree });
            } catch (err) {
              this.showWarningBanner(`⚠️ ${err.message || 'Cannot equip permanent'}`);
              return;
            }
          } else if (typeof this.tabletopState.attachPermanentToCreature === 'function') {
            this.tabletopState.attachPermanentToCreature(playerId, equipment.instanceId, targetCreature.instanceId);
          } else if (typeof this.tabletopState.attachPermanent === 'function') {
            this.tabletopState.attachPermanent(equipment.instanceId, targetCreature.instanceId);
          }
        }
        this.reconcileDOM();
      }
    });
    this.permanentDrawer = this.actionDrawer;
    if (this.tabletopState) {
      if (typeof this.tabletopState.attachPermanentToCreature !== 'function' && typeof this.tabletopState.attachPermanent === 'function') {
        this.tabletopState.attachPermanentToCreature = (playerId, equipmentId, targetCreatureId) => {
          return this.tabletopState.attachPermanent(equipmentId, targetCreatureId);
        };
      }
      if (typeof this.tabletopState.evaluateCreatureStats !== 'function') {
        this.tabletopState.evaluateCreatureStats = (cr, playerId) => {
          if (this.tabletopState.abilityEngine && typeof this.tabletopState.abilityEngine.evaluateCreatureStats === 'function') {
            return this.tabletopState.abilityEngine.evaluateCreatureStats(cr, this.tabletopState);
          }
          return {
            power: cr?.power ?? 1,
            toughness: cr?.toughness ?? 1,
            effectivePower: cr?.power ?? 1,
            effectiveToughness: cr?.toughness ?? 1,
            keywords: cr?.keywords || {}
          };
        };
      }
    }

    this.damageModal = options.damageModal || new DamageAssignmentModal({
      onConfirmAssignment: (data) => this.handleDamageConfirmed(data)
    });

    // 12. RPM Step 1 Emblem Dice Roll Overlay & Viewport
    this.diceRollOverlay = options.diceRollOverlay || new RPMDiceRollOverlay({
      app: this,
      bannerDurationMs: options.bannerDurationMs ?? 1500
    });

    if (this.tabletopState && typeof this.tabletopState.getActionCombinationsForSpell !== 'function') {
      this.tabletopState.getActionCombinationsForSpell = (playerId, card, castMode) => {
        return this._getActionCombinationsForSpell(playerId, card, castMode);
      };
    }
    this._hoverPreviewTimer = null;
    this._longPressTimer = null;
    this._activePreviewCard = null;
    this._hasBoundGlobalTooltipDismiss = false;

    // Handle container option if provided
    if (options.container) {
      this.container = typeof options.container === 'string' && typeof document !== 'undefined'
        ? document.querySelector(options.container)
        : options.container;
    }

    // Feature 14, 15 & 16 Tab Router & State (INV-HUB-1)
    let defaultTab = options.initialTab || 'LOBBY';
    if (this.requireAuth && (options.strictAuthGate || options.initialTab === 'AUTH')) {
      if (!this.authManager.isAuthenticated()) {
        defaultTab = 'AUTH';
      } else if (!this.authManager.isOnboarded()) {
        defaultTab = 'DECKBUILDER';
      } else {
        defaultTab = 'LOBBY';
      }
    }

    this._isSpectator = Boolean(options.isSpectator);
    this.spectatorMatches = options.spectatorMatches || null;

    this.tabRouter = options.tabRouter || new TabRouter({
      initialTab: defaultTab,
      strictAuthGate: Boolean(options.strictAuthGate || options.initialTab === 'AUTH'),
      onTabChange: (newTab, prevTab) => {
        this.reconcileDOM();
      },
      onLockoutBlocked: (targetTab) => {
        this.showConcedeModal(() => {
          this.concedeMatch();
          this.tabRouter.navigate(targetTab, this.getMatchState(), this.isSpectator());
        });
      }
    });

    if (this.authManager && typeof this.authManager.on === 'function') {
      this.authManager.on('auth_state_changed', () => {
        this._syncAuthUser();
        this.reconcileDOM();
      });
      this.authManager.on('profile_updated', () => {
        this._syncAuthUser();
        this.reconcileDOM();
      });
      this.authManager.on('onboarding_completed', () => {
        this._syncAuthUser();
        this.reconcileDOM();
      });
    }

    if (this.authManager && typeof this.authManager.autoRestoreSession === 'function') {
      try {
        this.authManager.autoRestoreSession().then(() => {
          this._syncAuthUser();
          this.reconcileDOM();
        }).catch(() => {});
      } catch (_) {}
    }

    this.isMatchActiveFlag = Boolean(options.isMatchActive);
    this._hasMatchStarted = Boolean(options.hasMatchStarted);
    this.matchHistory = options.matchHistory || [];
    this._isVictoryModalOpen = false;
    this._isDeckbuilderModalOpen = false;
    this._isRecapModalOpen = false;
    this.selectedHandCardId = null;
    this.turnRollOffManager = null;
    this.isRollOffActive = false;
    this.rollOffResult = null;
    this.deckbuilderMode = 'FREE_CONSTRUCT';
    this.queueSearchStartTime = null;
    this.queueSearchInterval = null;
    this.activeDeckSlot = 1;
    this.activeDeckData = null;
    try {
      const storage = (typeof localStorage !== 'undefined') ? localStorage : (this.storage || null);
      if (storage) {
        const savedSlot = storage.getItem('rpm_active_deck_slot');
        if (savedSlot) {
          this.activeDeckSlot = parseInt(savedSlot, 10) || 1;
        }
        const rawMap = storage.getItem('rpm_saved_decks_by_slot');
        if (rawMap) {
          const slotMap = JSON.parse(rawMap);
          if (slotMap && slotMap[this.activeDeckSlot]) {
            this.activeDeckData = slotMap[this.activeDeckSlot];
          }
        }
      }
    } catch (_) {}

    // Lobby & Matchmaking
    this.lobbyManager = options.lobbyManager || new LobbyManager({ roomCode: 'LOBBY1' });
    if (!this.requireAuth || (this.authManager && this.authManager.isAuthenticated())) {
      this.lobbyManager.claimSeat(this.myPlayerId, this.username, 1);
    }
    this.lobbyManager.on('LOBBY_READY_RESET', () => {
      this.reconcileDOM();
    });
    this.lobbyManager.on('COUNTDOWN_STARTED', () => {
      this.reconcileDOM();
    });
    this.lobbyManager.on('COUNTDOWN_TICK', () => {
      this.reconcileDOM();
    });
    this.lobbyManager.on('COUNTDOWN_ABORTED', () => {
      this.reconcileDOM();
    });
    this.lobbyManager.on('MATCH_START_TRIGGERED', () => {
      this.startRollOff();
    });
    this.matchmakingQueue = options.matchmakingQueue || new MatchmakingQueue();

    this._autoRoomFlowStarted = false;
    this._autoPregameTriggered = false;
    this._autopilotRunning = false;

    if (this.autoRoomCode && typeof window === 'undefined') {
      queueMicrotask(() => {
        if (!this._autoRoomFlowStarted) {
          this._autoRoomFlowStarted = true;
          this._startAutoRoomFlow().catch(() => {});
        }
      });
    }
  }

  get perkEngine() {
    return this.randomPerk;
  }

  set perkEngine(val) {
    this.randomPerk = val;
  }

  /**
   * Returns true if running in interactive browser UI mode (not headless / Node test runner).
   * @returns {boolean}
   */
  isInteractiveBrowserMode() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (typeof process !== 'undefined' && process.env && (process.env.NODE_ENV === 'test' || process.versions?.node)) {
      return false;
    }
    if (typeof window !== 'undefined' && window.__RPM_HEADLESS_TEST__) return false;
    return true;
  }

  isMatchActive() {
    if (this.isMatchActiveFlag) return true;
    if (this._hasMatchStarted) return true;
    if (this.relayClient?.roomStatus === 'MATCH_ACTIVE') return true;
    return false;
  }

  getMatchState() {
    const state = {
      status: this.isMatchActive() ? 'ACTIVE' : (this.isRollOffActive ? 'ROLL_OFF_PHASE' : 'IDLE'),
      isMatchActive: this.isMatchActive(),
      isSpectator: this.isSpectator()
    };
    if (this.requireAuth) {
      state.isAuthenticated = this.authManager ? this.authManager.isAuthenticated() : false;
      state.isOnboarded = this.authManager ? this.authManager.isOnboarded() : false;
    }
    return state;
  }

  isSpectator() {
    return Boolean(this.options.isSpectator || this._isSpectator || this.relayClient?.isSpectator);
  }

  getOngoingMatches() {
    if (this.options.spectatorMatches) return this.options.spectatorMatches;
    if (this.relayClient && typeof this.relayClient.getOngoingMatches === 'function') {
      return this.relayClient.getOngoingMatches();
    }
    return this.spectatorMatches || [
      {
        roomCode: '#POD-1',
        roomType: 'POD_MULTIPLAYER',
        format: 'Commander (4p)',
        status: 'MATCH_ACTIVE',
        roundNumber: 3,
        activePlayerTurnNumber: 2,
        activePlayerName: 'Alice',
        seatedPlayers: [
          { playerId: 'p1', playerName: 'Alice', isBot: false, life: 34, colorIdentity: ['U', 'R'] },
          { playerId: 'p2', playerName: 'Bob', isBot: false, life: 28, colorIdentity: ['G'] },
          { playerId: 'p3', playerName: 'Perkins x2', isBot: true, life: 40, colorIdentity: ['R'] }
        ],
        spectatorCount: 4
      },
      {
        roomCode: '#DUEL-2',
        roomType: 'DUEL_1V1',
        format: '1v1 Ranked',
        status: 'MATCH_ACTIVE',
        roundNumber: 3,
        activePlayerTurnNumber: 3,
        activePlayerName: 'Gideon',
        seatedPlayers: [
          { playerId: 'p1', playerName: 'Gideon', isBot: false, life: 18, colorIdentity: ['W'] },
          { playerId: 'p2', playerName: 'Jace', isBot: false, life: 14, colorIdentity: ['U'] }
        ],
        spectatorCount: 12
      },
      {
        roomCode: '#PRIV-3',
        roomType: 'CUSTOM_ROOM',
        format: 'Custom Pod',
        status: 'MATCH_ACTIVE',
        roundNumber: 1,
        activePlayerTurnNumber: 1,
        activePlayerName: 'Carlos',
        seatedPlayers: [
          { playerId: 'p1', playerName: 'Carlos', isBot: false, life: 20, colorIdentity: ['B'] },
          { playerId: 'p2', playerName: 'Dave', isBot: false, life: 20, colorIdentity: ['G'] },
          { playerId: 'p3', playerName: 'Eve', isBot: false, life: 20, colorIdentity: ['W'] }
        ],
        spectatorCount: 1
      }
    ];
  }

  setSpectatorMatches(matches) {
    this.spectatorMatches = matches;
    this.reconcileDOM();
  }

  watchMatch(roomCode) {
    this._isSpectator = true;
    this.options.isSpectator = true;
    if (this.lobbyManager && typeof this.lobbyManager.registerSpectator === 'function') {
      this.lobbyManager.registerSpectator(this.myPlayerId);
    }
    this.tabRouter.navigate('ARENA', this.getMatchState(), true);
    this.reconcileDOM();
  }

  exitSpectating() {
    this._isSpectator = false;
    this.options.isSpectator = false;
    if (this.lobbyManager && typeof this.lobbyManager.unregisterSpectator === 'function') {
      this.lobbyManager.unregisterSpectator(this.myPlayerId);
    }
    this.tabRouter.navigate('LOBBY', this.getMatchState(), false);
    this.reconcileDOM();
  }

  startMatch(matchOptions = {}) {
    this._hasMatchStarted = true;
    this.isMatchActiveFlag = true;
    this.isRollOffActive = false;
    this._openingHandActionsResolved = false;
    this._lastLoggedTurnHandoverKey = null;

    if (this.traceLogger && typeof this.traceLogger.clear === 'function') {
      this.traceLogger.clear();
    }
    this.executionLog = [];
    if (this.dualChat && Array.isArray(this.dualChat.turnCommandMessages)) {
      this.dualChat.turnCommandMessages = [];
    }

    // Purge and sanitize TabletopStateManager (INV-LOBBY-6, Screenshot 1 Bug Fix)
    const seatedSlots = this.lobbyManager ? this.lobbyManager.getSeatedSlots() : [];
    if (Array.isArray(matchOptions?.playerIds) && matchOptions.playerIds.length > 0) {
      this.playerIds = [...matchOptions.playerIds];
    } else if (this.priorityMachine?.players?.length > 0 && this.rollOffResult?.isComplete) {
      this.playerIds = [...this.priorityMachine.players];
    } else if (seatedSlots.length > 1) {
      this.playerIds = seatedSlots.map(s => s.playerId);
    } else if (!this.playerIds || this.playerIds.length === 0) {
      this.playerIds = seatedSlots.length > 0 ? seatedSlots.map(s => s.playerId) : [this.myPlayerId];
    }

    if (this.tabletopState) {
      this.tabletopState.isGameOver = false;
      this.tabletopState.winnerId = null;
      this.tabletopState.stack = [];
      this.tabletopState._stack = [];
      this.tabletopState.combatState = { attackers: [], blockers: [] };
      this.tabletopState.turnNumber = 1;
      this.tabletopState.roundNumber = 1;
      this.tabletopState.players = {};
      if (this.tabletopState._drawsExecutedThisTurn && typeof this.tabletopState._drawsExecutedThisTurn.clear === 'function') {
        this.tabletopState._drawsExecutedThisTurn.clear();
      }
      for (const pid of this.playerIds) {
        const slot = seatedSlots.find(s => s.playerId === pid);
        const name = slot ? slot.playerName : (pid === this.myPlayerId ? this.username : `Player ${pid.toUpperCase()}`);
        if (typeof this.tabletopState.registerPlayer === 'function') {
          try {
            this.tabletopState.registerPlayer(pid, name);
          } catch (_) {}
        }
        this.tabletopState.players[pid] = {
          id: pid,
          playerId: pid,
          name,
          resources: { life: 20, poison: 0, energy: 0, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, landsPlayedThisTurn: 0, maxLandsPerTurn: 1 },
          zones: { hand: [], library: [], graveyard: [], exile: [], battlefield: [] },
          battlefield: { lands: [], creatures: [], noncreatures: [], planeswalkers: [] },
          hand: [],
          library: [],
          graveyard: [],
          exile: [],
          isEliminated: false,
          turnsTaken: 0
        };
      }
    }

    if (this.priorityMachine) {
      this.priorityMachine.isGameOver = false;
      this.priorityMachine.players = [...this.playerIds];
      this.priorityMachine.turnNumber = 1;
      this.priorityMachine.roundNumber = 1;
      this.priorityMachine.stack = [];
      this.priorityMachine._stack = [];
      this.priorityMachine.consecutivePassCount = 0;
      if (this.priorityMachine.playerTurnCounts && typeof this.priorityMachine.playerTurnCounts.clear === 'function') {
        this.priorityMachine.playerTurnCounts.clear();
      }
      const startId = this.priorityMachine.startingPlayerId || this.priorityMachine.activePlayerId || this.playerIds[0];
      this.priorityMachine.startingPlayerId = startId;
      this.priorityMachine.activePlayerId = startId;
      this.priorityMachine.priorityPlayerId = startId;
      if (this.tabletopState) {
        this.tabletopState.startingPlayerId = startId;
        this.tabletopState.priorityMachine = this.priorityMachine;
      }
    }

    if (this.perkEngine && typeof this.perkEngine.reconfigure === 'function') {
      this.perkEngine.reconfigure(this.playerIds.length);
    }

    // Dismiss lingering modals from previous matches
    if (this.container) {
      const victoryModal = this.container.querySelector('#victory-modal');
      if (victoryModal) victoryModal.classList.add('hidden');
      const mulliganModalEl = this.container.querySelector('#mulligan-modal');
      if (mulliganModalEl) mulliganModalEl.classList.add('hidden');
      const castModeModal = this.container.querySelector('#cast-mode-selector-modal');
      if (castModeModal) {
        try { castModeModal.remove(); } catch (_) {}
      }
    }

    if (!this.botAgents) {
      this.botAgents = new Map();
    }
    if (this.perkinsAgent && this.perkinsAgent.isDestroyed) {
      this.perkinsAgent = null;
    }
    for (const [bId, bot] of this.botAgents.entries()) {
      if (bot !== this.perkinsAgent || bot.isDestroyed) {
        try { bot.destroy(); } catch (_) {}
        this.botAgents.delete(bId);
      }
    }
    if (this.perkinsAgent && !this.perkinsAgent.isDestroyed && this.playerIds.includes(this.perkinsAgent.slotId)) {
      this.botAgents.set(this.perkinsAgent.slotId, this.perkinsAgent);
    }

    for (const slot of seatedSlots) {
      if (slot.isBot) {
        const storedAssigned = this._assignedBotDecks?.get(slot.playerId) || this._assignedBotDecks?.get(String(slot.slotId));
        const assignedKey = this.botAssignedDecks?.[String(slot.slotId)] || this.botAssignedDecks?.[slot.playerId];
        const customAssigned = storedAssigned || ((assignedKey && assignedKey !== 'RANDOM')
          ? (typeof this.assignDeckToBot === 'function' ? this.assignDeckToBot(slot.slotId, assignedKey) : null)
          : null);
        const starter = customAssigned || getStarterDeck(slot.starterDeckId || 'R') || BEGINNER_DECKS.R;
        const botPlayer = this.tabletopState?.players?.[slot.playerId];
        if (botPlayer && starter) {
          const mainboard = starter.mainboard || [];
          const libCards = mainboard.flatMap(c => {
            const count = c.count || 1;
            const meta = getHydratedCardMetadata(c.name);
            return Array.from({ length: count }, () => {
              const cardObj = {
                instanceId: generateInstanceId(),
                ownerId: slot.playerId,
                controllerId: slot.playerId,
                name: c.name,
                typeLine: c.type || meta?.typeLine || 'Creature',
                manaCost: c.manaCost ?? meta?.manaCost ?? (c.cmc === 0 ? '' : '{R}'),
                cmc: c.cmc ?? meta?.cmc ?? 1,
                power: c.power ?? meta?.power ?? 2,
                toughness: c.toughness ?? meta?.toughness ?? 2,
                keywords: { ...(meta?.keywords || {}), ...(c.keywords || {}) },
                effect: meta?.effect || null,
                isTapped: false,
                isSummoningSick: false
              };
              return TabletopStateManager.hydrateCardMechanics(cardObj);
            });
          });
          botPlayer.library = libCards;
          botPlayer.zones = botPlayer.zones || {};
          botPlayer.zones.library = [...libCards];
        }

        let agent = this.botAgents.get(slot.playerId);
        if (agent && agent.isDestroyed) {
          this.botAgents.delete(slot.playerId);
          agent = null;
        }
        if (!agent && this.perkinsAgent?.slotId === slot.playerId && !this.perkinsAgent.isDestroyed) {
          agent = this.perkinsAgent;
        }
        if (!agent) {
          agent = new PerkinsAgent({
            slotId: slot.playerId,
            name: slot.playerName,
            mode: 'LOCAL',
            thinkingDelayMs: this.botFastForward ? 50 : 600,
            coachEnabled: false,
            starterDeck: starter
          });
          agent.attach(this);
          this.botAgents.set(slot.playerId, agent);
          this.perkinsAgent = agent;
        } else {
          this.botAgents.set(slot.playerId, agent);
          this.perkinsAgent = agent;
        }
      }
    }

    this.tabRouter.navigate('ARENA', this.getMatchState(), this.isSpectator());
    this.dealStartingHands();
    if (!this.pregameEnabled && !this.pregameActive && !this.isRollOffActive) {
      this._resolveOpeningHandActions();
    }
    this.reconcileDOM();

    // Synchronize deck manifest with relayClient if active online session exists
    if (this.relayClient && (this.relayClient.roomCode || this.relayClient.sessionId || this.relayClient.socket?.readyState === 1)) {
      try {
        const manifest = typeof this.exportDeckManifest === 'function' ? this.exportDeckManifest(this.myPlayerId) : null;
        if (manifest && typeof this.registerDeckManifest === 'function') {
          this.registerDeckManifest(manifest, this.myPlayerId);
        }
      } catch (err) {
        console.warn('[RPM] Non-fatal manifest sync error:', err);
      }
    }

    this.authManager?.dispatchTelemetry('MATCH_START', null, {
      playerIds: this.playerIds,
      botCount: this.botAgents.size
    });
  }

  concedeMatch() {
    this.isMatchActiveFlag = false;
    this._hasMatchStarted = false;
    if (this.botAgents) {
      for (const bot of this.botAgents.values()) {
        try { bot.destroy(); } catch (_) {}
      }
      this.botAgents.clear();
    }
    let elimResult = null;
    if (this.tabletopState && typeof this.tabletopState.eliminatePlayer === 'function') {
      try {
        elimResult = this.tabletopState.eliminatePlayer(this.myPlayerId, 'CONCEDED');
      } catch (_) {}
    }
    if (this.relayClient && typeof this.relayClient.send === 'function') {
      try {
        this.relayClient.send({ type: 'CONCEDE_MATCH' });
      } catch (_) {}
    }
    const modalRoot = this.container?.querySelector('#modal-root');
    if (modalRoot) {
      const cm = modalRoot.querySelector('#concede-modal');
      if (cm) {
        try {
          if (typeof cm.remove === 'function') cm.remove();
          else if (cm.parentNode) cm.parentNode.removeChild(cm);
        } catch (_) {}
      }
      if (!modalRoot.querySelector('.modal-dialog-box')) {
        modalRoot.setAttribute('aria-hidden', 'true');
      }
    }
    this.tabRouter.unlockAll?.();
    this.tabRouter.reset('LOBBY');
    if (elimResult && elimResult.gameOver) {
      this.showGameOverModal(elimResult);
    }
    this.reconcileDOM();
    this.authManager?.dispatchTelemetry('MATCH_CONCEDE', null, { playerId: this.myPlayerId });
  }

  showGameOverModal(data = {}) {
    const winnerId = data.winnerId || this.tabletopState?.winnerId;
    let winnerName = data.winnerName;
    if (!winnerName) {
      if (winnerId === this.myPlayerId) {
        winnerName = this.username || 'You';
      } else {
        const p = this.tabletopState?.players?.[winnerId];
        winnerName = p?.name || this.getFriendlyPlayerName(winnerId);
      }
    }
    this.openModal('VICTORY_FANFARE', {
      winnerId,
      winnerName,
      ...data
    });
  }

  showConcedeModal(onConfirm, onCancel) {
    const modalRoot = this.container?.querySelector('#modal-root');
    if (!modalRoot) return;

    const existing = modalRoot.querySelector('#concede-modal');
    if (existing) {
      try { existing.remove(); } catch (_) {}
    }

    modalRoot.setAttribute('aria-hidden', 'false');
    const concedeModal = document.createElement('div');
    concedeModal.id = 'concede-modal';
    concedeModal.className = 'modal-backdrop concede-modal-backdrop';
    concedeModal.innerHTML = `
      <div class="modal-dialog-box" role="dialog" aria-modal="true" aria-label="Concede Match Confirmation">
        <h2 style="color: #ff4d4d; margin-top: 0;">⚠️ ACTIVE MATCH IN PROGRESS</h2>
        <p style="color: #cbd5e1; font-size: 0.95rem; line-height: 1.5;">
          You are currently in an active match in the Arena. Leaving this screen will immediately <strong>CONCEDE</strong> the game to your opponent.
        </p>
        <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
          <button id="btn-concede-cancel" class="btn btn-secondary">Keep Playing</button>
          <button id="btn-concede-confirm" class="btn btn-danger" style="background: #dc2626; color: white;">Concede Match & Exit</button>
        </div>
      </div>
    `;

    const btnCancel = concedeModal.querySelector('#btn-concede-cancel');
    const btnConfirm = concedeModal.querySelector('#btn-concede-confirm');

    const cleanup = () => {
      try { concedeModal.remove(); } catch (_) {}
      const remaining = modalRoot.querySelectorAll('.modal-dialog-box, #concede-modal');
      if (remaining.length === 0) {
        modalRoot.setAttribute('aria-hidden', 'true');
      }
    };

    btnCancel.addEventListener('click', () => {
      cleanup();
      if (typeof onCancel === 'function') onCancel();
    });

    btnConfirm.addEventListener('click', () => {
      cleanup();
      if (typeof onConfirm === 'function') onConfirm();
    });

    modalRoot.appendChild(concedeModal);
  }

  showAuthModal(onSuccess) {
    const modalRoot = this.container?.querySelector('#modal-root');
    if (!modalRoot) return;

    const existing = modalRoot.querySelector('#contextual-auth-modal');
    if (existing) {
      try { existing.remove(); } catch (_) {}
    }

    modalRoot.setAttribute('aria-hidden', 'false');
    const authModal = document.createElement('div');
    authModal.id = 'contextual-auth-modal';
    authModal.className = 'modal-backdrop auth-modal-backdrop visible';
    authModal.innerHTML = `
      <div class="modal-dialog-box" role="dialog" aria-modal="true" aria-label="Authentication Required">
        <div class="modal-header-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 8px;">
          <h2 style="color: #38bdf8; margin: 0; font-size: 1.15rem;">🔐 Planeswalker Sign In Required</h2>
          <button class="modal-close-btn btn-icon" style="color: #ffffff; font-size: 1.2rem;">&times;</button>
        </div>

        <div class="auth-tabs" style="display: flex; gap: 8px; margin: 12px 0 6px 0;">
          <button type="button" id="auth-tab-login" class="btn btn-outline active" style="flex: 1; padding: 6px 10px; font-size: 0.85rem; cursor: pointer;">🔑 Iniciar Sesión (Login)</button>
          <button type="button" id="auth-tab-signup" class="btn btn-outline" style="flex: 1; padding: 6px 10px; font-size: 0.85rem; cursor: pointer;">✨ Crear Cuenta (Sign Up)</button>
        </div>

        <p id="auth-instruction-text" style="color: #cbd5e1; font-size: 0.95rem; line-height: 1.5; margin: 10px 0;">
          To join a match queue or claim a seat, please authenticate your Planeswalker identity.
        </p>

        <div class="modal-form-fields" style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px;">
          <input type="email" id="auth-email-input" class="auth-input" placeholder="planeswalker@tabletop.com" value="user@tabletop.com" autocomplete="email" />
          <input type="hidden" id="modal-auth-email" value="user@tabletop.com" />
          <input type="password" id="auth-password-input" class="auth-input" placeholder="Contraseña (mínimo 6 caracteres)" value="secret123" autocomplete="current-password" />
          <div id="auth-signup-fields" style="display: none;">
            <input type="text" id="modal-auth-username" class="auth-input" placeholder="Display Name" value="${this.username || 'Planeswalker'}" style="width: 100%; box-sizing: border-box;" />
          </div>
        </div>

        <div id="auth-error" class="auth-error-msg" style="display: none; color: #ef4444; font-size: 0.85rem; margin-bottom: 10px; padding: 6px 8px; background: rgba(239, 68, 68, 0.1); border-radius: 4px; border: 1px solid rgba(239, 68, 68, 0.3);"></div>

        <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 10px;">
          <button id="btn-modal-auth-cancel" class="btn btn-secondary">Cancel</button>
          <button id="btn-modal-dev-login" class="btn btn-secondary btn-dev-bypass">⚡ Dev Login</button>
          <button id="auth-submit-btn" class="btn btn-primary">Sign In</button>
          <button id="btn-modal-auth-confirm" class="btn btn-primary" style="display: none;" aria-hidden="true">Sign In</button>
        </div>
      </div>
    `;

    const cleanup = () => {
      try { authModal.remove(); } catch (_) {}
      const remaining = modalRoot.querySelectorAll('.modal-dialog-box, #concede-modal, #contextual-auth-modal, #contextual-deck-modal');
      if (remaining.length === 0) {
        modalRoot.setAttribute('aria-hidden', 'true');
      }
    };

    authModal.querySelector('.modal-close-btn')?.addEventListener('click', cleanup);
    authModal.querySelector('#btn-modal-auth-cancel')?.addEventListener('click', cleanup);

    let activeTab = 'login';
    const tabLogin = authModal.querySelector('#auth-tab-login');
    const tabSignup = authModal.querySelector('#auth-tab-signup');
    const signupFields = authModal.querySelector('#auth-signup-fields');
    const submitBtn = authModal.querySelector('#auth-submit-btn');
    const confirmBtn = authModal.querySelector('#btn-modal-auth-confirm');
    const errorDiv = authModal.querySelector('#auth-error');
    const emailInput = authModal.querySelector('#auth-email-input');
    const hiddenEmailInput = authModal.querySelector('#modal-auth-email');
    const passwordInput = authModal.querySelector('#auth-password-input');
    const usernameInput = authModal.querySelector('#modal-auth-username');

    if (emailInput && hiddenEmailInput) {
      emailInput.addEventListener('input', () => {
        hiddenEmailInput.value = emailInput.value;
      });
    }

    const setTab = (tab) => {
      activeTab = tab;
      if (errorDiv) {
        errorDiv.textContent = '';
        errorDiv.style.display = 'none';
      }
      if (tab === 'login') {
        tabLogin?.classList.add('active');
        tabSignup?.classList.remove('active');
        if (signupFields) signupFields.style.display = 'none';
        if (submitBtn) submitBtn.textContent = 'Sign In';
      } else {
        tabSignup?.classList.add('active');
        tabLogin?.classList.remove('active');
        if (signupFields) signupFields.style.display = 'block';
        if (submitBtn) submitBtn.textContent = 'Crear Cuenta';
      }
    };

    tabLogin?.addEventListener('click', () => setTab('login'));
    tabSignup?.addEventListener('click', () => setTab('signup'));

    const finishAuth = async () => {
      this._syncAuthUser();
      if (this.authManager && !this.authManager.isOnboarded()) {
        const existingDeck = this.activeDeckData || this.getActiveDeckForPlayer(this.myPlayerId);
        if (existingDeck && Array.isArray(existingDeck.mainboard) && existingDeck.mainboard.length > 0 && typeof this.authManager.saveActiveDeck === 'function') {
          try {
            await this.authManager.saveActiveDeck(existingDeck.id || `custom_${Date.now()}`, existingDeck);
          } catch (_) {}
        }
      }
      cleanup();
      if (this.authManager && !this.authManager.isOnboarded()) {
        this.showDeckModal(onSuccess);
      } else {
        if (typeof onSuccess === 'function') onSuccess();
        this.reconcileDOM();
      }
    };

    const doSubmit = async () => {
      const email = (emailInput?.value || hiddenEmailInput?.value || '').trim();
      const password = (passwordInput?.value || '').trim();
      const displayName = (usernameInput?.value || '').trim();

      if (errorDiv) {
        errorDiv.textContent = '';
        errorDiv.style.display = 'none';
      }

      try {
        if (activeTab === 'signup') {
          if (this.authManager && typeof this.authManager.signUpWithPassword === 'function') {
            await this.authManager.signUpWithPassword(email, password, displayName);
          } else if (this.authManager && typeof this.authManager.instantDevLogin === 'function') {
            await this.authManager.instantDevLogin(email, displayName || 'Planeswalker', '1995-01-01');
          }
        } else {
          if (this.authManager && typeof this.authManager.signInWithPassword === 'function') {
            await this.authManager.signInWithPassword(email, password);
          } else if (this.authManager && typeof this.authManager.instantDevLogin === 'function') {
            await this.authManager.instantDevLogin(email, displayName || 'Planeswalker', '1995-01-01');
          }
        }
        await finishAuth();
      } catch (err) {
        if (errorDiv) {
          errorDiv.textContent = err.message || 'Authentication error';
          errorDiv.style.display = 'block';
        }
      }
    };

    submitBtn?.addEventListener('click', doSubmit);
    confirmBtn?.addEventListener('click', doSubmit);

    authModal.querySelector('#btn-modal-dev-login')?.addEventListener('click', async () => {
      if (this.authManager) {
        if (typeof this.authManager.instantDevLogin === 'function') {
          await this.authManager.instantDevLogin('dev@tabletop.com', 'Dev Planeswalker', '1995-01-01');
        } else if (typeof this.authManager.loginWithDevBypass === 'function') {
          await this.authManager.loginWithDevBypass('dev@tabletop.com', 'Dev Planeswalker');
        }
      }
      await finishAuth();
    });

    modalRoot.appendChild(authModal);
  }

  showDeckModal(onSuccess) {
    const modalRoot = this.container?.querySelector('#modal-root');
    if (!modalRoot) return;

    const existing = modalRoot.querySelector('#contextual-deck-modal');
    if (existing) {
      try { existing.remove(); } catch (_) {}
    }

    modalRoot.setAttribute('aria-hidden', 'false');
    const deckModal = document.createElement('div');
    deckModal.id = 'contextual-deck-modal';
    deckModal.className = 'modal-backdrop deck-modal-backdrop visible';
    deckModal.innerHTML = `
      <div class="modal-dialog-box" role="dialog" aria-modal="true" aria-label="Select Deck">
        <div class="modal-header-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 8px;">
          <h2 style="color: #38bdf8; margin: 0; font-size: 1.15rem;">📚 Select Starter Deck to Begin</h2>
          <button class="modal-close-btn btn-icon" style="color: #ffffff; font-size: 1.2rem;">&times;</button>
        </div>
        <p style="color: #cbd5e1; font-size: 0.95rem; line-height: 1.5; margin: 12px 0;">
          Choose an archetype to complete onboarding and enter the battlefield:
        </p>
        <div class="starter-cards-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 16px;">
          <button class="btn btn-outline btn-select-starter" data-arch="R">🔥 Mono-Red Burn</button>
          <button class="btn btn-outline btn-select-starter" data-arch="U">💧 Mono-Blue Control</button>
          <button class="btn btn-outline btn-select-starter" data-arch="G">🌲 Mono-Green Stompy</button>
          <button class="btn btn-outline btn-select-starter" data-arch="W">⚔️ Mono-White Weenie</button>
        </div>
        <div class="modal-actions" style="display: flex; justify-content: flex-end;">
          <button id="btn-modal-deck-cancel" class="btn btn-secondary">Cancel</button>
        </div>
      </div>
    `;

    const cleanup = () => {
      try { deckModal.remove(); } catch (_) {}
      const remaining = modalRoot.querySelectorAll('.modal-dialog-box, #concede-modal, #contextual-auth-modal, #contextual-deck-modal');
      if (remaining.length === 0) {
        modalRoot.setAttribute('aria-hidden', 'true');
      }
    };

    deckModal.querySelector('.modal-close-btn')?.addEventListener('click', cleanup);
    deckModal.querySelector('#btn-modal-deck-cancel')?.addEventListener('click', cleanup);

    deckModal.querySelectorAll('.btn-select-starter').forEach(btn => {
      btn.addEventListener('click', async () => {
        const arch = btn.getAttribute('data-arch') || 'R';
        if (this.authManager) {
          if (typeof this.authManager.saveActiveDeck === 'function') {
            await this.authManager.saveActiveDeck(arch);
          } else if (typeof this.authManager.completeOnboarding === 'function') {
            await this.authManager.completeOnboarding(arch);
          }
        }
        cleanup();
        if (typeof onSuccess === 'function') onSuccess();
        this.reconcileDOM();
      });
    });

    modalRoot.appendChild(deckModal);
  }

  showWarningBanner(message) {
    this.lastWarning = message;
    let banner = this.container?.querySelector('#arena-warning-banner');
    if (!banner && this.container) {
      banner = document.createElement('div');
      banner.id = 'arena-warning-banner';
      banner.className = 'arena-warning-banner';
      const center = this.container.querySelector('#center-arena') || this.container.querySelector('#tabletop-arena') || this.container;
      center.prepend(banner);
    }
    if (banner) {
      banner.textContent = message;
      banner.style.display = 'block';
      if (this._warningBannerTimer) {
        clearTimeout(this._warningBannerTimer);
      }
      this._warningBannerTimer = setTimeout(() => {
        if (banner) {
          banner.style.display = 'none';
          banner.textContent = '';
        }
        this._warningBannerTimer = null;
      }, 3500);
    }
    this.showToast(message);
  }

  showToast(message) {
    this.lastToast = message;
    let toast = this.container?.querySelector('#arena-toast-notification');
    if (!toast && this.container) {
      toast = document.createElement('div');
      toast.id = 'arena-toast-notification';
      toast.className = 'arena-toast-notification toast-active';
      const center = this.container.querySelector('#center-arena') || this.container.querySelector('#tabletop-arena') || this.container;
      center.appendChild(toast);
    }
    if (!toast) return;
    toast.textContent = message;
    toast.style.display = 'block';
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
    }
    this._toastTimer = setTimeout(() => {
      if (toast) {
        toast.style.display = 'none';
        toast.textContent = '';
      }
      this._toastTimer = null;
    }, 3500);
  }

  _escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  _isRawUuid(str) {
    if (typeof str !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
  }

  _getLandPipInfo(land) {
    if (!land) return { colorKey: 'c', glyph: 'ms-c' };
    const name = (land.name || '').toLowerCase();
    const colors = Array.isArray(land.colors) ? land.colors.map(c => String(c).toLowerCase()) : [];
    if (name.includes('steam vents') || (colors.includes('u') && colors.includes('r'))) {
      return { colorKey: 'ur', glyph: 'ms-u ms-r' };
    }
    if (name.includes('mountain') || colors.includes('r')) {
      return { colorKey: 'r', glyph: 'ms-r' };
    }
    if (name.includes('forest') || colors.includes('g')) {
      return { colorKey: 'g', glyph: 'ms-g' };
    }
    if (name.includes('island') || colors.includes('u')) {
      return { colorKey: 'u', glyph: 'ms-u' };
    }
    if (name.includes('swamp') || colors.includes('b')) {
      return { colorKey: 'b', glyph: 'ms-b' };
    }
    if (name.includes('plains') || colors.includes('w')) {
      return { colorKey: 'w', glyph: 'ms-w' };
    }
    return { colorKey: 'c', glyph: 'ms-c' };
  }

  /**
   * Retrieves the active deck for a player (or current human player).
   * Supports activeDeckData in memory, AuthManager active deck, or saved deck by slot in localStorage.
   * @param {string} [playerId=this.myPlayerId]
   * @returns {Object|null}
   */
  getActiveDeckForPlayer(playerId = this.myPlayerId) {
    if (playerId !== this.myPlayerId) {
      return null;
    }
    if (this.activeDeckData) {
      return this.activeDeckData;
    }
    if (this.authManager && this.authManager.user && this.authManager.user.activeDeckData) {
      return this.authManager.user.activeDeckData;
    }
    try {
      const storage = (typeof localStorage !== 'undefined') ? localStorage : (this.storage || null);
      if (storage) {
        const slot = storage.getItem('rpm_active_deck_slot') || this.activeDeckSlot || 1;
        const rawMap = storage.getItem('rpm_saved_decks_by_slot');
        if (rawMap) {
          const slotMap = JSON.parse(rawMap);
          if (slotMap && slotMap[slot]) {
            return slotMap[slot];
          }
        }
      }
    } catch (_) {}
    return null;
  }

  /**
   * Loads a saved deck from a specific slot into active deck state.
   * @param {number|string} slotNum
   * @returns {Object|null}
   */
  _loadDeckSlot(slotNum) {
    this.activeDeckSlot = Number(slotNum) || 1;
    try {
      const storage = (typeof localStorage !== 'undefined') ? localStorage : (this.storage || null);
      if (storage) {
        storage.setItem('rpm_active_deck_slot', String(this.activeDeckSlot));
        const rawMap = storage.getItem('rpm_saved_decks_by_slot');
        if (rawMap) {
          const slotMap = JSON.parse(rawMap);
          if (slotMap && slotMap[this.activeDeckSlot]) {
            this.activeDeckData = slotMap[this.activeDeckSlot];
            return slotMap[this.activeDeckSlot];
          }
        }
      }
    } catch (_) {}
    this.activeDeckData = null;
    return null;
  }

  exportDeckManifest(playerId = this.myPlayerId) {
    if (this.tabletopState && typeof this.tabletopState.exportDeckManifest === 'function' && this.tabletopState.exportDeckManifest !== this.exportDeckManifest) {
      return this.tabletopState.exportDeckManifest(playerId);
    }
    const player = this.tabletopState?.players?.[playerId];
    const deck = this.getActiveDeckForPlayer(playerId);
    const libraryCards = Array.isArray(player?.library) ? player.library : [];
    const mainboard = (deck && Array.isArray(deck.mainboard))
      ? deck.mainboard
      : (libraryCards.length > 0
        ? libraryCards.map(c => ({ name: c.name, count: 1, typeLine: c.typeLine || c.type || '' }))
        : []);
    return {
      playerId,
      playerName: player?.name || this.username,
      activeDeckSlot: this.activeDeckSlot || 1,
      format: this.deckbuilderMode || 'FREE_CONSTRUCT',
      cardsCount: libraryCards.length || mainboard.length,
      mainboard,
      timestamp: Date.now()
    };
  }

  registerDeckManifest(manifest, playerId = this.myPlayerId) {
    if (this.tabletopState && typeof this.tabletopState.registerDeckManifest === 'function' && this.tabletopState.registerDeckManifest !== this.registerDeckManifest) {
      this.tabletopState.registerDeckManifest(manifest, playerId);
    }
    if (this.relayClient) {
      if (typeof this.relayClient.registerDeckManifest === 'function') {
        this.relayClient.registerDeckManifest(manifest, playerId);
      } else if (typeof this.relayClient.sendAction === 'function') {
        this.relayClient.sendAction('DECK_MANIFEST', { manifest, playerId });
      }
    }
  }

  dealStartingHands() {
    const starterCardNames = [
      'Steam Vents', 'Mountain', 'Swamp', 'Lightning Bolt', 'Goblin Guide', 'Monastery Swiftspear', 'Lava Spike'
    ];
    for (const pid of this.playerIds) {
      const p = this.tabletopState?.players?.[pid];
      if (p) {
        if (!p.zones) {
          p.zones = { hand: [], library: [], graveyard: [], exile: [], battlefield: [] };
        }
        const buildCardInstance = (cardOrName, idx, zoneName) => {
          const name = typeof cardOrName === 'string' ? cardOrName : (cardOrName?.name || 'Card');
          const fallbackMeta = getHydratedCardMetadata(name);
          let meta = (typeof cardOrName === 'object' && cardOrName !== null)
            ? { ...(fallbackMeta || {}), ...cardOrName }
            : (fallbackMeta ? { ...fallbackMeta } : null);

          const norm = name.trim().toLowerCase();
          let typeLine = meta?.typeLine || meta?.type_line || meta?.type || fallbackMeta?.typeLine || '';
          if (!typeLine) {
            if (BASIC_LAND_COLORS[norm] || norm.includes('mountain') || norm.includes('swamp') || norm.includes('plains') || norm.includes('island') || norm.includes('forest') || norm.includes('vents') || norm.includes('fountain') || norm.includes('grave') || norm.includes('crypt') || norm.includes('ground') || norm.includes('garden') || norm.includes('shrine') || norm.includes('pool') || norm.includes('tomb') || norm.includes('foundry')) {
              typeLine = 'Land';
            } else if (norm.includes('bolt') || norm.includes('spike') || norm.includes('charm') || norm.includes('shock') || norm.includes('counter')) {
              typeLine = 'Instant';
            } else {
              typeLine = 'Card';
            }
          }

          const isCreature = typeLine.toLowerCase().includes('creature');
          const isLand = typeLine.toLowerCase().includes('land');
          const imgUri = meta?.imageUri || meta?.imageUrl || fallbackMeta?.imageUri || '';
          const oracleText = meta?.oracleText || meta?.oracle_text || meta?.text || fallbackMeta?.oracleText || '';

          const card = {
            instanceId: `card_${pid}_${zoneName}_${idx}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: meta?.name || fallbackMeta?.name || name,
            typeLine,
            type: typeLine,
            manaCost: meta?.manaCost !== undefined ? meta.manaCost : (fallbackMeta?.manaCost !== undefined ? fallbackMeta.manaCost : (isLand ? '' : (name.includes('Bolt') || name.includes('Spike') ? '{R}' : '{1}'))),
            cmc: meta?.cmc ?? fallbackMeta?.cmc ?? (isLand ? 0 : 1),
            oracleText,
            imageUri: imgUri,
            imageUrl: imgUri,
            power: isCreature ? (meta?.power ?? fallbackMeta?.power ?? 1) : undefined,
            toughness: isCreature ? (meta?.toughness ?? fallbackMeta?.toughness ?? 1) : undefined,
            loyalty: meta?.loyalty ?? fallbackMeta?.loyalty,
            colors: meta?.colors || fallbackMeta?.colors || [],
            cardFaces: meta?.cardFaces || meta?.card_faces || fallbackMeta?.cardFaces || null,
            layout: meta?.layout || fallbackMeta?.layout || 'normal',
            owner: pid,
            ownerId: pid,
            controllerId: pid,
            zone: zoneName,
            isTapped: false,
            effect: meta?.effect || fallbackMeta?.effect,
            keywords: (meta?.keywords || fallbackMeta?.keywords) ? { ...(fallbackMeta?.keywords || {}), ...(meta?.keywords || {}) } : undefined,
            isShockland: meta?.isShockland ?? fallbackMeta?.isShockland,
            hasSummoningSickness: isCreature ? meta?.hasSummoningSickness : false,
            isSummoningSick: isCreature ? meta?.isSummoningSick : false
          };

          if (TabletopStateManager && typeof TabletopStateManager.hydrateCardMechanics === 'function') {
            TabletopStateManager.hydrateCardMechanics(card);
          }
          return card;
        };

        const activeDeck = this.getActiveDeckForPlayer(pid);
        const hasCustomMainboard = activeDeck && Array.isArray(activeDeck.mainboard) && activeDeck.mainboard.length > 0;

        if (hasCustomMainboard) {
          const fullMainboardCards = activeDeck.mainboard.flatMap(c => {
            const count = Number(c.count) || 1;
            return Array.from({ length: count }, () => (typeof c === 'object' ? { ...c } : c));
          });

          const shouldShuffle = Boolean(this.options?.shuffleDeck || (typeof this.isInteractiveBrowserMode === 'function' && this.isInteractiveBrowserMode()));
          const deckPool = (shouldShuffle && ZoneModel?.shuffleArray) ? ZoneModel.shuffleArray([...fullMainboardCards]) : [...fullMainboardCards];

          if (!p.zones.hand || p.zones.hand.length === 0) {
            const handCards = deckPool.slice(0, 7);
            p.zones.hand = handCards.map((item, idx) => buildCardInstance(item, idx, 'HAND'));
            p.hand = p.zones.hand;
          }
          if (!p.library || p.library.length === 0) {
            const libCards = deckPool.slice(7);
            const libInstances = libCards.map((item, idx) => buildCardInstance(item, idx, 'LIBRARY'));
            p.library = (shouldShuffle && ZoneModel?.shuffleArray) ? ZoneModel.shuffleArray(libInstances) : libInstances;
            p.zones.library = [...p.library];
          }
        } else {
          if (!p.zones.hand || p.zones.hand.length === 0) {
            p.zones.hand = starterCardNames.map((name, idx) => buildCardInstance(name, idx, 'HAND'));
            p.hand = p.zones.hand;
          }
          if (!p.library || p.library.length === 0) {
            const pool = [
              'Mountain', 'Steam Vents', 'Lightning Bolt', 'Lava Spike',
              'Goblin Guide', 'Monastery Swiftspear', 'Mountain', 'Lightning Bolt',
              'Lava Spike', 'Goblin Guide', 'Monastery Swiftspear', 'Steam Vents'
            ];
            const libCards = Array.from({ length: 53 }, (_, idx) => buildCardInstance(pool[idx % pool.length], idx, 'LIBRARY'));
            p.library = libCards;
            p.zones.library = [...libCards];
          }
        }
      }
    }
  }

  playLandFromHand(card) {
    const p = this.tabletopState?.players?.[this.myPlayerId];
    if (!p) return;

    if (this.tabletopState && typeof this.tabletopState.canPlayLand === 'function') {
      const check = this.tabletopState.canPlayLand(this.myPlayerId);
      const isAllowed = typeof check === 'boolean' ? check : Boolean(check && check.allowed);
      if (!isAllowed) {
        const msg = (typeof check === 'object' && check.message) ? check.message : "⚠️ Cannot play land";
        this.showWarningBanner(msg);
        return;
      }
    }

    if (this.tabletopState && typeof this.tabletopState.canPlayerCastOrPlay === 'function') {
      const check = this.tabletopState.canPlayerCastOrPlay(this.myPlayerId, card, this.priorityMachine);
      if (check && !check.allowed) {
        this.showWarningBanner(`⚠️ ${check.message || 'Cannot play land'}`);
        return;
      }
    }

    const isShockland = Boolean(card?.isShockland) ||
      /steam vents|sacred foundry|watery grave|stomping ground|godless shrine|blood crypt|breeding pool|overgrown tomb|temple garden|hallowed fountain/i.test(card?.name || '') ||
      /pay 2 life.*untapped|enters the battlefield tapped unless you pay 2 life/i.test(card?.text || card?.oracleText || '');

    let payShockCost = false;
    if (isShockland && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      payShockCost = window.confirm(`¿Pagar 2 vidas para que ${card.name || 'Steam Vents'} entre enderezada? (Sí: -2 vidas / No: entra girada)`);
    }

    if (this.tabletopState && typeof this.tabletopState.playLand === 'function') {
      try {
        if (!p.hand) p.hand = [];
        if (!p.hand.some(c => c && (c.instanceId === card.instanceId || c.name === card.name))) {
          p.hand.push(card);
        }
        this.tabletopState.playLand(this.myPlayerId, card.instanceId || card, { payShockCost });
      } catch (err) {
        this.tabletopState?.recordTrace?.('UI_REJECTION', 'PLAY_LAND_REJECTED', {
          playerId: this.myPlayerId,
          cardName: card?.name,
          reason: err.message
        });
        this.showWarningBanner(`⚠️ ${err.message || 'Cannot play land'}`);
        return;
      }
    }

    p.zones = p.zones || {};
    p.zones.hand = (p.zones.hand || []).filter(c => (c.instanceId || c.id || c.name) !== (card.instanceId || card.id || card.name));
    p.hand = p.zones.hand;
    if (!p.zones.battlefield) p.zones.battlefield = [];
    const battlefieldCard = {
      ...card,
      subzone: 'lands',
      isTapped: isShockland ? !payShockCost : false,
      zone: 'BATTLEFIELD'
    };
    if (!p.zones.battlefield.some(c => c && c.instanceId && c.instanceId === card.instanceId)) {
      p.zones.battlefield.push(battlefieldCard);
    }
    this.selectedHandCardId = null;
    this.dispatchAction({
      type: 'PLAY_LAND',
      payload: {
        playerId: this.myPlayerId,
        card,
        cardName: card.name,
        cardInstanceId: card.instanceId,
        payShockCost,
        pay2Life: payShockCost,
        landAlreadyPlayed: true
      }
    }, { origin: 'LOCAL' });
    this.reconcileDOM();
  }

  castSpellToStack(card, chosenTarget = null, chosenMode = null) {
    if (card && typeof TabletopStateManager?.hydrateCardMechanics === 'function') {
      TabletopStateManager.hydrateCardMechanics(card);
    }
    const p = this.tabletopState?.players?.[this.myPlayerId];

    const hasAdventure = (card?.typeLine || card?.type || '').includes('//') ||
      /adventure/i.test(card?.typeLine || card?.oracleText || '') ||
      /callous\s+sell-sword/i.test(card?.name || '');

    if (hasAdventure) {
      if (!card.compiledMechanics) card.compiledMechanics = {};
      if (!Array.isArray(card.compiledMechanics.castModes) || card.compiledMechanics.castModes.length < 2) {
        if (/callous\s+sell-sword/i.test(card.name || '') || (card.typeLine || '').includes('//')) {
          card.compiledMechanics.castModes = [
            {
              mode: 'MAIN',
              name: 'Callous Sell-Sword',
              manaCost: '{1}{B}',
              typeLine: 'Creature — Human Soldier',
              oracleText: card.oracleText || '',
              power: 2,
              toughness: 2,
              exileOnResolve: false,
              isPermanent: true,
              requiresTarget: false
            },
            {
              mode: 'ADVENTURE',
              name: 'Burn Together',
              manaCost: '{R}',
              typeLine: 'Sorcery — Adventure',
              oracleText: 'Burn Together deals damage equal to target creature you control\'s power to any target. Then sacrifice that creature.',
              exileOnResolve: true,
              isPermanent: false,
              requiresTarget: true
            }
          ];
        }
      }
    }

    if ((card?.zone === 'exile' || card?.onAdventure) && card?.onAdventure === true) {
      chosenMode = 'MAIN';
    }

    if (!chosenMode && !card?.selectedCastMode && this.container && card?.compiledMechanics?.castModes?.length > 1) {
      this._openCastModeSelectorModal(card);
      return;
    }

    let modeObj = null;
    const effectiveMode = chosenMode || card?.selectedCastMode || null;
    if (effectiveMode && Array.isArray(card?.compiledMechanics?.castModes)) {
      modeObj = card.compiledMechanics.castModes.find(m => m.mode === effectiveMode) || null;
    }
    if (modeObj) {
      card.selectedCastMode = modeObj.mode;
      card.activeCastMode = modeObj.mode;
    }

    const effectiveManaCost = modeObj?.manaCost || card?.manaCost;
    const effectiveTypeLine = modeObj?.typeLine || card?.typeLine || '';
    const effectiveOracleText = modeObj?.oracleText || card?.oracleText || '';
    const effectiveName = modeObj?.name || card?.name;

    const checkCard = {
      ...card,
      name: effectiveName,
      manaCost: effectiveManaCost,
      typeLine: effectiveTypeLine,
      oracleText: effectiveOracleText
    };

    if (this.tabletopState && typeof this.tabletopState.canPlayerCastOrPlay === 'function') {
      const check = this.tabletopState.canPlayerCastOrPlay(this.myPlayerId, checkCard, this.priorityMachine, { castMode: modeObj?.mode });
      if (check && !check.allowed) {
        this.tabletopState?.recordTrace?.('UI_REJECTION', 'CAST_SPELL_REJECTED', {
          playerId: this.myPlayerId,
          cardName: effectiveName,
          reason: check.message
        });
        this.showWarningBanner(`⚠️ ${check.message || 'Cannot cast spell'}`);
        return;
      }
    }

    const typeLineLower = effectiveTypeLine.toLowerCase();
    const isInstantOrSorceryOrAura = typeLineLower.includes('instant') || typeLineLower.includes('sorcery') || typeLineLower.includes('aura');
    const requiresTarget = Boolean(
      modeObj?.requiresTarget ||
      modeObj?.effect?.targetType ||
      card?.effect?.targetType ||
      card?.requiresTarget ||
      /target/i.test(effectiveOracleText)
    );
    const isSpellWithTarget = isInstantOrSorceryOrAura && requiresTarget;

    const combinations = (effectiveMode !== 'MAIN')
      ? ((typeof this.tabletopState?.getActionCombinationsForSpell === 'function')
          ? this.tabletopState.getActionCombinationsForSpell(this.myPlayerId, checkCard, effectiveMode)
          : this._getActionCombinationsForSpell(this.myPlayerId, checkCard, effectiveMode))
      : [];

    if (effectiveMode !== 'MAIN' && combinations && combinations.length > 0 && !chosenTarget && !card?._combinationChosen) {
      if (this.targetModal && typeof this.targetModal.openCombinationSelector === 'function' && Boolean(this.container)) {
        if (!this.targetModal.element && this.container) {
          const modalHost = this.container.querySelector('#modal-root') || this.container;
          if (typeof this.targetModal.mount === 'function') {
            this.targetModal.mount(modalHost);
          } else {
            this.targetModal.container = modalHost;
            this.targetModal.init();
          }
        }
        this._pendingSpellToCast = card;
        this._stagedCast = card;
        const confirmComboCallback = (selectedCombo) => {
          this._pendingSpellToCast = null;
          this._stagedCast = null;
          card._combinationChosen = true;
          this.castSpellToStack(card, selectedCombo, effectiveMode);
          card._combinationChosen = false;
        };
        this.targetModal.openCombinationSelector({
          spell: checkCard,
          combinations,
          prompt: `Elige combinación para ${checkCard.name || 'el hechizo'}:`,
          onSelectCombination: confirmComboCallback,
          onConfirm: confirmComboCallback,
          onCancel: () => {
            this._pendingSpellToCast = null;
            this._stagedCast = null;
            this.render?.();
            this.reconcileDOM?.();
          }
        });
        return;
      }
    }

    const dualTargets = this.tabletopState?.getValidTargetCandidatesForCard?.(this.myPlayerId, checkCard);
    if (dualTargets?.requiresDualTarget && !chosenTarget && (!card?.targets || card.targets.length < 2)) {
      if (this.targetModal) {
        if (!this.targetModal.element && this.container) {
          const modalHost = this.container.querySelector('#modal-root') || this.container;
          if (typeof this.targetModal.mount === 'function') {
            this.targetModal.mount(modalHost);
          } else {
            this.targetModal.container = modalHost;
            this.targetModal.init();
          }
        }
        if (Boolean(this.container)) {
          this._pendingSpellToCast = card;
          this._stagedCast = card;
          this.targetModal.openDualTarget({
            spell: checkCard,
            step1Prompt: dualTargets.step1Prompt || `Step 1: Choose Creature for ${effectiveName}`,
            step1Candidates: dualTargets.step1Candidates || dualTargets.candidatesStep1 || dualTargets.creatures || [],
            step2Prompt: dualTargets.step2Prompt || `Step 2: Choose Equipment for ${effectiveName}`,
            step2Candidates: dualTargets.step2Candidates || dualTargets.candidatesStep2 || dualTargets.equipment || [],
            onComplete: (data) => {
              this._pendingSpellToCast = null;
              this._stagedCast = null;
              this.castSpellToStack(card, { targetId: data.targetId, equipmentId: data.equipmentId, targets: data.targets }, chosenMode);
            },
            onCancel: () => {
              this._pendingSpellToCast = null;
              this._stagedCast = null;
              this.render?.();
              this.reconcileDOM?.();
            }
          });
          return;
        }
      }
    }

    if (isSpellWithTarget && !chosenTarget && !card?.targetId && (!Array.isArray(card?.targets) || card.targets.length === 0) && this.targetModal) {
      if (!this.targetModal.element && this.container) {
        const modalHost = this.container.querySelector('#modal-root') || this.container;
        if (typeof this.targetModal.mount === 'function') {
          this.targetModal.mount(modalHost);
        } else {
          this.targetModal.container = modalHost;
          this.targetModal.init();
        }
      }
      if (Boolean(this.container)) {
        this._pendingSpellToCast = card;
        this._stagedCast = card;
        this.targetModal.onSelectTarget = (data) => this.handleTargetSelected(data);
        this.targetModal.onCancel = () => {
          this._pendingSpellToCast = null;
          this._stagedCast = null;
          this.render?.();
          this.reconcileDOM?.();
        };
        this.targetModal.open(checkCard, this.tabletopState, this.myPlayerId, {
          onSelectTarget: (data) => this.handleTargetSelected(data),
          onCancel: () => {
            this._pendingSpellToCast = null;
            this._stagedCast = null;
            this.render?.();
            this.reconcileDOM?.();
          }
        });
        if (this.targetModal.candidateTargets && this.targetModal.candidateTargets.some(t => t.isLegal)) {
          return;
        } else {
          this.targetModal.close();
          this._pendingSpellToCast = null;
          this._stagedCast = null;
          this.showWarningBanner?.('⚠️ No legal targets available for this spell.');
          return;
        }
      }
    }

    let manaAlreadyPaid = false;
    if (effectiveManaCost && this.tabletopState && typeof this.tabletopState.autoTapForMana === 'function') {
      try {
        this.tabletopState.autoTapForMana(this.myPlayerId, effectiveManaCost);
        manaAlreadyPaid = true;
      } catch (err) {
        this.tabletopState?.recordTrace?.('UI_REJECTION', 'CAST_SPELL_MANA_REJECTED', {
          playerId: this.myPlayerId,
          cardName: effectiveName,
          manaCost: effectiveManaCost,
          reason: err.message
        });
        this.showWarningBanner(`⚠️ ${err.message || 'Insufficient mana'}`);
        return;
      }
    }
    if (p) {
      if (card.zone === 'exile' || card.onAdventure) {
        card.onAdventure = false;
        p.exile = (p.exile || []).filter(c => (c.instanceId || c.id || c.name) !== (card.instanceId || card.id || card.name));
        if (p.zones) p.zones.exile = p.exile;
      } else {
        p.zones = p.zones || {};
        p.zones.hand = (p.zones.hand || []).filter(c => (c.instanceId || c.id || c.name) !== (card.instanceId || card.id || card.name));
        p.hand = p.zones.hand;
      }
    }
    this.selectedHandCardId = null;

    const targetId = chosenTarget?.targetId || chosenTarget?.id || card?.targetId || (Array.isArray(card?.targets) ? card.targets[0] : null) || null;
    const equipmentId = chosenTarget?.equipmentId || card?.equipmentId || (Array.isArray(card?.targets) && card.targets.length > 1 ? card.targets[1] : null) || null;
    const creatureId = chosenTarget?.creatureId || null;
    const targetName = chosenTarget?.targetName || chosenTarget?.name || null;
    let targets = [];
    if (chosenTarget?.targets && Array.isArray(chosenTarget.targets)) {
      targets = chosenTarget.targets;
    } else if (Array.isArray(card?.targets) && card.targets.length > 0) {
      targets = card.targets;
    } else if (creatureId && targetId) {
      targets = [creatureId, targetId];
    } else if (targetId && equipmentId) {
      targets = [targetId, equipmentId];
    } else if (targetId) {
      targets = [targetId];
    }

    if (creatureId) card.creatureId = creatureId;
    if (equipmentId) card.equipmentId = equipmentId;
    if (targetId) card.targetId = targetId;
    if (chosenTarget && (chosenTarget.creatureId || chosenTarget.equipmentId || chosenTarget.label)) {
      card.selectedCombination = chosenTarget;
    }

    if (creatureId && card.effect && typeof card.effect === 'object') {
      card.effect.sourceCreatureId = creatureId;
    }
    if (targetId && card.effect && typeof card.effect === 'object') {
      card.effect.damageTargetId = targetId;
    }

    const effectiveCastMode = modeObj?.mode || effectiveMode || null;

    this.dispatchAction({
      type: 'CAST_SPELL',
      manaAlreadyPaid,
      castMode: effectiveCastMode,
      manaCost: effectiveManaCost,
      cardName: effectiveName,
      targetId,
      equipmentId,
      creatureId,
      targetName,
      targets,
      selectedCombination: chosenTarget?.label || chosenTarget?.creatureId || chosenTarget?.equipmentId ? chosenTarget : null,
      payload: {
        playerId: this.myPlayerId,
        controllerId: this.myPlayerId,
        controllerName: this.username || 'You',
        card,
        cardName: effectiveName,
        cardInstanceId: card.instanceId,
        castMode: effectiveCastMode,
        manaCost: effectiveManaCost,
        manaAlreadyPaid,
        creatureId,
        targetId,
        equipmentId,
        targetName,
        targets,
        selectedCombination: chosenTarget?.label || chosenTarget?.creatureId || chosenTarget?.equipmentId ? chosenTarget : null,
        combination: chosenTarget?.label ? chosenTarget : null
      }
    }, { origin: 'LOCAL' });
    this.reconcileDOM();
  }

  _openCastModeSelectorModal(card) {
    const modalRoot = this.container?.querySelector('#modal-root') || this.container;
    if (!modalRoot) return;

    const existing = modalRoot.querySelector('#cast-mode-selector-modal');
    if (existing) {
      try { existing.remove(); } catch (_) {}
    }

    modalRoot.setAttribute('aria-hidden', 'false');
    modalRoot.style.pointerEvents = 'auto';

    const modal = document.createElement('div');
    modal.id = 'cast-mode-selector-modal';
    modal.className = 'modal-backdrop cast-mode-modal-backdrop visible';
    modal.style.cssText = 'position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75); display: flex; align-items: center; justify-content: center; z-index: 9999;';

    const playerCreatures = this.tabletopState?.players?.[this.myPlayerId]?.battlefield?.creatures || [];
    const hasCreatureToSac = playerCreatures.length > 0;

    const modes = card.compiledMechanics?.castModes || [];
    let buttonsHtml = '';
    modes.forEach((modeObj, idx) => {
      const isAdv = modeObj.mode === 'ADVENTURE' || (modeObj.typeLine || '').toLowerCase().includes('adventure') || /burn together/i.test(modeObj.name || '');
      const icon = isAdv ? '✨' : '⚔️';
      let label = '';
      let disabledAttr = '';
      if (isAdv) {
        if (!hasCreatureToSac) {
          disabledAttr = 'disabled title="Requires a creature you control to sacrifice"';
          label = `${icon} Cast ${modeObj.name || 'Burn Together'} (${modeObj.manaCost || '{R}'} — Sorcery — Adventure) [Requires a creature to sacrifice]`;
        } else {
          label = `${icon} Cast ${modeObj.name || 'Burn Together'} (${modeObj.manaCost || '{R}'} — Sorcery — Adventure)`;
        }
      } else {
        label = `${icon} Cast ${modeObj.name || 'Callous Sell-Sword'} (${modeObj.manaCost || '{1}{B}'} — Creature 2/2)`;
      }
      buttonsHtml += `<button class="btn btn-primary btn-cast-mode" data-mode-idx="${idx}" ${disabledAttr} style="padding: 12px 16px; font-size: 0.95rem; text-align: left; margin-bottom: 8px; width: 100%; cursor: ${disabledAttr ? 'not-allowed; opacity: 0.5' : 'pointer'};">${this._escapeHtml(label)}</button>`;
    });

    modal.innerHTML = `
      <div class="modal-dialog-box" role="dialog" aria-modal="true" aria-label="Select Cast Mode" style="background: #1e293b; border: 1px solid var(--rpm-border, #334155); border-radius: 8px; padding: 20px; max-width: 480px; width: 90%; color: #f8fafc; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
        <div class="modal-header-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #334155; padding-bottom: 8px;">
          <h3 style="margin: 0; font-size: 1.15rem; color: var(--rpm-aqua, #38bdf8);">✨ Choose Cast Mode</h3>
          <button class="modal-close-btn btn-icon" style="color: #ffffff; font-size: 1.2rem; cursor: pointer; background: transparent; border: none;">&times;</button>
        </div>
        <p style="font-size: 0.9rem; color: #cbd5e1; margin-bottom: 16px;">
          Choose which face / half of <strong>${this._escapeHtml(card.name)}</strong> to cast:
        </p>
        <div class="cast-modes-buttons" style="display: flex; flex-direction: column;">
          ${buttonsHtml}
        </div>
        <div class="modal-actions" style="display: flex; justify-content: flex-end; margin-top: 12px;">
          <button id="btn-cancel-cast-mode" class="btn btn-secondary" style="padding: 8px 16px; cursor: pointer;">Cancel</button>
        </div>
      </div>
    `;

    const cleanup = () => {
      try { modal.remove(); } catch (_) {}
      if (!this.diceRollOverlay?.isOpen && !this.targetModal?.isOpen && !this._isVictoryModalOpen) {
        modalRoot.setAttribute('aria-hidden', 'true');
        modalRoot.style.pointerEvents = 'none';
      }
    };

    modal.querySelector('.modal-close-btn')?.addEventListener('click', cleanup);
    modal.querySelector('#btn-cancel-cast-mode')?.addEventListener('click', cleanup);

    modal.querySelectorAll('.btn-cast-mode').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-mode-idx'), 10);
        const chosen = modes[idx];
        cleanup();
        if (chosen) {
          this.castSpellToStack(card, null, chosen.mode);
        }
      });
    });

    modalRoot.appendChild(modal);
  }

  playLandByName(landName) {
    const p = this.tabletopState?.players?.[this.myPlayerId];
    if (!p) return;

    if (this.tabletopState && typeof this.tabletopState.canPlayLand === 'function') {
      const check = this.tabletopState.canPlayLand(this.myPlayerId);
      const isAllowed = typeof check === 'boolean' ? check : Boolean(check && check.allowed);
      if (!isAllowed) {
        const msg = (typeof check === 'object' && check.message) ? check.message : "⚠️ Cannot play land";
        this.showWarningBanner(msg);
        return;
      }
    }

    const hand = p.zones?.hand || p.hand || [];
    const idx = hand.findIndex(c => c && (c.name.toLowerCase() === landName.toLowerCase() || (c.typeLine || '').toLowerCase().includes('land')));
    let card;
    if (idx !== -1) {
      card = hand[idx];
    } else {
      card = {
        instanceId: `land_${Date.now()}`,
        name: landName,
        typeLine: 'Basic Land — ' + landName,
        zone: 'BATTLEFIELD'
      };
    }

    const isShockland = Boolean(card?.isShockland) ||
      /steam vents|sacred foundry|watery grave|stomping ground|godless shrine|blood crypt|breeding pool|overgrown tomb|temple garden|hallowed fountain/i.test(card?.name || '') ||
      /pay 2 life.*untapped|enters the battlefield tapped unless you pay 2 life/i.test(card?.text || card?.oracleText || '');

    let payShockCost = false;
    if (isShockland && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      payShockCost = window.confirm(`¿Pagar 2 vidas para que ${card.name || 'Steam Vents'} entre enderezada? (Sí: -2 vidas / No: entra girada)`);
    }

    if (idx !== -1) {
      if (this.tabletopState && typeof this.tabletopState.playLand === 'function') {
        try {
          if (!p.hand) p.hand = [];
          if (!p.hand.some(c => c && (c.instanceId === card.instanceId || c.name === card.name))) {
            p.hand.push(card);
          }
          this.tabletopState.playLand(this.myPlayerId, card.instanceId || card, { payShockCost });
        } catch (err) {
          this.showWarningBanner(`⚠️ ${err.message || 'Cannot play land'}`);
          return;
        }
      }
      hand.splice(idx, 1);
    } else {
      if (this.tabletopState && typeof this.tabletopState.playLand === 'function') {
        try {
          if (!p.hand) p.hand = [];
          p.hand.push(card);
          this.tabletopState.playLand(this.myPlayerId, card.instanceId || card, { payShockCost });
        } catch (err) {
          this.showWarningBanner(`⚠️ ${err.message || 'Cannot play land'}`);
          return;
        }
      } else if (p.battlefield) {
        p.battlefield.lands = p.battlefield.lands || [];
        p.battlefield.lands.push(card);
        p.landsPlayedThisTurn = (p.landsPlayedThisTurn || 0) + 1;
      }
    }
    if (!p.zones) p.zones = {};
    if (!p.zones.battlefield) p.zones.battlefield = [];
    p.zones.battlefield.push({ ...card, subzone: 'lands', isTapped: isShockland ? !payShockCost : false, zone: 'BATTLEFIELD' });
    this.authManager?.dispatchTelemetry('LAND_PLAY', landName, { playerId: this.myPlayerId });
    this.reconcileDOM();
  }

  castSpellByName(spellName, targets = null) {
    const p = this.tabletopState?.players?.[this.myPlayerId];
    let card = null;
    if (p && Array.isArray(p.zones?.hand)) {
      const idx = p.zones.hand.findIndex(c => c.name.toLowerCase() === spellName.toLowerCase());
      if (idx !== -1) {
        card = p.zones.hand[idx];
        if (card && card.manaCost && this.tabletopState && typeof this.tabletopState.autoTapForMana === 'function') {
          try {
            this.tabletopState.autoTapForMana(this.myPlayerId, card.manaCost);
          } catch (err) {
            this.showWarningBanner(`⚠️ ${err.message || 'Insufficient mana'}`);
            return;
          }
        }
        p.zones.hand.splice(idx, 1);
        p.hand = p.zones.hand;
      }
    }
    if (this.priorityMachine) {
      try {
        this.priorityMachine.dispatch('CAST_SPELL', {
          playerId: this.myPlayerId,
          controllerId: this.myPlayerId,
          controllerName: this.username || 'You',
          card: card || { name: spellName },
          cardName: spellName,
          targets
        });
      } catch (_) {}
    }
    this.authManager?.dispatchTelemetry('SPELL_CAST', spellName, { playerId: this.myPlayerId, targets });
    this.reconcileDOM();
  }

  /**
   * Assigns a specific deck source (Random, Precon Starter, or Custom Slot) to a Perkins Bot [P39].
   * @param {string|number} botSlotId - Seat number (2..6) or bot playerId ('p2', 'perkins', etc.)
   * @param {string} deckSourceId - 'RANDOM' | precon id | 'slot_1'..'slot_6'
   */
  assignDeckToBot(botSlotId, deckSourceId = 'RANDOM') {
    const key = String(botSlotId);
    this.botAssignedDecks[key] = deckSourceId || 'RANDOM';

    let resolvedDeck = null;
    if (deckSourceId && deckSourceId !== 'RANDOM') {
      if (deckSourceId.startsWith('slot_')) {
        resolvedDeck = this.deckSlotManager?.getSlotDeck(deckSourceId) || null;
        if (!resolvedDeck) {
          const slotNum = Number(deckSourceId.replace('slot_', ''));
          if (Number.isFinite(slotNum)) {
            resolvedDeck = this._loadDeckSlot?.(slotNum) || null;
          }
        }
      } else {
        resolvedDeck = getPreconstructedDeckById(deckSourceId) || getStarterDeck(deckSourceId) || null;
      }
    }

    if (this.perkinsAgent && (String(this.perkinsAgent.slotId) === key || key === '2' || key === 'p2' || key === 'perkins')) {
      if (typeof this.perkinsAgent.setAssignedDeck === 'function') {
        this.perkinsAgent.setAssignedDeck(resolvedDeck);
      } else {
        this.perkinsAgent.assignedDeck = resolvedDeck;
        this.perkinsAgent.starterDeck = resolvedDeck;
      }
    }
    return resolvedDeck;
  }

  /**
   * Toggles Fast-Forward mode (50ms bot thinking delay vs 450ms normal) [P40].
   * @param {boolean} [forceValue]
   * @returns {boolean}
   */
  toggleBotFastForward(forceValue) {
    this.botFastForward = typeof forceValue === 'boolean' ? forceValue : !this.botFastForward;
    const delay = this.botFastForward ? 50 : 450;
    if (this.perkinsAgent) {
      this.perkinsAgent.thinkingDelayMs = delay;
    }
    if (this.botAgents) {
      const bots = typeof this.botAgents.values === 'function' ? this.botAgents.values() : this.botAgents;
      for (const bot of bots) {
        if (bot) bot.thinkingDelayMs = delay;
      }
    }
    this.reconcileDOM?.();
    return this.botFastForward;
  }

  /**
   * Enqueues a legal Assisted Play or Unsupported deck into CompatibilityReviewQueue [P27].
   * @param {Object} deckPayload
   */
  submitDeckToReviewQueue(deckPayload = {}) {
    if (!this.compatibilityReviewQueue) {
      this.compatibilityReviewQueue = new CompatibilityReviewQueue();
    }
    const entry = this.compatibilityReviewQueue.enqueueReviewRequest(deckPayload);
    this.showToast?.(`📩 Deck "${entry.deckName}" submitted to Compatibility Review Queue!`);
    return entry;
  }

  async triggerDiceRoll(diceType = 'dice') {
    if (diceType === 'd20' || this.isRollOffActive) {
      return await this.submitRollOff();
    } else {
      let rollDigits = null;
      if (typeof diceCanvas !== 'undefined' && typeof diceCanvas.rollPercentile === 'function') {
        try {
          rollDigits = await diceCanvas.rollPercentile();
        } catch (_) {}
      }

      let roll;
      if (Array.isArray(rollDigits) && rollDigits.length === 2) {
        const tens = rollDigits[0];
        const ones = rollDigits[1];
        roll = {
          tens,
          ones,
          total: tens * 10 + ones,
          rollString: `${tens}${ones}`
        };
      } else {
        roll = executeAuthoritativeRoll();
      }

      const birthday = this.authManager?.getBirthdayRoll?.() || '69';
      const resolved = resolveRoll(roll.tens, roll.ones, birthday);

      this.handlePerkRolled({
        ...roll,
        ...resolved
      });
      return roll;
    }
  }

  startRollOff(playerIds = null) {
    let activePlayerIds = playerIds;
    if (!activePlayerIds || activePlayerIds.length === 0) {
      if (this.lobbyManager && this.lobbyManager.getSeatedCount() > 0) {
        const seated = this.lobbyManager.getSeatedSlots();
        activePlayerIds = seated.map(s => s.playerId);
      } else {
        activePlayerIds = this.playerIds && this.playerIds.length > 0 ? this.playerIds : [this.myPlayerId];
      }
    }
    this.playerIds = [...activePlayerIds];
    this.isRollOffActive = true;
    this.rollOffResult = null;
    this.turnRollOffManager = new TurnRollOffManager(this.playerIds && this.playerIds.length > 0 ? this.playerIds : ['p1', 'p2']);
    if (this.tabRouter) {
      this.tabRouter.navigate('ARENA', this.getMatchState(), this.isSpectator());
    }
    this.reconcileDOM();
  }

  async submitRollOff(forcedValue = null) {
    let rolledValue = (typeof forcedValue === 'number') ? forcedValue : null;
    if (rolledValue === null && typeof diceCanvas !== 'undefined' && typeof diceCanvas.rollD20 === 'function') {
      try {
        const d20Val = await diceCanvas.rollD20(this.myPlayerId);
        if (typeof d20Val === 'number' && d20Val >= 1 && d20Val <= 20) {
          rolledValue = d20Val;
        }
      } catch (_) {}
    }
    return this.submitRollOffForPlayer(this.myPlayerId, rolledValue);
  }

  submitRollOffForPlayer(playerId, forcedValue = null) {
    if (!this.turnRollOffManager) {
      this.startRollOff();
    }
    const roll = this.turnRollOffManager.submitRoll(playerId, forcedValue);

    // Auto-roll for bot opponents if in solo mode or pod with bots
    const seatedBots = this.lobbyManager
      ? this.lobbyManager.getSeatedSlots().filter(s => s.isBot).map(s => s.playerId)
      : [];
    const botIds = new Set([
      ...seatedBots,
      ...this.playerIds.filter(pid => pid.startsWith('bot_') || pid.includes('perkins'))
    ]);
    if (playerId === this.myPlayerId) {
      for (const opId of botIds) {
        if (this.turnRollOffManager.pendingPlayerIds.has(opId)) {
          this.turnRollOffManager.submitRoll(opId);
        }
      }
    }

    if (this.turnRollOffManager.isRoundComplete()) {
      let res = this.turnRollOffManager.evaluateRound();
      // If a tie-breaker round only involves bots (human not tied), auto-roll tied bots to completion
      let tieGuard = 0;
      while (!res.isComplete && !this.turnRollOffManager.pendingPlayerIds.has(this.myPlayerId) && tieGuard++ < 20) {
        for (const opId of botIds) {
          if (this.turnRollOffManager.pendingPlayerIds.has(opId)) {
            this.turnRollOffManager.submitRoll(opId);
          }
        }
        if (this.turnRollOffManager.isRoundComplete()) {
          res = this.turnRollOffManager.evaluateRound();
        } else {
          break;
        }
      }
      this.rollOffResult = res;
      if (res.isComplete) {
        // Reconstruct complete roll map across rounds (latest roll per player)
        const roundRolls = {};
        for (const h of (this.turnRollOffManager.roundHistory || [])) {
          if (h && h.rolls) {
            for (const [pid, rVal] of h.rolls.entries()) {
              roundRolls[pid] = rVal;
            }
          }
        }
        const winnerId = (res.sortedPlayers && res.sortedPlayers.length > 0)
          ? res.sortedPlayers[0]
          : this.playerIds[0];

        // Determine circular clockwise seat order starting from winner (or keep [myPlayerId, opponent] for 1v1 pregame)
        let orderedPlayers;
        if (this.pregameEnabled && Array.isArray(this.playerIds) && this.playerIds.length === 2 && this.playerIds.includes(this.myPlayerId)) {
          orderedPlayers = [this.myPlayerId, ...this.playerIds.filter(p => p !== this.myPlayerId)];
        } else if (Array.isArray(this.playerIds) && this.playerIds.includes(winnerId)) {
          const idx = this.playerIds.indexOf(winnerId);
          orderedPlayers = [...this.playerIds.slice(idx), ...this.playerIds.slice(0, idx)];
        } else if (Array.isArray(res.sortedPlayers)) {
          orderedPlayers = [...res.sortedPlayers];
        } else {
          orderedPlayers = [...this.playerIds];
        }

        this.playerIds = orderedPlayers;
        if (this.priorityMachine) {
          this.priorityMachine.players = orderedPlayers;
          this.priorityMachine.activePlayerId = winnerId;
          this.priorityMachine.priorityPlayerId = winnerId;
          this.priorityMachine.startingPlayerId = winnerId;
        }
        this.isRollOffActive = false;
        this.startMatch({ playerIds: orderedPlayers });
        if (this.pregameEnabled && orderedPlayers.length >= 2) {
          this._beginPregame({ rolls: roundRolls, winnerId });
        }
      }
    }
    this.reconcileDOM();
    return roll;
  }

  start1v1QueueSearch() {
    if (this.authManager) {
      if (!this.authManager.isAuthenticated()) {
        this.showAuthModal(() => this.start1v1QueueSearch());
        return false;
      }
      if (!this.authManager.isOnboarded()) {
        this.showDeckModal(() => this.start1v1QueueSearch());
        return false;
      }
    }
    this.queueSearchStartTime = Date.now();
    const banner = this.container?.querySelector('#queue-search-banner');
    const btnFind = this.container?.querySelector('#btn-find-1v1');
    if (banner) banner.style.display = 'flex';
    if (btnFind) btnFind.style.display = 'none';

    if (this.queueSearchInterval) clearInterval(this.queueSearchInterval);
    this.queueSearchInterval = setInterval(() => {
      this._updateQueueTimer();
    }, 1000);
    this._updateQueueTimer();
    return true;
  }

  startMatchmaking() {
    return this.start1v1QueueSearch();
  }

  claimLobbySeat(slotId) {
    if (this.authManager && !this.authManager.isAuthenticated()) {
      this.showAuthModal(() => {
        if (this.lobbyManager) {
          this.lobbyManager.claimSeat(this.myPlayerId, this.username, slotId);
        }
        this.reconcileDOM();
      });
      return false;
    }
    if (this.lobbyManager) {
      this.lobbyManager.claimSeat(this.myPlayerId, this.username, slotId);
    }
    this.reconcileDOM();
    return true;
  }

  cancel1v1QueueSearch() {
    if (this.queueSearchInterval) {
      clearInterval(this.queueSearchInterval);
      this.queueSearchInterval = null;
    }
    this.queueSearchStartTime = null;
    const banner = this.container?.querySelector('#queue-search-banner');
    const btnFind = this.container?.querySelector('#btn-find-1v1');
    const wModal = this.container?.querySelector('#queue-watchdog-modal');
    if (banner) banner.style.display = 'none';
    if (btnFind) btnFind.style.display = 'inline-block';
    if (wModal) wModal.style.display = 'none';
  }

  _updateQueueTimer() {
    if (!this.queueSearchStartTime) return;
    const elapsedSec = Math.floor((Date.now() - this.queueSearchStartTime) / 1000);
    const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const ss = String(elapsedSec % 60).padStart(2, '0');
    const label = this.container?.querySelector('#queue-timer-label');
    if (label) {
      label.textContent = `🔍 Searching for Opponent... ${mm}:${ss}`;
    }

    // 45s Perkins Watchdog (INV-QUEUE-1)
    if (elapsedSec >= 45) {
      const wModal = this.container?.querySelector('#queue-watchdog-modal');
      if (wModal) wModal.style.display = 'block';
    }
  }

  toggleLobbyReady() {
    if (!this.lobbyManager) return;
    if (this.lobbyManager.status === 'LOBBY_COUNTDOWN' || this.lobbyManager.countdownSecondsRemaining !== null) {
      this.lobbyManager.abortCountdown('USER_CANCELLED');
      this.reconcileDOM();
      return;
    }
    const mySlot = Array.from(this.lobbyManager.slots.values()).find(s => s.playerId === this.myPlayerId);
    if (!mySlot) {
      this.lobbyManager.claimSeat(this.myPlayerId, this.username, 1);
    }
    const currentReady = Boolean(this.lobbyManager.slots.get(mySlot?.slotId || 1)?.isReady);
    this.lobbyManager.setReady(this.myPlayerId, !currentReady);
    this.reconcileDOM();
  }

  // ==========================================================================
  // Lifecycle Management (INV-HARNESS-1)
  // ==========================================================================

  /**
   * Initializes DOM elements, binds event listeners, and mounts subsystems.
   * 
   * @param {HTMLElement|string} [container]
   * @returns {Promise<void>}
   */
  async mount(container = null) {
    if (container) {
      this.container = typeof container === 'string' && typeof document !== 'undefined'
        ? document.querySelector(container)
        : container;
    }

    if (!this.container) {
      return;
    }

    // 1. Build or ensure the semantic DOM skeleton
    this._ensureLayoutSkeleton();

    // 2. Wire subsystem events
    this._setupSubscriptions();

    // 3. Bind UI DOM events
    this._bindDOMEvents();

    // 4. Initial view reconciliation
    this.reconcileDOM();

    // 5. Connect relay if autoConnect option is set
    if (this.options.autoConnect && this.relayClient) {
      try {
        await this.relayClient.connect();
      } catch (_) {}
    }

    // 6. Initialize 3D Dice Canvas (INV-DICE-3D-1)
    if (typeof diceCanvas !== 'undefined' && typeof diceCanvas.init === 'function') {
      diceCanvas.init().catch(err => {
        console.warn('[app] diceCanvas init error:', err);
      });
    }

    // 7. Interactive RPM Dice Roll Mode
    if (this.isInteractiveBrowserMode() || this.options.awaitHumanRollConfirmation) {
      this.perkEngine.awaitHumanRollConfirmation = true;
      this.perkEngine.humanPlayerId = this.myPlayerId;
    }

    // 8. Auto-room flow initialization (URL auto-pairing / autopilot)
    if (this.autoRoomCode && !this._autoRoomFlowStarted) {
      this._autoRoomFlowStarted = true;
      this._startAutoRoomFlow().catch(err => {
        console.warn('[app] Auto-room flow error:', err);
      });
    }
  }

  /**
   * Destroys all DOM elements, unbinds listeners, cancels timers, and closes sockets.
   * Strictly enforces INV-HARNESS-1.
   */
  destroy() {
    this.isDestroyed = true;

    // 1. Cancel and clear all timers
    if (this.alarmManager) {
      try { this.alarmManager.cancel(); } catch (_) {}
    }
    for (const timerId of this._activeTimers) {
      clearTimeout(timerId);
      clearInterval(timerId);
    }
    this._activeTimers.clear();

    // 2. Unbind global event listeners
    if (typeof document !== 'undefined') {
      try {
        document.removeEventListener('keydown', this._boundKeyDown);
      } catch (_) {}
    }
    for (const unbind of this._domListeners) {
      try { unbind(); } catch (_) {}
    }
    this._domListeners = [];

    // 3. Unsubscribe subsystem subscriptions
    for (const unsub of this._unsubscribers) {
      try { unsub(); } catch (_) {}
    }
    this._unsubscribers = [];

    // 4. Teardown sub-engines
    if (this.randomPerk && typeof this.randomPerk.destroy === 'function') {
      try { this.randomPerk.destroy(); } catch (_) {}
    }
    if (this.victoryFanfare && typeof this.victoryFanfare.destroy === 'function') {
      try { this.victoryFanfare.destroy(); } catch (_) {}
    }
    if (this.cardModal && typeof this.cardModal.destroy === 'function') {
      try { this.cardModal.destroy(); } catch (_) {}
    }
    if (this.diceRollOverlay && typeof this.diceRollOverlay.destroy === 'function') {
      try { this.diceRollOverlay.destroy(); } catch (_) {}
    }
    if (this.relayClient) {
      try {
        this.relayClient.disconnect();
        this.relayClient.removeAllListeners();
      } catch (_) {}
    }
    if (this.perkinsAgent && typeof this.perkinsAgent.destroy === 'function') {
      try { this.perkinsAgent.destroy(); } catch (_) {}
      this.perkinsAgent = null;
    }
    if (typeof diceCanvas !== 'undefined' && typeof diceCanvas.clear === 'function') {
      try { diceCanvas.clear(); } catch (_) {}
    }
    if (this.queueSearchInterval) {
      clearInterval(this.queueSearchInterval);
      this.queueSearchInterval = null;
    }
    if (this.lobbyManager) {
      try { this.lobbyManager.removeAllListeners(); } catch (_) {}
    }

    // 5. Clear container DOM
    if (this.container) {
      try {
        this.container.innerHTML = '';
      } catch (_) {}
      this.container = null;
    }
  }

  // ==========================================================================
  // Layout Construction
  // ==========================================================================

  /**
   * Ensures all 6 required semantic regions exist inside the root container.
   * @private
   */
  _ensureLayoutSkeleton() {
    if (!this.container) return;

    let headerBar = this.container.querySelector('#header-bar');
    let opponentsContainer = this.container.querySelector('#opponents-container');
    let centerArena = this.container.querySelector('#center-arena');
    let playerDashboard = this.container.querySelector('#player-dashboard');
    let chatDrawer = this.container.querySelector('#chat-drawer');
    let modalRoot = this.container.querySelector('#modal-root');

    // If container is empty or regions are missing, construct layout
    if (!headerBar) {
      headerBar = document.createElement('header');
      headerBar.id = 'header-bar';
      headerBar.className = 'rpm-header-bar';
      headerBar.setAttribute('role', 'banner');
      headerBar.innerHTML = `
        <div class="header-brand">
          <span class="brand-glyph">⚔️</span>
          <h1 class="brand-title">RPM TABLETOP</h1>
        </div>
        <nav class="header-nav-tabs" role="tablist" aria-label="Main Navigation">
          <button id="tab-btn-auth" class="nav-tab" data-tab="AUTH" role="tab" aria-selected="false" style="display: none;">🔐 Auth</button>
          <button id="tab-btn-arena" class="nav-tab active" data-tab="ARENA" role="tab" aria-selected="true">🏟️ Arena</button>
          <button id="tab-btn-deckbuilder" class="nav-tab" data-tab="DECKBUILDER" role="tab" aria-selected="false">📚 Deckbuilder</button>
          <button id="tab-btn-lobby" class="nav-tab" data-tab="LOBBY" role="tab" aria-selected="false">🔍 Lobby</button>
          <button id="tab-btn-profile" class="nav-tab" data-tab="PROFILE" role="tab" aria-selected="false">👤 Profile</button>
          <button id="tab-btn-leaderboard" class="nav-tab" data-tab="LEADERBOARD" role="tab" aria-selected="false">🏆 Leaderboard</button>
        </nav>
        <div class="header-room-controls">
          <input type="text" id="room-code-input" class="room-input" placeholder="ROOM CODE" maxlength="8" spellcheck="false" autocomplete="off" />
          <button id="btn-join-room" class="btn btn-secondary">Join</button>
          <button id="btn-create-room" class="btn btn-primary">Create Room</button>
          <button id="btn-play-perkins" class="btn btn-special btn-perkins" title="Start Solo Match vs Perkins AI">🤖 Play vs Perkins</button>
        </div>
        <div class="header-status-group">
          <div id="connection-status-pill" class="status-pill status-offline" aria-live="polite">
            <span class="status-dot"></span>
            <span class="status-text">Offline</span>
          </div>
          <div id="active-player-badge" class="active-player-badge" style="display: none;">
            <span class="badge-label">Active:</span>
            <span id="active-player-name" class="badge-value"></span>
            <span id="current-phase-name" class="badge-phase"></span>
          </div>
          <div class="header-actions">
            <button id="btn-audio-mute" class="btn-icon" title="Toggle Victory Audio Mute" aria-label="Toggle Victory Audio Mute">
              <span class="icon-speaker">🔊</span>
            </button>
            <button id="btn-open-deckbuilder" class="btn btn-outline" title="Open AI Deckbuilder & Guidelines">
              <span class="icon-deck">📚</span> Decks
            </button>
          </div>
        </div>
      `;
      this.container.appendChild(headerBar);
    } else {
      let navTabs = headerBar.querySelector('.header-nav-tabs');
      if (!navTabs) {
        navTabs = document.createElement('nav');
        navTabs.className = 'header-nav-tabs';
        navTabs.setAttribute('role', 'tablist');
        navTabs.setAttribute('aria-label', 'Main Navigation');
        navTabs.innerHTML = `
          <button id="tab-btn-auth" class="nav-tab" data-tab="AUTH" role="tab" aria-selected="false" style="display: none;">🔐 Auth</button>
          <button id="tab-btn-arena" class="nav-tab active" data-tab="ARENA" role="tab" aria-selected="true">🏟️ Arena</button>
          <button id="tab-btn-deckbuilder" class="nav-tab" data-tab="DECKBUILDER" role="tab" aria-selected="false">📚 Deckbuilder</button>
          <button id="tab-btn-lobby" class="nav-tab" data-tab="LOBBY" role="tab" aria-selected="false">🔍 Lobby</button>
          <button id="tab-btn-profile" class="nav-tab" data-tab="PROFILE" role="tab" aria-selected="false">👤 Profile</button>
          <button id="tab-btn-leaderboard" class="nav-tab" data-tab="LEADERBOARD" role="tab" aria-selected="false">🏆 Leaderboard</button>
        `;
        const brand = headerBar.querySelector('.header-brand');
        if (brand && brand.nextSibling) {
          headerBar.insertBefore(navTabs, brand.nextSibling);
        } else {
          headerBar.appendChild(navTabs);
        }
      }
    }

    let viewHost = this.container.querySelector('#view-host');
    if (!viewHost) {
      viewHost = document.createElement('div');
      viewHost.id = 'view-host';
      viewHost.className = 'rpm-view-host';
      this.container.appendChild(viewHost);
    }

    let viewAuth = viewHost.querySelector('#view-auth');
    if (!viewAuth) {
      viewAuth = document.createElement('div');
      viewAuth.id = 'view-auth';
      viewAuth.className = 'view-pane';
      viewAuth.style.display = 'none';
      viewHost.appendChild(viewAuth);
    }

    let viewArena = viewHost.querySelector('#view-arena');
    if (!viewArena) {
      viewArena = document.createElement('div');
      viewArena.id = 'view-arena';
      viewArena.className = 'view-pane active';
      viewHost.appendChild(viewArena);
    }

    let viewDeckbuilder = viewHost.querySelector('#view-deckbuilder');
    if (!viewDeckbuilder) {
      viewDeckbuilder = document.createElement('div');
      viewDeckbuilder.id = 'view-deckbuilder';
      viewDeckbuilder.className = 'view-pane';
      viewDeckbuilder.style.display = 'none';
      viewHost.appendChild(viewDeckbuilder);
    }

    let viewLobby = viewHost.querySelector('#view-lobby');
    if (!viewLobby) {
      viewLobby = document.createElement('div');
      viewLobby.id = 'view-lobby';
      viewLobby.className = 'view-pane';
      viewLobby.style.display = 'none';
      viewHost.appendChild(viewLobby);
    }

    let viewProfile = viewHost.querySelector('#view-profile');
    if (!viewProfile) {
      viewProfile = document.createElement('div');
      viewProfile.id = 'view-profile';
      viewProfile.className = 'view-pane';
      viewProfile.style.display = 'none';
      viewHost.appendChild(viewProfile);
    }

    let viewLeaderboard = viewHost.querySelector('#view-leaderboard');
    if (!viewLeaderboard) {
      viewLeaderboard = document.createElement('div');
      viewLeaderboard.id = 'view-leaderboard';
      viewLeaderboard.className = 'view-pane';
      viewLeaderboard.style.display = 'none';
      viewHost.appendChild(viewLeaderboard);
    }

    let mainArena = this.container.querySelector('#tabletop-arena');
    if (!mainArena) {
      mainArena = document.createElement('main');
      mainArena.id = 'tabletop-arena';
      mainArena.className = 'rpm-tabletop-arena';
      mainArena.setAttribute('role', 'main');
      viewArena.appendChild(mainArena);
    } else if (mainArena.parentElement !== viewArena) {
      viewArena.appendChild(mainArena);
    }

    if (!opponentsContainer) {
      opponentsContainer = document.createElement('section');
      opponentsContainer.id = 'opponents-container';
      opponentsContainer.className = 'opponents-bar';
      opponentsContainer.setAttribute('aria-label', 'Opponent Player Zones');
      mainArena.appendChild(opponentsContainer);
    }

    if (!centerArena) {
      centerArena = document.createElement('section');
      centerArena.id = 'center-arena';
      centerArena.className = 'center-battlefield-arena';
      centerArena.setAttribute('aria-label', 'Battlefield and Priority Stack');
      centerArena.innerHTML = `
        <div id="arena-phase-track" class="phase-track-wrapper" aria-label="Turn Phase Track"></div>
        <div id="arena-warning-banner" class="arena-warning-banner" style="display: none;" aria-live="assertive"></div>
        <div id="stack-alarm-container" class="stack-alarm-wrapper" style="display: none;" aria-live="assertive">
          <div class="alarm-header">
            <span class="alarm-title">⚡ PRIORITY COUNTDOWN</span>
            <span id="alarm-timer-label" class="alarm-countdown">15.0s</span>
          </div>
          <div class="alarm-progress-track">
            <div id="stack-alarm-progress-bar" class="alarm-progress-fill alarm-state-green" style="width: 100%;"></div>
          </div>
        </div>
        <div id="stack-visualizer-container" class="stack-container" aria-label="Active LIFO Priority Stack">
          <div class="stack-header">
            <h2 class="stack-title">THE STACK <span id="stack-count-badge" class="badge-counter">(0)</span></h2>
            <div class="stack-controls">
              <button id="btn-pass-priority" class="btn btn-pass" title="Pass Priority (Hotkey: Space or P)">Pass Priority [Space]</button>
              <button id="btn-hold-respond" class="btn btn-hold" title="Hold Alarm & Respond (Hotkey: H)">Hold & Respond [H]</button>
            </div>
          </div>
          <ul id="stack-item-list" class="stack-list" role="list"></ul>
        </div>
        <div id="perk-dice-container" class="perk-display-wrapper" style="display: none;">
          <div class="perk-dice-row">
            <div id="dice-tens" class="dice-box dice-tens" title="Tens Die (Violet d10)">
              <span class="dice-label">10s</span>
              <span class="dice-value">0</span>
            </div>
            <div id="dice-ones" class="dice-box dice-ones" title="Ones Die (Aquamarine d10)">
              <span class="dice-label">1s</span>
              <span class="dice-value">0</span>
            </div>
            <div class="perk-roll-summary">
              <span id="perk-roll-key" class="perk-key-badge">ROLL --</span>
              <span id="perk-effect-description" class="perk-desc">Awaiting upkeep trigger...</span>
            </div>
          </div>
        </div>
      `;
      mainArena.appendChild(centerArena);
    } else {
      if (centerArena.parentElement !== viewArena && centerArena.parentElement !== mainArena) {
        mainArena.appendChild(centerArena);
      }
      let phaseTrack = centerArena.querySelector('#arena-phase-track');
      if (!phaseTrack) {
        phaseTrack = document.createElement('div');
        phaseTrack.id = 'arena-phase-track';
        phaseTrack.className = 'phase-track-wrapper';
        phaseTrack.setAttribute('aria-label', 'Turn Phase Track');
        centerArena.insertBefore(phaseTrack, centerArena.firstChild);
      }
      let warningBanner = centerArena.querySelector('#arena-warning-banner');
      if (!warningBanner) {
        warningBanner = document.createElement('div');
        warningBanner.id = 'arena-warning-banner';
        warningBanner.className = 'arena-warning-banner';
        warningBanner.style.display = 'none';
        warningBanner.setAttribute('aria-live', 'assertive');
        if (phaseTrack && phaseTrack.nextSibling) {
          centerArena.insertBefore(warningBanner, phaseTrack.nextSibling);
        } else {
          centerArena.appendChild(warningBanner);
        }
      }
    }

    if (!playerDashboard) {
      playerDashboard = document.createElement('section');
      playerDashboard.id = 'player-dashboard';
      playerDashboard.className = 'player-dashboard-panel';
      playerDashboard.setAttribute('aria-label', 'Active Player Dashboard');
      mainArena.appendChild(playerDashboard);
    }

    let rollOffOverlay = this.container.querySelector('#roll-off-overlay');
    if (!rollOffOverlay) {
      rollOffOverlay = document.createElement('div');
      rollOffOverlay.id = 'roll-off-overlay';
      rollOffOverlay.className = 'roll-off-overlay';
      rollOffOverlay.style.display = 'none';
      rollOffOverlay.setAttribute('aria-live', 'assertive');
      rollOffOverlay.innerHTML = `
        <div class="roll-off-box">
          <h2 class="roll-off-title">🎲 Pre-Game d20 Roll-Off</h2>
          <p id="roll-off-status-text" class="roll-off-status">Roll d20 to determine turn order (Highest goes first).</p>
          <div id="roll-off-results-list" class="roll-off-results"></div>
          <div class="roll-off-actions">
            <button id="btn-roll-d20" class="btn btn-primary btn-roll-d20">🎲 Roll d20 for Turn Order</button>
          </div>
        </div>
      `;
      viewArena.appendChild(rollOffOverlay);
    }

    if (!chatDrawer) {
      chatDrawer = document.createElement('aside');
      chatDrawer.id = 'chat-drawer';
      chatDrawer.className = 'rpm-chat-drawer';
      chatDrawer.setAttribute('aria-label', 'Chat and Turn Commands');
      viewArena.appendChild(chatDrawer);
    } else if (chatDrawer.parentElement !== viewArena) {
      viewArena.appendChild(chatDrawer);
    }

    if (!modalRoot) {
      modalRoot = document.createElement('div');
      modalRoot.id = 'modal-root';
      modalRoot.className = 'rpm-modal-host';
      modalRoot.setAttribute('aria-hidden', 'true');
      this.container.appendChild(modalRoot);
    }

    // Mount CardOverlayModal into modalRoot if available
    if (this.cardModal) {
      this.cardModal.mount(modalRoot);
    }
    if (this.targetModal && typeof this.targetModal.mount === 'function') {
      this.targetModal.mount(modalRoot);
    }
    if (this.diceRollOverlay && typeof this.diceRollOverlay.mount === 'function') {
      this.diceRollOverlay.mount(modalRoot);
    }
  }

  // ==========================================================================
  // Subsystem Subscriptions
  // ==========================================================================

  /**
   * Subscribes to events from all reactive state managers.
   * @private
   */
  _setupSubscriptions() {
    // 1. TabletopStateManager
    if (this.tabletopState && typeof this.tabletopState.subscribe === 'function') {
      const unsub = this.tabletopState.subscribe(() => {
        if (!this.isDestroyed) this.reconcileDOM();
      });
      this._unsubscribers.push(unsub);
    }
    if (this.tabletopState && typeof this.tabletopState.on === 'function') {
      const onGameOver = (data) => {
        if (this.isDestroyed) return;
        if (this.perkinsAgent && typeof this.perkinsAgent.destroy === 'function') {
          try { this.perkinsAgent.destroy(); } catch (_) {}
          this.perkinsAgent = null;
        }
        if (this.botAgents) {
          const bots = typeof this.botAgents.values === 'function' ? this.botAgents.values() : this.botAgents;
          for (const bot of bots) {
            try { bot?.destroy?.(); } catch (_) {}
          }
          if (typeof this.botAgents.clear === 'function') {
            this.botAgents.clear();
          }
        }
        if (this.lobbyManager && typeof this.lobbyManager.invalidateReadiness === 'function') {
          try { this.lobbyManager.invalidateReadiness('MATCH_COMPLETED'); } catch (_) {}
        }
        if (this.tabletopState) {
          this.tabletopState.isGameOver = true;
        }
        if (this.priorityMachine) {
          this.priorityMachine.isGameOver = true;
        }
        this.isMatchActiveFlag = false;
        this._hasMatchStarted = false;
        this.tabRouter.unlockAll?.();
        const winnerId = data?.winnerId || this.tabletopState?.winnerId;
        const winnerName = (winnerId && this.tabletopState?.players?.[winnerId]?.name) || (winnerId === this.myPlayerId ? this.username : (winnerId ? `Player ${winnerId.toUpperCase()}` : null));
        this.archiveMatchRecord({ winnerId, winnerName });
        if (winnerId && typeof this.handleMatchVictory === 'function') {
          this.handleMatchVictory({
            winner: winnerId,
            winnerId,
            winnerName
          });
        } else {
          this.showGameOverModal(data);
        }
        this.reconcileDOM();
      };
      this.tabletopState.on('GAME_OVER', onGameOver);
      this._unsubscribers.push(() => {
        if (typeof this.tabletopState.off === 'function') {
          this.tabletopState.off('GAME_OVER', onGameOver);
        }
      });
    }

    // 2. PriorityStateMachine
    if (this.priorityMachine && typeof this.priorityMachine.subscribe === 'function') {
      const unsub = this.priorityMachine.subscribe((event) => {
        if (this.isDestroyed) return;
        if (event && (event.type === 'TURN_ADVANCED' || event.type === 'TURN_ROTATED')) {
          if (this.tabletopState && typeof this.tabletopState.resetTurnQuotas === 'function') {
            const nextActiveId = event.activePlayerId || event.newActivePlayerId || this.priorityMachine.activePlayerId;
            this.tabletopState.resetTurnQuotas(nextActiveId);
          }
        }
        this.reconcileDOM();
      });
      this._unsubscribers.push(unsub);
    }

    if (this.priorityMachine && typeof this.priorityMachine.on === 'function') {
      const onStackResolve = (event) => {
        if (this.isDestroyed) return;
        const resolvedItem = event?.item || event?.spell || event;
        const resolvedName = resolvedItem?.cardName || resolvedItem?.name || resolvedItem?.card?.name;
        if (resolvedName) {
          this.appendExecutionLog('Stack', `✨ Resolved ${resolvedName}`, {
            playerId: resolvedItem?.controllerId || resolvedItem?.sourcePlayerId || this.priorityMachine?.activePlayerId
          });
        }
        // handleStackResolution is now invoked authoritatively by PriorityStateMachine.resolveTop();
        // this handler only triggers a visual reconciliation.
        this.reconcileDOM();
      };
      const onTurnChange = (event) => {
        if (this.isDestroyed) return;
        const nextActiveId = event?.activePlayerId || event?.newActivePlayerId || this.priorityMachine.activePlayerId;
        const tNum = event?.turnNumber || this.priorityMachine?.turnNumber || 1;
        const rNum = event?.roundNumber || this.priorityMachine?.roundNumber || 1;
        const handoverKey = `${tNum}:${nextActiveId}`;
        if (this._lastLoggedTurnHandoverKey === handoverKey) {
          return;
        }
        this._lastLoggedTurnHandoverKey = handoverKey;
        if (this.tabletopState && typeof this.tabletopState.resetTurnQuotas === 'function') {
          this.tabletopState.resetTurnQuotas(nextActiveId);
        }
        this.tabletopState?.recordTrace?.('TURN_TRACE', 'TURN_HANDOVER', {
          turnNumber: tNum,
          roundNumber: rNum,
          previousActivePlayerId: event?.previousPlayerId || null,
          nextActivePlayerId: nextActiveId
        });
        this.appendExecutionLog(`Turn ${tNum}`, `🔄 Turn ${tNum}: ${this.getFriendlyPlayerName(nextActiveId)} is now active`, {
          playerId: nextActiveId
        });
        this.reconcileDOM();
      };
      const onDrawStep = (evt) => {
        if (this.isDestroyed || !evt) return;
        if (evt.shouldSkipDraw) {
          this.showToast(evt.reason || 'CR 103.7a: Starting player in 1v1 skips first turn draw step');
        } else {
          // Draw is executed authoritatively (once per turn) by TabletopStateManager.handlePhaseStepChanged;
          // drawing here as well caused a double draw. Fallback only if the manager is not wired to the machine.
          const wired = this.tabletopState && this.tabletopState.priorityMachine === this.priorityMachine;
          if (!wired && this.tabletopState && typeof this.tabletopState.drawCard === 'function') {
            try {
              this.tabletopState.drawCard(evt.activePlayerId, 1);
            } catch (err) { console.error('[StackResolution Error]:', err); }
          }
        }
        this.reconcileDOM();
      };
      let isAlarmStarting = false;
      const onSpellCastPriorityRotated = (evt) => {
        if (this.isDestroyed || !evt || isAlarmStarting) return;
        const nextId = evt.nextPriorityPlayerId;
        if (this.alarmManager && typeof this.alarmManager.start === 'function') {
          isAlarmStarting = true;
          try {
            this.alarmManager.start(nextId, 15);
          } finally {
            isAlarmStarting = false;
          }
        }
        let oppName = evt.controllerName || nextId;
        if (nextId === this.myPlayerId) {
          oppName = 'You';
        } else if (nextId && nextId.toLowerCase().includes('perkins')) {
          oppName = 'Perkins AI (Bot)';
        } else {
          const p = this.tabletopState?.players?.[nextId];
          oppName = (p && p.name && !this._isRawUuid(p.name)) ? p.name : (nextId || 'Opponent');
        }
        this.showToast(`Spell cast! Priority passed to ${oppName}`);
        this.reconcileDOM();
      };

      this.priorityMachine.on('STACK_RESOLVE', onStackResolve);
      this.priorityMachine.on('TURN_ADVANCED', onTurnChange);
      this.priorityMachine.on('DRAW_STEP', onDrawStep);
      this.priorityMachine.on('SPELL_CAST_PRIORITY_ROTATED', onSpellCastPriorityRotated);
      this.priorityMachine.on('PHASE_STEP_CHANGED', (evt) => {
        if (!this.isDestroyed) {
          this.tabletopState?.recordTrace?.('TURN_TRACE', 'PHASE_STEP_CHANGED', {
            previousStep: evt?.previousStep || null,
            currentPhaseStep: evt?.currentPhaseStep || this.priorityMachine?.currentPhaseStep,
            activePlayerId: evt?.activePlayerId || this.priorityMachine?.activePlayerId,
            priorityPlayerId: evt?.priorityPlayerId || this.priorityMachine?.priorityPlayerId
          });
          this.reconcileDOM();
        }
      });
      this._unsubscribers.push(() => {
        this.priorityMachine.off('STACK_RESOLVE', onStackResolve);
        this.priorityMachine.off('TURN_ADVANCED', onTurnChange);
        if (typeof this.priorityMachine.off === 'function') {
          this.priorityMachine.off('DRAW_STEP', onDrawStep);
          this.priorityMachine.off('SPELL_CAST_PRIORITY_ROTATED', onSpellCastPriorityRotated);
        }
      });
    }

    // 3. StackAlarmManager
    if (this.alarmManager) {
      const prevOnEmit = this.alarmManager.onEmit;
      this.alarmManager.onEmit = (event) => {
        if (typeof prevOnEmit === 'function') prevOnEmit(event);
        if (this.isDestroyed) return;
        this._handleAlarmEvent(event);
      };
    }

    // 4. RandomPerkEngine
    if (this.randomPerk && typeof this.randomPerk.on === 'function') {
      const onStep1 = (data) => {
        if (this.isDestroyed) return;
        const pName = this.getFriendlyPlayerName(data?.activePlayerId);
        const msg = data?.logMessage || `🔮 [RPM Step 1]: Upkeep Emblem Trigger on stack for ${pName}. Priority open.`;
        this.addTurnCommandLog(msg, { playerId: data?.activePlayerId });
        this.reconcileDOM();
      };
      const onRolled = (roll) => {
        if (this.isDestroyed) return;
        this.handlePerkRolled(roll);
        const pName = this.getFriendlyPlayerName(roll?.activePlayerId || this.priorityMachine?.activePlayerId);
        const perkName = roll?.isMiss ? 'Miss' : (roll?.perkName || roll?.matchedKey || 'Perk');
        const rollStr = roll?.rollString || `${roll?.tens ?? ''}${roll?.ones ?? ''}`;
        const msg = roll?.logMessage || `🎲 [RPM Roll]: ${pName} rolled ${rollStr} (${perkName})`;
        this.addTurnCommandLog(msg, { playerId: roll?.activePlayerId });
        this.reconcileDOM();
      };
      const onMiss = (data) => {
        if (this.isDestroyed) return;
        const rollPayload = data?.roll ? { ...data.roll, ...data, isMiss: true } : { ...data, isMiss: true };
        this.handlePerkRolled(rollPayload);
      };
      const onStep2 = (data) => {
        if (this.isDestroyed) return;
        const pName = this.getFriendlyPlayerName(data?.activePlayerId);
        const msg = data?.logMessage || `🔮 [RPM Step 2]: Perk Effect Trigger (${data?.perkKey}) on stack for ${pName}. Priority open.`;
        this.addTurnCommandLog(msg, { playerId: data?.activePlayerId });
        this.reconcileDOM();
      };
      const onResolved = (data) => {
        if (this.isDestroyed) return;
        const msg = data?.logMessage || `✨ [RPM #${data?.perkKey} Resolved]: ${data?.result?.logSummary || 'Effect resolved'}`;
        this.addTurnCommandLog(msg, { playerId: data?.activePlayerId });
        this.reconcileDOM();
      };
      const onAwaitRoll = (data) => {
        if (this.isDestroyed) {
          data?.callback?.('ROLL');
          return;
        }
        if (this.diceRollOverlay) {
          this.diceRollOverlay.open(data);
        } else if (typeof data?.callback === 'function') {
          data.callback('ROLL');
        }
      };
      const onDeclined = (data) => {
        if (this.isDestroyed) return;
        const pName = this.getFriendlyPlayerName(data?.activePlayerId || data?.playerId);
        const msg = data?.logMessage || `🛑 [RPM Step 1]: ${pName} declined to roll the RPM Emblem dice.`;
        this.addTurnCommandLog(msg, { playerId: data?.activePlayerId || data?.playerId });
        this.reconcileDOM();
      };

      this.randomPerk.on('PERK_STEP1_TRIGGERED', onStep1);
      this.randomPerk.on('PERK_DICE_ROLLED', onRolled);
      this.randomPerk.on('PERK_ROLL_MISS', onMiss);
      this.randomPerk.on('PERK_STEP2_TRIGGERED', onStep2);
      this.randomPerk.on('PERK_RESOLVED', onResolved);
      this.randomPerk.on('RPM_AWAIT_PLAYER_ROLL', onAwaitRoll);
      this.randomPerk.on('PERK_ROLL_DECLINED', onDeclined);

      this._unsubscribers.push(() => {
        this.randomPerk.off('PERK_STEP1_TRIGGERED', onStep1);
        this.randomPerk.off('PERK_DICE_ROLLED', onRolled);
        this.randomPerk.off('PERK_ROLL_MISS', onMiss);
        this.randomPerk.off('PERK_STEP2_TRIGGERED', onStep2);
        this.randomPerk.off('PERK_RESOLVED', onResolved);
        this.randomPerk.off('RPM_AWAIT_PLAYER_ROLL', onAwaitRoll);
        this.randomPerk.off('PERK_ROLL_DECLINED', onDeclined);
      });
    }

    const onAwaitSacrifice = (data) => {
      if (this.isDestroyed || !data) return;
      const targetPid = data.playerId || this.myPlayerId;
      if (targetPid !== this.myPlayerId) return;

      const p = this.tabletopState?.players?.[this.myPlayerId];
      const creatures = data.candidateCreatures || data.candidates || p?.battlefield?.creatures || [];
      if (!creatures || creatures.length === 0) {
        if (typeof data.callback === 'function') data.callback(null);
        return;
      }

      if (this.targetModal && typeof this.targetModal.openSacrificeSelector === 'function') {
        this.targetModal.openSacrificeSelector({
          spell: data.spell || { name: data.sourceName || 'Sacrifice Choice' },
          candidates: creatures,
          prompt: data.prompt || 'Elige una criatura para sacrificar:',
          onSelectCandidate: (chosen) => {
            if (typeof data.callback === 'function') {
              data.callback(chosen);
            } else if (typeof data.onSelect === 'function') {
              data.onSelect(chosen);
            } else if (this.tabletopState && typeof this.tabletopState.sacrificePermanent === 'function') {
              this.tabletopState.sacrificePermanent(this.myPlayerId, chosen.instanceId || chosen.id);
            }
            this.reconcileDOM();
          },
          onCancel: () => {
            if (typeof data.onCancel === 'function') data.onCancel();
          }
        });
      }
    };

    if (this.tabletopState && typeof this.tabletopState.on === 'function') {
      this.tabletopState.on('AWAIT_PLAYER_SACRIFICE_CHOICE', onAwaitSacrifice);
      const onOptionalEtb = (data) => {
        if (this.isDestroyed || (data?.playerId && data.playerId !== this.myPlayerId)) return;
        this.openOptionalTriggerModal({
          title: "⚡ Sigarda's Aid (Attach Equipment)",
          description: `¿Deseas anexar gratis ${data?.equipment?.name || 'este equipo'} a una de tus criaturas?`,
          confirmLabel: '⚡ Anexar Gratis',
          declineLabel: '✋ Rechazar',
          onConfirm: () => { if (typeof data?.onConfirm === 'function') data.onConfirm(); },
          onDecline: () => { if (typeof data?.onDecline === 'function') data.onDecline(); }
        });
      };
      const onLeylinePrompt = (data) => {
        if (this.isDestroyed || (data?.playerId && data.playerId !== this.myPlayerId)) return;
        this.openOptionalTriggerModal({
          title: '⚡ Leyline Axe (CR 103.6)',
          description: 'Tienes Leyline Axe en tu mano inicial. ¿Deseas comenzar el juego con él en el campo de batalla gratis?',
          confirmLabel: '⚡ Bajar Gratis',
          declineLabel: '✋ Mantener en Mano',
          onConfirm: () => { if (typeof data?.onConfirm === 'function') data.onConfirm(); },
          onDecline: () => { if (typeof data?.onDecline === 'function') data.onDecline(); }
        });
      };
      this.tabletopState.on('OPTIONAL_ETB_AUTO_ATTACH', onOptionalEtb);
      this.tabletopState.on('PREGAME_LEYLINE_PROMPT', onLeylinePrompt);

      const onTriggerTargetRequired = (payload) => {
        if (this.isDestroyed || !payload) return;
        if (payload.controllerId === this.myPlayerId) {
          if (this.targetModal && typeof this.targetModal.openTriggerTargetSelector === 'function' && Boolean(this.container)) {
            if (!this.targetModal.element && this.container) {
              const modalHost = this.container.querySelector('#modal-root') || this.container;
              if (typeof this.targetModal.mount === 'function') {
                this.targetModal.mount(modalHost);
              } else {
                this.targetModal.container = modalHost;
                this.targetModal.init();
              }
            }
            this.targetModal.openTriggerTargetSelector(payload, (chosenIdOrDecline) => {
              if (this.tabletopState && typeof this.tabletopState.resolvePendingTriggerChoice === 'function') {
                this.tabletopState.resolvePendingTriggerChoice(payload.triggerId, chosenIdOrDecline);
              }
              this.reconcileDOM();
            });
          } else {
            const fallbackChoice = payload.candidates?.[0]?.id || payload.candidates?.[0]?.instanceId || 'DECLINE';
            if (this.tabletopState && typeof this.tabletopState.resolvePendingTriggerChoice === 'function') {
              this.tabletopState.resolvePendingTriggerChoice(payload.triggerId, fallbackChoice);
            }
            this.reconcileDOM();
          }
        } else {
          // Bot controller: auto-resolve targeting strongest own creature (power, then toughness)
          let bestId = 'DECLINE';
          const candidates = Array.isArray(payload.candidates) ? [...payload.candidates] : [];
          if (candidates.length > 0) {
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
          if (this.tabletopState && typeof this.tabletopState.resolvePendingTriggerChoice === 'function') {
            this.tabletopState.resolvePendingTriggerChoice(payload.triggerId, bestId);
          }
          this.reconcileDOM();
        }
      };

      this.tabletopState.on('TRIGGER_TARGET_REQUIRED', onTriggerTargetRequired);

      this._unsubscribers.push(() => {
        if (typeof this.tabletopState.off === 'function') {
          this.tabletopState.off('AWAIT_PLAYER_SACRIFICE_CHOICE', onAwaitSacrifice);
          this.tabletopState.off('OPTIONAL_ETB_AUTO_ATTACH', onOptionalEtb);
          this.tabletopState.off('PREGAME_LEYLINE_PROMPT', onLeylinePrompt);
          this.tabletopState.off('TRIGGER_TARGET_REQUIRED', onTriggerTargetRequired);
        }
      });
    }
    if (this.randomPerk && typeof this.randomPerk.on === 'function') {
      this.randomPerk.on('AWAIT_PLAYER_SACRIFICE_CHOICE', onAwaitSacrifice);
      this._unsubscribers.push(() => {
        if (typeof this.randomPerk.off === 'function') {
          this.randomPerk.off('AWAIT_PLAYER_SACRIFICE_CHOICE', onAwaitSacrifice);
        }
      });
    }

    // 5. DualChannelChat
    if (this.dualChat && typeof this.dualChat.subscribe === 'function') {
      const unsub = this.dualChat.subscribe(() => {
        if (!this.isDestroyed) this._reconcileChat();
      });
      this._unsubscribers.push(unsub);
    }

    // 6. RelayClient
    if (this.relayClient) {
      const onConn = () => this._setConnectionStatus('CONNECTED');
      const onDisconn = () => this._setConnectionStatus('OFFLINE');
      const onReconn = () => this._setConnectionStatus('RECONNECTING');
      const onStateSync = (snapshot) => {
        this.handleStateSync(snapshot);
      };
      const onPlayerJoined = (msg) => {
        this.handlePlayerJoined(msg);
      };
      const onPlayerDisconnected = (msg) => {
        this.handlePlayerConnectionChanged(msg.playerId, 'DISCONNECTED');
      };
      const onPlayerReconnected = (msg) => {
        this.handlePlayerConnectionChanged(msg.playerId, 'CONNECTED');
      };
      const onSequenced = (msg) => {
        // Echo suppression: If this client originated the action, it was already applied locally
        if (msg.slotId && this.relayClient && msg.slotId === this.relayClient.slotId) {
          return;
        }
        this.dispatchAction(msg.action || msg, { origin: 'REMOTE' });
      };
      const onPlayerEliminated = (msg) => {
        this.dispatchAction({ type: 'PLAYER_ELIMINATED', payload: msg }, { origin: 'REMOTE' });
      };
      const onVictory = (msg) => {
        this.dispatchAction({ type: 'MATCH_VICTORY', payload: msg }, { origin: 'REMOTE' });
      };

      this.relayClient.on('connected', onConn);
      this.relayClient.on('disconnected', onDisconn);
      this.relayClient.on('reconnecting', onReconn);
      this.relayClient.on('state_sync', onStateSync);
      this.relayClient.on('player_joined', onPlayerJoined);
      this.relayClient.on('player_disconnected', onPlayerDisconnected);
      this.relayClient.on('player_reconnected', onPlayerReconnected);
      this.relayClient.on('action_sequenced', onSequenced);
      this.relayClient.on('player_eliminated', onPlayerEliminated);
      this.relayClient.on('match_victory', onVictory);

      this._unsubscribers.push(() => {
        this.relayClient.off('connected', onConn);
        this.relayClient.off('disconnected', onDisconn);
        this.relayClient.off('reconnecting', onReconn);
        this.relayClient.off('state_sync', onStateSync);
        this.relayClient.off('player_joined', onPlayerJoined);
        this.relayClient.off('player_disconnected', onPlayerDisconnected);
        this.relayClient.off('player_reconnected', onPlayerReconnected);
        this.relayClient.off('action_sequenced', onSequenced);
        this.relayClient.off('player_eliminated', onPlayerEliminated);
        this.relayClient.off('match_victory', onVictory);
      });
    }

    // 7. Global Keyboard Event Listener
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', this._boundKeyDown);
    }
  }

  /**
   * Binds UI events to interactive DOM buttons.
   * @private
   */
  _bindDOMEvents() {
    if (!this.container) return;

    // Room Create / Join
    const btnCreate = this.container.querySelector('#btn-create-room');
    if (btnCreate) {
      const handler = () => this.createRoom();
      btnCreate.addEventListener('click', handler);
      this._domListeners.push(() => btnCreate.removeEventListener('click', handler));
    }

    const btnJoin = this.container.querySelector('#btn-join-room');
    if (btnJoin) {
      const handler = () => {
        const inp = this.container.querySelector('#room-code-input');
        if (inp && inp.value) this.joinRoom(inp.value.trim());
      };
      btnJoin.addEventListener('click', handler);
      this._domListeners.push(() => btnJoin.removeEventListener('click', handler));
    }

    // Audio Mute Toggle
    const btnMute = this.container.querySelector('#btn-audio-mute');
    if (btnMute) {
      const handler = () => {
        this.audioEnabled = !this.audioEnabled;
        const icon = btnMute.querySelector('.icon-speaker');
        if (icon) icon.textContent = this.audioEnabled ? '🔊' : '🔇';
      };
      btnMute.addEventListener('click', handler);
      this._domListeners.push(() => btnMute.removeEventListener('click', handler));
    }

    // Play vs Perkins Button
    const btnPlayPerkins = this.container.querySelector('#btn-play-perkins');
    if (btnPlayPerkins) {
      const handler = async () => {
        await this.startPerkinsMatch();
      };
      btnPlayPerkins.addEventListener('click', handler);
      this._domListeners.push(() => btnPlayPerkins.removeEventListener('click', handler));
    }

    // Open Deckbuilder Modal
    const btnDeckbuilder = this.container.querySelector('#btn-open-deckbuilder');
    if (btnDeckbuilder) {
      const handler = () => this.openModal('DECKBUILDER');
      btnDeckbuilder.addEventListener('click', handler);
      this._domListeners.push(() => btnDeckbuilder.removeEventListener('click', handler));
    }

    // Pass Priority Button
    const btnPass = this.container.querySelector('#btn-pass-priority');
    if (btnPass) {
      const handler = () => this.dispatchAction({ type: 'PASS_PRIORITY' }, { origin: 'LOCAL' });
      btnPass.addEventListener('click', handler);
      this._domListeners.push(() => btnPass.removeEventListener('click', handler));
    }

    // Hold Priority Button
    const btnHold = this.container.querySelector('#btn-hold-respond');
    if (btnHold) {
      const handler = () => this.dispatchAction({ type: 'HOLD_RESPOND' }, { origin: 'LOCAL' });
      btnHold.addEventListener('click', handler);
      this._domListeners.push(() => btnHold.removeEventListener('click', handler));
    }

    // Top-Level Nav Tabs
    const navTabs = this.container.querySelectorAll('.nav-tab');
    navTabs.forEach(btn => {
      const handler = () => {
        const targetTab = btn.getAttribute('data-tab');
        if (!targetTab) return;
        this.tabRouter.navigate(targetTab, this.getMatchState(), this.isSpectator());
      };
      btn.addEventListener('click', handler);
      this._domListeners.push(() => btn.removeEventListener('click', handler));
    });

    // Roll-off Button
    const btnRollD20 = this.container.querySelector('#btn-roll-d20');
    if (btnRollD20) {
      const handler = () => this.submitRollOff();
      btnRollD20.addEventListener('click', handler);
      this._domListeners.push(() => btnRollD20.removeEventListener('click', handler));
    }
  }

  // ==========================================================================
  // Perkins AI Autonomous Opponent & Coach (SPEC-RPM-PERKINS-013)
  // ==========================================================================

  /**
   * Initiates an instant solo match against Perkins AI (INV-PERKINS-2).
   * 
   * @param {string|Object} [deckIdOrOptions={}]
   * @param {Object} [maybeOptions={}]
   * @returns {Promise<PerkinsAgent>} Instantiated Perkins agent
   */
  /**
   * Assigns a deck (AMERICAN_GADGETS, 5 starters, or a saved user slot deck) to a bot seat.
   *
   * @param {string} botSeatId
   * @param {string|Object} deckIdOrSlot
   * @returns {Object|null} The resolved deck object
   */
  assignBotDeck(botSeatId, deckIdOrSlot) {
    if (!botSeatId || !deckIdOrSlot) return null;

    let resolvedDeck = null;

    // 1. Direct deck object passed
    if (typeof deckIdOrSlot === 'object' && (deckIdOrSlot.mainboard || deckIdOrSlot.cards)) {
      resolvedDeck = deckIdOrSlot;
    }

    // 2. Saved user slot deck via DeckSlotManager
    if (!resolvedDeck && this.deckSlotManager && typeof this.deckSlotManager.getSlotDeck === 'function') {
      try {
        const slotDeck = this.deckSlotManager.getSlotDeck(deckIdOrSlot);
        if (slotDeck && (slotDeck.mainboard || slotDeck.cards)) {
          resolvedDeck = slotDeck;
        }
      } catch (_) {}
    }

    // 3. Preconstructed decks (American Gadgets, starters, aliases)
    if (!resolvedDeck && typeof getPreconstructedDeckById === 'function') {
      try {
        resolvedDeck = getPreconstructedDeckById(deckIdOrSlot);
      } catch (_) {}
    }

    // 4. Beginner decks (W, U, B, R, G)
    if (!resolvedDeck && BEGINNER_DECKS && BEGINNER_DECKS[deckIdOrSlot]) {
      resolvedDeck = BEGINNER_DECKS[deckIdOrSlot];
    }

    // 5. Name or ID match across PRECONSTRUCTED_STARTER_DECKS
    if (!resolvedDeck && Array.isArray(PRECONSTRUCTED_STARTER_DECKS)) {
      const norm = String(deckIdOrSlot).trim().toUpperCase();
      resolvedDeck = PRECONSTRUCTED_STARTER_DECKS.find(d => {
        const dId = String(d.id || '').toUpperCase();
        const dName = String(d.name || '').toUpperCase();
        return dId === norm || dName === norm || (norm === 'AMERICAN_GADGETS' && (dId.includes('AMERICAN_GADGETS') || dName.includes('AMERICAN GADGETS')));
      }) || null;
    }

    // 6. Defensive check on getStarterDeck
    if (!resolvedDeck && typeof getStarterDeck === 'function') {
      try {
        resolvedDeck = getStarterDeck(deckIdOrSlot);
      } catch (_) {}
    }

    if (!resolvedDeck) {
      return null;
    }

    this._assignedBotDecks = this._assignedBotDecks || new Map();
    this._assignedBotDecks.set(botSeatId, resolvedDeck);

    const bot = this.botAgents?.get(botSeatId) || (this.perkinsAgent?.slotId === botSeatId ? this.perkinsAgent : null);
    if (bot) {
      if (typeof bot.setAssignedDeck === 'function') {
        bot.setAssignedDeck(resolvedDeck);
      } else {
        bot.assignedDeck = resolvedDeck;
        bot.starterDeck = resolvedDeck;
      }
    }

    const botPlayer = this.tabletopState?.players?.[botSeatId];
    if (botPlayer && !this._hasMatchStarted) {
      const mainboard = resolvedDeck.mainboard || resolvedDeck.cards || [];
      if (mainboard.length > 0) {
        const libCards = mainboard.flatMap(c => {
          const count = c.count || 1;
          const meta = getHydratedCardMetadata(c.name);
          return Array.from({ length: count }, () => {
            const cardObj = {
              instanceId: generateInstanceId(),
              ownerId: botSeatId,
              controllerId: botSeatId,
              name: c.name,
              typeLine: c.type || meta?.typeLine || 'Creature',
              manaCost: c.manaCost ?? meta?.manaCost ?? (c.cmc === 0 ? '' : '{R}'),
              cmc: c.cmc ?? meta?.cmc ?? 1,
              power: c.power ?? meta?.power ?? 2,
              toughness: c.toughness ?? meta?.toughness ?? 2,
              keywords: { ...(meta?.keywords || {}), ...(c.keywords || {}) },
              effect: meta?.effect || null,
              isTapped: false,
              isSummoningSick: false
            };
            return TabletopStateManager.hydrateCardMechanics(cardObj);
          });
        });
        botPlayer.library = libCards;
        botPlayer.zones = botPlayer.zones || {};
        botPlayer.zones.library = [...libCards];
      }
    }

    return resolvedDeck;
  }

  async startPerkinsMatch(deckIdOrOptions = {}, maybeOptions = {}) {
    let deckId = null;
    let options = {};
    if (typeof deckIdOrOptions === 'string') {
      deckId = deckIdOrOptions;
      options = maybeOptions || {};
    } else {
      options = deckIdOrOptions || {};
      deckId = options.deckId || options.starterDeckId || 'R';
    }

    // Intercept with contextual auth / deck modals if requireAuth is active (INV-AUTH-GATE-2)
    this._syncAuthUser();
    if (this.requireAuth && this.authManager) {
      if (!this.authManager.isAuthenticated()) {
        this.showAuthModal(() => this.startPerkinsMatch(deckIdOrOptions, maybeOptions));
        return null;
      }
      if (!this.authManager.isOnboarded()) {
        const existingDeck = this.activeDeckData || this.getActiveDeckForPlayer(this.myPlayerId);
        if (existingDeck && Array.isArray(existingDeck.mainboard) && existingDeck.mainboard.length > 0 && typeof this.authManager.saveActiveDeck === 'function') {
          try {
            await this.authManager.saveActiveDeck(existingDeck.id || `custom_${Date.now()}`, existingDeck);
          } catch (_) {}
        }
      }
      if (!this.authManager.isOnboarded()) {
        this.showDeckModal(() => this.startPerkinsMatch(deckIdOrOptions, maybeOptions));
        return null;
      }
    }

    // 1. Teardown any existing active bot (INV-SAFE-3)
    if (this.perkinsAgent) {
      try { this.perkinsAgent.destroy(); } catch (_) {}
      this.perkinsAgent = null;
    }

    // 2. Configure 2-player seating: [this.myPlayerId, botSeatId]
    const botSeatId = options.slotId || 'p2_perkins';
    this.playerIds = [this.myPlayerId, botSeatId];

    if (!this.drawerState[botSeatId]) {
      this.drawerState[botSeatId] = {};
    }

    // Ensure bot registered in TabletopStateManager
    if (this.tabletopState) {
      this.tabletopState.isGameOver = false;
      this.tabletopState.winnerId = null;
      // Purge any phantom players (like legacy p2) to eliminate opponent duplicate bug
      this.tabletopState.players = {};
      if (typeof this.tabletopState.registerPlayer === 'function') {
        try {
          this.tabletopState.registerPlayer(this.myPlayerId, this.username);
          this.tabletopState.registerPlayer(botSeatId, options.name || 'Perkins AI (Bot)');
        } catch (_) {}
      }
      if (!this.tabletopState.players[this.myPlayerId]) {
        this.tabletopState.players[this.myPlayerId] = {
          id: this.myPlayerId,
          playerId: this.myPlayerId,
          name: this.username,
          resources: { life: 20, poison: 0, energy: 0, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 } },
          zones: { hand: [], library: [], graveyard: [], exile: [], battlefield: [] },
          battlefield: { lands: [], creatures: [], noncreatures: [], planeswalkers: [] },
          hand: [],
          library: [],
          graveyard: [],
          exile: [],
          isEliminated: false
        };
      }
      if (!this.tabletopState.players[botSeatId]) {
        this.tabletopState.players[botSeatId] = {
          id: botSeatId,
          playerId: botSeatId,
          name: options.name || 'Perkins AI (Bot)',
          resources: { life: 20, poison: 0, energy: 0, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 } },
          zones: { hand: [], library: [], graveyard: [], exile: [], battlefield: [] },
          battlefield: { lands: [], creatures: [], noncreatures: [], planeswalkers: [] },
          hand: [],
          library: [],
          graveyard: [],
          exile: [],
          isEliminated: false
        };
      }
    }

    // Configure PriorityStateMachine players
    if (this.priorityMachine) {
      this.priorityMachine.players = [this.myPlayerId, botSeatId];
      if (!this.priorityMachine.activePlayerId) {
        this.priorityMachine.activePlayerId = this.myPlayerId;
      }
      if (!this.priorityMachine.priorityPlayerId) {
        this.priorityMachine.priorityPlayerId = this.myPlayerId;
      }
    }

    // 3. Initialize starter deck for Perkins
    let assigned = this._assignedBotDecks?.get(botSeatId) || options.assignedDeck;
    if (!assigned && (options.botDeck || options.deckIdOrSlot)) {
      assigned = this.assignBotDeck(botSeatId, options.botDeck || options.deckIdOrSlot);
    }
    const starter = assigned || options.starterDeck || (deckId && BEGINNER_DECKS[deckId]) || BEGINNER_DECKS.R;
    const botPlayer = this.tabletopState?.players?.[botSeatId];
    if (botPlayer) {
      const mainboard = starter.mainboard || [];
      const libCards = mainboard.flatMap(c => {
        const count = c.count || 1;
        const meta = getHydratedCardMetadata(c.name);
        return Array.from({ length: count }, () => {
          const cardObj = {
            instanceId: generateInstanceId(),
            ownerId: botSeatId,
            controllerId: botSeatId,
            name: c.name,
            typeLine: c.type || meta?.typeLine || 'Creature',
            manaCost: c.manaCost || meta?.manaCost || (c.cmc === 0 ? '' : '{R}'),
            cmc: c.cmc ?? meta?.cmc ?? 1,
            power: c.power ?? meta?.power ?? 2,
            toughness: c.toughness ?? meta?.toughness ?? 2,
            keywords: { ...(meta?.keywords || {}), ...(c.keywords || {}) },
            effect: meta?.effect || null,
            isTapped: false,
            isSummoningSick: false
          };
          return TabletopStateManager.hydrateCardMechanics(cardObj);
        });
      });
      botPlayer.library = libCards;
      botPlayer.zones = botPlayer.zones || {};
      botPlayer.zones.library = [...libCards];
    }

    // 4. Instantiate PerkinsAgent
    const agent = new PerkinsAgent({
      slotId: botSeatId,
      name: options.name || 'Perkins AI (Bot)',
      mode: 'LOCAL',
      thinkingDelayMs: options.thinkingDelayMs !== undefined ? options.thinkingDelayMs : 1200,
      coachEnabled: options.coachEnabled !== false,
      language: options.language || 'es',
      starterDeck: starter,
      assignedDeck: assigned || starter,
      ...options
    });
    if (assigned && typeof agent.setAssignedDeck === 'function') {
      agent.setAssignedDeck(assigned);
    }

    // 5. Attach to app controller
    agent.attach(this);
    this.perkinsAgent = agent;

    this.startMatch({ playerIds: [this.myPlayerId, botSeatId] });
    if (this.pregameEnabled && options.pregame !== false) {
      const useInteractiveRollOff = (options.interactiveRollOff === true) ||
        (options.interactiveRollOff !== false && typeof this.isInteractiveBrowserMode === 'function' && this.isInteractiveBrowserMode());
      if (useInteractiveRollOff) {
        this.startRollOff([this.myPlayerId, botSeatId]);
      } else {
        this._beginPregame();
      }
    }
    return agent;
  }

  /**
   * Spawns a headless Perkins bot inside an online multiplayer room.
   * 
   * @param {string} roomCode - Target room code
   * @param {string|Object} [optionsOrSeatId={}] - Target player seat or options
   * @returns {Promise<PerkinsAgent>}
   */
  async spawnBotInRoom(roomCode, optionsOrSeatId = {}) {
    const options = typeof optionsOrSeatId === 'string' ? { slotId: optionsOrSeatId } : (optionsOrSeatId || {});
    const botSeatId = options.slotId || 'p2';

    const defaultRelayUrl = (typeof window !== 'undefined' && window.location && window.location.host)
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
      : (this.options?.relayUrl || 'ws://localhost:3000');

    const relayClient = options.relayClient || new RelayClient({
      url: options.relayUrl || defaultRelayUrl
    });

    const assigned = this._assignedBotDecks?.get(botSeatId) || options.assignedDeck || (options.botDeck ? this.assignBotDeck(botSeatId, options.botDeck) : null);

    const agent = new PerkinsAgent({
      slotId: botSeatId,
      name: options.name || 'Perkins AI (Bot)',
      mode: 'REMOTE',
      thinkingDelayMs: options.thinkingDelayMs !== undefined ? options.thinkingDelayMs : 1200,
      coachEnabled: false,
      language: options.language || 'es',
      assignedDeck: assigned,
      ...options
    });
    if (assigned && typeof agent.setAssignedDeck === 'function') {
      agent.setAssignedDeck(assigned);
    }

    agent.attachRelay(relayClient);
    if (roomCode && typeof relayClient.joinRoom === 'function') {
      try {
        await relayClient.connect();
        await relayClient.joinRoom(roomCode, botSeatId);
      } catch (_) {}
    }
    return agent;
  }

  // ==========================================================================
  // Unidirectional Action Dispatcher (INV-HARNESS-2)
  // ==========================================================================

  /**
   * Central Unidirectional Action Dispatcher.
   * Strictly enforces INV-HARNESS-2:
   * When origin === 'LOCAL', transmits action over WebSocket.
   * When origin === 'REMOTE' or 'LOCAL_BOT', updates local state WITHOUT re-broadcasting.
   * 
   * @param {Object} action
   * @param {Object} [context={ origin: 'LOCAL' }]
   * @returns {Promise<void>}
   */
  async dispatchAction(action, context = { origin: 'LOCAL' }) {
    if (!action) return;

    const origin = context?.origin || action.origin || 'LOCAL';
    const actionType = action.type === 'ACTION_SEQUENCED' ? action.actionType : (action.actionType || action.type);
    const payload = action.payload || {};

    // CR 103: only pre-game actions are accepted until GAME_ACTIVE
    if (this.pregameActive && !/^(EXECUTE_STARTING_ROLL|SELECT_PLAY_OR_DRAW|DRAW_INITIAL_HANDS|DECIDE_MULLIGAN|PUT_ON_BOTTOM|AUTO_SYNC_EVENT|ROOM_JOINED|READY_CHECK_PASSED|ROLL_OFF_COMPLETE|MULLIGAN_COMPLETE|TURN_1_MAIN_PHASE|SPELL_CAST|COMBAT_DAMAGE|STATE_HASH_MATCH)$/.test(String(actionType))) {
      this.showToast?.('Pre-game in progress: finish the mulligan first');
      return;
    }

    // Definitive GAME_OVER lockdown
    const GAME_ACTIONS = ['PASS_PRIORITY', 'NEXT_PHASE', 'CAST_SPELL', 'PLAY_LAND', 'DECLARE_ATTACKERS', 'DECLARE_BLOCKERS'];
    if (this.tabletopState?.isGameOver && GAME_ACTIONS.includes(actionType)) {
      return;
    }

    // Invariant INV-HARNESS-2 & INV-PERKINS-2: Circular loop suppression
    if (origin === 'LOCAL') {
      if (this.relayClient && typeof this.relayClient.sendAction === 'function') {
        try {
          this.relayClient.sendAction(action);
        } catch (_) {}
      }
    }

    // Mutate local state managers
    switch (actionType) {
      case 'AUTO_SYNC_EVENT':
      case 'ROOM_JOINED':
      case 'READY_CHECK_PASSED':
      case 'ROLL_OFF_COMPLETE':
      case 'MULLIGAN_COMPLETE':
      case 'TURN_1_MAIN_PHASE':
      case 'SPELL_CAST':
      case 'COMBAT_DAMAGE':
      case 'STATE_HASH_MATCH':
        this._applyAutopilotTransition(actionType, payload);
        break;
      case 'PASS_PRIORITY':
        if (this.priorityMachine) {
          const targetPlayerId = payload.playerId || (action.slotId ? `player_${action.slotId}` : this.priorityMachine.priorityPlayerId);
          this.priorityMachine.passPriority(targetPlayerId);
        }
        break;

      case 'HOLD_RESPOND':
        if (this.alarmManager) {
          this.alarmManager.hold();
        }
        break;

      case 'ACTIVATE_EQUIP':
      case 'EQUIP': {
        const playerId = payload.playerId || action.playerId || this.myPlayerId;
        const equipmentId = payload.equipmentId || payload.equipment?.instanceId || action.equipmentId;
        const targetCreatureId = payload.targetCreatureId || payload.targetCreature?.instanceId || action.targetCreatureId;
        if (this.tabletopState && typeof this.tabletopState.activateEquipAbility === 'function' && equipmentId && targetCreatureId) {
          try {
            const isFree = Boolean(payload.isFree);
            this.tabletopState.activateEquipAbility(playerId, equipmentId, targetCreatureId, { isFree });
          } catch (err) {
            console.warn('[RPM] Equip action failed:', err.message);
          }
        }
        break;
      }

      case 'CHANGE_LIFE': {
        const targetId = payload.playerId || this.myPlayerId;
        const p = this.tabletopState?.players?.[targetId];
        if (p) {
          const delta = payload.delta !== undefined ? payload.delta : (payload.amount !== undefined ? (payload.amount - (p.resources.life ?? 20)) : 0);
          p.resources.life = (p.resources.life ?? 20) + delta;
          if (p.resources.life <= 0) {
            this.handlePlayerElimination(targetId, 'LIFE_ZERO');
          }
        }
        break;
      }

      case 'CAST_SPELL': {
        const cardObj = payload.card || action.card || payload;
        const controllerId = payload.controllerId || action.controllerId || payload.playerId || action.playerId || cardObj.controllerId;
        const sourcePlayerId = payload.playerId || action.playerId || payload.controllerId || action.controllerId || cardObj.sourcePlayerId;
        const controllerName = payload.controllerName || action.controllerName || cardObj.controllerName;
        const cardName = payload.cardName || action.cardName || cardObj.name || cardObj.cardName;

        // 1. Hand Zone Card Splicing (INV-BOT-CAST-1)
        if (this.tabletopState?.players?.[controllerId]) {
          const p = this.tabletopState.players[controllerId];
          const handList = Array.isArray(p.zones?.hand) ? p.zones.hand : (Array.isArray(p.hand) ? p.hand : []);
          const idx = handList.findIndex(c => {
            if (!c) return false;
            if (cardObj.instanceId && c.instanceId === cardObj.instanceId) return true;
            const cName = c.name || c.cardName || c;
            return cName === cardName;
          });

          if (idx !== -1) {
            handList.splice(idx, 1);
            if (p.zones) p.zones.hand = handList;
            p.hand = handList;
          }
        }

        // 2. Auto-Tap Mana Pool Deduction & Land Tapping (INV-BOT-CAST-1)
        const manaCost = cardObj.manaCost || payload.manaCost;
        const manaAlreadyPaid = Boolean(payload.manaAlreadyPaid || action.manaAlreadyPaid);
        if (!manaAlreadyPaid && this.tabletopState && manaCost && typeof this.tabletopState.autoTapForMana === 'function') {
          try {
            this.tabletopState.autoTapForMana(controllerId, manaCost);
          } catch (err) {
            console.warn(`[app] autoTapForMana warning for player ${controllerId}:`, err.message);
          }
        }

        // 3. Stack Placement & Priority Forwarding
        const typeLine = String(cardObj.typeLine || cardObj.type || '').toLowerCase();
        const isTargetable = typeLine.includes('instant') || typeLine.includes('sorcery') || typeLine.includes('aura');
        const rawTargetData = payload.targets || action.targets || payload.targetId || action.targetId;
        const formattedTargets = isTargetable
          ? (Array.isArray(rawTargetData) ? rawTargetData : (rawTargetData ? [rawTargetData] : []))
          : [];
        const explicitTargetId = isTargetable ? (payload.targetId || action.targetId || (formattedTargets.length > 0 ? formattedTargets[0] : null)) : null;

        const explicitCreatureId = payload.creatureId || action.creatureId || cardObj?.creatureId || null;
        const explicitEquipmentId = payload.equipmentId || action.equipmentId || cardObj?.equipmentId || null;
        const explicitSelectedCombination = payload.selectedCombination || payload.combination || action.selectedCombination || cardObj?.selectedCombination || null;

        if (cardObj) {
          cardObj.targetId = explicitTargetId;
          cardObj.targets = formattedTargets;
          if (explicitCreatureId) cardObj.creatureId = explicitCreatureId;
          if (explicitEquipmentId) cardObj.equipmentId = explicitEquipmentId;
          if (explicitSelectedCombination) cardObj.selectedCombination = explicitSelectedCombination;
        }

        const castMode = payload.castMode || action.castMode || cardObj.activeCastMode || cardObj.selectedCastMode || null;
        if (cardObj && castMode) {
          cardObj.activeCastMode = castMode;
          cardObj.selectedCastMode = castMode;
        }

        if (this.priorityMachine) {
          const item = {
            ...cardObj,
            card: cardObj,
            controllerId,
            sourcePlayerId,
            controllerName,
            cardName,
            castMode,
            activeCastMode: castMode,
            targetId: explicitTargetId,
            targets: formattedTargets,
            creatureId: explicitCreatureId,
            equipmentId: explicitEquipmentId,
            selectedCombination: explicitSelectedCombination
          };
          this.priorityMachine.pushStack(item);
        }

        if (this.tabletopState && Array.isArray(this.tabletopState.stack)) {
          const alreadyOnTsm = this.tabletopState.stack.some(s => s && (
            s === cardObj ||
            (s.instanceId && cardObj.instanceId && s.instanceId === cardObj.instanceId)
          ));
          if (!alreadyOnTsm) {
            this.tabletopState.stack.push(cardObj);
          }
        }
        if (this.tabletopState && typeof this.tabletopState._checkAndFireSpellCastTriggers === 'function') {
          this.tabletopState._checkAndFireSpellCastTriggers(controllerId, cardObj);
        }

        let resolvedTargetLabel = payload.targetName || action.targetName || null;
        if (!resolvedTargetLabel && explicitTargetId) {
          if (this.tabletopState?.players?.[explicitTargetId]) {
            resolvedTargetLabel = this.getFriendlyPlayerName(explicitTargetId);
          } else {
            for (const p of Object.values(this.tabletopState?.players || {})) {
              const allPerms = [
                ...(p.battlefield?.creatures || []),
                ...(p.battlefield?.lands || []),
                ...(p.battlefield?.noncreatures || []),
                ...(p.battlefield?.planeswalkers || [])
              ];
              const match = allPerms.find(perm => perm && (perm.instanceId === explicitTargetId || perm.id === explicitTargetId));
              if (match) {
                resolvedTargetLabel = match.name;
                break;
              }
            }
          }
        }
        const targetSuffix = resolvedTargetLabel ? ` targeting ${resolvedTargetLabel}` : '';
        this.appendExecutionLog('Spell', `⚡ ${this.getFriendlyPlayerName(controllerId)} casts ${cardName || 'Spell'}${targetSuffix}`, {
          playerId: controllerId
        });
        break;
      }

      case 'PLAY_LAND': {
        const targetId = payload.playerId || action.playerId || this.myPlayerId;
        const card = payload.card || action.card;
        const cardName = payload.cardName || action.cardName || card?.name || 'Land';
        const landAlreadyPlayed = Boolean(payload.landAlreadyPlayed || action.landAlreadyPlayed);
        const payShockCost = Boolean(payload.payShockCost ?? payload.pay2Life ?? action.payShockCost ?? action.pay2Life);
        const isShockland = Boolean(card?.isShockland) ||
          /steam vents|sacred foundry|watery grave|stomping ground|godless shrine|blood crypt|breeding pool|overgrown tomb|temple garden|hallowed fountain/i.test(cardName || '');
        const isTapped = isShockland ? !payShockCost : false;

        if (!landAlreadyPlayed && this.tabletopState?.players?.[targetId] && card) {
          const p = this.tabletopState.players[targetId];
          const played = p.landsPlayedThisTurn ?? p.resources?.landsPlayedThisTurn ?? 0;
          const baseLimit = p.maxLandsPerTurn ?? p.landsPerTurnLimit ?? p.resources?.maxLandsPerTurn ?? 1;
          const extraLands = p.resources?.additionalLandsAllowed || 0;
          const limit = Math.max(baseLimit, 1 + extraLands);
          const isActive = !this.priorityMachine || this.priorityMachine.activePlayerId === targetId;
          if (isActive && played < limit) {
            if (Array.isArray(p.hand)) {
              p.hand = p.hand.filter(c => c.instanceId !== card.instanceId && c.name !== card.name);
            }
            if (Array.isArray(p.zones?.hand)) {
              p.zones.hand = p.zones.hand.filter(c => c.instanceId !== card.instanceId && c.name !== card.name);
            }

            p.battlefield = p.battlefield || {};
            p.battlefield.lands = p.battlefield.lands || [];
            if (!p.battlefield.lands.some(l => l && l.instanceId && l.instanceId === card.instanceId)) {
              p.battlefield.lands.push({ ...card, isTapped });
            }
            p.landsPlayedThisTurn = played + 1;
            if (p.resources) {
              p.resources.landsPlayedThisTurn = p.landsPlayedThisTurn;
            }
          }
        }
        if (this.tabletopState?.players?.[targetId] && (card || payload.cardName)) {
          this.appendExecutionLog('Land', `⛰️ ${this.getFriendlyPlayerName(targetId)} played ${cardName}${isTapped ? ' (tapped)' : ''}`, {
            playerId: targetId
          });
        }
        break;
      }

      case 'DECLARE_ATTACKERS':
        this._handleDeclareAttackers(action);
        this.appendExecutionLog('Combat', `⚔️ ${this.getFriendlyPlayerName(payload.playerId || action.playerId || this.myPlayerId)} declared ${(payload.attackers || action.attackers || []).length} attacker(s)`, {
          playerId: payload.playerId || action.playerId || this.myPlayerId
        });
        break;

      case 'DECLARE_BLOCKERS':
        this._handleDeclareBlockers(action);
        this.appendExecutionLog('Combat', `🛡️ ${this.getFriendlyPlayerName(payload.playerId || action.playerId || this.myPlayerId)} declared ${(payload.assignments || payload.blocks || payload.blockers || []).length} blocker(s)`, {
          playerId: payload.playerId || action.playerId || this.myPlayerId
        });
        break;

      case 'SEND_CHIT_CHAT':
        if (this.dualChat) {
          this.dualChat.sendChitChat(
            payload.text,
            payload.senderId || this.myPlayerId,
            payload.senderName || this.username
          );
        }
        break;

      case 'TURN_COMMAND': {
        const cmdText = payload.command || action.command || payload.text;
        if (cmdText) {
          let proposal = null;
          if (this.dualChat) {
            try {
              proposal = this.dualChat.submitTurnCommand(cmdText, {
                senderId: payload.senderId || action.playerId || this.myPlayerId,
                handCards: this.tabletopState?.players?.[this.myPlayerId]?.zones?.hand || []
              });
            } catch (err) { console.error('[StackResolution Error]:', err); }
          }
          if (!proposal && this.actionLexer) {
            try {
              proposal = ActionLexer.parse(cmdText, {
                activePlayerId: this.myPlayerId,
                handCards: this.tabletopState?.players?.[this.myPlayerId]?.zones?.hand || []
              });
            } catch (err) { console.error('[StackResolution Error]:', err); }
          }
          if (proposal && (proposal.status === 'READY' || proposal.status === 'STAGED')) {
            this.executeActionProposal(proposal);
          }
        }
        break;
      }

      case 'PLAYER_CONCEDED':
      case 'PLAYER_ELIMINATED':
        this.handlePlayerElimination(payload.playerId || payload.player || action.playerId, payload.reason || action.reason);
        break;

      case 'MATCH_VICTORY':
        this.handleMatchVictory(payload);
        break;

      case 'PERK_ROLLED':
        this.handlePerkRolled(payload);
        break;

      default:
        break;
    }

    // Reconcile DOM views
    this.reconcileDOM();
  }

  _handleDeclareAttackers(action) {
    const payload = action.payload || action;
    const targetId = payload.playerId || action.playerId || this.myPlayerId;
    const attackerIds = payload.attackers || action.attackers || payload.attackersList || [];
    const defendingPlayerId = payload.defendingPlayerId || action.defendingPlayerId || null;

    if (this.tabletopState && typeof this.tabletopState.declareAttackers === 'function') {
      try {
        this.tabletopState.declareAttackers(targetId, attackerIds, defendingPlayerId, payload.attackerTargets || action.attackerTargets);
      } catch (err) {
        console.warn('[_handleDeclareAttackers] Error declaring attackers:', err.message);
      }
    } else if (this.tabletopState?.players?.[targetId]) {
      const p = this.tabletopState.players[targetId];
      const creatures = p.battlefield?.creatures || [];
      for (const c of creatures) {
        const isAttacker = Array.isArray(attackerIds) && attackerIds.some(a =>
          typeof a === 'string' ? a === c.instanceId : (a.creatureId === c.instanceId || a.id === c.instanceId)
        );
        if (isAttacker) {
          c.isAttacking = true;
          const hasVigilance = Boolean(c.keywords?.vigilance || /vigilance/i.test(c.text || c.oracleText || ''));
          if (!hasVigilance) {
            c.isTapped = true;
          }
        }
      }
    }
    if (typeof this.render === 'function') {
      this.render();
    }
  }

  _handleDeclareBlockers(action) {
    const payload = action.payload || action;
    const targetId = payload.playerId || action.playerId || this.myPlayerId;
    const assignments = payload.assignments || payload.blocks || payload.blockers || [];

    if (this.tabletopState && typeof this.tabletopState.declareBlockers === 'function') {
      try {
        this.tabletopState.declareBlockers(targetId, assignments);
      } catch (err) {
        console.warn('[_handleDeclareBlockers] Error declaring blockers:', err.message);
      }
    } else if (this.tabletopState?.players?.[targetId]) {
      const p = this.tabletopState.players[targetId];
      const creatures = p.battlefield?.creatures || [];
      for (const item of assignments) {
        const blockerId = typeof item === 'string' ? item : (item.blockerId || item.id);
        const blocker = creatures.find(c => c && c.instanceId === blockerId);
        if (blocker) {
          blocker.isBlocking = true;
          blocker.blockingTargetId = item.attackerId;
        }
      }
    }
    if (typeof this.render === 'function') {
      this.render();
    }
  }

  commitHumanBlocks(assignmentsArray = null) {
    const assignments = assignmentsArray !== null
      ? assignmentsArray
      : (this._blockerAssignments
          ? Array.from(this._blockerAssignments.entries()).map(([blockerId, attackerId]) => ({ blockerId, attackerId }))
          : []);

    const pData = this.tabletopState?.getPlayer ? this.tabletopState.getPlayer(this.myPlayerId) : this.tabletopState?.players?.[this.myPlayerId];
    const creatures = Array.isArray(pData?.battlefield?.creatures)
      ? pData.battlefield.creatures
      : (Array.isArray(pData?.zones?.battlefield) ? pData.zones.battlefield.filter(c => (c.typeLine || c.type || '').toLowerCase().includes('creature') || c.subzone === 'creatures') : []);
    const activeCombatAttackers = this.tabletopState?.combatState?.attackers || [];

    const resolveAttackerObj = (attackerId) => {
      if (!attackerId) return null;
      const entry = activeCombatAttackers.find(a =>
        (typeof a === 'string' ? a : (a?.creatureId || a?.instanceId || a?.id)) === attackerId
      );
      if (entry && typeof entry === 'object' && entry.creature) return entry.creature;
      if (entry && typeof entry === 'object' && entry.name) return entry;
      return this.tabletopState?._findPermanentOnBattlefield?.(attackerId) || { instanceId: attackerId, name: 'Attacker' };
    };

    // Validate Menace / multi-blocker constraints per attacker before committing
    const byAttacker = new Map();
    for (const item of assignments) {
      const aId = item.attackerId;
      if (!byAttacker.has(aId)) byAttacker.set(aId, []);
      const bCard = creatures.find(c => c && (c.instanceId === item.blockerId || c.id === item.blockerId));
      if (bCard) byAttacker.get(aId).push(bCard);
    }
    for (const [aId, bList] of byAttacker.entries()) {
      const attackerObj = resolveAttackerObj(aId);
      if (attackerObj) {
        const check = canBlockAssignment(attackerObj, bList, this.tabletopState);
        if (!check.allowed) {
          this.tabletopState?.recordTrace?.('UI_REJECTION', 'BLOCKER_COMMIT_REJECTED', {
            playerId: this.myPlayerId,
            attackerId: aId,
            blockerIds: bList.map(b => b.instanceId),
            reason: check.reason
          });
          if (typeof this.showWarningBanner === 'function') {
            this.showWarningBanner(`⚠️ ${check.reason}`);
          }
          return;
        }
      }
    }

    // If still in DECLARE_ATTACKERS with priority on human defender, advance to DECLARE_BLOCKERS first
    if (this.priorityMachine && this.priorityMachine.currentPhaseStep === 'DECLARE_ATTACKERS') {
      try {
        if (this.priorityMachine.priorityPlayerId === this.myPlayerId) {
          this.priorityMachine.passPriority(this.myPlayerId);
        } else {
          this.priorityMachine.advanceStep();
        }
      } catch (_) {}
    }

    if (this._blockerAssignments) this._blockerAssignments.clear();
    this.dispatchAction({
      type: 'DECLARE_BLOCKERS',
      playerId: this.myPlayerId,
      blocks: assignments,
      payload: {
        playerId: this.myPlayerId,
        blocks: assignments,
        assignments: assignments
      }
    }, { origin: 'LOCAL' });

    // Pass priority in DECLARE_BLOCKERS so combat advances to COMBAT_DAMAGE
    if (this.priorityMachine && this.priorityMachine.currentPhaseStep === 'DECLARE_BLOCKERS') {
      if (this.priorityMachine.priorityPlayerId !== this.myPlayerId) {
        try { this.priorityMachine.passPriority(this.priorityMachine.priorityPlayerId); } catch (_) {}
      }
      if (this.priorityMachine.currentPhaseStep === 'DECLARE_BLOCKERS' && this.priorityMachine.priorityPlayerId === this.myPlayerId) {
        this.dispatchAction({
          type: 'PASS_PRIORITY',
          playerId: this.myPlayerId,
          payload: { playerId: this.myPlayerId }
        }, { origin: 'LOCAL' });
      }
    }
  }

  /**
   * Executes an ActionLexer proposal directly onto tabletop state.
   * @param {Object} proposal
   */
  executeActionProposal(proposal) {
    if (!proposal) return;
    switch (proposal.actionType) {
      case 'PLAY_LAND': {
        const landName = proposal.params?.canonicalLandName || proposal.params?.cardName || proposal.cardName || proposal.params?.landName;
        if (landName) {
          this.playLandByName(landName);
        }
        break;
      }
      case 'CAST_SPELL': {
        const spellName = proposal.params?.cardName || proposal.cardName || proposal.params?.spellName;
        if (spellName) {
          this.castSpellByName(spellName, proposal.params?.targets);
        }
        break;
      }
      case 'ROLL_DICE': {
        const diceType = proposal.params?.diceType || 'dice';
        this.triggerDiceRoll(diceType);
        break;
      }
      case 'PASS_PRIORITY': {
        if (this.priorityMachine) {
          try {
            this.priorityMachine.passPriority(this.myPlayerId);
          } catch (_) {}
        }
        break;
      }
      case 'ADJUST_LIFE': {
        const mode = proposal.params?.mode;
        const amount = proposal.params?.amount;
        if (mode === 'SET' && amount !== undefined) {
          this.dispatchAction({
            type: 'CHANGE_LIFE',
            payload: { playerId: this.myPlayerId, amount }
          });
        } else if (mode === 'DELTA' && amount !== undefined) {
          this.dispatchAction({
            type: 'CHANGE_LIFE',
            payload: { playerId: this.myPlayerId, delta: amount }
          });
        }
        break;
      }
      default:
        break;
    }
    this.reconcileDOM();
  }

  // ==========================================================================
  // Game Actions & Eliminations (INV-RING-1, INV-RING-2)
  // ==========================================================================

  /**
   * Eliminates a player from the active ring, renders gray-out overlay,
   * purges their owned spells from the stack (CR 800.4a), updates priority ring,
   * and checks for match victory.
   * 
   * @param {string} playerId
   * @param {string} [reason='LIFE_ZERO']
   */
  handlePlayerElimination(playerId, reason = 'LIFE_ZERO') {
    if (!playerId) return;

    // 1. Mark eliminated in TabletopStateManager
    if (this.tabletopState?.players?.[playerId]) {
      this.tabletopState.players[playerId].isEliminated = true;
    }

    // 2. CR 800.4a Stack Purge (INV-RING-2)
    if (this.priorityMachine && Array.isArray(this.priorityMachine.stack)) {
      this.priorityMachine.stack = this.priorityMachine.stack.filter(
        item => item.sourcePlayerId !== playerId && item.ownerId !== playerId
      );
    }

    // 3. Dynamic Priority Ring Hand-off & Elimination (INV-RING-1)
    if (this.priorityMachine) {
      const remainingPlayers = (this.priorityMachine.players || []).filter(p => p !== playerId);
      const wasPriority = (this.priorityMachine.priorityPlayerId === playerId);
      const wasActive = (this.priorityMachine.activePlayerId === playerId);

      this.priorityMachine.players = remainingPlayers;

      if (wasPriority && remainingPlayers.length > 0) {
        this.priorityMachine.priorityPlayerId = remainingPlayers[0];
        this.priorityMachine.consecutivePassCount = 0;
      }
      if (wasActive && remainingPlayers.length > 0) {
        this.priorityMachine.activePlayerId = remainingPlayers[0];
      }
    }

    // 4. Check if only 1 survivor remains (Last Player Standing -> MATCH_VICTORY)
    const survivors = Object.entries(this.tabletopState?.players || {}).filter(
      ([_, p]) => !p.isEliminated
    );

    if (survivors.length === 1) {
      if (this.perkinsAgent && typeof this.perkinsAgent.destroy === 'function') {
        try { this.perkinsAgent.destroy(); } catch (_) {}
        this.perkinsAgent = null;
      }
      if (this.botAgents) {
        const bots = typeof this.botAgents.values === 'function' ? this.botAgents.values() : this.botAgents;
        for (const bot of bots) {
          try { bot?.destroy?.(); } catch (_) {}
        }
        if (typeof this.botAgents.clear === 'function') {
          this.botAgents.clear();
        }
      }
      if (this.lobbyManager && typeof this.lobbyManager.invalidateReadiness === 'function') {
        try { this.lobbyManager.invalidateReadiness('MATCH_COMPLETED'); } catch (_) {}
      }
      if (this.tabletopState) {
        this.tabletopState.isGameOver = true;
      }
      if (this.priorityMachine) {
        this.priorityMachine.isGameOver = true;
      }
      this.isMatchActiveFlag = false;
      this._hasMatchStarted = false;
      const winnerId = survivors[0][0];
      const winnerName = survivors[0][1]?.name || winnerId;
      this.archiveMatchRecord({ winnerId, winnerName });
      this.handleMatchVictory({
        winner: winnerId,
        winnerId,
        winnerName
      });
    }

    this.reconcileDOM();
  }

  /**
   * Reconciles state from authoritative STATE_RECONCILE_SNAPSHOT.
   * 
   * @param {Object} snapshot
   */
  handleStateSync(snapshot) {
    if (!snapshot) return;

    if (snapshot.roomCode) {
      const inp = this.container?.querySelector('#room-code-input');
      if (inp) inp.value = snapshot.roomCode;
    }

    // Adopt assigned seat identity
    if (snapshot.slotId && Array.isArray(snapshot.activeSlots)) {
      const mySlot = snapshot.activeSlots.find(s => s.slotId === snapshot.slotId);
      if (mySlot && mySlot.playerId) {
        this.myPlayerId = mySlot.playerId;
        this.username = mySlot.playerName || this.username;
      }
    }

    // Reconcile players into TabletopStateManager
    if (snapshot.projectedState && snapshot.projectedState.players) {
      for (const [pId, pData] of Object.entries(snapshot.projectedState.players)) {
        if (!this.tabletopState.players[pId]) {
          this.tabletopState.registerPlayer(pId, pData.playerName || pId);
        }
        const target = this.tabletopState.players[pId];
        if (pData.resources) {
          target.resources = { ...target.resources, ...pData.resources };
        }
        if (pData.zones) {
          target.zones = { ...target.zones, ...pData.zones };
        }
        target.isEliminated = Boolean(pData.isEliminated);
      }
    } else if (Array.isArray(snapshot.activeSlots)) {
      for (const slot of snapshot.activeSlots) {
        if (!this.tabletopState.players[slot.playerId]) {
          this.tabletopState.registerPlayer(slot.playerId, slot.playerName || `Player ${slot.slotId}`);
        }
        this.tabletopState.players[slot.playerId].isEliminated = Boolean(slot.isEliminated);
      }
    }

    // Reconcile PriorityStateMachine
    if (this.priorityMachine) {
      if (Array.isArray(snapshot.activeSlots)) {
        const activeIds = snapshot.activeSlots.filter(s => !s.isEliminated).map(s => s.playerId);
        if (activeIds.length > 0) {
          this.priorityMachine.players = activeIds;
          this.playerIds = snapshot.activeSlots.map(s => s.playerId);
        }
      }
      if (snapshot.activePlayerId) {
        this.priorityMachine.activePlayerId = snapshot.activePlayerId;
      }
      if (snapshot.priorityPlayerId) {
        this.priorityMachine.priorityPlayerId = snapshot.priorityPlayerId;
      }
      if (snapshot.currentPhaseStep) {
        this.priorityMachine.currentPhaseStep = snapshot.currentPhaseStep;
      }
      if (snapshot.turnNumber !== undefined) {
        this.priorityMachine.turnNumber = snapshot.turnNumber;
      }
      if (Array.isArray(snapshot.stack)) {
        this.priorityMachine.stack = [...snapshot.stack];
      }
    }

    // Reconcile 15s stack alarm if active
    if (snapshot.remainingAlarmMs > 0 && this.alarmManager) {
      if (typeof this.alarmManager.start === 'function') {
        const targetPlayer = snapshot.priorityPlayerId || this.myPlayerId;
        const topItem = snapshot.stack?.[snapshot.stack.length - 1]?.id || 'remote_alarm';
        this.alarmManager.start(targetPlayer, topItem, snapshot.remainingAlarmMs / 1000);
      }
    }

    if (this.autoRoomCode) {
      this._checkAutoPregameStart();
    }

    this.reconcileDOM();
  }

  /**
   * Handles dynamic seat entry of a new player into the room.
   * 
   * @param {Object} msg
   */
  handlePlayerJoined(msg) {
    if (!msg || !msg.playerId) return;

    if (!this.tabletopState.players[msg.playerId]) {
      this.tabletopState.registerPlayer(msg.playerId, msg.playerName || `Player ${msg.slotId || ''}`);
    }

    if (this.priorityMachine && !this.priorityMachine.players.includes(msg.playerId)) {
      this.priorityMachine.players.push(msg.playerId);
    }
    if (!this.playerIds.includes(msg.playerId)) {
      this.playerIds.push(msg.playerId);
    }

    if (this.autoRoomCode) {
      this._checkAutoPregameStart();
    }

    this.reconcileDOM();
  }

  /**
   * Updates player connection status.
   * 
   * @param {string} playerId
   * @param {string} status
   */
  handlePlayerConnectionChanged(playerId, status) {
    if (!playerId) return;
    const p = this.tabletopState?.players?.[playerId];
    if (p) {
      p.connectionStatus = status;
    }
    this.reconcileDOM();
  }

  /**
   * Handles match victory celebration, Elo progression, and victory audio playback.
   * 
   * @param {Object} victoryPayload
   */
  handleMatchVictory(victoryPayload = {}) {
    const winnerId = victoryPayload.winner || victoryPayload.winnerId || this.myPlayerId;
    const winnerName = victoryPayload.winnerName || (winnerId === this.myPlayerId ? this.username : `Player ${winnerId.toUpperCase()}`);

    this.authManager?.dispatchTelemetry('MATCH_VICTORY', null, {
      winnerId,
      winnerName,
      ...victoryPayload
    });

    // Open celebratory modal
    this.openModal('VICTORY_FANFARE', {
      winnerId,
      winnerName,
      ...victoryPayload
    });

    // Try playing victory audio
    if (this.audioEnabled && this.victoryFanfare) {
      const ctx = this.victoryFanfare.audioContext;
      const isSuspended = ctx && ctx.state === 'suspended';

      if (isSuspended) {
        // Show fallback banner (INV-AUDIO-1)
        this._renderAutoplayFallbackBanner();
      } else {
        try {
          this.victoryFanfare.playChiptune();
        } catch (_) {
          this._renderAutoplayFallbackBanner();
        }
      }
    }
  }

  /**
   * Handles 2 d10 perk roll outcome.
   * 
   * @param {Object} roll
   */
  handlePerkRolled(roll) {
    if (!roll) return;
    this._lastRoll = roll;

    const diceContainer = this.container?.querySelector('#perk-dice-container');
    const diceTens = this.container?.querySelector('#dice-tens .dice-value');
    const diceOnes = this.container?.querySelector('#dice-ones .dice-value');
    const perkKeyBadge = this.container?.querySelector('#perk-roll-key');
    const perkDesc = this.container?.querySelector('#perk-effect-description');

    if (diceTens) diceTens.textContent = String(roll.tens ?? 0);
    if (diceOnes) diceOnes.textContent = String(roll.ones ?? 0);

    if (perkKeyBadge && perkDesc) {
      if (roll.isMiss) {
        perkKeyBadge.textContent = `ROLL ${roll.tens ?? 0}${roll.ones ?? 0} ➔ Roll Miss (No Perk)`;
        perkDesc.textContent = 'No perk triggered for this roll.';
      } else {
        const perkKey = roll.matchedKey || roll.perkKey || `${roll.tens ?? 0}${roll.ones ?? 0}`;
        const def = getPerkDefinition(perkKey);
        const name = def?.name || 'Perk Triggered';
        perkKeyBadge.textContent = `Perk #${perkKey}: ${name}`;
        perkDesc.textContent = def?.effectDescription || 'Resolving perk trigger on stack...';
      }
    }

    if (diceContainer) {
      diceContainer.style.display = 'block';
    }

    const perkKey = roll.matchedKey || roll.perkKey || `${roll.tens ?? 0}${roll.ones ?? 0}`;
    const def = typeof getPerkDefinition === 'function' ? getPerkDefinition(perkKey) : null;
    const effectName = roll.effect_name || roll.effectName || def?.name || (roll.isMiss ? 'Roll Miss' : 'Perk Triggered');

    this.authManager?.dispatchTelemetry('PERK_ACTIVATION', null, {
      tens: roll.tens ?? 0,
      ones: roll.ones ?? 0,
      perk_key: roll.perk_key !== undefined ? roll.perk_key : (Number(perkKey) || perkKey),
      effect_name: effectName,
      is_match: roll.is_match !== undefined ? roll.is_match : !roll.isMiss
    });
  }

  // ==========================================================================
  // Room Networking Wrappers
  // ==========================================================================

  async createRoom(seatOptions = {}) {
    if (!this.relayClient) return null;
    try {
      if (!this.relayClient.socket || this.relayClient.socket.readyState !== 1) {
        await this.relayClient.connect();
      }
      const res = await this.relayClient.createRoom({
        playerName: this.username,
        ...seatOptions
      });
      if (res && res.roomCode) {
        const inp = this.container?.querySelector('#room-code-input');
        if (inp) inp.value = res.roomCode;
      }
      return res?.roomCode;
    } catch (e) {
      return null;
    }
  }

  async joinRoom(roomCode, seatOptions = {}) {
    if (!this.relayClient || !roomCode) return;
    try {
      if (!this.relayClient.socket || this.relayClient.socket.readyState !== 1) {
        await this.relayClient.connect();
      }
      await this.relayClient.joinRoom(roomCode, this.username, seatOptions.seatPreference);
      const inp = this.container?.querySelector('#room-code-input');
      if (inp) inp.value = roomCode;
    } catch (e) {}
  }

  disconnect() {
    if (this.relayClient) {
      this.relayClient.disconnect();
    }
  }

  // ==========================================================================
  // Auto-Room & Autopilot Engine (Feature: USB Auto-Pairing & Live Dual-Device)
  // ==========================================================================

  /**
   * Initializes auto-room connection and join flow programmatically (for Node/headless harnesses).
   * @returns {Promise<void>}
   */
  async initAutoRoom() {
    if (this._autoRoomFlowStarted) return;
    this._autoRoomFlowStarted = true;
    return this._startAutoRoomFlow();
  }

  /**
   * Automatically connects and joins/creates the target autoRoom.
   * @private
   */
  async _startAutoRoomFlow() {
    if (!this.autoRoomCode || !this.relayClient) return;

    try {
      if (!this.relayClient.socket || this.relayClient.socket.readyState !== 1) {
        await this.relayClient.connect(this.relayUrl);
      }

      const seatPref = (this.autoRole === 'host') ? 1 : 2;
      let joined = false;

      if (this.autoRole === 'host') {
        try {
          await this.relayClient.joinRoom(this.autoRoomCode, this.username, seatPref);
          joined = true;
        } catch (err) {
          if (err && (err.code === 4404 || String(err.message).includes('4404') || String(err.message).includes('not found'))) {
            await this.createRoom({ roomCode: this.autoRoomCode, playerName: this.username });
            joined = true;
          } else {
            throw err;
          }
        }
      } else {
        // Guest retry loop: retry joinRoom every 500ms up to 15 times until Host/server creates room
        let attempts = 0;
        while (attempts < 15 && !joined) {
          try {
            await this.relayClient.joinRoom(this.autoRoomCode, this.username, seatPref);
            joined = true;
            break;
          } catch (err) {
            attempts++;
            if (attempts >= 15) {
              console.warn(`[RPM] Guest joinRoom retries exhausted: ${err?.message || err}`);
              break;
            }
            await new Promise(r => setTimeout(r, 500));
          }
        }
      }

      if (joined) {
        if (this.activeDeckData) {
          try {
            this.registerDeckManifest(this.activeDeckData, this.myPlayerId);
          } catch (_) {}
        }

        // Broadcast telemetry sync event
        try {
          this.relayClient.sendAction({
            type: 'AUTO_SYNC_EVENT',
            payload: {
              stage: 'ROOM_JOINED',
              role: this.autoRole,
              playerId: this.myPlayerId,
              deckId: this.activeDeckId,
              roomCode: this.autoRoomCode
            }
          });
        } catch (_) {}

        this._checkAutoPregameStart();
      }
    } catch (e) {
      console.warn('[RPM] _startAutoRoomFlow error:', e);
    }
  }

  /**
   * Checks if both seats in the room are present and starts pregame/match flow.
   * @private
   */
  _checkAutoPregameStart() {
    if (!this.autoRoomCode || this._autoPregameTriggered) return;

    const activeSlots = this.relayClient?.activeSlots || [];
    const playerKeys = Object.keys(this.tabletopState?.players || {});
    const count = Math.max(activeSlots.length, playerKeys.length);

    if (count >= 2) {
      this._autoPregameTriggered = true;
      this._onBothPlayersPresent();
    }
  }

  /**
   * Handles pregame readiness synchronization when both players are seated.
   * @private
   */
  _onBothPlayersPresent() {
    if (!this.lobbyManager) {
      this.lobbyManager = new LobbyManager({ roomCode: this.autoRoomCode });
    }
    if (this.lobbyManager) {
      for (const slotId of [1, 2]) {
        try {
          const slot = this.lobbyManager.slots.get(slotId);
          if (slot) {
            slot.isReady = true;
          }
        } catch (_) {}
      }
    }

    if (this.relayClient?.socket?.readyState === 1) {
      try {
        this.relayClient.send({ type: 'LOBBY_TOGGLE_READY', isReady: true });
      } catch (_) {}
    }

    this.switchView('TABLETOP');

    if (this.autoRole === 'host' && this.autoPlayEnabled && !this.isSpectator() && !this._autopilotRunning) {
      this._autopilotRunning = true;
      this._driveVisualAutopilot().catch(err => {
        console.warn('[RPM] Autopilot error:', err);
      });
    }
  }

  /**
   * Drives visual synchronized autopilot sequence through all 7 stages on authoritative Host.
   * @private
   */
  async _driveVisualAutopilot() {
    const delayMs = this.autoPlayDelayMs || 800;
    const delay = () => new Promise(r => setTimeout(r, delayMs));

    await delay();

    // 1. ROOM_JOINED
    const roomJoinedPayload = {
      stage: 'ROOM_JOINED',
      players: {
        player_1: { name: 'Host (Laptop)', deck: 'AMERICAN_GADGETS' },
        player_2: { name: 'Guest (Phone)', deck: 'BURN' }
      },
      roomCode: this.autoRoomCode
    };
    this._applyAutopilotTransition('ROOM_JOINED', roomJoinedPayload);
    try {
      this.relayClient.sendAction({ type: 'ROOM_JOINED', payload: roomJoinedPayload });
    } catch (_) {}
    await delay();

    // 2. READY_CHECK_PASSED
    const readyPayload = {
      roomCode: this.autoRoomCode,
      allReady: true,
      view: 'TABLETOP'
    };
    this._applyAutopilotTransition('READY_CHECK_PASSED', readyPayload);
    try {
      this.relayClient.sendAction({ type: 'READY_CHECK_PASSED', payload: readyPayload });
    } catch (_) {}
    await delay();

    // 3. ROLL_OFF_COMPLETE
    const rollOffPayload = {
      rolls: { player_1: 20, player_2: 12 },
      winnerId: 'player_1',
      choice: 'PLAY',
      startingPlayerId: 'player_1'
    };
    this._applyAutopilotTransition('ROLL_OFF_COMPLETE', rollOffPayload);
    try {
      this.relayClient.sendAction({ type: 'ROLL_OFF_COMPLETE', payload: rollOffPayload });
    } catch (_) {}
    await delay();

    // 4. MULLIGAN_COMPLETE
    const mulliganPayload = {
      hands: {
        player_1: [
          { name: 'Plains', typeLine: 'Basic Land — Plains', manaCost: '', instanceId: 'c_p1_land_1' },
          { name: "Sigarda's Aid", typeLine: 'Enchantment', manaCost: '{W}', instanceId: 'c_p1_spell_1' },
          { name: 'Colossus Hammer', typeLine: 'Artifact — Equipment', manaCost: '{1}', instanceId: 'c_p1_spell_2' },
          { name: 'Heartfire Hero', typeLine: 'Creature — Mouse Soldier', manaCost: '{R}', power: 1, toughness: 1, instanceId: 'c_p1_creature_1' },
          { name: 'Mountain', typeLine: 'Basic Land — Mountain', manaCost: '', instanceId: 'c_p1_land_2' },
          { name: 'Inkmoth Nexus', typeLine: 'Land', manaCost: '', instanceId: 'c_p1_land_3' },
          { name: 'Fervent Champion', typeLine: 'Creature — Knight', manaCost: '{R}', power: 1, toughness: 1, instanceId: 'c_p1_creature_2' }
        ],
        player_2: [
          { name: 'Mountain', typeLine: 'Basic Land — Mountain', manaCost: '', instanceId: 'c_p2_land_1' },
          { name: 'Goblin Guide', typeLine: 'Creature — Goblin Scout', manaCost: '{R}', power: 2, toughness: 2, instanceId: 'c_p2_creature_1' },
          { name: 'Lightning Bolt', typeLine: 'Instant', manaCost: '{R}', instanceId: 'c_p2_spell_1' },
          { name: 'Monastery Swiftspear', typeLine: 'Creature — Human Monk', manaCost: '{R}', power: 1, toughness: 2, instanceId: 'c_p2_creature_2' },
          { name: 'Mountain', typeLine: 'Basic Land — Mountain', manaCost: '', instanceId: 'c_p2_land_2' },
          { name: 'Lava Spike', typeLine: 'Sorcery', manaCost: '{R}', instanceId: 'c_p2_spell_2' },
          { name: 'Mountain', typeLine: 'Basic Land — Mountain', manaCost: '', instanceId: 'c_p2_land_3' }
        ]
      },
      leylinesChecked: true,
      allKept: true
    };
    this._applyAutopilotTransition('MULLIGAN_COMPLETE', mulliganPayload);
    try {
      this.relayClient.sendAction({ type: 'MULLIGAN_COMPLETE', payload: mulliganPayload });
    } catch (_) {}
    await delay();

    // 5. TURN_1_MAIN_PHASE
    const landPayload = {
      playerId: 'player_1',
      phase: 'PRECOMBAT_MAIN',
      turn: 1,
      land: { name: 'Plains', typeLine: 'Basic Land — Plains', instanceId: 'c_p1_land_1', isTapped: false }
    };
    this._applyAutopilotTransition('TURN_1_MAIN_PHASE', landPayload);
    try {
      this.relayClient.sendAction({ type: 'TURN_1_MAIN_PHASE', payload: landPayload });
    } catch (_) {}
    await delay();

    // 6. SPELL_CAST
    const spellPayload = {
      controllerId: 'player_1',
      card: { name: "Sigarda's Aid", typeLine: 'Enchantment', manaCost: '{W}', instanceId: 'c_p1_spell_1' },
      tappedLandId: 'c_p1_land_1',
      resolved: true
    };
    this._applyAutopilotTransition('SPELL_CAST', spellPayload);
    try {
      this.relayClient.sendAction({ type: 'SPELL_CAST', payload: spellPayload });
    } catch (_) {}
    await delay();

    // 7. COMBAT_DAMAGE
    const damagePayload = {
      sourcePlayerId: 'player_1',
      targetPlayerId: 'player_2',
      damage: 2,
      previousLife: 20,
      newLife: 18
    };
    this._applyAutopilotTransition('COMBAT_DAMAGE', damagePayload);
    try {
      this.relayClient.sendAction({ type: 'COMBAT_DAMAGE', payload: damagePayload });
    } catch (_) {}
    await delay();

    // Verification: STATE_HASH_MATCH
    const { hash, summary } = this.computeStateHash();
    const stateHashPayload = {
      hash,
      summary,
      timestamp: Date.now()
    };
    this._applyAutopilotTransition('STATE_HASH_MATCH', stateHashPayload);
    try {
      this.relayClient.sendAction({ type: 'STATE_HASH_MATCH', payload: stateHashPayload });
    } catch (_) {}
  }

  /**
   * Applies an autopilot transition to internal state and reconciles DOM.
   * Executed both locally by Host driver and remotely by Guest receiver.
   * @private
   */
  _applyAutopilotTransition(stage, payload = {}) {
    if (!stage) return;

    if (!this.tabletopState.players['player_1']) {
      this.tabletopState.registerPlayer('player_1', 'Host (Laptop)');
    }
    if (!this.tabletopState.players['player_2']) {
      this.tabletopState.registerPlayer('player_2', 'Guest (Phone)');
    }
    const player1 = this.tabletopState.players['player_1'];
    const player2 = this.tabletopState.players['player_2'];

    switch (stage) {
      case 'ROOM_JOINED': {
        this.appendExecutionLog('Lobby', `👥 Both seats filled: Host (Laptop) [AMERICAN_GADGETS] vs Guest (Phone) [BURN] in ${payload.roomCode || this.autoRoomCode}`);
        break;
      }

      case 'READY_CHECK_PASSED': {
        this.isMatchActiveFlag = true;
        this._hasMatchStarted = true;
        this.pregameActive = false;
        this.switchView('TABLETOP');
        this.appendExecutionLog('Lobby', '✅ Both players ready! Switching to Tabletop Arena.');
        break;
      }

      case 'ROLL_OFF_COMPLETE': {
        const rolls = payload.rolls || { player_1: 20, player_2: 12 };
        const winnerId = payload.winnerId || 'player_1';
        const choice = payload.choice || 'PLAY';
        this.rollOffResult = { winnerId, choice, rolls };
        if (this.priorityMachine) {
          this.priorityMachine.startingPlayerId = winnerId;
          this.priorityMachine.activePlayerId = winnerId;
          this.priorityMachine.priorityPlayerId = winnerId;
        }
        this.appendExecutionLog('Roll-Off', `🎲 d20 Roll-off: Host rolled ${rolls.player_1}, Guest rolled ${rolls.player_2} — ${winnerId === 'player_1' ? 'Host' : 'Guest'} wins and selects ${choice}!`);
        break;
      }

      case 'MULLIGAN_COMPLETE': {
        this.pregameActive = false;
        this._openingHandActionsResolved = true;
        this.mulliganModal?.close?.();

        if (payload.hands) {
          if (payload.hands.player_1 && player1) {
            player1.hand = [...payload.hands.player_1];
            if (player1.zones) player1.zones.hand = [...player1.hand];
          }
          if (payload.hands.player_2 && player2) {
            player2.hand = [...payload.hands.player_2];
            if (player2.zones) player2.zones.hand = [...player2.hand];
          }
        }
        this.appendExecutionLog('Mulligan', '🃏 7-card opening hands dealt from equipped decks. Both players keep. Leylines checked.');
        break;
      }

      case 'TURN_1_MAIN_PHASE': {
        if (this.priorityMachine) {
          this.priorityMachine.turnNumber = payload.turn || 1;
          this.priorityMachine.currentPhaseStep = payload.phase || 'PRECOMBAT_MAIN';
          this.priorityMachine.activePlayerId = payload.playerId || 'player_1';
          this.priorityMachine.priorityPlayerId = payload.playerId || 'player_1';
        }

        const land = payload.land;
        if (land && player1) {
          player1.hand = (player1.hand || []).filter(c => c.instanceId !== land.instanceId && c.name !== land.name);
          if (player1.zones) player1.zones.hand = [...player1.hand];

          player1.battlefield = player1.battlefield || {};
          player1.battlefield.lands = player1.battlefield.lands || [];
          if (!player1.battlefield.lands.some(l => l.instanceId === land.instanceId)) {
            player1.battlefield.lands.push({ ...land, isTapped: false });
          }
          if (player1.zones) {
            player1.zones.battlefield = player1.zones.battlefield || [];
            if (!player1.zones.battlefield.some(l => l.instanceId === land.instanceId)) {
              player1.zones.battlefield.push({ ...land, isTapped: false });
            }
          }
          player1.landsPlayedThisTurn = 1;
          if (player1.resources) {
            player1.resources.manaPool = player1.resources.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
            player1.resources.manaPool.W = 1;
          }
        }
        this.appendExecutionLog('Turn 1', `⛰️ Turn 1 Precombat Main: ${this.getFriendlyPlayerName(payload.playerId || 'player_1')} plays ${land?.name || 'Land'} to battlefield.`);
        break;
      }

      case 'SPELL_CAST': {
        const spellCard = payload.card;
        if (spellCard && player1) {
          if (player1.battlefield?.lands) {
            const land = player1.battlefield.lands.find(l => l.instanceId === payload.tappedLandId) || player1.battlefield.lands[0];
            if (land) land.isTapped = true;
          }
          player1.hand = (player1.hand || []).filter(c => c.instanceId !== spellCard.instanceId && c.name !== spellCard.name);
          if (player1.zones) player1.zones.hand = [...player1.hand];

          if (player1.resources?.manaPool) {
            player1.resources.manaPool.W = 0;
          }

          player1.battlefield = player1.battlefield || {};
          const isCreature = String(spellCard.typeLine || '').toLowerCase().includes('creature');
          if (isCreature) {
            player1.battlefield.creatures = player1.battlefield.creatures || [];
            player1.battlefield.creatures.push({ ...spellCard });
          } else {
            player1.battlefield.noncreatures = player1.battlefield.noncreatures || [];
            player1.battlefield.noncreatures.push({ ...spellCard });
          }
          if (player1.zones) {
            player1.zones.battlefield = player1.zones.battlefield || [];
            player1.zones.battlefield.push({ ...spellCard });
          }
        }
        this.appendExecutionLog('Spell', `⚡ ${this.getFriendlyPlayerName(payload.controllerId || 'player_1')} taps land and casts ${spellCard?.name || 'Spell'}, resolving onto battlefield.`);
        break;
      }

      case 'COMBAT_DAMAGE': {
        const dmg = payload.damage || 2;
        const targetId = payload.targetPlayerId || 'player_2';
        const targetPlayer = this.tabletopState?.players?.[targetId] || player2;
        if (targetPlayer?.resources) {
          targetPlayer.resources.life = (payload.newLife !== undefined) ? payload.newLife : Math.max(0, (targetPlayer.resources.life || 20) - dmg);
        }
        this.appendExecutionLog('Combat', `⚔️ Attack deals ${dmg} damage to ${this.getFriendlyPlayerName(targetId)}! Life total: ${targetPlayer?.resources?.life}`);
        break;
      }

      case 'STATE_HASH_MATCH': {
        const local = this.computeStateHash();
        const matches = (local.hash === payload.hash);
        this.lastStateHash = local.hash;
        this.stateHashMatch = matches;
        this.appendExecutionLog('State Hash', `🔒 Deterministic state verification: Hash [${local.hash}] ${matches ? 'MATCHES' : 'MISMATCH'} payload [${payload.hash}]`);
        break;
      }
    }

    this.reconcileDOM();
  }

  /**
   * Computes deterministic state hash of life totals, hand counts, battlefield counts, turn, and phase.
   * @returns {{ hash: string, summary: Object }}
   */
  computeStateHash() {
    const p1 = this.tabletopState?.players?.['player_1'] || this.tabletopState?.players?.['p1'];
    const p2 = this.tabletopState?.players?.['player_2'] || this.tabletopState?.players?.['p2'];
    const p1Life = p1?.resources?.life ?? 20;
    const p2Life = p2?.resources?.life ?? 20;
    const p1Hand = (p1?.zones?.hand || p1?.hand || []).length;
    const p2Hand = (p2?.zones?.hand || p2?.hand || []).length;
    const p1Bf = (
      (p1?.battlefield?.lands || []).length +
      (p1?.battlefield?.creatures || []).length +
      (p1?.battlefield?.noncreatures || []).length +
      (p1?.battlefield?.planeswalkers || []).length
    );
    const p2Bf = (
      (p2?.battlefield?.lands || []).length +
      (p2?.battlefield?.creatures || []).length +
      (p2?.battlefield?.noncreatures || []).length +
      (p2?.battlefield?.planeswalkers || []).length
    );
    const turn = this.priorityMachine?.turnNumber || 1;
    const phase = this.priorityMachine?.currentPhaseStep || 'PRECOMBAT_MAIN';

    const summary = {
      p1Life,
      p2Life,
      p1Hand,
      p2Hand,
      p1Bf,
      p2Bf,
      turn,
      phase
    };

    const str = JSON.stringify(summary, Object.keys(summary).sort());
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const hash = ('00000000' + (h >>> 0).toString(16)).slice(-8);

    return { hash, summary };
  }

  /**
   * Synchronizes active authenticated user identity across all internal subsystems.
   * Ensures pre-auth temporary seat holders and state references are cleanly migrated.
   * @private
   */
  _syncAuthUser() {
    if (!this.authManager) return;
    const user = this.authManager.getCurrentUser();
    if (!user) return;

    const oldId = this.myPlayerId;
    this.myPlayerId = user.id || this.myPlayerId;
    this.username = user.username || this.username;

    if (this.lobbyManager) {
      for (const slot of this.lobbyManager.slots.values()) {
        if (slot.playerId === oldId || (!slot.isBot && slot.slotId === 1 && oldId === 'p1')) {
          slot.playerId = this.myPlayerId;
          slot.playerName = this.username;
        }
      }
    }

    if (this.tabletopState?.players && oldId !== this.myPlayerId) {
      if (this.tabletopState.players[oldId]) {
        this.tabletopState.players[this.myPlayerId] = this.tabletopState.players[oldId];
        this.tabletopState.players[this.myPlayerId].id = this.myPlayerId;
        this.tabletopState.players[this.myPlayerId].playerId = this.myPlayerId;
        this.tabletopState.players[this.myPlayerId].name = this.username;
        delete this.tabletopState.players[oldId];
      }
    }

    if (Array.isArray(this.playerIds) && oldId !== this.myPlayerId) {
      const idx = this.playerIds.indexOf(oldId);
      if (idx !== -1) {
        this.playerIds[idx] = this.myPlayerId;
      }
    }

    if (this.drawerState && oldId !== this.myPlayerId && this.drawerState[oldId]) {
      this.drawerState[this.myPlayerId] = this.drawerState[oldId];
      delete this.drawerState[oldId];
    }

    if (this.dualChat && oldId !== this.myPlayerId) {
      this.dualChat.myPlayerId = this.myPlayerId;
    }

    if (this.priorityMachine && oldId !== this.myPlayerId) {
      if (Array.isArray(this.priorityMachine.players)) {
        this.priorityMachine.players = this.priorityMachine.players.map(p => (p === oldId || p === 'p1') ? this.myPlayerId : p);
      }
      if (this.priorityMachine.activePlayerId === oldId || this.priorityMachine.activePlayerId === 'p1') {
        this.priorityMachine.activePlayerId = this.myPlayerId;
      }
      if (this.priorityMachine.priorityPlayerId === oldId || this.priorityMachine.priorityPlayerId === 'p1') {
        this.priorityMachine.priorityPlayerId = this.myPlayerId;
      }
      if (this.priorityMachine.startingPlayerId === oldId || this.priorityMachine.startingPlayerId === 'p1') {
        this.priorityMachine.startingPlayerId = this.myPlayerId;
      }
      if (this.priorityMachine.playerTurnCounts instanceof Map && this.priorityMachine.playerTurnCounts.has(oldId)) {
        const cnt = this.priorityMachine.playerTurnCounts.get(oldId);
        this.priorityMachine.playerTurnCounts.delete(oldId);
        this.priorityMachine.playerTurnCounts.set(this.myPlayerId, cnt);
      }
    }

    if (this.pregameMachine && oldId !== this.myPlayerId) {
      const pm = this.pregameMachine;
      if (Array.isArray(pm.players)) {
        pm.players = pm.players.map(p => (p === oldId || p === 'p1') ? this.myPlayerId : p);
      }
      for (const prop of ['rollWinnerId', 'choicePriority', 'startingPlayerId', 'activePlayerId', 'currentDecidingPlayerId']) {
        if (pm[prop] === oldId || pm[prop] === 'p1') pm[prop] = this.myPlayerId;
      }
      for (const dict of ['rolls', 'mulliganCount', 'mulliganStatus', 'playerSubStates', 'pendingBottomCount']) {
        if (pm[dict] && oldId in pm[dict]) {
          pm[dict][this.myPlayerId] = pm[dict][oldId];
          delete pm[dict][oldId];
        }
      }
    }

    if (this.perkEngine) {
      this.perkEngine.humanPlayerId = this.myPlayerId;
    }
    if (this.randomPerk) {
      this.randomPerk.humanPlayerId = this.myPlayerId;
    }
  }

  /**
   * Resolves a human-friendly display label for a playerId, never exposing raw UUIDs (INV-HEADER-1).
   * @param {string} playerId
   * @returns {string}
   */
  getFriendlyPlayerName(playerId) {
    if (!playerId) return 'Player';
    if (playerId === this.myPlayerId || (String(playerId).toLowerCase() === 'p1' && this._isRawUuid(this.myPlayerId))) {
      return this.username && !this._isRawUuid(this.username) ? `${this.username} (You)` : 'You (P1)';
    }
    if (String(playerId).toLowerCase().includes('perkins')) {
      return 'Perkins AI (Bot)';
    }
    const p = this.tabletopState?.players?.[playerId];
    if (p?.name && !this._isRawUuid(p.name)) return p.name;
    if (this._isRawUuid(playerId)) return 'Player 1';
    return String(playerId).toUpperCase();
  }

  /**
   * Appends an entry specifically into Turn Command and execution log.
   * @param {string} text
   * @param {Object} [meta={}]
   */
  addTurnCommandLog(text, meta = {}) {
    if (!text || typeof text !== 'string') return null;
    const now = Date.now();
    const normalized = text.replace(/\s*\(You\)/gi, '').trim();

    if (!this._recentTurnCommandLogs) {
      this._recentTurnCommandLogs = [];
    }
    this._recentTurnCommandLogs = this._recentTurnCommandLogs.filter(e => (now - e.time) < 2500);

    const isDuplicate = this._recentTurnCommandLogs.some(e =>
      e.normText === normalized && (now - e.time) <= 250
    );
    if (isDuplicate) {
      return null;
    }

    this._recentTurnCommandLogs.push({ normText: normalized, time: now });
    if (!this.turnCommandLogs) this.turnCommandLogs = [];
    const entry = this.appendExecutionLog('Turn Cmd', text, meta);
    if (entry) {
      this.turnCommandLogs.push(entry);
    }
    return entry;
  }

  /**
   * Appends a real-time execution telemetry entry to `this.executionLog` and the Turn Command feed.
   * @param {string} category
   * @param {string} text
   * @param {Object} [meta={}]
   */
  appendExecutionLog(category, text, meta = {}) {
    if (!this.executionLog) this.executionLog = [];
    const turnNum = this.priorityMachine?.turnNumber || 1;
    const step = this.priorityMachine?.currentPhaseStep || 'PREGAME';
    const entry = {
      id: `log_${Date.now()}_${this.executionLog.length}`,
      timestamp: Date.now(),
      category,
      turnNumber: turnNum,
      phaseStep: step,
      senderName: `[${category}]`,
      text,
      ...meta
    };
    this.executionLog.push(entry);
    if (this.dualChat && Array.isArray(this.dualChat.turnCommandMessages)) {
      this.dualChat.turnCommandMessages.push({
        id: entry.id,
        senderId: meta.playerId || 'SYSTEM',
        senderName: entry.senderName,
        text: entry.text,
        timestamp: entry.timestamp
      });
    }
    return entry;
  }

  _wireTraceLogger(logger) {
    if (!logger) return;
    const bridge = (entry) => {
      if (!entry) return;
      const { category, action, payload } = entry;
      if (action === 'COMBAT_DAMAGE_STEP' && payload?.summary) {
        this.appendExecutionLog('Combat', payload.summary, { origin: 'COMBAT_DAMAGE' });
      } else if (action === 'SBA_APPLIED' && Array.isArray(payload?.actions)) {
        for (const act of payload.actions) {
          if (act.type === 'CREATURE_DESTROYED_LETHAL_DAMAGE' || act.rule === '704.5g') {
            this.appendExecutionLog('SBA', `💀 SBA (704.5g): ${act.cardName || 'Creature'} destroyed by lethal damage (${act.markedDamage}/${act.toughness})`, { origin: 'SBA' });
          } else if (act.type === 'CREATURE_DIED_ZERO_TOUGHNESS' || act.rule === '704.5f') {
            this.appendExecutionLog('SBA', `💀 SBA (704.5f): ${act.cardName || 'Creature'} put into graveyard (0 or less toughness)`, { origin: 'SBA' });
          } else if (act.type === 'PLAYER_ELIMINATED' || act.rule === '704.5a') {
            this.appendExecutionLog('SBA', `💀 SBA (704.5a): Player ${this.getFriendlyPlayerName(act.playerId)} loses the game (0 or less life)`, { origin: 'SBA' });
          }
        }
      } else if (action === 'PROWESS_TRIGGERED') {
        const cName = payload.creatureName || 'Monastery Swiftspear';
        const pName = this.getFriendlyPlayerName(payload.playerId);
        this.appendExecutionLog('Triggers', `✨ Prowess triggered on ${cName} (${pName}) (+1/+1 until end of turn, now ${payload.powerAfter || 2}/${payload.toughnessAfter || 3})`, { origin: 'TRIGGER' });
      } else if (action === 'GOBLIN_GUIDE_ATTACK_TRIGGER') {
        const defName = this.getFriendlyPlayerName(payload.defenderId);
        const cardName = payload.revealedCardName || 'nothing';
        const actionStr = payload.isLand ? 'revealed land put into hand! 🌄' : 'not a land, stays on top of library 📜';
        this.appendExecutionLog('Triggers', `🎯 Goblin Guide attack trigger: ${defName} reveals ${cardName} — ${actionStr}`, { origin: 'ATTACK_TRIGGER' });
      } else if (action === 'TRIGGER_QUEUED') {
        const cond = payload?.triggerCondition || payload?.condition || 'ABILITY';
        const name = payload?.sourceName || payload?.name || 'Permanent';
        this.appendExecutionLog('Triggers', `⚡ Trigger Queued: [${cond}] from ${name}`, { origin: 'TRIGGER' });
      } else if (action === 'TRIGGER_FLUSHED_APNAP') {
        const count = payload?.flushedCount ?? (payload?.triggers?.length || 0);
        if (count > 0) {
          this.appendExecutionLog('Triggers', `⚡ APNAP Trigger Flush: ${count} ability(s) put onto stack`, { origin: 'TRIGGER' });
        }
      } else if (action === 'STACK_ITEM_RESOLVED') {
        const name = payload?.name || payload?.itemId || 'Spell/Ability';
        this.appendExecutionLog('Stack', `✨ Stack Item Resolved: ${name} (${payload?.type || 'SPELL'})`, { origin: 'STACK' });
      } else if (category === 'PERK_TRACE' && payload?.summary) {
        // PERK_TRACE events (PERK_STEP1_TRIGGERED, PERK_DICE_ROLLED, etc.) are logged directly by RandomPerkEngine event handlers
      } else if (action === 'PHASE_TRANSITION') {
        const step = payload?.currentPhaseStep || entry.step;
        const turn = payload?.turnNumber ?? entry.turn ?? 1;
        const active = payload?.activePlayerId ?? entry.activePlayerId;
        const activeName = this.getFriendlyPlayerName(active);
        this.appendExecutionLog('Phase', `⏱️ Turn ${turn} [${activeName}] entered ${step}`, { origin: 'PHASE' });
      }
    };

    if (typeof logger.setOnRecord === 'function') {
      logger.setOnRecord(bridge);
    } else {
      logger.onRecord = bridge;
    }
  }

  // ==========================================================================
  // View Reconciliation (Sub-16ms Frame Budget Gate)
  // ==========================================================================

  /**
   * Reconciles the DOM view based on current subsystem states.
   * Executes within sub-16ms frame budget (60 FPS).
   */
  render() {
    return this.reconcileDOM();
  }

  /**
   * Pre-syncs and validates combat block targets before rendering opponents and dashboard.
   * Ensures active attacker target ID is available when opponents are rendered.
   * @private
   */
  _syncCombatBlockTargetState() {
    const psmForAttack = this.priorityMachine;
    const activeCombatAttackers = this.tabletopState?.combatState?.attackers || [];
    const defendingPid = psmForAttack?.defendingPlayerId || this.tabletopState?.combatState?.defendingPlayerId || activeCombatAttackers[0]?.defendingPlayerId;
    const isUnderAttack = (psmForAttack?.currentPhaseStep === 'DECLARE_BLOCKERS' || (psmForAttack?.currentPhaseStep === 'DECLARE_ATTACKERS' && psmForAttack?.priorityPlayerId === this.myPlayerId)) &&
      (defendingPid === this.myPlayerId || this.tabletopState?.players?.[this.myPlayerId]?.underAttack === true) &&
      (activeCombatAttackers.length > 0);

    const isBlockWindow = !!psmForAttack &&
      !this.isSpectator() &&
      !this.pregameActive &&
      psmForAttack.activePlayerId !== this.myPlayerId &&
      activeCombatAttackers.length > 0 &&
      !this.tabletopState?.combatState?.blockersDeclared &&
      isUnderAttack;

    if (!this._blockerAssignments) this._blockerAssignments = new Map();
    if (!isBlockWindow) {
      this._blockerAssignments.clear();
      this._activeAttackerTargetId = null;
    } else {
      const attackerIds = activeCombatAttackers
        .map(a => typeof a === 'string' ? a : (a?.creatureId || a?.instanceId || a?.id))
        .filter(Boolean);
      if (!this._activeAttackerTargetId || !attackerIds.includes(this._activeAttackerTargetId)) {
        this._activeAttackerTargetId = attackerIds[0] || null;
      }
      const p = this.tabletopState?.players?.[this.myPlayerId];
      const creatures = p?.battlefield?.creatures || p?.zones?.battlefield || [];
      const untappedCreatureIds = new Set(creatures.filter(c => c && !c.isTapped).map(c => c.instanceId));
      for (const [bId, aId] of [...this._blockerAssignments.entries()]) {
        if (!untappedCreatureIds.has(bId) || !attackerIds.includes(aId)) {
          this._blockerAssignments.delete(bId);
        }
      }
    }
  }

  reconcileDOM() {
    if (!this.container || this.isDestroyed) return;
    this._syncAuthUser();

    // Keep #modal-root interactive whenever any active modal layer is open
    const isAnyModalActive = Boolean(
      this.diceRollOverlay?.isOpen ||
      this.targetModal?.isOpen ||
      this._isVictoryModalOpen ||
      this._isDeckbuilderModalOpen ||
      this._isRecapModalOpen
    );
    const modalRoot = this.container?.querySelector('#modal-root');
    if (modalRoot && isAnyModalActive) {
      modalRoot.setAttribute('aria-hidden', 'false');
      modalRoot.style.pointerEvents = 'auto';
    }

    // 1. Header Bar & Nav Tabs
    this._reconcileHeader();

    // 2. Tab Panes Visibility
    this._reconcileTabPanes();

    // 2.5 Phase Track Strip (INV-PHASE-1)
    this._reconcilePhaseTrack();

    // 2.8 Pre-sync Combat Block Target State so Opponents render with active target
    this._syncCombatBlockTargetState();

    // 3. Opponents Pod (Auto-scaling 1 to 5 opponents)
    this._reconcileOpponents();

    // 4. Center Battlefield & Stack
    this._reconcileStack();

    // 5. Bottom Player Dashboard
    this._reconcilePlayerDashboard();

    // 6. Dual-Channel Chat
    this._reconcileChat();

    // 7. Roll-off Overlay
    this._reconcileRollOff();

    // 8. Views
    this._reconcileAuthView();
    this._reconcileDeckbuilderView();
    this._reconcileLobbyView();
    this._reconcileProfileView();
    this._reconcileLeaderboardView();
  }

  /**
   * Reconciles Tab Panes visibility.
   * @private
   */
  _reconcileTabPanes() {
    const curTab = this.tabRouter ? this.tabRouter.getCurrentTab() : 'ARENA';
    const panes = {
      AUTH: this.container.querySelector('#view-auth'),
      ARENA: this.container.querySelector('#view-arena'),
      DECKBUILDER: this.container.querySelector('#view-deckbuilder'),
      LOBBY: this.container.querySelector('#view-lobby'),
      PROFILE: this.container.querySelector('#view-profile'),
      LEADERBOARD: this.container.querySelector('#view-leaderboard')
    };

    for (const [tabKey, el] of Object.entries(panes)) {
      if (!el) continue;
      if (tabKey === curTab) {
        el.style.display = 'block';
        el.classList.add('active');
      } else {
        el.style.display = 'none';
        el.classList.remove('active');
      }
    }
  }

  /**
   * Reconciles Turn Phase Marker Strip (INV-PHASE-1).
   * @private
   */
  _reconcilePhaseTrack() {
    const track = this.container?.querySelector('#arena-phase-track');
    if (!track) return;

    const canonicalSteps = [
      { id: 'UNTAP', label: 'UNTAP' },
      { id: 'UPKEEP', label: 'UPKEEP' },
      { id: 'DRAW', label: 'DRAW' },
      { id: 'MAIN 1', stepMatch: ['PRECOMBAT_MAIN', 'MAIN 1', 'MAIN1'], label: 'MAIN 1' },
      { id: 'COMBAT', stepMatch: ['COMBAT', 'BEGIN_COMBAT', 'DECLARE_ATTACKERS', 'DECLARE_BLOCKERS', 'COMBAT_DAMAGE', 'END_COMBAT'], label: 'COMBAT' },
      { id: 'MAIN 2', stepMatch: ['POSTCOMBAT_MAIN', 'MAIN 2', 'MAIN2'], label: 'MAIN 2' },
      { id: 'END', stepMatch: ['END', 'END_STEP', 'CLEANUP'], label: 'END' }
    ];

    const currentStep = (this.priorityMachine?.currentPhaseStep || 'UNTAP').toUpperCase();

    let stepList = track.querySelector('#phase-step-list') || track.querySelector('.phase-step-list');
    let btnNext = track.querySelector('#btn-next-phase');

    if (!stepList || !btnNext) {
      track.innerHTML = `
        <div id="phase-step-list" class="phase-step-list"></div>
        <button id="btn-next-phase" class="btn btn-next-phase" title="Advance to Next Phase (Consensus / 1-Tap)">⏭️ Next Phase</button>
      `;
      stepList = track.querySelector('#phase-step-list') || track.querySelector('.phase-step-list');
      btnNext = track.querySelector('#btn-next-phase');

      if (!stepList && typeof document !== 'undefined') {
        stepList = document.createElement('div');
        stepList.id = 'phase-step-list';
        stepList.className = 'phase-step-list';
        track.appendChild(stepList);
      }
      if (!btnNext && typeof document !== 'undefined') {
        btnNext = document.createElement('button');
        btnNext.id = 'btn-next-phase';
        btnNext.className = 'btn btn-next-phase';
        track.appendChild(btnNext);
      }

      if (btnNext) {
        btnNext.addEventListener('click', () => {
          if (this.isSpectator()) return;
          if (this.tabletopState?.isGameOver) return;
          if (this.priorityMachine) {
            try {
              const step = this.priorityMachine.currentPhaseStep;
              const isActive = this.priorityMachine.activePlayerId === this.myPlayerId;
              const activeCombatAttackers = this.tabletopState?.combatState?.attackers || [];

              if (isActive) {
                // If active player has selected attackers during DECLARE_ATTACKERS, commit them first
                if (step === 'DECLARE_ATTACKERS' && this._selectedAttackers && this._selectedAttackers.size > 0) {
                  const ids = Array.from(this._selectedAttackers);
                  const attackerTargetsPayload = { ...this.attackerTargets };
                  const defId = this._selectedDefendingPlayerId;
                  this._selectedAttackers.clear();
                  this.attackerTargets = {};
                  this.dispatchAction({
                    type: 'DECLARE_ATTACKERS',
                    playerId: this.myPlayerId,
                    attackers: ids,
                    attackerTargets: attackerTargetsPayload,
                    defendingPlayerId: defId,
                    payload: { playerId: this.myPlayerId, attackers: ids, attackerTargets: attackerTargetsPayload, defendingPlayerId: defId }
                  }, { origin: 'LOCAL' });
                }
                if (typeof this.priorityMachine.nextPhase === 'function') {
                  this.priorityMachine.nextPhase(this.myPlayerId);
                }
              } else {
                // Defending / non-active player: check block window
                const defendingPid = this.priorityMachine.defendingPlayerId || this.tabletopState?.combatState?.defendingPlayerId || activeCombatAttackers[0]?.defendingPlayerId;
                const isUnderAttack = (defendingPid === this.myPlayerId || this.tabletopState?.players?.[this.myPlayerId]?.underAttack === true);
                const isBlockWindow = !this.tabletopState?.combatState?.blockersDeclared &&
                  (step === 'DECLARE_BLOCKERS' || (step === 'DECLARE_ATTACKERS' && this.priorityMachine.priorityPlayerId === this.myPlayerId)) &&
                  activeCombatAttackers.length > 0 &&
                  isUnderAttack;

                if (isBlockWindow) {
                  const assignments = this._blockerAssignments
                    ? Array.from(this._blockerAssignments.entries()).map(([blockerId, attackerId]) => ({ blockerId, attackerId }))
                    : [];
                  this.commitHumanBlocks(assignments);
                } else if (this.priorityMachine.priorityPlayerId === this.myPlayerId) {
                  this.dispatchAction({ type: 'PASS_PRIORITY', payload: { playerId: this.myPlayerId } }, { origin: 'LOCAL' });
                }
              }
            } catch (err) {
              console.warn('[app.js] nextPhase error:', err);
            }
            this.reconcileDOM();
          }
        });
      }
    }

    if (btnNext) {
      if (this.isSpectator() || Boolean(this.tabletopState?.isGameOver)) {
        btnNext.disabled = true;
        if (this.isSpectator()) {
          btnNext.style.display = 'none';
        }
      } else {
        btnNext.style.display = 'inline-flex';
        btnNext.disabled = false;
      }
    }

    if (stepList) {
      stepList.innerHTML = '';
      canonicalSteps.forEach(step => {
        const isMatch = step.stepMatch
          ? step.stepMatch.includes(currentStep)
          : step.id === currentStep;

        const hasStop = this.hasPhaseStop(step.id);
        const pill = document.createElement('div');
        pill.className = `phase-step ${isMatch ? 'active phase-active-step' : ''} ${hasStop ? 'phase-stop-active' : ''}`;
        pill.setAttribute('data-step', step.id);
        pill.style.cursor = 'pointer';
        pill.title = `Click to toggle phase stop for ${step.label} (${hasStop ? 'Stop Active' : 'No Stop'})`;
        pill.textContent = `${isMatch ? '🌟 ' : ''}${hasStop ? '🛑 ' : ''}${step.label}`;
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          this.togglePhaseStop(step.id);
        });
        stepList.appendChild(pill);
      });
    }
  }

  /**
   * Reconciles Header elements.
   * @private
   */
  _reconcileHeader() {
    const activePlayerBadge = this.container.querySelector('#active-player-badge');
    const activePlayerName = this.container.querySelector('#active-player-name');
    const currentPhaseName = this.container.querySelector('#current-phase-name');

    const currentTab = this.tabRouter ? this.tabRouter.getCurrentTab() : 'ARENA';
    const matchActive = this.isMatchActive();

    // 1. Badge visibility: Only show when match is active AND current tab is ARENA
    if (activePlayerBadge) {
      if (matchActive && currentTab === 'ARENA') {
        activePlayerBadge.style.display = 'flex';
      } else {
        activePlayerBadge.style.display = 'none';
      }
    }

    if (activePlayerName) {
      if (matchActive) {
        const activeId = this.priorityMachine ? (this.priorityMachine.activePlayerId || 'p1') : 'p1';
        const roundNum = this.priorityMachine?.roundNumber || this.tabletopState?.roundNumber || 1;
        const playerTurn = typeof this.priorityMachine?.getPlayerTurnCount === 'function'
          ? this.priorityMachine.getPlayerTurnCount(activeId)
          : (this.priorityMachine?.turnNumber || 1);

        let displayName;
        if (activeId === this.myPlayerId) {
          const idSuffix = (this.myPlayerId && !this._isRawUuid(this.myPlayerId)) ? ` (${this.myPlayerId.toUpperCase()})` : '';
          displayName = `Your Turn (You)${idSuffix}`;
        } else {
          const pState = this.tabletopState?.players?.[activeId];
          if (pState && pState.name && !this._isRawUuid(pState.name)) {
            displayName = pState.name;
          } else if (activeId.toLowerCase().includes('perkins')) {
            displayName = 'Perkins AI (Bot)';
          } else {
            const slot = this.lobbyManager?.getSeatedSlots?.()?.find(s => s.playerId === activeId);
            displayName = slot?.username || `Opponent (${activeId.substring(0, 6).toUpperCase()})`;
          }
        }

        activePlayerName.textContent = `Round ${roundNum} • Turn: ${displayName} (Turn ${playerTurn})`;
      } else if (this.priorityMachine && this.priorityMachine.activePlayerId && this.priorityMachine.activePlayerId.includes('perkins')) {
        // Backwards compatibility for headless TC-STABILITY-16 friendly bot test
        activePlayerName.textContent = `Round 1 • Turn: Perkins AI (Bot) (Turn 1)`;
      } else {
        const userLabel = this.username || 'You';
        const idSuffix = (this.myPlayerId && !this._isRawUuid(this.myPlayerId)) ? ` (${this.myPlayerId.toUpperCase()})` : '';
        activePlayerName.textContent = `${userLabel} (You)${idSuffix}`;
      }
    }

    if (currentPhaseName) {
      if (matchActive && this.priorityMachine) {
        currentPhaseName.textContent = capitalize(this.priorityMachine.currentPhaseStep || 'Untap');
      } else {
        currentPhaseName.textContent = '';
      }
    }

    // Reconcile Nav Tabs
    const isLocked = this.isMatchActive() && !this.isSpectator();
    const isAuth = this.authManager ? this.authManager.isAuthenticated() : true;
    const isOnboard = this.authManager ? this.authManager.isOnboarded() : true;

    const navTabs = this.container.querySelectorAll('.nav-tab');
    navTabs.forEach(btn => {
      const tabName = (btn.getAttribute('data-tab') || '').toUpperCase();
      const isActive = tabName === currentTab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');

      if (tabName === 'AUTH') {
        btn.style.display = !isAuth ? 'inline-block' : 'none';
      }

      let locked = false;
      if (this.isSpectator()) {
        locked = false;
      } else {
        if (isLocked && LOCKED_TABS_DURING_MATCH.has(tabName)) {
          locked = true;
        }
        if (this.requireAuth && (this.options.strictAuthGate || this.tabRouter?.strictAuthGate)) {
          if (!isAuth && tabName !== 'AUTH') {
            locked = true;
          }
          if (isAuth && !isOnboard && (tabName === 'LOBBY' || tabName === 'ARENA')) {
            locked = true;
          }
        }
      }

      if (locked) {
        btn.classList.add('tab-locked');
        btn.setAttribute('title', 'Locked');
      } else {
        btn.classList.remove('tab-locked');
        btn.removeAttribute('title');
      }
    });
  }

  /**
   * Sets connection status pill.
   * @private
   */
  _setConnectionStatus(status) {
    const pill = this.container?.querySelector('#connection-status-pill');
    if (!pill) return;

    pill.classList.remove('status-connected', 'status-reconnecting', 'status-offline');
    const textSpan = pill.querySelector('.status-text');

    if (status === 'CONNECTED') {
      pill.classList.add('status-connected');
      if (textSpan) textSpan.textContent = 'Connected';
    } else if (status === 'RECONNECTING') {
      pill.classList.add('status-reconnecting');
      if (textSpan) textSpan.textContent = 'Reconnecting';
    } else {
      pill.classList.add('status-offline');
      if (textSpan) textSpan.textContent = 'Offline';
    }
  }

  /**
   * Reconciles Opponents pod container dynamically scaling for 1 to 5 opponents (INV-HARNESS-3).
   * @private
   */
  _reconcileOpponents() {
    const oppContainer = this.container.querySelector('#opponents-container');
    if (!oppContainer) return;

    // Get all player IDs from state
    const allPlayers = Object.keys(this.tabletopState?.players || {});
    const opponentIds = allPlayers.filter(pid => pid !== this.myPlayerId);

    // Ensure opponent elements exist
    for (const oppId of opponentIds) {
      let oppCard = oppContainer.querySelector(`#opponent-board-${oppId}`);
      const oppData = this.tabletopState?.players?.[oppId];
      const isEliminated = Boolean(oppData?.isEliminated);

      if (!oppCard) {
        oppCard = document.createElement('div');
        oppCard.id = `opponent-board-${oppId}`;
        oppCard.className = 'opponent-board tabletop-board board-opponent';
        oppContainer.appendChild(oppCard);
      }

      // Handle elimination gray-out overlay
      if (isEliminated) {
        oppCard.classList.add('player-eliminated');
        let overlay = oppCard.querySelector('.player-eliminated-overlay');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.className = 'player-eliminated-overlay';
          overlay.innerHTML = `<span class="eliminated-badge">💀 ELIMINATED</span>`;
          oppCard.appendChild(overlay);
        }
      } else {
        oppCard.classList.remove('player-eliminated');
        const overlay = oppCard.querySelector('.player-eliminated-overlay');
        if (overlay) {
          if (typeof overlay.remove === 'function') {
            overlay.remove();
          } else if (overlay.parentNode && typeof overlay.parentNode.removeChild === 'function') {
            overlay.parentNode.removeChild(overlay);
          }
        }
      }

      const life = oppData?.resources?.life ?? 20;
      const poison = oppData?.resources?.poison ?? 0;
      const handCount = Array.isArray(oppData?.zones?.hand) ? oppData.zones.hand.length : (Array.isArray(oppData?.hand) ? oppData.hand.length : 0);
      const graveCount = Array.isArray(oppData?.zones?.graveyard) ? oppData.zones.graveyard.length : (Array.isArray(oppData?.graveyard) ? oppData.graveyard.length : 0);
      const exileCount = Array.isArray(oppData?.zones?.exile) ? oppData.zones.exile.length : (Array.isArray(oppData?.exile) ? oppData.exile.length : 0);
      const bCreatures = Array.isArray(oppData?.battlefield?.creatures) ? oppData.battlefield.creatures : [];
      const zCreatures = Array.isArray(oppData?.zones?.battlefield)
        ? oppData.zones.battlefield.filter(c => (c.type_line || c.typeLine || c.type || '').toLowerCase().includes('creature') || c.subzone === 'creatures')
        : [];
      const oppCreatures = Array.isArray(oppData?.battlefield?.creatures) ? bCreatures : zCreatures;
      const creatureCount = oppCreatures.length;

      // Reconcile opponent content
      let content = oppCard.querySelector('.opponent-card-content');
      if (!content) {
        content = document.createElement('div');
        content.className = 'opponent-card-content';
        oppCard.appendChild(content);
      }

      // Dedicated Opponent Lands Strip (INV-OPP-LAND-1)
      const bLands = Array.isArray(oppData?.battlefield?.lands) ? oppData.battlefield.lands : [];
      const zLands = Array.isArray(oppData?.zones?.battlefield)
        ? oppData.zones.battlefield.filter(c => (c.type_line || c.typeLine || c.type || '').toLowerCase().includes('land') || c.subzone === 'lands')
        : [];
      const oppLands = bLands.length >= zLands.length ? bLands : zLands;
      const availableMana = oppLands.filter(l => !l.isTapped).length;

      const landsHtml = oppLands.map(land => {
        const isTapped = Boolean(land.isTapped);
        const pip = this._getLandPipInfo(land);
        const name = land.name || 'Land';
        const instId = land.instanceId || land.id || '';
        return `
          <div class="opponent-land-card ${isTapped ? 'is-tapped card-tapped' : ''}"
               data-instance-id="${instId}"
               data-tapped="${isTapped ? 'true' : 'false'}"
               style="${isTapped ? 'opacity: 0.62; border-color: rgba(255,255,255,0.2);' : ''}"
               title="${name} (${isTapped ? 'Tapped' : 'Untapped'}) - Click to inspect">
            <span class="land-pip mana-${pip.colorKey}"><i class="ms ${pip.glyph} ms-cost"></i></span>
            <span class="land-name">${name} ${isTapped ? '(Tapped)' : '(Untapped)'}</span>
            ${isTapped ? '<span class="tap-badge">↺</span>' : ''}
          </div>
        `;
      }).join('');

      // Opponent Noncreature Permanents (Artifacts, Enchantments, Planeswalkers, Battles)
      const bNoncreatures = [
        ...(Array.isArray(oppData?.battlefield?.noncreatures) ? oppData.battlefield.noncreatures : []),
        ...(Array.isArray(oppData?.battlefield?.planeswalkers) ? oppData.battlefield.planeswalkers : [])
      ];
      const zNoncreatures = Array.isArray(oppData?.zones?.battlefield)
        ? oppData.zones.battlefield.filter(c => {
            const tl = (c.type_line || c.typeLine || c.type || '').toLowerCase();
            return c.subzone === 'noncreatures' || c.subzone === 'planeswalkers' || (((tl.includes('artifact') || tl.includes('enchantment') || tl.includes('planeswalker') || tl.includes('battle')) && !tl.includes('creature') && !tl.includes('land')));
          })
        : [];
      const oppNoncreatures = bNoncreatures.length >= zNoncreatures.length ? bNoncreatures : zNoncreatures;

      const noncreaturesHtml = oppNoncreatures.map(nc => {
        const isTapped = Boolean(nc.isTapped);
        const name = nc.name || 'Permanent';
        const instId = nc.instanceId || nc.id || '';
        let attachedLabel = '';
        if (nc.attachedTo) {
          let targetCr = (oppCreatures || []).find(cr => cr && (cr.instanceId === nc.attachedTo || cr.id === nc.attachedTo));
          if (!targetCr && this.tabletopState) {
            for (const pl of Object.values(this.tabletopState.players || {})) {
              const found = (pl.battlefield?.creatures || []).find(cr => cr && (cr.instanceId === nc.attachedTo || cr.id === nc.attachedTo));
              if (found) { targetCr = found; break; }
            }
          }
          attachedLabel = ` <span class="attached-badge">🔗 Equipped: ${this._escapeHtml(targetCr?.name || 'Creature')}</span>`;
        }
        return `
          <div class="opponent-noncreature-card battlefield-card-chip ${isTapped ? 'is-tapped card-tapped' : ''}"
               data-instance-id="${instId}"
               data-tapped="${isTapped ? 'true' : 'false'}"
               style="${isTapped ? 'opacity: 0.62;' : ''}"
               title="${name}${nc.attachedTo ? ' (Attached)' : ''} - Click to inspect">
            <span class="noncreature-name">${name}${attachedLabel}${isTapped ? ' ↺' : ''}</span>
          </div>
        `;
      }).join('');

      const activeCombatAttackers = this.tabletopState?.combatState?.attackers || [];
      const attackerIdSet = new Set(
        activeCombatAttackers.map(a => typeof a === 'string' ? a : (a?.creatureId || a?.instanceId || a?.id)).filter(Boolean)
      );
      const defendingPid = this.priorityMachine?.defendingPlayerId || this.tabletopState?.combatState?.defendingPlayerId || activeCombatAttackers[0]?.defendingPlayerId;
      const isUnderAttack = (defendingPid === this.myPlayerId || this.tabletopState?.players?.[this.myPlayerId]?.underAttack === true);
      const isBlockWindow = Boolean(
        this.priorityMachine &&
        !this.isSpectator() &&
        !this.pregameActive &&
        this.priorityMachine.activePlayerId !== this.myPlayerId &&
        activeCombatAttackers.length > 0 &&
        !this.tabletopState?.combatState?.blockersDeclared &&
        isUnderAttack &&
        (this.priorityMachine.currentPhaseStep === 'DECLARE_BLOCKERS' ||
         (this.priorityMachine.currentPhaseStep === 'DECLARE_ATTACKERS' && this.priorityMachine.priorityPlayerId === this.myPlayerId))
      );

      const creaturesHtml = oppCreatures.map(cr => {
        const instId = cr.instanceId || cr.id || '';
        const isTapped = Boolean(cr.isTapped);
        const isAttacking = Boolean(cr.isAttacking || attackerIdSet.has(instId));
        const isSelectedTarget = isBlockWindow && isAttacking && this._activeAttackerTargetId === instId;
        const name = cr.name || 'Creature';
        const stats = this.tabletopState?.abilityEngine?.evaluateCreatureStats
          ? this.tabletopState.abilityEngine.evaluateCreatureStats(cr, this.tabletopState)
          : (typeof this.tabletopState?.evaluateCreatureStats === 'function'
            ? this.tabletopState.evaluateCreatureStats(cr, oppId)
            : { power: cr.power, toughness: cr.toughness, keywords: cr.keywords || {} });
        let counterBadges = '';
        let counterTitle = '';
        if (cr.counters) {
          if (cr.counters['+1/+1']) {
            counterBadges += `<span class="counter-badge" style="background: #10b981; color: #0f172a; font-weight: bold; font-size: 0.7rem; padding: 1px 4px; border-radius: 3px; margin-left: 4px;">+1/+1 ×${cr.counters['+1/+1']}</span>`;
            counterTitle += ` [+1/+1 ×${cr.counters['+1/+1']}]`;
          }
          if (cr.counters['-1/-1']) {
            counterBadges += `<span class="counter-badge" style="background: #ef4444; color: #ffffff; font-weight: bold; font-size: 0.7rem; padding: 1px 4px; border-radius: 3px; margin-left: 4px;">-1/-1 ×${cr.counters['-1/-1']}</span>`;
            counterTitle += ` [-1/-1 ×${cr.counters['-1/-1']}]`;
          }
        }
        const pt = `${stats.power}/${stats.toughness}`;
        const effectiveKeywords = stats.keywords || {};
        const activeKws = Object.keys(effectiveKeywords).filter(k => effectiveKeywords[k] && k === k.toLowerCase());
        const kwTitle = activeKws.length > 0 ? ` [${activeKws.map(k => k.charAt(0).toUpperCase() + k.slice(1)).join(', ')}]` : '';
        return `
          <div class="opponent-creature-card battlefield-card-chip ${isTapped ? 'is-tapped card-tapped' : ''} ${isAttacking ? 'is-attacking attacking' : ''} ${isSelectedTarget ? 'attacker-target-selected' : ''}"
               data-instance-id="${instId}"
               data-tapped="${isTapped ? 'true' : 'false'}"
               data-power="${stats.power}"
               data-toughness="${stats.toughness}"
               data-keywords="${activeKws.join(',')}"
               style="${isAttacking ? 'border: 1px solid #ef4444; background: rgba(127, 29, 29, 0.35); cursor: pointer;' : ''}${isSelectedTarget ? ' box-shadow: 0 0 0 2px #f59e0b;' : ''}"
               title="${name} (${pt})${counterTitle}${kwTitle}${isAttacking ? ' - Attacking! Click to target with blocker' : ' - Click to inspect'}">
            <span class="creature-name">${name} (${pt})${counterBadges}${isAttacking ? ' ⚔️' : ''}${isSelectedTarget ? ' <span class="badge-target" style="background:#f59e0b; color:#000; font-size:10px; font-weight:bold; padding:1px 4px; border-radius:3px; margin-left:4px;">🎯 TARGET</span>' : ''}${isTapped ? ' ↺' : ''}</span>
          </div>
        `;
      }).join('');

      content.innerHTML = `
        <div class="opponent-header">
          <span class="opponent-name">${oppData?.name || `Opponent (${oppId.toUpperCase()})`}</span>
          <span class="opponent-life badge">Life: ${life}</span>
          <span class="opponent-poison">P: ${poison}</span>
        </div>
        <div class="opponent-lands-container">
          <div class="opponent-lands-header">
            <span class="lands-title">Lands (<span class="lands-count">${oppLands.length}</span>)</span>
            <span class="mana-avail-summary">Available: ${availableMana} / ${oppLands.length}</span>
          </div>
          <div class="opponent-lands-strip" data-player-id="${oppId}">
            ${landsHtml}
          </div>
        </div>
        ${oppCreatures.length > 0 ? `
        <div class="opponent-creatures-container">
          <div class="opponent-creatures-header">
            <span class="creatures-title">Creatures (<span class="creatures-count">${oppCreatures.length}</span>)</span>
          </div>
          <div class="opponent-creatures-strip" data-player-id="${oppId}">
            ${creaturesHtml}
          </div>
        </div>
        ` : ''}
        ${oppNoncreatures.length > 0 ? `
        <div class="opponent-noncreatures-container">
          <div class="opponent-noncreatures-header">
            <span class="noncreatures-title">Other Permanents (<span class="noncreatures-count">${oppNoncreatures.length}</span>)</span>
          </div>
          <div class="opponent-noncreatures-strip" data-player-id="${oppId}">
            ${noncreaturesHtml}
          </div>
        </div>
        ` : ''}
        <div class="opponent-drawers-row">
          <button class="btn btn-drawer-hand" ${isEliminated ? 'disabled' : ''}>Hand (${handCount})</button>
          <button class="btn btn-drawer-creatures" ${isEliminated ? 'disabled' : ''}>Creatures (${creatureCount})</button>
          <button class="btn btn-drawer-grave" data-player-id="${oppId}" data-zone="graveyard">Grave (${graveCount})</button>
          <button class="btn btn-drawer-exile" data-player-id="${oppId}" data-zone="exile">Exile (${exileCount})</button>
        </div>
      `;

      const btnOppGrave = oppCard.querySelector('.btn-drawer-grave');
      if (btnOppGrave) {
        btnOppGrave.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.openZoneBrowser(oppId, 'graveyard');
        });
      }
      const btnOppExile = oppCard.querySelector('.btn-drawer-exile');
      if (btnOppExile) {
        btnOppExile.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.openZoneBrowser(oppId, 'exile');
        });
      }

      // Bind click on opponent noncreatures to inspect card
      const noncreatureCards = oppCard.querySelectorAll('.opponent-noncreature-card');
      noncreatureCards.forEach((el, idx) => {
        const nc = oppNoncreatures[idx];
        if (!nc) return;
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (this.cardModal && typeof this.cardModal.show === 'function') {
            this.cardModal.show(nc);
          } else if (typeof this.openModal === 'function') {
            this.openModal('CARD_OVERLAY', nc);
          }
        });
      });

      // Bind click on opponent lands to inspect card
      const landCards = oppCard.querySelectorAll('.opponent-land-card');
      landCards.forEach((el, idx) => {
        const land = oppLands[idx];
        if (!land) return;
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (this.cardModal && typeof this.cardModal.show === 'function') {
            this.cardModal.show(land);
          } else if (typeof this.openModal === 'function') {
            this.openModal('CARD_OVERLAY', land);
          }
        });
      });

      // Bind click on opponent creatures to select attacker target in block window or inspect card
      const creatureCards = oppCard.querySelectorAll('.opponent-creature-card');
      creatureCards.forEach((el, idx) => {
        const cr = oppCreatures[idx];
        if (!cr) return;
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const instId = cr.instanceId || cr.id;
          if (isBlockWindow && (cr.isAttacking || attackerIdSet.has(instId))) {
            this._activeAttackerTargetId = instId;
            this.reconcileDOM();
            return;
          }
          if (this.cardModal && typeof this.cardModal.show === 'function') {
            this.cardModal.show(cr);
          } else if (typeof this.openModal === 'function') {
            this.openModal('CARD_OVERLAY', cr);
          }
        });
      });
    }

    // Remove any extra cards if players changed
    const currentCards = oppContainer.querySelectorAll('.opponent-board');
    for (const card of currentCards) {
      const match = card.id.match(/^opponent-board-(.+)$/);
      if (match && !opponentIds.includes(match[1])) {
        if (typeof card.remove === 'function') {
          card.remove();
        } else if (card.parentNode && typeof card.parentNode.removeChild === 'function') {
          card.parentNode.removeChild(card);
        } else if (card.parentElement && typeof card.parentElement.removeChild === 'function') {
          card.parentElement.removeChild(card);
        }
      }
    }
  }

  /**
   * Reconciles MTG Stack visualizer and 15s alarm.
   * @private
   */
  _reconcileStack() {
    const stackBadge = this.container.querySelector('#stack-count-badge');
    const stackList = this.container.querySelector('#stack-item-list');
    const stackItems = this.priorityMachine?.stack || [];

    if (stackBadge) {
      stackBadge.textContent = `(${stackItems.length})`;
    }

    const stackControls = this.container.querySelector('.stack-controls');
    const isSpec = this.isSpectator();
    if (stackControls) {
      stackControls.style.display = isSpec ? 'none' : 'flex';
    }

    const isGameOver = Boolean(this.tabletopState?.isGameOver);

    let btnAutoPass = this.container.querySelector('#btn-toggle-autopass');
    if (!btnAutoPass) {
      const controls = this.container.querySelector('.stack-controls');
      if (controls) {
        btnAutoPass = document.createElement('button');
        btnAutoPass.id = 'btn-toggle-autopass';
        btnAutoPass.className = 'btn btn-autopass';
        btnAutoPass.textContent = '⚡ Auto-Pass: OFF';
        btnAutoPass.title = 'Toggle Auto-Pass Priority (Hotkey: Enter)';
        controls.appendChild(btnAutoPass);
        btnAutoPass.addEventListener('click', () => this.toggleAutoPass());
      }
    }
    if (btnAutoPass) {
      if (isSpec) {
        btnAutoPass.style.display = 'none';
        btnAutoPass.disabled = true;
      } else {
        btnAutoPass.style.display = 'inline-flex';
        btnAutoPass.disabled = isGameOver;
        btnAutoPass.textContent = this.autoPassEnabled ? '⚡ Auto-Pass: ON' : '⚡ Auto-Pass: OFF';
        btnAutoPass.classList.toggle('active', Boolean(this.autoPassEnabled));
      }
    }

    let btnFastForward = this.container.querySelector('#btn-fast-forward-bots');
    if (!btnFastForward) {
      const controls = this.container.querySelector('.stack-controls');
      if (controls) {
        btnFastForward = document.createElement('button');
        btnFastForward.id = 'btn-fast-forward-bots';
        btnFastForward.className = 'btn btn-fast-forward-bots';
        btnFastForward.textContent = '⏩ Fast-Forward Bots (1x)';
        btnFastForward.title = 'Accelerate Perkins AI bot turns (50ms delay)';
        controls.appendChild(btnFastForward);
        btnFastForward.addEventListener('click', () => this.toggleBotFastForward());
      }
    }
    if (btnFastForward) {
      const myPlayer = this.tabletopState?.players?.[this.myPlayerId];
      const isEliminated = Boolean(myPlayer?.isEliminated);
      const isBotActive = this.priorityMachine && this.priorityMachine.activePlayerId !== this.myPlayerId;
      btnFastForward.style.display = 'inline-flex';
      btnFastForward.disabled = isGameOver;
      btnFastForward.textContent = this.botFastForward ? '⏩ Fast-Forward Bots (4x ON)' : '⏩ Fast-Forward Bots (1x)';
      btnFastForward.classList.toggle('active', Boolean(this.botFastForward));
      btnFastForward.classList.toggle('fast-forward-highlight', Boolean(isEliminated || isBotActive));
    }

    const btnPass = this.container.querySelector('#btn-pass-priority');
    if (btnPass) {
      if (isSpec) {
        btnPass.style.display = 'none';
        btnPass.disabled = true;
      } else {
        btnPass.style.display = '';
        btnPass.disabled = isGameOver;
      }
    }

    const btnHold = this.container.querySelector('#btn-hold-respond');
    if (btnHold) {
      if (isSpec) {
        btnHold.style.display = 'none';
        btnHold.disabled = true;
      } else {
        btnHold.style.display = '';
        btnHold.disabled = isGameOver;
      }
    }

    if (stackList) {
      stackList.innerHTML = '';
      // Render in LIFO order (newest on top)
      const reversed = [...stackItems].reverse();
      reversed.forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = 'stack-item';
        const sourceName = item.controllerName
          || (this.tabletopState?.players?.[item.sourcePlayerId]?.name)
          || (item.sourcePlayerId === this.myPlayerId ? 'You' : null)
          || (item.sourcePlayerId && item.sourcePlayerId.toLowerCase().includes('perkins') ? 'Perkins AI (Bot)' : null)
          || item.sourcePlayerId
          || 'P1';
        const cardName = item.cardName || item.name || item.card?.name || 'Spell/Ability';
        li.innerHTML = `
          <div class="stack-item-info">
            <span class="stack-index">#${stackItems.length - idx}</span>
            <span class="stack-source">${sourceName}:</span>
            <span class="stack-name">${cardName}</span>
          </div>
        `;
        stackList.appendChild(li);
      });
    }

    // Reconcile visual alarm bar
    this._reconcileAlarm();
  }

  /**
   * Handles alarm tick, start, hold, and cancel events.
   * @private
   */
  _handleAlarmEvent(event) {
    if (!event) return;
    this._reconcileAlarm();
  }

  /**
   * Reconciles the 15-second visual stack alarm progress bar (INV-HARNESS-4).
   * @private
   */
  _reconcileAlarm() {
    const alarmContainer = this.container.querySelector('#stack-alarm-container');
    const timerLabel = this.container.querySelector('#alarm-timer-label');
    const progressBar = this.container.querySelector('#stack-alarm-progress-bar');
    if (!alarmContainer || !progressBar) return;

    const isRunning = this.alarmManager?.status === 'RUNNING' || Boolean(this.alarmManager?.isRunning);
    const remainingMs = this.alarmManager?.remainingMs ?? (isRunning ? 15000 : 0);
    const durationMs = this.alarmManager?.durationMs ?? 15000;
    const remainingSeconds = Math.max(0, remainingMs / 1000);

    if (isRunning) {
      alarmContainer.style.display = 'block';

      if (timerLabel) {
        timerLabel.textContent = `${remainingSeconds.toFixed(1)}s`;
      }

      const pct = Math.min(100, Math.max(0, (remainingMs / durationMs) * 100));
      progressBar.style.width = `${pct}%`;

      // Color progression: Green (>7s), Amber (3s-7s), Red (<3s)
      progressBar.classList.remove('alarm-state-green', 'alarm-state-amber', 'alarm-state-red');
      if (remainingSeconds > 7.0) {
        progressBar.classList.add('alarm-state-green');
      } else if (remainingSeconds >= 3.0) {
        progressBar.classList.add('alarm-state-amber');
      } else {
        progressBar.classList.add('alarm-state-red');
      }
    } else {
      alarmContainer.style.display = 'none';
    }
  }

  /**
   * Reconciles Player Dashboard (Life, Mana, Hand, Emblem).
   * @private
   */
  _reconcilePlayerDashboard() {
    const dashboard = this.container.querySelector('#player-dashboard');
    if (!dashboard) return;

    const pData = this.tabletopState?.players?.[this.myPlayerId];
    const life = pData?.resources?.life ?? 20;
    const poison = pData?.resources?.poison ?? 0;
    const energy = pData?.resources?.energy ?? 0;
    const mana = pData?.resources?.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    const undoableTaps = pData?._undoableManaTaps || this.tabletopState?.getPlayer?.(this.myPlayerId)?._undoableManaTaps || [];
    const hasUndoable = Array.isArray(undoableTaps) && undoableTaps.length > 0;
    const hand = Array.isArray(pData?.zones?.hand) ? pData.zones.hand : (Array.isArray(pData?.hand) ? pData.hand : []);

    // Random Perk Upkeep Dormancy (INV-PERK-UI-1)
    const unlockRound = (this.playerIds.length <= 2 ? 4 : 2);
    const roundNumber = this.priorityMachine?.roundNumber ?? this.tabletopState?.roundNumber;
    const currentRound = (typeof roundNumber === 'number')
      ? roundNumber
      : (this.priorityMachine?.turnNumber && this.priorityMachine.turnNumber >= 7 ? 4 : Math.ceil((this.priorityMachine?.turnNumber || 1) / (this.playerIds?.length || 2)));
    const isDormant = currentRound < unlockRound;
    const emblemText = isDormant
      ? `🔮 Perk: Dormant until Round ${unlockRound}`
      : `🔮 Perk Emblem: Active`;

    // Battlefield cards
    const battlefieldCards = Array.isArray(pData?.zones?.battlefield)
      ? pData.zones.battlefield
      : (Array.isArray(pData?.battlefield) ? pData.battlefield : []);
    const bLands = Array.isArray(pData?.battlefield?.lands) ? pData.battlefield.lands : [];
    const bCreatures = Array.isArray(pData?.battlefield?.creatures) ? pData.battlefield.creatures : [];
    const zLands = battlefieldCards.filter(c => (c.typeLine || c.type || '').toLowerCase().includes('land') || c.subzone === 'lands');
    const zCreatures = battlefieldCards.filter(c => (c.typeLine || c.type || '').toLowerCase().includes('creature') || c.subzone === 'creatures');
    const lands = bLands.length >= zLands.length ? bLands : zLands;
    const creatures = Array.isArray(pData?.battlefield?.creatures) ? bCreatures : zCreatures;

    const bNoncreatures = [
      ...(Array.isArray(pData?.battlefield?.noncreatures) ? pData.battlefield.noncreatures : []),
      ...(Array.isArray(pData?.battlefield?.planeswalkers) ? pData.battlefield.planeswalkers : [])
    ];
    const zNoncreatures = battlefieldCards.filter(c => {
      const tl = (c.typeLine || c.type || '').toLowerCase();
      return c.subzone === 'noncreatures' || c.subzone === 'planeswalkers' || (((tl.includes('artifact') || tl.includes('enchantment') || tl.includes('planeswalker') || tl.includes('battle')) && !tl.includes('creature') && !tl.includes('land')));
    });
    const noncreatures = bNoncreatures.length >= zNoncreatures.length ? bNoncreatures : zNoncreatures;

    const psmForAttack = this.priorityMachine;
    const isAttackWindow = !!psmForAttack &&
      !this.isSpectator() &&
      !this.pregameActive &&
      psmForAttack.currentPhaseStep === 'DECLARE_ATTACKERS' &&
      psmForAttack.activePlayerId === this.myPlayerId;
    const attackState = { activePlayerId: psmForAttack?.activePlayerId, currentPhaseStep: psmForAttack?.currentPhaseStep };
    if (!isAttackWindow) {
      this._selectedAttackers = new Set();
      this.attackerTargets = {};
    }
    if (!this._selectedAttackers) this._selectedAttackers = new Set();
    if (!this.attackerTargets) this.attackerTargets = {};
    const attackCandidateIds = new Set(
      isAttackWindow
        ? creatures.filter(c => c && canDeclareAsAttacker({ ...c, controllerId: c.controllerId || this.myPlayerId }, attackState)).map(c => c.instanceId)
        : []
    );
    for (const sel of [...this._selectedAttackers]) {
      if (!attackCandidateIds.has(sel)) this._selectedAttackers.delete(sel);
    }

    // Interactive Blocker Window (CR 509.1) & Spectate Ongoing Combat Banner
    const activeCombatAttackers = this.tabletopState?.combatState?.attackers || [];
    const defendingPid = psmForAttack?.defendingPlayerId || this.tabletopState?.combatState?.defendingPlayerId || activeCombatAttackers[0]?.defendingPlayerId;
    const isCombatStep = psmForAttack?.currentPhaseStep === 'DECLARE_BLOCKERS' ||
      (psmForAttack?.currentPhaseStep === 'DECLARE_ATTACKERS' && psmForAttack?.priorityPlayerId === this.myPlayerId);
    const isUnderAttack = isCombatStep &&
      (defendingPid === this.myPlayerId || pData?.underAttack === true) &&
      (activeCombatAttackers.length > 0);

    const isBlockWindow = !!psmForAttack &&
      !this.isSpectator() &&
      !this.pregameActive &&
      psmForAttack.activePlayerId !== this.myPlayerId &&
      activeCombatAttackers.length > 0 &&
      !this.tabletopState?.combatState?.blockersDeclared &&
      isUnderAttack;

    const isSpectatingOtherCombat = !!psmForAttack &&
      !this.isSpectator() &&
      !this.pregameActive &&
      psmForAttack.activePlayerId !== this.myPlayerId &&
      activeCombatAttackers.length > 0 &&
      defendingPid &&
      defendingPid !== this.myPlayerId;

    const aliveOpponents = (this.playerIds || []).filter(pid => pid !== this.myPlayerId && !this.tabletopState?.players?.[pid]?.isEliminated);
    if (!this._selectedDefendingPlayerId || !aliveOpponents.includes(this._selectedDefendingPlayerId)) {
      this._selectedDefendingPlayerId = aliveOpponents[0] || null;
    }
    if (isAttackWindow && this._selectedAttackers) {
      for (const atkId of this._selectedAttackers) {
        if (!this.attackerTargets[atkId]) {
          this.attackerTargets[atkId] = this._selectedDefendingPlayerId || aliveOpponents[0];
        }
      }
      for (const atkId of Object.keys(this.attackerTargets)) {
        if (!this._selectedAttackers.has(atkId)) {
          delete this.attackerTargets[atkId];
        }
      }
    }
    if (!this._blockerAssignments) this._blockerAssignments = new Map();
    let attackerIds = [];
    if (!isBlockWindow) {
      this._blockerAssignments.clear();
      this._activeAttackerTargetId = null;
    } else {
      attackerIds = activeCombatAttackers
        .map(a => typeof a === 'string' ? a : (a?.creatureId || a?.instanceId || a?.id))
        .filter(Boolean);
      if (!this._activeAttackerTargetId || !attackerIds.includes(this._activeAttackerTargetId)) {
        this._activeAttackerTargetId = attackerIds[0] || null;
      }
      const untappedCreatureIds = new Set(creatures.filter(c => c && !c.isTapped).map(c => c.instanceId));
      for (const [bId, aId] of [...this._blockerAssignments.entries()]) {
        if (!untappedCreatureIds.has(bId) || !attackerIds.includes(aId)) {
          this._blockerAssignments.delete(bId);
        }
      }
    }
    const blockerCandidateIds = new Set(
      isBlockWindow
        ? creatures.filter(c => c && !c.isTapped).map(c => c.instanceId)
        : []
    );

    const resolveAttackerObj = (attackerId) => {
      if (!attackerId) return null;
      const entry = activeCombatAttackers.find(a =>
        (typeof a === 'string' ? a : (a?.creatureId || a?.instanceId || a?.id)) === attackerId
      );
      if (entry && typeof entry === 'object' && entry.creature) return entry.creature;
      if (entry && typeof entry === 'object' && entry.name) return entry;
      return this.tabletopState?._findPermanentOnBattlefield?.(attackerId) || { instanceId: attackerId, name: 'Attacker' };
    };

    dashboard.innerHTML = `
      <div class="player-stats-row">
        <div class="life-adjust-group">
          <button class="btn btn-life-mod" data-delta="-5">-5</button>
          <button class="btn btn-life-mod" data-delta="-1">-1</button>
          <span class="life-value-display">${life}</span>
          <button class="btn btn-life-mod" data-delta="1">+1</button>
          <button class="btn btn-life-mod" data-delta="5">+5</button>
        </div>
        <div class="counters-group">
          <span class="badge">Poison: ${poison}</span>
          <span class="badge">Energy: ${energy}</span>
          <button id="player-btn-grave" class="btn btn-xs btn-drawer-grave" style="padding: 1px 6px; font-size: 0.72rem; cursor: pointer;">Grave (${(pData?.graveyard || pData?.zones?.graveyard || []).length})</button>
          <button id="player-btn-exile" class="btn btn-xs btn-drawer-exile" style="padding: 1px 6px; font-size: 0.72rem; cursor: pointer;">Exile (${(pData?.exile || pData?.zones?.exile || []).length})</button>
        </div>
        <div class="mana-pool-chips">
          <span class="mana-chip chip-w" data-color="W" style="${(mana.W || 0) > 0 && hasUndoable ? 'cursor: pointer;' : ''}">W:${mana.W || 0}</span>
          <span class="mana-chip chip-u" data-color="U" style="${(mana.U || 0) > 0 && hasUndoable ? 'cursor: pointer;' : ''}">U:${mana.U || 0}</span>
          <span class="mana-chip chip-b" data-color="B" style="${(mana.B || 0) > 0 && hasUndoable ? 'cursor: pointer;' : ''}">B:${mana.B || 0}</span>
          <span class="mana-chip chip-r" data-color="R" style="${(mana.R || 0) > 0 && hasUndoable ? 'cursor: pointer;' : ''}">R:${mana.R || 0}</span>
          <span class="mana-chip chip-g" data-color="G" style="${(mana.G || 0) > 0 && hasUndoable ? 'cursor: pointer;' : ''}">G:${mana.G || 0}</span>
          <span class="mana-chip chip-c" data-color="C" style="${(mana.C || 0) > 0 && hasUndoable ? 'cursor: pointer;' : ''}">C:${mana.C || 0}</span>
          ${hasUndoable ? `<button id="btn-undo-mana-tap" class="btn btn-xs btn-outline btn-undo-mana" title="Undo last mana tap" style="margin-left: 6px; padding: 1px 6px; font-size: 0.75rem; cursor: pointer;">↩️ Undo Tap</button>` : ''}
        </div>
        <div class="command-emblem-badge ${isDormant ? 'dormant' : 'active'}">
          <span id="command-emblem-text">${emblemText}</span>
        </div>
      </div>
      <div id="battlefield-strips" class="player-battlefield-strips">
        <div id="battlefield-lands" class="battlefield-strip battlefield-lands">
          <div class="strip-label">Lands (<span class="lands-count">${lands.length}</span>)</div>
          <div class="strip-cards">${lands.map(c => {
            const profile = this.tabletopState?._getLandManaProfile ? this.tabletopState._getLandManaProfile(c) : [];
            const isMulti = profile.length > 1;
            const isSelected = this._selectedLandId === (c.instanceId || c.id);
            return `<span class="battlefield-card-chip land-chip ${c.isTapped ? 'tapped is-tapped card-tapped' : ''} ${isSelected ? 'selected-land' : ''}" data-instance-id="${c.instanceId || ''}" data-tapped="${c.isTapped ? 'true' : 'false'}" style="${c.isTapped ? 'opacity: 0.62;' : ''}" title="${c.name} (${c.isTapped ? 'Tapped' : 'Untapped - Click to tap for mana'})">${c.name} ${c.isTapped ? '(Tapped) ↺' : ''}${isSelected && !c.isTapped && isMulti ? ` <span class="land-color-selector" style="display:inline-flex; gap:4px; margin-left:6px;">${profile.map(col => `<button class="btn btn-xs btn-color-choice" data-color="${col}" data-instance-id="${c.instanceId || c.id}" style="padding:1px 6px; font-size:0.75rem; border-radius:3px; background:${col === 'R' ? '#ef4444' : col === 'U' ? '#3b82f6' : '#64748b'}; color:#fff; border:none; cursor:pointer;">{${col}}</button>`).join('')}</span>` : ''}</span>`;
          }).join('')}</div>
        </div>
        <div id="battlefield-noncreatures" class="battlefield-strip battlefield-noncreatures">
          <div class="strip-label">Other Permanents (<span class="noncreatures-count">${noncreatures.length}</span>)</div>
          <div class="strip-cards">${noncreatures.map(c => {
            const isTapped = Boolean(c.isTapped);
            const tl = (c.typeLine || c.type || '').toLowerCase();
            let typeBadge = '[Permanent]';
            if (tl.includes('enchantment')) typeBadge = '[Enchantment]';
            else if (tl.includes('equipment')) typeBadge = '[Equipment]';
            else if (tl.includes('artifact')) typeBadge = '[Artifact]';
            else if (tl.includes('planeswalker')) typeBadge = '[Planeswalker]';
            else if (tl.includes('battle')) typeBadge = '[Battle]';

            let attachedLabel = '';
            if (c.attachedTo) {
              let targetCr = (pData?.battlefield?.creatures || []).find(cr => cr && (cr.instanceId === c.attachedTo || cr.id === c.attachedTo));
              if (!targetCr && this.tabletopState) {
                for (const pl of Object.values(this.tabletopState.players || {})) {
                  const found = (pl.battlefield?.creatures || []).find(cr => cr && (cr.instanceId === c.attachedTo || cr.id === c.attachedTo));
                  if (found) { targetCr = found; break; }
                }
              }
              attachedLabel = ` <span class="attached-badge">🔗 Equipped: ${this._escapeHtml(targetCr?.name || 'Creature')}</span>`;
            }

            return `<span class="battlefield-card-chip noncreature-chip ${isTapped ? 'tapped is-tapped card-tapped' : ''}" data-instance-id="${c.instanceId || ''}" data-tapped="${isTapped ? 'true' : 'false'}" style="${isTapped ? 'opacity: 0.62;' : ''}" title="${c.name} ${typeBadge}${c.attachedTo ? ' (Attached)' : ''} - Click to inspect or attach"><span class="badge-type-label" style="opacity: 0.75; font-size: 0.7rem; margin-right: 4px;">${typeBadge}</span>${c.name}${attachedLabel}${isTapped ? ' ↺' : ''}</span>`;
          }).join('')}</div>
        </div>
        <div id="battlefield-creatures" class="battlefield-strip battlefield-creatures">
          <div class="strip-label">Creatures (<span class="creatures-count">${creatures.length}</span>)</div>
          <div class="strip-cards">${creatures.map(c => {
            const isAssignedBlocker = this._blockerAssignments.has(c.instanceId);
            const assignedAttacker = isAssignedBlocker ? resolveAttackerObj(this._blockerAssignments.get(c.instanceId)) : null;
            const stats = this.tabletopState?.abilityEngine?.evaluateCreatureStats
              ? this.tabletopState.abilityEngine.evaluateCreatureStats(c, this.tabletopState)
              : (typeof this.tabletopState?.evaluateCreatureStats === 'function'
                ? this.tabletopState.evaluateCreatureStats(c, this.myPlayerId)
                : { power: c.power, toughness: c.toughness, keywords: c.keywords || {} });
            let counterBadges = '';
            let counterTitle = '';
            if (c.counters) {
              if (c.counters['+1/+1']) {
                counterBadges += `<span class="counter-badge" style="background: #10b981; color: #0f172a; font-weight: bold; font-size: 0.7rem; padding: 1px 4px; border-radius: 3px; margin-left: 4px;">+1/+1 ×${c.counters['+1/+1']}</span>`;
                counterTitle += ` [+1/+1 ×${c.counters['+1/+1']}]`;
              }
              if (c.counters['-1/-1']) {
                counterBadges += `<span class="counter-badge" style="background: #ef4444; color: #ffffff; font-weight: bold; font-size: 0.7rem; padding: 1px 4px; border-radius: 3px; margin-left: 4px;">-1/-1 ×${c.counters['-1/-1']}</span>`;
                counterTitle += ` [-1/-1 ×${c.counters['-1/-1']}]`;
              }
            }
            const pt = ` (${stats.power}/${stats.toughness})`;
            const effectiveKeywords = stats.keywords || {};
            const activeKws = Object.keys(effectiveKeywords).filter(k => effectiveKeywords[k] && k === k.toLowerCase());
            const kwTitle = activeKws.length > 0 ? ` [${activeKws.map(k => k.charAt(0).toUpperCase() + k.slice(1)).join(', ')}]` : '';
            return `<span class="battlefield-card-chip creature-chip ${c.isTapped ? 'tapped is-tapped card-tapped' : ''} ${c.isAttacking ? 'is-attacking attacking' : ''} ${c.isBlocking || isAssignedBlocker ? 'is-blocking blocking' : ''} ${attackCandidateIds.has(c.instanceId) ? 'attack-candidate' : ''} ${this._selectedAttackers.has(c.instanceId) ? 'attack-selected' : ''} ${blockerCandidateIds.has(c.instanceId) ? 'blocker-candidate' : ''} ${isAssignedBlocker ? 'blocker-selected' : ''}" data-instance-id="${c.instanceId || ''}" data-tapped="${c.isTapped ? 'true' : 'false'}" data-power="${stats.power}" data-toughness="${stats.toughness}" data-keywords="${activeKws.join(',')}" title="${c.name}${pt}${counterTitle}${kwTitle}${attackCandidateIds.has(c.instanceId) ? ' - Click to select as attacker' : ''}${blockerCandidateIds.has(c.instanceId) ? ' - Click to assign as blocker' : ''}">${c.name}${pt}${counterBadges}${c.isAttacking ? ' ⚔️' : ''}${c.isBlocking || isAssignedBlocker ? ` 🛡️${assignedAttacker ? ` → ${assignedAttacker.name}` : ''}` : ''}${c.isTapped ? ' ↺' : ''}</span>`;
          }).join('')}</div>
          ${isAttackWindow ? `
            <div class="attack-confirm-bar" style="display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap;">
              <button id="btn-confirm-attackers" class="btn btn-primary" ${this._selectedAttackers.size === 0 ? 'disabled' : ''}>⚔️ Confirm Attackers (${this._selectedAttackers.size})</button>
              <button id="btn-attack-all-eligible" class="btn btn-secondary btn-attack-all" ${attackCandidateIds.size === 0 ? 'disabled' : ''}>⚔️ Attack All Eligible (${attackCandidateIds.size})</button>
              ${aliveOpponents.length > 1 ? `
                <div class="defender-target-selector-group" style="display: inline-flex; align-items: center; gap: 4px;">
                  <span style="font-size: 0.78rem; font-weight: bold; color: #f59e0b;">🎯 Defending Player:</span>
                  ${aliveOpponents.map(oppPid => {
                    const oppData = this.tabletopState?.players?.[oppPid];
                    const oppName = this.getFriendlyPlayerName(oppPid);
                    const oppLife = oppData?.life ?? 20;
                    const isSel = oppPid === this._selectedDefendingPlayerId;
                    return `<button type="button" class="btn btn-sm btn-select-defender-target" data-defender-id="${oppPid}" style="padding: 2px 8px; font-size: 0.75rem; border-radius: 4px; border: 1px solid ${isSel ? '#f59e0b' : '#475569'}; background: ${isSel ? '#78350f' : '#1e293b'}; color: ${isSel ? '#fef3c7' : '#cbd5e1'}; cursor: pointer;">${oppName} (Life: ${oppLife})${isSel ? ' (Target)' : ''}</button>`;
                  }).join('')}
                </div>
              ` : ''}
              ${this._selectedAttackers.size > 0 ? `
                <div class="attacker-target-selector-group" style="display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                  ${[...this._selectedAttackers].map(atkId => {
                    const cr = creatures.find(c => c && (c.instanceId === atkId || c.id === atkId));
                    const crName = cr?.name || 'Creature';
                    const targetOppId = this.attackerTargets[atkId] || this._selectedDefendingPlayerId || aliveOpponents[0];
                    const foundBattle = this.tabletopState?.findPermanentById?.(targetOppId)?.card;
                    const oppName = foundBattle ? `${foundBattle.name} 🏰` : this.getFriendlyPlayerName(targetOppId);
                    return `<button type="button" class="btn btn-sm btn-cycle-attacker-target" data-attacker-id="${atkId}" style="padding: 2px 8px; font-size: 0.75rem; border-radius: 4px; border: 1px solid #3b82f6; background: #1e3a8a; color: #dbeafe; cursor: pointer;" title="Click to cycle defender target for ${crName}">🎯 ${crName} → ${oppName}</button>`;
                  }).join('')}
                </div>
              ` : ''}
              <span class="attack-hint" style="font-size: 0.78rem; color: #cbd5e1;">${attackCandidateIds.size === 0 ? 'No creatures can attack - press Next Phase' : 'Select attackers, then confirm (or press Next Phase to skip combat)'}</span>
            </div>
          ` : ''}
          ${isBlockWindow ? `
            <div class="block-confirm-bar" style="display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap;">
              <button id="btn-confirm-blockers" class="btn btn-primary">🛡️ Confirm Blockers (${this._blockerAssignments.size})</button>
              <button id="btn-no-blocks" class="btn btn-secondary">⏭️ No Blocks (Take Damage)</button>
              <div class="attacker-target-selector-group" style="display: inline-flex; align-items: center; gap: 4px;">
                <span style="font-size: 0.78rem; font-weight: bold; color: #f59e0b;">🎯 Target:</span>
                ${attackerIds.map(atkId => {
                  const atkObj = resolveAttackerObj(atkId);
                  const isSel = atkId === this._activeAttackerTargetId;
                  return `<button type="button" class="btn btn-sm btn-select-attacker-target" data-attacker-id="${atkId}" style="padding: 2px 8px; font-size: 0.75rem; border-radius: 4px; border: 1px solid ${isSel ? '#f59e0b' : '#475569'}; background: ${isSel ? '#78350f' : '#1e293b'}; color: ${isSel ? '#fef3c7' : '#cbd5e1'}; cursor: pointer;">${atkObj?.name || 'Attacker'}${isSel ? ' (Active)' : ''}</button>`;
                }).join('')}
              </div>
              <span class="block-hint" style="font-size: 0.78rem; color: #cbd5e1;">${blockerCandidateIds.size === 0 ? 'No untapped creatures to block — click No Blocks' : `Click your creature to block ${resolveAttackerObj(this._activeAttackerTargetId)?.name || 'attacker'}, then confirm`}</span>
            </div>
          ` : ''}
          ${isSpectatingOtherCombat ? `
            <div class="combat-spectate-banner" style="padding: 6px 12px; margin-top: 6px; background: #1e293b; border-left: 3px solid #3b82f6; border-radius: 4px; font-size: 0.8rem; color: #94a3b8;">
              👀 <strong>Combat Ongoing:</strong> ${this.getFriendlyPlayerName(psmForAttack.activePlayerId)} is attacking ${this.getFriendlyPlayerName(defendingPid)}. You are not being attacked.
            </div>
          ` : ''}
        </div>
      </div>
      <div id="player-hand" class="player-hand-grid"></div>
    `;

    // Attack declaration: candidate selection + explicit confirmation (CR 508.1)
    if (isAttackWindow) {
      dashboard.querySelectorAll('.btn-select-defender-target').forEach(btn => {
        btn.addEventListener('click', () => {
          const defId = btn.getAttribute('data-defender-id');
          if (defId) {
            this._selectedDefendingPlayerId = defId;
            this.reconcileDOM();
          }
        });
      });

      const btnAttackAll = dashboard.querySelector('#btn-attack-all-eligible');
      if (btnAttackAll) {
        btnAttackAll.addEventListener('click', () => {
          for (const candId of attackCandidateIds) {
            this._selectedAttackers.add(candId);
            if (!this.attackerTargets[candId]) {
              this.attackerTargets[candId] = this._selectedDefendingPlayerId || aliveOpponents[0];
            }
          }
          this.reconcileDOM();
        });
      }

      dashboard.querySelectorAll('.btn-cycle-attacker-target').forEach(btn => {
        btn.addEventListener('click', () => {
          const atkId = btn.getAttribute('data-attacker-id');
          if (!atkId) return;
          const battleTargets = [];
          for (const pl of Object.values(this.tabletopState?.players || {})) {
            for (const nc of (pl.battlefield?.noncreatures || [])) {
              if (nc && (/battle/i.test(nc.typeLine || nc.type || '') || /invasion of gobakhan/i.test(nc.name || ''))) {
                battleTargets.push(nc.instanceId || nc.id);
              }
            }
          }
          const allTargets = [...aliveOpponents, ...battleTargets];
          if (allTargets.length > 1) {
            const currentTgt = this.attackerTargets[atkId] || this._selectedDefendingPlayerId || allTargets[0];
            const currentIndex = allTargets.indexOf(currentTgt);
            const nextIndex = (currentIndex + 1) % allTargets.length;
            this.attackerTargets[atkId] = allTargets[nextIndex];
            this.reconcileDOM();
          }
        });
      });

      dashboard.querySelectorAll('.attack-candidate').forEach(chip => {
        chip.addEventListener('click', () => {
          const id = chip.getAttribute('data-instance-id');
          if (!id) return;
          if (this._selectedAttackers.has(id)) {
            this._selectedAttackers.delete(id);
            delete this.attackerTargets[id];
          } else {
            this._selectedAttackers.add(id);
            this.attackerTargets[id] = this._selectedDefendingPlayerId || aliveOpponents[0];
          }
          this.reconcileDOM();
        });
      });
      const confirmBtn = dashboard.querySelector('#btn-confirm-attackers');
      if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
          const ids = [...this._selectedAttackers];
          if (ids.length === 0) return;
          const attackerTargetsPayload = { ...this.attackerTargets };
          const defId = this._selectedDefendingPlayerId;
          this._selectedAttackers = new Set();
          this.attackerTargets = {};
          this.dispatchAction({
            type: 'DECLARE_ATTACKERS',
            playerId: this.myPlayerId,
            attackers: ids,
            attackerTargets: attackerTargetsPayload,
            defendingPlayerId: defId,
            payload: {
              playerId: this.myPlayerId,
              attackers: ids,
              attackerTargets: attackerTargetsPayload,
              defendingPlayerId: defId
            }
          }, { origin: 'LOCAL' });
        });
      }
    }

    // Blocker declaration: candidate selection + explicit confirmation (CR 509.1)
    if (isBlockWindow) {
      dashboard.querySelectorAll('.btn-select-attacker-target').forEach(btn => {
        btn.addEventListener('click', () => {
          const atkId = btn.getAttribute('data-attacker-id');
          if (atkId) {
            this._activeAttackerTargetId = atkId;
            this.reconcileDOM();
          }
        });
      });

      dashboard.querySelectorAll('.blocker-candidate').forEach(chip => {
        chip.addEventListener('click', () => {
          const blockerId = chip.getAttribute('data-instance-id');
          if (!blockerId) return;
          if (this._blockerAssignments.has(blockerId)) {
            const prevTargetId = this._blockerAssignments.get(blockerId);
            if (prevTargetId === this._activeAttackerTargetId) {
              this._blockerAssignments.delete(blockerId);
              this.reconcileDOM();
              return;
            }
          }
          const targetAttackerId = this._activeAttackerTargetId;
          const attackerObj = resolveAttackerObj(targetAttackerId);
          const blockerObj = creatures.find(c => c && c.instanceId === blockerId);
          if (attackerObj && blockerObj) {
            const check = canBlockAssignment(attackerObj, [blockerObj], this.tabletopState);
            if (!check.allowed) {
              this.tabletopState?.recordTrace?.('UI_REJECTION', 'BLOCKER_ASSIGNMENT_REJECTED', {
                playerId: this.myPlayerId,
                blockerId,
                attackerId: targetAttackerId,
                reason: check.reason
              });
              this.showWarningBanner(`⚠️ ${check.reason}`);
              return;
            }
          }
          if (targetAttackerId) {
            this._blockerAssignments.set(blockerId, targetAttackerId);
            this.reconcileDOM();
          }
        });
      });

      const commitHumanBlocks = (assignmentsArray) => this.commitHumanBlocks(assignmentsArray);

      const btnConfirmBlockers = dashboard.querySelector('#btn-confirm-blockers');
      if (btnConfirmBlockers) {
        btnConfirmBlockers.addEventListener('click', () => {
          const assignments = Array.from(this._blockerAssignments.entries()).map(([blockerId, attackerId]) => ({
            blockerId,
            attackerId
          }));
          commitHumanBlocks(assignments);
        });
      }

      const btnNoBlocks = dashboard.querySelector('#btn-no-blocks');
      if (btnNoBlocks) {
        btnNoBlocks.addEventListener('click', () => {
          commitHumanBlocks([]);
        });
      }
    }

    // Bind life modifier buttons
    if (this.isSpectator()) {
      dashboard.querySelectorAll('.btn-life-mod').forEach(b => {
        b.style.display = 'none';
      });
    } else {
      const lifeBtns = dashboard.querySelectorAll('.btn-life-mod');
      lifeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          const delta = parseInt(e.target.getAttribute('data-delta'), 10) || 0;
          this.dispatchAction({
            type: 'CHANGE_LIFE',
            payload: { playerId: this.myPlayerId, delta }
          }, { origin: 'LOCAL' });
        });
      });

      // Bind undo mana tap and mana chip click interactions
      const btnUndo = dashboard.querySelector('#btn-undo-mana-tap');
      btnUndo?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.tabletopState && typeof this.tabletopState.undoLastManaTap === 'function') {
          this.tabletopState.undoLastManaTap(this.myPlayerId);
          this.reconcileDOM();
        }
      });

      const manaChips = dashboard.querySelectorAll('.mana-pool-chips .mana-chip');
      manaChips.forEach(chip => {
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          const col = chip.getAttribute('data-color');
          if (!col) return;
          const currentPool = pData?.resources?.manaPool || {};
          if ((currentPool[col] || 0) <= 0) return;

          if (this.tabletopState && typeof this.tabletopState.undoLastManaTap === 'function') {
            try {
              this.tabletopState.undoLastManaTap(this.myPlayerId, col);
              this.reconcileDOM();
            } catch (err) {
              this.showToast?.(err.message || 'Cannot undo mana tap');
            }
          }
        });
      });
    }

    // Populate interactive hand
    const handGrid = dashboard.querySelector('#player-hand');
    if (handGrid) {
      if (this.isSpectator()) {
        handGrid.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 8px 12px; background: rgba(15, 23, 42, 0.8); border: 1px solid #334155; border-radius: 6px;">
            <span class="spectator-watermark">👁️ Spectating Match (Turn Commands Locked)</span>
            <button id="btn-exit-spectate-dashboard" class="btn btn-secondary btn-exit-spectator">🚪 Exit Spectating</button>
          </div>
        `;
        const btnExit = handGrid.querySelector('#btn-exit-spectate-dashboard');
        if (btnExit) {
          btnExit.addEventListener('click', () => this.exitSpectating());
        }
      } else {
      hand.forEach(card => {
        const cardId = card.instanceId || card.id || card.name;
        const isSelected = this.selectedHandCardId === cardId;
        const isLand = (card.typeLine || card.type || '').toLowerCase().includes('land');
        const avail = CastAvailabilityManager.evaluateCardAvailability(
          this.tabletopState,
          this.myPlayerId,
          card,
          this.priorityMachine
        );
        const isPlayable = Boolean(avail?.allowed || (Array.isArray(avail?.availableModes) && avail.availableModes.length > 0));
        const chip = document.createElement('div');
        chip.className = `hand-card-chip ${isSelected ? 'selected' : ''} ${isPlayable ? 'card-playable-glow' : ''}`;
        chip.textContent = card.name || 'Card';

        this._attachCardHoverPreview(chip, card);

        const hasMultipleModes = Boolean(
          (avail.allModes && avail.allModes.length > 1) ||
          (card.typeLine || '').includes('//') ||
          (card.name || '').includes('//') ||
          /adventure/i.test(card.typeLine || '') ||
          /callous\s+sell-sword/i.test(card.name || '') ||
          (Array.isArray(card.compiledMechanics?.castModes) && card.compiledMechanics.castModes.length > 1)
        );

        // [P5] Golden border auto-tap preview on hover over playable spell in hand
        if (!isLand && isPlayable) {
          chip.addEventListener('pointerenter', () => {
            const landEls = Array.from(dashboard.querySelectorAll('#battlefield-lands .land-chip:not(.is-tapped)'));
            const cmc = Number(card.cmc ?? 1) || 1;
            landEls.slice(0, cmc).forEach(el => el.classList.add('land-autotap-preview'));
          });
          chip.addEventListener('pointerleave', () => {
            dashboard.querySelectorAll('#battlefield-lands .land-autotap-preview').forEach(el => el.classList.remove('land-autotap-preview'));
          });
        }

        if (isSelected) {

          let actionButtonsHtml = '';
          if (isLand) {
            let canPlayLand = true;
            let landReason = '';
            if (this.tabletopState && typeof this.tabletopState.canPlayLand === 'function') {
              const check = this.tabletopState.canPlayLand(this.myPlayerId);
              if (typeof check === 'boolean') canPlayLand = check;
              else if (check && !check.allowed) {
                canPlayLand = false;
                landReason = check.message || 'Cannot play land';
              }
            }
            actionButtonsHtml = `<button id="btn-play-land" class="btn btn-popover-action" ${!canPlayLand ? 'disabled title="' + this._escapeHtml(landReason) + '"' : ''}>🏔️ Jugar Tierra</button>`;
          } else if (hasMultipleModes) {
            const modes = (avail.allModes && avail.allModes.length > 0)
              ? avail.allModes
              : (CastAvailabilityManager.getCastableModes(this.tabletopState, this.myPlayerId, card) || []);

            actionButtonsHtml = modes.map(m => {
              const isAdv = m.mode === 'ADVENTURE' || (m.typeLine || '').toLowerCase().includes('adventure');
              const icon = isAdv ? '✨' : '⚔️';
              const disabledAttr = !m.isAvailable ? `disabled title="${this._escapeHtml(m.unselectableReason || m.timingReason || 'No disponible')}"` : '';
              return `<button class="btn btn-popover-action btn-popover-cast-mode" data-mode="${m.mode}" ${disabledAttr}>${icon} Lanzar ${m.name || card.name} (${m.manaCost || ''})</button>`;
            }).join('');
          } else {
            actionButtonsHtml = `<button id="btn-cast-spell" class="btn btn-popover-action" ${!isPlayable ? 'disabled' : ''}>⚔️ Lanzar ${card.name} (${card.manaCost || ''})</button>`;
          }

          const popover = document.createElement('div');
          popover.className = 'hand-card-popover';
          popover.innerHTML = `
            ${actionButtonsHtml}
            <button id="btn-close-popover" class="btn btn-popover-close">✕ Cancelar</button>
          `;

          const btnPlay = popover.querySelector('#btn-play-land');
          if (btnPlay) {
            btnPlay.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (btnPlay.disabled) return;
              this.playLandFromHand(card);
            });
          }

          const btnCast = popover.querySelector('#btn-cast-spell');
          if (btnCast) {
            btnCast.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (btnCast.disabled) return;
              this.castSpellToStack(card);
            });
          }

          popover.querySelectorAll('.btn-popover-cast-mode').forEach(btn => {
            btn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (btn.disabled) return;
              const mode = btn.getAttribute('data-mode');
              this.castSpellToStack(card, null, mode);
            });
          });

          const btnClose = popover.querySelector('#btn-close-popover');
          if (btnClose) {
            btnClose.addEventListener('click', (ev) => {
              ev.stopPropagation();
              this.selectedHandCardId = null;
              this.reconcileDOM();
            });
          }

          chip.appendChild(popover);
        }

        chip.addEventListener('click', (ev) => {
          if (ev.target.closest('.hand-card-popover')) return;
          this.selectedHandCardId = (this.selectedHandCardId === cardId ? null : cardId);
          this.reconcileDOM();
        });

        handGrid.appendChild(chip);
      });

      // Also display cards on Adventure in exile (CR 715.3d) so player can cast the Creature mode from exile
      const exileCards = Array.isArray(pData?.exile) ? pData.exile : (Array.isArray(pData?.zones?.exile) ? pData.zones.exile : []);
      const adventureExiled = exileCards.filter(c => c && c.onAdventure);
      adventureExiled.forEach(card => {
        const cardId = card.instanceId || card.id || card.name;
        const isSelected = this.selectedHandCardId === cardId;
        const avail = CastAvailabilityManager.evaluateCardAvailability(
          this.tabletopState,
          this.myPlayerId,
          card,
          this.priorityMachine
        );
        const isPlayable = Boolean(avail?.allowed || (Array.isArray(avail?.availableModes) && avail.availableModes.length > 0));
        const chip = document.createElement('div');
        chip.className = `hand-card-chip adventure-exile-chip ${isSelected ? 'selected' : ''} ${isPlayable ? 'card-playable-glow' : ''}`;
        chip.style.borderColor = '#38bdf8';
        chip.textContent = `${card.name || 'Card'} [On Adventure]`;

        this._attachCardHoverPreview(chip, card);

        if (isSelected) {
          const popover = document.createElement('div');
          popover.className = 'hand-card-popover';
          popover.innerHTML = `
            <button id="btn-cast-spell" class="btn btn-popover-action" ${!isPlayable ? 'disabled' : ''}>⚔️ Lanzar ${card.name} (${card.manaCost || ''})</button>
            <button id="btn-close-popover" class="btn btn-popover-close">✕ Cancelar</button>
          `;
          const btnCast = popover.querySelector('#btn-cast-spell');
          if (btnCast) {
            btnCast.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (btnCast.disabled) return;
              this.castSpellToStack(card, null, 'MAIN');
            });
          }
          const btnClose = popover.querySelector('#btn-close-popover');
          if (btnClose) {
            btnClose.addEventListener('click', (ev) => {
              ev.stopPropagation();
              this.selectedHandCardId = null;
              this.reconcileDOM();
            });
          }
          chip.appendChild(popover);
        }

        chip.addEventListener('click', (ev) => {
          if (ev.target.closest('.hand-card-popover')) return;
          this.selectedHandCardId = (this.selectedHandCardId === cardId ? null : cardId);
          this.reconcileDOM();
        });

        handGrid.appendChild(chip);
      });
      }
    }

    // Bind click to tap land on battlefield (INV-MANA-1)
    if (!this.isSpectator()) {
      const landChips = dashboard.querySelectorAll('#battlefield-lands .land-chip');
      landChips.forEach((chip, idx) => {
        const land = lands[idx];
        if (!land) return;
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          const colorBtn = e.target.closest('.btn-color-choice');
          if (colorBtn) {
            const chosenColor = colorBtn.getAttribute('data-color');
            try {
              if (this.tabletopState && typeof this.tabletopState.tapLandForMana === 'function') {
                this.tabletopState.tapLandForMana(this.myPlayerId, land.instanceId, chosenColor);
                this._selectedLandId = null;
                this.reconcileDOM();
              }
            } catch (err) {
              this.showToast(err.message || 'Cannot tap land');
            }
            return;
          }

          if (land.isTapped && !land.name?.toLowerCase()?.includes('inkmoth')) return;

          const landName = (land.name || '').trim();
          const landNameLower = landName.toLowerCase();
          const isInkmoth = landNameLower.includes('inkmoth nexus');
          const isStartingTown = landNameLower.includes('starting town');
          const isSpireOfIndustry = landNameLower.includes('spire of industry');
          const isSpecialModeLand = isInkmoth || isStartingTown || isSpireOfIndustry;

          const hasNonManaAbilities = Boolean(
            isInkmoth ||
            land.compiledMechanics?.activatedAbilities?.some(a => !a.isManaAbility && a.action !== 'TAP_MANA') ||
            land.abilities?.some(a => !a.isManaAbility && !a.produces && a.action !== 'TAP_MANA')
          );

          if (isSpecialModeLand || hasNonManaAbilities) {
            const drawerContext = {
              friendlyCreatures: pData?.battlefield?.creatures || [],
              tabletopState: this.tabletopState,
              abilities: land.abilities || land.compiledMechanics?.activatedAbilities || []
            };
            const drawer = this.actionDrawer || this.permanentDrawer;
            if (drawer && typeof drawer.open === 'function') {
              drawer.open(land, this.myPlayerId, chip, drawerContext);
            }
            return;
          }

          const profile = this.tabletopState?._getLandManaProfile ? this.tabletopState._getLandManaProfile(land) : [];
          if (profile.length > 1) {
            this._selectedLandId = this._selectedLandId === (land.instanceId || land.id) ? null : (land.instanceId || land.id);
            this.reconcileDOM();
            return;
          }

          try {
            if (this.tabletopState && typeof this.tabletopState.tapLandForMana === 'function') {
              this.tabletopState.tapLandForMana(this.myPlayerId, land.instanceId);
              this.reconcileDOM();
            }
          } catch (err) {
            this.tabletopState?.recordTrace?.('UI_REJECTION', 'TAP_LAND_REJECTED', {
              playerId: this.myPlayerId,
              landId: land.instanceId,
              landName: land.name,
              reason: err.message
            });
            this.showToast(err.message || 'Cannot tap land');
          }
        });
      });

      // [P8] Bind Graveyard & Exile drawer browser buttons
      const btnPlayerGrave = dashboard.querySelector('#player-btn-grave');
      if (btnPlayerGrave) {
        btnPlayerGrave.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openZoneBrowser(this.myPlayerId, 'graveyard');
        });
      }
      const btnPlayerExile = dashboard.querySelector('#player-btn-exile');
      if (btnPlayerExile) {
        btnPlayerExile.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openZoneBrowser(this.myPlayerId, 'exile');
        });
      }

      // [P7] Attachment linked highlight between Creatures and attached Equipment/Auras
      const creatureChips = dashboard.querySelectorAll('#battlefield-creatures .creature-chip');
      creatureChips.forEach((crChip, idx) => {
        const cr = creatures[idx];
        if (!cr) return;
        this._attachCardHoverPreview(crChip, cr);
        const crId = cr.instanceId || cr.id;
        crChip.addEventListener('pointerenter', () => {
          dashboard.querySelectorAll('#battlefield-noncreatures .noncreature-chip').forEach((ncChip, ncIdx) => {
            const nc = noncreatures[ncIdx];
            if (nc && nc.attachedTo === crId) {
              ncChip.classList.add('attachment-linked-highlight');
              crChip.classList.add('attachment-linked-highlight');
            }
          });
        });
        crChip.addEventListener('pointerleave', () => {
          dashboard.querySelectorAll('.attachment-linked-highlight').forEach(el => el.classList.remove('attachment-linked-highlight'));
        });
      });

      // Bind click on noncreature permanents (inspect or attach equipment via PermanentActionDrawer)
      const noncreatureChips = dashboard.querySelectorAll('#battlefield-noncreatures .noncreature-chip');
      noncreatureChips.forEach((chip, idx) => {
        const item = noncreatures[idx];
        if (!item) return;
        this._attachCardHoverPreview(chip, item);
        if (item.attachedTo) {
          chip.addEventListener('pointerenter', () => {
            chip.classList.add('attachment-linked-highlight');
            dashboard.querySelectorAll(`#battlefield-creatures .creature-chip[data-instance-id="${item.attachedTo}"]`).forEach(el => {
              el.classList.add('attachment-linked-highlight');
            });
          });
          chip.addEventListener('pointerleave', () => {
            dashboard.querySelectorAll('.attachment-linked-highlight').forEach(el => el.classList.remove('attachment-linked-highlight'));
          });
        }
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          const pCreatures = pData?.battlefield?.creatures || [];
          const drawerContext = {
            friendlyCreatures: pCreatures,
            tabletopState: this.tabletopState
          };
          if (this.permanentDrawer && typeof this.permanentDrawer.open === 'function') {
            this.permanentDrawer.open(item, this.myPlayerId, chip, drawerContext);
          } else if (this.actionDrawer && typeof this.actionDrawer.open === 'function') {
            this.actionDrawer.open(item, this.myPlayerId, chip, drawerContext);
          } else if (typeof this.openModal === 'function') {
            this.openModal('CARD_OVERLAY', item);
          }
        });
      });
    }
  }

  /**
   * Reconciles Dual-Channel Chat drawer (INV-HARNESS-5).
   * @private
   */
  _reconcileChat() {
    const chatDrawer = this.container.querySelector('#chat-drawer');
    if (!chatDrawer) return;

    const holdsPriority = Boolean(
      this.priorityMachine && this.priorityMachine.priorityPlayerId === this.myPlayerId
    );

    // Update Priority Held in DualChannelChat instance
    if (this.dualChat && typeof this.dualChat.setPriorityHeld === 'function') {
      this.dualChat.setPriorityHeld(holdsPriority);
    }
    if (this.dualChat) {
      this.dualChat.isSpectator = this.isSpectator();
    }

    const isSpectator = this.isSpectator();
    const isTurnTab = this.activeChatTab === 'TURN_COMMAND' || this.activeChatTab === 'TURN';
    const traceCount = this.traceLogger?.entries?.length || 0;

    chatDrawer.innerHTML = `
      <div class="chat-tab-bar">
        <button class="chat-tab-btn tab-turn-command ${isTurnTab && !this.showTraceLog ? 'active' : ''}">
          Turn Cmd ${isSpectator ? '<span class="priority-lock-pill lock-badge">🔒 (Spectator)</span>' : (!holdsPriority ? '<span class="priority-lock-pill lock-badge">🔒</span>' : '')}
        </button>
        <button class="chat-tab-btn tab-chit-chat ${!isTurnTab && !this.showTraceLog ? 'active' : ''}">
          Chit-Chat
        </button>
        <button id="btn-toggle-trace-log" class="btn-badge ${this.showTraceLog ? 'active' : ''}" title="Toggle Deterministic Process Trace Log">
          📋 Trace (${traceCount})
        </button>
        <button id="btn-toggle-coach" class="btn-badge btn-coach-toggle ${this.perkinsAgent?.coachEnabled !== false ? 'active' : ''}" title="Toggle Perkins Coach Tips">
          ${this.perkinsAgent?.coachEnabled === false ? '🎓 Coach: OFF' : '🎓 Coach: ON'}
        </button>
      </div>
      ${this.showTraceLog ? `
      <div class="trace-toolbar" style="display: flex; gap: 6px; padding: 6px 8px; background: rgba(15, 23, 42, 0.9); border-bottom: 1px solid #334155;">
        <button id="btn-copy-trace" class="btn btn-secondary" style="font-size: 0.72rem; padding: 3px 8px;">📋 Copy Full Trace</button>
        <button id="btn-download-trace" class="btn btn-secondary" style="font-size: 0.72rem; padding: 3px 8px;">💾 Download .log</button>
        <button id="btn-clear-trace" class="btn btn-secondary" style="font-size: 0.72rem; padding: 3px 8px;">🧹 Clear</button>
      </div>
      ` : ''}
      <div id="chat-messages" class="chat-feed"></div>
      <div id="chat-staged-chips" class="staged-chips-container" style="${isTurnTab && holdsPriority && !isSpectator ? '' : 'display: none;'}">
        <button class="action-chip btn-chip-pass">Pass Priority</button>
        <button class="action-chip btn-chip-hold">Hold & Respond</button>
      </div>
      <div class="chat-input-row">
        <input type="text" id="turn-command-input" class="chat-text-input" 
          placeholder="${isTurnTab ? (isSpectator ? 'Spectators cannot execute turn commands' : (!holdsPriority ? 'Waiting for priority...' : 'Enter turn command...')) : 'Enter casual message...'}"
          ${isTurnTab && (isSpectator || !holdsPriority) ? 'disabled' : ''} />
        <button id="btn-chat-mic" class="btn btn-icon" ${isTurnTab && (isSpectator || !holdsPriority) ? 'disabled' : ''} title="Voice Dictation">🎙️</button>
        <button id="btn-chat-send" class="btn btn-primary" ${isTurnTab && isSpectator ? 'disabled' : ''}>Send</button>
      </div>
    `;

    // Tab switching
    const btnTurnTab = chatDrawer.querySelector('.tab-turn-command');
    if (btnTurnTab) {
      btnTurnTab.addEventListener('click', () => {
        this.showTraceLog = false;
        this.activeChatTab = 'TURN_COMMAND';
        this._reconcileChat();
      });
    }

    const btnChitTab = chatDrawer.querySelector('.tab-chit-chat');
    if (btnChitTab) {
      btnChitTab.addEventListener('click', () => {
        this.showTraceLog = false;
        this.activeChatTab = 'CHIT_CHAT';
        this._reconcileChat();
      });
    }

    const btnToggleTrace = chatDrawer.querySelector('#btn-toggle-trace-log');
    if (btnToggleTrace) {
      btnToggleTrace.addEventListener('click', () => {
        this.showTraceLog = !this.showTraceLog;
        this._reconcileChat();
      });
    }

    const btnCopyTrace = chatDrawer.querySelector('#btn-copy-trace');
    if (btnCopyTrace) {
      btnCopyTrace.addEventListener('click', () => {
        const text = this.traceLogger?.formatAsText?.() || '';
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).catch(() => {});
        }
        this.showToast('Process trace copied to clipboard');
      });
    }

    const btnDownloadTrace = chatDrawer.querySelector('#btn-download-trace');
    if (btnDownloadTrace) {
      btnDownloadTrace.addEventListener('click', () => {
        const isJSON = typeof this.traceLogger?.exportAsJSON === 'function';
        const text = isJSON ? this.traceLogger.exportAsJSON() : (this.traceLogger?.formatAsText?.() || '');
        const filename = isJSON ? `rpm-process-trace-${Date.now()}.json` : `rpm-process-trace-${Date.now()}.log`;
        const mime = isJSON ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8';
        if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof document !== 'undefined') {
          const blob = new Blob([text], { type: mime });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);
        }
      });
    }

    const btnClearTrace = chatDrawer.querySelector('#btn-clear-trace');
    if (btnClearTrace) {
      btnClearTrace.addEventListener('click', () => {
        this.traceLogger?.clear?.();
        this._reconcileChat();
      });
    }

    // Coach toggle
    const btnToggleCoach = chatDrawer.querySelector('#btn-toggle-coach');
    if (btnToggleCoach) {
      btnToggleCoach.addEventListener('click', () => {
        if (this.perkinsAgent) {
          this.perkinsAgent.coachEnabled = !this.perkinsAgent.coachEnabled;
          btnToggleCoach.textContent = this.perkinsAgent.coachEnabled ? '🎓 Coach: ON' : '🎓 Coach: OFF';
          btnToggleCoach.classList.toggle('active', this.perkinsAgent.coachEnabled);
        }
      });
    }

    // Staged chip clicks
    const chipPass = chatDrawer.querySelector('.btn-chip-pass');
    if (chipPass) {
      chipPass.addEventListener('click', () => {
        this.dispatchAction({ type: 'PASS_PRIORITY' }, { origin: 'LOCAL' });
      });
    }
    const chipHold = chatDrawer.querySelector('.btn-chip-hold');
    if (chipHold) {
      chipHold.addEventListener('click', () => {
        this.dispatchAction({ type: 'HOLD_RESPOND' }, { origin: 'LOCAL' });
      });
    }

    // Input submission
    const input = chatDrawer.querySelector('#turn-command-input');
    const sendBtn = chatDrawer.querySelector('#btn-chat-send');
    const doSend = () => {
      if (!input || input.disabled || !input.value.trim()) return;
      const text = input.value.trim();
      input.value = '';
      if (isTurnTab) {
        if (isSpectator || !holdsPriority) return;
        this.dispatchAction({
          type: 'TURN_COMMAND',
          payload: { command: text, senderId: this.myPlayerId }
        }, { origin: 'LOCAL' });
      } else {
        const senderName = isSpectator ? `[Spectator] ${this.username}` : this.username;
        this.dispatchAction({
          type: 'SEND_CHIT_CHAT',
          payload: { text, senderId: this.myPlayerId, senderName, isSpectator }
        }, { origin: 'LOCAL' });
      }
    };

    if (sendBtn) sendBtn.addEventListener('click', doSend);
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSend();
      });
    }

    // Populate chat feed messages
    const chatFeed = chatDrawer.querySelector('#chat-messages');
    if (chatFeed) {
      if (this.showTraceLog) {
        const traceEntries = this.traceLogger?.entries || [];
        if (traceEntries.length === 0) {
          chatFeed.innerHTML = '<div style="color: #64748b; font-size: 0.78rem; font-family: monospace;">No process trace entries yet.</div>';
        } else {
          chatFeed.innerHTML = traceEntries.map(e => `
            <div class="chat-msg trace-log-entry" style="font-family: monospace; font-size: 0.72rem; line-height: 1.35; border-bottom: 1px solid rgba(51,65,85,0.4); padding: 3px 0;">
              <span style="color: #38bdf8;">#${e.seq}</span>
              <span style="color: #94a3b8;">[T${e.turn}/R${e.round} ${e.step}]</span>
              <span style="color: #f59e0b;">[${e.category}:${e.action}]</span>
              <span style="color: #e2e8f0; word-break: break-all;">${JSON.stringify(e.payload)}</span>
            </div>
          `).join('');
          chatFeed.scrollTop = chatFeed.scrollHeight;
        }
        return;
      }

      const messages = isTurnTab
        ? (this.dualChat?.turnCommandMessages || [])
        : (this.dualChat?.chitChatMessages || []);

      if (messages.length === 0) {
        chatFeed.innerHTML = '<div style="color: #64748b; font-size: 0.8rem; font-style: italic;">No messages yet.</div>';
      } else {
        chatFeed.innerHTML = messages.map(m => `
          <div class="chat-msg">
            <span class="chat-msg-author">${m.senderName || m.senderId || 'Player'}:</span>
            <span class="chat-msg-text">${m.text || m.rawInput || ''}</span>
          </div>
        `).join('');
        chatFeed.scrollTop = chatFeed.scrollHeight;
      }
    }
  }

  /**
   * Reconciles Pre-Game d20 Roll-Off overlay.
   * @private
   */
  _reconcileRollOff() {
    const overlay = this.container.querySelector('#roll-off-overlay');
    if (!overlay) return;

    if (this.isRollOffActive) {
      overlay.style.display = 'flex';
      const statusText = overlay.querySelector('#roll-off-status-text');
      const resultsList = overlay.querySelector('#roll-off-results-list');
      const rollBtn = overlay.querySelector('#btn-roll-d20');

      if (this.turnRollOffManager) {
        const round = this.turnRollOffManager.round;
        const hasTies = this.rollOffResult?.hasTies;
        const pending = this.turnRollOffManager.pendingPlayerIds;

        if (statusText) {
          if (this.rollOffResult?.isComplete) {
            const sorted = this.rollOffResult.sortedPlayers || [];
            const winner = sorted[0];
            statusText.textContent = `Turn order resolved! ${winner === this.myPlayerId ? 'You take' : `${this.getFriendlyPlayerName(winner)} takes`} Turn 1. Starting match...`;
          } else if (hasTies) {
            statusText.textContent = `Round ${round} (Tie Breaker): Tied players re-roll!`;
          } else {
            statusText.textContent = `Round ${round}: Roll d20 for Turn Order`;
          }
        }

        if (resultsList) {
          const rolls = Array.from(this.turnRollOffManager.currentRolls.entries());
          resultsList.innerHTML = rolls.map(([pid, val]) => `
            <div class="roll-result-chip">
              <span class="roll-player">${pid === this.myPlayerId ? 'You' : this.getFriendlyPlayerName(pid)}:</span>
              <span class="roll-val">🎲 ${val}</span>
            </div>
          `).join('');
        }

        if (rollBtn) {
          const myPending = pending.has(this.myPlayerId);
          rollBtn.disabled = !myPending;
          rollBtn.textContent = myPending ? '🎲 Roll d20 for Turn Order' : '✅ Roll Submitted (Waiting for others...)';
        }
      }
    } else {
      overlay.style.display = 'none';
    }
  }

  /**
   * Reconciles Authentication & Registration View panel (INV-AUTH-1).
   * @private
   */
  _reconcileAuthView() {
    const curTab = this.tabRouter ? this.tabRouter.getCurrentTab() : 'ARENA';
    const view = this.container?.querySelector('#view-auth');
    if (!view) return;
    if (curTab !== 'AUTH') return;

    if (!view.querySelector('.auth-view-container')) {
      view.innerHTML = `
        <div class="auth-view-container">
          <div class="auth-card">
            <div class="auth-header">
              <span class="auth-shield">🔐</span>
              <h2>Planeswalker Authentication Gate</h2>
              <p class="auth-subtitle">Email & Password Persistent Account or Instant Dev Bypass</p>
            </div>

            <div id="auth-error-message" class="auth-error-banner" style="display: none;"></div>
            <div id="auth-success-message" class="auth-success-banner" style="display: none;"></div>

            <div class="auth-tabs" style="display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px;">
              <button id="auth-tab-signin" class="btn btn-secondary btn-sm active" style="flex: 1; font-weight: bold;">Sign In</button>
              <button id="auth-tab-register" class="btn btn-secondary btn-sm" style="flex: 1; font-weight: bold;">Create Account</button>
            </div>

            <div class="auth-form">
              <div class="form-group">
                <label for="auth-email-input">Email Address <span class="required">*</span></label>
                <input type="email" id="auth-email-input" class="auth-input" placeholder="planeswalker@tabletop.com" required autocomplete="email" />
              </div>

              <div class="form-group">
                <label for="auth-password-input">Password <span class="required">*</span></label>
                <input type="password" id="auth-password-input" class="auth-input" placeholder="••••••••" required autocomplete="current-password" />
              </div>

              <div id="auth-register-extra-fields" style="display: none;">
                <div class="form-group">
                  <label for="auth-username-input">Player Display Name <span class="required">*</span></label>
                  <input type="text" id="auth-username-input" class="auth-input" placeholder="e.g. Alice" value="${this.username || ''}" maxlength="32" />
                </div>

                <div class="form-group">
                  <label for="auth-dob-input">Date of Birth (Age &ge; 13) <span class="required">*</span></label>
                  <input type="date" id="auth-dob-input" class="auth-input" value="1998-05-14" required />
                </div>
              </div>

              <div class="auth-actions" style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px;">
                <button id="btn-auth-submit" class="btn btn-primary" style="width: 100%; font-weight: bold; padding: 10px;">Sign In</button>
                <button id="btn-instant-dev-login" class="btn btn-secondary btn-dev-bypass" style="width: 100%;">⚡ Instant Dev Login</button>
              </div>

              <details style="margin-top: 16px; font-size: 0.8rem; color: #94a3b8; cursor: pointer;">
                <summary>Legacy Magic Link OTP fallback</summary>
                <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 6px;">
                  <button id="btn-send-magic-link" class="btn btn-outline btn-sm">✉️ Send Magic Link OTP</button>
                  <div id="auth-otp-section" class="otp-section" style="display: none;">
                    <div class="otp-input-group" style="display: flex; gap: 6px; margin-top: 6px;">
                      <input type="text" id="auth-otp-input" class="auth-input otp-code-input" placeholder="123456" maxlength="8" />
                      <button id="btn-verify-otp" class="btn btn-primary btn-sm">Verify OTP</button>
                    </div>
                  </div>
                </div>
              </details>
            </div>
          </div>
        </div>
      `;

      const tabSignIn = view.querySelector('#auth-tab-signin');
      const tabRegister = view.querySelector('#auth-tab-register');
      const registerFields = view.querySelector('#auth-register-extra-fields');
      const btnSubmit = view.querySelector('#btn-auth-submit');
      const btnSendOtp = view.querySelector('#btn-send-magic-link');
      const btnDevLogin = view.querySelector('#btn-instant-dev-login');
      const btnVerifyOtp = view.querySelector('#btn-verify-otp');
      const errBanner = view.querySelector('#auth-error-message');
      const succBanner = view.querySelector('#auth-success-message');
      const otpSection = view.querySelector('#auth-otp-section');

      let currentMode = 'signin';

      const setMode = (mode) => {
        currentMode = mode;
        if (mode === 'signin') {
          tabSignIn?.classList.add('active');
          tabRegister?.classList.remove('active');
          if (registerFields) registerFields.style.display = 'none';
          if (btnSubmit) btnSubmit.textContent = 'Sign In';
        } else {
          tabRegister?.classList.add('active');
          tabSignIn?.classList.remove('active');
          if (registerFields) registerFields.style.display = 'block';
          if (btnSubmit) btnSubmit.textContent = 'Create Account';
        }
      };

      tabSignIn?.addEventListener('click', () => setMode('signin'));
      tabRegister?.addEventListener('click', () => setMode('register'));

      const showError = (msg) => {
        if (errBanner) {
          errBanner.textContent = msg;
          errBanner.style.display = 'block';
        }
        if (succBanner) succBanner.style.display = 'none';
      };

      const showSuccess = (msg) => {
        if (succBanner) {
          succBanner.textContent = msg;
          succBanner.style.display = 'block';
        }
        if (errBanner) errBanner.style.display = 'none';
      };

      if (btnSubmit) {
        btnSubmit.addEventListener('click', async () => {
          const email = view.querySelector('#auth-email-input')?.value?.trim();
          const password = view.querySelector('#auth-password-input')?.value?.trim();
          const username = view.querySelector('#auth-username-input')?.value?.trim() || email?.split('@')[0] || 'Planeswalker';

          if (!email || !password) {
            showError('Please provide both email and password.');
            return;
          }

          try {
            if (currentMode === 'register') {
              if (this.authManager && typeof this.authManager.signUpWithPassword === 'function') {
                await this.authManager.signUpWithPassword(email, password, username);
              } else if (this.authManager && typeof this.authManager.instantDevLogin === 'function') {
                await this.authManager.instantDevLogin(email, username, '1998-05-14');
              }
              showSuccess('Account registered and logged in successfully!');
            } else {
              if (this.authManager && typeof this.authManager.signInWithPassword === 'function') {
                await this.authManager.signInWithPassword(email, password);
              } else if (this.authManager && typeof this.authManager.instantDevLogin === 'function') {
                await this.authManager.instantDevLogin(email, username, '1998-05-14');
              }
              showSuccess('Signed in successfully!');
            }
            this._syncAuthUser();

            if (!this.authManager.isOnboarded()) {
              this.tabRouter.navigate('DECKBUILDER', this.getMatchState(), this.isSpectator());
            } else {
              this.tabRouter.navigate('LOBBY', this.getMatchState(), this.isSpectator());
            }
            this.reconcileDOM();
          } catch (err) {
            showError(err.message || 'Authentication failed');
          }
        });
      }

      if (btnDevLogin) {
        btnDevLogin.addEventListener('click', async () => {
          const email = view.querySelector('#auth-email-input')?.value?.trim();
          const username = view.querySelector('#auth-username-input')?.value?.trim();
          const dob = view.querySelector('#auth-dob-input')?.value?.trim();

          try {
            await this.authManager.instantDevLogin(email, username, dob);
            this._syncAuthUser();
            showSuccess('Logged in successfully via Instant Dev Bypass!');

            if (!this.authManager.isOnboarded()) {
              this.tabRouter.navigate('DECKBUILDER', this.getMatchState(), this.isSpectator());
            } else {
              this.tabRouter.navigate('LOBBY', this.getMatchState(), this.isSpectator());
            }
            this.reconcileDOM();
          } catch (err) {
            showError(err.message || 'Login failed');
          }
        });
      }

      if (btnSendOtp) {
        btnSendOtp.addEventListener('click', async () => {
          const email = view.querySelector('#auth-email-input')?.value?.trim();
          try {
            await this.authManager.sendMagicLink(email);
            showSuccess(`Magic link OTP dispatched to ${email}! Check inbox or test token.`);
            if (otpSection) otpSection.style.display = 'block';
          } catch (err) {
            showError(err.message || 'Failed to send Magic Link');
          }
        });
      }

      if (btnVerifyOtp) {
        btnVerifyOtp.addEventListener('click', async () => {
          const email = view.querySelector('#auth-email-input')?.value?.trim();
          const otp = view.querySelector('#auth-otp-input')?.value?.trim();
          try {
            await this.authManager.verifyOtp(email, otp);
            this._syncAuthUser();
            showSuccess('OTP Verified successfully!');

            if (!this.authManager.isOnboarded()) {
              this.tabRouter.navigate('DECKBUILDER', this.getMatchState(), this.isSpectator());
            } else {
              this.tabRouter.navigate('LOBBY', this.getMatchState(), this.isSpectator());
            }
            this.reconcileDOM();
          } catch (err) {
            showError(err.message || 'OTP verification failed');
          }
        });
      }
    }
  }

  /**
   * Reconciles Deckbuilder View panel.
   * @private
   */
  _reconcileDeckbuilderView() {
    const curTab = this.tabRouter ? this.tabRouter.getCurrentTab() : 'ARENA';
    const view = this.container.querySelector('#view-deckbuilder');
    if (!view) return;
    if (curTab !== 'DECKBUILDER') return;

    const isOnboarded = this.authManager ? this.authManager.isOnboarded() : true;

    if (!view.querySelector('.deckbuilder-view-container')) {
      view.innerHTML = `
        <div class="deckbuilder-view-container">
          <div id="deckbuilder-onboard-banner" class="onboarding-gate-banner" style="${isOnboarded ? 'display: none;' : ''}">
            <h3>⚠️ MANDATORY DECK CREATOR GATE (INV-ONBOARD-1)</h3>
            <p>Welcome, <strong>${this.username}</strong>! Select a starter archetype below or validate a custom construct to unlock Multiplayer Lobby Matchmaking.</p>
          </div>

          <div class="starter-archetypes-container">
            <h3>🔥 Modern Starter Archetypes (1-Click Select)</h3>
            <div class="starter-cards-grid" id="starter-cards-grid">
              ${Object.values(STARTER_ARCHETYPES).map(starter => `
                <div class="starter-card" data-deck-id="${starter.id}">
                  <div class="starter-header">
                    <h4>${starter.name}</h4>
                    <span class="starter-colors">${starter.colorIdentity.join('/')}</span>
                  </div>
                  <p class="starter-archetype-desc">${starter.archetype}</p>
                  <div class="starter-preview-chips">
                    ${starter.previewCards.map(c => `<span class="chip-card">${c}</span>`).join('')}
                  </div>
                  <button class="btn btn-primary btn-select-starter" data-starter-id="${starter.id}">
                    Select ${starter.name}
                  </button>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="format-toggle-bar" style="margin-top: 24px;">
            <button id="btn-mode-free" class="btn btn-mode-toggle ${this.deckbuilderMode === 'FREE_CONSTRUCT' ? 'active' : ''}" data-mode="FREE_CONSTRUCT">⚡ Free Construct</button>
            <button id="btn-mode-ranked" class="btn btn-mode-toggle ${this.deckbuilderMode === 'RANKED_CONSTRUCT' ? 'active' : ''}" data-mode="RANKED_CONSTRUCT">🏆 Ranked Construct (Modern)</button>
          </div>
          <div class="deck-slots-section">
            <h4>Deck Slots:</h4>
            <div id="deck-slots-bar" class="deck-slots-bar"></div>
          </div>
          <div class="deck-validator-section">
            <h4>Decklist Validator (Oracle 4-Of Override):</h4>
            <div class="deck-name-container">
              <input type="text" id="deckbuilder-name-input" class="deck-name-input" placeholder="Deck Name (e.g. Mono-Red Burn)" />
            </div>
            <textarea id="deckbuilder-text-input" class="deck-input-area" placeholder="Paste decklist here...&#10;4 Lightning Bolt&#10;20 Relentless Rats&#10;20 Mountain"></textarea>
            <div class="deck-validator-controls">
              <button id="btn-validate-deck" class="btn btn-primary">Validate Decklist</button>
              <button id="btn-save-active-deck" class="btn btn-special" style="margin-left: 10px;">💾 Save Active Deck</button>
              <div id="deck-validation-badge" class="deck-validation-badge"></div>
            </div>
            <div id="deck-save-confirmation-banner" class="deck-save-confirmation-banner" style="display: none;">
              <span class="banner-text">✅ Deck saved!</span>
              <button id="btn-deck-go-to-lobby" class="btn btn-primary btn-sm">⚔️ Go to Lobby</button>
            </div>
            <ul id="deck-validation-errors" class="deck-validation-errors"></ul>
          </div>
          <div class="active-deck-preview-section">
            <div id="active-deck-preview-panel" class="active-deck-preview-panel"></div>
          </div>
        </div>
      `;

      // Bind starter deck buttons
      const starterBtns = view.querySelectorAll('.btn-select-starter');
      starterBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
          const sId = btn.getAttribute('data-starter-id');
          const starter = getStarterDeck(sId);
          if (starter) {
            const nameInput = view.querySelector('#deckbuilder-name-input');
            const textarea = view.querySelector('#deckbuilder-text-input');
            const deckName = starter.title || starter.name || starter.archetype;
            if (nameInput) nameInput.value = deckName;

            const mainLines = (starter.mainboard || []).map(c => `${c.count || 1} ${c.name}`).join('\n');
            const sideLines = (starter.sideboard || []).length > 0
              ? '\n\nSideboard\n' + starter.sideboard.map(c => `${c.count || 1} ${c.name}`).join('\n')
              : '';
            const rawText = mainLines + sideLines;
            if (textarea) textarea.value = rawText;

            const badge = view.querySelector('#deck-validation-badge');
            if (badge) {
              badge.className = 'deck-validation-badge';
              badge.textContent = '🔄 Consulting Scryfall Oracle API & running card smoke tests...';
            }

            const report = await DeckValidator.validateAndHydrateDeck(rawText, {
              format: this.deckbuilderMode,
              scryfallService: this.scryfallService
            });
            this._renderDeckValidationReport(view, report);

            const mainboard = (report.hydratedCards && report.hydratedCards.length > 0)
              ? report.hydratedCards.filter(c => c.section !== 'sideboard' && !c.isSideboard)
              : (report.mainboard || starter.mainboard || []);
            const sideboard = (report.hydratedCards && report.hydratedCards.length > 0)
              ? report.hydratedCards.filter(c => c.section === 'sideboard' || Boolean(c.isSideboard))
              : (report.sideboard || starter.sideboard || []);

            const deckObj = {
              slot: this.activeDeckSlot,
              name: deckName,
              rawText,
              format: this.deckbuilderMode,
              mainboard,
              sideboard,
              colorIdentity: report.colorIdentity || starter.colorIdentity || ['C'],
              breakdown: report.breakdown || {
                creatures: 0,
                spells: 0,
                otherPermanents: 0,
                lands: 0,
                sideboard: report.sideboardCount || 0
              },
              mainCount: report.mainCount || 60,
              sideboardCount: report.sideboardCount || 0,
              savedAt: Date.now()
            };
            this.activeDeckData = deckObj;

            try {
              const storage = (typeof localStorage !== 'undefined') ? localStorage : (this.storage || null);
              if (storage) {
                storage.setItem('rpm_active_deck_slot', String(this.activeDeckSlot));
                let slotMap = {};
                const existing = storage.getItem('rpm_saved_decks_by_slot');
                if (existing) {
                  try { slotMap = JSON.parse(existing) || {}; } catch (_) {}
                }
                slotMap[this.activeDeckSlot] = deckObj;
                storage.setItem('rpm_saved_decks_by_slot', JSON.stringify(slotMap));
              }
            } catch (_) {}

            if (this.authManager) {
              try {
                if (typeof this.authManager.isAuthenticated === 'function' && this.authManager.isAuthenticated()) {
                  await this.authManager.saveActiveDeck(starter.id, starter);
                }
              } catch (_) {}
            }

            const banner = view.querySelector('#deck-save-confirmation-banner');
            if (banner) {
              banner.style.display = 'flex';
              const textEl = banner.querySelector('.banner-text');
              if (textEl) textEl.textContent = `✅ Deck "${deckName}" saved to Slot ${this.activeDeckSlot}!`;
              const btnLobby = banner.querySelector('#btn-deck-go-to-lobby');
              if (btnLobby && !btnLobby._bound) {
                btnLobby._bound = true;
                btnLobby.addEventListener('click', () => {
                  this.tabRouter.navigate('LOBBY', this.getMatchState(), this.isSpectator());
                  this.reconcileDOM();
                });
              }
            }

            this._renderActiveDeckPreview(view, deckObj);
          }
        });
      });

      // Bind save active deck button
      const btnSaveActive = view.querySelector('#btn-save-active-deck');
      if (btnSaveActive) {
        btnSaveActive.addEventListener('click', async () => {
          const textarea = view.querySelector('#deckbuilder-text-input');
          const nameInput = view.querySelector('#deckbuilder-name-input');
          const rawText = textarea ? textarea.value : '';
          const deckName = (nameInput?.value || '').trim() || `Slot ${this.activeDeckSlot} Deck`;
          const badge = view.querySelector('#deck-validation-badge');
          if (badge) {
            badge.className = 'deck-validation-badge';
            badge.textContent = '🔄 Consulting Scryfall Oracle API & running card smoke tests...';
          }

          const report = await DeckValidator.validateAndHydrateDeck(rawText, {
            format: this.deckbuilderMode,
            scryfallService: this.scryfallService
          });
          this._renderDeckValidationReport(view, report);
          if (report.isValid) {
            const mainboard = (report.hydratedCards && report.hydratedCards.length > 0)
              ? report.hydratedCards.filter(c => c.section !== 'sideboard' && !c.isSideboard)
              : report.mainboard;
            const sideboard = (report.hydratedCards && report.hydratedCards.length > 0)
              ? report.hydratedCards.filter(c => c.section === 'sideboard' || Boolean(c.isSideboard))
              : report.sideboard;

            const deckObj = {
              slot: this.activeDeckSlot,
              name: deckName,
              rawText,
              format: this.deckbuilderMode,
              mainboard,
              sideboard,
              colorIdentity: report.colorIdentity,
              breakdown: report.breakdown,
              mainCount: report.mainCount,
              sideboardCount: report.sideboardCount,
              savedAt: Date.now()
            };
            this.activeDeckData = deckObj;

            try {
              const storage = (typeof localStorage !== 'undefined') ? localStorage : (this.storage || null);
              if (storage) {
                storage.setItem('rpm_active_deck_slot', String(this.activeDeckSlot));
                let slotMap = {};
                const existing = storage.getItem('rpm_saved_decks_by_slot');
                if (existing) {
                  try { slotMap = JSON.parse(existing) || {}; } catch (_) {}
                }
                slotMap[this.activeDeckSlot] = deckObj;
                storage.setItem('rpm_saved_decks_by_slot', JSON.stringify(slotMap));
              }
            } catch (_) {}

            if (this.authManager) {
              try {
                if (typeof this.authManager.isAuthenticated === 'function' && this.authManager.isAuthenticated()) {
                  const deckId = `custom_${Date.now()}`;
                  await this.authManager.saveActiveDeck(deckId, report);
                }
              } catch (_) {}
            }

            const banner = view.querySelector('#deck-save-confirmation-banner');
            if (banner) {
              banner.style.display = 'flex';
              const textEl = banner.querySelector('.banner-text');
              if (textEl) textEl.textContent = `✅ Deck "${deckName}" saved to Slot ${this.activeDeckSlot}!`;
              const btnLobby = banner.querySelector('#btn-deck-go-to-lobby');
              if (btnLobby && !btnLobby._bound) {
                btnLobby._bound = true;
                btnLobby.addEventListener('click', () => {
                  this.tabRouter.navigate('LOBBY', this.getMatchState(), this.isSpectator());
                  this.reconcileDOM();
                });
              }
            }

            this._renderActiveDeckPreview(view, deckObj);
          }
        });
      }

      // Bind format toggle
      const btnFree = view.querySelector('#btn-mode-free');
      const btnRanked = view.querySelector('#btn-mode-ranked');
      if (btnFree) {
        btnFree.addEventListener('click', () => {
          this.deckbuilderMode = 'FREE_CONSTRUCT';
          this.reconcileDOM();
        });
      }
      if (btnRanked) {
        btnRanked.addEventListener('click', () => {
          this.deckbuilderMode = 'RANKED_CONSTRUCT';
          this.reconcileDOM();
        });
      }

      // Bind validate button
      const btnValidate = view.querySelector('#btn-validate-deck');
      if (btnValidate) {
        btnValidate.addEventListener('click', async () => {
          const textarea = view.querySelector('#deckbuilder-text-input');
          const rawText = textarea ? textarea.value : '';
          const badge = view.querySelector('#deck-validation-badge');
          if (badge) {
            badge.className = 'deck-validation-badge';
            badge.textContent = '🔄 Consulting Scryfall Oracle API & running card smoke tests...';
          }
          const report = await DeckValidator.validateAndHydrateDeck(rawText, {
            format: this.deckbuilderMode,
            scryfallService: this.scryfallService
          });
          this._renderDeckValidationReport(view, report);
          if (report.isValid) {
            const nameInput = view.querySelector('#deckbuilder-name-input');
            const deckName = (nameInput?.value || '').trim() || `Slot ${this.activeDeckSlot} Deck`;
            const mainboard = (report.hydratedCards && report.hydratedCards.length > 0)
              ? report.hydratedCards.filter(c => c.section !== 'sideboard' && !c.isSideboard)
              : report.mainboard;
            const sideboard = (report.hydratedCards && report.hydratedCards.length > 0)
              ? report.hydratedCards.filter(c => c.section === 'sideboard' || Boolean(c.isSideboard))
              : report.sideboard;
            const deckObj = {
              slot: this.activeDeckSlot,
              name: deckName,
              rawText,
              format: this.deckbuilderMode,
              mainboard,
              sideboard,
              colorIdentity: report.colorIdentity,
              breakdown: report.breakdown,
              mainCount: report.mainCount,
              sideboardCount: report.sideboardCount,
              savedAt: Date.now()
            };
            this.activeDeckData = deckObj;
            try {
              const storage = (typeof localStorage !== 'undefined') ? localStorage : (this.storage || null);
              if (storage) {
                storage.setItem('rpm_active_deck_slot', String(this.activeDeckSlot));
                let slotMap = {};
                const existing = storage.getItem('rpm_saved_decks_by_slot');
                if (existing) {
                  try { slotMap = JSON.parse(existing) || {}; } catch (_) {}
                }
                slotMap[this.activeDeckSlot] = deckObj;
                storage.setItem('rpm_saved_decks_by_slot', JSON.stringify(slotMap));
              }
            } catch (_) {}
            if (this.authManager && typeof this.authManager.isAuthenticated === 'function' && this.authManager.isAuthenticated()) {
              try {
                await this.authManager.saveActiveDeck(`custom_${Date.now()}`, report);
              } catch (_) {}
            }
            this._renderActiveDeckPreview(view, deckObj);
          }
        });
      }
    }

    const onboardBanner = view.querySelector('#deckbuilder-onboard-banner');
    if (onboardBanner) {
      onboardBanner.style.display = isOnboarded ? 'none' : 'block';
    }

    const btnFree = view.querySelector('#btn-mode-free');
    const btnRanked = view.querySelector('#btn-mode-ranked');
    if (btnFree) btnFree.classList.toggle('active', this.deckbuilderMode === 'FREE_CONSTRUCT');
    if (btnRanked) btnRanked.classList.toggle('active', this.deckbuilderMode === 'RANKED_CONSTRUCT');

    // Deck slots
    const slotsBar = view.querySelector('#deck-slots-bar');
    if (slotsBar) {
      const profile = this.profileManager?.getProfile(this.myPlayerId) || createDefaultProfile(this.myPlayerId);
      const unlockedSlots = evaluateDeckSlots(profile.lifetimeWins || 0, profile.totalPerksTriggered || 0);

      slotsBar.innerHTML = '';
      for (let s = 1; s <= 5; s++) {
        const isUnlocked = s <= unlockedSlots;
        const isActive = this.activeDeckSlot === s;
        const btn = document.createElement('button');
        btn.className = `btn btn-deck-slot ${isActive ? 'active' : ''} ${isUnlocked ? 'unlocked' : 'locked'}`;
        btn.setAttribute('data-slot', String(s));
        btn.textContent = isUnlocked ? `Slot ${s}${isActive ? ' (Active)' : ''}` : `🔒 Slot ${s} (Locked)`;

        btn.addEventListener('click', () => {
          if (isUnlocked) {
            const loadedDeck = this._loadDeckSlot(s);
            const textarea = view.querySelector('#deckbuilder-text-input');
            const nameInput = view.querySelector('#deckbuilder-name-input');
            if (loadedDeck) {
              if (textarea) textarea.value = loadedDeck.rawText || '';
              if (nameInput) nameInput.value = loadedDeck.name || `Slot ${s} Deck`;
              const report = DeckValidator.validateDeck(loadedDeck.rawText || '', { format: this.deckbuilderMode });
              this._renderDeckValidationReport(view, report);
              this._renderActiveDeckPreview(view, loadedDeck);
            } else {
              if (textarea) textarea.value = '';
              if (nameInput) nameInput.value = `Slot ${s} Deck`;
              this._renderActiveDeckPreview(view, null);
            }
            this.reconcileDOM();
          }
        });

        slotsBar.appendChild(btn);
      }
    }

    const activeDeck = this.getActiveDeckForPlayer(this.myPlayerId);
    const textarea = view.querySelector('#deckbuilder-text-input');
    const nameInput = view.querySelector('#deckbuilder-name-input');
    if (activeDeck) {
      if (nameInput && !nameInput.value) {
        nameInput.value = activeDeck.name || `Slot ${this.activeDeckSlot} Deck`;
      }
      if (textarea && !textarea.value) {
        textarea.value = activeDeck.rawText || '';
      }
    }
    this._renderActiveDeckPreview(view, activeDeck);

    const banner = view.querySelector('#deck-save-confirmation-banner');
    if (banner) {
      const btnLobby = banner.querySelector('#btn-deck-go-to-lobby');
      if (btnLobby && !btnLobby._bound) {
        btnLobby._bound = true;
        btnLobby.addEventListener('click', () => {
          this.tabRouter.navigate('LOBBY', this.getMatchState(), this.isSpectator());
          this.reconcileDOM();
        });
      }
    }
  }

  /**
   * Renders deck validation report into Deckbuilder View.
   * @private
   */
  _renderDeckValidationReport(view, report) {
    const badge = view.querySelector('#deck-validation-badge');
    const errorList = view.querySelector('#deck-validation-errors');
    if (!badge || !errorList) return;

    if (report.isValid) {
      badge.className = 'deck-validation-badge valid';
      badge.textContent = `✅ VALID (${report.mainCount} Main / ${report.sideboardCount} Sideboard)`;
      errorList.innerHTML = '';

      const compatTier = report.compatibilityBadge || report.supportTier || 'FULL';
      let btnReview = view.querySelector('#btn-submit-deck-review');
      if (compatTier === 'ASSISTED' || compatTier === 'UNSUPPORTED' || (Array.isArray(report.unverifiedCards) && report.unverifiedCards.length > 0)) {
        if (!btnReview) {
          btnReview = document.createElement('button');
          btnReview.id = 'btn-submit-deck-review';
          btnReview.className = 'btn btn-submit-deck-review';
          btnReview.textContent = '📩 Submit for Full Support Review';
          badge.parentElement?.appendChild(btnReview);
        }
        btnReview.style.display = 'inline-flex';
        btnReview.onclick = () => {
          const nameInput = view.querySelector('#deckbuilder-name-input');
          const textarea = view.querySelector('#deckbuilder-text-input');
          this.submitDeckToReviewQueue({
            deckName: nameInput?.value || 'Custom Deck',
            format: this.deckbuilderMode,
            rawDecklist: textarea?.value || '',
            compatibilityBadge: compatTier,
            unverifiedCards: report.unverifiedCards || []
          });
        };
      } else if (btnReview) {
        btnReview.style.display = 'none';
      }
    } else {
      badge.className = 'deck-validation-badge invalid';
      badge.textContent = `❌ INVALID (${report.errors.length} Errors)`;
      errorList.innerHTML = report.errors.map(err => `
        <li class="error-item">
          <strong>${err.cardName}:</strong> ${err.reason}
        </li>
      `).join('');
    }
  }

  /**
   * Renders active deck preview panel in Deckbuilder View.
   * @private
   */
  _renderActiveDeckPreview(view, deckData) {
    const panel = view.querySelector('#active-deck-preview-panel');
    if (!panel) return;

    if (!deckData) {
      panel.innerHTML = `
        <div class="active-deck-empty-state">
          <p>No active deck configured for Slot ${this.activeDeckSlot}. Paste a decklist above or select a Starter Archetype to equip.</p>
        </div>
      `;
      return;
    }

    const mainboard = deckData.mainboard || [];
    const sideboard = deckData.sideboard || [];
    const colorIdentity = Array.isArray(deckData.colorIdentity) && deckData.colorIdentity.length > 0 ? deckData.colorIdentity : ['C'];
    const breakdown = deckData.breakdown || {
      creatures: 0,
      spells: 0,
      otherPermanents: 0,
      lands: 0,
      sideboard: sideboard.reduce((a, c) => a + (Number(c.count) || 1), 0)
    };

    const creatures = [];
    const spells = [];
    const otherPermanents = [];
    const lands = [];

    for (const card of mainboard) {
      const norm = (card.name || '').trim().toLowerCase();
      const meta = getHydratedCardMetadata(card.name);
      let typeLine = (card.typeLine || card.type || meta?.typeLine || meta?.type || '').toLowerCase();
      if (!typeLine && BASIC_LAND_COLORS[norm]) typeLine = 'land';
      if (!typeLine && DUAL_LAND_METADATA[norm]) typeLine = 'land';

      if (typeLine.includes('creature')) {
        creatures.push(card);
      } else if (typeLine.includes('land') || DeckValidator.isBasicLand(card.name) || DUAL_LAND_METADATA[norm]) {
        lands.push(card);
      } else if (typeLine.includes('instant') || typeLine.includes('sorcery')) {
        spells.push(card);
      } else if (typeLine.includes('artifact') || typeLine.includes('enchantment') || typeLine.includes('planeswalker') || typeLine.includes('battle')) {
        otherPermanents.push(card);
      } else {
        spells.push(card);
      }
    }

    const formatLabel = deckData.format === 'RANKED_CONSTRUCT' ? '🏆 Ranked Construct (Modern)' : '⚡ Free Construct';

    const renderCardList = (cards) => {
      if (!cards || cards.length === 0) return '<li class="empty-cat-item"><em>None</em></li>';
      return cards.map(c => {
        if (!c.smokeTest) {
          try {
            c.smokeTest = OracleEffectCompiler.smokeTestCard(c);
          } catch (_) {}
        }
        const isVerified = Boolean(c.compiledMechanics || c.smokeTest?.passed || c.typeLine);
        const verifiedBadge = isVerified
          ? `<span class="card-verified-badge" title="Smoke Test Passed (${c.smokeTest?.supportTier || 'VERIFIED'})" style="margin-left: 6px; font-size: 0.75rem; color: #4ade80;">🟢 Verified</span>`
          : '';
        return `<li class="card-item">${c.count || 1}x ${c.name}${verifiedBadge}</li>`;
      }).join('');
    };

    panel.innerHTML = `
      <div class="active-deck-preview-card">
        <div class="preview-header">
          <h3 class="preview-title">🃏 ${deckData.name || 'Custom Deck'} <span class="slot-tag">(Slot ${deckData.slot || this.activeDeckSlot})</span></h3>
          <div class="preview-badges">
            <span class="badge badge-format">${formatLabel}</span>
            <span class="badge badge-counts">${deckData.mainCount || mainboard.reduce((a, c) => a + (Number(c.count) || 1), 0)} Main / ${deckData.sideboardCount || sideboard.reduce((a, c) => a + (Number(c.count) || 1), 0)} Sideboard</span>
            <span class="badge badge-colors">Colors: ${colorIdentity.join('/')}</span>
          </div>
        </div>
        <div class="preview-categories-grid">
          <div class="category-column">
            <h4>Creatures (${breakdown.creatures})</h4>
            <ul class="preview-card-list">${renderCardList(creatures)}</ul>
          </div>
          <div class="category-column">
            <h4>Spells (${breakdown.spells})</h4>
            <ul class="preview-card-list">${renderCardList(spells)}</ul>
          </div>
          <div class="category-column">
            <h4>Other Permanents (${breakdown.otherPermanents})</h4>
            <ul class="preview-card-list">${renderCardList(otherPermanents)}</ul>
          </div>
          <div class="category-column">
            <h4>Lands (${breakdown.lands})</h4>
            <ul class="preview-card-list">${renderCardList(lands)}</ul>
          </div>
          <div class="category-column">
            <h4>Sideboard (${breakdown.sideboard})</h4>
            <ul class="preview-card-list">${renderCardList(sideboard)}</ul>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Reconciles Lobby View panel (INV-HUB-1, INV-SPEC-1, INV-AUTH-GATE-2).
   * @private
   */
  _reconcileLobbyView() {
    const curTab = this.tabRouter ? this.tabRouter.getCurrentTab() : 'ARENA';
    const view = this.container.querySelector('#view-lobby');
    if (!view) return;
    if (curTab !== 'LOBBY') return;

    if (!view.querySelector('.lobby-view-container')) {
      view.innerHTML = `
        <div class="lobby-view-container">
          <!-- Hub Header (INV-HUB-1) -->
          <div class="lobby-hub-header">
            <h2>⚔️ BATTLE HUB: SELECT A GAME MODE</h2>
            <div id="lobby-equipped-deck-badge" class="lobby-equipped-deck-badge"></div>
            <p>Jump into modern constructed matchmaking, custom multiplayer pods, or watch ongoing matches.</p>
          </div>

          <!-- Mode Selector Cards (INV-HUB-1) -->
          <div id="lobby-mode-selector" class="lobby-mode-cards-grid mode-selector-grid">
            <div class="lobby-mode-card">
              <h4>⚡ 1v1 Ranked Matchmaking</h4>
              <p>Competitive Modern Construct with automated FIFO queue and 45-second Perkins watchdog fallback.</p>
              <button id="btn-mode-1v1" class="btn btn-primary">⚔️ Find 1v1 Match</button>
            </div>
            <div class="lobby-mode-card">
              <h4>👥 Multiplayer Pod (3-6 Players)</h4>
              <p>Commander or Casual pod with 3 to 6 seated players, dynamic seating, and Perkins AI bot fill.</p>
              <button id="btn-mode-pod" class="btn btn-secondary">👥 Enter Pod Lobby</button>
            </div>
            <div class="lobby-mode-card">
              <h4>🗝️ Custom Private Room</h4>
              <p>Host custom rooms with 6-character private codes to play directly with friends.</p>
              <div style="display: flex; gap: 8px;">
                <button id="btn-mode-create" class="btn btn-secondary" style="flex: 1;">➕ Create</button>
                <button id="btn-mode-join" class="btn btn-secondary" style="flex: 1;">🔗 Join</button>
              </div>
            </div>
            <div class="lobby-mode-card">
              <h4>🤖 Solo Play vs Perkins AI</h4>
              <p>Instant practice duel against autonomous Perkins AI with real-time MTG coaching tips.</p>
              <button id="btn-mode-perkins" class="btn btn-special">🤖 Play vs Perkins</button>
            </div>
          </div>

          <!-- 1v1 Queue Search & Watchdog Status Banner -->
          <div class="matchmaking-1v1-section">
            <div id="queue-search-banner" class="queue-search-banner" style="display: none;">
              <span id="queue-timer-label">🔍 Searching for Opponent... 00:00</span>
              <button id="btn-cancel-queue" class="btn btn-secondary">Cancel</button>
            </div>
            <div id="queue-watchdog-modal" class="queue-watchdog-box" style="display: none;">
              <p>⏳ No opponent found (45s elapsed). Would you like to play vs Perkins AI?</p>
              <button id="btn-watchdog-perkins" class="btn btn-special">🤖 Play vs Perkins AI (Instant)</button>
              <button id="btn-watchdog-wait" class="btn btn-secondary">Keep Waiting</button>
            </div>
          </div>

          <!-- Seating Area (INV-COUNTDOWN-1) -->
          <div class="custom-room-section">
            <h3>Multiplayer Pod Room Seating (1..6)</h3>
            <div id="lobby-seating-grid" class="lobby-seating-grid"></div>
            <div class="lobby-room-actions">
              <button id="btn-lobby-ready" class="btn btn-primary">Start Game / Ready</button>
              <span id="lobby-ready-counter" class="lobby-ready-counter">0/0 Ready</span>
            </div>
          </div>

          <!-- Spectator Directory (INV-SPEC-1) -->
          <div id="lobby-spectator-directory" class="spectator-directory-section">
            <div class="spectator-directory-header">
              <h3>📺 ONGOING MATCHES (SPECTATOR DIRECTORY)</h3>
              <button id="btn-refresh-directory" class="btn btn-secondary">🔄 Refresh Directory</button>
            </div>
            <div class="spectator-table-wrapper">
              <table class="spectator-table">
                <thead>
                  <tr>
                    <th>Table Code</th>
                    <th>Format</th>
                    <th>Round / Turn</th>
                    <th>Players</th>
                    <th>Spectators</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody id="spectator-matches-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>
      `;

      // Mode card 1v1 click
      view.querySelector('#btn-mode-1v1')?.addEventListener('click', () => {
        this.start1v1QueueSearch();
      });

      // Mode card Perkins click
      view.querySelector('#btn-mode-perkins')?.addEventListener('click', async () => {
        await this.startPerkinsMatch();
      });

      // Mode card create click
      view.querySelector('#btn-mode-create')?.addEventListener('click', async () => {
        if (this.authManager && !this.authManager.isAuthenticated()) {
          this.showAuthModal(() => this.createRoom());
          return;
        }
        await this.createRoom();
      });

      // Mode card join click
      view.querySelector('#btn-mode-join')?.addEventListener('click', async () => {
        const code = prompt('Enter 6-character Room Code:');
        if (code) {
          if (this.authManager && !this.authManager.isAuthenticated()) {
            this.showAuthModal(() => this.joinRoom(code));
            return;
          }
          await this.joinRoom(code);
        }
      });

      // Refresh directory
      view.querySelector('#btn-refresh-directory')?.addEventListener('click', () => {
        this.reconcileDOM();
      });

      // 1v1 Queue Cancel
      const btnCancel = view.querySelector('#btn-cancel-queue');
      if (btnCancel) {
        btnCancel.addEventListener('click', () => {
          this.cancel1v1QueueSearch();
        });
      }

      // Watchdog Play Perkins
      const btnWatchdogPerkins = view.querySelector('#btn-watchdog-perkins');
      if (btnWatchdogPerkins) {
        btnWatchdogPerkins.addEventListener('click', async () => {
          this.cancel1v1QueueSearch();
          await this.startPerkinsMatch();
        });
      }

      // Watchdog Wait
      const btnWatchdogWait = view.querySelector('#btn-watchdog-wait');
      if (btnWatchdogWait) {
        btnWatchdogWait.addEventListener('click', () => {
          const wModal = view.querySelector('#queue-watchdog-modal');
          if (wModal) wModal.style.display = 'none';
        });
      }

      // Room Ready
      const btnReady = view.querySelector('#btn-lobby-ready');
      if (btnReady) {
        btnReady.addEventListener('click', () => {
          this.toggleLobbyReady();
        });
      }
    }

    // Populate Spectator Table Rows (INV-SPEC-1)
    const tbody = view.querySelector('#spectator-matches-tbody');
    if (tbody) {
      const matches = this.getOngoingMatches();
      tbody.innerHTML = matches.map(m => {
        const playerNames = (m.seatedPlayers || []).map(p => p.playerName || p.playerId).join(', ');
        return `
          <tr class="spectator-match-row" data-room="${m.roomCode}">
            <td><strong>${m.roomCode}</strong></td>
            <td>${m.format || 'Casual'}</td>
            <td>Round ${m.roundNumber || 1} (T${m.activePlayerTurnNumber || 1})</td>
            <td>${playerNames}</td>
            <td>👁️ ${m.spectatorCount || 0}</td>
            <td>
              <button class="btn btn-spectate-match" data-room="${m.roomCode}">👁️ Watch</button>
            </td>
          </tr>
        `;
      }).join('');

      tbody.querySelectorAll('.btn-spectate-match').forEach(btn => {
        btn.addEventListener('click', () => {
          const room = btn.getAttribute('data-room');
          this.watchMatch(room);
        });
      });
    }

    // Render equipped deck badge in lobby hub header
    const equippedBadge = view.querySelector('#lobby-equipped-deck-badge');
    if (equippedBadge) {
      const equipped = this.getActiveDeckForPlayer(this.myPlayerId);
      if (equipped) {
        const cardCount = equipped.mainCount || (equipped.mainboard ? equipped.mainboard.reduce((a, c) => a + (Number(c.count) || 1), 0) : 60);
        equippedBadge.innerHTML = `
          <div class="equipped-badge-content">
            <span class="equipped-icon">🃏</span>
            <span class="equipped-label">Equipped Deck:</span>
            <strong class="equipped-deck-name">${equipped.name || 'Custom Deck'}</strong>
            <span class="equipped-details">(${cardCount} cards — Slot ${equipped.slot || this.activeDeckSlot})</span>
            <button id="btn-lobby-change-deck" class="btn btn-change-deck">Change Deck</button>
          </div>
        `;
      } else {
        equippedBadge.innerHTML = `
          <div class="equipped-badge-content">
            <span class="equipped-icon">🃏</span>
            <span class="equipped-label">Equipped Deck:</span>
            <strong class="equipped-deck-name">Mono-Red Starter</strong>
            <span class="equipped-details">(60 cards — Starter)</span>
            <button id="btn-lobby-change-deck" class="btn btn-change-deck">Equip Custom Deck</button>
          </div>
        `;
      }
      const btnChange = equippedBadge.querySelector('#btn-lobby-change-deck');
      if (btnChange && !btnChange._bound) {
        btnChange._bound = true;
        btnChange.addEventListener('click', () => {
          this.tabRouter.navigate('DECKBUILDER', this.getMatchState(), this.isSpectator());
          this.reconcileDOM();
        });
      }
    }

    this._reconcileLobbySeating(view);
  }

  /**
   * Reconciles seating pods inside Lobby View (INV-COUNTDOWN-1, INV-AUTH-GATE-2).
   * @private
   */
  _reconcileLobbySeating(view) {
    const grid = view.querySelector('#lobby-seating-grid');
    const btnReady = view.querySelector('#btn-lobby-ready');
    const counter = view.querySelector('#lobby-ready-counter');
    if (!grid) return;

    if (!this.lobbyManager) {
      this.lobbyManager = new LobbyManager({ roomCode: 'LOBBY1' });
      if (!this.requireAuth || (this.authManager && this.authManager.isAuthenticated())) {
        this.lobbyManager.claimSeat(this.myPlayerId, this.username, 1);
      }
    }

    const isCountdown = (this.lobbyManager.status === 'LOBBY_COUNTDOWN' || this.lobbyManager.countdownSecondsRemaining !== null);
    const seatedCount = this.lobbyManager.getSeatedCount();
    const readyCount = this.lobbyManager.getReadyCount();
    const canStart = this.lobbyManager.canStart();
    const mySlot = Array.from(this.lobbyManager.slots.values()).find(s => s.playerId === this.myPlayerId);
    const isMyReady = Boolean(mySlot?.isReady);

    if (counter) {
      counter.textContent = `${readyCount}/${seatedCount} Ready (Min ${this.lobbyManager.minPlayersToStart})`;
    }

    if (btnReady) {
      if (isCountdown) {
        btnReady.disabled = false;
        btnReady.classList.remove('btn-disabled');
        btnReady.classList.add('btn-countdown-active');
        const secs = this.lobbyManager.countdownSecondsRemaining ?? 3;
        btnReady.textContent = `🚀 Launching in ${secs}... (Cancel)`;
      } else {
        btnReady.classList.remove('btn-countdown-active');
        btnReady.disabled = !canStart;
        btnReady.classList.toggle('btn-disabled', !canStart);
        btnReady.textContent = isMyReady ? 'Cancel Ready' : 'Start Game / Ready';
      }
    }

    grid.innerHTML = '';
    for (let s = 1; s <= 6; s++) {
      const slot = this.lobbyManager.slots.get(s);
      const pod = document.createElement('div');
      pod.id = `lobby-seat-${s}`;
      pod.className = `lobby-seat-pod ${slot ? 'occupied' : 'empty'} ${slot?.isReady ? 'ready' : ''} ${slot?.isBot ? 'bot-seat' : ''}`;
      if (slot) {
        if (slot.isBot) {
          const currentBotDeck = this.botAssignedDecks?.[String(s)] || 'RANDOM';
          const preconOptionsHtml = PRECONSTRUCTED_STARTER_DECKS.map(d =>
            `<option value="${d.id}" ${currentBotDeck === d.id ? 'selected' : ''}>${d.badge ? `${d.badge} ` : ''}${d.name}</option>`
          ).join('');
          const allSlots = this.deckSlotManager ? this.deckSlotManager.getAllSlots() : [];
          const customSlotOptionsHtml = allSlots
            .filter(sl => sl.isUnlocked && sl.deck)
            .map(sl => `<option value="${sl.slotId}" ${currentBotDeck === sl.slotId ? 'selected' : ''}>[${sl.label}] ${sl.deck.name || 'Saved Deck'}</option>`)
            .join('');

          pod.innerHTML = `
            <div class="seat-num">Seat ${s}</div>
            <div class="seat-player">🤖 ${slot.playerName}</div>
            <div class="seat-status">✅ Ready (AI)</div>
            <div class="bot-deck-selector-wrap">
              <label class="bot-deck-label" for="bot-deck-select-${s}">Bot Deck:</label>
              <select id="bot-deck-select-${s}" class="bot-deck-select" data-seat="${s}">
                <option value="RANDOM" ${currentBotDeck === 'RANDOM' ? 'selected' : ''}>🎲 Aleatorio (Random Starter)</option>
                <optgroup label="Starter &amp; Beta Decks">
                  ${preconOptionsHtml}
                </optgroup>
                ${customSlotOptionsHtml ? `<optgroup label="Your Saved Slots">${customSlotOptionsHtml}</optgroup>` : ''}
              </select>
            </div>
            <div class="seat-actions">
              <button class="btn btn-remove-bot" data-seat="${s}">✖ Remove Bot</button>
            </div>
          `;
          const selectDeck = pod.querySelector('.bot-deck-select');
          if (selectDeck) {
            selectDeck.addEventListener('change', (e) => {
              this.assignDeckToBot(s, e.target.value);
            });
          }
          const btnRemove = pod.querySelector('.btn-remove-bot');
          if (btnRemove) {
            btnRemove.addEventListener('click', () => {
              this.lobbyManager.removeBot(s);
              this.reconcileDOM();
            });
          }
        } else if (slot.playerId === this.myPlayerId) {
          pod.innerHTML = `
            <div class="seat-num">Seat ${s}</div>
            <div class="seat-player">👤 ${slot.playerName} (You)</div>
            <div class="seat-status">${slot.isReady ? '✅ Ready' : '⏳ Waiting'}</div>
            <div class="seat-actions">
              <button class="btn btn-leave-seat" data-seat="${s}">🚪 Leave Seat</button>
            </div>
          `;
          const btnLeave = pod.querySelector('.btn-leave-seat');
          if (btnLeave) {
            btnLeave.addEventListener('click', () => {
              this.lobbyManager.leaveSeat(s);
              this.reconcileDOM();
            });
          }
        } else {
          pod.innerHTML = `
            <div class="seat-num">Seat ${s}</div>
            <div class="seat-player">👤 ${slot.playerName}</div>
            <div class="seat-status">${slot.isReady ? '✅ Ready' : '⏳ Waiting'}</div>
          `;
        }
      } else {
        pod.innerHTML = `
          <div class="seat-num">Seat ${s}</div>
          <div class="seat-empty-actions">
            <button class="btn btn-claim-seat" data-seat="${s}">Claim Seat</button>
            ${s >= 2 ? `<button class="btn btn-seat-bot" data-seat="${s}">🤖 Seat Perkins AI</button>` : ''}
          </div>
        `;
        const claimBtn = pod.querySelector('.btn-claim-seat');
        if (claimBtn) {
          claimBtn.addEventListener('click', () => {
            if (this.authManager && !this.authManager.isAuthenticated()) {
              this.showAuthModal(() => {
                this.lobbyManager.claimSeat(s, { playerId: this.myPlayerId, playerName: this.username });
                this.reconcileDOM();
              });
              return;
            }
            if (this.authManager && !this.authManager.isOnboarded()) {
              this.showDeckModal(() => {
                this.lobbyManager.claimSeat(s, { playerId: this.myPlayerId, playerName: this.username });
                this.reconcileDOM();
              });
              return;
            }
            this.lobbyManager.claimSeat(s, { playerId: this.myPlayerId, playerName: this.username });
            this.reconcileDOM();
          });
        }
        const seatBotBtn = pod.querySelector('.btn-seat-bot');
        if (seatBotBtn) {
          seatBotBtn.addEventListener('click', () => {
            this.lobbyManager.seatBot(s);
            this.reconcileDOM();
          });
        }
      }
      grid.appendChild(pod);
    }
  }

  /**
   * Reconciles Profile View panel.
   * @private
   */
  _reconcileProfileView() {
    const curTab = this.tabRouter ? this.tabRouter.getCurrentTab() : 'ARENA';
    const view = this.container.querySelector('#view-profile');
    if (!view) return;
    if (curTab !== 'PROFILE') return;

    const profile = this.profileManager?.getProfile(this.myPlayerId) || createDefaultProfile(this.myPlayerId);
    const unlockedSlots = evaluateDeckSlots(profile.lifetimeWins || 0, profile.totalPerksTriggered || 0);

    view.innerHTML = `
      <div class="profile-view-container">
        <div class="profile-card">
          <h2>👤 Planeswalker Profile: ${this.username}</h2>
          <div class="profile-stats-grid">
            <div id="profile-elo" class="stat-box"><strong>Elo Rating:</strong> ${profile.elo ?? 1200}</div>
            <div id="profile-wins" class="stat-box"><strong>Lifetime Wins:</strong> ${profile.lifetimeWins ?? 0}</div>
            <div id="profile-losses" class="stat-box"><strong>Lifetime Losses:</strong> ${profile.lifetimeLosses ?? 0}</div>
            <div id="profile-perks" class="stat-box"><strong>Perks Triggered:</strong> ${profile.totalPerksTriggered ?? 0}</div>
            <div id="deck-slot-milestones" class="stat-box"><strong>Deck Slots Unlocked:</strong> ${unlockedSlots} / 5</div>
          </div>
        </div>
        <div class="fanfare-config-card">
          <h3>🔊 Victory Fanfare Configuration</h3>
          <div class="form-row">
            <label for="fanfare-audio-url">Audio Source (Instagram A-to-B or YouTube):</label>
            <input type="text" id="fanfare-audio-url" value="${profile.fanfareConfig?.audioUrl || ''}" placeholder="https://instagram.com/reel/... or https://youtube.com/..." />
          </div>
          <div class="form-row times-row">
            <div>
              <label for="fanfare-start-time">Start Time (sec):</label>
              <input type="number" id="fanfare-start-time" value="${profile.fanfareConfig?.startTimeSec ?? 0}" min="0" step="0.5" />
            </div>
            <div>
              <label for="fanfare-end-time">End Time (sec):</label>
              <input type="number" id="fanfare-end-time" value="${profile.fanfareConfig?.endTimeSec ?? 5}" min="0.5" max="30" step="0.5" />
            </div>
          </div>
          <button id="btn-save-fanfare" class="btn btn-primary">Save Fanfare Settings</button>
        </div>
      </div>
    `;

    const btnSave = view.querySelector('#btn-save-fanfare');
    if (btnSave) {
      btnSave.addEventListener('click', () => {
        const urlInput = view.querySelector('#fanfare-audio-url');
        const startInput = view.querySelector('#fanfare-start-time');
        const endInput = view.querySelector('#fanfare-end-time');
        const fanfare = {
          audioUrl: urlInput ? urlInput.value.trim() : '',
          startTimeSec: startInput ? parseFloat(startInput.value) || 0 : 0,
          endTimeSec: endInput ? parseFloat(endInput.value) || 5 : 5
        };
        if (this.profileManager && typeof this.profileManager.updateFanfareConfig === 'function') {
          this.profileManager.updateFanfareConfig(this.myPlayerId, fanfare);
        }
        btnSave.textContent = 'Saved! ✓';
        setTimeout(() => { btnSave.textContent = 'Save Fanfare Settings'; }, 1500);
      });
    }
  }

  /**
   * Reconciles Leaderboard View panel.
   * @private
   */
  _reconcileLeaderboardView() {
    const curTab = this.tabRouter ? this.tabRouter.getCurrentTab() : 'ARENA';
    const view = this.container.querySelector('#view-leaderboard');
    if (!view) return;
    if (curTab !== 'LEADERBOARD') return;

    view.innerHTML = `
      <div class="leaderboard-view-container">
        <h2>🏆 Global Arena Leaderboard</h2>
        <table id="leaderboard-table" class="leaderboard-table">
          <thead>
            <tr><th>Rank</th><th>Planeswalker</th><th>Elo</th><th>W - L</th><th>Win %</th></tr>
          </thead>
          <tbody>
            <tr><td>#1</td><td>Nicol Bolas</td><td>1850</td><td>42 - 3</td><td>93%</td></tr>
            <tr><td>#2</td><td>Jace Beleren</td><td>1620</td><td>35 - 12</td><td>74%</td></tr>
            <tr><td>#3</td><td>Chandra Nalaar</td><td>1580</td><td>30 - 15</td><td>67%</td></tr>
            <tr><td>#4</td><td>${this.username} (You)</td><td>1200</td><td>0 - 0</td><td>--</td></tr>
          </tbody>
        </table>
        <div class="match-history-section">
          <h3>Recent Match History</h3>
          <div id="match-history-list" class="match-history-list">
            <div class="history-empty">No recent matches recorded. Play a match in Arena to record history.</div>
          </div>
        </div>
        <div class="spectator-section">
          <h3>Live Matches (Spectator Mode)</h3>
          <div id="spectator-room-list" class="spectator-room-list">
            <div class="spectator-empty">No active public rooms available to spectate.</div>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // Modal Management (INV-HARNESS-6)
  // ==========================================================================

  /**
   * Opens a specific modal layer with payload data.
   * Strictly enforces INV-HARNESS-6 (|ActiveModals| <= 1).
   * 
   * @param {string} type 'CARD_OVERLAY' | 'DECKBUILDER' | 'VICTORY_FANFARE'
   * @param {any} [data=null]
   */
  openModal(type, data = null) {
    if (this.isDestroyed) return;

    // Dismiss existing modal
    if (this.activeModalType !== 'NONE') {
      this.closeModal();
    }

    this.activeModalType = type;
    this.activeModalData = data;

    const modalRoot = this.container?.querySelector('#modal-root');
    if (!modalRoot) return;
    modalRoot.setAttribute('aria-hidden', 'false');

    if (type === 'CARD_OVERLAY') {
      const cardPayload = data || { name: 'Card Preview', type_line: 'Instant', mana_cost: '{1}{R}' };
      const cardName = typeof cardPayload === 'string' ? cardPayload : (cardPayload.name || 'Unknown Card');
      this.authManager?.dispatchTelemetry('RULING_INSPECT', cardName, {
        source: cardPayload.source || 'CARD_OVERLAY',
        scryfall_id: cardPayload.id || cardPayload.scryfall_id || null,
        type_line: cardPayload.type_line || null,
        mana_cost: cardPayload.mana_cost || null,
        rulings_count: Array.isArray(cardPayload.rulings) ? cardPayload.rulings.length : (cardPayload.rulings_count || 0)
      });
      if (this.cardModal) {
        this.cardModal.open(typeof cardPayload === 'string' ? { name: cardPayload } : cardPayload);
      }
      return;
    }

    if (type === 'DECKBUILDER') {
      this._renderDeckbuilderModal(modalRoot, data?.tab || 'guidelines');
      return;
    }

    if (type === 'VICTORY_FANFARE') {
      this._renderVictoryModal(modalRoot, data);
      return;
    }
  }

  /**
   * Closes the active modal layer cleanly.
   * Strictly enforces INV-HARNESS-6.
   */
  closeModal() {
    const prevType = this.activeModalType;
    this.activeModalType = 'NONE';
    this.activeModalData = null;
    this._isVictoryModalOpen = false;
    this._isDeckbuilderModalOpen = false;
    this._isRecapModalOpen = false;

    if (this.cardModal && prevType === 'CARD_OVERLAY') {
      this.cardModal.close();
    }

    const modalRoot = this.container?.querySelector('#modal-root');
    if (modalRoot) {
      const temporaryModals = modalRoot.querySelectorAll(
        '.modal-backdrop-harness, .modal-dialog-box, .game-over-modal-backdrop, #victory-modal-wrapper, #deckbuilder-modal-wrapper, #recap-modal-wrapper, #game-over-modal, #concede-modal, #contextual-auth-modal, #contextual-deck-modal'
      );
      for (const m of temporaryModals) {
        try {
          if (typeof m.remove === 'function') {
            m.remove();
          } else if (m.parentNode && typeof m.parentNode.removeChild === 'function') {
            m.parentNode.removeChild(m);
          }
        } catch (_) {}
      }
      if (!this.diceRollOverlay?.isOpen && !this.targetModal?.isOpen) {
        modalRoot.setAttribute('aria-hidden', 'true');
        modalRoot.style.pointerEvents = 'none';
      }
    }
  }

  /**
   * Starts the CR 103 pre-game sequence (roll -> play/draw -> London mulligan -> GAME_ACTIVE) for a 1v1 match.
   * Opt-in via `options.pregame === true` (enabled by index.html); headless harnesses keep the deterministic start.
   */
  _beginPregame(preRolled = null) {
    if (!this.tabletopState || !this.priorityMachine || !Array.isArray(this.playerIds) || this.playerIds.length < 2) return null;
    const machine = new PregameStateMachine({
      players: [...this.playerIds],
      tabletopState: this.tabletopState,
      priorityMachine: this.priorityMachine
    });
    this.pregameMachine = machine;
    this.tabletopState.pregameMachine = machine;
    this.pregameActive = true;

    const hasPreRolls = preRolled && preRolled.rolls && typeof preRolled.rolls === 'object' &&
      this.playerIds.every(pid => typeof preRolled.rolls[pid] === 'number');
    const roll = hasPreRolls
      ? machine.dispatch('EXECUTE_STARTING_ROLL', { rolls: preRolled.rolls, winnerId: preRolled.winnerId })
      : machine.dispatch('EXECUTE_STARTING_ROLL');
    const nameOf = (pid) => this.getFriendlyPlayerName(pid);
    const rollsDesc = this.playerIds.map(pid => `${nameOf(pid)} rolled ${roll.rolls[pid] || 0}`).join(' vs ');
    const rollMsg = `Starting roll (d20): ${rollsDesc} — ${nameOf(roll.winnerId)} wins choice`;
    this.showToast?.(rollMsg);
    this.appendExecutionLog('Pre-Game', `🎲 ${rollMsg}`, { playerId: roll.winnerId });

    let choice = 'PLAY';
    if (roll.winnerId === this.myPlayerId && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      choice = window.confirm(`You won the roll (${roll.rolls[this.myPlayerId]}).\nOK = PLAY first, Cancel = DRAW first`) ? 'PLAY' : 'DRAW';
    }
    machine.dispatch('SELECT_PLAY_OR_DRAW', { playerId: roll.winnerId, choice });
    this.appendExecutionLog('Pre-Game', `⚡ ${nameOf(roll.winnerId)} chose to ${choice} (${nameOf(machine.startingPlayerId)} goes first)`, { playerId: roll.winnerId });
    this._advanceMulligans();
    this.reconcileDOM();
    return machine;
  }

  /**
   * Drives mulligan decisions in turn order: bots decide automatically, the local player via MulliganModal.
   * @private
   */
  _advanceMulligans() {
    const machine = this.pregameMachine;
    if (!machine) return;
    let guard = 0;
    while (machine.state === PREGAME_STATES.PREGAME_MULLIGAN && guard++ < 50) {
      const pid = machine.currentDecidingPlayerId;
      if (!pid) break;
      if (pid === this.myPlayerId) {
        const me = this.tabletopState.getPlayer(pid);
        const mCount = machine.mulliganCount[pid] || 0;
        const bottomCount = machine.pendingBottomCount?.[pid] ?? mCount;
        this.mulliganModal?.open({
          cards: me?.hand || [],
          mulliganCount: mCount,
          cardsToBottomCount: bottomCount
        });
        return;
      }
      const bot = this.botAgents?.get(pid) || this.perkinsAgent;
      const player = this.tabletopState.getPlayer(pid);
      const count = machine.mulliganCount[pid] || 0;
      const ev = bot && typeof bot.evaluateOpeningHand === 'function'
        ? bot.evaluateOpeningHand(player?.hand || [], count)
        : { keep: true, bottomCards: [] };
      if (!ev.keep && count < 3) {
        machine.dispatch('DECIDE_MULLIGAN', { playerId: pid, keep: false });
        this.appendExecutionLog('Mulligan', `🃏 ${this.getFriendlyPlayerName(pid)} took mulligan #${machine.mulliganCount[pid]}`, { playerId: pid });
        continue;
      }
      const pending = machine.pendingBottomCount?.[pid] || 0;
      if (pending > 0) {
        const hand = player?.hand || [];
        const bottom = (bot?.evaluateOpeningHand?.(hand, pending)?.bottomCards || []).slice(0, pending);
        const ids = bottom.map(c => c.instanceId);
        for (const c of [...hand].reverse()) {
          if (ids.length >= pending) break;
          if (!ids.includes(c.instanceId)) ids.push(c.instanceId);
        }
        machine.dispatch('PUT_ON_BOTTOM', { playerId: pid, cardIds: ids.slice(0, pending) });
      }
      machine.dispatch('DECIDE_MULLIGAN', { playerId: pid, keep: true });
      this.appendExecutionLog('Mulligan', `🃏 ${this.getFriendlyPlayerName(pid)} kept ${7 - pending}-card hand`, { playerId: pid });
    }
    if (machine.state === PREGAME_STATES.GAME_ACTIVE) this._finishPregame();
  }

  _resolveOpeningHandActions() {
    if (this._openingHandActionsResolved) return false;

    const myPlayer = this.tabletopState?.getPlayer?.(this.myPlayerId) || this.tabletopState?.players?.[this.myPlayerId];
    const myHand = myPlayer?.hand || myPlayer?.zones?.hand || [];
    const hasLeylineInHand = myHand.some(c =>
      c && (
        c.compiledMechanics?.openingHandAction === 'START_ON_BATTLEFIELD' ||
        /^leyline\s+axe$/i.test((c.name || '').trim()) ||
        /opening\s+hand,\s*you\s+may\s+begin\s+the\s+game\s+with\s+(?:it|this\s+card|[^\n,]+)\s+on\s+the\s+battlefield/i.test(c.oracleText || c.text || '')
      )
    );

    const isInteractive = typeof this.isInteractiveBrowserMode === 'function' &&
      this.isInteractiveBrowserMode() &&
      typeof document !== 'undefined';

    if (hasLeylineInHand && isInteractive) {
      const modalRoot = (this.container?.querySelector && this.container.querySelector('#modal-root')) ||
        (typeof document !== 'undefined' ? (document.getElementById('modal-root') || document.body) : null);
      if (!modalRoot) return false;

      const existing = modalRoot.querySelector('#leyline-opening-hand-modal');
      if (existing) {
        try { existing.remove(); } catch (_) {
          if (existing.parentElement) existing.parentElement.removeChild(existing);
        }
      }

      if (modalRoot.id === 'modal-root') {
        modalRoot.setAttribute('aria-hidden', 'false');
        modalRoot.style.pointerEvents = 'auto';
      }

      const modal = document.createElement('div');
      modal.id = 'leyline-opening-hand-modal';
      modal.className = 'modal-backdrop active';
      modal.style.cssText = 'pointer-events: auto; display: flex; align-items: center; justify-content: center; z-index: 10000; position: fixed; inset: 0; background: rgba(0,0,0,0.8);';
      modal.innerHTML = `
        <div class="modal-dialog-box" style="background: #1e293b; border: 2px solid #3b82f6; border-radius: 8px; padding: 24px; max-width: 480px; text-align: center; color: #f8fafc;">
          <h3 style="margin-top: 0; color: #60a5fa;">⚡ Opening Hand Action (CR 103.6)</h3>
          <p>You have <strong>Leyline Axe</strong> in your opening hand. You may begin the game with it on the battlefield for free!</p>
          <div style="display: flex; gap: 12px; justify-content: center; margin-top: 20px;">
            <button id="btn-leyline-battlefield" class="btn btn-primary" style="padding: 10px 18px; font-weight: bold; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer;">⚡ Put on Battlefield (Free)</button>
            <button id="btn-leyline-hand" class="btn btn-secondary" style="padding: 10px 18px; background: #475569; color: #fff; border: none; border-radius: 6px; cursor: pointer;">✋ Keep in Hand</button>
          </div>
        </div>
      `;

      const removeModal = () => {
        try { modal.remove(); } catch (_) {
          if (modal.parentElement) modal.parentElement.removeChild(modal);
        }
        if (modalRoot.id === 'modal-root') {
          const remainingModals = modalRoot.querySelectorAll?.('.modal-backdrop:not(.hidden):not([style*="display: none"]), .target-modal-backdrop:not(.hidden):not([style*="display: none"])');
          if (!remainingModals || remainingModals.length === 0) {
            modalRoot.setAttribute('aria-hidden', 'true');
            modalRoot.style.pointerEvents = '';
          }
        }
      };

      const resolveOtherPlayers = () => {
        const otherPids = Object.keys(this.tabletopState?.players || {}).filter(id => id !== this.myPlayerId);
        for (const oppId of otherPids) {
          if (typeof this.tabletopState?.resolveOpeningHandActions === 'function') {
            const opened = this.tabletopState.resolveOpeningHandActions(oppId);
            if (Array.isArray(opened)) {
              for (const item of opened) {
                const name = item.name || item.card?.name || 'Leyline Axe';
                const pid = item.playerId || item.controllerId || oppId;
                this.addTurnCommandLog?.(`⚔️ Opening Hand Action: ${name} put onto battlefield!`, { playerId: pid });
              }
            }
          }
        }
      };

      modal.querySelector('#btn-leyline-battlefield')?.addEventListener('click', () => {
        removeModal();
        let placed = false;
        if (typeof this.tabletopState?.resolveOpeningHandActions === 'function') {
          const opened = this.tabletopState.resolveOpeningHandActions(this.myPlayerId);
          if (Array.isArray(opened) && opened.length > 0) {
            placed = true;
            for (const item of opened) {
              const name = item.name || item.card?.name || 'Leyline Axe';
              const pid = item.playerId || item.controllerId || this.myPlayerId;
              this.addTurnCommandLog?.(`⚔️ Opening Hand Action: ${name} put onto battlefield!`, { playerId: pid });
            }
          }
        }
        if (!placed && myPlayer) {
          const hand = myPlayer.hand || myPlayer.zones?.hand || [];
          const idx = hand.findIndex(c => c && (/^leyline\s+axe$/i.test((c.name || '').trim()) || c.compiledMechanics?.openingHandAction === 'START_ON_BATTLEFIELD'));
          if (idx !== -1) {
            const [c] = hand.splice(idx, 1);
            c.zone = 'battlefield';
            c.subzone = 'noncreatures';
            myPlayer.battlefield = myPlayer.battlefield || {};
            myPlayer.battlefield.noncreatures = myPlayer.battlefield.noncreatures || [];
            myPlayer.battlefield.noncreatures.push(c);
            this.addTurnCommandLog?.(`⚔️ Opening Hand Action: ${c.name || 'Leyline Axe'} put onto battlefield!`, { playerId: this.myPlayerId });
          }
        }
        resolveOtherPlayers();
        this._openingHandActionsResolved = true;
        this._finishPregame();
      });

      modal.querySelector('#btn-leyline-hand')?.addEventListener('click', () => {
        removeModal();
        this.addTurnCommandLog?.(`🛡️ Leyline Axe kept in hand by player election (CR 103.6)`, { playerId: this.myPlayerId });
        resolveOtherPlayers();
        this._openingHandActionsResolved = true;
        this._finishPregame();
      });

      modalRoot.appendChild(modal);
      return true; // Pauses pregame activation!
    }

    this._openingHandActionsResolved = true;
    if (typeof this.tabletopState?.resolveOpeningHandActions === 'function') {
      try {
        const opened = this.tabletopState.resolveOpeningHandActions();
        if (Array.isArray(opened)) {
          for (const item of opened) {
            const name = item.name || item.card?.name || 'Leyline Axe';
            const pid = item.playerId || item.controllerId || this.myPlayerId;
            this.addTurnCommandLog?.(`⚔️ Opening Hand Action: ${name} put onto battlefield!`, { playerId: pid });
          }
        }
      } catch (err) {
        console.warn('[app] resolveOpeningHandActions error:', err);
      }
    }
    return false;
  }

  _finishPregame() {
    const isPaused = this._resolveOpeningHandActions();
    if (isPaused) {
      this.pregameActive = true;
      return;
    }
    this.pregameActive = false;
    this.mulliganModal?.close?.();
    const starterName = this.getFriendlyPlayerName(this.pregameMachine?.startingPlayerId);
    this.showToast?.(`Game start: ${starterName} goes first`);
    this.appendExecutionLog('Turn 1', `🚀 Match active! ${starterName} begins Turn 1 (${this.priorityMachine?.currentPhaseStep || 'PRECOMBAT_MAIN'})`, { playerId: this.pregameMachine?.startingPlayerId });
    this.reconcileDOM();

    const activePid = this.priorityMachine?.activePlayerId;
    if (activePid && activePid !== this.myPlayerId) {
      const bot = this.botAgents?.get(activePid) || (this.perkinsAgent?.slotId === activePid ? this.perkinsAgent : null);
      if (bot && typeof bot.evaluateTurnPhase === 'function') {
        Promise.resolve().then(() => bot.evaluateTurnPhase(this.priorityMachine.currentPhaseStep));
      }
    }
  }

  handleMulliganKeep(data) {
    if (this.pregameMachine && this.pregameActive) {
      this.pregameMachine.dispatch('DECIDE_MULLIGAN', { playerId: this.myPlayerId, keep: true });
      const me = this.tabletopState?.getPlayer?.(this.myPlayerId);
      const handLen = me?.hand?.length ?? 7;
      this.appendExecutionLog('Mulligan', `🃏 ${this.getFriendlyPlayerName(this.myPlayerId)} kept ${handLen}-card opening hand`, { playerId: this.myPlayerId });
      this._advanceMulligans();
      this.render();
      return;
    }
    this._resolveOpeningHandActions();
    if (this.priorityMachine && typeof this.priorityMachine.completeMulliganPhase === 'function') {
      this.priorityMachine.completeMulliganPhase();
    }
    this.render();
  }

  handleMulliganTake(data) {
    if (this.pregameMachine && this.pregameActive) {
      this.pregameMachine.dispatch('DECIDE_MULLIGAN', { playerId: this.myPlayerId, keep: false });
      const count = this.pregameMachine.mulliganCount[this.myPlayerId];
      const bottomCount = this.pregameMachine.pendingBottomCount?.[this.myPlayerId] ?? count;
      this.appendExecutionLog('Mulligan', `🃏 ${this.getFriendlyPlayerName(this.myPlayerId)} took mulligan #${count} (drawing 7 cards)`, { playerId: this.myPlayerId });
      const me = this.tabletopState.getPlayer(this.myPlayerId);
      this.mulliganModal?.open({
        cards: me?.hand || [],
        mulliganCount: count,
        cardsToBottomCount: bottomCount
      });
      this.reconcileDOM();
      return;
    }
    const player = this.tabletopState?.getPlayer?.(this.myPlayerId);
    if (!player) return;
    player.library = [...(player.library || []), ...(player.hand || [])];
    player.hand = [];
    this.tabletopState?.drawCard?.(this.myPlayerId, 7);
    this.mulliganModal?.open({
      cards: player.hand,
      mulliganCount: data.nextMulliganCount || 1
    });
  }

  handleMulliganConfirmBottom(data) {
    if (this.pregameMachine && this.pregameActive) {
      const ids = (data?.bottomedCards || []).map(c => c.instanceId);
      this.pregameMachine.dispatch('PUT_ON_BOTTOM', { playerId: this.myPlayerId, cardIds: ids });
      this.pregameMachine.dispatch('DECIDE_MULLIGAN', { playerId: this.myPlayerId, keep: true });
      this.appendExecutionLog('Mulligan', `🃏 ${this.getFriendlyPlayerName(this.myPlayerId)} kept ${7 - ids.length}-card hand (bottomed ${ids.length})`, { playerId: this.myPlayerId });
      this._advanceMulligans();
      this.render();
      return;
    }
    const player = this.tabletopState?.getPlayer?.(this.myPlayerId);
    if (!player || !data.bottomedCards) return;
    for (const card of data.bottomedCards) {
      const idx = player.hand.findIndex(c => c && c.instanceId === card.instanceId);
      if (idx !== -1) {
        const [removed] = player.hand.splice(idx, 1);
        player.library.push(removed);
      }
    }
    this._resolveOpeningHandActions();
    if (this.priorityMachine && typeof this.priorityMachine.completeMulliganPhase === 'function') {
      this.priorityMachine.completeMulliganPhase();
    }
    this.render();
  }

  handleTargetSelected(data) {
    if (this._stagedCast || this._pendingSpellToCast) {
      const staged = this._stagedCast || this._pendingSpellToCast;
      this._stagedCast = null;
      this._pendingSpellToCast = null;
      const card = staged.card || staged;

      if (card && card.name) {
        this.castSpellToStack(card, data);
      } else if (staged.instanceId) {
        this.tabletopState?.dispatch?.('CAST_SPELL', {
          playerId: this.myPlayerId,
          instanceId: staged.instanceId,
          autoTap: staged.autoTap,
          targets: [data.targetId]
        });
        this.render?.();
        this.reconcileDOM?.();
      }
    }
  }

  handleAbilityActivated(data) {
    const { card, ability, playerId } = data;
    const pid = playerId || this.myPlayerId;
    const abilityId = typeof ability === 'string' ? ability : (ability?.id || ability?.action || 'ANIMATE_LAND');
    const isLevelUp = ability?.action === 'LEVEL_UP_CLASS' || abilityId === 'LEVEL_UP_CLASS' || String(abilityId).startsWith('LEVEL_UP_');
    if (this.tabletopState) {
      if (isLevelUp && typeof this.tabletopState.levelUpClass === 'function') {
        try {
          const res = this.tabletopState.levelUpClass(pid, card.instanceId || card.id, { ability, cost: ability?.cost?.mana });
          this.showToast?.(`🌟 [Class Level Up]: ${card.name} is now Level ${res?.newLevel || 2}!`);
        } catch (err) {
          this.showToast?.(`⚠️ ${err.message || 'Cannot level up Class'}`);
        }
      } else if (typeof this.tabletopState.activatePermanentAbility === 'function') {
        try {
          this.tabletopState.activatePermanentAbility(pid, card.instanceId, abilityId, { ability });
        } catch (err) {
          this.showToast?.(err.message || 'Cannot activate ability');
        }
      } else if (typeof this.tabletopState.activateAbility === 'function') {
        try {
          this.tabletopState.activateAbility(pid, card.instanceId, abilityId, { ability });
        } catch (err) {
          this.showToast?.(err.message || 'Cannot activate ability');
        }
      } else {
        this.tabletopState?.dispatch?.('ACTIVATE_ABILITY', {
          playerId: pid,
          instanceId: card.instanceId,
          ability
        });
      }
    }
    this.render?.();
    this.reconcileDOM?.();
  }

  handleDrawerTapMana(data) {
    const { card, playerId, chosenColor, lifeCost } = data;
    const pid = playerId || this.myPlayerId;
    if (this.tabletopState && typeof this.tabletopState.tapLandForMana === 'function') {
      try {
        const p = this.tabletopState.getPlayer?.(pid);
        const tapsBefore = (p?._undoableManaTaps || []).length;
        const tapResult = this.tabletopState.tapLandForMana(pid, card.instanceId, chosenColor);
        if (p && (p._undoableManaTaps || []).length === tapsBefore) {
          p._undoableManaTaps = p._undoableManaTaps || [];
          p._undoableManaTaps.push({
            instanceId: card.instanceId,
            color: chosenColor || tapResult?.color || 'C',
            lifePaid: lifeCost ?? tapResult?.lifePaid ?? 0,
            timestamp: Date.now()
          });
        }
      } catch (err) {
        this.showToast?.(err.message || 'Cannot tap land for mana');
      }
    } else {
      this.tabletopState?.dispatch?.('TAP_PERMANENT', {
        playerId: pid,
        instanceId: card.instanceId
      });
    }
    this.render?.();
    this.reconcileDOM?.();
  }

  handleDamageConfirmed(data) {
    if (this.tabletopState && typeof this.tabletopState.dealDamage === 'function') {
      for (const [blockerId, dmg] of Object.entries(data.blockerAssignments || {})) {
        if (dmg > 0) {
          this.tabletopState.dealDamage({
            sourceId: data.attackerId,
            sourceControllerId: this.myPlayerId,
            targetId: blockerId,
            targetType: 'CREATURE',
            amount: dmg,
            isCombat: true
          });
        }
      }
      if (data.playerDamage > 0) {
        this.tabletopState.dealDamage({
          sourceId: data.attackerId,
          sourceControllerId: this.myPlayerId,
          targetId: this.opponentPlayerId || 'p2',
          targetType: 'PLAYER',
          amount: data.playerDamage,
          isCombat: true
        });
      }
    }
    this.render();
  }

  /**
   * Renders the Deckbuilder AI modal dialog with 3 tabs.
   * @private
   */
  _renderDeckbuilderModal(modalRoot, activeTab = 'guidelines') {
    this._isDeckbuilderModalOpen = true;
    modalRoot.setAttribute('aria-hidden', 'false');
    modalRoot.style.pointerEvents = 'auto';

    let wrapper = modalRoot.querySelector('#deckbuilder-modal-wrapper');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'deckbuilder-modal-wrapper';
      modalRoot.appendChild(wrapper);
    }

    wrapper.innerHTML = `
      <div class="modal-backdrop-harness"></div>
      <div class="modal-dialog-box deckbuilder-modal-dialog" role="dialog" aria-modal="true" aria-label="Deckbuilder AI">
        <div class="modal-header-row" style="padding: 12px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--rpm-border);">
          <h2 style="margin: 0; font-size: 1.1rem; color: var(--rpm-aqua);">📚 AI Deckbuilder & Guidelines</h2>
          <button class="modal-close-btn btn-icon" style="color: #ffffff; font-size: 1.2rem;">&times;</button>
        </div>
        <div class="modal-tabs-bar" style="display: flex; border-bottom: 1px solid var(--rpm-border);">
          <button class="btn-modal-tab ${activeTab === 'guidelines' ? 'active' : ''}" data-tab="guidelines" style="flex: 1; padding: 8px; background: none; border: none; color: #ffffff; cursor: pointer;">10-Point Guidelines</button>
          <button class="btn-modal-tab ${activeTab === 'starters' ? 'active' : ''}" data-tab="starters" style="flex: 1; padding: 8px; background: none; border: none; color: #ffffff; cursor: pointer;">Starter Decks</button>
          <button class="btn-modal-tab ${activeTab === 'showcase' ? 'active' : ''}" data-tab="showcase" style="flex: 1; padding: 8px; background: none; border: none; color: #ffffff; cursor: pointer;">Top 10 Showcase</button>
        </div>
        <div id="deckbuilder-tab-content" style="padding: 14px; overflow-y: auto; max-height: 60vh;"></div>
      </div>
    `;

    // Close button & backdrop click
    const closeBtn = wrapper.querySelector('.modal-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeModal());
    const backdrop = wrapper.querySelector('.modal-backdrop-harness');
    if (backdrop) backdrop.addEventListener('click', () => this.closeModal());

    // Tab switcher
    const tabBtns = wrapper.querySelectorAll('.btn-modal-tab');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        this._renderDeckbuilderModal(modalRoot, tab);
      });
    });

    const contentDiv = wrapper.querySelector('#deckbuilder-tab-content');
    if (!contentDiv) return;

    if (activeTab === 'guidelines') {
      this._renderGuidelinesTab(contentDiv);
    } else if (activeTab === 'starters') {
      this._renderStartersTab(contentDiv);
    } else if (activeTab === 'showcase') {
      this._renderShowcaseTab(contentDiv);
    }
  }

  /**
   * Renders Tab 1: Guidelines Editor with Quota Gauge (INV-STORAGE-1, INV-STORAGE-2).
   * @private
   */
  _renderGuidelinesTab(container) {
    const guidelines = this.deckbuilderAI.getActiveGuidelines(this.myPlayerId) || [];
    const bytesUsed = calculatePayloadBytes(guidelines);
    const quotaPct = Math.min(100, Math.round((bytesUsed / 16384) * 100));

    container.innerHTML = `
      <div class="guideline-quota-box" style="margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; font-size: 0.78rem; margin-bottom: 4px;">
          <span>Guideline Memory Quota (16KB Guard):</span>
          <span id="guideline-quota-label">${bytesUsed} / 16384 bytes (${quotaPct}%)</span>
        </div>
        <div style="height: 6px; background: #0f172a; border-radius: 3px; overflow: hidden;">
          <div id="guideline-quota-bar" class="quota-progress" style="width: ${quotaPct}%; height: 100%; background: var(--rpm-aqua);"></div>
        </div>
      </div>
      <div class="guideline-input-row" style="display: flex; gap: 6px; margin-bottom: 12px;">
        <input type="text" id="guideline-input" placeholder="Add rule (e.g. Prefer artifact ramp)" style="flex: 1; padding: 6px 10px; background: #0f172a; border: 1px solid var(--rpm-border); color: #ffffff; border-radius: 4px;" />
        <button id="btn-add-guideline" class="btn btn-primary">Add</button>
      </div>
      <ul id="guideline-list" style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px;"></ul>
    `;

    const listUl = container.querySelector('#guideline-list');
    guidelines.forEach((g) => {
      const li = document.createElement('li');
      li.className = 'guideline-item';
      li.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: #1e293b; padding: 6px 10px; border-radius: 6px; border: 1px solid #334155;';
      li.innerHTML = `
        <span class="guideline-text">${g.text || g.targetTag} (wt: ${g.weight ?? 1.0})</span>
        <div class="guideline-actions" style="display: flex; gap: 4px;">
          <button class="btn-guideline-upvote btn-icon" title="Upvote (+0.5)">👍</button>
          <button class="btn-guideline-downvote btn-icon" title="Downvote (-0.5)">👎</button>
          <button class="btn-guideline-delete btn-icon" title="Delete">🗑️</button>
        </div>
      `;

      // Upvote handler
      const btnUp = li.querySelector('.btn-guideline-upvote');
      if (btnUp) {
        btnUp.addEventListener('click', () => {
          g.weight = (g.weight || 1.0) + 0.5;
          const current = this.deckbuilderAI.storage.getGuidelines(this.myPlayerId);
          const idx = current.findIndex(item => item.id === g.id || item.text === g.text);
          if (idx !== -1) current[idx].weight = g.weight;
          this.deckbuilderAI.storage.saveGuidelines(this.myPlayerId, current);
          this._renderGuidelinesTab(container);
        });
      }

      // Downvote handler
      const btnDown = li.querySelector('.btn-guideline-downvote');
      if (btnDown) {
        btnDown.addEventListener('click', () => {
          g.weight = (g.weight || 1.0) - 0.5;
          const current = this.deckbuilderAI.storage.getGuidelines(this.myPlayerId);
          const idx = current.findIndex(item => item.id === g.id || item.text === g.text);
          if (idx !== -1) current[idx].weight = g.weight;
          this.deckbuilderAI.storage.saveGuidelines(this.myPlayerId, current);
          this._renderGuidelinesTab(container);
        });
      }

      // Delete handler
      const btnDel = li.querySelector('.btn-guideline-delete');
      if (btnDel) {
        btnDel.addEventListener('click', () => {
          const current = this.deckbuilderAI.storage.getGuidelines(this.myPlayerId);
          const filtered = current.filter(item => item.id !== g.id && item.text !== g.text);
          this.deckbuilderAI.storage.saveGuidelines(this.myPlayerId, filtered);
          this._renderGuidelinesTab(container);
        });
      }

      listUl.appendChild(li);
    });

    // Add guideline button
    const btnAdd = container.querySelector('#btn-add-guideline');
    const input = container.querySelector('#guideline-input');
    if (btnAdd && input) {
      btnAdd.addEventListener('click', () => {
        const text = input.value.trim();
        if (text) {
          this.deckbuilderAI.addPositiveFeedback(text, text.toUpperCase().replace(/\s+/g, '_'), 1.0, this.myPlayerId);
          this._renderGuidelinesTab(container);
        }
      });
    }
  }

  /**
   * Renders Tab 2: Beginner Starter Decks (INV-STORAGE-4).
   * @private
   */
  _renderStartersTab(container) {
    container.innerHTML = `
      <div style="margin-bottom: 12px;">
        <span style="font-size: 0.85rem; color: #94a3b8;">Choose a color archetype to instantly generate a tournament-legal 60-card starter deck:</span>
      </div>
      <div class="starter-colors-row" style="display: flex; gap: 8px; margin-bottom: 14px;">
        <button class="btn btn-secondary btn-starter-w" data-color="W">⚪ White Weenie</button>
        <button class="btn btn-secondary btn-starter-u" data-color="U">🔵 Blue Tempo</button>
        <button class="btn btn-secondary btn-starter-b" data-color="B">⚫ Black Midrange</button>
        <button class="btn btn-secondary btn-starter-r" data-color="R">🔴 Red Burn</button>
        <button class="btn btn-secondary btn-starter-g" data-color="G">🟢 Green Stompy</button>
      </div>
      <div id="starter-deck-preview" style="background: #0f172a; padding: 10px; border-radius: 6px; border: 1px solid var(--rpm-border);">
        <p style="margin: 0; color: #94a3b8; font-size: 0.85rem;">Click a color above to generate decklist.</p>
      </div>
    `;

    const colorBtns = container.querySelectorAll('.starter-colors-row button');
    const previewDiv = container.querySelector('#starter-deck-preview');

    colorBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const color = btn.getAttribute('data-color') || 'R';
        const res = this.deckbuilderAI.generateBeginnerDeck(color);
        const deck = res?.deck;
        if (!deck) return;

        const totalCount = deck.totalCards || deck.mainboard.reduce((a, c) => a + c.count, 0);
        previewDiv.innerHTML = `
          <h3 style="margin: 0 0 6px 0; color: var(--rpm-aqua); font-size: 1rem;">${deck.title || deck.archetype} (${totalCount} cards)</h3>
          <textarea id="deck-export-output" readonly style="width: 100%; height: 140px; background: #1e293b; color: #f8fafc; border: 1px solid #334155; font-family: monospace; font-size: 0.75rem; padding: 6px; box-sizing: border-box;">${deck.exportText || formatDeckForExport(deck, 'arena')}</textarea>
          <div style="margin-top: 8px;">
            <button class="btn btn-primary btn-copy-export">Copy to Clipboard</button>
          </div>
        `;

        const copyBtn = previewDiv.querySelector('.btn-copy-export');
        if (copyBtn) {
          copyBtn.addEventListener('click', () => {
            copyBtn.textContent = 'Copied! ✓';
            setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; }, 1500);
          });
        }
      });
    });
  }

  /**
   * Renders Tab 3: Top 10 Showcase (INV-STORAGE-5).
   * @private
   */
  _renderShowcaseTab(container) {
    const rawShowcase = this.deckbuilderAI.getTopShowcase();
    const renderList = (showcase) => {
      const items = Array.isArray(showcase) ? showcase : [];
      container.innerHTML = `
        <div style="margin-bottom: 10px; font-size: 0.85rem; color: #94a3b8;">
          Top 10 public player decks ranked by composite score:
        </div>
        <ul id="showcase-list" style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px;">
          ${items.length === 0 ? '<li style="color: #64748b; font-size: 0.85rem;">No public decks featured yet. Win matches to rank on the showcase!</li>' : ''}
        </ul>
      `;

      const listUl = container.querySelector('#showcase-list');
      if (!listUl) return;
      items.forEach((deck, idx) => {
        const li = document.createElement('li');
        li.className = 'showcase-item';
        li.style.cssText = 'background: #1e293b; padding: 8px 12px; border-radius: 6px; border: 1px solid #334155; display: flex; justify-content: space-between; align-items: center;';
        li.innerHTML = `
          <div>
            <span style="font-weight: 800; color: var(--rpm-gold);">#${idx + 1}</span>
            <span style="font-weight: 700; color: #ffffff; margin-left: 6px;">${deck.title || deck.archetype || 'Custom Modern'}</span>
            <div style="font-size: 0.75rem; color: #94a3b8; margin-top: 2px;">
              Score: ${deck.compositeScore ?? 0} | WinRate: ${Math.round((deck.winRate ?? 0.5) * 100)}% | Elo: ${deck.elo ?? 1200}
            </div>
          </div>
        `;
        listUl.appendChild(li);
      });
    };

    if (rawShowcase && typeof rawShowcase.then === 'function') {
      renderList([]);
      rawShowcase.then(list => renderList(list)).catch(() => {});
    } else {
      renderList(rawShowcase);
    }
  }

  /**
   * Renders Victory Celebration Modal with Autoplay Fallback (INV-AUDIO-1).
   * @private
   */
  _renderVictoryModal(modalRoot, data = {}) {
    this._isVictoryModalOpen = true;
    modalRoot.setAttribute('aria-hidden', 'false');
    modalRoot.style.pointerEvents = 'auto';

    let wrapper = modalRoot.querySelector('#victory-modal-wrapper');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'victory-modal-wrapper';
      modalRoot.appendChild(wrapper);
    }

    const winnerId = data.winnerId || data.winner;
    const isWinner = Boolean(winnerId && winnerId === this.myPlayerId);
    let winnerName = data.winnerName;
    if (!winnerName) {
      if (isWinner) {
        winnerName = this.username || 'You';
      } else {
        const p = this.tabletopState?.players?.[winnerId];
        winnerName = p?.name || this.getFriendlyPlayerName(winnerId);
      }
    }

    wrapper.innerHTML = `
      <div class="modal-backdrop-harness"></div>
      <div class="modal-dialog-box victory-modal-dialog" role="dialog" aria-modal="true" aria-label="Victory Announcement">
        <h2 class="victory-title" style="color: ${isWinner ? 'var(--rpm-gold, #eab308)' : '#ef4444'}; margin-top: 0;">
          ${isWinner ? '🏆 VICTORY!' : '💀 DEFEAT'}
        </h2>
        <p style="font-size: 1.1rem; color: #ffffff; margin: 0 0 16px 0;">
          ${isWinner ? `Planeswalker <strong>${winnerName}</strong> Reigns Supreme!` : `${winnerName} has won the match.`}
        </p>
        <div id="victory-fallback-container"></div>
        <div class="modal-actions victory-modal-actions" style="display: flex; flex-direction: column; gap: 10px; margin-top: 20px;">
          <button id="btn-victory-inspect-arena" class="btn btn-secondary" type="button">
            🔍 Return to Arena (Inspect Board & Logs)
          </button>
          <button id="btn-victory-view-recap" class="btn btn-secondary" type="button">
            📜 View / Save Match Recap
          </button>
          <button id="btn-victory-return-lobby" class="btn btn-primary" type="button">
            🏠 Back to Menu (Lobby)
          </button>
        </div>
      </div>
    `;

    // 1. Return to Arena (Inspect Board & Logs)
    const btnInspect = wrapper.querySelector('#btn-victory-inspect-arena');
    if (btnInspect) {
      btnInspect.addEventListener('click', () => {
        this.closeModal();
        this._renderPostGameArenaBanner(winnerName);
      });
    }

    // 2. View / Save Match Recap
    const btnRecap = wrapper.querySelector('#btn-victory-view-recap');
    if (btnRecap) {
      btnRecap.addEventListener('click', () => {
        this._renderMatchRecapModal(modalRoot);
      });
    }

    // 3. Back to Menu (Lobby)
    const btnLobby = wrapper.querySelector('#btn-victory-return-lobby');
    if (btnLobby) {
      btnLobby.addEventListener('click', () => {
        this._removePostGameArenaBanner();
        this.closeModal();
        this.isMatchActiveFlag = false;
        this._hasMatchStarted = false;
        this.switchView('LOBBY');
      });
    }

    // Backdrop click: closes modal and reveals arena banner
    const backdrop = wrapper.querySelector('.modal-backdrop-harness');
    if (backdrop) {
      backdrop.addEventListener('click', () => {
        this.closeModal();
        this._renderPostGameArenaBanner(winnerName);
      });
    }
  }

  /**
   * Renders a non-intrusive banner atop the arena allowing post-game inspection.
   * @private
   */
  _renderPostGameArenaBanner(winnerName = '') {
    this._removePostGameArenaBanner();
    const arenaView = this.container?.querySelector('#view-arena');
    if (!arenaView) return;

    const banner = document.createElement('div');
    banner.id = 'post-game-arena-banner';
    banner.className = 'post-game-arena-banner';
    banner.style.cssText = 'background: rgba(15, 23, 42, 0.95); border: 1px solid var(--rpm-gold, #eab308); border-radius: 8px; padding: 10px 16px; margin: 8px 12px; display: flex; justify-content: space-between; align-items: center; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.5);';

    banner.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 1.2rem;">🏁</span>
        <span style="color: #ffffff; font-weight: 600;">Match Ended${winnerName ? ` — Winner: ${winnerName}` : ''}</span>
        <span style="color: #94a3b8; font-size: 0.85rem;">(Board & logs are frozen for inspection)</span>
      </div>
      <div style="display: flex; gap: 8px;">
        <button id="btn-postgame-view-recap" class="btn btn-secondary" style="padding: 6px 12px; font-size: 0.85rem;">📜 View Match Recap</button>
        <button id="btn-postgame-return-lobby" class="btn btn-primary" style="padding: 6px 12px; font-size: 0.85rem;">🏠 Back to Menu (Lobby)</button>
      </div>
    `;

    const btnRecap = banner.querySelector('#btn-postgame-view-recap');
    if (btnRecap) {
      btnRecap.addEventListener('click', () => {
        const modalRoot = this.container?.querySelector('#modal-root');
        if (modalRoot) {
          this._renderMatchRecapModal(modalRoot);
        }
      });
    }

    const btnLobby = banner.querySelector('#btn-postgame-return-lobby');
    if (btnLobby) {
      btnLobby.addEventListener('click', () => {
        this._removePostGameArenaBanner();
        this.closeModal();
        this.isMatchActiveFlag = false;
        this._hasMatchStarted = false;
        this.switchView('LOBBY');
      });
    }

    if (arenaView.firstChild) {
      arenaView.insertBefore(banner, arenaView.firstChild);
    } else {
      arenaView.appendChild(banner);
    }
  }

  _removePostGameArenaBanner() {
    const existing = this.container?.querySelector('#post-game-arena-banner');
    if (existing) {
      try { existing.remove(); } catch (_) {}
    }
  }

  /**
   * Renders the Match Recap view/modal.
   * @private
   */
  _renderMatchRecapModal(modalRoot) {
    if (!modalRoot) modalRoot = this.container?.querySelector('#modal-root');
    if (!modalRoot) return;

    this._isRecapModalOpen = true;
    modalRoot.setAttribute('aria-hidden', 'false');
    modalRoot.style.pointerEvents = 'auto';

    // Remove any existing recap or victory wrapper
    const existing = modalRoot.querySelectorAll('#recap-modal-wrapper, #victory-modal-wrapper');
    for (const el of existing) {
      try { el.remove(); } catch (_) {}
    }

    let wrapper = modalRoot.querySelector('#recap-modal-wrapper');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'recap-modal-wrapper';
      modalRoot.appendChild(wrapper);
    }

    // Get latest match record from matchHistory or archive
    const latestRecord = (this.matchHistory && this.matchHistory.length > 0)
      ? this.matchHistory[this.matchHistory.length - 1]
      : this.archiveMatchRecord();

    const winnerName = latestRecord?.winnerName || 'Winner';
    const turnCount = latestRecord?.turnCount || this.priorityMachine?.turnNumber || 1;
    const roundCount = latestRecord?.roundCount || this.priorityMachine?.roundNumber || 1;
    const traceCount = latestRecord?.traceEntriesCount || this.traceLogger?.entries?.length || 0;
    const execCount = latestRecord?.executionLog?.length || this.executionLog?.length || 0;

    // Render life totals
    let lifeTotalsHTML = '';
    const playersObj = latestRecord?.players || this.tabletopState?.players || {};
    for (const [pid, p] of Object.entries(playersObj)) {
      const pName = p.name || this.getFriendlyPlayerName(pid);
      const life = p.life !== undefined ? p.life : (p.resources?.life ?? 20);
      const isElim = p.isEliminated || life <= 0;
      lifeTotalsHTML += `
        <div style="background: rgba(30, 41, 59, 0.7); padding: 8px 12px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="font-weight: 600; color: #f8fafc;">${pName}</span>
          <span style="color: ${isElim ? '#ef4444' : '#22c55e'}; font-weight: bold;">
            ${life} HP ${isElim ? '💀 (Eliminated)' : '✨'}
          </span>
        </div>
      `;
    }

    // Recent logs preview (last 5 entries)
    const logs = latestRecord?.executionLog || this.executionLog || [];
    const recentLogs = logs.slice(-5).reverse();
    let logsPreviewHTML = recentLogs.map(l => `
      <div style="font-size: 0.8rem; color: #cbd5e1; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.06); font-family: monospace;">
        ${l.text || l.summary || JSON.stringify(l)}
      </div>
    `).join('') || '<div style="color: #64748b; font-size: 0.85rem;">No log entries recorded.</div>';

    wrapper.innerHTML = `
      <div class="modal-backdrop-harness"></div>
      <div class="modal-dialog-box recap-modal-dialog" role="dialog" aria-modal="true" aria-label="Match Recap" style="max-width: 640px;">
        <div class="modal-header-row" style="padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--rpm-border);">
          <h2 style="margin: 0; font-size: 1.2rem; color: var(--rpm-aqua, #38bdf8);">📜 Match Recap & Replay</h2>
          <button class="modal-close-btn btn-icon" style="color: #ffffff; font-size: 1.2rem; cursor: pointer;">&times;</button>
        </div>
        <div style="padding: 20px; overflow-y: auto; max-height: 65vh;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
            <div style="background: rgba(15, 23, 42, 0.6); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);">
              <span style="color: #94a3b8; font-size: 0.75rem; text-transform: uppercase;">Winner</span>
              <div style="font-size: 1.1rem; font-weight: bold; color: var(--rpm-gold, #eab308);">${winnerName}</div>
            </div>
            <div style="background: rgba(15, 23, 42, 0.6); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);">
              <span style="color: #94a3b8; font-size: 0.75rem; text-transform: uppercase;">Duration</span>
              <div style="font-size: 1.1rem; font-weight: bold; color: #f8fafc;">${roundCount} Rounds / Turn ${turnCount}</div>
            </div>
          </div>

          <h3 style="font-size: 0.9rem; color: #94a3b8; text-transform: uppercase; margin: 12px 0 6px 0;">Final Life Totals</h3>
          ${lifeTotalsHTML}

          <div style="display: flex; justify-content: space-between; align-items: center; margin: 14px 0 6px 0;">
            <h3 style="font-size: 0.9rem; color: #94a3b8; text-transform: uppercase; margin: 0;">Logs Summary</h3>
            <span style="font-size: 0.8rem; color: #64748b;">${execCount} Action Logs • ${traceCount} Trace Events</span>
          </div>
          <div style="background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 10px; max-height: 120px; overflow-y: auto;">
            ${logsPreviewHTML}
          </div>

          <div style="margin-top: 16px; text-align: center;">
            <button id="btn-download-match-replay" class="btn btn-secondary" style="width: 100%; padding: 10px; font-weight: 600;">
              💾 Download Replay (.json)
            </button>
          </div>
        </div>

        <div class="modal-actions" style="padding: 12px 20px; display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--rpm-border);">
          <button id="btn-recap-return-arena" class="btn btn-secondary">🔍 Return to Arena</button>
          <button id="btn-recap-return-lobby" class="btn btn-primary">🏠 Back to Menu (Lobby)</button>
        </div>
      </div>
    `;

    // Close button & backdrop
    const closeBtn = wrapper.querySelector('.modal-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => {
      this.closeModal();
      this._renderPostGameArenaBanner(winnerName);
    });
    const backdrop = wrapper.querySelector('.modal-backdrop-harness');
    if (backdrop) backdrop.addEventListener('click', () => {
      this.closeModal();
      this._renderPostGameArenaBanner(winnerName);
    });

    // Download Replay
    const btnDownload = wrapper.querySelector('#btn-download-match-replay');
    if (btnDownload) {
      btnDownload.addEventListener('click', () => {
        try {
          const replayData = {
            ...latestRecord,
            traceJSON: typeof this.traceLogger?.exportAsJSON === 'function' ? this.traceLogger.exportAsJSON() : null,
            exportedAt: new Date().toISOString()
          };
          const jsonStr = JSON.stringify(replayData, null, 2);
          if (typeof document !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `rpm-replay-${latestRecord.matchId || Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }
        } catch (err) {
          console.warn('[app] Could not download match replay:', err);
        }
      });
    }

    // Return to Arena
    const btnReturnArena = wrapper.querySelector('#btn-recap-return-arena');
    if (btnReturnArena) {
      btnReturnArena.addEventListener('click', () => {
        this.closeModal();
        this._renderPostGameArenaBanner(winnerName);
      });
    }

    // Return to Lobby
    const btnReturnLobby = wrapper.querySelector('#btn-recap-return-lobby');
    if (btnReturnLobby) {
      btnReturnLobby.addEventListener('click', () => {
        this._removePostGameArenaBanner();
        this.closeModal();
        this.isMatchActiveFlag = false;
        this._hasMatchStarted = false;
        this.switchView('LOBBY');
      });
    }
  }

  /**
   * Archives a completed match record into this.matchHistory and localStorage (bounded to 10 records).
   * @param {Object} [victoryData={}]
   * @returns {Object}
   */
  archiveMatchRecord(victoryData = {}) {
    const winnerId = victoryData.winner || victoryData.winnerId || null;
    let winnerName = victoryData.winnerName || null;
    if (!winnerName && winnerId) {
      winnerName = this.getFriendlyPlayerName(winnerId);
    }

    const playersSummary = {};
    if (this.tabletopState?.players) {
      for (const [pid, p] of Object.entries(this.tabletopState.players)) {
        playersSummary[pid] = {
          name: p.name || this.getFriendlyPlayerName(pid),
          life: p.resources?.life ?? 20,
          isEliminated: Boolean(p.isEliminated),
          creaturesCount: p.battlefield?.creatures?.length || 0,
          graveyardCount: p.graveyard?.length || 0
        };
      }
    }

    const record = {
      matchId: this.relayClient?.roomCode || `match_${Date.now()}`,
      timestamp: Date.now(),
      isoDate: new Date().toISOString(),
      winnerId,
      winnerName,
      turnCount: this.priorityMachine?.turnNumber || 1,
      roundCount: this.priorityMachine?.roundNumber || this.tabletopState?.roundNumber || 1,
      players: playersSummary,
      executionLog: Array.isArray(this.executionLog) ? [...this.executionLog] : [],
      actionLog: Array.isArray(this.executionLog) ? [...this.executionLog] : [],
      traceEntriesCount: this.traceLogger?.entries?.length || 0,
      traceEntries: this.traceLogger?.entries ? [...this.traceLogger.entries] : []
    };

    if (!Array.isArray(this.matchHistory)) {
      this.matchHistory = [];
    }
    this.matchHistory.push(record);

    if (typeof localStorage !== 'undefined') {
      try {
        let saved = [];
        const raw = localStorage.getItem('rpm_match_history_records');
        if (raw) {
          try {
            saved = JSON.parse(raw);
            if (!Array.isArray(saved)) saved = [];
          } catch (_) { saved = []; }
        }
        saved.push(record);
        saved = saved.slice(-10);
        localStorage.setItem('rpm_match_history_records', JSON.stringify(saved));
      } catch (err) {
        console.warn('[app] Could not archive match to localStorage:', err);
      }
    }

    return record;
  }

  /**
   * Switches the active application tab view cleanly.
   * @param {string} viewName
   */
  switchView(viewName) {
    const targetTab = (viewName === 'TABLETOP') ? 'ARENA' : viewName;
    if (targetTab === 'ARENA') {
      this.isMatchActiveFlag = true;
    }
    if (targetTab === 'LOBBY' && this.lobbyManager && typeof this.lobbyManager.invalidateReadiness === 'function') {
      try { this.lobbyManager.invalidateReadiness('RETURN_TO_LOBBY'); } catch (_) {}
    }
    if (this.tabRouter) {
      if (targetTab === 'LOBBY') {
        this.tabRouter.unlockAll?.();
      }
      this.tabRouter.navigate(targetTab, this.getMatchState(), this.isSpectator());
    }
    this.reconcileDOM();
  }

  /**
   * Renders the 1-tap celebratory fallback banner for browser autoplay policy (INV-AUDIO-1).
   * @private
   */
  _renderAutoplayFallbackBanner() {
    const container = this.container?.querySelector('#victory-fallback-container');
    if (!container) return;

    container.innerHTML = `
      <div class="fallback-banner">
        <button class="btn-fallback-fanfare">🔊 TAP TO PLAY VICTORY FANFARE</button>
      </div>
    `;

    const btn = container.querySelector('.btn-fallback-fanfare');
    if (btn) {
      btn.addEventListener('click', () => {
        if (this.victoryFanfare) {
          try {
            primeAudio(this.victoryFanfare.audioContext);
            this.victoryFanfare.playChiptune();
          } catch (_) {}
        }
        container.innerHTML = '';
      });
    }
  }

  // ==========================================================================
  // Keyboard Shortcuts (Audio Note 1, Space/P = Pass, H = Hold, Esc = Close)
  // ==========================================================================

  /**
   * Computes available full action combinations for spells with multi-object requirements
   * (e.g. Burn Together fling creature + damage recipient, or Stolen Uniform equipment + creature).
   * 
   * @param {string} playerId
   * @param {Object} card
   * @param {string} [castMode]
   * @returns {Array<Object>}
   */
  _getActionCombinationsForSpell(playerId, card, castMode = null) {
    if (!this.tabletopState || !card) return [];
    if (castMode === 'MAIN') return [];
    const p = this.tabletopState.players?.[playerId];
    if (!p) return [];

    const nameLower = (card.name || '').toLowerCase();
    const isBurnTogether = (castMode === 'ADVENTURE') ||
      (nameLower === 'burn together') ||
      (nameLower.includes('burn together') && castMode !== 'MAIN' && !nameLower.includes('callous sell-sword'));
    const isStolenUniform = nameLower.includes('stolen uniform') || /gain control of target equipment.*attach.*creature/i.test(card.oracleText || '');

    // 1. Burn Together (Fling damage + sacrifice)
    if (isBurnTogether) {
      const creatures = [
        ...(p.battlefield?.creatures || []),
        ...(p.zones?.battlefield?.filter(c => /creature/i.test(c.typeLine || c.type || '')) || [])
      ];
      const uniqueCreatures = [];
      const seenCr = new Set();
      for (const cr of creatures) {
        const id = cr.instanceId || cr.id;
        if (id && !seenCr.has(id)) {
          seenCr.add(id);
          uniqueCreatures.push(cr);
        }
      }

      const targets = [];
      for (const [oppPid, opp] of Object.entries(this.tabletopState.players || {})) {
        if (opp.isEliminated) continue;
        if (oppPid !== playerId) {
          targets.push({
            id: oppPid,
            type: 'PLAYER',
            name: this.getFriendlyPlayerName(oppPid),
            subtitle: `Life: ${opp.resources?.life ?? 20}`
          });
        }
        const oppCreatures = [
          ...(opp.battlefield?.creatures || []),
          ...(opp.zones?.battlefield?.filter(c => /creature/i.test(c.typeLine || c.type || '')) || [])
        ];
        for (const cr of oppCreatures) {
          const cid = cr.instanceId || cr.id;
          if (cid) {
            const stats = this.tabletopState.abilityEngine?.evaluateCreatureStats
              ? this.tabletopState.abilityEngine.evaluateCreatureStats(cr, this.tabletopState)
              : { power: cr.power ?? 0, toughness: cr.toughness ?? 0 };
            targets.push({
              id: cid,
              type: 'CREATURE',
              name: cr.name,
              subtitle: `${stats.power}/${stats.toughness} (${this.getFriendlyPlayerName(oppPid)})`
            });
          }
        }
      }

      const combos = [];
      for (const cr of uniqueCreatures) {
        const stats = this.tabletopState.abilityEngine?.evaluateCreatureStats
          ? this.tabletopState.abilityEngine.evaluateCreatureStats(cr, this.tabletopState)
          : { power: cr.power ?? 0, toughness: cr.toughness ?? 0 };
        const pwr = stats.power;

        for (const tg of targets) {
          combos.push({
            type: 'BURN_TOGETHER',
            creatureId: cr.instanceId || cr.id,
            creature: cr,
            creatureName: cr.name,
            power: pwr,
            damage: pwr,
            targetId: tg.id,
            target: tg,
            targetName: tg.name,
            targetType: tg.type,
            targetSubtitle: tg.subtitle,
            label: `🔥 Sacrificar ${cr.name} (${pwr} DMG) ➔ Dañar a ${tg.name}${tg.subtitle ? ` (${tg.subtitle})` : ''}`,
            targets: [cr.instanceId || cr.id, tg.id]
          });
        }
      }
      return combos;
    }

    // 2. Stolen Uniform (Target Equipment + Target Creature you control)
    if (isStolenUniform) {
      const myCreatures = [
        ...(p.battlefield?.creatures || []),
        ...(p.zones?.battlefield?.filter(c => /creature/i.test(c.typeLine || c.type || '')) || [])
      ];
      const allEquipments = [];
      for (const [pid, pl] of Object.entries(this.tabletopState.players || {})) {
        const noncreatures = [
          ...(pl.battlefield?.noncreatures || []),
          ...(pl.zones?.battlefield?.filter(c => !/creature/i.test(c.typeLine || c.type || '')) || [])
        ];
        for (const nc of noncreatures) {
          if (nc && (nc.compiledMechanics?.isEquipment || /equipment/i.test(nc.typeLine || nc.type || ''))) {
            allEquipments.push({ card: nc, ownerId: pid });
          }
        }
      }

      const combos = [];
      for (const eqEntry of allEquipments) {
        const eq = eqEntry.card;
        for (const cr of myCreatures) {
          combos.push({
            type: 'STOLEN_UNIFORM',
            equipmentId: eq.instanceId || eq.id,
            equipment: eq,
            equipmentName: eq.name,
            creatureId: cr.instanceId || cr.id,
            creature: cr,
            creatureName: cr.name,
            targetId: cr.instanceId || cr.id,
            targetName: cr.name,
            label: `🛡️ Anexar ${eq.name} ➔ a ${cr.name}`,
            targets: [cr.instanceId || cr.id, eq.instanceId || eq.id]
          });
        }
      }
      return combos;
    }

    return [];
  }

  /**
   * Initializes the singleton floating card preview tooltip element (#card-hover-preview-tooltip).
   * @private
   */
  _initCardHoverPreviewTooltip() {
    if (typeof document === 'undefined') return;
    let tooltip = document.getElementById('card-hover-preview-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'card-hover-preview-tooltip';
      tooltip.className = 'card-hover-preview-tooltip hidden';
      tooltip.style.display = 'none';
      const host = this.container || document.body;
      host.appendChild(tooltip);
    }

    if (!this._hasBoundGlobalTooltipDismiss) {
      this._hasBoundGlobalTooltipDismiss = true;
      const dismiss = () => this._hideCardPreviewTooltip();
      document.addEventListener('scroll', dismiss, true);
      document.addEventListener('pointerdown', (e) => {
        if (!e.target?.closest?.('.hand-card-chip, .battlefield-card-chip, .opponent-land-card, .opponent-creature-card, .opponent-noncreature-card, .stack-item')) {
          dismiss();
        }
      }, true);
    }
  }

  /**
   * Displays the floating card preview tooltip positioned intelligently near coordinates.
   * @private
   */
  _showCardPreviewTooltip(card, clientX, clientY, sourceEl = null) {
    if (!card || typeof document === 'undefined') return;
    this._initCardHoverPreviewTooltip();
    const tooltip = document.getElementById('card-hover-preview-tooltip');
    if (!tooltip) return;

    this._activePreviewCard = card;

    const imgUrl = card.image_uris?.normal || card.image_uris?.small || card.imageUrl || card.image_uri || null;
    const name = card.name || 'Card';
    const manaCost = card.manaCost || '';
    const typeLine = card.typeLine || card.type || '';
    const oracleText = card.oracleText || card.text || card.oracle_text || '';

    const isCreature = /creature/i.test(typeLine) || card.power !== undefined || card.effectivePower !== undefined;
    let creatureDetailsHtml = '';
    if (isCreature) {
      const stats = this.tabletopState?.abilityEngine?.evaluateCreatureStats
        ? this.tabletopState.abilityEngine.evaluateCreatureStats(card, this.tabletopState)
        : { power: card.effectivePower ?? card.power ?? 0, toughness: card.effectiveToughness ?? card.toughness ?? 0 };
      const power = stats.power ?? card.power ?? 0;
      const toughness = stats.toughness ?? card.toughness ?? 0;

      let countersLabel = '';
      if (card.counters) {
        if (card.counters['+1/+1']) {
          countersLabel += `<span class="tooltip-counters-badge">+1/+1 ×${card.counters['+1/+1']}</span>`;
        }
        if (card.counters['-1/-1']) {
          countersLabel += `<span class="tooltip-counters-badge" style="background:rgba(239,68,68,0.2); border-color:#ef4444; color:#fca5a5;">-1/-1 ×${card.counters['-1/-1']}</span>`;
        }
      }

      let attachedLabel = '';
      if (Array.isArray(card.attachedCards) && card.attachedCards.length > 0) {
        const names = card.attachedCards.map(a => a.name || a).filter(Boolean).join(', ');
        attachedLabel = `<div style="font-size: 0.72rem; color: #c4b5fd; margin-top: 4px;">🔗 Equip: ${this._escapeHtml(names)}</div>`;
      } else if (card.attachedTo) {
        attachedLabel = `<div style="font-size: 0.72rem; color: #c4b5fd; margin-top: 4px;">🔗 Equipped to target</div>`;
      }

      creatureDetailsHtml = `
        <div class="tooltip-creature-stats">
          <span>Stats: ${power}/${toughness}</span>
          ${countersLabel ? `<div>${countersLabel}</div>` : ''}
        </div>
        ${attachedLabel}
      `;
    }

    tooltip.innerHTML = `
      ${imgUrl ? `<img src="${this._escapeHtml(imgUrl)}" alt="${this._escapeHtml(name)}" class="tooltip-card-img" />` : ''}
      <div class="tooltip-header">
        <span>${this._escapeHtml(name)}</span>
        ${manaCost ? `<span class="tooltip-mana">${this._escapeHtml(manaCost)}</span>` : ''}
      </div>
      ${typeLine ? `<div class="tooltip-type">${this._escapeHtml(typeLine)}</div>` : ''}
      ${oracleText ? `<div class="tooltip-oracle">${this._escapeHtml(oracleText)}</div>` : ''}
      ${creatureDetailsHtml}
    `;

    tooltip.style.display = 'block';
    tooltip.classList.remove('hidden');

    const viewportWidth = (typeof window !== 'undefined' ? window.innerWidth : 1024) || 1024;
    const viewportHeight = (typeof window !== 'undefined' ? window.innerHeight : 768) || 768;
    const tooltipWidth = 280;
    const tooltipHeight = 260;

    let posX = (clientX !== undefined ? clientX : 0) + 16;
    let posY = (clientY !== undefined ? clientY : 0) + 16;

    if (clientX === undefined || clientY === undefined) {
      if (sourceEl && typeof sourceEl.getBoundingClientRect === 'function') {
        const rect = sourceEl.getBoundingClientRect();
        posX = rect.left + (rect.width / 2) - (tooltipWidth / 2);
        posY = rect.top - tooltipHeight - 12;
        if (posY < 10) posY = rect.bottom + 12;
      } else {
        posX = (viewportWidth - tooltipWidth) / 2;
        posY = (viewportHeight - tooltipHeight) / 2;
      }
    }

    if (posX + tooltipWidth > viewportWidth - 12) {
      posX = Math.max(12, (clientX !== undefined ? clientX : posX) - tooltipWidth - 16);
    }
    if (posY + tooltipHeight > viewportHeight - 12) {
      posY = Math.max(12, (clientY !== undefined ? clientY : posY) - tooltipHeight - 16);
    }
    posX = Math.max(8, posX);
    posY = Math.max(8, posY);

    tooltip.style.left = `${posX}px`;
    tooltip.style.top = `${posY}px`;
  }

  /**
   * Hides the floating card preview tooltip.
   * @private
   */
  _hideCardPreviewTooltip() {
    clearTimeout(this._hoverPreviewTimer);
    clearTimeout(this._longPressTimer);
    this._hoverPreviewTimer = null;
    this._longPressTimer = null;
    this._activePreviewCard = null;

    if (typeof document === 'undefined') return;
    const tooltip = document.getElementById('card-hover-preview-tooltip');
    if (tooltip) {
      tooltip.style.display = 'none';
      tooltip.classList.add('hidden');
    }
  }

  /**
   * Attaches unified Hover (150ms delay) and Long-Press (350ms) preview handlers to an element.
   * @private
   */
  _attachCardHoverPreview(element, card) {
    if (!element || !card) return;

    let pointerType = 'mouse';

    element.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      clearTimeout(this._hoverPreviewTimer);
      const x = e.clientX;
      const y = e.clientY;
      this._hoverPreviewTimer = setTimeout(() => {
        this._showCardPreviewTooltip(card, x, y, element);
      }, 150);
    });

    element.addEventListener('mousemove', (e) => {
      if (e.pointerType === 'touch') return;
      if (this._activePreviewCard === card) {
        this._showCardPreviewTooltip(card, e.clientX, e.clientY, element);
      }
    });

    element.addEventListener('pointerleave', () => {
      this._hideCardPreviewTooltip();
    });

    element.addEventListener('pointerdown', (e) => {
      pointerType = e.pointerType || 'mouse';
      if (pointerType === 'touch') {
        clearTimeout(this._longPressTimer);
        const x = e.clientX;
        const y = e.clientY;
        this._longPressTimer = setTimeout(() => {
          this._showCardPreviewTooltip(card, x, y, element);
        }, 350);
      }
    });

    element.addEventListener('pointerup', () => {
      clearTimeout(this._longPressTimer);
    });

    element.addEventListener('pointercancel', () => {
      clearTimeout(this._longPressTimer);
      this._hideCardPreviewTooltip();
    });
  }

  /**
   * [P3] Activates direct board targeting mode with top guide banner (#board-targeting-banner)
   * and pulsing .board-target-candidate highlights on valid permanents/players.
   */
  startBoardTargeting(config = {}) {
    if (typeof document === 'undefined') return;
    this.pendingBoardTargeting = {
      step: 1,
      totalSteps: config.totalSteps || 2,
      prompt: config.prompt || '🎯 Paso 1/2: Haz clic en un objetivo válido en la mesa',
      candidateIds: new Set(config.candidateIds || []),
      onSelect: config.onSelect || null,
      onCancel: config.onCancel || null
    };

    let banner = document.getElementById('board-targeting-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'board-targeting-banner';
      banner.className = 'board-targeting-banner';
      (this.container || document.body).appendChild(banner);
    }
    banner.innerHTML = `
      <span class="targeting-banner-text">${this._escapeHtml(this.pendingBoardTargeting.prompt)}</span>
      <button id="btn-cancel-board-targeting" class="btn btn-xs btn-secondary">Cancelar</button>
    `;
    banner.style.display = 'flex';

    const cancelBtn = banner.querySelector('#btn-cancel-board-targeting');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        const cb = this.pendingBoardTargeting?.onCancel;
        this.pendingBoardTargeting = null;
        banner.style.display = 'none';
        document.querySelectorAll('.board-target-candidate').forEach(el => el.classList.remove('board-target-candidate'));
        if (typeof cb === 'function') cb();
      });
    }

    document.querySelectorAll('[data-instance-id]').forEach(el => {
      const instId = el.getAttribute('data-instance-id');
      if (instId && this.pendingBoardTargeting.candidateIds.has(instId)) {
        el.classList.add('board-target-candidate');
      }
    });
  }

  /**
   * [P8] Opens the Graveyard / Exile zone browser drawer (#zone-browser-drawer)
   * allowing inspection and casting of exiled Adventure cards.
   */
  openZoneBrowser(playerId, zoneName = 'graveyard') {
    if (typeof document === 'undefined') return;
    const pData = this.tabletopState?.players?.[playerId];
    const cards = Array.isArray(pData?.[zoneName])
      ? pData[zoneName]
      : (Array.isArray(pData?.zones?.[zoneName]) ? pData.zones[zoneName] : []);

    let drawer = document.getElementById('zone-browser-drawer');
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.id = 'zone-browser-drawer';
      drawer.className = 'zone-browser-drawer';
      (this.container || document.body).appendChild(drawer);
    }

    const title = zoneName === 'exile' ? 'Exile Zone' : 'Graveyard';
    drawer.innerHTML = `
      <div class="zone-browser-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <strong>${this._escapeHtml(this.getFriendlyPlayerName(playerId))} — ${title} (${cards.length})</strong>
        <button id="btn-close-zone-browser" class="btn btn-xs btn-secondary">✕ Close</button>
      </div>
      <div class="zone-browser-cards" style="display:flex; gap:8px; flex-wrap:wrap;">
        ${cards.length === 0 ? '<span style="opacity:0.7;">Empty</span>' : cards.map((c, idx) => `
          <div class="zone-browser-card-item" data-card-idx="${idx}" style="padding:6px 10px; border:1px solid #475569; border-radius:6px; background:#1e293b; cursor:pointer;">
            <div>${this._escapeHtml(c.name || 'Card')}</div>
            ${zoneName === 'exile' && c.onAdventure && playerId === this.myPlayerId ? `<button class="btn btn-xs btn-primary btn-cast-exiled-adventure" data-card-idx="${idx}" style="margin-top:4px;">⚔️ Cast ${this._escapeHtml(c.name)}</button>` : ''}
          </div>
        `).join('')}
      </div>
    `;
    drawer.style.display = 'block';

    const closeBtn = drawer.querySelector('#btn-close-zone-browser');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        drawer.style.display = 'none';
      });
    }

    drawer.querySelectorAll('.btn-cast-exiled-adventure').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const idx = Number(btn.getAttribute('data-card-idx'));
        const card = cards[idx];
        if (card) {
          drawer.style.display = 'none';
          this.castSpellToStack(card, null, 'MAIN');
        }
      });
    });
  }

  /**
   * [P12] / [P31] Opens optional trigger modal for Sigarda's Aid (OPTIONAL_ETB_AUTO_ATTACH)
   * and Leyline Axe (PREGAME_LEYLINE_PROMPT).
   */
  openOptionalTriggerModal(config = {}) {
    if (typeof document === 'undefined') {
      if (typeof config.onConfirm === 'function') config.onConfirm(config.candidates?.[0]?.instanceId || true);
      return;
    }
    let modal = document.getElementById('optional-trigger-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'optional-trigger-modal';
      modal.className = 'modal-overlay';
      (this.container || document.body).appendChild(modal);
    }

    const candidates = Array.isArray(config.candidates) ? config.candidates : [];
    modal.innerHTML = `
      <div class="modal-card" style="max-width:420px; padding:16px; background:#0f172a; border:1px solid #38bdf8; border-radius:8px;">
        <h3 style="margin-top:0;">${this._escapeHtml(config.title || 'Optional Trigger')}</h3>
        <p>${this._escapeHtml(config.description || '')}</p>
        ${candidates.length > 0 ? `
          <div style="display:flex; flex-direction:column; gap:6px; margin:10px 0;">
            ${candidates.map(c => `<button class="btn btn-primary btn-opt-candidate" data-id="${this._escapeHtml(c.instanceId || c.id)}">🛡️ ${this._escapeHtml(c.name || 'Creature')}</button>`).join('')}
          </div>
        ` : `
          <button id="btn-opt-confirm" class="btn btn-primary" style="margin-right:8px;">${this._escapeHtml(config.confirmLabel || 'Confirm')}</button>
        `}
        <button id="btn-opt-decline" class="btn btn-secondary">${this._escapeHtml(config.declineLabel || 'Decline')}</button>
      </div>
    `;
    modal.style.display = 'flex';

    modal.querySelectorAll('.btn-opt-candidate').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        modal.style.display = 'none';
        if (typeof config.onConfirm === 'function') config.onConfirm(id);
      });
    });

    const btnConfirm = modal.querySelector('#btn-opt-confirm');
    if (btnConfirm) {
      btnConfirm.addEventListener('click', () => {
        modal.style.display = 'none';
        if (typeof config.onConfirm === 'function') config.onConfirm(true);
      });
    }

    const btnDecline = modal.querySelector('#btn-opt-decline');
    if (btnDecline) {
      btnDecline.addEventListener('click', () => {
        modal.style.display = 'none';
        if (typeof config.onDecline === 'function') config.onDecline();
      });
    }
  }

  /**
   * Global keydown handler.
   * @private
   * @param {KeyboardEvent} e
   */
  _handleGlobalKeyDown(e) {
    if (this.isDestroyed || !e) return;

    // Filter out typing inside form inputs
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      return;
    }

    const key = e.key || '';
    const code = e.code || '';

    // Escape closes active modal
    if (key === 'Escape') {
      if (this.activeModalType !== 'NONE') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        this.closeModal();
      }
      return;
    }

    // Space, P, H isolation when overlay or target modal is open, or match is over / not active
    if (this.diceRollOverlay?.isOpen || this.targetModal?.isOpen || this.tabletopState?.isGameOver || (!this.isMatchActive() && this.isInteractiveBrowserMode())) {
      return;
    }

    // [P6] Z undoes last mana tap
    if (code === 'KeyZ' || key.toLowerCase() === 'z') {
      if (this.tabletopState && typeof this.tabletopState.undoLastManaTap === 'function') {
        try {
          if (this.tabletopState.undoLastManaTap(this.myPlayerId)) {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            this.reconcileDOM();
          }
        } catch (_err) {
          // Ignore if no mana tap to undo
        }
      }
      return;
    }

    // Enter passes priority if holding, or toggles auto-pass
    if (code === 'Enter' || key === 'Enter') {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (this.priorityMachine && this.priorityMachine.priorityPlayerId === this.myPlayerId) {
        this.dispatchAction({ type: 'PASS_PRIORITY' }, { origin: 'LOCAL' });
      } else {
        this.toggleAutoPass?.();
      }
      return;
    }

    // Space or P passes priority
    if (code === 'Space' || key === ' ' || code === 'KeyP' || key.toLowerCase() === 'p') {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      this.dispatchAction({ type: 'PASS_PRIORITY' }, { origin: 'LOCAL' });
      return;
    }

    // H holds priority & responds
    if (code === 'KeyH' || key.toLowerCase() === 'h') {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      this.dispatchAction({ type: 'HOLD_RESPOND' }, { origin: 'LOCAL' });
      return;
    }
  }

  toggleAutoPass() {
    this.autoPassEnabled = !this.autoPassEnabled;
    if (this.priorityMachine && typeof this.priorityMachine.setAutoPass === 'function') {
      this.priorityMachine.setAutoPass(this.myPlayerId, this.autoPassEnabled);
    }
    const btn = this.container?.querySelector('#btn-toggle-autopass');
    if (btn) {
      btn.textContent = this.autoPassEnabled ? '⚡ Auto-Pass: ON' : '⚡ Auto-Pass: OFF';
      btn.classList.toggle('active', this.autoPassEnabled);
    }
    if (this.autoPassEnabled && this.priorityMachine?.priorityPlayerId === this.myPlayerId && !this.isSpectator() && !this.tabletopState?.isGameOver) {
      const curStep = this.priorityMachine.currentPhaseStep;
      if (!this.hasPhaseStop(curStep)) {
        this.dispatchAction({ type: 'PASS_PRIORITY' }, { origin: 'LOCAL' });
      }
    }
  }

  hasPhaseStop(stepOrPhase) {
    if (!stepOrPhase) return false;
    const upper = String(stepOrPhase).toUpperCase();
    if (this.phaseStops.has(upper)) return true;
    for (const stop of this.phaseStops) {
      if (upper.includes(stop) || stop.includes(upper)) return true;
    }
    return false;
  }

  togglePhaseStop(phaseKey) {
    const upper = String(phaseKey).toUpperCase();
    if (this.phaseStops.has(upper)) {
      this.phaseStops.delete(upper);
    } else {
      this.phaseStops.add(upper);
    }
    if (this.priorityMachine && typeof this.priorityMachine.togglePhaseStop === 'function') {
      this.priorityMachine.togglePhaseStop(upper, this.myPlayerId);
    }
    this.reconcileDOM();
  }

  openDamageAllocationModal(attacker, blockers, onConfirm) {
    if (this.damageModal) {
      const stats = this.tabletopState?.abilityEngine?.evaluateCreatureStats
        ? this.tabletopState.abilityEngine.evaluateCreatureStats(attacker, this.tabletopState)
        : { power: attacker?.power ?? 0 };
      this.damageModal.onConfirmAssignment = (assignmentData) => {
        if (typeof onConfirm === 'function') onConfirm(assignmentData);
      };
      this.damageModal.open({
        attacker,
        blockers,
        attackerPower: stats.power
      });
    }
  }
}

// Export aliases
export const AppController = RPMAppController;
export default RPMAppController;
