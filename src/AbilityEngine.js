/**
 * AbilityEngine.js - MTG CR 602, 603, 604 & CR 613 Abilities & Continuous Layers Engine
 * 
 * Part of RPM Multiplayer - Feature 21
 * Specification: SPEC-RPM-RULES-ENGINE-021 (INV-ABILITY-ENGINE-1, INV-STATIC-SBA-1)
 * 
 * Implements:
 * - CR 602: Activated Abilities (Cost : Effect, tap cost, life payment, sacrifice)
 * - CR 603: Triggered Abilities (APNAP LIFO Stack Ordering, ETB, Dies, Upkeep)
 * - CR 604 & CR 613: Comprehensive 7-Layer Continuous Effects System:
 *     Layer 1: Copy effects
 *     Layer 2: Control-changing effects
 *     Layer 3: Text-changing effects
 *     Layer 4: Type-changing effects
 *     Layer 5: Color-changing effects
 *     Layer 6: Ability-granting and ability-removing effects
 *     Layer 7: Power/Toughness modifications (7a-7e)
 * - Grounding for INV-STATIC-SBA-1 (1/1 Indestructible entering under -1/-1 static debuff has toughness 0)
 * 
 * @module AbilityEngine
 */

/**
 * 7-Layer Continuous Effect Architecture per MTG CR 613
 */
export const CONTINUOUS_LAYERS = Object.freeze({
  LAYER_1_COPY: 1,
  LAYER_2_CONTROL: 2,
  LAYER_3_TEXT: 3,
  LAYER_4_TYPE: 4,
  LAYER_5_COLOR: 5,
  LAYER_6_ABILITY: 6,
  LAYER_7A_CDA_PT: 7.1,
  LAYER_7B_SET_PT: 7.2,
  LAYER_7C_MODIFY_PT: 7.3,
  LAYER_7D_COUNTERS_PT: 7.4,
  LAYER_7E_SWITCH_PT: 7.5
});

export class AbilityEngine {
  constructor() {
    this.staticEffects = []; // Array of registered continuous effects
    this.triggeredQueue = []; // Staged triggers awaiting stack placement
  }

  // ==========================================
  // CR 602: Activated Abilities
  // ==========================================

  /**
   * Validates if an activated ability can legally be activated by a player.
   * 
   * @param {Object} permanent - Source battlefield card instance
   * @param {Object} ability - Activated ability definition
   * @param {Object} context - Game context (player, priorityPlayerId, isMainPhase, stackEmpty)
   * @returns {{ canActivate: boolean, error: string|null }}
   */
  static canActivateAbility(permanent, ability, context = {}) {
    if (!permanent || !ability) {
      return { canActivate: false, error: 'PERMANENT_OR_ABILITY_MISSING' };
    }

    const { playerId, priorityPlayerId, isMainPhase = true, stackEmpty = true } = context;

    // Check Priority (unless mana ability)
    if (!ability.isManaAbility && priorityPlayerId && priorityPlayerId !== playerId) {
      return { canActivate: false, error: 'NO_PRIORITY' };
    }

    // Check Sorcery Timing Restriction if specified
    if (ability.timing === 'SORCERY') {
      if (!isMainPhase || !stackEmpty) {
        return { canActivate: false, error: 'SORCERY_SPEED_RESTRICTION' };
      }
    }

    // Check Tap Cost {T}
    if (ability.cost?.tap) {
      if (permanent.isTapped) {
        return { canActivate: false, error: 'PERMANENT_ALREADY_TAPPED' };
      }
      // Summoning Sickness: Creatures cannot tap for abilities unless they have Haste
      const isCreature = /creature/i.test(permanent.typeLine || permanent.type || '');
      if (isCreature && permanent.hasSummoningSickness && !permanent.keywords?.haste && !permanent.hasHaste) {
        return { canActivate: false, error: 'SUMMONING_SICKNESS' };
      }
    }

    // Check Life Payment Cost
    if (ability.cost?.life) {
      const currentLife = context.player?.resources?.life ?? 20;
      if (currentLife < ability.cost.life) {
        return { canActivate: false, error: 'INSUFFICIENT_LIFE' };
      }
    }

    return { canActivate: true, error: null };
  }

