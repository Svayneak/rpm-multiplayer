/**
 * ZoneTransitionMatrix.js - MTG CR 400 Universal 6-Zone Transition Matrix
 * 
 * Part of RPM Multiplayer - Feature 21
 * Specification: SPEC-RPM-RULES-ENGINE-021 (INV-ZONE-MATRIX-1)
 * 
 * Implements:
 * - Authoritative 36-path bi-directional transition matrix:
 *   Zones: library, hand, battlefield, graveyard, exile, stack
 * - MTG CR 400.7 Zone-Change Identity Reset:
 *   Clears marked damage, counters, tap state, and temporary modifications.
 * - Specialized MTG flows:
 *   - "Enter without casting" (Aether Vial, Collected Company, Polymorph)
 *   - "Cast without paying mana cost" (Cascade, Omniscience)
 *   - Reanimation (Graveyard to Battlefield)
 *   - Regrowth (Graveyard to Hand)
 *   - Mill / Surveil (Library to Graveyard)
 *   - Impulse Draw (Library to Exile)
 *   - Blink / Flicker (Battlefield to Exile to Battlefield)
 * 
 * @module ZoneTransitionMatrix
 */

import { ZoneModel } from './ZoneModel.js';

export const ZONES = Object.freeze([
  'library',
  'hand',
  'battlefield',
  'graveyard',
  'exile',
  'stack'
]);

export class ZoneTransitionMatrix {
  /**
   * Resets card identity upon zone transition per MTG CR 400.7.
   * 
   * @param {Object} card - Card instance
   * @param {string} toZone - Destination zone
   * @returns {Object} Card instance with refreshed identity
   */
  static resetCardIdentity(card, toZone) {
    if (!card) return card;

    card.zone = toZone;
    card.damageMarked = 0;
    card.isTapped = false;
    card.counters = {};
    card.grantedAbilities = [];

    // Summoning sickness applies when entering the battlefield
    if (toZone === 'battlefield') {
      const isCreature = /creature/i.test(card.typeLine || card.type || '');
      card.hasSummoningSickness = isCreature;
    } else {
      card.hasSummoningSickness = false;
      card.subzone = null;
    }

    return card;
  }

  /**
   * Executes an authoritative zone transition across any of the 36 valid MTG paths.
   * 
   * @param {Object} playerState - Target player's zone state
   * @param {string} instanceId - Card instance ID
   * @param {string} fromZone - Source zone
   * @param {string} toZone - Destination zone
   * @param {Object} [options={}] - Transition modifiers (position: 'top'|'bottom', subzone, freeCast)
   * @param {Array} [stack=[]] - Shared stack container
   * @returns {{ card: Object, fromZone: string, toZone: string, details: Object }}
   */
  static moveCard(playerState, instanceId, fromZone, toZone, options = {}, stack = []) {
    if (!playerState) {
      throw new Error('playerState is required for zone transition');
    }
    if (!ZONES.includes(fromZone)) {
      throw new Error(`Invalid source zone: ${fromZone}`);
    }
    if (!ZONES.includes(toZone)) {
      throw new Error(`Invalid destination zone: ${toZone}`);
    }

    // Locate and remove card from source zone
    const removalResult = ZoneModel.removeCardFromZone(playerState, instanceId, stack);
    if (!removalResult || !removalResult.card) {
      throw new Error(`Card with instanceId '${instanceId}' not found in source zone '${fromZone}'`);
    }

    const card = removalResult.card;

    // Apply CR 400.7 Zone-Change Identity Reset
    this.resetCardIdentity(card, toZone);

    // Apply specific transition flags
    if (options.withoutPayingManaCost || options.isFreeCast) {
      card.isFreeCast = true;
      card.withoutPayingManaCost = true;
    }

    // Insert card into destination zone
    const targetSubzone = options.subzone || null;
    const position = options.position || 'bottom';

    ZoneModel.insertCardIntoZone(playerState, card, toZone, targetSubzone, position, stack);

    return {
      card,
      fromZone,
      toZone,
      details: {
        position,
        subzone: card.subzone,
        isFreeCast: !!card.isFreeCast,
        timestamp: Date.now()
      }
    };
  }

