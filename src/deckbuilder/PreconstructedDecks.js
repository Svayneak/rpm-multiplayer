/**
 * src/deckbuilder/PreconstructedDecks.js
 * 5 Tournament-Grade Starter Archetypes + American Gadgets Beta Deck (INV-ARCH-HEADLESS compliant).
 */

function parseDecklistLines(decklistText) {
  const lines = (decklistText || '').split('\n').map(l => l.trim()).filter(Boolean);
  const cards = [];
  for (const line of lines) {
    if (line.toLowerCase().startsWith('sideboard')) break;
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (match) {
      const count = parseInt(match[1], 10) || 1;
      const name = match[2].trim();
      cards.push({ count, name });
    }
  }
  return cards;
}

export const PRECONSTRUCTED_STARTER_DECKS = [
  {
    id: 'STARTER_MONO_BLACK',
    name: 'Mono-Black Midrange',
    archetype: 'Midrange / Hand Disruption & Removal',
    colors: ['B'],
    badge: '🟢 100% Supported',
    totalCards: 60,
    decklistText: `4 Fatal Push
4 Thoughtseize
4 Gifted Aetherborn
4 Nighthawk Scavenger
4 Sign in Blood
4 Go for the Throat
4 Gray Merchant of Asphodel
4 Murderous Rider
4 Castle Locthwain
24 Swamp`
  },
  {
    id: 'STARTER_BOROS_BURN',
    name: 'Boros / Mono-Red Burn',
    archetype: 'Aggro / Direct Damage',
    colors: ['R', 'W'],
    badge: '🟢 100% Supported',
    totalCards: 60,
    decklistText: `4 Goblin Guide
4 Monastery Swiftspear
4 Lightning Bolt
4 Lava Spike
4 Boros Charm
4 Searing Blaze
4 Skewer the Critics
4 Rift Bolt
4 Eidolon of the Great Revel
4 Sacred Foundry
4 Inspiring Vantage
16 Mountain`
  },
  {
    id: 'STARTER_AZORIUS_CONTROL',
    name: 'Azorius Control',
    archetype: 'Control / Counterspells & Board Wipes',
    colors: ['W', 'U'],
    badge: '🟢 100% Supported',
    totalCards: 60,
    decklistText: `4 Counterspell
4 Opt
4 Consider
4 Path to Exile
4 Supreme Verdict
4 Archmage's Charm
4 Brazen Borrower
4 Celestial Colonnade
4 Hallowed Fountain
4 Glacial Fortress
10 Island
10 Plains`
  },
  {
    id: 'STARTER_MONO_GREEN_STOMPY',
    name: 'Mono-Green Stompy',
    archetype: 'Aggro-Midrange / High Power Creatures',
    colors: ['G'],
    badge: '🟢 100% Supported',
    totalCards: 60,
    decklistText: `4 Llanowar Elves
4 Strangleroot Geist
4 Leatherback Baloth
4 Steel Leaf Champion
4 Garruk's Harbinger
4 Aspect of Hydra
4 Vines of Vastwood
4 Rancor
4 Dismember
24 Forest`
  },
  {
    id: 'STARTER_WHITE_WEENIE',
    name: 'White Weenie',
    archetype: 'Aggro / Go-Wide & Anthem Tax',
    colors: ['W'],
    badge: '🟢 100% Supported',
    totalCards: 60,
    decklistText: `4 Dauntless Bodyguard
4 Soldier of the Pantheon
4 Thalia, Guardian of Thraben
4 Luminarch Aspirant
4 Benalish Marshal
4 Brave the Elements
4 Path to Exile
4 Honor of the Pure
4 Mutavault
24 Plains`
  },
  {
    id: 'BETA_AMERICAN_GADGETS',
    name: 'American Gadgets (Beta Tester — Advanced)',
    archetype: 'Combo-Aggro / Hammer Time & Equipment',
    colors: ['W', 'U', 'R'],
    badge: '🧪 Beta Tester Deck',
    isBetaTester: true,
    companion: 'Jegantha, the Wellspring',
    totalCards: 60,
    decklistText: `4 Heartfire Hero
4 Fervent Champion
4 Goblin Gaveleer
4 Colossus Hammer
4 Sigarda's Aid
4 Stolen Uniform
4 Callous Sell-Sword // Burn Together
2 Belt of Giant Strength
2 Leyline Axe
2 Forge Anew
2 Resolute Strike
2 Surge of Salvation
2 Invasion of Gobakhan
4 Inkmoth Nexus
4 Hallowed Fountain
4 Steam Vents
4 Spire of Industry
4 Mana Confluence`
  }
];

for (const deck of PRECONSTRUCTED_STARTER_DECKS) {
  deck.cards = parseDecklistLines(deck.decklistText);
  deck.mainboard = deck.cards;
}

export function getPreconstructedDeckById(id) {
  if (!id) return null;
  const norm = String(id).trim().toUpperCase();
  return PRECONSTRUCTED_STARTER_DECKS.find(
    d => d.id.toUpperCase() === norm || d.name.toUpperCase() === norm
  ) || null;
}
