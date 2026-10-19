/**
 * TurnRollOffManager.js
 * Pre-Game d20 Roll-Off, Tie-Break Loop & Strict Turn Sorting Engine
 * 
 * Part of RPM Multiplayer - Feature 14
 * Document ID: SPEC-RPM-PLATFORM-014
 * Enforces Architectural Invariants:
 * - INV-TURNSORT-1: Pre-Game d20 Roll-Off & Tie-Break Turn Sorting
 * 
 * @module TurnRollOffManager
 */

/**
 * Generates an authoritative d20 roll (1 to 20) via CSPRNG.
 * @param {Function} [customRng]
 * @returns {number} Integer between 1 and 20 inclusive
 */
export function generateAuthoritativeD20(customRng = null) {
  if (typeof customRng === 'function') {
    const val = customRng();
    if (typeof val === 'number') {
      return Math.floor(val * 20) + 1;
    }
  }

  // Authoritative CSPRNG
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return (buf[0] % 20) + 1;
  }

  return Math.floor(Math.random() * 20) + 1;
}

/**
 * TurnRollOffManager
 * Orchestrates pre-game d20 roll-offs, iterative tie-breakers, and total turn order sorting.
 */
export class TurnRollOffManager {
  /**
   * @param {Array<string>} playerIds - List of seated player IDs
   * @param {Object} [options={}]
   * @param {Function} [options.rng] - Custom random generator for deterministic testing
   */
  constructor(playerIds, options = {}) {
    if (!Array.isArray(playerIds) || playerIds.length === 0) {
      throw new Error('TurnRollOffManager requires a non-empty array of player IDs');
    }

    this.allPlayerIds = [...playerIds];
    this.rng = options.rng || null;
    this.round = 1;

    // Rolls recorded for current round: playerId -> number
    this.currentRolls = new Map();

    // History of all rounds: [{ round, rolls: Map }]
    this.roundHistory = [];

    // Players who still need to roll in this round
    this.pendingPlayerIds = new Set(this.allPlayerIds);

    // Final resolved order: [playerId1, playerId2, ...] sorted descending
    this.sortedPlayers = [];
    this.isComplete = false;

    // Tie-break state: groups of tied players
    // Each entry: { playerIds: Array<string>, baseRank: number }
    this.activeTieBreakGroups = [];
  }

  /**
   * Submits or generates a d20 roll for a player.
   * 
   * @param {string} playerId 
   * @param {number} [forcedValue] - Optional explicit roll (1..20)
   * @returns {number} The roll value
   */
  submitRoll(playerId, forcedValue = null) {
    if (!this.pendingPlayerIds.has(playerId)) {
      throw new Error(`Player '${playerId}' is not currently expected to roll in round ${this.round}`);
    }

    let rollValue;
    if (typeof forcedValue === 'number') {
      if (forcedValue < 1 || forcedValue > 20) {
        throw new Error(`Roll value ${forcedValue} out of bounds (1..20)`);
      }
      rollValue = Math.floor(forcedValue);
    } else {
      rollValue = generateAuthoritativeD20(this.rng);
    }

    this.currentRolls.set(playerId, rollValue);
    this.pendingPlayerIds.delete(playerId);

    return rollValue;
  }

  /**
   * Checks if all required players have rolled in the current round.
   * @returns {boolean}
   */
  isRoundComplete() {
    return this.pendingPlayerIds.size === 0;
  }

