/**
 * OracleEffectCompiler.js
 * 
 * Deterministic MTG Rules & Oracle Text Compilation Engine.
 * Parses raw Scryfall metadata (typeLine, oracleText, manaCost, etc.) into
 * structured, serializable mechanics descriptors:
 * - Category & Destination Subzone (creatures, lands, noncreatures, planeswalkers, spells)
 * - Mana Production Profile & Life Costs (e.g. Mana Confluence, Starting Town)
 * - Spell Effects (Damage, Stat Buffs, Keyword Grants, Card Draw, Counterspells, Removal, Life)
 * - Equipment & Aura Attachment Modifiers (P/T deltas, keyword grants/losses, equip costs, auto-attach)
 * - Triggered & Static Abilities (ETB, Dies, Attacks, Valiant / Becomes Target, Flash Grants)
 * - Per-card automated smoke testing (smokeTestCard)
 * 
 * 100% Headless-Safe (INV-ARCH-HEADLESS): Zero unguarded browser globals.
 * 
 * @module OracleEffectCompiler
 */

/**
 * Standard MTG Keywords normalized list.
 */
export const STANDARD_KEYWORDS = Object.freeze([
  'flying', 'haste', 'vigilance', 'trample', 'lifelink',
  'deathtouch', 'reach', 'flash', 'prowess', 'firstStrike',
  'doubleStrike', 'menace', 'hexproof', 'indestructible'
]);

/**
 * Compiles a card's type line into its canonical category, tabletop subzone, and permanence flag.
 * 
 * @param {string} typeLine
 * @param {boolean} [defaultIsPermanent=false]
 * @returns {{ category: string, subzone: string|null, isPermanent: boolean }}
 */
export function compileCardCategory(typeLine = '', defaultIsPermanent = false) {
  const tl = String(typeLine || '').toLowerCase();

  if (tl.includes('creature')) {
    return { category: 'creatures', subzone: 'creatures', isPermanent: true };
  }
  if (tl.includes('land')) {
    return { category: 'lands', subzone: 'lands', isPermanent: true };
  }
  if (tl.includes('planeswalker')) {
    return { category: 'otherPermanents', subzone: 'planeswalkers', isPermanent: true };
  }
  if (tl.includes('artifact') || tl.includes('enchantment') || tl.includes('battle')) {
    return { category: 'otherPermanents', subzone: 'noncreatures', isPermanent: true };
  }
  if (tl.includes('instant') || tl.includes('sorcery')) {
    return { category: 'spells', subzone: null, isPermanent: false };
  }

  // Fallback based on default permanence
  if (defaultIsPermanent) {
    return { category: 'otherPermanents', subzone: 'noncreatures', isPermanent: true };
  }
  return { category: 'spells', subzone: null, isPermanent: false };
}

/**
 * Parses land and permanent mana abilities line-by-line into structured descriptors.
 * 
 * @param {string} typeLine
 * @param {string} oracleText
 * @param {string[]} [existingColors=[]]
 * @returns {Array<{ id: string, produces: string[], lifeCost: number, condition: string|null }>}
 */
export function compileManaAbilities(typeLine = '', oracleText = '', existingColors = []) {
  const tl = String(typeLine || '').toLowerCase();
  const ot = String(oracleText || '');
  const abilities = [];

  const isLand = tl.includes('land');
  const lines = ot.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let hasColorless = false;
  let hasAnyColor = false;

  for (const line of lines) {
    const lineLower = line.toLowerCase();

    // Check for colorless ability: "{T}: Add {C}" without paying life
    if (/(?:\{t\}|add).*\{c\}/i.test(line) && !/pay\s+\d+\s+life/i.test(lineLower)) {
      if (!hasColorless) {
        abilities.push({
          id: 'colorless',
          produces: ['C'],
          lifeCost: 0,
          condition: null
        });
        hasColorless = true;
      }
    }

    // Check for any color ability: "Add one mana of any color" or "mana of any color"
    if (
      lineLower.includes('add one mana of any color') ||
      lineLower.includes('mana of any color') ||
      lineLower.includes('mana of any type') ||
      lineLower.includes('add {w}, {u}, {b}, {r}, or {g}')
    ) {
      if (!hasAnyColor) {
        const lifeCostMatch = line.match(/pay\s+(\d+)\s+life/i) || ot.match(/pay\s+(\d+)\s+life/i);
        const lifeCost = lifeCostMatch ? (parseInt(lifeCostMatch[1], 10) || 1) : 0;

        const conditionMatch = /activate\s+only\s+if\s+you\s+control\s+an\s+artifact/i.test(line) ||
                               /activate\s+only\s+if\s+you\s+control\s+an\s+artifact/i.test(ot);
        const condition = conditionMatch ? 'CONTROLS_ARTIFACT' : null;

        abilities.push({
          id: 'any_color',
          produces: ['W', 'U', 'B', 'R', 'G'],
          lifeCost,
          condition
        });
        hasAnyColor = true;
      }
    }
  }

  // Check for Jegantha / restricted WUBRG mana ability
  if (/add\s*\{w\}\{u\}\{b\}\{r\}\{g\}/i.test(ot)) {
    const restricted = /can't be spent to pay generic mana costs|cannot be spent to pay generic/i.test(ot) ? 'NO_GENERIC' : null;
    abilities.push({
      id: 'jegantha',
      produces: ['W', 'U', 'B', 'R', 'G'],
      lifeCost: 0,
      condition: null,
      restrictedSpend: restricted
    });
  }

  // If no explicit abilities found from lines, parse standard land subtypes / colors
  if (abilities.length === 0 && isLand) {
    const produces = [];
    if (tl.includes('plains')) produces.push('W');
    if (tl.includes('island')) produces.push('U');
    if (tl.includes('swamp')) produces.push('B');
    if (tl.includes('mountain')) produces.push('R');
    if (tl.includes('forest')) produces.push('G');
    if (tl.includes('wastes')) produces.push('C');

    if (produces.length === 0) {
      const addMatches = ot.match(/\{([wubrgc])\}/gi);
      if (addMatches) {
        const syms = new Set(addMatches.map(s => s.replace(/[{}]/g, '').toUpperCase()));
        ['W', 'U', 'B', 'R', 'G', 'C'].forEach(c => {
          if (syms.has(c)) produces.push(c);
        });
      }
    }

    if (produces.length === 0 && Array.isArray(existingColors) && existingColors.length > 0) {
      existingColors.forEach(c => produces.push(String(c).toUpperCase()));
    }

    if (produces.length === 0) {
      produces.push('C');
    }

    abilities.push({
      id: 'mana_0',
      produces,
      lifeCost: 0,
      condition: null
    });
  }

  // Sort by lifeCost ascending (0 first, then 1, etc.)
  abilities.sort((a, b) => a.lifeCost - b.lifeCost);

  return abilities;
}

