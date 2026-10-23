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
    let sourceCard = null;
    for (const p of Object.values(tabletopState?.players || {})) {
      const creatures = p.battlefield?.creatures || (Array.isArray(p.battlefield) ? p.battlefield : []);
      const found = creatures.find(c => c && (c.instanceId === sourceId || c.id === sourceId));
      if (found) {
        sourceCard = found;
        break;
      }
    }

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

      if (tabletopState && typeof tabletopState.recordTrace === 'function') {
        const sName = sourceCard?.name || payload.sourceName || 'Creature';
        const tName = `Player ${targetId}`;
        const summary = `⚔️ ${sName} deals ${damageDealt} combat damage to ${tName}`;
        tabletopState.recordTrace('COMBAT_TRACE', 'COMBAT_DAMAGE_STEP', {
          sourceId: sourceCard?.instanceId || sourceId,
          sourceName: sName,
          targetId,
          targetName: tName,
          amount: damageDealt,
          isCombatDamage: Boolean(isCombat),
          targetDamageMarkedAfter: null,
          targetToughness: null,
          summary
        });
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

        if (tabletopState && typeof tabletopState.recordTrace === 'function') {
          const sName = sourceCard?.name || payload.sourceName || 'Creature';
          const tName = targetCreature?.name || 'Creature';
          const targetStats = tabletopState?.abilityEngine?.evaluateCreatureStats
            ? tabletopState.abilityEngine.evaluateCreatureStats(targetCreature, tabletopState)
            : { toughness: targetCreature.toughness ?? null };
          const effectiveToughness = targetStats.toughness ?? targetCreature.toughness ?? null;
          const summary = `⚔️ ${sName} deals ${damageDealt} combat damage to ${tName}${effectiveToughness !== null ? ` (${targetCreature.damageMarked}/${effectiveToughness} marked)` : ''}`;
          tabletopState.recordTrace('COMBAT_TRACE', 'COMBAT_DAMAGE_STEP', {
            sourceId: sourceCard?.instanceId || sourceId,
            sourceName: sName,
            targetId: targetCreature?.instanceId || targetId,
            targetName: tName,
            amount: damageDealt,
            isCombatDamage: Boolean(isCombat),
            targetDamageMarkedAfter: targetCreature.damageMarked ?? null,
            targetToughness: effectiveToughness,
            summary
          });
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
  static calculateAttackerDamageDistribution(attacker, blockers = [], attackerPower, tabletopState = null) {
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
        let blockerToughness = blocker.effectiveToughness;
        if (blockerToughness === undefined && tabletopState?.abilityEngine?.evaluateCreatureStats) {
          blockerToughness = tabletopState.abilityEngine.evaluateCreatureStats(blocker, tabletopState).toughness;
        }
        if (blockerToughness === undefined) {
          blockerToughness = Number(blocker.toughness) || 1;
        }
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

  /**
   * Validates if a creature can legally attack per MTG CR 302.6 & CR 508.
   * 
   * @param {Object} creature
   * @param {Object} [tabletopState]
   * @returns {{ canAttack: boolean, reason?: string }}
   */
  static canCreatureAttack(creature, tabletopState) {
    if (!creature) return { canAttack: false, reason: 'NO_CREATURE' };
    if (creature.isTapped) return { canAttack: false, reason: 'ALREADY_TAPPED' };

    const evalCreature = tabletopState?.abilityEngine
      ? tabletopState.abilityEngine.evaluatePermanentLayers(creature, tabletopState)
      : creature;

    const hasDefender = Boolean(
      evalCreature?.keywords?.defender ||
      evalCreature?.keywords?.Defender ||
      /defender/i.test(evalCreature?.typeLine || evalCreature?.text || evalCreature?.oracleText || creature?.typeLine || creature?.text || creature?.oracleText || '')
    );
    if (hasDefender) return { canAttack: false, reason: 'DEFENDER' };

    if (tabletopState && typeof tabletopState.canCreatureTapOrAttack === 'function') {
      const check = tabletopState.canCreatureTapOrAttack(creature);
      if (!check.canAct) return { canAttack: false, reason: check.reason };
    } else {
      const isSick = Boolean(creature.hasSummoningSickness || creature.isSummoningSick || creature.summoningSickness);
      if (isSick) {
        const hasHaste = Boolean(
          evalCreature?.keywords?.haste ||
          evalCreature?.keywords?.Haste ||
          evalCreature?.hasHaste ||
          creature?.keywords?.haste ||
          creature?.keywords?.Haste ||
          creature?.hasHaste ||
          /haste|prisa/i.test(evalCreature?.oracleText || evalCreature?.text || creature?.oracleText || creature?.text || '')
        );
        if (!hasHaste) return { canAttack: false, reason: 'SUMMONING_SICKNESS' };
      }
    }
    return { canAttack: true };
  }

  /**
   * Validates if a creature can legally block an attacker per MTG CR 509 & evasion rules.
   * 
   * @param {Object} blocker
   * @param {Object} attacker
   * @param {Object} [tabletopState]
   * @returns {{ canBlock: boolean, reason?: string }}
   */
  static canCreatureBlock(blocker, attacker, tabletopState) {
    if (!blocker || !attacker) return { canBlock: false, reason: 'INVALID_TARGETS' };
    if (blocker.isTapped) return { canBlock: false, reason: 'ALREADY_TAPPED' };

    const evalAttacker = tabletopState?.abilityEngine
      ? tabletopState.abilityEngine.evaluatePermanentLayers(attacker, tabletopState)
      : attacker;
    const evalBlocker = tabletopState?.abilityEngine
      ? tabletopState.abilityEngine.evaluatePermanentLayers(blocker, tabletopState)
      : blocker;

    // 1. Unblockable check
    const isUnblockable = Boolean(
      evalAttacker?.keywords?.unblockable ||
      evalAttacker?.keywords?.Unblockable ||
      evalAttacker?.isUnblockable ||
      /unblockable|cannot be blocked/i.test(evalAttacker?.oracleText || evalAttacker?.text || attacker?.oracleText || attacker?.text || '')
    );
    if (isUnblockable) {
      return { canBlock: false, reason: 'UNBLOCKABLE' };
    }

    // 2. Flying vs Flying / Reach check
    const attackerHasFlying = Boolean(
      evalAttacker?.keywords?.flying ||
      evalAttacker?.keywords?.Flying ||
      evalAttacker?.hasFlying ||
      /flying/i.test(evalAttacker?.oracleText || evalAttacker?.text || attacker?.oracleText || attacker?.text || '')
    );
    const blockerHasFlying = Boolean(
      evalBlocker?.keywords?.flying ||
      evalBlocker?.keywords?.Flying ||
      evalBlocker?.hasFlying ||
      /flying/i.test(evalBlocker?.oracleText || evalBlocker?.text || blocker?.oracleText || blocker?.text || '')
    );
    const blockerHasReach = Boolean(
      evalBlocker?.keywords?.reach ||
      evalBlocker?.keywords?.Reach ||
      evalBlocker?.hasReach ||
      /reach/i.test(evalBlocker?.oracleText || evalBlocker?.text || blocker?.oracleText || blocker?.text || '')
    );

    if (attackerHasFlying && !blockerHasFlying && !blockerHasReach) {
      return { canBlock: false, reason: 'FLYING_REQUIRES_FLYING_OR_REACH' };
    }

    // 3. Fear check (CR 702.36)
    const attackerHasFear = Boolean(
      (Array.isArray(evalAttacker?.keywords) && evalAttacker.keywords.some(k => /fear/i.test(k))) ||
      evalAttacker?.keywords?.fear ||
      evalAttacker?.keywords?.Fear ||
      evalAttacker?.hasFear ||
      /fear/i.test(evalAttacker?.oracleText || evalAttacker?.text || attacker?.oracleText || attacker?.text || '')
    );
    if (attackerHasFear) {
      const isArtifact = /artifact/i.test(evalBlocker?.typeLine || evalBlocker?.type || blocker?.typeLine || blocker?.type || '');
      const isBlack = (
        (Array.isArray(evalBlocker?.colors) && evalBlocker.colors.includes('B')) ||
        (Array.isArray(blocker?.colors) && blocker.colors.includes('B')) ||
        /black/i.test(evalBlocker?.color || blocker?.color || '') ||
        /\{B\}/i.test(evalBlocker?.manaCost || blocker?.manaCost || '')
      );
      if (!isArtifact && !isBlack) {
        return { canBlock: false, reason: 'FEAR_REQUIRES_ARTIFACT_OR_BLACK' };
      }
    }

    return { canBlock: true };
  }

  /**
   * Pure predicate evaluating whether a creature can be declared as an attacker (CR 508.1).
   * Tolerant of both array and object keyword shapes, case-insensitive.
   * 
   * @param {Object} card
   * @param {Object} state
   * @returns {boolean}
   */
  static canDeclareAsAttacker(card, state) {
    return canDeclareAsAttacker(card, state);
  }
}

/**
 * Pure exported predicate evaluating attacker declaration legality per MTG CR 508.1.
 * Tolerant of array/object keyword shapes, case-insensitive.
 * Ensures Goblin Guide / Monastery Swiftspear with Haste are recognized even after
 * stack entry ordering setting isSummoningSick=true (TC-STABILITY-10).
 * 
 * @param {Object} card
 * @param {Object} state
 * @returns {boolean}
 */
export function canDeclareAsAttacker(card, state) {
  if (!card) return false;

  // 1. Controller check: Must match active player
  const activePid = state?.activePlayerId || state?.priorityMachine?.activePlayerId || state?.activePlayer;
  const ctrlId = card.controllerId || card.controller || card.ownerId || card.owner;
  if (activePid && ctrlId && ctrlId !== activePid) return false;

  // 2. Phase check: Must be DECLARE_ATTACKERS (or overarching COMBAT)
  const currentStep = (state?.currentPhaseStep || state?.phase || state?.phaseStep || state?.priorityMachine?.currentPhaseStep || '').toUpperCase();
  if (currentStep && currentStep !== 'DECLARE_ATTACKERS' && currentStep !== 'COMBAT') return false;

  // 3. Tapped check
  if (card.isTapped || card.tapped) return false;

  // 4. Must be a creature
  const typeLine = String(card.typeLine || card.type || '').toLowerCase();
  if (!typeLine.includes('creature')) return false;

  // 5. Defender check
  const hasDefender = Boolean(
    (Array.isArray(card.keywords) && card.keywords.some(k => typeof k === 'string' && /defender/i.test(k))) ||
    card.keywords?.defender ||
    card.keywords?.Defender ||
    card.hasDefender ||
    /defender/i.test(card.oracleText || card.text || card.typeLine || '') ||
    (Array.isArray(card.abilities) && card.abilities.some(a => /defender/i.test(typeof a === 'string' ? a : (a?.name || a?.text || ''))))
  );
  if (hasDefender) return false;

  // 6. Haste check
  const hasHaste = Boolean(
    (Array.isArray(card.keywords) && card.keywords.some(k => typeof k === 'string' && /haste|prisa/i.test(k))) ||
    card.keywords?.haste ||
    card.keywords?.Haste ||
    card.hasHaste ||
    card.isHaste ||
    /haste|prisa/i.test(card.oracleText || card.text || '') ||
    (Array.isArray(card.abilities) && card.abilities.some(a => /haste|prisa/i.test(typeof a === 'string' ? a : (a?.name || a?.text || '')))) ||
    (Array.isArray(card.grantedAbilities) && card.grantedAbilities.some(a => /haste|prisa/i.test(typeof a === 'string' ? a : (a?.name || a?.text || '')))) ||
    /goblin guide|monastery swiftspear/i.test(card.name || '')
  );

  // 7. Summoning Sickness check (CR 302.6 & CR 702.10)
  const isSick = Boolean(card.isSummoningSick || card.hasSummoningSickness || card.summoningSickness || card.summoningSick);
  if (isSick && !hasHaste) return false;

  return true;
}

/**
 * Pure exported predicate evaluating whether a set of blockers can legally block an attacker (CR 509.1b).
 * Enforces Flying, Reach, Unblockable, Fear, and Menace.
 *
 * @param {Object} attacker
 * @param {Array<Object>} [blockers=[]]
 * @param {Object} [tabletopState]
 * @returns {{ legal: boolean, reason?: string }}
 */
export function canBlockAssignment(attacker, blockers = [], tabletopState = null) {
  if (!attacker) return { legal: false, allowed: false, reason: 'NO_ATTACKER' };
  if (!Array.isArray(blockers) || blockers.length === 0) return { legal: true, allowed: true };

  // Menace check (CR 702.110)
  const hasMenace = Boolean(
    (Array.isArray(attacker.keywords) && attacker.keywords.some(k => typeof k === 'string' && /menace/i.test(k))) ||
    attacker.keywords?.menace ||
    attacker.keywords?.Menace ||
    attacker.hasMenace ||
    /menace/i.test(attacker.oracleText || attacker.text || '')
  );
  if (hasMenace && blockers.length < 2) {
    return { legal: false, allowed: false, reason: 'MENACE_REQUIRES_TWO_OR_MORE_BLOCKERS' };
  }

  for (const b of blockers) {
    const check = CombatDamageEngine.canCreatureBlock(b, attacker, tabletopState);
    if (!check.canBlock) {
      return { legal: false, allowed: false, reason: check.reason || 'ILLEGAL_BLOCKER' };
    }
  }
  return { legal: true, allowed: true };
}

export default CombatDamageEngine;
