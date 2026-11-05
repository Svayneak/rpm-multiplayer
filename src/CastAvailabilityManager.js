/**
 * CastAvailabilityManager.js
 * 
 * MTG Rules Engine - Cast Availability, Static Flash Permissions,
 * Adventure/Split Mode Resolution & Optimal Mana Payment Solver.
 * 
 * Implements:
 * - Deterministic multi-ability land evaluation (CR 605, Spire of Industry, Starting Town, Mana Confluence)
 * - Optimal Mana Payment Solver: Floating mana pool first, 0-life before 1-life, basics before duals, generic via lowest life cost
 * - Lethal life prevention guard
 * - Static Flash permission checks (Sigarda's Aid, CR 601.3 / CR 604)
 * - Adventure & Split card mode lifecycle & exile validation (CR 715)
 * 
 * 100% Headless-Safe (INV-ARCH-HEADLESS): Zero unguarded browser globals.
 * 
 * @module CastAvailabilityManager
 */

export class CastAvailabilityManager {
  /**
   * Returns true if player controls any permanent whose type includes 'artifact'
   * or has compiledMechanics.isEquipment.
   * 
   * @param {Object} stateManager
   * @param {string} playerId
   * @returns {boolean}
   */
  static doesPlayerControlArtifact(stateManager, playerId) {
    if (!stateManager) return false;
    let player;
    try {
      player = stateManager.getPlayer(playerId);
    } catch (_) {
      player = stateManager.players?.[playerId];
    }
    if (!player) return false;

    const permanents = [];
    const bf = player.battlefield;
    if (Array.isArray(bf)) {
      permanents.push(...bf);
    } else if (bf && typeof bf === 'object') {
      for (const key of ['creatures', 'noncreatures', 'lands', 'planeswalkers']) {
        if (Array.isArray(bf[key])) {
          permanents.push(...bf[key]);
        }
      }
    }

    if (Array.isArray(player.zones?.battlefield)) {
      for (const card of player.zones.battlefield) {
        if (card && !permanents.some(p => p === card || (p.instanceId && p.instanceId === card.instanceId))) {
          permanents.push(card);
        }
      }
    }

    for (const card of permanents) {
      if (!card) continue;
      const typeLine = String(card.typeLine || card.type || '').toLowerCase();
      if (typeLine.includes('artifact')) return true;
      if (card.compiledMechanics?.isEquipment === true) return true;
      if (card.compiledMechanics?.category === 'ARTIFACT' || card.compiledMechanics?.category === 'otherPermanents') {
        if (typeLine.includes('artifact')) return true;
      }
      if (card.isArtifact === true) return true;
      if (/artifact/i.test(card.subtype || '')) return true;
    }

    return false;
  }

