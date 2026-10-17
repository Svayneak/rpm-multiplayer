/**
 * RPM Multiplayer - Tabletop Zone State Manager & Fog-of-War Projection
 * ZoneModel: Low-level pure zone operations, entities, and validation invariants.
 *
 * Specification: SPEC-RPM-ZONE-003
 *
 * @module ZoneModel
 */

import { randomUUID } from 'node:crypto';

/**
 * Custom Error hierarchy for State Transitions and Zone Invariants
 */
export class StateTransitionError extends Error {
  constructor(message = 'State transition error') {
    super(message);
    this.name = 'StateTransitionError';
  }
}

export class CardNotFoundError extends StateTransitionError {
  constructor(message = 'Card not found') {
    super(message);
    this.name = 'CardNotFoundError';
  }
}

export class InvalidZoneError extends StateTransitionError {
  constructor(message = 'Invalid zone operation') {
    super(message);
    this.name = 'InvalidZoneError';
  }
}

export class InvalidCardTypeError extends StateTransitionError {
  constructor(message = 'Invalid card type for operation') {
    super(message);
    this.name = 'InvalidCardTypeError';
  }
}

export class InsufficientManaError extends StateTransitionError {
  constructor(message = 'Insufficient mana in pool') {
    super(message);
    this.name = 'InsufficientManaError';
  }
}

export class PermanentAlreadyTappedError extends StateTransitionError {
  constructor(message = 'Permanent is already tapped') {
    super(message);
    this.name = 'PermanentAlreadyTappedError';
  }
}

export class PlayerNotFoundError extends StateTransitionError {
  constructor(message = 'Player not found in session') {
    super(message);
    this.name = 'PlayerNotFoundError';
  }
}

let instanceIdCounter = 0;

/**
 * Generates an RFC-compliant collision-resistant Card Instance ID.
 * Format: `inst_${timestamp}_${uuid}`
 * 
 * @returns {string} Unique instance ID
 */
export function generateInstanceId() {
  const timestamp = Date.now();
  let uuidPart;
  if (typeof randomUUID === 'function') {
    uuidPart = randomUUID().replace(/-/g, '').substring(0, 8);
  } else {
    uuidPart = Math.random().toString(36).substring(2, 10);
  }
  instanceIdCounter = (instanceIdCounter + 1) % 100000;
  const seq = instanceIdCounter.toString(36).padStart(3, '0');
  return `inst_${timestamp}_${uuidPart}${seq}`;
}

/**
 * Classifies an MTG card into its proper battlefield subzone based on typeLine.
 * Precedence Rule:
 * 1. Planeswalker -> 'planeswalkers'
 * 2. Creature     -> 'creatures'
 * 3. Land         -> 'lands'
 * 4. Default      -> 'noncreatures' (Artifacts, Enchantments, Battles)
 *
 * @param {string} typeLine - Card type line (e.g. "Artifact Creature — Golem")
 * @returns {'lands' | 'creatures' | 'noncreatures' | 'planeswalkers'}
 */
export function classifySubzone(typeLine = '') {
  const normalized = String(typeLine).toLowerCase();

  if (normalized.includes('planeswalker')) {
    return 'planeswalkers';
  }
  if (normalized.includes('creature')) {
    return 'creatures';
  }
  if (normalized.includes('land')) {
    return 'lands';
  }
  return 'noncreatures';
}

/**
 * Fisher-Yates array shuffle in-place.
 *
 * @template T
 * @param {T[]} array
 * @returns {T[]}
 */
export function shuffleArray(array) {
  if (!Array.isArray(array)) return array;
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
  return array;
}

/**
 * Resets permanent state (untaps and clears counters and transient battlefield annotations)
 * when leaving the battlefield.
 *
 * @param {Object} card - CardInstance
 */
export function resetCardState(card) {
  if (!card) return;
  card.isTapped = false;
  card.counters = {};
  if (card.annotations && card.annotations.castTargets) {
    delete card.annotations.castTargets;
  }
}

/**
 * Pure low-level zone operations and model utilities.
 */
export class ZoneModel {
  static StateTransitionError = StateTransitionError;
  static CardNotFoundError = CardNotFoundError;
  static InvalidZoneError = InvalidZoneError;
  static InvalidCardTypeError = InvalidCardTypeError;
  static InsufficientManaError = InsufficientManaError;
  static PermanentAlreadyTappedError = PermanentAlreadyTappedError;
  static PlayerNotFoundError = PlayerNotFoundError;

  /**
   * Generates a unique collision-resistant Card Instance ID.
   * Format: `inst_${timestamp}_${uuid}`
   */
  static generateInstanceId() {
    return generateInstanceId();
  }

