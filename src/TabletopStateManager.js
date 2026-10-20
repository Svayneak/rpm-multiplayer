/**
 * RPM Multiplayer - Tabletop Zone State Manager & Fog-of-War Projection
 * TabletopStateManager: Session orchestration, command dispatch, and Fog-of-War state projection.
 *
 * Specification: SPEC-RPM-ZONE-003
 *
 * @module TabletopStateManager
 */

import {
  ZoneModel,
  classifySubzone,
  StateTransitionError,
  CardNotFoundError,
  InvalidZoneError,
  InvalidCardTypeError,
  InsufficientManaError,
  PermanentAlreadyTappedError,
  PlayerNotFoundError
} from './ZoneModel.js';
import { EventEmitter } from './EventEmitter.js';
import { ZoneTransitionMatrix } from './ZoneTransitionMatrix.js';
import { CombatDamageEngine } from './CombatDamageEngine.js';
import { StateBasedActionsEngine } from './StateBasedActionsEngine.js';
import { AbilityEngine } from './AbilityEngine.js';

export class LandLimitExceededError extends StateTransitionError {
  constructor(message = 'Land drop limit reached for this turn') {
    super(message);
    this.name = 'LandLimitExceededError';
  }
}

export class PriorityViolationError extends StateTransitionError {
  constructor(message = 'Priority violation') {
    super(message);
    this.name = 'PriorityViolationError';
  }
}

export class PhaseTimingError extends StateTransitionError {
  constructor(message = 'Phase timing restriction violated') {
    super(message);
    this.name = 'PhaseTimingError';
  }
}

/**
 * Deep clones a card instance entity to guarantee state immutability.
 * 
 * @param {Object} card
 * @returns {Object}
 */
function cloneCard(card) {
  if (!card) return card;
  return {
    ...card,
    colors: Array.isArray(card.colors) ? [...card.colors] : [],
    counters: card.counters ? { ...card.counters } : {},
    annotations: card.annotations ? { ...card.annotations } : {}
  };
}

/**
 * Projects canonical state into a safe Fog-of-War perspective for viewerPlayerId.
 * Strict Fog-of-War visibility policies are applied:
 * - Hand cards are opaque `{ instanceId: 'hidden', isHidden: true }` for opponents unless isHandRevealed === true.
 * - Library array is masked to `{ count: N }` for everyone to prevent top-deck scouting.
 * - Public zones (battlefield, graveyard, stack, exile) are visible.
 *
 * @param {Object|TabletopStateManager} fullStateOrManager - Full match state
 * @param {string} viewerPlayerId - Player ID of viewer or 'spectator'
 * @returns {Object} ProjectedTabletopState
 */
export function projectState(fullStateOrManager, viewerPlayerId) {
  const fullState = fullStateOrManager instanceof TabletopStateManager
    ? fullStateOrManager
    : fullStateOrManager;

  const projectedPlayers = {};

  for (const [playerId, playerState] of Object.entries(fullState.players || {})) {
    const isOwner = (playerId === viewerPlayerId);
    const canSeeHand = isOwner || playerState.isHandRevealed === true;

    // 1. Hand projection
    let projectedHandCards;
    if (canSeeHand) {
      projectedHandCards = (playerState.hand || []).map(cloneCard);
    } else {
      projectedHandCards = (playerState.hand || []).map(() => ({
        instanceId: 'hidden',
        isHidden: true
      }));
    }

    // 2. Library projection (Order is ALWAYS hidden)
    const projectedLibrary = {
      count: (playerState.library || []).length
    };

    // 3. Public battlefield projection
    const battlefield = playerState.battlefield || { lands: [], creatures: [], noncreatures: [], planeswalkers: [] };
    const projectedBattlefield = {
      lands: (battlefield.lands || []).map(cloneCard),
      creatures: (battlefield.creatures || []).map(cloneCard),
      noncreatures: (battlefield.noncreatures || []).map(cloneCard),
      planeswalkers: (battlefield.planeswalkers || []).map(cloneCard)
    };

    // 4. Public graveyard projection
    const projectedGraveyard = (playerState.graveyard || []).map(cloneCard);

    // 5. Exile projection (Mask face-down cards from opponents)
    const projectedExile = (playerState.exile || []).map(c => {
      if (c && c.isFaceDown && !isOwner) {
        return { instanceId: 'hidden', isFaceDown: true, isHidden: true };
      }
      return cloneCard(c);
    });

    const resources = playerState.resources || {
      life: 20,
      poison: 0,
      energy: 0,
      manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
    };

    projectedPlayers[playerId] = {
      playerId: playerState.playerId,
      playerName: playerState.playerName,
      library: projectedLibrary,
      hand: {
        count: (playerState.hand || []).length,
        cards: projectedHandCards,
        isRevealed: Boolean(playerState.isHandRevealed)
      },
      battlefield: projectedBattlefield,
      graveyard: projectedGraveyard,
      exile: projectedExile,
      resources: {
        life: resources.life,
        poison: resources.poison,
        energy: resources.energy,
        manaPool: { ...resources.manaPool }
      }
    };
  }

  return {
    sessionId: fullState.sessionId,
    activePlayerId: fullState.activePlayerId,
    turnNumber: fullState.turnNumber ?? 1,
    stack: (fullState.stack || []).map(cloneCard),
    players: projectedPlayers,
    viewerPlayerId,
    timestamp: Date.now()
  };
}

/**
 * High-level Tabletop Match Manager and Event Coordinator.
 */