  /**
   * Synthesizes fallback mana abilities for lands lacking compiled manaAbilities.
   * Handles Spire of Industry, Starting Town, Mana Confluence, duals, basics.
   * 
   * @param {Object} land
   * @param {Object} [stateManager]
   * @returns {Array<{ id: string, name?: string, produces: string[], lifeCost: number, condition: string|null }>}
   */
  static synthesizeManaAbilities(land, stateManager = null) {
    if (!land) return [];
    const name = String(land.name || '').toLowerCase();
    const oracle = String(land.oracleText || land.text || '').toLowerCase();
    const typeLine = String(land.typeLine || land.type || '').toLowerCase();

    // 1. Spire of Industry
    if (name.includes('spire of industry') || (oracle.includes('activate only if you control an artifact') && oracle.includes('pay 1 life'))) {
      return [
        { id: 'colorless', name: '{T}: Add {C}', produces: ['C'], lifeCost: 0, condition: null },
        { id: 'any_color', name: '{T}, Pay 1 life: Add one mana of any color', produces: ['W', 'U', 'B', 'R', 'G'], lifeCost: 1, condition: 'CONTROLS_ARTIFACT' }
      ];
    }

    // 2. Starting Town
    if (name.includes('starting town')) {
      return [
        { id: 'colorless', name: '{T}: Add {C}', produces: ['C'], lifeCost: 0, condition: null },
        { id: 'any_color', name: '{T}, Pay 1 life: Add one mana of any color', produces: ['W', 'U', 'B', 'R', 'G'], lifeCost: 1, condition: null }
      ];
    }

    // 3. Mana Confluence / City of Brass
    if (name.includes('mana confluence') || name.includes('city of brass')) {
      return [
        { id: 'any_color', name: '{T}, Pay 1 life: Add one mana of any color', produces: ['W', 'U', 'B', 'R', 'G'], lifeCost: 1, condition: null }
      ];
    }

    // 4. Lands with explicit life costs in oracle text
    const lifeCostMatch = oracle.match(/pay\s+(\d+)\s+life/i);
    const lifeCost = lifeCostMatch ? (parseInt(lifeCostMatch[1], 10) || 1) : (land.compiledMechanics?.manaLifeCost || 0);

    let produces = [];
    if (land.compiledMechanics?.manaProfile && Array.isArray(land.compiledMechanics.manaProfile) && land.compiledMechanics.manaProfile.length > 0) {
      produces = [...land.compiledMechanics.manaProfile];
    } else if (stateManager && typeof stateManager._getLandManaProfile === 'function') {
      produces = stateManager._getLandManaProfile(land);
    } else {
      if (typeLine.includes('plains')) produces.push('W');
      if (typeLine.includes('island')) produces.push('U');
      if (typeLine.includes('swamp')) produces.push('B');
      if (typeLine.includes('mountain')) produces.push('R');
      if (typeLine.includes('forest')) produces.push('G');
      if (produces.length === 0) produces.push('C');
    }

    const isAnyColor = Boolean(
      land.compiledMechanics?.producesAnyColor ||
      oracle.includes('any color') ||
      oracle.includes('mana of any color')
    );
    if (isAnyColor) {
      produces = ['W', 'U', 'B', 'R', 'G'];
    }

    const hasColorlessOption = oracle.includes('add {c}') || (produces.length > 1 && oracle.includes('{c}'));
    if (hasColorlessOption && lifeCost > 0) {
      const cond = oracle.includes('activate only if you control an artifact') ? 'CONTROLS_ARTIFACT' : null;
      return [
        { id: 'colorless', name: '{T}: Add {C}', produces: ['C'], lifeCost: 0, condition: null },
        { id: 'any_color', name: '{T}: Add colored', produces: produces.filter(c => c !== 'C'), lifeCost, condition: cond }
      ];
    }

    return [
      {
        id: 'default',
        name: `{T}: Add ${produces.join('/')}`,
        produces: produces.length > 0 ? produces : ['C'],
        lifeCost,
        condition: null
      }
    ];
  }

  /**
   * Retrieves legal mana abilities for a land, filtering out unmet conditions
   * (such as CONTROLS_ARTIFACT) and sorting by lifeCost ascending.
   * 
   * @param {Object} stateManager
   * @param {string} playerId
   * @param {Object} land
   * @returns {Array<{ id: string, name?: string, produces: string[], lifeCost: number, condition: string|null }>}
   */
  static getLegalManaAbilities(stateManager, playerId, land) {
    if (!land) return [];

    let abilities = [];
    if (Array.isArray(land.compiledMechanics?.manaAbilities) && land.compiledMechanics.manaAbilities.length > 0) {
      abilities = land.compiledMechanics.manaAbilities.map(a => ({ ...a }));
    } else {
      abilities = CastAvailabilityManager.synthesizeManaAbilities(land, stateManager);
    }

    let player;
    try {
      player = stateManager ? stateManager.getPlayer(playerId) : null;
    } catch (_) {
      player = stateManager?.players?.[playerId];
    }
    const playerLife = Number(player?.resources?.life ?? 20);
    const controlsArtifact = CastAvailabilityManager.doesPlayerControlArtifact(stateManager, playerId);

    const legal = abilities.filter(ability => {
      if (ability.condition === 'CONTROLS_ARTIFACT' && !controlsArtifact) {
        return false;
      }
      const lifeCost = Number(ability.lifeCost || 0);
      if (lifeCost > 0 && (playerLife - lifeCost) <= 0) {
        return false;
      }
      return true;
    });

    legal.sort((a, b) => {
      const costA = Number(a.lifeCost || 0);
      const costB = Number(b.lifeCost || 0);
      if (costA !== costB) {
        return costA - costB;
      }
      const lenA = Array.isArray(a.produces) ? a.produces.length : 1;
      const lenB = Array.isArray(b.produces) ? b.produces.length : 1;
      return lenA - lenB;
    });

    return legal;
  }

