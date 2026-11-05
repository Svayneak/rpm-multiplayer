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

import { ScryfallService, LocalStorageCacheAdapter, MemoryCacheAdapter } from './ScryfallService.js';
import { DeckParser } from './DeckParser.js';
import { STARTER_CARD_METADATA } from './DeckbuilderAI.js';
import { OracleEffectCompiler, compileCardMechanics, smokeTestCard } from './OracleEffectCompiler.js';

export const VALIDATION_ERRORS = Object.freeze({
  TOO_FEW_MAIN: 'TOO_FEW_MAIN',
  TOO_MANY_SIDEBOARD: 'TOO_MANY_SIDEBOARD',
  EXCEEDS_COPY_LIMIT: 'EXCEEDS_COPY_LIMIT',
  BANNED_IN_FORMAT: 'BANNED_IN_FORMAT',
  NOT_LEGAL_IN_FORMAT: 'NOT_LEGAL_IN_FORMAT',
  INVALID_CARD_STRUCTURE: 'INVALID_CARD_STRUCTURE'
});

export const BASIC_LAND_COLORS = Object.freeze({
  plains: ['W'],
  island: ['U'],
  swamp: ['B'],
  mountain: ['R'],
  forest: ['G'],
  wastes: ['C'],
  'snow-covered plains': ['W'],
  'snow-covered island': ['U'],
  'snow-covered swamp': ['B'],
  'snow-covered mountain': ['R'],
  'snow-covered forest': ['G'],
  'snow-covered wastes': ['C']
});

export const BASIC_LANDS = new Set(Object.keys(BASIC_LAND_COLORS));

export const DUAL_LAND_METADATA = Object.freeze({
  // Shocklands
  'hallowed fountain': { colors: ['W', 'U'], isShockland: true, type: 'Land' },
  'watery grave': { colors: ['U', 'B'], isShockland: true, type: 'Land' },
  'blood crypt': { colors: ['B', 'R'], isShockland: true, type: 'Land' },
  'stomping ground': { colors: ['R', 'G'], isShockland: true, type: 'Land' },
  'temple garden': { colors: ['G', 'W'], isShockland: true, type: 'Land' },
  'godless shrine': { colors: ['W', 'B'], isShockland: true, type: 'Land' },
  'steam vents': { colors: ['U', 'R'], isShockland: true, type: 'Land' },
  'overgrown tomb': { colors: ['B', 'G'], isShockland: true, type: 'Land' },
  'sacred foundry': { colors: ['R', 'W'], isShockland: true, type: 'Land' },
  'breeding pool': { colors: ['G', 'U'], isShockland: true, type: 'Land' },
  // Fetchlands
  'flooded strand': { colors: ['W', 'U'], isFetchland: true, type: 'Land' },
  'polluted delta': { colors: ['U', 'B'], isFetchland: true, type: 'Land' },
  'bloodstained mire': { colors: ['B', 'R'], isFetchland: true, type: 'Land' },
  'wooded foothills': { colors: ['R', 'G'], isFetchland: true, type: 'Land' },
  'windswept heath': { colors: ['G', 'W'], isFetchland: true, type: 'Land' },
  'marsh flats': { colors: ['W', 'B'], isFetchland: true, type: 'Land' },
  'scalding tarn': { colors: ['U', 'R'], isFetchland: true, type: 'Land' },
  'verdant catacombs': { colors: ['B', 'G'], isFetchland: true, type: 'Land' },
  'arid mesa': { colors: ['R', 'W'], isFetchland: true, type: 'Land' },
  'misty rainforest': { colors: ['G', 'U'], isFetchland: true, type: 'Land' },
  // Checklands
  'glacial fortress': { colors: ['W', 'U'], isCheckland: true, type: 'Land' },
  'drowned catacomb': { colors: ['U', 'B'], isCheckland: true, type: 'Land' },
  'dragonskull summit': { colors: ['B', 'R'], isCheckland: true, type: 'Land' },
  'rootbound crag': { colors: ['R', 'G'], isCheckland: true, type: 'Land' },
  'sunpetal grove': { colors: ['G', 'W'], isCheckland: true, type: 'Land' },
  'isolated chapel': { colors: ['W', 'B'], isCheckland: true, type: 'Land' },
  'sulfur falls': { colors: ['U', 'R'], isCheckland: true, type: 'Land' },
  'woodland cemetery': { colors: ['B', 'G'], isCheckland: true, type: 'Land' },
  'clifftop retreat': { colors: ['R', 'W'], isCheckland: true, type: 'Land' },
  'hinterland harbor': { colors: ['G', 'U'], isCheckland: true, type: 'Land' }
});

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
 * Complete offline fallback metadata for tournament archetype cards.
 */