export class TabletopStateManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId || `session_${Date.now()}`;
    this.players = {}; // Map: playerId -> PlayerZoneState
    this.stack = [];   // Array: CardInstance
    this.activePlayerId = options.activePlayerId || null;
    this.turnNumber = options.turnNumber || 1;
    this.roundNumber = options.roundNumber || 1;
    this.playerTurnNumbers = new Map();
    this.priorityMachine = options.priorityMachine || null;
    this.abilityEngine = options.abilityEngine || new AbilityEngine();
    this.actionLog = [];
    this.subscribers = new Set();
    this.sequenceCounter = 0;
    this._priorityMachineWired = false;

    if (Array.isArray(options.players)) {
      for (const p of options.players) {
        if (typeof p === 'string') {
          this.registerPlayer(p, p);
        } else if (p && p.id) {
          this.registerPlayer(p.id, p.name || p.id);
        }
      }
    }

    if (this.priorityMachine) {
      this._wirePriorityMachine();
    }
  }

  /**
   * Registers a player in the session.
   *
   * @param {string} playerId
   * @param {string} [playerName='Player']
   * @returns {Object} PlayerZoneState
   */
  registerPlayer(playerId, playerName = 'Player') {
    if (!playerId) {
      throw new Error('playerId is required');
    }
    if (this.players[playerId]) {
      return this.players[playerId];
    }
    const player = ZoneModel.createInitialPlayerState(playerId, playerName);
    player.landsPlayedThisTurn = 0;
    player.maxLandsPerTurn = 1;
    player.landsPerTurnLimit = 1;
    if (player.resources) {
      player.resources.landsPlayedThisTurn = 0;
      player.resources.maxLandsPerTurn = 1;
      player.resources.landsPerTurnLimit = 1;
    }
    this.players[playerId] = player;
    if (!this.playerTurnNumbers.has(playerId)) {
      this.playerTurnNumbers.set(playerId, 1);
    }
    if (!this.activePlayerId) {
      this.activePlayerId = playerId;
    }
    return player;
  }

  /**
   * Returns two-layer turn summary for specified or active player.
   *
   * @param {string} [playerId]
   * @returns {{ roundNumber: number, playerTurnNumber: number }}
   */
  getTurnSummary(playerId = this.activePlayerId) {
    return {
      roundNumber: this.roundNumber,
      playerTurnNumber: (playerId && this.playerTurnNumbers.get(playerId)) || 1
    };
  }

  /**
   * Retrieves a player state or throws if not found.
   *
   * @param {string} playerId
   * @returns {Object} PlayerZoneState
   */
  getPlayer(playerId) {
    const player = this.players[playerId];
    if (!player) {
      throw new PlayerNotFoundError(`Player '${playerId}' not found in session`);
    }
    return player;
  }

  /**
   * Returns current life total for a player.
   *
   * @param {string} playerId
   * @returns {number}
   */
  getPlayerLife(playerId) {
    const player = this.getPlayer(playerId);
    return player.resources?.life ?? 20;
  }

  /**
   * Subscribes a listener to receive state updates on every state change.
   *
   * @param {Function} listener
   * @returns {Function} Unsubscribe callback
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new Error('Subscriber listener must be a function');
    }
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /**
   * Internal notifier to broadcast actions to subscribers.
   * @private
   */
  _notifySubscribers(logEntry, result) {
    for (const sub of this.subscribers) {
      try {
        sub({
          type: 'state_changed',
          sequenceId: logEntry.sequenceId,
          actionType: logEntry.actionType,
          playerId: logEntry.playerId,
          payload: logEntry.payload,
          result,
          timestamp: logEntry.timestamp
        });
      } catch (err) {
        // Prevent subscriber errors from disrupting state machine
        console.error('Subscriber error:', err);
      }
    }
  }

  /**
   * Returns a copy of the sequential action log.
   *
   * @returns {Array<Object>}
   */
  getActionLog() {
    return [...this.actionLog];
  }

  /**
   * Projects state from the perspective of viewerPlayerId.
   *
   * @param {string} viewerPlayerId
   * @returns {Object} ProjectedTabletopState
   */
  projectState(viewerPlayerId) {
    return projectState(this, viewerPlayerId);
  }

  /**
   * Primary action dispatch method. Validates preconditions, executes transitions,
   * logs the action, and notifies subscribers.
   *
   * @param {string} actionType
   * @param {Object} [payload={}]
   * @returns {Object} Action result
   */
  dispatch(actionType, payload = {}) {
    let result;

    switch (actionType) {
      case 'INITIALIZE_DECK':
        result = this._handleInitializeDeck(payload);
        break;
      case 'DRAW_CARD':
        result = this._handleDrawCard(payload);
        break;
      case 'PLAY_LAND':
        result = this._handlePlayLand(payload);
        break;
      case 'CAST_SPELL':
        result = this._handleCastSpell(payload);
        break;
      case 'MOVE_ZONE':
        result = this._handleMoveZone(payload);
        break;
      case 'TAP_PERMANENT':
        result = this._handleTapPermanent(payload);
        break;
      case 'UNTAP_PERMANENT':
        result = this._handleUntapPermanent(payload);
        break;
      case 'UNTAP_ALL':
        result = this._handleUntapAll(payload);
        break;
      case 'ADJUST_LIFE':
        result = this._handleAdjustLife(payload);
        break;
      case 'UPDATE_MANA_POOL':
        result = this._handleUpdateManaPool(payload);
        break;
      case 'MODIFY_COUNTERS':
        result = this._handleModifyCounters(payload);
        break;
      case 'REVEAL_HAND':
      case 'HIDE_HAND':
      case 'SET_HAND_REVEALED':
        result = this._handleSetHandRevealed(actionType, payload);
        break;
      case 'DEAL_DAMAGE':
        result = this._handleDealDamage(payload);
        break;
      case 'LOSE_LIFE':
        result = this._handleLoseLife(payload);
        break;
      case 'ENTER_WITHOUT_CASTING':
        result = this._handleEnterWithoutCasting(payload);
        break;
      case 'CAST_WITHOUT_PAYING_MANA':
        result = this._handleCastWithoutPaying(payload);
        break;
      case 'REANIMATE':
        result = this._handleReanimate(payload);
        break;
      case 'REGROWTH':
        result = this._handleRegrowth(payload);
        break;
      case 'FLICKER':
        result = this._handleFlicker(payload);
        break;
      case 'MILL':
        result = this._handleMill(payload);
        break;
      case 'IMPULSE_EXILE':
        result = this._handleImpulseExile(payload);
        break;
      case 'RUN_SBA_CHECK':
        result = this.runSBACheck();
        break;
      default:
        throw new StateTransitionError(`Unknown actionType: ${actionType}`);
    }

    this.sequenceCounter++;
    const logEntry = {
      sequenceId: this.sequenceCounter,
      timestamp: Date.now(),
      actionType,
      playerId: payload.playerId || this.activePlayerId,
      payload: { ...payload }
    };
    this.actionLog.push(logEntry);

    this._notifySubscribers(logEntry, result);
    return result;
  }

  // --- Action Handlers ---

  _handleInitializeDeck(payload) {
    const { playerId, playerName = 'Player' } = payload;
    const options = payload.options || {};
    const cardsInput = payload.hydratedCards || payload.deckCards || [];

    let player = this.players[playerId];
    if (!player) {
      player = this.registerPlayer(playerId, playerName);
    } else {
      player.library = [];
      player.hand = [];
      player.battlefield = { lands: [], creatures: [], noncreatures: [], planeswalkers: [] };
      player.graveyard = [];
      player.exile = [];
      player.isHandRevealed = false;
      player.landsPlayedThisTurn = 0;
      player.maxLandsPerTurn = 1;
      player.landsPerTurnLimit = 1;
      player.resources = {
        life: 20,
        poison: 0,
        energy: 0,
        manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
        landsPlayedThisTurn: 0,
        maxLandsPerTurn: 1,
        landsPerTurnLimit: 1
      };
    }

    const startingLife = options.startingLife ?? payload.startingLife ?? 20;
    player.resources.life = startingLife;
    player.resources.poison = 0;
    player.resources.energy = 0;
    player.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    player.resources.landsPlayedThisTurn = 0;
    player.resources.maxLandsPerTurn = 1;
    player.resources.landsPerTurnLimit = 1;
    player.landsPlayedThisTurn = 0;
    player.maxLandsPerTurn = 1;
    player.landsPerTurnLimit = 1;
    player.isHandRevealed = false;

    // Expand cards based on count
    for (const cardData of cardsInput) {
      const count = typeof cardData.count === 'number' && cardData.count > 0 ? cardData.count : 1;
      for (let i = 0; i < count; i++) {
        const cardInstance = ZoneModel.createCardInstance(cardData, playerId, { zone: 'library' });
        player.library.push(cardInstance);
      }
    }

    const skipShuffle = options.skipShuffle ?? payload.skipShuffle ?? false;
    if (!skipShuffle) {
      ZoneModel.shuffleArray(player.library);
    }

    const startingHandSize = options.startingHandSize ?? payload.startingHandSize ?? 7;
    const cardsToDraw = Math.min(startingHandSize, player.library.length);
    if (cardsToDraw > 0) {
      const drawn = player.library.splice(0, cardsToDraw);
      for (const card of drawn) {
        card.zone = 'hand';
        card.subzone = null;
        player.hand.push(card);
      }
    }

    return {
      playerId,
      handCount: player.hand.length,
      libraryCount: player.library.length,
      life: player.resources.life
    };
  }

  _handleDrawCard(payload) {
    const { playerId, count = 1 } = payload;
    const player = this.getPlayer(playerId);
    const n = Math.max(0, count);

    // CR 104.3c: If a player is required to draw from an empty library, they lose the game
    if (player.library.length === 0 && n > 0) {
      player.isEliminated = true;
      this.emit('EMPTY_LIBRARY_DRAW', { playerId, rule: 'CR 104.3c: Drawing from empty library results in game loss' });
      this.emit('PLAYER_LOST', { playerId, reason: 'EMPTY_LIBRARY', rule: 'CR 104.3c' });
      return {
        drawn: [],
        drawnCount: 0,
        libraryCount: 0,
        handCount: player.hand.length,
        playerLost: true,
        reason: 'CR 104.3c'
      };
    }

    const available = Math.min(n, player.library.length);
    const drawn = player.library.splice(0, available);

    for (const card of drawn) {
      card.zone = 'hand';
      card.subzone = null;
      player.hand.push(card);
    }

    if (player.zones) {
      player.zones.hand = player.hand;
      if (Array.isArray(player.zones.library)) {
        player.zones.library = player.library;
      }
    }

    if (drawn.length < n) {
      player.isEliminated = true;
      this.emit('EMPTY_LIBRARY_DRAW', { playerId, rule: 'CR 104.3c: Drawing from empty library results in game loss' });
      this.emit('PLAYER_LOST', { playerId, reason: 'EMPTY_LIBRARY', rule: 'CR 104.3c' });
    }

    return {
      drawn,
      drawnCount: drawn.length,
      libraryCount: player.library.length,
      handCount: player.hand.length
    };
  }

  _handlePlayLand(payload) {
    const playerId = payload.playerId || this.activePlayerId;
    const player = this.getPlayer(playerId);

    const activePid = this.priorityMachine?.activePlayerId || this.activePlayerId;
    if (activePid && activePid !== playerId) {
      throw new PriorityViolationError(`Only the active player ('${activePid}') may play a land.`);
    }

    const currentPhase = this.priorityMachine?.currentPhaseStep;
    if (currentPhase) {
      const normalizedPhase = currentPhase.toUpperCase();
      const isMain = normalizedPhase.includes('MAIN') || normalizedPhase === 'PRECOMBAT_MAIN' || normalizedPhase === 'POSTCOMBAT_MAIN';
      if (!isMain) {
        throw new PhaseTimingError(`Lands may only be played during Main phases (current: ${currentPhase}).`);
      }
    }

    const stackDepth = this.priorityMachine?.getStackDepth?.() ?? this.stack.length;
    if (stackDepth > 0) {
      throw new PriorityViolationError('Lands may only be played when the stack is empty.');
    }

    const priorityPid = this.priorityMachine?.priorityPlayerId;
    if (priorityPid && priorityPid !== playerId) {
      throw new PriorityViolationError(`Player '${playerId}' does not hold priority.`);
    }

    const instanceId = payload.instanceId || (payload.card && payload.card.instanceId);
    const cardIdx = player.hand.findIndex(c => c && (
      (instanceId && c.instanceId === instanceId) ||
      (payload.card && (c.instanceId === payload.card.instanceId || c.name === payload.card.name))
    ));
    if (cardIdx === -1) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId || payload.card?.name} not found in player's hand`);
    }

    const card = player.hand[cardIdx];
    if (!/land/i.test(card.typeLine || card.type || '')) {
      throw new InvalidCardTypeError(`Card is not a land: "${card.name}" (${card.typeLine})`);
    }

    const played = player.landsPlayedThisTurn ?? player.resources?.landsPlayedThisTurn ?? 0;
    const limit = player.maxLandsPerTurn ?? player.landsPerTurnLimit ?? player.resources?.maxLandsPerTurn ?? 1;
    if (played >= limit) {
      throw new LandLimitExceededError(`Land drop limit reached for this turn (${played}/${limit}).`);
    }

    player.hand.splice(cardIdx, 1);
    card.zone = 'battlefield';
    card.subzone = 'lands';
    card.isTapped = false;

    // Shockland Detection (Steam Vents, Sacred Foundry, Watery Grave, etc. or ETB 2 life rules text)
    const isShockland = /steam vents|sacred foundry|watery grave|stomping ground|godless shrine|blood crypt|breeding pool|overgrown tomb|temple garden|hallowed fountain/i.test(card.name || '') ||
      /pay 2 life.*untapped|enters the battlefield tapped unless you pay 2 life/i.test(card.text || '');

    if (isShockland) {
      if (payload.pay2Life === true) {
        CombatDamageEngine.loseLife({ playerId, amount: 2, reason: 'SHOCKLAND_COST' }, this);
        card.isTapped = false;
        this.emit('SHOCKLAND_ETB_RESOLVED', { playerId, card, paidLife: true });
      } else {
        card.isTapped = true;
        this.emit('SHOCKLAND_ETB_RESOLVED', { playerId, card, paidLife: false, enteredTapped: true });
      }
    }

    player.battlefield.lands.push(card);

    player.landsPlayedThisTurn = played + 1;
    if (player.resources) {
      player.resources.landsPlayedThisTurn = player.landsPlayedThisTurn;
    }

    this.emit('LAND_PLAYED', {
      playerId,
      card,
      landsPlayedThisTurn: player.landsPlayedThisTurn
    });

    return { card, landsPlayedThisTurn: player.landsPlayedThisTurn };
  }

  _handleCastSpell(payload) {
    const { playerId, instanceId, sourceZone = 'hand', manaCostPaid, targets } = payload;
    const player = this.getPlayer(playerId);

    let sourceArray;
    if (sourceZone === 'hand') {
      sourceArray = player.hand;
    } else if (sourceZone === 'graveyard') {
      sourceArray = player.graveyard;
    } else if (sourceZone === 'exile') {
      sourceArray = player.exile;
    } else {
      throw new InvalidZoneError(`Invalid sourceZone for CAST_SPELL: ${sourceZone}`);
    }

    const cardIdx = sourceArray.findIndex(c => c && c.instanceId === instanceId);
    if (cardIdx === -1) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId} not found in ${sourceZone}`);
    }

    const isFree = Boolean(payload.isFreeCast || payload.withoutPayingManaCost || sourceArray[cardIdx]?.isFreeCast);

    // Auto-tap or verify sufficient mana before deducting (bypassed if free cast)
    if (!isFree) {
      if (payload.autoTap || (payload.manaCost && !manaCostPaid)) {
        const costToPay = payload.manaCost || sourceArray[cardIdx]?.manaCost;
        if (costToPay) {
          this.autoTapForMana(playerId, costToPay);
        }
      } else if (manaCostPaid && typeof manaCostPaid === 'object') {
        for (const [color, amt] of Object.entries(manaCostPaid)) {
          const required = Number(amt) || 0;
          if (required > 0) {
            const available = player.resources.manaPool[color] || 0;
            if (available < required) {
              throw new InsufficientManaError(`Insufficient ${color} mana: required ${required}, available ${available}`);
            }
          }
        }

        for (const [color, amt] of Object.entries(manaCostPaid)) {
          const required = Number(amt) || 0;
          if (required > 0) {
            player.resources.manaPool[color] -= required;
          }
        }
      }
    }

    const [card] = sourceArray.splice(cardIdx, 1);
    card.zone = 'stack';
    card.subzone = null;
    if (isFree) {
      card.isFreeCast = true;
      card.withoutPayingManaCost = true;
    }

    if (targets) {
      card.annotations = card.annotations || {};
      card.annotations.castTargets = targets;
    }

    this.stack.push(card);
    return { card };
  }

  _handleMoveZone(payload) {
    const { playerId, instanceId, position = 'bottom' } = payload;
    const fromZone = payload.sourceZone || payload.fromZone;
    const toZone = payload.targetZone || payload.toZone;
    const targetSubzone = payload.targetSubzone;

    if (!toZone) {
      throw new StateTransitionError('targetZone (or toZone) is required for MOVE_ZONE');
    }

    const player = this.getPlayer(playerId);

    // Locate card in player or stack
    const found = ZoneModel.findCard(this, instanceId);
    if (!found) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId} not found`);
    }

    if (fromZone && found.zone !== fromZone) {
      throw new InvalidZoneError(`Card expected in zone ${fromZone}, but found in ${found.zone}`);
    }

    const card = found.card;

    // Remove from source zone container
    found.container.splice(found.index, 1);

    // Leaving battlefield cleanup
    if (found.zone === 'battlefield') {
      ZoneModel.resetCardState(card);
    }

    // Insert into destination zone
    ZoneModel.insertCardIntoZone(player, card, toZone, targetSubzone, position, this.stack);

    return { card, fromZone: found.zone, toZone };
  }

  _handleTapPermanent(payload) {
    const { playerId, instanceId } = payload;
    const player = this.getPlayer(playerId);
    const found = ZoneModel.findCard(player, instanceId);
    if (!found) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId} not found`);
    }
    if (found.zone !== 'battlefield') {
      throw new InvalidZoneError(`Cannot tap card in zone '${found.zone}'. Card must be on the battlefield.`);
    }
    if (found.card.isTapped) {
      throw new PermanentAlreadyTappedError(`Permanent "${found.card.name}" (${instanceId}) is already tapped`);
    }
    found.card.isTapped = true;
    return { card: found.card };
  }

  _handleUntapPermanent(payload) {
    const { playerId, instanceId } = payload;
    const player = this.getPlayer(playerId);
    const found = ZoneModel.findCard(player, instanceId);
    if (!found) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId} not found`);
    }
    if (found.zone !== 'battlefield') {
      throw new InvalidZoneError(`Cannot untap card in zone '${found.zone}'. Card must be on the battlefield.`);
    }
    found.card.isTapped = false;
    return { card: found.card };
  }

  _handleUntapAll(payload) {
    const { playerId } = payload;
    const player = this.getPlayer(playerId);
    const subzones = ['lands', 'creatures', 'noncreatures', 'planeswalkers'];
    let count = 0;
    for (const sub of subzones) {
      for (const card of (player.battlefield[sub] || [])) {
        if (!card.doesNotUntap && !card.doesNotUntapDuringUntapStep) {
          card.isTapped = false;
          count++;
        }
      }
    }
    return { untappedCount: count };
  }

  _handleAdjustLife(payload) {
    const { playerId, delta, targetValue, target } = payload;
    const player = this.getPlayer(playerId);

    if (targetValue !== undefined) {
      player.resources.life = Number(targetValue);
    } else if (target !== undefined) {
      player.resources.life = Number(target);
    } else if (delta !== undefined) {
      player.resources.life += Number(delta);
    }

    return { life: player.resources.life };
  }

  _handleUpdateManaPool(payload) {
    const { playerId, color, amount, clearAll } = payload;
    const poolDelta = payload.poolDelta || payload.manaDelta || (color && amount !== undefined ? { [color]: amount } : {});
    const player = this.getPlayer(playerId);

    if (clearAll) {
      player.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      return { manaPool: { ...player.resources.manaPool } };
    }

    // Pre-validate that no mana color drops below zero
    for (const [col, d] of Object.entries(poolDelta)) {
      const change = Number(d) || 0;
      const current = player.resources.manaPool[col] || 0;
      if (current + change < 0) {
        throw new InsufficientManaError(
          `Insufficient mana: Cannot reduce mana below 0 for ${col} (current: ${current}, change: ${change})`
        );
      }
    }

    // Apply valid mana changes
    for (const [col, d] of Object.entries(poolDelta)) {
      const change = Number(d) || 0;
      player.resources.manaPool[col] = (player.resources.manaPool[col] || 0) + change;
    }

    return { manaPool: { ...player.resources.manaPool } };
  }

  _handleModifyCounters(payload) {
    const { playerId, instanceId, counterType, delta, targetCount } = payload;
    const player = this.getPlayer(playerId);
    const found = ZoneModel.findCard(player, instanceId);

    if (!found) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId} not found`);
    }
    if (found.zone !== 'battlefield') {
      throw new InvalidZoneError(`Cannot modify counters on card in zone '${found.zone}'. Card must be on the battlefield.`);
    }

    const card = found.card;
    card.counters = card.counters || {};

    let newCount;
    if (targetCount !== undefined) {
      newCount = Number(targetCount);
    } else if (delta !== undefined) {
      newCount = (card.counters[counterType] || 0) + Number(delta);
    } else {
      newCount = 0;
    }

    if (newCount <= 0) {
      delete card.counters[counterType];
    } else {
      card.counters[counterType] = newCount;
    }

    return { card, counters: { ...card.counters } };
  }

  _handleSetHandRevealed(actionType, payload) {
    const { playerId } = payload;
    let isRevealed = payload.isRevealed;

    if (actionType === 'HIDE_HAND') {
      isRevealed = false;
    } else if (actionType === 'REVEAL_HAND' && isRevealed === undefined) {
      isRevealed = true;
    }

    const player = this.getPlayer(playerId);
    player.isHandRevealed = Boolean(isRevealed);
    return { playerId, isHandRevealed: player.isHandRevealed };
  }

  _handleDealDamage(payload) {
    const result = CombatDamageEngine.dealDamage(payload, this);
    this.runSBACheck();
    return result;
  }

  _handleLoseLife(payload) {
    const result = CombatDamageEngine.loseLife(payload, this);
    this.runSBACheck();
    return result;
  }

  _handleEnterWithoutCasting(payload) {
    const { playerId, instanceId, fromZone = 'library', subzone = null } = payload;
    const player = this.getPlayer(playerId);
    const card = ZoneTransitionMatrix.enterWithoutCasting(player, instanceId, fromZone, subzone);
    this.emit('CARD_ENTERED_WITHOUT_CASTING', { playerId, card, fromZone });
    this.runSBACheck();
    return { card };
  }

  _handleCastWithoutPaying(payload) {
    const { playerId, instanceId, fromZone = 'hand' } = payload;
    const player = this.getPlayer(playerId);
    const card = ZoneTransitionMatrix.castWithoutPayingManaCost(player, instanceId, fromZone, this.stack);
    this.emit('CARD_CAST_WITHOUT_PAYING', { playerId, card, fromZone });
    return { card };
  }

  _handleReanimate(payload) {
    const { playerId, instanceId } = payload;
    const player = this.getPlayer(playerId);
    const card = ZoneTransitionMatrix.reanimate(player, instanceId);
    this.emit('CREATURE_REANIMATED', { playerId, card });
    this.runSBACheck();
    return { card };
  }

  _handleRegrowth(payload) {
    const { playerId, instanceId } = payload;
    const player = this.getPlayer(playerId);
    const card = ZoneTransitionMatrix.regrowth(player, instanceId);
    this.emit('CARD_REGROWTH', { playerId, card });
    return { card };
  }

  _handleFlicker(payload) {
    const { playerId, instanceId } = payload;
    const player = this.getPlayer(playerId);
    const card = ZoneTransitionMatrix.flicker(player, instanceId);
    this.emit('PERMANENT_FLICKERED', { playerId, card });
    this.runSBACheck();
    return { card };
  }

  _handleMill(payload) {
    const { playerId, count = 1 } = payload;
    const player = this.getPlayer(playerId);
    const cards = ZoneTransitionMatrix.mill(player, count);
    this.emit('CARDS_MILLED', { playerId, count, cards });
    return { cards };
  }

  _handleImpulseExile(payload) {
    const { playerId, count = 1 } = payload;
    const player = this.getPlayer(playerId);
    const cards = ZoneTransitionMatrix.impulseExile(player, count);
    this.emit('CARDS_IMPULSE_EXILED', { playerId, count, cards });
    return { cards };
  }

  // --- Convenience Direct Methods ---

  initializeDeck(playerId, deckCards, options) {
    return this.dispatch('INITIALIZE_DECK', { playerId, deckCards, options });
  }

  drawCard(playerId, count = 1) {
    return this.dispatch('DRAW_CARD', { playerId, count });
  }

  drawCardForTurn(playerId, context = {}) {
    return this.drawCard(playerId, 1);
  }

  canPlayLand(playerId = this.activePlayerId) {
    const player = this.getPlayer(playerId);
    if (!player) {
      const res = { allowed: false, reason: 'NOT_ACTIVE_PLAYER', message: '⚠️ Player not found' };
      res.valueOf = () => false;
      return res;
    }

    // 1. Check Active Player
    const activePid = this.priorityMachine?.activePlayerId || this.activePlayerId;
    if (activePid && activePid !== playerId) {
      const res = { allowed: false, reason: 'NOT_ACTIVE_PLAYER', message: '⚠️ It is not your turn' };
      res.valueOf = () => false;
      return res;
    }

    // 2. Check Phase Timing (Main Phase Only)
    const currentPhase = this.priorityMachine?.currentPhaseStep;
    if (currentPhase) {
      const normalizedPhase = currentPhase.toUpperCase();
      const isMain = normalizedPhase.includes('MAIN') || normalizedPhase === 'PRECOMBAT_MAIN' || normalizedPhase === 'POSTCOMBAT_MAIN';
      if (!isMain) {
        const res = { allowed: false, reason: 'WRONG_PHASE', message: '⚠️ Lands can only be played during Main phase' };
        res.valueOf = () => false;
        return res;
      }
    }

    // 3. Check Stack Depth (Must be empty)
    const stackDepth = this.priorityMachine?.getStackDepth?.() ?? this.stack.length;
    if (stackDepth > 0) {
      const res = { allowed: false, reason: 'STACK_NOT_EMPTY', message: '⚠️ Lands can only be played when the stack is empty' };
      res.valueOf = () => false;
      return res;
    }

    // 4. Check Priority
    const priorityPid = this.priorityMachine?.priorityPlayerId;
    if (priorityPid && priorityPid !== playerId) {
      const res = { allowed: false, reason: 'NOT_ACTIVE_PLAYER', message: '⚠️ You do not hold priority' };
      res.valueOf = () => false;
      return res;
    }

    // 5. Check Land Drop Limit (CR 305.1)
    const played = player.landsPlayedThisTurn ?? player.resources?.landsPlayedThisTurn ?? 0;
    const limit = player.maxLandsPerTurn ?? player.landsPerTurnLimit ?? player.resources?.maxLandsPerTurn ?? 1;
    if (played >= limit) {
      const res = { allowed: false, reason: 'LAND_LIMIT_REACHED', message: `⚠️ You have already played a land this turn (${played}/${limit})` };
      res.valueOf = () => false;
      return res;
    }

    const res = { allowed: true };
    res.valueOf = () => true;
    return res;
  }

  /**
   * Directly taps a land on the battlefield to float 1 mana into mana pool (INV-MANA-1).
   * 
   * @param {string} playerId
   * @param {string} instanceId
   * @param {string} [chosenColor]
   * @returns {{ card: Object, manaAdded: Record<string, number> }}
   */
  tapLandForMana(playerId, instanceId, chosenColor = null) {
    const player = this.getPlayer(playerId);
    const lands = player.battlefield?.lands || [];
    const foundLand = lands.find(l => l && (l.instanceId === instanceId || l.id === instanceId));

    if (!foundLand) {
      const foundAnywhere = ZoneModel.findCard(player, instanceId);
      if (!foundAnywhere) {
        throw new CardNotFoundError(`Land with instanceId '${instanceId}' not found on battlefield.`);
      }
      if (foundAnywhere.zone !== 'battlefield') {
        throw new InvalidZoneError(`Cannot tap land in zone '${foundAnywhere.zone}'. Land must be on the battlefield.`);
      }
      if (!/land/i.test(foundAnywhere.card.typeLine || foundAnywhere.card.type || '')) {
        throw new InvalidCardTypeError(`Card '${foundAnywhere.card.name}' is not a land.`);
      }
    }

    const land = foundLand || ZoneModel.findCard(player, instanceId).card;

    if (land.isTapped) {
      throw new PermanentAlreadyTappedError(`Permanent "${land.name}" (${instanceId}) is already tapped`);
    }

    const color = chosenColor || this._resolveLandManaColor(land);
    land.isTapped = true;

    player.resources.manaPool = player.resources.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    player.resources.manaPool[color] = (player.resources.manaPool[color] || 0) + 1;

    const manaAdded = { [color]: 1 };

    this.emit('PERMANENT_TAPPED', { playerId, instanceId: land.instanceId || instanceId, card: land });
    this.emit('LAND_TAPPED', { playerId, instanceId: land.instanceId || instanceId, card: land, manaAdded });
    this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });

    return { card: land, manaAdded };
  }

  /**
   * Helper to determine primary mana color produced by a land.
   * 
   * @param {Object} land
   * @returns {string}
   */
  _resolveLandManaColor(land) {
    const name = String(land.name || '').toLowerCase();
    const typeLine = String(land.typeLine || land.type || '').toLowerCase();

    if (name.includes('mountain') || typeLine.includes('mountain')) return 'R';
    if (name.includes('island') || typeLine.includes('island')) return 'U';
    if (name.includes('swamp') || typeLine.includes('swamp')) return 'B';
    if (name.includes('plains') || typeLine.includes('plains')) return 'W';
    if (name.includes('forest') || typeLine.includes('forest')) return 'G';
    if (name.includes('wastes') || name.includes("urza's")) return 'C';
    if (name.includes('steam vents') || name.includes('spirebluff')) return 'R';
    if (name.includes('overgrown tomb') || name.includes('twilight mire')) return 'B';
    if (name.includes('breeding pool')) return 'U';
    if (name.includes('stomping ground')) return 'R';

    if (Array.isArray(land.colors) && land.colors.length > 0) return land.colors[0];
    if (Array.isArray(land.colorIdentity) && land.colorIdentity.length > 0) return land.colorIdentity[0];
    return 'C';
  }

  /**
   * MTG Arena Greedy Auto-Tap Engine (INV-MANA-1).
   * Parses mana cost string, evaluates floating mana, taps matching untapped lands to cover
   * deficit atomically, and returns AutoTapResult.
   * 
   * @param {string} playerId
   * @param {string} manaCostString
   * @returns {{ success: boolean, tappedLands: Array, tappedLandIds: string[], manaPaid: Record<string, number>, remainingPool: Record<string, number> }}
   */
  autoTapForMana(playerId, manaCostString) {
    const player = this.getPlayer(playerId);
    player.resources.manaPool = player.resources.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

    const parsedCost = this._parseManaCostString(manaCostString);
    const pool = { ...player.resources.manaPool };

    // 1. Evaluate colored requirements vs pool
    const coloredDeficits = {};
    const manaDeducted = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

    for (const [col, req] of Object.entries(parsedCost.colored)) {
      const avail = pool[col] || 0;
      if (avail >= req) {
        pool[col] -= req;
        manaDeducted[col] += req;
      } else {
        manaDeducted[col] += avail;
        coloredDeficits[col] = req - avail;
        pool[col] = 0;
      }
    }

    // 2. Evaluate generic requirement vs remaining pool
    let genericDeficit = parsedCost.generic;
    const poolColors = ['C', 'W', 'U', 'B', 'R', 'G'];
    for (const col of poolColors) {
      if (genericDeficit <= 0) break;
      const avail = pool[col] || 0;
      const take = Math.min(avail, genericDeficit);
      if (take > 0) {
        pool[col] -= take;
        manaDeducted[col] += take;
        genericDeficit -= take;
      }
    }

    // If no deficit remains, floating mana covers entire cost
    if (Object.keys(coloredDeficits).length === 0 && genericDeficit <= 0) {
      player.resources.manaPool = pool;
      this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });
      return {
        success: true,
        tappedLands: [],
        tappedLandIds: [],
        manaPaid: manaDeducted,
        remainingPool: { ...player.resources.manaPool }
      };
    }

    // 3. Scan untapped lands to satisfy deficits
    const untappedLands = (player.battlefield?.lands || []).filter(l => l && !l.isTapped);
    const landsToTap = [];
    const simulatedTaps = new Set();

    // Satisfy colored deficits first
    for (const [col, defCount] of Object.entries(coloredDeficits)) {
      let needed = defCount;
      for (const land of untappedLands) {
        if (needed <= 0) break;
        if (simulatedTaps.has(land.instanceId || land)) continue;

        const produced = this._resolveLandManaColor(land);
        const name = String(land.name || '').toLowerCase();
        const canProduce = produced === col ||
          (col === 'R' && (name.includes('steam vents') || name.includes('spirebluff') || name.includes('stomping'))) ||
          (col === 'U' && (name.includes('steam vents') || name.includes('breeding'))) ||
          (col === 'B' && (name.includes('overgrown tomb') || name.includes('twilight mire'))) ||
          (col === 'G' && (name.includes('overgrown tomb') || name.includes('twilight mire') || name.includes('breeding') || name.includes('stomping')));

        if (canProduce) {
          landsToTap.push({ land, color: col });
          simulatedTaps.add(land.instanceId || land);
          needed--;
        }
      }

      if (needed > 0) {
        // Atomic abort: insufficient colored mana
        throw new InsufficientManaError(`Insufficient ${col} mana: needed ${defCount}, available ${defCount - needed}`);
      }
    }

    // Satisfy generic deficit with remaining untapped lands
    let genNeeded = genericDeficit;
    for (const land of untappedLands) {
      if (genNeeded <= 0) break;
      if (simulatedTaps.has(land.instanceId || land)) continue;

      const col = this._resolveLandManaColor(land);
      landsToTap.push({ land, color: col });
      simulatedTaps.add(land.instanceId || land);
      genNeeded--;
    }

    if (genNeeded > 0) {
      // Atomic abort: insufficient lands for generic mana
      throw new InsufficientManaError(`Insufficient mana: needed ${parsedCost.totalCmc}, could not satisfy cost.`);
    }

    // Commit: tap all selected lands and deduct floating pool
    for (const { land, color } of landsToTap) {
      land.isTapped = true;
      manaDeducted[color] = (manaDeducted[color] || 0) + 1;
      this.emit('PERMANENT_TAPPED', { playerId, instanceId: land.instanceId, card: land });
      this.emit('LAND_TAPPED', { playerId, instanceId: land.instanceId, card: land, manaAdded: { [color]: 1 } });
    }

    player.resources.manaPool = pool;
    this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });

    const tappedCards = landsToTap.map(item => item.land);
    return {
      success: true,
      tappedLands: tappedCards,
      tappedLandIds: tappedCards.map(l => l.instanceId || l.id),
      manaPaid: manaDeducted,
      remainingPool: { ...player.resources.manaPool }
    };
  }

  /**
   * Parses mana cost string into colored and generic requirements.
   * Examples: "{R}" -> { colored: { R: 1 }, generic: 0 }
   *           "{1}{R}" -> { colored: { R: 1 }, generic: 1 }
   *           "{R}{R}" -> { colored: { R: 2 }, generic: 0 }
   *           "{5}{U}{U}" -> { colored: { U: 2 }, generic: 5 }
   * 
   * @param {string} costStr
   * @returns {{ colored: Record<string, number>, generic: number, totalCmc: number }}
   */
  _parseManaCostString(costStr) {
    const colored = {};
    let generic = 0;
    let totalCmc = 0;

    if (!costStr || typeof costStr !== 'string') {
      return { colored, generic, totalCmc };
    }

    const matches = costStr.match(/\{([^}]+)\}/g) || [];
    if (matches.length === 0) {
      // Shorthand e.g. "1R", "RR", "2G"
      const numMatch = costStr.match(/^(\d+)/);
      if (numMatch) {
        generic = parseInt(numMatch[1], 10);
      }
      const letters = costStr.replace(/[0-9]/g, '').toUpperCase().split('');
      for (const char of letters) {
        if (['W', 'U', 'B', 'R', 'G', 'C'].includes(char)) {
          colored[char] = (colored[char] || 0) + 1;
        }
      }
      totalCmc = generic + Object.values(colored).reduce((a, b) => a + b, 0);
      return { colored, generic, totalCmc };
    }

    for (const rawToken of matches) {
      const sym = rawToken.replace(/[{}]/g, '').toUpperCase().trim();
      const num = parseInt(sym, 10);
      if (!isNaN(num)) {
        generic += num;
        totalCmc += num;
      } else if (['W', 'U', 'B', 'R', 'G', 'C'].includes(sym)) {
        colored[sym] = (colored[sym] || 0) + 1;
        totalCmc += 1;
      } else if (sym === 'X') {
        // X = 0 by default unless declared
      }
    }

    return { colored, generic, totalCmc };
  }

  resetTurnQuotas(playerId) {
    const targetPlayers = playerId ? [this.getPlayer(playerId)] : Object.values(this.players);
    for (const player of targetPlayers) {
      player.landsPlayedThisTurn = 0;
      if (player.resources) {
        player.resources.landsPlayedThisTurn = 0;
      }
    }
    return { playerId: playerId || this.activePlayerId, landsPlayedThisTurn: 0 };
  }

  playLand(playerIdOrPayload, instanceIdOrCard) {
    if (typeof playerIdOrPayload === 'object' && playerIdOrPayload !== null) {
      return this.dispatch('PLAY_LAND', playerIdOrPayload);
    }
    const instanceId = typeof instanceIdOrCard === 'object' ? instanceIdOrCard.instanceId : instanceIdOrCard;
    const card = typeof instanceIdOrCard === 'object' ? instanceIdOrCard : undefined;
    return this.dispatch('PLAY_LAND', { playerId: playerIdOrPayload, instanceId, card });
  }

  handleStackResolution(resolvedItem) {
    if (!resolvedItem) return null;
    const card = resolvedItem.card || resolvedItem;
    const controllerId = resolvedItem.controllerId || resolvedItem.sourcePlayerId || card.controllerId || card.ownerId || this.activePlayerId;
    const player = this.getPlayer(controllerId);

    // If card is still in this.stack, remove it
    const stackIdx = this.stack.findIndex(c => c && (c.instanceId === card.instanceId || c === card));
    if (stackIdx !== -1) {
      this.stack.splice(stackIdx, 1);
    }

    const typeLine = String(card.typeLine || card.type || '').toLowerCase();
    let destinationZone = 'battlefield';
    let destinationSubzone = null;

    if (typeLine.includes('creature')) {
      destinationSubzone = 'creatures';
      card.zone = 'battlefield';
      card.subzone = 'creatures';
      card.isSummoningSick = true;
      card.summoningSickness = true;
      card.isTapped = false;
      player.battlefield.creatures.push(card);
    } else if (typeLine.includes('land')) {
      destinationSubzone = 'lands';
      card.zone = 'battlefield';
      card.subzone = 'lands';
      card.isTapped = false;
      player.battlefield.lands.push(card);
    } else if (typeLine.includes('planeswalker')) {
      destinationSubzone = 'planeswalkers';
      card.zone = 'battlefield';
      card.subzone = 'planeswalkers';
      card.isTapped = false;
      player.battlefield.planeswalkers.push(card);
    } else if (typeLine.includes('artifact') || typeLine.includes('enchantment') || typeLine.includes('battle')) {
      destinationSubzone = 'noncreatures';
      card.zone = 'battlefield';
      card.subzone = 'noncreatures';
      card.isTapped = false;
      player.battlefield.noncreatures.push(card);
    } else if (typeLine.includes('instant') || typeLine.includes('sorcery')) {
      destinationZone = 'graveyard';
      card.zone = 'graveyard';
      card.subzone = null;
      player.graveyard.push(card);
    } else {
      if (card.isPermanent) {
        destinationSubzone = 'noncreatures';
        card.zone = 'battlefield';
        card.subzone = 'noncreatures';
        card.isTapped = false;
        player.battlefield.noncreatures.push(card);
      } else {
        destinationZone = 'graveyard';
        card.zone = 'graveyard';
        card.subzone = null;
        player.graveyard.push(card);
      }
    }

    // Sync with player.zones if present
    if (player.zones) {
      if (destinationZone === 'battlefield') {
        if (!player.zones.battlefield) player.zones.battlefield = [];
        player.zones.battlefield.push(card);
      } else if (destinationZone === 'graveyard') {
        if (!player.zones.graveyard) player.zones.graveyard = [];
        player.zones.graveyard.push(card);
      }
    }

    this._notifySubscribers({
      sequenceId: ++this.sequenceCounter,
      actionType: destinationZone === 'battlefield' ? 'CARD_ENTERED_BATTLEFIELD' : 'SPELL_RESOLVED_TO_GRAVEYARD',
      playerId: controllerId,
      payload: { card, destinationZone, destinationSubzone },
      timestamp: Date.now()
    }, { card, destinationZone, destinationSubzone });

    this.emit('STACK_RESOLVE', { card, destinationZone, destinationSubzone, controllerId });
    this.emit('STACK_RESOLVED', { card, destinationZone, destinationSubzone, controllerId });
    if (destinationZone === 'battlefield') {
      this.emit('CARD_ENTERED_BATTLEFIELD', { card, subzone: destinationSubzone, controllerId });
    } else {
      this.emit('SPELL_RESOLVED_TO_GRAVEYARD', { card, controllerId });
    }

    return { card, destinationZone, destinationSubzone };
  }

  castSpell(playerId, instanceId, options = {}) {
    return this.dispatch('CAST_SPELL', { playerId, instanceId, ...options });
  }

  moveZone(playerId, instanceId, fromZone, toZone, options = {}) {
    return this.dispatch('MOVE_ZONE', { playerId, instanceId, fromZone, toZone, ...options });
  }

  tapPermanent(playerId, instanceId) {
    return this.dispatch('TAP_PERMANENT', { playerId, instanceId });
  }

  untapPermanent(playerId, instanceId) {
    return this.dispatch('UNTAP_PERMANENT', { playerId, instanceId });
  }

  untapAll(playerId) {
    return this.dispatch('UNTAP_ALL', { playerId });
  }

  adjustLife(playerId, lifeOptions) {
    return this.dispatch('ADJUST_LIFE', {
      playerId,
      ...(typeof lifeOptions === 'number' ? { delta: lifeOptions } : lifeOptions)
    });
  }

  updateManaPool(playerId, manaDelta) {
    return this.dispatch('UPDATE_MANA_POOL', { playerId, poolDelta: manaDelta });
  }

  modifyCounters(playerId, instanceId, counterType, delta) {
    return this.dispatch('MODIFY_COUNTERS', { playerId, instanceId, counterType, delta });
  }

  setHandRevealed(playerId, isRevealed) {
    return this.dispatch('SET_HAND_REVEALED', { playerId, isRevealed });
  }

  mutatePlayerLife(playerId, delta) {
    return this.adjustLife(playerId, delta);
  }

  setPlayerLife(playerId, life) {
    return this.adjustLife(playerId, { targetValue: life });
  }

  addCardToZone(playerId, zone, cardData = {}) {
    const player = this.getPlayer(playerId);
    const instanceId = cardData.instanceId || ZoneModel.generateInstanceId();
    const typeLine = cardData.typeLine || '';
    const subzone = cardData.subzone !== undefined
      ? cardData.subzone
      : (zone === 'battlefield' ? classifySubzone(typeLine) : null);

    const card = {
      instanceId,
      name: cardData.name || 'Unknown Card',
      manaCost: cardData.manaCost || '',
      typeLine,
      oracleText: cardData.oracleText || '',
      imageUri: cardData.imageUri || '',
      power: cardData.power,
      toughness: cardData.toughness,
      loyalty: cardData.loyalty,
      modernLegal: cardData.modernLegal !== undefined ? cardData.modernLegal : true,
      colors: cardData.colors || [],
      ownerId: cardData.ownerId || playerId,
      controllerId: cardData.controllerId || playerId,
      zone,
      subzone,
      isTapped: Boolean(cardData.isTapped),
      counters: cardData.counters ? { ...cardData.counters } : {},
      isToken: Boolean(cardData.isToken),
      isFaceDown: Boolean(cardData.isFaceDown),
      annotations: cardData.annotations ? { ...cardData.annotations } : {},
      ...cardData
    };

    ZoneModel.insertCardIntoZone(player, card, zone, subzone, cardData.position || 'bottom', this.stack);
    this._notifySubscribers({
      sequenceId: ++this.sequenceCounter,
      actionType: 'ADD_CARD_TO_ZONE',
      playerId,
      payload: { zone, card },
      timestamp: Date.now()
    }, { card });
    return card;
  }

  dealDamage(payload) {
    return this.dispatch('DEAL_DAMAGE', payload);
  }

  loseLife(playerId, amount, reason = 'LIFE_LOSS') {
    return this.dispatch('LOSE_LIFE', { playerId, amount, reason });
  }

  enterWithoutCasting(playerId, instanceId, fromZone = 'library', subzone = null) {
    return this.dispatch('ENTER_WITHOUT_CASTING', { playerId, instanceId, fromZone, subzone });
  }

  reanimate(playerId, instanceId) {
    return this.dispatch('REANIMATE', { playerId, instanceId });
  }

  regrowth(playerId, instanceId) {
    return this.dispatch('REGROWTH', { playerId, instanceId });
  }

  flicker(playerId, instanceId) {
    return this.dispatch('FLICKER', { playerId, instanceId });
  }

  mill(playerId, count = 1) {
    return this.dispatch('MILL', { playerId, count });
  }

  impulseExile(playerId, count = 1) {
    return this.dispatch('IMPULSE_EXILE', { playerId, count });
  }

  searchZone(playerId, zoneName = 'library', filterFn = null) {
    const player = this.getPlayer(playerId);
    let cards = [];
    if (zoneName === 'battlefield') {
      cards = [
        ...(player.battlefield?.lands || []),
        ...(player.battlefield?.creatures || []),
        ...(player.battlefield?.noncreatures || []),
        ...(player.battlefield?.planeswalkers || [])
      ];
    } else {
      cards = Array.isArray(player[zoneName]) ? [...player[zoneName]] : [];
    }
    if (typeof filterFn === 'function') {
      return cards.filter(filterFn);
    }
    return cards;
  }

  setPriorityMachine(priorityMachine) {
    this.priorityMachine = priorityMachine;
    this._wirePriorityMachine();
  }

  _wirePriorityMachine() {
    if (!this.priorityMachine || this._priorityMachineWired) return;
    this._priorityMachineWired = true;

    this.priorityMachine.on('PHASE_STEP_CHANGED', (data) => {
      this.handlePhaseStepChanged(data);
    });

    this.priorityMachine.on('UNTAP_STEP_ENTERED', (data) => {
      this.handleUntapStep(data.activePlayerId);
    });

    this.priorityMachine.on('UPKEEP_STEP_ENTERED', (data) => {
      this.handleUpkeepStep(data.activePlayerId, data.turnNumber);
    });

    this.priorityMachine.on('CLEANUP_STEP_ENTERED', (data) => {
      this.handleCleanupStep(data.activePlayerId);
    });
  }

  handleUntapStep(activePlayerId) {
    if (!activePlayerId) return;
    this.untapAll(activePlayerId);
    this.resetTurnQuotas(activePlayerId);
    this.emit('AUTO_UNTAP_RESOLVED', { activePlayerId });
  }

  handleUpkeepStep(activePlayerId, turnNumber) {
    this.emit('UPKEEP_PERK_PROMPT_READY', {
      activePlayerId,
      turnNumber: turnNumber || this.turnNumber
    });
  }

  handleCleanupStep(activePlayerId) {
    const count = StateBasedActionsEngine.purgeCleanupMarkedDamage(this);
    this.runSBACheck();
    this.emit('CLEANUP_DAMAGE_PURGED', { activePlayerId, purgedCount: count });
  }

  handlePhaseStepChanged(data) {
    const { currentPhaseStep, activePlayerId } = data;
    if (currentPhaseStep === 'UNTAP') {
      this.handleUntapStep(activePlayerId);
    } else if (currentPhaseStep === 'UPKEEP') {
      this.handleUpkeepStep(activePlayerId, data.turnNumber);
    } else if (currentPhaseStep === 'DRAW') {
      if (!data.shouldSkipDraw) {
        try {
          this.drawCardForTurn(activePlayerId);
          this.emit('AUTO_DRAW_RESOLVED', { activePlayerId });
        } catch (err) {}
      }
    } else if (currentPhaseStep === 'CLEANUP') {
      this.handleCleanupStep(activePlayerId);
    }
  }

  runSBACheck() {
    return StateBasedActionsEngine.runSBACheck(this, this.abilityEngine);
  }
}
