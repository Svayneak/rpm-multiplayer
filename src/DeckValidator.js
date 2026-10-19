/**
 * DeckValidator.js
 * Comprehensive Deck Validation Engine for Free Construct and Ranked Construct (Modern).
 * 
 * Part of RPM Multiplayer - Feature 14
 * Document ID: SPEC-RPM-PLATFORM-014
 * Enforces Architectural Invariants:
 * - INV-DECK-1: Oracle 4-Of Override Resolution
 * 
 * @module DeckValidator
 */

import { LocalStorageCacheAdapter, MemoryCacheAdapter } from './ScryfallService.js';
import { DeckParser } from './DeckParser.js';

export const VALIDATION_ERRORS = Object.freeze({
  TOO_FEW_MAIN: 'TOO_FEW_MAIN',
  TOO_MANY_SIDEBOARD: 'TOO_MANY_SIDEBOARD',
  EXCEEDS_COPY_LIMIT: 'EXCEEDS_COPY_LIMIT',
  BANNED_IN_FORMAT: 'BANNED_IN_FORMAT',
  NOT_LEGAL_IN_FORMAT: 'NOT_LEGAL_IN_FORMAT',
  INVALID_CARD_STRUCTURE: 'INVALID_CARD_STRUCTURE'
});

export const BASIC_LANDS = new Set([
  'plains', 'island', 'swamp', 'mountain', 'forest', 'wastes',
  'snow-covered plains', 'snow-covered island', 'snow-covered swamp',
  'snow-covered mountain', 'snow-covered forest', 'snow-covered wastes'
]);

export const ORACLE_UNLIMITED_CARDS = Object.freeze({
  'Relentless Rats': { maxCopies: Infinity, rule: 'A deck can contain any number of cards named Relentless Rats.' },
  'Persistent Petitioners': { maxCopies: Infinity, rule: 'A deck can contain any number of cards named Persistent Petitioners.' },
  'Shadowborn Apostle': { maxCopies: Infinity, rule: 'A deck can contain any number of cards named Shadowborn Apostle.' },
  'Rat Colony': { maxCopies: Infinity, rule: 'A deck can contain any number of cards named Rat Colony.' },
  "Dragon's Approach": { maxCopies: Infinity, rule: "A deck can contain any number of cards named Dragon's Approach." },
  'Slime Against Humanity': { maxCopies: Infinity, rule: 'A deck can contain any number of cards named Slime Against Humanity.' },
  'Templar Knight': { maxCopies: Infinity, rule: 'A deck can contain any number of cards named Templar Knight.' },
  'Seven Dwarves': { maxCopies: 7, rule: 'A deck can contain up to seven cards named Seven Dwarves.' }
});

export const REGEX_UNLIMITED_RULE = /a deck can contain (?:any number|up to \w+) of cards named/i;

export const MODERN_BANLIST = new Set([
  'ancient den', 'birthing pod', 'blazing shoal', 'bridge from below', 'chrome mox',
  'cloudpost', 'dark depths', 'deathrite shaman', 'dig through time', 'dread return',
  'eye of ugin', 'faithless looting', 'field of the dead', 'fury', 'gitaxian probe',
  'glimpse of nature', 'golgari grave-troll', 'great furnace', 'green sun\'s zenith',
  'hogaak, arisen necropolis', 'hypergenesis', 'krark-clan ironworks', 'mental misstep',
  'mox opal', 'mycosynth lattice', 'mystic sanctuary', 'nadu, winged wisdom',
  'oko, thief of crowns', 'once upon a time', 'ponder', 'preordain', 'punishing fire',
  'rite of flame', 'seat of the synod', 'second sunrise', 'seething song', 'sensei\'s divining top',
  'simian spirit guide', 'skullclamp', 'splinter twin', 'summer bloom', 'tibalt\'s trickery',
  'the one ring', 'treasure cruise', 'tree of tales', 'umezawa\'s jitte', 'uro, titan of nature\'s wrath',
  'vault of whispers', 'violent outburst', 'yorion, sky nomad',
  // Vintage/Legacy only cards
  'black lotus', 'mox pearl', 'mox sapphire', 'mox jet', 'mox ruby', 'mox emerald',
  'ancestral recall', 'time walk', 'timetwister', 'channel', 'fastbond', 'demonic tutor',
  'vampiric tutor', 'sol ring', 'mana crypt', 'mana vault', 'wheel of fortune', 'library of alexandria'
]);

