/**
 * Automated Verification Test Suite for RPM Core Ingestion Engine
 * Validates all 12 test cases from Section 5 of SPEC-RPM-INGEST-001.
 */

import assert from 'node:assert';
import { parseDecklist } from '../src/DeckParser.js';
import { ScryfallService, MemoryCacheAdapter } from '../src/ScryfallService.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(err);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(err);
    failed++;
  }
}

console.log('=== RUNNING SPEC-RPM-INGEST-001 TEST SUITE ===\n');

// Test Case 1: Standard Modern Decklist (Plain Text)
test('Test Case 1: Standard Modern Decklist (Plain Text)', () => {
  const input = `4 Lightning Bolt
4 Ragavan, Nimble Pilferer
2 Murktide Regent`;

  const result = parseDecklist(input);

  assert.strictEqual(result.cards.length, 3, 'cards.length should be 3');
  assert.strictEqual(result.totalCards, 10, 'totalCards should be 10');
  assert.deepStrictEqual(result.cards[0], {
    count: 4,
    name: 'Lightning Bolt',
    set: null,
    collectorNumber: null,
    section: 'main'
  });
  assert.deepStrictEqual(result.cards[1], {
    count: 4,
    name: 'Ragavan, Nimble Pilferer',
    set: null,
    collectorNumber: null,
    section: 'main'
  });
  assert.strictEqual(result.errors.length, 0, 'errors.length should be 0');
});

// Test Case 2: MTG Arena Export Format with Set Codes & Collector Numbers
test('Test Case 2: MTG Arena Export Format with Set Codes & Collector Numbers', () => {
  const input = `Deck
4 Ragavan, Nimble Pilferer (MH2) 138
2 Murktide Regent (MH2) 52

Sideboard
2 Flusterstorm (MH1) 255`;

  const result = parseDecklist(input);

  assert.strictEqual(result.mainCount, 6, 'mainCount should be 6');
  assert.strictEqual(result.sideboardCount, 2, 'sideboardCount should be 2');
  assert.strictEqual(result.cards[0].set, 'mh2', 'set should be mh2');
  assert.strictEqual(result.cards[0].collectorNumber, '138', 'collectorNumber should be 138');
  assert.strictEqual(result.cards[0].section, 'main', 'section should be main');
  assert.strictEqual(result.cards[2].name, 'Flusterstorm');
  assert.strictEqual(result.cards[2].section, 'sideboard');
});

// Test Case 3: Moxfield / Archidekt Export with Brackets & Cosmetic Tags
test('Test Case 3: Moxfield / Archidekt Export with Brackets & Cosmetic Tags', () => {
  const input = `1 Sol Ring [CLB] #298 *F*
4x Mishra's Bauble [2XM] 274`;

  const result = parseDecklist(input);

  assert.strictEqual(result.cards[0].name, 'Sol Ring');
  assert.strictEqual(result.cards[0].set, 'clb');
  assert.strictEqual(result.cards[0].collectorNumber, '298');
  assert.strictEqual(result.cards[1].count, 4);
  assert.strictEqual(result.cards[1].name, "Mishra's Bauble");
  assert.strictEqual(result.cards[1].set, '2xm');
  assert.strictEqual(result.cards[1].collectorNumber, '274');
});

// Test Case 4: Complex Card Names (Punctuation, Hyphens, Commas, Diacritics, Splits)
test('Test Case 4: Complex Card Names (Punctuation, Hyphens, Commas, Diacritics, Splits)', () => {
  const input = `1 Jace, the Mind Sculptor
1 Lim-Dûl's Vault
1 Fire // Ice
1 Kongming, "Sleeping Dragon"`;

  const result = parseDecklist(input);

  assert.strictEqual(result.cards[0].name, 'Jace, the Mind Sculptor');
  assert.strictEqual(result.cards[1].name, "Lim-Dûl's Vault");
  assert.strictEqual(result.cards[2].name, 'Fire // Ice');
  assert.strictEqual(result.cards[3].name, 'Kongming, "Sleeping Dragon"');
});

// Test Case 5: Multi-Section Transitions (Mainboard, Sideboard, Commander, Companion)
test('Test Case 5: Multi-Section Transitions (Mainboard, Sideboard, Commander, Companion)', () => {
  const input = `Commander
1 Atraxa, Praetors' Voice (C16) 28
Deck
1 Sol Ring
Sideboard
1 Heroic Intervention`;

  const result = parseDecklist(input);

  assert.strictEqual(result.commanderCount, 1, 'commanderCount should be 1');
  assert.strictEqual(result.mainCount, 1, 'mainCount should be 1');
  assert.strictEqual(result.sideboardCount, 1, 'sideboardCount should be 1');
  assert.strictEqual(result.cards[0].section, 'commander');
  assert.strictEqual(result.cards[1].section, 'main');
  assert.strictEqual(result.cards[2].section, 'sideboard');
});