  /**
   * Classifies card typeLine into lands, creatures, noncreatures, or planeswalkers.
   *
   * @param {string} typeLine
   * @returns {'lands' | 'creatures' | 'noncreatures' | 'planeswalkers'}
   */
  static classifySubzone(typeLine) {
    return classifySubzone(typeLine);
  }

  /**
   * Fisher-Yates array shuffle.
   *
   * @param {Array} array
   * @returns {Array}
   */
  static shuffleArray(array) {
    return shuffleArray(array);
  }

  /**
   * Creates a fresh player zone state object.
   *
   * @param {string} playerId
   * @param {string} [playerName='Player']
   * @returns {Object} PlayerZoneState
   */
  static createInitialPlayerState(playerId, playerName = 'Player') {
    return {
      playerId,
      playerName,
      library: [],
      hand: [],
      battlefield: {
        lands: [],
        creatures: [],
        noncreatures: [],
        planeswalkers: []
      },
      graveyard: [],
      exile: [],
      isHandRevealed: false,
      resources: {
        life: 20,
        poison: 0,
        energy: 0,
        manaPool: {
          W: 0,
          U: 0,
          B: 0,
          R: 0,
          G: 0,
          C: 0
        }
      }
    };
  }

  /**
   * Instantiates a card instance from a hydrated card entity.
   *
   * @param {Object} hydratedCard
   * @param {string} ownerId
   * @param {Object} [options={}]
   * @returns {Object} CardInstance
   */
  static createCardInstance(hydratedCard = {}, ownerId = '', options = {}) {
    const cardId = hydratedCard.cardId || hydratedCard.id || '';
    const name = hydratedCard.name || 'Unknown Card';
    const manaCost = hydratedCard.manaCost ?? hydratedCard.mana_cost ?? '';
    const typeLine = hydratedCard.typeLine ?? hydratedCard.type_line ?? '';
    const oracleText = hydratedCard.oracleText ?? hydratedCard.oracle_text ?? '';

    let imageUri = hydratedCard.imageUri ?? hydratedCard.image_uris?.normal ?? hydratedCard.image_uris?.small ?? '';
    if (!imageUri && hydratedCard.raw?.image_uris?.normal) {
      imageUri = hydratedCard.raw.image_uris.normal;
    }
    if (!imageUri && hydratedCard.card_faces?.[0]?.image_uris?.normal) {
      imageUri = hydratedCard.card_faces[0].image_uris.normal;
    }

    const colors = Array.isArray(hydratedCard.colors)
      ? [...hydratedCard.colors]
      : (hydratedCard.raw?.colors ? [...hydratedCard.raw.colors] : []);

    const instanceId = options.instanceId || generateInstanceId();
    const zone = options.zone || 'library';
    const subzone = options.subzone !== undefined
      ? options.subzone
      : (zone === 'battlefield' ? classifySubzone(typeLine) : null);

    return {
      instanceId,
      cardId,
      name,
      manaCost,
      typeLine,
      oracleText,
      imageUri,
      colors,
      ownerId: ownerId || hydratedCard.ownerId || '',
      controllerId: options.controllerId || ownerId || hydratedCard.controllerId || '',
      zone,
      subzone,
      isTapped: Boolean(options.isTapped),
      counters: options.counters ? { ...options.counters } : {},
      isToken: Boolean(hydratedCard.isToken || options.isToken),
      isFaceDown: Boolean(options.isFaceDown),
      annotations: options.annotations ? { ...options.annotations } : {}
    };
  }

  /**
   * Resets card permanent state (untaps and clears counters).
   *
   * @param {Object} card
   */
  static resetCardState(card) {
    resetCardState(card);
  }

  /**
   * Finds a card instance across all zones of a player or session.
   *
   * @param {Object} playerStateOrManager - Either a single PlayerZoneState or TabletopStateManager
   * @param {string} instanceId
   * @param {Array} [stack=[]]
   * @returns {{ card: Object, zone: string, subzone: string|null, index: number, container: Array } | null}
   */
  static findCard(playerStateOrManager, instanceId, stack = []) {
    if (!playerStateOrManager || !instanceId) return null;

    // Check if playerStateOrManager is TabletopStateManager or contains a players map
    if (playerStateOrManager.players && typeof playerStateOrManager.players === 'object') {
      const managerStack = Array.isArray(playerStateOrManager.stack) ? playerStateOrManager.stack : stack;
      for (const player of Object.values(playerStateOrManager.players)) {
        const found = this._findCardInPlayer(player, instanceId);
        if (found) return found;
      }
      // Check stack
      if (Array.isArray(managerStack)) {
        const stackIdx = managerStack.findIndex(c => c && c.instanceId === instanceId);
        if (stackIdx !== -1) {
          return {
            card: managerStack[stackIdx],
            zone: 'stack',
            subzone: null,
            index: stackIdx,
            container: managerStack
          };
        }
      }
      return null;
    }

    // Otherwise treat as a single PlayerZoneState
    const found = this._findCardInPlayer(playerStateOrManager, instanceId);
    if (found) return found;

    // Check stack if provided
    if (Array.isArray(stack)) {
      const stackIdx = stack.findIndex(c => c && c.instanceId === instanceId);
      if (stackIdx !== -1) {
        return {
          card: stack[stackIdx],
          zone: 'stack',
          subzone: null,
          index: stackIdx,
          container: stack
        };
      }
    }

    return null;
  }