/**
 * DeckValidator
 * Validates deck lists against format legality, copy constraints, and Scryfall Oracle overrides.
 */
export class DeckValidator {
  /**
   * @param {Object} [options]
   * @param {Object} [options.cacheAdapter]
   */
  constructor(options = {}) {
    if (options.cacheAdapter) {
      this.cache = options.cacheAdapter;
    } else if (typeof localStorage !== 'undefined') {
      this.cache = new LocalStorageCacheAdapter();
    } else {
      this.cache = new MemoryCacheAdapter();
    }
  }

  /**
   * Normalizes a card name for case-insensitive and punctuation-agnostic comparison.
   * @param {string} name 
   * @returns {string}
   */
  static normalizeName(name) {
    if (!name || typeof name !== 'string') return '';
    return name.trim().toLowerCase();
  }

  /**
   * Checks whether a card name is a basic land.
   * @param {string} name 
   * @returns {boolean}
   */
  static isBasicLand(name) {
    const norm = DeckValidator.normalizeName(name);
    return BASIC_LANDS.has(norm);
  }

  /**
   * Resolves maximum copy allowance for a given card based on Oracle rules (INV-DECK-1).
   * @param {string} cardName 
   * @param {string} [oracleText='']
   * @param {Object} [cacheAdapter]
   * @returns {{ maxCopies: number, isOracleExempt: boolean, ruleText?: string }}
   */
  static getCardCopyLimit(cardName, oracleText = '', cacheAdapter = null) {
    if (DeckValidator.isBasicLand(cardName)) {
      return { maxCopies: Infinity, isOracleExempt: true, ruleText: 'Basic Land rule' };
    }

    const norm = DeckValidator.normalizeName(cardName);

    // 1. Check Pre-Compiled Canonical Unlimited Cards
    for (const [canonicalName, info] of Object.entries(ORACLE_UNLIMITED_CARDS)) {
      if (DeckValidator.normalizeName(canonicalName) === norm) {
        return {
          maxCopies: info.maxCopies,
          isOracleExempt: true,
          ruleText: info.rule
        };
      }
    }

    // 2. Check Provided Oracle Text
    if (oracleText && REGEX_UNLIMITED_RULE.test(oracleText)) {
      const sevenMatch = /up to seven cards named/i.test(oracleText);
      return {
        maxCopies: sevenMatch ? 7 : Infinity,
        isOracleExempt: true,
        ruleText: oracleText
      };
    }

    // 3. Check Cache Adapter
    if (cacheAdapter) {
      try {
        const cachedRaw = cacheAdapter.getItem(`name:${norm}`);
        if (cachedRaw) {
          const parsed = JSON.parse(cachedRaw);
          const text = parsed.oracleText || parsed.oracle_text || '';
          if (text && REGEX_UNLIMITED_RULE.test(text)) {
            const sevenMatch = /up to seven cards named/i.test(text);
            return {
              maxCopies: sevenMatch ? 7 : Infinity,
              isOracleExempt: true,
              ruleText: text
            };
          }
        }
      } catch (e) {
        // Cache read fallback
      }
    }

    // Standard 4-of limit
    return { maxCopies: 4, isOracleExempt: false };
  }

  /**
   * Checks format legality for a given card name.
   * @param {string} cardName 
   * @param {'FREE_CONSTRUCT'|'RANKED_CONSTRUCT'} format 
   * @param {Object} [cardMetadata]
   * @returns {{ isLegal: boolean, reason?: string }}
   */
  static checkCardFormatLegality(cardName, format = 'FREE_CONSTRUCT', cardMetadata = null) {
    if (format === 'FREE_CONSTRUCT' || format === 'FREE') {
      return { isLegal: true };
    }

    const norm = DeckValidator.normalizeName(cardName);

    // Check Modern banlist
    if (MODERN_BANLIST.has(norm)) {
      return {
        isLegal: false,
        reason: `${cardName} is banned in Ranked Construct (Modern)`
      };
    }

    // Check card metadata modern legality if provided
    if (cardMetadata && cardMetadata.modernLegal === false) {
      return {
        isLegal: false,
        reason: `${cardName} is not legal in Modern`
      };
    }

    return { isLegal: true };
  }

