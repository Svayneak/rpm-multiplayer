/**
 * Live Scryfall API Integration & Quality Compliance Test
 * Tests real network calls against api.scryfall.com/cards/collection
 */

import assert from 'node:assert';
import { parseDecklist } from '../src/DeckParser.js';
import { ScryfallService, MemoryCacheAdapter } from '../src/ScryfallService.js';

console.log('=== STARTING LIVE SCRYFALL INTEGRATION TESTS ===\n');

// Realistic 75-card Modern Decklist with DFCs, Split cards, and diverse card types
const modernDecklistRaw = `
// Mainboard (60 cards)
4 Ragavan, Nimble Pilferer
4 Galvanic Discharge
4 Guide of Souls
4 Amped Raptor
4 Ajani, Nacatl Pariah
4 Phlage, Titan of Fire's Fury
4 Ocelot Pride
2 Fable of the Mirror-Breaker
2 Boggart Trawler
2 Tamiyo, Inquisitive Student
4 Lightning Bolt
4 Static Prison
2 Bloodstained Mire
2 Wooded Foothills
2 Sacred Foundry
2 Inspiring Vantage
4 Arena of Glory
3 Plains
3 Mountain

Sideboard
2 Blood Moon
2 Wear // Tear
2 Wrath of the Skies
2 Obsidian Charmaw
2 Sunspine Lynx
2 Disruptor Flute
3 Surgical Extraction
`;

