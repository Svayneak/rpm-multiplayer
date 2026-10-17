/**
 * TabletopUI.js
 * Minimalist Tap-to-Expand Accordion Tabletop UI Component
 * 
 * Zero-dependency reactive DOM renderer for RPM Tabletop arena.
 * Integrates TabletopStateManager, PriorityStateMachine, DualChannelChat,
 * StackAlarmManager, and CardOverlayModal.
 * 
 * Part of RPM Multiplayer - Feature 7
 * Document ID: SPEC-RPM-UI-007
 * 
 * @module TabletopUI
 */

import { CardOverlayModal, formatManaSymbols } from './CardOverlayModal.js';
import { projectState } from '../TabletopStateManager.js';

/**
 * Standard MTG Zone Drawers in display order
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
 * TabletopUI Reactive View Controller
 */
export class TabletopUI {
  /**
   * @param {Object} options
   * @param {HTMLElement|string} options.container Container element or selector
   * @param {Object} options.tabletopStateManager TabletopStateManager instance
   * @param {Object} options.priorityStateMachine PriorityStateMachine instance
   * @param {Object} options.dualChannelChat DualChannelChat instance
   * @param {string} options.myPlayerId Active player ID (e.g. 'p1')
   * @param {string} [options.opponentPlayerId] Opponent player ID (e.g. 'p2')
   * @param {Object} [options.speechService] SpeechRecognitionService instance
   * @param {boolean} [options.allowMultipleDrawers=true] Allow multiple accordions open
   * @param {boolean} [options.enableSoundEffects=false] Enable 8-bit alarm sound cues
   */
  constructor(options = {}) {
    if (!options.container) {
      throw new Error('TabletopUI requires a container element or selector');
    }

    if (typeof options.container === 'string') {
      if (typeof document !== 'undefined') {
        this.container = document.querySelector(options.container);
      } else {
        this.container = null;
      }
    } else {
      this.container = options.container;
    }

    this.ttsm = options.tabletopStateManager || null;
    this.psm = options.priorityStateMachine || null;
    this.chat = options.dualChannelChat || null;
    this.myPlayerId = options.myPlayerId || 'p1';
    this.opponentPlayerId = options.opponentPlayerId || this._resolveOpponentId();
    this.speechService = options.speechService || null;
    this.allowMultipleDrawers = options.allowMultipleDrawers !== false;
    this.enableSoundEffects = Boolean(options.enableSoundEffects);

    // Track accordion drawer expansion state: [playerId][zone] -> boolean
    // Active player's Hand is expanded by default
    this.drawerState = {
      [this.myPlayerId]: { hand: true },
      [this.opponentPlayerId]: {}
    };

    // Chat active channel: 'CHIT_CHAT' or 'TURN_COMMAND' (default 'TURN_COMMAND')
    this.activeChatTab = 'TURN_COMMAND';

    // Modal instance
    this.cardModal = new CardOverlayModal({
      container: typeof document !== 'undefined' ? document.body : null
    });

    // Subscriptions cleanup callbacks
    this._unsubscribers = [];

    // Bind event handlers
    this._boundKeyDown = this._handleGlobalKeyDown.bind(this);

    // Mount and subscribe
    if (this.container) {
      this.mount(this.container);
    }

    this._setupSubscriptions();
  }

  /**
   * Resolves opponent ID from available state managers
   * @private
   * @returns {string}
   */
  _resolveOpponentId() {
    if (this.psm && Array.isArray(this.psm.players)) {
      const opp = this.psm.players.find(p => p !== this.myPlayerId);
      if (opp) return opp;
    }
    if (this.ttsm && this.ttsm.players) {
      const opp = Object.keys(this.ttsm.players).find(p => p !== this.myPlayerId);
      if (opp) return opp;
    }
    return 'p2';
  }

