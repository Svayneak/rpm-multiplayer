/**
 * DeckbuilderAI.js - Strategic Intelligence & Guideline Memory Engine.
 * 
 * Implements:
 * - 10-point guideline memory with ring-buffer FIFO eviction and 16KB quota guard (INV-STORAGE-1)
 * - Deterministic recency conflict resolution (INV-STORAGE-2)
 * - Dual-Mode Deck Generation (INV-STORAGE-3):
 *     - Mode A: Offline deterministic tournament starter archetypes & single-color beginner decks (INV-STORAGE-4)
 *     - Mode B: Online LLM synthesizer bridge with 4000ms timeout SLA and graceful Mode A fallback
 * - Top 10 Public Showcase Subsystem with composite scoring & preview card extraction (INV-STORAGE-5)
 * - Deck export formatting (Arena, MTGO, Text)
 * 
 * Specifications:
 * - SPEC-RPM-DECKAI-010
 * - DEC-013, DEC-015
 * - Audio Note 9
 * 
 * @module DeckbuilderAI
 */

import { StorageAdapter, validateAndGuardGuidelineQuota } from './StorageAdapter.js';
import { DeckValidator, VALIDATION_ERRORS } from './DeckValidator.js';
import { evaluateDeckSlots, DECK_SLOT_MILESTONES } from './VictoryFanfare.js';

// =============================================================================
// Constants & Semantic Vocabulary
// =============================================================================

export const TAG_COLORS = {
  W: 'COLOR_W',
  U: 'COLOR_U',
  B: 'COLOR_B',
  R: 'COLOR_R',
  G: 'COLOR_G',
  C: 'COLOR_COLORLESS'
};

export const TAG_ARCHETYPES = {
  BURN: 'ARCH_BURN',
  TEMPO: 'ARCH_TEMPO',
  COMBO: 'ARCH_COMBO',
  CONTROL: 'ARCH_CONTROL',
  RAMP: 'ARCH_RAMP',
  MIDRANGE: 'ARCH_MIDRANGE',
  CASCADE: 'ARCH_CASCADE',
  AGGRO: 'ARCH_AGGRO'
};

export const TAG_MECHANICS = {
  COUNTERSPELL: 'MECH_COUNTERSPELL',
  GRAVEYARD: 'MECH_GRAVEYARD',
  DISCARD: 'MECH_DISCARD',
  LIFELINK: 'MECH_LIFELINK',
  CASCADE: 'MECH_CASCADE',
  SACRIFICE: 'MECH_SACRIFICE',
  BURN: 'MECH_BURN'
};

export const TAG_TYPES = {
  CREATURE: 'TYPE_CREATURE',
  INSTANT: 'TYPE_INSTANT',
  SORCERY: 'TYPE_SORCERY',
  PLANESWALKER: 'TYPE_PLANESWALKER',
  ARTIFACT: 'TYPE_ARTIFACT',
  ENCHANTMENT: 'TYPE_ENCHANTMENT',
  LAND: 'TYPE_LAND'
};

// =============================================================================
// Precompiled Tournament Modern Starter Archetypes (Mode A)
// =============================================================================