  /**
   * Validates a complete deck structure.
   * 
   * @param {Object|Array|string} deck - Decklist object, array of cards, or raw text
   * @param {Object} [options={}]
   * @param {'FREE_CONSTRUCT'|'RANKED_CONSTRUCT'|'FREE'|'MODERN'} [options.format='FREE_CONSTRUCT']
   * @param {number} [options.minMainboard=0]
   * @param {number} [options.maxSideboard=15]
   * @param {Object} [options.cacheAdapter]
   * @returns {import('./specs/FEATURE_14_UNIFIED_PLATFORM_SPEC').DeckValidationReport}
   */
  static validateDeck(deck, options = {}) {
    const rawFormat = (options.format || 'FREE_CONSTRUCT').toUpperCase();
    const format = (rawFormat === 'RANKED' || rawFormat === 'MODERN' || rawFormat === 'RANKED_CONSTRUCT')
      ? 'RANKED_CONSTRUCT'
      : 'FREE_CONSTRUCT';

    const minMainboard = options.minMainboard ?? (options.enforceMinimum ? 60 : 0);
    const maxSideboard = options.maxSideboard ?? 15;
    const cacheAdapter = options.cacheAdapter || null;

    let mainboard = [];
    let sideboard = [];

    // Parse text input if string
    if (typeof deck === 'string') {
      const parsed = DeckParser.parse(deck);
      mainboard = parsed.cards.filter(c => !c.isSideboard);
      sideboard = parsed.cards.filter(c => c.isSideboard);
    } else if (Array.isArray(deck)) {
      mainboard = deck;
    } else if (deck && typeof deck === 'object') {
      mainboard = deck.mainboard || deck.main || deck.cards || [];
      sideboard = deck.sideboard || deck.side || [];
    }

    const errors = [];
    let mainCount = 0;
    let sideboardCount = 0;

    // Aggregate counts across main and side
    const cardTotals = new Map(); // normalizedName -> { cardName, count, oracleText, metadata }

    const recordCard = (card, isSide) => {
      if (!card || !card.name) return;
      const count = Number(card.count) || 1;
      const name = String(card.name).trim();
      const norm = DeckValidator.normalizeName(name);

      if (isSide) {
        sideboardCount += count;
      } else {
        mainCount += count;
      }

      if (!cardTotals.has(norm)) {
        cardTotals.set(norm, {
          cardName: name,
          count: 0,
          oracleText: card.oracleText || card.oracle_text || '',
          metadata: card
        });
      }
      const entry = cardTotals.get(norm);
      entry.count += count;
      if (card.oracleText && !entry.oracleText) {
        entry.oracleText = card.oracleText;
      }
    };

    mainboard.forEach(c => recordCard(c, false));
    sideboard.forEach(c => recordCard(c, true));

    // Deck size limits
    if (minMainboard > 0 && mainCount < minMainboard) {
      errors.push({
        cardName: 'Mainboard',
        count: mainCount,
        reason: `Mainboard must contain at least ${minMainboard} cards (found ${mainCount})`
      });
    }

    if (sideboardCount > maxSideboard) {
      errors.push({
        cardName: 'Sideboard',
        count: sideboardCount,
        reason: `Sideboard exceeds maximum ${maxSideboard} cards (found ${sideboardCount})`
      });
    }

    // Card copy counts and format legality
    for (const [norm, entry] of cardTotals.entries()) {
      const { cardName, count, oracleText, metadata } = entry;

      // 1. Format Banlist / Legality Check
      if (format === 'RANKED_CONSTRUCT') {
        const legality = DeckValidator.checkCardFormatLegality(cardName, format, metadata);
        if (!legality.isLegal) {
          errors.push({
            cardName,
            count,
            reason: legality.reason || `${cardName} is not legal in ${format}`
          });
        }
      }

      // 2. 4-Of Limit & Oracle Override (INV-DECK-1)
      const copyLimit = DeckValidator.getCardCopyLimit(cardName, oracleText, cacheAdapter);
      if (count > copyLimit.maxCopies) {
        errors.push({
          cardName,
          count,
          reason: `${cardName} exceeds ${copyLimit.maxCopies} copies (${count} found) without Oracle rule exemption`,
          isOracleExempt: copyLimit.isOracleExempt
        });
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      mainCount,
      sideboardCount,
      format
    };
  }

  /**
   * Instance validation method.
   * @param {Object|Array|string} deck 
   * @param {Object} [options={}] 
   * @returns {Object}
   */
  validate(deck, options = {}) {
    return DeckValidator.validateDeck(deck, {
      cacheAdapter: this.cache,
      ...options
    });
  }
}

export default DeckValidator;
