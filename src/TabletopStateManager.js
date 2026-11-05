/**
 * RPM Multiplayer - Tabletop Zone State Manager & Fog-of-War Projection
 * TabletopStateManager: Session orchestration, command dispatch, and Fog-of-War state projection.
 *
 * Specification: SPEC-RPM-ZONE-003
 *
 * @module TabletopStateManager
 */

import {
  ZoneModel,
  classifySubzone,
  StateTransitionError,
  CardNotFoundError,
  InvalidZoneError,
  InvalidCardTypeError,
  InsufficientManaError,
  PermanentAlreadyTappedError,
  PlayerNotFoundError
} from './ZoneModel.js';
import { EventEmitter } from './EventEmitter.js';
import { ZoneTransitionMatrix } from './ZoneTransitionMatrix.js';
import { CombatDamageEngine, canDeclareAsAttacker } from './CombatDamageEngine.js';
import { StateBasedActionsEngine } from './StateBasedActionsEngine.js';
import { AbilityEngine, CONTINUOUS_LAYERS } from './AbilityEngine.js';
import { CostModificationEngine } from './CostModificationEngine.js';
import { PregameStateMachine, PREGAME_STATES } from './PregameStateMachine.js';
import { ProcessTraceLogger, defaultProcessTraceLogger } from './ProcessTraceLogger.js';
import { OracleEffectCompiler, compileCardMechanics } from './OracleEffectCompiler.js';
import { CastAvailabilityManager } from './CastAvailabilityManager.js';

export { canDeclareAsAttacker, PregameStateMachine, PREGAME_STATES, ProcessTraceLogger, CastAvailabilityManager };

export class LandLimitExceededError extends StateTransitionError {
  constructor(message = 'Land drop limit reached for this turn') {
    super(message);
    this.name = 'LandLimitExceededError';
  }
}

export class PriorityViolationError extends StateTransitionError {
  constructor(message = 'Priority violation', details = {}) {
    super(message);
    this.name = 'PriorityViolationError';
    this.details = details;
    this.reason = details.reason || 'NO_PRIORITY';
  }
}

export class PhaseTimingError extends StateTransitionError {
  constructor(message = 'Phase timing restriction violated', details = {}) {
    super(message);
    this.name = 'PhaseTimingError';
    this.details = details;
    this.reason = details.reason || 'SORCERY_SPEED_RESTRICTION';
  }
}

/**
 * Deep clones a card instance entity to guarantee state immutability.
 * 
 * @param {Object} card
 * @returns {Object}
 */
function cloneCard(card) {
  if (!card) return card;
  return {
    ...card,
    colors: Array.isArray(card.colors) ? [...card.colors] : [],
    counters: card.counters ? { ...card.counters } : {},
    annotations: card.annotations ? { ...card.annotations } : {}
  };
}

/**
 * Projects canonical state into a safe Fog-of-War perspective for viewerPlayerId.
 * Strict Fog-of-War visibility policies are applied:
 * - Hand cards are opaque `{ instanceId: 'hidden', isHidden: true }` for opponents unless isHandRevealed === true.
 * - Library array is masked to `{ count: N }` for everyone to prevent top-deck scouting.
 * - Public zones (battlefield, graveyard, stack, exile) are visible.
 *
 * @param {Object|TabletopStateManager} fullStateOrManager - Full match state
 * @param {string} viewerPlayerId - Player ID of viewer or 'spectator'
 * @returns {Object} ProjectedTabletopState
 */
export function projectState(fullStateOrManager, viewerPlayerId) {
  const fullState = fullStateOrManager instanceof TabletopStateManager
    ? fullStateOrManager
    : fullStateOrManager;

  const projectedPlayers = {};

  for (const [playerId, playerState] of Object.entries(fullState.players || {})) {
    const isOwner = (playerId === viewerPlayerId);
    const canSeeHand = isOwner || playerState.isHandRevealed === true;

    // 1. Hand projection
    let projectedHandCards;
    if (canSeeHand) {
      projectedHandCards = (playerState.hand || []).map(cloneCard);
    } else {
      projectedHandCards = (playerState.hand || []).map(() => ({
        instanceId: 'hidden',
        isHidden: true
      }));
    }

    // 2. Library projection (Order is ALWAYS hidden)
    const projectedLibrary = {
      count: (playerState.library || []).length
    };

    // 3. Public battlefield projection
    const battlefield = playerState.battlefield || { lands: [], creatures: [], noncreatures: [], planeswalkers: [] };
    const projectedBattlefield = {
      lands: (battlefield.lands || []).map(cloneCard),
      creatures: (battlefield.creatures || []).map(cloneCard),
      noncreatures: (battlefield.noncreatures || []).map(cloneCard),
      planeswalkers: (battlefield.planeswalkers || []).map(cloneCard)
    };

    // 4. Public graveyard projection
    const projectedGraveyard = (playerState.graveyard || []).map(cloneCard);

    // 5. Exile projection (Mask face-down cards from opponents)
    const projectedExile = (playerState.exile || []).map(c => {
      if (c && c.isFaceDown && !isOwner) {
        return { instanceId: 'hidden', isFaceDown: true, isHidden: true };
      }
      return cloneCard(c);
    });

    const resources = playerState.resources || {
      life: 20,
      poison: 0,
      energy: 0,
      manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
    };

    projectedPlayers[playerId] = {
      playerId: playerState.playerId,
      playerName: playerState.playerName,
      library: projectedLibrary,
      hand: {
        count: (playerState.hand || []).length,
        cards: projectedHandCards,
        isRevealed: Boolean(playerState.isHandRevealed)
      },
      battlefield: projectedBattlefield,
      graveyard: projectedGraveyard,
      exile: projectedExile,
      resources: {
        life: resources.life,
        poison: resources.poison,
        energy: resources.energy,
        manaPool: { ...resources.manaPool }
      }
    };
  }

  return {
    sessionId: fullState.sessionId,
    activePlayerId: fullState.priorityMachine?.activePlayerId || fullState._priorityMachine?.activePlayerId || fullState.activePlayerId || null,
    turnNumber: fullState.turnNumber ?? 1,
    stack: (fullState.stack || []).map(cloneCard),
    players: projectedPlayers,
    viewerPlayerId,
    timestamp: Date.now()
  };
}

const BASIC_LAND_MAP = Object.freeze({
  plains: { typeLine: 'Basic Land — Plains', colors: ['W'] },
  island: { typeLine: 'Basic Land — Island', colors: ['U'] },
  swamp: { typeLine: 'Basic Land — Swamp', colors: ['B'] },
  mountain: { typeLine: 'Basic Land — Mountain', colors: ['R'] },
  forest: { typeLine: 'Basic Land — Forest', colors: ['G'] },
  wastes: { typeLine: 'Basic Land', colors: ['C'] },
  'snow-covered plains': { typeLine: 'Basic Snow Land — Plains', colors: ['W'] },
  'snow-covered island': { typeLine: 'Basic Snow Land — Island', colors: ['U'] },
  'snow-covered swamp': { typeLine: 'Basic Snow Land — Swamp', colors: ['B'] },
  'snow-covered mountain': { typeLine: 'Basic Snow Land — Mountain', colors: ['R'] },
  'snow-covered forest': { typeLine: 'Basic Snow Land — Forest', colors: ['G'] },
  'snow-covered wastes': { typeLine: 'Basic Snow Land', colors: ['C'] }
});

const SHOCK_LANDS = new Set([
  'steam vents', 'watery grave', 'blood crypt', 'stomping ground',
  'temple garden', 'godless shrine', 'overgrown tomb', 'breeding pool',
  'hallowed fountain', 'sacred foundry'
]);

const FETCH_LANDS = new Set([
  'flooded strand', 'polluted delta', 'bloodstained mire', 'wooded foothills',
  'windswept heath', 'marsh flats', 'scalding tarn', 'verdant catacombs',
  'arid mesa', 'misty rainforest'
]);

const CHECK_LANDS = new Set([
  'glacial fortress', 'drowned catacomb', 'dragonskull summit', 'rootbound crag',
  'sunpetal grove', 'isolated chapel', 'sulfur falls', 'woodland cemetery',
  'clifftop retreat', 'hinterland harbor'
]);

/**
 * Hydrates card mechanics, rules text, and effects for active deck cards.
 * @param {Object} card
 * @param {Object} [manifests=null]
 * @returns {Object}
 */
export function hydrateCardMechanics(card, manifests = null) {
  if (!card) return card;
  const nameNorm = String(card.name || '').trim().toLowerCase();

  // 1. Check manifests first if available
  const allManifests = manifests || TabletopStateManager?.deckManifests || null;
  if (allManifests) {
    let manifestCard = null;
    if (card.ownerId && allManifests[card.ownerId] && allManifests[card.ownerId][nameNorm]) {
      manifestCard = allManifests[card.ownerId][nameNorm];
    } else if (card.controllerId && allManifests[card.controllerId] && allManifests[card.controllerId][nameNorm]) {
      manifestCard = allManifests[card.controllerId][nameNorm];
    } else {
      for (const pid of Object.keys(allManifests)) {
        if (allManifests[pid] && allManifests[pid][nameNorm]) {
          manifestCard = allManifests[pid][nameNorm];
          break;
        }
      }
    }
    if (manifestCard) {
      if (manifestCard.typeLine && !card.typeLine) card.typeLine = manifestCard.typeLine;
      if (manifestCard.manaCost && !card.manaCost) card.manaCost = manifestCard.manaCost;
      if (manifestCard.power !== undefined && card.power === undefined) card.power = manifestCard.power;
      if (manifestCard.toughness !== undefined && card.toughness === undefined) card.toughness = manifestCard.toughness;
      if (manifestCard.oracleText && !card.oracleText) card.oracleText = manifestCard.oracleText;
      if (manifestCard.colors && (!card.colors || card.colors.length === 0)) card.colors = [...manifestCard.colors];
      if (manifestCard.compiledMechanics && !card.compiledMechanics) card.compiledMechanics = JSON.parse(JSON.stringify(manifestCard.compiledMechanics));
      if (manifestCard.subzone && !card.subzone) card.subzone = manifestCard.subzone;
      if (manifestCard.isPermanent !== undefined && card.isPermanent === undefined) card.isPermanent = manifestCard.isPermanent;
      if (manifestCard.effect && !card.effect) card.effect = manifestCard.effect;
    }
  }

  // 2. Canonical Card Presets
  if (nameNorm === 'heartfire hero') {
    card.typeLine = card.typeLine || 'Creature — Mouse Soldier';
    card.manaCost = card.manaCost || '{R}';
    card.power = card.power ?? 1;
    card.toughness = card.toughness ?? 1;
    card.oracleText = card.oracleText || 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.';
  } else if (nameNorm === "sigarda's aid" || nameNorm === 'sigardas aid' || nameNorm === "sigarda\x27s aid") {
    card.typeLine = card.typeLine || 'Enchantment';
    card.manaCost = card.manaCost || '{W}';
    card.oracleText = card.oracleText || 'You may cast Aura and Equipment spells as though they had flash.\nWhenever an Equipment enters the battlefield under your control, you may attach it to target creature you control.';
  } else if (nameNorm === 'colossus hammer') {
    card.typeLine = card.typeLine || 'Artifact — Equipment';
    card.manaCost = card.manaCost || '{1}';
    card.oracleText = card.oracleText || 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}';
  } else if (nameNorm === 'belt of giant strength') {
    card.typeLine = card.typeLine || 'Artifact — Equipment';
    card.manaCost = card.manaCost || '{1}{G}';
    card.equipCost = card.equipCost || '{10}';
    card.oracleText = card.oracleText || 'Equipped creature has base power and toughness 10/10.\nEquip {10}. This ability costs {X} less to activate, where X is the power of the creature it targets.';
    card.isPermanent = true;
    card.setBasePT = { power: 10, toughness: 10 };
  } else if (nameNorm === 'fervent champion') {
    card.typeLine = card.typeLine || 'Creature — Human Knight';
    card.manaCost = card.manaCost || '{R}';
    card.power = card.power ?? 1;
    card.toughness = card.toughness ?? 1;
    card.oracleText = card.oracleText || 'First strike, haste\nWhenever Fervent Champion attacks, another target attacking Knight you control gets +1/+0 until end of turn.\nEquip abilities you activate that target Fervent Champion cost {3} less to activate.';
    card.keywords = { ...(card.keywords || {}), firstStrike: true, FirstStrike: true, haste: true, Haste: true };
    card.hasSummoningSickness = false;
    card.isSummoningSick = false;
  } else if (nameNorm === 'leyline axe') {
    card.typeLine = card.typeLine || 'Artifact — Equipment';
    card.manaCost = card.manaCost || '{4}';
    card.oracleText = card.oracleText || 'If Leyline Axe is in your opening hand, you may begin the game with it on the battlefield.\nEquipped creature gets +1/+1 and has double strike and trample.\nEquip {3}';
    card.isPermanent = true;
  } else if (nameNorm === 'spire of industry') {
    card.type = 'Land';
    card.typeLine = card.typeLine || 'Land';
    card.cmc = card.cmc ?? 0;
    card.manaCost = card.manaCost !== undefined ? card.manaCost : '';
    card.oracleText = card.oracleText || '{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color. Activate only if you control an artifact.';
    card.isPermanent = true;
  } else if (nameNorm === 'starting town') {
    card.type = 'Land';
    card.typeLine = card.typeLine || 'Land';
    card.cmc = card.cmc ?? 0;
    card.manaCost = card.manaCost !== undefined ? card.manaCost : '';
    card.oracleText = card.oracleText || "Starting Town enters the battlefield tapped unless it's the first, second, or third turn of the game.\n{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color.";
    card.isPermanent = true;
  } else if (nameNorm === 'mana confluence') {
    card.type = 'Land';
    card.typeLine = card.typeLine || 'Land';
    card.cmc = card.cmc ?? 0;
    card.manaCost = card.manaCost !== undefined ? card.manaCost : '';
    card.oracleText = card.oracleText || '{T}, Pay 1 life: Add one mana of any color.';
    card.isPermanent = true;
  } else if (nameNorm.includes('callous sell-sword') || nameNorm.includes('burn together')) {
    card.typeLine = card.typeLine || 'Creature — Human Soldier // Sorcery — Adventure';
    card.manaCost = card.manaCost || '{1}{B} // {R}';
    card.power = card.power ?? 2;
    card.toughness = card.toughness ?? 2;
    card.oracleText = card.oracleText || "Callous Sell-Sword enters the battlefield with a +1/+1 counter on it for each creature that died under your control this turn.\n\nBurn Together\nTarget creature you control deals damage equal to its power to any other target. Then sacrifice it.";
  } else if (nameNorm === 'lava spike') {
    card.effect = card.effect || { type: 'DEAL_DAMAGE', amount: 3, targetType: 'player_or_planeswalker' };
    card.typeLine = card.typeLine || 'Sorcery — Arcane';
    card.manaCost = card.manaCost || '{R}';
  } else if (nameNorm === 'lightning bolt') {
    card.effect = card.effect || { type: 'DEAL_DAMAGE', amount: 3, targetType: 'any' };
    card.typeLine = card.typeLine || 'Instant';
    card.manaCost = card.manaCost || '{R}';
  } else if (nameNorm === 'goblin guide') {
    card.typeLine = card.typeLine || 'Creature — Goblin Scout';
    card.keywords = { ...(card.keywords || {}), haste: true, Haste: true };
    card.hasSummoningSickness = false;
    card.isSummoningSick = false;
    card.power = card.power ?? 2;
    card.toughness = card.toughness ?? 2;
  } else if (nameNorm === 'monastery swiftspear') {
    card.typeLine = card.typeLine || 'Creature — Human Monk';
    card.keywords = { ...(card.keywords || {}), haste: true, Haste: true, prowess: true, Prowess: true };
    card.hasSummoningSickness = false;
    card.isSummoningSick = false;
    card.power = card.power ?? 1;
    card.toughness = card.toughness ?? 2;
  }

  // Hydrate lands
  if (BASIC_LAND_MAP[nameNorm]) {
    card.type = card.type || 'Land';
    card.typeLine = card.typeLine || BASIC_LAND_MAP[nameNorm].typeLine;
    card.cmc = card.cmc ?? 0;
    card.manaCost = card.manaCost !== undefined ? card.manaCost : '';
    card.isBasicLand = true;
    if (!card.colors || card.colors.length === 0) {
      card.colors = [...BASIC_LAND_MAP[nameNorm].colors];
    }
  } else if (SHOCK_LANDS.has(nameNorm)) {
    card.type = card.type || 'Land';
    card.cmc = card.cmc ?? 0;
    card.manaCost = card.manaCost !== undefined ? card.manaCost : '';
    card.isShockland = true;
  } else if (FETCH_LANDS.has(nameNorm)) {
    card.type = card.type || 'Land';
    card.cmc = card.cmc ?? 0;
    card.manaCost = card.manaCost !== undefined ? card.manaCost : '';
    card.isFetchland = true;
  } else if (CHECK_LANDS.has(nameNorm)) {
    card.type = card.type || 'Land';
    card.cmc = card.cmc ?? 0;
    card.manaCost = card.manaCost !== undefined ? card.manaCost : '';
    card.isCheckland = true;
  }

  // Hydrate standard keywords
  const kw = { ...(card.keywords || {}) };
  const fullText = `${card.oracleText || ''} ${card.text || ''}`.toLowerCase();

  const checkKw = (regex, key, altKeys = []) => {
    let matched = Boolean(kw[key] || kw[key.toLowerCase()] || kw[key.charAt(0).toUpperCase() + key.slice(1)]);
    if (!matched && regex.test(fullText)) {
      matched = true;
    }
    if (matched) {
      kw[key] = true;
      kw[key.charAt(0).toUpperCase() + key.slice(1)] = true;
      for (const alt of altKeys) {
        kw[alt] = true;
      }
    }
  };

  checkKw(/\bflying\b/i, 'flying');
  checkKw(/\bhaste\b/i, 'haste');
  checkKw(/\bvigilance\b/i, 'vigilance');
  checkKw(/\btrample\b/i, 'trample');
  checkKw(/\blifelink\b/i, 'lifelink');
  checkKw(/\bdeathtouch\b/i, 'deathtouch');
  checkKw(/\breach\b/i, 'reach');
  checkKw(/\bflash\b/i, 'flash');
  checkKw(/\bprowess\b/i, 'prowess');
  checkKw(/\bfirst strike\b/i, 'firstStrike', ['first_strike', 'FirstStrike']);
  checkKw(/\bdouble strike\b/i, 'doubleStrike', ['double_strike', 'DoubleStrike']);
  checkKw(/\bmenace\b/i, 'menace');
  checkKw(/\bhexproof\b/i, 'hexproof');
  checkKw(/\bindestructible\b/i, 'indestructible');

  card.keywords = kw;
  if (kw.haste) {
    card.hasSummoningSickness = false;
    card.isSummoningSick = false;
  }

  // Compile full deterministic rules and subzone classification
  compileCardMechanics(card);

  if (nameNorm === 'belt of giant strength') {
    card.compiledMechanics = card.compiledMechanics || {};
    card.compiledMechanics.isEquipment = true;
    card.compiledMechanics.equipCost = '{10}';
    card.compiledMechanics.attachmentEffects = card.compiledMechanics.attachmentEffects || {};
    card.compiledMechanics.attachmentEffects.setPower = 10;
    card.compiledMechanics.attachmentEffects.setToughness = 10;
    card.attachmentEffects = card.attachmentEffects || {};
    card.attachmentEffects.setPower = 10;
    card.attachmentEffects.setToughness = 10;
    card.setBasePT = { power: 10, toughness: 10 };
  }

  return card;
}

/**
 * High-level Tabletop Match Manager and Event Coordinator.
 */
export class TabletopStateManager extends EventEmitter {
  static deckManifests = {};

  static hydrateCardMechanics(card, manifests = null) {
    return hydrateCardMechanics(card, manifests || this.deckManifests);
  }

  hydrateCardMechanics(card) {
    return hydrateCardMechanics(card, this.deckManifests);
  }

  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId || `session_${Date.now()}`;
    this.players = {}; // Map: playerId -> PlayerZoneState
    this.stack = [];   // Array: CardInstance
    this.deckManifests = options.deckManifests || {};
    this._activePlayerId = options.activePlayerId || null;
    this._turnNumber = options.turnNumber || 1;
    this._roundNumber = options.roundNumber || 1;
    this.startingPlayerId = options.startingPlayerId || (Array.isArray(options.players) ? (typeof options.players[0] === 'string' ? options.players[0] : options.players[0]?.id) : null) || this._activePlayerId || 'p1';
    this.playerTurnNumbers = new Map();
    this._priorityMachine = options.priorityMachine || null;
    this._priorityMachineWired = false;
    this.pregameMachine = options.pregameMachine || null;
    this.traceLogger = options.traceLogger || defaultProcessTraceLogger;
    this.abilityEngine = options.abilityEngine || new AbilityEngine({ tabletopState: this, traceLogger: this.traceLogger });
    if (this.abilityEngine) {
      this.abilityEngine._tabletopState = this;
      this.abilityEngine.tabletopState = this;
      if (!this.abilityEngine.traceLogger) this.abilityEngine.traceLogger = this.traceLogger;
    }
    this.costEngine = CostModificationEngine;
    this.actionLog = [];
    this.subscribers = new Set();
    this.sequenceCounter = 0;
    this.winnerId = null;
    this.isGameOver = false;
    this.combatState = { attackers: [], blockers: [] };
    this.pendingTriggerChoices = [];
    this.interactiveMode = Boolean(options.interactiveMode);

    if (Array.isArray(options.players)) {
      for (const p of options.players) {
        if (typeof p === 'string') {
          this.registerPlayer(p, p);
        } else if (p && p.id) {
          this.registerPlayer(p.id, p.name || p.id);
        }
      }
    }

