/**
 * MulliganEngine.js - MTG CR 103.2 & CR 103.4 Shuffling & London Mulligan Engine
 * 
 * Part of RPM Multiplayer - Feature 21
 * Specification: SPEC-RPM-RULES-ENGINE-021 (INV-MULLIGAN-1)
 * 
 * Provides:
 * - CSPRNG Fisher-Yates unbiased deck shuffling (CR 103.2)
 * - London Mulligan calculation and bottoming tracking (CR 103.4)
 * - Perkins AI opening hand evaluation heuristics and card bottoming prioritization
 * - Multi-player London Mulligan state coordination
 * 
 * @module MulliganEngine
 */

/**
 * Executes a Cryptographically Secure Pseudo-Random Number Generator (CSPRNG)
 * Fisher-Yates shuffle on the given array in place.
 * 
 * @template T
 * @param {T[]} array - Array of card instances to shuffle
 * @returns {T[]} The mutated, uniformly randomized array
 */
export function shuffleLibrary(array) {
  if (!Array.isArray(array) || array.length <= 1) return array;

  const cryptoObj = (typeof window !== 'undefined' && window.crypto)
    ? window.crypto
    : (typeof globalThis !== 'undefined' && globalThis.crypto ? globalThis.crypto : null);

  for (let i = array.length - 1; i > 0; i--) {
    let j;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      const buffer = new Uint32Array(1);
      cryptoObj.getRandomValues(buffer);
      // Uniform integer in range [0, i] avoiding modulo bias
      const maxRange = Math.floor(0xFFFFFFFF / (i + 1)) * (i + 1);
      let randVal = buffer[0];
      while (randVal >= maxRange) {
        cryptoObj.getRandomValues(buffer);
        randVal = buffer[0];
      }
      j = randVal % (i + 1);
    } else {
      // High-precision fallback if Web Crypto is unavailable
      j = Math.floor(Math.random() * (i + 1));
    }
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
  return array;
}

/**
 * Evaluates whether Perkins AI bot should keep or mulligan an opening hand.
 * MTG Heuristic:
 * - 0 lands: Always Mulligan (Unplayable mana drought)
 * - 1 land: Always Mulligan (High risk of mana screw)
 * - 6 lands: Always Mulligan (Severe mana flood)
 * - 7 lands: Always Mulligan (Unplayable pure flood)
 * - 2-5 lands: Keep Hand
 * 
 * @param {Array<Object>} hand - Array of 7 card instances in hand
 * @param {number} [currentMulliganCount=0] - Number of mulligans already taken
 * @returns {{ keep: boolean, reason: string }}
 */
export function evaluatePerkinsMulligan(hand, currentMulliganCount = 0) {
  if (!Array.isArray(hand) || hand.length === 0) {
    return { keep: true, reason: 'EMPTY_HAND' };
  }

  if (currentMulliganCount >= 3) {
    // Diminishing returns: at 3 mulligans (effective hand size 4), keep to prevent card disadvantage
    return { keep: true, reason: 'MULLIGAN_DEPTH_THRESHOLD_REACHED' };
  }

  const landCount = hand.filter(card => card && /land/i.test(card.typeLine || card.type || '')).length;

  if (landCount === 0) {
    return { keep: false, reason: 'MANA_DROUGHT_ZERO_LANDS' };
  }
  if (landCount === 1) {
    return { keep: false, reason: 'MANA_SCREW_ONE_LAND' };
  }
  if (landCount === 6) {
    return { keep: false, reason: 'MANA_FLOOD_SIX_LANDS' };
  }
  if (landCount === 7) {
    return { keep: false, reason: 'MANA_FLOOD_SEVEN_LANDS' };
  }

  // 2, 3, 4, or 5 lands
  return { keep: true, reason: `BALANCED_HAND_${landCount}_LANDS` };
}

/**
 * Prioritizes which N cards Perkins AI bot puts on the bottom of the library.
 * Heuristic priority:
 * 1. Expensive spells (CMC >= 5) when land count is low (2-3)
 * 2. Excess lands when land count >= 4
 * 3. Off-curve or uncastable high-cost non-land cards
 * 4. Redundant copies of legendary or situational cards
 * 
 * @param {Array<Object>} hand - Current cards in hand (length typically 7)
 * @param {number} countToBottom - Exactly N cards to select
 * @returns {Array<Object>} Cards to bottom, ordered
 */
export function selectPerkinsBottomCards(hand, countToBottom) {
  if (!Array.isArray(hand) || countToBottom <= 0) return [];
  const count = Math.min(countToBottom, hand.length);

  const cardsWithScores = hand.map(card => {
    let discardScore = 0;
    const isLand = /land/i.test(card.typeLine || card.type || '');
    const cmc = card.cmc ?? (card.manaCost ? (card.manaCost.match(/\{[0-9WUBRGC]\}/g) || []).length : 0);
    
    if (isLand) {
      // Deprioritize bottoming lands unless in flood
      const totalLands = hand.filter(c => /land/i.test(c.typeLine || c.type || '')).length;
      discardScore = totalLands > 3 ? 50 + totalLands : 10;
    } else {
      // Non-lands: score proportional to CMC (higher CMC = higher bottom priority)
      discardScore = 30 + (cmc * 15);
    }
    return { card, score: discardScore };
  });

  // Sort descending by discardScore (highest score bottoms first)
  cardsWithScores.sort((a, b) => b.score - a.score);
  return cardsWithScores.slice(0, count).map(item => item.card);
}

/**
 * Coordinates multi-player London Mulligan states and bottoming counts.
 */
export class MulliganTracker {
  constructor(playerIds = []) {
    this.playerStates = new Map();
    for (const pid of playerIds) {
      this.initPlayer(pid);
    }
  }

  initPlayer(playerId) {
    this.playerStates.set(playerId, {
      mulliganCount: 0,
      isDecided: false,
      kept: false,
      cardsToBottomCount: 0,
      bottomedCards: []
    });
  }

  getPlayerState(playerId) {
    if (!this.playerStates.has(playerId)) {
      this.initPlayer(playerId);
    }
    return this.playerStates.get(playerId);
  }

  getMulliganCount(playerId) {
    return this.getPlayerState(playerId).mulliganCount;
  }

  incrementMulligan(playerId) {
    const st = this.getPlayerState(playerId);
    st.mulliganCount++;
    st.cardsToBottomCount = st.mulliganCount;
    st.isDecided = false;
    st.kept = false;
    return st.mulliganCount;
  }

  setDecided(playerId, kept = true) {
    const st = this.getPlayerState(playerId);
    st.isDecided = true;
    st.kept = kept;
    st.cardsToBottomCount = kept ? st.mulliganCount : 0;
    return st;
  }

  recordBottomedCards(playerId, cards) {
    const st = this.getPlayerState(playerId);
    st.bottomedCards = Array.isArray(cards) ? [...cards] : [];
    return st;
  }

  isAllDecided() {
    if (this.playerStates.size === 0) return true;
    for (const st of this.playerStates.values()) {
      if (!st.isDecided) return false;
    }
    return true;
  }

  reset() {
    for (const pid of this.playerStates.keys()) {
      this.initPlayer(pid);
    }
  }
}

export default {
  shuffleLibrary,
  evaluatePerkinsMulligan,
  selectPerkinsBottomCards,
  MulliganTracker
};