export const FALLBACK_CARD_METADATA = Object.freeze({
  'callous sell-sword // burn together': {
    name: 'Callous Sell-Sword // Burn Together',
    manaCost: '{1}{B} // {R}',
    cmc: 2,
    typeLine: 'Creature — Human Soldier // Sorcery — Adventure',
    oracleText: "Callous Sell-Sword enters the battlefield with a +1/+1 counter on it for each creature that died under your control this turn.\n\nBurn Together\nTarget creature you control deals damage equal to its power to any other target. Then sacrifice it.",
    power: 2,
    toughness: 2,
    colors: ['B', 'R'],
    layout: 'adventure',
    cardFaces: [
      {
        name: 'Callous Sell-Sword',
        manaCost: '{1}{B}',
        typeLine: 'Creature — Human Soldier',
        oracleText: 'Callous Sell-Sword enters the battlefield with a +1/+1 counter on it for each creature that died under your control this turn.',
        power: 2,
        toughness: 2,
        colors: ['B']
      },
      {
        name: 'Burn Together',
        manaCost: '{R}',
        typeLine: 'Sorcery — Adventure',
        oracleText: 'Target creature you control deals damage equal to its power to any other target. Then sacrifice it.',
        colors: ['R']
      }
    ]
  },
  'callous sell-sword': {
    name: 'Callous Sell-Sword // Burn Together',
    manaCost: '{1}{B} // {R}',
    cmc: 2,
    typeLine: 'Creature — Human Soldier // Sorcery — Adventure',
    oracleText: "Callous Sell-Sword enters the battlefield with a +1/+1 counter on it for each creature that died under your control this turn.\n\nBurn Together\nTarget creature you control deals damage equal to its power to any other target. Then sacrifice it.",
    power: 2,
    toughness: 2,
    colors: ['B', 'R'],
    layout: 'adventure',
    cardFaces: [
      {
        name: 'Callous Sell-Sword',
        manaCost: '{1}{B}',
        typeLine: 'Creature — Human Soldier',
        oracleText: 'Callous Sell-Sword enters the battlefield with a +1/+1 counter on it for each creature that died under your control this turn.',
        power: 2,
        toughness: 2,
        colors: ['B']
      },
      {
        name: 'Burn Together',
        manaCost: '{R}',
        typeLine: 'Sorcery — Adventure',
        oracleText: 'Target creature you control deals damage equal to its power to any other target. Then sacrifice it.',
        colors: ['R']
      }
    ]
  },
  'spire of industry': {
    name: 'Spire of Industry',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: "{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color. Activate only if you control an artifact.",
    colors: [],
    layout: 'normal',
    cardFaces: null
  },
  'starting town': {
    name: 'Starting Town',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: "Starting Town enters the battlefield tapped unless it's the first, second, or third turn of the game.\n{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color.",
    colors: [],
    layout: 'normal',
    cardFaces: null
  },
  'leyline axe': {
    name: 'Leyline Axe',
    manaCost: '{4}',
    cmc: 4,
    typeLine: 'Artifact — Equipment',
    oracleText: "If Leyline Axe is in your opening hand, you may begin the game with it on the battlefield.\nEquipped creature gets +1/+1 and has double strike and trample.\nEquip {3}",
    colors: [],
    layout: 'normal',
    cardFaces: null
  },
  'fervent champion': {
    name: 'Fervent Champion',
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Creature — Human Knight',
    oracleText: "First strike, haste\nWhenever Fervent Champion attacks, another target attacking Knight you control gets +1/+0 until end of turn.\nEquip abilities you activate that target Fervent Champion cost {3} less to activate.",
    power: 1,
    toughness: 1,
    colors: ['R'],
    layout: 'normal',
    cardFaces: null
  },
  "sigarda's aid": {
    name: "Sigarda's Aid",
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Enchantment',
    oracleText: "You may cast Aura and Equipment spells as though they had flash.\nWhenever an Equipment enters the battlefield under your control, you may attach it to target creature you control.",
    colors: ['W'],
    layout: 'normal',
    cardFaces: null
  },
  'colossus hammer': {
    name: 'Colossus Hammer',
    manaCost: '{1}',
    cmc: 1,
    typeLine: 'Artifact — Equipment',
    oracleText: "Equipped creature gets +10/+10 and loses flying.\nEquip {8}",
    colors: [],
    layout: 'normal',
    cardFaces: null
  },
  'heartfire hero': {
    name: 'Heartfire Hero',
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Creature — Mouse Soldier',
    oracleText: "Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.",
    power: 1,
    toughness: 1,
    colors: ['R'],
    layout: 'normal',
    cardFaces: null
  },
  'goblin gaveleer': {
    name: 'Goblin Gaveleer',
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Creature — Goblin Warrior',
    oracleText: "Trample\nGoblin Gaveleer gets +2/+0 for each Equipment attached to it.",
    power: 1,
    toughness: 1,
    colors: ['R'],
    layout: 'normal',
    cardFaces: null
  },
  'stolen uniform': {
    name: 'Stolen Uniform',
    manaCost: '{U}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: "Choose target creature you control and target Equipment. Gain control of that Equipment until end of turn. Attach it to the chosen creature. When you lose control of that Equipment this turn, if it's attached to a creature you control, unattach it.",
    colors: ['U'],
    layout: 'normal',
    cardFaces: null
  },
  "doc ock's tentacles": {
    name: "Doc Ock's Tentacles",
    manaCost: '{1}',
    cmc: 1,
    typeLine: 'Artifact — Equipment',
    oracleText: "Whenever a creature you control with mana value 5 or greater enters, you may attach this Equipment to it.\nEquipped creature gets +4/+4.\nEquip {5}",
    colors: [],
    layout: 'normal',
    cardFaces: null
  },
  'inkmoth nexus': {
    name: 'Inkmoth Nexus',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: "{T}: Add {C}.\n{1}: Inkmoth Nexus becomes a 1/1 Blinkmoth artifact creature with flying and infect until end of turn. It's still a land.",
    colors: [],
    layout: 'normal',
    cardFaces: null
  },
  'surge of salvation': {
    name: 'Surge of Salvation',
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: "You and permanents you control gain hexproof until end of turn. Prevent all damage that black and/or red sources would deal to creatures you control this turn.",
    colors: ['W'],
    layout: 'normal',
    cardFaces: null
  },
  'surgical extraction': {
    name: 'Surgical Extraction',
    manaCost: '{B/P}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: "({B/P} can be paid with either {B} or 2 life.)\nChoose target card in a graveyard other than a basic land card. Search its owner's graveyard, hand, and library for any number of cards with the same name as that card and exile them. Then that player shuffles.",
    colors: ['B'],
    layout: 'normal',
    cardFaces: null
  },
  'invasion of gobakhan // lightshield array': {
    name: 'Invasion of Gobakhan // Lightshield Array',
    manaCost: '{1}{W}',
    cmc: 2,
    typeLine: 'Battle — Siege // Enchantment',
    defense: 3,
    oracleText: "When Invasion of Gobakhan enters the battlefield, look at target opponent's hand and exile a nonland card from it. For as long as that card remains exiled, its owner may play it, and spells cast this way cost {2} more to cast.",
    colors: ['W'],
    layout: 'transform',
    cardFaces: [
      {
        name: 'Invasion of Gobakhan',
        manaCost: '{1}{W}',
        typeLine: 'Battle — Siege',
        defense: 3,
        oracleText: "When this Siege enters, look at target opponent's hand. You may exile a nonland card from it. For as long as that card remains exiled, its owner may play it. A spell cast this way costs {2} more to cast.",
        colors: ['W']
      },
      {
        name: 'Lightshield Array',
        manaCost: '',
        typeLine: 'Enchantment',
        oracleText: "At the beginning of your end step, put a +1/+1 counter on each creature that attacked this turn.\nSacrifice this enchantment: Creatures you control gain hexproof and indestructible until end of turn.",
        colors: ['W']
      }
    ]
  },
  'invasion of gobakhan': {
    name: 'Invasion of Gobakhan // Lightshield Array',
    manaCost: '{1}{W}',
    cmc: 2,
    typeLine: 'Battle — Siege // Enchantment',
    defense: 3,
    oracleText: "When Invasion of Gobakhan enters the battlefield, look at target opponent's hand and exile a nonland card from it. For as long as that card remains exiled, its owner may play it, and spells cast this way cost {2} more to cast.",
    colors: ['W'],
    layout: 'transform',
    cardFaces: [
      {
        name: 'Invasion of Gobakhan',
        manaCost: '{1}{W}',
        typeLine: 'Battle — Siege',
        defense: 3,
        oracleText: "When this Siege enters, look at target opponent's hand. You may exile a nonland card from it. For as long as that card remains exiled, its owner may play it. A spell cast this way costs {2} more to cast.",
        colors: ['W']
      },
      {
        name: 'Lightshield Array',
        manaCost: '',
        typeLine: 'Enchantment',
        oracleText: "At the beginning of your end step, put a +1/+1 counter on each creature that attacked this turn.\nSacrifice this enchantment: Creatures you control gain hexproof and indestructible until end of turn.",
        colors: ['W']
      }
    ]
  },
  "tormod's crypt": {
    name: "Tormod's Crypt",
    manaCost: '{0}',
    cmc: 0,
    typeLine: 'Artifact',
    oracleText: "{T}, Sacrifice Tormod's Crypt: Exile target player's graveyard.",
    colors: [],
    layout: 'normal',
    cardFaces: null
  },
  'skrelv, defector mite': {
    name: 'Skrelv, Defector Mite',
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Legendary Artifact Creature — Phyrexian Mite',
    oracleText: "Toxic 1\nSkrelv, Defector Mite can't block.\n{W/P}, {T}: Another target creature you control gains toxic 1 and hexproof from the color of your choice until end of turn. It can't be blocked by creatures of that color this turn.",
    power: 1,
    toughness: 1,
    colors: ['W'],
    layout: 'normal',
    cardFaces: null
  },
  'soul-guide lantern': {
    name: 'Soul-Guide Lantern',
    manaCost: '{1}',
    cmc: 1,
    typeLine: 'Artifact',
    oracleText: "When Soul-Guide Lantern enters the battlefield, exile target card from a graveyard.\n{T}, Sacrifice Soul-Guide Lantern: Exile each opponent's graveyard.\n{1}, {T}, Sacrifice Soul-Guide Lantern: Draw a card.",
    colors: [],
    layout: 'normal',
    cardFaces: null
  },
  'jegantha, the wellspring': {
    name: 'Jegantha, the Wellspring',
    manaCost: '{4}{R/G}',
    cmc: 5,
    typeLine: 'Legendary Creature — Elemental Elk',
    oracleText: "Companion — No card in your starting deck has more than one of the same mana symbol in its mana cost.\n{T}: Add {W}{U}{B}{R}{G}. This mana can't be spent to pay generic mana costs.",
    power: 5,
    toughness: 5,
    colors: ['R', 'G'],
    layout: 'normal',
    cardFaces: null
  },
  'resolute strike': {
    name: 'Resolute Strike',
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: "Target creature gets +2/+2 until end of turn. If it's a Warrior, you may attach an Equipment you control to it.",
    colors: ['W'],
    layout: 'normal',
    cardFaces: null
  },
  'belt of giant strength': {
    name: 'Belt of Giant Strength',
    manaCost: '{1}{G}',
    cmc: 2,
    typeLine: 'Artifact — Equipment',
    oracleText: "Equipped creature has base power and toughness 10/10.\nEquip {10}. This ability costs {X} less to activate, where X is the power of the creature it targets.",
    colors: ['G'],
    layout: 'normal',
    cardFaces: null
  },
  'forge anew': {
    name: 'Forge Anew',
    manaCost: '{2}{W}',
    cmc: 3,
    typeLine: 'Enchantment',
    oracleText: "When Forge Anew enters the battlefield, return target Equipment card from your graveyard to the battlefield.\nAs long as it's your turn, you may activate equip abilities any time you could cast an instant.\nYou may pay {0} rather than pay the equip cost of the first equip ability you activate each turn.",
    colors: ['W'],
    layout: 'normal',
    cardFaces: null
  },
  'wear // tear': {
    name: 'Wear // Tear',
    manaCost: '{1}{R} // {W}',
    cmc: 3,
    typeLine: 'Instant // Instant',
    oracleText: "Destroy target artifact.\nFuse\n\nDestroy target enchantment.\nFuse",
    colors: ['R', 'W'],
    layout: 'split',
    cardFaces: [
      {
        name: 'Wear',
        manaCost: '{1}{R}',
        typeLine: 'Instant',
        oracleText: 'Destroy target artifact.',
        colors: ['R']
      },
      {
        name: 'Tear',
        manaCost: '{W}',
        typeLine: 'Instant',
        oracleText: 'Destroy target enchantment.',
        colors: ['W']
      }
    ]
  },
  'wear': {
    name: 'Wear // Tear',
    manaCost: '{1}{R} // {W}',
    cmc: 3,
    typeLine: 'Instant // Instant',
    oracleText: "Destroy target artifact.\nFuse\n\nDestroy target enchantment.\nFuse",
    colors: ['R', 'W'],
    layout: 'split',
    cardFaces: [
      {
        name: 'Wear',
        manaCost: '{1}{R}',
        typeLine: 'Instant',
        oracleText: 'Destroy target artifact.',
        colors: ['R']
      },
      {
        name: 'Tear',
        manaCost: '{W}',
        typeLine: 'Instant',
        oracleText: 'Destroy target enchantment.',
        colors: ['W']
      }
    ]
  }
});