  /**
   * Constructs an authoritative Stack Item for an activated ability per CR 602.2.
   * 
   * @param {Object} permanent - Source card
   * @param {Object} ability - Activated ability definition
   * @param {string} controllerId - Player activating the ability
   * @param {Object} [payload={}] - Targets and parameters
   * @returns {Object} StackItem
   */
  static createActivatedAbilityStackItem(permanent, ability, controllerId, payload = {}) {
    const timestamp = Date.now();
    const hex = Math.random().toString(36).substring(2, 9);
    return {
      id: `ability_${timestamp}_${hex}`,
      sourceId: permanent.instanceId,
      sourceName: permanent.name,
      controllerId,
      type: 'ACTIVATED_ABILITY',
      abilityId: ability.id || `act_${permanent.instanceId}`,
      abilityText: ability.text || ability.description || 'Activated ability',
      cost: ability.cost || {},
      effect: ability.effect,
      targets: payload.targets || [],
      timestamp
    };
  }

  // ==========================================
  // CR 603: Triggered Abilities (APNAP Order)
  // ==========================================

  /**
   * Pushes a triggered ability into the pending queue.
   * 
   * @param {Object} trigger - { sourceId, controllerId, event, effect, text }
   */
  queueTrigger(trigger) {
    if (trigger) {
      this.triggeredQueue.push({
        ...trigger,
        queuedAt: Date.now()
      });
    }
  }

  /**
   * Orders pending triggers onto the stack according to APNAP (Active Player, Non-Active Player) rules (CR 603.3b).
   * Active Player's triggers are put on the stack first in their chosen order,
   * followed by Non-Active Player's triggers.
   * As a result, Non-Active Player's triggers resolve first (LIFO order).
   * 
   * @param {string} activePlayerId - ID of active player
   * @param {Array<string>} turnOrder - Player IDs in turn order [active, opponent1, ...]
   * @returns {Array<Object>} Ordered stack items to push onto tabletop stack
   */
  flushTriggersAPNAP(activePlayerId, turnOrder = []) {
    if (this.triggeredQueue.length === 0) return [];

    const activePlayerTriggers = [];
    const nonActivePlayerTriggers = [];

    for (const trig of this.triggeredQueue) {
      if (trig.controllerId === activePlayerId) {
        activePlayerTriggers.push(trig);
      } else {
        nonActivePlayerTriggers.push(trig);
      }
    }

    // Clear queue
    this.triggeredQueue = [];

    // APNAP order onto stack: Active Player first, then Non-Active
    // Stack is LIFO, so Non-Active Player triggers will sit on top and resolve first!
    const stackItems = [...activePlayerTriggers, ...nonActivePlayerTriggers].map(trig => {
      const timestamp = Date.now();
      const hex = Math.random().toString(36).substring(2, 9);
      return {
        id: `trigger_${timestamp}_${hex}`,
        sourceId: trig.sourceId,
        sourceName: trig.sourceName || 'Triggered Ability',
        controllerId: trig.controllerId,
        type: 'TRIGGERED_ABILITY',
        abilityText: trig.text || `${trig.event || 'Trigger'} ability`,
        effect: trig.effect,
        targets: trig.targets || [],
        timestamp
      };
    });

    return stackItems;
  }

  // ==========================================
  // CR 604 & CR 613: 7-Layer Continuous Effects
  // ==========================================

  /**
   * Registers a static continuous effect into the layer engine.
   * 
   * @param {Object} effect
   * @param {string} effect.id - Unique ID
   * @param {string} effect.sourceId - InstanceId of source permanent
   * @param {number} effect.layer - One of CONTINUOUS_LAYERS
   * @param {Function} effect.apply - Function (card, context) => card
   * @param {Function} [effect.appliesTo] - Filter function (card) => boolean
   */
  registerStaticEffect(effect) {
    if (effect && effect.id && effect.layer) {
      // Remove existing with same id if any
      this.unregisterStaticEffect(effect.id);
      this.staticEffects.push(effect);
      // Keep sorted by layer ascending, then timestamp
      this.staticEffects.sort((a, b) => (a.layer - b.layer) || (a.timestamp || 0) - (b.timestamp || 0));
    }
  }

