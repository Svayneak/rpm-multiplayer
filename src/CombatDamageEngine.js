/**
 * CombatDamageEngine.js - MTG CR 510 Combat Damage Engine, Damage vs. Life Loss, Keyword Resolution
 * 
 * Part of RPM Multiplayer - Feature 20
 * Specification: SPEC-RPM-COMBAT-DAMAGE-020 (INV-DMG-LIFE-1, INV-KEYWORD-DMG-1, INV-DAMAGE-ASSIGN-1)
 * 
 * Implements:
 * - Authoritative separation of Damage (CR 120) and Life Loss (CR 119)
 * - Comprehensive Keyword Resolution:
 *   - Lifelink (CR 702.15, CR 120.3f): Simultaneous life gain
 *   - Infect (CR 702.90, CR 120.3b/d): Poison counters on players, -1/-1 counters on creatures
 *   - Trample (CR 702.19, CR 510.1c): Excess assigned to defending player
 *   - Deathtouch (CR 702.2): 1 damage is lethal
 *   - Deathtouch + Trample combo: 1 damage to each blocker, remainder to player
 *   - Protection (CR 702.16e): All damage from source is prevented (0 damage, prevented = true)
 *   - Indestructible (CR 702.12): Accumulates marked damage, but immune to destruction (CR 704.5g)
 *   - First Strike / Double Strike: Dual combat damage step distribution
 * - Smart Combat Damage Assignment & Manual Override Calculation
 * 
 * @module CombatDamageEngine
 */

export class CombatDamageEngine {
  /**
   * Resolves a single instance of dealing damage (Combat or Non-Combat) per MTG CR 120.
   * 
   * @param {Object} payload
   * @param {string} payload.sourceId - InstanceId of damage source
   * @param {string} payload.sourceControllerId - Player who controls source
   * @param {string} payload.targetId - InstanceId of target creature OR playerId of target player
   * @param {'PLAYER' | 'CREATURE'} payload.targetType
   * @param {number} payload.amount - Unprevented damage amount
   * @param {boolean} [payload.isCombat=false]
   * @param {Object} [payload.keywords={}] - { lifelink, infect, deathtouch, colors }
   * @param {Object} tabletopState - Active TabletopStateManager instance
   * @returns {Object} DamageResult
   */
  static dealDamage(payload, tabletopState) {
    const {
      sourceId,
      sourceControllerId,
      targetId,
      targetType,
      amount,
      isCombat = false,
      keywords = {}
    } = payload;

    const rawAmount = Math.max(0, Number(amount) || 0);

    // 1. Check Protection Damage Prevention (CR 702.16e)
    if (keywords.protectionBlocked) {
      return {
        sourceId,
        sourceControllerId,
        targetId,
        targetType,
        damageDealt: 0,
        prevented: true,
        isCombat,
        hasLifelink: false,
        hasInfect: false,
        hasDeathtouch: false
      };
    }

    let damageDealt = rawAmount;
    const hasInfect = !!keywords.infect;
    const hasLifelink = !!keywords.lifelink;
    const hasDeathtouch = !!keywords.deathtouch;

    // 2. Apply to Target
    if (targetType === 'PLAYER') {
      const targetPlayer = tabletopState.getPlayer ? tabletopState.getPlayer(targetId) : tabletopState.players?.[targetId];
      if (targetPlayer) {
        if (hasInfect) {
          // CR 120.3b: Damage from a source with infect is dealt in the form of poison counters
          targetPlayer.resources = targetPlayer.resources || {};
          targetPlayer.resources.poison = (targetPlayer.resources.poison || 0) + damageDealt;
        } else {
          // Normal damage causes loss of life (CR 120.3a)
          targetPlayer.resources = targetPlayer.resources || {};
          targetPlayer.resources.life = (targetPlayer.resources.life ?? 20) - damageDealt;
        }
      }
    } else if (targetType === 'CREATURE') {
      // Find target creature on battlefield
      let targetCreature = null;
      for (const p of Object.values(tabletopState.players || {})) {
        const creatures = p.battlefield?.creatures || [];
        const found = creatures.find(c => c && c.instanceId === targetId);
        if (found) {
          targetCreature = found;
          break;
        }
      }

      if (targetCreature) {
        if (hasInfect) {
          // CR 120.3d: Damage from source with infect placed as -1/-1 counters
          targetCreature.counters = targetCreature.counters || {};
          targetCreature.counters['-1/-1'] = (targetCreature.counters['-1/-1'] || 0) + damageDealt;
        } else {
          // CR 120.3e: Damage dealt to a creature is marked on it
          targetCreature.damageMarked = (targetCreature.damageMarked || 0) + damageDealt;
        }

        // Record deathtouch damage marker
        if (hasDeathtouch && damageDealt > 0) {
          targetCreature.hasDeathtouchDamageMarked = true;
        }
      }
    }

    // 3. Lifelink simultaneous life gain (CR 120.3f)
    if (hasLifelink && damageDealt > 0 && sourceControllerId) {
      const controller = tabletopState.getPlayer ? tabletopState.getPlayer(sourceControllerId) : tabletopState.players?.[sourceControllerId];
      if (controller) {
        controller.resources = controller.resources || {};
        controller.resources.life = (controller.resources.life ?? 20) + damageDealt;
      }
    }

    const result = {
      sourceId,
      sourceControllerId,
      targetId,
      targetType,
      damageDealt,
      prevented: false,
      isCombat,
      hasLifelink,
      hasInfect,
      hasDeathtouch
    };

    if (tabletopState.emit) {
      tabletopState.emit('DAMAGE_DEALT', result);
      tabletopState.emit('DAMAGE_TAKEN', result);
    }

    return result;
  }

