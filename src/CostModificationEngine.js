/**
 * CostModificationEngine.js - MTG CR 601.2f Dynamic Mana & Cost Modification Engine
 * 
 * Part of RPM Multiplayer - Feature 21
 * Specification: SPEC-RPM-RULES-ENGINE-021 (INV-COST-ENGINE-1)
 * 
 * Implements:
 * - Mathematical Order of Operations per CR 601.2f:
 *   Total Cost = ((Base or Alternate Cost) + Additional Costs/Taxes - Reductions) * Multipliers
 * - Pip Vector Model: <Generic, W, U, B, R, G, C>
 * - "Cast without paying mana cost" (bypasses mana cost, CMC becomes 0)
 * - Alternate cost support (Overload, Surge, Flashback)
 * - Static tax effects (Thalia generic +1, Grand Arbiter)
 * - Static reductions (Goblin Electromancer generic -1, Baral)
 * - Special constraints: Trinisphere 3-mana minimum rule
 * - Alternate payment mechanics: Delve (exiling cards), Convoke (tapping creatures)
 * 
 * @module CostModificationEngine
 */

/**
 * Parses a standard MTG mana cost string into a structured Pip Vector.
 * Example: "{2}{U}{U}" -> { generic: 2, W: 0, U: 2, B: 0, R: 0, G: 0, C: 0, total: 4 }
 * 
 * @param {string} costStr - e.g. "{1}{R}", "{3}{U}{U}"
 * @returns {Object} PipVector
 */
export function parseManaCost(costStr) {
  const vector = {
    generic: 0,
    W: 0,
    U: 0,
    B: 0,
    R: 0,
    G: 0,
    C: 0,
    total: 0
  };

  if (!costStr || typeof costStr !== 'string') {
    return vector;
  }

  const symbolRegex = /\{([^}]+)\}/g;
  let match;
  while ((match = symbolRegex.exec(costStr)) !== null) {
    const sym = match[1].toUpperCase();
    if (/^\d+$/.test(sym)) {
      const g = parseInt(sym, 10);
      vector.generic += g;
      vector.total += g;
    } else if (sym === 'W') {
      vector.W++;
      vector.total++;
    } else if (sym === 'U') {
      vector.U++;
      vector.total++;
    } else if (sym === 'B') {
      vector.B++;
      vector.total++;
    } else if (sym === 'R') {
      vector.R++;
      vector.total++;
    } else if (sym === 'G') {
      vector.G++;
      vector.total++;
    } else if (sym === 'C') {
      vector.C++;
      vector.total++;
    } else if (sym === 'X') {
      // X is treated as variable generic, defaults to 0
    }
  }

  return vector;
}

/**
 * Formats a Pip Vector back into an MTG mana cost string.
 * Example: { generic: 1, R: 2 } -> "{1}{R}{R}"
 * 
 * @param {Object} vector
 * @returns {string}
 */
export function formatManaCost(vector) {
  if (!vector || vector.total === 0) {
    return vector?.generic === 0 && Object.keys(vector).length > 0 ? '{0}' : '{0}';
  }

  let out = '';
  if (vector.generic > 0) {
    out += `{${vector.generic}}`;
  }
  const colorOrder = ['W', 'U', 'B', 'R', 'G', 'C'];
  for (const c of colorOrder) {
    const count = vector[c] || 0;
    for (let i = 0; i < count; i++) {
      out += `{${c}}`;
    }
  }
  return out || '{0}';
}

export class CostModificationEngine {
  /**
   * Calculates the exact final total cost to cast a spell per MTG CR 601.2f.
   * 
   * @param {Object} card - Card instance being cast
   * @param {Object} [context={}] - Environment context
   * @param {boolean} [context.isWithoutPayingManaCost=false] - Free cast flag (Omniscience, Cascade)
   * @param {string} [context.alternateCostString=null] - Overload, Surge, Flashback cost
   * @param {number} [context.genericTax=0] - Additional generic mana tax (Thalia, Commander tax)
   * @param {number} [context.genericReduction=0] - Generic mana reductions (Electromancer, Baral)
   * @param {boolean} [context.applyTrinisphere=false] - Whether Trinisphere rule is active
   * @param {number} [context.delveCardsExiled=0] - Number of cards exiled to pay for Delve
   * @param {Array<string>} [context.convokeTaps=[]] - Colors of tapped creatures for Convoke
   * @returns {Object} CostBreakdown
   */
  static calculateTotalCost(card, context = {}) {
    const {
      isWithoutPayingManaCost = false,
      alternateCostString = null,
      genericTax = 0,
      genericReduction = 0,
      applyTrinisphere = false,
      delveCardsExiled = 0,
      convokeTaps = []
    } = context;

    // Step 1: Base or Alternate Cost
    let baseVector;
    if (isWithoutPayingManaCost) {
      baseVector = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, total: 0 };
    } else if (alternateCostString) {
      baseVector = parseManaCost(alternateCostString);
    } else {
      const rawCost = card?.manaCost || card?.cost || '{0}';
      baseVector = parseManaCost(rawCost);
    }