/**
 * Parses mana production capabilities from oracle text and type line.
 * 
 * @param {string} typeLine
 * @param {string} oracleText
 * @param {string[]} [existingColors=[]]
 * @returns {{ manaProfile: string[], manaLifeCost: number, producesAnyColor: boolean, manaAbilities: Array }}
 */
export function compileManaProfile(typeLine = '', oracleText = '', existingColors = []) {
  const tl = String(typeLine || '').toLowerCase();
  const ot = String(oracleText || '').toLowerCase();
  const profileSet = new Set();
  let manaLifeCost = 0;

  // 1. Any color patterns (e.g. Mana Confluence, Starting Town, City of Brass, Birds of Paradise)
  const isAnyColor = Boolean(
    ot.includes('add one mana of any color') ||
    ot.includes('add one mana of any type') ||
    ot.includes('mana of any color') ||
    ot.includes('mana of any type') ||
    ot.includes('add {w}, {u}, {b}, {r}, or {g}')
  );
  if (isAnyColor) {
    ['W', 'U', 'B', 'R', 'G'].forEach(c => profileSet.add(c));
  }

  // 2. Explicit symbols in mana abilities (e.g., "{T}: Add {W} or {U}", "Add {C}", "({T}: Add {R}.)")
  const addAbilityRegex = /(?:add|\{t\}:?\s*add)\s+([^.\n]+)/gi;
  let addMatch;
  while ((addMatch = addAbilityRegex.exec(ot)) !== null) {
    const segment = addMatch[1];
    const symbolMatches = segment.match(/\{([wubrgc])\}/gi);
    if (symbolMatches) {
      symbolMatches.forEach(sym => {
        const clean = sym.replace(/[{}]/g, '').toUpperCase();
        profileSet.add(clean);
      });
    }
  }

  // 3. Basic land subtypes in type line
  if (tl.includes('plains')) profileSet.add('W');
  if (tl.includes('island')) profileSet.add('U');
  if (tl.includes('swamp')) profileSet.add('B');
  if (tl.includes('mountain')) profileSet.add('R');
  if (tl.includes('forest')) profileSet.add('G');
  if (tl.includes('wastes')) profileSet.add('C');

  // 4. Life cost payment in mana abilities (e.g. "Pay 1 life, {T}: Add...", "{T}, Pay 1 life: Add...")
  const lifeCostMatch = ot.match(/pay\s+(\d+)\s+life/i);
  if (lifeCostMatch && (ot.includes('add') || tl.includes('land'))) {
    manaLifeCost = parseInt(lifeCostMatch[1], 10) || 1;
  }

  // 5. Fallback: if land has no explicit profile yet, check existing colors
  if (profileSet.size === 0 && tl.includes('land')) {
    if (Array.isArray(existingColors) && existingColors.length > 0) {
      existingColors.forEach(c => profileSet.add(String(c).toUpperCase()));
    } else {
      profileSet.add('C');
    }
  }

  const manaAbilities = compileManaAbilities(typeLine, oracleText, existingColors);

  const hasZeroLifeColorless = manaAbilities.some(a => a.lifeCost === 0 && a.produces.includes('C'));
  const hasConditionalOrPaidColored = manaAbilities.some(a => (a.lifeCost > 0 || a.condition !== null) && a.produces.some(c => c !== 'C'));

  let manaProfile = [];
  if (hasZeroLifeColorless && hasConditionalOrPaidColored) {
    manaProfile.push('C');
    ['W', 'U', 'B', 'R', 'G'].forEach(col => {
      if (profileSet.has(col) && !manaProfile.includes(col)) {
        manaProfile.push(col);
      }
    });
  } else {
    const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'];
    manaProfile = COLOR_ORDER.filter(col => profileSet.has(col));
    if (manaProfile.length === 0 && profileSet.size > 0) {
      manaProfile.push(...profileSet);
    }
  }

  const finalProfile = manaProfile.length > 0 ? manaProfile : (tl.includes('land') ? ['C'] : []);
  finalProfile.producesAnyColor = isAnyColor;

  return {
    manaProfile: finalProfile,
    manaLifeCost,
    producesAnyColor: isAnyColor,
    manaAbilities
  };
}

/**
 * Parses ETB tapped conditions from oracle text.
 * 
 * @param {string} oracleText
 * @returns {'UNLESS_ROUND_1_2_OR_3'|null}
 */
export function compileEtbTappedCondition(oracleText = '') {
  const ot = String(oracleText || '');
  if (
    /enters(?:\s+the\s+battlefield)?\s+tapped\s+unless\s+it's\s+(?:the|your)\s+first,\s+second,\s+or\s+third\s+(?:turn|round)/i.test(ot) ||
    /enters(?:\s+the\s+battlefield)?\s+tapped\s+unless\s+you\s+control\s+two\s+or\s+fewer\s+other\s+lands/i.test(ot)
  ) {
    return 'UNLESS_ROUND_1_2_OR_3';
  }
  return null;
}

/**
 * Parses cast modes for adventure, split, and standard cards.
 * 
 * @param {Object} card
 * @returns {Array<Object>}
 */
