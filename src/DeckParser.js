/**
 * DeckParser.js - Robust parser for MTG Decklists across all major formats.
 * 
 * Supports MTG Arena, MTGO, Moxfield, Archidekt, Deckbox, and plain text formats.
 * Implements Section 2 of SPEC-RPM-INGEST-001 with zero-failure parsing guarantees.
 * 
 * @module DeckParser
 */

/**
 * @typedef {'main' | 'sideboard' | 'commander'} DeckSection
 */

/**
 * @typedef {Object} ParsedDeckCard
 * @property {number} count - Quantity of the card.
 * @property {string} name - Normalized card name.
 * @property {string | null} set - Lowercase 3-5 character set code (e.g. 'mh2') or null.
 * @property {string | null} collectorNumber - Collector number (e.g. '138', '298', '52a') or null.
 * @property {DeckSection} section - Deck section assignment ('main', 'sideboard', or 'commander').
 */

/**
 * @typedef {Object} DeckParserError
 * @property {number} lineNumber - 1-indexed line number where error occurred.
 * @property {string} rawLine - The raw unparsed text of the line.
 * @property {string} reason - Descriptive error explanation.
 */

/**
 * @typedef {Object} DeckParseStats
 * @property {number} totalCards - Sum of counts across all sections.
 * @property {number} mainCount - Sum of counts in mainboard.
 * @property {number} sideboardCount - Sum of counts in sideboard.
 * @property {number} commanderCount - Sum of counts in commander/companion.
 * @property {number} errorCount - Number of invalid lines encountered.
 */

/**
 * @typedef {Object} DeckParseResult
 * @property {ParsedDeckCard[]} cards - Structured parsed card items.
 * @property {number} totalCards - Total card count across all sections.
 * @property {number} mainCount - Mainboard card count.
 * @property {number} sideboardCount - Sideboard card count.
 * @property {number} commanderCount - Commander / Companion card count.
 * @property {DeckParserError[]} errors - List of non-fatal line parse errors.
 * @property {DeckParseStats} stats - Aggregated statistics object.
 */

/**
 * Primary comprehensive regex matching count, card name, optional set code,
 * optional collector number, and optional cosmetic indicators (e.g. *F*, *E*).
 */