// Test Case 6: Edge Cases, Comments & Noise Resilience
test('Test Case 6: Edge Cases, Comments & Noise Resilience', () => {
  const input = `// Core Spells
4 Counterspell

   
# Sideboard Options
Sideboard
// Graveyard hate
2 Endurance`;

  const result = parseDecklist(input);

  assert.strictEqual(result.cards.length, 2, 'cards.length should be 2');
  assert.strictEqual(result.errors.length, 0, 'No errors should be captured');
  assert.strictEqual(result.cards[0].name, 'Counterspell');
  assert.strictEqual(result.cards[1].name, 'Endurance');
  assert.strictEqual(result.cards[1].section, 'sideboard');
});

// Test Case 7: Scryfall Batch Chunking of > 75 Cards
await testAsync('Test Case 7: Scryfall Batch Chunking of > 75 Cards', async () => {
  const testCards = [];
  for (let i = 1; i <= 100; i++) {
    testCards.push({
      count: 1,
      name: `Unique Card ${i}`,
      set: null,
      collectorNumber: null,
      section: 'main'
    });
  }

  const calls = [];
  const mockFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, opts, identifiers: body.identifiers });

    const returnedData = body.identifiers.map(id => ({
      id: `id-${id.name}`,
      name: id.name,
      mana_cost: '{1}',
      type_line: 'Creature',
      oracle_text: 'Test',
      colors: ['W'],
      legalities: { modern: 'legal' },
      image_uris: { normal: `https://img/${id.name}.jpg` }
    }));

    return {
      status: 200,
      ok: true,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ data: returnedData, not_found: [] })
    };
  };

  const service = new ScryfallService({
    cacheAdapter: new MemoryCacheAdapter(),
    fetch: mockFetch,
    rateLimitMs: 10
  });

  const result = await service.fetchDeckCards(testCards);

  assert.strictEqual(calls.length, 2, 'Mock HTTP dispatcher receives exactly 2 POST calls');
  assert.strictEqual(calls[0].identifiers.length, 75, 'Request 1 payload contains identifiers.length === 75');
  assert.strictEqual(calls[1].identifiers.length, 25, 'Request 2 payload contains identifiers.length === 25');
  assert.strictEqual(result.cards.length, 100, 'Total cards returned in result equals 100');
});

// Test Case 8: Polite Rate Limiting & Header Verification
await testAsync('Test Case 8: Polite Rate Limiting & Header Verification', async () => {
  const testCards = [];
  for (let i = 1; i <= 76; i++) {
    testCards.push({
      count: 1,
      name: `Card ${i}`,
      set: null,
      collectorNumber: null,
      section: 'main'
    });
  }

  const requestTimestamps = [];
  let capturedHeaders = null;

  const mockFetch = async (url, opts) => {
    requestTimestamps.push(Date.now());
    capturedHeaders = opts.headers;
    const body = JSON.parse(opts.body);
    const returnedData = body.identifiers.map(id => ({
      id: `id-${id.name}`,
      name: id.name,
      mana_cost: '{1}',
      type_line: 'Instant',
      oracle_text: '',
      colors: [],
      legalities: { modern: 'legal' }
    }));
    return {
      status: 200,
      ok: true,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ data: returnedData, not_found: [] })
    };
  };

  const service = new ScryfallService({
    cacheAdapter: new MemoryCacheAdapter(),
    fetch: mockFetch,
    rateLimitMs: 100
  });

  await service.fetchDeckCards(testCards);

  assert.strictEqual(capturedHeaders['User-Agent'], 'RPM-Multiplayer/1.0', "Header User-Agent equals 'RPM-Multiplayer/1.0'");
  assert.strictEqual(capturedHeaders['Content-Type'], 'application/json', "Header Content-Type equals 'application/json'");
  
  const delta = requestTimestamps[1] - requestTimestamps[0];
  assert.ok(delta >= 95, `Delta timestamp between Request 1 and Request 2 must be >= 100ms (measured: ${delta}ms)`);
});