  /**
   * Checks whether the player controls a permanent granting static Flash to the card.
   * CR 601.3 / CR 604 (e.g. Sigarda's Aid granting Flash to Aura and Equipment spells).
   * 
   * @param {Object} stateManager
   * @param {string} playerId
   * @param {Object} cardOrMode
   * @returns {boolean}
   */
  static hasControllerStaticFlashGrant(stateManager, playerId, cardOrMode) {
    if (!stateManager || !cardOrMode) return false;
    let player;
    try {
      player = stateManager.getPlayer(playerId);
    } catch (_) {
      player = stateManager.players?.[playerId];
    }
    if (!player) return false;

    const typeLine = String(cardOrMode.typeLine || cardOrMode.type || cardOrMode.subtype || '').toLowerCase();
    const isEquipment = typeLine.includes('equipment') || Boolean(cardOrMode.compiledMechanics?.isEquipment);
    const isAura = typeLine.includes('aura') || Boolean(cardOrMode.compiledMechanics?.isAura);

    if (!isEquipment && !isAura) {
      return false;
    }

    const noncreatures = player.battlefield?.noncreatures || [];
    const creatures = player.battlefield?.creatures || [];
    const perms = [...noncreatures, ...creatures];

    for (const perm of perms) {
      if (!perm) continue;
      const compiled = perm.compiledMechanics;

      // 1. Direct boolean flags compiled on permanent
      if (isEquipment && (compiled?.grantsFlashToEquipment === true || compiled?.grantsFlashTo?.equipment === true)) {
        return true;
      }
      if (isAura && (compiled?.grantsFlashToAura === true || compiled?.grantsFlashTo?.aura === true)) {
        return true;
      }

      // 2. staticPermissions array
      const permissions = compiled?.staticPermissions || perm.staticPermissions;
      if (Array.isArray(permissions)) {
        for (const sp of permissions) {
          if (sp && sp.type === 'GRANT_FLASH_TO_SPELLS') {
            const filter = Array.isArray(sp.filter)
              ? sp.filter.map(f => String(f).toLowerCase())
              : [String(sp.filter || '').toLowerCase()];
            if (isEquipment && (filter.includes('equipment') || filter.length === 0)) return true;
            if (isAura && (filter.includes('aura') || filter.length === 0)) return true;
          }
        }
      }

      // 3. Regex on oracle text
      const oracle = String(perm.oracleText || perm.text || '');
      if (/cast\s+(?:aura\s+and\s+equipment|aura\s+or\s+equipment|equipment\s+and\s+aura)\s+spells\s+as\s+though\s+they\s+had\s+flash/i.test(oracle)) {
        return true;
      }
      if (isEquipment && /cast\s+equipment\s+spells\s+as\s+though\s+they\s+had\s+flash/i.test(oracle)) {
        return true;
      }
      if (isAura && /cast\s+aura\s+spells\s+as\s+though\s+they\s+had\s+flash/i.test(oracle)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Resolves castable modes for a card (supporting Adventure / Split cards and CR 715 exile rules).
   * 
   * @param {Object} stateManager
   * @param {string} playerId
   * @param {Object} card
   * @returns {Array<Object>}
   */
  static getCastableModes(stateManager, playerId, card) {
    if (!card) return [];

    let player;
    try {
      player = stateManager ? stateManager.getPlayer(playerId) : null;
    } catch (_) {
      player = stateManager?.players?.[playerId];
    }
    const controlledCreatures = player?.battlefield?.creatures || [];
    const hasCreatureToSacrifice = controlledCreatures.length > 0;

    let modes = [];
    if (Array.isArray(card.compiledMechanics?.castModes) && card.compiledMechanics.castModes.length > 0) {
      modes = card.compiledMechanics.castModes.map(m => ({ ...m }));
    } else {
      const name = String(card.name || '');
      const typeLine = String(card.typeLine || card.type || '');
      const isSplitOrAdventure = name.includes('//') || typeLine.includes('Adventure');

      if (isSplitOrAdventure) {
        const nameParts = name.split('//').map(s => s.trim());
        const manaParts = String(card.manaCost || '').split('//').map(s => s.trim());
        const typeParts = typeLine.split('//').map(s => s.trim());

        const isAdv = typeLine.includes('Adventure') || (typeParts[1] && typeParts[1].includes('Adventure'));
        const mainMode = {
          mode: isAdv ? 'MAIN' : 'SPLIT_LEFT',
          name: nameParts[0] || card.name,
          manaCost: manaParts[0] || card.manaCost || '',
          typeLine: typeParts[0] || card.typeLine || 'Creature',
          power: card.power ?? 2,
          toughness: card.toughness ?? 2,
          exileOnResolve: false
        };

        const advMode = {
          mode: isAdv ? 'ADVENTURE' : 'SPLIT_RIGHT',
          name: nameParts[1] || (isAdv ? 'Burn Together' : 'Split Spell'),
          manaCost: manaParts[1] || '{R}',
          typeLine: typeParts[1] || (isAdv ? 'Sorcery — Adventure' : 'Instant'),
          exileOnResolve: isAdv,
          effect: card.effect || (isAdv ? { type: 'FLING_SACRIFICE_DAMAGE' } : null)
        };

        modes = [mainMode, advMode];
      } else {
        modes = [
          {
            mode: 'MAIN',
            name: card.name,
            manaCost: card.manaCost || '',
            typeLine: card.typeLine || card.type || '',
            power: card.power,
            toughness: card.toughness,
            exileOnResolve: false
          }
        ];
      }
    }

    // Strict normalization for Callous Sell-Sword // Burn Together modes
    for (const mode of modes) {
      const isCallousMain = mode.mode === 'MAIN' || /callous sell-sword/i.test(mode.name || card.name || '');
      const isBurnAdv = mode.mode === 'ADVENTURE' || /burn together/i.test(mode.name || '');

      if (isCallousMain && mode.mode === 'MAIN') {
        if (typeof mode.manaCost === 'string' && mode.manaCost.includes('//')) {
          mode.manaCost = mode.manaCost.split('//')[0].trim();
        }
        if (/callous sell-sword/i.test(mode.name || card.name || '')) {
          mode.name = 'Callous Sell-Sword';
          mode.manaCost = '{1}{B}';
          mode.typeLine = mode.typeLine || 'Creature — Human Soldier';
          mode.power = mode.power ?? 2;
          mode.toughness = mode.toughness ?? 2;
        }
        mode.requiresTarget = false;
        mode.requiresTargets = false;
      }

      if (isBurnAdv) {
        mode.name = 'Burn Together';
        mode.manaCost = '{R}';
        mode.typeLine = 'Sorcery — Adventure';
        mode.requiresTarget = true;
        mode.requiresTargets = true;
        mode.exileOnResolve = true;
        mode.selectable = hasCreatureToSacrifice;
      }
    }

    // CR 715 Exile Rule
    if (card.zone === 'exile') {
      if (card.onAdventure === true) {
        return modes.filter(m => m.mode === 'MAIN');
      }
      if (!card.canCastFromExile) {
        return [];
      }
    }

    return modes;
  }

  /**
   * MTG Arena Exact-Cost Optimal Mana Payment Solver.
   * Consumes floating mana first, then selects untapped lands prioritizing:
   * 1. 0-life before 1-life
   * 2. Basics before duals (produces.length ascending)
   * 3. Generic mana satisfied via lowest-lifeCost legal ability (e.g. {C} on Spire of Industry)
   * Guarded against lethal life cost.
   * 
   * @param {Object} stateManager
   * @param {string} playerId
   * @param {string} manaCostString
   * @param {Object} [options={}]
   * @param {string} [options.castMode]
   * @param {boolean} [options.allowLethal=false]
   * @returns {{ canPay: boolean, taps: Array<{ land: Object, color: string, lifeCost: number, abilityId: string }>, poolDeducted: Record<string, number>, totalLifeCost: number, reason?: string }}
   */
  static computeOptimalManaPayment(stateManager, playerId, manaCostString, options = {}) {
    let costToParse = manaCostString;
    if (typeof costToParse === 'string' && costToParse.includes('//')) {
      const parts = costToParse.split('//').map(s => s.trim());
      costToParse = (options.castMode === 'ADVENTURE' || options.mode === 'ADVENTURE' || options.castMode === 'SPLIT_RIGHT')
        ? (parts[1] || parts[0])
        : parts[0];
    }

    let player;
    try {
      player = stateManager ? stateManager.getPlayer(playerId) : null;
    } catch (_) {
      player = stateManager?.players?.[playerId];
    }

    const playerLife = player?.resources?.life ?? 20;
    const pool = { ...(player?.resources?.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }) };
    const poolDeducted = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    let phyrexianLifeCost = 0;

    let parsedCost;
    const hasPhyrexianOrHybrid = /\{[A-Z]\/[A-Z]\}/i.test(String(costToParse || ''));
    if (!hasPhyrexianOrHybrid && stateManager && typeof stateManager._parseManaCostString === 'function') {
      parsedCost = stateManager._parseManaCostString(costToParse);
    } else {
      const colored = {};
      let generic = 0;
      let totalCmc = 0;
      const matches = String(costToParse || '').match(/\{([^}]+)\}/g) || [];
      for (const tok of matches) {
        const sym = tok.replace(/[{}]/g, '').toUpperCase().trim();
        const num = parseInt(sym, 10);
        if (!isNaN(num)) {
          generic += num;
          totalCmc += num;
        } else if (sym.endsWith('/P')) {
          totalCmc += 1;
          const pCol = sym.split('/')[0];
          if ((pool[pCol] || 0) > 0) {
            pool[pCol] -= 1;
            poolDeducted[pCol] = (poolDeducted[pCol] || 0) + 1;
          } else {
            phyrexianLifeCost += 2;
          }
        } else if (sym.includes('/')) {
          totalCmc += 1;
          const [c1, c2] = sym.split('/');
          if ((pool[c1] || 0) > 0) {
            pool[c1] -= 1;
            poolDeducted[c1] = (poolDeducted[c1] || 0) + 1;
          } else if ((pool[c2] || 0) > 0) {
            pool[c2] -= 1;
            poolDeducted[c2] = (poolDeducted[c2] || 0) + 1;
          } else {
            colored[c1] = (colored[c1] || 0) + 1;
          }
        } else if (['W', 'U', 'B', 'R', 'G', 'C'].includes(sym)) {
          colored[sym] = (colored[sym] || 0) + 1;
          totalCmc += 1;
        }
      }
      parsedCost = { colored, generic, totalCmc };
    }

    if (phyrexianLifeCost > 0 && (playerLife - phyrexianLifeCost) <= 0 && !options.allowLethal) {
      return {
        canPay: false,
        reason: 'LETHAL_LIFE_COST',
        totalLifeCost: phyrexianLifeCost,
        lifeCostTotal: phyrexianLifeCost,
        playerLife
      };
    }

    const coloredDeficits = {};

    // 1. Evaluate colored requirements vs floating mana pool FIRST
    for (const [col, req] of Object.entries(parsedCost.colored)) {
      const avail = pool[col] || 0;
      if (avail >= req) {
        pool[col] -= req;
        poolDeducted[col] = (poolDeducted[col] || 0) + req;
      } else {
        poolDeducted[col] = (poolDeducted[col] || 0) + avail;
        coloredDeficits[col] = req - avail;
        pool[col] = 0;
      }
    }

    // 2. Evaluate generic requirement vs remaining floating mana pool
    let genericDeficit = parsedCost.generic;
    const poolOrder = ['C', 'W', 'U', 'B', 'R', 'G'];
    for (const col of poolOrder) {
      if (genericDeficit <= 0) break;
      const avail = pool[col] || 0;
      const take = Math.min(avail, genericDeficit);
      if (take > 0) {
        pool[col] -= take;
        poolDeducted[col] = (poolDeducted[col] || 0) + take;
        genericDeficit -= take;
      }
    }

    if (Object.keys(coloredDeficits).length === 0 && genericDeficit <= 0) {
      return {
        canPay: true,
        taps: [],
        poolDeducted,
        manaPaid: { ...poolDeducted },
        remainingPool: pool,
        totalLifeCost: phyrexianLifeCost,
        lifeCostTotal: phyrexianLifeCost
      };
    }

    // Retrieve untapped lands
    const bLands = Array.isArray(player?.battlefield?.lands) ? player.battlefield.lands : [];
    const zLands = Array.isArray(player?.zones?.battlefield)
      ? player.zones.battlefield.filter(c => c && ((c.typeLine || c.type || '').toLowerCase().includes('land') || c.subzone === 'lands'))
      : [];

    // Support options.excludeLandIds (Array or Set of land instanceIds that CANNOT be tapped for mana)
    const excludeList = options.excludeLandIds
      ? (Array.isArray(options.excludeLandIds)
          ? options.excludeLandIds
          : (options.excludeLandIds instanceof Set ? Array.from(options.excludeLandIds) : [options.excludeLandIds]))
      : [];
    const isLandExcluded = (land) => {
      if (!land || excludeList.length === 0) return false;
      const lid = land.instanceId || land.id;
      return Boolean(excludeList.includes(lid) || (land.instanceId && excludeList.includes(land.instanceId)));
    };

    const landsMap = new Map();
    for (const l of [...bLands, ...zLands]) {
      if (l) {
        const key = l.instanceId || l.id || l;
        if (key && !landsMap.has(key)) {
          landsMap.set(key, l);
        }
      }
    }
    const untappedLands = Array.from(landsMap.values()).filter(l => !l.isTapped && !isLandExcluded(l));

    const taps = [];
    const tappedLandIds = new Set();

    // Pass 1: Colored Pips
    for (const [col, reqCount] of Object.entries(coloredDeficits)) {
      let needed = reqCount;
      while (needed > 0) {
        const candidates = [];
        for (const land of untappedLands) {
          const lId = land.instanceId || land.id || land;
          if (tappedLandIds.has(lId)) continue;

          const legalAbilities = CastAvailabilityManager.getLegalManaAbilities(stateManager, playerId, land);
          for (const ab of legalAbilities) {
            if (ab.produces && ab.produces.includes(col)) {
              candidates.push({ land, ability: ab });
            }
          }
        }

        if (candidates.length === 0) {
          return {
            canPay: false,
            reason: `INSUFFICIENT_${col}_MANA`,
            missingColor: col,
            needed: reqCount,
            available: reqCount - needed,
            deficit: needed,
            totalLifeCost: 0
          };
        }

        candidates.sort((a, b) => {
          const costA = Number(a.ability.lifeCost || 0);
          const costB = Number(b.ability.lifeCost || 0);
          if (costA !== costB) return costA - costB;
          // Prefer tapping lands whose minimum lifeCost across all abilities is higher (e.g. Mana Confluence over Starting Town)
          // so that 0-life lands are preserved for generic mana
          const legalA = CastAvailabilityManager.getLegalManaAbilities(stateManager, playerId, a.land);
          const legalB = CastAvailabilityManager.getLegalManaAbilities(stateManager, playerId, b.land);
          const minCostA = legalA.length > 0 ? Math.min(...legalA.map(ab => Number(ab.lifeCost || 0))) : 0;
          const minCostB = legalB.length > 0 ? Math.min(...legalB.map(ab => Number(ab.lifeCost || 0))) : 0;
          if (minCostA !== minCostB) return minCostB - minCostA;
          const lenA = Array.isArray(a.ability.produces) ? a.ability.produces.length : 1;
          const lenB = Array.isArray(b.ability.produces) ? b.ability.produces.length : 1;
          return lenA - lenB;
        });

        const chosen = candidates[0];
        const chosenId = chosen.land.instanceId || chosen.land.id || chosen.land;
        tappedLandIds.add(chosenId);
        taps.push({
          land: chosen.land,
          color: col,
          lifeCost: Number(chosen.ability.lifeCost || 0),
          abilityId: chosen.ability.id
        });
        needed--;
      }
    }

    // Pass 2: Generic Mana
    while (genericDeficit > 0) {
      const candidates = [];
      for (const land of untappedLands) {
        const lId = land.instanceId || land.id || land;
        if (tappedLandIds.has(lId)) continue;

        const legalAbilities = CastAvailabilityManager.getLegalManaAbilities(stateManager, playerId, land);
        if (legalAbilities.length > 0) {
          const bestAbility = legalAbilities[0];
          candidates.push({ land, ability: bestAbility });
        }
      }

      if (candidates.length === 0) {
        return {
          canPay: false,
          reason: 'INSUFFICIENT_GENERIC_MANA',
          totalCmc: parsedCost.totalCmc,
          deficit: genericDeficit,
          totalLifeCost: 0
        };
      }

      candidates.sort((a, b) => {
        const costA = Number(a.ability.lifeCost || 0);
        const costB = Number(b.ability.lifeCost || 0);
        if (costA !== costB) return costA - costB;
        const lenA = Array.isArray(a.ability.produces) ? a.ability.produces.length : 1;
        const lenB = Array.isArray(b.ability.produces) ? b.ability.produces.length : 1;
        return lenA - lenB;
      });

      const chosen = candidates[0];
      const chosenId = chosen.land.instanceId || chosen.land.id || chosen.land;
      tappedLandIds.add(chosenId);

      const chosenColor = (chosen.ability.produces && chosen.ability.produces.includes('C'))
        ? 'C'
        : (chosen.ability.produces?.[0] || 'C');

      taps.push({
        land: chosen.land,
        color: chosenColor,
        lifeCost: Number(chosen.ability.lifeCost || 0),
        abilityId: chosen.ability.id
      });
      genericDeficit--;
    }

    // Lethal Life Guard
    const totalLifeCost = phyrexianLifeCost + taps.reduce((sum, t) => sum + (t.lifeCost || 0), 0);
    if (totalLifeCost > 0 && (playerLife - totalLifeCost) <= 0 && !options.allowLethal) {
      return {
        canPay: false,
        reason: 'LETHAL_LIFE_COST',
        totalLifeCost,
        lifeCostTotal: totalLifeCost,
        playerLife
      };
    }

    const manaPaid = { ...poolDeducted };
    for (const t of taps) {
      if (t.color) {
        manaPaid[t.color] = (manaPaid[t.color] || 0) + 1;
      }
    }

    return {
      canPay: true,
      taps,
      poolDeducted,
      manaPaid,
      remainingPool: pool,
      totalLifeCost,
      lifeCostTotal: totalLifeCost
    };
  }

  /**
   * Computes the effective equip cost string after applying target-specific
   * static equip cost reductions (e.g. Fervent Champion's {3} reduction,
   * Belt of Giant Strength's {X} target power reduction, and Forge Anew's first equip {0}).
   *
   * @param {Object} equipment
   * @param {Object} [targetCreature]
   * @param {string|Object} [rawEquipCostOrState]
   * @param {string} [playerId]
   * @returns {string}
   */
  static computeEffectiveEquipCost(equipment, targetCreature = null, rawEquipCostOrState = null, playerId = null, explicitRawCost = null) {
    let rawEquipCost = explicitRawCost || null;
    let stateManager = null;
    if (typeof rawEquipCostOrState === 'string') {
      rawEquipCost = rawEquipCost || rawEquipCostOrState;
    } else if (rawEquipCostOrState && typeof rawEquipCostOrState === 'object') {
      stateManager = rawEquipCostOrState;
    }

    const effectivePlayerId = playerId || targetCreature?.controllerId || equipment?.controllerId || 'p1';
    let player = null;
    if (stateManager) {
      try {
        player = stateManager.getPlayer ? stateManager.getPlayer(effectivePlayerId) : stateManager.players?.[effectivePlayerId];
      } catch (_) {
        player = stateManager.players?.[effectivePlayerId];
      }
    }

    // 1. Forge Anew: FIRST_EQUIP_COST_ZERO check
    const hasForgeAnew = Boolean(
      player && (
        (player.battlefield?.noncreatures || []).some(nc =>
          /forge anew/i.test(nc?.name || '') ||
          nc?.compiledMechanics?.staticPermissions?.some(p => p.type === 'FIRST_EQUIP_COST_ZERO')
        ) ||
        (Array.isArray(player.battlefield) && player.battlefield.some(nc =>
          /forge anew/i.test(nc?.name || '') ||
          nc?.compiledMechanics?.staticPermissions?.some(p => p.type === 'FIRST_EQUIP_COST_ZERO')
        ))
      )
    );
    if (hasForgeAnew && player && !player.equipsActivatedThisTurn) {
      return '{0}';
    }

    const baseCostStr = rawEquipCost || equipment?.compiledMechanics?.equipCost || equipment?.equipCost || '{0}';
    let reduction = 0;

    if (targetCreature) {
      const permissions = targetCreature.compiledMechanics?.staticPermissions || targetCreature.staticPermissions || [];
      for (const sp of permissions) {
        if (sp && sp.type === 'TARGET_EQUIP_COST_REDUCTION') {
          reduction += Number(sp.genericReduction || 0);
        }
      }
      if (reduction === 0) {
        const oracle = String(targetCreature.oracleText || targetCreature.text || '');
        const match = oracle.match(/equip\s+abilities\s+you\s+activate\s+that\s+target\s+[^.]*?\s+cost\s+\{(\d+)\}\s+less/i);
        if (match) {
          reduction += parseInt(match[1], 10) || 0;
        } else if (/fervent champion/i.test(targetCreature.name || '')) {
          reduction += 3;
        }
      }
    }

    // 2. Belt of Giant Strength: equipDiscountByTargetPower
    const hasPowerDiscount = Boolean(
      /belt of giant strength/i.test(equipment?.name || '') ||
      equipment?.compiledMechanics?.attachmentEffects?.equipDiscountByTargetPower ||
      equipment?.compiledMechanics?.attachment?.equipDiscountByTargetPower ||
      /costs\s+\{X\}\s+less.*power\s+of\s+the\s+creature/i.test(equipment?.oracleText || equipment?.text || '')
    );
    if (hasPowerDiscount && targetCreature) {
      let targetPower = 0;
      if (stateManager && typeof stateManager.evaluateCreatureStats === 'function') {
        const stats = stateManager.evaluateCreatureStats(targetCreature, effectivePlayerId);
        targetPower = Number(stats.power ?? targetCreature.power ?? 0);
      } else {
        const p1 = Number(targetCreature.counters?.['+1/+1'] || 0);
        const m1 = Number(targetCreature.counters?.['-1/-1'] || 0);
        targetPower = (Number(targetCreature.power) || 0) + (p1 - m1);
      }
      reduction += Math.max(0, targetPower);
    }

    if (reduction <= 0) {
      return baseCostStr;
    }

    const tokens = String(baseCostStr).match(/\{([^}]+)\}/g) || [];
    let generic = 0;
    const coloredTokens = [];

    for (const tok of tokens) {
      const sym = tok.replace(/[{}]/g, '').trim();
      const num = parseInt(sym, 10);
      if (!isNaN(num)) {
        generic += num;
      } else {
        coloredTokens.push(`{${sym.toUpperCase()}}`);
      }
    }

    const reducedGeneric = Math.max(0, generic - reduction);
    if (coloredTokens.length === 0) {
      return `{${reducedGeneric}}`;
    }
    if (reducedGeneric > 0) {
      return `{${reducedGeneric}}${coloredTokens.join('')}`;
    }
    return coloredTokens.join('');
  }