  /**
   * Executes "Enter without casting" (MTG CR: bypasses stack & counterspells, enters directly).
   * Used for Aether Vial, Collected Company, Polymorph, Show and Tell.
   * 
   * @param {Object} playerState
   * @param {string} instanceId
   * @param {string} [fromZone='library']
   * @param {string|null} [subzone=null]
   * @returns {Object} Moved card
   */
  static enterWithoutCasting(playerState, instanceId, fromZone = 'library', subzone = null) {
    const result = this.moveCard(playerState, instanceId, fromZone, 'battlefield', {
      subzone,
      bypassesStack: true,
      enterWithoutCasting: true
    });
    return result.card;
  }

  /**
   * Executes "Cast without paying mana cost" (MTG CR: places on stack with cost 0, counterable).
   * Used for Omniscience, Cascade, Bloodbraid Elf.
   * 
   * @param {Object} playerState
   * @param {string} instanceId
   * @param {string} [fromZone='hand']
   * @param {Array} [stack=[]]
   * @returns {Object} Card on stack
   */
  static castWithoutPayingManaCost(playerState, instanceId, fromZone = 'hand', stack = []) {
    const result = this.moveCard(playerState, instanceId, fromZone, 'stack', {
      withoutPayingManaCost: true,
      isFreeCast: true
    }, stack);
    return result.card;
  }

  /**
   * Reanimates a creature from graveyard directly to the battlefield.
   * 
   * @param {Object} playerState
   * @param {string} instanceId
   * @returns {Object} Card on battlefield
   */
  static reanimate(playerState, instanceId) {
    return this.enterWithoutCasting(playerState, instanceId, 'graveyard');
  }

  /**
   * Returns a card from graveyard to owner's hand (Regrowth, Eternal Witness).
   * 
   * @param {Object} playerState
   * @param {string} instanceId
   * @returns {Object} Card in hand
   */
  static regrowth(playerState, instanceId) {
    const result = this.moveCard(playerState, instanceId, 'graveyard', 'hand');
    return result.card;
  }

  /**
   * Blinks/Flickers a permanent: battlefield -> exile -> battlefield as a fresh object.
   * 
   * @param {Object} playerState
   * @param {string} instanceId
   * @returns {Object} Refreshed card on battlefield
   */
  static flicker(playerState, instanceId) {
    // Step 1: Move to exile
    this.moveCard(playerState, instanceId, 'battlefield', 'exile');
    // Step 2: Return to battlefield
    const result = this.moveCard(playerState, instanceId, 'exile', 'battlefield');
    return result.card;
  }

  /**
   * Mills N cards from top of library to graveyard.
   * 
   * @param {Object} playerState
   * @param {number} count
   * @returns {Array<Object>} Milled cards
   */
  static mill(playerState, count = 1) {
    if (!playerState || !Array.isArray(playerState.library)) return [];
    const milled = [];
    const toMill = Math.min(count, playerState.library.length);

    for (let i = 0; i < toMill; i++) {
      const topCard = playerState.library[0];
      if (topCard) {
        const moved = this.moveCard(playerState, topCard.instanceId, 'library', 'graveyard');
        milled.push(moved.card);
      }
    }
    return milled;
  }

  /**
   * Impulse exiles top N cards from library.
   * 
   * @param {Object} playerState
   * @param {number} count
   * @returns {Array<Object>} Exiled cards
   */
  static impulseExile(playerState, count = 1) {
    if (!playerState || !Array.isArray(playerState.library)) return [];
    const exiled = [];
    const toExile = Math.min(count, playerState.library.length);

    for (let i = 0; i < toExile; i++) {
      const topCard = playerState.library[0];
      if (topCard) {
        const moved = this.moveCard(playerState, topCard.instanceId, 'library', 'exile');
        moved.card.impulsePlayable = true;
        exiled.push(moved.card);
      }
    }
    return exiled;
  }
}

export default ZoneTransitionMatrix;
