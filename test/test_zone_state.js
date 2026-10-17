/**
 * Automated Verification Test Suite for RPM Tabletop Zone State Manager & Fog-of-War Projection
 * Validates all 12 test cases from Section 7 of SPEC-RPM-ZONE-003.
 */

import assert from 'node:assert/strict';
import { TabletopStateManager, projectState } from '../src/TabletopStateManager.js';
import {
  ZoneModel,
  classifySubzone,
  generateInstanceId,
  StateTransitionError,
  CardNotFoundError,
  InvalidZoneError,
  InvalidCardTypeError,
  InsufficientManaError,
  PermanentAlreadyTappedError
} from '../src/ZoneModel.js';

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

console.log('=== RUNNING SPEC-RPM-ZONE-003 TEST SUITE ===\n');

// Build 60-card deterministic test fixture
function create60CardDeck() {
  const cards = [];

  // Starting 7 cards for initial hand draw:
  cards.push({ count: 2, name: 'Lightning Bolt', typeLine: 'Instant', manaCost: '{R}', oracleText: 'Lightning Bolt deals 3 damage to any target.' });
  cards.push({ count: 2, name: 'Mountain', typeLine: 'Basic Land — Mountain', manaCost: '', oracleText: '{T}: Add {R}.' });
  cards.push({ count: 2, name: 'Ragavan, Nimble Pilferer', typeLine: 'Legendary Creature — Monkey Pirate', manaCost: '{R}', oracleText: 'Dash {1}{R}' });
  cards.push({ count: 1, name: 'Jace, the Mind Sculptor', typeLine: 'Legendary Planeswalker — Jace', manaCost: '{2}{U}{U}', oracleText: '' });

  // Top of library for Test Case 2 draw:
  cards.push({ count: 1, name: 'Mountain', typeLine: 'Basic Land — Mountain', manaCost: '', oracleText: '{T}: Add {R}.' });

  // Remaining 52 cards:
  cards.push({ count: 21, name: 'Mountain', typeLine: 'Basic Land — Mountain', manaCost: '', oracleText: '{T}: Add {R}.' });
  cards.push({ count: 2, name: 'Ragavan, Nimble Pilferer', typeLine: 'Legendary Creature — Monkey Pirate', manaCost: '{R}', oracleText: 'Dash {1}{R}' });
  cards.push({ count: 2, name: 'Lightning Bolt', typeLine: 'Instant', manaCost: '{R}', oracleText: 'Lightning Bolt deals 3 damage to any target.' });
  cards.push({ count: 3, name: 'Jace, the Mind Sculptor', typeLine: 'Legendary Planeswalker — Jace', manaCost: '{2}{U}{U}', oracleText: '' });
  cards.push({ count: 4, name: 'Counterspell', typeLine: 'Instant', manaCost: '{U}{U}', oracleText: 'Counter target spell.' });
  cards.push({ count: 4, name: 'Murktide Regent', typeLine: 'Creature — Dragon', manaCost: '{5}{U}{U}', oracleText: 'Delve, Flying' });
  cards.push({ count: 4, name: "Dragon's Rage Channeler", typeLine: 'Creature — Human Shaman', manaCost: '{R}', oracleText: 'Surveil 1' });
  cards.push({ count: 4, name: "Mishra's Bauble", typeLine: 'Artifact', manaCost: '{0}', oracleText: 'Draw a card next turn.' });
  cards.push({ count: 4, name: 'Unholy Heat', typeLine: 'Instant', manaCost: '{R}', oracleText: 'Deal 2 damage.' });
  cards.push({ count: 4, name: 'Scalding Tarn', typeLine: 'Land', manaCost: '', oracleText: 'Fetch.' });

  return cards;
}

// Shared State Manager Instance
const stateManager = new TabletopStateManager({ sessionId: 'spec_zone_session_001' });
stateManager.registerPlayer('p1', 'Player 1');
stateManager.registerPlayer('p2', 'Player 2');
const player = stateManager.players.p1;

