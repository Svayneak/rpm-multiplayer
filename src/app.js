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
  createDefaultProfile
} from './VictoryFanfare.js';

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

    // Local player identity
    this.myPlayerId = options.userId || options.preferredSeat || 'p1';
    this.username = options.username || 'Alice';
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
    this.relayClient = options.relayClient || new RelayClient({
      url: options.relayUrl || 'ws://localhost:8080'
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
        <div class="header-room-controls">
          <input type="text" id="room-code-input" class="room-input" placeholder="ROOM CODE" maxlength="8" spellcheck="false" autocomplete="off" />
          <button id="btn-join-room" class="btn btn-secondary">Join</button>
          <button id="btn-create-room" class="btn btn-primary">Create Room</button>
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
    }

    let mainArena = this.container.querySelector('#tabletop-arena');
    if (!mainArena) {
      mainArena = document.createElement('main');
      mainArena.id = 'tabletop-arena';
      mainArena.className = 'rpm-tabletop-arena';
      mainArena.setAttribute('role', 'main');
      this.container.appendChild(mainArena);
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
    }

    if (!playerDashboard) {
      playerDashboard = document.createElement('section');
      playerDashboard.id = 'player-dashboard';
      playerDashboard.className = 'player-dashboard-panel';
      playerDashboard.setAttribute('aria-label', 'Active Player Dashboard');
      mainArena.appendChild(playerDashboard);
    }

    if (!chatDrawer) {
      chatDrawer = document.createElement('aside');
      chatDrawer.id = 'chat-drawer';
      chatDrawer.className = 'rpm-chat-drawer';
      chatDrawer.setAttribute('aria-label', 'Chat and Turn Commands');
      this.container.appendChild(chatDrawer);
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
        this.reconcileDOM();
      });
      this._unsubscribers.push(unsub);
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
      const onSequenced = (msg) => {
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
      this.relayClient.on('action_sequenced', onSequenced);
      this.relayClient.on('player_eliminated', onPlayerEliminated);
      this.relayClient.on('match_victory', onVictory);

      this._unsubscribers.push(() => {
        this.relayClient.off('connected', onConn);
        this.relayClient.off('disconnected', onDisconn);
        this.relayClient.off('reconnecting', onReconn);
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
  }

  // ==========================================================================
  // Unidirectional Action Dispatcher (INV-HARNESS-2)
  // ==========================================================================

  /**
   * Central Unidirectional Action Dispatcher.
   * Strictly enforces INV-HARNESS-2:
   * When origin === 'LOCAL', transmits action over WebSocket.
   * When origin === 'REMOTE', updates local state WITHOUT re-broadcasting.
   * 
   * @param {Object} action
   * @param {Object} [context={ origin: 'LOCAL' }]
   * @returns {Promise<void>}
   */
  async dispatchAction(action, context = { origin: 'LOCAL' }) {
    if (!action) return;

    const origin = context?.origin || action.origin || 'LOCAL';
    const actionType = action.type || action.actionType;
    const payload = action.payload || {};

    // Invariant INV-HARNESS-2: Circular loop suppression
    if (origin === 'LOCAL') {
      if (this.relayClient && typeof this.relayClient.sendAction === 'function') {
        this.relayClient.sendAction(action);
      }
    }

    // Mutate local state managers
    switch (actionType) {
      case 'PASS_PRIORITY':
        if (this.priorityMachine) {
          const targetPlayerId = payload.playerId || this.priorityMachine.priorityPlayerId;
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

      case 'SEND_CHIT_CHAT':
        if (this.dualChat) {
          this.dualChat.sendChitChat(
            payload.text,
            payload.senderId || this.myPlayerId,
            payload.senderName || this.username
          );
        }
        break;

      case 'PLAYER_ELIMINATED':
        this.handlePlayerElimination(payload.playerId || payload.player || action.playerId);
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

  // ==========================================================================
  // Game Actions & Eliminations (INV-RING-1, INV-RING-2)
  // ==========================================================================

  /**
   * Eliminates a player from the active ring, renders gray-out overlay,
   * purges their owned spells from the stack (CR 800.4a), and checks for match victory.
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

    // 3. Skip priority if currently holding
    if (this.priorityMachine && this.priorityMachine.priorityPlayerId === playerId) {
      this.priorityMachine.passPriority(playerId);
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
   * Handles match victory celebration, Elo progression, and victory audio playback.
   * 
   * @param {Object} victoryPayload
   */
  handleMatchVictory(victoryPayload = {}) {
    const winnerId = victoryPayload.winner || victoryPayload.winnerId || this.myPlayerId;
    const winnerName = victoryPayload.winnerName || (winnerId === this.myPlayerId ? this.username : `Player ${winnerId.toUpperCase()}`);

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
  }

  // ==========================================================================
  // Room Networking Wrappers
  // ==========================================================================

  async createRoom(seatOptions = {}) {
    if (!this.relayClient) return null;
    try {
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
  // View Reconciliation (Sub-16ms Frame Budget Gate)
  // ==========================================================================

  /**
   * Reconciles the DOM view based on current subsystem states.
   * Executes within sub-16ms frame budget (60 FPS).
   */
  reconcileDOM() {
    if (!this.container || this.isDestroyed) return;

    // 1. Header Bar
    this._reconcileHeader();

    // 2. Opponents Pod (Auto-scaling 1 to 5 opponents)
    this._reconcileOpponents();

    // 3. Center Battlefield & Stack
    this._reconcileStack();

    // 4. Bottom Player Dashboard
    this._reconcilePlayerDashboard();

    // 5. Dual-Channel Chat
    this._reconcileChat();
  }

  /**
   * Reconciles Header elements.
   * @private
   */
  _reconcileHeader() {
    const activePlayerName = this.container.querySelector('#active-player-name');
    const currentPhaseName = this.container.querySelector('#current-phase-name');

    if (activePlayerName && this.priorityMachine) {
      const activeId = this.priorityMachine.activePlayerId || 'p1';
      activePlayerName.textContent = activeId === this.myPlayerId ? `${this.username} (You)` : `Player ${activeId.toUpperCase()}`;
    }

    if (currentPhaseName && this.priorityMachine) {
      currentPhaseName.textContent = capitalize(this.priorityMachine.currentPhaseStep || 'Untap');
    }
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
        if (overlay) overlay.remove();
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
        card.remove();
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
    const hand = Array.isArray(pData?.zones?.hand) ? pData.zones.hand : [];

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
        <div class="command-emblem-badge">
          <span>🔮 Perk Emblem: Active</span>
        </div>
      </div>
      <div id="player-hand" class="player-hand-grid"></div>
    `;

    // Bind life modifier buttons
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

    // Populate interactive hand
    const handGrid = dashboard.querySelector('#player-hand');
    if (handGrid) {
      hand.forEach(card => {
        const chip = document.createElement('div');
        chip.className = 'hand-card-chip';
        chip.textContent = card.name || 'Card';
        chip.addEventListener('click', () => {
          this.openModal('CARD_OVERLAY', card);
        });
        handGrid.appendChild(chip);
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

    const isTurnTab = this.activeChatTab === 'TURN_COMMAND' || this.activeChatTab === 'TURN';

    chatDrawer.innerHTML = `
      <div class="chat-tab-bar">
        <button class="chat-tab-btn tab-turn-command ${isTurnTab ? 'active' : ''}">
          Turn Cmd ${!holdsPriority ? '<span class="priority-lock-pill lock-badge">🔒</span>' : ''}
        </button>
        <button class="chat-tab-btn tab-chit-chat ${!isTurnTab ? 'active' : ''}">
          Chit-Chat
        </button>
      </div>
      <div id="chat-messages" class="chat-feed"></div>
      <div id="chat-staged-chips" class="staged-chips-container" style="${isTurnTab && holdsPriority ? '' : 'display: none;'}">
        <button class="action-chip btn-chip-pass">Pass Priority</button>
        <button class="action-chip btn-chip-hold">Hold & Respond</button>
      </div>
      <div class="chat-input-row">
        <input type="text" id="turn-command-input" class="chat-text-input" 
          placeholder="${isTurnTab && !holdsPriority ? 'Waiting for priority...' : 'Enter turn command or message...'}"
          ${isTurnTab && !holdsPriority ? 'disabled' : ''} />
        <button id="btn-chat-mic" class="btn btn-icon" ${isTurnTab && !holdsPriority ? 'disabled' : ''} title="Voice Dictation">🎙️</button>
        <button id="btn-chat-send" class="btn btn-primary">Send</button>
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
        if (!holdsPriority) return;
        this.dispatchAction({
          type: 'TURN_COMMAND',
          payload: { command: text, senderId: this.myPlayerId }
        }, { origin: 'LOCAL' });
      } else {
        this.dispatchAction({
          type: 'SEND_CHIT_CHAT',
          payload: { text, senderId: this.myPlayerId, senderName: this.username }
        }, { origin: 'LOCAL' });
      }
    };

    if (sendBtn) sendBtn.addEventListener('click', doSend);
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSend();
      });
    }
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
      if (this.cardModal) {
        this.cardModal.open(data || { name: 'Card Preview', type_line: 'Instant', mana_cost: '{1}{R}' });
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
