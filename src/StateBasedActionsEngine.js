/**
 * StateBasedActionsEngine.js - MTG CR 704 State-Based Actions (SBA) Engine
 * 
 * Part of RPM Multiplayer - Feature 20 & 21
 * Specifications: SPEC-RPM-COMBAT-DAMAGE-020 (INV-SBA-1), SPEC-RPM-RULES-ENGINE-021 (INV-STATIC-SBA-1)
 * 
 * Implements:
 * - Authoritative iterative while-loop evaluating all active SBAs until board state stabilizes.
 * - CR 704.5a: Player with life <= 0 loses the game.
 * - CR 704.5c: Player with 10 or more poison counters loses the game.
 * - CR 704.5q: +1/+1 and -1/-1 counter annihilation.
 * - CR 704.5f: Creature with toughness <= 0 put into owner's graveyard.
 *     ENFORCES INV-STATIC-SBA-1: Bypasses Indestructible! 0-toughness is NOT destruction.
 * - CR 704.5g: Creature with marked damage >= toughness destroyed (Prevented by Indestructible).
 * - CR 704.5h: Creature dealt deathtouch damage destroyed (Prevented by Indestructible).
 * - CR 514.2: Cleanup step damage purge loop.
 * 
 * @module StateBasedActionsEngine
 */

import { ZoneModel } from './ZoneModel.js';
import { ZoneTransitionMatrix } from './ZoneTransitionMatrix.js';