// Test Case 1: INITIALIZE_DECK and Starting Hand Allocation
test('Test Case 1: INITIALIZE_DECK and Starting Hand Allocation', () => {
  const deck = create60CardDeck();
  stateManager.dispatch('INITIALIZE_DECK', {
    playerId: 'p1',
    hydratedCards: deck,
    options: {
      startingHandSize: 7,
      startingLife: 20,
      skipShuffle: true
    }
  });

  assert.equal(player.library.length, 53);
  assert.equal(player.hand.length, 7);
  assert.equal(player.resources.life, 20);
  assert.equal(player.resources.poison, 0);
  assert.equal(player.resources.manaPool.R, 0);

  // Verify all 60 card instances have unique instance IDs
  const allIds = new Set([...player.library, ...player.hand].map(c => c.instanceId));
  assert.equal(allIds.size, 60);
});

// Test Case 2: DRAW_CARD Top-of-Library Transition
test('Test Case 2: DRAW_CARD Top-of-Library Transition', () => {
  const topCardBefore = player.library[0];
  stateManager.dispatch('DRAW_CARD', { playerId: 'p1', count: 1 });

  assert.equal(player.library.length, 52);
  assert.equal(player.hand.length, 8);
  assert.equal(player.hand[player.hand.length - 1].instanceId, topCardBefore.instanceId);
  assert.equal(player.hand[player.hand.length - 1].zone, 'hand');
});

// Test Case 3: PLAY_LAND Type Line Validation & Subzone Routing
test('Test Case 3: PLAY_LAND Type Line Validation & Subzone Routing', () => {
  const landCard = player.hand.find(c => c.typeLine.includes('Land'));
  assert.ok(landCard, 'Must have a land card in hand');

  stateManager.dispatch('PLAY_LAND', { playerId: 'p1', instanceId: landCard.instanceId });

  assert.equal(player.battlefield.lands.length, 1);
  assert.equal(player.battlefield.lands[0].instanceId, landCard.instanceId);
  assert.equal(player.battlefield.lands[0].isTapped, false);
  assert.equal(player.battlefield.lands[0].subzone, 'lands');

  // Attempt to play a non-land creature as land -> should throw error
  const creatureCard = player.hand.find(c => c.typeLine.includes('Creature'));
  assert.ok(creatureCard, 'Must have a creature card in hand');

  assert.throws(() => {
    stateManager.dispatch('PLAY_LAND', { playerId: 'p1', instanceId: creatureCard.instanceId });
  }, /InvalidCardTypeError|Card is not a land/);
});

// Test Case 4: CAST_SPELL Stack Transition & Mana Deduction
test('Test Case 4: CAST_SPELL Stack Transition & Mana Deduction', () => {
  stateManager.dispatch('UPDATE_MANA_POOL', { playerId: 'p1', poolDelta: { R: 2, U: 1 } });
  const bolt = player.hand.find(c => c.name === 'Lightning Bolt');
  assert.ok(bolt, 'Must have Lightning Bolt in hand');

  stateManager.dispatch('CAST_SPELL', {
    playerId: 'p1',
    instanceId: bolt.instanceId,
    manaCostPaid: { R: 1 }
  });

  assert.equal(stateManager.stack.length, 1);
  assert.equal(stateManager.stack[0].instanceId, bolt.instanceId);
  assert.equal(stateManager.stack[0].zone, 'stack');
  assert.equal(player.resources.manaPool.R, 1);
  assert.equal(player.resources.manaPool.U, 1);
});

// Test Case 5: TAP_PERMANENT, UNTAP_PERMANENT, and UNTAP_ALL
test('Test Case 5: TAP_PERMANENT, UNTAP_PERMANENT, and UNTAP_ALL', () => {
  const land = player.battlefield.lands[0];
  assert.ok(land, 'Must have a land on the battlefield');

  stateManager.dispatch('TAP_PERMANENT', { playerId: 'p1', instanceId: land.instanceId });
  assert.equal(land.isTapped, true);

  // Tapping an already tapped permanent must reject with PermanentAlreadyTappedError
  assert.throws(() => {
    stateManager.dispatch('TAP_PERMANENT', { playerId: 'p1', instanceId: land.instanceId });
  }, /PermanentAlreadyTappedError/);

  stateManager.dispatch('UNTAP_PERMANENT', { playerId: 'p1', instanceId: land.instanceId });
  assert.equal(land.isTapped, false);

  stateManager.dispatch('TAP_PERMANENT', { playerId: 'p1', instanceId: land.instanceId });
  assert.equal(land.isTapped, true);

  stateManager.dispatch('UNTAP_ALL', { playerId: 'p1' });
  assert.equal(land.isTapped, false);
});