export const STARTER_CARD_METADATA = {
  'goblin guide': {
    name: 'Goblin Guide',
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Creature — Goblin Scout',
    type: 'Creature',
    oracleText: "Haste\nWhenever Goblin Guide attacks, defending player reveals the top card of their library. If it's a land card, that player puts it into their hand.",
    imageUri: 'https://cards.scryfall.io/normal/front/3/b/3b0e5411-1940-4c05-9610-0f9752b450c3.jpg',
    power: 2,
    toughness: 2,
    colors: ['R']
  },
  'monastery swiftspear': {
    name: 'Monastery Swiftspear',
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Creature — Human Monk',
    type: 'Creature',
    oracleText: 'Haste\nProwess',
    imageUri: 'https://cards.scryfall.io/normal/front/d/6/d6bfa227-4309-40ed-952c-279595eab17e.jpg',
    power: 1,
    toughness: 2,
    colors: ['R']
  },
  'eidolon of the great revel': {
    name: 'Eidolon of the Great Revel',
    manaCost: '{R}{R}',
    cmc: 2,
    typeLine: 'Enchantment Creature — Spirit',
    type: 'Creature',
    oracleText: 'Whenever a player casts a spell with mana value 3 or less, Eidolon of the Great Revel deals 2 damage to that player.',
    imageUri: 'https://cards.scryfall.io/normal/front/1/8/183ef738-0559-49ca-85b4-e6836521f203.jpg',
    power: 2,
    toughness: 2,
    colors: ['R']
  },
  'lightning bolt': {
    name: 'Lightning Bolt',
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'Lightning Bolt deals 3 damage to any target.',
    imageUri: 'https://cards.scryfall.io/normal/front/f/2/f29ba16f-c8fb-42fe-aabf-87089cb214a7.jpg',
    colors: ['R']
  },
  'lava spike': {
    name: 'Lava Spike',
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Sorcery — Arcane',
    type: 'Sorcery',
    oracleText: 'Lava Spike deals 3 damage to target player or planeswalker.',
    imageUri: 'https://cards.scryfall.io/normal/front/7/9/79c21c1f-eaa4-454d-a1c7-b41466d0a428.jpg',
    colors: ['R']
  },
  'rift bolt': {
    name: 'Rift Bolt',
    manaCost: '{1}{R}{R}',
    cmc: 3,
    typeLine: 'Sorcery',
    type: 'Sorcery',
    oracleText: 'Rift Bolt deals 3 damage to any target.\nSuspend 1—{R}',
    imageUri: 'https://cards.scryfall.io/normal/front/4/a/4a10a82a-e05b-426a-ae05-c5b51ae95bfd.jpg',
    colors: ['R']
  },
  'searing blaze': {
    name: 'Searing Blaze',
    manaCost: '{R}{R}',
    cmc: 2,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: "Searing Blaze deals 1 damage to target player or planeswalker and 1 damage to target creature that player or that planeswalker's controller controls.\nLandfall — If you had a land enter the battlefield under your control this turn, Searing Blaze deals 3 damage to that player or planeswalker and 3 damage to that creature instead.",
    imageUri: 'https://cards.scryfall.io/normal/front/f/6/f659d464-13dd-49e2-a842-098dcba49659.jpg',
    colors: ['R']
  },
  'skewer the critics': {
    name: 'Skewer the Critics',
    manaCost: '{2}{R}',
    cmc: 3,
    typeLine: 'Sorcery',
    type: 'Sorcery',
    oracleText: 'Spectacle {R}\nSkewer the Critics deals 3 damage to any target.',
    imageUri: 'https://cards.scryfall.io/normal/front/d/7/d72ceb4b-9f62-400d-876e-7b174888e65e.jpg',
    colors: ['R']
  },
  'roiling vortex': {
    name: 'Roiling Vortex',
    manaCost: '{1}{R}',
    cmc: 2,
    typeLine: 'Enchantment',
    type: 'Enchantment',
    oracleText: "At the beginning of each player's upkeep, Roiling Vortex deals 5 damage to that player if they didn't cast a spell from their hand this turn.\nWhenever a player casts a spell, if no mana was spent to cast it, Roiling Vortex deals 5 damage to that player.\n{R}: Players can't gain life this turn.",
    imageUri: 'https://cards.scryfall.io/normal/front/0/b/0b057eb7-8439-4d26-89df-c345ab2773e1.jpg',
    colors: ['R']
  },
  'shard volley': {
    name: 'Shard Volley',
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'As an additional cost to cast this spell, sacrifice a land.\nShard Volley deals 3 damage to any target.',
    imageUri: 'https://cards.scryfall.io/normal/front/4/3/43db4810-078e-487a-afef-57cbc1db0cc7.jpg',
    colors: ['R']
  },
  'mountain': {
    name: 'Mountain',
    manaCost: '',
    cmc: 0,
    typeLine: 'Basic Land — Mountain',
    type: 'Land',
    oracleText: '({T}: Add {R}.)',
    imageUri: 'https://cards.scryfall.io/normal/front/f/a/fa3d328f-5324-4530-9ab7-b81d43f367e4.jpg',
    colors: []
  },
  'smash to smithereens': {
    name: 'Smash to Smithereens',
    manaCost: '{1}{R}',
    cmc: 2,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: "Destroy target artifact. Smash to Smithereens deals 3 damage to that artifact's controller.",
    imageUri: 'https://cards.scryfall.io/normal/front/6/5/655c489f-0b59-4445-9998-69335477c05c.jpg',
    colors: ['R']
  },
  'deflecting palm': {
    name: 'Deflecting Palm',
    manaCost: '{R}{W}',
    cmc: 2,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: "The next time a source of your choice would deal damage to you this turn, prevent that damage. If damage is prevented this way, Deflecting Palm deals that much damage to that source's controller.",
    imageUri: 'https://cards.scryfall.io/normal/front/c/5/c5580886-a402-4048-b8b6-39e19479f491.jpg',
    colors: ['R', 'W']
  },
  'path to exile': {
    name: 'Path to Exile',
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
    imageUri: 'https://cards.scryfall.io/normal/front/e/9/e9d36855-c38a-4bba-a642-cff3f81e057e.jpg',
    colors: ['W']
  },
  'rest in peace': {
    name: 'Rest in Peace',
    manaCost: '{1}{W}',
    cmc: 2,
    typeLine: 'Enchantment',
    type: 'Enchantment',
    oracleText: 'When Rest in Peace enters the battlefield, exile all cards from all graveyards.\nIf a card or token would be put into a graveyard from anywhere, exile it instead.',
    imageUri: 'https://cards.scryfall.io/normal/front/9/f/9f2b39be-0fec-4647-ade1-8e1626dc5470.jpg',
    colors: ['W']
  },
  'murktide regent': {
    name: 'Murktide Regent',
    manaCost: '{5}{U}{U}',
    cmc: 7,
    typeLine: 'Creature — Dragon',
    type: 'Creature',
    oracleText: 'Delve\nFlying\nMurktide Regent enters the battlefield with a +1/+1 counter on it for each instant and sorcery card exiled with it.\nWhenever an instant or sorcery card leaves your graveyard, put a +1/+1 counter on Murktide Regent.',
    imageUri: 'https://cards.scryfall.io/normal/front/2/0/20c4aae1-7665-4df7-bd51-a1d95bf8a17d.jpg',
    power: 3,
    toughness: 3,
    colors: ['U']
  },
  "dragon's rage channeler": {
    name: "Dragon's Rage Channeler",
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Creature — Human Shaman',
    type: 'Creature',
    oracleText: "Whenever you cast a noncreature spell, surveil 1.\nDelirium — Dragon's Rage Channeler gets +2/+2, has flying, and attacks each combat if able as long as there are four or more card types among cards in your graveyard.",
    imageUri: 'https://cards.scryfall.io/normal/front/4/c/4ced0e10-2de0-4d49-825f-4a5b21b1455d.jpg',
    power: 1,
    toughness: 1,
    colors: ['R']
  },
  'ragavan, nimble pilferer': {
    name: 'Ragavan, Nimble Pilferer',
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Legendary Creature — Monkey Pirate',
    type: 'Creature',
    oracleText: "Whenever Ragavan, Nimble Pilferer deals combat damage to a player, create a Treasure token and exile the top card of that player's library. Until end of turn, you may cast that card.\nDash {1}{R}",
    imageUri: 'https://cards.scryfall.io/normal/front/a/9/a9738cda-adb1-47fb-9f4c-ecd930228c4d.jpg',
    power: 2,
    toughness: 1,
    colors: ['R']
  },
  'ledger shredder': {
    name: 'Ledger Shredder',
    manaCost: '{1}{U}',
    cmc: 2,
    typeLine: 'Creature — Bird Advisor',
    type: 'Creature',
    oracleText: 'Flying\nWhenever a player casts their second spell each turn, Ledger Shredder connives.',
    imageUri: 'https://cards.scryfall.io/normal/front/7/e/7ea4b5bc-18a4-45db-a56a-ab3f8bd2fb0d.jpg',
    power: 1,
    toughness: 3,
    colors: ['U']
  },
  'counterspell': {
    name: 'Counterspell',
    manaCost: '{U}{U}',
    cmc: 2,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'Counter target spell.',
    imageUri: 'https://cards.scryfall.io/normal/front/a/4/a457f404-ddf1-40fa-b0f0-23c8598533f4.jpg',
    colors: ['U']
  },
  'expressive iteration': {
    name: 'Expressive Iteration',
    manaCost: '{U}{R}',
    cmc: 2,
    typeLine: 'Sorcery',
    type: 'Sorcery',
    oracleText: 'Look at the top three cards of your library. Put one of them into your hand, put one of them on the bottom of your library, and exile one of them. You may play the exiled card this turn.',
    imageUri: 'https://cards.scryfall.io/normal/front/3/1/31b770cc-09e7-4c0b-ae28-98223321ad7d.jpg',
    colors: ['U', 'R']
  },
  'consider': {
    name: 'Consider',
    manaCost: '{U}',
    cmc: 1,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'Surveil 1.\nDraw a card.',
    imageUri: 'https://cards.scryfall.io/normal/front/a/2/a211d505-4d40-4914-a9da-220770d6ddbc.jpg',
    colors: ['U']
  },
  'unholy heat': {
    name: 'Unholy Heat',
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'Unholy Heat deals 2 damage to target creature or planeswalker.\nDelirium — Unholy Heat deals 6 damage instead if there are four or more card types among cards in your graveyard.',
    imageUri: 'https://cards.scryfall.io/normal/front/2/b/2b97240f-3a03-48ae-af84-28b824ff5dd1.jpg',
    colors: ['R']
  },
  "mishra's bauble": {
    name: "Mishra's Bauble",
    manaCost: '{0}',
    cmc: 0,
    typeLine: 'Artifact',
    type: 'Artifact',
    oracleText: "{T}, Sacrifice Mishra's Bauble: Look at the top card of target player's library. Draw a card at the beginning of the next turn's upkeep.",
    imageUri: 'https://cards.scryfall.io/normal/front/4/5/45bbbf9b-8ffa-4c37-97fe-4319293271f3.jpg',
    colors: []
  },
  'spell pierce': {
    name: 'Spell Pierce',
    manaCost: '{U}',
    cmc: 1,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'Counter target noncreature spell unless its controller pays {2}.',
    imageUri: 'https://cards.scryfall.io/normal/front/3/5/35b8a9db-d126-403e-abb1-74dcc5b36136.jpg',
    colors: ['U']
  },
  'steam vents': {
    name: 'Steam Vents',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land — Island Mountain',
    type: 'Land',
    oracleText: "({T}: Add {U} or {R}.)\nAs Steam Vents enters the battlefield, you may pay 2 life. If you don't, it enters the battlefield tapped.",
    imageUri: 'https://cards.scryfall.io/normal/front/b/8/b8dea3ac-88ca-4179-8210-271223713c43.jpg',
    colors: []
  },
  'spirebluff canal': {
    name: 'Spirebluff Canal',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    type: 'Land',
    oracleText: 'Spirebluff Canal enters the battlefield tapped unless you control two or fewer other lands.\n{T}: Add {U} or {R}.',
    imageUri: 'https://cards.scryfall.io/normal/front/4/e/4e587ea7-0632-4789-ba75-3c410da2bb96.jpg',
    colors: []
  },
  'scalding tarn': {
    name: 'Scalding Tarn',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    type: 'Land',
    oracleText: '{T}, Pay 1 life, Sacrifice Scalding Tarn: Search your library for an Island or Mountain card, put it onto the battlefield, then shuffle.',
    imageUri: 'https://cards.scryfall.io/normal/front/7/1/71e491c5-8c07-449b-b2f1-ffa052e6d311.jpg',
    colors: []
  },
  'island': {
    name: 'Island',
    manaCost: '',
    cmc: 0,
    typeLine: 'Basic Land — Island',
    type: 'Land',
    oracleText: '({T}: Add {U}.)',
    imageUri: 'https://cards.scryfall.io/normal/front/4/e/4e1d7b36-3023-4f4f-a3c3-308707e4083a.jpg',
    colors: []
  },
  'blood moon': {
    name: 'Blood Moon',
    manaCost: '{2}{R}',
    cmc: 3,
    typeLine: 'Enchantment',
    type: 'Enchantment',
    oracleText: 'Nonbasic lands are Mountains.',
    imageUri: 'https://cards.scryfall.io/normal/front/d/0/d072e9ca-aae7-45dc-8025-3ce590bae63f.jpg',
    colors: ['R']
  },
  'flusterstorm': {
    name: 'Flusterstorm',
    manaCost: '{U}',
    cmc: 1,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'Counter target instant or sorcery spell unless its controller pays {1}.\nStorm',
    imageUri: 'https://cards.scryfall.io/normal/front/f/9/f900eeb7-7c45-44bc-ad3a-0bbe594ecf50.jpg',
    colors: ['U']
  },
  'engineered explosives': {
    name: 'Engineered Explosives',
    manaCost: '{X}',
    cmc: 0,
    typeLine: 'Artifact',
    type: 'Artifact',
    oracleText: 'Sunburst\n{2}, Sacrifice Engineered Explosives: Destroy each nonland permanent with mana value equal to the number of charge counters on Engineered Explosives.',
    imageUri: 'https://cards.scryfall.io/normal/front/4/2/420bf1e9-f2ec-4dff-b54f-807078880f08.jpg',
    colors: []
  },
  'subtlety': {
    name: 'Subtlety',
    manaCost: '{2}{U}{U}',
    cmc: 4,
    typeLine: 'Creature — Incarnation',
    type: 'Creature',
    oracleText: 'Flash\nFlying\nWhen Subtlety enters the battlefield, choose up to one target creature spell or planeswalker spell. Its owner puts it on the top or bottom of their library.\nEvoke—Exile a blue card from your hand.',
    imageUri: 'https://cards.scryfall.io/normal/front/7/0/701256d5-1389-48b7-9581-d6037209bd06.jpg',
    power: 3,
    toughness: 3,
    colors: ['U']
  },
  'dress down': {
    name: 'Dress Down',
    manaCost: '{1}{U}',
    cmc: 2,
    typeLine: 'Enchantment',
    type: 'Enchantment',
    oracleText: 'Flash\nWhen Dress Down enters the battlefield, draw a card.\nCreatures lose all abilities.\nAt the beginning of the end step, sacrifice Dress Down.',
    imageUri: 'https://cards.scryfall.io/normal/front/0/4/04f9f061-67b8-4427-9fcb-b3ccfee8fc5d.jpg',
    colors: ['U']
  },
  'yawgmoth, thran physician': {
    name: 'Yawgmoth, Thran Physician',
    manaCost: '{2}{B}{B}',
    cmc: 4,
    typeLine: 'Legendary Creature — Human Cleric',
    type: 'Creature',
    oracleText: 'Protection from Humans\nPay 1 life, Sacrifice another creature: Put a -1/-1 counter on up to one target creature and draw a card.\n{B}{B}, Discard a card: Proliferate.',
    imageUri: 'https://cards.scryfall.io/normal/front/8/6/8690cbcc-f8fd-44f7-8e6a-9115a7776791.jpg',
    power: 2,
    toughness: 4,
    colors: ['B']
  },
  'young wolf': {
    name: 'Young Wolf',
    manaCost: '{G}',
    cmc: 1,
    typeLine: 'Creature — Wolf',
    type: 'Creature',
    oracleText: 'Undying',
    imageUri: 'https://cards.scryfall.io/normal/front/0/d/0d39aa86-fd66-49fb-960f-4e78698e158c.jpg',
    power: 1,
    toughness: 1,
    colors: ['G']
  },
  'strangleroot geist': {
    name: 'Strangleroot Geist',
    manaCost: '{G}{G}',
    cmc: 2,
    typeLine: 'Creature — Spirit',
    type: 'Creature',
    oracleText: 'Haste\nUndying',
    imageUri: 'https://cards.scryfall.io/normal/front/b/f/bf1fb131-0845-4586-8a71-42358fb96c9c.jpg',
    power: 2,
    toughness: 1,
    colors: ['G']
  },
  'wall of roots': {
    name: 'Wall of Roots',
    manaCost: '{1}{G}',
    cmc: 2,
    typeLine: 'Creature — Plant Wall',
    type: 'Creature',
    oracleText: 'Defender\nPut a -0/-1 counter on Wall of Roots: Add {G}. Activate only once each turn.',
    imageUri: 'https://cards.scryfall.io/normal/front/d/8/d80940ad-8e36-4226-ad5f-b54487c75c76.jpg',
    power: 0,
    toughness: 5,
    colors: ['G']
  },
  'orcish bowmasters': {
    name: 'Orcish Bowmasters',
    manaCost: '{1}{B}',
    cmc: 2,
    typeLine: 'Creature — Orc Archer',
    type: 'Creature',
    oracleText: 'Flash\nWhen Orcish Bowmasters enters the battlefield and whenever an opponent draws a card except the first one they draw in each of their draw steps, Orcish Bowmasters deals 1 damage to any target and you amass Orcs 1.',
    imageUri: 'https://cards.scryfall.io/normal/front/7/c/7c024bae-5631-4e20-ac69-df392ac9e109.jpg',
    power: 1,
    toughness: 1,
    colors: ['B']
  },
  'delighted halfling': {
    name: 'Delighted Halfling',
    manaCost: '{G}',
    cmc: 1,
    typeLine: 'Creature — Halfling Citizen',
    type: 'Creature',
    oracleText: "{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a legendary spell, and that spell can't be countered.",
    imageUri: 'https://cards.scryfall.io/normal/front/7/1/71384418-0738-4b77-a488-709779ab6559.jpg',
    power: 1,
    toughness: 2,
    colors: ['G']
  },
  'chord of calling': {
    name: 'Chord of Calling',
    manaCost: '{X}{G}{G}{G}',
    cmc: 3,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'Convoke\nSearch your library for a creature card with mana value X or less, put it onto the battlefield, then shuffle.',
    imageUri: 'https://cards.scryfall.io/normal/front/c/6/c6607447-7459-4590-b338-89749dca838b.jpg',
    colors: ['G']
  },
  'eldritch evolution': {
    name: 'Eldritch Evolution',
    manaCost: '{1}{G}{G}',
    cmc: 3,
    typeLine: 'Sorcery',
    type: 'Sorcery',
    oracleText: "As an additional cost to cast this spell, sacrifice a creature.\nSearch your library for a creature card with mana value equal to or less than 2 plus the sacrificed creature's mana value, put that card onto the battlefield, then shuffle. Exile Eldritch Evolution.",
    imageUri: 'https://cards.scryfall.io/normal/front/6/1/6192b732-ec07-4fb8-9f17-1f3854745c9f.jpg',
    colors: ['G']
  },
  "agatha's soul cauldron": {
    name: "Agatha's Soul Cauldron",
    manaCost: '{2}',
    cmc: 2,
    typeLine: 'Legendary Artifact',
    type: 'Artifact',
    oracleText: "You may spend mana as though it were mana of any color to activate abilities of creatures you control.\nCreatures you control with +1/+1 counters on them have all activated abilities of all creature cards exiled with Agatha's Soul Cauldron.\n{T}: Exile target card from a graveyard. When a creature card is exiled this way, put a +1/+1 counter on target creature you control.",
    imageUri: 'https://cards.scryfall.io/normal/front/0/1/019b51b0-e5c6-4208-922b-7736686dddcd.jpg',
    colors: []
  },
  'fatal push': {
    name: 'Fatal Push',
    manaCost: '{B}',
    cmc: 1,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'Destroy target creature if it has mana value 2 or less.\nRevolt — Destroy that creature if it has mana value 4 or less instead if a permanent you controlled left the battlefield this turn.',
    imageUri: 'https://cards.scryfall.io/normal/front/6/e/6e9da5aa-9a72-4284-9426-54737609af3b.jpg',
    colors: ['B']
  },
  'overgrown tomb': {
    name: 'Overgrown Tomb',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land — Swamp Forest',
    type: 'Land',
    oracleText: "({T}: Add {B} or {G}.)\nAs Overgrown Tomb enters the battlefield, you may pay 2 life. If you don't, it enters the battlefield tapped.",
    imageUri: 'https://cards.scryfall.io/normal/front/e/f/eff1f52c-5c43-4260-aaa0-6920846a191c.jpg',
    colors: []
  },
  'twilight mire': {
    name: 'Twilight Mire',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    type: 'Land',
    oracleText: '{T}: Add {C}.\n{B/G}, {T}: Add {B}{B}, {B}{G}, or {G}{G}.',
    imageUri: 'https://cards.scryfall.io/normal/front/5/3/533a1e03-9372-46eb-a437-0ea873636bb2.jpg',
    colors: []
  },
  'verdant catacombs': {
    name: 'Verdant Catacombs',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    type: 'Land',
    oracleText: '{T}, Pay 1 life, Sacrifice Verdant Catacombs: Search your library for a Swamp or Forest card, put it onto the battlefield, then shuffle.',
    imageUri: 'https://cards.scryfall.io/normal/front/9/4/94c229ea-90da-4aa0-bfda-b162fb3b5b83.jpg',
    colors: []
  },
  'forest': {
    name: 'Forest',
    manaCost: '',
    cmc: 0,
    typeLine: 'Basic Land — Forest',
    type: 'Land',
    oracleText: '({T}: Add {G}.)',
    imageUri: 'https://cards.scryfall.io/normal/front/9/f/9f9e911e-7e12-4d99-806c-5cfba19ea8f3.jpg',
    colors: []
  },
  'swamp': {
    name: 'Swamp',
    manaCost: '',
    cmc: 0,
    typeLine: 'Basic Land — Swamp',
    type: 'Land',
    oracleText: '({T}: Add {B}.)',
    imageUri: 'https://cards.scryfall.io/normal/front/6/2/624ec200-a6ad-45be-b922-a5ecdf0d15e2.jpg',
    colors: []
  },
  'thoughtseize': {
    name: 'Thoughtseize',
    manaCost: '{B}',
    cmc: 1,
    typeLine: 'Sorcery',
    type: 'Sorcery',
    oracleText: 'Target player reveals their hand. You choose a nonland card from it. That player discards that card. You lose 2 life.',
    imageUri: 'https://cards.scryfall.io/normal/front/b/2/b281a308-ab6b-47b6-bec7-632c9aaecede.jpg',
    colors: ['B']
  },
  'force of vigor': {
    name: 'Force of Vigor',
    manaCost: '{2}{G}{G}',
    cmc: 4,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: "If it's not your turn, you may exile a green card from your hand rather than pay this spell's mana cost.\nDestroy up to two target artifacts and/or enchantments.",
    imageUri: 'https://cards.scryfall.io/normal/front/1/9/192ce524-7601-4713-a5c9-94b29ce45fc0.jpg',
    colors: ['G']
  },
  'endurance': {
    name: 'Endurance',
    manaCost: '{1}{G}{G}',
    cmc: 3,
    typeLine: 'Creature — Incarnation',
    type: 'Creature',
    oracleText: 'Flash\nReach\nWhen Endurance enters the battlefield, up to one target player puts all the cards from their graveyard on the bottom of their library in a random order.\nEvoke—Exile a green card from your hand.',
    imageUri: 'https://cards.scryfall.io/normal/front/e/b/eb0e0404-4846-4891-acfa-bd0951ecf9c6.jpg',
    power: 3,
    toughness: 4,
    colors: ['G']
  },
  'scavenging ooze': {
    name: 'Scavenging Ooze',
    manaCost: '{1}{G}',
    cmc: 2,
    typeLine: 'Creature — Ooze',
    type: 'Creature',
    oracleText: '{G}: Exile target card from a graveyard. If it was a creature card, put a +1/+1 counter on Scavenging Ooze and you gain 1 life.',
    imageUri: 'https://cards.scryfall.io/normal/front/6/7/67d93e17-13fd-4cf5-a53c-a7b68229609b.jpg',
    power: 2,
    toughness: 2,
    colors: ['G']
  },
  'veil of summer': {
    name: 'Veil of Summer',
    manaCost: '{G}',
    cmc: 1,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: "Draw a card if an opponent has cast a blue or black spell this turn. Spells you control can't be countered this turn. You and permanents you control gain hexproof from blue and from black until end of turn.",
    imageUri: 'https://cards.scryfall.io/normal/front/a/a/aa686c34-1c11-469f-93c2-f9891aea521f.jpg',
    colors: ['G']
  },
  'karn liberated': {
    name: 'Karn Liberated',
    manaCost: '{7}',
    cmc: 7,
    typeLine: 'Legendary Planeswalker — Karn',
    type: 'Planeswalker',
    oracleText: '+4: Target player exiles a card from their hand.\n-3: Exile target permanent.\n-14: Restart the game, leaving in exile all nonland cards exiled with Karn Liberated. Then put those cards onto the battlefield under your control.',
    imageUri: 'https://cards.scryfall.io/normal/front/4/b/4b0c6662-4dde-40a2-97e0-0318478c0367.jpg',
    loyalty: 6,
    colors: []
  },
  'karn, the great creator': {
    name: 'Karn, the Great Creator',
    manaCost: '{4}',
    cmc: 4,
    typeLine: 'Legendary Planeswalker — Karn',
    type: 'Planeswalker',
    oracleText: "Activated abilities of artifacts your opponents control can't be activated.\n+1: Until your next turn, up to one target noncreature artifact becomes an artifact creature with power and toughness each equal to its mana value.\n-2: You may reveal an artifact card you own from outside the game or in exile and put it into your hand.",
    imageUri: 'https://cards.scryfall.io/normal/front/3/e/3ec0c0fb-1a4f-45f4-85b7-346a6d3ce2c5.jpg',
    loyalty: 5,
    colors: []
  },
  'wurmcoil engine': {
    name: 'Wurmcoil Engine',
    manaCost: '{6}',
    cmc: 6,
    typeLine: 'Artifact Creature — Wurm',
    type: 'Creature',
    oracleText: 'Deathtouch, lifelink\nWhen Wurmcoil Engine dies, create a 3/3 colorless Wurm artifact creature token with deathtouch and a 3/3 colorless Wurm artifact creature token with lifelink.',
    imageUri: 'https://cards.scryfall.io/normal/front/d/0/d011d728-4642-4796-a831-eed055666e8d.jpg',
    power: 6,
    toughness: 6,
    colors: []
  },
  'cityscape leveler': {
    name: 'Cityscape Leveler',
    manaCost: '{8}',
    cmc: 8,
    typeLine: 'Artifact Creature — Construct',
    type: 'Creature',
    oracleText: 'Trample\nWhen you cast this spell and whenever Cityscape Leveler attacks, destroy target nonland permanent. Its controller creates a tapped Powerstone token.\nUnearth {8}',
    imageUri: 'https://cards.scryfall.io/normal/front/6/7/67a6e434-1b6f-4c82-9929-6942ad7f9997.jpg',
    power: 8,
    toughness: 8,
    colors: []
  },
  'oblivion stone': {
    name: 'Oblivion Stone',
    manaCost: '{3}',
    cmc: 3,
    typeLine: 'Artifact',
    type: 'Artifact',
    oracleText: '{4}, {T}: Put a fate counter on target permanent.\n{5}, {T}, Sacrifice Oblivion Stone: Destroy each permanent without a fate counter on it, then remove all fate counters from all permanents.',
    imageUri: 'https://cards.scryfall.io/normal/front/f/0/f010f5a9-2711-4063-976f-86e04729f666.jpg',
    colors: []
  },
  'expedition map': {
    name: 'Expedition Map',
    manaCost: '{1}',
    cmc: 1,
    typeLine: 'Artifact',
    type: 'Artifact',
    oracleText: '{2}, {T}, Sacrifice Expedition Map: Search your library for a land card, reveal it, put it into your hand, then shuffle.',
    imageUri: 'https://cards.scryfall.io/normal/front/5/5/551c0a45-9515-4e51-84e5-79703832a661.jpg',
    colors: []
  },
  'sylvan scrying': {
    name: 'Sylvan Scrying',
    manaCost: '{1}{G}',
    cmc: 2,
    typeLine: 'Sorcery',
    type: 'Sorcery',
    oracleText: 'Search your library for a land card, reveal it, put it into your hand, then shuffle.',
    imageUri: 'https://cards.scryfall.io/normal/front/d/1/d19c35c4-29ae-4764-9c95-e0440fb585ae.jpg',
    colors: ['G']
  },
  'ancient stirrings': {
    name: 'Ancient Stirrings',
    manaCost: '{G}',
    cmc: 1,
    typeLine: 'Sorcery',
    type: 'Sorcery',
    oracleText: 'Look at the top five cards of your library. You may reveal a colorless card from among them and put it into your hand. Put the rest on the bottom of your library in any order.',
    imageUri: 'https://cards.scryfall.io/normal/front/7/2/726039a0-e49d-4217-a364-75175585fa8b.jpg',
    colors: ['G']
  },
  'chromatic sphere': {
    name: 'Chromatic Sphere',
    manaCost: '{1}',
    cmc: 1,
    typeLine: 'Artifact',
    type: 'Artifact',
    oracleText: '{1}, {T}, Sacrifice Chromatic Sphere: Add one mana of any color. Draw a card.',
    imageUri: 'https://cards.scryfall.io/normal/front/b/d/bd35b7bd-1166-4dd9-8758-003a49c21455.jpg',
    colors: []
  },
  'chromatic star': {
    name: 'Chromatic Star',
    manaCost: '{1}',
    cmc: 1,
    typeLine: 'Artifact',
    type: 'Artifact',
    oracleText: '{1}, {T}, Sacrifice Chromatic Star: Add one mana of any color.\nWhen Chromatic Star is put into a graveyard from the battlefield, draw a card.',
    imageUri: 'https://cards.scryfall.io/normal/front/c/2/c2e8d492-2c67-410b-b556-c157a14c4ecd.jpg',
    colors: []
  },
  'dismember': {
    name: 'Dismember',
    manaCost: '{1}{B/P}{B/P}',
    cmc: 3,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: '({B/P} can be paid with either {B} or 2 life.)\nTarget creature gets -5/-5 until end of turn.',
    imageUri: 'https://cards.scryfall.io/normal/front/3/d/3d286cf6-3e16-4941-9326-1818b1e06d69.jpg',
    colors: ['B']
  },
  "urza's tower": {
    name: "Urza's Tower",
    manaCost: '',
    cmc: 0,
    typeLine: "Land — Urza's Tower",
    type: 'Land',
    oracleText: "{T}: Add {C}. If you control an Urza's Mine and an Urza's Power-Plant, add {C}{C}{C} instead.",
    imageUri: 'https://cards.scryfall.io/normal/front/9/e/9e369f3f-354b-42bf-9b2f-2d8f42c2042e.jpg',
    colors: []
  },
  "urza's power plant": {
    name: "Urza's Power Plant",
    manaCost: '',
    cmc: 0,
    typeLine: "Land — Urza's Power-Plant",
    type: 'Land',
    oracleText: "{T}: Add {C}. If you control an Urza's Mine and an Urza's Tower, add {C}{C} instead.",
    imageUri: 'https://cards.scryfall.io/normal/front/5/4/544e1080-4965-4f46-990a-a1b9b2ff4387.jpg',
    colors: []
  },
  "urza's mine": {
    name: "Urza's Mine",
    manaCost: '',
    cmc: 0,
    typeLine: "Land — Urza's Mine",
    type: 'Land',
    oracleText: "{T}: Add {C}. If you control an Urza's Power-Plant and an Urza's Tower, add {C}{C} instead.",
    imageUri: 'https://cards.scryfall.io/normal/front/0/8/08dec8fe-e143-4874-a3d3-298246529370.jpg',
    colors: []
  },
  'boseiju, who endures': {
    name: 'Boseiju, Who Endures',
    manaCost: '',
    cmc: 0,
    typeLine: 'Legendary Land',
    type: 'Land',
    oracleText: '{T}: Add {G}.\nChannel — {1}{G}, Discard Boseiju, Who Endures: Destroy target artifact, enchantment, or nonbasic land an opponent controls. That player may search their library for a land card with a basic land type, put it onto the battlefield, then shuffle. This ability costs {1} less to activate for each legendary creature you control.',
    imageUri: 'https://cards.scryfall.io/normal/front/2/1/2135ac5a-187b-4dc9-8f82-34e8d1603416.jpg',
    colors: []
  },
  'ensnaring bridge': {
    name: 'Ensnaring Bridge',
    manaCost: '{3}',
    cmc: 3,
    typeLine: 'Artifact',
    type: 'Artifact',
    oracleText: "Creatures with power greater than the number of cards in your hand can't attack.",
    imageUri: 'https://cards.scryfall.io/normal/front/c/f/cf825a56-4870-423a-8657-7ce575ac5e5e.jpg',
    colors: []
  },
  'the stone brain': {
    name: 'The Stone Brain',
    manaCost: '{2}',
    cmc: 2,
    typeLine: 'Legendary Artifact',
    type: 'Artifact',
    oracleText: "{2}, {T}, Exile The Stone Brain: Choose a card name. Search target opponent's graveyard, hand, and library for up to four cards with that name and exile them. That player draws a card for each card exiled from their hand this way, then shuffles. Activate only as a sorcery.",
    imageUri: 'https://cards.scryfall.io/normal/front/3/b/3b02925c-96a4-4573-a069-42de622b6a1a.jpg',
    colors: []
  },
  'sundering titan': {
    name: 'Sundering Titan',
    manaCost: '{8}',
    cmc: 8,
    typeLine: 'Artifact Creature — Golem',
    type: 'Creature',
    oracleText: 'When Sundering Titan enters the battlefield or leaves the battlefield, choose a land of each basic land type, then destroy those lands.',
    imageUri: 'https://cards.scryfall.io/normal/front/a/2/a2ebb1b3-7058-4c45-9b0c-5263ac3f0507.jpg',
    power: 7,
    toughness: 10,
    colors: []
  },
  "tormod's crypt": {
    name: "Tormod's Crypt",
    manaCost: '{0}',
    cmc: 0,
    typeLine: 'Artifact',
    type: 'Artifact',
    oracleText: "{T}, Sacrifice Tormod's Crypt: Exile all cards from target player's graveyard.",
    imageUri: 'https://cards.scryfall.io/normal/front/9/c/9c224bf0-5641-4160-9d5c-46141ea8372a.jpg',
    colors: []
  },
  'haywire mite': {
    name: 'Haywire Mite',
    manaCost: '{1}',
    cmc: 1,
    typeLine: 'Artifact Creature — Insect',
    type: 'Creature',
    oracleText: 'When Haywire Mite dies, you gain 2 life.\n{G}, Sacrifice Haywire Mite: Exile target noncreature artifact or noncreature enchantment.',
    imageUri: 'https://cards.scryfall.io/normal/front/8/4/847a175e-edd1-4596-baf3-5f7f57859e8b.jpg',
    power: 1,
    toughness: 1,
    colors: []
  },
  "nature's claim": {
    name: "Nature's Claim",
    manaCost: '{G}',
    cmc: 1,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'Destroy target artifact or enchantment. Its controller gains 4 life.',
    imageUri: 'https://cards.scryfall.io/normal/front/d/2/d24b6640-ef2f-4c92-bbe3-afbf7c32b142.jpg',
    colors: ['G']
  },
  'shardless agent': {
    name: 'Shardless Agent',
    manaCost: '{1}{G}{U}',
    cmc: 3,
    typeLine: 'Artifact Creature — Human Rogue',
    type: 'Creature',
    oracleText: 'Cascade',
    imageUri: 'https://cards.scryfall.io/normal/front/b/0/b0ba79d1-0e32-4933-b437-d420400eddb7.jpg',
    power: 2,
    toughness: 2,
    colors: ['G', 'U']
  },
  'violent outburst': {
    name: 'Violent Outburst',
    manaCost: '{1}{R}{G}',
    cmc: 3,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'Cascade\nCreatures you control get +1/+0 until end of turn.',
    imageUri: 'https://cards.scryfall.io/normal/front/1/b/1b58856a-f88e-4625-8636-62b5c717b956.jpg',
    colors: ['R', 'G']
  },
  'crashing footfalls': {
    name: 'Crashing Footfalls',
    manaCost: '',
    cmc: 0,
    typeLine: 'Sorcery',
    type: 'Sorcery',
    oracleText: 'Suspend 4—{G}\nCreate two 4/4 green Rhino creature tokens with trample.',
    imageUri: 'https://cards.scryfall.io/normal/front/a/8/a8cca2a2-69e3-4136-936c-7a2774c19351.jpg',
    colors: ['G']
  },
  'fire // ice': {
    name: 'Fire // Ice',
    manaCost: '{1}{R} // {1}{U}',
    cmc: 2,
    typeLine: 'Instant // Instant',
    type: 'Instant',
    oracleText: 'Fire deals 2 damage divided as you choose among one or two targets.\n//\nTap target permanent.\nDraw a card.',
    imageUri: 'https://cards.scryfall.io/normal/front/0/e/0e8dac9c-df96-4937-8149-1607e0f3d893.jpg',
    colors: ['R', 'U']
  },
  'force of negation': {
    name: 'Force of Negation',
    manaCost: '{1}{U}{U}',
    cmc: 3,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: "If it's not your turn, you may exile a blue card from your hand rather than pay this spell's mana cost.\nCounter target noncreature spell. If that spell is countered this way, exile it instead of putting it into its owner's graveyard.",
    imageUri: 'https://cards.scryfall.io/normal/front/e/8/e82fa0fe-e33b-4c23-9ed7-d0c7a70d728e.jpg',
    colors: ['U']
  },
  'lorien revealed': {
    name: 'Lorien Revealed',
    manaCost: '{3}{U}{U}',
    cmc: 5,
    typeLine: 'Sorcery',
    type: 'Sorcery',
    oracleText: 'Draw three cards.\nIslandcycling {1}',
    imageUri: 'https://cards.scryfall.io/normal/front/0/c/0ce44270-a884-4a39-9030-8b11a55da823.jpg',
    colors: ['U']
  },
  'bloodbraid elf': {
    name: 'Bloodbraid Elf',
    manaCost: '{2}{R}{G}',
    cmc: 4,
    typeLine: 'Creature — Elf Berserker',
    type: 'Creature',
    oracleText: 'Haste\nCascade',
    imageUri: 'https://cards.scryfall.io/normal/front/e/2/e2f12f6f-9383-47e6-a44f-2e34dd67756e.jpg',
    power: 3,
    toughness: 2,
    colors: ['R', 'G']
  },
  'bonecrusher giant': {
    name: 'Bonecrusher Giant',
    manaCost: '{2}{R}',
    cmc: 3,
    typeLine: 'Creature — Giant',
    type: 'Creature',
    oracleText: 'Whenever Bonecrusher Giant becomes the target of a spell, Bonecrusher Giant deals 2 damage to that spell\'s controller.',
    imageUri: 'https://cards.scryfall.io/normal/front/0/9/09fd2d9c-1793-4beb-a3fb-7a869f660cd4.jpg',
    power: 4,
    toughness: 3,
    colors: ['R']
  },
  'dead // gone': {
    name: 'Dead // Gone',
    manaCost: '{R} // {2}{R}',
    cmc: 1,
    typeLine: 'Instant // Instant',
    type: 'Instant',
    oracleText: 'Dead deals 2 damage to target creature.\n//\nReturn target creature you don\'t control to its owner\'s hand.',
    imageUri: 'https://cards.scryfall.io/normal/front/3/e/3e739fa9-5075-4f83-822d-72c85a6f5e33.jpg',
    colors: ['R']
  },
  'misty rainforest': {
    name: 'Misty Rainforest',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    type: 'Land',
    oracleText: '{T}, Pay 1 life, Sacrifice Misty Rainforest: Search your library for a Forest or Island card, put it onto the battlefield, then shuffle.',
    imageUri: 'https://cards.scryfall.io/normal/front/8/8/88231c0d-0cc8-44ec-bf95-81c1710ac141.jpg',
    colors: []
  },
  'wooded foothills': {
    name: 'Wooded Foothills',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    type: 'Land',
    oracleText: '{T}, Pay 1 life, Sacrifice Wooded Foothills: Search your library for a Mountain or Forest card, put it onto the battlefield, then shuffle.',
    imageUri: 'https://cards.scryfall.io/normal/front/a/8/a8503cca-7e7d-44c4-8587-81376b396398.jpg',
    colors: []
  },
  'breeding pool': {
    name: 'Breeding Pool',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land — Forest Island',
    type: 'Land',
    oracleText: '({T}: Add {G} or {U}.)\nAs Breeding Pool enters the battlefield, you may pay 2 life. If you don\'t, it enters the battlefield tapped.',
    imageUri: 'https://cards.scryfall.io/normal/front/b/b/bb54233c-0844-4965-9cde-e8a4ef3e11b8.jpg',
    colors: []
  },
  'stomping ground': {
    name: 'Stomping Ground',
    manaCost: '',
    cmc: 0,
    typeLine: 'Land — Mountain Forest',
    type: 'Land',
    oracleText: '({T}: Add {R} or {G}.)\nAs Stomping Ground enters the battlefield, you may pay 2 life. If you don\'t, it enters the battlefield tapped.',
    imageUri: 'https://cards.scryfall.io/normal/front/d/c/dcaa1ff6-304e-4660-9df3-36de8e89592e.jpg',
    colors: []
  },
  'mystical dispute': {
    name: 'Mystical Dispute',
    manaCost: '{2}{U}',
    cmc: 3,
    typeLine: 'Instant',
    type: 'Instant',
    oracleText: 'This spell costs {2} less to cast if it targets a blue spell.\nCounter target spell unless its controller pays {3}.',
    imageUri: 'https://cards.scryfall.io/normal/front/f/b/fbe4a4e8-f86f-4ae3-b703-b62bd0dd9729.jpg',
    colors: ['U']
  },
  'flame slash': {
    name: 'Flame Slash',
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Sorcery',
    type: 'Sorcery',
    oracleText: 'Flame Slash deals 4 damage to target creature.',
    imageUri: 'https://cards.scryfall.io/normal/front/1/5/1548defd-43f2-4255-a6ae-f63328e3b586.jpg',
    colors: ['R']
  },
  "brotherhood's end": {
    name: "Brotherhood's End",
    manaCost: '{1}{R}{R}',
    cmc: 3,
    typeLine: 'Sorcery',
    type: 'Sorcery',
    oracleText: "Choose one —\n• Brotherhood's End deals 3 damage to each creature and each planeswalker.\n• Destroy all artifacts with mana value 3 or less.",
    imageUri: 'https://cards.scryfall.io/normal/front/5/0/50f7666d-0d60-4fe5-b144-286d4e47b704.jpg',
    colors: ['R']
  },
  'plains': {
    name: 'Plains',
    manaCost: '',
    cmc: 0,
    typeLine: 'Basic Land — Plains',
    type: 'Land',
    oracleText: '({T}: Add {W}.)',
    imageUri: 'https://cards.scryfall.io/normal/front/5/b/5b4c1071-12f8-4b71-a8bb-e68840a1b2ee.jpg',
    colors: []
  }
};

