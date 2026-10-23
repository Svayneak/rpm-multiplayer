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
  constructor(options = {}) {
    this.staticEffects = []; // Array of registered continuous effects
    this.triggeredQueue = []; // Staged triggers awaiting stack placement
    this._nextTimestamp = 0;
    this.tabletopState = options.tabletopState || null;
    this.traceLogger = options.traceLogger || null;
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
      const isSick = Boolean(permanent.hasSummoningSickness || permanent.isSummoningSick || permanent.summoningSickness);
      if (isCreature && isSick) {
        let evalCard = permanent;
        const engine = context.tabletopState?.abilityEngine || context.abilityEngine;
        if (engine && typeof engine.evaluatePermanentLayers === 'function') {
          evalCard = engine.evaluatePermanentLayers(permanent, context.tabletopState || context);
        }
        const hasHaste = Boolean(
          evalCard?.keywords?.haste ||
          evalCard?.keywords?.Haste ||
          evalCard?.hasHaste ||
          permanent?.keywords?.haste ||
          permanent?.keywords?.Haste ||
          permanent?.hasHaste ||
          /haste|prisa/i.test(evalCard?.oracleText || evalCard?.text || permanent?.oracleText || permanent?.text || '') ||
          (Array.isArray(evalCard?.grantedAbilities) && evalCard.grantedAbilities.some(a =>
            typeof a === 'string' ? /haste|prisa/i.test(a) : /haste|prisa/i.test(a?.name || a?.text || '')
          )) ||
          (Array.isArray(permanent?.grantedAbilities) && permanent.grantedAbilities.some(a =>
            typeof a === 'string' ? /haste|prisa/i.test(a) : /haste|prisa/i.test(a?.name || a?.text || '')
          ))
        );
        if (!hasHaste) {
          return { canActivate: false, error: 'SUMMONING_SICKNESS' };
        }
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
      const entry = {
        ...trigger,
        queuedAt: Date.now()
      };
      this.triggeredQueue.push(entry);

      const state = this.tabletopState || this._tabletopState;
      if (state && typeof state.recordTrace === 'function') {
        state.recordTrace('TRIGGER_TRACE', 'TRIGGER_QUEUED', {
          sourceId: trigger.sourceId,
          sourceName: trigger.sourceName || trigger.name || 'Ability',
          controllerId: trigger.controllerId,
          triggerCondition: trigger.triggerCondition || trigger.event || 'ABILITY',
          text: trigger.text || null
        });
      } else if (this.traceLogger && typeof this.traceLogger.record === 'function') {
        this.traceLogger.record({
          category: 'TRIGGER_TRACE',
          action: 'TRIGGER_QUEUED',
          payload: {
            sourceId: trigger.sourceId,
            sourceName: trigger.sourceName || trigger.name || 'Ability',
            controllerId: trigger.controllerId,
            triggerCondition: trigger.triggerCondition || trigger.event || 'ABILITY',
            text: trigger.text || null
          }
        });
      }

      if (state && typeof state.emit === 'function') {
        state.emit('TRIGGER_QUEUED', entry);
      }
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
        triggerCondition: trig.triggerCondition || trig.event || 'ABILITY',
        abilityText: trig.text || `${trig.event || 'Trigger'} ability`,
        effect: trig.effect,
        targets: trig.targets || [],
        timestamp
      };
    });

    const state = this.tabletopState || this._tabletopState;
    if (state && typeof state.recordTrace === 'function') {
      state.recordTrace('TRIGGER_TRACE', 'TRIGGER_FLUSHED_APNAP', {
        flushedCount: stackItems.length,
        triggers: stackItems.map(t => ({
          id: t.id,
          sourceId: t.sourceId,
          controllerId: t.controllerId,
          triggerCondition: t.triggerCondition
        }))
      });
    } else if (this.traceLogger && typeof this.traceLogger.record === 'function') {
      this.traceLogger.record({
        category: 'TRIGGER_TRACE',
        action: 'TRIGGER_FLUSHED_APNAP',
        payload: {
          flushedCount: stackItems.length,
          triggers: stackItems.map(t => ({
            id: t.id,
            sourceId: t.sourceId,
            controllerId: t.controllerId,
            triggerCondition: t.triggerCondition
          }))
        }
      });
    }

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
    if (effect && effect.layer) {
      if (!effect.id) {
        effect.id = `static_${effect.sourceId || Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      }
      if (effect.timestamp === undefined || effect.timestamp === null) {
        this._nextTimestamp = (this._nextTimestamp || 0) + 1;
        effect.timestamp = this._nextTimestamp;
      }
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
    let isCreature = /creature/i.test(card.typeLine || card.type || '');
    const basePower = Number(card.power ?? card.basePower ?? 0) || 0;
    const baseToughness = Number(card.toughness ?? card.baseToughness ?? 0) || 0;

    const normalizedKeywords = Array.isArray(card.keywords)
      ? card.keywords.reduce((acc, k) => {
          if (typeof k === 'string') {
            acc[k] = true;
            acc[k.toLowerCase()] = true;
          }
          return acc;
        }, {})
      : { ...(card.keywords || {}) };

    const evaluated = {
      ...card,
      basePower,
      baseToughness,
      effectivePower: basePower,
      effectiveToughness: baseToughness,
      grantedAbilities: [...(card.grantedAbilities || [])],
      keywords: normalizedKeywords
    };

    // If card has inherent Indestructible keyword, record it
    if (/indestructible/i.test(card.text || '') || card.isIndestructible || card.keywords?.indestructible) {
      evaluated.keywords.indestructible = true;
      evaluated.isIndestructible = true;
    }

    if (card.strippedProtectionUntilEOT || evaluated.strippedProtectionUntilEOT) {
      evaluated.isIndestructible = false;
      delete evaluated.keywords.indestructible;
      delete evaluated.keywords.Indestructible;
      delete evaluated.keywords.hexproof;
      delete evaluated.keywords.Hexproof;
    }

    let countersApplied = false;
    const applyCounters = () => {
      if (countersApplied) return;
      countersApplied = true;
      if (isCreature && evaluated.counters) {
        const p1 = Number(evaluated.counters['+1/+1'] || 0);
        const m1 = Number(evaluated.counters['-1/-1'] || 0);
        evaluated.effectivePower += (p1 - m1);
        evaluated.effectiveToughness += (p1 - m1);
      }
    };

    // Iterate through all registered continuous effects in strict layer order
    for (const effect of this.staticEffects) {
      if (effect.targetId && (evaluated.instanceId !== effect.targetId && evaluated.id !== effect.targetId)) {
        continue;
      }

      if (effect.appliesTo && !effect.appliesTo(evaluated, context)) {
        continue;
      }

      switch (effect.layer) {
        case CONTINUOUS_LAYERS.LAYER_4_TYPE:
          if (effect.apply) effect.apply(evaluated, context);
          isCreature = /creature/i.test(evaluated.typeLine || evaluated.type || '');
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

        case CONTINUOUS_LAYERS.LAYER_7A_CDA_PT:
          isCreature = /creature/i.test(evaluated.typeLine || evaluated.type || '');
          if (isCreature) {
            if (effect.apply) {
              effect.apply(evaluated, context);
            } else {
              if (effect.setPower !== undefined) evaluated.effectivePower = effect.setPower;
              if (effect.setToughness !== undefined) evaluated.effectiveToughness = effect.setToughness;
            }
          }
          break;

        case CONTINUOUS_LAYERS.LAYER_7B_SET_PT:
          isCreature = /creature/i.test(evaluated.typeLine || evaluated.type || '');
          if (isCreature) {
            if (effect.setPower !== undefined) evaluated.effectivePower = effect.setPower;
            if (effect.setToughness !== undefined) evaluated.effectiveToughness = effect.setToughness;
            if (effect.apply) effect.apply(evaluated, context);
          }
          break;

        case CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT:
          isCreature = /creature/i.test(evaluated.typeLine || evaluated.type || '');
          // e.g. Static -1/-1 debuff (Night of Souls' Betrayal, Elesh Norn) or Prowess buff
          if (isCreature) {
            evaluated.effectivePower += (effect.powerMod || effect.powerDelta || 0);
            evaluated.effectiveToughness += (effect.toughnessMod || effect.toughnessDelta || 0);
            if (typeof effect.effectFn === 'function') {
              effect.effectFn(evaluated, context);
            }
            if (effect.apply) effect.apply(evaluated, context);
          }
          break;

        case CONTINUOUS_LAYERS.LAYER_7D_COUNTERS_PT:
          isCreature = /creature/i.test(evaluated.typeLine || evaluated.type || '');
          applyCounters();
          if (isCreature && effect.apply) effect.apply(evaluated, context);
          break;

        case CONTINUOUS_LAYERS.LAYER_7E_SWITCH_PT:
          isCreature = /creature/i.test(evaluated.typeLine || evaluated.type || '');
          applyCounters();
          if (isCreature && effect.switchPT) {
            const temp = evaluated.effectivePower;
            evaluated.effectivePower = evaluated.effectiveToughness;
            evaluated.effectiveToughness = temp;
          }
          if (isCreature && effect.apply) effect.apply(evaluated, context);
          break;

        default:
          if (effect.apply) effect.apply(evaluated, context);
          break;
      }
    }

    applyCounters();

    evaluated.power = evaluated.effectivePower;
    evaluated.toughness = evaluated.effectiveToughness;

    if (card.strippedProtectionUntilEOT || evaluated.strippedProtectionUntilEOT) {
      evaluated.isIndestructible = false;
      delete evaluated.keywords.indestructible;
      delete evaluated.keywords.Indestructible;
      delete evaluated.keywords.hexproof;
      delete evaluated.keywords.Hexproof;
    }

    return evaluated;
  }

  /**
   * Evaluates creature stats considering all continuous layers and active effects.
   * 
   * @param {Object} creature - Creature permanent
   * @param {Object} [gameState={}] - Optional tabletop / game state context
   * @returns {{ power: number, toughness: number, keywords: Object, effectivePower: number, effectiveToughness: number }}
   */
  evaluateCreatureStats(creature, gameState = {}) {
    if (!creature) {
      return { power: 0, toughness: 0, keywords: {}, effectivePower: 0, effectiveToughness: 0 };
    }
    const evaluated = this.evaluatePermanentLayers(creature, gameState);
    return {
      power: evaluated.effectivePower ?? Number(creature.power ?? 0) ?? 0,
      toughness: evaluated.effectiveToughness ?? Number(creature.toughness ?? 0) ?? 0,
      keywords: evaluated.keywords || {},
      effectivePower: evaluated.effectivePower ?? Number(creature.power ?? 0) ?? 0,
      effectiveToughness: evaluated.effectiveToughness ?? Number(creature.toughness ?? 0) ?? 0
    };
  }
}

export default AbilityEngine;