// Test Case 6: MOVE_ZONE from Battlefield to Graveyard with State Cleanup
test('Test Case 6: MOVE_ZONE from Battlefield to Graveyard with State Cleanup', () => {
  // Move creature to battlefield, tap it, add +1/+1 counter
  const creature = player.hand.find(c => c.typeLine.includes('Creature'));
  assert.ok(creature, 'Must have creature in hand');

  stateManager.dispatch('MOVE_ZONE', {
    playerId: 'p1',
    instanceId: creature.instanceId,
    targetZone: 'battlefield'
  });
  stateManager.dispatch('TAP_PERMANENT', { playerId: 'p1', instanceId: creature.instanceId });
  stateManager.dispatch('MODIFY_COUNTERS', { playerId: 'p1', instanceId: creature.instanceId, counterType: '+1/+1', delta: 2 });

  assert.equal(creature.isTapped, true);
  assert.equal(creature.counters['+1/+1'], 2);

  // Move to Graveyard (e.g. dies)
  stateManager.dispatch('MOVE_ZONE', {
    playerId: 'p1',
    instanceId: creature.instanceId,
    targetZone: 'graveyard'
  });

  assert.equal(player.graveyard.length, 1);
  const deadCreature = player.graveyard[0];
  assert.equal(deadCreature.isTapped, false);
  assert.deepEqual(deadCreature.counters, {});
  assert.equal(deadCreature.zone, 'graveyard');
});

// Test Case 7: ADJUST_LIFE Delta and Absolute Targeting
test('Test Case 7: ADJUST_LIFE Delta and Absolute Targeting', () => {
  stateManager.dispatch('ADJUST_LIFE', { playerId: 'p1', delta: -3 });
  assert.equal(player.resources.life, 17);

  stateManager.dispatch('ADJUST_LIFE', { playerId: 'p1', delta: +5 });
  assert.equal(player.resources.life, 22);

  stateManager.dispatch('ADJUST_LIFE', { playerId: 'p1', targetValue: 10 });
  assert.equal(player.resources.life, 10);
});

// Test Case 8: UPDATE_MANA_POOL Multi-Color Operations & Non-Negative Invariant
test('Test Case 8: UPDATE_MANA_POOL Multi-Color Operations & Non-Negative Invariant', () => {
  // Clear floating mana first to establish fresh pool state
  stateManager.dispatch('UPDATE_MANA_POOL', { playerId: 'p1', clearAll: true });

  stateManager.dispatch('UPDATE_MANA_POOL', { playerId: 'p1', poolDelta: { W: 1, U: 2, B: 0, R: 3, G: 0, C: 1 } });
  assert.deepEqual(player.resources.manaPool, { W: 1, U: 2, B: 0, R: 3, G: 0, C: 1 });

  stateManager.dispatch('UPDATE_MANA_POOL', { playerId: 'p1', poolDelta: { R: -2 } });
  assert.equal(player.resources.manaPool.R, 1);

  // Attempt to spend more mana than available -> must throw error
  assert.throws(() => {
    stateManager.dispatch('UPDATE_MANA_POOL', { playerId: 'p1', poolDelta: { W: -2 } });
  }, /InsufficientManaError|Cannot reduce mana below 0/);
});

