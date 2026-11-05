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

    // Sort Non-Active Player triggers by turn order starting after active player (CR 603.3b)
    if (Array.isArray(turnOrder) && turnOrder.length > 1) {
      const activeIdx = turnOrder.indexOf(activePlayerId);
      const reordered = [];
      const baseIdx = activeIdx >= 0 ? activeIdx : 0;
      for (let i = 1; i < turnOrder.length; i++) {
        const nextPid = turnOrder[(baseIdx + i) % turnOrder.length];
        reordered.push(nextPid);
      }
      nonActivePlayerTriggers.sort((a, b) => {
        const idxA = reordered.indexOf(a.controllerId);
        const idxB = reordered.indexOf(b.controllerId);
        return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
      });
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
    if (card.basePower === undefined && card.power !== undefined) {
      card.basePower = Number(card.power) || 0;
    }
    if (card.baseToughness === undefined && card.toughness !== undefined) {
      card.baseToughness = Number(card.toughness) || 0;
    }
    const basePower = Number(card.basePower ?? card.power ?? 0) || 0;
    const baseToughness = Number(card.baseToughness ?? card.toughness ?? 0) || 0;
    card.basePower = basePower;
    card.baseToughness = baseToughness;

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

    // Resolve attached equipment and aura modifiers across zones (CR 613.4b Layer 7b, CR 613.4c Layer 7c & CR 613.1f Layer 6)
    const stateObj = context?.tabletopState || context?.state || context || this.tabletopState || this._tabletopState;
    const resolvedAttachedMap = new Map();

    const resolveItem = (itemOrId) => {
      if (!itemOrId) return null;
      if (typeof itemOrId === 'object') {
        const id = itemOrId.instanceId || itemOrId.id;
        if (id) {
          resolvedAttachedMap.set(id, itemOrId);
        } else {
          resolvedAttachedMap.set(itemOrId, itemOrId);
        }
        return itemOrId;
      }
      const targetId = String(itemOrId);
      if (stateObj && stateObj.players) {
        for (const p of Object.values(stateObj.players)) {
          const list = [
            ...(p.battlefield?.noncreatures || []),
            ...(Array.isArray(p.battlefield) ? p.battlefield : []),
            ...(p.zones?.battlefield || [])
          ];
          const found = list.find(nc => nc && (nc.instanceId === targetId || nc.id === targetId));
          if (found) {
            resolvedAttachedMap.set(targetId, found);
            return found;
          }
        }
      }
      return null;
    };

    const attachedSources = [
      ...(Array.isArray(card.attachedCards) ? card.attachedCards : []),
      ...(Array.isArray(card.attachments) ? card.attachments : [])
    ];
    for (const item of attachedSources) {
      resolveItem(item);
    }

    if (stateObj && stateObj.players) {
      for (const player of Object.values(stateObj.players)) {
        const noncreatures = [
          ...(player.battlefield?.noncreatures || []),
          ...(Array.isArray(player.battlefield) ? player.battlefield : []),
          ...(player.zones?.battlefield || [])
        ];
        for (const nc of noncreatures) {
          if (nc && nc.attachedTo && (nc.attachedTo === card.instanceId || nc.attachedTo === card.id)) {
            const id = nc.instanceId || nc.id;
            if (id && !resolvedAttachedMap.has(id)) {
              resolvedAttachedMap.set(id, nc);
            } else if (!id) {
              resolvedAttachedMap.set(nc, nc);
            }
          }
        }
      }
    }

    const attachedItems = Array.from(resolvedAttachedMap.values());

    // Resolve controller and battlefield permanents for static anthems (Honor of the Pure, Intangible Virtue, Wedding Festivity, Caretaker's Talent)
    let controller = null;
    if (stateObj && stateObj.players) {
      if (card.controllerId && stateObj.players[card.controllerId]) {
        controller = stateObj.players[card.controllerId];
      } else {
        for (const p of Object.values(stateObj.players)) {
          const allPerms = [
            ...(p.battlefield?.creatures || []),
            ...(p.battlefield?.lands || []),
            ...(p.battlefield?.noncreatures || []),
            ...(p.battlefield?.planeswalkers || []),
            ...(Array.isArray(p.battlefield) ? p.battlefield : []),
            ...(p.zones?.battlefield || [])
          ];
          if (allPerms.some(perm => perm && (perm.instanceId === card.instanceId || perm.id === card.id || perm === card))) {
            controller = p;
            break;
          }
        }
        if (!controller && context?.playerId && stateObj.players[context.playerId]) {
          controller = stateObj.players[context.playerId];
        }
      }
    }
    if (!controller && context && (context.battlefield || context.zones?.battlefield)) {
      controller = context;
    }

    const controllerPermanents = [];
    if (controller) {
      const rawControlled = [
        ...(controller.battlefield?.noncreatures || []),
        ...(controller.battlefield?.creatures || []),
        ...(controller.battlefield?.lands || []),
        ...(controller.battlefield?.planeswalkers || []),
        ...(Array.isArray(controller.battlefield) ? controller.battlefield : []),
        ...(controller.zones?.battlefield || [])
      ];
      const seenControlled = new Set();
      for (const p of rawControlled) {
        if (!p) continue;
        const id = p.instanceId || p.id;
        if (id) {
          if (!seenControlled.has(id)) {
            seenControlled.add(id);
            controllerPermanents.push(p);
          }
        } else {
          controllerPermanents.push(p);
        }
      }
    }

    let honorCopies = 0;
    let virtueCopies = 0;
    let festivityCopies = 0;
    let caretakerLevel3Copies = 0;

    for (const p of controllerPermanents) {
      const pName = (p.name || '').toLowerCase();
      if (pName.includes('honor of the pure')) {
        honorCopies++;
      }
      if (pName.includes('intangible virtue')) {
        virtueCopies++;
      }
      if (pName.includes('wedding festivity') || (p.isTransformed === true && pName.includes('wedding announcement'))) {
        festivityCopies++;
      }
      if (pName.includes("caretaker's talent") || pName.includes('caretakers talent')) {
        const lvl = Number(p.classLevel ?? p.level ?? 1);
        if (lvl >= 3) {
          caretakerLevel3Copies++;
        }
      }
    }

    // --- CONTINUOUS LAYERS 1 THROUGH 6 ---
    for (const effect of this.staticEffects) {
      if (effect.targetId && (evaluated.instanceId !== effect.targetId && evaluated.id !== effect.targetId)) continue;
      if (effect.appliesTo && !effect.appliesTo(evaluated, context)) continue;

      switch (effect.layer) {
        case CONTINUOUS_LAYERS.LAYER_4_TYPE:
          if (effect.apply) effect.apply(evaluated, context);
          isCreature = /creature/i.test(evaluated.typeLine || evaluated.type || '');
          break;
        case CONTINUOUS_LAYERS.LAYER_5_COLOR:
          if (effect.apply) effect.apply(evaluated, context);
          break;
        case CONTINUOUS_LAYERS.LAYER_6_ABILITY:
          if (effect.grantedKeywords) Object.assign(evaluated.keywords, effect.grantedKeywords);
          if (effect.removedKeywords) {
            for (const kw of effect.removedKeywords) delete evaluated.keywords[kw];
          }
          if (effect.apply) effect.apply(evaluated, context);
          break;
        default:
          break;
      }
    }

    // Layer 6 from attached equipment / auras (keywords granted/lost)
    for (const item of attachedItems) {
      const attachEffects = item.compiledMechanics?.attachmentEffects ||
        item.compiledMechanics?.attachment ||
        item.compiledMechanics?.attachEffects ||
        item.attachmentEffects ||
        item.attachEffects ||
        item.attachment;
      if (attachEffects) {
        const granted = attachEffects.keywordsGranted || attachEffects.grantedKeywords || attachEffects.grantKeywords || [];
        if (Array.isArray(granted)) {
          for (const kw of granted) {
            if (typeof kw === 'string') {
              const lower = kw.toLowerCase();
              evaluated.keywords[kw] = true;
              evaluated.keywords[lower] = true;
              evaluated.keywords[kw.charAt(0).toUpperCase() + kw.slice(1)] = true;
              if (lower === 'haste') {
                evaluated.hasHaste = true;
                evaluated.hasSummoningSickness = false;
                evaluated.isSummoningSick = false;
              }
            }
          }
        }
        const lost = attachEffects.loseKeywords || attachEffects.keywordsLost || attachEffects.lostKeywords || [];
        if (Array.isArray(lost)) {
          for (const kw of lost) {
            if (typeof kw === 'string') {
              const lower = kw.toLowerCase();
              delete evaluated.keywords[kw];
              delete evaluated.keywords[lower];
              delete evaluated.keywords[kw.charAt(0).toUpperCase() + kw.slice(1)];
              if (lower === 'flying') {
                evaluated.hasFlying = false;
                delete evaluated.flying;
                delete evaluated.Flying;
              }
            }
          }
        }
      }
    }

    // Layer 6: Intangible Virtue grants Vigilance to controlled token creatures
    const isTokenCreature = isCreature && Boolean(card.isToken || evaluated.isToken);
    if (isTokenCreature && virtueCopies > 0) {
      evaluated.keywords.vigilance = true;
      evaluated.keywords.Vigilance = true;
      evaluated.hasVigilance = true;
    }

    // Ocelot Pride native / baseline keywords
    if (/ocelot pride/i.test(card.name || evaluated.name || '')) {
      evaluated.keywords.firstStrike = true;
      evaluated.keywords['First strike'] = true;
      evaluated.keywords.lifelink = true;
      evaluated.keywords.Lifelink = true;
      evaluated.hasFirstStrike = true;
      evaluated.hasLifelink = true;
    }

    // --- CONTINUOUS LAYER 7A: CDA P/T ---
    for (const effect of this.staticEffects) {
      if (effect.targetId && (evaluated.instanceId !== effect.targetId && evaluated.id !== effect.targetId)) continue;
      if (effect.appliesTo && !effect.appliesTo(evaluated, context)) continue;
      if (effect.layer === CONTINUOUS_LAYERS.LAYER_7A_CDA_PT && isCreature) {
        if (effect.apply) {
          effect.apply(evaluated, context);
        } else {
          if (effect.setPower !== undefined) evaluated.effectivePower = effect.setPower;
          if (effect.setToughness !== undefined) evaluated.effectiveToughness = effect.setToughness;
        }
      }
    }

    // --- CONTINUOUS LAYER 7B: SET P/T (Belt of Giant Strength 10/10 & setBasePT) ---
    for (const effect of this.staticEffects) {
      if (effect.targetId && (evaluated.instanceId !== effect.targetId && evaluated.id !== effect.targetId)) continue;
      if (effect.appliesTo && !effect.appliesTo(evaluated, context)) continue;
      if (effect.layer === CONTINUOUS_LAYERS.LAYER_7B_SET_PT && isCreature) {
        if (effect.setPower !== undefined) evaluated.effectivePower = effect.setPower;
        if (effect.setToughness !== undefined) evaluated.effectiveToughness = effect.setToughness;
        if (effect.apply) effect.apply(evaluated, context);
      }
    }

    for (const item of attachedItems) {
      const attachEffects = item.compiledMechanics?.attachmentEffects ||
        item.compiledMechanics?.attachment ||
        item.compiledMechanics?.attachEffects ||
        item.attachmentEffects ||
        item.attachEffects ||
        item.attachment;
      const isBelt = /belt of giant strength/i.test(item.name || '') ||
        /base power and toughness 10\/10/i.test(item.oracleText || item.text || '') ||
        Boolean(item.setBasePT) ||
        (attachEffects && (attachEffects.setPower !== undefined || attachEffects.basePower !== undefined));

      if (isBelt || attachEffects?.setPower !== undefined || attachEffects?.basePower !== undefined) {
        const setP = item.setBasePT?.power ?? attachEffects?.setPower ?? attachEffects?.basePower ?? (isBelt ? 10 : undefined);
        const setT = item.setBasePT?.toughness ?? attachEffects?.setToughness ?? attachEffects?.baseToughness ?? (isBelt ? 10 : undefined);
        if (setP !== undefined && setP !== null) {
          evaluated.basePower = Number(setP);
          evaluated.effectivePower = Number(setP);
        }
        if (setT !== undefined && setT !== null) {
          evaluated.baseToughness = Number(setT);
          evaluated.effectiveToughness = Number(setT);
        }
      }
    }

    // --- CONTINUOUS LAYER 7C: MODIFY P/T (+X/+Y, Colossus Hammer, Gaveleer Scaling, Static Anthems/Debuffs) ---
    for (const effect of this.staticEffects) {
      if (effect.targetId && (evaluated.instanceId !== effect.targetId && evaluated.id !== effect.targetId)) continue;
      if (effect.appliesTo && !effect.appliesTo(evaluated, context)) continue;
      if (effect.layer === CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT && isCreature) {
        evaluated.effectivePower += (effect.powerMod || effect.powerDelta || 0);
        evaluated.effectiveToughness += (effect.toughnessMod || effect.toughnessDelta || 0);
        if (typeof effect.effectFn === 'function') effect.effectFn(evaluated, context);
        if (effect.apply) effect.apply(evaluated, context);
      }
    }

    for (const item of attachedItems) {
      const attachEffects = item.compiledMechanics?.attachmentEffects ||
        item.compiledMechanics?.attachment ||
        item.compiledMechanics?.attachEffects ||
        item.attachmentEffects ||
        item.attachEffects ||
        item.attachment;
      if (attachEffects) {
        const powerDelta = Number(attachEffects.powerDelta ?? attachEffects.powerModifier ?? attachEffects.powerMod ?? 0);
        const toughnessDelta = Number(attachEffects.toughnessDelta ?? attachEffects.toughnessModifier ?? attachEffects.toughnessMod ?? 0);
        evaluated.effectivePower += powerDelta;
        evaluated.effectiveToughness += toughnessDelta;
      }
    }

    // Layer 7c: Scaling buff per attached Equipment (e.g. Goblin Gaveleer: "gets +2/+0 for each Equipment attached to it")
    const scalingPerm = Array.isArray(evaluated.compiledMechanics?.staticPermissions)
      ? evaluated.compiledMechanics.staticPermissions.find(p => p && p.type === 'SCALING_BUFF_PER_EQUIPMENT')
      : null;
    const isGaveleer = Boolean(
      scalingPerm ||
      /goblin gaveleer/i.test(evaluated.name || '') ||
      /gets\s+\+2\/\+0\s+for\s+each\s+equipment\s+attached\s+to\s+it/i.test(evaluated.oracleText || evaluated.text || '')
    );
    if (isGaveleer) {
      const equipCount = attachedItems.filter(i =>
        i && (i.compiledMechanics?.isEquipment || /equipment/i.test(i.typeLine || i.type || ''))
      ).length;
      const pPerEq = scalingPerm ? Number(scalingPerm.powerPerEquipment ?? 2) : 2;
      const tPerEq = scalingPerm ? Number(scalingPerm.toughnessPerEquipment ?? 0) : 0;
      evaluated.effectivePower += equipCount * pPerEq;
      evaluated.effectiveToughness += equipCount * tPerEq;
    }

    // --- CONTINUOUS LAYER 7C: STATIC ANTHEMS (Honor of the Pure, Intangible Virtue, Wedding Festivity, Caretaker's Talent L3) ---
    if (isCreature) {
      const isWhite = Boolean(
        card.colors?.includes('W') ||
        evaluated.colors?.includes('W') ||
        card.isWhite === true ||
        evaluated.isWhite === true ||
        /\{W\}/i.test(card.manaCost || evaluated.manaCost || '') ||
        card.colorIdentity?.includes('W') ||
        evaluated.colorIdentity?.includes('W')
      );
      if (isWhite && honorCopies > 0) {
        evaluated.effectivePower += honorCopies;
        evaluated.effectiveToughness += honorCopies;
      }

      if (isTokenCreature && virtueCopies > 0) {
        evaluated.effectivePower += virtueCopies;
        evaluated.effectiveToughness += virtueCopies;
      }

      if (festivityCopies > 0) {
        evaluated.effectivePower += festivityCopies;
        evaluated.effectiveToughness += festivityCopies;
      }

      if (isTokenCreature && caretakerLevel3Copies > 0) {
        evaluated.effectivePower += (caretakerLevel3Copies * 2);
        evaluated.effectiveToughness += (caretakerLevel3Copies * 2);
      }
    }

    // --- CONTINUOUS LAYER 7D: COUNTERS (+1/+1 and -1/-1) ---
    if (isCreature && evaluated.counters) {
      const p1 = Number(evaluated.counters['+1/+1'] || 0);
      const m1 = Number(evaluated.counters['-1/-1'] || 0);
      evaluated.effectivePower += (p1 - m1);
      evaluated.effectiveToughness += (p1 - m1);
    }
    for (const effect of this.staticEffects) {
      if (effect.targetId && (evaluated.instanceId !== effect.targetId && evaluated.id !== effect.targetId)) continue;
      if (effect.appliesTo && !effect.appliesTo(evaluated, context)) continue;
      if (effect.layer === CONTINUOUS_LAYERS.LAYER_7D_COUNTERS_PT && isCreature && effect.apply) {
        effect.apply(evaluated, context);
      }
    }

    // --- CONTINUOUS LAYER 7E: SWITCH P/T ---
    for (const effect of this.staticEffects) {
      if (effect.targetId && (evaluated.instanceId !== effect.targetId && evaluated.id !== effect.targetId)) continue;
      if (effect.appliesTo && !effect.appliesTo(evaluated, context)) continue;
      if (effect.layer === CONTINUOUS_LAYERS.LAYER_7E_SWITCH_PT && isCreature) {
        if (effect.switchPT) {
          const temp = evaluated.effectivePower;
          evaluated.effectivePower = evaluated.effectiveToughness;
          evaluated.effectiveToughness = temp;
        }
        if (effect.apply) effect.apply(evaluated, context);
      }
    }

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
   * Recalculates continuous layers for all permanents across all player battlefields.
   * 
   * @param {Object} [context={}]
   * @returns {Array<Object>} Evaluated permanent cards
   */
  evaluateAllLayers(context = {}) {
    const stateObj = context?.tabletopState || context?.state || context || this.tabletopState || this._tabletopState;
    if (!stateObj || !stateObj.players) return [];

    const evaluatedPerms = [];
    for (const player of Object.values(stateObj.players)) {
      const perms = [
        ...(player.battlefield?.creatures || []),
        ...(player.battlefield?.lands || []),
        ...(player.battlefield?.noncreatures || []),
        ...(player.battlefield?.planeswalkers || [])
      ];

      for (const perm of perms) {
        if (!perm) continue;
        const evaluated = this.evaluatePermanentLayers(perm, stateObj);
        if (/creature/i.test(perm.typeLine || perm.type || '')) {
          perm.effectivePower = evaluated.effectivePower;
          perm.effectiveToughness = evaluated.effectiveToughness;
          perm.power = evaluated.effectivePower;
          perm.toughness = evaluated.effectiveToughness;
          perm.keywords = { ...evaluated.keywords };
        }
        evaluatedPerms.push(evaluated);
      }
    }
    return evaluatedPerms;
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
      hasFlying: evaluated.hasFlying !== undefined ? evaluated.hasFlying : Boolean(evaluated.keywords?.flying),
      hasVigilance: evaluated.hasVigilance !== undefined ? evaluated.hasVigilance : Boolean(evaluated.keywords?.vigilance || evaluated.keywords?.Vigilance),
      hasFirstStrike: evaluated.hasFirstStrike !== undefined ? evaluated.hasFirstStrike : Boolean(evaluated.keywords?.firstStrike || evaluated.keywords?.['First strike']),
      hasLifelink: evaluated.hasLifelink !== undefined ? evaluated.hasLifelink : Boolean(evaluated.keywords?.lifelink || evaluated.keywords?.Lifelink),
      effectivePower: evaluated.effectivePower ?? Number(creature.power ?? 0) ?? 0,
      effectiveToughness: evaluated.effectiveToughness ?? Number(creature.toughness ?? 0) ?? 0
    };
  }

  static evaluateCreatureStats(creature, gameState = {}) {
    const engine = (gameState?.abilityEngine) || new AbilityEngine({ tabletopState: gameState?.tabletopState || gameState });
    return engine.evaluateCreatureStats(creature, gameState);
  }
}

export default AbilityEngine;
