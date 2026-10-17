/**
 * ActionLexer.js
 * Sub-2ms Bilingual Fast-Path Regex Engine & Staged Action Proposal Generator
 * Supports Spanish ('es') and English ('en') MTG shorthands.
 * 
 * Part of RPM Multiplayer - Feature 5 & 6
 * Document ID: SPEC-RPM-CHAT-005
 * 
 * @module ActionLexer
 */

/**
 * Thrown when text fails lexer grammar rules or syntax constraints.
 */
export class ActionLexerError extends Error {
  /**
   * @param {string} message
   * @param {Object} [details={}]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'ActionLexerError';
    this.details = details;
  }
}

/**
 * Pre-compiled Regular Expressions for Sub-2ms Performance SLA
 */

// Priority Passing
const REGEX_PASS_EN = /^(?:pass(?:\s+priority)?|go|your\s+turn|turn|done)$/i;
const REGEX_PASS_ES = /^(?:paso(?:\s+prioridad)?|cedo(?:\s+prioridad)?|tu\s+turno|turno|listo|pasa)$/i;

// Life Adjustments - SET
const REGEX_LIFE_SET = /^(?:(?:life|vida|vidas|to|a|baja\s+a|sube\s+a|vida\s+a)\s*(\d+)|(?:set\s+life\s+to|poner\s+vida\s+en)\s*(\d+))$/i;

// Life Adjustments - DELTA (Loss/Damage)
const REGEX_LIFE_MINUS_EN = /^(?:(?:take|lose)\s*(\d+)(?:\s*(?:damage|life))?|-\s*(\d+)(?:\s*life)?)$/i;
const REGEX_LIFE_MINUS_ES = /^(?:(?:pierdo|baja|me\s+pego)\s*(\d+)(?:\s*(?:de\s+vida|vidas|dano))?|-\s*(\d+)(?:\s*(?:vida|vidas))?)$/i;

// Life Adjustments - DELTA (Gain)
const REGEX_LIFE_PLUS_EN = /^(?:gain\s*(\d+)(?:\s*life)?|\+\s*(\d+)(?:\s*life)?)$/i;
const REGEX_LIFE_PLUS_ES = /^(?:(?:gano|subo|cura)\s*(\d+)(?:\s*(?:de\s+vida|vidas))?|\+\s*(\d+)(?:\s*(?:vida|vidas))?)$/i;

// Play Land
const REGEX_LAND_EN = /^(?:play|land|drop)\s+(?:a\s+|an\s+)?([a-z0-9\s',/-]+)$/i;
const REGEX_LAND_ES = /^(?:bajo|juego|tierra)\s+(?:un\s+|una\s+)?([a-z0-9\s',/-]+)$/i;

// Cast Spell
const REGEX_CAST_EN = /^(?:cast|play)\s+([a-z0-9\s',/-]+?)(?:\s+(?:on|targeting|to)\s+([a-z0-9\s',/-]+))?$/i;
const REGEX_CAST_ES = /^(?:tiro|lanzo|casteo|juego)\s+([a-z0-9\s',/-]+?)(?:\s+(?:a|al|sobre|objetivo)\s+([a-z0-9\s',/-]+))?$/i;

// Single-word shorthand spells
const REGEX_SHORTHAND_SPELL = /^(bolt|counterspell|push|heat|path|swords|thoughtseize)$/i;

// Shorthand Card Aliases Table (CR 117 rules shorthand)
const CARD_ALIASES = Object.freeze({
  'bolt': 'Lightning Bolt',
  'push': 'Fatal Push',
  'heat': 'Unholy Heat',
  'counterspell': 'Counterspell',
  'path': 'Path to Exile',
  'swords': 'Swords to Plowshares',
  'thoughtseize': 'Thoughtseize',
  'fetch': 'Fetchland',
  'isla': 'Island',
  'island': 'Island',
  'montana': 'Mountain',
  'mountain': 'Mountain',
  'pantano': 'Swamp',
  'swamp': 'Swamp',
  'bosque': 'Forest',
  'forest': 'Forest',
  'llanura': 'Plains',
  'plains': 'Plains'
});

// Known Land Names & Subtypes for Disambiguation
const KNOWN_LAND_KEYWORDS = new Set([
  'mountain', 'island', 'swamp', 'forest', 'plains',
  'montana', 'isla', 'pantano', 'bosque', 'llanura',
  'blood crypt', 'steam vents', 'overgrown tomb', 'watery grave',
  'sacred foundry', 'temple garden', 'breeding pool', 'stomping ground',
  'godless shrine', 'hallowed fountain', 'arid mesa', 'scalding tarn',
  'misty rainforest', 'verdant catacombs', 'marsh flats', 'polluted delta',
  'flooded strand', 'bloodstained mire', 'wooded foothills', 'windswept heath',
  'urza\'s saga', 'urzas saga', 'boseiju', 'otawara', 'eiganjo', 'sokenzan',
  'takenuma', 'cavern of souls', 'fetch', 'fetchland', 'shockland', 'triome'
]);

// Known Removal Spells for Generic Intent "removal"
const KNOWN_REMOVAL_NAMES = new Set([
  'fatal push', 'unholy heat', 'lightning bolt', 'path to exile',
  'swords to plowshares', 'terminate', 'dismember', 'abrupt decay',
  'assassin\'s trophy', 'prismatic ending', 'solitude', 'fury'
]);

/**
 * Generates an RFC-compliant proposal ID
 * Format: `prop_${timestamp}_${hex8}`
 * 
 * @returns {string}
 */
export function generateProposalId() {
  const timestamp = Date.now();
  const hex = Math.random().toString(36).substring(2, 10);
  return `prop_${timestamp}_${hex}`;
}

/**
 * Builds confirmation display metadata for UI chips
 * 
 * @param {string} actionType 
 * @param {string|null} cardName 
 * @param {Object} params 
 * @returns {{ title: string, subtitle: string, icon: string, badgeColor: string }}
 */
function buildConfirmationDisplay(actionType, cardName, params = {}) {
  switch (actionType) {
    case 'PASS_PRIORITY':
      return {
        title: 'Confirm: Pass Priority',
        subtitle: 'Yield priority to opponent',
        icon: 'clock',
        badgeColor: '#4A90E2'
      };
    case 'ADJUST_LIFE': {
      const opText = params.lifeOperation === 'SET'
        ? `Set to ${params.lifeAmount}`
        : `${params.lifeDelta > 0 ? '+' : ''}${params.lifeDelta}`;
      return {
        title: `Confirm: Adjust Life (${opText})`,
        subtitle: 'Update player life total',
        icon: 'heart',
        badgeColor: '#E24A4A'
      };
    }
    case 'PLAY_LAND':
      return {
        title: `Confirm: Play Land: ${cardName || params.cardName}`,
        subtitle: 'Play land onto battlefield',
        icon: 'mountain',
        badgeColor: '#4AE290'
      };
    case 'CAST_SPELL': {
      const targets = params.targets;
      const targetStr = (Array.isArray(targets) && targets.length > 0)
        ? `Target: ${targets[0].targetName}`
        : 'Cast to stack';
      return {
        title: `Confirm: Cast ${cardName || params.cardName || 'Spell'}`,
        subtitle: targetStr,
        icon: 'zap',
        badgeColor: '#E2904A'
      };
    }
    default:
      return {
        title: `Confirm: ${actionType}`,
        subtitle: 'Submit tabletop action',
        icon: 'play',
        badgeColor: '#6C757D'
      };
  }
}

/**
 * ActionLexer - Deterministic bilingual regex engine for MTG shorthands.
 */
export class ActionLexer {
  /**
   * Normalizes bilingual text:
   * 1. Strips diacritics/accents via Unicode NFKD (á -> a, ñ -> n, etc.)
   * 2. Lowers case
   * 3. Strips extraneous punctuation preserving math signs, hyphens, and apostrophes
   * 4. Collapses multiple whitespace to single space
   * 
   * @param {string} text
   * @returns {string}
   */
  static normalize(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\w\s+\-',/]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Matches a raw card name token against cards in hand.
   * 
   * @param {string} rawCardName
   * @param {Array<Object>} handCards
   * @returns {{ matchType: 'EXACT'|'ALIAS'|'AMBIGUOUS'|'NONE', candidates: Array<Object>, matchedCard: Object|null }}
   */
  static matchHandCard(rawCardName, handCards = []) {
    if (!Array.isArray(handCards) || handCards.length === 0) {
      return { matchType: 'NONE', candidates: [], matchedCard: null };
    }

    const normToken = ActionLexer.normalize(rawCardName);

    // Generic intent "removal"
    if (normToken === 'removal') {
      const removalCandidates = handCards.filter(card => {
        const nameNorm = ActionLexer.normalize(card.name || '');
        const typeNorm = ActionLexer.normalize(card.typeLine || '');
        return KNOWN_REMOVAL_NAMES.has(nameNorm) ||
               typeNorm.includes('instant') ||
               typeNorm.includes('sorcery');
      });

      if (removalCandidates.length > 1) {
        return {
          matchType: 'AMBIGUOUS',
          candidates: removalCandidates.map(c => ({
            instanceId: c.instanceId,
            name: c.name,
            manaCost: c.manaCost || '',
            typeLine: c.typeLine || '',
            zone: c.zone || 'HAND',
            matchScore: 0.9,
            isPlayable: true
          })),
          matchedCard: null
        };
      } else if (removalCandidates.length === 1) {
        return {
          matchType: 'EXACT',
          candidates: [removalCandidates[0]],
          matchedCard: removalCandidates[0]
        };
      }
    }

    // Exact match
    const exactMatches = handCards.filter(c => ActionLexer.normalize(c.name || '') === normToken);
    if (exactMatches.length === 1) {
      return { matchType: 'EXACT', candidates: exactMatches, matchedCard: exactMatches[0] };
    } else if (exactMatches.length > 1) {
      return {
        matchType: 'AMBIGUOUS',
        candidates: exactMatches,
        matchedCard: null
      };
    }

    // Alias match
    const canonicalAlias = CARD_ALIASES[normToken];
    if (canonicalAlias) {
      const aliasNorm = ActionLexer.normalize(canonicalAlias);
      const aliasMatches = handCards.filter(c => ActionLexer.normalize(c.name || '') === aliasNorm);
      if (aliasMatches.length === 1) {
        return { matchType: 'ALIAS', candidates: aliasMatches, matchedCard: aliasMatches[0] };
      } else if (aliasMatches.length > 1) {
        return { matchType: 'AMBIGUOUS', candidates: aliasMatches, matchedCard: null };
      }
    }

    // Substring match
    const subMatches = handCards.filter(c => ActionLexer.normalize(c.name || '').includes(normToken));
    if (subMatches.length === 1) {
      return { matchType: 'EXACT', candidates: subMatches, matchedCard: subMatches[0] };
    } else if (subMatches.length > 1) {
      return { matchType: 'AMBIGUOUS', candidates: subMatches, matchedCard: null };
    }

    return { matchType: 'NONE', candidates: [], matchedCard: null };
  }

  /**
   * Evaluates if a card token represents a land
   * 
   * @param {string} token 
   * @param {Array<Object>} [handCards=[]] 
   * @returns {boolean}
   */
  static isLand(token, handCards = []) {
    const norm = ActionLexer.normalize(token);
    if (KNOWN_LAND_KEYWORDS.has(norm)) return true;

    for (const keyword of KNOWN_LAND_KEYWORDS) {
      if (norm.includes(keyword)) return true;
    }

    if (Array.isArray(handCards)) {
      const found = handCards.find(c => ActionLexer.normalize(c.name || '') === norm || ActionLexer.normalize(c.name || '').includes(norm));
      if (found && (found.typeLine || '').toLowerCase().includes('land')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Parses raw input text against MTG regex grammar
   * Execution budget: < 2.0ms.
   * 
   * @param {string} text - Raw input string or speech transcript
   * @param {Object} [context={}] - Tabletop context { handCards, battlefieldPermanents, activePlayerId, sessionId }
   * @returns {Object} DraftActionProposal
   */
  static parse(text, context = {}) {
    if (!text || typeof text !== 'string') {
      throw new ActionLexerError('Input text must be a non-empty string', { text });
    }

    const rawTrimmed = text.trim();
    const normalized = ActionLexer.normalize(rawTrimmed);
    const handCards = context.handCards || [];
    const battlefieldPermanents = context.battlefieldPermanents || context.battlefieldCards || [];
    const proposalId = generateProposalId();
    const now = Date.now();

    // 1. Pass Priority
    if (REGEX_PASS_EN.test(normalized) || REGEX_PASS_ES.test(normalized)) {
      const isES = REGEX_PASS_ES.test(normalized);
      const params = { passType: 'PASS_PRIORITY' };
      return {
        id: proposalId,
        sessionId: context.sessionId || 'session',
        playerId: context.activePlayerId || 'p1',
        actionType: 'PASS_PRIORITY',
        cardName: null,
        params,
        confidence: 1.0,
        rawText: rawTrimmed,
        language: isES ? 'es' : 'en',
        status: 'STAGED',
        createdAt: now,
        expiresAt: now + 30000,
        confirmationDisplay: buildConfirmationDisplay('PASS_PRIORITY', null, params)
      };
    }

    // 2. Life Adjustments - SET
    const setMatch = normalized.match(REGEX_LIFE_SET);
    if (setMatch) {
      const amount = parseInt(setMatch[1] || setMatch[2], 10);
      const params = {
        lifeOperation: 'SET',
        lifeAmount: amount
      };
      return {
        id: proposalId,
        sessionId: context.sessionId || 'session',
        playerId: context.activePlayerId || 'p1',
        actionType: 'ADJUST_LIFE',
        cardName: null,
        params,
        confidence: 1.0,
        rawText: rawTrimmed,
        language: /vida|baja|sube|poner/i.test(normalized) ? 'es' : 'en',
        status: 'STAGED',
        createdAt: now,
        expiresAt: now + 30000,
        confirmationDisplay: buildConfirmationDisplay('ADJUST_LIFE', null, params)
      };
    }

    // 3. Life Adjustments - DELTA (Loss/Damage)
    const minusEnMatch = normalized.match(REGEX_LIFE_MINUS_EN);
    const minusEsMatch = normalized.match(REGEX_LIFE_MINUS_ES);
    if (minusEnMatch || minusEsMatch) {
      const match = minusEnMatch || minusEsMatch;
      const amount = parseInt(match[1] || match[2], 10);
      const params = {
        lifeOperation: 'DELTA',
        lifeDelta: -amount
      };
      return {
        id: proposalId,
        sessionId: context.sessionId || 'session',
        playerId: context.activePlayerId || 'p1',
        actionType: 'ADJUST_LIFE',
        cardName: null,
        params,
        confidence: 1.0,
        rawText: rawTrimmed,
        language: minusEsMatch ? 'es' : 'en',
        status: 'STAGED',
        createdAt: now,
        expiresAt: now + 30000,
        confirmationDisplay: buildConfirmationDisplay('ADJUST_LIFE', null, params)
      };
    }

    // 4. Life Adjustments - DELTA (Gain)
    const plusEnMatch = normalized.match(REGEX_LIFE_PLUS_EN);
    const plusEsMatch = normalized.match(REGEX_LIFE_PLUS_ES);
    if (plusEnMatch || plusEsMatch) {
      const match = plusEnMatch || plusEsMatch;
      const amount = parseInt(match[1] || match[2], 10);
      const params = {
        lifeOperation: 'DELTA',
        lifeDelta: +amount
      };
      return {
        id: proposalId,
        sessionId: context.sessionId || 'session',
        playerId: context.activePlayerId || 'p1',
        actionType: 'ADJUST_LIFE',
        cardName: null,
        params,
        confidence: 1.0,
        rawText: rawTrimmed,
        language: plusEsMatch ? 'es' : 'en',
        status: 'STAGED',
        createdAt: now,
        expiresAt: now + 30000,
        confirmationDisplay: buildConfirmationDisplay('ADJUST_LIFE', null, params)
      };
    }

    // 5. Land Plays vs Spells
    const landEnMatch = normalized.match(REGEX_LAND_EN);
    const landEsMatch = normalized.match(REGEX_LAND_ES);
    const castEnMatch = normalized.match(REGEX_CAST_EN);
    const castEsMatch = normalized.match(REGEX_CAST_ES);
    const shorthandMatch = normalized.match(REGEX_SHORTHAND_SPELL);

    // Check if definitely Land
    const isLandVerb = /^(?:land|drop|bajo|tierra)\b/i.test(normalized);
    const isCastVerb = /^(?:cast|tiro|lanzo|casteo)\b/i.test(normalized);

    // Resolve Land Drops
    if ((isLandVerb && (landEnMatch || landEsMatch)) ||
        ((landEnMatch || landEsMatch) && !isCastVerb && ActionLexer.isLand((landEnMatch || landEsMatch)[1], handCards))) {
      const match = landEnMatch || landEsMatch;
      const rawCardToken = match[1].trim();
      const isES = Boolean(landEsMatch);

      // Check hand cards match
      const handMatch = ActionLexer.matchHandCard(rawCardToken, handCards);
      const resolvedCardName = handMatch.matchedCard ? handMatch.matchedCard.name : rawCardToken;
      const cardId = handMatch.matchedCard ? handMatch.matchedCard.instanceId : null;

      const params = {
        cardName: resolvedCardName,
        cardId
      };

      const proposal = {
        id: proposalId,
        sessionId: context.sessionId || 'session',
        playerId: context.activePlayerId || 'p1',
        actionType: 'PLAY_LAND',
        cardName: resolvedCardName,
        params,
        confidence: handMatch.matchedCard ? 0.95 : 0.8,
        rawText: rawTrimmed,
        language: isES ? 'es' : 'en',
        status: handMatch.matchType === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'STAGED',
        createdAt: now,
        expiresAt: now + 30000,
        confirmationDisplay: buildConfirmationDisplay('PLAY_LAND', resolvedCardName, params)
      };

      if (handMatch.matchType === 'AMBIGUOUS') {
        proposal.candidates = handMatch.candidates;
      }

      return proposal;
    }

    // 6. Resolve Spells (Cast or Shorthand)
    if (castEnMatch || castEsMatch || shorthandMatch || (landEnMatch && !ActionLexer.isLand(landEnMatch[1], handCards))) {
      const isES = Boolean(castEsMatch);
      let rawCardToken = '';
      let rawTargetToken = null;

      if (shorthandMatch) {
        rawCardToken = shorthandMatch[1].trim();
      } else if (castEsMatch) {
        rawCardToken = castEsMatch[1].trim();
        rawTargetToken = castEsMatch[2] ? castEsMatch[2].trim() : null;
      } else if (castEnMatch) {
        rawCardToken = castEnMatch[1].trim();
        rawTargetToken = castEnMatch[2] ? castEnMatch[2].trim() : null;
      } else if (landEnMatch) {
        rawCardToken = landEnMatch[1].trim();
      }

      // Check card in hand
      const handMatch = ActionLexer.matchHandCard(rawCardToken, handCards);

      // Ambiguity check for Card
      if (handMatch.matchType === 'AMBIGUOUS') {
        return {
          id: proposalId,
          sessionId: context.sessionId || 'session',
          playerId: context.activePlayerId || 'p1',
          actionType: 'CAST_SPELL',
          cardName: null,
          params: {
            cardName: null,
            cardId: null,
            targets: null
          },
          candidates: handMatch.candidates,
          confidence: 0.5,
          rawText: rawTrimmed,
          language: isES ? 'es' : 'en',
          status: 'AMBIGUOUS',
          createdAt: now,
          expiresAt: now + 30000,
          confirmationDisplay: {
            title: `Ambiguous Action: "${rawTrimmed}"`,
            subtitle: 'Select card to cast',
            icon: 'help-circle',
            badgeColor: '#F5A623'
          }
        };
      }

      const resolvedCardName = handMatch.matchedCard ? handMatch.matchedCard.name : rawCardToken;
      const cardId = handMatch.matchedCard ? handMatch.matchedCard.instanceId : null;

      // Targets resolution
      let targets = null;
      if (rawTargetToken) {
        targets = [{
          targetType: 'PERMANENT',
          targetId: `target_${rawTargetToken.replace(/\s+/g, '_')}`,
          targetName: rawTargetToken
        }];
      }

      // Check Ambiguity for Target if no target provided in text but battlefieldPermanents has multiple targets
      const needsTargetDisambiguation = !targets && Array.isArray(battlefieldPermanents) && battlefieldPermanents.length > 1;

      if (needsTargetDisambiguation) {
        const targetCandidates = battlefieldPermanents.map(perm => ({
          targetId: perm.targetId || perm.id || perm.instanceId,
          targetType: perm.targetType || 'PERMANENT',
          targetName: perm.targetName || perm.name,
          name: perm.targetName || perm.name,
          zone: perm.zone || 'BATTLEFIELD',
          matchScore: 1.0,
          isPlayable: true
        }));

        const params = {
          cardName: resolvedCardName,
          cardId,
          targets: null
        };

        return {
          id: proposalId,
          sessionId: context.sessionId || 'session',
          playerId: context.activePlayerId || 'p1',
          actionType: 'CAST_SPELL',
          cardName: resolvedCardName,
          params,
          candidates: targetCandidates,
          confidence: 0.8,
          rawText: rawTrimmed,
          language: isES ? 'es' : 'en',
          status: 'AMBIGUOUS',
          createdAt: now,
          expiresAt: now + 30000,
          confirmationDisplay: {
            title: `Ambiguous Target for ${resolvedCardName}`,
            subtitle: 'Select target permanent',
            icon: 'crosshair',
            badgeColor: '#F5A623'
          }
        };
      }

      const params = {
        cardName: resolvedCardName,
        cardId,
        targets
      };

      return {
        id: proposalId,
        sessionId: context.sessionId || 'session',
        playerId: context.activePlayerId || 'p1',
        actionType: 'CAST_SPELL',
        cardName: resolvedCardName,
        params,
        confidence: handMatch.matchedCard ? 0.95 : 0.8,
        rawText: rawTrimmed,
        language: isES ? 'es' : 'en',
        status: 'STAGED',
        createdAt: now,
        expiresAt: now + 30000,
        confirmationDisplay: buildConfirmationDisplay('CAST_SPELL', resolvedCardName, params)
      };
    }

    // Fallback: If no recognized pattern matches, throw ActionLexerError
    throw new ActionLexerError(`Unrecognized turn command grammar: "${rawTrimmed}"`, {
      rawText: rawTrimmed,
      normalized
    });
  }

  /**
   * Resolves an AMBIGUOUS proposal by selecting a candidate ID
   * (either a card from hand or a permanent target).
   * 
   * @param {Object} proposal - DraftActionProposal with status === 'AMBIGUOUS'
   * @param {string} candidateId - Selected candidate ID
   * @returns {Object} Updated DraftActionProposal with status === 'STAGED'
   */
  static resolveCandidate(proposal, candidateId) {
    if (!proposal || !Array.isArray(proposal.candidates)) {
      throw new ActionLexerError('Proposal has no candidates to resolve', { proposal });
    }

    const candidate = proposal.candidates.find(c => 
      c.instanceId === candidateId ||
      c.cardId === candidateId ||
      c.targetId === candidateId ||
      c.id === candidateId
    );

    if (!candidate) {
      throw new ActionLexerError(`Candidate ID '${candidateId}' not found in proposal candidates`, {
        candidateId,
        availableCandidates: proposal.candidates
      });
    }

    const resolved = {
      ...proposal,
      status: 'STAGED',
      confidence: 0.95
    };

    // If resolving a target
    if (candidate.targetId || candidate.targetType) {
      const targetObj = {
        targetId: candidate.targetId || candidateId,
        targetType: candidate.targetType || 'PERMANENT',
        targetName: candidate.targetName || candidate.name
      };
      resolved.params = {
        ...resolved.params,
        targets: [targetObj]
      };
    } else {
      // Resolving a card
      resolved.cardName = candidate.name;
      resolved.params = {
        ...resolved.params,
        cardName: candidate.name,
        cardId: candidate.instanceId || candidateId
      };
    }

    resolved.confirmationDisplay = buildConfirmationDisplay(
      resolved.actionType,
      resolved.cardName || resolved.params.cardName,
      resolved.params
    );

    return resolved;
  }
}

export default ActionLexer;