// Test Case 9: Fog-of-War Projection: Active Owner vs Opponent
test('Test Case 9: Fog-of-War Projection: Active Owner vs Opponent', () => {
  const ownerProjection = stateManager.projectState('p1');
  const opponentProjection = stateManager.projectState('p2');

  // Owner view: Full hand visibility
  assert.equal(ownerProjection.players.p1.hand.count, player.hand.length);
  assert.ok(ownerProjection.players.p1.hand.cards[0].name);
  assert.ok(ownerProjection.players.p1.hand.cards[0].manaCost);

  // Opponent view: Masked hand
  const oppHand = opponentProjection.players.p1.hand;
  assert.equal(oppHand.count, player.hand.length);
  assert.equal(oppHand.isRevealed, false);
  assert.equal(oppHand.cards.length, player.hand.length);
  assert.equal(oppHand.cards[0].instanceId, 'hidden');
  assert.equal(oppHand.cards[0].isHidden, true);
  assert.equal(oppHand.cards[0].name, undefined);
  assert.equal(oppHand.cards[0].manaCost, undefined);
  assert.equal(oppHand.cards[0].oracleText, undefined);

  // Both views see library as count only
  assert.equal(ownerProjection.players.p1.library.count, 52);
  assert.equal(ownerProjection.players.p1.library.cards, undefined);
  assert.equal(opponentProjection.players.p1.library.count, 52);
  assert.equal(opponentProjection.players.p1.library.cards, undefined);
});

// Test Case 10: Fog-of-War Hand Reveal Mechanics
test('Test Case 10: Fog-of-War Hand Reveal Mechanics', () => {
  stateManager.dispatch('REVEAL_HAND', { playerId: 'p1', isRevealed: true });
  const revealedProjection = stateManager.projectState('p2');
  assert.equal(revealedProjection.players.p1.hand.isRevealed, true);
  assert.ok(revealedProjection.players.p1.hand.cards[0].name);
  assert.notEqual(revealedProjection.players.p1.hand.cards[0].instanceId, 'hidden');

  stateManager.dispatch('REVEAL_HAND', { playerId: 'p1', isRevealed: false });
  const hiddenProjection = stateManager.projectState('p2');
  assert.equal(hiddenProjection.players.p1.hand.isRevealed, false);
  assert.equal(hiddenProjection.players.p1.hand.cards[0].instanceId, 'hidden');
  assert.equal(hiddenProjection.players.p1.hand.cards[0].name, undefined);
});

// Test Case 11: Error Rejection on Invalid Move / Non-Existent Card
test('Test Case 11: Error Rejection on Invalid Move / Non-Existent Card', () => {
  assert.throws(() => {
    stateManager.dispatch('MOVE_ZONE', {
      playerId: 'p1',
      instanceId: 'inst_fake_999999',
      targetZone: 'graveyard'
    });
  }, /CardNotFoundError/);

  assert.throws(() => {
    stateManager.dispatch('TAP_PERMANENT', {
      playerId: 'p1',
      instanceId: player.hand[0].instanceId // In hand, not battlefield
    });
  }, /InvalidZoneError/);
});