export const KNOWN_CARD_METADATA = FALLBACK_CARD_METADATA;

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

    const minMainboard = options.minMainboard ?? (options.enforceMinimum ? (format === 'RANKED_CONSTRUCT' ? 60 : 40) : 0);
    const maxSideboard = options.maxSideboard ?? 15;
    const cacheAdapter = options.cacheAdapter || null;

    let mainboard = [];
    let sideboard = [];
    const errors = [];

    // Parse text input if string
    if (typeof deck === 'string') {
      const parsed = DeckParser.parse(deck);
      mainboard = parsed.cards.filter(c => c.section !== 'sideboard' && !c.isSideboard);
      sideboard = parsed.cards.filter(c => c.section === 'sideboard' || Boolean(c.isSideboard));
      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        for (const err of parsed.errors) {
          errors.push({
            cardName: `Line ${err.lineNumber || err.line || '?'}`,
            count: 0,
            reason: err.reason || err.message || 'Unable to parse card line',
            isParseError: true
          });
        }
      }
    } else if (Array.isArray(deck)) {
      mainboard = deck.filter(c => c.section !== 'sideboard' && !c.isSideboard);
      sideboard = deck.filter(c => c.section === 'sideboard' || Boolean(c.isSideboard));
    } else if (deck && typeof deck === 'object') {
      if (deck.cards && !deck.mainboard && !deck.main) {
        mainboard = deck.cards.filter(c => c.section !== 'sideboard' && !c.isSideboard);
        sideboard = deck.cards.filter(c => c.section === 'sideboard' || Boolean(c.isSideboard));
      } else {
        mainboard = deck.mainboard || deck.main || [];
        sideboard = deck.sideboard || deck.side || [];
      }
    }

    let mainCount = 0;
    let sideboardCount = 0;

    // Aggregate counts across main and side
    const cardTotals = new Map(); // normalizedName -> { cardName, count, oracleText, metadata }

    const recordCard = (card, isSide) => {
      if (!card || !card.name) return;
      const rawCount = Number(card.count ?? card.quantity);
      const count = Number.isFinite(rawCount) ? rawCount : 1;
      if (count <= 0) return;
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

    // Compute Color Identity
    const colorSet = new Set();
    const allCards = [...mainboard, ...sideboard];
    for (const card of allCards) {
      if (!card || !card.name) continue;
      const nameNorm = DeckValidator.normalizeName(card.name);

      if (Array.isArray(card.colorIdentity)) {
        card.colorIdentity.forEach(col => colorSet.add(col.toUpperCase()));
      } else if (Array.isArray(card.colors)) {
        card.colors.forEach(col => colorSet.add(col.toUpperCase()));
      }

      if (BASIC_LAND_COLORS[nameNorm]) {
        BASIC_LAND_COLORS[nameNorm].forEach(col => colorSet.add(col));
      }

      if (DUAL_LAND_METADATA[nameNorm]?.colors) {
        DUAL_LAND_METADATA[nameNorm].colors.forEach(col => colorSet.add(col));
      }

      const starterMeta = FALLBACK_CARD_METADATA[nameNorm] || STARTER_CARD_METADATA?.[nameNorm];
      if (starterMeta?.colors && Array.isArray(starterMeta.colors)) {
        starterMeta.colors.forEach(col => colorSet.add(col.toUpperCase()));
      }

      const cost = card.manaCost || card.mana_cost || starterMeta?.manaCost || '';
      if (typeof cost === 'string') {
        const matches = cost.match(/[WUBRG]/gi);
        if (matches) {
          matches.forEach(m => colorSet.add(m.toUpperCase()));
        }
      }

      if (cacheAdapter) {
        try {
          const cached = cacheAdapter.getItem(`name:${nameNorm}`);
          if (cached) {
            const p = JSON.parse(cached);
            if (Array.isArray(p.colors)) p.colors.forEach(c => colorSet.add(c.toUpperCase()));
            if (Array.isArray(p.color_identity)) p.color_identity.forEach(c => colorSet.add(c.toUpperCase()));
          }
        } catch (_) {}
      }
    }

    const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];
    let colorIdentity = COLOR_ORDER.filter(col => colorSet.has(col));
    if (colorIdentity.length === 0) {
      colorIdentity = ['C'];
    }

    // Compute Breakdown
    const breakdown = {
      creatures: 0,
      spells: 0,
      otherPermanents: 0,
      lands: 0,
      sideboard: sideboardCount
    };

    for (const card of mainboard) {
      if (!card || !card.name) continue;
      const rawCount = Number(card.count ?? card.quantity);
      const count = Number.isFinite(rawCount) ? rawCount : 1;
      if (count <= 0) continue;
      const nameNorm = DeckValidator.normalizeName(card.name);
      const starterMeta = FALLBACK_CARD_METADATA[nameNorm] || STARTER_CARD_METADATA?.[nameNorm];
      let typeLine = (card.typeLine || card.type || starterMeta?.typeLine || starterMeta?.type || '').toLowerCase();

      if (!typeLine && BASIC_LAND_COLORS[nameNorm]) {
        typeLine = 'land';
      } else if (!typeLine && DUAL_LAND_METADATA[nameNorm]) {
        typeLine = 'land';
      } else if (!typeLine && cacheAdapter) {
        try {
          const cached = cacheAdapter.getItem(`name:${nameNorm}`);
          if (cached) {
            const p = JSON.parse(cached);
            typeLine = (p.typeLine || p.type_line || p.type || '').toLowerCase();
          }
        } catch (_) {}
      }
      if (!typeLine && typeof localStorage !== 'undefined') {
        try {
          const cached = localStorage.getItem(`rpm_scryfall_v1_name:${nameNorm}`);
          if (cached) {
            const p = JSON.parse(cached);
            typeLine = (p.typeLine || p.type_line || p.type || '').toLowerCase();
          }
        } catch (_) {}
      }

      if (typeLine.includes('creature')) {
        breakdown.creatures += count;
      } else if (typeLine.includes('land') || DeckValidator.isBasicLand(card.name) || DUAL_LAND_METADATA[nameNorm]) {
        breakdown.lands += count;
      } else if (typeLine.includes('instant') || typeLine.includes('sorcery')) {
        breakdown.spells += count;
      } else if (typeLine.includes('artifact') || typeLine.includes('enchantment') || typeLine.includes('planeswalker') || typeLine.includes('battle')) {
        breakdown.otherPermanents += count;
      } else {
        breakdown.spells += count;
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      mainCount,
      sideboardCount,
      format,
      mainboard,
      sideboard,
      colorIdentity,
      breakdown
    };
  }

  /**
   * 3-Pass Asynchronous Hydration & Validation Pipeline (Option 1A)
   * 
   * Pass 1: Parse input deck and batch fetch Scryfall metadata via ScryfallService.fetchDeckCards
   * Pass 2: Fallback fetch via ScryfallService.fetchCardByName for any unresolved cards
   * Pass 3: Mechanics compilation & automated smoke testing via OracleEffectCompiler
   * 
   * @param {Object|Array|string} rawTextOrDeck
   * @param {Object} [options={}]
   * @param {import('./ScryfallService').ScryfallService} [options.scryfallService]
   * @param {'FREE_CONSTRUCT'|'RANKED_CONSTRUCT'} [options.format='FREE_CONSTRUCT']
   * @param {Function} [options.onProgress] Optional callback: ({ step, message, percent }) => void
   * @returns {Promise<Object>}
   */
  static async validateAndHydrateDeck(rawTextOrDeck, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

    onProgress({ step: 'PARSING', message: 'Parsing decklist tokens...', percent: 10 });

    let parsedCards = [];
    let initialErrors = [];

    if (typeof rawTextOrDeck === 'string') {
      const parsed = DeckParser.parse(rawTextOrDeck);
      parsedCards = parsed.cards || [];
      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        initialErrors.push(...parsed.errors);
      }
    } else if (Array.isArray(rawTextOrDeck)) {
      parsedCards = rawTextOrDeck.map(c => {
        const rawCount = Number(c.count ?? c.quantity);
        const count = Number.isFinite(rawCount) ? rawCount : 1;
        return {
          ...c,
          count,
          section: c.section || (c.isSideboard ? 'sideboard' : 'mainboard')
        };
      }).filter(c => c.count > 0);
    } else if (rawTextOrDeck && typeof rawTextOrDeck === 'object') {
      if (rawTextOrDeck.cards) {
        parsedCards = rawTextOrDeck.cards;
      } else {
        const mb = (rawTextOrDeck.mainboard || rawTextOrDeck.main || []).map(c => {
          const rawCount = Number(c.count ?? c.quantity);
          const count = Number.isFinite(rawCount) ? rawCount : 1;
          return {
            ...c,
            count,
            section: 'mainboard'
          };
        }).filter(c => c.count > 0);
        const sb = (rawTextOrDeck.sideboard || rawTextOrDeck.side || []).map(c => {
          const rawCount = Number(c.count ?? c.quantity);
          const count = Number.isFinite(rawCount) ? rawCount : 1;
          return {
            ...c,
            count,
            section: 'sideboard'
          };
        }).filter(c => c.count > 0);
        parsedCards = [...mb, ...sb];
      }
    }

    const scryfall = options.scryfallService || new ScryfallService({
      cacheAdapter: options.cacheAdapter || (typeof localStorage !== 'undefined' ? new LocalStorageCacheAdapter() : new MemoryCacheAdapter()),
      fetchFn: options.fetchFn
    });

    onProgress({ step: 'PASS_1_BATCH', message: 'Fetching Scryfall card data (Batch Pass)...', percent: 30 });

    // Pass 1: Batch fetch
    let batchResult = { cards: [], notFound: [] };
    try {
      batchResult = await scryfall.fetchDeckCards(parsedCards);
    } catch (err) {
      // Scryfall network error: fallback gracefully to offline metadata
    }

    // Map of normalized name to resolved card entity
    const resolvedByName = new Map();
    if (batchResult && Array.isArray(batchResult.cards)) {
      for (const card of batchResult.cards) {
        if (card && card.name) {
          resolvedByName.set(DeckValidator.normalizeName(card.name), card);
        }
      }
    }

    onProgress({ step: 'PASS_2_FALLBACK', message: 'Resolving remaining cards (Fallback Pass)...', percent: 65 });

    // Pass 2: Fallback for unresolved / notFound cards
    const notFoundStillMissing = [];
    if (batchResult && Array.isArray(batchResult.notFound) && batchResult.notFound.length > 0) {
      for (const item of batchResult.notFound) {
        const nameToTry = item.requestedName || item.identifier?.name || (typeof item === 'string' ? item : null);
        if (nameToTry) {
          const norm = DeckValidator.normalizeName(nameToTry);
          if (resolvedByName.has(norm)) continue;

          // Check starter metadata first
          const starterMeta = FALLBACK_CARD_METADATA[norm] || STARTER_CARD_METADATA?.[norm];
          if (starterMeta) {
            resolvedByName.set(norm, { ...starterMeta });
            continue;
          }

          // Attempt fetchCardByName
          try {
            const fetched = await scryfall.fetchCardByName(nameToTry);
            if (fetched) {
              resolvedByName.set(norm, fetched);
              continue;
            }
          } catch (_) {}
          notFoundStillMissing.push(item);
        }
      }
    }

    // Also check any input card that might not be in resolvedByName
    for (const card of parsedCards) {
      if (!card || !card.name) continue;
      const norm = DeckValidator.normalizeName(card.name);
      if (!resolvedByName.has(norm)) {
        const starterMeta = FALLBACK_CARD_METADATA[norm] || STARTER_CARD_METADATA?.[norm];
        if (starterMeta) {
          resolvedByName.set(norm, { ...starterMeta });
        } else if (scryfall && scryfall.cache) {
          try {
            const cached = await scryfall.cache.getItem(`name:${norm}`);
            if (cached) {
              resolvedByName.set(norm, JSON.parse(cached));
            }
          } catch (_) {}
        }
      }
    }

    onProgress({ step: 'PASS_3_COMPILE', message: 'Compiling oracle effects & smoke testing...', percent: 90 });

    // Pass 3: Compilation and automated smoke testing
    const hydratedCards = [];
    const smokeTests = [];

    for (const cardToken of parsedCards) {
      if (!cardToken || !cardToken.name) continue;
      const norm = DeckValidator.normalizeName(cardToken.name);
      const meta = resolvedByName.get(norm) || {};
      const rawCount = Number(cardToken.count ?? cardToken.quantity);
      const count = Number.isFinite(rawCount) ? rawCount : 1;
      if (count <= 0) continue;
      const section = cardToken.section || (cardToken.isSideboard ? 'sideboard' : 'mainboard');

      const hydrated = {
        ...cardToken,
        ...meta,
        name: meta.name || cardToken.name,
        count,
        section,
        isSideboard: section === 'sideboard',
        typeLine: meta.typeLine || meta.type_line || cardToken.typeLine || cardToken.type || '',
        oracleText: meta.oracleText || meta.oracle_text || cardToken.oracleText || '',
        manaCost: meta.manaCost !== undefined ? meta.manaCost : (cardToken.manaCost || ''),
        cmc: meta.cmc ?? cardToken.cmc ?? 0,
        power: meta.power ?? cardToken.power,
        toughness: meta.toughness ?? cardToken.toughness,
        loyalty: meta.loyalty ?? cardToken.loyalty,
        colors: meta.colors || cardToken.colors || [],
        imageUri: meta.imageUri || cardToken.imageUri || '',
        modernLegal: meta.modernLegal !== undefined ? meta.modernLegal : cardToken.modernLegal,
        cardFaces: meta.cardFaces || meta.card_faces || cardToken.cardFaces || null,
        layout: meta.layout || cardToken.layout || 'normal'
      };

      // Compile mechanics
      compileCardMechanics(hydrated);

      // Automated smoke test
      const smokeResult = smokeTestCard(hydrated);
      smokeTests.push({
        cardName: hydrated.name,
        ...smokeResult
      });

      hydratedCards.push(hydrated);
    }

    onProgress({ step: 'VALIDATING', message: 'Executing deck validation rules...', percent: 100 });

    const mainboard = hydratedCards.filter(c => c.section !== 'sideboard' && !c.isSideboard);
    const sideboard = hydratedCards.filter(c => c.section === 'sideboard' || Boolean(c.isSideboard));

    const report = DeckValidator.validateDeck({ mainboard, sideboard }, {
      ...options,
      cacheAdapter: scryfall.cache
    });

    report.cards = hydratedCards;
    report.hydratedCards = hydratedCards;
    report.smokeTests = smokeTests;
    report.allCardsSmokeTested = smokeTests.every(s => s.passed);
    report.notFound = notFoundStillMissing;
    report.parseErrors = initialErrors;

    return report;
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