  /**
   * Subscribes to events from all reactive state managers
   * @private
   */
  _setupSubscriptions() {
    // 1. TabletopStateManager
    if (this.ttsm && typeof this.ttsm.subscribe === 'function') {
      const unsub = this.ttsm.subscribe(() => {
        this.render();
      });
      this._unsubscribers.push(unsub);
    }

    // 2. PriorityStateMachine
    if (this.psm && typeof this.psm.subscribe === 'function') {
      const unsub = this.psm.subscribe((event) => {
        if (event.type === 'PRIORITY_CHANGED' || event.type === 'PHASE_STEP_CHANGED' || event.type === 'TURN_ADVANCED') {
          this.render();
        }
      });
      this._unsubscribers.push(unsub);
    }

    // 3. StackAlarmManager (via psm.alarmManager)
    if (this.psm && this.psm.alarmManager) {
      const alarmMgr = this.psm.alarmManager;
      const prevOnEmit = alarmMgr.onEmit;
      alarmMgr.onEmit = (event) => {
        if (typeof prevOnEmit === 'function') {
          prevOnEmit(event);
        }
        this._handleAlarmEvent(event);
      };
    }

    // 4. DualChannelChat
    if (this.chat && typeof this.chat.subscribe === 'function') {
      const unsub = this.chat.subscribe((event) => {
        if (
          event.type === 'PRIORITY_LOCK_CHANGED' ||
          event.type === 'ACTION_PROPOSAL_GENERATED' ||
          event.type === 'ACTION_PROPOSAL_CONFIRMED' ||
          event.type === 'ACTION_PROPOSAL_CANCELLED' ||
          event.type === 'CHAT_MESSAGE_SENT' ||
          event.type === 'ACTION_PROPOSAL_AMBIGUITY'
        ) {
          this.render();
        }
      });
      this._unsubscribers.push(unsub);
    }

    // Global keyboard shortcuts (Space / P = Pass, H = Hold)
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', this._boundKeyDown);
    }
  }

  /**
   * Handles alarm lifecycle events
   * @private
   * @param {Object} event 
   */
  _handleAlarmEvent(event) {
    if (
      event.type === 'STACK_ALARM_START' ||
      event.type === 'STACK_ALARM_TICK' ||
      event.type === 'STACK_ALARM_HELD' ||
      event.type === 'STACK_ALARM_CANCELLED'
    ) {
      this._reconcileAlarmBanner();
    }
  }

  /**
   * Mounts the tabletop UI into a container element
   * @param {HTMLElement} container 
   */
  mount(container) {
    if (!container) return;
    this.container = container;
    this._ensureLayoutSkeleton();
    this.render();
  }

  /**
   * Ensures the root layout DOM elements exist inside the container
   * @private
   */
  _ensureLayoutSkeleton() {
    if (!this.container) return;

    let root = this.container.querySelector('#tabletop-container');
    if (!root) {
      root = document.createElement('div');
      root.id = 'tabletop-container';
      root.className = 'tabletop-root';
      this.container.appendChild(root);
    }

    // Opponent Board
    if (!root.querySelector('#opponent-board')) {
      const oppBoard = document.createElement('div');
      oppBoard.id = 'opponent-board';
      oppBoard.className = 'tabletop-board board-opponent';
      root.appendChild(oppBoard);
    }

    // Stack Region
    if (!root.querySelector('#stack-region')) {
      const stackRegion = document.createElement('div');
      stackRegion.id = 'stack-region';
      stackRegion.className = 'tabletop-stack-container';
      root.appendChild(stackRegion);
    }

    // Player Board
    if (!root.querySelector('#player-board')) {
      const playerBoard = document.createElement('div');
      playerBoard.id = 'player-board';
      playerBoard.className = 'tabletop-board board-player';
      root.appendChild(playerBoard);
    }

    // Dual Chat Bar
    if (!root.querySelector('#dual-chat-bar')) {
      const chatBar = document.createElement('div');
      chatBar.id = 'dual-chat-bar';
      chatBar.className = 'tabletop-chat-bar';
      root.appendChild(chatBar);
    }

    // Mount CardOverlayModal into document.body or container
    if (this.cardModal && !this.cardModal.element?.parentNode) {
      const target = typeof document !== 'undefined' ? document.body : this.container;
      this.cardModal.mount(target);
    }
  }

  /**
   * Primary render / reconciliation entrypoint
   */
  render() {
    this._ensureLayoutSkeleton();
    if (!this.container) return;

    // Refresh opponent ID if dynamic
    this.opponentPlayerId = this._resolveOpponentId();

    // Project state with Fog-of-War rules
    const projected = this.ttsm ? projectState(this.ttsm, this.myPlayerId) : null;
    const playerState = projected?.players?.[this.myPlayerId] || null;
    const oppState = projected?.players?.[this.opponentPlayerId] || null;

    // 1. Reconcile Opponent Board
    this._reconcileOpponentBoard(oppState);

    // 2. Reconcile Stack & Alarm Banner
    this._reconcileStackAndAlarm(projected?.stack);

    // 3. Reconcile Player Board
    this._reconcilePlayerBoard(playerState);

    // 4. Reconcile Dual-Channel Chat Bar
    this._reconcileChatBar();
  }

  // ==========================================================================
  // Region A: Opponent Board Reconciliation
  // ==========================================================================

  /**
   * @private
   * @param {Object} oppState Projected opponent state
   */
  _reconcileOpponentBoard(oppState) {
    const oppBoard = this.container.querySelector('#opponent-board');
    if (!oppBoard) return;

    const life = oppState?.resources?.life ?? 20;
    const poison = oppState?.resources?.poison ?? 0;
    const energy = oppState?.resources?.energy ?? 0;
    const name = oppState?.playerName || 'Opponent';
    const isActiveTurn = Boolean(this.psm && this.psm.activePlayerId === this.opponentPlayerId);

    // 1. Summary Bar
    let summaryBar = oppBoard.querySelector('.board-summary-bar');
    if (!summaryBar) {
      summaryBar = document.createElement('div');
      summaryBar.className = 'board-summary-bar';
      oppBoard.appendChild(summaryBar);
    }

    summaryBar.innerHTML = `
      <div class="summary-identity-group">
        <div class="player-badge ${isActiveTurn ? 'active-turn' : ''}">
          <span class="player-avatar">👤</span>
          <span class="player-name">${name}</span>
        </div>
        <div class="life-badge"><span class="heart-icon">❤️</span> <span class="life-value">${life}</span></div>
        <div class="counter-badges">
          ${poison > 0 ? `<span class="counter-item poison-counter"><i class="ms ms-poison"></i> ${poison}</span>` : ''}
          ${energy > 0 ? `<span class="counter-item energy-counter"><i class="ms ms-e"></i> ${energy}</span>` : ''}
        </div>
      </div>
      <div class="summary-resources-group">
        <div class="land-mana-bar">${this._renderLandManaBar(oppState?.battlefield?.lands || [])}</div>
      </div>
    `.trim();

    // 2. Zone Drawers Container
    let drawersContainer = oppBoard.querySelector('.zone-drawers-container');
    if (!drawersContainer) {
      drawersContainer = document.createElement('div');
      drawersContainer.className = 'zone-drawers-container';
      oppBoard.appendChild(drawersContainer);
    }

    for (const zone of OPPONENT_ZONES) {
      this._reconcileOpponentDrawer(drawersContainer, zone, oppState);
    }
  }

  /**
   * Renders an individual opponent accordion drawer
   * @private
   */
  _reconcileOpponentDrawer(container, zone, oppState) {
    let drawer = container.querySelector(`.zone-drawer[data-zone="${zone}"]`);
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.className = 'zone-drawer';
      drawer.setAttribute('data-zone', zone);
      container.appendChild(drawer);
    }

    const isExpanded = Boolean(this.drawerState[this.opponentPlayerId]?.[zone]);
    drawer.setAttribute('data-expanded', String(isExpanded));

    let count = 0;
    let label = capitalize(zone);

    if (zone === 'hand') {
      count = oppState?.hand?.count ?? 0;
      if (oppState?.hand?.isRevealed) {
        label = `Hand: ${count} (Revealed)`;
      } else {
        label = `Hand: ${count}`;
      }
    } else if (zone === 'library') {
      count = oppState?.library?.count ?? 0;
      label = `Library: ${count}`;
    } else if (zone === 'graveyard') {
      count = oppState?.graveyard?.length ?? 0;
      label = `Graveyard: ${count}`;
    } else if (zone === 'exile') {
      count = oppState?.exile?.length ?? 0;
      label = `Exile: ${count}`;
    } else if (zone === 'creatures' || zone === 'noncreatures' || zone === 'planeswalkers') {
      count = oppState?.battlefield?.[zone]?.length ?? 0;
      label = `${capitalize(zone)}: ${count}`;
    }

    let header = drawer.querySelector('.zone-drawer-header');
    if (!header) {
      header = document.createElement('div');
      header.className = 'zone-drawer-header';
      drawer.appendChild(header);
    }

    header.innerHTML = `
      <div class="zone-drawer-badge" role="button" aria-expanded="${isExpanded}">
        <span class="drawer-chevron">▶</span>
        <span class="drawer-label">${label}</span>
      </div>
    `.trim();

    const badge = header.querySelector('.zone-drawer-badge');
    badge.onclick = (e) => {
      e.stopPropagation();
      this._toggleDrawer(this.opponentPlayerId, zone);
    };

    let body = drawer.querySelector('.zone-drawer-body');
    if (!body) {
      body = document.createElement('div');
      body.className = 'zone-drawer-body';
      drawer.appendChild(body);
    }

    // Fog-of-War rules for opponent contents
    if (zone === 'hand') {
      if (oppState?.hand?.isRevealed) {
        body.innerHTML = this._renderCardGrid(oppState?.hand?.cards || [], false);
        this._bindCardClickEvents(body, oppState?.hand?.cards || []);
      } else {
        // Enforce Fog-of-War: Masked cards only; zero private data in DOM
        let maskedHtml = '<div class="cards-flow-grid">';
        for (let i = 0; i < count; i++) {
          maskedHtml += '<div class="card-item card-facedown" data-masked="true"><span class="card-back-pattern">🂠</span></div>';
        }
        maskedHtml += '</div>';
        body.innerHTML = maskedHtml;
      }
    } else if (zone === 'library') {
      // Conceal card identities and order: count indicator only
      body.innerHTML = `<div class="deck-count-indicator"><span class="card-back-pattern">🂠</span> Deck Count: ${count}</div>`;
    } else if (zone === 'graveyard') {
      const cards = oppState?.graveyard || [];
      body.innerHTML = this._renderCardGrid(cards, false);
      this._bindCardClickEvents(body, cards);
    } else if (zone === 'exile') {
      const cards = oppState?.exile || [];
      body.innerHTML = this._renderCardGrid(cards, false);
      this._bindCardClickEvents(body, cards);
    } else {
      // Battlefield subzones: creatures, noncreatures, planeswalkers
      const cards = oppState?.battlefield?.[zone] || [];
      body.innerHTML = this._renderCardGrid(cards, false);
      this._bindCardClickEvents(body, cards);
    }
  }

  // ==========================================================================
  // Region B: The Stack & 15-Second Alarm Banner
  // ==========================================================================

  /**
   * Reconciles the stack queue and the 15-second response countdown banner
   * @private
   * @param {Array} [projectedStack]
   */
  _reconcileStackAndAlarm(projectedStack) {
    const stackRegion = this.container.querySelector('#stack-region');
    if (!stackRegion) return;

    const stackItems = this.psm?.stack || projectedStack || [];
    const stackCount = stackItems.length;

    // 1. Stack Title Bar
    let titleBar = stackRegion.querySelector('.stack-title-bar');
    if (!titleBar) {
      titleBar = document.createElement('div');
      titleBar.className = 'stack-title-bar';
      stackRegion.appendChild(titleBar);
    }
    titleBar.innerHTML = `<span>THE STACK (<span class="stack-count">${stackCount}</span> Items)</span>`;

    // 2. Stack Alarm Banner
    this._reconcileAlarmBanner();

    // 3. Stack Queue List (Strict LIFO: newest item on top)
    let queueList = stackRegion.querySelector('.stack-queue-list');
    if (!queueList) {
      queueList = document.createElement('div');
      queueList.className = 'stack-queue-list';
      stackRegion.appendChild(queueList);
    }

    if (stackCount === 0) {
      queueList.innerHTML = '<div class="stack-empty-indicator" style="color: #8b949e; font-size: 0.85rem; padding: 4px;">Stack is currently empty.</div>';
      return;
    }

    // Reverse array to render in LIFO order (top item is index 0)
    const lifoItems = [...stackItems].reverse();
    let queueHtml = '';

    lifoItems.forEach((item, index) => {
      const isTop = (index === 0);
      const seqNumber = stackCount - index;
      const card = item.card || item;
      const name = card.name || 'Unknown Spell';
      const costHtml = formatManaSymbols(card.manaCost);
      const controller = item.controllerId || item.playerId || 'Player';
      const targets = item.targets ? ` -> Target: ${Array.isArray(item.targets) ? item.targets.join(', ') : item.targets}` : '';

      queueHtml += `
        <div class="stack-item ${isTop ? 'stack-item-top' : ''}" data-index="${index}" role="button">
          <div class="stack-item-left">
            <span class="stack-seq-badge">#${seqNumber}${isTop ? ' Top' : ''}</span>
            <span class="stack-item-name">${name}</span>
            <span class="card-cost">${costHtml}</span>
          </div>
          <div class="stack-item-right">
            <span class="stack-controller">Cast by ${controller}${targets}</span>
          </div>
        </div>
      `;
    });

    queueList.innerHTML = queueHtml;

    // Bind inspection on stack item click
    const domItems = queueList.querySelectorAll('.stack-item');
    domItems.forEach((el, idx) => {
      el.onclick = () => {
        const item = lifoItems[idx];
        const card = item.card || item;
        this.cardModal.open(card);
      };
    });
  }

  /**
   * Reconciles or updates the 15-second response countdown banner
   * @private
   */
  _reconcileAlarmBanner() {
    const stackRegion = this.container.querySelector('#stack-region');
    if (!stackRegion) return;

    let banner = stackRegion.querySelector('.stack-alarm-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'stack-alarm-banner';
      // Insert after titleBar
      const titleBar = stackRegion.querySelector('.stack-title-bar');
      if (titleBar && titleBar.nextSibling) {
        stackRegion.insertBefore(banner, titleBar.nextSibling);
      } else {
        stackRegion.appendChild(banner);
      }
    }

    const alarmMgr = this.psm?.alarmManager;
    const isAlarmActive = Boolean(alarmMgr && (alarmMgr.status === 'RUNNING' || alarmMgr.status === 'HELD'));

    if (!isAlarmActive) {
      banner.style.display = 'none';
      return;
    }

    banner.style.display = 'flex';
    const isHeld = (alarmMgr.status === 'HELD');
    banner.classList.toggle('held', isHeld);

    const remainingSec = Math.max(0, (alarmMgr.remainingMs / 1000)).toFixed(1);
    const duration = alarmMgr.durationSeconds || 15;
    const percentage = Math.min(100, Math.max(0, (alarmMgr.remainingMs / (duration * 1000)) * 100));

    let statusClass = 'status-safe';
    if (alarmMgr.remainingMs <= 3000) statusClass = 'status-danger';
    else if (alarmMgr.remainingMs <= 7000) statusClass = 'status-warning';

    const labelText = isHeld
      ? `⚡ [15s ALARM - HELD BY ${alarmMgr.heldByPlayerId === this.myPlayerId ? 'YOU' : (alarmMgr.heldByPlayerId || 'PLAYER')}]`
      : `⚡ 15s ALARM: ${remainingSec}s (${duration}s window)`;

    banner.innerHTML = `
      <div class="alarm-info-row">
        <div class="alarm-label">${labelText}</div>
        <div class="alarm-actions">
          <button class="btn-pass-priority" aria-label="Pass Priority">Pass Priority</button>
          <button class="btn-hold-respond" aria-label="Hold or Respond">Hold / Respond</button>
        </div>
      </div>
      <div class="alarm-progress-bar">
        <div class="alarm-progress-fill ${statusClass}" style="width: ${percentage}%;"></div>
      </div>
    `.trim();

    const passBtn = banner.querySelector('.btn-pass-priority');
    if (passBtn) {
      passBtn.onclick = (e) => {
        e.stopPropagation();
        this._handlePassPriority();
      };
    }

    const holdBtn = banner.querySelector('.btn-hold-respond');
    if (holdBtn) {
      holdBtn.onclick = (e) => {
        e.stopPropagation();
        this._handleHoldRespond();
      };
    }
  }

  // ==========================================================================
  // Region C: Active Player Board Reconciliation
  // ==========================================================================

  /**
   * Reconciles active player board section
   * @private
   * @param {Object} playerState Projected active player state
   */
  _reconcilePlayerBoard(playerState) {
    const playerBoard = this.container.querySelector('#player-board');
    if (!playerBoard) return;

    const life = playerState?.resources?.life ?? 20;
    const poison = playerState?.resources?.poison ?? 0;
    const energy = playerState?.resources?.energy ?? 0;
    const name = playerState?.playerName || 'You';
    const manaPool = playerState?.resources?.manaPool || {};
    const priorityHolder = this.psm?.getPriorityPlayerId?.() || this.psm?.priorityPlayerId;
    const holdsPriority = (priorityHolder === this.myPlayerId);

    // Apply priority glow
    playerBoard.classList.toggle('priority-held', holdsPriority);

    // 1. Summary Bar
    let summaryBar = playerBoard.querySelector('.board-summary-bar');
    if (!summaryBar) {
      summaryBar = document.createElement('div');
      summaryBar.className = 'board-summary-bar';
      playerBoard.appendChild(summaryBar);
    }

    summaryBar.innerHTML = `
      <div class="summary-identity-group">
        <div class="player-badge ${holdsPriority ? 'priority-glow' : ''}">
          <span class="player-avatar">🧙</span>
          <span class="player-name">${name}</span>
          ${holdsPriority ? '<span class="priority-indicator-chip" style="font-size: 0.75rem; color: #2ea043;">(Priority)</span>' : ''}
        </div>
        <div class="life-controller">
          <button class="btn-life btn-life-minus" aria-label="Decrease life">-</button>
          <div class="life-badge"><span class="heart-icon">❤️</span> <span class="life-value">${life}</span></div>
          <button class="btn-life btn-life-plus" aria-label="Increase life">+</button>
        </div>
        <div class="counter-badges">
          ${poison > 0 ? `<span class="counter-item poison-counter"><i class="ms ms-poison"></i> ${poison}</span>` : ''}
          ${energy > 0 ? `<span class="counter-item energy-counter"><i class="ms ms-e"></i> ${energy}</span>` : ''}
        </div>
      </div>
      <div class="summary-resources-group">
        <div class="floating-mana-pool">${this._renderManaPoolChips(manaPool)}</div>
        <div class="land-mana-bar">${this._renderLandManaBar(playerState?.battlefield?.lands || [])}</div>
      </div>
    `.trim();

    // Bind life adjustment buttons
    const minusBtn = summaryBar.querySelector('.btn-life-minus');
    if (minusBtn) {
      minusBtn.onclick = () => {
        if (this.ttsm) this.ttsm.adjustLife(this.myPlayerId, -1);
      };
    }

    const plusBtn = summaryBar.querySelector('.btn-life-plus');
    if (plusBtn) {
      plusBtn.onclick = () => {
        if (this.ttsm) this.ttsm.adjustLife(this.myPlayerId, 1);
      };
    }

    // 2. Zone Drawers Container
    let drawersContainer = playerBoard.querySelector('.zone-drawers-container');
    if (!drawersContainer) {
      drawersContainer = document.createElement('div');
      drawersContainer.className = 'zone-drawers-container';
      playerBoard.appendChild(drawersContainer);
    }

    for (const zone of PLAYER_ZONES) {
      this._reconcilePlayerDrawer(drawersContainer, zone, playerState);
    }
  }

  /**
   * Renders an individual active player accordion drawer
   * @private
   */
  _reconcilePlayerDrawer(container, zone, playerState) {
    let drawer = container.querySelector(`.zone-drawer[data-zone="${zone}"]`);
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.className = 'zone-drawer';
      drawer.setAttribute('data-zone', zone);
      container.appendChild(drawer);
    }

    const isExpanded = Boolean(this.drawerState[this.myPlayerId]?.[zone]);
    drawer.setAttribute('data-expanded', String(isExpanded));

    let count = 0;
    let label = capitalize(zone);

    if (zone === 'hand') {
      count = playerState?.hand?.count ?? playerState?.hand?.cards?.length ?? 0;
      label = `Hand: ${count}`;
    } else if (zone === 'library') {
      count = playerState?.library?.count ?? 0;
      label = `Library: ${count}`;
    } else if (zone === 'graveyard') {
      count = playerState?.graveyard?.length ?? 0;
      label = `Graveyard: ${count}`;
    } else if (zone === 'exile') {
      count = playerState?.exile?.length ?? 0;
      label = `Exile: ${count}`;
    } else if (zone === 'creatures' || zone === 'noncreatures' || zone === 'planeswalkers') {
      count = playerState?.battlefield?.[zone]?.length ?? 0;
      label = `${capitalize(zone)}: ${count}`;
    }

    let header = drawer.querySelector('.zone-drawer-header');
    if (!header) {
      header = document.createElement('div');
      header.className = 'zone-drawer-header';
      drawer.appendChild(header);
    }

    header.innerHTML = `
      <div class="zone-drawer-badge" role="button" aria-expanded="${isExpanded}">
        <span class="drawer-chevron">▶</span>
        <span class="drawer-label">${label}</span>
      </div>
    `.trim();

    const badge = header.querySelector('.zone-drawer-badge');
    badge.onclick = (e) => {
      e.stopPropagation();
      this._toggleDrawer(this.myPlayerId, zone);
    };

    let body = drawer.querySelector('.zone-drawer-body');
    if (!body) {
      body = document.createElement('div');
      body.className = 'zone-drawer-body';
      drawer.appendChild(body);
    }

    if (zone === 'hand') {
      const cards = playerState?.hand?.cards || [];
      body.innerHTML = this._renderCardGrid(cards, true);
      this._bindCardClickEvents(body, cards);
    } else if (zone === 'library') {
      body.innerHTML = `
        <div class="deck-count-indicator">
          <span class="card-back-pattern">🂠</span> Library: ${count} cards
          <div style="margin-top: 8px;">
            <button class="btn-card-action btn-draw-card" style="padding: 4px 10px;">Draw Card</button>
          </div>
        </div>
      `;
      const drawBtn = body.querySelector('.btn-draw-card');
      if (drawBtn) {
        drawBtn.onclick = () => {
          if (this.ttsm) this.ttsm.drawCard(this.myPlayerId, 1);
        };
      }
    } else if (zone === 'graveyard') {
      const cards = playerState?.graveyard || [];
      body.innerHTML = this._renderCardGrid(cards, false);
      this._bindCardClickEvents(body, cards);
    } else if (zone === 'exile') {
      const cards = playerState?.exile || [];
      body.innerHTML = this._renderCardGrid(cards, false);
      this._bindCardClickEvents(body, cards);
    } else {
      // Battlefield subzones: creatures, noncreatures, planeswalkers
      const cards = playerState?.battlefield?.[zone] || [];
      body.innerHTML = this._renderCardGrid(cards, false);
      this._bindCardClickEvents(body, cards);
    }
  }

  // ==========================================================================
  // Region D: Dual-Channel Chat Bar Reconciliation
  // ==========================================================================

  /**
   * Reconciles chat tabs, staged action chip, messages feed, and input row
   * @private
   */
  _reconcileChatBar() {
    const chatBar = this.container.querySelector('#dual-chat-bar');
    if (!chatBar) return;

    const isLocked = Boolean(this.chat?.isInputLocked ? this.chat.isInputLocked() : false);
    const activeProposal = this.chat?.getActiveProposal ? this.chat.getActiveProposal() : null;

    // 1. Channel Tabs
    let tabs = chatBar.querySelector('.chat-header-tabs');
    if (!tabs) {
      tabs = document.createElement('div');
      tabs.className = 'chat-header-tabs';
      tabs.innerHTML = `
        <button class="tab-btn tab-chitchat">💬 Chit-Chat</button>
        <button class="tab-btn tab-turncmd">⚡ Turn Command</button>
      `.trim();
      chatBar.appendChild(tabs);

      const chitChatBtn = tabs.querySelector('.tab-btn.tab-chitchat');
      const turnCmdBtn = tabs.querySelector('.tab-btn.tab-turncmd');

      chitChatBtn.onclick = () => {
        this.activeChatTab = 'CHIT_CHAT';
        this.render();
      };

      turnCmdBtn.onclick = () => {
        this.activeChatTab = 'TURN_COMMAND';
        this.render();
      };
    }

    const chitChatTab = tabs.querySelector('.tab-btn.tab-chitchat');
    const turnCmdTab = tabs.querySelector('.tab-btn.tab-turncmd');
    if (chitChatTab) {
      chitChatTab.classList.toggle('active', this.activeChatTab === 'CHIT_CHAT');
    }
    if (turnCmdTab) {
      turnCmdTab.classList.toggle('active', this.activeChatTab === 'TURN_COMMAND');
    }

    // 2. Staged Action Proposal Chip Overlay
    let chipOverlay = chatBar.querySelector('.staged-chip-overlay');
    if (!chipOverlay) {
      chipOverlay = document.createElement('div');
      chipOverlay.className = 'staged-chip-overlay';
      chatBar.appendChild(chipOverlay);
    }

    if (activeProposal) {
      const actionType = activeProposal.actionType || activeProposal.type || 'ACTION';
      const desc = activeProposal.description || activeProposal.text || activeProposal.intent || '';
      chipOverlay.innerHTML = `
        <div class="staged-action-chip">
          <div class="chip-label">
            <span class="chip-action-type">${actionType}</span>
            <span class="chip-description">${desc}</span>
          </div>
          <div class="chip-actions">
            <button class="chip-btn btn-confirm" data-action="confirm">Confirm</button>
            <button class="chip-btn btn-edit" data-action="edit">Edit</button>
            <button class="chip-btn btn-cancel" data-action="cancel">Cancel</button>
          </div>
        </div>
      `.trim();

      const proposalId = activeProposal.id || activeProposal.proposalId;
      const confirmBtn = chipOverlay.querySelector('.btn-confirm');
      const editBtn = chipOverlay.querySelector('.btn-edit');
      const cancelBtn = chipOverlay.querySelector('.btn-cancel');

      if (confirmBtn) {
        confirmBtn.onclick = () => {
          this.chat?.confirmProposal(proposalId);
          this.render();
        };
      }
      if (editBtn) {
        editBtn.onclick = () => {
          const rawText = this.chat?.editProposal(proposalId);
          const inputField = chatBar.querySelector('.chat-input-field');
          if (inputField) {
            inputField.value = rawText || '';
            inputField.focus?.();
          }
          this.render();
        };
      }
      if (cancelBtn) {
        cancelBtn.onclick = () => {
          this.chat?.cancelProposal(proposalId);
          this.render();
        };
      }
    } else {
      chipOverlay.innerHTML = '';
    }

    // 3. Messages Container
    let msgContainer = chatBar.querySelector('.chat-messages-container');
    if (!msgContainer) {
      msgContainer = document.createElement('div');
      msgContainer.className = 'chat-messages-container';
      chatBar.appendChild(msgContainer);
    }

    const messages = this.activeChatTab === 'CHIT_CHAT'
      ? (this.chat?.chitChatMessages || [])
      : (this.chat?.turnCommandMessages || []);

    if (messages.length === 0) {
      msgContainer.innerHTML = '<div style="color: #8b949e; font-size: 0.8rem; font-style: italic;">No messages yet.</div>';
    } else {
      let msgsHtml = '';
      for (const m of messages) {
        const sender = m.senderName || m.senderId || 'Player';
        msgsHtml += `
          <div class="chat-msg">
            <span class="chat-msg-sender">${sender}:</span>
            <span class="chat-msg-text">${m.text || ''}</span>
          </div>
        `;
      }
      msgContainer.innerHTML = msgsHtml;
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    // 4. Input Row
    let inputRow = chatBar.querySelector('.chat-input-row');
    if (!inputRow) {
      inputRow = document.createElement('div');
      inputRow.className = 'chat-input-row';
      inputRow.innerHTML = `
        <div class="priority-lock-badge"></div>
        <input type="text" class="chat-input-field" placeholder="Type command or message..." />
        <button class="mic-dictation-btn">🎤 [ 🇪🇸 ES | 🇺🇸 EN ]</button>
        <button class="send-btn">Send</button>
      `.trim();
      chatBar.appendChild(inputRow);

      const sendBtn = inputRow.querySelector('.send-btn');
      const inputField = inputRow.querySelector('.chat-input-field');
      const micBtn = inputRow.querySelector('.mic-dictation-btn');

      const handleSend = () => {
        if (inputField?.disabled || sendBtn?.disabled) return;
        const text = inputField?.value?.trim();
        if (!text) return;

        if (this.activeChatTab === 'CHIT_CHAT') {
          this.chat?.sendChatMessage('CHIT_CHAT', text);
        } else {
          this.chat?.submitTurnCommand(text);
        }

        if (inputField) inputField.value = '';
        this.render();
      };

      if (sendBtn) sendBtn.onclick = handleSend;
      if (inputField) {
        inputField.onkeydown = (e) => {
          if (e.key === 'Enter') {
            handleSend();
          }
        };
      }

      if (micBtn) {
        micBtn.onclick = () => {
          if (micBtn.disabled) return;
          if (this.speechService) {
            this.speechService.toggleLanguage?.();
          }
        };
      }
    }

    // When locked and in Turn Command tab, input and controls are disabled
    const isInputDisabled = (this.activeChatTab === 'TURN_COMMAND' && isLocked);
    const lockBadge = inputRow.querySelector('.priority-lock-badge');
    const inputField = inputRow.querySelector('.chat-input-field');
    const micBtn = inputRow.querySelector('.mic-dictation-btn');
    const sendBtn = inputRow.querySelector('.send-btn');

    if (lockBadge) {
      lockBadge.className = `priority-lock-badge ${isLocked ? 'locked' : 'unlocked'}`;
      lockBadge.textContent = isLocked ? '🔒 Opponent Priority' : '🟢 Priority Held';
    }

    if (inputField) {
      inputField.disabled = isInputDisabled;
      inputField.placeholder = (isLocked && this.activeChatTab === 'TURN_COMMAND')
        ? 'Waiting for priority...'
        : 'Type command or message...';
    }

    if (micBtn) {
      micBtn.disabled = isInputDisabled;
    }

    if (sendBtn) {
      sendBtn.disabled = isInputDisabled;
    }
  }

  // ==========================================================================
  // Helper Renderers & Event Bindings
  // ==========================================================================

  /**
   * Toggles drawer expansion state for a player
   * @private
   */
  _toggleDrawer(playerId, zone) {
    if (!this.drawerState[playerId]) {
      this.drawerState[playerId] = {};
    }

    const current = Boolean(this.drawerState[playerId][zone]);
    if (!this.allowMultipleDrawers && !current) {
      this.drawerState[playerId] = {};
    }

    this.drawerState[playerId][zone] = !current;
    this.render();
  }

  /**
   * Generates card grid HTML
   * @private
   */
  _renderCardGrid(cards, isHand = false) {
    if (!cards || cards.length === 0) {
      return '<div style="color: #8b949e; font-size: 0.8rem; padding: 6px;">Zone is empty.</div>';
    }

    let html = '<div class="cards-flow-grid">';
    cards.forEach((card, idx) => {
      const name = card.name || 'Unknown Card';
      const costHtml = formatManaSymbols(card.manaCost);
      const isTapped = Boolean(card.isTapped);
      const pt = (card.power !== undefined && card.toughness !== undefined) ? `${card.power}/${card.toughness}` : '';
      const loyalty = card.loyalty !== undefined && card.loyalty !== null ? `Loyalty: ${card.loyalty}` : '';

      html += `
        <div class="card-item ${isTapped ? 'card-tapped' : ''}" data-index="${idx}" role="button">
          <div class="card-header-line">
            <span class="card-name" title="${name}">${name}</span>
            <span class="card-cost">${costHtml}</span>
          </div>
          <div class="card-typeline-short">${card.typeLine || ''}</div>
          ${(pt || loyalty) ? `<div class="card-stats-line"><span>${pt || loyalty}</span></div>` : ''}
          ${isHand ? `
            <div class="card-quick-actions">
              <button class="btn-card-action btn-cast" data-index="${idx}">Cast</button>
              <button class="btn-card-action btn-inspect" data-index="${idx}">👁️</button>
            </div>
          ` : ''}
        </div>
      `;
    });
    html += '</div>';
    return html;
  }

  /**
   * Binds inspection click events to cards
   * @private
   */
  _bindCardClickEvents(container, cards) {
    const cardEls = container.querySelectorAll('.card-item');
    cardEls.forEach((el, idx) => {
      const card = cards[idx];
      if (!card || card.isHidden) return;

      el.onclick = (e) => {
        // If clicking cast button
        if (e.target.closest('.btn-cast')) {
          e.stopPropagation();
          this.chat?.submitTurnCommand(`cast ${card.name}`);
          return;
        }
        // If clicking inspect or anywhere else on the card
        this.cardModal.open(card);
      };
    });
  }

  /**
   * Generates land mana bar HTML grouped by color
   * @private
   */
  _renderLandManaBar(lands) {
    if (!lands || lands.length === 0) {
      return '<span style="color: #8b949e; font-size: 0.8rem;">No lands</span>';
    }

    const availableColors = {};
    let tappedCount = 0;

    for (const land of lands) {
      if (land.isTapped) {
        tappedCount++;
        continue;
      }
      // Infer mana color from land properties
      let color = 'C';
      if (Array.isArray(land.colors) && land.colors.length > 0) {
        color = land.colors[0];
      } else if (land.name?.includes('Mountain')) color = 'R';
      else if (land.name?.includes('Island')) color = 'U';
      else if (land.name?.includes('Swamp')) color = 'B';
      else if (land.name?.includes('Plains')) color = 'W';
      else if (land.name?.includes('Forest')) color = 'G';

      availableColors[color] = (availableColors[color] || 0) + 1;
    }

    let pipsHtml = '';
    for (const [col, count] of Object.entries(availableColors)) {
      pipsHtml += `<span class="mana-pip-group"><i class="ms ms-${col.toLowerCase()}"></i> x${count}</span>`;
    }

    if (tappedCount > 0) {
      pipsHtml += `<span class="mana-pip-group tapped-group"><i class="ms ms-tap"></i> x${tappedCount}</span>`;
    }

    return pipsHtml || '<span style="color: #8b949e; font-size: 0.8rem;">All tapped</span>';
  }

  /**
   * Generates floating mana pool chips HTML
   * @private
   */
  _renderManaPoolChips(manaPool) {
    let chipsHtml = '';
    const order = ['W', 'U', 'B', 'R', 'G', 'C'];
    for (const col of order) {
      const count = manaPool[col] || 0;
      if (count > 0) {
        chipsHtml += `<span class="mana-chip mana-${col.toLowerCase()}"><i class="ms ms-${col.toLowerCase()}"></i> ${count}</span>`;
      }
    }
    return chipsHtml;
  }

  /**
   * Action trigger: Pass Priority
   * @private
   */
  _handlePassPriority() {
    if (this.psm) {
      try {
        const priorityHolder = this.psm.getPriorityPlayerId?.() || this.psm.priorityPlayerId;
        if (priorityHolder === this.myPlayerId) {
          this.psm.dispatch('PASS_PRIORITY', { playerId: this.myPlayerId });
        }
      } catch (err) {
        // Silently handle if priority already transitioned
      }
    }
    if (this.psm?.alarmManager) {
      this.psm.alarmManager.passAlarm(this.myPlayerId);
    }
    this.render();
  }

  /**
   * Action trigger: Hold / Respond
   * @private
   */
  _handleHoldRespond() {
    if (this.psm?.alarmManager) {
      this.psm.alarmManager.hold(this.myPlayerId);
    }
    this.render();
  }

  /**
   * Handles keyboard shortcuts (Space / P = Pass, H = Hold)
   * @private
   */
  _handleGlobalKeyDown(event) {
    // Avoid triggering when focused inside an input or textarea
    if (typeof document !== 'undefined') {
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea') {
        return;
      }
    }

    if (event.key === ' ' || event.key === 'p' || event.key === 'P') {
      event.preventDefault();
      this._handlePassPriority();
    } else if (event.key === 'h' || event.key === 'H') {
      event.preventDefault();
      this._handleHoldRespond();
    }
  }

  /**
   * Cleans up all DOM listeners and manager subscriptions
   */
  destroy() {
    for (const unsub of this._unsubscribers) {
      if (typeof unsub === 'function') {
        unsub();
      }
    }
    this._unsubscribers = [];

    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', this._boundKeyDown);
    }

    if (this.cardModal) {
      this.cardModal.destroy();
      this.cardModal = null;
    }

    if (this.container) {
      const root = this.container.querySelector('#tabletop-container');
      if (root) {
        this.container.removeChild(root);
      }
    }
  }
}