// Test Case 9: Dual-Layer Cache Interception
await testAsync('Test Case 9: Dual-Layer Cache Interception', async () => {
  const cache = new MemoryCacheAdapter();
  cache.setItem('name:lightning bolt', JSON.stringify({
    id: 'bolt-id',
    name: 'Lightning Bolt',
    manaCost: '{R}',
    typeLine: 'Instant',
    oracleText: 'Lightning Bolt deals 3 damage to any target.',
    imageUri: 'https://img/bolt.jpg',
    colors: ['R'],
    modernLegal: true,
    raw: {}
  }));
  cache.setItem('name:counterspell', JSON.stringify({
    id: 'counter-id',
    name: 'Counterspell',
    manaCost: '{U}{U}',
    typeLine: 'Instant',
    oracleText: 'Counter target spell.',
    imageUri: 'https://img/counter.jpg',
    colors: ['U'],
    modernLegal: true,
    raw: {}
  }));

  let networkCallCount = 0;
  let requestedIdentifiers = [];

  const mockFetch = async (url, opts) => {
    networkCallCount++;
    const body = JSON.parse(opts.body);
    requestedIdentifiers = body.identifiers;
    const returnedData = body.identifiers.map(id => ({
      id: `id-${id.name}`,
      name: id.name,
      mana_cost: '{1}',
      type_line: 'Creature',
      oracle_text: '',
      colors: [],
      legalities: { modern: 'legal' }
    }));
    return {
      status: 200,
      ok: true,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ data: returnedData, not_found: [] })
    };
  };

  const service = new ScryfallService({
    cacheAdapter: cache,
    fetch: mockFetch,
    rateLimitMs: 0
  });

  const parsedDeck = [
    { count: 4, name: 'Lightning Bolt', set: null, collectorNumber: null, section: 'main' },
    { count: 4, name: 'Counterspell', set: null, collectorNumber: null, section: 'main' },
    { count: 4, name: 'Ragavan, Nimble Pilferer', set: null, collectorNumber: null, section: 'main' },
    { count: 2, name: 'Murktide Regent', set: null, collectorNumber: null, section: 'main' }
  ];

  const firstResult = await service.fetchDeckCards(parsedDeck);

  // Assertion 1: Outbound network request contains only the 2 missing identifiers
  assert.strictEqual(requestedIdentifiers.length, 2, 'Network request contains only 2 missing identifiers');
  assert.deepStrictEqual(requestedIdentifiers.map(i => i.name), ['Ragavan, Nimble Pilferer', 'Murktide Regent']);

  // Assertion 2: Response combines the 2 cached cards + the 2 fetched cards
  assert.strictEqual(firstResult.cards.length, 4, 'Response contains all 4 cards');
  assert.strictEqual(firstResult.stats.cacheHits, 2, '2 cache hits');
  assert.strictEqual(firstResult.stats.networkFetches, 2, '2 network fetches');

  // Assertion 3: Cache now contains all 4 cards
  assert.ok(cache.hasItem('name:lightning bolt'));
  assert.ok(cache.hasItem('name:counterspell'));
  assert.ok(cache.hasItem('name:ragavan, nimble pilferer'));
  assert.ok(cache.hasItem('name:murktide regent'));

  // Assertion 4: Second identical call executes 0 network requests
  networkCallCount = 0;
  const secondResult = await service.fetchDeckCards(parsedDeck);
  assert.strictEqual(networkCallCount, 0, 'Second identical call executes 0 network requests');
  assert.strictEqual(secondResult.stats.cacheHits, 4, 'Second call reports 4 cache hits');
  assert.strictEqual(secondResult.cards.length, 4, 'Second call returns all 4 cards');
});

// Test Case 10: Graceful Handling of Unresolved / Typo Cards (not_found)
await testAsync('Test Case 10: Graceful Handling of Unresolved / Typo Cards (not_found)', async () => {
  const mockFetch = async () => ({
    status: 200,
    ok: true,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => ({
      data: [{
        id: 'bolt-id',
        name: 'Lightning Bolt',
        mana_cost: '{R}',
        type_line: 'Instant',
        oracle_text: 'Deal 3 damage.',
        colors: ['R'],
        legalities: { modern: 'legal' }
      }],
      not_found: [{
        name: 'Nonexistent Card XYZ 123'
      }]
    })
  });

  const service = new ScryfallService({
    cacheAdapter: new MemoryCacheAdapter(),
    fetch: mockFetch
  });

  const inputDeck = [
    { count: 4, name: 'Lightning Bolt', set: null, collectorNumber: null, section: 'main' },
    { count: 1, name: 'Nonexistent Card XYZ 123', set: null, collectorNumber: null, section: 'main' }
  ];

  const result = await service.fetchDeckCards(inputDeck);

  assert.strictEqual(result.cards.length, 1, 'result.cards.length === 1 (Lightning Bolt)');
  assert.strictEqual(result.notFound.length, 1, 'result.notFound.length === 1');
  assert.strictEqual(result.notFound[0].requestedName, 'Nonexistent Card XYZ 123', 'requestedName matches');
});