async function runLiveTests() {
  let passed = 0;
  let failed = 0;

  function report(name, ok, err) {
    if (ok) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}`);
      if (err) console.error(err);
      failed++;
    }
  }

  // Instrument native fetch to monitor live network traffic
  const originalFetch = globalThis.fetch;
  const capturedRequests = [];

  const monitoredFetch = async (url, opts) => {
    const timestamp = Date.now();
    const headers = {};
    if (opts.headers) {
      if (opts.headers instanceof Headers) {
        opts.headers.forEach((val, key) => { headers[key] = val; });
      } else {
        Object.assign(headers, opts.headers);
      }
    }
    const body = opts.body ? JSON.parse(opts.body) : null;
    capturedRequests.push({
      url,
      method: opts.method,
      headers,
      body,
      timestamp
    });
    return originalFetch(url, opts);
  };

  const cache = new MemoryCacheAdapter();
  const service = new ScryfallService({
    cacheAdapter: cache,
    fetch: monitoredFetch,
    rateLimitMs: 120 // polite rate limit
  });

  console.log('--- 1. Parsing Real 75-Card Modern Decklist ---');
  const parsed = parseDecklist(modernDecklistRaw);
  try {
    assert.strictEqual(parsed.totalCards, 75, 'Parsed totalCards must be 75');
    assert.strictEqual(parsed.mainCount, 60, 'Mainboard must have 60 cards');
    assert.strictEqual(parsed.sideboardCount, 15, 'Sideboard must have 15 cards');
    assert.strictEqual(parsed.errors.length, 0, 'No parse errors on modern decklist');
    report('1. DeckParser accurately processes 75-card Modern decklist', true);
  } catch (e) {
    report('1. DeckParser accurately processes 75-card Modern decklist', false, e);
  }

  console.log('\n--- 2. Live Scryfall Hydration (Initial Cold Fetch) ---');
  let result1;
  try {
    const startTime = Date.now();
    result1 = await service.fetchDeckCards(parsed.cards);
    const duration = Date.now() - startTime;

    console.log(`Live fetch completed in ${duration}ms`);
    console.log(`Requested: ${result1.stats.totalRequested}, Resolved: ${result1.stats.totalResolved}`);
    console.log(`Cache hits: ${result1.stats.cacheHits}, Network fetches: ${result1.stats.networkFetches}`);
    console.log(`Chunks dispatched: ${result1.stats.chunksDispatched}`);

    assert.strictEqual(result1.cards.length, parsed.cards.length, 'All parsed cards must be resolved');
    assert.strictEqual(result1.notFound.length, 0, 'Zero cards in notFound for valid Modern deck');
    assert.strictEqual(result1.stats.cacheHits, 0, 'Cold fetch should have 0 cache hits');
    assert.ok(result1.stats.networkFetches > 0, 'Cold fetch should have network fetches');
    report('2. Live Scryfall cold fetch resolved 100% of cards', true);
  } catch (e) {
    report('2. Live Scryfall cold fetch resolved 100% of cards', false, e);
  }

  console.log('\n--- 3. Verifying Outbound HTTP Headers & Scryfall API Protocol ---');
  try {
    assert.ok(capturedRequests.length >= 1, 'At least 1 network request was made');
    const firstReq = capturedRequests[0];
    assert.strictEqual(firstReq.url, 'https://api.scryfall.com/cards/collection');
    assert.strictEqual(firstReq.method, 'POST');
    assert.strictEqual(firstReq.headers['User-Agent'], 'RPM-Multiplayer/1.0', 'User-Agent header must match spec');
    assert.strictEqual(firstReq.headers['Accept'], 'application/json', 'Accept header must be application/json');
    assert.strictEqual(firstReq.headers['Content-Type'], 'application/json', 'Content-Type must be application/json');
    assert.ok(Array.isArray(firstReq.body.identifiers), 'Payload has identifiers array');
    assert.ok(firstReq.body.identifiers.length <= 75, 'Identifiers length must be <= 75');
    report('3. Outbound HTTP headers and protocol strictly conform to Scryfall TOS', true);
  } catch (e) {
    report('3. Outbound HTTP headers and protocol strictly conform to Scryfall TOS', false, e);
  }

  console.log('\n--- 4. Cache Interception & Zero-Network Repeat Fetch ---');
  try {
    const networkCountBefore = capturedRequests.length;
    const result2 = await service.fetchDeckCards(parsed.cards);
    const networkCountAfter = capturedRequests.length;

    assert.strictEqual(networkCountAfter - networkCountBefore, 0, 'Second run must dispatch 0 network requests');
    assert.strictEqual(result2.stats.cacheHits, parsed.cards.length, 'All cards must hit cache on second run');
    assert.strictEqual(result2.stats.networkFetches, 0, 'Network fetches stat must be 0');
    assert.strictEqual(result2.cards.length, result1.cards.length, 'Result cards count matches');
    report('4. Cache interception successfully avoids redundant network calls (0 calls on replay)', true);
  } catch (e) {
    report('4. Cache interception successfully avoids redundant network calls (0 calls on replay)', false, e);
  }

  console.log('\n--- 5. Double-Faced Card (DFC) Normalization & Attributes ---');
  try {
    // 5a. Fable of the Mirror-Breaker
    const fable = result1.cards.find(c => c.name.includes('Fable of the Mirror-Breaker'));
    assert.ok(fable, 'Fable of the Mirror-Breaker must be in resolved cards');
    assert.ok(fable.imageUri && fable.imageUri.startsWith('http'), `Fable imageUri valid: ${fable.imageUri}`);
    assert.ok(fable.oracleText && fable.oracleText.length > 20, 'Fable oracleText must be populated');
    assert.ok(fable.typeLine.includes('Enchantment') || fable.typeLine.includes('Saga'), 'Fable typeLine matches');
    assert.strictEqual(fable.modernLegal, true, 'Fable is Modern legal');
    console.log(`   [DFC] Fable imageUri: ${fable.imageUri.slice(0, 60)}...`);
    console.log(`   [DFC] Fable oracleText preview: ${fable.oracleText.slice(0, 80).replace(/\n/g, ' ')}...`);

    // 5b. Boggart Trawler // Boggart Bog (MDFC)
    const boggart = result1.cards.find(c => c.name.includes('Boggart Trawler'));
    assert.ok(boggart, 'Boggart Trawler must be in resolved cards');
    assert.ok(boggart.imageUri && boggart.imageUri.startsWith('http'), `Boggart imageUri valid: ${boggart.imageUri}`);
    assert.ok(boggart.oracleText && boggart.oracleText.length > 20, 'Boggart oracleText must be populated');
    assert.strictEqual(boggart.modernLegal, true, 'Boggart Trawler is Modern legal');
    console.log(`   [DFC] Boggart imageUri: ${boggart.imageUri.slice(0, 60)}...`);
    console.log(`   [DFC] Boggart oracleText preview: ${boggart.oracleText.slice(0, 80).replace(/\n/g, ' ')}...`);

    // 5c. Tamiyo, Inquisitive Student // Tamiyo, Seasoned Scholar
    const tamiyo = result1.cards.find(c => c.name.includes('Tamiyo, Inquisitive Student'));
    assert.ok(tamiyo, 'Tamiyo must be in resolved cards');
    assert.ok(tamiyo.imageUri && tamiyo.imageUri.startsWith('http'), `Tamiyo imageUri valid: ${tamiyo.imageUri}`);
    assert.ok(tamiyo.oracleText && tamiyo.oracleText.length > 20, 'Tamiyo oracleText must be populated');
    assert.strictEqual(tamiyo.modernLegal, true, 'Tamiyo is Modern legal');
    console.log(`   [DFC] Tamiyo imageUri: ${tamiyo.imageUri.slice(0, 60)}...`);
    console.log(`   [DFC] Tamiyo oracleText preview: ${tamiyo.oracleText.slice(0, 80).replace(/\n/g, ' ')}...`);

    // 5d. Ajani, Nacatl Pariah // Ajani, Nacatl Avenger
    const ajani = result1.cards.find(c => c.name.includes('Ajani, Nacatl Pariah'));
    assert.ok(ajani, 'Ajani must be in resolved cards');
    assert.ok(ajani.imageUri && ajani.imageUri.startsWith('http'), `Ajani imageUri valid: ${ajani.imageUri}`);
    assert.ok(ajani.oracleText && ajani.oracleText.length > 20, 'Ajani oracleText must be populated');
    assert.strictEqual(ajani.modernLegal, true, 'Ajani is Modern legal');
    console.log(`   [DFC] Ajani imageUri: ${ajani.imageUri.slice(0, 60)}...`);

    report('5. Double-faced cards (DFCs & MDFCs) correctly populate imageUri, oracleText, and attributes', true);
  } catch (e) {
    report('5. Double-faced cards (DFCs & MDFCs) correctly populate imageUri, oracleText, and attributes', false, e);
  }

  console.log('\n--- 6. Live Multi-Batch Chunking (> 75 Cards) & Polite Throttling ---');
  try {
    // Generate 80 distinct real MTG card names to force 2 chunks (75 + 5)
    const baseCards = [
      'Counterspell', 'Brainstorm', 'Ponder', 'Preordain', 'Opt', 'Serum Visions', 'Sleight of Hand',
      'Lightning Bolt', 'Lava Spike', 'Rift Bolt', 'Chain Lightning', 'Monastery Swiftspear', 'Goblin Guide',
      'Eidolon of the Great Revel', 'Skullcrack', 'Searing Blaze', 'Fireblast', 'Price of Progress',
      'Dark Ritual', 'Thoughtseize', 'Inquisition of Kozilek', 'Duress', 'Cabal Therapy', 'Hymn to Tourach',
      'Fatal Push', 'Dismember', 'Go for the Throat', 'Doom Blade', 'Infernal Grasp', 'Snuff Out',
      'Swords to Plowshares', 'Path to Exile', 'Prismatic Ending', 'Solitude', 'Leyline Binding',
      'Birds of Paradise', 'Noble Hierarch', 'Ignoble Hierarch', 'Llanowar Elves', 'Elvish Mystic',
      'Fyndhorn Elves', 'Delighted Halfling', 'Heritage Druid', 'Nettle Sentinel', 'Quirion Ranger',
      'Tarmogoyf', 'Scavenging Ooze', 'Dryad of the Ilysian Grove', 'Primeval Titan', 'Craterhoof Behemoth',
      'Snapcaster Mage', 'Murktide Regent', 'True-Name Nemesis', 'Urza, Lord High Artificer',
      'Grief', 'Fury', 'Subtlety', 'Endurance', 'Orcish Bowmasters', 'The One Ring',
      'Mox Opal', 'Mox Amber', 'Chrome Mox', 'Lotus Petal', 'Mishra\'s Bauble', 'Urza\'s Bauble',
      'Chalice of the Void', 'Ensnaring Bridge', 'Blood Moon', 'Magus of the Moon', 'Back to Basics',
      'Rest in Peace', 'Leyline of the Void', 'Damping Sphere', 'Torpor Orb', 'Grafdigger\'s Cage',
      'Relic of Progenitus', 'Soul-Guide Lantern', 'Engineered Explosives', 'Pithing Needle'
    ]; // exactly 80 unique cards!

    assert.strictEqual(baseCards.length, 80, 'Card list has exactly 80 items');

    const largeDeck = baseCards.map(name => ({
      count: 1,
      name,
      set: null,
      collectorNumber: null,
      section: 'main'
    }));

    const multiBatchService = new ScryfallService({
      cacheAdapter: new MemoryCacheAdapter(),
      fetch: monitoredFetch,
      rateLimitMs: 150 // 150ms throttle
    });

    const reqCountBefore = capturedRequests.length;
    const multiResult = await multiBatchService.fetchDeckCards(largeDeck);
    const reqCountAfter = capturedRequests.length;

    const newRequests = capturedRequests.slice(reqCountBefore, reqCountAfter);
    assert.strictEqual(newRequests.length, 2, 'Exactly 2 chunk requests dispatched for 80 cards');
    assert.strictEqual(newRequests[0].body.identifiers.length, 75, 'Chunk 1 must have 75 identifiers');
    assert.strictEqual(newRequests[1].body.identifiers.length, 5, 'Chunk 2 must have 5 identifiers');

    const throttleTime = newRequests[1].timestamp - newRequests[0].timestamp;
    console.log(`   Measured inter-request throttle delay: ${throttleTime}ms (configured: 150ms)`);
    assert.ok(throttleTime >= 140, `Throttle delay must be >= 140ms (measured: ${throttleTime}ms)`);

    assert.strictEqual(multiResult.cards.length, 80, 'All 80 cards resolved across the two chunks');
    assert.strictEqual(multiResult.stats.chunksDispatched, 2, 'chunksDispatched stat is 2');
    report('6. Multi-batch chunking (>75 cards) and live 150ms throttling strictly validated', true);
  } catch (e) {
    report('6. Multi-batch chunking (>75 cards) and live 150ms throttling strictly validated', false, e);
  }

  console.log('\n--- 7. Live Graceful Error Handling (not_found Typo Handling) ---');
  try {
    const invalidDeck = [
      { count: 1, name: 'Lightning Bolt', set: null, collectorNumber: null, section: 'main' },
      { count: 1, name: 'ThisCardDoesNotExistXYZ99999', set: null, collectorNumber: null, section: 'main' }
    ];

    const errorService = new ScryfallService({
      cacheAdapter: new MemoryCacheAdapter(),
      fetch: monitoredFetch
    });

    const errorResult = await errorService.fetchDeckCards(invalidDeck);
    assert.strictEqual(errorResult.cards.length, 1, 'Only valid card returned');
    assert.strictEqual(errorResult.cards[0].name, 'Lightning Bolt');
    assert.strictEqual(errorResult.notFound.length, 1, 'Invalid card captured in notFound');
    assert.strictEqual(errorResult.notFound[0].requestedName, 'ThisCardDoesNotExistXYZ99999');
    assert.strictEqual(errorResult.notFound[0].reason, 'Card not found in Scryfall database');
    report('7. Live Scryfall not_found response handled gracefully without exceptions', true);
  } catch (e) {
    report('7. Live Scryfall not_found response handled gracefully without exceptions', false, e);
  }

  console.log(`\n=== LIVE TEST RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runLiveTests().catch(err => {
  console.error('Fatal live test failure:', err);
  process.exit(1);
});
