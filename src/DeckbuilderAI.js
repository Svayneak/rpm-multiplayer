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
