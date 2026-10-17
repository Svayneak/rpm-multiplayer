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
export class TabletopStateManager {
  constructor(options = {}) {
    this.sessionId = options.sessionId || `session_${Date.now()}`;
    this.players = {}; // Map: playerId -> PlayerZoneState
    this.stack = [];   // Array: CardInstance
    this.activePlayerId = options.activePlayerId || null;
    this.turnNumber = options.turnNumber || 1;
    this.actionLog = [];
    this.subscribers = new Set();
    this.sequenceCounter = 0;

    if (Array.isArray(options.players)) {
      for (const p of options.players) {
        if (typeof p === 'string') {
          this.registerPlayer(p, p);
        } else if (p && p.id) {
          this.registerPlayer(p.id, p.name || p.id);
        }
      }
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
    this.players[playerId] = player;
    if (!this.activePlayerId) {
      this.activePlayerId = playerId;
    }
    return player;
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
      player.resources = {
        life: 20,
        poison: 0,
        energy: 0,
        manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
      };
    }

    const startingLife = options.startingLife ?? payload.startingLife ?? 20;
    player.resources.life = startingLife;
    player.resources.poison = 0;
    player.resources.energy = 0;
    player.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
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
    const available = Math.min(n, player.library.length);
    const drawn = player.library.splice(0, available);

    for (const card of drawn) {
      card.zone = 'hand';
      card.subzone = null;
      player.hand.push(card);
    }

    return {
      drawn,
      drawnCount: drawn.length,
      libraryCount: player.library.length,
      handCount: player.hand.length
    };
  }

  _handlePlayLand(payload) {
    const { playerId, instanceId } = payload;
    const player = this.getPlayer(playerId);
    const cardIdx = player.hand.findIndex(c => c && c.instanceId === instanceId);
    if (cardIdx === -1) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId} not found in player's hand`);
    }

    const card = player.hand[cardIdx];
    if (!/land/i.test(card.typeLine)) {
      throw new InvalidCardTypeError(`Card is not a land: "${card.name}" (${card.typeLine})`);
    }

    player.hand.splice(cardIdx, 1);
    card.zone = 'battlefield';
    card.subzone = 'lands';
    card.isTapped = false;
    player.battlefield.lands.push(card);

    return { card };
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

    // Verify sufficient mana before deducting
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
    }

    const [card] = sourceArray.splice(cardIdx, 1);
    card.zone = 'stack';
    card.subzone = null;

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
        card.isTapped = false;
        count++;
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

  // --- Convenience Direct Methods ---

  initializeDeck(playerId, deckCards, options) {
    return this.dispatch('INITIALIZE_DECK', { playerId, deckCards, options });
  }

  drawCard(playerId, count = 1) {
    return this.dispatch('DRAW_CARD', { playerId, count });
  }

  playLand(playerId, instanceId) {
    return this.dispatch('PLAY_LAND', { playerId, instanceId });
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
}