    if (this._priorityMachine) {
      this._wirePriorityMachine();
    }
  }

  get activePlayerId() {
    return this._priorityMachine?.activePlayerId ?? this._activePlayerId;
  }
  set activePlayerId(val) {
    this._activePlayerId = val;
    if (this._priorityMachine && this._priorityMachine.activePlayerId !== val) {
      this._priorityMachine.activePlayerId = val;
    }
  }

  get turnNumber() {
    return this._priorityMachine?.turnNumber ?? this._turnNumber;
  }
  set turnNumber(val) {
    this._turnNumber = val;
    if (this._priorityMachine && this._priorityMachine.turnNumber !== val) {
      this._priorityMachine.turnNumber = val;
    }
  }

  get roundNumber() {
    return this._priorityMachine?.roundNumber ?? this._roundNumber;
  }
  set roundNumber(val) {
    this._roundNumber = val;
    if (this._priorityMachine && this._priorityMachine.roundNumber !== val) {
      this._priorityMachine.roundNumber = val;
    }
  }

  /**
   * Registers a player in the session.
   *
   * @param {string} playerId
   * @param {string} [playerName='Player']
   * @returns {Object} PlayerZoneState
   */
  registerPlayer(playerId, playerName = 'Player') {
    if (!playerId) {
      throw new Error('playerId is required');
    }
    if (this.players[playerId]) {
      return this.players[playerId];
    }
    const player = ZoneModel.createInitialPlayerState(playerId, playerName);
    player.id = playerId;
    player.playerId = playerId;
    player.companionZone = player.companionZone || [];
    if (player.zones) {
      player.zones.companionZone = player.companionZone;
    }
    player.landsPlayedThisTurn = 0;
    player.maxLandsPerTurn = 1;
    player.landsPerTurnLimit = 1;
    if (player.resources) {
      player.resources.landsPlayedThisTurn = 0;
      player.resources.maxLandsPerTurn = 1;
      player.resources.landsPerTurnLimit = 1;
    }
    this.players[playerId] = player;
    if (!this.playerTurnNumbers.has(playerId)) {
      this.playerTurnNumbers.set(playerId, 1);
    }
    if (!this.activePlayerId) {
      this.activePlayerId = playerId;
    }
    return player;
  }

  /**
   * Returns two-layer turn summary for specified or active player.
   *
   * @param {string} [playerId]
   * @returns {{ roundNumber: number, playerTurnNumber: number }}
   */
  getTurnSummary(playerId = this.activePlayerId) {
    return {
      roundNumber: this.roundNumber,
      playerTurnNumber: (playerId && this.playerTurnNumbers.get(playerId)) || 1
    };
  }

  /**
   * Retrieves a player state or throws if not found.
   *
   * @param {string} playerId
   * @returns {Object} PlayerZoneState
   */
  /**
   * Resolves canonical player ID when 'p1'/'P1' or 'p2'/'P2' alias is passed in a UUID-seated match.
   * @param {string} playerId
   * @returns {string}
   */
  resolvePlayerId(playerId) {
    if (!playerId || this.players[playerId]) return playerId;
    const norm = String(playerId).trim().toLowerCase();
    const keys = Object.keys(this.players || {});
    if (norm === 'p1' && keys[0] && /^[0-9a-f]{8}-/i.test(keys[0])) return keys[0];
    if (norm === 'p2' && keys[1] && keys[1] !== 'p2') return keys[1];
    return playerId;
  }

  getPlayer(playerId) {
    const resolvedId = this.resolvePlayerId(playerId);
    const player = this.players[resolvedId];
    if (!player) {
      throw new PlayerNotFoundError(`Player '${playerId}' not found in session`);
    }
    return player;
  }

  /**
   * Eliminates a player from the match (via concession, life 0, or deckout).
   * Unregisters all static effects of the player's permanents, clears their battlefield,
   * notifies priorityMachine, logs the action, and checks the victory condition.
   * 
   * @param {string} playerId
   * @param {string} [reason='CONCEDED']
   * @returns {{ eliminatedPlayerId: string, gameOver: boolean, winnerId: string|null }}
   */
  eliminatePlayer(playerId, reason = 'CONCEDED') {
    const player = this.players[playerId];
    if (!player) return null;

    player.isEliminated = true;

    // Collect permanents to unregister static effects and clear battlefield
    const permanents = [];
    if (Array.isArray(player.battlefield)) {
      permanents.push(...player.battlefield);
      player.battlefield = [];
    } else if (player.battlefield && typeof player.battlefield === 'object') {
      for (const key of Object.keys(player.battlefield)) {
        if (Array.isArray(player.battlefield[key])) {
          permanents.push(...player.battlefield[key]);
          player.battlefield[key] = [];
        }
      }
    }
    if (player.zones && Array.isArray(player.zones.battlefield)) {
      permanents.push(...player.zones.battlefield);
      player.zones.battlefield = [];
    }

    for (const perm of permanents) {
      if (perm && perm.instanceId && this.abilityEngine) {
        try {
          this.abilityEngine.unregisterEffectsFromSource(perm.instanceId);
        } catch (_) {}
      }
    }

    // Clean up cards on stack controlled or owned by eliminated player
    if (Array.isArray(this.stack)) {
      this.stack = this.stack.filter(card => {
        const owner = card.controllerId || card.ownerId || card.playerId;
        return owner !== playerId;
      });
    }

    const logEntry = {
      sequenceId: ++this.sequenceCounter,
      timestamp: Date.now(),
      actionType: 'PLAYER_ELIMINATED',
      playerId,
      payload: { playerId, reason }
    };
    this.actionLog.push(logEntry);
    this.emit('PLAYER_ELIMINATED', { playerId, reason });

    // Notify priority machine if wired
    if (this.priorityMachine && typeof this.priorityMachine.eliminatePlayer === 'function') {
      this.priorityMachine.eliminatePlayer(playerId);
    }

    // Victory condition check: count living players (!p.isEliminated)
    const survivingPlayers = Object.values(this.players).filter(p => !p.isEliminated);
    if (survivingPlayers.length === 1) {
      const survivingPlayer = survivingPlayers[0];
      this.winnerId = survivingPlayer.id || survivingPlayer.playerId;
      this.isGameOver = true;
      const gameOverPayload = {
        winnerId: this.winnerId,
        survivingPlayer
      };
      this.emit('GAME_OVER', gameOverPayload);
      return {
        eliminatedPlayerId: playerId,
        gameOver: true,
        winnerId: this.winnerId
      };
    }

    return {
      eliminatedPlayerId: playerId,
      gameOver: false,
      winnerId: null
    };
  }

  /**
   * Returns current life total for a player.
   *
   * @param {string} playerId
   * @returns {number}
   */
  getPlayerLife(playerId) {
    const player = this.getPlayer(playerId);
    return player.resources?.life ?? 20;
  }

  /**
   * Subscribes a listener to receive state updates on every state change.
   *
   * @param {Function} listener
   * @returns {Function} Unsubscribe callback
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new Error('Subscriber listener must be a function');
    }
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /**
   * Internal notifier to broadcast actions to subscribers.
   * @private
   */
  _notifySubscribers(logEntry, result) {
    for (const sub of this.subscribers) {
      try {
        sub({
          type: 'state_changed',
          sequenceId: logEntry.sequenceId,
          actionType: logEntry.actionType,
          playerId: logEntry.playerId,
          payload: logEntry.payload,
          result,
          timestamp: logEntry.timestamp
        });
      } catch (err) {
        // Prevent subscriber errors from disrupting state machine
        console.error('Subscriber error:', err);
      }
    }
  }

  /**
   * Returns a copy of the sequential action log.
   *
   * @returns {Array<Object>}
   */
  getActionLog() {
    return [...this.actionLog];
  }

  /**
   * Projects state from the perspective of viewerPlayerId.
   *
   * @param {string} viewerPlayerId
   * @returns {Object} ProjectedTabletopState
   */
  projectState(viewerPlayerId) {
    return projectState(this, viewerPlayerId);
  }

  /**
   * Primary action dispatch method. Validates preconditions, executes transitions,
   * logs the action, and notifies subscribers.
   *
   * @param {string} actionType
   * @param {Object} [payload={}]
   * @returns {Object} Action result
   */
  dispatch(actionType, payload = {}) {
    let result;

    switch (actionType) {
      case 'INITIALIZE_DECK':
        result = this._handleInitializeDeck(payload);
        break;
      case 'DRAW_CARD':
        result = this._handleDrawCard(payload);
        break;
      case 'PLAY_LAND':
        result = this._handlePlayLand(payload);
        break;
      case 'CAST_SPELL':
        result = this._handleCastSpell(payload);
        break;
      case 'MOVE_ZONE':
        result = this._handleMoveZone(payload);
        break;
      case 'TAP_PERMANENT':
        result = this._handleTapPermanent(payload);
        break;
      case 'UNTAP_PERMANENT':
        result = this._handleUntapPermanent(payload);
        break;
      case 'UNTAP_ALL':
        result = this._handleUntapAll(payload);
        break;
      case 'ADJUST_LIFE':
        result = this._handleAdjustLife(payload);
        break;
      case 'UPDATE_MANA_POOL':
        result = this._handleUpdateManaPool(payload);
        break;
      case 'MODIFY_COUNTERS':
        result = this._handleModifyCounters(payload);
        break;
      case 'REVEAL_HAND':
      case 'HIDE_HAND':
      case 'SET_HAND_REVEALED':
        result = this._handleSetHandRevealed(actionType, payload);
        break;
      case 'DEAL_DAMAGE':
        result = this._handleDealDamage(payload);
        break;
      case 'LOSE_LIFE':
        result = this._handleLoseLife(payload);
        break;
      case 'DECLARE_ATTACKERS':
        result = this.declareAttackers(payload.playerId || this.activePlayerId, payload.attackers || payload.attackersList || []);
        break;
      case 'DECLARE_BLOCKERS':
        result = this.declareBlockers(payload.playerId, payload.assignments || payload.blockers || []);
        break;
      case 'RESOLVE_COMBAT_DAMAGE':
        result = this.resolveCombatDamage();
        break;
      case 'ENTER_WITHOUT_CASTING':
        result = this._handleEnterWithoutCasting(payload);
        break;
      case 'CAST_WITHOUT_PAYING_MANA':
        result = this._handleCastWithoutPaying(payload);
        break;
      case 'REANIMATE':
        result = this._handleReanimate(payload);
        break;
      case 'REGROWTH':
        result = this._handleRegrowth(payload);
        break;
      case 'FLICKER':
        result = this._handleFlicker(payload);
        break;
      case 'MILL':
        result = this._handleMill(payload);
        break;
      case 'IMPULSE_EXILE':
        result = this._handleImpulseExile(payload);
        break;
      case 'RUN_SBA_CHECK':
        result = this.runSBACheck();
        break;
      case 'UNDO_LAST_MANA_TAP':
        result = this.undoLastManaTap(payload.playerId);
        break;
      case 'UNDO_ALL_MANA_TAPS':
        result = this.undoAllManaTaps(payload.playerId);
        break;
      case 'MOVE_COMPANION_TO_HAND':
        result = this.moveCompanionToHand(payload.playerId, payload.options || payload);
        break;
      default:
        throw new StateTransitionError(`Unknown actionType: ${actionType}`);
    }

    this.sequenceCounter++;
    const logEntry = {
      sequenceId: this.sequenceCounter,
      timestamp: Date.now(),
      actionType,
      playerId: payload.playerId || this.activePlayerId,
      payload: { ...payload }
    };
    this.actionLog.push(logEntry);

    this._notifySubscribers(logEntry, result);
    return result;
  }

  // --- Action Handlers ---

  _handleInitializeDeck(payload) {
    const { playerId, playerName = 'Player' } = payload;
    const options = payload.options || {};
    const cardsInput = payload.hydratedCards || payload.deckCards || [];

    let player = this.players[playerId];
    if (!player) {
      player = this.registerPlayer(playerId, playerName);
    } else {
      player.library = [];
      player.hand = [];
      player.battlefield = { lands: [], creatures: [], noncreatures: [], planeswalkers: [] };
      player.graveyard = [];
      player.exile = [];
      player.companionZone = [];
      player._companionMovedToHandThisGame = false;
      player.isHandRevealed = false;
      player.landsPlayedThisTurn = 0;
      player.creaturesDiedThisTurn = 0;
      player.maxLandsPerTurn = 1;
      player.landsPerTurnLimit = 1;
      player.resources = {
        life: 20,
        poison: 0,
        energy: 0,
        manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
        landsPlayedThisTurn: 0,
        maxLandsPerTurn: 1,
        landsPerTurnLimit: 1
      };
    }

    const startingLife = options.startingLife ?? payload.startingLife ?? 20;
    player.resources.life = startingLife;
    player.resources.poison = 0;
    player.resources.energy = 0;
    player.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    player.resources.landsPlayedThisTurn = 0;
    player.resources.maxLandsPerTurn = 1;
    player.resources.landsPerTurnLimit = 1;
    player.landsPlayedThisTurn = 0;
    player.maxLandsPerTurn = 1;
    player.landsPerTurnLimit = 1;
    player.isHandRevealed = false;

    // Expand cards based on count
    for (const cardData of cardsInput) {
      const count = typeof cardData.count === 'number' && cardData.count > 0 ? cardData.count : 1;
      for (let i = 0; i < count; i++) {
        const cardInstance = ZoneModel.createCardInstance(cardData, playerId, { zone: 'library' });
        player.library.push(cardInstance);
      }
    }

    const skipShuffle = options.skipShuffle ?? payload.skipShuffle ?? false;
    if (!skipShuffle) {
      ZoneModel.shuffleArray(player.library);
    }

    const startingHandSize = options.startingHandSize ?? payload.startingHandSize ?? 7;
    const cardsToDraw = Math.min(startingHandSize, player.library.length);
    if (cardsToDraw > 0) {
      const drawn = player.library.splice(0, cardsToDraw);
      for (const card of drawn) {
        card.zone = 'hand';
        card.subzone = null;
        player.hand.push(card);
      }
    }

    if (options.resolveOpeningHandActions === true || payload.resolveOpeningHandActions === true) {
      this.resolveOpeningHandActions(playerId);
    }

    return {
      playerId,
      handCount: player.hand.length,
      libraryCount: player.library.length,
      life: player.resources.life
    };
  }

  _handleDrawCard(payload) {
    const { playerId, count = 1 } = payload;
    this.clearUndoableManaTaps(playerId);
    const player = this.getPlayer(playerId);
    const n = Math.max(0, count);

    // CR 104.3c: If a player is required to draw from an empty library, they lose the game
    if (player.library.length === 0 && n > 0) {
      player.isEliminated = true;
      this.emit('EMPTY_LIBRARY_DRAW', { playerId, rule: 'CR 104.3c: Drawing from empty library results in game loss' });
      this.emit('PLAYER_LOST', { playerId, reason: 'EMPTY_LIBRARY', rule: 'CR 104.3c' });
      return {
        drawn: [],
        drawnCount: 0,
        libraryCount: 0,
        handCount: player.hand.length,
        playerLost: true,
        reason: 'CR 104.3c'
      };
    }

    const available = Math.min(n, player.library.length);
    const drawn = player.library.splice(0, available);

    for (const card of drawn) {
      card.zone = 'hand';
      card.subzone = null;
      player.hand.push(card);
    }

    if (player.zones) {
      player.zones.hand = player.hand;
      if (Array.isArray(player.zones.library)) {
        player.zones.library = player.library;
      }
    }

    if (drawn.length < n) {
      player.isEliminated = true;
      this.emit('EMPTY_LIBRARY_DRAW', { playerId, rule: 'CR 104.3c: Drawing from empty library results in game loss' });
      this.emit('PLAYER_LOST', { playerId, reason: 'EMPTY_LIBRARY', rule: 'CR 104.3c' });
    }

    return {
      drawn,
      drawnCount: drawn.length,
      libraryCount: player.library.length,
      handCount: player.hand.length
    };
  }

  _handlePlayLand(payload) {
    const playerId = payload.playerId || this.activePlayerId;
    this.clearUndoableManaTaps(playerId);
    const player = this.getPlayer(playerId);

    const instanceId = payload.instanceId || (payload.card && payload.card.instanceId);
    let card = payload.card;
    if (!card && player && player.hand) {
      card = player.hand.find(c => c && (
        (instanceId && c.instanceId === instanceId) ||
        (payload.card && (c.instanceId === payload.card.instanceId || c.name === payload.card.name))
      ));
    }
    if (!card) {
      card = { typeLine: 'Land', type: 'Land' };
    }

    const check = this.canPlayerCastOrPlay(playerId, card, this.priorityMachine);
    if (!check.allowed) {
      const err = check.reason === 'SORCERY_SPEED_RESTRICTION'
        ? new PhaseTimingError(check.message, { playerId, reason: check.reason })
        : new PriorityViolationError(check.message, { playerId, reason: check.reason });
      err.reason = check.reason;
      throw err;
    }

    const cardIdx = player.hand.findIndex(c => c && (
      (instanceId && c.instanceId === instanceId) ||
      (payload.card && (c.instanceId === payload.card.instanceId || c.name === payload.card.name))
    ));
    if (cardIdx === -1) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId || payload.card?.name} not found in player's hand`);
    }

    card = player.hand[cardIdx];
    TabletopStateManager.hydrateCardMechanics(card);
    if (!/land/i.test(card.typeLine || card.type || '')) {
      throw new InvalidCardTypeError(`Card is not a land: "${card.name}" (${card.typeLine})`);
    }

    const played = player.landsPlayedThisTurn ?? player.resources?.landsPlayedThisTurn ?? 0;
    const baseLimit = player.maxLandsPerTurn ?? player.landsPerTurnLimit ?? player.resources?.maxLandsPerTurn ?? 1;
    const extraLands = player.resources?.additionalLandsAllowed || 0;
    const limit = Math.max(baseLimit, 1 + extraLands);
    if (played >= limit) {
      throw new LandLimitExceededError(`Land drop limit reached for this turn (${played}/${limit}).`);
    }

    player.hand.splice(cardIdx, 1);
    card.zone = 'battlefield';
    card.subzone = 'lands';
    card.isTapped = false;

    // Shockland Detection (Steam Vents, Sacred Foundry, Watery Grave, etc. or ETB 2 life rules text)
    const isShockland = Boolean(card.isShockland) ||
      /steam vents|sacred foundry|watery grave|stomping ground|godless shrine|blood crypt|breeding pool|overgrown tomb|temple garden|hallowed fountain/i.test(card.name || '') ||
      /pay 2 life.*untapped|enters the battlefield tapped unless you pay 2 life/i.test(card.text || card.oracleText || '');

    if (isShockland) {
      const payShock = Boolean(payload.payShockCost ?? payload.pay2Life);
      const currentLife = player.resources?.life ?? 20;
      if (payShock && currentLife > 2) {
        CombatDamageEngine.loseLife({ playerId, amount: 2, reason: 'SHOCKLAND_COST' }, this);
        card.isTapped = false;
        this.emit('SHOCKLAND_ETB_RESOLVED', { playerId, card, paidLife: true });
      } else {
        card.isTapped = true;
        this.emit('SHOCKLAND_ETB_RESOLVED', { playerId, card, paidLife: false, enteredTapped: true });
      }
    }

    // Starting Town / Fastland ETB Condition (CR 305)
    const isStartingTown = Boolean(
      card.compiledMechanics?.etbTappedCondition === 'UNLESS_ROUND_1_2_OR_3' ||
      /enters(?:\s+the\s+battlefield)?\s+tapped\s+unless\s+it's\s+the\s+first,\s+second,\s+or\s+third\s+(?:turn|round)/i.test(card.oracleText || card.text || '') ||
      /starting\s+town/i.test(card.name || '')
    );

    if (isStartingTown) {
      const turnNum = this.priorityMachine?.turnNumber ?? this.turnNumber ?? 1;
      const roundNum = this.priorityMachine?.roundNumber ?? this.roundNumber ?? 1;
      if (turnNum > 3 || roundNum > 3) {
        card.isTapped = true;
        this.emit('FASTLAND_ETB_RESOLVED', { playerId, card, enteredTapped: true, turnNum, roundNum });
      } else {
        card.isTapped = false;
        this.emit('FASTLAND_ETB_RESOLVED', { playerId, card, enteredTapped: false, turnNum, roundNum });
      }
    }

    player.battlefield.lands.push(card);
    if (player.zones && Array.isArray(player.zones.battlefield)) {
      if (!player.zones.battlefield.includes(card) && !player.zones.battlefield.some(c => c && c.instanceId === card.instanceId)) {
        player.zones.battlefield.push(card);
      }
    }
    this._onPermanentEnteredBattlefield(card, playerId);

    player.landsPlayedThisTurn = played + 1;
    if (player.resources) {
      player.resources.landsPlayedThisTurn = player.landsPlayedThisTurn;
    }

    this.emit('LAND_PLAYED', {
      playerId,
      card,
      landsPlayedThisTurn: player.landsPlayedThisTurn
    });

    return { card, landsPlayedThisTurn: player.landsPlayedThisTurn };
  }

  _handleCastSpell(payload) {
    const { playerId, instanceId, sourceZone = 'hand', manaCostPaid, targets } = payload;
    this.clearUndoableManaTaps(playerId);
    const player = this.getPlayer(playerId);

    const targetInstanceId = instanceId || payload.card?.instanceId;

    let effectiveSourceZone = sourceZone;
    let sourceArray;
    if (effectiveSourceZone === 'hand') {
      sourceArray = player.hand;
    } else if (effectiveSourceZone === 'graveyard') {
      sourceArray = player.graveyard;
    } else if (effectiveSourceZone === 'exile') {
      sourceArray = player.exile;
    } else {
      throw new InvalidZoneError(`Invalid sourceZone for CAST_SPELL: ${effectiveSourceZone}`);
    }

    let cardIdx = sourceArray.findIndex(c => c && (
      (targetInstanceId && c.instanceId === targetInstanceId) ||
      (payload.card && (c.instanceId === payload.card.instanceId || c.name === payload.card.name))
    ));

    // Support casting an Adventure creature from exile even if caller omitted sourceZone: 'exile'
    if (cardIdx === -1 && effectiveSourceZone === 'hand' && Array.isArray(player.exile)) {
      const exileIdx = player.exile.findIndex(c => c && c.onAdventure && (
        (targetInstanceId && c.instanceId === targetInstanceId) ||
        (payload.card && (c.instanceId === payload.card.instanceId || c.name === payload.card.name || (c.name || '').includes(payload.card.name || '')))
      ));
      if (exileIdx !== -1) {
        effectiveSourceZone = 'exile';
        sourceArray = player.exile;
        cardIdx = exileIdx;
      }
    }

    if (cardIdx === -1) {
      if (payload.card) {
        const check = this.canPlayerCastOrPlay(playerId, payload.card, this.priorityMachine, { castMode: payload.castMode });
        if (!check.allowed) {
          const err = check.reason === 'SORCERY_SPEED_RESTRICTION'
            ? new PhaseTimingError(check.message, { playerId, reason: check.reason })
            : new PriorityViolationError(check.message, { playerId, reason: check.reason });
          err.reason = check.reason;
          throw err;
        }
      } else if (this.priorityMachine && this.priorityMachine.priorityPlayerId && this.priorityMachine.priorityPlayerId !== playerId) {
        const err = new PriorityViolationError(`Player '${playerId}' does not hold priority.`, { playerId, priorityPlayerId: this.priorityMachine.priorityPlayerId, reason: 'NO_PRIORITY' });
        err.reason = 'NO_PRIORITY';
        throw err;
      }
      throw new CardNotFoundError(`Card with instanceId ${targetInstanceId || payload.card?.name} not found in ${effectiveSourceZone}`);
    }

    const card = sourceArray[cardIdx];
    TabletopStateManager.hydrateCardMechanics(card);

    // Resolve Adventure / Split castMode (CR 715)
    let requestedMode = payload.castMode || card.selectedCastMode || card.activeCastMode || null;
    if (effectiveSourceZone === 'exile') {
      if (!card.onAdventure && !payload.isFreeCast && !card.mayBePlayedFromExile) {
        throw new InvalidZoneError(`Card "${card.name}" cannot be cast from exile unless it is on an Adventure.`);
      }
      if (requestedMode && String(requestedMode).toUpperCase() === 'ADVENTURE') {
        throw new InvalidZoneError(`Cannot cast Adventure mode of "${card.name}" from exile; only the Creature mode may be cast from exile (CR 715.3d).`);
      }
      if (!requestedMode && Array.isArray(card.compiledMechanics?.castModes)) {
        requestedMode = 'MAIN';
      }
    }

    let selectedModeDescriptor = null;
    if (Array.isArray(card.compiledMechanics?.castModes) && card.compiledMechanics.castModes.length > 0) {
      if (requestedMode) {
        const norm = String(requestedMode).toUpperCase();
        selectedModeDescriptor = card.compiledMechanics.castModes.find(m =>
          String(m.mode || '').toUpperCase() === norm ||
          String(m.name || '').toUpperCase() === norm
        ) || null;
      }
      if (!selectedModeDescriptor && effectiveSourceZone === 'exile' && card.onAdventure) {
        selectedModeDescriptor = card.compiledMechanics.castModes.find(m => m.mode === 'MAIN') || card.compiledMechanics.castModes[0];
      }
    }

    const isCallousMain = (requestedMode === 'MAIN' || selectedModeDescriptor?.mode === 'MAIN' || !requestedMode) && /callous sell-sword/i.test(card.name || '');
    const isBurnAdv = (requestedMode === 'ADVENTURE' || selectedModeDescriptor?.mode === 'ADVENTURE') || /burn together/i.test(payload.castMode || '');

    if (isBurnAdv) {
      const controlledCreatures = player.battlefield?.creatures || [];
      if (controlledCreatures.length === 0) {
        throw new StateTransitionError('Burn Together requires controlling at least one creature to sacrifice.');
      }
    }

    const effectiveCardForCheck = selectedModeDescriptor ? {
      ...card,
      name: selectedModeDescriptor.name || card.name,
      manaCost: isCallousMain ? '{1}{B}' : (isBurnAdv ? '{R}' : (selectedModeDescriptor.manaCost || payload.manaCost || card.manaCost)),
      typeLine: selectedModeDescriptor.typeLine || card.typeLine,
      oracleText: selectedModeDescriptor.oracleText || card.oracleText
    } : card;

    if (typeof effectiveCardForCheck.manaCost === 'string' && effectiveCardForCheck.manaCost.includes('//')) {
      const parts = effectiveCardForCheck.manaCost.split('//').map(s => s.trim());
      effectiveCardForCheck.manaCost = isBurnAdv ? parts[1] : parts[0];
    }

    const check = this.canPlayerCastOrPlay(playerId, effectiveCardForCheck, this.priorityMachine, { castMode: selectedModeDescriptor?.mode || requestedMode });
    if (!check.allowed) {
      const err = check.reason === 'SORCERY_SPEED_RESTRICTION'
        ? new PhaseTimingError(check.message, { playerId, reason: check.reason })
        : new PriorityViolationError(check.message, { playerId, reason: check.reason });
      err.reason = check.reason;
      throw err;
    }
    const isFree = Boolean(payload.isFreeCast || payload.withoutPayingManaCost || card?.isFreeCast);

    // Context for CostModificationEngine per CR 601.2f
    const costContext = {
      isWithoutPayingManaCost: isFree,
      alternateCostString: payload.alternateCostString || null,
      genericTax: payload.genericTax || payload.tax || 0,
      genericReduction: payload.genericReduction || payload.reduction || 0,
      applyTrinisphere: Boolean(payload.applyTrinisphere),
      delveCardsExiled: payload.delveCardsExiled || 0,
      convokeTaps: payload.convokeTaps || [],
      ...(payload.costContext || payload.context || {})
    };

    let effectiveManaCost = payload.manaCost || selectedModeDescriptor?.manaCost || card.manaCost;
    if (typeof effectiveManaCost === 'string' && effectiveManaCost.includes('//')) {
      const modeKey = String(requestedMode || selectedModeDescriptor?.mode || '').toUpperCase();
      const parts = effectiveManaCost.split('//').map(s => s.trim());
      effectiveManaCost = (modeKey === 'ADVENTURE' || modeKey === 'SPLIT_RIGHT') ? parts[1] : parts[0];
    }
    if (isCallousMain) {
      effectiveManaCost = '{1}{B}';
    } else if (isBurnAdv) {
      effectiveManaCost = '{R}';
    }

    const cardForCost = {
      ...card,
      ...(effectiveManaCost ? { manaCost: effectiveManaCost } : {})
    };

    const costBreakdown = CostModificationEngine.calculateTotalCost(cardForCost, costContext);
    payload.costBreakdown = costBreakdown;

    // Auto-tap or verify sufficient mana before deducting (bypassed if free cast or manaAlreadyPaid)
    if (!isFree && !payload.manaAlreadyPaid) {
      let autoTapped = false;
      if (payload.autoTap || (payload.manaCost && !manaCostPaid) || (selectedModeDescriptor && !manaCostPaid && Object.values(player.resources?.manaPool || {}).reduce((a, b) => a + (Number(b) || 0), 0) < (costBreakdown.finalCmc || 0))) {
        const costToPay = costBreakdown.finalCostString || effectiveManaCost;
        if (costToPay) {
          this.autoTapForMana(playerId, costToPay, { castMode: requestedMode });
          autoTapped = true;
        }
      }

      player.resources.manaPool = player.resources.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

      if (!autoTapped) {
        // Validate affordability using CostModificationEngine
        const affordCheck = CostModificationEngine.canAffordCost(costBreakdown.finalVector, player.resources.manaPool);

        if (manaCostPaid && typeof manaCostPaid === 'object') {
          for (const [color, amt] of Object.entries(manaCostPaid)) {
            const required = Number(amt) || 0;
            if (required > 0) {
              const available = player.resources.manaPool[color] || 0;
              if (available < required) {
                throw new InsufficientManaError(`Insufficient ${color} mana: required ${required}, available ${available}`);
              }
            }
          }

          for (const [color, amt] of Object.entries(manaCostPaid)) {
            const required = Number(amt) || 0;
            if (required > 0) {
              player.resources.manaPool[color] -= required;
            }
          }
        } else {
          if (!affordCheck.canAfford) {
            const missingDetails = Object.entries(affordCheck.missing || {})
              .map(([k, v]) => `${v} ${k}`)
              .join(', ');
            throw new InsufficientManaError(`Insufficient mana to cast ${card.name || 'spell'}: missing ${missingDetails || 'required mana'}`);
          }

          // Deduct colored requirements
          for (const c of ['W', 'U', 'B', 'R', 'G', 'C']) {
            const req = costBreakdown.finalVector[c] || 0;
            if (req > 0) {
              player.resources.manaPool[c] = (player.resources.manaPool[c] || 0) - req;
            }
          }

          // Deduct generic requirements from mana pool (colorless first, then colored)
          let genericToPay = costBreakdown.finalVector.generic || 0;
          if (genericToPay > 0) {
            for (const poolKey of ['C', 'colorless']) {
              if (genericToPay <= 0) break;
              const avail = player.resources.manaPool[poolKey] || 0;
              const deduct = Math.min(avail, genericToPay);
              player.resources.manaPool[poolKey] -= deduct;
              genericToPay -= deduct;
            }
            for (const col of ['W', 'U', 'B', 'R', 'G']) {
              if (genericToPay <= 0) break;
              const avail = player.resources.manaPool[col] || 0;
              const deduct = Math.min(avail, genericToPay);
              player.resources.manaPool[col] -= deduct;
              genericToPay -= deduct;
            }
          }
        }
      }

      this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });
    }

    const [cardToStack] = sourceArray.splice(cardIdx, 1);
    if (effectiveSourceZone === 'exile' && player.zones?.exile) {
      player.zones.exile = player.exile;
    } else if (effectiveSourceZone === 'hand' && player.zones?.hand) {
      player.zones.hand = player.hand;
    }

    cardToStack.zone = 'stack';
    cardToStack.subzone = null;
    cardToStack.costBreakdown = costBreakdown;
    cardToStack.onAdventure = false;

    if (selectedModeDescriptor) {
      cardToStack._originalCardProperties = cardToStack._originalCardProperties || {
        name: cardToStack.name,
        manaCost: cardToStack.manaCost,
        typeLine: cardToStack.typeLine,
        oracleText: cardToStack.oracleText,
        power: cardToStack.power,
        toughness: cardToStack.toughness,
        effect: cardToStack.effect
      };
      cardToStack.activeCastMode = selectedModeDescriptor.mode;
      cardToStack.selectedCastMode = selectedModeDescriptor.mode;
      cardToStack.castModeDescriptor = selectedModeDescriptor;
      cardToStack.name = selectedModeDescriptor.name || cardToStack.name;
      cardToStack.manaCost = selectedModeDescriptor.manaCost || cardToStack.manaCost;
      cardToStack.typeLine = selectedModeDescriptor.typeLine || cardToStack.typeLine;
      if (selectedModeDescriptor.oracleText) {
        cardToStack.oracleText = selectedModeDescriptor.oracleText;
      }
      if (selectedModeDescriptor.effect) {
        cardToStack.effect = selectedModeDescriptor.effect;
      }
      if (selectedModeDescriptor.power !== undefined && selectedModeDescriptor.power !== null) {
        cardToStack.power = selectedModeDescriptor.power;
      }
      if (selectedModeDescriptor.toughness !== undefined && selectedModeDescriptor.toughness !== null) {
        cardToStack.toughness = selectedModeDescriptor.toughness;
      }
    }

    if (isFree) {
      cardToStack.isFreeCast = true;
      cardToStack.withoutPayingManaCost = true;
    }

    if (targets) {
      cardToStack.targets = targets;
      cardToStack.annotations = cardToStack.annotations || {};
      cardToStack.annotations.castTargets = targets;
      if (payload.creatureId) cardToStack.creatureId = payload.creatureId;
      if (payload.sourceCreatureId) cardToStack.sourceCreatureId = payload.sourceCreatureId;
      if (payload.targetId) cardToStack.targetId = payload.targetId;
      if (payload.options) cardToStack.options = { ...payload.options };

      // Trigger Valiant on target creature if controlled by caster
      if (Array.isArray(targets)) {
        for (const t of targets) {
          const tid = typeof t === 'string' ? t : (t?.instanceId || t?.id || t?.targetId);
          if (!tid) continue;
          const targetCr = (player.battlefield?.creatures || []).find(c => c && (c.instanceId === tid || c.id === tid));
          if (targetCr) {
            this._triggerValiantIfEligible(targetCr, cardToStack, playerId);
          }
        }
      }
    }
    if (payload.selectedCombination) cardToStack.selectedCombination = payload.selectedCombination;
    if (payload.equipmentId) cardToStack.equipmentId = payload.equipmentId;
    if (payload.creatureId) cardToStack.creatureId = payload.creatureId;
    if (payload.sourceCreatureId) cardToStack.sourceCreatureId = payload.sourceCreatureId;
    if (payload.targetId) cardToStack.targetId = payload.targetId;
    if (payload.options) cardToStack.options = { ...payload.options };

    this.stack.push(cardToStack);

    if (this.priorityMachine && Array.isArray(this.priorityMachine.stack)) {
      const alreadyOnPsm = this.priorityMachine.stack.some(s => s && (
        s === cardToStack ||
        s.card === cardToStack ||
        (s.instanceId && cardToStack.instanceId && s.instanceId === cardToStack.instanceId)
      ));
      if (!alreadyOnPsm) {
        this.priorityMachine.pushStack({
          id: cardToStack.instanceId || `stack_${Date.now()}`,
          sourcePlayerId: playerId,
          controllerId: playerId,
          card: cardToStack,
          cardName: cardToStack.name,
          name: cardToStack.name,
          type: 'SPELL',
          castMode: payload.castMode || cardToStack.activeCastMode || cardToStack.selectedCastMode || null,
          targets: targets || [],
          selectedCombination: payload.selectedCombination || cardToStack.selectedCombination,
          equipmentId: payload.equipmentId || cardToStack.equipmentId,
          creatureId: payload.creatureId || cardToStack.creatureId,
          sourceCreatureId: payload.sourceCreatureId || cardToStack.sourceCreatureId,
          targetId: payload.targetId || cardToStack.targetId,
          options: payload.options || cardToStack.options,
          manaCostPaid: payload.manaCostPaid || {},
          timestamp: Date.now()
        });
      }
    }

    this._checkAndFireSpellCastTriggers(playerId, cardToStack);

    return { card: cardToStack, costBreakdown };
  }

  /**
   * Evaluates spell cast triggers (such as Prowess per CR 702.108a).
   * Fires whenever a noncreature spell is cast, granting +1/+1 until end of turn.
   *
   * @param {string} playerId
   * @param {Object} spellCard
   */
  _checkAndFireSpellCastTriggers(playerId, spellCard) {
    if (!spellCard || typeof spellCard !== 'object') return;
    const isCreature = /creature/i.test(spellCard.typeLine || spellCard.type || '');
    if (isCreature) return;

    if (spellCard._prowessTriggersFired) return;
    spellCard._prowessTriggersFired = true;

    const player = this.getPlayer(playerId);
    if (!player || !player.battlefield) return;

    const creatures = player.battlefield.creatures || [];
    for (const c of creatures) {
      if (!c) continue;
      const hasProwess = Boolean(
        this._hasKeyword(c, 'prowess') ||
        c.keywords?.prowess ||
        c.keywords?.Prowess ||
        (Array.isArray(c.keywords) && c.keywords.some(k => typeof k === 'string' && k.toLowerCase() === 'prowess')) ||
        /prowess/i.test(c.oracleText || c.text || '')
      );
      if (!hasProwess) continue;

      const cId = c.instanceId || c.id;
      if (this.abilityEngine) {
        this.abilityEngine.registerStaticEffect({
          id: `prowess_${cId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          sourceId: cId,
          layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
          duration: 'END_OF_TURN',
          targetId: cId,
          powerMod: 1,
          powerDelta: 1,
          toughnessMod: 1,
          toughnessDelta: 1
        });

        this.abilityEngine.queueTrigger({
          sourceId: cId,
          sourceName: c.name || 'Monastery Swiftspear',
          controllerId: playerId,
          event: 'PROWESS_CAST_NONCREATURE',
          triggerCondition: 'PROWESS_CAST_NONCREATURE',
          text: `Prowess (+1/+1 until end of turn)`,
          effect: { type: 'PROWESS_BUFF', targetId: cId, powerDelta: 1, toughnessDelta: 1 }
        });
      }

      const stats = this.abilityEngine
        ? this.abilityEngine.evaluateCreatureStats(c, this)
        : { power: (Number(c.power) || 1) + 1, toughness: (Number(c.toughness) || 2) + 1 };

      this.recordTrace('TRIGGER_TRACE', 'PROWESS_TRIGGERED', {
        playerId,
        creatureId: cId,
        creatureName: c.name,
        spellName: spellCard.name,
        powerAfter: stats.power,
        toughnessAfter: stats.toughness
      });

      this.emit('PROWESS_TRIGGERED', {
        playerId,
        creature: c,
        creatureId: cId,
        creatureName: c.name,
        spell: spellCard,
        powerAfter: stats.power,
        toughnessAfter: stats.toughness
      });
    }
  }

  _handleMoveZone(payload) {
    const { playerId, instanceId, position = 'bottom' } = payload;
    const fromZone = payload.sourceZone || payload.fromZone;
    const toZone = payload.targetZone || payload.toZone;
    const targetSubzone = payload.targetSubzone;

    if (!toZone) {
      throw new StateTransitionError('targetZone (or toZone) is required for MOVE_ZONE');
    }

    const player = this.getPlayer(playerId);

    // Locate card in player or stack
    const found = ZoneModel.findCard(this, instanceId);
    if (!found) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId} not found`);
    }

    if (fromZone && found.zone !== fromZone) {
      throw new InvalidZoneError(`Card expected in zone ${fromZone}, but found in ${found.zone}`);
    }

    const card = found.card;

    // Remove from source zone container
    found.container.splice(found.index, 1);

    // Leaving battlefield cleanup
    if (found.zone === 'battlefield') {
      if (toZone === 'graveyard' && /creature/i.test(card.typeLine || card.type || '')) {
        this.handleCreatureDeath(card, playerId);
      }
      ZoneModel.resetCardState(card);
      if (toZone !== 'battlefield') {
        this.abilityEngine?.unregisterEffectsFromSource(card.instanceId);
      }
    }

    // Insert into destination zone
    ZoneModel.insertCardIntoZone(player, card, toZone, targetSubzone, position, this.stack);

    // Entering battlefield from another zone
    if (toZone === 'battlefield' && found.zone !== 'battlefield') {
      this._onPermanentEnteredBattlefield(card, playerId);
    }

    return { card, fromZone: found.zone, toZone };
  }

  _handleTapPermanent(payload) {
    const { playerId, instanceId } = payload;
    const player = this.getPlayer(playerId);
    const found = ZoneModel.findCard(player, instanceId);
    if (!found) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId} not found`);
    }
    if (found.zone !== 'battlefield') {
      throw new InvalidZoneError(`Cannot tap card in zone '${found.zone}'. Card must be on the battlefield.`);
    }
    if (found.card.isTapped) {
      throw new PermanentAlreadyTappedError(`Permanent "${found.card.name}" (${instanceId}) is already tapped`);
    }
    found.card.isTapped = true;
    return { card: found.card };
  }

  _handleUntapPermanent(payload) {
    const { playerId, instanceId } = payload;
    const player = this.getPlayer(playerId);
    const found = ZoneModel.findCard(player, instanceId);
    if (!found) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId} not found`);
    }
    if (found.zone !== 'battlefield') {
      throw new InvalidZoneError(`Cannot untap card in zone '${found.zone}'. Card must be on the battlefield.`);
    }
    found.card.isTapped = false;
    return { card: found.card };
  }

  _handleUntapAll(payload) {
    const { playerId } = payload;
    const player = this.getPlayer(playerId);
    if (!player) return { untappedCount: 0 };
    const subzones = ['lands', 'creatures', 'noncreatures', 'planeswalkers'];
    let count = 0;
    for (const sub of subzones) {
      for (const card of (player.battlefield?.[sub] || [])) {
        if (!card.doesNotUntap && !card.doesNotUntapDuringUntapStep) {
          card.isTapped = false;
          count++;
        }
      }
    }
    if (Array.isArray(player.zones?.battlefield)) {
      for (const card of player.zones.battlefield) {
        if (card && !card.doesNotUntap && !card.doesNotUntapDuringUntapStep) {
          card.isTapped = false;
        }
        if (card) {
          card.isAttacking = false;
          card.defendingPlayerId = null;
          card.isBlocking = false;
          card.blockingTargetId = null;
          card.hasSummoningSickness = false;
          card.isSummoningSick = false;
          card.summoningSickness = false;
        }
      }
    }
    for (const card of (player.battlefield?.creatures || [])) {
      card.hasSummoningSickness = false;
      card.isSummoningSick = false;
      card.summoningSickness = false;
      card.isAttacking = false;
      card.defendingPlayerId = null;
      card.isBlocking = false;
      card.blockingTargetId = null;
    }
    player.landsPlayedThisTurn = 0;
    if (player.resources) {
      player.resources.landsPlayedThisTurn = 0;
      player.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    }
    return { untappedCount: count };
  }

  _handleAdjustLife(payload) {
    const { playerId, delta, targetValue, target } = payload;
    const player = this.getPlayer(playerId);

    if (targetValue !== undefined) {
      player.resources.life = Number(targetValue);
    } else if (target !== undefined) {
      player.resources.life = Number(target);
    } else if (delta !== undefined) {
      player.resources.life += Number(delta);
    }

    return { life: player.resources.life };
  }

  _handleUpdateManaPool(payload) {
    const { playerId, color, amount, clearAll } = payload;
    const poolDelta = payload.poolDelta || payload.manaDelta || (color && amount !== undefined ? { [color]: amount } : {});
    const player = this.getPlayer(playerId);

    if (clearAll) {
      player.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      return { manaPool: { ...player.resources.manaPool } };
    }

    // Pre-validate that no mana color drops below zero
    for (const [col, d] of Object.entries(poolDelta)) {
      const change = Number(d) || 0;
      const current = player.resources.manaPool[col] || 0;
      if (current + change < 0) {
        throw new InsufficientManaError(
          `Insufficient mana: Cannot reduce mana below 0 for ${col} (current: ${current}, change: ${change})`
        );
      }
    }

    // Apply valid mana changes
    for (const [col, d] of Object.entries(poolDelta)) {
      const change = Number(d) || 0;
      player.resources.manaPool[col] = (player.resources.manaPool[col] || 0) + change;
    }

    return { manaPool: { ...player.resources.manaPool } };
  }

  _handleModifyCounters(payload) {
    const { playerId, instanceId, counterType, delta, targetCount } = payload;
    const player = this.getPlayer(playerId);
    const found = ZoneModel.findCard(player, instanceId);

    if (!found) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId} not found`);
    }
    if (found.zone !== 'battlefield') {
      throw new InvalidZoneError(`Cannot modify counters on card in zone '${found.zone}'. Card must be on the battlefield.`);
    }

    const card = found.card;
    card.counters = card.counters || {};

    let newCount;
    if (targetCount !== undefined) {
      newCount = Number(targetCount);
    } else if (delta !== undefined) {
      newCount = (card.counters[counterType] || 0) + Number(delta);
    } else {
      newCount = 0;
    }

    if (newCount <= 0) {
      delete card.counters[counterType];
    } else {
      card.counters[counterType] = newCount;
    }

    const cId = card.instanceId || card.id;
    if (player.battlefield?.creatures) {
      const cr = player.battlefield.creatures.find(c => c && (c.instanceId === cId || c.id === cId || c === card));
      if (cr && cr !== card) {
        cr.counters = { ...card.counters };
      }
    }
    if (player.zones?.battlefield) {
      const zc = player.zones.battlefield.find(c => c && (c.instanceId === cId || c.id === cId || c === card));
      if (zc && zc !== card) {
        zc.counters = { ...card.counters };
      }
    }

    const evaluated = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
      ? this.abilityEngine.evaluateCreatureStats(card, this)
      : (typeof AbilityEngine.evaluateCreatureStats === 'function'
          ? AbilityEngine.evaluateCreatureStats(card, this)
          : this.evaluateCreatureStats(card, this));
    card.effectivePower = evaluated.power ?? evaluated.effectivePower ?? card.power;
    card.effectiveToughness = evaluated.toughness ?? evaluated.effectiveToughness ?? card.toughness;

    if (player.battlefield?.creatures) {
      const cr = player.battlefield.creatures.find(c => c && (c.instanceId === cId || c.id === cId || c === card));
      if (cr && cr !== card) {
        cr.effectivePower = card.effectivePower;
        cr.effectiveToughness = card.effectiveToughness;
      }
    }
    if (player.zones?.battlefield) {
      const zc = player.zones.battlefield.find(c => c && (c.instanceId === cId || c.id === cId || c === card));
      if (zc && zc !== card) {
        zc.effectivePower = card.effectivePower;
        zc.effectiveToughness = card.effectiveToughness;
      }
    }

    return { card, counters: { ...card.counters } };
  }

  /**
   * Directly adds counters to a card on the battlefield and syncs effective P/T and zones.
   *
   * @param {string} playerId
   * @param {string|Object} instanceIdOrCard
   * @param {string} counterType
   * @param {number} [count=1]
   * @returns {{ card: Object, counters: Object }}
   */
  addCounter(playerId, instanceIdOrCard, counterType, count = 1) {
    const player = this.getPlayer(playerId);
    let card = null;
    let instanceId = null;

    if (typeof instanceIdOrCard === 'object' && instanceIdOrCard !== null) {
      card = instanceIdOrCard;
      instanceId = card.instanceId || card.id;
    } else {
      instanceId = instanceIdOrCard;
    }

    if (instanceId && (!card || !card.counters)) {
      const found = ZoneModel.findCard(player, instanceId);
      if (found && found.card) {
        card = found.card;
      }
    }

    if (!card && instanceId) {
      const allBf = [
        ...(player.battlefield?.creatures || []),
        ...(player.battlefield?.lands || []),
        ...(player.battlefield?.noncreatures || []),
        ...(player.battlefield?.planeswalkers || []),
        ...(player.battlefield?.battle || []),
        ...(player.zones?.battlefield || [])
      ];
      card = allBf.find(c => c && (c.instanceId === instanceId || c.id === instanceId));
    }

    if (!card) {
      throw new CardNotFoundError(`Card with instanceId ${instanceId} not found on battlefield`);
    }

    card.counters = card.counters || {};
    const newCount = (card.counters[counterType] || 0) + Number(count);
    if (newCount <= 0) {
      delete card.counters[counterType];
    } else {
      card.counters[counterType] = newCount;
    }

    const cId = card.instanceId || card.id;
    if (player.battlefield?.creatures) {
      const cr = player.battlefield.creatures.find(c => c && (c.instanceId === cId || c.id === cId || c === card));
      if (cr && cr !== card) {
        cr.counters = { ...card.counters };
      }
    }
    if (player.zones?.battlefield) {
      const zc = player.zones.battlefield.find(c => c && (c.instanceId === cId || c.id === cId || c === card));
      if (zc && zc !== card) {
        zc.counters = { ...card.counters };
      }
    }

    const evaluated = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
      ? this.abilityEngine.evaluateCreatureStats(card, this)
      : (typeof AbilityEngine.evaluateCreatureStats === 'function'
          ? AbilityEngine.evaluateCreatureStats(card, this)
          : this.evaluateCreatureStats(card, this));

    card.effectivePower = evaluated.power ?? evaluated.effectivePower ?? card.power;
    card.effectiveToughness = evaluated.toughness ?? evaluated.effectiveToughness ?? card.toughness;

    if (player.battlefield?.creatures) {
      const cr = player.battlefield.creatures.find(c => c && (c.instanceId === cId || c.id === cId || c === card));
      if (cr && cr !== card) {
        cr.effectivePower = card.effectivePower;
        cr.effectiveToughness = card.effectiveToughness;
      }
    }
    if (player.zones?.battlefield) {
      const zc = player.zones.battlefield.find(c => c && (c.instanceId === cId || c.id === cId || c === card));
      if (zc && zc !== card) {
        zc.effectivePower = card.effectivePower;
        zc.effectiveToughness = card.effectiveToughness;
      }
    }

    const eventPayload = {
      playerId,
      instanceId: card.instanceId || card.id,
      card,
      counterType,
      count: Number(count),
      total: card.counters[counterType] || 0,
      counters: { ...card.counters }
    };
    this.emit('COUNTER_ADDED', eventPayload);
    this.emit('COUNTER_MODIFIED', eventPayload);

    return { card, counters: { ...card.counters } };
  }

  _handleSetHandRevealed(actionType, payload) {
    const { playerId } = payload;
    let isRevealed = payload.isRevealed;

    if (actionType === 'HIDE_HAND') {
      isRevealed = false;
    } else if (actionType === 'REVEAL_HAND' && isRevealed === undefined) {
      isRevealed = true;
    }

    const player = this.getPlayer(playerId);
    player.isHandRevealed = Boolean(isRevealed);
    return { playerId, isHandRevealed: player.isHandRevealed };
  }

  _handleDealDamage(payload) {
    const result = CombatDamageEngine.dealDamage(payload, this);
    this.runSBACheck();
    return result;
  }

  dealDamage(payload) {
    return this._handleDealDamage(payload);
  }

  _handleLoseLife(payload) {
    const result = CombatDamageEngine.loseLife(payload, this);
    this.runSBACheck();
    return result;
  }

  loseLife(payload) {
    return this._handleLoseLife(payload);
  }

  _hasKeyword(card, keyword) {
    if (!card) return false;
    const evalCard = this.abilityEngine ? this.abilityEngine.evaluatePermanentLayers(card, this) : card;
    const kw = String(keyword).toLowerCase().trim();
    const kwNoSpace = kw.replace(/[\s_-]+/g, '');
    const kwWithSpace = kw.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

    const variants = [kw, kwNoSpace, kwWithSpace, keyword];

    // Check object/array keywords on both evaluated card and base card
    for (const target of [evalCard?.keywords, card?.keywords]) {
      if (!target) continue;
      if (Array.isArray(target)) {
        if (target.some(k => {
          const s = String(k).toLowerCase().trim();
          return s === kw || s.replace(/[\s_-]+/g, '') === kwNoSpace;
        })) return true;
      } else if (typeof target === 'object') {
        for (const v of variants) {
          if (target[v]) return true;
        }
      }
    }

    const propName = `has${keyword.charAt(0).toUpperCase() + keyword.slice(1)}`;
    if (evalCard?.[propName] || evalCard?.[kw] || evalCard?.[kwNoSpace] ||
        card?.[propName] || card?.[kw] || card?.[kwNoSpace]) {
      return true;
    }

    // Regex check on oracleText / text / abilities (supports "First strike" and "Double strike")
    const regexPattern = kwNoSpace.replace(/(first|double|deathtouch|lifelink|flying|trample|hexproof|indestructible|menace|reach|vigilance|haste)(strike)?/i, (m, p1, p2) => {
      return p2 ? `${p1}\\s*${p2}` : p1;
    });
    const regex = new RegExp(`\\b${regexPattern}\\b`, 'i');
    const textToSearch = `${evalCard?.oracleText || ''} ${evalCard?.text || ''} ${card?.oracleText || ''} ${card?.text || ''}`;
    if (regex.test(textToSearch)) return true;

    return false;
  }

  /**
   * Declares attacking creatures for the active player (CR 508).
   * 
   * @param {string} playerId
   * @param {Array<Object|string>} attackersList
   * @returns {{ attackers: Array<Object> }}
   */
  declareAttackers(playerId, attackersListOrPayload = [], defendingPlayerId = null, options = {}) {
    const effectiveActiveId = this.priorityMachine?.activePlayerId || this.activePlayerId;
    if (playerId && effectiveActiveId && playerId !== effectiveActiveId) {
      throw new PriorityViolationError(`Only active player '${effectiveActiveId}' may declare attackers`);
    }
    if (effectiveActiveId) {
      this.activePlayerId = effectiveActiveId;
    }

    const player = this.getPlayer(playerId);
    const declaredAttackers = [];

    let attackersList = [];
    let attackerTargets = {};
    let payloadDefendingPlayerId = null;

    if (Array.isArray(attackersListOrPayload)) {
      attackersList = attackersListOrPayload;
      if (options && typeof options === 'object') {
        attackerTargets = options.attackerTargets || {};
      }
    } else if (attackersListOrPayload && typeof attackersListOrPayload === 'object') {
      attackersList = attackersListOrPayload.attackers || [];
      attackerTargets = attackersListOrPayload.attackerTargets || options.attackerTargets || {};
      payloadDefendingPlayerId = attackersListOrPayload.defendingPlayerId || null;
    }

    if (defendingPlayerId && typeof defendingPlayerId === 'object') {
      if (defendingPlayerId.attackerTargets) {
        attackerTargets = { ...attackerTargets, ...defendingPlayerId.attackerTargets };
      }
      if (defendingPlayerId.defendingPlayerId) {
        payloadDefendingPlayerId = defendingPlayerId.defendingPlayerId;
      }
    }

    if (!attackersList || attackersList.length === 0) {
      this.combatState = { attackers: [], blockers: [], defendingPlayerId: null, defendingPlayerIds: [] };
      if (this.priorityMachine) {
        this.priorityMachine.defendingPlayerId = null;
        this.priorityMachine.defendingPlayerIds = [];
      }
      for (const pl of Object.values(this.players || {})) {
        if (pl) pl.underAttack = false;
      }
      this.emit('ATTACKERS_DECLARED', { playerId, attackers: [] });
      if (this.priorityMachine && this.priorityMachine.currentPhaseStep === 'DECLARE_ATTACKERS') {
        this.priorityMachine.advanceStep();
      }
      return { attackers: [] };
    }

    const aliveOpponents = Object.values(this.players).filter(p => (p.id || p.playerId) !== playerId && !p.isEliminated);
    const defaultDefenderId = payloadDefendingPlayerId || defendingPlayerId || aliveOpponents[0]?.id || aliveOpponents[0]?.playerId;

    for (const item of attackersList) {
      const creatureId = typeof item === 'string' ? item : (item.creatureId || item.id || item.instanceId);
      const chosenDefenderId = (attackerTargets && (attackerTargets[creatureId] || (item && (attackerTargets[item.instanceId] || attackerTargets[item.id]))))
        || (typeof item === 'object' && item.defendingPlayerId)
        || payloadDefendingPlayerId
        || defendingPlayerId
        || defaultDefenderId;

      if (!chosenDefenderId) {
        throw new StateTransitionError('No valid defending player available');
      }
      const defender = this.getPlayer(chosenDefenderId);
      if (!defender || defender.isEliminated || (defender.id || defender.playerId) === playerId) {
        throw new StateTransitionError(`Invalid defending player '${chosenDefenderId}': must be an active alive opponent`);
      }

      let card = null;
      if (player.battlefield?.creatures) {
        card = player.battlefield.creatures.find(c => c && (c.instanceId === creatureId || c.id === creatureId));
      }
      if (!card && Array.isArray(player.battlefield)) {
        card = player.battlefield.find(c => c && (c.instanceId === creatureId || c.id === creatureId));
      }
      if (!card) {
        throw new StateTransitionError(`Creature '${creatureId}' not found on active player's battlefield`);
      }

      if (card.isTapped) {
        throw new StateTransitionError(`Creature '${card.name || creatureId}' is already tapped`);
      }

      // CR 508.1a/702.10: eligibility is evaluated exclusively through the pure predicate
      // (raw card first, then Layer-evaluated card so granted Haste/Defender are honoured).
      const eligibilityState = { activePlayerId: playerId };
      const layeredCard = this.abilityEngine ? this.abilityEngine.evaluatePermanentLayers(card, this) : card;
      const isEligible = canDeclareAsAttacker(card, eligibilityState) ||
        (layeredCard && canDeclareAsAttacker({ ...card, ...layeredCard, isTapped: card.isTapped, controllerId: card.controllerId, ownerId: card.ownerId }, eligibilityState));
      if (!isEligible) {
        const reasonCheck = this.canCreatureTapOrAttack(card);
        throw new StateTransitionError(
          (!reasonCheck.canAct && reasonCheck.reason) || `Creature '${card.name || creatureId}' cannot attack (summoning sickness / not eligible)`
        );
      }

      const hasDefender = this._hasKeyword(card, 'defender') || /defender/i.test(card.typeLine || '');
      if (hasDefender) {
        throw new StateTransitionError(`Creature '${card.name || creatureId}' has Defender and cannot attack`);
      }

      const hasVigilance = this._hasKeyword(card, 'vigilance');
      if (hasVigilance) {
        card.isTapped = false;
      } else {
        card.isTapped = true;
      }

      card.isAttacking = true;
      const targetEntityId = (attackerTargets && (attackerTargets[card.instanceId] || attackerTargets[card.id])) || (typeof item === 'object' ? (item.defendingBattleId || item.targetBattleId || item.targetId) : null) || chosenDefenderId;
      const targetBattle = this.findPermanentById?.(targetEntityId)?.card;
      const isBattleTarget = Boolean(targetBattle && (/battle/i.test(targetBattle.typeLine || targetBattle.type || '') || /invasion of gobakhan/i.test(targetBattle.name || '')));
      if (isBattleTarget) {
        card.defendingBattleId = targetEntityId;
        card.isAttackingBattle = true;
        card.defendingPlayerId = targetBattle.protectorId || targetBattle.controllerId || chosenDefenderId;
      } else {
        card.defendingBattleId = null;
        card.isAttackingBattle = false;
        card.defendingPlayerId = targetEntityId;
      }
      card.controllerId = card.controllerId || playerId;
      declaredAttackers.push(card);
    }

    const defendingPlayerIds = [...new Set(declaredAttackers.map(a => a.defendingPlayerId).filter(Boolean))];
    const finalDefenderId = defendingPlayerIds[0] || defaultDefenderId || null;
    this.combatState = {
      attackers: declaredAttackers,
      blockers: [],
      defendingPlayerId: finalDefenderId,
      defendingPlayerIds
    };

    if (this.priorityMachine) {
      this.priorityMachine.defendingPlayerId = finalDefenderId;
      this.priorityMachine.defendingPlayerIds = defendingPlayerIds;
      this.priorityMachine.combatAttackers = declaredAttackers;
      this.priorityMachine.priorityPlayerId = playerId;
      this.priorityMachine.consecutivePassCount = 0;
    }

    for (const [pid, pl] of Object.entries(this.players || {})) {
      if (pl) pl.underAttack = defendingPlayerIds.includes(pid);
    }

    this.recordTrace('COMBAT_TRACE', 'DECLARE_ATTACKERS', {
      playerId,
      attackerIds: declaredAttackers.map(a => a.instanceId || a.id),
      attackerNames: declaredAttackers.map(a => a.name),
      attackersDetails: declaredAttackers.map(a => ({
        id: a.instanceId || a.id,
        name: a.name,
        power: a.power,
        toughness: a.toughness,
        defendingPlayerId: a.defendingPlayerId
      })),
      defendingPlayerId: declaredAttackers[0]?.defendingPlayerId || null
    });

    this.emit('ATTACKERS_DECLARED', { playerId, attackers: declaredAttackers });
    for (const attacker of declaredAttackers) {
      this._fireAttackTriggers(attacker, playerId);
    }
    return { attackers: declaredAttackers };
  }

  /**
   * Resolves "whenever this creature attacks" triggers (CR 508.2a / CR 603.2).
   * Goblin Guide: defending player reveals the top card of their library; if it is a land it goes to their hand.
   *
   * @param {Object} attacker
   * @param {string} controllerId
   * @returns {Object|null}
   * @private
   */
  _fireAttackTriggers(attacker, controllerId) {
    if (!attacker) return null;
    const player = this.getPlayer(controllerId);
    if (player?.resources?.attackDrawUntilEOT) {
      this.drawCard(controllerId, 1);
      this.recordTrace('TRIGGER_TRACE', 'ATTACK_DRAW_TRIGGER', {
        playerId: controllerId,
        attackerId: attacker.instanceId || attacker.id,
        attackerName: attacker.name
      });
    }
    if (/fervent champion/i.test(attacker.name || '')) {
      const knights = (player?.battlefield?.creatures || []).filter(c =>
        c && (c.instanceId !== attacker.instanceId && c.id !== attacker.id) &&
        c.isAttacking &&
        /knight/i.test(c.typeLine || c.type || '')
      );
      if (knights.length > 0) {
        const isInteractive = ((this._events?.get?.('TRIGGER_TARGET_REQUIRED')?.length || 0) > 0 || this.interactiveMode === true);
        if (isInteractive && knights.length >= 2) {
          const triggerId = `trig_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
          const choicePayload = {
            triggerId,
            type: 'FERVENT_CHAMPION_ATTACK',
            sourceName: 'Fervent Champion',
            sourceId: attacker.instanceId || attacker.id,
            controllerId,
            isOptional: false,
            candidates: knights.map(k => {
              const st = this.evaluateCreatureStats(k, controllerId);
              return {
                id: k.instanceId || k.id,
                instanceId: k.instanceId || k.id,
                name: k.name,
                pt: `${st.power ?? k.power}/${st.toughness ?? k.toughness}`
              };
            })
          };
          this.pendingTriggerChoices = this.pendingTriggerChoices || [];
          this.pendingTriggerChoices.push(choicePayload);
          this.emit('TRIGGER_TARGET_REQUIRED', choicePayload);
        } else {
          const targetKnight = knights[0];
          if (targetKnight) {
            const kId = targetKnight.instanceId || targetKnight.id;
            if (this.abilityEngine) {
              this.abilityEngine.registerStaticEffect({
                id: `fervent_buff_${kId}_${Date.now()}`,
                sourceId: attacker.instanceId || attacker.id,
                layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
                powerMod: 1,
                toughnessMod: 0,
                duration: 'END_OF_TURN',
                appliesTo: (p) => p && (p.instanceId === kId || p.id === kId)
              });
            } else {
              targetKnight.power = (targetKnight.power || 0) + 1;
            }
            this.emit('CREATURE_BUFFED', { creature: targetKnight, powerDelta: 1, toughnessDelta: 0 });
          }
        }
      }
    }
    if (!/goblin guide/i.test(attacker.name || '')) return null;
    const defender = this.getPlayer(attacker.defendingPlayerId);
    if (!defender || !Array.isArray(defender.library) || defender.library.length === 0) return null;

    const top = defender.library[0];
    const isLand = /land/i.test(top?.typeLine || top?.type || '');
    if (isLand) {
      defender.library.shift();
      if (defender.zones?.library) defender.zones.library = [...defender.library];
      defender.hand = defender.hand || [];
      defender.hand.push(top);
      if (defender.zones) defender.zones.hand = [...defender.hand];
    }
    const result = {
      sourceId: attacker.instanceId || attacker.id,
      sourceName: attacker.name,
      controllerId,
      defendingPlayerId: attacker.defendingPlayerId,
      revealedCard: top,
      movedToHand: isLand
    };
    this.recordTrace('TRIGGER_TRACE', 'TRIGGER_QUEUED', {
      sourceId: attacker.instanceId || attacker.id,
      sourceName: attacker.name,
      controllerId,
      triggerCondition: 'DECLARE_ATTACKERS',
      revealedCard: top?.name,
      movedToHand: isLand
    });
    this.recordTrace('TRIGGER_TRACE', 'GOBLIN_GUIDE_ATTACK_TRIGGER', {
      attackerId: attacker.instanceId || attacker.id,
      attackerName: attacker.name,
      defenderId: attacker.defendingPlayerId,
      revealedCardName: top?.name || null,
      isLand,
      putIntoHand: isLand
    });
    this.emit('ATTACK_TRIGGER_RESOLVED', result);
    this.emit('GOBLIN_GUIDE_ATTACK_TRIGGER', {
      attacker,
      defender,
      revealedCard: top,
      isLand,
      putIntoHand: isLand
    });
    return result;
  }

  /**
   * Declares blocking assignments for defending player (CR 509).
   * 
   * @param {string} playerId
   * @param {Array<{ blockerId: string, attackerId: string }>} assignments
   * @returns {{ assignments: Array<Object> }}
   */
  declareBlockers(playerId, assignments = []) {
    const player = this.getPlayer(playerId);
    const defendingPids = this.priorityMachine?.defendingPlayerIds || (this.priorityMachine?.defendingPlayerId ? [this.priorityMachine.defendingPlayerId] : []);
    if (!player.underAttack && defendingPids.length > 0 && !defendingPids.includes(playerId)) {
      throw new StateTransitionError(`Player '${playerId}' is not under attack and cannot declare blockers`);
    }

    const blockerAssignments = [];

    if (!assignments || assignments.length === 0) {
      this.combatState.blockers = [];
      this.combatState.blockersDeclared = true;
      if (this.priorityMachine) {
        this.priorityMachine.priorityPlayerId = this.activePlayerId;
        this.priorityMachine.consecutivePassCount = 0;
      }
      this.recordTrace('COMBAT_TRACE', 'DECLARE_BLOCKERS', {
        playerId,
        blockerAssignments: []
      });
      this.emit('BLOCKERS_DECLARED', { playerId, assignments: [] });
      return { assignments: [] };
    }

    // CR 702.110 Menace: an attacker with Menace can't be blocked except by two or more creatures.
    // Validated before any blocker state is mutated so a rejected declaration leaves no residue.
    const blockersPerAttacker = new Map();
    for (const item of assignments) {
      if (item && typeof item === 'object') {
        const aId = item.attackerId || item.targetAttackerId;
        if (aId) blockersPerAttacker.set(aId, (blockersPerAttacker.get(aId) || 0) + 1);
      }
    }
    for (const [aId, count] of blockersPerAttacker.entries()) {
      const menaceAttacker = (this.combatState?.attackers || []).find(a => a && (a.instanceId === aId || a.id === aId));
      if (menaceAttacker && count < 2 && this._hasKeyword(menaceAttacker, 'menace')) {
        throw new StateTransitionError(`Attacker '${menaceAttacker.name || aId}' has Menace and must be blocked by two or more creatures`);
      }
    }

    for (const item of assignments) {
      const blockerId = typeof item === 'string' ? item : (item.blockerId || item.id || item.instanceId);
      const attackerId = typeof item === 'object' ? (item.attackerId || item.targetAttackerId) : null;

      let blocker = null;
      if (player.battlefield?.creatures) {
        blocker = player.battlefield.creatures.find(c => c && (c.instanceId === blockerId || c.id === blockerId));
      }
      if (!blocker && Array.isArray(player.battlefield)) {
        blocker = player.battlefield.find(c => c && (c.instanceId === blockerId || c.id === blockerId));
      }
      if (!blocker) {
        throw new StateTransitionError(`Blocker '${blockerId}' not found on player's battlefield`);
      }

      if (blocker.isTapped) {
        throw new StateTransitionError(`Blocker '${blocker.name || blockerId}' is already tapped`);
      }

      const attacker = (this.combatState?.attackers || []).find(a => a && (a.instanceId === attackerId || a.id === attackerId));
      if (!attacker) {
        throw new StateTransitionError(`Attacking creature '${attackerId}' not found in declared attackers`);
      }

      if (attacker.defendingPlayerId !== playerId) {
        throw new StateTransitionError(`Player '${playerId}' is not the defending player for attacker '${attacker.name || attackerId}'`);
      }

      const blockCheck = CombatDamageEngine.canCreatureBlock(blocker, attacker, this);
      if (!blockCheck.canBlock) {
        if (blockCheck.reason === 'UNBLOCKABLE') {
          throw new StateTransitionError(`Attacker '${attacker.name || attackerId}' is unblockable and cannot be blocked`);
        }
        if (blockCheck.reason === 'FLYING_REQUIRES_FLYING_OR_REACH') {
          throw new StateTransitionError(`Creature '${blocker.name || blockerId}' without Flying or Reach cannot block an attacker with Flying`);
        }
        throw new StateTransitionError(`Creature cannot block: ${blockCheck.reason}`);
      }

      blocker.isBlocking = true;
      blocker.blockingTargetId = attacker.instanceId || attacker.id;
      blockerAssignments.push({
        blocker,
        blockerId: blocker.instanceId || blocker.id,
        attackerId: attacker.instanceId || attacker.id
      });
    }

    this.combatState.blockers = [...(this.combatState.blockers || []), ...blockerAssignments];
    this.combatState.blockersDeclared = true;
    if (assignments && typeof assignments === 'object' && assignments.damageAllocation) {
      this.combatState.damageAllocation = assignments.damageAllocation;
    }

    if (this.priorityMachine) {
      this.priorityMachine.priorityPlayerId = this.activePlayerId;
      this.priorityMachine.consecutivePassCount = 0;
    }

    this.recordTrace('COMBAT_TRACE', 'DECLARE_BLOCKERS', {
      playerId,
      blockerAssignments: blockerAssignments.map(b => ({ blockerId: b.blockerId, attackerId: b.attackerId })),
      blockersDetails: blockerAssignments.map(b => {
        const atk = this.combatState?.attackers?.find(a => (a.instanceId || a.id) === b.attackerId);
        return {
          blockerId: b.blockerId,
          blockerName: b.blocker?.name,
          blockerPT: `${b.blocker?.power ?? 0}/${b.blocker?.toughness ?? 0}`,
          attackerId: b.attackerId,
          attackerName: atk?.name || null,
          attackerPT: atk ? `${atk.power ?? 0}/${atk.toughness ?? 0}` : null
        };
      })
    });

    this.emit('BLOCKERS_DECLARED', { playerId, assignments });
    return { assignments };
  }

  /**
   * Helper to evaluate a creature's full combat profile across continuous layers.
   * Resolves effective power, toughness, native keywords, and equipment-granted Layer 6 keywords.
   *
   * @param {Object} creature
   * @returns {Object}
   * @private
   */
  _getCreatureCombatProfile(creature) {
    if (!creature) return null;
    const evalCreature = this.abilityEngine
      ? this.abilityEngine.evaluatePermanentLayers(creature, this)
      : creature;

    const effectivePower = evalCreature?.effectivePower ?? Number(evalCreature?.power) ?? Number(creature.power) ?? 0;
    const effectiveToughness = evalCreature?.effectiveToughness ?? Number(evalCreature?.toughness) ?? Number(creature.toughness) ?? 0;

    const hasKw = (kw) => this._hasKeyword(creature, kw);

    const hasFirstStrike = Boolean(hasKw('firstStrike') || hasKw('first strike') || hasKw('firststrike'));
    const hasDoubleStrike = Boolean(hasKw('doubleStrike') || hasKw('double strike') || hasKw('doublestrike'));
    const hasTrample = Boolean(hasKw('trample'));
    const hasLifelink = Boolean(hasKw('lifelink'));
    const hasDeathtouch = Boolean(hasKw('deathtouch'));
    const hasInfect = Boolean(hasKw('infect'));
    const toxic = Number(evalCreature?.keywords?.toxic || creature?.keywords?.toxic || 0);

    const keywords = {
      ...(creature.keywords || {}),
      ...(evalCreature.keywords || {}),
      firstStrike: hasFirstStrike,
      doubleStrike: hasDoubleStrike,
      trample: hasTrample,
      lifelink: hasLifelink,
      deathtouch: hasDeathtouch,
      infect: hasInfect,
      toxic
    };

    return {
      creature,
      evalCreature,
      power: effectivePower,
      toughness: effectiveToughness,
      hasFirstStrike,
      hasDoubleStrike,
      hasTrample,
      hasLifelink,
      hasDeathtouch,
      hasInfect,
      toxic,
      keywords
    };
  }

  /**
   * Checks if a creature permanent is currently alive on any player's battlefield.
   *
   * @param {Object} card
   * @returns {boolean}
   * @private
   */
  _isCreatureOnBattlefield(card) {
    if (!card) return false;
    const cid = card.instanceId || card.id;
    if (!cid) return false;
    for (const p of Object.values(this.players || {})) {
      const creatures = p.battlefield?.creatures || (Array.isArray(p.battlefield) ? p.battlefield : []);
      if (creatures.some(c => c && (c.instanceId === cid || c.id === cid))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolves combat damage allocation per MTG CR 510, CR 510.4, CR 702.4b, and CR 702.19b.
   * If any attacking or blocking creature has First Strike or Double Strike, resolves combat
   * in two distinct strike steps (FIRST_STRIKE and NORMAL_STRIKE) with intervening state-based actions.
   *
   * @returns {{ resolved: boolean }}
   */
  resolveCombatDamage() {
    this.clearUndoableManaTaps?.();

    const declaredAttackers = (this.combatState?.attackers || []).filter(a => this._isCreatureOnBattlefield(a));
    const declaredBlockerAssignments = (this.combatState?.blockers || []);

    // Check if any active attacker or assigned blocker has First Strike or Double Strike
    let hasAnyFirstOrDoubleStrike = false;
    for (const attacker of declaredAttackers) {
      const prof = this._getCreatureCombatProfile(attacker);
      if (prof.hasFirstStrike || prof.hasDoubleStrike) {
        hasAnyFirstOrDoubleStrike = true;
        break;
      }
    }

    if (!hasAnyFirstOrDoubleStrike) {
      for (const b of declaredBlockerAssignments) {
        const blockerCard = b.blocker || this.findPermanentById?.(b.blockerId || b.instanceId || b.id)?.card || b;
        if (this._isCreatureOnBattlefield(blockerCard)) {
          const prof = this._getCreatureCombatProfile(blockerCard);
          if (prof.hasFirstStrike || prof.hasDoubleStrike) {
            hasAnyFirstOrDoubleStrike = true;
            break;
          }
        }
      }
    }

    if (hasAnyFirstOrDoubleStrike) {
      // Step 1: FIRST_STRIKE (CR 510.4 & CR 702.4b)
      this._executeCombatDamageStrikeStep('FIRST_STRIKE', true);
      this.runSBACheck(); // CR 704.5g: lethal damage destroys creatures before step 2

      // Step 2: NORMAL_STRIKE
      this._executeCombatDamageStrikeStep('NORMAL_STRIKE', true);
      this.runSBACheck();
    } else {
      // Standard simultaneous combat damage step
      this._executeCombatDamageStrikeStep('NORMAL_STRIKE', false);
      this.runSBACheck();
    }

    this.emit('COMBAT_DAMAGE_RESOLVED', {
      attackers: this.combatState?.attackers || [],
      blockers: this.combatState?.blockers || []
    });
    return { resolved: true };
  }

  /**
   * Internal executor for a single strike step (FIRST_STRIKE or NORMAL_STRIKE).
   *
   * @param {'FIRST_STRIKE' | 'NORMAL_STRIKE'} strikePhase
   * @param {boolean} isDualStep
   * @private
   */
  _executeCombatDamageStrikeStep(strikePhase, isDualStep) {
    const attackers = this.combatState?.attackers || [];

    for (const attacker of attackers) {
      // 1. Attacker must still be on the battlefield
      if (!this._isCreatureOnBattlefield(attacker)) continue;

      const atkProfile = this._getCreatureCombatProfile(attacker);
      const effectivePower = atkProfile.power;
      const attackerKeywords = atkProfile.keywords;

      // 2. Determine if attacker participates in this strike phase
      let attackerStrikes = false;
      if (strikePhase === 'FIRST_STRIKE') {
        attackerStrikes = atkProfile.hasFirstStrike || atkProfile.hasDoubleStrike;
      } else {
        // NORMAL_STRIKE
        if (isDualStep) {
          attackerStrikes = atkProfile.hasDoubleStrike || !(atkProfile.hasFirstStrike || atkProfile.hasDoubleStrike);
        } else {
          attackerStrikes = true;
        }
      }

      // 3. Find blockers assigned to this attacker
      const assigned = (this.combatState.blockers || []).filter(b =>
        b.attackerId === attacker.instanceId || b.attackerId === attacker.id || b.blockingTargetId === attacker.instanceId
      );

      const aliveBlockers = assigned
        .map(b => b.blocker || this.findPermanentById?.(b.blockerId || b.instanceId || b.id)?.card || b)
        .filter(b => this._isCreatureOnBattlefield(b));

      // 4. Attacker deals damage if eligible
      if (attackerStrikes) {
        if (assigned.length === 0) {
          if (attacker.defendingBattleId) {
            CombatDamageEngine.dealDamage({
              sourceId: attacker.instanceId || attacker.id,
              sourceName: attacker.name,
              sourceControllerId: attacker.controllerId || this.activePlayerId,
              targetId: attacker.defendingBattleId,
              targetType: 'BATTLE',
              amount: effectivePower,
              isCombat: true,
              strikePhase,
              keywords: attackerKeywords
            }, this);
          } else {
            // Unblocked -> All damage to defending player
            const defPlayer = this.players[attacker.defendingPlayerId];
            const lifeBefore = defPlayer?.resources?.life ?? 20;
            CombatDamageEngine.dealDamage({
              sourceId: attacker.instanceId || attacker.id,
              sourceName: attacker.name,
              sourceControllerId: attacker.controllerId || this.activePlayerId,
              targetId: attacker.defendingPlayerId,
              targetType: 'PLAYER',
              amount: effectivePower,
              isCombat: true,
              strikePhase,
              keywords: attackerKeywords
            }, this);
            const lifeAfter = defPlayer?.resources?.life ?? lifeBefore;
            this.recordTrace('COMBAT_TRACE', 'COMBAT_DAMAGE_UNBLOCKED', {
              attackerId: attacker.instanceId || attacker.id,
              attackerName: attacker.name,
              attackerPower: effectivePower,
              blocked: false,
              defendingPlayerId: attacker.defendingPlayerId,
              strikePhase,
              lifeBefore,
              lifeAfter
            });
          }
        } else {
          // Blocked attacker
          const defPlayer = this.players[attacker.defendingPlayerId];
          const lifeBefore = defPlayer?.resources?.life ?? 20;

          if (aliveBlockers.length === 0) {
            // Blockers were assigned but destroyed prior to this strike step (e.g. killed in Step 1)
            // CR 702.19b: Trample deals full damage to player.
            // CR 510.1c: Without Trample, blocked creature deals 0 damage to player.
            if (atkProfile.hasTrample && effectivePower > 0) {
              CombatDamageEngine.dealDamage({
                sourceId: attacker.instanceId || attacker.id,
                sourceName: attacker.name,
                sourceControllerId: attacker.controllerId || this.activePlayerId,
                targetId: attacker.defendingPlayerId,
                targetType: 'PLAYER',
                amount: effectivePower,
                isCombat: true,
                strikePhase,
                keywords: attackerKeywords
              }, this);
              const lifeAfter = defPlayer?.resources?.life ?? lifeBefore;
              this.recordTrace('COMBAT_TRACE', 'COMBAT_DAMAGE_UNBLOCKED', {
                attackerId: attacker.instanceId || attacker.id,
                attackerName: attacker.name,
                attackerPower: effectivePower,
                blocked: true,
                trample: true,
                defendingPlayerId: attacker.defendingPlayerId,
                strikePhase,
                lifeBefore,
                lifeAfter
              });
            } else {
              this.recordTrace('COMBAT_TRACE', 'COMBAT_DAMAGE_BLOCKED', {
                attackerId: attacker.instanceId || attacker.id,
                attackerName: attacker.name,
                attackerPower: effectivePower,
                blocked: true,
                blockerIds: [],
                defendingPlayerId: attacker.defendingPlayerId,
                strikePhase,
                lifeBefore,
                lifeAfter: lifeBefore
              });
            }
          } else {
            // Distribute damage to alive blockers (passing damageAllocation)
            const dist = CombatDamageEngine.calculateAttackerDamageDistribution(
              atkProfile.evalCreature || attacker,
              aliveBlockers,
              effectivePower,
              this,
              this.combatState?.damageAllocation
            );
            for (const assign of dist.blockerAssignments) {
              if (assign.damage > 0) {
                CombatDamageEngine.dealDamage({
                  sourceId: attacker.instanceId || attacker.id,
                  sourceName: attacker.name,
                  sourceControllerId: attacker.controllerId || this.activePlayerId,
                  targetId: assign.blockerId,
                  targetType: 'CREATURE',
                  amount: assign.damage,
                  isCombat: true,
                  strikePhase,
                  keywords: attackerKeywords
                }, this);
              }
            }
            if (dist.playerTrampleDamage > 0) {
              if (attacker.defendingBattleId) {
                CombatDamageEngine.dealDamage({
                  sourceId: attacker.instanceId || attacker.id,
                  sourceName: attacker.name,
                  sourceControllerId: attacker.controllerId || this.activePlayerId,
                  targetId: attacker.defendingBattleId,
                  targetType: 'BATTLE',
                  amount: dist.playerTrampleDamage,
                  isCombat: true,
                  strikePhase,
                  keywords: attackerKeywords
                }, this);
              } else {
                CombatDamageEngine.dealDamage({
                  sourceId: attacker.instanceId || attacker.id,
                  sourceName: attacker.name,
                  sourceControllerId: attacker.controllerId || this.activePlayerId,
                  targetId: attacker.defendingPlayerId,
                  targetType: 'PLAYER',
                  amount: dist.playerTrampleDamage,
                  isCombat: true,
                  strikePhase,
                  keywords: attackerKeywords
                }, this);
              }
            }

            const lifeAfter = defPlayer?.resources?.life ?? lifeBefore;
            this.recordTrace('COMBAT_TRACE', 'COMBAT_DAMAGE_BLOCKED', {
              attackerId: attacker.instanceId || attacker.id,
              attackerName: attacker.name,
              attackerPower: effectivePower,
              blocked: true,
              blockerIds: aliveBlockers.map(b => b.instanceId || b.id),
              defendingPlayerId: attacker.defendingPlayerId,
              strikePhase,
              lifeBefore,
              lifeAfter
            });
          }
        }
      }

      // 5. Blockers deal damage back to attacker if eligible
      for (const blocker of aliveBlockers) {
        if (!this._isCreatureOnBattlefield(blocker)) continue;
        const blkProfile = this._getCreatureCombatProfile(blocker);

        let blockerStrikes = false;
        if (strikePhase === 'FIRST_STRIKE') {
          blockerStrikes = blkProfile.hasFirstStrike || blkProfile.hasDoubleStrike;
        } else {
          // NORMAL_STRIKE
          if (isDualStep) {
            blockerStrikes = blkProfile.hasDoubleStrike || !(blkProfile.hasFirstStrike || blkProfile.hasDoubleStrike);
          } else {
            blockerStrikes = true;
          }
        }

        if (blockerStrikes && blkProfile.power > 0) {
          CombatDamageEngine.dealDamage({
            sourceId: blocker.instanceId || blocker.id,
            sourceName: blocker.name,
            sourceControllerId: blocker.controllerId || attacker.defendingPlayerId,
            targetId: attacker.instanceId || attacker.id,
            targetType: 'CREATURE',
            amount: blkProfile.power,
            isCombat: true,
            strikePhase,
            keywords: blkProfile.keywords
          }, this);
        }
      }
    }

    this.recordTrace('COMBAT_TRACE', 'COMBAT_DAMAGE_STEP_RESOLVED', {
      strikePhase,
      isDualStep
    });
  }

  /**
   * Cleans up combat state and creature combat flags per MTG CR 511.
   */
  endCombat() {
    for (const player of Object.values(this.players || {})) {
      if (player) player.underAttack = false;
      const permanents = [];
      if (player.battlefield) {
        if (Array.isArray(player.battlefield)) {
          permanents.push(...player.battlefield);
        } else {
          for (const list of Object.values(player.battlefield)) {
            if (Array.isArray(list)) permanents.push(...list);
          }
        }
      }
      if (Array.isArray(player.zones?.battlefield)) {
        permanents.push(...player.zones.battlefield);
      }
      for (const card of permanents) {
        if (card) {
          card.isAttacking = false;
          card.isBlocking = false;
          card.defendingPlayerId = null;
          card.blockingTargetId = null;
          delete card.defendingPlayerId;
          delete card.blockingTargetId;
        }
      }
    }
    this.combatState = { attackers: [], blockers: [], defendingPlayerId: null, defendingPlayerIds: [] };
    if (this.priorityMachine) {
      this.priorityMachine.defendingPlayerId = null;
      this.priorityMachine.defendingPlayerIds = [];
      this.priorityMachine.combatAttackers = [];
    }
    this.emit('COMBAT_ENDED');
  }

  _handleEnterWithoutCasting(payload) {
    const { playerId, instanceId, fromZone = 'library', subzone = null } = payload;
    const player = this.getPlayer(playerId);
    const card = ZoneTransitionMatrix.enterWithoutCasting(player, instanceId, fromZone, subzone);
    this._onPermanentEnteredBattlefield(card, playerId);
    this.emit('CARD_ENTERED_WITHOUT_CASTING', { playerId, card, fromZone });
    this.runSBACheck();
    return { card };
  }

  _handleCastWithoutPaying(payload) {
    const { playerId, instanceId, fromZone = 'hand' } = payload;
    const player = this.getPlayer(playerId);
    const card = ZoneTransitionMatrix.castWithoutPayingManaCost(player, instanceId, fromZone, this.stack);
    this.emit('CARD_CAST_WITHOUT_PAYING', { playerId, card, fromZone });
    return { card };
  }

  _handleReanimate(payload) {
    const { playerId, instanceId } = payload;
    const player = this.getPlayer(playerId);
    const card = ZoneTransitionMatrix.reanimate(player, instanceId);
    this._onPermanentEnteredBattlefield(card, playerId);
    this.emit('CREATURE_REANIMATED', { playerId, card });
    this.runSBACheck();
    return { card };
  }

  _handleRegrowth(payload) {
    const { playerId, instanceId } = payload;
    const player = this.getPlayer(playerId);
    const card = ZoneTransitionMatrix.regrowth(player, instanceId);
    this.emit('CARD_REGROWTH', { playerId, card });
    return { card };
  }

  _handleFlicker(payload) {
    const { playerId, instanceId } = payload;
    const player = this.getPlayer(playerId);
    this.abilityEngine?.unregisterEffectsFromSource(instanceId);
    const card = ZoneTransitionMatrix.flicker(player, instanceId);
    this._onPermanentEnteredBattlefield(card, playerId);
    this.emit('PERMANENT_FLICKERED', { playerId, card });
    this.runSBACheck();
    return { card };
  }

  _handleMill(payload) {
    const { playerId, count = 1 } = payload;
    const player = this.getPlayer(playerId);
    const cards = ZoneTransitionMatrix.mill(player, count);
    this.emit('CARDS_MILLED', { playerId, count, cards });
    return { cards };
  }

  _handleImpulseExile(payload) {
    const { playerId, count = 1 } = payload;
    const player = this.getPlayer(playerId);
    const cards = ZoneTransitionMatrix.impulseExile(player, count);
    this.emit('CARDS_IMPULSE_EXILED', { playerId, count, cards });
    return { cards };
  }

  // --- Convenience Direct Methods ---

  initializeDeck(playerId, deckCards, options) {
    return this.dispatch('INITIALIZE_DECK', { playerId, deckCards, options });
  }

  drawCard(playerId, count = 1) {
    return this.dispatch('DRAW_CARD', { playerId, count });
  }

  drawCardForTurn(playerId, context = {}) {
    return this.drawCard(playerId, 1);
  }

  /**
   * Evaluates if a creature can legally tap or attack per MTG CR 302.6 & CR 702.10.
   * Checks summoning sickness and real Haste / Prisa (native or granted via Layer 6).
   * 
   * @param {Object} card
   * @returns {{ canAct: boolean, hasHaste?: boolean, reason?: string }}
   */
  canCreatureTapOrAttack(card) {
    if (!card) {
      const res = { canAct: false, reason: 'NO_CARD' };
      res.valueOf = () => false;
      return res;
    }

    const isSick = Boolean(card.hasSummoningSickness || card.isSummoningSick || card.summoningSickness);
    if (!isSick) {
      const res = { canAct: true };
      res.valueOf = () => true;
      return res;
    }

    // Creature has summoning sickness -> check for Haste / Prisa (evaluated via Layer 6 if engine present)
    const evalCard = this.abilityEngine
      ? this.abilityEngine.evaluatePermanentLayers(card, this)
      : card;

    const hasHaste = Boolean(
      evalCard?.keywords?.haste ||
      evalCard?.keywords?.Haste ||
      evalCard?.hasHaste ||
      card?.keywords?.haste ||
      card?.keywords?.Haste ||
      card?.hasHaste ||
      /haste|prisa/i.test(evalCard?.oracleText || evalCard?.text || card?.oracleText || card?.text || '') ||
      (Array.isArray(evalCard?.grantedAbilities) && evalCard.grantedAbilities.some(a =>
        typeof a === 'string' ? /haste|prisa/i.test(a) : /haste|prisa/i.test(a?.name || a?.text || '')
      )) ||
      (Array.isArray(card?.grantedAbilities) && card.grantedAbilities.some(a =>
        typeof a === 'string' ? /haste|prisa/i.test(a) : /haste|prisa/i.test(a?.name || a?.text || '')
      ))
    );

    if (hasHaste) {
      const res = { canAct: true, hasHaste: true };
      res.valueOf = () => true;
      return res;
    }

    const res = { canAct: false, reason: 'SUMMONING_SICKNESS' };
    res.valueOf = () => false;
    return res;
  }

  /**
   * Validates priority holding and MTG speed restrictions (Instant vs Sorcery timing).
   * CR 117.1a, CR 305.1, CR 601.2
   * 
   * @param {string} playerId
   * @param {Object} card
   * @param {PriorityStateMachine|Object} [priorityState=this.priorityMachine]
   * @returns {{ allowed: boolean, reason?: string, message?: string }}
   */
  canPlayerCastOrPlay(playerId, card, priorityState = this.priorityMachine, options = {}) {
    if (!card) {
      const res = { allowed: false, reason: 'INVALID_CARD', message: 'No card specified.' };
      res.valueOf = () => false;
      return res;
    }

    TabletopStateManager.hydrateCardMechanics(card);

    // a) Priority Rule
    if (priorityState && priorityState.priorityPlayerId && priorityState.priorityPlayerId !== playerId) {
      const res = {
        allowed: false,
        reason: 'NO_PRIORITY',
        message: `Player '${playerId}' does not hold priority.`
      };
      res.valueOf = () => false;
      return res;
    }

    if (!priorityState) {
      const res = { allowed: true };
      res.valueOf = () => true;
      return res;
    }

    const castMode = options?.castMode || card.selectedCastMode || card.activeCastMode || null;
    let effectiveTypeLine = card.typeLine || card.type || '';
    if (castMode && Array.isArray(card.compiledMechanics?.castModes)) {
      const norm = String(castMode).toUpperCase();
      const matched = card.compiledMechanics.castModes.find(m =>
        String(m.mode || '').toUpperCase() === norm ||
        String(m.name || '').toUpperCase() === norm
      );
      if (matched && matched.typeLine) {
        effectiveTypeLine = matched.typeLine;
      }
    }

    const typeLine = effectiveTypeLine;
    const isLand = /land/i.test(typeLine);
    const activePlayerId = priorityState.activePlayerId;
    const stackLength = priorityState.stack ? priorityState.stack.length : (this.stack?.length || 0);
    const currentPhase = (priorityState.currentPhaseStep || '').toUpperCase();
    const isMain = currentPhase.includes('MAIN') || currentPhase === 'PRECOMBAT_MAIN' || currentPhase === 'POSTCOMBAT_MAIN';

    // b) Type & Speed Rules
    // Lands: Never played at instant speed. Only active player during main phase with empty stack.
    if (isLand) {
      if (playerId !== activePlayerId || stackLength !== 0 || !isMain) {
        const res = {
          allowed: false,
          reason: 'SORCERY_SPEED_RESTRICTION',
          message: 'Lands may only be played at sorcery speed during your main phase with an empty stack.'
        };
        res.valueOf = () => false;
        return res;
      }
      const res = { allowed: true };
      res.valueOf = () => true;
      return res;
    }

    // Instant or Flash (including controller static permissions like Sigarda's Aid)
    const isInstant = /instant/i.test(typeLine);
    const evalCard = this.abilityEngine
      ? this.abilityEngine.evaluatePermanentLayers(card, this)
      : card;
    const hasControllerFlashGrant = CastAvailabilityManager.hasControllerStaticFlashGrant(this, playerId, {
      ...evalCard,
      typeLine
    });
    const hasFlash = Boolean(
      hasControllerFlashGrant ||
      /flash/i.test(typeLine) ||
      evalCard?.keywords?.flash ||
      evalCard?.keywords?.Flash ||
      evalCard?.hasFlash ||
      card?.keywords?.flash ||
      card?.keywords?.Flash ||
      card?.hasFlash ||
      /flash/i.test(evalCard?.oracleText || evalCard?.text || card?.oracleText || card?.text || '') ||
      (Array.isArray(evalCard?.grantedAbilities) && evalCard.grantedAbilities.some(a =>
        typeof a === 'string' ? /flash/i.test(a) : /flash/i.test(a?.name || a?.text || '')
      )) ||
      (Array.isArray(card?.grantedAbilities) && card.grantedAbilities.some(a =>
        typeof a === 'string' ? /flash/i.test(a) : /flash/i.test(a?.name || a?.text || '')
      ))
    );

    if (isInstant || hasFlash) {
      if (priorityState.priorityPlayerId && priorityState.priorityPlayerId !== playerId) {
        const res = {
          allowed: false,
          reason: 'NO_PRIORITY',
          message: `Player '${playerId}' does not hold priority.`
        };
        res.valueOf = () => false;
        return res;
      }
      const res = { allowed: true };
      res.valueOf = () => true;
      return res;
    }

    // Sorcery speed spells (Sorcery, Creature without Flash, Artifact without Flash, etc.)
    if (playerId !== activePlayerId || stackLength !== 0 || !isMain) {
      const res = {
        allowed: false,
        reason: 'SORCERY_SPEED_RESTRICTION',
        message: 'Sorcery speed spells require an empty stack during your main phase.'
      };
      res.valueOf = () => false;
      return res;
    }

    const res = { allowed: true };
    res.valueOf = () => true;
    return res;
  }

  canPlayLand(playerId = this.activePlayerId) {
    const player = this.getPlayer(playerId);
    if (!player) {
      const res = { allowed: false, reason: 'NOT_ACTIVE_PLAYER', message: '⚠️ Player not found' };
      res.valueOf = () => false;
      return res;
    }

    // 1. Check Active Player
    const activePid = this.priorityMachine?.activePlayerId || this.activePlayerId;
    if (activePid && activePid !== playerId) {
      const res = { allowed: false, reason: 'NOT_ACTIVE_PLAYER', message: '⚠️ It is not your turn' };
      res.valueOf = () => false;
      return res;
    }

    // 2. Check Phase Timing (Main Phase Only)
    const currentPhase = this.priorityMachine?.currentPhaseStep;
    if (currentPhase) {
      const normalizedPhase = currentPhase.toUpperCase();
      const isMain = normalizedPhase.includes('MAIN') || normalizedPhase === 'PRECOMBAT_MAIN' || normalizedPhase === 'POSTCOMBAT_MAIN';
      if (!isMain) {
        const res = { allowed: false, reason: 'WRONG_PHASE', message: '⚠️ Lands can only be played during Main phase' };
        res.valueOf = () => false;
        return res;
      }
    }

    // 3. Check Stack Depth (Must be empty)
    const stackDepth = this.priorityMachine?.getStackDepth?.() ?? this.stack.length;
    if (stackDepth > 0) {
      const res = { allowed: false, reason: 'STACK_NOT_EMPTY', message: '⚠️ Lands can only be played when the stack is empty' };
      res.valueOf = () => false;
      return res;
    }

    // 4. Check Priority
    const priorityPid = this.priorityMachine?.priorityPlayerId;
    if (priorityPid && priorityPid !== playerId) {
      const res = { allowed: false, reason: 'NOT_ACTIVE_PLAYER', message: '⚠️ You do not hold priority' };
      res.valueOf = () => false;
      return res;
    }

    // 5. Check Land Drop Limit (CR 305.1)
    const played = player.landsPlayedThisTurn ?? player.resources?.landsPlayedThisTurn ?? 0;
    const baseLimit = player.maxLandsPerTurn ?? player.landsPerTurnLimit ?? player.resources?.maxLandsPerTurn ?? 1;
    const extraLands = player.resources?.additionalLandsAllowed || 0;
    const limit = Math.max(baseLimit, 1 + extraLands);
    if (played >= limit) {
      const res = { allowed: false, reason: 'LAND_LIMIT_REACHED', message: `⚠️ You have already played a land this turn (${played}/${limit})` };
      res.valueOf = () => false;
      return res;
    }

    const res = { allowed: true };
    res.valueOf = () => true;
    return res;
  }

  /**
   * Directly taps a land on the battlefield to float 1 mana into mana pool (INV-MANA-1).
   * 
   * @param {string} playerId
   * @param {string} instanceId
   * @param {string} [chosenColor]
   * @returns {{ card: Object, manaAdded: Record<string, number> }}
   */
  tapLandForMana(playerId, instanceId, chosenColor = null) {
    const player = this.getPlayer(playerId);
    const lands = player.battlefield?.lands || [];
    const foundLand = lands.find(l => l && (l.instanceId === instanceId || l.id === instanceId));

    if (!foundLand) {
      const foundAnywhere = ZoneModel.findCard(player, instanceId);
      if (!foundAnywhere) {
        throw new CardNotFoundError(`Land with instanceId '${instanceId}' not found on battlefield.`);
      }
      if (foundAnywhere.zone !== 'battlefield') {
        throw new InvalidZoneError(`Cannot tap land in zone '${foundAnywhere.zone}'. Land must be on the battlefield.`);
      }
      if (!/land/i.test(foundAnywhere.card.typeLine || foundAnywhere.card.type || '')) {
        throw new InvalidCardTypeError(`Card '${foundAnywhere.card.name}' is not a land.`);
      }
    }

    const land = foundLand || ZoneModel.findCard(player, instanceId).card;
    if (!land.compiledMechanics) hydrateCardMechanics(land);

    if (land.isTapped) {
      throw new PermanentAlreadyTappedError(`Permanent "${land.name}" (${instanceId}) is already tapped`);
    }

    const legalAbilities = CastAvailabilityManager.getLegalManaAbilities(this, playerId, land);
    let selectedAbility = null;
    let color = chosenColor ? String(chosenColor).toUpperCase() : null;

    if (legalAbilities.length > 0) {
      if (color) {
        selectedAbility = legalAbilities.find(ab => (ab.produces || []).includes(color)) || null;
        if (!selectedAbility) {
          throw new InsufficientManaError(`Land "${land.name}" cannot legally produce {${color}} right now (requires condition or insufficient life).`);
        }
      } else {
        // Default to lowest lifeCost ability (e.g. {C} with 0 life on Spire of Industry / Starting Town)
        selectedAbility = legalAbilities[0];
        color = (selectedAbility.produces && selectedAbility.produces[0]) || 'C';
      }
    } else if (Array.isArray(land.compiledMechanics?.manaAbilities) && land.compiledMechanics.manaAbilities.length > 0) {
      throw new InsufficientManaError(`No legal mana abilities available on "${land.name}" (insufficient life or condition not met).`);
    } else {
      color = color || this._resolveLandManaColor(land);
    }

    const lifeCostToPay = selectedAbility
      ? Number(selectedAbility.lifeCost || 0)
      : Number(land.compiledMechanics?.manaLifeCost || 0);

    if (lifeCostToPay > 0) {
      const currentLife = Number(player.resources?.life ?? 20);
      if (currentLife - lifeCostToPay <= 0) {
        throw new InsufficientManaError(`Cannot pay ${lifeCostToPay} life for "${land.name}" at ${currentLife} life.`);
      }
    }

    land.isTapped = true;
    if (Array.isArray(player.zones?.battlefield)) {
      for (const zc of player.zones.battlefield) {
        if (zc && (zc === land || (land.instanceId && zc.instanceId === land.instanceId))) {
          zc.isTapped = true;
        }
      }
    }

    if (lifeCostToPay > 0) {
      this.adjustLife(playerId, { delta: -lifeCostToPay });
    }

    player.resources.manaPool = player.resources.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    const manaPoolBefore = { ...player.resources.manaPool };
    player.resources.manaPool[color] = (player.resources.manaPool[color] || 0) + 1;

    const manaAdded = { [color]: 1 };

    // Record undoable mana tap
    player._undoableManaTaps = player._undoableManaTaps || [];
    player._undoableManaTaps.push({
      instanceId: land.instanceId || instanceId,
      color,
      amount: 1,
      lifePaid: lifeCostToPay
    });

    this.recordTrace('MANA_TRACE', 'MANUAL_LAND_TAP', {
      playerId,
      instanceId: land.instanceId || instanceId,
      landName: land.name,
      abilityId: selectedAbility?.id || 'default',
      lifePaid: lifeCostToPay,
      manaAdded,
      manaPoolBefore,
      manaPoolAfter: { ...player.resources.manaPool }
    });

    this.emit('PERMANENT_TAPPED', { playerId, instanceId: land.instanceId || instanceId, card: land });
    this.emit('LAND_TAPPED', { playerId, instanceId: land.instanceId || instanceId, card: land, manaAdded, lifePaid: lifeCostToPay });
    this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });

    return { card: land, manaAdded, color, lifePaid: lifeCostToPay };
  }

  /**
   * Clears the undo stack of floating mana taps for one or all players.
   * Invoked automatically whenever the game state advances.
   *
   * @param {string} [playerId]
   */
  clearUndoableManaTaps(playerId = null) {
    if (playerId) {
      const player = this.players?.[playerId];
      if (player) player._undoableManaTaps = [];
    } else {
      for (const p of Object.values(this.players || {})) {
        if (p) p._undoableManaTaps = [];
      }
    }
  }

  /**
   * Undoes the last manual land tap for floating mana if no irreversible state has progressed.
   * Untaps the land, restores mana pool and paid life, records trace, and emits untap events.
   *
   * @param {string} playerId
   * @returns {Object|null}
   */
  undoLastManaTap(playerId) {
    const player = this.getPlayer(playerId);
    if (!player || !Array.isArray(player._undoableManaTaps) || player._undoableManaTaps.length === 0) {
      return null;
    }

    const entry = player._undoableManaTaps.pop();
    if (!entry) return null;

    // Find the land card on player.battlefield.lands or player.zones.battlefield
    const lands = player.battlefield?.lands || [];
    let land = lands.find(l => l && (l.instanceId === entry.instanceId || l.id === entry.instanceId));
    if (!land && Array.isArray(player.zones?.battlefield)) {
      land = player.zones.battlefield.find(l => l && (l.instanceId === entry.instanceId || l.id === entry.instanceId));
    }

    if (land) {
      land.isTapped = false;
      if (Array.isArray(player.zones?.battlefield)) {
        for (const zc of player.zones.battlefield) {
          if (zc && (zc === land || (land.instanceId && zc.instanceId === land.instanceId))) {
            zc.isTapped = false;
          }
        }
      }
    }

    player.resources = player.resources || {};
    player.resources.manaPool = player.resources.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    if (entry.color) {
      player.resources.manaPool[entry.color] = Math.max(0, (player.resources.manaPool[entry.color] || 0) - (entry.amount || 1));
    }

    if (entry.lifePaid > 0) {
      this.adjustLife(playerId, { delta: entry.lifePaid });
    }

    this.recordTrace('MANA_TRACE', 'MANA_TAP_UNDONE', {
      playerId,
      instanceId: entry.instanceId,
      landName: land?.name || null,
      color: entry.color,
      amount: entry.amount || 1,
      lifeRestored: entry.lifePaid || 0,
      manaPoolAfter: { ...player.resources.manaPool }
    });

    this.emit('PERMANENT_UNTAPPED', { playerId, instanceId: entry.instanceId, card: land });
    this.emit('LAND_UNTAPPED', { playerId, instanceId: entry.instanceId, card: land, color: entry.color, amount: entry.amount || 1 });
    this.emit('MANA_TAP_UNDONE', { playerId, instanceId: entry.instanceId, card: land, color: entry.color, amount: entry.amount || 1, lifeRestored: entry.lifePaid || 0 });
    this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });

    return {
      undone: true,
      land,
      color: entry.color,
      amount: entry.amount || 1,
      lifeRestored: entry.lifePaid || 0
    };
  }

  /**
   * Undoes all floating manual land taps for a player in reverse order.
   *
   * @param {string} playerId
   * @returns {Array<Object>}
   */
  undoAllManaTaps(playerId) {
    const player = this.getPlayer(playerId);
    if (!player || !Array.isArray(player._undoableManaTaps) || player._undoableManaTaps.length === 0) {
      return [];
    }
    const undoneRecords = [];
    while (player._undoableManaTaps && player._undoableManaTaps.length > 0) {
      const res = this.undoLastManaTap(playerId);
      if (res) {
        undoneRecords.push(res);
      } else {
        break;
      }
    }
    return undoneRecords;
  }

  /**
   * Helper to record a structured process trace entry.
   * @param {string} category
   * @param {string} action
   * @param {Object} [payload={}]
   */
  recordTrace(category, action, payload = {}) {
    if (!this.traceLogger || typeof this.traceLogger.record !== 'function') return null;
    const psm = this._priorityMachine;
    const activePid = psm?.activePlayerId || this._activePlayerId;
    const oppPid = Object.keys(this.players || {}).find(id => id !== activePid && !this.players[id]?.isEliminated) || null;
    return this.traceLogger.record({
      category,
      action,
      stateContext: {
        turn: psm?.turnNumber ?? this._turnNumber ?? 1,
        round: psm?.roundNumber ?? this._roundNumber ?? 1,
        phase: psm?.getOverarchingPhase?.() ?? 'MAIN',
        step: psm?.currentPhaseStep ?? 'PRECOMBAT_MAIN',
        activePlayerId: activePid,
        priorityPlayerId: psm?.priorityPlayerId ?? activePid,
        defendingPlayerId: this.combatState?.defendingPlayerId || oppPid
      },
      payload
    });
  }

  /**
   * Helper to determine all mana colors a land can produce (ordered by preference).
   * Single-color basic lands return 1 color (e.g. ['R']); dual/shocklands return 2 (e.g. ['U', 'R']).
   *
   * @param {Object} land
   * @returns {string[]}
   */
  _getLandManaProfile(land) {
    if (!land) return ['C'];
    if (!land.compiledMechanics) hydrateCardMechanics(land);
    if (land.compiledMechanics?.manaProfile && land.compiledMechanics.manaProfile.length > 0) {
      return [...land.compiledMechanics.manaProfile];
    }
    const name = String(land.name || '').toLowerCase();
    const typeLine = String(land.typeLine || land.type || '').toLowerCase();
    const oracle = String(land.oracleText || land.text || '').toLowerCase();

    // Dual / Shocklands / Fastlands
    if (name.includes('steam vents') || name.includes('spirebluff') || name.includes('scalding tarn') || (typeLine.includes('island') && typeLine.includes('mountain'))) return ['R', 'U'];
    if (name.includes('sacred foundry') || name.includes('inspiring vantage') || (typeLine.includes('mountain') && typeLine.includes('plains'))) return ['R', 'W'];
    if (name.includes('stomping ground') || name.includes('copperline') || (typeLine.includes('mountain') && typeLine.includes('forest'))) return ['R', 'G'];
    if (name.includes('blood crypt') || name.includes('blackcleave') || (typeLine.includes('swamp') && typeLine.includes('mountain'))) return ['B', 'R'];
    if (name.includes('watery grave') || name.includes('darkslick') || (typeLine.includes('island') && typeLine.includes('swamp'))) return ['U', 'B'];
    if (name.includes('overgrown tomb') || name.includes('twilight mire') || name.includes('blooming marsh') || (typeLine.includes('swamp') && typeLine.includes('forest'))) return ['B', 'G'];
    if (name.includes('breeding pool') || name.includes('botanical') || (typeLine.includes('forest') && typeLine.includes('island'))) return ['G', 'U'];
    if (name.includes('temple garden') || name.includes('razorverge') || (typeLine.includes('forest') && typeLine.includes('plains'))) return ['G', 'W'];
    if (name.includes('hallowed fountain') || name.includes('seachrome') || (typeLine.includes('plains') && typeLine.includes('island'))) return ['W', 'U'];
    if (name.includes('godless shrine') || name.includes('concealed') || (typeLine.includes('plains') && typeLine.includes('swamp'))) return ['W', 'B'];

    // Basic lands
    if (name.includes('mountain') || typeLine.includes('mountain')) return ['R'];
    if (name.includes('island') || typeLine.includes('island')) return ['U'];
    if (name.includes('swamp') || typeLine.includes('swamp')) return ['B'];
    if (name.includes('plains') || typeLine.includes('plains')) return ['W'];
    if (name.includes('forest') || typeLine.includes('forest')) return ['G'];
    if (name.includes('wastes') || name.includes("urza's")) return ['C'];

    // Parse oracle "{T}: Add {X} or {Y}"
    const addMatches = oracle.match(/\{([wubrgc])\}/gi);
    if (addMatches && addMatches.length > 0) {
      const cols = [...new Set(addMatches.map(m => m.replace(/[{}]/g, '').toUpperCase()))];
      if (cols.length > 0) return cols;
    }

    if (Array.isArray(land.colors) && land.colors.length > 0) return [...land.colors];
    if (Array.isArray(land.colorIdentity) && land.colorIdentity.length > 0) return [...land.colorIdentity];
    return ['C'];
  }

  /**
   * Helper to determine primary mana color produced by a land.
   * 
   * @param {Object} land
   * @returns {string}
   */
  _resolveLandManaColor(land) {
    return this._getLandManaProfile(land)[0] || 'C';
  }

  /**
   * MTG Arena Exact-Cost Auto-Tap Engine (INV-MANA-1).
   * Parses mana cost string, deducts floating mana from `player.resources.manaPool` FIRST,
   * taps the exact minimum number of untapped lands (preferring single-color basic lands
   * over dual/shocklands), and performs an atomic rollback if total mana is insufficient.
   * 
   * @param {string} playerId
   * @param {string} manaCostString
   * @returns {{ success: boolean, tappedLands: Array, tappedLandIds: string[], manaPaid: Record<string, number>, remainingPool: Record<string, number> }}
   */
  autoTapForMana(playerId, manaCostString, options = {}) {
    const player = this.getPlayer(playerId);
    player.resources.manaPool = player.resources.manaPool || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

    const manaPoolBefore = { ...player.resources.manaPool };
    const bLands = Array.isArray(player.battlefield?.lands) ? player.battlefield.lands : [];
    const zLands = Array.isArray(player.zones?.battlefield)
      ? player.zones.battlefield.filter(c => c && ((c.typeLine || c.type || '').toLowerCase().includes('land') || c.subzone === 'lands'))
      : [];

    // Reconcile any lands present in `player.zones.battlefield` into `player.battlefield.lands` so we have a single source of truth
    if (player.battlefield && Array.isArray(player.battlefield.lands)) {
      for (const zl of zLands) {
        if (!player.battlefield.lands.some(bl => bl && (bl === zl || (bl.instanceId && bl.instanceId === zl.instanceId)))) {
          player.battlefield.lands.push(zl);
        }
      }
    }

    // Support options.excludeLandIds filter
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

    const allLands = Array.isArray(player.battlefield?.lands) && player.battlefield.lands.length > 0
      ? player.battlefield.lands
      : zLands;
    const untappedLands = allLands.filter(l => l && !l.isTapped && !isLandExcluded(l));
    const untappedLandsBefore = untappedLands.map(l => ({ instanceId: l.instanceId, name: l.name }));

    let costToPay = manaCostString;
    if (typeof costToPay === 'string' && costToPay.includes('//')) {
      const modeKey = String(options.castMode || options.mode || options.selectedCastMode || options.activeCastMode || '').toUpperCase();
      const parts = costToPay.split('//').map(s => s.trim());
      costToPay = (modeKey === 'ADVENTURE' || modeKey === 'SPLIT_RIGHT') ? parts[1] : parts[0];
    }

    const paymentPlan = CastAvailabilityManager.computeOptimalManaPayment(this, playerId, costToPay, options);

    if (!paymentPlan.canPay) {
      const actionType = paymentPlan.missingColor
        ? 'AUTO_TAP_REJECTED_INSUFFICIENT_COLOR'
        : 'AUTO_TAP_REJECTED_INSUFFICIENT_GENERIC';
      this.recordTrace('MANA_TRACE', actionType, {
        playerId,
        spellCost: manaCostString,
        reason: paymentPlan.reason,
        missingColor: paymentPlan.missingColor || null,
        manaPoolBefore,
        untappedLandsBefore,
        landsTappedByAutoTap: [],
        manaPoolAfter: { ...player.resources.manaPool }
      });
      throw new InsufficientManaError(paymentPlan.reason || `Insufficient mana to pay ${manaCostString}`);
    }

    // If no lands needed to be tapped, floating mana covers the entire spell cost
    if (paymentPlan.taps.length === 0) {
      if (paymentPlan.totalLifeCost > 0) {
        this.adjustLife(playerId, { delta: -paymentPlan.totalLifeCost });
      }
      player.resources.manaPool = { ...paymentPlan.remainingPool };
      this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });
      this.recordTrace('MANA_TRACE', 'AUTO_TAP_SATISFIED_BY_POOL', {
        playerId,
        spellCost: manaCostString,
        manaPoolBefore,
        untappedLandsBefore,
        landsTappedByAutoTap: [],
        manaPoolAfter: { ...player.resources.manaPool }
      });
      return {
        success: true,
        tappedLands: [],
        tappedLandIds: [],
        manaPaid: paymentPlan.manaPaid,
        lifeCostTotal: 0,
        remainingPool: { ...player.resources.manaPool }
      };
    }

    // Commit: tap ONLY the exact selected lands with their chosen ability (0 life for {C}, 1 life only when colored mana is required)
    const manaDeducted = { ...paymentPlan.manaPaid };
    for (const tapStep of paymentPlan.taps) {
      const { land, color, lifeCost } = tapStep;
      land.isTapped = true;
      if (Array.isArray(player.zones?.battlefield)) {
        for (const zc of player.zones.battlefield) {
          if (zc && (zc === land || (land.instanceId && zc.instanceId === land.instanceId))) {
            zc.isTapped = true;
          }
        }
      }
      if (lifeCost > 0) {
        this.adjustLife(playerId, { delta: -lifeCost });
      }
      this.emit('PERMANENT_TAPPED', { playerId, instanceId: land.instanceId, card: land });
      this.emit('LAND_TAPPED', { playerId, instanceId: land.instanceId, card: land, manaAdded: { [color]: 1 }, lifePaid: lifeCost });
    }

    player.resources.manaPool = { ...paymentPlan.remainingPool };
    this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });

    const tappedCards = paymentPlan.taps.map(item => item.land);
    this.recordTrace('MANA_TRACE', 'AUTO_TAP_COMMITTED', {
      playerId,
      spellCost: manaCostString,
      manaPoolBefore,
      untappedLandsBefore,
      landsTappedByAutoTap: paymentPlan.taps.map(t => ({
        instanceId: t.land.instanceId,
        name: t.land.name,
        abilityId: t.abilityId,
        color: t.color,
        lifeCost: t.lifeCost
      })),
      manaPaid: manaDeducted,
      lifeCostTotal: paymentPlan.lifeCostTotal,
      manaPoolAfter: { ...player.resources.manaPool }
    });

    return {
      success: true,
      tappedLands: tappedCards,
      tappedLandIds: tappedCards.map(l => l.instanceId || l.id),
      manaPaid: manaDeducted,
      lifeCostTotal: paymentPlan.lifeCostTotal,
      remainingPool: { ...player.resources.manaPool }
    };
  }

  /**
   * Parses mana cost string into colored and generic requirements.
   * Examples: "{R}" -> { colored: { R: 1 }, generic: 0 }
   *           "{1}{R}" -> { colored: { R: 1 }, generic: 1 }
   *           "{R}{R}" -> { colored: { R: 2 }, generic: 0 }
   *           "{5}{U}{U}" -> { colored: { U: 2 }, generic: 5 }
   * 
   * @param {string} costStr
   * @returns {{ colored: Record<string, number>, generic: number, totalCmc: number }}
   */
  _parseManaCostString(costStr) {
    const colored = {};
    let generic = 0;
    let totalCmc = 0;

    if (!costStr || typeof costStr !== 'string') {
      return { colored, generic, totalCmc };
    }

    const matches = costStr.match(/\{([^}]+)\}/g) || [];
    if (matches.length === 0) {
      // Shorthand e.g. "1R", "RR", "2G"
      const numMatch = costStr.match(/^(\d+)/);
      if (numMatch) {
        generic = parseInt(numMatch[1], 10);
      }
      const letters = costStr.replace(/[0-9]/g, '').toUpperCase().split('');
      for (const char of letters) {
        if (['W', 'U', 'B', 'R', 'G', 'C'].includes(char)) {
          colored[char] = (colored[char] || 0) + 1;
        }
      }
      totalCmc = generic + Object.values(colored).reduce((a, b) => a + b, 0);
      return { colored, generic, totalCmc };
    }

    for (const rawToken of matches) {
      const sym = rawToken.replace(/[{}]/g, '').toUpperCase().trim();
      const num = parseInt(sym, 10);
      if (!isNaN(num)) {
        generic += num;
        totalCmc += num;
      } else if (['W', 'U', 'B', 'R', 'G', 'C'].includes(sym)) {
        colored[sym] = (colored[sym] || 0) + 1;
        totalCmc += 1;
      } else if (sym === 'X') {
        // X = 0 by default unless declared
      }
    }

    return { colored, generic, totalCmc };
  }

  resetTurnQuotas(playerId) {
    const targetPlayers = playerId ? [this.getPlayer(playerId)] : Object.values(this.players);
    for (const player of targetPlayers) {
      if (!player) continue;
      player.landsPlayedThisTurn = 0;
      player.creaturesDiedThisTurn = 0;
      player.maxLandsPerTurn = 1;
      player.landsPerTurnLimit = 1;
      if (player.resources) {
        player.resources.landsPlayedThisTurn = 0;
        player.resources.additionalLandsAllowed = 0;
        player.resources.maxLandsPerTurn = 1;
        player.resources.attackDrawUntilEOT = false;
        player.resources.freeCastAllowed = false;
        player.resources.freeCast = false;
      }
      for (const card of (player.battlefield?.creatures || [])) {
        if (card) card.valiantTriggeredThisTurn = false;
      }
      for (const zoneList of Object.values(player.zones || {})) {
        if (Array.isArray(zoneList)) {
          for (const card of zoneList) {
            if (card) card.valiantTriggeredThisTurn = false;
          }
        }
      }
    }
    for (const p of Object.values(this.players || {})) {
      for (const card of (p.battlefield?.creatures || [])) {
        if (card) card.valiantTriggeredThisTurn = false;
      }
      for (const zoneList of Object.values(p.zones || {})) {
        if (Array.isArray(zoneList)) {
          for (const card of zoneList) {
            if (card) card.valiantTriggeredThisTurn = false;
          }
        }
      }
    }
    return { playerId: playerId || this.activePlayerId, landsPlayedThisTurn: 0 };
  }

  playLand(playerIdOrPayload, instanceIdOrCard, options = {}) {
    if (typeof playerIdOrPayload === 'object' && playerIdOrPayload !== null) {
      return this.dispatch('PLAY_LAND', playerIdOrPayload);
    }
    const instanceId = typeof instanceIdOrCard === 'object' ? instanceIdOrCard.instanceId : instanceIdOrCard;
    const card = typeof instanceIdOrCard === 'object' ? instanceIdOrCard : undefined;
    const payShockCost = options.payShockCost ?? options.pay2Life;
    return this.dispatch('PLAY_LAND', {
      playerId: playerIdOrPayload,
      instanceId,
      card,
      ...(payShockCost !== undefined ? { payShockCost, pay2Life: payShockCost } : {})
    });
  }

  _isTargetLegal(target) {
    if (target === null || target === undefined) return false;

    // Check if target is explicitly a player object
    if (typeof target === 'object' && (target.playerId || target.type === 'PLAYER')) {
      const pid = target.playerId || target.id;
      const player = this.players[pid];
      return Boolean(player && !player.isEliminated);
    }

    const targetId = typeof target === 'string'
      ? target
      : (target.instanceId || target.id || target.targetId || target.card?.instanceId);
    if (!targetId) return false;

    const expectedZone = typeof target === 'object' ? (target.zone || target.expectedZone || null) : null;

    if (expectedZone === 'graveyard') {
      for (const p of Object.values(this.players || {})) {
        if ((p.graveyard || []).some(c => c && (c.instanceId === targetId || c.id === targetId))) {
          return true;
        }
      }
      return false;
    }

    if (expectedZone === 'stack') {
      return (this.stack || []).some(s => s && (s.instanceId === targetId || s.id === targetId || s.card?.instanceId === targetId));
    }

    // Default: Check battlefield across all players
    for (const p of Object.values(this.players || {})) {
      const bf = [
        ...(p.battlefield?.creatures || []),
        ...(p.battlefield?.lands || []),
        ...(p.battlefield?.noncreatures || []),
        ...(p.battlefield?.planeswalkers || [])
      ];
      if (bf.some(c => c && (c.instanceId === targetId || c.id === targetId))) {
        return true;
      }
    }

    // Check if targetId matches an active player
    const player = this.players[targetId];
    if (player && !player.isEliminated) {
      return true;
    }

    // Check if target is on stack (e.g. Counterspell targeting a spell on stack)
    if ((this.stack || []).some(s => s && (s.instanceId === targetId || s.id === targetId || s.card?.instanceId === targetId))) {
      return true;
    }

    return false;
  }

  _onPermanentEnteredBattlefield(card, controllerId) {
    if (!card || !this.abilityEngine) return;

    // a) Register static continuous effects (CR 604)
    const staticEffects = Array.isArray(card.staticEffects)
      ? card.staticEffects
      : (card.staticEffect ? [card.staticEffect] : []);

    for (let i = 0; i < staticEffects.length; i++) {
      const effect = staticEffects[i];
      if (effect) {
        this.abilityEngine.registerStaticEffect({
          ...effect,
          id: effect.id || `static_${card.instanceId}_${i}`,
          sourceId: card.instanceId
        });
      }
    }

    // b) Queue ETB triggered abilities (CR 603)
    if (card.onEnterBattlefield || card.etbTrigger) {
      this.abilityEngine.queueTrigger({
        sourceId: card.instanceId,
        controllerId,
        effect: card.onEnterBattlefield || card.etbTrigger,
        text: `${card.name || 'Permanent'} ETB Trigger`
      });
    }

    // c) Check ON_EQUIPMENT_ETB auto-attach (Sigarda's Aid)
    const isEquip = Boolean(card.compiledMechanics?.isEquipment || /equipment/i.test(card.typeLine || card.type || ''));
    const player = this.getPlayer(controllerId);
    const triggers = card.compiledMechanics?.triggers || [];

    if (isEquip && player) {
      const noncreatures = player.battlefield?.noncreatures || [];
      const sigardasAid = noncreatures.find(p => {
        if (!p) return false;
        if (/sigarda('s|\x27s)?\s+aid/i.test(p.name || '')) return true;
        const pTriggers = p.compiledMechanics?.triggers || [];
        return pTriggers.some(t => t.triggerType === 'ON_EQUIPMENT_ETB' || t.action === 'AUTO_ATTACH_EQUIPMENT');
      });

      if (sigardasAid) {
        const creatures = player.battlefield?.creatures || [];
        if (creatures.length > 0) {
          const candidates = creatures.map(c => {
            const st = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
              ? this.abilityEngine.evaluateCreatureStats(c, this)
              : this.evaluateCreatureStats(c, controllerId);
            return {
              id: c.instanceId || c.id,
              instanceId: c.instanceId || c.id,
              name: c.name,
              pt: `${st.power ?? c.power}/${st.toughness ?? c.toughness}`
            };
          });

          const hasTriggerListener = (this._events?.get?.('TRIGGER_TARGET_REQUIRED')?.length || 0) > 0;
          const isInteractive = (this.interactiveMode === true || (hasTriggerListener && (creatures.length >= 2 || Boolean(card.previousInstanceId)))) && !card?.autoSelectFirstTriggerTarget;

          if (isInteractive) {
            const triggerId = `trig_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
            const choicePayload = {
              triggerId,
              type: 'SIGARDAS_AID_ATTACH',
              sourceName: "Sigarda's Aid",
              sourceId: sigardasAid.instanceId || sigardasAid.id,
              equipmentId: card.instanceId || card.id,
              equipmentName: card.name,
              controllerId,
              isOptional: true,
              candidates
            };
            this.pendingTriggerChoices = this.pendingTriggerChoices || [];
            this.pendingTriggerChoices.push(choicePayload);
            this.emit('TRIGGER_TARGET_REQUIRED', choicePayload);
          } else {
            const targetCr = creatures[0];
            if (targetCr) {
              this.attachPermanentToCreature(controllerId, card.instanceId, targetCr.instanceId, {
                source: 'ON_EQUIPMENT_ETB',
                sourceType: 'ABILITY',
                sourceId: sigardasAid.instanceId || sigardasAid.id,
                isFreeAttach: true
              });
              this.emit('EQUIPMENT_AUTO_ATTACHED', { equipment: card, creature: targetCr, controllerId });
            }
          }
        }
      }
    }

    // d) Forge Anew ETB: Return target Equipment card from your graveyard to the battlefield
    const hasForgeReturn = triggers.some(t => t.action === 'RETURN_EQUIPMENT_FROM_GRAVEYARD') ||
      /when\s+forge\s+anew\s+enters.*return\s+target\s+equipment\s+card\s+from\s+your\s+graveyard\s+to\s+the\s+battlefield/i.test(card.oracleText || '');
    if (hasForgeReturn && player && Array.isArray(player.graveyard)) {
      const equipGraveyard = player.graveyard.filter(c =>
        c && (c.compiledMechanics?.isEquipment || /equipment/i.test(c.typeLine || c.type || ''))
      );
      if (equipGraveyard.length > 0) {
        const isInteractive = ((this._events?.get?.('TRIGGER_TARGET_REQUIRED')?.length || 0) > 0 || this.interactiveMode === true) && equipGraveyard.length >= 2 && !card?.autoSelectFirstTriggerTarget;
        if (isInteractive) {
          const triggerId = `trig_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
          const choicePayload = {
            triggerId,
            type: 'FORGE_ANEW_ETB',
            sourceName: 'Forge Anew',
            sourceId: card.instanceId || card.id,
            controllerId,
            isOptional: true,
            candidates: equipGraveyard.map(e => ({
              id: e.instanceId || e.id,
              instanceId: e.instanceId || e.id,
              name: e.name,
              manaCost: e.manaCost
            }))
          };
          this.pendingTriggerChoices = this.pendingTriggerChoices || [];
          this.pendingTriggerChoices.push(choicePayload);
          this.emit('TRIGGER_TARGET_REQUIRED', choicePayload);
        } else {
          const rawReturned = equipGraveyard[0];
          const equipIdx = player.graveyard.indexOf(rawReturned);
          if (equipIdx !== -1) {
            player.graveyard.splice(equipIdx, 1);
            if (player.zones?.graveyard) {
              player.zones.graveyard = player.zones.graveyard.filter(c => c !== rawReturned && c?.instanceId !== rawReturned.instanceId);
            }
            // Enforce CR 400.7: create clean zone-changed object with new instanceId and clean attachment state
            const returned = ZoneTransitionMatrix.createZoneChangedObject(rawReturned, 'battlefield');
            returned.zone = 'battlefield';
            returned.subzone = 'noncreatures';
            returned.attachedTo = null;
            returned.controllerId = controllerId;
            returned.ownerId = rawReturned.ownerId || controllerId;
            TabletopStateManager.hydrateCardMechanics(returned, this.deckManifests);
            player.battlefield.noncreatures = player.battlefield.noncreatures || [];
            player.battlefield.noncreatures.push(returned);
            if (player.zones) {
              player.zones.battlefield = player.zones.battlefield || [];
              player.zones.battlefield.push(returned);
            }
            this._onPermanentEnteredBattlefield(returned, controllerId);
            this.emit('EQUIPMENT_RETURNED_TO_BATTLEFIELD', { card: returned, source: card, playerId: controllerId });
          }
        }
      }
    }

    // e) Doc Ock's Tentacles: Whenever a creature you control with mana value 5 or greater enters, attach this Equipment to it
    const isCreature = /creature/i.test(card.typeLine || card.type || '');
    const parsedCmc = Number(card.cmc ?? card.manaValue ?? this._parseManaCostString(card.manaCost || '').totalCmc ?? 0);
    if (isCreature && parsedCmc >= 5 && player) {
      const noncreatures = player.battlefield?.noncreatures || [];
      for (const nc of noncreatures) {
        if (nc && (/doc ock's tentacles/i.test(nc.name || '') || nc.compiledMechanics?.triggers?.some(t => t.triggerType === 'ON_CREATURE_MV5_ETB_ATTACH'))) {
          this.attachPermanentToCreature(controllerId, nc.instanceId, card.instanceId, { source: 'ON_CREATURE_MV5_ETB_ATTACH' });
          this.emit('EQUIPMENT_AUTO_ATTACHED', { equipment: nc, creature: card, controllerId });
        }
      }
    }

    // f) Soul-Guide Lantern ETB: Exile target card from a graveyard
    const hasSoulGuideETB = triggers.some(t => t.action === 'EXILE_TARGET_GRAVEYARD_CARD') ||
      /when\s+soul-guide\s+lantern\s+enters.*exile\s+target\s+card\s+from\s+a\s+graveyard/i.test(card.oracleText || '');
    if (hasSoulGuideETB) {
      for (const [oppPid, opp] of Object.entries(this.players || {})) {
        if (oppPid !== controllerId && !opp.isEliminated && Array.isArray(opp.graveyard) && opp.graveyard.length > 0) {
          const [exiled] = opp.graveyard.splice(0, 1);
          if (opp.zones?.graveyard) {
            opp.zones.graveyard = opp.zones.graveyard.filter(c => c !== exiled && c?.instanceId !== exiled.instanceId);
          }
          opp.exile = opp.exile || [];
          opp.exile.push(exiled);
          if (opp.zones) opp.zones.exile = opp.exile;
          this.emit('CARD_EXILED_FROM_GRAVEYARD', { card: exiled, targetPlayerId: oppPid });
          break;
        }
      }
    }

    // g) Invasion of Gobakhan (Battle — Siege): Enters with defense counters and exiles nonland card from opponent's hand with {2} tax
    const isBattle = /battle/i.test(card.typeLine || card.type || '') || /invasion of gobakhan/i.test(card.name || '');
    if (isBattle) {
      const initDefense = Number(card.defense || card.cardFaces?.[0]?.defense || 3);
      card.defense = initDefense;
      card.counters = card.counters || {};
      card.counters.defense = initDefense;
      for (const [oppPid, opp] of Object.entries(this.players || {})) {
        if (oppPid !== controllerId && !opp.isEliminated && Array.isArray(opp.hand) && opp.hand.length > 0) {
          const nonlandIdx = opp.hand.findIndex(c => c && !/land/i.test(c.typeLine || c.type || ''));
          if (nonlandIdx !== -1) {
            const [exiled] = opp.hand.splice(nonlandIdx, 1);
            if (opp.zones?.hand) {
              opp.zones.hand = opp.zones.hand.filter(c => c !== exiled && c?.instanceId !== exiled.instanceId);
            }
            exiled.castTaxGeneric = 2;
            exiled.mayBePlayedFromExile = true;
            opp.exile = opp.exile || [];
            opp.exile.push(exiled);
            if (opp.zones) opp.zones.exile = opp.exile;
            this.emit('BATTLE_EXILED_HAND_CARD', { card: exiled, targetPlayerId: oppPid, castTaxGeneric: 2 });
            break;
          }
        }
      }
    }
  }

  /**
   * Dispatches Valiant trigger on a creature if it has not already triggered this turn.
   * 
   * @param {Object} creature
   * @param {Object|string} source
   * @param {string} playerId
   * @returns {boolean} Whether Valiant triggered
   * @private
   */
  _triggerValiantIfEligible(creature, source, playerId) {
    const turnKey = `${this.turnNumber || 1}`;
    if (!creature || creature.valiantTriggeredThisTurn || creature._valiantTriggeredTurn === turnKey) return false;
    const triggers = creature.compiledMechanics?.triggers || [];
    const valiantTrigger = triggers.find(t => t.triggerType === 'ON_BECOMES_TARGET') ||
      (/becomes\s+the\s+target\s+of\s+a\s+spell\s+or\s+ability\s+you\s+control/i.test(creature.oracleText || creature.text || '')
        ? { triggerType: 'ON_BECOMES_TARGET', action: 'ADD_COUNTER', counterType: '+1/+1', count: 1 }
        : null);

    if (valiantTrigger) {
      creature.valiantTriggeredThisTurn = true;
      creature._valiantTriggeredTurn = turnKey;
      creature.counters = creature.counters || {};
      const count = Number(valiantTrigger.count || 1);
      const cType = valiantTrigger.counterType || '+1/+1';
      creature.counters[cType] = (creature.counters[cType] || 0) + count;

      const evaluated = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
        ? this.abilityEngine.evaluateCreatureStats(creature, this)
        : (typeof AbilityEngine.evaluateCreatureStats === 'function'
            ? AbilityEngine.evaluateCreatureStats(creature, this)
            : this.evaluateCreatureStats(creature, this));
      creature.effectivePower = evaluated.power ?? evaluated.effectivePower ?? creature.power;
      creature.effectiveToughness = evaluated.toughness ?? evaluated.effectiveToughness ?? creature.toughness;

      const logPayload = {
        creatureId: creature.instanceId,
        creatureName: creature.name,
        sourceId: source?.instanceId || source?.id || (typeof source === 'string' ? source : null),
        sourceName: source?.name || 'Spell or Ability',
        counterType: cType,
        count,
        newCount: creature.counters[cType]
      };
      this.recordTrace('TRIGGER_TRACE', 'VALIANT_TRIGGERED', logPayload);
      this.emit('VALIANT_TRIGGERED', { creature, source, playerId, counterType: cType, count });
      this.emit('COUNTER_ADDED', {
        instanceId: creature.instanceId,
        card: creature,
        counterType: cType,
        count,
        total: creature.counters[cType]
      });
      return true;
    }
    return false;
  }

  /**
   * Attaches an Equipment or Aura on the battlefield to a target creature (CR 701.3 / CR 301.5).
   * 
   * @param {string} playerId
   * @param {string} equipmentId
   * @param {string} targetCreatureId
   * @param {Object} [options={}]
   * @returns {{ success: boolean, equipment: Object, targetCreature: Object, stats: Object }}
   */
  attachPermanentToCreature(playerId, equipmentId, targetCreatureId, options = {}) {
    const player = this.getPlayer(playerId);

    let equipment = null;
    const playerNoncreatures = [
      ...(player.battlefield?.noncreatures || []),
      ...(Array.isArray(player.battlefield) ? player.battlefield.filter(c => !/creature/i.test(c?.typeLine || c?.type || '')) : []),
      ...(player.zones?.battlefield?.filter(c => !/creature/i.test(c?.typeLine || c?.type || '')) || [])
    ];
    equipment = playerNoncreatures.find(c => c && (c.instanceId === equipmentId || c.id === equipmentId));
    if (!equipment) {
      for (const p of Object.values(this.players || {})) {
        const ncList = [
          ...(p.battlefield?.noncreatures || []),
          ...(Array.isArray(p.battlefield) ? p.battlefield.filter(c => !/creature/i.test(c?.typeLine || c?.type || '')) : []),
          ...(p.zones?.battlefield?.filter(c => !/creature/i.test(c?.typeLine || c?.type || '')) || [])
        ];
        const found = ncList.find(c => c && (c.instanceId === equipmentId || c.id === equipmentId));
        if (found) {
          equipment = found;
          break;
        }
      }
    }
    if (!equipment) {
      throw new CardNotFoundError(`Permanent with instanceId ${equipmentId} not found on battlefield`);
    }

    let targetCreature = null;
    const playerCreatures = [
      ...(player.battlefield?.creatures || []),
      ...(Array.isArray(player.battlefield) ? player.battlefield.filter(c => /creature/i.test(c?.typeLine || c?.type || '')) : []),
      ...(player.zones?.battlefield?.filter(c => /creature/i.test(c?.typeLine || c?.type || '')) || [])
    ];
    targetCreature = playerCreatures.find(c => c && (c.instanceId === targetCreatureId || c.id === targetCreatureId));
    if (!targetCreature) {
      for (const p of Object.values(this.players || {})) {
        const crList = [
          ...(p.battlefield?.creatures || []),
          ...(Array.isArray(p.battlefield) ? p.battlefield.filter(c => /creature/i.test(c?.typeLine || c?.type || '')) : []),
          ...(p.zones?.battlefield?.filter(c => /creature/i.test(c?.typeLine || c?.type || '')) || [])
        ];
        const found = crList.find(c => c && (c.instanceId === targetCreatureId || c.id === targetCreatureId));
        if (found) {
          targetCreature = found;
          break;
        }
      }
    }
    if (!targetCreature) {
      throw new CardNotFoundError(`Target creature with instanceId ${targetCreatureId} not found on battlefield`);
    }

    // Clean previous creature attachment if any
    if (equipment.attachedTo && equipment.attachedTo !== targetCreature.instanceId) {
      const prevId = equipment.attachedTo;
      for (const p of Object.values(this.players || {})) {
        const crList = p.battlefield?.creatures || [];
        const prevCr = crList.find(c => c && (c.instanceId === prevId || c.id === prevId));
        if (prevCr && Array.isArray(prevCr.attachedCards)) {
          prevCr.attachedCards = prevCr.attachedCards.filter(item => {
            const id = typeof item === 'string' ? item : (item?.instanceId || item?.id);
            return id !== equipment.instanceId && id !== equipment.id && item !== equipment;
          });
        }
      }
    }

    equipment.attachedTo = targetCreature.instanceId;

    targetCreature.attachedCards = targetCreature.attachedCards || [];
    const alreadyAttached = targetCreature.attachedCards.some(item => {
      const id = typeof item === 'string' ? item : (item?.instanceId || item?.id);
      return id === equipment.instanceId || id === equipment.id || item === equipment;
    });
    if (!alreadyAttached) {
      targetCreature.attachedCards.push(equipment);
    }

    const creatureController = targetCreature.controllerId || targetCreature.ownerId || playerId;
    if (creatureController === playerId && !targetCreature.valiantTriggeredThisTurn && options.triggersTargeting !== false) {
      this._triggerValiantIfEligible(targetCreature, equipment, playerId);
    }

    if (this.abilityEngine && typeof this.abilityEngine.evaluateAllLayers === 'function') {
      this.abilityEngine.evaluateAllLayers(this);
    }

    if (targetCreature.basePower === undefined) targetCreature.basePower = Number(targetCreature.power) || 0;
    if (targetCreature.baseToughness === undefined) targetCreature.baseToughness = Number(targetCreature.toughness) || 0;

    const stats = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
      ? this.abilityEngine.evaluateCreatureStats(targetCreature, this)
      : (typeof AbilityEngine.evaluateCreatureStats === 'function'
          ? AbilityEngine.evaluateCreatureStats(targetCreature, this)
          : this.evaluateCreatureStats(targetCreature, playerId));
    targetCreature.effectivePower = stats.power ?? stats.effectivePower;
    targetCreature.effectiveToughness = stats.toughness ?? stats.effectiveToughness;
    targetCreature.power = stats.power;
    targetCreature.toughness = stats.toughness;
    targetCreature.keywords = { ...stats.keywords };

    const logEntry = {
      sequenceId: ++this.sequenceCounter,
      actionType: 'PERMANENT_ATTACHED',
      playerId,
      payload: {
        equipmentId: equipment.instanceId,
        targetCreatureId: targetCreature.instanceId,
        options,
        stats
      },
      timestamp: Date.now()
    };
    this.actionLog.push(logEntry);
    this._notifySubscribers(logEntry, { equipment, targetCreature, stats });
    this.emit('PERMANENT_ATTACHED', { source: equipment, equipment, target: targetCreature, targetCreature, stats, playerId });

    this.runSBACheck();

    return {
      success: true,
      equipment,
      targetCreature,
      stats
    };
  }

  attachPermanent(sourceInstanceId, targetCreatureInstanceId) {
    let controllerId = this.activePlayerId;
    for (const [pid, p] of Object.entries(this.players || {})) {
      const allBattlefield = [
        ...(p.battlefield?.noncreatures || []),
        ...(p.battlefield?.creatures || [])
      ];
      if (allBattlefield.some(c => c && (c.instanceId === sourceInstanceId || c.id === sourceInstanceId))) {
        controllerId = pid;
        break;
      }
    }
    const res = this.attachPermanentToCreature(controllerId, sourceInstanceId, targetCreatureInstanceId);
    return { success: res.success, source: res.equipment, target: res.targetCreature };
  }

  detachPermanent(equipmentIdOrCard, options = {}) {
    let equipment = null;
    let equipmentId = null;
    if (typeof equipmentIdOrCard === 'object' && equipmentIdOrCard !== null) {
      equipment = equipmentIdOrCard;
      equipmentId = equipment.instanceId || equipment.id;
    } else {
      equipmentId = equipmentIdOrCard;
    }

    if (!equipment) {
      const found = this.findPermanentById(equipmentId);
      if (found && found.card) {
        equipment = found.card;
      }
    }

    if (!equipment) {
      throw new CardNotFoundError(`Permanent with instanceId ${equipmentId} not found on battlefield`);
    }

    const prevTargetId = equipment.attachedTo;
    equipment.attachedTo = null;

    let targetCreature = null;
    if (prevTargetId) {
      for (const p of Object.values(this.players || {})) {
        const crList = [
          ...(p.battlefield?.creatures || []),
          ...(p.zones?.battlefield?.filter(c => /creature/i.test(c?.typeLine || c?.type || '')) || [])
        ];
        const foundCr = crList.find(c => c && (c.instanceId === prevTargetId || c.id === prevTargetId));
        if (foundCr) {
          targetCreature = foundCr;
          if (Array.isArray(foundCr.attachedCards)) {
            foundCr.attachedCards = foundCr.attachedCards.filter(item => {
              const id = typeof item === 'string' ? item : (item?.instanceId || item?.id);
              return id !== equipment.instanceId && id !== equipment.id && item !== equipment;
            });
          }
          break;
        }
      }
    }

    if (this.abilityEngine && typeof this.abilityEngine.evaluateAllLayers === 'function') {
      this.abilityEngine.evaluateAllLayers(this);
    }

    let stats = null;
    if (targetCreature) {
      const evaluated = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
        ? this.abilityEngine.evaluateCreatureStats(targetCreature, this)
        : (typeof AbilityEngine.evaluateCreatureStats === 'function'
            ? AbilityEngine.evaluateCreatureStats(targetCreature, this)
            : this.evaluateCreatureStats(targetCreature, targetCreature.controllerId));
      targetCreature.effectivePower = evaluated.power ?? evaluated.effectivePower ?? targetCreature.power;
      targetCreature.effectiveToughness = evaluated.toughness ?? evaluated.effectiveToughness ?? targetCreature.toughness;
      targetCreature.power = targetCreature.effectivePower;
      targetCreature.toughness = targetCreature.effectiveToughness;
      targetCreature.keywords = { ...(evaluated.keywords || targetCreature.keywords || {}) };
      stats = evaluated;
    }

    this.emit('PERMANENT_DETACHED', { equipment, targetCreature, creature: targetCreature });
    this.runSBACheck();

    return { success: true, equipment, targetCreature, stats };
  }

  /**
   * Returns valid target candidates for targeted spells (supporting dual-target cards like Stolen Uniform & Resolute Strike).
   *
   * @param {string} playerId
   * @param {Object} card
   * @returns {Object}
   */
  getValidTargetCandidatesForCard(playerId, card) {
    if (!card) return { requiresDualTarget: false, candidates: [] };
    const nameLower = (card.name || '').trim().toLowerCase();
    const oracleLower = (card.oracleText || card.oracle_text || card.text || '').toLowerCase();
    const player = this.getPlayer(playerId);

    const isStolenUniform = nameLower === 'stolen uniform' ||
      /gain control of that equipment until end of turn/i.test(oracleLower);

    if (isStolenUniform) {
      const step1Candidates = [];
      const seen1 = new Set();
      const pCreatures = [
        ...(player?.battlefield?.creatures || []),
        ...(player?.zones?.battlefield?.filter(c => /creature/i.test(c?.typeLine || c?.type || '')) || [])
      ];
      for (const c of pCreatures) {
        if (!c) continue;
        const id = c.instanceId || c.id;
        if (id && !seen1.has(id)) {
          seen1.add(id);
          step1Candidates.push(c);
        }
      }

      const step2Candidates = [];
      const seen2 = new Set();
      for (const [pid, pl] of Object.entries(this.players || {})) {
        const noncreatures = [
          ...(pl?.battlefield?.noncreatures || []),
          ...(pl?.zones?.battlefield?.filter(c => !/creature/i.test(c?.typeLine || c?.type || '')) || [])
        ];
        for (const c of noncreatures) {
          if (!c) continue;
          const isEquip = c.compiledMechanics?.isEquipment || /equipment/i.test(c.typeLine || c.type || '');
          const id = c.instanceId || c.id;
          if (isEquip && id && !seen2.has(id)) {
            seen2.add(id);
            c.ownerName = pl.name || pid;
            step2Candidates.push(c);
          }
        }
      }

      return {
        requiresDualTarget: true,
        step1Prompt: 'Select target creature you control',
        step1Candidates,
        step2Prompt: 'Select target Equipment on the battlefield',
        step2Candidates
      };
    }

    const isResoluteStrike = nameLower === 'resolute strike' ||
      /if it's a warrior, you may attach (?:an|target) equipment/i.test(oracleLower);

    if (isResoluteStrike) {
      const step1Candidates = [];
      const seen1 = new Set();
      for (const pl of Object.values(this.players || {})) {
        const creatures = [
          ...(pl?.battlefield?.creatures || []),
          ...(pl?.zones?.battlefield?.filter(c => /creature/i.test(c?.typeLine || c?.type || '')) || [])
        ];
        for (const c of creatures) {
          if (!c) continue;
          const id = c.instanceId || c.id;
          if (id && !seen1.has(id)) {
            seen1.add(id);
            step1Candidates.push(c);
          }
        }
      }

      const step2Candidates = [];
      const seen2 = new Set();
      const pNoncreatures = [
        ...(player?.battlefield?.noncreatures || []),
        ...(player?.zones?.battlefield?.filter(c => !/creature/i.test(c?.typeLine || c?.type || '')) || [])
      ];
      for (const c of pNoncreatures) {
        if (!c) continue;
        const isEquip = c.compiledMechanics?.isEquipment || /equipment/i.test(c.typeLine || c.type || '');
        const id = c.instanceId || c.id;
        if (isEquip && id && !seen2.has(id)) {
          seen2.add(id);
          c.ownerName = player.name || playerId;
          step2Candidates.push(c);
        }
      }

      return {
        requiresDualTarget: true,
        step1Prompt: 'Select target creature',
        step1Candidates,
        step2Prompt: 'Select target Equipment you control (if creature is a Warrior)',
        step2Candidates
      };
    }

    return {
      requiresDualTarget: false,
      candidates: []
    };
  }

  /**
   * Generates legal action combination tuples for multi-target or sacrifice-target spells
   * (e.g. Burn Together sacrifice + damage target, Stolen Uniform / Resolute Strike equipment + creature target).
   *
   * @param {string} playerId
   * @param {Object} card
   * @param {string} [castMode=null]
   * @returns {Array<Object>}
   */
  getActionCombinationsForSpell(playerId, card, castMode = null) {
    if (!card) return [];
    const player = this.getPlayer(playerId);
    if (!player) return [];

    const effectiveMode = String(castMode || card.selectedCastMode || card.activeCastMode || '').toUpperCase();
    if (effectiveMode === 'MAIN') return [];
    const nameLower = (card.name || '').toLowerCase();
    const oracleLower = (card.oracleText || card.text || '').toLowerCase();

    const isBurnTogether =
      effectiveMode === 'ADVENTURE' ||
      nameLower === 'burn together' ||
      (effectiveMode !== 'MAIN' && (
        nameLower.includes('burn together') ||
        /burn together/i.test(oracleLower)
      ));

    if (isBurnTogether) {
      const combinations = [];
      const controlledCreatures = [
        ...(player.battlefield?.creatures || []),
        ...(player.zones?.battlefield?.filter(c => /creature/i.test(c?.typeLine || c?.type || '')) || [])
      ];

      const seenCr = new Set();
      const uniqueCreatures = [];
      for (const cr of controlledCreatures) {
        if (!cr) continue;
        const cid = cr.instanceId || cr.id;
        if (cid && !seenCr.has(cid)) {
          seenCr.add(cid);
          uniqueCreatures.push(cr);
        }
      }

      const targets = [];
      // 1. Each non-eliminated opponent
      for (const [pid, p] of Object.entries(this.players || {})) {
        if (pid !== playerId && !p.isEliminated) {
          targets.push({
            targetId: pid,
            targetName: p.name || p.playerName || ('Player ' + pid),
            targetType: 'PLAYER'
          });
        }
      }

      // 2. Each creature on the battlefield of any player
      for (const [pid, p] of Object.entries(this.players || {})) {
        if (p.isEliminated) continue;
        const pCreatures = [
          ...(p.battlefield?.creatures || []),
          ...(p.zones?.battlefield?.filter(c => /creature/i.test(c?.typeLine || c?.type || '')) || [])
        ];
        const seenTargetCr = new Set();
        for (const cr of pCreatures) {
          if (!cr) continue;
          const cid = cr.instanceId || cr.id;
          if (cid && !seenTargetCr.has(cid)) {
            seenTargetCr.add(cid);
            targets.push({
              targetId: cid,
              targetName: cr.name || 'Creature',
              targetType: 'CREATURE'
            });
          }
        }
      }

      for (const cr of uniqueCreatures) {
        const cid = cr.instanceId || cr.id;
        const stats = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
          ? this.abilityEngine.evaluateCreatureStats(cr, this)
          : (typeof AbilityEngine !== 'undefined' && typeof AbilityEngine.evaluateCreatureStats === 'function'
              ? AbilityEngine.evaluateCreatureStats(cr, this)
              : this.evaluateCreatureStats(cr, playerId));
        const effectivePower = Math.max(0, Number(stats?.power ?? stats?.effectivePower ?? cr.effectivePower ?? cr.power ?? 0));

        for (const tgt of targets) {
          combinations.push({
            id: `comb_${cid}_${tgt.targetId}`,
            creatureId: cid,
            creatureName: cr.name || 'Creature',
            effectivePower,
            targetId: tgt.targetId,
            targetName: tgt.targetName,
            targetType: tgt.targetType,
            label: `🔥 Sacrificar ${cr.name || 'Creature'} (${effectivePower} DMG) ➔ Dañar a ${tgt.targetName}`
          });
        }
      }

      return combinations;
    }

    const isStolenUniform =
      nameLower === 'stolen uniform' ||
      /gain control of that equipment until end of turn/i.test(oracleLower);

    const isResoluteStrike =
      nameLower === 'resolute strike' ||
      /if it's a warrior, you may attach (?:an|target) equipment/i.test(oracleLower);

    if (isStolenUniform || isResoluteStrike) {
      const combinations = [];
      const controlledCreatures = [
        ...(player.battlefield?.creatures || []),
        ...(player.zones?.battlefield?.filter(c => /creature/i.test(c?.typeLine || c?.type || '')) || [])
      ];
      const seenCr = new Set();
      const eligibleCreatures = [];
      for (const cr of controlledCreatures) {
        if (!cr) continue;
        const cid = cr.instanceId || cr.id;
        if (cid && !seenCr.has(cid)) {
          seenCr.add(cid);
          if (isResoluteStrike) {
            const isWarrior = /\bwarrior\b/i.test(cr.typeLine || cr.type || '') ||
              (this.abilityEngine && /\bwarrior\b/i.test((this.abilityEngine.evaluatePermanentLayers(cr, this)?.subtypes || []).join(' ')));
            if (isWarrior) {
              eligibleCreatures.push(cr);
            }
          } else {
            eligibleCreatures.push(cr);
          }
        }
      }

      if (isResoluteStrike && eligibleCreatures.length === 0) {
        for (const cr of controlledCreatures) {
          if (!cr) continue;
          const cid = cr.instanceId || cr.id;
          if (cid && !eligibleCreatures.some(c => (c.instanceId || c.id) === cid)) {
            eligibleCreatures.push(cr);
          }
        }
      }

      const equipments = [];
      const seenEq = new Set();
      const targetPlayers = isStolenUniform
        ? Object.values(this.players || {})
        : [player];

      for (const p of targetPlayers) {
        const noncreatures = [
          ...(p.battlefield?.noncreatures || []),
          ...(p.zones?.battlefield?.filter(c => !/creature/i.test(c?.typeLine || c?.type || '')) || [])
        ];
        for (const nc of noncreatures) {
          if (!nc) continue;
          const isEquip = Boolean(nc.compiledMechanics?.isEquipment || /equipment/i.test(nc.typeLine || nc.type || ''));
          const eid = nc.instanceId || nc.id;
          if (isEquip && eid && !seenEq.has(eid)) {
            seenEq.add(eid);
            equipments.push(nc);
          }
        }
      }

      for (const eq of equipments) {
        const eqId = eq.instanceId || eq.id;
        for (const cr of eligibleCreatures) {
          const crId = cr.instanceId || cr.id;
          combinations.push({
            id: `comb_${eqId}_${crId}`,
            equipmentId: eqId,
            equipmentName: eq.name || 'Equipment',
            creatureId: crId,
            creatureName: cr.name || 'Creature',
            label: `🛡️ Anexar ${eq.name || 'Equipment'} ➔ a ${cr.name || 'Creature'}`
          });
        }
      }

      return combinations;
    }

    return [];
  }

  handleStackResolution(resolvedItem) {
    if (!resolvedItem) return null;
    const originalCard = resolvedItem.card || resolvedItem;
    const controllerId = resolvedItem.controllerId || resolvedItem.sourcePlayerId || originalCard.controllerId || originalCard.ownerId || this.activePlayerId;
    const player = this.getPlayer(controllerId);

    const isNonCardTriggerOrAbility = Boolean(
      resolvedItem.type === 'PERK_UPKEEP_TRIGGER' ||
      resolvedItem.type === 'PERK_EFFECT_TRIGGER' ||
      resolvedItem.type === 'TRIGGERED_ABILITY' ||
      resolvedItem.type === 'ABILITY' ||
      resolvedItem.isTrigger ||
      resolvedItem.isEmblemTrigger ||
      originalCard?.type === 'PERK_UPKEEP_TRIGGER' ||
      originalCard?.type === 'PERK_EFFECT_TRIGGER' ||
      originalCard?.isTrigger ||
      originalCard?.isEmblemTrigger
    );

    const topItem = resolvedItem;
    this.recordTrace('STACK_TRACE', 'STACK_ITEM_RESOLVED', {
      itemId: topItem.id || topItem.instanceId || originalCard.instanceId,
      name: topItem.name || topItem.card?.name || originalCard.name || topItem.type,
      type: topItem.type || 'SPELL',
      controllerId: topItem.controllerId || topItem.ownerId || controllerId
    });

    // ── Idempotency guard ──────────────────────────────────────────────
    // Prevent duplicate zone placement when handleStackResolution is
    // invoked more than once for the same item (e.g. by both PSM.resolveTop
    // and a subscriber in app.js).
    //
    // Step 1: Try to remove the item from TSM's own stack.
    const stackIdx = this.stack.findIndex(c => c && (
      c === originalCard ||
      c === resolvedItem ||
      (originalCard.instanceId && c.instanceId === originalCard.instanceId) ||
      (resolvedItem.id && (c.id === resolvedItem.id || c.instanceId === resolvedItem.id)) ||
      (resolvedItem.instanceId && (c.instanceId === resolvedItem.instanceId || c.id === resolvedItem.instanceId))
    ));
    if (stackIdx !== -1) {
      this.stack.splice(stackIdx, 1);
    } else if (!isNonCardTriggerOrAbility) {
      // Step 2: Item was not on TSM's stack (it likely lived only on PSM's
      // stack and was already popped by resolveTop).  Guard against a
      // duplicate call by checking whether the card has already landed in
      // its destination zone.
      const allBattlefield = [
        ...(player.battlefield?.creatures || []),
        ...(player.battlefield?.lands || []),
        ...(player.battlefield?.noncreatures || []),
        ...(player.battlefield?.planeswalkers || [])
      ];
      const hasValidId = Boolean(originalCard.instanceId);
      const alreadyOnField = hasValidId && allBattlefield.some(c => c && (
        (c.instanceId && c.instanceId === originalCard.instanceId) ||
        (c.previousInstanceId && c.previousInstanceId === originalCard.instanceId)
      ));
      const alreadyInGY = hasValidId && (player.graveyard || []).some(c => c && (
        (c.instanceId && c.instanceId === originalCard.instanceId) ||
        (c.previousInstanceId && c.previousInstanceId === originalCard.instanceId)
      ));
      if (alreadyOnField || alreadyInGY) {
        // Already resolved — nothing to do.
        return null;
      }
    }

    TabletopStateManager.hydrateCardMechanics(originalCard);
    const typeLine = String(originalCard.typeLine || originalCard.type || '').toLowerCase();
    const isInstantOrSorcery = typeLine.includes('instant') || typeLine.includes('sorcery');
    const isAura = typeLine.includes('aura') || /aura/i.test(originalCard.subtype || '');
    const isTargetableSpell = isInstantOrSorcery || isAura;

    // ── CR 608.2b — Target Validation & Fizzle Rule ────────────────────
    const rawTargets = resolvedItem.targets || originalCard.targets || originalCard.annotations?.castTargets;
    const hasTargets = !isNonCardTriggerOrAbility && isTargetableSpell && Array.isArray(rawTargets) && rawTargets.length > 0;
    let legalTargets = [];

    if (hasTargets) {
      legalTargets = rawTargets.filter(t => this._isTargetLegal(t));
      if (legalTargets.length === 0) {
        // All targets are illegal: Spell Fizzles per CR 608.2b
        if (isTargetableSpell) {
          const cardToGrave = ZoneTransitionMatrix.createZoneChangedObject(originalCard, 'graveyard');
          player.graveyard.push(cardToGrave);
          if (player.zones?.graveyard) player.zones.graveyard.push(cardToGrave);
        }

        const logEntry = {
          sequenceId: ++this.sequenceCounter,
          actionType: 'SPELL_FIZZLED',
          rule: 'CR 608.2b',
          playerId: controllerId,
          card: originalCard,
          reason: 'ALL_TARGETS_ILLEGAL',
          timestamp: Date.now()
        };
        this.actionLog.push(logEntry);
        this._notifySubscribers(logEntry, { card: originalCard, fizzled: true, reason: 'ALL_TARGETS_ILLEGAL' });
        this.emit('SPELL_FIZZLED', logEntry);

        this.runSBACheck();
        return { card: originalCard, fizzled: true, reason: 'ALL_TARGETS_ILLEGAL' };
      }
    }

    // Check Valiant / ON_BECOMES_TARGET triggers on controller's creatures (e.g. Heartfire Hero)
    if (rawTargets && rawTargets.length > 0) {
      for (const t of rawTargets) {
        const tid = typeof t === 'string' ? t : (t?.instanceId || t?.id || t?.targetId);
        if (!tid) continue;
        const targetCr = (player.battlefield?.creatures || []).find(c => c && (c.instanceId === tid || c.id === tid));
        if (targetCr) {
          const valiantTrigger = (targetCr.compiledMechanics?.triggers || []).find(tr => tr.triggerType === 'ON_BECOMES_TARGET');
          if (valiantTrigger && !targetCr.valiantTriggeredThisTurn) {
            targetCr.valiantTriggeredThisTurn = true;
            if (valiantTrigger.action === 'ADD_COUNTER') {
              targetCr.counters = targetCr.counters || {};
              targetCr.counters['+1/+1'] = (targetCr.counters['+1/+1'] || 0) + (valiantTrigger.count || 1);
              this.emit('COUNTER_ADDED', { card: targetCr, counterType: '+1/+1', count: valiantTrigger.count || 1 });
            }
          }
        }
      }
    }

    // ── CR 608.2 — Effect Execution ─────────────────────────────────────
    const effect = resolvedItem.effect || originalCard.effect;
    if (typeof effect === 'function') {
      effect(this, resolvedItem);
    } else if (typeof resolvedItem.onResolve === 'function') {
      resolvedItem.onResolve(this, resolvedItem);
    } else if (effect && typeof effect === 'object') {
      const effectType = String(effect.type || effect.action || '').toUpperCase();
      const firstTarget = rawTargets && rawTargets[0];
      let defaultTargetId = effect.targetId || effect.instanceId || (typeof firstTarget === 'string' ? firstTarget : (firstTarget?.instanceId || firstTarget?.id || firstTarget?.targetId));

      switch (effectType) {
        case 'DEAL_DAMAGE': {
          const amount = Number(effect.amount ?? effect.damage ?? effect.value ?? 0);
          let oppPid = null;
          if (this.combatState?.defendingPlayerId && !this.players[this.combatState.defendingPlayerId]?.isEliminated) {
            oppPid = this.combatState.defendingPlayerId;
          } else {
            const playerList = Object.keys(this.players || {});
            oppPid = playerList.find(pid => pid !== controllerId && !this.players[pid]?.isEliminated)
              || this._priorityMachine?.players?.find(pid => pid !== controllerId && !this.players[pid]?.isEliminated);
          }

          if (!defaultTargetId && oppPid) {
            defaultTargetId = oppPid;
          }
          let targetsToApply = effect.targetId ? [effect.targetId] : (legalTargets && legalTargets.length > 0 ? legalTargets : (defaultTargetId ? [defaultTargetId] : []));
          if ((!targetsToApply || targetsToApply.length === 0 || !targetsToApply[0]) && oppPid) {
            targetsToApply = [oppPid];
          }

          for (const t of targetsToApply) {
            const tid = typeof t === 'string' ? t : (t?.instanceId || t?.id || t?.targetId || t?.playerId);
            const effectiveTargetId = tid || oppPid;
            if (!effectiveTargetId) continue;

            let targetPerm = null;
            for (const p of Object.values(this.players || {})) {
              const bf = [
                ...(p.battlefield?.creatures || []),
                ...(p.battlefield?.lands || []),
                ...(p.battlefield?.noncreatures || []),
                ...(p.battlefield?.planeswalkers || [])
              ];
              const found = bf.find(c => c && (c.instanceId === effectiveTargetId || c.id === effectiveTargetId));
              if (found) {
                targetPerm = found;
                break;
              }
            }

            if (targetPerm) {
              targetPerm.damageMarked = (targetPerm.damageMarked || 0) + amount;
            } else {
              const targetPlayer = this.players[effectiveTargetId] || (t?.playerId && this.players[t.playerId]) || (effect.playerId && this.players[effect.playerId]) || this.players[oppPid];
              if (targetPlayer) {
                const targetPid = targetPlayer.id || targetPlayer.playerId || effectiveTargetId;
                this.adjustLife(targetPid, { delta: -amount });
                this.emit('LIFE_LOST', { playerId: targetPid, amount, newLife: targetPlayer.resources?.life });
                this.emit('DAMAGE_DEALT', { sourceId: originalCard.instanceId, sourceControllerId: controllerId, targetId: targetPid, targetType: 'PLAYER', amount });

                const damageLog = {
                  sequenceId: ++this.sequenceCounter,
                  actionType: 'DAMAGE_DEALT',
                  playerId: targetPid,
                  payload: {
                    sourceId: originalCard.instanceId,
                    sourceControllerId: controllerId,
                    targetId: targetPid,
                    targetType: 'PLAYER',
                    amount,
                    newLife: targetPlayer.resources?.life
                  },
                  timestamp: Date.now()
                };
                this.actionLog.push(damageLog);
                this._notifySubscribers(damageLog, { targetId: targetPid, amount, newLife: targetPlayer.resources?.life });
              }
            }
          }
          break;
        }

        case 'DRAW_CARD': {
          const drawPid = effect.playerId || effect.targetPlayerId || (typeof defaultTargetId === 'string' && this.players[defaultTargetId] ? defaultTargetId : null) || controllerId;
          const drawCount = Number(effect.amount ?? effect.count ?? effect.value ?? 1);
          this.drawCard(drawPid, drawCount);
          break;
        }

        case 'DESTROY_TARGET': {
          const targetsToDestroy = effect.targetId ? [effect.targetId] : (legalTargets && legalTargets.length > 0 ? legalTargets : [defaultTargetId]);
          for (const t of targetsToDestroy) {
            const tid = typeof t === 'string' ? t : (t?.instanceId || t?.id || t?.targetId);
            if (!tid) continue;
            for (const [pid, p] of Object.entries(this.players || {})) {
              const found = ZoneModel.findCard(p, tid);
              if (found && found.zone === 'battlefield') {
                if (/creature/i.test(found.card.typeLine || found.card.type || '')) {
                  this.handleCreatureDeath(found.card, pid);
                }
                this.abilityEngine?.unregisterEffectsFromSource(tid);
                ZoneTransitionMatrix.moveCard(p, tid, 'battlefield', 'graveyard');
                this.emit('PERMANENT_DESTROYED', { playerId: pid, cardId: tid });
                break;
              }
            }
          }
          break;
        }

        case 'COUNTER_TARGET': {
          const targetsToCounter = effect.targetId ? [effect.targetId] : (legalTargets && legalTargets.length > 0 ? legalTargets : [defaultTargetId]);
          for (const t of targetsToCounter) {
            const tid = typeof t === 'string' ? t : (t?.instanceId || t?.id || t?.targetId);
            if (!tid) continue;
            const targetStackIdx = this.stack.findIndex(s => s && (s.instanceId === tid || s.id === tid || s.card?.instanceId === tid));
            if (targetStackIdx !== -1) {
              const [removedItem] = this.stack.splice(targetStackIdx, 1);
              const targetCard = removedItem.card || removedItem;
              const ownerId = targetCard.ownerId || targetCard.controllerId || removedItem.controllerId;
              const owner = this.players[ownerId] || this.getPlayer(this.activePlayerId);
              if (owner) {
                const gyCard = ZoneTransitionMatrix.createZoneChangedObject(targetCard, 'graveyard');
                owner.graveyard.push(gyCard);
                if (owner.zones?.graveyard) owner.zones.graveyard.push(gyCard);
                this.emit('SPELL_COUNTERED', { card: targetCard, ownerId });
              }
            }
          }
          break;
        }

        case 'MODIFY_LIFE': {
          const targetPid = effect.playerId || effect.targetPlayerId || (typeof defaultTargetId === 'string' && this.players[defaultTargetId] ? defaultTargetId : null) || controllerId;
          const targetPlayer = this.players[targetPid];
          if (targetPlayer) {
            targetPlayer.resources = targetPlayer.resources || {};
            if (effect.targetValue !== undefined || effect.target !== undefined) {
              targetPlayer.resources.life = Number(effect.targetValue ?? effect.target);
            } else if (effect.amount !== undefined || effect.delta !== undefined || effect.value !== undefined) {
              targetPlayer.resources.life = (targetPlayer.resources.life ?? 20) + Number(effect.amount ?? effect.delta ?? effect.value);
            }
          }
          break;
        }

        case 'PUMP_PT_AND_KEYWORDS': {
          if (originalCard.compiledMechanics?.isEquipment || /equipment/i.test(typeLine)) {
            break;
          }
          const powerDelta = Number(effect.powerDelta || 0);
          const toughnessDelta = Number(effect.toughnessDelta || 0);
          const isControllerScope = effect.scope === 'CONTROLLER_PERMANENTS' || effect.scope === 'CONTROLLER_CREATURES' || (!/target/i.test(originalCard.oracleText || '') && (!rawTargets || rawTargets.length === 0));

          if (isControllerScope) {
            // Team buff (e.g. Surge of Salvation)
            player.hasHexproofUntilEOT = true;
            const targetPerms = effect.scope === 'CONTROLLER_CREATURES'
              ? (player.battlefield?.creatures || [])
              : [
                  ...(player.battlefield?.creatures || []),
                  ...(player.battlefield?.lands || []),
                  ...(player.battlefield?.noncreatures || []),
                  ...(player.battlefield?.planeswalkers || [])
                ];

            for (const targetCr of targetPerms) {
              if (this.abilityEngine) {
                this.abilityEngine.registerStaticEffect({
                  id: `pump_${Date.now()}_${targetCr.instanceId}`,
                  sourceId: originalCard.instanceId,
                  layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
                  powerMod: powerDelta,
                  toughnessMod: toughnessDelta,
                  duration: effect.duration || 'END_OF_TURN',
                  appliesTo: (perm) => perm && (perm.instanceId === targetCr.instanceId || perm.id === targetCr.instanceId)
                });
              } else {
                targetCr.power = (targetCr.power || 0) + powerDelta;
                targetCr.toughness = (targetCr.toughness || 0) + toughnessDelta;
              }
              if (Array.isArray(effect.keywordsGranted)) {
                targetCr.keywords = targetCr.keywords || {};
                for (const kw of effect.keywordsGranted) {
                  targetCr.keywords[kw] = true;
                  targetCr.keywords[kw.charAt(0).toUpperCase() + kw.slice(1)] = true;
                }
              }
              this.emit('CREATURE_BUFFED', { creature: targetCr, powerDelta, toughnessDelta, keywords: effect.keywordsGranted });
            }
          } else {
            const targetsToPump = effect.targetId ? [effect.targetId] : (legalTargets && legalTargets.length > 0 ? legalTargets : [defaultTargetId]);
            for (const t of targetsToPump) {
              const tid = typeof t === 'string' ? t : (t?.instanceId || t?.id || t?.targetId);
              if (!tid) continue;
              for (const p of Object.values(this.players || {})) {
                const targetCr = (p.battlefield?.creatures || []).find(c => c && (c.instanceId === tid || c.id === tid));
                if (targetCr) {
                  if (this.abilityEngine) {
                    this.abilityEngine.registerStaticEffect({
                      id: `pump_${Date.now()}_${tid}`,
                      sourceId: originalCard.instanceId,
                      layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
                      powerMod: powerDelta,
                      toughnessMod: toughnessDelta,
                      duration: effect.duration || 'END_OF_TURN',
                      appliesTo: (perm) => perm && (perm.instanceId === tid || perm.id === tid)
                    });
                  } else {
                    targetCr.power = (targetCr.power || 0) + powerDelta;
                    targetCr.toughness = (targetCr.toughness || 0) + toughnessDelta;
                  }
                  if (Array.isArray(effect.keywordsGranted)) {
                    targetCr.keywords = targetCr.keywords || {};
                    for (const kw of effect.keywordsGranted) {
                      targetCr.keywords[kw] = true;
                      targetCr.keywords[kw.charAt(0).toUpperCase() + kw.slice(1)] = true;
                    }
                  }
                  if (effect.autoAttachEquipment) {
                    const reqSubtype = effect.requiresSubtypeForAttach;
                    const hasRequiredSubtype = !reqSubtype || new RegExp(`\\b${reqSubtype}\\b`, 'i').test(targetCr.typeLine || targetCr.type || '');
                    if (hasRequiredSubtype) {
                      const unattachedEquip = (p.battlefield?.noncreatures || []).find(nc =>
                        nc && (nc.compiledMechanics?.isEquipment || /equipment/i.test(nc.typeLine || '')) && !nc.attachedTo
                      );
                      if (unattachedEquip) {
                        unattachedEquip.attachedTo = targetCr.instanceId;
                        if (!targetCr.attachedCards) targetCr.attachedCards = [];
                        if (!targetCr.attachedCards.includes(unattachedEquip)) targetCr.attachedCards.push(unattachedEquip);
                      }
                    }
                  }
                  this.emit('CREATURE_BUFFED', { creature: targetCr, powerDelta, toughnessDelta, keywords: effect.keywordsGranted });
                  break;
                }
              }
            }
          }
          break;
        }

        case 'GAIN_CONTROL_ATTACH_EQUIPMENT': {
          const comb = resolvedItem.selectedCombination || resolvedItem.options?.selectedCombination || originalCard?.selectedCombination || resolvedItem.options || {};
          const targetIds = (Array.isArray(rawTargets) ? rawTargets : [])
            .map(t => (typeof t === 'string' ? t : (t?.instanceId || t?.id || t?.targetId)))
            .filter(Boolean);
          const creatureId = comb.creatureId || resolvedItem.creatureId || effect.targetCreatureId || effect.creatureId || effect.targetId || targetIds[0] || (resolvedItem.options?.targetCreatureId || resolvedItem.options?.creatureId || resolvedItem.options?.targetId || resolvedItem.options?.targets?.[0]);
          const equipId = comb.equipmentId || resolvedItem.equipmentId || effect.targetEquipmentId || effect.equipmentId || targetIds[1] || (resolvedItem.options?.targetEquipmentId || resolvedItem.options?.equipmentId || resolvedItem.options?.targets?.[1]);
          this.resolveSpellEffect(controllerId, originalCard, {
            selectedCombination: comb,
            targetCreatureId: creatureId,
            targetEquipmentId: equipId,
            creatureId,
            equipmentId: equipId,
            targetId: creatureId,
            targets: [creatureId, equipId]
          });
          break;
        }

        case 'PREVENT_COLOR_DAMAGE': {
          this.resolveSpellEffect(controllerId, originalCard, {});
          break;
        }

        case 'SURGICAL_EXTRACT_NAME': {
          const targetId = effect.targetCardId || defaultTargetId;
          this.resolveSpellEffect(controllerId, originalCard, { targetCardId: targetId });
          break;
        }

        case 'FLING_SACRIFICE_DAMAGE': {
          const isCallousSellSword = /callous sell-sword/i.test(originalCard.name || '');
          const isMainCast = resolvedItem.castMode === 'MAIN' || originalCard.activeCastMode === 'MAIN' || originalCard.selectedCastMode === 'MAIN' || (isCallousSellSword && resolvedItem.castMode !== 'ADVENTURE' && originalCard.activeCastMode !== 'ADVENTURE' && originalCard.selectedCastMode !== 'ADVENTURE');
          if (isMainCast) {
            break;
          }
          this._resolveFlingSacrificeDamage(controllerId, originalCard, rawTargets, legalTargets, effect, resolvedItem);
          originalCard._flingAlreadyResolved = true;
          break;
        }
      }
    }

    const isCallousSellSword = /callous sell-sword/i.test(originalCard.name || '');
    const isExplicitMain = resolvedItem.castMode === 'MAIN' || originalCard.activeCastMode === 'MAIN' || originalCard.selectedCastMode === 'MAIN';
    const isExplicitAdventure = resolvedItem.castMode === 'ADVENTURE' || originalCard.activeCastMode === 'ADVENTURE' || originalCard.selectedCastMode === 'ADVENTURE' || originalCard.castModeDescriptor?.mode === 'ADVENTURE';

    const isAdventureResolution = Boolean(
      !isExplicitMain &&
      (isExplicitAdventure || (!isCallousSellSword && /\badventure\b/i.test(typeLine)))
    );

    if (isAdventureResolution && !originalCard._flingAlreadyResolved && /burn together|sacrifice.*creature|deals damage equal to.*power/i.test(originalCard.oracleText || originalCard.name || '')) {
      this._resolveFlingSacrificeDamage(controllerId, originalCard, rawTargets, legalTargets, originalCard.effect || {}, resolvedItem);
      originalCard._flingAlreadyResolved = true;
    }

    // ── Non-card triggers & abilities cease to exist upon resolving (CR 113.3b / CR 608.2) ──
    // Never move triggers or abilities to player.graveyard or battlefield.
    if (isNonCardTriggerOrAbility) {
      this._notifySubscribers({
        sequenceId: ++this.sequenceCounter,
        actionType: 'TRIGGER_RESOLVED',
        playerId: controllerId,
        payload: { item: resolvedItem },
        timestamp: Date.now()
      }, { item: resolvedItem });

      this.emit('STACK_RESOLVE', { item: resolvedItem, controllerId });
      this.emit('STACK_RESOLVED', { item: resolvedItem, controllerId });
      this.emit('TRIGGER_RESOLVED', { item: resolvedItem, controllerId });

      this.runSBACheck();
      return { item: resolvedItem, destinationZone: null, destinationSubzone: null };
    }

    // ── CR 715.3d — Adventure Resolution to Exile ("On an Adventure") ──
    if (isAdventureResolution) {
      const mainMode = Array.isArray(originalCard.compiledMechanics?.castModes)
        ? originalCard.compiledMechanics.castModes.find(m => m.mode === 'MAIN')
        : null;
      const origProps = originalCard._originalCardProperties || {};

      const cardToExile = ZoneTransitionMatrix.createZoneChangedObject(originalCard, 'exile');
      cardToExile.zone = 'exile';
      cardToExile.subzone = null;
      cardToExile.onAdventure = true;
      cardToExile.mayBePlayedFromExile = true;
      cardToExile.activeCastMode = null;
      cardToExile.selectedCastMode = null;
      cardToExile.castModeDescriptor = null;

      if (mainMode) {
        const origMainName = origProps.name ? origProps.name.split(' // ')[0].trim() : null;
        cardToExile.name = (mainMode.name && !mainMode.name.includes('//') && mainMode.name !== 'Burn Together')
          ? mainMode.name
          : (origMainName || mainMode.name || cardToExile.name);
        cardToExile.manaCost = mainMode.manaCost || (origProps.manaCost ? origProps.manaCost.split(' // ')[0].trim() : cardToExile.manaCost);
        cardToExile.typeLine = mainMode.typeLine || (origProps.typeLine ? origProps.typeLine.split(' // ')[0].trim() : cardToExile.typeLine);
        cardToExile.power = mainMode.power ?? origProps.power ?? cardToExile.power ?? 2;
        cardToExile.toughness = mainMode.toughness ?? origProps.toughness ?? cardToExile.toughness ?? 2;
        cardToExile.oracleText = mainMode.oracleText ?? origProps.oracleText ?? '';
      } else if (origProps.name) {
        cardToExile.name = origProps.name.split(' // ')[0].trim();
        cardToExile.manaCost = origProps.manaCost ? origProps.manaCost.split(' // ')[0].trim() : cardToExile.manaCost;
        cardToExile.typeLine = origProps.typeLine ? origProps.typeLine.split(' // ')[0].trim() : cardToExile.typeLine;
        cardToExile.power = origProps.power ?? cardToExile.power;
        cardToExile.toughness = origProps.toughness ?? cardToExile.toughness;
      }

      player.exile = player.exile || [];
      player.exile.push(cardToExile);
      if (player.zones) {
        player.zones.exile = player.exile;
      }

      this._notifySubscribers({
        sequenceId: ++this.sequenceCounter,
        actionType: 'ADVENTURE_EXILED',
        playerId: controllerId,
        payload: { card: cardToExile, destinationZone: 'exile', onAdventure: true },
        timestamp: Date.now()
      }, { card: cardToExile, destinationZone: 'exile', onAdventure: true });

      this.emit('STACK_RESOLVE', { card: cardToExile, destinationZone: 'exile', destinationSubzone: null, controllerId, onAdventure: true });
      this.emit('STACK_RESOLVED', { card: cardToExile, destinationZone: 'exile', destinationSubzone: null, controllerId, onAdventure: true });
      this.emit('ADVENTURE_EXILED', { card: cardToExile, controllerId });

      this.runSBACheck();
      return { card: cardToExile, destinationZone: 'exile', destinationSubzone: null, onAdventure: true };
    }

    // ── CR 400.7 — Zone-change identity reset ──────────────────────────
    // The card becomes a new game object when it changes zones.  Strip
    // counters, damage marks, granted abilities, and assign a fresh
    // instanceId so no stale state bleeds from the stack.
    const targetZone = isInstantOrSorcery ? 'graveyard' : 'battlefield';

    const card = ZoneTransitionMatrix.createZoneChangedObject(originalCard, targetZone);

    let destinationZone = targetZone;
    let destinationSubzone = null;

    if (typeLine.includes('creature')) {
      destinationSubzone = 'creatures';
      card.subzone = 'creatures';
      TabletopStateManager.hydrateCardMechanics(card);
      card.hasSummoningSickness = true;
      card.isSummoningSick = true;
      card.summoningSickness = true;
      card.isTapped = false;
      // Ensure Callous Sell-Sword characteristics are normalized as 2/2 creature and removed from hand
      if (/callous sell-sword/i.test(card.name || originalCard.name || '')) {
        card.name = 'Callous Sell-Sword';
        card.typeLine = 'Creature — Human Soldier';
        card.manaCost = '{1}{B}';
        card.power = 2;
        card.toughness = 2;
        card.basePower = 2;
        card.baseToughness = 2;
        const diedCount = Number(player.creaturesDiedThisTurn || 0);
        if (diedCount > 0) {
          card.counters = card.counters || {};
          card.counters['+1/+1'] = (card.counters['+1/+1'] || 0) + diedCount;
          card.power += diedCount;
          card.toughness += diedCount;
          card.effectivePower = card.power;
          card.effectiveToughness = card.toughness;
          this.emit('COUNTER_ADDED', { card, counterType: '+1/+1', count: diedCount, total: card.counters['+1/+1'] });
        }
      } else {
        const hydratedPower = Number(card.power ?? originalCard.power);
        const hydratedToughness = Number(card.toughness ?? originalCard.toughness);
        card.power = Number.isFinite(hydratedPower) ? hydratedPower : 1;
        card.toughness = Number.isFinite(hydratedToughness) ? hydratedToughness : 1;
      }

      // Assert removal from hand cleanly
      if (Array.isArray(player.hand)) {
        player.hand = player.hand.filter(c => c && c !== card && c.instanceId !== card.instanceId && c.instanceId !== originalCard.instanceId);
        if (player.zones?.hand) player.zones.hand = player.hand;
      }

      player.battlefield.creatures.push(card);
    } else if (typeLine.includes('land')) {
      destinationSubzone = 'lands';
      card.subzone = 'lands';
      card.isTapped = false;
      player.battlefield.lands.push(card);
    } else if (typeLine.includes('planeswalker')) {
      destinationSubzone = 'planeswalkers';
      card.subzone = 'planeswalkers';
      card.isTapped = false;
      player.battlefield.planeswalkers.push(card);
    } else if (typeLine.includes('artifact') || typeLine.includes('enchantment') || typeLine.includes('battle')) {
      destinationSubzone = 'noncreatures';
      card.subzone = 'noncreatures';
      card.isTapped = false;
      if (isAura || card.compiledMechanics?.isEquipment) {
        const attachTargetId = (rawTargets && rawTargets[0]) ? (typeof rawTargets[0] === 'string' ? rawTargets[0] : (rawTargets[0]?.instanceId || rawTargets[0]?.id)) : null;
        if (attachTargetId) {
          card.attachedTo = attachTargetId;
          const targetCreature = (player.battlefield?.creatures || []).find(c => c && (c.instanceId === attachTargetId || c.id === attachTargetId));
          if (targetCreature) {
            if (!targetCreature.attachedCards) targetCreature.attachedCards = [];
            if (!targetCreature.attachedCards.includes(card)) targetCreature.attachedCards.push(card);
          }
        }
      }
      player.battlefield.noncreatures.push(card);
    } else if (isInstantOrSorcery) {
      destinationZone = 'graveyard';
      card.subzone = null;
      player.graveyard.push(card);
    } else {
      if (card.isPermanent) {
        destinationSubzone = 'noncreatures';
        card.subzone = 'noncreatures';
        card.isTapped = false;
        player.battlefield.noncreatures.push(card);
      } else {
        destinationZone = 'graveyard';
        card.subzone = null;
        player.graveyard.push(card);
      }
    }

    // Sync with player.zones if present
    if (player.zones) {
      if (destinationZone === 'battlefield') {
        if (!player.zones.battlefield) player.zones.battlefield = [];
        player.zones.battlefield.push(card);
      } else if (destinationZone === 'graveyard') {
        if (!player.zones.graveyard) player.zones.graveyard = [];
        player.zones.graveyard.push(card);
      }
    }

    if (destinationZone === 'battlefield') {
      this._onPermanentEnteredBattlefield(card, controllerId);
    }

    this._notifySubscribers({
      sequenceId: ++this.sequenceCounter,
      actionType: destinationZone === 'battlefield' ? 'CARD_ENTERED_BATTLEFIELD' : 'SPELL_RESOLVED_TO_GRAVEYARD',
      playerId: controllerId,
      payload: { card, destinationZone, destinationSubzone },
      timestamp: Date.now()
    }, { card, destinationZone, destinationSubzone });

    this.emit('STACK_RESOLVE', { card, destinationZone, destinationSubzone, controllerId });
    this.emit('STACK_RESOLVED', { card, destinationZone, destinationSubzone, controllerId });
    if (destinationZone === 'battlefield') {
      this.emit('CARD_ENTERED_BATTLEFIELD', { card, subzone: destinationSubzone, controllerId });
    } else {
      this.emit('SPELL_RESOLVED_TO_GRAVEYARD', { card, controllerId });
    }

    // ── CR 117.5 — State-Based Actions check after resolution ──────────
    this.runSBACheck();

    return { card, destinationZone, destinationSubzone };
  }

  /**
   * Resolves top item of the stack (CR 608).
   * @returns {Object|null}
   */
  resolveTopOfStack() {
    if (this.priorityMachine && typeof this.priorityMachine.resolveTop === 'function' && ((this.priorityMachine.stack && this.priorityMachine.stack.length > 0) || (this.stack && this.stack.length > 0))) {
      return this.priorityMachine.resolveTop();
    }
    const top = this.stack && this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
    return this.handleStackResolution(top);
  }

  castSpell(playerId, instanceId, options = {}) {
    return this.dispatch('CAST_SPELL', { playerId, instanceId, ...options });
  }

  moveZone(playerId, instanceId, fromZone, toZone, options = {}) {
    return this.dispatch('MOVE_ZONE', { playerId, instanceId, fromZone, toZone, ...options });
  }

  tapPermanent(playerId, instanceId) {
    return this.dispatch('TAP_PERMANENT', { playerId, instanceId });
  }

  untapPermanent(playerId, instanceId) {
    return this.dispatch('UNTAP_PERMANENT', { playerId, instanceId });
  }

  untapAll(playerId) {
    return this.dispatch('UNTAP_ALL', { playerId });
  }

  adjustLife(playerId, lifeOptions) {
    return this.dispatch('ADJUST_LIFE', {
      playerId,
      ...(typeof lifeOptions === 'number' ? { delta: lifeOptions } : lifeOptions)
    });
  }

  updateManaPool(playerId, manaDelta) {
    return this.dispatch('UPDATE_MANA_POOL', { playerId, poolDelta: manaDelta });
  }

  modifyCounters(playerId, instanceId, counterType, delta) {
    return this.dispatch('MODIFY_COUNTERS', { playerId, instanceId, counterType, delta });
  }

  setHandRevealed(playerId, isRevealed) {
    return this.dispatch('SET_HAND_REVEALED', { playerId, isRevealed });
  }

  mutatePlayerLife(playerId, delta) {
    return this.adjustLife(playerId, delta);
  }

  setPlayerLife(playerId, life) {
    return this.adjustLife(playerId, { targetValue: life });
  }

  addCardToZone(playerId, zone, cardData = {}) {
    const player = this.getPlayer(playerId);
    const instanceId = cardData.instanceId || ZoneModel.generateInstanceId();

    const card = {
      instanceId,
      name: cardData.name || 'Unknown Card',
      manaCost: cardData.manaCost || '',
      typeLine: cardData.typeLine || '',
      oracleText: cardData.oracleText || '',
      imageUri: cardData.imageUri || '',
      power: cardData.power,
      toughness: cardData.toughness,
      loyalty: cardData.loyalty,
      modernLegal: cardData.modernLegal !== undefined ? cardData.modernLegal : true,
      colors: cardData.colors || [],
      ownerId: cardData.ownerId || playerId,
      controllerId: cardData.controllerId || playerId,
      attachedTo: cardData.attachedTo !== undefined ? cardData.attachedTo : null,
      zone,
      isTapped: Boolean(cardData.isTapped),
      counters: cardData.counters ? { ...cardData.counters } : {},
      isToken: Boolean(cardData.isToken),
      isFaceDown: Boolean(cardData.isFaceDown),
      annotations: cardData.annotations ? { ...cardData.annotations } : {},
      ...cardData
    };

    if (card.power !== undefined && card.basePower === undefined) {
      card.basePower = Number(card.power) || 0;
    }
    if (card.toughness !== undefined && card.baseToughness === undefined) {
      card.baseToughness = Number(card.toughness) || 0;
    }

    // Hydrate card mechanics BEFORE computing typeLine and subzone!
    TabletopStateManager.hydrateCardMechanics(card, this.deckManifests);

    const typeLine = card.typeLine || card.type || '';
    const subzone = cardData.subzone !== undefined
      ? cardData.subzone
      : (card.subzone !== undefined && card.subzone !== null
          ? card.subzone
          : (zone === 'battlefield' ? classifySubzone(card.typeLine || card.type || '') : null));

    card.typeLine = typeLine;
    card.subzone = subzone;

    if (zone === 'companionZone' || zone === 'companion') {
      player.companionZone = player.companionZone || [];
      player.companionZone.push(card);
      player.companion = card;
      if (player.zones) {
        player.zones.companionZone = player.companionZone;
      }
    } else {
      ZoneModel.insertCardIntoZone(player, card, zone, subzone, cardData.position || 'bottom', this.stack);
      if (zone === 'battlefield') {
        this._onPermanentEnteredBattlefield(card, playerId);
      }
    }
    this._notifySubscribers({
      sequenceId: ++this.sequenceCounter,
      actionType: 'ADD_CARD_TO_ZONE',
      playerId,
      payload: { zone, card },
      timestamp: Date.now()
    }, { card });
    return card;
  }

  /**
   * Moves a player's Companion from companionZone to hand for {3} as a special action
   * during their Main Phase when the stack is empty (CR 702.139a).
   *
   * @param {string} playerId
   * @param {Object} [options={}]
   * @returns {Object} The moved companion card
   */
  moveCompanionToHand(playerId, options = {}) {
    const resolvedId = this.resolvePlayerId(playerId || this.activePlayerId);
    const player = this.getPlayer(resolvedId);
    if (!options.bypassTiming) {
      const activePid = this.priorityMachine?.activePlayerId || this.activePlayerId;
      if (activePid && resolvedId !== activePid) {
        throw new PriorityViolationError(`Only active player '${activePid}' can move companion`);
      }
      const currentStep = this.priorityMachine?.currentPhaseStep || this.currentPhaseStep || 'PRECOMBAT_MAIN';
      if (!['PRECOMBAT_MAIN', 'POSTCOMBAT_MAIN', 'MAIN', 'MAIN_2'].includes(currentStep)) {
        throw new PhaseTimingError(`Companion can only be moved during main phase, currently '${currentStep}'`);
      }
      const stackSize = (this.stack?.length || 0) + (typeof this.priorityMachine?.getStackSize === 'function' ? this.priorityMachine.getStackSize() : 0);
      if (stackSize > 0) {
        throw new PhaseTimingError(`Stack must be empty, size is ${stackSize}`);
      }
    }
    if (player._companionMovedToHandThisGame) {
      throw new StateTransitionError('Companion already moved to hand this game');
    }
    const companionCard = (Array.isArray(player.companionZone) && player.companionZone[0]) || player.companion || player.zones?.companionZone?.[0];
    if (!companionCard) {
      throw new StateTransitionError('No companion found in companion zone');
    }
    if (!options.isFree) {
      const manaPool = player.resources?.manaPool || {};
      const floatingTotal = Object.values(manaPool).reduce((s, v) => s + (Number(v) || 0), 0);
      if (floatingTotal >= 3) {
        let needed = 3;
        for (const c of ['C', 'W', 'U', 'B', 'R', 'G']) {
          if (needed <= 0) break;
          const deduct = Math.min(manaPool[c] || 0, needed);
          manaPool[c] -= deduct;
          needed -= deduct;
        }
        this.emit('MANA_POOL_UPDATED', { playerId: resolvedId, manaPool: { ...manaPool } });
      } else {
        this.autoTapForMana(resolvedId, '{3}');
      }
    }
    if (Array.isArray(player.companionZone)) {
      const idx = player.companionZone.indexOf(companionCard);
      if (idx !== -1) player.companionZone.splice(idx, 1);
      else player.companionZone.shift();
    }
    if (player.zones && Array.isArray(player.zones.companionZone) && player.zones.companionZone !== player.companionZone) {
      const zIdx = player.zones.companionZone.indexOf(companionCard);
      if (zIdx !== -1) player.zones.companionZone.splice(zIdx, 1);
    }
    player.companion = null;
    companionCard.zone = 'hand';
    companionCard.subzone = null;
    player.hand = player.hand || [];
    player.hand.push(companionCard);
    if (player.zones && Array.isArray(player.zones.hand) && player.zones.hand !== player.hand) {
      player.zones.hand.push(companionCard);
    }
    player._companionMovedToHandThisGame = true;
    this.emit('COMPANION_MOVED_TO_HAND', { playerId: resolvedId, card: companionCard });
    return companionCard;
  }

  evaluateCreatureStats(creature, playerIdOrContext = null) {
    if (!creature) {
      return { power: 0, toughness: 0, keywords: {}, effectivePower: 0, effectiveToughness: 0 };
    }
    const context = (playerIdOrContext && typeof playerIdOrContext === 'object' && !playerIdOrContext.battlefield)
      ? playerIdOrContext
      : this;
    if (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function') {
      return this.abilityEngine.evaluateCreatureStats(creature, context);
    }
    const basePower = Number(creature.power ?? creature.basePower ?? 0) || 0;
    const baseToughness = Number(creature.toughness ?? creature.baseToughness ?? 0) || 0;
    let power = basePower;
    let toughness = baseToughness;
    if (creature.counters) {
      const p1 = Number(creature.counters['+1/+1'] || 0);
      const m1 = Number(creature.counters['-1/-1'] || 0);
      power += (p1 - m1);
      toughness += (p1 - m1);
    }
    return {
      power,
      toughness,
      keywords: { ...(creature.keywords || {}) },
      effectivePower: power,
      effectiveToughness: toughness
    };
  }

  handleCreatureDeath(creature, controllerId = null) {
    if (!creature) return null;
    const cid = controllerId || creature.controllerId || creature.ownerId || this.activePlayerId;

    if (creature._onDiesResolved) {
      this._unattachCreatureEquipment(creature);
      return null;
    }
    creature._onDiesResolved = true;

    // 1. Calculate Last Known Information (LKI) stats BEFORE un-attaching equipment
    const lkiStats = this.evaluateCreatureStats(creature, cid);
    const lkiPower = Number(lkiStats?.power ?? creature.power ?? 0);

    // 2. Check ON_DIES triggers
    const triggers = creature.compiledMechanics?.triggers || [];
    const hasDiesDamageTrigger = triggers.some(t => t.triggerType === 'ON_DIES' && t.action === 'DAMAGE_EQUAL_TO_POWER_EACH_OPPONENT') ||
      /deals\s+damage\s+equal\s+to\s+its\s+power\s+to\s+each\s+opponent/i.test(creature.oracleText || creature.text || '');

    if (hasDiesDamageTrigger && lkiPower > 0) {
      for (const [oppPid, opp] of Object.entries(this.players || {})) {
        if (oppPid !== cid && !opp.isEliminated) {
          this.adjustLife(oppPid, { delta: -lkiPower });
          this.emit('LIFE_LOST', { playerId: oppPid, amount: lkiPower, newLife: opp.resources?.life });
          this.emit('DAMAGE_DEALT', {
            sourceId: creature.instanceId,
            sourceName: creature.name,
            sourceControllerId: cid,
            targetId: oppPid,
            targetType: 'PLAYER',
            amount: lkiPower
          });
          this.recordTrace('TRIGGER_TRACE', 'DIES_TRIGGER_DAMAGE_DEALT', {
            sourceId: creature.instanceId,
            sourceName: creature.name,
            controllerId: cid,
            targetPlayerId: oppPid,
            amount: lkiPower
          });
        }
      }
    }

    // 3. Unattach any attached equipment, but keep equipment on battlefield.noncreatures
    this._unattachCreatureEquipment(creature);

    const pObj = this.getPlayer(cid);
    if (pObj) {
      pObj.creaturesDiedThisTurn = (pObj.creaturesDiedThisTurn || 0) + 1;
    }
    this.creaturesDiedThisTurn = (this.creaturesDiedThisTurn || 0) + 1;

    this.emit('CREATURE_DIED', { creature, controllerId: cid, lkiPower });
    return { creature, lkiPower };
  }

  _unattachCreatureEquipment(creature) {
    if (!creature) return;
    const creatureId = creature.instanceId || creature.id;

    if (Array.isArray(creature.attachedCards)) {
      for (const eq of creature.attachedCards) {
        if (eq && typeof eq === 'object') {
          eq.attachedTo = null;
        }
      }
      creature.attachedCards = [];
    }

    for (const player of Object.values(this.players || {})) {
      const noncreatures = player.battlefield?.noncreatures || [];
      for (const nc of noncreatures) {
        if (nc && (nc.attachedTo === creatureId || nc.attachedTo === creature.id)) {
          nc.attachedTo = null;
        }
      }
    }

    if (this.abilityEngine && typeof this.abilityEngine.evaluateAllLayers === 'function') {
      this.abilityEngine.evaluateAllLayers(this);
    }
    const evaluated = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
      ? this.abilityEngine.evaluateCreatureStats(creature, this)
      : (typeof AbilityEngine.evaluateCreatureStats === 'function'
          ? AbilityEngine.evaluateCreatureStats(creature, this)
          : this.evaluateCreatureStats(creature, creature.controllerId || this));
    creature.effectivePower = evaluated.power ?? evaluated.effectivePower ?? creature.power;
    creature.effectiveToughness = evaluated.toughness ?? evaluated.effectiveToughness ?? creature.toughness;
  }

  _reconcileDetachedEquipments() {
    const allBattlefieldCreatureIds = new Set();
    for (const player of Object.values(this.players || {})) {
      const creatures = player.battlefield?.creatures || [];
      for (const c of creatures) {
        if (c) {
          if (c.instanceId) allBattlefieldCreatureIds.add(c.instanceId);
          if (c.id) allBattlefieldCreatureIds.add(c.id);
        }
      }
    }

    for (const player of Object.values(this.players || {})) {
      const noncreatures = player.battlefield?.noncreatures || [];
      for (const nc of noncreatures) {
        if (nc && nc.attachedTo) {
          if (!allBattlefieldCreatureIds.has(nc.attachedTo)) {
            nc.attachedTo = null;
          }
        }
      }
    }
  }

  destroyCreature(playerId, creatureId) {
    const player = this.getPlayer(playerId);
    const creatures = player.battlefield?.creatures || [];
    const creature = creatures.find(c => c && (c.instanceId === creatureId || c.id === creatureId));
    if (!creature) {
      throw new CardNotFoundError(`Creature with instanceId '${creatureId}' not found on battlefield`);
    }
    this.handleCreatureDeath(creature, playerId);
    this.abilityEngine?.unregisterEffectsFromSource(creatureId);
    ZoneTransitionMatrix.moveCard(player, creatureId, 'battlefield', 'graveyard');
    this.runSBACheck();
    return { success: true, creatureId };
  }

  sacrificeCreature(playerId, creatureId) {
    const player = this.getPlayer(playerId);
    const creatures = player.battlefield?.creatures || [];
    const creature = creatures.find(c => c && (c.instanceId === creatureId || c.id === creatureId));
    if (!creature) {
      throw new CardNotFoundError(`Creature with instanceId '${creatureId}' not found on battlefield`);
    }
    this.handleCreatureDeath(creature, playerId);
    this.abilityEngine?.unregisterEffectsFromSource(creatureId);
    ZoneTransitionMatrix.moveCard(player, creatureId, 'battlefield', 'graveyard');
    this.runSBACheck();
    return { success: true, creatureId };
  }

  exportDeckManifest(playerId) {
    const player = this.getPlayer(playerId);
    const seenNames = new Set();
    const cards = [];

    const addCardToManifest = (c) => {
      if (!c || !c.name) return;
      const nameNorm = c.name.trim().toLowerCase();
      if (seenNames.has(nameNorm)) return;
      seenNames.add(nameNorm);

      TabletopStateManager.hydrateCardMechanics(c, this.deckManifests);

      cards.push({
        name: c.name,
        typeLine: c.typeLine || c.type || '',
        manaCost: c.manaCost || '',
        power: c.power,
        toughness: c.toughness,
        oracleText: c.oracleText || c.text || '',
        colors: Array.isArray(c.colors) ? [...c.colors] : [],
        subzone: c.subzone || null,
        isPermanent: c.isPermanent !== undefined ? c.isPermanent : null,
        compiledMechanics: c.compiledMechanics ? JSON.parse(JSON.stringify(c.compiledMechanics)) : null,
        imageUri: c.imageUri || ''
      });
    };

    const allContainers = [
      player.library || [],
      player.hand || [],
      player.battlefield?.creatures || [],
      player.battlefield?.lands || [],
      player.battlefield?.noncreatures || [],
      player.battlefield?.planeswalkers || [],
      player.graveyard || [],
      player.exile || []
    ];

    for (const container of allContainers) {
      for (const card of container) {
        addCardToManifest(card);
      }
    }

    for (const stackItem of (this.stack || [])) {
      const c = stackItem.card || stackItem;
      if (c && (c.ownerId === playerId || c.controllerId === playerId)) {
        addCardToManifest(c);
      }
    }

    return {
      playerId,
      cards,
      mainboard: cards,
      cardsCount: cards.length,
      timestamp: Date.now()
    };
  }

  static registerDeckManifest(arg1, arg2) {
    let playerId;
    let manifest;
    if (typeof arg1 === 'string') {
      playerId = arg1;
      manifest = arg2;
    } else {
      manifest = arg1;
      playerId = arg2 || manifest?.playerId;
    }
    TabletopStateManager.deckManifests = TabletopStateManager.deckManifests || {};
    const cardMap = {};

    let cardList = [];
    if (manifest && Array.isArray(manifest.cards)) {
      cardList = manifest.cards;
    } else if (manifest && Array.isArray(manifest.mainboard)) {
      cardList = manifest.mainboard;
    } else if (Array.isArray(manifest)) {
      cardList = manifest;
    } else if (manifest && typeof manifest === 'object') {
      cardList = Object.values(manifest);
    }

    for (const card of cardList) {
      if (card && card.name) {
        cardMap[card.name.trim().toLowerCase()] = card;
      }
    }

    if (playerId) {
      TabletopStateManager.deckManifests[playerId] = cardMap;
    }
    return cardMap;
  }

  registerDeckManifest(arg1, arg2) {
    const cardMap = TabletopStateManager.registerDeckManifest(arg1, arg2);
    let playerId;
    if (typeof arg1 === 'string') {
      playerId = arg1;
    } else {
      playerId = arg2 || arg1?.playerId;
    }
    const manifest = typeof arg1 === 'string' ? arg2 : arg1;
    this.deckManifests = this.deckManifests || {};
    if (playerId) {
      this.deckManifests[playerId] = cardMap;
    }

    const player = playerId ? this.players[playerId] : null;
    if (player) {
      const allPlayerCards = [
        ...(player.library || []),
        ...(player.hand || []),
        ...(player.battlefield?.creatures || []),
        ...(player.battlefield?.lands || []),
        ...(player.battlefield?.noncreatures || []),
        ...(player.battlefield?.planeswalkers || []),
        ...(player.graveyard || []),
        ...(player.exile || [])
      ];

      for (const card of allPlayerCards) {
        if (card) {
          TabletopStateManager.hydrateCardMechanics(card, this.deckManifests);
        }
      }

      for (const stackItem of (this.stack || [])) {
        const c = stackItem.card || stackItem;
        if (c && (c.ownerId === playerId || c.controllerId === playerId)) {
          TabletopStateManager.hydrateCardMechanics(c, this.deckManifests);
        }
      }
    }

    this.emit('DECK_MANIFEST_REGISTERED', { playerId, manifest, cardMap });
    return cardMap;
  }

  dealDamage(payload) {
    return this.dispatch('DEAL_DAMAGE', payload);
  }

  loseLife(playerId, amount, reason = 'LIFE_LOSS') {
    return this.dispatch('LOSE_LIFE', { playerId, amount, reason });
  }

  enterWithoutCasting(playerId, instanceId, fromZone = 'library', subzone = null) {
    return this.dispatch('ENTER_WITHOUT_CASTING', { playerId, instanceId, fromZone, subzone });
  }

  reanimate(playerId, instanceId) {
    return this.dispatch('REANIMATE', { playerId, instanceId });
  }

  regrowth(playerId, instanceId) {
    return this.dispatch('REGROWTH', { playerId, instanceId });
  }

  flicker(playerId, instanceId) {
    return this.dispatch('FLICKER', { playerId, instanceId });
  }

  mill(playerId, count = 1) {
    return this.dispatch('MILL', { playerId, count });
  }

  impulseExile(playerId, count = 1) {
    return this.dispatch('IMPULSE_EXILE', { playerId, count });
  }

  searchZone(playerId, zoneName = 'library', filterFn = null) {
    const player = this.getPlayer(playerId);
    let cards = [];
    if (zoneName === 'battlefield') {
      cards = [
        ...(player.battlefield?.lands || []),
        ...(player.battlefield?.creatures || []),
        ...(player.battlefield?.noncreatures || []),
        ...(player.battlefield?.planeswalkers || [])
      ];
    } else {
      cards = Array.isArray(player[zoneName]) ? [...player[zoneName]] : [];
    }
    if (typeof filterFn === 'function') {
      return cards.filter(filterFn);
    }
    return cards;
  }

  setPriorityMachine(priorityMachine) {
    if (this._priorityMachine === priorityMachine && this._priorityMachineWired) return;
    this._priorityMachine = priorityMachine;
    this._priorityMachineWired = false;
    this._wirePriorityMachine();
  }

  set priorityMachine(priorityMachine) {
    if (this._priorityMachine === priorityMachine && this._priorityMachineWired) return;
    this._priorityMachine = priorityMachine;
    this._priorityMachineWired = false;
    this._wirePriorityMachine();
  }

  get priorityMachine() {
    return this._priorityMachine;
  }

  _wirePriorityMachine() {
    if (!this._priorityMachine || this._priorityMachineWired) return;
    this._priorityMachineWired = true;
    this._priorityMachine.tabletopState = this;

    if (this._priorityMachine.startingPlayerId && !this.startingPlayerId) {
      this.startingPlayerId = this._priorityMachine.startingPlayerId;
    } else if (this.startingPlayerId && !this._priorityMachine.startingPlayerId) {
      this._priorityMachine.startingPlayerId = this.startingPlayerId;
    }

    this._priorityMachine.on('PHASE_STEP_CHANGED', (data) => {
      this.handlePhaseStepChanged(data);
    });

    this._priorityMachine.on('UNTAP_STEP_ENTERED', (data) => {
      this.handleUntapStep(data.activePlayerId);
    });

    this._priorityMachine.on('UPKEEP_STEP_ENTERED', (data) => {
      this.handleUpkeepStep(data.activePlayerId, data.turnNumber, data.roundNumber || this.roundNumber);
    });

    this._priorityMachine.on('CLEANUP_STEP_ENTERED', (data) => {
      this.handleCleanupStep(data.activePlayerId);
    });
  }

  handleUntapStep(activePlayerId) {
    if (!activePlayerId) return;
    const player = this.getPlayer(activePlayerId);
    this.untapAll(activePlayerId);
    if (player) {
      for (const card of (player.battlefield?.creatures || [])) {
        card.hasSummoningSickness = false;
        card.isSummoningSick = false;
        card.summoningSickness = false;
      }
      player.landsPlayedThisTurn = 0;
      player.creaturesDiedThisTurn = 0;
      player.maxLandsPerTurn = 1;
      player.landsPerTurnLimit = 1;
      if (player.resources) {
        player.resources.landsPlayedThisTurn = 0;
        player.resources.additionalLandsAllowed = 0;
        player.resources.maxLandsPerTurn = 1;
        player.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      }
    }
    this.resetTurnQuotas(activePlayerId);
    this.emit('AUTO_UNTAP_RESOLVED', { activePlayerId });
  }

  handleUpkeepStep(activePlayerId, turnNumber, roundNumber) {
    this.emit('UPKEEP_PERK_PROMPT_READY', {
      activePlayerId,
      turnNumber: turnNumber || this.turnNumber,
      roundNumber: roundNumber || this.roundNumber
    });
  }

  handleCleanupStep(activePlayerId) {
    this.clearEndOfTurnEffects();
    const count = StateBasedActionsEngine.purgeCleanupMarkedDamage(this);
    if (this.abilityEngine && Array.isArray(this.abilityEngine.staticEffects)) {
      this.abilityEngine.staticEffects = this.abilityEngine.staticEffects.filter(ef => ef.duration !== 'END_OF_TURN');
    }
    this.runSBACheck();
    this.emit('CLEANUP_DAMAGE_PURGED', { activePlayerId, purgedCount: count });
  }

  handlePhaseStepChanged(data = {}) {
    this.clearUndoableManaTaps();
    const { currentPhaseStep, activePlayerId } = data;

    this.recordTrace('PHASE_TRACE', 'PHASE_TRANSITION', {
      previousStep: data.previousStep || null,
      currentPhaseStep,
      activePlayerId,
      priorityPlayerId: this.priorityMachine?.priorityPlayerId || this._priorityMachine?.priorityPlayerId || activePlayerId,
      turnNumber: this.priorityMachine?.turnNumber ?? this._priorityMachine?.turnNumber ?? 1,
      stackSize: typeof this.priorityMachine?.getStackSize === 'function' ? this.priorityMachine.getStackSize() : (typeof this._priorityMachine?.getStackSize === 'function' ? this._priorityMachine.getStackSize() : 0),
      combatAttackersCount: this.combatState?.attackers?.length || 0,
      combatBlockersCount: this.combatState?.blockers?.length || 0
    });

    if (
      currentPhaseStep === 'END_COMBAT' ||
      currentPhaseStep === 'POSTCOMBAT_MAIN' ||
      currentPhaseStep === 'MAIN_2' ||
      currentPhaseStep === 'END' ||
      currentPhaseStep === 'UNTAP'
    ) {
      this.endCombat();
    }

    if (currentPhaseStep === 'UNTAP') {
      this.handleUntapStep(activePlayerId);
    } else if (currentPhaseStep === 'UPKEEP') {
      this.handleUpkeepStep(activePlayerId, data.turnNumber, data.roundNumber || this.roundNumber);
    } else if (currentPhaseStep === 'DRAW') {
      const is1v1 = (this._priorityMachine?.players?.length === 2) || (Object.keys(this.players).length === 2);
      const startingPid = this.startingPlayerId || this._priorityMachine?.startingPlayerId || Object.keys(this.players)[0];
      const isFirstTurnOfStartingPlayer = this._priorityMachine
        ? (this._priorityMachine.activePlayerId === startingPid && (this._priorityMachine.turnNumber === 1 || (this._priorityMachine.roundNumber === 1 && (this._priorityMachine.playerTurnCounts?.get(startingPid) || 0) <= 1)))
        : (activePlayerId === startingPid && this.turnNumber === 1);
      const shouldSkip = data.shouldSkipDraw !== undefined
        ? data.shouldSkipDraw
        : (is1v1 && isFirstTurnOfStartingPlayer);

      if (!shouldSkip) {
        const turnKey = `${activePlayerId}_${this._priorityMachine?.turnNumber || this.turnNumber}_draw`;
        if (!this._drawsExecutedThisTurn) this._drawsExecutedThisTurn = new Set();
        if (!this._drawsExecutedThisTurn.has(turnKey)) {
          this._drawsExecutedThisTurn.add(turnKey);
          try {
            this.drawCardForTurn(activePlayerId);
            this.emit('AUTO_DRAW_RESOLVED', { activePlayerId });
          } catch (err) {}
        }
      }
    } else if (currentPhaseStep === 'BEGIN_COMBAT') {
      this.recordTrace('COMBAT_TRACE', 'BEGIN_COMBAT', { activePlayerId });
    } else if (currentPhaseStep === 'DECLARE_BLOCKERS') {
      const attackers = this.combatState?.attackers || [];
      const defendingPid = attackers[0]?.defendingPlayerId || Object.keys(this.players || {}).find(id => id !== activePlayerId && !this.players[id]?.isEliminated) || null;
      this.recordTrace('COMBAT_TRACE', 'ENTER_DECLARE_BLOCKERS', {
        activePlayerId,
        waitingForDefender: defendingPid,
        attackerIds: attackers.map(a => a.instanceId || a.id)
      });
    } else if (currentPhaseStep === 'COMBAT_DAMAGE') {
      this.resolveCombatDamage();
    } else if (currentPhaseStep === 'CLEANUP') {
      this.handleCleanupStep(activePlayerId);
    }
  }

  runSBACheck() {
    const result = StateBasedActionsEngine.runSBACheck(this, this.abilityEngine);
    if (result && Array.isArray(result.actions)) {
      for (const act of result.actions) {
        if (act.type === 'DIES_TRIGGER_DAMAGE_DEALT' && act.sourceId) {
          for (const p of Object.values(this.players || {})) {
            const foundInGY = (p.graveyard || []).find(c => c && (c.instanceId === act.sourceId || c.previousInstanceId === act.sourceId || c.id === act.sourceId));
            if (foundInGY) {
              foundInGY._onDiesResolved = true;
            }
          }
        }
      }
    }
    this._reconcileDetachedEquipments();
    return result;
  }

  /**
   * Resolves FLING_SACRIFICE_DAMAGE (e.g. Burn Together Adventure spell):
   * Deals damage equal to target/selected controlled creature's effective power to target/opponent,
   * then sacrifices that creature (firing ON_DIES triggers such as Heartfire Hero).
   */
  _resolveFlingSacrificeDamage(controllerId, sourceCard, rawTargets = [], legalTargets = [], effect = {}, resolvedItem = null) {
    const player = this.getPlayer(controllerId);
    const controlledCreatures = player?.battlefield?.creatures || [];
    if (controlledCreatures.length === 0) return;

    const targetIds = (Array.isArray(rawTargets) ? rawTargets : [])
      .map(t => (typeof t === 'string' ? t : (t?.instanceId || t?.id || t?.targetId || t?.playerId)))
      .filter(Boolean);

    const comb = resolvedItem?.selectedCombination || resolvedItem?.options?.selectedCombination || resolvedItem?.options || sourceCard?.selectedCombination || {};
    // 1. Identify which controlled creature is being flung/sacrificed
    const explicitCreatureId =
      comb.creatureId ||
      resolvedItem?.creatureId ||
      resolvedItem?.options?.creatureId ||
      resolvedItem?.payload?.creatureId ||
      resolvedItem?.sourceCreatureId ||
      resolvedItem?.options?.sourceCreatureId ||
      resolvedItem?.payload?.sourceCreatureId ||
      effect?.creatureId ||
      effect?.sourceCreatureId ||
      sourceCard?.creatureId ||
      sourceCard?.options?.creatureId ||
      sourceCard?.payload?.creatureId ||
      sourceCard?.sourceCreatureId;

    let flungCreature = null;
    if (explicitCreatureId) {
      flungCreature = controlledCreatures.find(c => c && (c.instanceId === explicitCreatureId || c.id === explicitCreatureId)) || null;
    }

    if (!flungCreature && targetIds.length > 0) {
      for (const tid of targetIds) {
        const match = controlledCreatures.find(c => c && (c.instanceId === tid || c.id === tid));
        if (match) {
          flungCreature = match;
          break;
        }
      }
    }

    if (!flungCreature) {
      // Fallback only if no explicit creature is provided: pick highest effective power
      let bestPower = -Infinity;
      for (const cr of controlledCreatures) {
        if (!cr) continue;
        const evalCr = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
          ? this.abilityEngine.evaluateCreatureStats(cr, this)
          : (typeof AbilityEngine !== 'undefined' && typeof AbilityEngine.evaluateCreatureStats === 'function'
              ? AbilityEngine.evaluateCreatureStats(cr, this)
              : this.evaluateCreatureStats(cr, controllerId));
        const pwr = Number(evalCr?.power ?? evalCr?.effectivePower ?? cr.effectivePower ?? cr.power ?? 0);
        if (pwr > bestPower) {
          bestPower = pwr;
          flungCreature = cr;
        }
      }
    }
    if (!flungCreature) return;

    // Calculate effective power using LKI before sacrifice
    const stats = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
      ? this.abilityEngine.evaluateCreatureStats(flungCreature, this)
      : (typeof AbilityEngine !== 'undefined' && typeof AbilityEngine.evaluateCreatureStats === 'function'
          ? AbilityEngine.evaluateCreatureStats(flungCreature, this)
          : this.evaluateCreatureStats(flungCreature, controllerId));
    const damageAmount = Math.max(0, Number(stats?.power ?? stats?.effectivePower ?? flungCreature.effectivePower ?? flungCreature.power ?? 0));

    // 2. Identify damage recipient
    let oppPid = Object.keys(this.players || {}).find(pid => pid !== controllerId && !this.players[pid]?.isEliminated) || null;
    let damageTargetId =
      comb.targetId ||
      resolvedItem?.targetId ||
      resolvedItem?.options?.targetId ||
      resolvedItem?.payload?.targetId ||
      effect?.damageTargetId ||
      effect?.targetId ||
      sourceCard?.targetId ||
      sourceCard?.options?.targetId ||
      null;

    if (!damageTargetId) {
      for (const tid of targetIds) {
        if (tid !== (flungCreature.instanceId || flungCreature.id)) {
          damageTargetId = tid;
          break;
        }
      }
    }
    if (!damageTargetId) {
      damageTargetId = oppPid;
    }

    if (damageAmount > 0 && damageTargetId) {
      let targetPerm = null;
      for (const p of Object.values(this.players || {})) {
        const bf = [
          ...(p.battlefield?.creatures || []),
          ...(p.battlefield?.noncreatures || []),
          ...(p.battlefield?.planeswalkers || [])
        ];
        const found = bf.find(c => c && (c.instanceId === damageTargetId || c.id === damageTargetId));
        if (found) {
          targetPerm = found;
          break;
        }
      }

      if (targetPerm) {
        targetPerm.damageMarked = (targetPerm.damageMarked || 0) + damageAmount;
      } else {
        const targetPlayer = this.players[damageTargetId] || (oppPid && this.players[oppPid]);
        if (targetPlayer) {
          const tPid = targetPlayer.id || targetPlayer.playerId || damageTargetId;
          this.adjustLife(tPid, { delta: -damageAmount });
          this.emit('LIFE_LOST', { playerId: tPid, amount: damageAmount, newLife: targetPlayer.resources?.life });
          this.emit('DAMAGE_DEALT', {
            sourceId: flungCreature.instanceId || sourceCard?.instanceId,
            sourceName: flungCreature.name,
            sourceControllerId: controllerId,
            targetId: tPid,
            targetType: 'PLAYER',
            amount: damageAmount
          });
        }
      }
    }

    // 3. Sacrifice the flung creature
    const sacrificeId = flungCreature.instanceId || flungCreature.id;
    this.handleCreatureDeath(flungCreature, controllerId);
    this.abilityEngine?.unregisterEffectsFromSource?.(sacrificeId);
    ZoneTransitionMatrix.moveCard(player, sacrificeId, 'battlefield', 'graveyard');
    this._reconcileDetachedEquipments();
    this.emit('PERMANENT_SACRIFICED', { playerId: controllerId, cardId: sacrificeId, card: flungCreature });
    this.emit('PERMANENT_SACRIFICED', { playerId: controllerId, cardId: sacrificeId, card: flungCreature });
  }

  /**
   * Computes the effective equip cost string (e.g. "{0}" or "{5}") for equipping `equipment`
   * onto `targetCreature`, applying TARGET_EQUIP_COST_REDUCTION (e.g. Fervent Champion's {3} reduction).
   *
   * @param {string} playerId
   * @param {Object|string} equipmentOrId
   * @param {Object|string} targetCreatureOrId
   * @returns {string}
   */
  computeEquipCost(playerId, equipmentOrId, targetCreatureOrId) {
    const player = this.getPlayer(playerId);
    const equipment = typeof equipmentOrId === 'object'
      ? equipmentOrId
      : (player.battlefield?.noncreatures || []).find(e => e && (e.instanceId === equipmentOrId || e.id === equipmentOrId));
    const targetCreature = typeof targetCreatureOrId === 'object'
      ? targetCreatureOrId
      : (player.battlefield?.creatures || []).find(c => c && (c.instanceId === targetCreatureOrId || c.id === targetCreatureOrId));

    if (!equipment) {
      throw new CardNotFoundError(`Equipment not found on battlefield for player ${playerId}`);
    }
    if (!equipment.compiledMechanics) TabletopStateManager.hydrateCardMechanics(equipment);
    if (targetCreature && !targetCreature.compiledMechanics) TabletopStateManager.hydrateCardMechanics(targetCreature);

    const rawEquipCost = equipment.compiledMechanics?.equipCost || equipment.equipCost || '{0}';
    return CastAvailabilityManager.computeEffectiveEquipCost(equipment, targetCreature, this, playerId, rawEquipCost);
  }

  /**
   * Activates an Equipment's Equip ability targeting a controlled creature,
   * paying the effective equip mana cost (with Fervent Champion's {3} reduction,
   * Forge Anew's first-equip {0}, and Belt of Giant Strength's power discount)
   * via autoTapForMana and attaching the equipment.
   *
   * @param {string} playerId
   * @param {string} equipmentId
   * @param {string} targetCreatureId
   * @param {Object} [options={}]
   */
  activateEquipAbility(playerId, equipmentId, targetCreatureId, options = {}) {
    this.clearUndoableManaTaps(playerId);
    const player = this.getPlayer(playerId);
    const equipment = (player.battlefield?.noncreatures || []).find(e => e && (e.instanceId === equipmentId || e.id === equipmentId));
    if (!equipment) {
      throw new CardNotFoundError(`Equipment ${equipmentId} not found on battlefield`);
    }
    const targetCreature = (player.battlefield?.creatures || []).find(c => c && (c.instanceId === targetCreatureId || c.id === targetCreatureId));
    if (!targetCreature) {
      throw new CardNotFoundError(`Target creature ${targetCreatureId} not found on battlefield`);
    }

    const effectiveCostStr = this.computeEquipCost(playerId, equipment, targetCreature);
    const parsed = this._parseManaCostString(effectiveCostStr);

    if (!options.isFree && parsed.totalCmc > 0) {
      this.autoTapForMana(playerId, effectiveCostStr);
    }

    player.equipsActivatedThisTurn = (player.equipsActivatedThisTurn || 0) + 1;

    const attachRes = this.attachPermanentToCreature(playerId, equipmentId, targetCreatureId);
    return {
      ...attachRes,
      effectiveEquipCost: effectiveCostStr
    };
  }

  /**
   * Finds any permanent on any player's battlefield by instanceId.
   */
  findPermanentById(instanceId) {
    if (!instanceId) return null;
    for (const [pid, p] of Object.entries(this.players || {})) {
      const allBf = [
        ...(p.battlefield?.creatures || []),
        ...(p.battlefield?.lands || []),
        ...(p.battlefield?.noncreatures || []),
        ...(p.battlefield?.planeswalkers || [])
      ];
      const found = allBf.find(c => c && (c.instanceId === instanceId || c.id === instanceId));
      if (found) return { card: found, player: p, playerId: pid };
    }
    return null;
  }

  /**
   * Removes a permanent from all battlefield arrays of a player.
   */
  _removePermanentFromBattlefield(player, card) {
    if (!player || !card) return;
    const cid = card.instanceId || card.id;
    for (const sub of ['creatures', 'lands', 'noncreatures', 'planeswalkers']) {
      if (Array.isArray(player.battlefield?.[sub])) {
        const idx = player.battlefield[sub].findIndex(c => c && (c === card || c.instanceId === cid || c.id === cid));
        if (idx !== -1) player.battlefield[sub].splice(idx, 1);
      }
    }
    if (Array.isArray(player.zones?.battlefield)) {
      const zIdx = player.zones.battlefield.findIndex(c => c && (c === card || c.instanceId === cid || c.id === cid));
      if (zIdx !== -1) player.zones.battlefield.splice(zIdx, 1);
    }
  }

  /**
   * Clears end-of-turn temporary effects, control changes (e.g. Stolen Uniform),
   * temporary animations, hexproof shields, and damage prevention shields.
   */
  clearEndOfTurnEffects() {
    for (const [pid, p] of Object.entries(this.players || {})) {
      p.hasHexproofUntilEOT = false;
      p.hexproofUntilEOT = false;
      p.preventColorDamageUntilEOT = null;
      p._damagePreventionShields = [];
      p.equipsActivatedThisTurn = 0;

      // Check for temporary control effects (e.g. Stolen Uniform)
      const noncreatures = [...(p.battlefield?.noncreatures || [])];
      for (const eq of noncreatures) {
        if (eq && eq._stolenUniformOriginalController) {
          const origPid = eq._stolenUniformOriginalController;
          const origPlayer = this.players?.[origPid];
          // "When you lose control of that Equipment this turn, if it's attached to a creature you control, unattach it."
          if (eq.attachedTo) {
            const attachedCr = (p.battlefield?.creatures || []).find(c => c && (c.instanceId === eq.attachedTo || c.id === eq.attachedTo));
            if (attachedCr) {
              eq.attachedTo = null;
              if (Array.isArray(attachedCr.attachedCards)) {
                attachedCr.attachedCards = attachedCr.attachedCards.filter(a => a !== eq && a?.instanceId !== eq.instanceId);
              }
              const evaluated = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
                ? this.abilityEngine.evaluateCreatureStats(attachedCr, this)
                : (typeof AbilityEngine.evaluateCreatureStats === 'function'
                    ? AbilityEngine.evaluateCreatureStats(attachedCr, this)
                    : this.evaluateCreatureStats(attachedCr, attachedCr.controllerId || pid));
              attachedCr.effectivePower = evaluated.power ?? evaluated.effectivePower ?? attachedCr.power;
              attachedCr.effectiveToughness = evaluated.toughness ?? evaluated.effectiveToughness ?? attachedCr.toughness;
            }
          }
          this._removePermanentFromBattlefield(p, eq);
          eq.controllerId = origPid;
          delete eq._stolenUniformOriginalController;
          if (origPlayer) {
            origPlayer.battlefield.noncreatures = origPlayer.battlefield.noncreatures || [];
            if (!origPlayer.battlefield.noncreatures.includes(eq)) {
              origPlayer.battlefield.noncreatures.push(eq);
            }
            if (origPlayer.zones) {
              origPlayer.zones.battlefield = origPlayer.zones.battlefield || [];
              if (!origPlayer.zones.battlefield.includes(eq)) {
                origPlayer.zones.battlefield.push(eq);
              }
            }
          }
        }
      }

      // Revert animated land creatures back to lands subzone (CR 611.2a & CR 301.5c)
      const creatures = [...(p.battlefield?.creatures || [])];
      for (const cr of creatures) {
        if (!cr) continue;
        const isAnimatedLand = Boolean(
          cr._isAnimatedLandUntilEOT === true ||
          cr._animatedFromLand === true ||
          cr.name === 'Inkmoth Nexus' ||
          /inkmoth nexus/i.test(cr.name || '')
        );

        if (isAnimatedLand) {
          const cardId = cr.instanceId || cr.id;

          // a) Remove from player.battlefield.creatures
          this._removePermanentFromBattlefield(p, cr);

          // b) Restore land typeLine, subzone, clear stats & granted keywords
          cr.typeLine = cr._originalTypeLine || cr._originalLandTypeLine || 'Land';
          cr.type = 'Land';
          cr.subzone = 'lands';
          delete cr.power;
          delete cr.toughness;
          delete cr.basePower;
          delete cr.baseToughness;
          cr._isAnimatedLandUntilEOT = false;
          delete cr._animatedFromLand;
          delete cr._originalLandTypeLine;
          if (cr.keywords) {
            delete cr.keywords.flying;
            delete cr.keywords.infect;
            delete cr.keywords.Flying;
            delete cr.keywords.Infect;
          }

          // c) CR 301.5c (Unattach Equipments)
          for (const otherPlayer of Object.values(this.players || {})) {
            const playerNoncreatures = otherPlayer.battlefield?.noncreatures || [];
            for (const eq of playerNoncreatures) {
              if (eq && (eq.attachedTo === cardId || eq.attachedTo === cr.id || eq.attachedTo === cr.instanceId)) {
                eq.attachedTo = null;
              }
            }
          }
          if (Array.isArray(cr.attachedCards)) {
            for (const eq of cr.attachedCards) {
              if (eq && typeof eq === 'object') {
                eq.attachedTo = null;
              }
            }
            cr.attachedCards = [];
          }

          // d) Reinsert into player.battlefield.lands (preserving isTapped) and ensure in player.zones.battlefield
          p.battlefield.lands = p.battlefield.lands || [];
          if (!p.battlefield.lands.some(l => l === cr || (cardId && (l.instanceId === cardId || l.id === cardId)))) {
            p.battlefield.lands.push(cr);
          }
          if (p.zones) {
            p.zones.battlefield = p.zones.battlefield || [];
            if (!p.zones.battlefield.some(l => l === cr || (cardId && (l.instanceId === cardId || l.id === cardId)))) {
              p.zones.battlefield.push(cr);
            }
          }
        }
      }
    }

    if (this.abilityEngine && Array.isArray(this.abilityEngine.staticEffects)) {
      this.abilityEngine.staticEffects = this.abilityEngine.staticEffects.filter(ef => ef.duration !== 'END_OF_TURN');
    }
    if (this.abilityEngine && typeof this.abilityEngine.evaluateAllLayers === 'function') {
      this.abilityEngine.evaluateAllLayers(this);
    }
  }

  /**
   * Direct helper to resolve an instant/sorcery spell's effect in unit tests or direct execution.
   */
  resolveSpellEffect(playerId, card, options = {}) {
    const player = this.getPlayer(playerId);
    if (!card) return null;
    if (!card.compiledMechanics) TabletopStateManager.hydrateCardMechanics(card);

    const effects = card.compiledMechanics?.spellEffects || [];
    const nameLower = (card.name || '').toLowerCase();
    const oracleLower = (card.oracleText || '').toLowerCase();

    // 1. Stolen Uniform: Gain control of target Equipment until EOT, attach to target creature you control
    if (
      effects.some(e => e.action === 'GAIN_CONTROL_ATTACH_EQUIPMENT') ||
      nameLower === 'stolen uniform' ||
      /gain control of that equipment until end of turn/i.test(oracleLower)
    ) {
      const comb = options.selectedCombination || options.options?.selectedCombination || card?.selectedCombination || options;
      const targetCreatureId = comb.creatureId || comb.targetCreatureId || options.targetCreatureId || options.creatureId || options.targetId || (Array.isArray(options.targets) ? options.targets[0] : null);
      const targetEquipmentId = comb.equipmentId || comb.targetEquipmentId || options.targetEquipmentId || options.equipmentId || (Array.isArray(options.targets) ? options.targets[1] : null);

      const targetCreature = (player.battlefield?.creatures || []).find(c => c && (c.instanceId === targetCreatureId || c.id === targetCreatureId))
        || (player.zones?.battlefield?.find(c => c && (c.instanceId === targetCreatureId || c.id === targetCreatureId)));
      const eqFound = this.findPermanentById(targetEquipmentId);

      if (targetCreature && eqFound && eqFound.card) {
        const eq = eqFound.card;
        const prevControllerId = eqFound.playerId || eq.controllerId;

        // Unattach from any previous creature
        if (eq.attachedTo) {
          for (const p of Object.values(this.players || {})) {
            for (const cr of (p.battlefield?.creatures || [])) {
              if (cr && Array.isArray(cr.attachedCards)) {
                cr.attachedCards = cr.attachedCards.filter(a => a !== eq && a?.instanceId !== eq.instanceId);
              }
            }
          }
          eq.attachedTo = null;
        }

        if (prevControllerId !== playerId) {
          eq._stolenUniformOriginalController = prevControllerId;
          this._removePermanentFromBattlefield(eqFound.player, eq);
          eq.controllerId = playerId;
          player.battlefield.noncreatures = player.battlefield.noncreatures || [];
          if (!player.battlefield.noncreatures.includes(eq)) {
            player.battlefield.noncreatures.push(eq);
          }
          if (player.zones) {
            player.zones.battlefield = player.zones.battlefield || [];
            if (!player.zones.battlefield.includes(eq)) {
              player.zones.battlefield.push(eq);
            }
          }
        }

        // Attach to target creature
        eq.attachedTo = targetCreature.instanceId || targetCreature.id;
        targetCreature.attachedCards = targetCreature.attachedCards || [];
        if (!targetCreature.attachedCards.includes(eq)) {
          targetCreature.attachedCards.push(eq);
        }

        // Trigger Valiant if first time targeted this turn
        this._checkAndTriggerValiant(targetCreature, playerId, card);

        // Recompute targetCreature.effectivePower and targetCreature.effectiveToughness
        if (this.abilityEngine && typeof this.abilityEngine.evaluateAllLayers === 'function') {
          this.abilityEngine.evaluateAllLayers(this);
        }
        const evaluated = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
          ? this.abilityEngine.evaluateCreatureStats(targetCreature, this)
          : (typeof AbilityEngine.evaluateCreatureStats === 'function'
              ? AbilityEngine.evaluateCreatureStats(targetCreature, this)
              : this.evaluateCreatureStats(targetCreature, playerId));
        targetCreature.effectivePower = evaluated.power ?? evaluated.effectivePower ?? targetCreature.power;
        targetCreature.effectiveToughness = evaluated.toughness ?? evaluated.effectiveToughness ?? targetCreature.toughness;
      }
      return { resolved: 'GAIN_CONTROL_ATTACH_EQUIPMENT' };
    }

    // 2. Resolute Strike: Target creature gets +2/+2 until EOT. If it's a Warrior, you may attach target Equipment you control to it.
    if (nameLower === 'resolute strike' || /if it's a warrior, you may attach target equipment/i.test(oracleLower)) {
      const comb = options.selectedCombination || options.options?.selectedCombination || card?.selectedCombination || options;
      const targetCreatureId = comb.creatureId || comb.targetCreatureId || options.targetCreatureId || options.creatureId || options.targetId || (Array.isArray(options.targets) ? options.targets[0] : null);
      const targetEquipmentId = comb.equipmentId || comb.targetEquipmentId || options.targetEquipmentId || options.equipmentId || (Array.isArray(options.targets) ? options.targets[1] : null);
      const targetCreature = (player.battlefield?.creatures || []).find(c => c && (c.instanceId === targetCreatureId || c.id === targetCreatureId))
        || (player.zones?.battlefield?.find(c => c && (c.instanceId === targetCreatureId || c.id === targetCreatureId)));

      if (targetCreature) {
        if (this.abilityEngine) {
          this.abilityEngine.registerStaticEffect({
            id: `resolute_strike_${Date.now()}_${targetCreature.instanceId}`,
            sourceId: card.instanceId || 'resolute_strike',
            layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
            powerMod: 2,
            toughnessMod: 2,
            duration: 'END_OF_TURN',
            appliesTo: (perm) => perm && (perm.instanceId === targetCreature.instanceId || perm.id === targetCreature.instanceId)
          });
        } else {
          targetCreature.power = (targetCreature.power || 0) + 2;
          targetCreature.toughness = (targetCreature.toughness || 0) + 2;
        }

        this._checkAndTriggerValiant(targetCreature, playerId, card);

        const isWarrior = /\bwarrior\b/i.test(targetCreature.typeLine || targetCreature.type || '') ||
          (this.abilityEngine && /\bwarrior\b/i.test((this.abilityEngine.evaluatePermanentLayers(targetCreature, this)?.subtypes || []).join(' ')));

        if (isWarrior && targetEquipmentId) {
          const eq = (player.battlefield?.noncreatures || []).find(e => e && (e.instanceId === targetEquipmentId || e.id === targetEquipmentId));
          if (eq) {
            this.attachPermanentToCreature(playerId, eq.instanceId, targetCreature.instanceId);
          }
        }

        if (this.abilityEngine && typeof this.abilityEngine.evaluateAllLayers === 'function') {
          this.abilityEngine.evaluateAllLayers(this);
        }
        const evaluated = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
          ? this.abilityEngine.evaluateCreatureStats(targetCreature, this)
          : (typeof AbilityEngine.evaluateCreatureStats === 'function'
              ? AbilityEngine.evaluateCreatureStats(targetCreature, this)
              : this.evaluateCreatureStats(targetCreature, playerId));
        targetCreature.effectivePower = evaluated.power ?? evaluated.effectivePower ?? targetCreature.power;
        targetCreature.effectiveToughness = evaluated.toughness ?? evaluated.effectiveToughness ?? targetCreature.toughness;
      }
      return { resolved: 'RESOLUTE_STRIKE' };
    }

    // 3. Surge of Salvation: You and permanents you control gain hexproof until EOT. Prevent all damage that black and/or red sources would deal to creatures you control this turn.
    if (nameLower === 'surge of salvation' || /prevent all damage that black and\/or red sources would deal to creatures you control/i.test(oracleLower)) {
      player.hasHexproofUntilEOT = true;
      player.hexproofUntilEOT = true;
      player.preventColorDamageUntilEOT = ['B', 'R'];
      player._damagePreventionShields = player._damagePreventionShields || [];
      player._damagePreventionShields.push({ colors: ['B', 'R'], duration: 'END_OF_TURN' });

      const allPerms = [
        ...(player.battlefield?.creatures || []),
        ...(player.battlefield?.lands || []),
        ...(player.battlefield?.noncreatures || []),
        ...(player.battlefield?.planeswalkers || [])
      ];
      for (const perm of allPerms) {
        perm.keywords = perm.keywords || {};
        perm.keywords.hexproof = true;
        perm.keywords.Hexproof = true;
        if (this.abilityEngine) {
          this.abilityEngine.registerStaticEffect({
            id: `surge_hexproof_${Date.now()}_${perm.instanceId}`,
            sourceId: card.instanceId || 'surge_of_salvation',
            layer: CONTINUOUS_LAYERS.LAYER_6_ABILITY,
            keywordsGranted: ['hexproof'],
            duration: 'END_OF_TURN',
            appliesTo: (p) => p && (p.instanceId === perm.instanceId || p.id === perm.instanceId)
          });
        }
      }
      return { resolved: 'SURGE_OF_SALVATION' };
    }

    // 4. Surgical Extraction: Choose target card in a graveyard other than a basic land card. Search its owner's graveyard, hand, and library for any number of cards with the same name as that card and exile them.
    if (
      effects.some(e => e.action === 'SURGICAL_EXTRACT_NAME') ||
      nameLower === 'surgical extraction' ||
      /search its owner's graveyard, hand, and library for any number of cards with the same name/i.test(oracleLower)
    ) {
      const targetCardId = options.targetCardId || (Array.isArray(options.targets) ? options.targets[0] : null);
      let targetCard = null;
      let ownerPlayer = null;

      for (const p of Object.values(this.players || {})) {
        const found = (p.graveyard || []).find(c => c && (c.instanceId === targetCardId || c.id === targetCardId));
        if (found) {
          targetCard = found;
          ownerPlayer = p;
          break;
        }
      }

      if (targetCard && ownerPlayer && !/\bbasic\b.*\bland\b/i.test(targetCard.typeLine || '')) {
        const targetName = (targetCard.name || '').trim().toLowerCase();
        const exileFromZone = (zoneArr, zoneSyncArr) => {
          if (!Array.isArray(zoneArr)) return;
          for (let i = zoneArr.length - 1; i >= 0; i--) {
            const c = zoneArr[i];
            if (c && (c.name || '').trim().toLowerCase() === targetName) {
              const [removed] = zoneArr.splice(i, 1);
              if (Array.isArray(zoneSyncArr) && zoneSyncArr !== zoneArr) {
                const sIdx = zoneSyncArr.findIndex(sc => sc && (sc === removed || sc.instanceId === removed.instanceId));
                if (sIdx !== -1) zoneSyncArr.splice(sIdx, 1);
              }
              removed.zone = 'exile';
              ownerPlayer.exile = ownerPlayer.exile || [];
              ownerPlayer.exile.push(removed);
              if (ownerPlayer.zones && Array.isArray(ownerPlayer.zones.exile) && ownerPlayer.zones.exile !== ownerPlayer.exile) {
                ownerPlayer.zones.exile.push(removed);
              }
            }
          }
        };

        exileFromZone(ownerPlayer.graveyard, ownerPlayer.zones?.graveyard);
        exileFromZone(ownerPlayer.hand, ownerPlayer.zones?.hand);
        exileFromZone(ownerPlayer.library, ownerPlayer.zones?.library);
      }
      return { resolved: 'SURGICAL_EXTRACT_NAME' };
    }

    // Fallback for generic PUMP_PT_AND_KEYWORDS
    for (const effect of effects) {
      if (effect.action === 'PUMP_PT_AND_KEYWORDS') {
        const tid = options.targetCreatureId || (Array.isArray(options.targets) ? options.targets[0] : null);
        const targetCr = (player.battlefield?.creatures || []).find(c => c && (c.instanceId === tid || c.id === tid));
        if (targetCr && this.abilityEngine) {
          this.abilityEngine.registerStaticEffect({
            id: `pump_${Date.now()}_${targetCr.instanceId}`,
            sourceId: card.instanceId || 'spell',
            layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
            powerMod: Number(effect.powerDelta || 0),
            toughnessMod: Number(effect.toughnessDelta || 0),
            duration: effect.duration || 'END_OF_TURN',
            appliesTo: (perm) => perm && (perm.instanceId === targetCr.instanceId || perm.id === targetCr.instanceId)
          });
        }
      }
    }
    return { resolved: 'GENERIC' };
  }

  /**
   * Deals non-combat or spell damage to a creature on a player's battlefield,
   * respecting color damage prevention shields (e.g. Surge of Salvation vs Black/Red sources).
   */
  dealDamageToCreature(playerId, creatureId, amount, options = {}) {
    const player = this.getPlayer(playerId);
    const creature = (player.battlefield?.creatures || []).find(c => c && (c.instanceId === creatureId || c.id === creatureId));
    if (!creature) {
      throw new CardNotFoundError(`Creature ${creatureId} not found on battlefield for player ${playerId}`);
    }

    const dmg = Math.max(0, Number(amount) || 0);
    if (dmg === 0) return 0;

    const sourceColors = Array.isArray(options.sourceColors)
      ? options.sourceColors.map(c => String(c).toUpperCase())
      : (options.sourceColor ? [String(options.sourceColor).toUpperCase()] : []);

    // Check Surge of Salvation / color damage prevention shield
    const preventedColors = player.preventColorDamageUntilEOT || [];
    const hasMatchingShield = sourceColors.some(col => preventedColors.includes(col)) ||
      (Array.isArray(player._damagePreventionShields) && player._damagePreventionShields.some(sh =>
        Array.isArray(sh.colors) && sourceColors.some(col => sh.colors.includes(col))
      ));

    if (hasMatchingShield) {
      this.emit('DAMAGE_PREVENTED', { playerId, creatureId, amount: dmg, sourceColors });
      return 0;
    }

    creature.damageMarked = (creature.damageMarked || 0) + dmg;
    this.emit('DAMAGE_DEALT', { targetId: creatureId, targetType: 'CREATURE', amount: dmg, sourceColors });
    return dmg;
  }

  /**
   * Deals damage to a Battle — Siege permanent, removing defense counters.
   * When defense counters reach 0 (CR 310.11b), exiles the Battle and casts/transforms its back face (e.g. Lightshield Array).
   */
  dealDamageToBattle(battleId, amount) {
    const found = this.findPermanentById(battleId);
    if (!found || !found.card) {
      throw new CardNotFoundError(`Battle ${battleId} not found on battlefield`);
    }
    const { card: battle, player, playerId } = found;
    const dmg = Math.max(0, Number(amount) || 0);
    battle.counters = battle.counters || {};
    const currentDefense = Number(battle.counters.defense ?? battle.defense ?? 0);
    const nextDefense = Math.max(0, currentDefense - dmg);
    battle.counters.defense = nextDefense;
    battle.defense = nextDefense;

    if (nextDefense === 0) {
      if (!battle.compiledMechanics) TabletopStateManager.hydrateCardMechanics(battle);
      const transformMode = (battle.compiledMechanics?.castModes || []).find(m => m.mode === 'TRANSFORM');
      if (transformMode || /invasion of gobakhan/i.test(battle.name || '')) {
        if (!battle._frontFaceSnapshot) {
          battle._frontFaceSnapshot = {
            name: battle.name,
            typeLine: battle.typeLine,
            oracleText: battle.oracleText
          };
        }
        battle.name = transformMode?.name || 'Lightshield Array';
        battle.typeLine = transformMode?.typeLine || 'Enchantment';
        battle.oracleText = transformMode?.oracleText || 'At the beginning of your end step, put a +1/+1 counter on each creature that attacked this turn.\nSacrifice Lightshield Array: Creatures you control gain hexproof and indestructible until end of turn.';
        battle.isTransformed = true;
        delete battle.counters.defense;
        delete battle.defense;
        TabletopStateManager.hydrateCardMechanics(battle);
        this.emit('BATTLE_DEFEATED_TRANSFORMED', { playerId, card: battle });
      }
    }

    return { battle, remainingDefense: nextDefense };
  }

  /**
   * Fires ON_ATTACKS triggers for attacking creatures (e.g. Fervent Champion:
   * "Whenever Fervent Champion attacks, another target attacking Knight you control gets +1/+0 until end of turn.").
   */
  triggerAttackAbilities(playerId, attackingCreatures = []) {
    const attackers = Array.isArray(attackingCreatures) ? attackingCreatures : [];
    for (const attacker of attackers) {
      if (!attacker) continue;
      if (!attacker.compiledMechanics) TabletopStateManager.hydrateCardMechanics(attacker);
      const triggers = attacker.compiledMechanics?.triggers || [];
      const hasKnightBuff = triggers.some(t => t.triggerType === 'ON_ATTACKS' && t.action === 'PUMP_ANOTHER_ATTACKING_KNIGHT') ||
        /whenever fervent champion attacks, another target attacking knight you control gets \+1\/\+0 until end of turn/i.test(attacker.oracleText || '');

      if (hasKnightBuff) {
        const otherKnight = attackers.find(other => {
          if (!other || other === attacker || (other.instanceId && other.instanceId === attacker.instanceId)) return false;
          const evalOther = this.abilityEngine ? this.abilityEngine.evaluatePermanentLayers(other, this) : other;
          const typesStr = `${other.typeLine || ''} ${(evalOther?.subtypes || []).join(' ')}`;
          return /\bknight\b/i.test(typesStr);
        });

        if (otherKnight) {
          if (this.abilityEngine) {
            this.abilityEngine.registerStaticEffect({
              id: `fervent_attack_${Date.now()}_${attacker.instanceId}_${otherKnight.instanceId}`,
              sourceId: attacker.instanceId,
              layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
              powerMod: 1,
              toughnessMod: 0,
              duration: 'END_OF_TURN',
              appliesTo: (perm) => perm && (perm.instanceId === otherKnight.instanceId || perm.id === otherKnight.instanceId)
            });
          } else {
            otherKnight.power = (otherKnight.power || 0) + 1;
          }
          this._checkAndTriggerValiant(otherKnight, playerId, attacker);
        }
      }
    }
  }

  /**
   * Activates a non-mana activated ability of a permanent on the battlefield
   * (e.g. Inkmoth Nexus animate, Tormod's Crypt sacrifice, Soul-Guide Lantern sacrifice,
   * Skrelv grant hexproof/unblockable, Lightshield Array sacrifice).
   */
  activatePermanentAbility(playerId, instanceId, abilityId = null, options = {}) {
    this.clearUndoableManaTaps(playerId);
    const player = this.getPlayer(playerId);
    const found = this.findPermanentById(instanceId);
    if (!found || found.playerId !== playerId) {
      throw new CardNotFoundError(`Permanent ${instanceId} not found on battlefield for player ${playerId}`);
    }
    const perm = found.card;
    if (!perm.compiledMechanics) TabletopStateManager.hydrateCardMechanics(perm);

    const abilities = perm.compiledMechanics?.activatedAbilities || [];
    let ability = abilityId
      ? abilities.find(a => a.id === abilityId || a.action === abilityId)
      : abilities[0];

    // Fallback inference by card name / abilityId
    if (!ability) {
      const nameLower = (perm.name || '').toLowerCase();
      if (abilityId === 'ANIMATE_LAND' || nameLower.includes('inkmoth nexus')) {
        ability = {
          id: 'ANIMATE_LAND',
          cost: '{1}',
          requiresTap: false,
          requiresSacrifice: false,
          action: 'ANIMATE_LAND',
          targetPower: 1,
          targetToughness: 1,
          typesAdded: ['Artifact', 'Creature'],
          subtypesAdded: ['Phyrexian', 'Blinkmoth'],
          keywordsGranted: ['flying', 'infect']
        };
      } else if (abilityId === 'SACRIFICE_EXILE_GRAVEYARD' || nameLower.includes("tormod's crypt")) {
        ability = {
          id: 'SACRIFICE_EXILE_GRAVEYARD',
          cost: '{0}',
          requiresTap: true,
          requiresSacrifice: true,
          action: 'EXILE_TARGET_PLAYER_GRAVEYARD'
        };
      } else if (abilityId === 'SACRIFICE_EXILE_OPPONENT_GRAVEYARDS') {
        ability = {
          id: 'SACRIFICE_EXILE_OPPONENT_GRAVEYARDS',
          cost: '{0}',
          requiresTap: false,
          requiresSacrifice: true,
          action: 'EXILE_EACH_OPPONENT_GRAVEYARD'
        };
      } else if (abilityId === 'SACRIFICE_DRAW_CARD') {
        ability = {
          id: 'SACRIFICE_DRAW_CARD',
          cost: '{1}',
          requiresTap: true,
          requiresSacrifice: true,
          action: 'DRAW_CARDS',
          count: 1
        };
      } else if (abilityId === 'SKRELV_GRANT_PROTECTION' || nameLower.includes('skrelv')) {
        ability = {
          id: 'SKRELV_GRANT_PROTECTION',
          cost: '{W/P}',
          requiresTap: true,
          requiresSacrifice: false,
          action: 'GRANT_COLOR_HEXPROOF_AND_UNBLOCKABLE'
        };
      } else if (abilityId === 'SACRIFICE_TEAM_SHIELD' || nameLower.includes('lightshield array') || perm.isTransformed) {
        ability = {
          id: 'SACRIFICE_TEAM_SHIELD',
          cost: '{0}',
          requiresTap: false,
          requiresSacrifice: true,
          action: 'GRANT_TEAM_HEXPROOF_INDESTRUCTIBLE'
        };
      }
    }

    if (!ability) {
      throw new ValidationError(`Activated ability '${abilityId}' not found on ${perm.name}`);
    }

    const reqTap = Boolean(ability.requiresTap ?? ability.cost?.tap);
    const reqSacrifice = Boolean(ability.requiresSacrifice ?? ability.cost?.sacrifice);
    const rawManaCost = typeof ability.cost === 'string'
      ? ability.cost
      : (ability.cost?.mana || '{0}');

    const actionType = ability.effect?.action || ability.action;
    const isLandAnimation = actionType === 'ANIMATE_LAND' || abilityId === 'ANIMATE_LAND' || /inkmoth nexus/i.test(perm.name || '') || /land/i.test(perm.typeLine || perm.type || '');

    // Inkmoth Nexus Self-Tap Exclusion: pass excludeLandIds so the animating land is never tapped to pay for its own animation {1}
    const strictExclusion = Array.isArray(options.excludeLandIds) && options.excludeLandIds.includes(perm.instanceId);
    let manaOptions = (isLandAnimation && (actionType === 'ANIMATE_LAND' || abilityId === 'ANIMATE_LAND'))
      ? {
          ...options,
          excludeLandIds: [
            ...(Array.isArray(options.excludeLandIds) ? options.excludeLandIds : (options.excludeLandIds instanceof Set ? Array.from(options.excludeLandIds) : (options.excludeLandIds ? [options.excludeLandIds] : []))),
            perm.instanceId
          ]
        }
      : options;

    if (reqTap) {
      if (perm.isTapped) {
        throw new ValidationError(`${perm.name} is already tapped.`);
      }
      if (/creature/i.test(perm.typeLine || '') && (perm.hasSummoningSickness || perm.isSummoningSick)) {
        throw new ValidationError(`${perm.name} has summoning sickness.`);
      }
      perm.isTapped = true;
    }

    // Pay mana / Phyrexian life cost if any
    if (rawManaCost && rawManaCost !== '{0}') {
      const pool = player.resources?.manaPool || {};
      let payPlan = CastAvailabilityManager.computeOptimalManaPayment(this, playerId, rawManaCost, manaOptions);
      if (!payPlan?.canPay && isLandAnimation && !strictExclusion) {
        // Fallback to self-tapping only when no other land or floating mana exists
        const fallbackPlan = CastAvailabilityManager.computeOptimalManaPayment(this, playerId, rawManaCost, options);
        if (fallbackPlan?.canPay) {
          payPlan = fallbackPlan;
          manaOptions = options;
        }
      }
      if (payPlan && payPlan.canPay) {
        if (payPlan.taps && payPlan.taps.length > 0) {
          this.autoTapForMana(playerId, rawManaCost, manaOptions);
        } else {
          for (const [col, spent] of Object.entries(payPlan.poolDeducted || payPlan.manaPaid || {})) {
            if (spent > 0 && pool[col] !== undefined) {
              pool[col] = Math.max(0, pool[col] - spent);
            }
          }
          if ((payPlan.lifePaid || payPlan.totalLifeCost) > 0) {
            this.adjustLife(playerId, { delta: -(payPlan.lifePaid || payPlan.totalLifeCost) });
          }
          this.emit('MANA_POOL_UPDATED', { playerId, manaPool: { ...player.resources.manaPool } });
        }
      } else {
        this.autoTapForMana(playerId, rawManaCost, manaOptions);
      }
    }

    // Sacrifice cost if required
    if (reqSacrifice) {
      this._removePermanentFromBattlefield(player, perm);
      // CR 712.8a: Revert transformed DFC back to front face characteristics when leaving the battlefield
      const cardForZoneChange = perm._frontFaceSnapshot
        ? { ...perm, ...perm._frontFaceSnapshot, isTransformed: false }
        : perm;
      const gyCard = ZoneTransitionMatrix.createZoneChangedObject(cardForZoneChange, 'graveyard');
      gyCard.zone = 'graveyard';
      player.graveyard.push(gyCard);
      if (player.zones && Array.isArray(player.zones.graveyard) && player.zones.graveyard !== player.graveyard) {
        player.zones.graveyard.push(gyCard);
      }
    }

    // Execute action
    if (actionType === 'ANIMATE_LAND') {
      if (!perm._animatedFromLand) {
        perm._animatedFromLand = true;
        perm._originalLandTypeLine = perm.typeLine || 'Land';
      }
      perm._isAnimatedLandUntilEOT = true;
      perm._originalTypeLine = perm._originalTypeLine || perm.typeLine || 'Land';
      perm._originalSubtypes = ['Blinkmoth'];
      const permId = perm.instanceId || perm.id;
      // Remove from lands subzone to guarantee no duplication while animated as creature
      if (Array.isArray(player.battlefield?.lands)) {
        player.battlefield.lands = player.battlefield.lands.filter(c => c && c !== perm && c.instanceId !== permId && c.id !== permId);
      }
      player.battlefield.creatures = player.battlefield.creatures || [];
      if (!player.battlefield.creatures.some(c => c === perm || (permId && (c.instanceId === permId || c.id === permId)))) {
        player.battlefield.creatures.push(perm);
      }
      perm.subzone = 'creatures';
      perm.typeLine = 'Land Artifact Creature — Blinkmoth';
      perm.power = ability.targetPower ?? ability.power ?? 1;
      perm.toughness = ability.targetToughness ?? ability.toughness ?? 1;
      perm.basePower = perm.power;
      perm.baseToughness = perm.toughness;
      perm.keywords = perm.keywords || {};
      const kwList = Array.isArray(ability.keywordsGranted)
        ? ability.keywordsGranted
        : (ability.keywords && typeof ability.keywords === 'object' ? Object.keys(ability.keywords) : ['flying', 'infect']);
      for (const kw of kwList) {
        perm.keywords[kw] = true;
        perm.keywords[kw.charAt(0).toUpperCase() + kw.slice(1)] = true;
      }
      if (this.abilityEngine) {
        this.abilityEngine.registerStaticEffect({
          id: `animate_${Date.now()}_${perm.instanceId}`,
          sourceId: perm.instanceId,
          layer: CONTINUOUS_LAYERS.LAYER_4_TYPE,
          typesAdded: ability.typesAdded || ability.additionalTypes || ['Artifact', 'Creature'],
          subtypesAdded: ability.subtypesAdded || ability.creatureTypes || ['Phyrexian', 'Blinkmoth'],
          duration: 'END_OF_TURN',
          appliesTo: (p) => p && (p.instanceId === perm.instanceId || p.id === perm.instanceId)
        });
        this.abilityEngine.registerStaticEffect({
          id: `animate_kw_${Date.now()}_${perm.instanceId}`,
          sourceId: perm.instanceId,
          layer: CONTINUOUS_LAYERS.LAYER_6_ABILITY,
          keywordsGranted: kwList,
          duration: 'END_OF_TURN',
          appliesTo: (p) => p && (p.instanceId === perm.instanceId || p.id === perm.instanceId)
        });
        this.abilityEngine.registerStaticEffect({
          id: `animate_pt_${Date.now()}_${perm.instanceId}`,
          sourceId: perm.instanceId,
          layer: CONTINUOUS_LAYERS.LAYER_7B_SET_PT,
          targetPower: perm.power,
          targetToughness: perm.toughness,
          duration: 'END_OF_TURN',
          appliesTo: (p) => p && (p.instanceId === perm.instanceId || p.id === perm.instanceId)
        });
      }
    } else if (actionType === 'EXILE_TARGET_PLAYER_GRAVEYARD' || actionType === 'EXILE_TARGET_GRAVEYARD' || actionType === 'SACRIFICE_EXILE_GRAVEYARD') {
      const targetPid = options.targetPlayerId || Object.keys(this.players || {}).find(id => id !== playerId) || playerId;
      const targetPlayer = this.players?.[targetPid];
      if (targetPlayer && Array.isArray(targetPlayer.graveyard)) {
        while (targetPlayer.graveyard.length > 0) {
          const c = targetPlayer.graveyard.pop();
          if (targetPlayer.zones && Array.isArray(targetPlayer.zones.graveyard) && targetPlayer.zones.graveyard !== targetPlayer.graveyard) {
            targetPlayer.zones.graveyard.pop();
          }
          c.zone = 'exile';
          targetPlayer.exile = targetPlayer.exile || [];
          targetPlayer.exile.push(c);
          if (targetPlayer.zones && Array.isArray(targetPlayer.zones.exile) && targetPlayer.zones.exile !== targetPlayer.exile) {
            targetPlayer.zones.exile.push(c);
          }
        }
      }
    } else if (actionType === 'EXILE_EACH_OPPONENT_GRAVEYARD' || actionType === 'EXILE_OPPONENT_GRAVEYARDS' || actionType === 'SACRIFICE_EXILE_OPPONENT_GRAVEYARDS') {
      for (const [oppPid, opp] of Object.entries(this.players || {})) {
        if (oppPid !== playerId && opp && Array.isArray(opp.graveyard)) {
          while (opp.graveyard.length > 0) {
            const c = opp.graveyard.pop();
            if (opp.zones && Array.isArray(opp.zones.graveyard) && opp.zones.graveyard !== opp.graveyard) {
              opp.zones.graveyard.pop();
            }
            c.zone = 'exile';
            opp.exile = opp.exile || [];
            opp.exile.push(c);
            if (opp.zones && Array.isArray(opp.zones.exile) && opp.zones.exile !== opp.exile) {
              opp.zones.exile.push(c);
            }
          }
        }
      }
    } else if (actionType === 'DRAW_CARDS' || actionType === 'DRAW_CARD' || actionType === 'SACRIFICE_DRAW_CARD') {
      this.drawCards(playerId, ability.effect?.amount || ability.count || 1);
    } else if (actionType === 'GRANT_COLOR_HEXPROOF_AND_UNBLOCKABLE' || actionType === 'GRANT_TOXIC_AND_PROTECTION' || actionType === 'SKRELV_GRANT_PROTECTION') {
      const targetCreatureId = options.targetCreatureId;
      const chosenColor = options.chosenColor || 'R';
      const targetCr = (player.battlefield?.creatures || []).find(c => c && (c.instanceId === targetCreatureId || c.id === targetCreatureId));
      if (targetCr) {
        targetCr.keywords = targetCr.keywords || {};
        targetCr.keywords.toxic = (targetCr.keywords.toxic || 0) + 1;
        targetCr.keywords[`hexproofFrom_${chosenColor}`] = true;
        targetCr.keywords[`cantBeBlockedBy_${chosenColor}`] = true;
        this._checkAndTriggerValiant(targetCr, playerId, perm);
      }
    } else if (actionType === 'GRANT_TEAM_HEXPROOF_INDESTRUCTIBLE' || actionType === 'SACRIFICE_TEAM_SHIELD') {
      for (const cr of (player.battlefield?.creatures || [])) {
        if (!cr) continue;
        cr.keywords = cr.keywords || {};
        cr.keywords.hexproof = true;
        cr.keywords.Hexproof = true;
        cr.keywords.indestructible = true;
        cr.keywords.Indestructible = true;
        if (this.abilityEngine) {
          this.abilityEngine.registerStaticEffect({
            id: `lightshield_${Date.now()}_${cr.instanceId}`,
            sourceId: perm.instanceId,
            layer: CONTINUOUS_LAYERS.LAYER_6_ABILITY,
            keywordsGranted: ['hexproof', 'indestructible'],
            duration: 'END_OF_TURN',
            appliesTo: (p) => p && (p.instanceId === cr.instanceId || p.id === cr.instanceId)
          });
        }
      }
    }

    return { activated: ability.id, permanent: perm };
  }

  _checkAndTriggerValiant(targetCreature, controllerId, sourceObject) {
    if (!targetCreature) return;
    if (targetCreature.controllerId === controllerId) {
      this._triggerValiantIfEligible(targetCreature, sourceObject, controllerId);
    }
    const evaluated = (this.abilityEngine && typeof this.abilityEngine.evaluateCreatureStats === 'function')
      ? this.abilityEngine.evaluateCreatureStats(targetCreature, this)
      : (typeof AbilityEngine.evaluateCreatureStats === 'function'
          ? AbilityEngine.evaluateCreatureStats(targetCreature, this)
          : this.evaluateCreatureStats(targetCreature, controllerId || this));
    targetCreature.effectivePower = evaluated.power ?? evaluated.effectivePower ?? targetCreature.power;
    targetCreature.effectiveToughness = evaluated.toughness ?? evaluated.effectiveToughness ?? targetCreature.toughness;
  }

  /**
   * Resolves CR 103.6 Opening Hand Actions (e.g. Leyline Axe:
   * "If this card is in your opening hand, you may begin the game with it on the battlefield.")
   *
   * @param {string} [playerId] - Optional specific player ID; if omitted, resolves for all players.
   * @returns {Array<{ playerId: string, card: Object, name: string }>}
   */
  resolveOpeningHandActions(playerId = null) {
    const pids = playerId ? [playerId] : Object.keys(this.players || {});
    const moved = [];

    for (const pid of pids) {
      const player = this.players?.[pid];
      if (!player) continue;
      if ((!Array.isArray(player.hand) || player.hand.length === 0) && Array.isArray(player.zones?.hand) && player.zones.hand.length > 0) {
        player.hand = player.zones.hand;
      }
      if (!Array.isArray(player.hand)) continue;

      for (let i = player.hand.length - 1; i >= 0; i--) {
        const card = player.hand[i];
        if (!card) continue;
        TabletopStateManager.hydrateCardMechanics(card);

        const oracleStr = card.oracleText || card.oracle_text || card.text || '';
        const isOpeningBattlefield =
          card.compiledMechanics?.openingHandAction === 'START_ON_BATTLEFIELD' ||
          /opening\s+hand,\s*you\s+may\s+begin\s+the\s+game\s+with\s+(?:it|this\s+card|[^\n,]+)\s+on\s+the\s+battlefield/i.test(oracleStr) ||
          /^leyline\s+axe$/i.test((card.name || '').trim());

        if (isOpeningBattlefield) {
          const [removed] = player.hand.splice(i, 1);
          if (player.zones && Array.isArray(player.zones.hand) && player.zones.hand !== player.hand) {
            const zIdx = player.zones.hand.findIndex(c => c && (c === removed || (removed.instanceId && c.instanceId === removed.instanceId)));
            if (zIdx !== -1) player.zones.hand.splice(zIdx, 1);
          }
          if (player.zones) {
            player.zones.hand = player.hand;
          }

          const bfCard = ZoneTransitionMatrix.createZoneChangedObject(removed, 'battlefield');
          bfCard.zone = 'battlefield';
          bfCard.subzone = 'noncreatures';
          bfCard.isTapped = false;
          bfCard.controllerId = pid;
          bfCard.ownerId = pid;
          TabletopStateManager.hydrateCardMechanics(bfCard);

          player.battlefield.noncreatures = player.battlefield.noncreatures || [];
          player.battlefield.noncreatures.push(bfCard);
          if (player.zones) {
            player.zones.battlefield = player.zones.battlefield || [];
            player.zones.battlefield.push(bfCard);
          }

          this._onPermanentEnteredBattlefield(bfCard, pid);
          this.emit('OPENING_HAND_ACTION_RESOLVED', { playerId: pid, card: bfCard });
          moved.push({ playerId: pid, card: bfCard, name: bfCard.name });
        }
      }
    }

    return moved;
  }

  resolvePendingTriggerChoice(triggerId, selectedTargetId) {
    this.pendingTriggerChoices = this.pendingTriggerChoices || [];
    const choiceIdx = this.pendingTriggerChoices.findIndex(c => c && (c.triggerId === triggerId || c.id === triggerId));
    if (choiceIdx === -1) {
      return null;
    }
    const [choice] = this.pendingTriggerChoices.splice(choiceIdx, 1);
    const isDeclined = selectedTargetId === null || selectedTargetId === undefined || selectedTargetId === false || String(selectedTargetId).toUpperCase() === 'DECLINE';

    if (isDeclined) {
      const sourceName = choice.sourceName || "Sigarda's Aid";
      const equipName = choice.equipmentName || 'Equipment';
      this.recordTrace('TRIGGER_TRACE', 'TRIGGER_CHOICE_DECLINED', {
        triggerId,
        type: choice.type,
        sourceName,
        equipmentName: equipName,
        message: `✋ [${sourceName}]: Declined to attach ${equipName}.`
      });
      if (choice.equipmentId) {
        const found = this.findPermanentById?.(choice.equipmentId);
        if (found && found.card) {
          found.card.attachedTo = null;
        }
      }
      this.emit('TRIGGER_CHOICE_DECLINED', { choice, triggerId });
      return { success: true, declined: true, choice };
    }

    if (choice.type === 'SIGARDAS_AID_ATTACH') {
      const playerId = choice.controllerId;
      const equipmentId = choice.equipmentId;
      const res = this.attachPermanentToCreature(playerId, equipmentId, selectedTargetId, {
        source: 'ON_EQUIPMENT_ETB',
        sourceType: 'ABILITY',
        sourceId: choice.sourceId,
        isFreeAttach: true
      });
      this.emit('EQUIPMENT_ATTACHED', { equipmentId, targetCreatureId: selectedTargetId, choice });
      return { success: true, result: res, choice };
    }

    if (choice.type === 'FORGE_ANEW_ETB') {
      const playerId = choice.controllerId;
      const player = this.getPlayer(playerId);
      if (player && Array.isArray(player.graveyard)) {
        const equipIdx = player.graveyard.findIndex(c => c && (c.instanceId === selectedTargetId || c.id === selectedTargetId));
        if (equipIdx !== -1) {
          const [rawReturned] = player.graveyard.splice(equipIdx, 1);
          if (player.zones?.graveyard) {
            player.zones.graveyard = player.zones.graveyard.filter(c => c !== rawReturned && c?.instanceId !== rawReturned.instanceId);
          }
          const returned = ZoneTransitionMatrix.createZoneChangedObject(rawReturned, 'battlefield');
          returned.zone = 'battlefield';
          returned.subzone = 'noncreatures';
          returned.attachedTo = null;
          returned.controllerId = playerId;
          returned.ownerId = rawReturned.ownerId || playerId;
          TabletopStateManager.hydrateCardMechanics(returned, this.deckManifests);
          player.battlefield.noncreatures = player.battlefield.noncreatures || [];
          player.battlefield.noncreatures.push(returned);
          if (player.zones) {
            player.zones.battlefield = player.zones.battlefield || [];
            player.zones.battlefield.push(returned);
          }
          this._onPermanentEnteredBattlefield(returned, playerId);
          this.emit('EQUIPMENT_RETURNED_TO_BATTLEFIELD', { card: returned, source: choice, playerId });
          return { success: true, returnedCard: returned, choice };
        }
      }
    }

    if (choice.type === 'FERVENT_CHAMPION_ATTACK') {
      const player = this.getPlayer(choice.controllerId);
      const targetKnight = (player?.battlefield?.creatures || []).find(c => c && (c.instanceId === selectedTargetId || c.id === selectedTargetId));
      if (targetKnight) {
        const kId = targetKnight.instanceId || targetKnight.id;
        if (this.abilityEngine) {
          this.abilityEngine.registerStaticEffect({
            id: `fervent_buff_${kId}_${Date.now()}`,
            sourceId: choice.sourceId,
            layer: CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT,
            powerMod: 1,
            toughnessMod: 0,
            duration: 'END_OF_TURN',
            appliesTo: (p) => p && (p.instanceId === kId || p.id === kId)
          });
        } else {
          targetKnight.power = (targetKnight.power || 0) + 1;
        }
        this.emit('CREATURE_BUFFED', { creature: targetKnight, powerDelta: 1, toughnessDelta: 0 });
        return { success: true, targetKnight, choice };
      }
    }

    return { success: true, choice };
  }

  _transformBattle(battleCard) {
    if (!battleCard) return null;
    battleCard.isDefeated = true;
    battleCard.transformed = true;
    battleCard.isTransformed = true;
    if (!battleCard.compiledMechanics) TabletopStateManager.hydrateCardMechanics(battleCard);
    const transformMode = (battleCard.compiledMechanics?.castModes || []).find(m => m.mode === 'TRANSFORM');
    if (!battleCard._frontFaceSnapshot) {
      battleCard._frontFaceSnapshot = {
        name: battleCard.name,
        typeLine: battleCard.typeLine,
        oracleText: battleCard.oracleText
      };
    }
    battleCard.name = transformMode?.name || 'Lightshield Array';
    battleCard.typeLine = transformMode?.typeLine || 'Enchantment';
    battleCard.oracleText = transformMode?.oracleText || 'At the beginning of your end step, put a +1/+1 counter on each creature that attacked this turn.\nSacrifice Lightshield Array: Creatures you control gain hexproof and indestructible until end of turn.';
    battleCard.face = 'back';
    if (battleCard.counters) delete battleCard.counters.defense;
    delete battleCard.defense;
    delete battleCard.defenseCounters;
    TabletopStateManager.hydrateCardMechanics(battleCard, this.deckManifests);
    const ownerId = battleCard.ownerId || battleCard.controllerId;
    this.emit('BATTLE_DEFEATED_TRANSFORMED', { playerId: ownerId, card: battleCard });
    this.emit('BATTLE_TRANSFORMED', { original: battleCard, transformed: battleCard, playerId: ownerId });
    return battleCard;
  }
}