export const REGEX_DECK_COMPREHENSIVE = /^(?:(?<inlineSection>SB|SB:|COMMANDER|CMDR):?\s+)?(?<count>\d+)x?\s+(?<name>.+?)(?:\s+[\(\[](?<set>[A-Za-z0-9]{3,5})[\)\]](?:\s+(?:#)?(?<collector>[A-Za-z0-9\-_]+))?)?(?:\s+\*[A-Za-z0-9]+\*)*\s*$/i;

/**
 * Fallback simple regex matching count and card name when set/collector syntax is omitted.
 */
export const REGEX_DECK_SIMPLE = /^(?:(?<inlineSection>SB|SB:|COMMANDER|CMDR):?\s+)?(?<count>\d+)x?\s+(?<name>.+?)\s*$/i;

/**
 * Parses raw MTG decklist text into structured card tokens.
 * 
 * Complies with Section 2 of SPEC-RPM-INGEST-001:
 * - Tolerant to Arena, MTGO, Moxfield, Archidekt, and plain text exports.
 * - Manages stateful section transitions (Mainboard, Sideboard, Commander/Companion).
 * - Respects inline section prefixes (e.g., 'SB: 2 Flusterstorm').
 * - Zero-failure parsing: collects errors instead of throwing exceptions.
 * 
 * @param {string} rawText - Multiline decklist string.
 * @param {Object} [options] - Parsing configuration options.
 * @param {DeckSection} [options.defaultSection='main'] - Initial section state.
 * @returns {DeckParseResult} Parsed cards, section counts, errors, and statistics.
 */
export function parseDecklist(rawText, options = {}) {
  const defaultSection = options.defaultSection || 'main';

  // Input validation: graceful zero-state return
  if (typeof rawText !== 'string') {
    const error = {
      lineNumber: 0,
      rawLine: '',
      reason: 'Input must be a string'
    };
    return {
      cards: [],
      totalCards: 0,
      mainCount: 0,
      sideboardCount: 0,
      commanderCount: 0,
      errors: [error],
      stats: {
        totalCards: 0,
        mainCount: 0,
        sideboardCount: 0,
        commanderCount: 0,
        errorCount: 1
      }
    };
  }

  const lines = rawText.split(/\r?\n/);
  const cards = [];
  const errors = [];
  let currentSection = defaultSection;

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // 1. Skip empty lines and comment lines (prefixed with // or #)
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) {
      continue;
    }

    // 2. Section header state changes (standalone section labels)
    // Matches headers like "Commander", "Companion", "Commander (1)", "Sideboard:", "Deck"
    if (/^(?:commander|companion|cmdr)\b(?:\s*\(\d+\))?:?$/i.test(trimmed)) {
      currentSection = 'commander';
      continue;
    }
    if (/^(?:sideboard|side|sb)\b(?:\s*\(\d+\))?:?$/i.test(trimmed)) {
      currentSection = 'sideboard';
      continue;
    }
    if (/^(?:deck|main|mainboard)\b(?:\s*\(\d+\))?:?$/i.test(trimmed)) {
      currentSection = 'main';
      continue;
    }

    try {
      // 3. Attempt comprehensive regex match
      let match = trimmed.match(REGEX_DECK_COMPREHENSIVE);
      let matchedName = '';
      let matchedCount = 1;
      let matchedSet = null;
      let matchedCollector = null;
      let cardSection = currentSection;

      if (match && match.groups) {
        matchedCount = parseInt(match.groups.count, 10);
        matchedName = match.groups.name.trim();
        matchedSet = match.groups.set ? match.groups.set.toLowerCase() : null;
        matchedCollector = match.groups.collector || null;

        // Process inline section override if present
        if (match.groups.inlineSection) {
          const inline = match.groups.inlineSection.toUpperCase();
          if (inline.startsWith('SB')) {
            cardSection = 'sideboard';
          } else if (inline.startsWith('CMDR') || inline.startsWith('COMMANDER')) {
            cardSection = 'commander';
          }
        }
      } else {
        // 4. Fallback to simple regex
        match = trimmed.match(REGEX_DECK_SIMPLE);
        if (match && match.groups) {
          matchedCount = parseInt(match.groups.count, 10);
          matchedName = match.groups.name.trim();

          // Process inline section override if present
          if (match.groups.inlineSection) {
            const inline = match.groups.inlineSection.toUpperCase();
            if (inline.startsWith('SB')) {
              cardSection = 'sideboard';
            } else if (inline.startsWith('CMDR') || inline.startsWith('COMMANDER')) {
              cardSection = 'commander';
            }
          }
        } else {
          // Line failed to match expected card pattern
          errors.push({
            lineNumber,
            rawLine,
            reason: 'Unable to parse quantity and card name'
          });
          continue;
        }
      }

      // Step 3: Card Name Sanitization
      // Normalize multi-faced card slash separators (e.g. "Fire/Ice", "Fire // Ice" -> "Fire // Ice")
      matchedName = matchedName.replace(/\s*\/{1,}\s*/g, ' // ');

      cards.push({
        count: matchedCount,
        name: matchedName,
        set: matchedSet,
        collectorNumber: matchedCollector,
        section: cardSection
      });
    } catch (err) {
      // Zero-failure invariant: never throw on line parsing error
      errors.push({
        lineNumber,
        rawLine,
        reason: `Unexpected parsing error: ${err.message}`
      });
    }
  }

  // Calculate section totals
  let mainCount = 0;
  let sideboardCount = 0;
  let commanderCount = 0;

  for (const card of cards) {
    if (card.section === 'sideboard') {
      sideboardCount += card.count;
    } else if (card.section === 'commander') {
      commanderCount += card.count;
    } else {
      mainCount += card.count;
    }
  }

  const totalCards = mainCount + sideboardCount + commanderCount;

  return {
    cards,
    totalCards,
    mainCount,
    sideboardCount,
    commanderCount,
    errors,
    stats: {
      totalCards,
      mainCount,
      sideboardCount,
      commanderCount,
      errorCount: errors.length
    }
  };
}

export const DeckParser = {
  parse: parseDecklist,
  parseDecklist,
  REGEX_DECK_COMPREHENSIVE,
  REGEX_DECK_SIMPLE
};

export default {
  parseDecklist,
  DeckParser,
  REGEX_DECK_COMPREHENSIVE,
  REGEX_DECK_SIMPLE
};
