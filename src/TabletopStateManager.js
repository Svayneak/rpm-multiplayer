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
import { CombatDamageEngine, canDeclareAsAttacker } from './CombatDamageEngine.js';
import { StateBasedActionsEngine } from './StateBasedActionsEngine.js';
import { AbilityEngine, CONTINUOUS_LAYERS } from './AbilityEngine.js';
import { CostModificationEngine } from './CostModificationEngine.js';
import { PregameStateMachine, PREGAME_STATES } from './PregameStateMachine.js';
import { ProcessTraceLogger, defaultProcessTraceLogger } from './ProcessTraceLogger.js';

export { canDeclareAsAttacker, PregameStateMachine, PREGAME_STATES, ProcessTraceLogger };

export class LandLimitExceededError extends StateTransitionError {
  constructor(message = 'Land drop limit reached for this turn') {
    super(message);
    this.name = 'LandLimitExceededError';
  }
}

export class PriorityViolationError extends StateTransitionError {
  constructor(message = 'Priority violation', details = {}) {
    super(message);
    this.name = 'PriorityViolationError';
    this.details = details;
    this.reason = details.reason || 'NO_PRIORITY';
  }
}

export class PhaseTimingError extends StateTransitionError {
  constructor(message = 'Phase timing restriction violated', details = {}) {
    super(message);
    this.name = 'PhaseTimingError';
    this.details = details;
    this.reason = details.reason || 'SORCERY_SPEED_RESTRICTION';
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
    activePlayerId: fullState.priorityMachine?.activePlayerId || fullState._priorityMachine?.activePlayerId || fullState.activePlayerId || null,
    turnNumber: fullState.turnNumber ?? 1,
    stack: (fullState.stack || []).map(cloneCard),
    players: projectedPlayers,
    viewerPlayerId,
    timestamp: Date.now()
  };
}

/**
 * Hydrates card mechanics, rules text, and effects for active deck cards.
 * @param {Object} card
 * @returns {Object}
 */
export function hydrateCardMechanics(card) {
  if (!card) return card;
  const nameNorm = String(card.name || '').trim().toLowerCase();
  if (nameNorm === 'lava spike') {
    card.effect = card.effect || { type: 'DEAL_DAMAGE', amount: 3, targetType: 'player_or_planeswalker' };
    card.typeLine = card.typeLine || 'Sorcery — Arcane';
    card.manaCost = card.manaCost || '{R}';
  } else if (nameNorm === 'lightning bolt') {
    card.effect = card.effect || { type: 'DEAL_DAMAGE', amount: 3, targetType: 'any' };
    card.typeLine = card.typeLine || 'Instant';
    card.manaCost = card.manaCost || '{R}';
  } else if (nameNorm === 'goblin guide') {
    card.typeLine = card.typeLine || 'Creature — Goblin Scout';
    card.keywords = { ...(card.keywords || {}), haste: true, Haste: true };
    card.hasSummoningSickness = false;
    card.isSummoningSick = false;
    card.power = card.power ?? 2;
    card.toughness = card.toughness ?? 2;
  } else if (nameNorm === 'monastery swiftspear') {
    card.typeLine = card.typeLine || 'Creature — Human Monk';
    card.keywords = { ...(card.keywords || {}), haste: true, Haste: true, prowess: true, Prowess: true };
    card.hasSummoningSickness = false;
    card.isSummoningSick = false;
    card.power = card.power ?? 1;
    card.toughness = card.toughness ?? 2;
  } else if (nameNorm === 'steam vents') {
    card.isShockland = true;
  }
  return card;
}

/**
 * High-level Tabletop Match Manager and Event Coordinator.
 */
export class TabletopStateManager extends EventEmitter {
  static hydrateCardMechanics(card) {
    return hydrateCardMechanics(card);
  }

  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId || `session_${Date.now()}`;
    this.players = {}; // Map: playerId -> PlayerZoneState
    this.stack = [];   // Array: CardInstance
    this._activePlayerId = options.activePlayerId || null;
    this._turnNumber = options.turnNumber || 1;
    this._roundNumber = options.roundNumber || 1;
    this.startingPlayerId = options.startingPlayerId || (Array.isArray(options.players) ? (typeof options.players[0] === 'string' ? options.players[0] : options.players[0]?.id) : null) || this._activePlayerId || 'p1';
    this.playerTurnNumbers = new Map();
    this._priorityMachine = options.priorityMachine || null;
    this._priorityMachineWired = false;
    this.pregameMachine = options.pregameMachine || null;
    this.traceLogger = options.traceLogger || defaultProcessTraceLogger;
    this.abilityEngine = options.abilityEngine || new AbilityEngine({ tabletopState: this, traceLogger: this.traceLogger });
    if (this.abilityEngine) {
      this.abilityEngine._tabletopState = this;
      this.abilityEngine.tabletopState = this;
      if (!this.abilityEngine.traceLogger) this.abilityEngine.traceLogger = this.traceLogger;
    }
    this.costEngine = CostModificationEngine;
    this.actionLog = [];
    this.subscribers = new Set();
    this.sequenceCounter = 0;
    this.winnerId = null;
    this.isGameOver = false;
    this.combatState = { attackers: [], blockers: [] };

    if (Array.isArray(options.players)) {
      for (const p of options.players) {
        if (typeof p === 'string') {
          this.registerPlayer(p, p);
        } else if (p && p.id) {
          this.registerPlayer(p.id, p.name || p.id);
        }
      }
    }