// Test Case 12: Card Count Conservation Across Zone Cycles
test('Test Case 12: Card Count Conservation Across Zone Cycles', () => {
  const startingTotal = 60;

  // Execute sequence of 10 rapid zone transitions
  // 1. Draw a card (lib -> hand)
  stateManager.dispatch('DRAW_CARD', { playerId: 'p1', count: 1 });

  // 2. Cast card from hand (hand -> stack)
  const spellCard = player.hand[0];
  stateManager.dispatch('MOVE_ZONE', { playerId: 'p1', instanceId: spellCard.instanceId, targetZone: 'stack' });

  // 3. Resolve to battlefield (stack -> battlefield)
  stateManager.dispatch('MOVE_ZONE', { playerId: 'p1', instanceId: spellCard.instanceId, targetZone: 'battlefield' });

  // 4. Destroy permanent (battlefield -> graveyard)
  stateManager.dispatch('MOVE_ZONE', { playerId: 'p1', instanceId: spellCard.instanceId, targetZone: 'graveyard' });

  // 5. Exile from graveyard (graveyard -> exile)
  stateManager.dispatch('MOVE_ZONE', { playerId: 'p1', instanceId: spellCard.instanceId, targetZone: 'exile' });

  // 6. Return from exile to hand (exile -> hand)
  stateManager.dispatch('MOVE_ZONE', { playerId: 'p1', instanceId: spellCard.instanceId, targetZone: 'hand' });

  // 7. Tuck to bottom of library (hand -> library bottom)
  stateManager.dispatch('MOVE_ZONE', { playerId: 'p1', instanceId: spellCard.instanceId, targetZone: 'library', position: 'bottom' });

  // 8. Draw another card (library -> hand)
  stateManager.dispatch('DRAW_CARD', { playerId: 'p1', count: 1 });

  // 9. Discard top card of hand (hand -> graveyard)
  const discardCard = player.hand[player.hand.length - 1];
  stateManager.dispatch('MOVE_ZONE', { playerId: 'p1', instanceId: discardCard.instanceId, targetZone: 'graveyard' });

  // 10. Flashback / Exile from graveyard (graveyard -> exile)
  stateManager.dispatch('MOVE_ZONE', { playerId: 'p1', instanceId: discardCard.instanceId, targetZone: 'exile' });

  // Verify total card count invariant across all zones
  const p1 = stateManager.players.p1;
  const currentTotal = p1.library.length +
                       p1.hand.length +
                       p1.battlefield.lands.length +
                       p1.battlefield.creatures.length +
                       p1.battlefield.noncreatures.length +
                       p1.battlefield.planeswalkers.length +
                       p1.graveyard.length +
                       p1.exile.length +
                       stateManager.stack.filter(c => c.ownerId === 'p1').length;

  assert.equal(currentTotal, startingTotal, `Total card count must remain exactly ${startingTotal} (got ${currentTotal})`);
});

// Additional ZoneModel Unit Invariant Checks
test('Additional: Fisher-Yates shuffle preserves elements', () => {
  const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const shuffled = ZoneModel.shuffleArray([...original]);
  assert.equal(shuffled.length, 10);
  assert.deepEqual(new Set(shuffled), new Set(original));
});

test('Additional: classifySubzone handles all MTG core card types', () => {
  assert.equal(classifySubzone('Planeswalker — Chandra'), 'planeswalkers');
  assert.equal(classifySubzone('Artifact Creature — Construct'), 'creatures');
  assert.equal(classifySubzone('Legendary Creature — Elf Druid'), 'creatures');
  assert.equal(classifySubzone('Basic Land — Island'), 'lands');
  assert.equal(classifySubzone('Artifact'), 'noncreatures');
  assert.equal(classifySubzone('Enchantment — Saga'), 'noncreatures');
  assert.equal(classifySubzone('Battle — Siege'), 'noncreatures');
});

test('Additional: projectState deep-cloning immutability guarantees', () => {
  const proj = stateManager.projectState('p1');
  const p1Internal = stateManager.players.p1;

  // 1. Mutating projected card properties does not affect internal card
  const originalHandName = p1Internal.hand[0].name;
  proj.players.p1.hand.cards[0].name = 'MUTATED_NAME';
  assert.equal(p1Internal.hand[0].name, originalHandName);

  // 2. Mutating projected mana pool does not affect internal pool
  const originalLife = p1Internal.resources.life;
  proj.players.p1.resources.life = 999;
  assert.equal(p1Internal.resources.life, originalLife);

  const originalR = p1Internal.resources.manaPool.R;
  proj.players.p1.resources.manaPool.R = 999;
  assert.equal(p1Internal.resources.manaPool.R, originalR);

  // 3. Mutating projected battlefield arrays does not affect internal battlefield
  const originalLandCount = p1Internal.battlefield.lands.length;
  proj.players.p1.battlefield.lands.push({ name: 'Fake Land' });
  assert.equal(p1Internal.battlefield.lands.length, originalLandCount);

  // 4. Mutating projected stack does not affect internal stack
  const originalStackCount = stateManager.stack.length;
  proj.stack.push({ name: 'Fake Stack Spell' });
  assert.equal(stateManager.stack.length, originalStackCount);
});

console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