    // Step 2: Additional Costs & Taxes (Adds to Generic)
    let effectiveGeneric = baseVector.generic + Math.max(0, Number(genericTax) || 0);

    // Step 3: Cost Reductions (Subtracts from Generic, cannot drop below 0)
    const effectiveReduction = Math.max(0, Number(genericReduction) || 0);
    effectiveGeneric = Math.max(0, effectiveGeneric - effectiveReduction);

    // Step 4: Delve (Exiling graveyard cards reduces generic mana 1-for-1)
    if (delveCardsExiled > 0) {
      const delveSavings = Math.min(effectiveGeneric, Math.max(0, delveCardsExiled));
      effectiveGeneric = Math.max(0, effectiveGeneric - delveSavings);
    }

    // Step 5: Convoke (Tapped creatures pay for colored or generic mana)
    const coloredPips = {
      W: baseVector.W,
      U: baseVector.U,
      B: baseVector.B,
      R: baseVector.R,
      G: baseVector.G,
      C: baseVector.C
    };

    if (Array.isArray(convokeTaps) && convokeTaps.length > 0) {
      for (const tapColor of convokeTaps) {
        const c = String(tapColor).toUpperCase();
        if (coloredPips[c] && coloredPips[c] > 0) {
          coloredPips[c]--;
        } else if (effectiveGeneric > 0) {
          effectiveGeneric--;
        }
      }
    }

    // Step 6: Multipliers & Trinisphere Minimum Rule (CR 601.2f)
    let totalManaCount = effectiveGeneric + Object.values(coloredPips).reduce((a, b) => a + b, 0);
    if (applyTrinisphere && !isWithoutPayingManaCost && totalManaCount < 3) {
      const diff = 3 - totalManaCount;
      effectiveGeneric += diff;
      totalManaCount = 3;
    }

    const finalVector = {
      generic: effectiveGeneric,
      ...coloredPips,
      total: effectiveGeneric + Object.values(coloredPips).reduce((a, b) => a + b, 0)
    };

    return {
      originalCostString: card?.manaCost || '{0}',
      finalCostString: formatManaCost(finalVector),
      isWithoutPayingManaCost,
      baseVector,
      finalVector,
      totalCMC: finalVector.total,
      generic: finalVector.generic,
      coloredPips
    };
  }

  /**
   * Verifies if a player's mana pool satisfies the calculated cost.
   * 
   * @param {Object} finalVector - Calculated mana requirement
   * @param {Object} manaPool - e.g. { W: 0, U: 2, B: 0, R: 1, G: 0, C: 0, colorless: 0 }
   * @returns {{ canAfford: boolean, missing: Object }}
   */
  static canAffordCost(finalVector, manaPool = {}) {
    if (!finalVector || finalVector.total === 0) {
      return { canAfford: true, missing: {} };
    }

    const pool = {
      W: manaPool.W || 0,
      U: manaPool.U || 0,
      B: manaPool.B || 0,
      R: manaPool.R || 0,
      G: manaPool.G || 0,
      C: (manaPool.C || 0) + (manaPool.colorless || 0)
    };

    const missing = {};
    let canAfford = true;

    // Check colored requirements first
    const colors = ['W', 'U', 'B', 'R', 'G', 'C'];
    for (const c of colors) {
      const required = finalVector[c] || 0;
      if (pool[c] < required) {
        missing[c] = required - pool[c];
        canAfford = false;
      } else {
        pool[c] -= required;
      }
    }

    // Remaining total mana in pool must cover generic
    const totalRemaining = Object.values(pool).reduce((a, b) => a + b, 0);
    if (totalRemaining < finalVector.generic) {
      missing.generic = finalVector.generic - totalRemaining;
      canAfford = false;
    }

    return { canAfford, missing };
  }
}

export default CostModificationEngine;
