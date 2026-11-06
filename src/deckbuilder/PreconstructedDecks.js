/**
 * src/deckbuilder/PreconstructedDecks.js
 * 5 Tournament-Grade Starter Archetypes + American Gadgets Beta Deck (INV-ARCH-HEADLESS compliant).
 */

import { groundDeckForEngine } from '../OracleEffectCompiler.js';

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
    name: 'Mono-White Tokens',
    archetype: 'Aggro-Go-Wide / Anthems, Tokens & Ascend',
    colors: ['W'],
    badge: '🟢 100% Certified',
    totalCards: 61,
    decklistText: `17 Plains
4 Castle Ardenvale
3 Brave the Elements
4 Path to Exile
3 Ocelot Pride
3 Secure the Wastes
3 Soul Warden
4 Raise the Alarm
4 Honor of the Pure
2 Gather the Townsfolk
4 Intangible Virtue
3 Wedding Announcement // Wedding Festivity
2 Caretaker's Talent
3 Hero of Bladehold
2 Leyline of Sanctity`
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
4 Belt of Giant Strength
4 Leyline Axe
2 Forge Anew
1 Resolute Strike
1 Doc Ock's Tentacles
4 Inkmoth Nexus
4 Mana Confluence
4 Starting Town
4 Spire of Industry
1 Hallowed Fountain
1 Steam Vents
1 Plains
1 Mountain`
  }
];

export const PRECON_CARD_METADATA = {
  "castle ardenvale": {
    name: "Castle Ardenvale",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: "Castle Ardenvale enters the battlefield tapped unless you control a Plains.\n{T}: Add {W}.\n{2}{W}{W}, {T}: Create a 1/1 white Human creature token.",
    power: null,
    toughness: null,
    colors: []
  },
  "ocelot pride": {
    name: "Ocelot Pride",
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Creature — Cat',
    oracleText: "First strike, lifelink\nAscend\nAt the beginning of your end step, if you gained life this turn, create a 1/1 white Cat creature token. Then if you have the city's blessing, for each token you control, create a token that's a copy of that token.",
    power: 1,
    toughness: 1,
    colors: ['W'],
    keywords: ['First strike', 'Lifelink', 'Ascend']
  },
  "secure the wastes": {
    name: "Secure the Wastes",
    manaCost: '{X}{W}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: 'Create X 1/1 white Warrior creature tokens.',
    power: null,
    toughness: null,
    colors: ['W']
  },
  "soul warden": {
    name: "Soul Warden",
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Creature — Human Cleric',
    oracleText: 'Whenever another creature enters the battlefield, you gain 1 life.',
    power: 1,
    toughness: 1,
    colors: ['W']
  },
  "raise the alarm": {
    name: "Raise the Alarm",
    manaCost: '{1}{W}',
    cmc: 2,
    typeLine: 'Instant',
    oracleText: 'Create two 1/1 white Soldier creature tokens.',
    power: null,
    toughness: null,
    colors: ['W']
  },
  "gather the townsfolk": {
    name: "Gather the Townsfolk",
    manaCost: '{1}{W}',
    cmc: 2,
    typeLine: 'Sorcery',
    oracleText: 'Create two 1/1 white Human creature tokens.\nFateful hour — If you have 5 or less life, create five of those tokens instead.',
    power: null,
    toughness: null,
    colors: ['W']
  },
  "intangible virtue": {
    name: "Intangible Virtue",
    manaCost: '{1}{W}',
    cmc: 2,
    typeLine: 'Enchantment',
    oracleText: 'Creature tokens you control get +1/+1 and have vigilance.',
    power: null,
    toughness: null,
    colors: ['W']
  },
  "wedding announcement // wedding festivity": {
    name: "Wedding Announcement // Wedding Festivity",
    manaCost: '{2}{W}',
    cmc: 3,
    typeLine: 'Enchantment // Enchantment',
    oracleText: 'At the beginning of your end step, put an invitation counter on Wedding Announcement. If you attacked with two or more creatures this turn, draw a card. Otherwise, create a 1/1 white Human creature token. Then if Wedding Announcement has three or more invitation counters on it, transform it.',
    power: null,
    toughness: null,
    colors: ['W']
  },
  "wedding announcement": {
    name: "Wedding Announcement // Wedding Festivity",
    manaCost: '{2}{W}',
    cmc: 3,
    typeLine: 'Enchantment // Enchantment',
    oracleText: 'At the beginning of your end step, put an invitation counter on Wedding Announcement. If you attacked with two or more creatures this turn, draw a card. Otherwise, create a 1/1 white Human creature token. Then if Wedding Announcement has three or more invitation counters on it, transform it.',
    power: null,
    toughness: null,
    colors: ['W']
  },
  "caretaker's talent": {
    name: "Caretaker's Talent",
    manaCost: '{2}{W}',
    cmc: 3,
    typeLine: 'Enchantment — Class',
    oracleText: "Whenever one or more tokens enter the battlefield under your control, draw a card. This ability triggers only once each turn.\n{W}: Level 2\nWhen this Class becomes level 2, create a token that's a copy of a token you control.\n{3}{W}: Level 3\nCreature tokens you control get +2/+2.",
    power: null,
    toughness: null,
    colors: ['W']
  },
  "hero of bladehold": {
    name: "Hero of Bladehold",
    manaCost: '{2}{W}{W}',
    cmc: 4,
    typeLine: 'Creature — Human Knight',
    oracleText: 'Battle cry\nWhenever Hero of Bladehold attacks, create two 1/1 white Soldier creature tokens tapped and attacking.',
    power: 3,
    toughness: 4,
    colors: ['W'],
    keywords: ['Battle cry']
  },
  "leyline of sanctity": {
    name: "Leyline of Sanctity",
    manaCost: '{2}{W}{W}',
    cmc: 4,
    typeLine: 'Enchantment',
    oracleText: 'If Leyline of Sanctity is in your opening hand, you may begin the game with it on the battlefield.\nYou have hexproof.',
    power: null,
    toughness: null,
    colors: ['W'],
    keywords: ['Hexproof']
  },
  "archmage's charm": {
    name: "Archmage's Charm",
    manaCost: '{U}{U}{U}',
    cmc: 3,
    typeLine: 'Instant',
    oracleText: 'Choose one —\n• Counter target spell.\n• Target player draws two cards.\n• Gain control of target nonland permanent with mana value 1 or less.',
    power: null,
    toughness: null,
    colors: ['U']
  },
  "aspect of hydra": {
    name: "Aspect of Hydra",
    manaCost: '{G}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: 'Target creature gets +X/+X until end of turn, where X is your devotion to green.',
    power: null,
    toughness: null,
    colors: ['G']
  },
  "belt of giant strength": {
    name: "Belt of Giant Strength",
    manaCost: '{1}{G}',
    cmc: 2,
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature has base power and toughness 10/10.\nEquip {10}. This ability costs {X} less to activate, where X is the greatest power among creatures you control.',
    power: null,
    toughness: null,
    colors: ['G']
  },
  "benalish marshal": {
    name: "Benalish Marshal",
    manaCost: '{W}{W}{W}',
    cmc: 3,
    typeLine: 'Creature — Human Knight',
    oracleText: 'Other creatures you control get +1/+1.',
    power: 3,
    toughness: 3,
    colors: ['W']
  },
  "boros charm": {
    name: "Boros Charm",
    manaCost: '{R}{W}',
    cmc: 2,
    typeLine: 'Instant',
    oracleText: 'Choose one —\n• Boros Charm deals 4 damage to target player or planeswalker.\n• Permanents you control gain indestructible until end of turn.\n• Target creature gains double strike until end of turn.',
    power: null,
    toughness: null,
    colors: ['R', 'W']
  },
  "brave the elements": {
    name: "Brave the Elements",
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: 'Choose a color. White creatures you control gain protection from the chosen color until end of turn.',
    power: null,
    toughness: null,
    colors: ['W']
  },
  "brazen borrower": {
    name: "Brazen Borrower",
    manaCost: '{1}{U}{U}',
    cmc: 3,
    typeLine: 'Creature — Faerie Rogue // Instant — Adventure',
    oracleText: "Flash\nFlying\nBrazen Borrower can block only creatures with flying.\n// Petty Theft {1}{U} Instant — Adventure: Return target nonland permanent an opponent controls to its owner's hand.",
    power: 3,
    toughness: 1,
    colors: ['U']
  },
  "callous sell-sword // burn together": {
    name: "Callous Sell-Sword // Burn Together",
    manaCost: '{1}{B} // {R}',
    cmc: 2,
    typeLine: 'Creature — Human Soldier // Sorcery — Adventure',
    oracleText: 'Callous Sell-Sword enters the battlefield with a +1/+1 counter on it for each creature that died under your control this turn.\n// Burn Together {R} Sorcery — Adventure: Target creature you control deals damage equal to its power to any other target. Then sacrifice it.',
    power: 2,
    toughness: 2,
    colors: ['B', 'R']
  },
  "castle locthwain": {
    name: "Castle Locthwain",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: 'Castle Locthwain enters the battlefield tapped unless you control a Swamp.\n{T}: Add {B}.\n{1}{B}{B}, {T}: Draw a card, then you lose life equal to the number of cards in your hand.',
    power: null,
    toughness: null,
    colors: []
  },
  "celestial colonnade": {
    name: "Celestial Colonnade",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: "Celestial Colonnade enters the battlefield tapped.\n{T}: Add {W} or {U}.\n{3}{W}{U}: Until end of turn, Celestial Colonnade becomes a 4/4 white and blue Elemental creature with flying and vigilance. It's still a land.",
    power: null,
    toughness: null,
    colors: []
  },
  "colossus hammer": {
    name: "Colossus Hammer",
    manaCost: '{1}',
    cmc: 1,
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}',
    power: null,
    toughness: null,
    colors: []
  },
  "consider": {
    name: "Consider",
    manaCost: '{U}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: 'Surveil 1.\nDraw a card.',
    power: null,
    toughness: null,
    colors: ['U']
  },
  "counterspell": {
    name: "Counterspell",
    manaCost: '{U}{U}',
    cmc: 2,
    typeLine: 'Instant',
    oracleText: 'Counter target spell.',
    power: null,
    toughness: null,
    colors: ['U']
  },
  "dauntless bodyguard": {
    name: "Dauntless Bodyguard",
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Creature — Human Knight',
    oracleText: 'As Dauntless Bodyguard enters the battlefield, choose another creature you control.\nSacrifice Dauntless Bodyguard: The chosen creature gains indestructible until end of turn.',
    power: 2,
    toughness: 1,
    colors: ['W']
  },
  "dismember": {
    name: "Dismember",
    manaCost: '{1}{B/P}{B/P}',
    cmc: 3,
    typeLine: 'Instant',
    oracleText: 'Target creature gets -5/-5 until end of turn.',
    power: null,
    toughness: null,
    colors: ['B']
  },
  "doc ock's tentacles": {
    name: "Doc Ock's Tentacles",
    manaCost: '{2}',
    cmc: 2,
    typeLine: 'Artifact — Equipment',
    oracleText: "Equipped creature gets +4/+4.\nWhenever a creature with mana value 5 or greater enters the battlefield under your control, you may attach Doc Ock's Tentacles to it.\nEquip {5}",
    power: null,
    toughness: null,
    colors: []
  },
  "eidolon of the great revel": {
    name: "Eidolon of the Great Revel",
    manaCost: '{R}{R}',
    cmc: 2,
    typeLine: 'Enchantment Creature — Spirit',
    oracleText: 'Whenever a player casts a spell with mana value 3 or less, Eidolon of the Great Revel deals 2 damage to that player.',
    power: 2,
    toughness: 2,
    colors: ['R']
  },
  "fatal push": {
    name: "Fatal Push",
    manaCost: '{B}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: "Destroy target creature if it has mana value 2 or less.\nRevolt — Destroy that creature if it has mana value 4 or less instead if a permanent you controlled left the battlefield this turn.",
    power: null,
    toughness: null,
    colors: ['B']
  },
  "fervent champion": {
    name: "Fervent Champion",
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Creature — Human Knight',
    oracleText: 'First strike, haste\nWhenever Fervent Champion attacks, another target attacking Knight you control gets +1/+0 until end of turn.\nEquip abilities you activate that target Fervent Champion cost {3} less to activate.',
    power: 1,
    toughness: 1,
    colors: ['R']
  },
  "forest": {
    name: "Forest",
    manaCost: '',
    cmc: 0,
    typeLine: 'Basic Land — Forest',
    oracleText: '({T}: Add {G}.)',
    power: null,
    toughness: null,
    colors: []
  },
  "forge anew": {
    name: "Forge Anew",
    manaCost: '{2}{W}',
    cmc: 3,
    typeLine: 'Enchantment',
    oracleText: "When Forge Anew enters the battlefield, you may return target Equipment card from your graveyard to the battlefield.\nAs long as it's your turn, you may activate equip abilities any time you could cast an instant.\nYou may pay {0} rather than pay the equip cost of the first equip ability you activate each turn.",
    power: null,
    toughness: null,
    colors: ['W']
  },
  "garruk's harbinger": {
    name: "Garruk's Harbinger",
    manaCost: '{1}{G}{G}',
    cmc: 3,
    typeLine: 'Creature — Beast',
    oracleText: 'Hexproof from black\nWhenever Garruk\'s Harbinger deals combat damage to a player or planeswalker, look at that many cards from the top of your library. You may reveal a creature card or Garruk planeswalker card from among them and put it into your hand. Put the rest on the bottom of your library in a random order.',
    power: 4,
    toughness: 3,
    colors: ['G']
  },
  "gifted aetherborn": {
    name: "Gifted Aetherborn",
    manaCost: '{B}{B}',
    cmc: 2,
    typeLine: 'Creature — Aetherborn Vampire',
    oracleText: 'Deathtouch, lifelink',
    power: 2,
    toughness: 3,
    colors: ['B']
  },
  "glacial fortress": {
    name: "Glacial Fortress",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: 'Glacial Fortress enters the battlefield tapped unless you control a Plains or an Island.\n{T}: Add {W} or {U}.',
    power: null,
    toughness: null,
    colors: []
  },
  "go for the throat": {
    name: "Go for the Throat",
    manaCost: '{1}{B}',
    cmc: 2,
    typeLine: 'Instant',
    oracleText: 'Destroy target nonartifact creature.',
    power: null,
    toughness: null,
    colors: ['B']
  },
  "goblin gaveleer": {
    name: "Goblin Gaveleer",
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Creature — Goblin Warrior',
    oracleText: 'Trample\nGoblin Gaveleer gets +2/+0 for each Equipment attached to it.',
    power: 1,
    toughness: 1,
    colors: ['R']
  },
  "goblin guide": {
    name: "Goblin Guide",
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Creature — Goblin Scout',
    oracleText: "Haste\nWhenever Goblin Guide attacks, defending player reveals the top card of their library. If it's a land card, that player puts it into their hand.",
    power: 2,
    toughness: 2,
    colors: ['R']
  },
  "gray merchant of asphodel": {
    name: "Gray Merchant of Asphodel",
    manaCost: '{3}{B}{B}',
    cmc: 5,
    typeLine: 'Creature — Zombie',
    oracleText: 'When Gray Merchant of Asphodel enters the battlefield, each opponent loses X life, where X is your devotion to black. You gain life equal to the life lost this way.',
    power: 2,
    toughness: 4,
    colors: ['B']
  },
  "hallowed fountain": {
    name: "Hallowed Fountain",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land — Plains Island',
    oracleText: "({T}: Add {W} or {U}.)\nAs Hallowed Fountain enters the battlefield, you may pay 2 life. If you don't, it enters the battlefield tapped.",
    power: null,
    toughness: null,
    colors: []
  },
  "heartfire hero": {
    name: "Heartfire Hero",
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Creature — Mouse Soldier',
    oracleText: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.',
    power: 1,
    toughness: 1,
    colors: ['R']
  },
  "honor of the pure": {
    name: "Honor of the Pure",
    manaCost: '{1}{W}',
    cmc: 2,
    typeLine: 'Enchantment',
    oracleText: 'White creatures you control get +1/+1.',
    power: null,
    toughness: null,
    colors: ['W']
  },
  "inkmoth nexus": {
    name: "Inkmoth Nexus",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: "{T}: Add {C}.\n{1}: Inkmoth Nexus becomes a 1/1 Blinkmoth artifact creature with flying and infect until end of turn. It's still a land.",
    power: null,
    toughness: null,
    colors: []
  },
  "inspiring vantage": {
    name: "Inspiring Vantage",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: 'Inspiring Vantage enters the battlefield tapped unless you control two or fewer other lands.\n{T}: Add {R} or {W}.',
    power: null,
    toughness: null,
    colors: []
  },
  "invasion of gobakhan": {
    name: "Invasion of Gobakhan",
    manaCost: '{1}{W}',
    cmc: 2,
    typeLine: 'Battle — Siege',
    oracleText: 'When Invasion of Gobakhan enters the battlefield, target opponent reveals their hand. You may exile a nonland card from it. For as long as that card remains exiled, its owner may play it. A spell cast this way costs {2} more to cast.',
    power: null,
    toughness: null,
    colors: ['W']
  },
  "island": {
    name: "Island",
    manaCost: '',
    cmc: 0,
    typeLine: 'Basic Land — Island',
    oracleText: '({T}: Add {U}.)',
    power: null,
    toughness: null,
    colors: []
  },
  "lava spike": {
    name: "Lava Spike",
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Sorcery — Arcane',
    oracleText: 'Lava Spike deals 3 damage to target player or planeswalker.',
    power: null,
    toughness: null,
    colors: ['R']
  },
  "leatherback baloth": {
    name: "Leatherback Baloth",
    manaCost: '{G}{G}{G}',
    cmc: 3,
    typeLine: 'Creature — Beast',
    oracleText: '',
    power: 4,
    toughness: 5,
    colors: ['G']
  },
  "leyline axe": {
    name: "Leyline Axe",
    manaCost: '{2}',
    cmc: 2,
    typeLine: 'Artifact — Equipment',
    oracleText: 'If Leyline Axe is in your opening hand, you may begin the game with it on the battlefield.\nEquipped creature gets +1/+1 and has double strike and trample.\nEquip {3}',
    power: null,
    toughness: null,
    colors: []
  },
  "lightning bolt": {
    name: "Lightning Bolt",
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: 'Lightning Bolt deals 3 damage to any target.',
    power: null,
    toughness: null,
    colors: ['R']
  },
  "llanowar elves": {
    name: "Llanowar Elves",
    manaCost: '{G}',
    cmc: 1,
    typeLine: 'Creature — Elf Druid',
    oracleText: '{T}: Add {G}.',
    power: 1,
    toughness: 1,
    colors: ['G']
  },
  "luminarch aspirant": {
    name: "Luminarch Aspirant",
    manaCost: '{1}{W}',
    cmc: 2,
    typeLine: 'Creature — Human Cleric',
    oracleText: 'At the beginning of combat on your turn, put a +1/+1 counter on target creature you control.',
    power: 1,
    toughness: 1,
    colors: ['W']
  },
  "mana confluence": {
    name: "Mana Confluence",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: '{T}, Pay 1 life: Add one mana of any color.',
    power: null,
    toughness: null,
    colors: []
  },
  "monastery swiftspear": {
    name: "Monastery Swiftspear",
    manaCost: '{R}',
    cmc: 1,
    typeLine: 'Creature — Human Monk',
    oracleText: 'Haste\nProwess',
    power: 1,
    toughness: 2,
    colors: ['R']
  },
  "mountain": {
    name: "Mountain",
    manaCost: '',
    cmc: 0,
    typeLine: 'Basic Land — Mountain',
    oracleText: '({T}: Add {R}.)',
    power: null,
    toughness: null,
    colors: []
  },
  "murderous rider": {
    name: "Murderous Rider",
    manaCost: '{1}{B}{B} // {1}{B}{B}',
    cmc: 3,
    typeLine: 'Creature — Zombie Knight // Instant — Adventure',
    oracleText: "Lifelink\nWhen Murderous Rider dies, put it on the bottom of its owner's library.\n// Swift End {1}{B}{B} Instant — Adventure: Destroy target creature or planeswalker. You lose 2 life.",
    power: 2,
    toughness: 3,
    colors: ['B']
  },
  "mutavault": {
    name: "Mutavault",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: "{T}: Add {C}.\n{1}: Mutavault becomes a 2/2 creature with all creature types until end of turn. It's still a land.",
    power: null,
    toughness: null,
    colors: []
  },
  "nighthawk scavenger": {
    name: "Nighthawk Scavenger",
    manaCost: '{1}{B}{B}',
    cmc: 3,
    typeLine: 'Creature — Vampire Nighthawk Rogue',
    oracleText: "Flying, deathtouch, lifelink\nNighthawk Scavenger's power is equal to 1 plus the number of card types among cards in your opponents' graveyards.",
    power: 1,
    toughness: 3,
    colors: ['B']
  },
  "opt": {
    name: "Opt",
    manaCost: '{U}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: 'Scry 1.\nDraw a card.',
    power: null,
    toughness: null,
    colors: ['U']
  },
  "path to exile": {
    name: "Path to Exile",
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: 'Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
    power: null,
    toughness: null,
    colors: ['W']
  },
  "plains": {
    name: "Plains",
    manaCost: '',
    cmc: 0,
    typeLine: 'Basic Land — Plains',
    oracleText: '({T}: Add {W}.)',
    power: null,
    toughness: null,
    colors: []
  },
  "rancor": {
    name: "Rancor",
    manaCost: '{G}',
    cmc: 1,
    typeLine: 'Enchantment — Aura',
    oracleText: "Enchant creature\nEnchanted creature gets +2/+0 and has trample.\nWhen Rancor is put into a graveyard from the battlefield, return Rancor to its owner's hand.",
    power: null,
    toughness: null,
    colors: ['G']
  },
  "resolute strike": {
    name: "Resolute Strike",
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: "Target creature gets +2/+2 until end of turn. If it's a Warrior, you may attach an Equipment you control to it.",
    power: null,
    toughness: null,
    colors: ['W']
  },
  "rift bolt": {
    name: "Rift Bolt",
    manaCost: '{1}{R}',
    cmc: 2,
    typeLine: 'Sorcery',
    oracleText: 'Rift Bolt deals 3 damage to any target.\nSuspend 1—{R}',
    power: null,
    toughness: null,
    colors: ['R']
  },
  "sacred foundry": {
    name: "Sacred Foundry",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land — Mountain Plains',
    oracleText: "({T}: Add {R} or {W}.)\nAs Sacred Foundry enters the battlefield, you may pay 2 life. If you don't, it enters the battlefield tapped.",
    power: null,
    toughness: null,
    colors: []
  },
  "searing blaze": {
    name: "Searing Blaze",
    manaCost: '{R}{R}',
    cmc: 2,
    typeLine: 'Instant',
    oracleText: 'Searing Blaze deals 1 damage to target player and 1 damage to target creature that player controls.\nLandfall — If you had a land enter the battlefield under your control this turn, Searing Blaze deals 3 damage to that player and 3 damage to that creature instead.',
    power: null,
    toughness: null,
    colors: ['R']
  },
  "sigarda's aid": {
    name: "Sigarda's Aid",
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Enchantment',
    oracleText: 'You may cast Aura and Equipment spells as though they had flash.\nWhenever an Equipment enters the battlefield under your control, you may attach it to target creature you control.',
    power: null,
    toughness: null,
    colors: ['W']
  },
  "sign in blood": {
    name: "Sign in Blood",
    manaCost: '{B}{B}',
    cmc: 2,
    typeLine: 'Sorcery',
    oracleText: 'Target player draws two cards and loses 2 life.',
    power: null,
    toughness: null,
    colors: ['B']
  },
  "skewer the critics": {
    name: "Skewer the Critics",
    manaCost: '{2}{R}',
    cmc: 3,
    typeLine: 'Sorcery',
    oracleText: 'Spectacle {R}\nSkewer the Critics deals 3 damage to any target.',
    power: null,
    toughness: null,
    colors: ['R']
  },
  "soldier of the pantheon": {
    name: "Soldier of the Pantheon",
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Creature — Human Soldier',
    oracleText: 'Protection from multicolored\nWhenever an opponent casts a multicolored spell, you gain 1 life.',
    power: 2,
    toughness: 1,
    colors: ['W']
  },
  "spire of industry": {
    name: "Spire of Industry",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: '{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color. Activate only if you control an artifact.',
    power: null,
    toughness: null,
    colors: []
  },
  "starting town": {
    name: "Starting Town",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land',
    oracleText: "Starting Town enters the battlefield tapped unless it's the first, second, or third turn of the game.\n{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color.",
    power: null,
    toughness: null,
    colors: []
  },
  "steam vents": {
    name: "Steam Vents",
    manaCost: '',
    cmc: 0,
    typeLine: 'Land — Island Mountain',
    oracleText: "({T}: Add {U} or {R}.)\nAs Steam Vents enters the battlefield, you may pay 2 life. If you don't, it enters the battlefield tapped.",
    power: null,
    toughness: null,
    colors: []
  },
  "steel leaf champion": {
    name: "Steel Leaf Champion",
    manaCost: '{G}{G}{G}',
    cmc: 3,
    typeLine: 'Creature — Elf Knight',
    oracleText: "Steel Leaf Champion can't be blocked by creatures with power 2 or less.",
    power: 5,
    toughness: 4,
    colors: ['G']
  },
  "stolen uniform": {
    name: "Stolen Uniform",
    manaCost: '{U}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: 'Gain control of target Equipment until end of turn. Attach it to target creature you control. When you lose control of that Equipment, unattach it.',
    power: null,
    toughness: null,
    colors: ['U']
  },
  "strangleroot geist": {
    name: "Strangleroot Geist",
    manaCost: '{G}{G}',
    cmc: 2,
    typeLine: 'Creature — Spirit',
    oracleText: 'Haste\nUndying',
    power: 2,
    toughness: 1,
    colors: ['G']
  },
  "supreme verdict": {
    name: "Supreme Verdict",
    manaCost: '{1}{W}{W}{U}',
    cmc: 4,
    typeLine: 'Sorcery',
    oracleText: "This spell can't be countered.\nDestroy all creatures.",
    power: null,
    toughness: null,
    colors: ['W', 'U']
  },
  "surge of salvation": {
    name: "Surge of Salvation",
    manaCost: '{W}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: 'You and permanents you control gain hexproof until end of turn. Prevent all damage that black and/or red sources would deal to creatures you control this turn.',
    power: null,
    toughness: null,
    colors: ['W']
  },
  "swamp": {
    name: "Swamp",
    manaCost: '',
    cmc: 0,
    typeLine: 'Basic Land — Swamp',
    oracleText: '({T}: Add {B}.)',
    power: null,
    toughness: null,
    colors: []
  },
  "thalia, guardian of thraben": {
    name: "Thalia, Guardian of Thraben",
    manaCost: '{1}{W}',
    cmc: 2,
    typeLine: 'Legendary Creature — Human Soldier',
    oracleText: 'First strike\nNoncreature spells cost {1} more to cast.',
    power: 2,
    toughness: 1,
    colors: ['W']
  },
  "thoughtseize": {
    name: "Thoughtseize",
    manaCost: '{B}',
    cmc: 1,
    typeLine: 'Sorcery',
    oracleText: 'Target player reveals their hand. You choose a nonland card from it. That player discards that card. You lose 2 life.',
    power: null,
    toughness: null,
    colors: ['B']
  },
  "vines of vastwood": {
    name: "Vines of Vastwood",
    manaCost: '{G}',
    cmc: 1,
    typeLine: 'Instant',
    oracleText: "Kicker {G}\nTarget creature can't be the target of spells or abilities your opponents control this turn. If this spell was kicked, that creature gets +4/+4 until end of turn.",
    power: null,
    toughness: null,
    colors: ['G']
  }
};

const DECK_ALIASES = {
  AMERICAN_GADGETS: 'BETA_AMERICAN_GADGETS',
  MONO_BLACK: 'STARTER_MONO_BLACK',
  BURN: 'STARTER_BOROS_BURN',
  BOROS_BURN: 'STARTER_BOROS_BURN',
  AZORIUS_CONTROL: 'STARTER_AZORIUS_CONTROL',
  MONO_GREEN_STOMPY: 'STARTER_MONO_GREEN_STOMPY',
  WHITE_WEENIE: 'STARTER_WHITE_WEENIE',
  MONO_WHITE_TOKENS: 'STARTER_WHITE_WEENIE'
};

for (const deck of PRECONSTRUCTED_STARTER_DECKS) {
  deck.cards = parseDecklistLines(deck.decklistText);
  deck.mainboard = deck.cards;
  try {
    groundDeckForEngine(deck.cards);
  } catch (_) {}
}

export function getPreconstructedDeckById(id) {
  if (!id) return null;
  const norm = String(id).trim().toUpperCase();
  const targetId = DECK_ALIASES[norm] || norm;
  return PRECONSTRUCTED_STARTER_DECKS.find(
    d => d.id.toUpperCase() === targetId || d.id.toUpperCase() === norm || d.name.toUpperCase() === norm
  ) || null;
}

export function getPreconstructedDeckCards(id) {
  const deck = getPreconstructedDeckById(id);
  if (!deck || !Array.isArray(deck.cards)) return [];

  const uniqueCardsMap = new Map();
  for (const item of deck.cards) {
    const name = item.name;
    const count = Number(item.count) || 1;
    const norm = String(name).trim().toLowerCase();
    if (uniqueCardsMap.has(norm)) {
      uniqueCardsMap.get(norm).count += count;
    } else {
      const meta = PRECON_CARD_METADATA[norm] || {};
      uniqueCardsMap.set(norm, {
        name: meta.name || name,
        manaCost: meta.manaCost || '',
        cmc: meta.cmc ?? 0,
        typeLine: meta.typeLine || 'Card',
        oracleText: meta.oracleText || '',
        power: meta.power ?? null,
        toughness: meta.toughness ?? null,
        colors: meta.colors ? [...meta.colors] : [],
        count
      });
    }
  }

  const cardEntries = Array.from(uniqueCardsMap.values());
  const groundedResult = groundDeckForEngine(cardEntries);
  return groundedResult.cards;
}