  /**
   * Internal search helper within a single player's zones.
   * @private
   */
  static _findCardInPlayer(playerState, instanceId) {
    if (!playerState) return null;

    const simpleZones = ['library', 'hand', 'graveyard', 'exile'];
    for (const zone of simpleZones) {
      const arr = playerState[zone];
      if (Array.isArray(arr)) {
        const idx = arr.findIndex(c => c && c.instanceId === instanceId);
        if (idx !== -1) {
          return {
            card: arr[idx],
            zone,
            subzone: null,
            index: idx,
            container: arr
          };
        }
      }
    }

    if (playerState.battlefield && typeof playerState.battlefield === 'object') {
      const subzones = ['lands', 'creatures', 'noncreatures', 'planeswalkers'];
      for (const sub of subzones) {
        const arr = playerState.battlefield[sub];
        if (Array.isArray(arr)) {
          const idx = arr.findIndex(c => c && c.instanceId === instanceId);
          if (idx !== -1) {
            return {
              card: arr[idx],
              zone: 'battlefield',
              subzone: sub,
              index: idx,
              container: arr
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Removes a card instance from whatever zone it resides in.
   *
   * @param {Object} playerStateOrManager
   * @param {string} instanceId
   * @param {Array} [stack=[]]
   * @returns {{ card: Object, zone: string, subzone: string|null, index: number } | null}
   */
  static removeCardFromZone(playerStateOrManager, instanceId, stack = []) {
    const found = this.findCard(playerStateOrManager, instanceId, stack);
    if (!found) return null;

    found.container.splice(found.index, 1);
    return {
      card: found.card,
      zone: found.zone,
      subzone: found.subzone,
      index: found.index
    };
  }

  /**
   * Inserts a card into a target zone and optional subzone.
   *
   * @param {Object} playerState
   * @param {Object} card
   * @param {string} targetZone - 'library' | 'hand' | 'battlefield' | 'graveyard' | 'stack' | 'exile'
   * @param {string|null} [targetSubzone=null]
   * @param {'top' | 'bottom' | number} [position='bottom']
   * @param {Array} [stack=[]]
   * @returns {Object} The inserted card
   */
  static insertCardIntoZone(playerState, card, targetZone, targetSubzone = null, position = 'bottom', stack = []) {
    if (!card) {
      throw new Error('Card instance required for insertion');
    }

    card.zone = targetZone;

    if (targetZone === 'battlefield') {
      const sub = targetSubzone || classifySubzone(card.typeLine);
      card.subzone = sub;
      if (!playerState.battlefield[sub]) {
        playerState.battlefield[sub] = [];
      }
      playerState.battlefield[sub].push(card);
      return card;
    }

    card.subzone = null;

    if (targetZone === 'library') {
      if (!playerState.library) playerState.library = [];
      if (position === 'bottom') {
        playerState.library.push(card);
      } else if (typeof position === 'number') {
        playerState.library.splice(position, 0, card);
      } else {
        // default: 'top'
        playerState.library.unshift(card);
      }
      return card;
    }

    if (targetZone === 'stack') {
      const stackArr = Array.isArray(stack) ? stack : [];
      stackArr.push(card);
      return card;
    }

    if (targetZone === 'hand') {
      if (!playerState.hand) playerState.hand = [];
      playerState.hand.push(card);
      return card;
    }

    if (targetZone === 'graveyard') {
      if (!playerState.graveyard) playerState.graveyard = [];
      playerState.graveyard.push(card);
      return card;
    }

    if (targetZone === 'exile') {
      if (!playerState.exile) playerState.exile = [];
      playerState.exile.push(card);
      return card;
    }

    throw new InvalidZoneError(`Unsupported target zone: ${targetZone}`);
  }
}