  /**
   * Evaluates the current round results and resolves rankings or sets up tie-breakers (INV-TURNSORT-1).
   * 
   * @returns {{
   *   isComplete: boolean,
   *   round: number,
   *   sortedPlayers: Array<string>,
   *   hasTies: boolean,
   *   tiedPlayerIds: Array<string>,
   *   rollMap: Record<string, number>
   * }}
   */
  evaluateRound() {
    if (!this.isRoundComplete()) {
      throw new Error(`Cannot evaluate round ${this.round}: pending players remain (${Array.from(this.pendingPlayerIds).join(', ')})`);
    }

    const rollMap = Object.fromEntries(this.currentRolls);
    this.roundHistory.push({
      round: this.round,
      rolls: new Map(this.currentRolls)
    });

    if (this.round === 1) {
      // First round: sort all players descending by roll
      const sorted = [...this.allPlayerIds].sort((a, b) => {
        return this.currentRolls.get(b) - this.currentRolls.get(a);
      });

      // Find tie groups
      const valueGroups = new Map(); // rollValue -> Array<playerId>
      for (const pid of sorted) {
        const val = this.currentRolls.get(pid);
        if (!valueGroups.has(val)) {
          valueGroups.set(val, []);
        }
        valueGroups.get(val).push(pid);
      }

      // Check if any group has > 1 player
      const tieGroups = [];
      for (const [val, group] of valueGroups.entries()) {
        if (group.length > 1) {
          tieGroups.push(group);
        }
      }

      if (tieGroups.length === 0) {
        // Strict total order established on round 1!
        this.sortedPlayers = sorted;
        this.isComplete = true;
        return {
          isComplete: true,
          round: this.round,
          sortedPlayers: this.sortedPlayers,
          hasTies: false,
          tiedPlayerIds: [],
          rollMap
        };
      }

      // We have ties. Setup tie-breaker rounds
      this.activeTieBreakGroups = tieGroups;
      const allTied = tieGroups.flat();

      this.round++;
      this.currentRolls.clear();
      this.pendingPlayerIds = new Set(allTied);

      return {
        isComplete: false,
        round: this.round - 1,
        sortedPlayers: [],
        hasTies: true,
        tiedPlayerIds: allTied,
        rollMap
      };
    }

    // Subsequent tie-break rounds:
    // Resolve each tie group with its latest rolls
    const nextTieGroups = [];
    const nextPending = [];

    for (const group of this.activeTieBreakGroups) {
      // Sort this group by current round rolls
      const groupSorted = [...group].sort((a, b) => {
        return this.currentRolls.get(b) - this.currentRolls.get(a);
      });

      // Check for remaining ties within this group
      const valMap = new Map();
      for (const pid of groupSorted) {
        const val = this.currentRolls.get(pid);
        if (!valMap.has(val)) valMap.set(val, []);
        valMap.get(val).push(pid);
      }

      for (const [val, subGroup] of valMap.entries()) {
        if (subGroup.length > 1) {
          nextTieGroups.push(subGroup);
          nextPending.push(...subGroup);
        }
      }
    }

    if (nextTieGroups.length === 0) {
      // All ties resolved! Compute global strict order by cascading rounds
      this.sortedPlayers = this._reconstructStrictOrder();
      this.isComplete = true;
      return {
        isComplete: true,
        round: this.round,
        sortedPlayers: this.sortedPlayers,
        hasTies: false,
        tiedPlayerIds: [],
        rollMap
      };
    }

    // Still have ties, advance to next tie-breaker round
    this.activeTieBreakGroups = nextTieGroups;
    this.round++;
    this.currentRolls.clear();
    this.pendingPlayerIds = new Set(nextPending);

    return {
      isComplete: false,
      round: this.round - 1,
      sortedPlayers: [],
      hasTies: true,
      tiedPlayerIds: nextPending,
      rollMap
    };
  }

  /**
   * Reconstructs the strict descending order across all tie-break rounds.
   * @private
   * @returns {Array<string>}
   */
  _reconstructStrictOrder() {
    return [...this.allPlayerIds].sort((a, b) => {
      for (const roundData of this.roundHistory) {
        const rollA = roundData.rolls.get(a);
        const rollB = roundData.rolls.get(b);
        if (rollA !== undefined && rollB !== undefined && rollA !== rollB) {
          return rollB - rollA;
        }
      }
      return 0;
    });
  }

  /**
   * Returns highest roller (Active Player P1 for Turn 1).
   * @returns {string|null}
   */
  getFirstPlayerId() {
    return this.sortedPlayers.length > 0 ? this.sortedPlayers[0] : null;
  }
}

export default TurnRollOffManager;