/**
 * Retrieves pre-hydrated card metadata by card name (INV-INSPECT-1).
 * 
 * @param {string} name
 * @returns {Object|null}
 */
export function getHydratedCardMetadata(name) {
  if (!name || typeof name !== 'string') return null;
  const meta = STARTER_CARD_METADATA[name.trim().toLowerCase()];
  return meta ? { ...meta } : null;
}

export const PRECOMPILED_ARCHETYPES = [
  {
    id: 'starter_mono_red_burn',
    archetype: 'Mono-Red Burn',
    title: 'Mono-Red Burn (Modern)',
    format: 'modern',
    colorIdentity: ['R'],
    tags: ['COLOR_R', 'ARCH_BURN', 'ARCH_AGGRO', 'MECH_BURN'],
    strategyDescription: 'Fast, aggressive direct damage burn deck targeting the opponent life total with high tempo.',
    previewCards: ['Lightning Bolt', 'Goblin Guide', 'Monastery Swiftspear', 'Eidolon of the Great Revel'],
    mainboard: [
      { name: 'Goblin Guide', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Monastery Swiftspear', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Eidolon of the Great Revel', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Lightning Bolt', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Lava Spike', count: 4, cmc: 1, type: 'Sorcery' },
      { name: 'Rift Bolt', count: 4, cmc: 3, type: 'Sorcery' },
      { name: 'Searing Blaze', count: 4, cmc: 2, type: 'Instant' },
      { name: 'Skewer the Critics', count: 4, cmc: 3, type: 'Sorcery' },
      { name: 'Roiling Vortex', count: 4, cmc: 2, type: 'Enchantment' },
      { name: 'Shard Volley', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Mountain', count: 20, cmc: 0, type: 'Land' }
    ],
    sideboard: [
      { name: 'Smash to Smithereens', count: 4, cmc: 2, type: 'Instant' },
      { name: 'Roiling Vortex', count: 1, cmc: 2, type: 'Enchantment' },
      { name: 'Deflecting Palm', count: 4, cmc: 2, type: 'Instant' },
      { name: 'Path to Exile', count: 3, cmc: 1, type: 'Instant' },
      { name: 'Rest in Peace', count: 3, cmc: 2, type: 'Enchantment' }
    ]
  },
  {
    id: 'starter_izzet_murktide',
    archetype: 'Izzet Murktide',
    title: 'Izzet Murktide (Modern)',
    format: 'modern',
    colorIdentity: ['U', 'R'],
    tags: ['COLOR_U', 'COLOR_R', 'ARCH_TEMPO', 'MECH_COUNTERSPELL', 'MECH_GRAVEYARD'],
    strategyDescription: 'Delirium tempo deck combining cheap cantrips, permission, and towering Murktide Regents.',
    previewCards: ['Murktide Regent', "Dragon's Rage Channeler", 'Ragavan, Nimble Pilferer', 'Counterspell'],
    mainboard: [
      { name: 'Murktide Regent', count: 4, cmc: 7, type: 'Creature' },
      { name: "Dragon's Rage Channeler", count: 4, cmc: 1, type: 'Creature' },
      { name: 'Ragavan, Nimble Pilferer', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Ledger Shredder', count: 3, cmc: 2, type: 'Creature' },
      { name: 'Lightning Bolt', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Counterspell', count: 4, cmc: 2, type: 'Instant' },
      { name: 'Expressive Iteration', count: 4, cmc: 2, type: 'Sorcery' },
      { name: 'Consider', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Unholy Heat', count: 4, cmc: 1, type: 'Instant' },
      { name: "Mishra's Bauble", count: 4, cmc: 0, type: 'Artifact' },
      { name: 'Spell Pierce', count: 2, cmc: 1, type: 'Instant' },
      { name: 'Steam Vents', count: 4, cmc: 0, type: 'Land' },
      { name: 'Spirebluff Canal', count: 4, cmc: 0, type: 'Land' },
      { name: 'Scalding Tarn', count: 4, cmc: 0, type: 'Land' },
      { name: 'Island', count: 4, cmc: 0, type: 'Land' },
      { name: 'Mountain', count: 3, cmc: 0, type: 'Land' }
    ],
    sideboard: [
      { name: 'Blood Moon', count: 3, cmc: 3, type: 'Enchantment' },
      { name: 'Flusterstorm', count: 3, cmc: 1, type: 'Instant' },
      { name: 'Engineered Explosives', count: 3, cmc: 0, type: 'Artifact' },
      { name: 'Subtlety', count: 3, cmc: 4, type: 'Creature' },
      { name: 'Dress Down', count: 3, cmc: 2, type: 'Enchantment' }
    ]
  },
  {
    id: 'starter_golgari_yawgmoth',
    archetype: 'Golgari Yawgmoth',
    title: 'Golgari Yawgmoth (Modern)',
    format: 'modern',
    colorIdentity: ['B', 'G'],
    tags: ['COLOR_B', 'COLOR_G', 'ARCH_COMBO', 'ARCH_MIDRANGE', 'MECH_SACRIFICE', 'MECH_GRAVEYARD'],
    strategyDescription: 'Undying creature sacrifice combo engine with Yawgmoth generating infinite card draw and direct drain.',
    previewCards: ['Yawgmoth, Thran Physician', 'Orcish Bowmasters', "Agatha's Soul Cauldron", 'Chord of Calling'],
    mainboard: [
      { name: 'Yawgmoth, Thran Physician', count: 4, cmc: 4, type: 'Creature' },
      { name: 'Young Wolf', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Strangleroot Geist', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Wall of Roots', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Orcish Bowmasters', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Delighted Halfling', count: 3, cmc: 1, type: 'Creature' },
      { name: 'Chord of Calling', count: 4, cmc: 3, type: 'Instant' },
      { name: 'Eldritch Evolution', count: 4, cmc: 3, type: 'Sorcery' },
      { name: "Agatha's Soul Cauldron", count: 4, cmc: 2, type: 'Artifact' },
      { name: 'Fatal Push', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Overgrown Tomb', count: 4, cmc: 0, type: 'Land' },
      { name: 'Twilight Mire', count: 4, cmc: 0, type: 'Land' },
      { name: 'Verdant Catacombs', count: 4, cmc: 0, type: 'Land' },
      { name: 'Forest', count: 5, cmc: 0, type: 'Land' },
      { name: 'Swamp', count: 4, cmc: 0, type: 'Land' }
    ],
    sideboard: [
      { name: 'Thoughtseize', count: 4, cmc: 1, type: 'Sorcery' },
      { name: 'Force of Vigor', count: 3, cmc: 4, type: 'Instant' },
      { name: 'Endurance', count: 3, cmc: 3, type: 'Creature' },
      { name: 'Scavenging Ooze', count: 3, cmc: 2, type: 'Creature' },
      { name: 'Veil of Summer', count: 2, cmc: 1, type: 'Instant' }
    ]
  },
  {
    id: 'starter_mono_green_tron',
    archetype: 'Mono-Green Tron',
    title: 'Mono-Green Tron (Modern)',
    format: 'modern',
    colorIdentity: ['G'],
    tags: ['COLOR_G', 'COLOR_COLORLESS', 'ARCH_RAMP', 'TYPE_ARTIFACT', 'TYPE_PLANESWALKER'],
    strategyDescription: 'Assembles Urza land trio on turn 3 to deploy overwhelming colorless planeswalkers and threats.',
    previewCards: ['Karn Liberated', 'Karn, the Great Creator', 'Wurmcoil Engine', "Urza's Tower"],
    mainboard: [
      { name: 'Karn Liberated', count: 4, cmc: 7, type: 'Planeswalker' },
      { name: 'Karn, the Great Creator', count: 4, cmc: 4, type: 'Planeswalker' },
      { name: 'Wurmcoil Engine', count: 4, cmc: 6, type: 'Artifact Creature' },
      { name: 'Cityscape Leveler', count: 3, cmc: 8, type: 'Artifact Creature' },
      { name: 'Oblivion Stone', count: 4, cmc: 3, type: 'Artifact' },
      { name: 'Expedition Map', count: 4, cmc: 1, type: 'Artifact' },
      { name: 'Sylvan Scrying', count: 4, cmc: 2, type: 'Sorcery' },
      { name: 'Ancient Stirrings', count: 4, cmc: 1, type: 'Sorcery' },
      { name: 'Chromatic Sphere', count: 4, cmc: 1, type: 'Artifact' },
      { name: 'Chromatic Star', count: 4, cmc: 1, type: 'Artifact' },
      { name: 'Dismember', count: 2, cmc: 3, type: 'Instant' },
      { name: "Urza's Tower", count: 4, cmc: 0, type: 'Land' },
      { name: "Urza's Power Plant", count: 4, cmc: 0, type: 'Land' },
      { name: "Urza's Mine", count: 4, cmc: 0, type: 'Land' },
      { name: 'Boseiju, Who Endures', count: 1, cmc: 0, type: 'Land' },
      { name: 'Forest', count: 6, cmc: 0, type: 'Land' }
    ],
    sideboard: [
      { name: 'Ensnaring Bridge', count: 1, cmc: 3, type: 'Artifact' },
      { name: 'The Stone Brain', count: 1, cmc: 2, type: 'Artifact' },
      { name: 'Sundering Titan', count: 1, cmc: 8, type: 'Artifact Creature' },
      { name: "Tormod's Crypt", count: 1, cmc: 0, type: 'Artifact' },
      { name: 'Haywire Mite', count: 2, cmc: 1, type: 'Artifact Creature' },
      { name: 'Cityscape Leveler', count: 1, cmc: 8, type: 'Artifact Creature' },
      { name: 'Wurmcoil Engine', count: 1, cmc: 6, type: 'Artifact Creature' },
      { name: 'Dismember', count: 2, cmc: 3, type: 'Instant' },
      { name: "Nature's Claim", count: 3, cmc: 1, type: 'Instant' },
      { name: 'Veil of Summer', count: 2, cmc: 1, type: 'Instant' }
    ]
  },
  {
    id: 'starter_temur_rhinos',
    archetype: 'Temur Rhinos',
    title: 'Temur Rhinos (Modern)',
    format: 'modern',
    colorIdentity: ['G', 'U', 'R'],
    tags: ['COLOR_G', 'COLOR_U', 'COLOR_R', 'ARCH_CASCADE', 'ARCH_MIDRANGE', 'MECH_CASCADE'],
    strategyDescription: 'Reliably cascades into Crashing Footfalls to flood the board with 4/4 Trampling Rhino tokens.',
    previewCards: ['Crashing Footfalls', 'Shardless Agent', 'Violent Outburst', 'Force of Negation'],
    mainboard: [
      { name: 'Shardless Agent', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Violent Outburst', count: 4, cmc: 3, type: 'Instant' },
      { name: 'Crashing Footfalls', count: 4, cmc: 0, type: 'Sorcery' },
      { name: 'Fire // Ice', count: 4, cmc: 2, type: 'Instant' },
      { name: 'Subtlety', count: 4, cmc: 4, type: 'Creature' },
      { name: 'Force of Negation', count: 4, cmc: 3, type: 'Instant' },
      { name: 'Lorien Revealed', count: 4, cmc: 5, type: 'Sorcery' },
      { name: 'Bloodbraid Elf', count: 4, cmc: 4, type: 'Creature' },
      { name: 'Bonecrusher Giant', count: 3, cmc: 3, type: 'Creature' },
      { name: 'Dead // Gone', count: 3, cmc: 1, type: 'Instant' },
      { name: 'Misty Rainforest', count: 4, cmc: 0, type: 'Land' },
      { name: 'Wooded Foothills', count: 4, cmc: 0, type: 'Land' },
      { name: 'Breeding Pool', count: 3, cmc: 0, type: 'Land' },
      { name: 'Stomping Ground', count: 3, cmc: 0, type: 'Land' },
      { name: 'Steam Vents', count: 3, cmc: 0, type: 'Land' },
      { name: 'Island', count: 3, cmc: 0, type: 'Land' },
      { name: 'Forest', count: 1, cmc: 0, type: 'Land' },
      { name: 'Mountain', count: 1, cmc: 0, type: 'Land' }
    ],
    sideboard: [
      { name: 'Mystical Dispute', count: 3, cmc: 3, type: 'Instant' },
      { name: 'Endurance', count: 3, cmc: 3, type: 'Creature' },
      { name: 'Force of Vigor', count: 3, cmc: 4, type: 'Instant' },
      { name: 'Flame Slash', count: 3, cmc: 1, type: 'Sorcery' },
      { name: "Brotherhood's End", count: 3, cmc: 3, type: 'Sorcery' }
    ]
  }
];

// Pre-hydrate all starter cards with complete Scryfall metadata (INV-INSPECT-1)
for (const a of PRECOMPILED_ARCHETYPES) {
  for (const list of [a.mainboard, a.sideboard]) {
    for (let i = 0; i < list.length; i++) {
      const card = list[i];
      const meta = STARTER_CARD_METADATA[card.name.trim().toLowerCase()];
      if (meta) {
        list[i] = {
          ...card,
          manaCost: meta.manaCost,
          typeLine: meta.typeLine,
          type: meta.type || card.type,
          oracleText: meta.oracleText,
          imageUri: meta.imageUri,
          power: meta.power,
          toughness: meta.toughness,
          loyalty: meta.loyalty,
          colors: meta.colors || []
        };
      }
    }
  }
}

export const STARTER_DECKS = PRECOMPILED_ARCHETYPES;

/**
 * Deals rich pre-hydrated starting hands to players (INV-INSPECT-1).
 * 
 * @param {string[]} playerIds
 * @param {Object} tabletopState
 * @param {string} [archetypeId='starter_mono_red_burn']
 */
export function dealStartingHands(playerIds, tabletopState, archetypeId = 'starter_mono_red_burn') {
  const pids = Array.isArray(playerIds) ? playerIds : ['p1', 'p2'];
  const starterCardNames = [
    'Steam Vents', 'Mountain', 'Swamp', 'Lightning Bolt', 'Goblin Guide', 'Monastery Swiftspear', 'Lava Spike'
  ];

  for (const pid of pids) {
    const p = tabletopState?.players?.[pid];
    if (p) {
      if (!p.zones) {
        p.zones = { hand: [], library: [], graveyard: [], exile: [], battlefield: [] };
      }
      const handCards = starterCardNames.map((name, idx) => {
        const meta = getHydratedCardMetadata(name) || {
          name,
          cmc: 1,
          manaCost: '{R}',
          typeLine: 'Card',
          type: 'Card',
          oracleText: '',
          imageUri: ''
        };
        return {
          instanceId: `card_${pid}_${idx}_${Date.now()}`,
          name: meta.name || name,
          typeLine: meta.typeLine,
          type: meta.type || meta.typeLine,
          manaCost: meta.manaCost,
          cmc: meta.cmc ?? 1,
          oracleText: meta.oracleText || '',
          imageUri: meta.imageUri || '',
          power: meta.power,
          toughness: meta.toughness,
          loyalty: meta.loyalty,
          colors: meta.colors || [],
          owner: pid,
          ownerId: pid,
          controllerId: pid,
          zone: 'HAND',
          isTapped: false
        };
      });
      p.zones.hand = handCards;
      p.hand = handCards;
    }
  }
}

// Add total card counts to each starter
for (const a of PRECOMPILED_ARCHETYPES) {
  a.totalCards = a.mainboard.reduce((acc, c) => acc + c.count, 0);
  a.sideboardCount = a.sideboard.reduce((acc, c) => acc + c.count, 0);
}

// =============================================================================
// Beginner Single-Color Deck Catalogs (INV-STORAGE-4)
// =============================================================================

export const BEGINNER_DECKS = {
  W: {
    archetype: 'Mono-White Weenie Lifegain',
    title: 'Beginner Mono-White Lifegain',
    colorIdentity: ['W'],
    format: 'beginner',
    previewCards: ['Soul Warden', "Ajani's Pridemate", 'Skyclave Apparition', 'Serra Angel'],
    mainboard: [
      { name: 'Plains', count: 24, cmc: 0, type: 'Land' },
      { name: 'Soul Warden', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Leonin Vanguard', count: 4, cmc: 1, type: 'Creature' },
      { name: "Ajani's Pridemate", count: 4, cmc: 2, type: 'Creature' },
      { name: 'Daxos, Blessed by the Sun', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Reprieve', count: 4, cmc: 2, type: 'Instant' },
      { name: 'Linden, the Steadfast Queen', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Skyclave Apparition', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Banishing Light', count: 2, cmc: 3, type: 'Enchantment' },
      { name: 'Ranger-Captain of Eos', count: 4, cmc: 4, type: 'Creature' },
      { name: 'Serra Angel', count: 2, cmc: 5, type: 'Creature' }
    ],
    sideboard: []
  },
  U: {
    archetype: 'Mono-Blue Tempo Flying',
    title: 'Beginner Mono-Blue Tempo',
    colorIdentity: ['U'],
    format: 'beginner',
    previewCards: ['Delver of Secrets', 'Counterspell', 'Brazen Borrower', 'Murktide Regent'],
    mainboard: [
      { name: 'Island', count: 24, cmc: 0, type: 'Land' },
      { name: 'Delver of Secrets', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Opt', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Faerie Mastermind', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Counterspell', count: 4, cmc: 2, type: 'Instant' },
      { name: 'Snapcaster Mage', count: 4, cmc: 2, type: 'Creature' },
      { name: "Archmage's Charm", count: 4, cmc: 3, type: 'Instant' },
      { name: 'Brazen Borrower', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Thirst for Discovery', count: 2, cmc: 3, type: 'Instant' },
      { name: 'Cryptic Command', count: 4, cmc: 4, type: 'Instant' },
      { name: 'Murktide Regent', count: 2, cmc: 7, type: 'Creature' }
    ],
    sideboard: []
  },
  B: {
    archetype: 'Mono-Black Midrange Control',
    title: 'Beginner Mono-Black Midrange',
    colorIdentity: ['B'],
    format: 'beginner',
    previewCards: ['Inquisition of Kozilek', 'Fatal Push', 'Phyrexian Arena', 'Gray Merchant of Asphodel'],
    mainboard: [
      { name: 'Swamp', count: 24, cmc: 0, type: 'Land' },
      { name: 'Inquisition of Kozilek', count: 4, cmc: 1, type: 'Sorcery' },
      { name: 'Fatal Push', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Dauthi Voidwalker', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Gifted Aetherborn', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Bitterblossom', count: 4, cmc: 2, type: 'Enchantment' },
      { name: 'Phyrexian Arena', count: 4, cmc: 3, type: 'Enchantment' },
      { name: 'Murderous Rider', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Hypnotic Specter', count: 2, cmc: 3, type: 'Creature' },
      { name: 'Gray Merchant of Asphodel', count: 4, cmc: 5, type: 'Creature' },
      { name: 'Sheoldred, the Apocalypse', count: 2, cmc: 4, type: 'Creature' }
    ],
    sideboard: []
  },
  R: {
    archetype: 'Mono-Red Sligh Aggro',
    title: 'Beginner Mono-Red Aggro',
    colorIdentity: ['R'],
    format: 'beginner',
    previewCards: ['Monastery Swiftspear', 'Lightning Bolt', 'Seasoned Pyromancer', 'Torbran, Thane of Red Fell'],
    mainboard: [
      { name: 'Mountain', count: 22, cmc: 0, type: 'Land' },
      { name: 'Monastery Swiftspear', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Lightning Bolt', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Eidolon of the Great Revel', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Magmatic Channeler', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Searing Blaze', count: 4, cmc: 2, type: 'Instant' },
      { name: 'Seasoned Pyromancer', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Light Up the Stage', count: 4, cmc: 3, type: 'Sorcery' },
      { name: 'Bonecrusher Giant', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Torbran, Thane of Red Fell', count: 4, cmc: 4, type: 'Creature' },
      { name: 'Hazoret the Fervent', count: 2, cmc: 4, type: 'Legendary Creature' }
    ],
    sideboard: []
  },
  G: {
    archetype: 'Mono-Green Stompy Ramp',
    title: 'Beginner Mono-Green Stompy',
    colorIdentity: ['G'],
    format: 'beginner',
    previewCards: ['Llanowar Elves', 'Strangleroot Geist', 'Steel Leaf Champion', 'Questing Beast'],
    mainboard: [
      { name: 'Forest', count: 24, cmc: 0, type: 'Land' },
      { name: 'Llanowar Elves', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Elvish Mystic', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Strangleroot Geist', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Barkhide Troll', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Explore', count: 4, cmc: 2, type: 'Sorcery' },
      { name: 'Steel Leaf Champion', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Dungrove Elder', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Courser of Kruphix', count: 2, cmc: 3, type: 'Enchantment Creature' },
      { name: 'Questing Beast', count: 4, cmc: 4, type: 'Creature' },
      { name: 'Elder Gargaroth', count: 2, cmc: 5, type: 'Creature' }
    ],
    sideboard: []
  }
};

// =============================================================================
// Helper Functions: Export, Scoring, Conflict Resolution
// =============================================================================

/**
 * Formats a deck object into standard export text (Arena, MTGO, or plain text).
 * @param {Object} deck
 * @param {'arena'|'mtgo'|'text'} [format='arena']
 * @returns {string}
 */
export function formatDeckForExport(deck, format = 'arena') {
  if (!deck) return '';
  const main = Array.isArray(deck.mainboard) ? deck.mainboard : [];
  const side = Array.isArray(deck.sideboard) ? deck.sideboard : [];

  if (format === 'arena') {
    let out = 'Deck\n';
    for (const c of main) {
      out += `${c.count} ${c.name}\n`;
    }
    if (side.length > 0) {
      out += '\nSideboard\n';
      for (const c of side) {
        out += `${c.count} ${c.name}\n`;
      }
    }
    return out.trim();
  }

  if (format === 'mtgo') {
    let out = '';
    for (const c of main) {
      out += `${c.count} ${c.name}\n`;
    }
    for (const c of side) {
      out += `SB: ${c.count} ${c.name}\n`;
    }
    return out.trim();
  }

  let out = 'Mainboard:\n';
  for (const c of main) {
    out += `${c.count} ${c.name}\n`;
  }
  if (side.length > 0) {
    out += '\nSideboard:\n';
    for (const c of side) {
      out += `${c.count} ${c.name}\n`;
    }
  }
  return out.trim();
}

/**
 * Evaluates raw guidelines and eliminates contradictory constraints using
 * deterministic chronological recency precedence (INV-STORAGE-2).
 * Newer timestamp wins for any identical semantic targetTag.
 * 
 * @param {Array<Object>} rawGuidelines
 * @returns {Array<Object>} Filtered, conflict-free active guidelines (max 10).
 */
export function resolveActiveGuidelines(rawGuidelines) {
  if (!Array.isArray(rawGuidelines) || rawGuidelines.length === 0) {
    return [];
  }

  // Sort descending: newest first
  const sorted = [...rawGuidelines].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const resolvedMap = new Map();
  const activeGuidelines = [];

  for (const g of sorted) {
    const tag = (g.targetTag || '').trim().toUpperCase();
    if (!tag) continue;

    if (!resolvedMap.has(tag)) {
      resolvedMap.set(tag, g);
      activeGuidelines.push(g);
    }
    // Older entries for the same targetTag are dropped deterministically
  }

  return activeGuidelines.slice(0, 10);
}

/**
 * Calculates damped composite performance score for Top 10 Showcase (INV-STORAGE-5).
 * S = round((winRate * log10(matchesPlayed + 1)) * 1000) + elo
 * 
 * @param {number} winRate
 * @param {number} matchesPlayed
 * @param {number} elo
 * @returns {number}
 */
export function calculateCompositeScore(winRate, matchesPlayed, elo) {
  const w = Number.isFinite(winRate) ? Math.max(0, Math.min(1, winRate)) : 0.0;
  const m = Number.isFinite(matchesPlayed) ? Math.max(0, matchesPlayed) : 0;
  const e = Number.isFinite(elo) ? elo : 1200;

  return Math.round(w * Math.log10(m + 1) * 1000) + e;
}

/**
 * Ingests a new deck or updates player ranking, bounding the showcase to strictly the Top 10 (INV-STORAGE-5).
 * 
 * @param {Array<Object>} currentShowcase
 * @param {Object} candidateDeck
 * @returns {Array<Object>} Updated Top 10 showcase sorted monotonically descending.
 */
export function updateTopShowcase(currentShowcase, candidateDeck) {
  const list = Array.isArray(currentShowcase) ? [...currentShowcase] : [];
  if (!candidateDeck || typeof candidateDeck !== 'object' || !candidateDeck.id) {
    return list;
  }

  const elo = Number.isFinite(candidateDeck.elo) ? candidateDeck.elo : 1200;
  const winRate = Number.isFinite(candidateDeck.winRate) ? candidateDeck.winRate : 0.0;
  const matchesPlayed = Number.isFinite(candidateDeck.matchesPlayed) ? candidateDeck.matchesPlayed : 0;
  const compositeScore = calculateCompositeScore(winRate, matchesPlayed, elo);

  // Extract or validate preview cards (3 to 5 non-empty strings)
  let previewCards = Array.isArray(candidateDeck.previewCards)
    ? candidateDeck.previewCards.filter(c => typeof c === 'string' && c.trim().length > 0)
    : [];

  if (previewCards.length < 3 && Array.isArray(candidateDeck.mainboard)) {
    const candidateSpells = candidateDeck.mainboard
      .filter(c => c.type !== 'Land')
      .map(c => c.name);
    for (const name of candidateSpells) {
      if (!previewCards.includes(name)) {
        previewCards.push(name);
      }
      if (previewCards.length >= 4) break;
    }
  }

  if (previewCards.length < 3) {
    const defaults = ['Lightning Bolt', 'Counterspell', 'Thoughtseize', 'Birds of Paradise'];
    for (const d of defaults) {
      if (!previewCards.includes(d)) previewCards.push(d);
      if (previewCards.length >= 3) break;
    }
  }

  // Ensure previewCards is at most 5 items
  previewCards = previewCards.slice(0, 5);

  // Generate exportText if missing
  const exportText = candidateDeck.exportText || formatDeckForExport(candidateDeck, 'arena');

  const enriched = {
    ...candidateDeck,
    elo,
    winRate,
    matchesPlayed,
    compositeScore,
    previewCards,
    exportText
  };

  // Deduplicate by deck id or creatorId
  const filtered = list.filter(
    d => d.id !== enriched.id && (!enriched.creatorId || d.creatorId !== enriched.creatorId)
  );
  filtered.push(enriched);

  // Sort descending by compositeScore, secondary by winRate, tertiary by elo
  filtered.sort((a, b) => {
    if (b.compositeScore !== a.compositeScore) return b.compositeScore - a.compositeScore;
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return b.elo - a.elo;
  });

  return filtered.slice(0, 10).map((deck, idx) => ({
    ...deck,
    rank: idx + 1
  }));
}

// =============================================================================
// DeckbuilderAI Class
// =============================================================================

export class DeckbuilderAI {
  /**
   * @param {Object} [options]
   * @param {StorageAdapter} [options.storage]
   * @param {string} [options.defaultUserId='local_player']
   */
  constructor(options = {}) {
    this.storage = options.storage || new StorageAdapter(options);
    this.defaultUserId = options.defaultUserId || 'local_player';
    this._counter = 0;
    this.activeDeckSlots = {
      FREE_CONSTRUCT: 1,
      RANKED_CONSTRUCT: 1
    };
    this.validator = new DeckValidator(options);
  }

  /**
   * Validates a decklist adhering to format copy constraints and Oracle overrides (INV-DECK-1).
   * @param {Object|Array|string} deck
   * @param {Object} [options={}]
   * @returns {Object}
   */
  validateDeck(deck, options = {}) {
    return this.validator.validate(deck, options);
  }

  /**
   * Evaluates unlocked deck slot milestone progression (INV-AUDIO-6).
   * @param {Object} [profile={}]
   * @returns {Object}
   */
  getDeckSlotProgression(profile = {}) {
    const wins = profile.wins || profile.lifetimeWins || 0;
    const perks = profile.perks || profile.totalPerks || 0;
    return evaluateDeckSlots(wins, perks, 1);
  }

  /**
   * Gets current active slot for a mode (1..5).
   * @param {'FREE_CONSTRUCT'|'RANKED_CONSTRUCT'} [format='FREE_CONSTRUCT']
   * @returns {number}
   */
  getActiveSlot(format = 'FREE_CONSTRUCT') {
    const fmt = format.toUpperCase().includes('RANKED') ? 'RANKED_CONSTRUCT' : 'FREE_CONSTRUCT';
    return this.activeDeckSlots[fmt] || 1;
  }

  /**
   * Sets active slot for a mode after verifying milestone unlock progression (INV-AUDIO-6).
   * 
   * @param {number} slotNumber - 1 to 5
   * @param {Object} [profile={}]
   * @param {'FREE_CONSTRUCT'|'RANKED_CONSTRUCT'} [format='FREE_CONSTRUCT']
   * @returns {{ success: boolean, slotNumber: number, unlockedSlots: number }}
   */
  setActiveSlot(slotNumber, profile = {}, format = 'FREE_CONSTRUCT') {
    if (typeof slotNumber !== 'number' || slotNumber < 1 || slotNumber > 5) {
      throw new Error(`Invalid slot number ${slotNumber}. Must be between 1 and 5.`);
    }

    const progression = this.getDeckSlotProgression(profile);
    const unlocked = progression.unlockedSlots || 1;

    if (slotNumber > unlocked) {
      const nextMilestone = DECK_SLOT_MILESTONES.find(m => m.slot === slotNumber) || {};
      throw new Error(
        `Milestone Violation: Deck slot ${slotNumber} is locked. Requires ${nextMilestone.minWins || 0} wins or ${nextMilestone.minPerks || 0} perks (current: ${progression.currentWins} wins, ${progression.totalPerks} perks).`
      );
    }

    const fmt = format.toUpperCase().includes('RANKED') ? 'RANKED_CONSTRUCT' : 'FREE_CONSTRUCT';
    this.activeDeckSlots[fmt] = slotNumber;

    return {
      success: true,
      slotNumber,
      format: fmt,
      unlockedSlots: unlocked
    };
  }

  // ===========================================================================
  // Guideline Memory & Feedback UI Hooks (DEC-013, INV-STORAGE-1, INV-STORAGE-2)
  // ===========================================================================

  /**
   * Registers positive feedback (thumbs up 👍), creating or updating a PREFERENCE guideline.
   * 
   * @param {string} text
   * @param {string} targetTag
   * @param {number} [weight=1.0]
   * @param {string} [userId=null]
   * @param {number} [timestamp=null]
   * @returns {Array<Object>} Updated active guidelines.
   */
  addPositiveFeedback(text, targetTag, weight = 1.0, userId = null, timestamp = null) {
    return this._recordFeedback({
      text,
      targetTag,
      type: 'PREFERENCE',
      weight: Math.abs(weight || 1.0),
      userId,
      timestamp
    });
  }

  /**
   * Registers negative feedback (thumbs down 👎), creating or updating an AVOIDANCE guideline.
   * 
   * @param {string} text
   * @param {string} targetTag
   * @param {number} [weight=1.0]
   * @param {string} [userId=null]
   * @param {number} [timestamp=null]
   * @returns {Array<Object>} Updated active guidelines.
   */
  addNegativeFeedback(text, targetTag, weight = 1.0, userId = null, timestamp = null) {
    return this._recordFeedback({
      text,
      targetTag,
      type: 'AVOIDANCE',
      weight: -Math.abs(weight || 1.0),
      userId,
      timestamp
    });
  }

  /**
   * Generic guideline addition method.
   * Supports: addGuideline(userId, text, type, targetTag, weight)
   * or: addGuideline(text, type, targetTag, weight)
   */
  addGuideline(userIdOrText, textOrType, typeOrTargetTag, targetTagOrWeight, weight) {
    let uid, text, type, targetTag, w;

    if (['PREFERENCE', 'AVOIDANCE'].includes(String(textOrType).toUpperCase())) {
      // Signature: addGuideline(text, type, targetTag, weight)
      uid = this.defaultUserId;
      text = userIdOrText;
      type = String(textOrType).toUpperCase();
      targetTag = typeOrTargetTag;
      w = targetTagOrWeight;
    } else {
      // Signature: addGuideline(userId, text, type, targetTag, weight)
      uid = userIdOrText || this.defaultUserId;
      text = textOrType;
      type = String(typeOrTargetTag).toUpperCase();
      targetTag = targetTagOrWeight;
      w = weight;
    }

    if (type === 'AVOIDANCE') {
      return this.addNegativeFeedback(text, targetTag, w, uid);
    }
    return this.addPositiveFeedback(text, targetTag, w, uid);
  }

  /**
   * Internal recorder applying 10-point ring buffer FIFO eviction and conflict resolution.
   * @private
   */
  _recordFeedback({ text, targetTag, type, weight, userId, timestamp }) {
    const uid = userId || this.defaultUserId;
    const normTag = (targetTag || '').trim().toUpperCase();

    const id = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `g_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const effectiveTimestamp = Number.isFinite(timestamp)
      ? timestamp
      : Date.now() + (++this._counter);

    const guideline = {
      id,
      text: String(text || ''),
      type,
      targetTag: normTag,
      weight,
      timestamp: effectiveTimestamp
    };

    const current = this.storage.getGuidelines(uid);

    // If an existing guideline has the exact same normalized targetTag, replace it
    const existingIdx = current.findIndex(
      g => (g.targetTag || '').trim().toUpperCase() === normTag
    );

    if (existingIdx !== -1) {
      current[existingIdx] = guideline;
    } else {
      if (current.length >= 10) {
        // Drop oldest by timestamp (FIFO ring buffer)
        let oldestIdx = 0;
        for (let i = 1; i < current.length; i++) {
          if ((current[i].timestamp || 0) < (current[oldestIdx].timestamp || 0)) {
            oldestIdx = i;
          }
        }
        current.splice(oldestIdx, 1);
      }
      current.push(guideline);
    }

    this.storage.saveGuidelines(uid, current);
    return this.getActiveGuidelines(uid);
  }

  /**
   * Returns active, conflict-resolved guidelines for a user (INV-STORAGE-2).
   * @param {string} [userId]
   * @returns {Array<Object>}
   */
  getActiveGuidelines(userId = null) {
    const uid = userId || this.defaultUserId;
    const raw = this.storage.getGuidelines(uid);
    return resolveActiveGuidelines(raw);
  }

  /**
   * Directly resolves conflict array using recency precedence (INV-STORAGE-2).
   * @param {Array<Object>} guidelines
   * @returns {Array<Object>}
   */
  resolveConflicts(guidelines) {
    return resolveActiveGuidelines(guidelines);
  }

  // ===========================================================================
  // Mode A: Offline Archetype & Beginner Synthesis (INV-STORAGE-3, INV-STORAGE-4)
  // ===========================================================================

  /**
   * Returns the 5 precompiled Modern tournament starter archetypes.
   * @returns {Array<Object>}
   */
  getPrecompiledArchetypes() {
    return JSON.parse(JSON.stringify(PRECOMPILED_ARCHETYPES));
  }

  /**
   * Synthesizes an introductory single-color 60-card deck with strict mana curve (INV-STORAGE-4).
   * Lands in [22, 24], 1-CMC >= 8, 2-CMC >= 10, max non-land copies <= 4.
   * 
   * @param {'W'|'U'|'B'|'R'|'G'} color
   * @returns {Object} DeckGenerationResult
   */
  generateBeginnerDeck(color) {
    const startTime = Date.now();
    const c = (color || 'W').toUpperCase();
    const template = BEGINNER_DECKS[c] || BEGINNER_DECKS.W;

    const deck = JSON.parse(JSON.stringify(template));
    deck.id = `beginner_${c.toLowerCase()}_${Date.now()}`;
    deck.totalCards = deck.mainboard.reduce((acc, card) => acc + card.count, 0);
    deck.exportText = formatDeckForExport(deck, 'arena');

    return {
      success: true,
      source: 'OFFLINE_FAST_PATH',
      executionTimeMs: Math.max(1, Date.now() - startTime),
      deck,
      warnings: []
    };
  }

  /**
   * Matches candidate starter archetypes against active user guidelines.
   * Disqualifies any archetype with tags in active AVOIDANCES.
   * Rewards archetypes matching active PREFERENCES.
   * 
   * @param {Array<Object>} [userGuidelines]
   * @param {string} [requestedColor]
   * @returns {Object} Best matched archetype deck
   */
  matchStarterArchetype(userGuidelines = [], requestedColor = null) {
    const starters = this.getPrecompiledArchetypes();
    const active = resolveActiveGuidelines(userGuidelines);

    const avoidTags = new Set(
      active.filter(g => g.type === 'AVOIDANCE').map(g => (g.targetTag || '').toUpperCase())
    );

    const scored = starters.map(arch => {
      let isDisqualified = false;

      // Check avoidances against archetype tags and colors
      for (const t of arch.tags) {
        if (avoidTags.has(t.toUpperCase())) {
          isDisqualified = true;
          break;
        }
      }
      for (const col of arch.colorIdentity) {
        if (avoidTags.has(`COLOR_${col}`.toUpperCase())) {
          isDisqualified = true;
          break;
        }
      }

      let score = 0;
      if (isDisqualified) {
        score = -999999;
      } else {
        // Preference score
        for (const g of active) {
          if (g.type === 'PREFERENCE') {
            const tag = (g.targetTag || '').toUpperCase();
            if (arch.tags.map(t => t.toUpperCase()).includes(tag)) {
              score += Math.abs(g.weight || 1.0) * 10;
            }
            if (arch.colorIdentity.some(col => `COLOR_${col}`.toUpperCase() === tag)) {
              score += Math.abs(g.weight || 1.0) * 5;
            }
          }
        }

        // Color preference match
        if (requestedColor && arch.colorIdentity.includes(requestedColor.toUpperCase())) {
          score += 15;
        }
      }

      return { arch, score, isDisqualified };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Pick top scoring that is not disqualified
    const qualified = scored.filter(s => !s.isDisqualified);
    const chosen = qualified.length > 0 ? qualified[0].arch : scored[0].arch;

    chosen.exportText = formatDeckForExport(chosen, 'arena');
    return chosen;
  }

  // ===========================================================================
  // Dual-Mode Generator Bridge (INV-STORAGE-3)
  // ===========================================================================

  /**
   * Generates a 60-card Modern deck using the Dual-Mode architecture (INV-STORAGE-3).
   * Mode A: Sub-5ms deterministic generator.
   * Mode B: Online LLM synthesizer with 4000ms SLA, gracefully degrading to Mode A on error or timeout.
   * 
   * @param {Object} [request={}]
   * @returns {Promise<Object>} DeckGenerationResult
   */
  async generateDeck(request = {}) {
    const startTime = Date.now();
    const uid = request.userId || this.defaultUserId;
    const guidelines = request.guidelines || this.getActiveGuidelines(uid);

    // 1. Beginner Single-Color Request Fast Path
    if (request.beginner === true || request.format === 'beginner') {
      const color = request.color || 'W';
      return this.generateBeginnerDeck(color);
    }

    // 2. Mode B: Online LLM Synthesizer Bridge (if requested & endpoint provided)
    if (request.allowLLM && request.endpoint) {
      const timeoutMs = request.timeoutMs || 4000;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const promptPayload = this._buildPromptPayload({ ...request, guidelines });

        let response;
        try {
          response = await fetch(request.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {})
            },
            body: JSON.stringify(promptPayload),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          throw new Error(`LLM endpoint returned status code ${response.status}`);
        }

        const rawData = await response.json();
        const validatedDeck = this._validateAndNormalizeLLMDeck(rawData, guidelines);

        return {
          success: true,
          source: 'ONLINE_LLM',
          executionTimeMs: Date.now() - startTime,
          deck: validatedDeck,
          warnings: []
        };
      } catch (err) {
        // Graceful degradation to Mode A (INV-STORAGE-3)
        const fallbackDeck = this.matchStarterArchetype(guidelines, request.color);
        return {
          success: true,
          source: 'OFFLINE_FALLBACK',
          executionTimeMs: Date.now() - startTime,
          deck: fallbackDeck,
          warnings: [`Mode B degraded to Mode A: ${err.message}`]
        };
      }
    }

    // 3. Mode A: Offline Archetype Matching Fast Path
    const matchedDeck = this.matchStarterArchetype(guidelines, request.color);
    return {
      success: true,
      source: 'OFFLINE_FAST_PATH',
      executionTimeMs: Math.max(1, Date.now() - startTime),
      deck: matchedDeck,
      warnings: []
    };
  }

  /**
   * Constructs prompt payload for Mode B LLM synthesizer.
   * @private
   */
  _buildPromptPayload(request) {
    const preferences = (request.guidelines || [])
      .filter(g => g.type === 'PREFERENCE')
      .map(g => g.text || g.targetTag);

    const avoidances = (request.guidelines || [])
      .filter(g => g.type === 'AVOIDANCE')
      .map(g => g.text || g.targetTag);

    return {
      model: request.model || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are the RPM Tabletop Modern Deckbuilder Agent.\nGenerate a tournament-legal 60-card Magic: The Gathering Modern decklist.\nPreferences: ${preferences.join(', ') || 'None'}\nAvoidances (ABSOLUTE BLACKLIST): ${avoidances.join(', ') || 'None'}\nFormat: Modern. Output pure JSON only conforming to the schema.`
        },
        {
          role: 'user',
          content: `Build a 60-card Modern deck matching my guidelines.`
        }
      ]
    };
  }

  /**
   * Validates and normalizes raw deck response from LLM (INV-STORAGE-3).
   * @private
   */
  _validateAndNormalizeLLMDeck(data, activeGuidelines = []) {
    let payload = data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (e) {
        throw new Error('LLM response is not valid JSON string');
      }
    }

    // Handle standard LLM wrapped responses
    if (payload.choices && payload.choices[0] && payload.choices[0].message) {
      let content = payload.choices[0].message.content || '';
      content = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      payload = JSON.parse(content);
    } else if (payload.content && typeof payload.content === 'string') {
      let content = payload.content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      payload = JSON.parse(content);
    }

    if (!payload || !Array.isArray(payload.mainboard)) {
      throw new Error('LLM payload missing mainboard array');
    }

    const mainboard = payload.mainboard;
    const totalCards = mainboard.reduce((acc, c) => acc + (Number(c.count) || 0), 0);

    if (totalCards !== 60) {
      throw new Error(`Schema Violation: Deck has ${totalCards} cards; must have exactly 60 cards`);
    }

    // Check 4-of limit
    const basicLands = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'];
    for (const c of mainboard) {
      if (!basicLands.includes(c.name) && c.count > 4) {
        throw new Error(`Card copy limit violation: ${c.name} has ${c.count} copies (max 4)`);
      }
    }

    // Check active avoidances
    const avoidTags = new Set(
      activeGuidelines.filter(g => g.type === 'AVOIDANCE').map(g => (g.targetTag || '').toUpperCase())
    );

    if (avoidTags.size > 0 && Array.isArray(payload.colors)) {
      for (const col of payload.colors) {
        if (avoidTags.has(`COLOR_${col}`.toUpperCase())) {
          throw new Error(`Deck contains blacklisted color: COLOR_${col}`);
        }
      }
    }

    payload.totalCards = 60;
    payload.exportText = formatDeckForExport(payload, 'arena');
    return payload;
  }

  // ===========================================================================
  // Top 10 Public Showcase Subsystem (INV-STORAGE-5, Audio Note 9)
  // ===========================================================================

  /**
   * Updates and returns the Top 10 public showcase.
   * @param {Object} [candidateDeck=null]
   * @returns {Promise<Array<Object>>}
   */
  async updateShowcase(candidateDeck = null) {
    const current = await this.storage.getTopShowcase();
    if (!candidateDeck) {
      return current;
    }

    const updated = updateTopShowcase(current, candidateDeck);
    await this.storage.saveTopShowcase(updated);
    return updated;
  }

  /**
   * Retrieves the Top 10 public showcase.
   * @returns {Promise<Array<Object>>}
   */
  async getTopShowcase() {
    return this.storage.getTopShowcase();
  }

  /**
   * Formats deck export text.
   * @param {Object} deck
   * @param {'arena'|'mtgo'|'text'} [format='arena']
   * @returns {string}
   */
  formatDeckForExport(deck, format = 'arena') {
    return formatDeckForExport(deck, format);
  }
}

export default DeckbuilderAI;