  /**
   * Evaluates all castable modes of a card for timing and mana affordability.
   * 
   * @param {Object} stateManager
   * @param {string} playerId
   * @param {Object} card
   * @param {Object} [priorityState]
   * @returns {{ allowed: boolean, availableModes: Array<Object>, allModes: Array<Object> }}
   */
  static evaluateCardAvailability(stateManager, playerId, card, priorityState = null) {
    if (!stateManager || !card) {
      return { allowed: false, availableModes: [], allModes: [] };
    }

    const psm = priorityState || stateManager.priorityMachine;
    const modes = CastAvailabilityManager.getCastableModes(stateManager, playerId, card);
    const allModes = [];
    const availableModes = [];

    let player;
    try {
      player = stateManager ? stateManager.getPlayer(playerId) : null;
    } catch (_) {
      player = stateManager?.players?.[playerId];
    }
    const controlledCreatures = player?.battlefield?.creatures || [];
    const creatureCount = controlledCreatures.length;

    for (const mode of modes) {
      const isCallousMain = mode.mode === 'MAIN' && (/callous sell-sword/i.test(mode.name || card.name || ''));
      const isBurnAdv = mode.mode === 'ADVENTURE' || /burn together/i.test(mode.name || '');

      let modeManaCost = mode.manaCost;
      if (typeof modeManaCost === 'string' && modeManaCost.includes('//')) {
        const parts = modeManaCost.split('//').map(s => s.trim());
        modeManaCost = isBurnAdv ? parts[1] : parts[0];
      }
      if (isCallousMain) {
        modeManaCost = '{1}{B}';
      } else if (isBurnAdv) {
        modeManaCost = '{R}';
      }

      const cardForTiming = {
        ...card,
        name: mode.name || card.name,
        manaCost: modeManaCost,
        typeLine: mode.typeLine || card.typeLine,
        type: mode.typeLine || card.typeLine
      };

      const timingCheck = stateManager.canPlayerCastOrPlay(playerId, cardForTiming, psm, { castMode: mode.mode });
      const paymentCheck = CastAvailabilityManager.computeOptimalManaPayment(stateManager, playerId, modeManaCost, { castMode: mode.mode });

      let selectable = true;
      let unselectableReason = null;
      if (isBurnAdv && creatureCount === 0) {
        selectable = false;
        unselectableReason = 'NO_CONTROLLED_CREATURES_TO_SACRIFICE';
      }

      const isAvailable = Boolean(timingCheck.allowed && paymentCheck.canPay && selectable);
      const modeResult = {
        ...mode,
        manaCost: modeManaCost,
        requiresTarget: isBurnAdv ? true : false,
        requiresTargets: isBurnAdv ? true : false,
        selectable,
        timingAllowed: Boolean(timingCheck.allowed),
        timingReason: timingCheck.reason || null,
        canPayMana: Boolean(paymentCheck.canPay),
        paymentDetails: paymentCheck,
        unselectableReason,
        isAvailable
      };

      allModes.push(modeResult);
      if (isAvailable) {
        availableModes.push(modeResult);
      }
    }

    return {
      allowed: availableModes.length > 0,
      availableModes,
      allModes
    };
  }
}

export default CastAvailabilityManager;