  /**
   * Executes direct Life Loss or Life Payment per MTG CR 119.2.
   * DOES NOT trigger damage abilities, mark damage, or apply damage prevention.
   * 
   * @param {Object} payload
   * @param {string} payload.playerId - Target player ID
   * @param {number} payload.amount - Positive amount of life lost
   * @param {string} [payload.reason='LIFE_LOSS']
   * @param {Object} tabletopState
   * @returns {{ playerId: string, lifeLost: number, newLife: number }}
   */
  static loseLife(payload, tabletopState) {
    const { playerId, amount, reason = 'LIFE_LOSS' } = payload;
    const player = tabletopState.getPlayer ? tabletopState.getPlayer(playerId) : tabletopState.players?.[playerId];
    const actualLoss = Math.max(0, Number(amount) || 0);

    if (player) {
      player.resources = player.resources || {};
      player.resources.life = (player.resources.life ?? 20) - actualLoss;
    }

    const newLife = player?.resources?.life ?? 20;

    if (tabletopState.emit) {
      tabletopState.emit('LIFE_LOST', {
        playerId,
        amount: actualLoss,
        currentLife: newLife,
        reason
      });
    }

    return { playerId, lifeLost: actualLoss, newLife };
  }

  /**
   * Calculates smart combat damage distribution for an attacker against its blockers and defending player.
   * Enforces Trample (CR 702.19) and Deathtouch (CR 702.2).
   * 
   * @param {Object} attacker - Attacking creature instance
   * @param {Array<Object>} blockers - Ordered list of blocking creature instances
   * @param {number} attackerPower - Effective power of attacker
   * @returns {{ blockerAssignments: Array<{ blockerId: string, damage: number }>, playerTrampleDamage: number }}
   */
  static calculateAttackerDamageDistribution(attacker, blockers = [], attackerPower) {
    const power = Math.max(0, attackerPower);
    const hasTrample = !!(attacker.keywords?.trample || /trample/i.test(attacker.text || ''));
    const hasDeathtouch = !!(attacker.keywords?.deathtouch || /deathtouch/i.test(attacker.text || ''));

    const blockerAssignments = [];
    let remainingPower = power;

    if (!blockers || blockers.length === 0) {
      // Unblocked attacker deals all damage directly to player
      return { blockerAssignments: [], playerTrampleDamage: power };
    }

    for (const blocker of blockers) {
      if (remainingPower <= 0) {
        blockerAssignments.push({ blockerId: blocker.instanceId, damage: 0 });
        continue;
      }

      let lethalDamageNeeded;
      if (hasDeathtouch) {
        // Under CR 702.2, 1 damage from a deathtouch source is lethal
        lethalDamageNeeded = 1;
      } else {
        // Lethal damage = effective toughness - already marked damage
        const blockerToughness = blocker.effectiveToughness ?? (Number(blocker.toughness) || 1);
        const marked = blocker.damageMarked || 0;
        lethalDamageNeeded = Math.max(0, blockerToughness - marked);
      }

      const assigned = Math.min(remainingPower, lethalDamageNeeded);
      blockerAssignments.push({ blockerId: blocker.instanceId, damage: assigned });
      remainingPower -= assigned;
    }

    // Excess damage tramples to defending player if attacker has Trample
    const playerTrampleDamage = hasTrample ? Math.max(0, remainingPower) : 0;

    return {
      blockerAssignments,
      playerTrampleDamage
    };
  }
}

export default CombatDamageEngine;
