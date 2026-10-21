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
 *   The moved card becomes a new object: it is cloned, receives a regenerated
 *   (deterministic) instanceId, and has marked damage, counters, tap state, and
 *   temporary modifications cleared.
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
   * Derives the instanceId for the "new object" a card becomes after a zone change (CR 400.7).
   *
   * The id is deterministic (lineage root + zone-change ordinal) rather than random so that
   * every client replaying the same action log over the relay derives identical ids.
   *
   * @param {Object} card - Card object that is leaving its current zone
   * @returns {{ instanceId: string, lineageId: string, zoneChangeCount: number }}
   */
  static deriveNextIdentity(card) {
    const lineageId = card.lineageId || card.instanceId;
    const zoneChangeCount = (Number(card.zoneChangeCount) || 0) + 1;
    return {
      instanceId: `${lineageId}::zc${zoneChangeCount}`,
      lineageId,
      zoneChangeCount
    };
  }

  /**
   * Creates the new game object that results from a zone change (MTG CR 400.7):
   * a fresh clone of the card with a regenerated instanceId and a reset identity.
   * The source object is never mutated, so stale references held elsewhere
   * (targets, attackers, stack items) can no longer resolve to the moved card.
   *
   * @param {Object} card - Card object removed from its source zone
   * @param {string} toZone - Destination zone
   * @returns {Object} New card object
   */
  static createZoneChangedObject(card, toZone) {
    const identity = this.deriveNextIdentity(card);
    const clone = {
      ...card,
      instanceId: identity.instanceId,
      previousInstanceId: card.instanceId,
      lineageId: identity.lineageId,
      zoneChangeCount: identity.zoneChangeCount
    };
    // A new object does not inherit cast-time flags from its previous incarnation.
    delete clone.isFreeCast;
    delete clone.withoutPayingManaCost;
    delete clone.impulsePlayable;
    return this.resetCardIdentity(clone, toZone);
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
   *   `card` is the NEW object in the destination zone (different reference and instanceId
   *   from the source card; `card.previousInstanceId` holds the old id).
   */
  static moveCard(playerState, instanceId, fromZone, toZone, options = {}, stack = null) {
    if (!playerState) {
      throw new Error('playerState is required for zone transition');
    }
    if (!ZONES.includes(fromZone)) {
      throw new Error(`Invalid source zone: ${fromZone}`);
    }
    if (!ZONES.includes(toZone)) {
      throw new Error(`Invalid destination zone: ${toZone}`);
    }

    const effectiveStack = Array.isArray(stack)
      ? stack
      : (playerState.stack || (playerState.stack = []));

    // Locate and remove card from source zone
    const removalResult = ZoneModel.removeCardFromZone(playerState, instanceId, effectiveStack);
    if (!removalResult || !removalResult.card) {
      throw new Error(`Card with instanceId '${instanceId}' not found in source zone '${fromZone}'`);
    }

    // Apply CR 400.7 Zone-Change Identity Reset: the card becomes a brand-new object
    // (cloned, with a regenerated instanceId) in its destination zone.
    const card = this.createZoneChangedObject(removalResult.card, toZone);

    // Apply specific transition flags
    if (options.withoutPayingManaCost || options.isFreeCast) {
      card.isFreeCast = true;
      card.withoutPayingManaCost = true;
    }

    // Insert card into destination zone
    const targetSubzone = options.subzone || null;
    const position = options.position || 'bottom';

    ZoneModel.insertCardIntoZone(playerState, card, toZone, targetSubzone, position, effectiveStack);

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
    // Step 1: Move to exile (CR 400.7: the exiled card is a new object with a new instanceId)
    const exiled = this.moveCard(playerState, instanceId, 'battlefield', 'exile');
    // Step 2: Return to battlefield using the exiled object's identity
    const result = this.moveCard(playerState, exiled.card.instanceId, 'exile', 'battlefield');
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