    if (this._priorityMachine) {
      this._wirePriorityMachine();
    }
  }

  get activePlayerId() {
    return this._priorityMachine?.activePlayerId ?? this._activePlayerId;
  }
  set activePlayerId(val) {
    this._activePlayerId = val;
    if (this._priorityMachine && this._priorityMachine.activePlayerId !== val) {
      this._priorityMachine.activePlayerId = val;
    }
  }

  get turnNumber() {
    return this._priorityMachine?.turnNumber ?? this._turnNumber;
  }
  set turnNumber(val) {
    this._turnNumber = val;
    if (this._priorityMachine && this._priorityMachine.turnNumber !== val) {
      this._priorityMachine.turnNumber = val;
    }
  }

  get roundNumber() {
    return this._priorityMachine?.roundNumber ?? this._roundNumber;
  }
  set roundNumber(val) {
    this._roundNumber = val;
    if (this._priorityMachine && this._priorityMachine.roundNumber !== val) {
      this._priorityMachine.roundNumber = val;
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
    player.id = playerId;
    player.playerId = playerId;
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
  /**
   * Resolves canonical player ID when 'p1'/'P1' or 'p2'/'P2' alias is passed in a UUID-seated match.
   * @param {string} playerId
   * @returns {string}
   */
  resolvePlayerId(playerId) {
    if (!playerId || this.players[playerId]) return playerId;
    const norm = String(playerId).trim().toLowerCase();
    const keys = Object.keys(this.players || {});
    if (norm === 'p1' && keys[0] && /^[0-9a-f]{8}-/i.test(keys[0])) return keys[0];
    if (norm === 'p2' && keys[1] && keys[1] !== 'p2') return keys[1];
    return playerId;
  }

  getPlayer(playerId) {
    const resolvedId = this.resolvePlayerId(playerId);
    const player = this.players[resolvedId];
    if (!player) {
      throw new PlayerNotFoundError(`Player '${playerId}' not found in session`);
    }
    return player;
  }

  /**
   * Eliminates a player from the match (via concession, life 0, or deckout).
   * Unregisters all static effects of the player's permanents, clears their battlefield,
   * notifies priorityMachine, logs the action, and checks the victory condition.
   * 
   * @param {string} playerId
   * @param {string} [reason='CONCEDED']
   * @returns {{ eliminatedPlayerId: string, gameOver: boolean, winnerId: string|null }}
   */
  eliminatePlayer(playerId, reason = 'CONCEDED') {
    const player = this.players[playerId];
    if (!player) return null;

    player.isEliminated = true;

    // Collect permanents to unregister static effects and clear battlefield
    const permanents = [];
    if (Array.isArray(player.battlefield)) {
      permanents.push(...player.battlefield);
      player.battlefield = [];
    } else if (player.battlefield && typeof player.battlefield === 'object') {
      for (const key of Object.keys(player.battlefield)) {
        if (Array.isArray(player.battlefield[key])) {
          permanents.push(...player.battlefield[key]);
          player.battlefield[key] = [];
        }
      }
    }
    if (player.zones && Array.isArray(player.zones.battlefield)) {
      permanents.push(...player.zones.battlefield);
      player.zones.battlefield = [];
    }

    for (const perm of permanents) {
      if (perm && perm.instanceId && this.abilityEngine) {
        try {
          this.abilityEngine.unregisterEffectsFromSource(perm.instanceId);
        } catch (_) {}
      }
    }

    // Clean up cards on stack controlled or owned by eliminated player
    if (Array.isArray(this.stack)) {
      this.stack = this.stack.filter(card => {
        const owner = card.controllerId || card.ownerId || card.playerId;
        return owner !== playerId;
      });
    }

    const logEntry = {
      sequenceId: ++this.sequenceCounter,
      timestamp: Date.now(),
      actionType: 'PLAYER_ELIMINATED',
      playerId,
      payload: { playerId, reason }
    };
    this.actionLog.push(logEntry);
    this.emit('PLAYER_ELIMINATED', { playerId, reason });

    // Notify priority machine if wired
    if (this.priorityMachine && typeof this.priorityMachine.eliminatePlayer === 'function') {
      this.priorityMachine.eliminatePlayer(playerId);
    }

    // Victory condition check: count living players (!p.isEliminated)
    const survivingPlayers = Object.values(this.players).filter(p => !p.isEliminated);
    if (survivingPlayers.length === 1) {
      const survivingPlayer = survivingPlayers[0];
      this.winnerId = survivingPlayer.id || survivingPlayer.playerId;
      this.isGameOver = true;
      const gameOverPayload = {
        winnerId: this.winnerId,
        survivingPlayer
      };
      this.emit('GAME_OVER', gameOverPayload);
      return {
        eliminatedPlayerId: playerId,
        gameOver: true,
        winnerId: this.winnerId
      };
    }

    return {
      eliminatedPlayerId: playerId,
      gameOver: false,
      winnerId: null
    };
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
      case 'DECLARE_ATTACKERS':
        result = this.declareAttackers(payload.playerId || this.activePlayerId, payload.attackers || payload.attackersList || []);
        break;
      case 'DECLARE_BLOCKERS':
        result = this.declareBlockers(payload.playerId, payload.assignments || payload.blockers || []);
        break;
      case 'RESOLVE_COMBAT_DAMAGE':
        result = this.resolveCombatDamage();
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

    const instanceId = payload.instanceId || (payload.card && payload.card.instanceId);
    let card = payload.card;
    if (!card && player && player.hand) {
      card = player.hand.find(c => c && (
        (instanceId && c.instanceId === instanceId) ||
        (payload.card && (c.instanceId === payload.card.instanceId || c.name === payload.card.name))
      ));
    }
    if (!card) {
      card = { typeLine: 'Land', type: 'Land' };
    }

    const check = this.canPlayerCastOrPlay(playerId, card, this.priorityMachine);
    if (!check.allowed) {
      const err = check.reason === 'SORCERY_SPEED_RESTRICTION'
        ? new PhaseTimingError(check.message, { playerId, reason: check.reason })
        : new PriorityViolationError(check.message, { playerId, reason: check.reason });
      err.reason = check.reason;
      throw err;
    }

    const cardIdx = player.hand.findIndex(c => c && (
      (instanceId && c.instanceId === instanceId) ||
      (payload.card && (c.instanceId === payload.card.instanceId || c.name === payload.card.name))
    ));
    if (cardIdx === -1) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId || payload.card?.name} not found in player's hand`);
    }

    card = player.hand[cardIdx];
    TabletopStateManager.hydrateCardMechanics(card);
    if (!/land/i.test(card.typeLine || card.type || '')) {
      throw new InvalidCardTypeError(`Card is not a land: "${card.name}" (${card.typeLine})`);
    }

    const played = player.landsPlayedThisTurn ?? player.resources?.landsPlayedThisTurn ?? 0;
    const baseLimit = player.maxLandsPerTurn ?? player.landsPerTurnLimit ?? player.resources?.maxLandsPerTurn ?? 1;
    const extraLands = player.resources?.additionalLandsAllowed || 0;
    const limit = Math.max(baseLimit, 1 + extraLands);
    if (played >= limit) {
      throw new LandLimitExceededError(`Land drop limit reached for this turn (${played}/${limit}).`);
    }

    player.hand.splice(cardIdx, 1);
    card.zone = 'battlefield';
    card.subzone = 'lands';
    card.isTapped = false;

    // Shockland Detection (Steam Vents, Sacred Foundry, Watery Grave, etc. or ETB 2 life rules text)
    const isShockland = Boolean(card.isShockland) ||
      /steam vents|sacred foundry|watery grave|stomping ground|godless shrine|blood crypt|breeding pool|overgrown tomb|temple garden|hallowed fountain/i.test(card.name || '') ||
      /pay 2 life.*untapped|enters the battlefield tapped unless you pay 2 life/i.test(card.text || card.oracleText || '');

    if (isShockland) {
      const payShock = Boolean(payload.payShockCost ?? payload.pay2Life);
      const currentLife = player.resources?.life ?? 20;
      if (payShock && currentLife > 2) {
        CombatDamageEngine.loseLife({ playerId, amount: 2, reason: 'SHOCKLAND_COST' }, this);
        card.isTapped = false;
        this.emit('SHOCKLAND_ETB_RESOLVED', { playerId, card, paidLife: true });
      } else {
        card.isTapped = true;
        this.emit('SHOCKLAND_ETB_RESOLVED', { playerId, card, paidLife: false, enteredTapped: true });
      }
    }

    player.battlefield.lands.push(card);
    this._onPermanentEnteredBattlefield(card, playerId);

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

    const targetInstanceId = instanceId || payload.card?.instanceId;

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

    const cardIdx = sourceArray.findIndex(c => c && (
      (targetInstanceId && c.instanceId === targetInstanceId) ||
      (payload.card && (c.instanceId === payload.card.instanceId || c.name === payload.card.name))
    ));
    if (cardIdx === -1) {
      if (payload.card) {
        const check = this.canPlayerCastOrPlay(playerId, payload.card, this.priorityMachine);
        if (!check.allowed) {
          const err = check.reason === 'SORCERY_SPEED_RESTRICTION'
            ? new PhaseTimingError(check.message, { playerId, reason: check.reason })
            : new PriorityViolationError(check.message, { playerId, reason: check.reason });
          err.reason = check.reason;
          throw err;
        }
      } else if (this.priorityMachine && this.priorityMachine.priorityPlayerId && this.priorityMachine.priorityPlayerId !== playerId) {
        const err = new PriorityViolationError(`Player '${playerId}' does not hold priority.`, { playerId, priorityPlayerId: this.priorityMachine.priorityPlayerId, reason: 'NO_PRIORITY' });
        err.reason = 'NO_PRIORITY';
        throw err;
      }
      throw new CardNotFoundError(`Card with instanceId ${targetInstanceId || payload.card?.name} not found in ${sourceZone}`);
    }

    const card = sourceArray[cardIdx];
    TabletopStateManager.hydrateCardMechanics(card);

    const check = this.canPlayerCastOrPlay(playerId, card, this.priorityMachine);
    if (!check.allowed) {
      const err = check.reason === 'SORCERY_SPEED_RESTRICTION'
        ? new PhaseTimingError(check.message, { playerId, reason: check.reason })
        : new PriorityViolationError(check.message, { playerId, reason: check.reason });
      err.reason = check.reason;
      throw err;
    }
    const isFree = Boolean(payload.isFreeCast || payload.withoutPayingManaCost || card?.isFreeCast);

    // Context for CostModificationEngine per CR 601.2f
    const costContext = {
      isWithoutPayingManaCost: isFree,
      alternateCostString: payload.alternateCostString || null,
      genericTax: payload.genericTax || payload.tax || 0,
      genericReduction: payload.genericReduction || payload.reduction || 0,
      applyTrinisphere: Boolean(payload.applyTrinisphere),
      delveCardsExiled: payload.delveCardsExiled || 0,
      convokeTaps: payload.convokeTaps || [],
      ...(payload.costContext || payload.context || {})
    };

    const cardForCost = {
      ...card,
      ...(payload.manaCost ? { manaCost: payload.manaCost } : {})
    };

    const costBreakdown = CostModificationEngine.calculateTotalCost(cardForCost, costContext);
    payload.costBreakdown = costBreakdown;

    // Auto-tap or verify sufficient mana before deducting (bypassed if free cast)
    if (!isFree) {
      if (payload.autoTap || (payload.manaCost && !manaCostPaid)) {
        const costToPay = costBreakdown.finalCostString || payload.manaCost || card.manaCost;
        if (costToPay) {
          this.autoTapForMana(playerId, costToPay);
        }
      }

      player.resources.manaPool = player.resources.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

      // Validate affordability using CostModificationEngine
      const affordCheck = CostModificationEngine.canAffordCost(costBreakdown.finalVector, player.resources.manaPool);

      if (manaCostPaid && typeof manaCostPaid === 'object') {
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
      } else {
        if (!affordCheck.canAfford) {
          const missingDetails = Object.entries(affordCheck.missing || {})
            .map(([k, v]) => `${v} ${k}`)
            .join(', ');
          throw new InsufficientManaError(`Insufficient mana to cast ${card.name || 'spell'}: missing ${missingDetails || 'required mana'}`);
        }

        // Deduct colored requirements
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C']) {
          const req = costBreakdown.finalVector[c] || 0;
          if (req > 0) {
            player.resources.manaPool[c] = (player.resources.manaPool[c] || 0) - req;
          }
        }

        // Deduct generic requirements from mana pool (colorless first, then colored)
        let genericToPay = costBreakdown.finalVector.generic || 0;
        if (genericToPay > 0) {
          for (const poolKey of ['C', 'colorless']) {
            if (genericToPay <= 0) break;
            const avail = player.resources.manaPool[poolKey] || 0;
            const deduct = Math.min(avail, genericToPay);
            player.resources.manaPool[poolKey] -= deduct;
            genericToPay -= deduct;
          }
          for (const col of ['W', 'U', 'B', 'R', 'G']) {
            if (genericToPay <= 0) break;
            const avail = player.resources.manaPool[col] || 0;
            const deduct = Math.min(avail, genericToPay);
            player.resources.manaPool[col] -= deduct;
            genericToPay -= deduct;
          }
        }
      }

      this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });
    }

    const [cardToStack] = sourceArray.splice(cardIdx, 1);
    cardToStack.zone = 'stack';
    cardToStack.subzone = null;
    cardToStack.costBreakdown = costBreakdown;
    if (isFree) {
      cardToStack.isFreeCast = true;
      cardToStack.withoutPayingManaCost = true;
    }

    if (targets) {
      cardToStack.targets = targets;
      cardToStack.annotations = cardToStack.annotations || {};
      cardToStack.annotations.castTargets = targets;
    }

    this.stack.push(cardToStack);

    if (this.priorityMachine && Array.isArray(this.priorityMachine.stack)) {
      const alreadyOnPsm = this.priorityMachine.stack.some(s => s && (
        s === cardToStack ||
        s.card === cardToStack ||
        (s.instanceId && cardToStack.instanceId && s.instanceId === cardToStack.instanceId)
      ));
      if (!alreadyOnPsm) {
        this.priorityMachine.pushStack({
          id: cardToStack.instanceId || `stack_${Date.now()}`,
          sourcePlayerId: playerId,
          controllerId: playerId,
          card: cardToStack,
          cardName: cardToStack.name,
          name: cardToStack.name,
          type: 'SPELL',
          targets: targets || [],
          manaCostPaid: payload.manaCostPaid || {},
          timestamp: Date.now()
        });
      }
    }

    this._checkAndFireSpellCastTriggers(playerId, cardToStack);

    return { card: cardToStack, costBreakdown };
  }

  /**
   * Evaluates spell cast triggers (such as Prowess per CR 702.108a).
   * Fires whenever a noncreature spell is cast, granting +1/+1 until end of turn.
   *
   * @param {string} playerId
   * @param {Object} spellCard
   */
  _checkAndFireSpellCastTriggers(playerId, spellCard) {
    if (!spellCard || typeof spellCard !== 'object') return;
    const isCreature = /creature/i.test(spellCard.typeLine || spellCard.type || '');
    if (isCreature) return;

    if (spellCard._prowessTriggersFired) return;
    spellCard._prowessTriggersFired = true;

    const player = this.getPlayer(playerId);
    if (!player || !player.battlefield) return;

    const creatures = player.battlefield.creatures || [];
    for (const c of creatures) {
      if (!c) continue;
      const hasProwess = Boolean(
        this._hasKeyword(c, 'prowess') ||
        c.keywords?.prowess ||
        c.keywords?.Prowess ||
        (Array.isArray(c.keywords) && c.keywords.some(k => typeof k === 'string' && k.toLowerCase() === 'prowess')) ||
        /prowess/i.test(c.oracleText || c.text || '')
      );
      if (!hasProwess) continue;

      const cId = c.instanceId || c.id;
      if (this.abilityEngine) {
        this.abilityEngine.registerStaticEffect({
          id: `prowess_${cId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          sourceId: cId,
          layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
          duration: 'END_OF_TURN',
          targetId: cId,
          powerMod: 1,
          powerDelta: 1,
          toughnessMod: 1,
          toughnessDelta: 1
        });

        this.abilityEngine.queueTrigger({
          sourceId: cId,
          sourceName: c.name || 'Monastery Swiftspear',
          controllerId: playerId,
          event: 'PROWESS_CAST_NONCREATURE',
          triggerCondition: 'PROWESS_CAST_NONCREATURE',
          text: `Prowess (+1/+1 until end of turn)`,
          effect: { type: 'PROWESS_BUFF', targetId: cId, powerDelta: 1, toughnessDelta: 1 }
        });
      }

      const stats = this.abilityEngine
        ? this.abilityEngine.evaluateCreatureStats(c, this)
        : { power: (Number(c.power) || 1) + 1, toughness: (Number(c.toughness) || 2) + 1 };

      this.recordTrace('TRIGGER_TRACE', 'PROWESS_TRIGGERED', {
        playerId,
        creatureId: cId,
        creatureName: c.name,
        spellName: spellCard.name,
        powerAfter: stats.power,
        toughnessAfter: stats.toughness
      });

      this.emit('PROWESS_TRIGGERED', {
        playerId,
        creature: c,
        creatureId: cId,
        creatureName: c.name,
        spell: spellCard,
        powerAfter: stats.power,
        toughnessAfter: stats.toughness
      });
    }
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
      if (toZone !== 'battlefield') {
        this.abilityEngine?.unregisterEffectsFromSource(card.instanceId);
      }
    }

    // Insert into destination zone
    ZoneModel.insertCardIntoZone(player, card, toZone, targetSubzone, position, this.stack);

    // Entering battlefield from another zone
    if (toZone === 'battlefield' && found.zone !== 'battlefield') {
      this._onPermanentEnteredBattlefield(card, playerId);
    }

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
    if (!player) return { untappedCount: 0 };
    const subzones = ['lands', 'creatures', 'noncreatures', 'planeswalkers'];
    let count = 0;
    for (const sub of subzones) {
      for (const card of (player.battlefield?.[sub] || [])) {
        if (!card.doesNotUntap && !card.doesNotUntapDuringUntapStep) {
          card.isTapped = false;
          count++;
        }
      }
    }
    if (Array.isArray(player.zones?.battlefield)) {
      for (const card of player.zones.battlefield) {
        if (card && !card.doesNotUntap && !card.doesNotUntapDuringUntapStep) {
          card.isTapped = false;
        }
        if (card) {
          card.isAttacking = false;
          card.defendingPlayerId = null;
          card.isBlocking = false;
          card.blockingTargetId = null;
          card.hasSummoningSickness = false;
          card.isSummoningSick = false;
          card.summoningSickness = false;
        }
      }
    }
    for (const card of (player.battlefield?.creatures || [])) {
      card.hasSummoningSickness = false;
      card.isSummoningSick = false;
      card.summoningSickness = false;
      card.isAttacking = false;
      card.defendingPlayerId = null;
      card.isBlocking = false;
      card.blockingTargetId = null;
    }
    player.landsPlayedThisTurn = 0;
    if (player.resources) {
      player.resources.landsPlayedThisTurn = 0;
      player.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
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

  dealDamage(payload) {
    return this._handleDealDamage(payload);
  }

  _handleLoseLife(payload) {
    const result = CombatDamageEngine.loseLife(payload, this);
    this.runSBACheck();
    return result;
  }

  loseLife(payload) {
    return this._handleLoseLife(payload);
  }

  _hasKeyword(card, keyword) {
    if (!card) return false;
    const evalCard = this.abilityEngine ? this.abilityEngine.evaluatePermanentLayers(card, this) : card;
    const kw = keyword.toLowerCase();

    if (evalCard?.keywords && typeof evalCard.keywords === 'object') {
      if (evalCard.keywords[kw] || evalCard.keywords[keyword]) return true;
      if (Array.isArray(evalCard.keywords) && evalCard.keywords.some(k => String(k).toLowerCase() === kw)) return true;
    }
    if (card?.keywords && typeof card.keywords === 'object') {
      if (card.keywords[kw] || card.keywords[keyword]) return true;
      if (Array.isArray(card.keywords) && card.keywords.some(k => String(k).toLowerCase() === kw)) return true;
    }
    const propName = `has${keyword.charAt(0).toUpperCase() + keyword.slice(1)}`;
    if (evalCard?.[propName] || evalCard?.[kw] || card?.[propName] || card?.[kw]) return true;

    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    if (regex.test(evalCard?.oracleText || evalCard?.text || card?.oracleText || card?.text || '')) return true;

    return false;
  }

  /**
   * Declares attacking creatures for the active player (CR 508).
   * 
   * @param {string} playerId
   * @param {Array<Object|string>} attackersList
   * @returns {{ attackers: Array<Object> }}
   */
  declareAttackers(playerId, attackersList = []) {
    const effectiveActiveId = this.priorityMachine?.activePlayerId || this.activePlayerId;
    if (playerId && effectiveActiveId && playerId !== effectiveActiveId) {
      throw new PriorityViolationError(`Only active player '${effectiveActiveId}' may declare attackers`);
    }
    if (effectiveActiveId) {
      this.activePlayerId = effectiveActiveId;
    }

    const player = this.getPlayer(playerId);
    const declaredAttackers = [];

    if (!attackersList || attackersList.length === 0) {
      this.combatState = { attackers: [], blockers: [] };
      this.emit('ATTACKERS_DECLARED', { playerId, attackers: [] });
      if (this.priorityMachine && this.priorityMachine.currentPhaseStep === 'DECLARE_ATTACKERS') {
        this.priorityMachine.advanceStep();
      }
      return { attackers: [] };
    }

    const aliveOpponents = Object.values(this.players).filter(p => (p.id || p.playerId) !== playerId && !p.isEliminated);
    const defaultDefenderId = aliveOpponents[0]?.id || aliveOpponents[0]?.playerId;

    for (const item of attackersList) {
      const creatureId = typeof item === 'string' ? item : (item.creatureId || item.id || item.instanceId);
      const defendingPlayerId = (typeof item === 'object' && item.defendingPlayerId) ? item.defendingPlayerId : defaultDefenderId;

      if (!defendingPlayerId) {
        throw new StateTransitionError('No valid defending player available');
      }
      const defender = this.getPlayer(defendingPlayerId);
      if (!defender || defender.isEliminated || (defender.id || defender.playerId) === playerId) {
        throw new StateTransitionError(`Invalid defending player '${defendingPlayerId}': must be an active alive opponent`);
      }

      let card = null;
      if (player.battlefield?.creatures) {
        card = player.battlefield.creatures.find(c => c && (c.instanceId === creatureId || c.id === creatureId));
      }
      if (!card && Array.isArray(player.battlefield)) {
        card = player.battlefield.find(c => c && (c.instanceId === creatureId || c.id === creatureId));
      }
      if (!card) {
        throw new StateTransitionError(`Creature '${creatureId}' not found on active player's battlefield`);
      }

      if (card.isTapped) {
        throw new StateTransitionError(`Creature '${card.name || creatureId}' is already tapped`);
      }

      // CR 508.1a/702.10: eligibility is evaluated exclusively through the pure predicate
      // (raw card first, then Layer-evaluated card so granted Haste/Defender are honoured).
      const eligibilityState = { activePlayerId: playerId };
      const layeredCard = this.abilityEngine ? this.abilityEngine.evaluatePermanentLayers(card, this) : card;
      const isEligible = canDeclareAsAttacker(card, eligibilityState) ||
        (layeredCard && canDeclareAsAttacker({ ...card, ...layeredCard, isTapped: card.isTapped, controllerId: card.controllerId, ownerId: card.ownerId }, eligibilityState));
      if (!isEligible) {
        const reasonCheck = this.canCreatureTapOrAttack(card);
        throw new StateTransitionError(
          (!reasonCheck.canAct && reasonCheck.reason) || `Creature '${card.name || creatureId}' cannot attack (summoning sickness / not eligible)`
        );
      }

      const hasDefender = this._hasKeyword(card, 'defender') || /defender/i.test(card.typeLine || '');
      if (hasDefender) {
        throw new StateTransitionError(`Creature '${card.name || creatureId}' has Defender and cannot attack`);
      }

      const hasVigilance = this._hasKeyword(card, 'vigilance');
      if (hasVigilance) {
        card.isTapped = false;
      } else {
        card.isTapped = true;
      }

      card.isAttacking = true;
      card.defendingPlayerId = defendingPlayerId;
      card.controllerId = card.controllerId || playerId;
      declaredAttackers.push(card);
    }

    this.combatState = {
      attackers: declaredAttackers,
      blockers: []
    };

    if (this.priorityMachine) {
      this.priorityMachine.priorityPlayerId = playerId;
      this.priorityMachine.consecutivePassCount = 0;
    }

    this.recordTrace('COMBAT_TRACE', 'DECLARE_ATTACKERS', {
      playerId,
      attackerIds: declaredAttackers.map(a => a.instanceId || a.id),
      attackerNames: declaredAttackers.map(a => a.name),
      attackersDetails: declaredAttackers.map(a => ({
        id: a.instanceId || a.id,
        name: a.name,
        power: a.power,
        toughness: a.toughness,
        defendingPlayerId: a.defendingPlayerId
      })),
      defendingPlayerId: declaredAttackers[0]?.defendingPlayerId || null
    });

    this.emit('ATTACKERS_DECLARED', { playerId, attackers: declaredAttackers });
    for (const attacker of declaredAttackers) {
      this._fireAttackTriggers(attacker, playerId);
    }
    return { attackers: declaredAttackers };
  }

  /**
   * Resolves "whenever this creature attacks" triggers (CR 508.2a / CR 603.2).
   * Goblin Guide: defending player reveals the top card of their library; if it is a land it goes to their hand.
   *
   * @param {Object} attacker
   * @param {string} controllerId
   * @returns {Object|null}
   * @private
   */
  _fireAttackTriggers(attacker, controllerId) {
    if (!attacker) return null;
    const player = this.getPlayer(controllerId);
    if (player?.resources?.attackDrawUntilEOT) {
      this.drawCard(controllerId, 1);
      this.recordTrace('TRIGGER_TRACE', 'ATTACK_DRAW_TRIGGER', {
        playerId: controllerId,
        attackerId: attacker.instanceId || attacker.id,
        attackerName: attacker.name
      });
    }
    if (!/goblin guide/i.test(attacker.name || '')) return null;
    const defender = this.getPlayer(attacker.defendingPlayerId);
    if (!defender || !Array.isArray(defender.library) || defender.library.length === 0) return null;

    const top = defender.library[0];
    const isLand = /land/i.test(top?.typeLine || top?.type || '');
    if (isLand) {
      defender.library.shift();
      if (defender.zones?.library) defender.zones.library = [...defender.library];
      defender.hand = defender.hand || [];
      defender.hand.push(top);
      if (defender.zones) defender.zones.hand = [...defender.hand];
    }
    const result = {
      sourceId: attacker.instanceId || attacker.id,
      sourceName: attacker.name,
      controllerId,
      defendingPlayerId: attacker.defendingPlayerId,
      revealedCard: top,
      movedToHand: isLand
    };
    this.recordTrace('TRIGGER_TRACE', 'TRIGGER_QUEUED', {
      sourceId: attacker.instanceId || attacker.id,
      sourceName: attacker.name,
      controllerId,
      triggerCondition: 'DECLARE_ATTACKERS',
      revealedCard: top?.name,
      movedToHand: isLand
    });
    this.recordTrace('TRIGGER_TRACE', 'GOBLIN_GUIDE_ATTACK_TRIGGER', {
      attackerId: attacker.instanceId || attacker.id,
      attackerName: attacker.name,
      defenderId: attacker.defendingPlayerId,
      revealedCardName: top?.name || null,
      isLand,
      putIntoHand: isLand
    });
    this.emit('ATTACK_TRIGGER_RESOLVED', result);
    this.emit('GOBLIN_GUIDE_ATTACK_TRIGGER', {
      attacker,
      defender,
      revealedCard: top,
      isLand,
      putIntoHand: isLand
    });
    return result;
  }

  /**
   * Declares blocking assignments for defending player (CR 509).
   * 
   * @param {string} playerId
   * @param {Array<{ blockerId: string, attackerId: string }>} assignments
   * @returns {{ assignments: Array<Object> }}
   */
  declareBlockers(playerId, assignments = []) {
    const player = this.getPlayer(playerId);
    const blockerAssignments = [];

    if (!assignments || assignments.length === 0) {
      this.combatState.blockers = [];
      this.combatState.blockersDeclared = true;
      if (this.priorityMachine) {
        this.priorityMachine.priorityPlayerId = this.activePlayerId;
        this.priorityMachine.consecutivePassCount = 0;
      }
      this.recordTrace('COMBAT_TRACE', 'DECLARE_BLOCKERS', {
        playerId,
        blockerAssignments: []
      });
      this.emit('BLOCKERS_DECLARED', { playerId, assignments: [] });
      return { assignments: [] };
    }

    // CR 702.110 Menace: an attacker with Menace can't be blocked except by two or more creatures.
    // Validated before any blocker state is mutated so a rejected declaration leaves no residue.
    const blockersPerAttacker = new Map();
    for (const item of assignments) {
      if (item && typeof item === 'object') {
        const aId = item.attackerId || item.targetAttackerId;
        if (aId) blockersPerAttacker.set(aId, (blockersPerAttacker.get(aId) || 0) + 1);
      }
    }
    for (const [aId, count] of blockersPerAttacker.entries()) {
      const menaceAttacker = (this.combatState?.attackers || []).find(a => a && (a.instanceId === aId || a.id === aId));
      if (menaceAttacker && count < 2 && this._hasKeyword(menaceAttacker, 'menace')) {
        throw new StateTransitionError(`Attacker '${menaceAttacker.name || aId}' has Menace and must be blocked by two or more creatures`);
      }
    }

    for (const item of assignments) {
      const blockerId = typeof item === 'string' ? item : (item.blockerId || item.id || item.instanceId);
      const attackerId = typeof item === 'object' ? (item.attackerId || item.targetAttackerId) : null;

      let blocker = null;
      if (player.battlefield?.creatures) {
        blocker = player.battlefield.creatures.find(c => c && (c.instanceId === blockerId || c.id === blockerId));
      }
      if (!blocker && Array.isArray(player.battlefield)) {
        blocker = player.battlefield.find(c => c && (c.instanceId === blockerId || c.id === blockerId));
      }
      if (!blocker) {
        throw new StateTransitionError(`Blocker '${blockerId}' not found on player's battlefield`);
      }

      if (blocker.isTapped) {
        throw new StateTransitionError(`Blocker '${blocker.name || blockerId}' is already tapped`);
      }

      const attacker = (this.combatState?.attackers || []).find(a => a && (a.instanceId === attackerId || a.id === attackerId));
      if (!attacker) {
        throw new StateTransitionError(`Attacking creature '${attackerId}' not found in declared attackers`);
      }

      if (attacker.defendingPlayerId && attacker.defendingPlayerId !== playerId) {
        throw new StateTransitionError(`Player '${playerId}' is not the defending player for attacker '${attacker.name || attackerId}'`);
      }

      const blockCheck = CombatDamageEngine.canCreatureBlock(blocker, attacker, this);
      if (!blockCheck.canBlock) {
        if (blockCheck.reason === 'UNBLOCKABLE') {
          throw new StateTransitionError(`Attacker '${attacker.name || attackerId}' is unblockable and cannot be blocked`);
        }
        if (blockCheck.reason === 'FLYING_REQUIRES_FLYING_OR_REACH') {
          throw new StateTransitionError(`Creature '${blocker.name || blockerId}' without Flying or Reach cannot block an attacker with Flying`);
        }
        throw new StateTransitionError(`Creature cannot block: ${blockCheck.reason}`);
      }

      blocker.isBlocking = true;
      blocker.blockingTargetId = attacker.instanceId || attacker.id;
      blockerAssignments.push({
        blocker,
        blockerId: blocker.instanceId || blocker.id,
        attackerId: attacker.instanceId || attacker.id
      });
    }

    this.combatState.blockers = [...(this.combatState.blockers || []), ...blockerAssignments];
    this.combatState.blockersDeclared = true;

    if (this.priorityMachine) {
      this.priorityMachine.priorityPlayerId = this.activePlayerId;
      this.priorityMachine.consecutivePassCount = 0;
    }

    this.recordTrace('COMBAT_TRACE', 'DECLARE_BLOCKERS', {
      playerId,
      blockerAssignments: blockerAssignments.map(b => ({ blockerId: b.blockerId, attackerId: b.attackerId })),
      blockersDetails: blockerAssignments.map(b => {
        const atk = this.combatState?.attackers?.find(a => (a.instanceId || a.id) === b.attackerId);
        return {
          blockerId: b.blockerId,
          blockerName: b.blocker?.name,
          blockerPT: `${b.blocker?.power ?? 0}/${b.blocker?.toughness ?? 0}`,
          attackerId: b.attackerId,
          attackerName: atk?.name || null,
          attackerPT: atk ? `${atk.power ?? 0}/${atk.toughness ?? 0}` : null
        };
      })
    });

    this.emit('BLOCKERS_DECLARED', { playerId, assignments });
    return { assignments };
  }

  /**
   * Resolves combat damage allocation per MTG CR 510.
   * 
   * @returns {{ resolved: boolean }}
   */
  resolveCombatDamage() {
    const attackers = this.combatState?.attackers || [];

    for (const attacker of attackers) {
      // Verify attacker is still on battlefield
      let isAttackerAlive = false;
      for (const p of Object.values(this.players || {})) {
        const creatures = p.battlefield?.creatures || (Array.isArray(p.battlefield) ? p.battlefield : []);
        if (creatures.some(c => c && (c.instanceId === attacker.instanceId || c.id === attacker.id))) {
          isAttackerAlive = true;
          break;
        }
      }
      if (!isAttackerAlive) continue;

      const evalAttacker = this.abilityEngine ? this.abilityEngine.evaluatePermanentLayers(attacker, this) : attacker;
      const effectivePower = evalAttacker?.effectivePower ?? Number(evalAttacker?.power) ?? Number(attacker.power) ?? 0;
      const attackerKeywords = {
        ...(attacker.keywords || {}),
        ...(evalAttacker.keywords || {})
      };
      if (this._hasKeyword(attacker, 'lifelink')) attackerKeywords.lifelink = true;
      if (this._hasKeyword(attacker, 'infect')) attackerKeywords.infect = true;
      if (this._hasKeyword(attacker, 'deathtouch')) attackerKeywords.deathtouch = true;
      if (this._hasKeyword(attacker, 'trample')) attackerKeywords.trample = true;

      // Find blockers assigned to this attacker
      const assigned = (this.combatState.blockers || []).filter(b =>
        b.attackerId === attacker.instanceId || b.attackerId === attacker.id || b.blockingTargetId === attacker.instanceId
      );

      if (assigned.length === 0) {
        // Unblocked -> All damage to defending player
        const defPlayer = this.players[attacker.defendingPlayerId];
        const lifeBefore = defPlayer?.resources?.life ?? 20;
        CombatDamageEngine.dealDamage({
          sourceId: attacker.instanceId || attacker.id,
          sourceName: attacker.name,
          sourceControllerId: attacker.controllerId || this.activePlayerId,
          targetId: attacker.defendingPlayerId,
          targetType: 'PLAYER',
          amount: effectivePower,
          isCombat: true,
          keywords: attackerKeywords
        }, this);
        const lifeAfter = defPlayer?.resources?.life ?? lifeBefore;
        this.recordTrace('COMBAT_TRACE', 'COMBAT_DAMAGE_UNBLOCKED', {
          attackerId: attacker.instanceId || attacker.id,
          attackerName: attacker.name,
          attackerPower: effectivePower,
          blocked: false,
          defendingPlayerId: attacker.defendingPlayerId,
          lifeBefore,
          lifeAfter
        });
      } else {
        // Find alive blockers still on battlefield
        const defPlayer = this.players[attacker.defendingPlayerId];
        const lifeBefore = defPlayer?.resources?.life ?? 20;
        const aliveBlockers = assigned.map(b => b.blocker || b).filter(b => {
          for (const p of Object.values(this.players || {})) {
            const creatures = p.battlefield?.creatures || (Array.isArray(p.battlefield) ? p.battlefield : []);
            if (creatures.some(c => c && (c.instanceId === b.instanceId || c.id === b.id))) return true;
          }
          return false;
        });

        if (aliveBlockers.length === 0) {
          // Blockers were assigned but destroyed before damage step
          if (attackerKeywords.trample && effectivePower > 0) {
            CombatDamageEngine.dealDamage({
              sourceId: attacker.instanceId || attacker.id,
              sourceName: attacker.name,
              sourceControllerId: attacker.controllerId || this.activePlayerId,
              targetId: attacker.defendingPlayerId,
              targetType: 'PLAYER',
              amount: effectivePower,
              isCombat: true,
              keywords: attackerKeywords
            }, this);
          }
        } else {
          const dist = CombatDamageEngine.calculateAttackerDamageDistribution(attacker, aliveBlockers, effectivePower, this);
          for (const assign of dist.blockerAssignments) {
            if (assign.damage > 0) {
              CombatDamageEngine.dealDamage({
                sourceId: attacker.instanceId || attacker.id,
                sourceName: attacker.name,
                sourceControllerId: attacker.controllerId || this.activePlayerId,
                targetId: assign.blockerId,
                targetType: 'CREATURE',
                amount: assign.damage,
                isCombat: true,
                keywords: attackerKeywords
              }, this);
            }
          }
          if (dist.playerTrampleDamage > 0) {
            CombatDamageEngine.dealDamage({
              sourceId: attacker.instanceId || attacker.id,
              sourceName: attacker.name,
              sourceControllerId: attacker.controllerId || this.activePlayerId,
              targetId: attacker.defendingPlayerId,
              targetType: 'PLAYER',
              amount: dist.playerTrampleDamage,
              isCombat: true,
              keywords: attackerKeywords
            }, this);
          }

          // Each alive blocker deals its effective power back to the attacker
          for (const blocker of aliveBlockers) {
            const evalBlocker = this.abilityEngine ? this.abilityEngine.evaluatePermanentLayers(blocker, this) : blocker;
            const blockerPower = evalBlocker?.effectivePower ?? Number(evalBlocker?.power) ?? Number(blocker.power) ?? 0;
            const blockerKeywords = {
              ...(blocker.keywords || {}),
              ...(evalBlocker.keywords || {})
            };
            if (this._hasKeyword(blocker, 'lifelink')) blockerKeywords.lifelink = true;
            if (this._hasKeyword(blocker, 'infect')) blockerKeywords.infect = true;
            if (this._hasKeyword(blocker, 'deathtouch')) blockerKeywords.deathtouch = true;

            if (blockerPower > 0) {
              CombatDamageEngine.dealDamage({
                sourceId: blocker.instanceId || blocker.id,
                sourceName: blocker.name,
                sourceControllerId: blocker.controllerId || attacker.defendingPlayerId,
                targetId: attacker.instanceId || attacker.id,
                targetType: 'CREATURE',
                amount: blockerPower,
                isCombat: true,
                keywords: blockerKeywords
              }, this);
            }
          }
        }
        const lifeAfter = defPlayer?.resources?.life ?? lifeBefore;
        this.recordTrace('COMBAT_TRACE', 'COMBAT_DAMAGE_BLOCKED', {
          attackerId: attacker.instanceId || attacker.id,
          attackerName: attacker.name,
          attackerPower: effectivePower,
          blocked: true,
          blockerIds: aliveBlockers.map(b => b.instanceId || b.id),
          defendingPlayerId: attacker.defendingPlayerId,
          lifeBefore,
          lifeAfter
        });
      }
    }

    this.runSBACheck();
    this.emit('COMBAT_DAMAGE_RESOLVED', {
      attackers: this.combatState?.attackers || [],
      blockers: this.combatState?.blockers || []
    });
    return { resolved: true };
  }

  /**
   * Cleans up combat state and creature combat flags per MTG CR 511.
   */
  endCombat() {
    for (const player of Object.values(this.players || {})) {
      const permanents = [];
      if (player.battlefield) {
        if (Array.isArray(player.battlefield)) {
          permanents.push(...player.battlefield);
        } else {
          for (const list of Object.values(player.battlefield)) {
            if (Array.isArray(list)) permanents.push(...list);
          }
        }
      }
      if (Array.isArray(player.zones?.battlefield)) {
        permanents.push(...player.zones.battlefield);
      }
      for (const card of permanents) {
        if (card) {
          card.isAttacking = false;
          card.isBlocking = false;
          card.defendingPlayerId = null;
          card.blockingTargetId = null;
          delete card.defendingPlayerId;
          delete card.blockingTargetId;
        }
      }
    }
    this.combatState = { attackers: [], blockers: [] };
    this.emit('COMBAT_ENDED');
  }

  _handleEnterWithoutCasting(payload) {
    const { playerId, instanceId, fromZone = 'library', subzone = null } = payload;
    const player = this.getPlayer(playerId);
    const card = ZoneTransitionMatrix.enterWithoutCasting(player, instanceId, fromZone, subzone);
    this._onPermanentEnteredBattlefield(card, playerId);
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
    this._onPermanentEnteredBattlefield(card, playerId);
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
    this.abilityEngine?.unregisterEffectsFromSource(instanceId);
    const card = ZoneTransitionMatrix.flicker(player, instanceId);
    this._onPermanentEnteredBattlefield(card, playerId);
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

  /**
   * Evaluates if a creature can legally tap or attack per MTG CR 302.6 & CR 702.10.
   * Checks summoning sickness and real Haste / Prisa (native or granted via Layer 6).
   * 
   * @param {Object} card
   * @returns {{ canAct: boolean, hasHaste?: boolean, reason?: string }}
   */
  canCreatureTapOrAttack(card) {
    if (!card) {
      const res = { canAct: false, reason: 'NO_CARD' };
      res.valueOf = () => false;
      return res;
    }

    const isSick = Boolean(card.hasSummoningSickness || card.isSummoningSick || card.summoningSickness);
    if (!isSick) {
      const res = { canAct: true };
      res.valueOf = () => true;
      return res;
    }

    // Creature has summoning sickness -> check for Haste / Prisa (evaluated via Layer 6 if engine present)
    const evalCard = this.abilityEngine
      ? this.abilityEngine.evaluatePermanentLayers(card, this)
      : card;

    const hasHaste = Boolean(
      evalCard?.keywords?.haste ||
      evalCard?.keywords?.Haste ||
      evalCard?.hasHaste ||
      card?.keywords?.haste ||
      card?.keywords?.Haste ||
      card?.hasHaste ||
      /haste|prisa/i.test(evalCard?.oracleText || evalCard?.text || card?.oracleText || card?.text || '') ||
      (Array.isArray(evalCard?.grantedAbilities) && evalCard.grantedAbilities.some(a =>
        typeof a === 'string' ? /haste|prisa/i.test(a) : /haste|prisa/i.test(a?.name || a?.text || '')
      )) ||
      (Array.isArray(card?.grantedAbilities) && card.grantedAbilities.some(a =>
        typeof a === 'string' ? /haste|prisa/i.test(a) : /haste|prisa/i.test(a?.name || a?.text || '')
      ))
    );

    if (hasHaste) {
      const res = { canAct: true, hasHaste: true };
      res.valueOf = () => true;
      return res;
    }

    const res = { canAct: false, reason: 'SUMMONING_SICKNESS' };
    res.valueOf = () => false;
    return res;
  }

  /**
   * Validates priority holding and MTG speed restrictions (Instant vs Sorcery timing).
   * CR 117.1a, CR 305.1, CR 601.2
   * 
   * @param {string} playerId
   * @param {Object} card
   * @param {PriorityStateMachine|Object} [priorityState=this.priorityMachine]
   * @returns {{ allowed: boolean, reason?: string, message?: string }}
   */
  canPlayerCastOrPlay(playerId, card, priorityState = this.priorityMachine) {
    if (!card) {
      const res = { allowed: false, reason: 'INVALID_CARD', message: 'No card specified.' };
      res.valueOf = () => false;
      return res;
    }

    // a) Priority Rule
    if (priorityState && priorityState.priorityPlayerId && priorityState.priorityPlayerId !== playerId) {
      const res = {
        allowed: false,
        reason: 'NO_PRIORITY',
        message: `Player '${playerId}' does not hold priority.`
      };
      res.valueOf = () => false;
      return res;
    }

    if (!priorityState) {
      const res = { allowed: true };
      res.valueOf = () => true;
      return res;
    }

    const typeLine = card.typeLine || card.type || '';
    const isLand = /land/i.test(typeLine);
    const activePlayerId = priorityState.activePlayerId;
    const stackLength = priorityState.stack ? priorityState.stack.length : (this.stack?.length || 0);
    const currentPhase = (priorityState.currentPhaseStep || '').toUpperCase();
    const isMain = currentPhase.includes('MAIN') || currentPhase === 'PRECOMBAT_MAIN' || currentPhase === 'POSTCOMBAT_MAIN';

    // b) Type & Speed Rules
    // Lands: Never played at instant speed. Only active player during main phase with empty stack.
    if (isLand) {
      if (playerId !== activePlayerId || stackLength !== 0 || !isMain) {
        const res = {
          allowed: false,
          reason: 'SORCERY_SPEED_RESTRICTION',
          message: 'Lands may only be played at sorcery speed during your main phase with an empty stack.'
        };
        res.valueOf = () => false;
        return res;
      }
      const res = { allowed: true };
      res.valueOf = () => true;
      return res;
    }

    // Instant or Flash
    const isInstant = /instant/i.test(typeLine);
    const evalCard = this.abilityEngine
      ? this.abilityEngine.evaluatePermanentLayers(card, this)
      : card;
    const hasFlash = Boolean(
      /flash/i.test(typeLine) ||
      evalCard?.keywords?.flash ||
      evalCard?.keywords?.Flash ||
      evalCard?.hasFlash ||
      card?.keywords?.flash ||
      card?.keywords?.Flash ||
      card?.hasFlash ||
      /flash/i.test(evalCard?.oracleText || evalCard?.text || card?.oracleText || card?.text || '') ||
      (Array.isArray(evalCard?.grantedAbilities) && evalCard.grantedAbilities.some(a =>
        typeof a === 'string' ? /flash/i.test(a) : /flash/i.test(a?.name || a?.text || '')
      )) ||
      (Array.isArray(card?.grantedAbilities) && card.grantedAbilities.some(a =>
        typeof a === 'string' ? /flash/i.test(a) : /flash/i.test(a?.name || a?.text || '')
      ))
    );

    if (isInstant || hasFlash) {
      if (priorityState.priorityPlayerId && priorityState.priorityPlayerId !== playerId) {
        const res = {
          allowed: false,
          reason: 'NO_PRIORITY',
          message: `Player '${playerId}' does not hold priority.`
        };
        res.valueOf = () => false;
        return res;
      }
      const res = { allowed: true };
      res.valueOf = () => true;
      return res;
    }

    // Sorcery speed spells (Sorcery, Creature without Flash, Artifact without Flash, etc.)
    if (playerId !== activePlayerId || stackLength !== 0 || !isMain) {
      const res = {
        allowed: false,
        reason: 'SORCERY_SPEED_RESTRICTION',
        message: 'Sorcery speed spells require an empty stack during your main phase.'
      };
      res.valueOf = () => false;
      return res;
    }

    const res = { allowed: true };
    res.valueOf = () => true;
    return res;
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
    const baseLimit = player.maxLandsPerTurn ?? player.landsPerTurnLimit ?? player.resources?.maxLandsPerTurn ?? 1;
    const extraLands = player.resources?.additionalLandsAllowed || 0;
    const limit = Math.max(baseLimit, 1 + extraLands);
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
    if (Array.isArray(player.zones?.battlefield)) {
      for (const zc of player.zones.battlefield) {
        if (zc && (zc === land || (land.instanceId && zc.instanceId === land.instanceId))) {
          zc.isTapped = true;
        }
      }
    }

    player.resources.manaPool = player.resources.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    const manaPoolBefore = { ...player.resources.manaPool };
    player.resources.manaPool[color] = (player.resources.manaPool[color] || 0) + 1;

    const manaAdded = { [color]: 1 };

    this.recordTrace('MANA_TRACE', 'MANUAL_LAND_TAP', {
      playerId,
      instanceId: land.instanceId || instanceId,
      landName: land.name,
      manaAdded,
      manaPoolBefore,
      manaPoolAfter: { ...player.resources.manaPool }
    });

    this.emit('PERMANENT_TAPPED', { playerId, instanceId: land.instanceId || instanceId, card: land });
    this.emit('LAND_TAPPED', { playerId, instanceId: land.instanceId || instanceId, card: land, manaAdded });
    this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });

    return { card: land, manaAdded, color };
  }

  /**
   * Helper to record a structured process trace entry.
   * @param {string} category
   * @param {string} action
   * @param {Object} [payload={}]
   */
  recordTrace(category, action, payload = {}) {
    if (!this.traceLogger || typeof this.traceLogger.record !== 'function') return null;
    const psm = this._priorityMachine;
    const activePid = psm?.activePlayerId || this._activePlayerId;
    const oppPid = Object.keys(this.players || {}).find(id => id !== activePid && !this.players[id]?.isEliminated) || null;
    return this.traceLogger.record({
      category,
      action,
      stateContext: {
        turn: psm?.turnNumber ?? this._turnNumber ?? 1,
        round: psm?.roundNumber ?? this._roundNumber ?? 1,
        phase: psm?.getOverarchingPhase?.() ?? 'MAIN',
        step: psm?.currentPhaseStep ?? 'PRECOMBAT_MAIN',
        activePlayerId: activePid,
        priorityPlayerId: psm?.priorityPlayerId ?? activePid,
        defendingPlayerId: this.combatState?.defendingPlayerId || oppPid
      },
      payload
    });
  }

  /**
   * Helper to determine all mana colors a land can produce (ordered by preference).
   * Single-color basic lands return 1 color (e.g. ['R']); dual/shocklands return 2 (e.g. ['U', 'R']).
   *
   * @param {Object} land
   * @returns {string[]}
   */
  _getLandManaProfile(land) {
    if (!land) return ['C'];
    const name = String(land.name || '').toLowerCase();
    const typeLine = String(land.typeLine || land.type || '').toLowerCase();
    const oracle = String(land.oracleText || land.text || '').toLowerCase();

    // Dual / Shocklands / Fastlands
    if (name.includes('steam vents') || name.includes('spirebluff') || name.includes('scalding tarn') || (typeLine.includes('island') && typeLine.includes('mountain'))) return ['R', 'U'];
    if (name.includes('sacred foundry') || name.includes('inspiring vantage') || (typeLine.includes('mountain') && typeLine.includes('plains'))) return ['R', 'W'];
    if (name.includes('stomping ground') || name.includes('copperline') || (typeLine.includes('mountain') && typeLine.includes('forest'))) return ['R', 'G'];
    if (name.includes('blood crypt') || name.includes('blackcleave') || (typeLine.includes('swamp') && typeLine.includes('mountain'))) return ['B', 'R'];
    if (name.includes('watery grave') || name.includes('darkslick') || (typeLine.includes('island') && typeLine.includes('swamp'))) return ['U', 'B'];
    if (name.includes('overgrown tomb') || name.includes('twilight mire') || name.includes('blooming marsh') || (typeLine.includes('swamp') && typeLine.includes('forest'))) return ['B', 'G'];
    if (name.includes('breeding pool') || name.includes('botanical') || (typeLine.includes('forest') && typeLine.includes('island'))) return ['G', 'U'];
    if (name.includes('temple garden') || name.includes('razorverge') || (typeLine.includes('forest') && typeLine.includes('plains'))) return ['G', 'W'];
    if (name.includes('hallowed fountain') || name.includes('seachrome') || (typeLine.includes('plains') && typeLine.includes('island'))) return ['W', 'U'];
    if (name.includes('godless shrine') || name.includes('concealed') || (typeLine.includes('plains') && typeLine.includes('swamp'))) return ['W', 'B'];

    // Basic lands
    if (name.includes('mountain') || typeLine.includes('mountain')) return ['R'];
    if (name.includes('island') || typeLine.includes('island')) return ['U'];
    if (name.includes('swamp') || typeLine.includes('swamp')) return ['B'];
    if (name.includes('plains') || typeLine.includes('plains')) return ['W'];
    if (name.includes('forest') || typeLine.includes('forest')) return ['G'];
    if (name.includes('wastes') || name.includes("urza's")) return ['C'];

    // Parse oracle "{T}: Add {X} or {Y}"
    const addMatches = oracle.match(/\{([wubrgc])\}/gi);
    if (addMatches && addMatches.length > 0) {
      const cols = [...new Set(addMatches.map(m => m.replace(/[{}]/g, '').toUpperCase()))];
      if (cols.length > 0) return cols;
    }

    if (Array.isArray(land.colors) && land.colors.length > 0) return [...land.colors];
    if (Array.isArray(land.colorIdentity) && land.colorIdentity.length > 0) return [...land.colorIdentity];
    return ['C'];
  }

  /**
   * Helper to determine primary mana color produced by a land.
   * 
   * @param {Object} land
   * @returns {string}
   */
  _resolveLandManaColor(land) {
    return this._getLandManaProfile(land)[0] || 'C';
  }

  /**
   * MTG Arena Exact-Cost Auto-Tap Engine (INV-MANA-1).
   * Parses mana cost string, deducts floating mana from `player.resources.manaPool` FIRST,
   * taps the exact minimum number of untapped lands (preferring single-color basic lands
   * over dual/shocklands), and performs an atomic rollback if total mana is insufficient.
   * 
   * @param {string} playerId
   * @param {string} manaCostString
   * @returns {{ success: boolean, tappedLands: Array, tappedLandIds: string[], manaPaid: Record<string, number>, remainingPool: Record<string, number> }}
   */
  autoTapForMana(playerId, manaCostString) {
    const player = this.getPlayer(playerId);
    player.resources.manaPool = player.resources.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

    const manaPoolBefore = { ...player.resources.manaPool };
    const bLands = Array.isArray(player.battlefield?.lands) ? player.battlefield.lands : [];
    const zLands = Array.isArray(player.zones?.battlefield)
      ? player.zones.battlefield.filter(c => c && ((c.typeLine || c.type || '').toLowerCase().includes('land') || c.subzone === 'lands'))
      : [];

    // Reconcile any lands present in `player.zones.battlefield` into `player.battlefield.lands` so we have a single source of truth
    if (player.battlefield && Array.isArray(player.battlefield.lands)) {
      for (const zl of zLands) {
        if (!player.battlefield.lands.some(bl => bl && (bl === zl || (bl.instanceId && bl.instanceId === zl.instanceId)))) {
          player.battlefield.lands.push(zl);
        }
      }
    }

    const allLands = Array.isArray(player.battlefield?.lands) && player.battlefield.lands.length > 0
      ? player.battlefield.lands
      : zLands;
    const untappedLands = allLands.filter(l => l && !l.isTapped);
    const untappedLandsBefore = untappedLands.map(l => ({ instanceId: l.instanceId, name: l.name }));

    const parsedCost = this._parseManaCostString(manaCostString);
    const pool = { ...player.resources.manaPool };

    // 1. Evaluate colored requirements vs floating mana pool FIRST
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

    // 2. Evaluate generic requirement vs remaining floating mana pool
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

    // If no deficit remains, floating mana covers the entire spell cost -> DO NOT tap any lands!
    if (Object.keys(coloredDeficits).length === 0 && genericDeficit <= 0) {
      player.resources.manaPool = pool;
      this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });
      this.recordTrace('MANA_TRACE', 'AUTO_TAP_SATISFIED_BY_POOL', {
        playerId,
        spellCost: manaCostString,
        manaPoolBefore,
        untappedLandsBefore,
        landsTappedByAutoTap: [],
        manaPoolAfter: { ...player.resources.manaPool }
      });
      return {
        success: true,
        tappedLands: [],
        tappedLandIds: [],
        manaPaid: manaDeducted,
        remainingPool: { ...player.resources.manaPool }
      };
    }

    // 3. Sort untapped lands so single-color basic lands (e.g. Mountain) are tapped BEFORE dual/shocklands (e.g. Steam Vents)
    const sortedUntapped = [...untappedLands].sort((a, b) => {
      const profA = this._getLandManaProfile(a);
      const profB = this._getLandManaProfile(b);
      return profA.length - profB.length;
    });

    const landsToTap = [];
    const simulatedTaps = new Set();

    // Satisfy colored deficits (exact count, break immediately when needed === 0)
    for (const [col, defCount] of Object.entries(coloredDeficits)) {
      let needed = defCount;
      for (const land of sortedUntapped) {
        if (needed <= 0) break;
        const landKey = land.instanceId || land.id || land;
        if (simulatedTaps.has(landKey)) continue;

        const profile = this._getLandManaProfile(land);
        if (profile.includes(col)) {
          landsToTap.push({ land, color: col });
          simulatedTaps.add(landKey);
          needed--;
        }
      }

      if (needed > 0) {
        // Atomic abort: do NOT tap any lands
        this.recordTrace('MANA_TRACE', 'AUTO_TAP_REJECTED_INSUFFICIENT_COLOR', {
          playerId,
          spellCost: manaCostString,
          missingColor: col,
          needed: defCount,
          available: defCount - needed,
          manaPoolBefore,
          untappedLandsBefore,
          landsTappedByAutoTap: [],
          manaPoolAfter: { ...player.resources.manaPool }
        });
        throw new InsufficientManaError(`Insufficient ${col} mana: needed ${defCount}, available ${defCount - needed}`);
      }
    }

    // Satisfy generic deficit with remaining untapped lands (exact count, break immediately when genNeeded === 0)
    let genNeeded = genericDeficit;
    for (const land of sortedUntapped) {
      if (genNeeded <= 0) break;
      const landKey = land.instanceId || land.id || land;
      if (simulatedTaps.has(landKey)) continue;

      const col = this._resolveLandManaColor(land);
      landsToTap.push({ land, color: col });
      simulatedTaps.add(landKey);
      genNeeded--;
    }

    if (genNeeded > 0) {
      // Atomic abort: do NOT tap any lands
      this.recordTrace('MANA_TRACE', 'AUTO_TAP_REJECTED_INSUFFICIENT_GENERIC', {
        playerId,
        spellCost: manaCostString,
        totalCmc: parsedCost.totalCmc,
        genericMissing: genNeeded,
        manaPoolBefore,
        untappedLandsBefore,
        landsTappedByAutoTap: [],
        manaPoolAfter: { ...player.resources.manaPool }
      });
      throw new InsufficientManaError(`Insufficient mana: needed ${parsedCost.totalCmc}, could not satisfy cost.`);
    }

    // Commit: tap ONLY the exact selected lands and sync both battlefield.lands and zones.battlefield
    for (const { land, color } of landsToTap) {
      land.isTapped = true;
      if (Array.isArray(player.zones?.battlefield)) {
        for (const zc of player.zones.battlefield) {
          if (zc && (zc === land || (land.instanceId && zc.instanceId === land.instanceId))) {
            zc.isTapped = true;
          }
        }
      }
      manaDeducted[color] = (manaDeducted[color] || 0) + 1;
      this.emit('PERMANENT_TAPPED', { playerId, instanceId: land.instanceId, card: land });
      this.emit('LAND_TAPPED', { playerId, instanceId: land.instanceId, card: land, manaAdded: { [color]: 1 } });
    }

    player.resources.manaPool = pool;
    this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });

    const tappedCards = landsToTap.map(item => item.land);
    this.recordTrace('MANA_TRACE', 'AUTO_TAP_COMMITTED', {
      playerId,
      spellCost: manaCostString,
      manaPoolBefore,
      untappedLandsBefore,
      landsTappedByAutoTap: tappedCards.map(l => ({ instanceId: l.instanceId, name: l.name })),
      manaPaid: manaDeducted,
      manaPoolAfter: { ...player.resources.manaPool }
    });

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
      if (!player) continue;
      player.landsPlayedThisTurn = 0;
      player.maxLandsPerTurn = 1;
      player.landsPerTurnLimit = 1;
      if (player.resources) {
        player.resources.landsPlayedThisTurn = 0;
        player.resources.additionalLandsAllowed = 0;
        player.resources.maxLandsPerTurn = 1;
        player.resources.attackDrawUntilEOT = false;
        player.resources.freeCastAllowed = false;
        player.resources.freeCast = false;
      }
    }
    return { playerId: playerId || this.activePlayerId, landsPlayedThisTurn: 0 };
  }

  playLand(playerIdOrPayload, instanceIdOrCard, options = {}) {
    if (typeof playerIdOrPayload === 'object' && playerIdOrPayload !== null) {
      return this.dispatch('PLAY_LAND', playerIdOrPayload);
    }
    const instanceId = typeof instanceIdOrCard === 'object' ? instanceIdOrCard.instanceId : instanceIdOrCard;
    const card = typeof instanceIdOrCard === 'object' ? instanceIdOrCard : undefined;
    const payShockCost = options.payShockCost ?? options.pay2Life;
    return this.dispatch('PLAY_LAND', {
      playerId: playerIdOrPayload,
      instanceId,
      card,
      ...(payShockCost !== undefined ? { payShockCost, pay2Life: payShockCost } : {})
    });
  }

  _isTargetLegal(target) {
    if (target === null || target === undefined) return false;

    // Check if target is explicitly a player object
    if (typeof target === 'object' && (target.playerId || target.type === 'PLAYER')) {
      const pid = target.playerId || target.id;
      const player = this.players[pid];
      return Boolean(player && !player.isEliminated);
    }

    const targetId = typeof target === 'string'
      ? target
      : (target.instanceId || target.id || target.targetId || target.card?.instanceId);
    if (!targetId) return false;

    const expectedZone = typeof target === 'object' ? (target.zone || target.expectedZone || null) : null;

    if (expectedZone === 'graveyard') {
      for (const p of Object.values(this.players || {})) {
        if ((p.graveyard || []).some(c => c && (c.instanceId === targetId || c.id === targetId))) {
          return true;
        }
      }
      return false;
    }

    if (expectedZone === 'stack') {
      return (this.stack || []).some(s => s && (s.instanceId === targetId || s.id === targetId || s.card?.instanceId === targetId));
    }

    // Default: Check battlefield across all players
    for (const p of Object.values(this.players || {})) {
      const bf = [
        ...(p.battlefield?.creatures || []),
        ...(p.battlefield?.lands || []),
        ...(p.battlefield?.noncreatures || []),
        ...(p.battlefield?.planeswalkers || [])
      ];
      if (bf.some(c => c && (c.instanceId === targetId || c.id === targetId))) {
        return true;
      }
    }

    // Check if targetId matches an active player
    const player = this.players[targetId];
    if (player && !player.isEliminated) {
      return true;
    }

    // Check if target is on stack (e.g. Counterspell targeting a spell on stack)
    if ((this.stack || []).some(s => s && (s.instanceId === targetId || s.id === targetId || s.card?.instanceId === targetId))) {
      return true;
    }

    return false;
  }

  _onPermanentEnteredBattlefield(card, controllerId) {
    if (!card || !this.abilityEngine) return;

    // a) Register static continuous effects (CR 604)
    const staticEffects = Array.isArray(card.staticEffects)
      ? card.staticEffects
      : (card.staticEffect ? [card.staticEffect] : []);

    for (let i = 0; i < staticEffects.length; i++) {
      const effect = staticEffects[i];
      if (effect) {
        this.abilityEngine.registerStaticEffect({
          ...effect,
          id: effect.id || `static_${card.instanceId}_${i}`,
          sourceId: card.instanceId
        });
      }
    }

    // b) Queue ETB triggered abilities (CR 603)
    if (card.onEnterBattlefield || card.etbTrigger) {
      this.abilityEngine.queueTrigger({
        sourceId: card.instanceId,
        controllerId,
        effect: card.onEnterBattlefield || card.etbTrigger,
        text: `${card.name || 'Permanent'} ETB Trigger`
      });
    }
  }

  handleStackResolution(resolvedItem) {
    if (!resolvedItem) return null;
    const originalCard = resolvedItem.card || resolvedItem;
    const controllerId = resolvedItem.controllerId || resolvedItem.sourcePlayerId || originalCard.controllerId || originalCard.ownerId || this.activePlayerId;
    const player = this.getPlayer(controllerId);

    const isNonCardTriggerOrAbility = Boolean(
      resolvedItem.type === 'PERK_UPKEEP_TRIGGER' ||
      resolvedItem.type === 'PERK_EFFECT_TRIGGER' ||
      resolvedItem.type === 'TRIGGERED_ABILITY' ||
      resolvedItem.type === 'ABILITY' ||
      resolvedItem.isTrigger ||
      resolvedItem.isEmblemTrigger ||
      originalCard?.type === 'PERK_UPKEEP_TRIGGER' ||
      originalCard?.type === 'PERK_EFFECT_TRIGGER' ||
      originalCard?.isTrigger ||
      originalCard?.isEmblemTrigger
    );

    const topItem = resolvedItem;
    this.recordTrace('STACK_TRACE', 'STACK_ITEM_RESOLVED', {
      itemId: topItem.id || topItem.instanceId || originalCard.instanceId,
      name: topItem.name || topItem.card?.name || originalCard.name || topItem.type,
      type: topItem.type || 'SPELL',
      controllerId: topItem.controllerId || topItem.ownerId || controllerId
    });

    // ── Idempotency guard ──────────────────────────────────────────────
    // Prevent duplicate zone placement when handleStackResolution is
    // invoked more than once for the same item (e.g. by both PSM.resolveTop
    // and a subscriber in app.js).
    //
    // Step 1: Try to remove the item from TSM's own stack.
    const stackIdx = this.stack.findIndex(c => c && (
      c === originalCard ||
      c === resolvedItem ||
      (originalCard.instanceId && c.instanceId === originalCard.instanceId) ||
      (resolvedItem.id && (c.id === resolvedItem.id || c.instanceId === resolvedItem.id)) ||
      (resolvedItem.instanceId && (c.instanceId === resolvedItem.instanceId || c.id === resolvedItem.instanceId))
    ));
    if (stackIdx !== -1) {
      this.stack.splice(stackIdx, 1);
    } else if (!isNonCardTriggerOrAbility) {
      // Step 2: Item was not on TSM's stack (it likely lived only on PSM's
      // stack and was already popped by resolveTop).  Guard against a
      // duplicate call by checking whether the card has already landed in
      // its destination zone.
      const allBattlefield = [
        ...(player.battlefield?.creatures || []),
        ...(player.battlefield?.lands || []),
        ...(player.battlefield?.noncreatures || []),
        ...(player.battlefield?.planeswalkers || [])
      ];
      const hasValidId = Boolean(originalCard.instanceId);
      const alreadyOnField = hasValidId && allBattlefield.some(c => c && (
        (c.instanceId && c.instanceId === originalCard.instanceId) ||
        (c.previousInstanceId && c.previousInstanceId === originalCard.instanceId)
      ));
      const alreadyInGY = hasValidId && (player.graveyard || []).some(c => c && (
        (c.instanceId && c.instanceId === originalCard.instanceId) ||
        (c.previousInstanceId && c.previousInstanceId === originalCard.instanceId)
      ));
      if (alreadyOnField || alreadyInGY) {
        // Already resolved — nothing to do.
        return null;
      }
    }

    TabletopStateManager.hydrateCardMechanics(originalCard);
    const typeLine = String(originalCard.typeLine || originalCard.type || '').toLowerCase();
    const isInstantOrSorcery = typeLine.includes('instant') || typeLine.includes('sorcery');
    const isAura = typeLine.includes('aura') || /aura/i.test(originalCard.subtype || '');
    const isTargetableSpell = isInstantOrSorcery || isAura;

    // ── CR 608.2b — Target Validation & Fizzle Rule ────────────────────
    const rawTargets = resolvedItem.targets || originalCard.targets || originalCard.annotations?.castTargets;
    const hasTargets = !isNonCardTriggerOrAbility && isTargetableSpell && Array.isArray(rawTargets) && rawTargets.length > 0;
    let legalTargets = [];

    if (hasTargets) {
      legalTargets = rawTargets.filter(t => this._isTargetLegal(t));
      if (legalTargets.length === 0) {
        // All targets are illegal: Spell Fizzles per CR 608.2b
        if (isTargetableSpell) {
          const cardToGrave = ZoneTransitionMatrix.createZoneChangedObject(originalCard, 'graveyard');
          player.graveyard.push(cardToGrave);
          if (player.zones?.graveyard) player.zones.graveyard.push(cardToGrave);
        }

        const logEntry = {
          sequenceId: ++this.sequenceCounter,
          actionType: 'SPELL_FIZZLED',
          rule: 'CR 608.2b',
          playerId: controllerId,
          card: originalCard,
          reason: 'ALL_TARGETS_ILLEGAL',
          timestamp: Date.now()
        };
        this.actionLog.push(logEntry);
        this._notifySubscribers(logEntry, { card: originalCard, fizzled: true, reason: 'ALL_TARGETS_ILLEGAL' });
        this.emit('SPELL_FIZZLED', logEntry);

        this.runSBACheck();
        return { card: originalCard, fizzled: true, reason: 'ALL_TARGETS_ILLEGAL' };
      }
    }

    // ── CR 608.2 — Effect Execution ─────────────────────────────────────
    const effect = resolvedItem.effect || originalCard.effect;
    if (typeof effect === 'function') {
      effect(this, resolvedItem);
    } else if (typeof resolvedItem.onResolve === 'function') {
      resolvedItem.onResolve(this, resolvedItem);
    } else if (effect && typeof effect === 'object') {
      const effectType = String(effect.type || effect.action || '').toUpperCase();
      const firstTarget = rawTargets && rawTargets[0];
      let defaultTargetId = effect.targetId || effect.instanceId || (typeof firstTarget === 'string' ? firstTarget : (firstTarget?.instanceId || firstTarget?.id || firstTarget?.targetId));

      switch (effectType) {
        case 'DEAL_DAMAGE': {
          const amount = Number(effect.amount ?? effect.damage ?? effect.value ?? 0);
          let oppPid = null;
          if (this.combatState?.defendingPlayerId && !this.players[this.combatState.defendingPlayerId]?.isEliminated) {
            oppPid = this.combatState.defendingPlayerId;
          } else {
            const playerList = Object.keys(this.players || {});
            oppPid = playerList.find(pid => pid !== controllerId && !this.players[pid]?.isEliminated)
              || this._priorityMachine?.players?.find(pid => pid !== controllerId && !this.players[pid]?.isEliminated);
          }

          if (!defaultTargetId && oppPid) {
            defaultTargetId = oppPid;
          }
          let targetsToApply = effect.targetId ? [effect.targetId] : (legalTargets && legalTargets.length > 0 ? legalTargets : (defaultTargetId ? [defaultTargetId] : []));
          if ((!targetsToApply || targetsToApply.length === 0 || !targetsToApply[0]) && oppPid) {
            targetsToApply = [oppPid];
          }

          for (const t of targetsToApply) {
            const tid = typeof t === 'string' ? t : (t?.instanceId || t?.id || t?.targetId || t?.playerId);
            const effectiveTargetId = tid || oppPid;
            if (!effectiveTargetId) continue;

            let targetPerm = null;
            for (const p of Object.values(this.players || {})) {
              const bf = [
                ...(p.battlefield?.creatures || []),
                ...(p.battlefield?.lands || []),
                ...(p.battlefield?.noncreatures || []),
                ...(p.battlefield?.planeswalkers || [])
              ];
              const found = bf.find(c => c && (c.instanceId === effectiveTargetId || c.id === effectiveTargetId));
              if (found) {
                targetPerm = found;
                break;
              }
            }

            if (targetPerm) {
              targetPerm.damageMarked = (targetPerm.damageMarked || 0) + amount;
            } else {
              const targetPlayer = this.players[effectiveTargetId] || (t?.playerId && this.players[t.playerId]) || (effect.playerId && this.players[effect.playerId]) || this.players[oppPid];
              if (targetPlayer) {
                const targetPid = targetPlayer.id || targetPlayer.playerId || effectiveTargetId;
                this.adjustLife(targetPid, { delta: -amount });
                this.emit('LIFE_LOST', { playerId: targetPid, amount, newLife: targetPlayer.resources?.life });
                this.emit('DAMAGE_DEALT', { sourceId: originalCard.instanceId, sourceControllerId: controllerId, targetId: targetPid, targetType: 'PLAYER', amount });

                const damageLog = {
                  sequenceId: ++this.sequenceCounter,
                  actionType: 'DAMAGE_DEALT',
                  playerId: targetPid,
                  payload: {
                    sourceId: originalCard.instanceId,
                    sourceControllerId: controllerId,
                    targetId: targetPid,
                    targetType: 'PLAYER',
                    amount,
                    newLife: targetPlayer.resources?.life
                  },
                  timestamp: Date.now()
                };
                this.actionLog.push(damageLog);
                this._notifySubscribers(damageLog, { targetId: targetPid, amount, newLife: targetPlayer.resources?.life });
              }
            }
          }
          break;
        }

        case 'DRAW_CARD': {
          const drawPid = effect.playerId || effect.targetPlayerId || (typeof defaultTargetId === 'string' && this.players[defaultTargetId] ? defaultTargetId : null) || controllerId;
          const drawCount = Number(effect.amount ?? effect.count ?? effect.value ?? 1);
          this.drawCard(drawPid, drawCount);
          break;
        }

        case 'DESTROY_TARGET': {
          const targetsToDestroy = effect.targetId ? [effect.targetId] : (legalTargets && legalTargets.length > 0 ? legalTargets : [defaultTargetId]);
          for (const t of targetsToDestroy) {
            const tid = typeof t === 'string' ? t : (t?.instanceId || t?.id || t?.targetId);
            if (!tid) continue;
            for (const [pid, p] of Object.entries(this.players || {})) {
              const found = ZoneModel.findCard(p, tid);
              if (found && found.zone === 'battlefield') {
                this.abilityEngine?.unregisterEffectsFromSource(tid);
                ZoneTransitionMatrix.moveCard(p, tid, 'battlefield', 'graveyard');
                this.emit('PERMANENT_DESTROYED', { playerId: pid, cardId: tid });
                break;
              }
            }
          }
          break;
        }

        case 'COUNTER_TARGET': {
          const targetsToCounter = effect.targetId ? [effect.targetId] : (legalTargets && legalTargets.length > 0 ? legalTargets : [defaultTargetId]);
          for (const t of targetsToCounter) {
            const tid = typeof t === 'string' ? t : (t?.instanceId || t?.id || t?.targetId);
            if (!tid) continue;
            const targetStackIdx = this.stack.findIndex(s => s && (s.instanceId === tid || s.id === tid || s.card?.instanceId === tid));
            if (targetStackIdx !== -1) {
              const [removedItem] = this.stack.splice(targetStackIdx, 1);
              const targetCard = removedItem.card || removedItem;
              const ownerId = targetCard.ownerId || targetCard.controllerId || removedItem.controllerId;
              const owner = this.players[ownerId] || this.getPlayer(this.activePlayerId);
              if (owner) {
                const gyCard = ZoneTransitionMatrix.createZoneChangedObject(targetCard, 'graveyard');
                owner.graveyard.push(gyCard);
                if (owner.zones?.graveyard) owner.zones.graveyard.push(gyCard);
                this.emit('SPELL_COUNTERED', { card: targetCard, ownerId });
              }
            }
          }
          break;
        }

        case 'MODIFY_LIFE': {
          const targetPid = effect.playerId || effect.targetPlayerId || (typeof defaultTargetId === 'string' && this.players[defaultTargetId] ? defaultTargetId : null) || controllerId;
          const targetPlayer = this.players[targetPid];
          if (targetPlayer) {
            targetPlayer.resources = targetPlayer.resources || {};
            if (effect.targetValue !== undefined || effect.target !== undefined) {
              targetPlayer.resources.life = Number(effect.targetValue ?? effect.target);
            } else if (effect.amount !== undefined || effect.delta !== undefined || effect.value !== undefined) {
              targetPlayer.resources.life = (targetPlayer.resources.life ?? 20) + Number(effect.amount ?? effect.delta ?? effect.value);
            }
          }
          break;
        }
      }
    }

    // ── Non-card triggers & abilities cease to exist upon resolving (CR 113.3b / CR 608.2) ──
    // Never move triggers or abilities to player.graveyard or battlefield.
    if (isNonCardTriggerOrAbility) {
      this._notifySubscribers({
        sequenceId: ++this.sequenceCounter,
        actionType: 'TRIGGER_RESOLVED',
        playerId: controllerId,
        payload: { item: resolvedItem },
        timestamp: Date.now()
      }, { item: resolvedItem });

      this.emit('STACK_RESOLVE', { item: resolvedItem, controllerId });
      this.emit('STACK_RESOLVED', { item: resolvedItem, controllerId });
      this.emit('TRIGGER_RESOLVED', { item: resolvedItem, controllerId });

      this.runSBACheck();
      return { item: resolvedItem, destinationZone: null, destinationSubzone: null };
    }

    // ── CR 400.7 — Zone-change identity reset ──────────────────────────
    // The card becomes a new game object when it changes zones.  Strip
    // counters, damage marks, granted abilities, and assign a fresh
    // instanceId so no stale state bleeds from the stack.
    const targetZone = isInstantOrSorcery ? 'graveyard' : 'battlefield';

    const card = ZoneTransitionMatrix.createZoneChangedObject(originalCard, targetZone);

    let destinationZone = targetZone;
    let destinationSubzone = null;

    if (typeLine.includes('creature')) {
      destinationSubzone = 'creatures';
      card.subzone = 'creatures';
      TabletopStateManager.hydrateCardMechanics(card);
      card.hasSummoningSickness = true;
      card.isSummoningSick = true;
      card.summoningSickness = true;
      card.isTapped = false;
      const hydratedPower = Number(card.power ?? originalCard.power);
      const hydratedToughness = Number(card.toughness ?? originalCard.toughness);
      card.power = Number.isFinite(hydratedPower) ? hydratedPower : 1;
      card.toughness = Number.isFinite(hydratedToughness) ? hydratedToughness : 1;
      player.battlefield.creatures.push(card);
    } else if (typeLine.includes('land')) {
      destinationSubzone = 'lands';
      card.subzone = 'lands';
      card.isTapped = false;
      player.battlefield.lands.push(card);
    } else if (typeLine.includes('planeswalker')) {
      destinationSubzone = 'planeswalkers';
      card.subzone = 'planeswalkers';
      card.isTapped = false;
      player.battlefield.planeswalkers.push(card);
    } else if (typeLine.includes('artifact') || typeLine.includes('enchantment') || typeLine.includes('battle')) {
      destinationSubzone = 'noncreatures';
      card.subzone = 'noncreatures';
      card.isTapped = false;
      player.battlefield.noncreatures.push(card);
    } else if (isInstantOrSorcery) {
      destinationZone = 'graveyard';
      card.subzone = null;
      player.graveyard.push(card);
    } else {
      if (card.isPermanent) {
        destinationSubzone = 'noncreatures';
        card.subzone = 'noncreatures';
        card.isTapped = false;
        player.battlefield.noncreatures.push(card);
      } else {
        destinationZone = 'graveyard';
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

    if (destinationZone === 'battlefield') {
      this._onPermanentEnteredBattlefield(card, controllerId);
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

    // ── CR 117.5 — State-Based Actions check after resolution ──────────
    this.runSBACheck();

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

    TabletopStateManager.hydrateCardMechanics(card);

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
    if (this._priorityMachine === priorityMachine && this._priorityMachineWired) return;
    this._priorityMachine = priorityMachine;
    this._priorityMachineWired = false;
    this._wirePriorityMachine();
  }

  set priorityMachine(priorityMachine) {
    if (this._priorityMachine === priorityMachine && this._priorityMachineWired) return;
    this._priorityMachine = priorityMachine;
    this._priorityMachineWired = false;
    this._wirePriorityMachine();
  }

  get priorityMachine() {
    return this._priorityMachine;
  }

  _wirePriorityMachine() {
    if (!this._priorityMachine || this._priorityMachineWired) return;
    this._priorityMachineWired = true;
    this._priorityMachine.tabletopState = this;

    if (this._priorityMachine.startingPlayerId && !this.startingPlayerId) {
      this.startingPlayerId = this._priorityMachine.startingPlayerId;
    } else if (this.startingPlayerId && !this._priorityMachine.startingPlayerId) {
      this._priorityMachine.startingPlayerId = this.startingPlayerId;
    }

    this._priorityMachine.on('PHASE_STEP_CHANGED', (data) => {
      this.handlePhaseStepChanged(data);
    });

    this._priorityMachine.on('UNTAP_STEP_ENTERED', (data) => {
      this.handleUntapStep(data.activePlayerId);
    });

    this._priorityMachine.on('UPKEEP_STEP_ENTERED', (data) => {
      this.handleUpkeepStep(data.activePlayerId, data.turnNumber, data.roundNumber || this.roundNumber);
    });

    this._priorityMachine.on('CLEANUP_STEP_ENTERED', (data) => {
      this.handleCleanupStep(data.activePlayerId);
    });
  }

  handleUntapStep(activePlayerId) {
    if (!activePlayerId) return;
    const player = this.getPlayer(activePlayerId);
    this.untapAll(activePlayerId);
    if (player) {
      for (const card of (player.battlefield?.creatures || [])) {
        card.hasSummoningSickness = false;
        card.isSummoningSick = false;
        card.summoningSickness = false;
      }
      player.landsPlayedThisTurn = 0;
      player.maxLandsPerTurn = 1;
      player.landsPerTurnLimit = 1;
      if (player.resources) {
        player.resources.landsPlayedThisTurn = 0;
        player.resources.additionalLandsAllowed = 0;
        player.resources.maxLandsPerTurn = 1;
        player.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      }
    }
    this.resetTurnQuotas(activePlayerId);
    this.emit('AUTO_UNTAP_RESOLVED', { activePlayerId });
  }

  handleUpkeepStep(activePlayerId, turnNumber, roundNumber) {
    this.emit('UPKEEP_PERK_PROMPT_READY', {
      activePlayerId,
      turnNumber: turnNumber || this.turnNumber,
      roundNumber: roundNumber || this.roundNumber
    });
  }

  handleCleanupStep(activePlayerId) {
    const count = StateBasedActionsEngine.purgeCleanupMarkedDamage(this);
    if (this.abilityEngine && Array.isArray(this.abilityEngine.staticEffects)) {
      this.abilityEngine.staticEffects = this.abilityEngine.staticEffects.filter(ef => ef.duration !== 'END_OF_TURN');
    }
    this.runSBACheck();
    this.emit('CLEANUP_DAMAGE_PURGED', { activePlayerId, purgedCount: count });
  }

  handlePhaseStepChanged(data = {}) {
    const { currentPhaseStep, activePlayerId } = data;

    this.recordTrace('PHASE_TRACE', 'PHASE_TRANSITION', {
      previousStep: data.previousStep || null,
      currentPhaseStep,
      activePlayerId,
      priorityPlayerId: this.priorityMachine?.priorityPlayerId || this._priorityMachine?.priorityPlayerId || activePlayerId,
      turnNumber: this.priorityMachine?.turnNumber ?? this._priorityMachine?.turnNumber ?? 1,
      stackSize: typeof this.priorityMachine?.getStackSize === 'function' ? this.priorityMachine.getStackSize() : (typeof this._priorityMachine?.getStackSize === 'function' ? this._priorityMachine.getStackSize() : 0),
      combatAttackersCount: this.combatState?.attackers?.length || 0,
      combatBlockersCount: this.combatState?.blockers?.length || 0
    });

    if (
      currentPhaseStep === 'END_COMBAT' ||
      currentPhaseStep === 'POSTCOMBAT_MAIN' ||
      currentPhaseStep === 'MAIN_2' ||
      currentPhaseStep === 'END' ||
      currentPhaseStep === 'UNTAP'
    ) {
      this.endCombat();
    }

    if (currentPhaseStep === 'UNTAP') {
      this.handleUntapStep(activePlayerId);
    } else if (currentPhaseStep === 'UPKEEP') {
      this.handleUpkeepStep(activePlayerId, data.turnNumber, data.roundNumber || this.roundNumber);
    } else if (currentPhaseStep === 'DRAW') {
      const is1v1 = (this._priorityMachine?.players?.length === 2) || (Object.keys(this.players).length === 2);
      const startingPid = this.startingPlayerId || this._priorityMachine?.startingPlayerId || Object.keys(this.players)[0];
      const isFirstTurnOfStartingPlayer = this._priorityMachine
        ? (this._priorityMachine.activePlayerId === startingPid && (this._priorityMachine.turnNumber === 1 || (this._priorityMachine.roundNumber === 1 && (this._priorityMachine.playerTurnCounts?.get(startingPid) || 0) <= 1)))
        : (activePlayerId === startingPid && this.turnNumber === 1);
      const shouldSkip = data.shouldSkipDraw !== undefined
        ? data.shouldSkipDraw
        : (is1v1 && isFirstTurnOfStartingPlayer);

      if (!shouldSkip) {
        const turnKey = `${activePlayerId}_${this._priorityMachine?.turnNumber || this.turnNumber}_draw`;
        if (!this._drawsExecutedThisTurn) this._drawsExecutedThisTurn = new Set();
        if (!this._drawsExecutedThisTurn.has(turnKey)) {
          this._drawsExecutedThisTurn.add(turnKey);
          try {
            this.drawCardForTurn(activePlayerId);
            this.emit('AUTO_DRAW_RESOLVED', { activePlayerId });
          } catch (err) {}
        }
      }
    } else if (currentPhaseStep === 'BEGIN_COMBAT') {
      this.recordTrace('COMBAT_TRACE', 'BEGIN_COMBAT', { activePlayerId });
    } else if (currentPhaseStep === 'DECLARE_BLOCKERS') {
      const attackers = this.combatState?.attackers || [];
      const defendingPid = attackers[0]?.defendingPlayerId || Object.keys(this.players || {}).find(id => id !== activePlayerId && !this.players[id]?.isEliminated) || null;
      this.recordTrace('COMBAT_TRACE', 'ENTER_DECLARE_BLOCKERS', {
        activePlayerId,
        waitingForDefender: defendingPid,
        attackerIds: attackers.map(a => a.instanceId || a.id)
      });
    } else if (currentPhaseStep === 'COMBAT_DAMAGE') {
      this.resolveCombatDamage();
    } else if (currentPhaseStep === 'CLEANUP') {
      this.handleCleanupStep(activePlayerId);
    }
  }

  runSBACheck() {
    return StateBasedActionsEngine.runSBACheck(this, this.abilityEngine);
  }
}
