/**
 * Acceptance & Verification Test Suite for Feature 10: Deckbuilder AI Agent & Guideline Memory
 * Specification: SPEC-RPM-DECKAI-010
 * Decisions: DEC-013, DEC-015
 * Audio Reference: Audio Note 9
 * 
 * Validates all 14 Acceptance Test Cases:
 * - TC-DECKAI-01: Bounded Capacity Verification (INV-STORAGE-1)
 * - TC-DECKAI-02: 16KB Quota Guard Enforcement (INV-STORAGE-1)
 * - TC-DECKAI-03: Color Contradiction Recency Precedence (INV-STORAGE-2)
 * - TC-DECKAI-04: Reverse Recency Resolution (INV-STORAGE-2)
 * - TC-DECKAI-05: Feedback UI Hooks (DEC-013)
 * - TC-DECKAI-06: Precompiled Archetype Legality (INV-STORAGE-3)
 * - TC-DECKAI-07: Single-Color Beginner Mana Curve (INV-STORAGE-4)
 * - TC-DECKAI-08: Guideline-Driven Selection (Audio Note 9)
 * - TC-DECKAI-09: Avoidance Exclusion (Audio Note 9)
 * - TC-DECKAI-10: LLM Network Timeout Fallback (INV-STORAGE-3)
 * - TC-DECKAI-11: Malformed JSON Resilience (INV-STORAGE-3)
 * - TC-DECKAI-12: Top 10 Showcase Bounding & Sorting (INV-STORAGE-5)
 * - TC-DECKAI-13: Preview Card Integrity (Audio Note 9)
 * - TC-DECKAI-14: Storage Adapter Headless Environment Fallback (INV-STORAGE-1)
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import {
  StorageAdapter,
  calculatePayloadBytes,
  validateAndGuardGuidelineQuota,
  DeckbuilderAI,
  TAG_COLORS,
  TAG_ARCHETYPES,
  TAG_MECHANICS,
  TAG_TYPES,
  PRECOMPILED_ARCHETYPES,
  BEGINNER_DECKS,
  formatDeckForExport,
  resolveActiveGuidelines,
  calculateCompositeScore,
  updateTopShowcase
} from '../src/index.js';

let passed = 0;
let failed = 0;

function runTest(name, fn) {
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

async function runAsyncTest(name, fn) {
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

console.log('=== RUNNING FEATURE 10: DECKBUILDER AI & GUIDELINE MEMORY ACCEPTANCE TEST SUITE (SPEC-RPM-DECKAI-010) ===\n');

// -----------------------------------------------------------------------------
// TC-DECKAI-01: Bounded Capacity Verification (INV-STORAGE-1)
// -----------------------------------------------------------------------------
runTest('TC-DECKAI-01: Bounded Capacity Verification (INV-STORAGE-1)', () => {
  const adapter = new StorageAdapter({ isHeadless: true });
  const ai = new DeckbuilderAI({ storage: adapter, defaultUserId: 'test_p1' });

  // Add 12 distinct feedback guidelines sequentially
  for (let i = 1; i <= 12; i++) {
    ai.addPositiveFeedback(`Guideline #${i}`, `TAG_DISTINCT_${i}`, 1.0, 'test_p1', 1000 + i * 10);
  }

  const stored = adapter.getGuidelines('test_p1');
  const active = ai.getActiveGuidelines('test_p1');

  // Exactly 10 guidelines are retained
  assert.equal(stored.length, 10, 'Storage must retain exactly 10 guidelines');
  assert.equal(active.length, 10, 'Active guidelines must contain exactly 10 items');

  // Oldest 2 entries (TAG_DISTINCT_1 and TAG_DISTINCT_2) were evicted in FIFO order
  const storedTags = stored.map(g => g.targetTag);
  assert.equal(storedTags.includes('TAG_DISTINCT_1'), false, 'TAG_DISTINCT_1 should have been evicted');
  assert.equal(storedTags.includes('TAG_DISTINCT_2'), false, 'TAG_DISTINCT_2 should have been evicted');
  assert.equal(storedTags.includes('TAG_DISTINCT_3'), true, 'TAG_DISTINCT_3 should be retained');
  assert.equal(storedTags.includes('TAG_DISTINCT_12'), true, 'TAG_DISTINCT_12 should be retained');
});

// -----------------------------------------------------------------------------
// TC-DECKAI-02: 16KB Quota Guard Enforcement (INV-STORAGE-1)
// -----------------------------------------------------------------------------
runTest('TC-DECKAI-02: 16KB Quota Guard Enforcement (INV-STORAGE-1)', () => {
  const adapter = new StorageAdapter({ isHeadless: true });
  const uid = 'quota_test_user';

  // Seed with one valid guideline
  const initialGuidelines = [
    { id: 'initial_1', text: 'Valid preference', type: 'PREFERENCE', targetTag: 'COLOR_R', weight: 1, timestamp: 100 }
  ];
  adapter.saveGuidelines(uid, initialGuidelines);
  assert.equal(adapter.getGuidelines(uid).length, 1);

  // Construct oversized payload exceeding 16KB (16,384 bytes)
  const oversizedGuidelines = [];
  const largeString = 'X'.repeat(2500); // 2500 bytes each * 10 = 25KB > 16KB
  for (let i = 0; i < 10; i++) {
    oversizedGuidelines.push({
      id: `oversized_${i}`,
      text: `Oversized text payload: ${largeString}`,
      type: 'PREFERENCE',
      targetTag: `COLOR_${i}`,
      weight: 1,
      timestamp: 200 + i
    });
  }

  // Assert saveGuidelines throws explicit INV-STORAGE-1 Violation error
  assert.throws(
    () => {
      adapter.saveGuidelines(uid, oversizedGuidelines);
    },
    (err) => {
      return err.message && err.message.includes('INV-STORAGE-1 Violation');
    },
    'Should throw INV-STORAGE-1 Violation when exceeding 16KB quota'
  );

  // Assert previous storage was left uncorrupted
  const postAttempt = adapter.getGuidelines(uid);
  assert.equal(postAttempt.length, 1, 'Previous storage must remain intact');
  assert.equal(postAttempt[0].id, 'initial_1');
});

// -----------------------------------------------------------------------------
// TC-DECKAI-03: Color Contradiction Recency Precedence (INV-STORAGE-2)
// -----------------------------------------------------------------------------
runTest('TC-DECKAI-03: Color Contradiction Recency Precedence (INV-STORAGE-2)', () => {
  const ai = new DeckbuilderAI();

  const g1 = { id: '1', text: 'Love red', type: 'PREFERENCE', targetTag: 'COLOR_R', weight: 1, timestamp: 100 };
  const g2 = { id: '2', text: 'Hate red', type: 'AVOIDANCE', targetTag: 'COLOR_R', weight: -1, timestamp: 200 };

  const resolved = ai.resolveConflicts([g1, g2]);

  assert.equal(resolved.length, 1, 'Contradiction should reduce to 1 active rule');
  assert.equal(resolved[0].type, 'AVOIDANCE', 'Newer AVOIDANCE must override older PREFERENCE');
  assert.equal(resolved[0].targetTag, 'COLOR_R');
  assert.equal(resolved[0].timestamp, 200);
});

// -----------------------------------------------------------------------------
// TC-DECKAI-04: Reverse Recency Resolution (INV-STORAGE-2)
// -----------------------------------------------------------------------------
runTest('TC-DECKAI-04: Reverse Recency Resolution (INV-STORAGE-2)', () => {
  const ai = new DeckbuilderAI();

  const g1 = { id: '1', text: 'Hate blue', type: 'AVOIDANCE', targetTag: 'COLOR_U', weight: -1, timestamp: 100 };
  const g2 = { id: '2', text: 'Love blue', type: 'PREFERENCE', targetTag: 'COLOR_U', weight: 1, timestamp: 200 };

  const resolved = ai.resolveConflicts([g1, g2]);

  assert.equal(resolved.length, 1, 'Contradiction should reduce to 1 active rule');
  assert.equal(resolved[0].type, 'PREFERENCE', 'Newer PREFERENCE must override older AVOIDANCE');
  assert.equal(resolved[0].targetTag, 'COLOR_U');
  assert.equal(resolved[0].timestamp, 200);
});

// -----------------------------------------------------------------------------
// TC-DECKAI-05: Feedback UI Hooks (DEC-013)
// -----------------------------------------------------------------------------
runTest('TC-DECKAI-05: Feedback UI Hooks (DEC-013)', () => {
  const ai = new DeckbuilderAI({ defaultUserId: 'ui_hooks_user' });

  const activeAfterPos = ai.addPositiveFeedback('Prefer aggressive burn spells', 'ARCH_BURN', 2.5);
  const activeAfterNeg = ai.addNegativeFeedback('Avoid counterspells and permission', 'MECH_COUNTERSPELL', 1.0);

  const burnRule = activeAfterNeg.find(g => g.targetTag === 'ARCH_BURN');
  assert.ok(burnRule, 'Positive feedback rule should exist');
  assert.equal(burnRule.type, 'PREFERENCE');
  assert.equal(burnRule.text, 'Prefer aggressive burn spells');
  assert.equal(typeof burnRule.id, 'string');
  assert.ok(burnRule.weight > 0, 'PREFERENCE weight must be positive');
  assert.equal(typeof burnRule.timestamp, 'number');

  const counterRule = activeAfterNeg.find(g => g.targetTag === 'MECH_COUNTERSPELL');
  assert.ok(counterRule, 'Negative feedback rule should exist');
  assert.equal(counterRule.type, 'AVOIDANCE');
  assert.equal(counterRule.text, 'Avoid counterspells and permission');
  assert.equal(typeof counterRule.id, 'string');
  assert.ok(counterRule.weight < 0, 'AVOIDANCE weight must be negative');
  assert.equal(typeof counterRule.timestamp, 'number');
});

// -----------------------------------------------------------------------------
// TC-DECKAI-06: Precompiled Archetype Legality (INV-STORAGE-3)
// -----------------------------------------------------------------------------
runTest('TC-DECKAI-06: Precompiled Archetype Legality (INV-STORAGE-3)', () => {
  const ai = new DeckbuilderAI();
  const archetypes = ai.getPrecompiledArchetypes();

  assert.equal(archetypes.length, 5, 'Must provide exactly 5 starter archetypes');

  const expectedNames = [
    'Mono-Red Burn',
    'Izzet Murktide',
    'Golgari Yawgmoth',
    'Mono-Green Tron',
    'Temur Rhinos'
  ];

  const actualNames = archetypes.map(a => a.archetype);
  for (const exp of expectedNames) {
    assert.ok(actualNames.includes(exp), `Archetype ${exp} must be present`);
  }

  const basicLands = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'];

  for (const arch of archetypes) {
    const mainCount = arch.mainboard.reduce((acc, c) => acc + c.count, 0);
    const sideCount = arch.sideboard.reduce((acc, c) => acc + c.count, 0);

    assert.equal(mainCount, 60, `${arch.archetype} mainboard must contain exactly 60 cards`);
    assert.equal(sideCount, 15, `${arch.archetype} sideboard must contain exactly 15 cards`);
    assert.ok(Array.isArray(arch.colorIdentity) && arch.colorIdentity.length >= 1, `${arch.archetype} must have color identity`);

    // 4-of Rule validation
    for (const card of arch.mainboard) {
      if (!basicLands.includes(card.name)) {
        assert.ok(card.count <= 4, `${card.name} in ${arch.archetype} violates 4-of limit: ${card.count}`);
      }
    }
  }
});

// -----------------------------------------------------------------------------
// TC-DECKAI-07: Single-Color Beginner Mana Curve (INV-STORAGE-4)
// -----------------------------------------------------------------------------
runTest('TC-DECKAI-07: Single-Color Beginner Mana Curve (INV-STORAGE-4)', () => {
  const ai = new DeckbuilderAI();
  const colors = ['W', 'U', 'B', 'R', 'G'];
  const basicLands = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

  for (const color of colors) {
    const result = ai.generateBeginnerDeck(color);
    assert.equal(result.success, true);
    assert.equal(result.source, 'OFFLINE_FAST_PATH');

    const deck = result.deck;
    const totalCards = deck.mainboard.reduce((acc, c) => acc + c.count, 0);
    assert.equal(totalCards, 60, `${color} deck must contain exactly 60 cards`);

    const landCards = deck.mainboard.filter(c => c.type === 'Land');
    const landCount = landCards.reduce((acc, c) => acc + c.count, 0);
    assert.ok(landCount >= 22 && landCount <= 24, `${color} land count (${landCount}) must be between 22 and 24`);

    const cmc1Count = deck.mainboard
      .filter(c => c.type !== 'Land' && c.cmc === 1)
      .reduce((acc, c) => acc + c.count, 0);
    assert.ok(cmc1Count >= 8, `${color} 1-CMC count (${cmc1Count}) must be >= 8`);

    const cmc2Count = deck.mainboard
      .filter(c => c.type !== 'Land' && c.cmc === 2)
      .reduce((acc, c) => acc + c.count, 0);
    assert.ok(cmc2Count >= 10, `${color} 2-CMC count (${cmc2Count}) must be >= 10`);

    // Max copies per non-basic card <= 4
    for (const card of deck.mainboard) {
      if (!basicLands.includes(card.name)) {
        assert.ok(card.count <= 4, `${card.name} in ${color} exceeds 4 copies: ${card.count}`);
      }
    }
  }
});

// -----------------------------------------------------------------------------
// TC-DECKAI-08: Guideline-Driven Selection (Audio Note 9)
// -----------------------------------------------------------------------------
await runAsyncTest('TC-DECKAI-08: Guideline-Driven Selection (Audio Note 9)', async () => {
  const ai = new DeckbuilderAI({ defaultUserId: 'burn_fan_user' });

  ai.addPositiveFeedback('Love playing mono-red burn with high tempo', 'COLOR_R', 2.0);
  ai.addPositiveFeedback('Prefer aggressive direct damage burn strategy', 'ARCH_BURN', 2.0);

  const result = await ai.generateDeck({ allowLLM: false, userId: 'burn_fan_user' });

  assert.equal(result.success, true);
  assert.equal(result.source, 'OFFLINE_FAST_PATH');
  assert.equal(result.deck.archetype, 'Mono-Red Burn', 'Must select Mono-Red Burn when guidelines favor R and ARCH_BURN');
});

// -----------------------------------------------------------------------------
// TC-DECKAI-09: Avoidance Exclusion (Audio Note 9)
// -----------------------------------------------------------------------------
await runAsyncTest('TC-DECKAI-09: Avoidance Exclusion (Audio Note 9)', async () => {
  const ai = new DeckbuilderAI({ defaultUserId: 'no_red_user' });

  ai.addNegativeFeedback('Avoid red cards completely', 'COLOR_R', 2.0);

  const result = await ai.generateDeck({ allowLLM: false, userId: 'no_red_user' });

  assert.equal(result.success, true);
  assert.notEqual(result.deck.archetype, 'Mono-Red Burn', 'Mono-Red Burn must be completely disqualified');
  assert.equal(result.deck.colorIdentity.includes('R'), false, 'Selected archetype must not contain red');
});

// -----------------------------------------------------------------------------
// TC-DECKAI-10: LLM Network Timeout Fallback (INV-STORAGE-3)
// -----------------------------------------------------------------------------
await runAsyncTest('TC-DECKAI-10: LLM Network Timeout Fallback (INV-STORAGE-3)', async () => {
  // Spin up a mock hanging HTTP server that never sends a response
  const server = http.createServer((req, res) => {
    // Deliberately keep socket open and hang
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const ai = new DeckbuilderAI();
  const startTime = Date.now();

  const result = await ai.generateDeck({
    allowLLM: true,
    endpoint: `http://127.0.0.1:${port}/mock-llm`,
    apiKey: 'mock-key',
    timeoutMs: 1500 // Quick timeout budget for the test runner
  });

  const durationMs = Date.now() - startTime;
  server.close();

  assert.ok(durationMs <= 4500, `Execution took ${durationMs}ms; must complete in <= 4500ms`);
  assert.equal(result.success, true);
  assert.equal(result.source, 'OFFLINE_FALLBACK', 'Must degrade to OFFLINE_FALLBACK');
  assert.ok(result.deck, 'Must supply fallback deck');
  assert.equal(result.deck.mainboard.reduce((acc, c) => acc + c.count, 0), 60);
  assert.ok(result.warnings.length > 0, 'Must record timeout warning in result');
});

// -----------------------------------------------------------------------------
// TC-DECKAI-11: Malformed JSON Resilience (INV-STORAGE-3)
// -----------------------------------------------------------------------------
await runAsyncTest('TC-DECKAI-11: Malformed JSON Resilience (INV-STORAGE-3)', async () => {
  // Mock server returning malformed JSON or 50-card deck
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Invalid card count (50 instead of 60)
    res.end(JSON.stringify({
      archetype: 'BrokenDeck',
      mainboard: [
        { name: 'Mountain', count: 50, cmc: 0, type: 'Land' }
      ]
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const ai = new DeckbuilderAI();
  const result = await ai.generateDeck({
    allowLLM: true,
    endpoint: `http://127.0.0.1:${port}/bad-json`,
    apiKey: 'test-key',
    timeoutMs: 2000
  });

  server.close();

  assert.equal(result.success, true);
  assert.equal(result.source, 'OFFLINE_FALLBACK', 'Schema violation must trigger OFFLINE_FALLBACK');
  assert.equal(result.deck.mainboard.reduce((acc, c) => acc + c.count, 0), 60);
  assert.ok(result.warnings.some(w => w.includes('Mode B degraded to Mode A')));
});

// -----------------------------------------------------------------------------
// TC-DECKAI-12: Top 10 Showcase Bounding & Sorting (INV-STORAGE-5)
// -----------------------------------------------------------------------------
await runAsyncTest('TC-DECKAI-12: Top 10 Showcase Bounding & Sorting (INV-STORAGE-5)', async () => {
  const adapter = new StorageAdapter({ isHeadless: true });
  const ai = new DeckbuilderAI({ storage: adapter });

  // Ingest 15 candidate decks with varying stats
  for (let i = 1; i <= 15; i++) {
    const candidate = {
      id: `deck_cand_${i}`,
      title: `Championship Deck #${i}`,
      creatorId: `creator_${i}`,
      creatorName: `Player_${i}`,
      elo: 1100 + i * 20,
      winRate: Math.min(1.0, 0.40 + (i * 0.04)),
      matchesPlayed: i * 8,
      mainboard: [
        { name: 'Mountain', count: 20, cmc: 0, type: 'Land' },
        { name: 'Lightning Bolt', count: 4, cmc: 1, type: 'Instant' },
        { name: 'Goblin Guide', count: 4, cmc: 1, type: 'Creature' },
        { name: 'Monastery Swiftspear', count: 4, cmc: 1, type: 'Creature' },
        { name: 'Lava Spike', count: 4, cmc: 1, type: 'Sorcery' },
        { name: 'Rift Bolt', count: 4, cmc: 3, type: 'Sorcery' },
        { name: 'Searing Blaze', count: 4, cmc: 2, type: 'Instant' },
        { name: 'Skewer the Critics', count: 4, cmc: 3, type: 'Sorcery' },
        { name: 'Roiling Vortex', count: 4, cmc: 2, type: 'Enchantment' },
        { name: 'Eidolon of the Great Revel', count: 4, cmc: 2, type: 'Creature' },
        { name: 'Shard Volley', count: 4, cmc: 1, type: 'Instant' }
      ]
    };
    await ai.updateShowcase(candidate);
  }

  const top10 = await ai.getTopShowcase();

  // Exactly 10 decks retained
  assert.equal(top10.length, 10, 'Showcase must bound strictly to Top 10');

  // Sorted monotonically by compositeScore descending
  for (let i = 0; i < top10.length - 1; i++) {
    assert.ok(
      top10[i].compositeScore >= top10[i + 1].compositeScore,
      `Rank ${top10[i].rank} (${top10[i].compositeScore}) must be >= Rank ${top10[i + 1].rank} (${top10[i + 1].compositeScore})`
    );
    assert.equal(top10[i].rank, i + 1, `Rank index must be monotonically 1..10`);
  }
  assert.equal(top10[9].rank, 10);
});

// -----------------------------------------------------------------------------
// TC-DECKAI-13: Preview Card Integrity (Audio Note 9)
// -----------------------------------------------------------------------------
await runAsyncTest('TC-DECKAI-13: Preview Card Integrity (Audio Note 9)', async () => {
  const adapter = new StorageAdapter({ isHeadless: true });
  const ai = new DeckbuilderAI({ storage: adapter });

  // Ingest deck with explicit previewCards
  await ai.updateShowcase({
    id: 'deck_with_previews',
    title: 'Murktide Master',
    creatorId: 'c1',
    creatorName: 'Augusto',
    elo: 1650,
    winRate: 0.72,
    matchesPlayed: 85,
    previewCards: ['Murktide Regent', "Dragon's Rage Channeler", 'Counterspell', 'Ragavan, Nimble Pilferer'],
    exportText: 'Deck\n4 Murktide Regent\n4 Counterspell'
  });

  const showcase = await ai.getTopShowcase();
  assert.ok(showcase.length >= 1);

  for (const deck of showcase) {
    assert.ok(Array.isArray(deck.previewCards), 'previewCards must be an array');
    assert.ok(
      deck.previewCards.length >= 3 && deck.previewCards.length <= 5,
      `previewCards length (${deck.previewCards.length}) must be between 3 and 5`
    );
    for (const card of deck.previewCards) {
      assert.equal(typeof card, 'string', 'Card preview item must be string');
      assert.ok(card.trim().length > 0, 'Card preview must not be empty');
    }
    assert.equal(typeof deck.exportText, 'string', 'exportText must be string');
    assert.ok(deck.exportText.includes('Deck'), 'exportText must contain valid MTG Arena deck format');
  }
});

// -----------------------------------------------------------------------------
// TC-DECKAI-14: Storage Adapter Headless Environment Fallback (INV-STORAGE-1)
// -----------------------------------------------------------------------------
await runAsyncTest('TC-DECKAI-14: Storage Adapter Headless Environment Fallback (INV-STORAGE-1)', async () => {
  // Construct adapter explicitly enforcing isHeadless
  const storage = new StorageAdapter({ isHeadless: true });

  // 1. Guidelines in headless
  storage.saveGuidelines('headless_user', [
    { id: 'h1', text: 'Headless rule 1', type: 'PREFERENCE', targetTag: 'COLOR_G', weight: 1, timestamp: 100 }
  ]);
  const guides = storage.getGuidelines('headless_user');
  assert.equal(guides.length, 1);
  assert.equal(guides[0].id, 'h1');

  // 2. Decks in headless
  await storage.saveDeck({
    id: 'headless_deck_1',
    userId: 'headless_user',
    title: 'Tron Headless',
    totalCards: 60
  });
  const fetchedDeck = await storage.getDeck('headless_deck_1');
  assert.ok(fetchedDeck);
  assert.equal(fetchedDeck.title, 'Tron Headless');

  const deckList = await storage.getDecks('headless_user');
  assert.equal(deckList.length, 1);

  // 3. Showcase in headless
  await storage.saveTopShowcase([
    { id: 's1', rank: 1, title: 'Showcase 1', compositeScore: 2400 }
  ]);
  const fetchedShowcase = await storage.getTopShowcase();
  assert.equal(fetchedShowcase.length, 1);
  assert.equal(fetchedShowcase[0].compositeScore, 2400);

  // 4. Clear all in headless
  await storage.clearAll();
  assert.equal(storage.getGuidelines('headless_user').length, 0);
  assert.equal((await storage.getDecks('headless_user')).length, 0);
  assert.equal((await storage.getTopShowcase()).length, 0);
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
console.log(`\n==============================================`);
console.log(`ACCEPTANCE TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log(`==============================================`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