// Test Case 11: Multi-Faced Card (DFC / Split) Attribute Extraction
test('Test Case 11: Multi-Faced Card (DFC / Split) Attribute Extraction', () => {
  const service = new ScryfallService({ cacheAdapter: new MemoryCacheAdapter() });

  const mockDfcCard = {
    id: 'delver-id',
    name: 'Delver of Secrets // Insectile Aberration',
    legalities: { modern: 'legal' },
    card_faces: [
      {
        name: 'Delver of Secrets',
        mana_cost: '{U}',
        type_line: 'Creature — Human Wizard',
        oracle_text: 'At the beginning of your upkeep...',
        colors: ['U'],
        image_uris: {
          small: 'https://img/delver_small.jpg',
          normal: 'https://img/delver_normal.jpg'
        }
      },
      {
        name: 'Insectile Aberration',
        mana_cost: '',
        type_line: 'Creature — Human Insect',
        oracle_text: 'Flying',
        colors: ['U'],
        image_uris: {
          small: 'https://img/insect_small.jpg',
          normal: 'https://img/insect_normal.jpg'
        }
      }
    ]
  };

  const entity = service._transformScryfallCard(mockDfcCard);

  assert.strictEqual(entity.manaCost, '{U}', "entity.manaCost === '{U}'");
  assert.strictEqual(entity.imageUri, 'https://img/delver_normal.jpg', 'entity.imageUri resolves to face 0 normal');
  assert.deepStrictEqual(entity.colors, ['U'], "entity.colors contains ['U']");
  assert.strictEqual(entity.modernLegal, true, 'modernLegal is true');
});

// Test Case 12: Network Retry on HTTP 429 Throttling
await testAsync('Test Case 12: Network Retry on HTTP 429 Throttling', async () => {
  let attemptCount = 0;
  const mockFetch = async () => {
    attemptCount++;
    if (attemptCount === 1) {
      // First attempt fails with 429 and Retry-After header
      return {
        status: 429,
        ok: false,
        headers: new Headers({
          'Content-Type': 'application/json',
          'Retry-After': '0.05'
        }),
        json: async () => ({})
      };
    }
    // Second attempt succeeds with 200
    return {
      status: 200,
      ok: true,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({
        data: [{
          id: 'bolt-id',
          name: 'Lightning Bolt',
          mana_cost: '{R}',
          type_line: 'Instant',
          oracle_text: 'Deal 3 damage.',
          colors: ['R'],
          legalities: { modern: 'legal' }
        }],
        not_found: []
      })
    };
  };

  const service = new ScryfallService({
    cacheAdapter: new MemoryCacheAdapter(),
    fetch: mockFetch
  });

  const result = await service.fetchDeckCards([
    { count: 4, name: 'Lightning Bolt', set: null, collectorNumber: null, section: 'main' }
  ]);

  assert.strictEqual(attemptCount, 2, '2 attempts dispatched (initial 429 followed by retry 200)');
  assert.strictEqual(result.cards.length, 1, 'Final deck output is completely resolved');
  assert.strictEqual(result.cards[0].name, 'Lightning Bolt');
});

// Test Case 13: Split & DFC Identifier Query Normalization
await testAsync('Test Case 13: Split & DFC Identifier Query Normalization', async () => {
  let queriedIdentifier = null;
  const mockFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    queriedIdentifier = body.identifiers[0];
    return {
      status: 200,
      ok: true,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({
        data: [{
          id: 'wear-tear-id',
          name: 'Wear // Tear',
          mana_cost: '{1}{R} // {W}',
          type_line: 'Instant // Instant',
          oracle_text: 'Destroy artifact // Destroy enchantment',
          colors: ['R', 'W'],
          legalities: { modern: 'legal' },
          card_faces: [
            { name: 'Wear', mana_cost: '{1}{R}', oracle_text: 'Destroy target artifact.' },
            { name: 'Tear', mana_cost: '{W}', oracle_text: 'Destroy target enchantment.' }
          ]
        }],
        not_found: []
      })
    };
  };

  const cache = new MemoryCacheAdapter();
  const service = new ScryfallService({ cacheAdapter: cache, fetch: mockFetch });

  const result = await service.fetchDeckCards([
    { count: 2, name: 'Wear // Tear', set: null, collectorNumber: null, section: 'sideboard' }
  ]);

  // Assert query name was stripped to front-face for Scryfall collection compliance
  assert.strictEqual(queriedIdentifier.name, 'Wear', 'Identifier name sent to Scryfall must be front face');
  assert.strictEqual(result.cards.length, 1, 'Resolved 1 card');
  assert.strictEqual(result.cards[0].name, 'Wear // Tear', 'Card retains canonical name');
  assert.strictEqual(result.cards[0].section, 'sideboard', 'Preserves sideboard section');
  assert.strictEqual(result.cards[0].count, 2, 'Preserves count');

  // Verify caching under both full name and front-face
  assert.ok(cache.hasItem('name:wear // tear'), 'Cached under canonical split name');
  assert.ok(cache.hasItem('name:wear'), 'Cached under front face name');
});

console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