export function compileCastModes(card) {
  if (!card) return [];

  const name = String(card.name || '').trim();
  const typeLine = String(card.typeLine || card.type_line || card.type || '').trim();
  const oracleText = String(card.oracleText || card.oracle_text || card.text || '').trim();
  const layout = String(card.layout || '').toLowerCase();

  const isAdventure = layout === 'adventure' ||
                      /adventure/i.test(typeLine) ||
                      (Array.isArray(card.cardFaces) && card.cardFaces.some(f => /adventure/i.test(f.typeLine || ''))) ||
                      (Array.isArray(card.card_faces) && card.card_faces.some(f => /adventure/i.test(f.type_line || '')));

  const rawFaces = card.cardFaces || card.card_faces;

  const isBattle = layout === 'transform' ||
                   /battle/i.test(typeLine) ||
                   (Array.isArray(rawFaces) && rawFaces.some(f => /battle/i.test(f.typeLine || f.type_line || '')));

  if (isBattle && (rawFaces?.length >= 2 || name.includes(' // '))) {
    const nameParts = name.split(' // ');
    const f0 = rawFaces?.[0] || {
      name: nameParts[0]?.trim() || name,
      manaCost: card.manaCost || card.mana_cost || '',
      typeLine: typeLine.split(' // ')[0]?.trim() || 'Battle — Siege',
      defense: card.defense ?? 3,
      oracleText
    };
    const f1 = rawFaces?.[1] || {
      name: nameParts[1]?.trim() || 'Lightshield Array',
      manaCost: '',
      typeLine: typeLine.split(' // ')[1]?.trim() || 'Enchantment',
      oracleText: "At the beginning of your end step, put a +1/+1 counter on each creature that attacked this turn.\nSacrifice this enchantment: Creatures you control gain hexproof and indestructible until end of turn."
    };

    const mode0 = {
      mode: 'MAIN',
      name: f0.name,
      manaCost: f0.manaCost || f0.mana_cost || card.manaCost || '',
      typeLine: f0.typeLine || f0.type_line || 'Battle — Siege',
      defense: f0.defense ?? card.defense ?? 3,
      oracleText: f0.oracleText || f0.oracle_text || oracleText,
      exileOnResolve: false,
      isPermanent: true,
      subzone: 'noncreatures'
    };

    const mode1 = {
      mode: 'TRANSFORM',
      name: f1.name,
      manaCost: f1.manaCost || f1.mana_cost || '',
      typeLine: f1.typeLine || f1.type_line || 'Enchantment',
      oracleText: f1.oracleText || f1.oracle_text || '',
      exileOnResolve: false,
      isPermanent: true,
      subzone: 'noncreatures',
      transformedFace: f1
    };

    return [mode0, mode1];
  }

  const isSplit = layout === 'split' ||
                  (!isAdventure && !isBattle && name.includes(' // '));

  if (isAdventure) {
    let face0 = rawFaces?.[0];
    let face1 = rawFaces?.[1];

    if (!face0 || !face1) {
      const baseName = card._originalCardProperties?.name || name;
      const nameParts = baseName.split(' // ');
      const isBurnTogether = /callous sell-sword|burn together/i.test(baseName);
      const manaParts = String(card._originalCardProperties?.manaCost || card.manaCost || card.mana_cost || '').split(' // ');
      const typeParts = String(card._originalCardProperties?.typeLine || typeLine).split(' // ');
      const oracleParts = oracleText.split('\n\n');

      face0 = {
        name: (nameParts.length > 1 ? nameParts[0]?.trim() : (isBurnTogether ? 'Callous Sell-Sword' : nameParts[0]?.trim())) || name,
        manaCost: (manaParts.length > 1 ? manaParts[0]?.trim() : (isBurnTogether ? '{1}{B}' : manaParts[0]?.trim())) || '{1}{B}',
        typeLine: (typeParts.length > 1 ? typeParts[0]?.trim() : (isBurnTogether ? 'Creature — Human Soldier' : typeParts[0]?.trim())) || 'Creature — Human Soldier',
        power: card.power !== undefined ? card.power : 2,
        toughness: card.toughness !== undefined ? card.toughness : 2,
        oracleText: oracleParts[0]?.trim() || ''
      };
      face1 = {
        name: nameParts[1]?.trim() || 'Burn Together',
        manaCost: manaParts[1]?.trim() || '{R}',
        typeLine: typeParts[1]?.trim() || 'Sorcery — Adventure',
        oracleText: oracleParts[1]?.trim() || 'Target creature you control deals damage equal to its power to any other target. Then sacrifice it.'
      };
    }

    const face0Oracle = face0.oracleText || face0.oracle_text || '';
    const face1Oracle = face1.oracleText || face1.oracle_text || '';
    const face0Cat = compileCardCategory(face0.typeLine || face0.type_line || 'Creature', true);

    const mode0 = {
      mode: 'MAIN',
      name: face0.name,
      manaCost: face0.manaCost || face0.mana_cost || '',
      typeLine: face0.typeLine || face0.type_line || '',
      power: face0.power !== undefined && face0.power !== null ? Number(face0.power) : (card.power !== undefined ? Number(card.power) : undefined),
      toughness: face0.toughness !== undefined && face0.toughness !== null ? Number(face0.toughness) : (card.toughness !== undefined ? Number(card.toughness) : undefined),
      oracleText: face0Oracle,
      exileOnResolve: false,
      isPermanent: face0Cat.isPermanent,
      subzone: face0Cat.subzone
    };

    const mode1 = {
      mode: 'ADVENTURE',
      name: face1.name,
      manaCost: face1.manaCost || face1.mana_cost || '',
      typeLine: face1.typeLine || face1.type_line || '',
      oracleText: face1Oracle,
      exileOnResolve: true,
      isPermanent: false,
      subzone: null,
      spellEffects: compileSpellEffects(face1Oracle)
    };

    return [mode0, mode1];
  }

  if (isSplit && (rawFaces?.length >= 2 || name.includes(' // '))) {
    let face0 = rawFaces?.[0];
    let face1 = rawFaces?.[1];

    if (!face0 || !face1) {
      const nameParts = name.split(' // ');
      const manaParts = String(card.manaCost || card.mana_cost || '').split(' // ');
      const typeParts = typeLine.split(' // ');
      const oracleParts = oracleText.split('\n\n');

      face0 = {
        name: nameParts[0]?.trim() || name,
        manaCost: manaParts[0]?.trim() || '',
        typeLine: typeParts[0]?.trim() || 'Instant',
        oracleText: oracleParts[0]?.trim() || ''
      };
      face1 = {
        name: nameParts[1]?.trim() || '',
        manaCost: manaParts[1]?.trim() || '',
        typeLine: typeParts[1]?.trim() || 'Instant',
        oracleText: oracleParts[1]?.trim() || ''
      };
    }

    const face0Oracle = face0.oracleText || face0.oracle_text || '';
    const face1Oracle = face1.oracleText || face1.oracle_text || '';
    const face0Cat = compileCardCategory(face0.typeLine || face0.type_line || 'Instant', false);
    const face1Cat = compileCardCategory(face1.typeLine || face1.type_line || 'Instant', false);

    const mode0 = {
      mode: 'SPLIT_LEFT',
      name: face0.name,
      manaCost: face0.manaCost || face0.mana_cost || '',
      typeLine: face0.typeLine || face0.type_line || '',
      oracleText: face0Oracle,
      exileOnResolve: false,
      isPermanent: face0Cat.isPermanent,
      subzone: face0Cat.subzone,
      spellEffects: compileSpellEffects(face0Oracle)
    };

    const mode1 = {
      mode: 'SPLIT_RIGHT',
      name: face1.name,
      manaCost: face1.manaCost || face1.mana_cost || '',
      typeLine: face1.typeLine || face1.type_line || '',
      oracleText: face1Oracle,
      exileOnResolve: false,
      isPermanent: face1Cat.isPermanent,
      subzone: face1Cat.subzone,
      spellEffects: compileSpellEffects(face1Oracle)
    };

    const hasFuse = /\bfuse\b/i.test(oracleText) || /\bfuse\b/i.test(face0Oracle) || /\bfuse\b/i.test(face1Oracle);
    if (hasFuse) {
      const tokens0 = (mode0.manaCost || '').match(/\{[^}]+\}/g) || [];
      const tokens1 = (mode1.manaCost || '').match(/\{[^}]+\}/g) || [];
      let fusedGeneric = 0;
      const fusedColored = [];
      for (const t of [...tokens0, ...tokens1]) {
        const sym = t.replace(/[{}]/g, '').trim();
        const num = parseInt(sym, 10);
        if (!isNaN(num)) fusedGeneric += num;
        else fusedColored.push(`{${sym}}`);
      }
      const fusedManaCost = (fusedGeneric > 0 ? `{${fusedGeneric}}` : '') + fusedColored.join('');
      const fusedMode = {
        mode: 'FUSED',
        name: `${face0.name} // ${face1.name}`,
        manaCost: fusedManaCost || '{1}{R}{W}',
        typeLine: `${face0.typeLine || 'Instant'} // ${face1.typeLine || 'Instant'}`,
        oracleText: `${face0Oracle}\n\n${face1Oracle}`,
        exileOnResolve: false,
        isPermanent: false,
        subzone: null,
        spellEffects: [...mode0.spellEffects, ...mode1.spellEffects]
      };
      return [mode0, mode1, fusedMode];
    }

    return [mode0, mode1];
  }

  const cat = compileCardCategory(typeLine, card.isPermanent);
  const singleMode = {
    mode: 'MAIN',
    name,
    manaCost: card.manaCost !== undefined ? card.manaCost : (card.mana_cost || ''),
    typeLine,
    power: card.power !== undefined && card.power !== null && !isNaN(Number(card.power)) ? Number(card.power) : undefined,
    toughness: card.toughness !== undefined && card.toughness !== null && !isNaN(Number(card.toughness)) ? Number(card.toughness) : undefined,
    oracleText,
    exileOnResolve: false,
    isPermanent: cat.isPermanent,
    subzone: cat.subzone
  };

  return [singleMode];
}

