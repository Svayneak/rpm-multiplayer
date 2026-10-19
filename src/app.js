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
import { PriorityStateMachine } from './PriorityStateMachine.js';
import { StackAlarmManager } from './StackAlarmManager.js';
import { RandomPerkEngine, executeAuthoritativeRoll } from './RandomPerkEngine.js';
import { getPerkDefinition, resolveRoll } from './PerkCatalog.js';
import { DualChannelChat } from './DualChannelChat.js';
import { ActionLexer } from './ActionLexer.js';
import { CardOverlayModal, formatManaSymbols } from './view/CardOverlayModal.js';
import { RelayClient } from './RelayClient.js';
import { DeckbuilderAI, BEGINNER_DECKS, formatDeckForExport, resolveActiveGuidelines } from './DeckbuilderAI.js';
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
import { generateInstanceId } from './ZoneModel.js';
import { TabRouter, TABS, LOCKED_TABS_DURING_MATCH } from './view/TabRouter.js';
import { DeckValidator, VALIDATION_ERRORS, ORACLE_UNLIMITED_CARDS } from './DeckValidator.js';
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

    // Feature 15 AuthManager & Profile Initialization
    this.authManager = options.authManager || new AuthManager(options);
    this.botAgents = new Map();
    this.requireAuth = Boolean(options.requireAuth);

    // Local player identity
    this.myPlayerId = options.userId || options.preferredSeat || (this.authManager?.getCurrentUser()?.id || 'p1');
    this.username = options.username || (this.authManager?.getCurrentUser()?.username || 'Alice');
    this.audioEnabled = options.audioEnabled !== false;

    // Seating and initial players (default: 2 players)
    const initialPlayers = options.players || (
      options.initialPlayerCount
        ? Array.from({ length: options.initialPlayerCount }, (_, i) => `p${i + 1}`)
        : ['p1', 'p2']
    );
    this.playerIds = [...initialPlayers];

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
    this.storageAdapter = options.storageAdapter || new StorageAdapter(options);
    this.profileManager = options.profileManager || new ProfileManager({
      storageAdapter: this.storageAdapter,
      ...options
    });

    // 2. Deckbuilder AI
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

    this.relayClient = options.relayClient || new RelayClient({
      url: options.relayUrl || defaultRelayUrl
    });

    // 5. Tabletop State Manager
    this.tabletopState = options.tabletopState || new TabletopStateManager({
      players: this.playerIds,
      ...options
    });

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

    this.isMatchActiveFlag = Boolean(options.isMatchActive);
    this._hasMatchStarted = Boolean(options.hasMatchStarted);
    this.selectedHandCardId = null;
    this.turnRollOffManager = null;
    this.isRollOffActive = false;
    this.rollOffResult = null;
    this.deckbuilderMode = 'FREE_CONSTRUCT';
    this.queueSearchStartTime = null;
    this.queueSearchInterval = null;
    this.activeDeckSlot = 1;

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

    // Purge and sanitize TabletopStateManager (INV-LOBBY-6, Screenshot 1 Bug Fix)
    const seatedSlots = this.lobbyManager ? this.lobbyManager.getSeatedSlots() : [];
    if (Array.isArray(matchOptions?.playerIds) && matchOptions.playerIds.length > 0) {
      this.playerIds = [...matchOptions.playerIds];
    } else if (seatedSlots.length > 1) {
      this.playerIds = seatedSlots.map(s => s.playerId);
    } else if (!this.playerIds || this.playerIds.length === 0) {
      this.playerIds = seatedSlots.length > 0 ? seatedSlots.map(s => s.playerId) : [this.myPlayerId];
    }

    if (this.tabletopState) {
      const prevPlayers = this.tabletopState.players || {};
      this.tabletopState.players = {};
      for (const pid of this.playerIds) {
        const slot = seatedSlots.find(s => s.playerId === pid);
        const name = slot ? slot.playerName : (pid === this.myPlayerId ? this.username : `Player ${pid.toUpperCase()}`);
        if (typeof this.tabletopState.registerPlayer === 'function') {
          try {
            this.tabletopState.registerPlayer(pid, name);
          } catch (_) {}
        }
        if (prevPlayers[pid]) {
          this.tabletopState.players[pid] = prevPlayers[pid];
        } else if (!this.tabletopState.players[pid]) {
          this.tabletopState.players[pid] = {
            id: pid,
            playerId: pid,
            name,
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
    }

    if (this.priorityMachine) {
      this.priorityMachine.players = [...this.playerIds];
      if (!this.priorityMachine.players.includes(this.priorityMachine.activePlayerId)) {
        this.priorityMachine.activePlayerId = this.playerIds[0];
      }
      if (!this.priorityMachine.players.includes(this.priorityMachine.priorityPlayerId)) {
        this.priorityMachine.priorityPlayerId = this.playerIds[0];
      }
    }

    if (!this.botAgents) {
      this.botAgents = new Map();
    }
    for (const [bId, bot] of this.botAgents.entries()) {
      if (bot !== this.perkinsAgent) {
        try { bot.destroy(); } catch (_) {}
        this.botAgents.delete(bId);
      }
    }
    if (this.perkinsAgent && this.playerIds.includes(this.perkinsAgent.slotId)) {
      this.botAgents.set(this.perkinsAgent.slotId, this.perkinsAgent);
    }

    for (const slot of seatedSlots) {
      if (slot.isBot) {
        const starter = getStarterDeck(slot.starterDeckId || 'R') || BEGINNER_DECKS.R;
        const botPlayer = this.tabletopState?.players?.[slot.playerId];
        if (botPlayer && starter) {
          const mainboard = starter.mainboard || [];
          const libCards = mainboard.flatMap(c => {
            const count = c.count || 1;
            return Array.from({ length: count }, () => ({
              instanceId: generateInstanceId(),
              ownerId: slot.playerId,
              controllerId: slot.playerId,
              name: c.name,
              typeLine: c.type || 'Creature',
              manaCost: c.manaCost || '{R}',
              cmc: c.cmc ?? 1,
              power: c.power ?? 2,
              toughness: c.toughness ?? 2,
              isTapped: false,
              isSummoningSick: false
            }));
          });
          botPlayer.library = libCards;
          botPlayer.zones = botPlayer.zones || {};
          botPlayer.zones.library = [...libCards];
        }

        const agent = new PerkinsAgent({
          slotId: slot.playerId,
          name: slot.playerName,
          mode: 'LOCAL',
          thinkingDelayMs: 600,
          coachEnabled: false,
          starterDeck: starter
        });
        agent.attach(this);
        this.botAgents.set(slot.playerId, agent);
        this.perkinsAgent = agent;
      }
    }

    this.tabRouter.navigate('ARENA', this.getMatchState(), this.isSpectator());
    this.dealStartingHands();
    this.reconcileDOM();

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
    if (this.tabletopState && typeof this.tabletopState.eliminatePlayer === 'function') {
      try {
        this.tabletopState.eliminatePlayer(this.myPlayerId, 'CONCEDED');
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
    this.reconcileDOM();
    this.authManager?.dispatchTelemetry('MATCH_CONCEDE', null, { playerId: this.myPlayerId });
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
        <p style="color: #cbd5e1; font-size: 0.95rem; line-height: 1.5; margin: 12px 0;">
          To join a match queue or claim a seat, please authenticate your Planeswalker identity.
        </p>
        <div class="modal-form-fields" style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px;">
          <input type="email" id="modal-auth-email" class="auth-input" placeholder="planeswalker@tabletop.com" value="user@tabletop.com" />
          <input type="text" id="modal-auth-username" class="auth-input" placeholder="Display Name" value="${this.username || 'Planeswalker'}" />
        </div>
        <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 10px;">
          <button id="btn-modal-auth-cancel" class="btn btn-secondary">Cancel</button>
          <button id="btn-modal-dev-login" class="btn btn-secondary btn-dev-bypass">⚡ Dev Login</button>
          <button id="btn-modal-auth-confirm" class="btn btn-primary">Sign In</button>
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

    const doLogin = async (email, username) => {
      if (this.authManager) {
        if (typeof this.authManager.instantDevLogin === 'function') {
          await this.authManager.instantDevLogin(email, username, '1995-01-01');
        } else if (typeof this.authManager.loginWithDevBypass === 'function') {
          await this.authManager.loginWithDevBypass(email, username);
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

    authModal.querySelector('#btn-modal-dev-login')?.addEventListener('click', () => {
      doLogin('dev@tabletop.com', 'Dev Planeswalker');
    });

    authModal.querySelector('#btn-modal-auth-confirm')?.addEventListener('click', () => {
      const email = authModal.querySelector('#modal-auth-email')?.value?.trim() || 'user@tabletop.com';
      const name = authModal.querySelector('#modal-auth-username')?.value?.trim() || 'Planeswalker';
      doLogin(email, name);
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
    let banner = this.container?.querySelector('#arena-warning-banner');
    if (!banner && this.container) {
      banner = document.createElement('div');
      banner.id = 'arena-warning-banner';
      banner.className = 'arena-warning-banner';
      const center = this.container.querySelector('#center-arena') || this.container.querySelector('#tabletop-arena') || this.container;
      center.prepend(banner);
    }
    if (!banner) return;
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
        if (!p.zones.hand || p.zones.hand.length === 0) {
          p.zones.hand = starterCardNames.map((name, idx) => ({
            instanceId: `card_${pid}_${idx}_${Date.now()}`,
            name,
            typeLine: name.includes('Mountain') || name.includes('Swamp') || name.includes('Vents') ? 'Land' : (name.includes('Bolt') || name.includes('Spike') ? 'Instant' : 'Creature'),
            manaCost: name.includes('Bolt') || name.includes('Spike') || name.includes('Guide') || name.includes('Swiftspear') ? '{R}' : '',
            owner: pid,
            zone: 'HAND'
          }));
          p.hand = p.zones.hand;
        }
      }
    }
  }

  playLandFromHand(card) {
    const p = this.tabletopState?.players?.[this.myPlayerId];
    if (!p) return;

    if (this.tabletopState && typeof this.tabletopState.canPlayLand === 'function') {
      if (!this.tabletopState.canPlayLand(this.myPlayerId)) {
        this.showWarningBanner("⚠️ You have already played a land this turn (1/1)");
        return;
      }
    }

    if (this.tabletopState && typeof this.tabletopState.playLand === 'function') {
      try {
        if (!p.hand) p.hand = [];
        if (!p.hand.some(c => c && (c.instanceId === card.instanceId || c.name === card.name))) {
          p.hand.push(card);
        }
        this.tabletopState.playLand(this.myPlayerId, card.instanceId || card);
      } catch (err) {
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
      isTapped: false,
      zone: 'BATTLEFIELD'
    };
    p.zones.battlefield.push(battlefieldCard);
    this.selectedHandCardId = null;
    this.dispatchAction({
      type: 'PLAY_LAND',
      payload: { playerId: this.myPlayerId, cardName: card.name, cardInstanceId: card.instanceId }
    }, { origin: 'LOCAL' });
    this.reconcileDOM();
  }

  castSpellToStack(card) {
    const p = this.tabletopState?.players?.[this.myPlayerId];
    if (p) {
      p.zones.hand = (p.zones.hand || []).filter(c => (c.instanceId || c.id || c.name) !== (card.instanceId || card.id || card.name));
    }
    this.selectedHandCardId = null;
    this.dispatchAction({
      type: 'CAST_SPELL',
      payload: { playerId: this.myPlayerId, cardName: card.name, cardInstanceId: card.instanceId }
    }, { origin: 'LOCAL' });
    this.reconcileDOM();
  }

  playLandByName(landName) {
    const p = this.tabletopState?.players?.[this.myPlayerId];
    if (!p) return;

    if (this.tabletopState && typeof this.tabletopState.canPlayLand === 'function') {
      if (!this.tabletopState.canPlayLand(this.myPlayerId)) {
        this.showWarningBanner("⚠️ You have already played a land this turn (1/1)");
        return;
      }
    }

    const hand = p.zones?.hand || p.hand || [];
    const idx = hand.findIndex(c => c && (c.name.toLowerCase() === landName.toLowerCase() || (c.typeLine || '').toLowerCase().includes('land')));
    let card;
    if (idx !== -1) {
      card = hand[idx];
      if (this.tabletopState && typeof this.tabletopState.playLand === 'function') {
        try {
          if (!p.hand) p.hand = [];
          if (!p.hand.some(c => c && (c.instanceId === card.instanceId || c.name === card.name))) {
            p.hand.push(card);
          }
          this.tabletopState.playLand(this.myPlayerId, card.instanceId || card);
        } catch (err) {
          this.showWarningBanner(`⚠️ ${err.message || 'Cannot play land'}`);
          return;
        }
      }
      hand.splice(idx, 1);
    } else {
      card = {
        instanceId: `land_${Date.now()}`,
        name: landName,
        typeLine: 'Basic Land — ' + landName,
        zone: 'BATTLEFIELD'
      };
      if (this.tabletopState && typeof this.tabletopState.playLand === 'function') {
        try {
          if (!p.hand) p.hand = [];
          p.hand.push(card);
          this.tabletopState.playLand(this.myPlayerId, card.instanceId || card);
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
    p.zones.battlefield.push({ ...card, subzone: 'lands', isTapped: false, zone: 'BATTLEFIELD' });
    this.authManager?.dispatchTelemetry('LAND_PLAY', landName, { playerId: this.myPlayerId });
    this.reconcileDOM();
  }

  castSpellByName(spellName, targets = null) {
    const p = this.tabletopState?.players?.[this.myPlayerId];
    if (p && Array.isArray(p.zones?.hand)) {
      const idx = p.zones.hand.findIndex(c => c.name.toLowerCase() === spellName.toLowerCase());
      if (idx !== -1) {
        p.zones.hand.splice(idx, 1);
      }
    }
    if (this.priorityMachine) {
      try {
        this.priorityMachine.dispatch('CAST_SPELL', {
          playerId: this.myPlayerId,
          cardName: spellName,
          targets
        });
      } catch (_) {}
    }
    this.authManager?.dispatchTelemetry('SPELL_CAST', spellName, { playerId: this.myPlayerId, targets });
    this.reconcileDOM();
  }

  triggerDiceRoll(diceType = 'dice') {
    if (diceType === 'd20' || this.isRollOffActive) {
      this.submitRollOff();
    } else {
      const roll = executeAuthoritativeRoll();
      this.handlePerkRolled({
        ...roll,
        isMiss: roll.perkId === null
      });
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

  submitRollOff(forcedValue = null) {
    return this.submitRollOffForPlayer(this.myPlayerId, forcedValue);
  }

  submitRollOffForPlayer(playerId, forcedValue = null) {
    if (!this.turnRollOffManager) {
      this.startRollOff();
    }
    const roll = this.turnRollOffManager.submitRoll(playerId, forcedValue);

    // Auto-roll for bot opponents if in solo mode or pod with bots
    if (playerId === this.myPlayerId) {
      const seatedBots = this.lobbyManager
        ? this.lobbyManager.getSeatedSlots().filter(s => s.isBot).map(s => s.playerId)
        : [];
      const botIds = new Set([
        ...seatedBots,
        ...this.playerIds.filter(pid => pid.startsWith('bot_') || pid.includes('perkins'))
      ]);
      for (const opId of botIds) {
        if (this.turnRollOffManager.pendingPlayerIds.has(opId)) {
          this.turnRollOffManager.submitRoll(opId);
        }
      }
    }

    if (this.turnRollOffManager.isRoundComplete()) {
      const res = this.turnRollOffManager.evaluateRound();
      this.rollOffResult = res;
      if (res.isComplete) {
        if (this.priorityMachine) {
          this.priorityMachine.players = res.sortedPlayers;
          this.priorityMachine.activePlayerId = res.sortedPlayers[0];
          this.priorityMachine.priorityPlayerId = res.sortedPlayers[0];
        }
        this.isRollOffActive = false;
        this.startMatch();
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
          <div id="active-player-badge" class="active-player-badge">
            <span class="badge-label">Active:</span>
            <span id="active-player-name" class="badge-value">P1</span>
            <span id="current-phase-name" class="badge-phase">Untap</span>
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

    // 2. PriorityStateMachine
    if (this.priorityMachine && typeof this.priorityMachine.subscribe === 'function') {
      const unsub = this.priorityMachine.subscribe((event) => {
        if (this.isDestroyed) return;
        if (event && (event.type === 'STACK_RESOLVE' || event.name === 'STACK_RESOLVE')) {
          if (this.tabletopState && typeof this.tabletopState.handleStackResolution === 'function') {
            try {
              this.tabletopState.handleStackResolution(event.resolvedItem || event);
            } catch (err) {
              console.warn('[app.js] Error in handleStackResolution:', err);
            }
          }
        }
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
        if (this.tabletopState && typeof this.tabletopState.handleStackResolution === 'function') {
          try {
            this.tabletopState.handleStackResolution(event.resolvedItem || event);
          } catch (_) {}
        }
        this.reconcileDOM();
      };
      const onTurnChange = (event) => {
        if (this.isDestroyed) return;
        if (this.tabletopState && typeof this.tabletopState.resetTurnQuotas === 'function') {
          const nextActiveId = event?.activePlayerId || this.priorityMachine.activePlayerId;
          this.tabletopState.resetTurnQuotas(nextActiveId);
        }
        this.reconcileDOM();
      };
      this.priorityMachine.on('STACK_RESOLVE', onStackResolve);
      this.priorityMachine.on('TURN_ADVANCED', onTurnChange);
      this.priorityMachine.on('TURN_ROTATED', onTurnChange);
      this.priorityMachine.on('PHASE_STEP_CHANGED', () => {
        if (!this.isDestroyed) this.reconcileDOM();
      });
      this._unsubscribers.push(() => {
        this.priorityMachine.off('STACK_RESOLVE', onStackResolve);
        this.priorityMachine.off('TURN_ADVANCED', onTurnChange);
        this.priorityMachine.off('TURN_ROTATED', onTurnChange);
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
      const onRolled = (roll) => {
        if (this.isDestroyed) return;
        this.handlePerkRolled(roll);
      };
      const onMiss = (data) => {
        if (this.isDestroyed) return;
        this.handlePerkRolled({ ...data, isMiss: true });
      };
      this.randomPerk.on('PERK_ROLLED', onRolled);
      this.randomPerk.on('PERK_ROLL_MISS', onMiss);
      this._unsubscribers.push(() => {
        this.randomPerk.off('PERK_ROLLED', onRolled);
        this.randomPerk.off('PERK_ROLL_MISS', onMiss);
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
    const starter = options.starterDeck || (deckId && BEGINNER_DECKS[deckId]) || BEGINNER_DECKS.R;
    const botPlayer = this.tabletopState?.players?.[botSeatId];
    if (botPlayer) {
      const mainboard = starter.mainboard || [];
      const libCards = mainboard.flatMap(c => {
        const count = c.count || 1;
        return Array.from({ length: count }, () => ({
          instanceId: generateInstanceId(),
          ownerId: botSeatId,
          controllerId: botSeatId,
          name: c.name,
          typeLine: c.type || 'Creature',
          manaCost: c.manaCost || (c.cmc === 0 ? '' : '{R}'),
          cmc: c.cmc ?? 1,
          power: c.power ?? 2,
          toughness: c.toughness ?? 2,
          isTapped: false,
          isSummoningSick: false
        }));
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
      ...options
    });

    // 5. Attach to app controller
    agent.attach(this);
    this.perkinsAgent = agent;

    this.startMatch();
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

    const agent = new PerkinsAgent({
      slotId: botSeatId,
      name: options.name || 'Perkins AI (Bot)',
      mode: 'REMOTE',
      thinkingDelayMs: options.thinkingDelayMs !== undefined ? options.thinkingDelayMs : 1200,
      coachEnabled: false,
      language: options.language || 'es',
      ...options
    });

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

    // Invariant INV-HARNESS-2 & INV-PERKINS-2: Circular loop suppression
    if (origin === 'LOCAL') {
      if (this.relayClient && typeof this.relayClient.sendAction === 'function') {
        this.relayClient.sendAction(action);
      }
    }

    // Mutate local state managers
    switch (actionType) {
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

      case 'CAST_SPELL':
        if (this.priorityMachine) {
          const item = payload.card || payload;
          this.priorityMachine.pushStack(item);
        }
        break;

      case 'PLAY_LAND': {
        const targetId = payload.playerId || action.playerId || this.myPlayerId;
        const card = payload.card || action.card;
        if (this.tabletopState?.players?.[targetId] && card) {
          const p = this.tabletopState.players[targetId];
          if (Array.isArray(p.hand)) {
            p.hand = p.hand.filter(c => c.instanceId !== card.instanceId && c.name !== card.name);
          }
          if (Array.isArray(p.zones?.hand)) {
            p.zones.hand = p.zones.hand.filter(c => c.instanceId !== card.instanceId && c.name !== card.name);
          }
          p.battlefield = p.battlefield || {};
          p.battlefield.lands = p.battlefield.lands || [];
          p.battlefield.lands.push({ ...card, isTapped: false });
        }
        break;
      }

      case 'DECLARE_ATTACKERS': {
        const targetId = payload.playerId || action.playerId || this.myPlayerId;
        const attackerIds = payload.attackers || action.attackers || [];
        if (this.tabletopState?.players?.[targetId]) {
          const p = this.tabletopState.players[targetId];
          const creatures = p.battlefield?.creatures || [];
          for (const c of creatures) {
            if (attackerIds.includes(c.instanceId)) {
              c.isTapped = true;
            }
          }
        }
        break;
      }

      case 'DECLARE_BLOCKERS':
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
            } catch (_) {}
          }
          if (!proposal && this.actionLexer) {
            try {
              proposal = ActionLexer.parse(cmdText, {
                activePlayerId: this.myPlayerId,
                handCards: this.tabletopState?.players?.[this.myPlayerId]?.zones?.hand || []
              });
            } catch (_) {}
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
      const winnerId = survivors[0][0];
      const winnerName = survivors[0][1]?.name || winnerId;
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
  }

  // ==========================================================================
  // View Reconciliation (Sub-16ms Frame Budget Gate)
  // ==========================================================================

  /**
   * Reconciles the DOM view based on current subsystem states.
   * Executes within sub-16ms frame budget (60 FPS).
   */
  reconcileDOM() {
    if (!this.container || this.isDestroyed) return;
    this._syncAuthUser();

    // 1. Header Bar & Nav Tabs
    this._reconcileHeader();

    // 2. Tab Panes Visibility
    this._reconcileTabPanes();

    // 2.5 Phase Track Strip (INV-PHASE-1)
    this._reconcilePhaseTrack();

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
          if (this.priorityMachine && typeof this.priorityMachine.nextPhase === 'function') {
            try {
              this.priorityMachine.nextPhase(this.myPlayerId);
            } catch (err) {
              console.warn('[app.js] nextPhase error:', err);
            }
            this.reconcileDOM();
          }
        });
      }
    }

    if (btnNext) {
      if (this.isSpectator()) {
        btnNext.style.display = 'none';
        btnNext.disabled = true;
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

        const pill = document.createElement('div');
        pill.className = `phase-step ${isMatch ? 'active phase-active-step' : ''}`;
        pill.setAttribute('data-step', step.id);
        pill.textContent = (isMatch ? '🌟 ' : '') + step.label;
        stepList.appendChild(pill);
      });
    }
  }

  /**
   * Reconciles Header elements.
   * @private
   */
  _reconcileHeader() {
    const activePlayerName = this.container.querySelector('#active-player-name');
    const currentPhaseName = this.container.querySelector('#current-phase-name');

    if (activePlayerName) {
      if (this.priorityMachine) {
        const activeId = this.priorityMachine.activePlayerId || 'p1';
        const roundNum = this.priorityMachine.roundNumber || this.tabletopState?.roundNumber || 1;
        const playerTurn = typeof this.priorityMachine.getPlayerTurnCount === 'function'
          ? this.priorityMachine.getPlayerTurnCount(activeId)
          : (this.priorityMachine.turnNumber || 1);
        const pLabel = activeId.toUpperCase();
        activePlayerName.textContent = `Round ${roundNum} • ${pLabel} (Turn ${playerTurn})`;
      } else {
        activePlayerName.textContent = `${this.username} (You)`;
      }
    }

    if (currentPhaseName && this.priorityMachine) {
      currentPhaseName.textContent = capitalize(this.priorityMachine.currentPhaseStep || 'Untap');
    }

    // Reconcile Nav Tabs
    const currentTab = this.tabRouter ? this.tabRouter.getCurrentTab() : 'ARENA';
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
      const handCount = Array.isArray(oppData?.zones?.hand) ? oppData.zones.hand.length : 0;
      const graveCount = Array.isArray(oppData?.zones?.graveyard) ? oppData.zones.graveyard.length : 0;
      const exileCount = Array.isArray(oppData?.zones?.exile) ? oppData.zones.exile.length : 0;
      const creatureCount = Array.isArray(oppData?.zones?.battlefield)
        ? oppData.zones.battlefield.filter(c => (c.type_line || c.type || '').toLowerCase().includes('creature')).length
        : 0;

      // Reconcile opponent content
      let content = oppCard.querySelector('.opponent-card-content');
      if (!content) {
        content = document.createElement('div');
        content.className = 'opponent-card-content';
        oppCard.appendChild(content);
      }

      content.innerHTML = `
        <div class="opponent-header">
          <span class="opponent-name">${oppData?.name || `Opponent (${oppId.toUpperCase()})`}</span>
          <span class="opponent-life badge">Life: ${life}</span>
          <span class="opponent-poison">P: ${poison}</span>
        </div>
        <div class="opponent-drawers-row">
          <button class="btn btn-drawer-hand" ${isEliminated ? 'disabled' : ''}>Hand (${handCount})</button>
          <button class="btn btn-drawer-creatures" ${isEliminated ? 'disabled' : ''}>Creatures (${creatureCount})</button>
          <button class="btn btn-drawer-grave">Grave (${graveCount})</button>
          <button class="btn btn-drawer-exile">Exile (${exileCount})</button>
        </div>
      `;
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

    const btnPass = this.container.querySelector('#btn-pass-priority');
    if (btnPass) {
      if (isSpec) {
        btnPass.style.display = 'none';
        btnPass.disabled = true;
      } else {
        btnPass.style.display = '';
        btnPass.disabled = false;
      }
    }

    const btnHold = this.container.querySelector('#btn-hold-respond');
    if (btnHold) {
      if (isSpec) {
        btnHold.style.display = 'none';
        btnHold.disabled = true;
      } else {
        btnHold.style.display = '';
        btnHold.disabled = false;
      }
    }

    if (stackList) {
      stackList.innerHTML = '';
      // Render in LIFO order (newest on top)
      const reversed = [...stackItems].reverse();
      reversed.forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = 'stack-item';
        li.innerHTML = `
          <div class="stack-item-info">
            <span class="stack-index">#${stackItems.length - idx}</span>
            <span class="stack-source">${item.sourcePlayerId || 'P1'}:</span>
            <span class="stack-name">${item.name || 'Spell/Ability'}</span>
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
    const hand = Array.isArray(pData?.zones?.hand) ? pData.zones.hand : (Array.isArray(pData?.hand) ? pData.hand : []);

    // Random Perk Upkeep Dormancy (INV-PERK-UI-1)
    const unlockTurn = (this.playerIds.length <= 2 ? 4 : 2);
    const currentTurn = this.priorityMachine?.turnNumber || 1;
    const isDormant = currentTurn < unlockTurn;
    const emblemText = isDormant
      ? `🔮 Perk: Dormant until Turn ${unlockTurn}`
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
    const creatures = bCreatures.length >= zCreatures.length ? bCreatures : zCreatures;

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
        </div>
        <div class="mana-pool-chips">
          <span class="mana-chip chip-w">W:${mana.W || 0}</span>
          <span class="mana-chip chip-u">U:${mana.U || 0}</span>
          <span class="mana-chip chip-b">B:${mana.B || 0}</span>
          <span class="mana-chip chip-r">R:${mana.R || 0}</span>
          <span class="mana-chip chip-g">G:${mana.G || 0}</span>
          <span class="mana-chip chip-c">C:${mana.C || 0}</span>
        </div>
        <div class="command-emblem-badge ${isDormant ? 'dormant' : 'active'}">
          <span id="command-emblem-text">${emblemText}</span>
        </div>
      </div>
      <div id="battlefield-strips" class="player-battlefield-strips">
        <div id="battlefield-lands" class="battlefield-strip battlefield-lands">
          <div class="strip-label">Lands (<span class="lands-count">${lands.length}</span>)</div>
          <div class="strip-cards">${lands.map(c => `<span class="battlefield-card-chip land-chip ${c.isTapped ? 'tapped' : ''}">${c.name}</span>`).join('')}</div>
        </div>
        <div id="battlefield-creatures" class="battlefield-strip battlefield-creatures">
          <div class="strip-label">Creatures (<span class="creatures-count">${creatures.length}</span>)</div>
          <div class="strip-cards">${creatures.map(c => `<span class="battlefield-card-chip creature-chip ${c.isTapped ? 'tapped' : ''}">${c.name}</span>`).join('')}</div>
        </div>
      </div>
      <div id="player-hand" class="player-hand-grid"></div>
    `;

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
        const chip = document.createElement('div');
        chip.className = `hand-card-chip ${isSelected ? 'selected' : ''}`;
        chip.textContent = card.name || 'Card';

        if (isSelected) {
          const isLand = (card.typeLine || card.type || '').toLowerCase().includes('land');
          const popover = document.createElement('div');
          popover.className = 'hand-card-popover';
          popover.innerHTML = `
            ${isLand
              ? `<button id="btn-play-land" class="btn btn-popover-action">🏔️ Play Land</button>`
              : `<button id="btn-cast-spell" class="btn btn-popover-action">⚡ Cast to Stack</button>`
            }
            <button id="btn-inspect-card" class="btn btn-popover-inspect">🔍 Inspect</button>
            <button id="btn-close-popover" class="btn btn-popover-close">✖️</button>
          `;

          const btnPlay = popover.querySelector('#btn-play-land');
          if (btnPlay) {
            btnPlay.addEventListener('click', (ev) => {
              ev.stopPropagation();
              this.playLandFromHand(card);
            });
          }

          const btnCast = popover.querySelector('#btn-cast-spell');
          if (btnCast) {
            btnCast.addEventListener('click', (ev) => {
              ev.stopPropagation();
              this.castSpellToStack(card);
            });
          }

          const btnInspect = popover.querySelector('#btn-inspect-card');
          if (btnInspect) {
            btnInspect.addEventListener('click', (ev) => {
              ev.stopPropagation();
              this.openModal('CARD_OVERLAY', card);
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

    chatDrawer.innerHTML = `
      <div class="chat-tab-bar">
        <button class="chat-tab-btn tab-turn-command ${isTurnTab ? 'active' : ''}">
          Turn Cmd ${isSpectator ? '<span class="priority-lock-pill lock-badge">🔒 (Spectator)</span>' : (!holdsPriority ? '<span class="priority-lock-pill lock-badge">🔒</span>' : '')}
        </button>
        <button class="chat-tab-btn tab-chit-chat ${!isTurnTab ? 'active' : ''}">
          Chit-Chat
        </button>
        <button id="btn-toggle-coach" class="btn-badge btn-coach-toggle ${this.perkinsAgent?.coachEnabled !== false ? 'active' : ''}" title="Toggle Perkins Coach Tips">
          ${this.perkinsAgent?.coachEnabled === false ? '🎓 Coach: OFF' : '🎓 Coach: ON'}
        </button>
      </div>
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
        this.activeChatTab = 'TURN_COMMAND';
        this._reconcileChat();
      });
    }

    const btnChitTab = chatDrawer.querySelector('.tab-chit-chat');
    if (btnChitTab) {
      btnChitTab.addEventListener('click', () => {
        this.activeChatTab = 'CHIT_CHAT';
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
            statusText.textContent = `Turn order resolved! ${winner === this.myPlayerId ? 'You take' : `Player ${winner.toUpperCase()} takes`} Turn 1. Starting match...`;
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
              <span class="roll-player">${pid === this.myPlayerId ? 'You' : pid.toUpperCase()}:</span>
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
              <h2>Planeswalker Registration Gate</h2>
              <p class="auth-subtitle">Supabase Magic Link OTP & Profile Setup (INV-AUTH-1)</p>
            </div>

            <div id="auth-error-message" class="auth-error-banner" style="display: none;"></div>
            <div id="auth-success-message" class="auth-success-banner" style="display: none;"></div>

            <div class="auth-form">
              <div class="form-group">
                <label for="auth-email-input">Email Address <span class="required">*</span></label>
                <input type="email" id="auth-email-input" class="auth-input" placeholder="planeswalker@tabletop.com" required autocomplete="email" />
              </div>

              <div class="form-group">
                <label for="auth-username-input">Player Display Name <span class="required">*</span></label>
                <input type="text" id="auth-username-input" class="auth-input" placeholder="e.g. Alice" value="${this.username || ''}" maxlength="32" />
              </div>

              <div class="form-group">
                <label for="auth-dob-input">Date of Birth (Age &ge; 13) <span class="required">*</span></label>
                <input type="date" id="auth-dob-input" class="auth-input" value="1998-05-14" required />
              </div>

              <div class="auth-actions">
                <button id="btn-send-magic-link" class="btn btn-primary btn-magic-link">✉️ Send Magic Link OTP</button>
                <button id="btn-instant-dev-login" class="btn btn-secondary btn-dev-bypass">⚡ Instant Dev Login</button>
              </div>

              <div id="auth-otp-section" class="otp-section" style="display: none;">
                <hr class="auth-divider" />
                <label for="auth-otp-input">Enter 6-Digit OTP Code</label>
                <div class="otp-input-group">
                  <input type="text" id="auth-otp-input" class="auth-input otp-code-input" placeholder="123456" maxlength="8" />
                  <button id="btn-verify-otp" class="btn btn-primary">Verify OTP & Login</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      const btnSendOtp = view.querySelector('#btn-send-magic-link');
      const btnDevLogin = view.querySelector('#btn-instant-dev-login');
      const btnVerifyOtp = view.querySelector('#btn-verify-otp');
      const errBanner = view.querySelector('#auth-error-message');
      const succBanner = view.querySelector('#auth-success-message');
      const otpSection = view.querySelector('#auth-otp-section');

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
            <textarea id="deckbuilder-text-input" class="deck-input-area" placeholder="Paste decklist here...&#10;4 Lightning Bolt&#10;20 Relentless Rats&#10;20 Mountain"></textarea>
            <div class="deck-validator-controls">
              <button id="btn-validate-deck" class="btn btn-primary">Validate Decklist</button>
              <button id="btn-save-active-deck" class="btn btn-special" style="margin-left: 10px;">💾 Save Active Deck</button>
              <div id="deck-validation-badge" class="deck-validation-badge"></div>
            </div>
            <ul id="deck-validation-errors" class="deck-validation-errors"></ul>
          </div>
        </div>
      `;

      // Bind starter deck buttons
      const starterBtns = view.querySelectorAll('.btn-select-starter');
      starterBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
          const sId = btn.getAttribute('data-starter-id');
          const starter = getStarterDeck(sId);
          if (starter && this.authManager) {
            await this.authManager.saveActiveDeck(starter.id, starter);
            this.tabRouter.navigate('LOBBY', this.getMatchState(), this.isSpectator());
            this.reconcileDOM();
          }
        });
      });

      // Bind save active deck button
      const btnSaveActive = view.querySelector('#btn-save-active-deck');
      if (btnSaveActive) {
        btnSaveActive.addEventListener('click', async () => {
          const textarea = view.querySelector('#deckbuilder-text-input');
          const rawText = textarea ? textarea.value : '';
          const report = DeckValidator.validateDeck(rawText, { format: this.deckbuilderMode });
          this._renderDeckValidationReport(view, report);
          if (report.isValid && this.authManager) {
            const deckId = `custom_${Date.now()}`;
            await this.authManager.saveActiveDeck(deckId, report);
            this.tabRouter.navigate('LOBBY', this.getMatchState(), this.isSpectator());
            this.reconcileDOM();
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
        btnValidate.addEventListener('click', () => {
          const textarea = view.querySelector('#deckbuilder-text-input');
          const rawText = textarea ? textarea.value : '';
          const report = DeckValidator.validateDeck(rawText, { format: this.deckbuilderMode });
          this._renderDeckValidationReport(view, report);
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
            this.activeDeckSlot = s;
            this.reconcileDOM();
          }
        });

        slotsBar.appendChild(btn);
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
          pod.innerHTML = `
            <div class="seat-num">Seat ${s}</div>
            <div class="seat-player">🤖 ${slot.playerName}</div>
            <div class="seat-status">✅ Ready (AI)</div>
            <div class="seat-actions">
              <button class="btn btn-remove-bot" data-seat="${s}">✖ Remove Bot</button>
            </div>
          `;
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
    if (this.activeModalType === 'NONE') return;
    const prevType = this.activeModalType;
    this.activeModalType = 'NONE';
    this.activeModalData = null;

    if (this.cardModal && prevType === 'CARD_OVERLAY') {
      this.cardModal.close();
    }

    const modalRoot = this.container?.querySelector('#modal-root');
    if (modalRoot) {
      modalRoot.innerHTML = '';
      modalRoot.setAttribute('aria-hidden', 'true');
    }
  }

  /**
   * Renders the Deckbuilder AI modal dialog with 3 tabs.
   * @private
   */
  _renderDeckbuilderModal(modalRoot, activeTab = 'guidelines') {
    modalRoot.innerHTML = `
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
    const closeBtn = modalRoot.querySelector('.modal-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeModal());
    const backdrop = modalRoot.querySelector('.modal-backdrop-harness');
    if (backdrop) backdrop.addEventListener('click', () => this.closeModal());

    // Tab switcher
    const tabBtns = modalRoot.querySelectorAll('.btn-modal-tab');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        this._renderDeckbuilderModal(modalRoot, tab);
      });
    });

    const contentDiv = modalRoot.querySelector('#deckbuilder-tab-content');
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
    modalRoot.innerHTML = `
      <div class="modal-backdrop-harness"></div>
      <div class="modal-dialog-box victory-modal-dialog" role="dialog" aria-modal="true" aria-label="Victory Announcement">
        <h2 class="victory-title">🏆 VICTORY!</h2>
        <p style="font-size: 1.1rem; color: #ffffff; margin: 0 0 16px 0;">Planeswalker <strong>${data.winnerName || 'Planeswalker'}</strong> Reigns Supreme!</p>
        <div id="victory-fallback-container"></div>
        <div style="margin-top: 20px;">
          <button class="btn btn-secondary modal-close-btn">Return to Arena</button>
        </div>
      </div>
    `;

    const closeBtn = modalRoot.querySelector('.modal-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeModal());
    const backdrop = modalRoot.querySelector('.modal-backdrop-harness');
    if (backdrop) backdrop.addEventListener('click', () => this.closeModal());
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
}

// Export aliases
export const AppController = RPMAppController;
export default RPMAppController;