export class StateBasedActionsEngine {
  /**
   * Executes an authoritative SBA check loop on the tabletop state per MTG CR 704.3.
   * Runs repeatedly until a pass occurs where zero actions are taken.
   * 
   * @param {Object} tabletopState - Active TabletopStateManager instance
   * @param {Object} [abilityEngine=null] - Optional AbilityEngine for layer recalculation
   * @returns {{ loopCount: number, totalActionsApplied: number, actions: Array<Object> }}
   */
  static runSBACheck(tabletopState, abilityEngine = null) {
    let loopCount = 0;
    const maxLoops = 25; // Guard against infinite recursion
    let totalActionsApplied = 0;
    const allActions = [];

    while (loopCount < maxLoops) {
      loopCount++;
      const passActions = [];

      // 1. CR 704.5a: Player with 0 or less life loses
      for (const [pid, player] of Object.entries(tabletopState.players || {})) {
        if (!player.isEliminated && (player.resources?.life ?? 20) <= 0) {
          player.isEliminated = true;
          passActions.push({
            type: 'PLAYER_ELIMINATED',
            rule: 'CR 704.5a',
            playerId: pid,
            reason: 'LIFE_ZERO_OR_LESS'
          });
        }
      }

      // 2. CR 704.5c: Player with 10+ poison counters loses
      for (const [pid, player] of Object.entries(tabletopState.players || {})) {
        if (!player.isEliminated && (player.resources?.poison || 0) >= 10) {
          player.isEliminated = true;
          passActions.push({
            type: 'PLAYER_ELIMINATED',
            rule: 'CR 704.5c',
            playerId: pid,
            reason: 'POISON_TEN_OR_MORE'
          });
        }
      }

      // 3. CR 704.5q: +1/+1 and -1/-1 counter annihilation
      for (const player of Object.values(tabletopState.players || {})) {
        const creatures = player.battlefield?.creatures || [];
        for (const card of creatures) {
          if (card.counters && card.counters['+1/+1'] && card.counters['-1/-1']) {
            const p1 = card.counters['+1/+1'];
            const m1 = card.counters['-1/-1'];
            const annihilated = Math.min(p1, m1);
            if (annihilated > 0) {
              card.counters['+1/+1'] -= annihilated;
              card.counters['-1/-1'] -= annihilated;
              passActions.push({
                type: 'COUNTERS_ANNIHILATED',
                rule: 'CR 704.5q',
                cardId: card.instanceId,
                annihilated
              });
            }
          }
        }
      }

      // 4. Creature Deaths: CR 704.5f (Zero Toughness) vs CR 704.5g (Lethal Damage) & CR 704.5h (Deathtouch)
      for (const [pid, player] of Object.entries(tabletopState.players || {})) {
        const creatures = [...(player.battlefield?.creatures || [])];

        for (const card of creatures) {
          // If AbilityEngine is available, evaluate continuous layers first
          const evaluated = abilityEngine ? abilityEngine.evaluatePermanentLayers(card, tabletopState) : card;

          const toughness = evaluated.effectiveToughness !== undefined 
            ? evaluated.effectiveToughness 
            : (Number(card.toughness) || 0);

          const markedDamage = card.damageMarked || 0;
          const isIndestructible = !!(
            card.isIndestructible ||
            card.keywords?.indestructible ||
            evaluated.keywords?.indestructible ||
            /indestructible/i.test(card.text || '')
          );

          // CHECK 1: CR 704.5f - Toughness <= 0 (State-Based Death)
          // INVARIANT INV-STATIC-SBA-1: BYPASSES INDESTRUCTIBLE!
          if (toughness <= 0) {
            ZoneTransitionMatrix.moveCard(player, card.instanceId, 'battlefield', 'graveyard');
            passActions.push({
              type: 'CREATURE_DIED_ZERO_TOUGHNESS',
              rule: 'CR 704.5f',
              playerId: pid,
              cardId: card.instanceId,
              cardName: card.name,
              effectiveToughness: toughness,
              bypassedIndestructible: isIndestructible
            });
            continue;
          }

          // CHECK 2: CR 704.5g - Lethal Damage Destruction
          // Prevented by Indestructible!
          if (markedDamage >= toughness) {
            if (isIndestructible) {
              // Immune to lethal damage destruction
              continue;
            }
            ZoneTransitionMatrix.moveCard(player, card.instanceId, 'battlefield', 'graveyard');
            passActions.push({
              type: 'CREATURE_DESTROYED_LETHAL_DAMAGE',
              rule: 'CR 704.5g',
              playerId: pid,
              cardId: card.instanceId,
              cardName: card.name,
              markedDamage,
              toughness
            });
            continue;
          }

          // CHECK 3: CR 704.5h - Deathtouch Damage Destruction
          // Prevented by Indestructible!
          if (card.hasDeathtouchDamageMarked && markedDamage > 0) {
            if (isIndestructible) {
              continue;
            }
            ZoneTransitionMatrix.moveCard(player, card.instanceId, 'battlefield', 'graveyard');
            passActions.push({
              type: 'CREATURE_DESTROYED_DEATHTOUCH',
              rule: 'CR 704.5h',
              playerId: pid,
              cardId: card.instanceId,
              cardName: card.name
            });
            continue;
          }
        }
      }

      totalActionsApplied += passActions.length;
      allActions.push(...passActions);

      // If no actions occurred in this pass, the game state has stabilized
      if (passActions.length === 0) {
        break;
      }
    }

    if (totalActionsApplied > 0 && tabletopState.emit) {
      tabletopState.emit('SBA_CYCLE_COMPLETED', {
        loopCount,
        totalActionsApplied,
        actions: allActions
      });
    }

    return {
      loopCount,
      totalActionsApplied,
      actions: allActions
    };
  }

  /**
   * Purges all marked damage and temporary combat flags from permanents during the Cleanup Step per MTG CR 514.2.
   * 
   * @param {Object} tabletopState
   * @returns {number} Count of permanents cleansed
   */
  static purgeCleanupMarkedDamage(tabletopState) {
    let cleansedCount = 0;
    for (const player of Object.values(tabletopState.players || {})) {
      const perms = [
        ...(player.battlefield?.creatures || []),
        ...(player.battlefield?.lands || []),
        ...(player.battlefield?.noncreatures || []),
        ...(player.battlefield?.planeswalkers || [])
      ];
      for (const card of perms) {
        if (card.damageMarked || card.hasDeathtouchDamageMarked) {
          card.damageMarked = 0;
          card.hasDeathtouchDamageMarked = false;
          cleansedCount++;
        }
      }
    }
    return cleansedCount;
  }
}

export default StateBasedActionsEngine;