/**
 * Parses spell effects (damage, stat buffs, card draw, counter, destroy, life) from oracle text.
 * 
 * @param {string} oracleText
 * @returns {Array<Object>}
 */
export function compileSpellEffects(oracleText = '') {
  const ot = String(oracleText || '');
  const effects = [];

  // 0a. Stolen Uniform: Gain control of target Equipment until EOT and attach to target creature
  if (/gain\s+control\s+of\s+that\s+equipment.*attach\s+it/i.test(ot)) {
    effects.push({
      type: 'GAIN_CONTROL_ATTACH_EQUIPMENT',
      action: 'GAIN_CONTROL_ATTACH_EQUIPMENT',
      unattachOnControlLoss: true,
      duration: 'END_OF_TURN'
    });
  }

  // 0b. Surge of Salvation: Prevent all damage that black and/or red sources would deal
  if (/prevent\s+all\s+damage\s+that\s+(?:black\s+and\/or\s+red|red\s+and\/or\s+black)\s+sources\s+would\s+deal/i.test(ot)) {
    effects.push({
      type: 'PREVENT_COLOR_DAMAGE',
      action: 'PREVENT_COLOR_DAMAGE',
      colors: ['B', 'R'],
      preventColors: ['B', 'R'],
      scope: 'CONTROLLER_CREATURES',
      duration: 'END_OF_TURN'
    });
  }

  // 0c. Surgical Extraction: Search graveyard, hand, and library for same name and exile
  if (/search\s+its\s+owner's\s+graveyard,\s+hand,\s+and\s+library\s+for.*same\s+name/i.test(ot)) {
    effects.push({
      type: 'SURGICAL_EXTRACT_NAME',
      action: 'SURGICAL_EXTRACT_NAME'
    });
  }

  // 0. Fling / Sacrifice Damage (e.g. Burn Together)
  if (/deals\s+damage\s+equal\s+to\s+its\s+power\s+to\s+any(?:\s+other)?\s+target.*then\s+sacrifice\s+it/i.test(ot) ||
      /target\s+creature\s+you\s+control\s+deals\s+damage\s+equal\s+to\s+its\s+power.*sacrifice\s+it/i.test(ot)) {
    effects.push({
      type: 'FLING_SACRIFICE_DAMAGE',
      action: 'FLING_SACRIFICE_DAMAGE',
      targetType: 'any',
      requiresControlledCreature: true,
      sacrificeSourceCreature: true
    });
  }

  // 1. Direct Damage (e.g. "deals 3 damage to any target")
  const damageRegex = /deals\s+(\d+)\s+damage\s+to\s+(any target|target creature or planeswalker|target player or planeswalker|target creature|target player|target opponent|each opponent|each creature)/i;
  const dmgMatch = ot.match(damageRegex);
  if (dmgMatch) {
    let targetType = dmgMatch[2].toLowerCase();
    if (targetType === 'any target') targetType = 'any';
    else if (targetType.includes('player or planeswalker')) targetType = 'player_or_planeswalker';
    else if (targetType.includes('creature or planeswalker')) targetType = 'creature_or_planeswalker';
    else if (targetType.includes('opponent')) targetType = 'opponent';
    else if (targetType.includes('creature')) targetType = 'creature';
    else if (targetType.includes('player')) targetType = 'player';

    effects.push({
      type: 'DEAL_DAMAGE',
      action: 'DEAL_DAMAGE',
      amount: parseInt(dmgMatch[1], 10),
      targetType
    });
  }

  // 2. Stat Buffs & Keyword Grants (e.g. Resolute Strike: "Target creature gets +2/+2 until end of turn. If it's a Warrior, you may attach an Equipment you control to it.")
  const pumpRegex = /gets\s+([+-]\d+)\/([+-]\d+)/i;
  const pumpMatch = ot.match(pumpRegex);
  const keywordGrantRegex = /gains?\s+([a-z\s,]+)\s+until\s+end\s+of\s+turn/i;
  const kwMatch = ot.match(keywordGrantRegex);

  if (pumpMatch || kwMatch) {
    const powerDelta = pumpMatch ? parseInt(pumpMatch[1], 10) : 0;
    const toughnessDelta = pumpMatch ? parseInt(pumpMatch[2], 10) : 0;
    const keywordsGranted = [];

    if (kwMatch) {
      const grantString = kwMatch[1].toLowerCase();
      STANDARD_KEYWORDS.forEach(kw => {
        const regex = new RegExp(`\\b${kw.replace(/([A-Z])/g, ' $1').toLowerCase()}\\b`, 'i');
        if (regex.test(grantString)) {
          keywordsGranted.push(kw);
        }
      });
    }

    const autoAttachEquipment = /attach\s+(?:target\s+|an\s+)?equipment/i.test(ot);
    const subtypeMatch = ot.match(/if\s+it's\s+a\s+([a-z]+),\s+you\s+may\s+attach\s+(?:target\s+|an\s+)?equipment/i);
    const requiresSubtype = subtypeMatch ? subtypeMatch[1] : undefined;

    let scope = 'TARGET';
    if (/you and permanents you control gain/i.test(ot)) {
      scope = 'CONTROLLER_PERMANENTS';
    } else if (/(?:creatures|permanents) you control (?:get|gain)/i.test(ot)) {
      scope = 'CONTROLLER_CREATURES';
    } else if (!/target/i.test(ot)) {
      scope = 'CONTROLLER_PERMANENTS';
    }

    effects.push({
      type: 'PUMP_PT_AND_KEYWORDS',
      action: 'PUMP_PT_AND_KEYWORDS',
      powerDelta,
      toughnessDelta,
      keywordsGranted,
      duration: 'END_OF_TURN',
      autoAttachEquipment,
      ...(requiresSubtype ? { requiresSubtypeForAttach: requiresSubtype, requiresSubtype } : {}),
      scope
    });
  }

  // 3. Card Draw (e.g. "draw two cards", "draw a card")
  const drawRegex = /draw\s+(a|one|two|three|\d+)\s+cards?/i;
  const drawMatch = ot.match(drawRegex);
  if (drawMatch) {
    let amount = 1;
    const word = drawMatch[1].toLowerCase();
    if (word === 'a' || word === 'one') amount = 1;
    else if (word === 'two') amount = 2;
    else if (word === 'three') amount = 3;
    else amount = parseInt(word, 10) || 1;

    effects.push({
      type: 'DRAW_CARD',
      action: 'DRAW_CARD',
      amount
    });
  }

  // 4. Destroy / Exile Target (e.g. "destroy target artifact or enchantment", "exile target creature")
  const removalRegex = /(destroy|exile)\s+target\s+([a-z\s]+?)(?:\.|$)/i;
  const remMatch = ot.match(removalRegex);
  if (remMatch) {
    const act = remMatch[1].toUpperCase() === 'DESTROY' ? 'DESTROY_TARGET' : 'EXILE_TARGET';
    const filter = remMatch[2].trim().toLowerCase();
    effects.push({
      type: act,
      action: act,
      targetFilter: filter
    });
  }

  // 5. Counterspell (e.g. "counter target spell")
  if (/counter\s+target\s+(?:noncreature\s+)?spell/i.test(ot)) {
    effects.push({
      type: 'COUNTER_TARGET',
      action: 'COUNTER_TARGET'
    });
  }

  // 6. Life Gain / Loss (e.g. "you gain 3 life")
  const lifeGainRegex = /gain\s+(\d+)\s+life/i;
  const lgMatch = ot.match(lifeGainRegex);
  if (lgMatch) {
    effects.push({
      type: 'MODIFY_LIFE',
      action: 'MODIFY_LIFE',
      amount: parseInt(lgMatch[1], 10)
    });
  }

  return effects;
}

/**
 * Parses Equipment and Aura modifiers (P/T bonuses, granted/lost keywords, equip cost, pregame opening hand).
 * 
 * @param {string} typeLine
 * @param {string} oracleText
 * @returns {Object|null}
 */
export function compileAttachmentEffects(typeLine = '', oracleText = '') {
  const tl = String(typeLine || '').toLowerCase();
  const ot = String(oracleText || '');

  const isEquipment = tl.includes('equipment');
  const isAura = tl.includes('aura');

  if (!isEquipment && !isAura) {
    return null;
  }

  // 1. P/T Modifiers (e.g. "Equipped creature gets +10/+10", "Enchanted creature gets +1/+1")
  let powerDelta = 0;
  let toughnessDelta = 0;
  const ptMatch = ot.match(/(?:equipped|enchanted)\s+creature\s+gets\s+([+-]\d+)\/([+-]\d+)/i);
  if (ptMatch) {
    powerDelta = parseInt(ptMatch[1], 10) || 0;
    toughnessDelta = parseInt(ptMatch[2], 10) || 0;
  }

  // 1b. Layer 7b Base P/T Setting (e.g. Belt of Giant Strength: "Equipped creature has base power and toughness 10/10.")
  let setPower = undefined;
  let setToughness = undefined;
  let basePower = undefined;
  let baseToughness = undefined;
  const basePtMatch = ot.match(/(?:equipped|enchanted)\s+creature\s+has\s+base\s+power\s+and\s+toughness\s+(\d+)\/(\d+)/i);
  if (basePtMatch) {
    setPower = parseInt(basePtMatch[1], 10);
    setToughness = parseInt(basePtMatch[2], 10);
    basePower = setPower;
    baseToughness = setToughness;
  }

  const equipDiscountByTargetPower = /costs\s+\{X\}\s+less\s+to\s+activate,\s+where\s+X\s+is\s+the\s+power\s+of\s+the\s+creature/i.test(ot);

  // 2. Granted Keywords (e.g. "and has double strike and trample", "Equipped creature has hexproof and haste")
  const keywordsGranted = [];
  const hasMatch = ot.match(/(?:(?:equipped|enchanted)\s+creature\s+(?:gets\s+[+-]\d+\/[+-]\d+\s+and\s+)?has|and\s+has)\s+([^.\n]+)/i);
  if (hasMatch) {
    const sub = hasMatch[1].toLowerCase();
    STANDARD_KEYWORDS.forEach(kw => {
      const reg = new RegExp(`\\b${kw.replace(/([A-Z])/g, ' $1').toLowerCase()}\\b`, 'i');
      if (reg.test(sub)) {
        keywordsGranted.push(kw);
      }
    });
  }

  // 3. Lost Keywords (e.g. Colossus Hammer: "and loses flying")
  const keywordsLost = [];
  const loseMatch = ot.match(/and\s+loses\s+([^.\n]+)/i);
  if (loseMatch) {
    const sub = loseMatch[1].toLowerCase();
    STANDARD_KEYWORDS.forEach(kw => {
      const reg = new RegExp(`\\b${kw.replace(/([A-Z])/g, ' $1').toLowerCase()}\\b`, 'i');
      if (reg.test(sub)) {
        keywordsLost.push(kw);
      }
    });
  }

  // 4. Equip Cost (e.g. "Equip {8}", "Equip—Pay 3 life", "Equip {3}")
  let equipCost = null;
  const equipMatch = ot.match(/equip(?:—|\s+)\{?([^}\n.]+)\}?/i);
  if (equipMatch) {
    const rawCost = equipMatch[1].trim();
    equipCost = rawCost.startsWith('{') ? rawCost : `{${rawCost}}`;
  }

  // 5. Pregame opening hand placement (e.g. Leyline Axe: "if ~ is in your opening hand, you may begin the game with it on the battlefield")
  const canBeginOnBattlefield = /opening\s+hand.*begin\s+the\s+game\s+with\s+it\s+on\s+the\s+battlefield/i.test(ot);

  return {
    isEquipment,
    isAura,
    powerDelta,
    toughnessDelta,
    powerModifier: powerDelta,
    toughnessModifier: toughnessDelta,
    ...(setPower !== undefined ? { setPower, setToughness, basePower, baseToughness } : {}),
    ...(equipDiscountByTargetPower ? { equipDiscountByTargetPower: true } : {}),
    keywordsGranted,
    keywordsLost,
    lostKeywords: keywordsLost,
    loseKeywords: keywordsLost,
    equipCost,
    canBeginOnBattlefield
  };
}

