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
    if (!tabletopState) return { loopCount: 0, totalActionsApplied: 0, actions: [] };
    const effectiveAbilityEngine = abilityEngine || tabletopState.abilityEngine || null;
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
          if (typeof tabletopState.eliminatePlayer === 'function') {
            tabletopState.eliminatePlayer(pid, 'LIFE_ZERO_OR_LESS');
          } else {
            player.isEliminated = true;
          }
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
          if (typeof tabletopState.eliminatePlayer === 'function') {
            tabletopState.eliminatePlayer(pid, 'POISON_TEN_OR_MORE');
          } else {
            player.isEliminated = true;
          }
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
          let evaluated = card;
          let toughness = Number(card.toughness) || 0;
          if (effectiveAbilityEngine) {
            if (typeof effectiveAbilityEngine.evaluateCreatureStats === 'function') {
              const stats = effectiveAbilityEngine.evaluateCreatureStats(card, tabletopState);
              toughness = stats.toughness ?? stats.effectiveToughness ?? toughness;
              evaluated = effectiveAbilityEngine.evaluatePermanentLayers(card, tabletopState);
            } else if (typeof effectiveAbilityEngine.evaluatePermanentLayers === 'function') {
              evaluated = effectiveAbilityEngine.evaluatePermanentLayers(card, tabletopState);
              toughness = evaluated.effectiveToughness !== undefined 
                ? evaluated.effectiveToughness 
                : (Number(card.toughness) || 0);
            }
          }

          const markedDamage = card.damageMarked || 0;
          const isIndestructible = !!(
            card.isIndestructible ||
            card.keywords?.indestructible ||
            evaluated.keywords?.indestructible ||
            /indestructible/i.test(card.text || '')
          );

          const handleCreatureDiesTriggers = (creatureCard) => {
            if (creatureCard._onDiesResolved) {
              if (tabletopState && typeof tabletopState._unattachCreatureEquipment === 'function') {
                tabletopState._unattachCreatureEquipment(creatureCard);
              }
              return;
            }
            creatureCard._onDiesResolved = true;
            const lastKnownStats = (effectiveAbilityEngine || tabletopState.abilityEngine)?.evaluateCreatureStats
              ? (effectiveAbilityEngine || tabletopState.abilityEngine).evaluateCreatureStats(creatureCard, tabletopState)
              : { power: creatureCard.power ?? 1 };
            const triggers = creatureCard.compiledMechanics?.triggers || [];
            for (const trig of triggers) {
              if (trig.triggerType === 'ON_DIES') {
                if (trig.action === 'DAMAGE_EQUAL_TO_POWER_EACH_OPPONENT' && lastKnownStats.power > 0) {
                  const dmg = Number(lastKnownStats.power);
                  for (const [oppPid, opp] of Object.entries(tabletopState.players || {})) {
                    if (oppPid !== pid && oppPid !== player.id && oppPid !== player.playerId && !opp.isEliminated) {
                      if (typeof tabletopState.adjustLife === 'function') {
                        tabletopState.adjustLife(oppPid, { delta: -dmg });
                      } else if (opp.resources) {
                        opp.resources.life = (opp.resources.life ?? 20) - dmg;
                      }
                      passActions.push({
                        type: 'DIES_TRIGGER_DAMAGE_DEALT',
                        rule: 'CR 603.2',
                        sourceId: creatureCard.instanceId,
                        sourceName: creatureCard.name,
                        targetPlayerId: oppPid,
                        amount: dmg
                      });
                    }
                  }
                }
              }
            }
            if (tabletopState && typeof tabletopState._unattachCreatureEquipment === 'function') {
              tabletopState._unattachCreatureEquipment(creatureCard);
            }
          };

          // CHECK 1: CR 704.5f - Toughness <= 0 (State-Based Death)
          // INVARIANT INV-STATIC-SBA-1: BYPASSES INDESTRUCTIBLE!
          if (toughness <= 0) {
            handleCreatureDiesTriggers(card);
            ZoneTransitionMatrix.moveCard(player, card.instanceId, 'battlefield', 'graveyard');
            (effectiveAbilityEngine || tabletopState.abilityEngine)?.unregisterEffectsFromSource(card.instanceId);
            passActions.push({
              type: 'CREATURE_DIED_ZERO_TOUGHNESS',
              rule: 'CR 704.5f',
              playerId: pid,
              cardId: card.instanceId,
              cardName: card.name,
              markedDamage,
              toughness,
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
            handleCreatureDiesTriggers(card);
            ZoneTransitionMatrix.moveCard(player, card.instanceId, 'battlefield', 'graveyard');
            (effectiveAbilityEngine || tabletopState.abilityEngine)?.unregisterEffectsFromSource(card.instanceId);
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
            handleCreatureDiesTriggers(card);
            ZoneTransitionMatrix.moveCard(player, card.instanceId, 'battlefield', 'graveyard');
            (effectiveAbilityEngine || tabletopState.abilityEngine)?.unregisterEffectsFromSource(card.instanceId);
            passActions.push({
              type: 'CREATURE_DESTROYED_DEATHTOUCH',
              rule: 'CR 704.5h',
              playerId: pid,
              cardId: card.instanceId,
              cardName: card.name,
              markedDamage,
              toughness
            });
            continue;
          }
        }
      }

      // 5. CR 704.5j: Legend Rule
      for (const [pid, player] of Object.entries(tabletopState.players || {})) {
        const perms = [];
        if (Array.isArray(player.battlefield)) {
          perms.push(...player.battlefield);
        } else if (player.battlefield && typeof player.battlefield === 'object') {
          for (const sub of ['lands', 'creatures', 'noncreatures', 'planeswalkers']) {
            if (Array.isArray(player.battlefield[sub])) {
              perms.push(...player.battlefield[sub]);
            }
          }
        }

        const legendariesByName = new Map();
        for (const card of perms) {
          if (!card) continue;
          const isLegendary = Boolean(
            /legendary/i.test(card.typeLine || card.type || '') ||
            card.isLegendary ||
            (Array.isArray(card.supertypes) && card.supertypes.includes('Legendary'))
          );
          if (isLegendary && card.name) {
            if (!legendariesByName.has(card.name)) {
              legendariesByName.set(card.name, []);
            }
            legendariesByName.get(card.name).push(card);
          }
        }

        for (const [name, cards] of legendariesByName.entries()) {
          if (cards.length > 1) {
            const [kept, ...duplicates] = cards;
            for (const dup of duplicates) {
              const moved = ZoneTransitionMatrix.moveCard(player, dup.instanceId, 'battlefield', 'graveyard');
              (effectiveAbilityEngine || tabletopState.abilityEngine)?.unregisterEffectsFromSource(dup.instanceId);
              passActions.push({
                type: 'LEGEND_RULE_APPLIED',
                rule: 'CR 704.5j',
                playerId: pid,
                cardId: dup.instanceId,
                graveyardInstanceId: moved?.card?.instanceId || dup.instanceId,
                cardName: name,
                keptCardId: kept.instanceId
              });
            }
          }
        }
      }

      // 6. CR 704.5d: Tokens outside battlefield cease to exist
      for (const [pid, player] of Object.entries(tabletopState.players || {})) {
        const nonBattlefieldZones = ['graveyard', 'exile', 'hand', 'library'];
        for (const zoneName of nonBattlefieldZones) {
          const zoneCards = player[zoneName];
          if (Array.isArray(zoneCards)) {
            for (let i = zoneCards.length - 1; i >= 0; i--) {
              const card = zoneCards[i];
              if (card && card.isToken) {
                zoneCards.splice(i, 1);
                passActions.push({
                  type: 'TOKEN_CEASED_TO_EXIST',
                  rule: 'CR 704.5d',
                  playerId: pid,
                  cardId: card.instanceId,
                  cardName: card.name,
                  zone: zoneName
                });
              }
            }
          }
          if (player.zones && Array.isArray(player.zones[zoneName])) {
            const zCards = player.zones[zoneName];
            for (let i = zCards.length - 1; i >= 0; i--) {
              const card = zCards[i];
              if (card && card.isToken) {
                zCards.splice(i, 1);
              }
            }
          }
        }
      }

      if (Array.isArray(tabletopState.stack)) {
        for (let i = tabletopState.stack.length - 1; i >= 0; i--) {
          const item = tabletopState.stack[i];
          const card = item?.card || item;
          if (card && card.isToken) {
            tabletopState.stack.splice(i, 1);
            passActions.push({
              type: 'TOKEN_CEASED_TO_EXIST',
              rule: 'CR 704.5d',
              cardId: card.instanceId,
              cardName: card.name,
              zone: 'stack'
            });
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

    if (allActions.length > 0 && typeof tabletopState.recordTrace === 'function') {
      tabletopState.recordTrace('SBA_TRACE', 'SBA_APPLIED', {
        cycleCount: loopCount,
        actions: allActions
      });
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