  unregisterStaticEffect(effectId) {
    this.staticEffects = this.staticEffects.filter(e => e.id !== effectId);
  }

  unregisterEffectsFromSource(sourceId) {
    this.staticEffects = this.staticEffects.filter(e => e.sourceId !== sourceId);
  }

  /**
   * Recalculates effective characteristics for a permanent through all 7 continuous layers.
   * Enforces INV-STATIC-SBA-1: P/T modifications in Layer 7c are computed authoritatively.
   * 
   * @param {Object} card - Card instance from battlefield
   * @param {Object} [context={}] - Tabletop state context
   * @returns {Object} Recalculated card with effectivePower, effectiveToughness, keywords
   */
  evaluatePermanentLayers(card, context = {}) {
    if (!card) return card;

    // Initialize base values from printed card characteristics
    const isCreature = /creature/i.test(card.typeLine || card.type || '');
    const basePower = Number(card.power ?? card.basePower ?? 0) || 0;
    const baseToughness = Number(card.toughness ?? card.baseToughness ?? 0) || 0;

    const evaluated = {
      ...card,
      basePower,
      baseToughness,
      effectivePower: basePower,
      effectiveToughness: baseToughness,
      grantedAbilities: [...(card.grantedAbilities || [])],
      keywords: { ...(card.keywords || {}) }
    };

    // If card has inherent Indestructible keyword, record it
    if (/indestructible/i.test(card.text || '') || card.isIndestructible || card.keywords?.indestructible) {
      evaluated.keywords.indestructible = true;
      evaluated.isIndestructible = true;
    }

    // Iterate through all registered continuous effects in strict layer order
    for (const effect of this.staticEffects) {
      if (effect.appliesTo && !effect.appliesTo(evaluated, context)) {
        continue;
      }

      switch (effect.layer) {
        case CONTINUOUS_LAYERS.LAYER_4_TYPE:
          if (effect.apply) effect.apply(evaluated, context);
          break;

        case CONTINUOUS_LAYERS.LAYER_5_COLOR:
          if (effect.apply) effect.apply(evaluated, context);
          break;

        case CONTINUOUS_LAYERS.LAYER_6_ABILITY:
          if (effect.grantedKeywords) {
            Object.assign(evaluated.keywords, effect.grantedKeywords);
          }
          if (effect.removedKeywords) {
            for (const kw of effect.removedKeywords) {
              delete evaluated.keywords[kw];
            }
          }
          if (effect.apply) effect.apply(evaluated, context);
          break;

        case CONTINUOUS_LAYERS.LAYER_7B_SET_PT:
          if (isCreature && effect.setPower !== undefined) evaluated.effectivePower = effect.setPower;
          if (isCreature && effect.setToughness !== undefined) evaluated.effectiveToughness = effect.setToughness;
          break;

        case CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT:
          // e.g. Static -1/-1 debuff (Night of Souls' Betrayal, Elesh Norn)
          if (isCreature) {
            evaluated.effectivePower += (effect.powerMod || 0);
            evaluated.effectiveToughness += (effect.toughnessMod || 0);
          }
          break;

        case CONTINUOUS_LAYERS.LAYER_7D_COUNTERS_PT:
          // Counters: +1/+1 and -1/-1 counters
          if (isCreature && evaluated.counters) {
            const p1 = evaluated.counters['+1/+1'] || 0;
            const m1 = evaluated.counters['-1/-1'] || 0;
            evaluated.effectivePower += (p1 - m1);
            evaluated.effectiveToughness += (p1 - m1);
          }
          break;

        case CONTINUOUS_LAYERS.LAYER_7E_SWITCH_PT:
          if (isCreature && effect.switchPT) {
            const temp = evaluated.effectivePower;
            evaluated.effectivePower = evaluated.effectiveToughness;
            evaluated.effectiveToughness = temp;
          }
          break;

        default:
          if (effect.apply) effect.apply(evaluated, context);
          break;
      }
    }

    return evaluated;
  }
}

export default AbilityEngine;