/**
 * Parses Triggered and Static abilities from oracle text.
 * 
 * @param {string} oracleText
 * @returns {Array<Object>}
 */
export function compileTriggeredAbilities(oracleText = '') {
  const ot = String(oracleText || '');
  const triggers = [];

  // 1. ON_ETB (Only for self-ETB, avoiding "an equipment enters" or other permanents entering)
  const isEquipmentOrAnotherEtb = /when(?:ever)?\s+(?:an?\s+equipment|another\s+|a\s+creature|a\s+land)\s+.*enters/i.test(ot);
  if (!isEquipmentOrAnotherEtb && /when(?:ever)?\s+(?:this\s+(?:permanent|creature|artifact|enchantment|siege)|~|it|[a-z'\s-]+)\s+enters(?:\s+the\s+battlefield)?\b/i.test(ot)) {
    let action = undefined;
    if (/return\s+target\s+equipment\s+card\s+from\s+your\s+graveyard\s+to\s+the\s+battlefield/i.test(ot)) {
      action = 'RETURN_EQUIPMENT_FROM_GRAVEYARD';
    } else if (/exile\s+target\s+card\s+from\s+a\s+graveyard/i.test(ot)) {
      action = 'EXILE_TARGET_GRAVEYARD_CARD';
    } else if (/look\s+at\s+target\s+opponent's\s+hand.*exile\s+a\s+nonland\s+card/i.test(ot)) {
      action = 'EXILE_OPPONENT_HAND_NONLAND_WITH_TAX';
    }
    triggers.push({
      triggerType: 'ON_ETB',
      ...(action ? { action } : {}),
      oracleSnippet: 'Enters the battlefield trigger'
    });
  }

  // 2. ON_DIES (e.g. Heartfire Hero: "When ~ dies, it deals damage equal to its power to each opponent.")
  if (/when(?:ever)?\s+(?:this\s+creature|~|it|[a-z\s]+)\s+dies\b/i.test(ot)) {
    const action = /deals\s+damage\s+equal\s+to\s+its\s+power\s+to\s+each\s+opponent/i.test(ot)
      ? 'DAMAGE_EQUAL_TO_POWER_EACH_OPPONENT'
      : 'GENERIC_DIES';
    triggers.push({
      triggerType: 'ON_DIES',
      action
    });
  }

  // 3. ON_ATTACK / ON_ATTACKS (e.g. Fervent Champion)
  if (/when(?:ever)?\s+(?:~|[a-z\s]+)\s+attacks\b/i.test(ot)) {
    triggers.push({
      triggerType: 'ON_ATTACK',
      oracleSnippet: 'Attacks trigger'
    });
    if (/another\s+target\s+attacking\s+knight\s+you\s+control\s+gets\s+\+1\/\+0\s+until\s+end\s+of\s+turn/i.test(ot)) {
      triggers.push({
        triggerType: 'ON_ATTACKS',
        action: 'BUFF_ANOTHER_ATTACKING_KNIGHT',
        powerDelta: 1,
        toughnessDelta: 0,
        duration: 'END_OF_TURN',
        targetSubtype: 'Knight'
      });
    }
  }

  // 4. ON_BECOMES_TARGET (Valiant, e.g. Heartfire Hero: "Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.")
  if (/when(?:ever)?\s+.*becomes\s+the\s+target\s+of\s+a\s+spell\s+or\s+ability\s+you\s+control/i.test(ot)) {
    const isCounter = /put\s+a\s+\+1\/\+1\s+counter\s+on\s+it/i.test(ot);
    triggers.push({
      triggerType: 'ON_BECOMES_TARGET',
      action: isCounter ? 'ADD_COUNTER' : 'GENERIC_TARGETED',
      counterType: '+1/+1',
      count: 1,
      oncePerTurn: /first\s+time\s+each\s+turn/i.test(ot)
    });
  }

  // 5. ON_EQUIPMENT_ETB_AUTO_ATTACH (Sigarda's Aid: "Whenever an Equipment enters the battlefield under your control, you may attach it to target creature you control.")
  if (/when(?:ever)?\s+an\s+equipment\s+.*enters/i.test(ot) && /attach\s+it\s+to\s+(?:target\s+)?creature/i.test(ot)) {
    triggers.push({
      triggerType: 'ON_EQUIPMENT_ETB',
      action: 'AUTO_ATTACH_EQUIPMENT'
    });
  }

  // 6. ON_CREATURE_MV5_ETB_ATTACH (Doc Ock's Tentacles: "Whenever a creature you control with mana value 5 or greater enters, you may attach this Equipment to it.")
  const mvEtbMatch = ot.match(/whenever\s+a\s+creature\s+you\s+control\s+with\s+mana\s+value\s+(\d+)\s+or\s+greater\s+enters.*attach\s+this\s+equipment\s+to\s+it/i);
  if (mvEtbMatch) {
    triggers.push({
      triggerType: 'ON_CREATURE_MV5_ETB_ATTACH',
      action: 'AUTO_ATTACH_MV5',
      minManaValue: parseInt(mvEtbMatch[1], 10) || 5
    });
  }

  return triggers;
}

/**
 * Parses static permission grants (e.g. Sigarda's Aid: "You may cast Aura and Equipment spells as though they had flash.")
 * 
 * @param {string} oracleText
 * @returns {string[]} Array of card types granted flash (e.g. ['Aura', 'Equipment'])
 */
export function compileStaticPermissions(oracleText = '') {
  const ot = String(oracleText || '');
  const permissions = [];

  // 1. Grant Flash to Spells (Sigarda's Aid)
  if (/cast\s+(?:aura\s+and\s+equipment|aura\s+or\s+equipment)\s+spells\s+as\s+though\s+they\s+had\s+flash/i.test(ot)) {
    permissions.push({
      type: 'GRANT_FLASH_TO_SPELLS',
      filter: ['Equipment', 'Aura']
    });
  } else if (/cast\s+equipment\s+spells\s+as\s+though\s+they\s+had\s+flash/i.test(ot)) {
    permissions.push({
      type: 'GRANT_FLASH_TO_SPELLS',
      filter: ['Equipment']
    });
  } else if (/cast\s+aura\s+spells\s+as\s+though\s+they\s+had\s+flash/i.test(ot)) {
    permissions.push({
      type: 'GRANT_FLASH_TO_SPELLS',
      filter: ['Aura']
    });
  }

  // 2. Target Equip Cost Reduction (Fervent Champion)
  const equipCostReductMatch = ot.match(/equip\s+abilities\s+you\s+activate\s+that\s+target\s+.*\s+cost\s+\{(\d+)\}\s+less\s+to\s+activate/i);
  if (equipCostReductMatch) {
    const reduction = parseInt(equipCostReductMatch[1], 10) || 1;
    permissions.push({
      type: 'TARGET_EQUIP_COST_REDUCTION',
      genericReduction: reduction
    });
  }

  // 3. Forge Anew static permissions
  if (/activate\s+equip\s+abilities\s+any\s+time\s+you\s+could\s+cast\s+an\s+instant/i.test(ot)) {
    permissions.push({
      type: 'INSTANT_SPEED_EQUIP'
    });
  }
  if (/pay\s+\{0\}\s+rather\s+than\s+pay\s+the\s+equip\s+cost\s+of\s+the\s+first\s+equip\s+ability/i.test(ot)) {
    permissions.push({
      type: 'FIRST_EQUIP_COST_ZERO'
    });
  }

  // 4. Goblin Gaveleer scaling buff per attached equipment
  const scalingEquipMatch = ot.match(/gets\s+\+(\d+)\/\+(\d+)\s+for\s+each\s+equipment\s+attached\s+to\s+it/i);
  if (scalingEquipMatch) {
    permissions.push({
      type: 'SCALING_BUFF_PER_EQUIPMENT',
      powerPerEquipment: parseInt(scalingEquipMatch[1], 10) || 2,
      toughnessPerEquipment: parseInt(scalingEquipMatch[2], 10) || 0
    });
  }

  permissions.equipment = permissions.some(p => p.type === 'GRANT_FLASH_TO_SPELLS' && p.filter?.includes('Equipment'));
  permissions.aura = permissions.some(p => p.type === 'GRANT_FLASH_TO_SPELLS' && p.filter?.includes('Aura'));

  return permissions;
}

/**
 * Parses Activated Abilities (e.g. Inkmoth Nexus animation, Tormod's Crypt, Soul-Guide Lantern, Skrelv).
 *
 * @param {string} typeLine
 * @param {string} oracleText
 * @returns {Array<Object>}
 */
export function compileActivatedAbilities(typeLine = '', oracleText = '') {
  const ot = String(oracleText || '');
  const abilities = [];

  // 1. Inkmoth Nexus animation ability
  if (/becomes\s+a\s+1\/1\s+Blinkmoth\s+artifact\s+creature\s+with\s+flying\s+and\s+infect/i.test(ot)) {
    abilities.push({
      id: 'ANIMATE_LAND',
      action: 'ANIMATE_LAND',
      cost: { mana: '{1}' },
      becomesCreature: true,
      power: 1,
      toughness: 1,
      creatureTypes: ['Blinkmoth'],
      additionalTypes: ['Artifact', 'Creature'],
      keywords: { flying: true, infect: true },
      duration: 'END_OF_TURN'
    });
  }

  // 2. Tormod's Crypt: {T}, Sacrifice: Exile target player's graveyard
  if (/\{t\},\s*sacrifice\s+[^:]+:\s*exile\s+(?:all\s+cards\s+from\s+)?target\s+player's\s+graveyard/i.test(ot)) {
    abilities.push({
      id: 'SACRIFICE_EXILE_GRAVEYARD',
      action: 'SACRIFICE_EXILE_GRAVEYARD',
      cost: { tap: true, sacrifice: true },
      effect: { action: 'EXILE_TARGET_GRAVEYARD', targetType: 'player' }
    });
  }

  // 3. Soul-Guide Lantern: {T}, Sacrifice: Exile each opponent's graveyard
  if (/\{t\},\s*sacrifice\s+[^:]+:\s*exile\s+each\s+opponent's\s+graveyard/i.test(ot)) {
    abilities.push({
      id: 'SACRIFICE_EXILE_OPPONENT_GRAVEYARDS',
      action: 'SACRIFICE_EXILE_OPPONENT_GRAVEYARDS',
      cost: { tap: true, sacrifice: true },
      effect: { action: 'EXILE_OPPONENT_GRAVEYARDS' }
    });
  }

  // 4. Soul-Guide Lantern: {1}, {T}, Sacrifice: Draw a card
  if (/\{1\},\s*\{t\},\s*sacrifice\s+[^:]+:\s*draw\s+a\s+card/i.test(ot)) {
    abilities.push({
      id: 'SACRIFICE_DRAW_CARD',
      action: 'SACRIFICE_DRAW_CARD',
      cost: { mana: '{1}', tap: true, sacrifice: true },
      effect: { action: 'DRAW_CARD', amount: 1 }
    });
  }

  // 5. Skrelv, Defector Mite: {W/P}, {T}: Another target creature gains toxic 1 and hexproof from color
  if (/\{w\/p\},\s*\{t\}:\s*another\s+target\s+creature/i.test(ot)) {
    abilities.push({
      id: 'SKRELV_GRANT_PROTECTION',
      action: 'SKRELV_GRANT_PROTECTION',
      cost: { mana: '{W/P}', tap: true, phyrexian: 'W' },
      effect: { action: 'GRANT_TOXIC_AND_PROTECTION', toxic: 1, duration: 'END_OF_TURN' }
    });
  }

  return abilities;
}

/**
 * Main compilation entry point.
 * Given a card or card metadata object, compiles rules text and properties into
 * a canonical `compiledMechanics` object attached to `card.compiledMechanics`.
 * 
 * @param {Object} card
 * @returns {Object} The compiledMechanics object.
 */
export function compileCardMechanics(card) {
  if (!card) return null;

  const typeLine = card.typeLine || card.type_line || card.type || '';
  const oracleText = card.oracleText || card.oracle_text || card.text || '';
  const colors = Array.isArray(card.colors) ? card.colors : [];

  // 1. Category & Subzone
  const { category, subzone, isPermanent } = compileCardCategory(typeLine, card.isPermanent);

  // 2. Mana Profile
  const { manaProfile, manaLifeCost, producesAnyColor, manaAbilities } = compileManaProfile(typeLine, oracleText, colors);

  // 3. Spell Effects
  const spellEffects = compileSpellEffects(oracleText);
  if (!card.effect && spellEffects.length > 0) {
    card.effect = spellEffects[0];
  }

  // 4. Attachment Effects (Equipment / Aura)
  const attachmentEffects = compileAttachmentEffects(typeLine, oracleText);

  // 5. Triggers
  const triggers = compileTriggeredAbilities(oracleText);

  // 6. Static Permissions
  const staticPermissions = compileStaticPermissions(oracleText);

  // 7. ETB Tapped Condition
  const etbTappedCondition = compileEtbTappedCondition(oracleText);

  // 8. Opening Hand Action
  const openingHandAction = /opening\s+hand.*begin\s+the\s+game\s+with\s+it\s+on\s+the\s+battlefield/i.test(oracleText)
    ? 'START_ON_BATTLEFIELD'
    : null;

  // 9. Cast Modes
  const castModes = compileCastModes(card);

  // 10. Activated Abilities, Keywords & Combat Restrictions
  const activatedAbilities = compileActivatedAbilities(typeLine, oracleText);
  const keywords = { ...(card.keywords && typeof card.keywords === 'object' && !Array.isArray(card.keywords) ? card.keywords : {}) };
  const toxicMatch = oracleText.match(/\btoxic\s+(\d+)/i);
  if (toxicMatch) {
    keywords.toxic = parseInt(toxicMatch[1], 10);
  }
  if (/\binfect\b/i.test(oracleText)) {
    keywords.infect = true;
  }
  const cantBlock = /can't\s+block|cannot\s+block/i.test(oracleText);

  const grantsFlashTo = [];
  const flashPerm = staticPermissions.find(p => p.type === 'GRANT_FLASH_TO_SPELLS');
  if (flashPerm && Array.isArray(flashPerm.filter)) {
    grantsFlashTo.push(...flashPerm.filter);
  }
  grantsFlashTo.equipment = Boolean(staticPermissions.equipment);
  grantsFlashTo.aura = Boolean(staticPermissions.aura);

  const compiled = {
    category,
    subzone,
    isPermanent,
    manaProfile,
    manaLifeCost,
    producesAnyColor: Boolean(producesAnyColor || manaProfile?.producesAnyColor),
    manaAbilities: manaAbilities || [],
    etbTappedCondition,
    castModes,
    staticPermissions,
    openingHandAction,
    spellEffects,
    attachmentEffects,
    attachment: attachmentEffects ? {
      ...attachmentEffects,
      powerModifier: attachmentEffects.powerDelta,
      toughnessModifier: attachmentEffects.toughnessDelta,
      lostKeywords: attachmentEffects.keywordsLost,
      loseKeywords: attachmentEffects.keywordsLost,
      keywordsLost: attachmentEffects.keywordsLost
    } : null,
    isEquipment: Boolean(attachmentEffects?.isEquipment),
    isAura: Boolean(attachmentEffects?.isAura),
    equipCost: attachmentEffects?.equipCost || null,
    canBeginOnBattlefield: openingHandAction === 'START_ON_BATTLEFIELD' || Boolean(attachmentEffects?.canBeginOnBattlefield),
    triggers,
    activatedAbilities,
    keywords,
    cantBlock,
    grantsFlashTo,
    grantsFlashToEquipment: Boolean(staticPermissions.equipment),
    grantsFlashToAura: Boolean(staticPermissions.aura),
    compiledAt: Date.now()
  };

  card.compiledMechanics = compiled;
  card.subzone = subzone;
  card.isPermanent = isPermanent;

  return compiled;
}

/**
 * Runs an isolated verification on a card object ensuring:
 * 1. typeLine is present and resolves to a valid category and subzone.
 * 2. Non-creature permanents (Enchantment, Artifact, Planeswalker, Battle) are NEVER classified as creatures.
 * 3. Lands have a non-empty mana profile.
 * 
 * @param {Object} card
 * @returns {{ passed: boolean, supportTier: 'FULL_AUTO'|'ASSISTED', destinationSubzone: string|null, category: string, summary: string }}
 */
export function smokeTestCard(card) {
  if (!card) {
    return {
      passed: false,
      valid: false,
      supportTier: 'ASSISTED',
      destinationSubzone: null,
      category: 'unknown',
      summary: 'Card object is null or undefined'
    };
  }

  // Ensure compiled
  const compiled = card.compiledMechanics || compileCardMechanics(card);
  const typeLine = (card.typeLine || card.type_line || card.type || '').toLowerCase();

  // Test 1: Category sanity
  const isCreature = typeLine.includes('creature');
  const isArtifactOrEnchantment = (typeLine.includes('artifact') || typeLine.includes('enchantment') || typeLine.includes('battle')) && !isCreature;
  const isLand = typeLine.includes('land');

  if (isArtifactOrEnchantment && (compiled.category === 'CREATURE' || compiled.category === 'creatures')) {
    return {
      passed: false,
      valid: false,
      supportTier: 'ASSISTED',
      destinationSubzone: compiled.subzone,
      category: compiled.category,
      summary: `Failed: Non-creature permanent ${card.name} classified as creature`
    };
  }

  // Test 2: Subzone destination
  let expectedSubzone = null;
  if (isCreature) expectedSubzone = 'creatures';
  else if (isLand) expectedSubzone = 'lands';
  else if (typeLine.includes('planeswalker')) expectedSubzone = 'planeswalkers';
  else if (isArtifactOrEnchantment) expectedSubzone = 'noncreatures';

  if (compiled.subzone !== expectedSubzone) {
    return {
      passed: false,
      valid: false,
      supportTier: 'ASSISTED',
      destinationSubzone: compiled.subzone,
      category: compiled.category,
      summary: `Subzone mismatch for ${card.name}: expected ${expectedSubzone}, got ${compiled.subzone}`
    };
  }

  // Test 3: Land mana profile
  if (isLand && (!compiled.manaProfile || (Array.isArray(compiled.manaProfile) && compiled.manaProfile.length === 0))) {
    return {
      passed: false,
      valid: false,
      supportTier: 'ASSISTED',
      destinationSubzone: compiled.subzone,
      category: compiled.category,
      summary: `Land ${card.name} produced empty mana profile`
    };
  }

  const result = {
    passed: true,
    valid: true,
    supportTier: 'FULL_AUTO',
    destinationSubzone: compiled.subzone,
    category: compiled.category,
    summary: `Verified ${card.name} [${card.typeLine || 'Card'}] -> ${compiled.category} (${compiled.subzone || 'none'})`
  };

  card.smokeTest = result;
  return result;
}

export const compileCard = compileCardMechanics;

export const OracleEffectCompiler = {
  compileCard,
  compileCardMechanics,
  compileCardCategory,
  compileManaProfile,
  compileSpellEffects,
  compileAttachmentEffects,
  compileTriggeredAbilities,
  compileStaticPermissions,
  compileActivatedAbilities,
  smokeTestCard,
  STANDARD_KEYWORDS
};

export default OracleEffectCompiler;
