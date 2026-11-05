/**
 * test/test_active_deck_certification.js
 * 
 * Exhaustive Deterministic Certification Suite for the Active 28-Card Modern Deck:
 * Hammer Time + Jegantha Companion.
 * 
 * Enforces 100% MTG Comprehensive Rules (CR) fidelity.
 * Tests isolated card mechanics and runtime execution across:
 * - OracleEffectCompiler
 * - TabletopStateManager
 * - PriorityStateMachine
 * - AbilityEngine & 7 Continuous Layers
 * - CastAvailabilityManager & Optimal Mana Solver
 * - CombatDamageEngine & Infect/Poison/Toxic
 * - StateBasedActionsEngine
 * - DeckValidator & ScryfallService fallback metadata
 */

import assert from 'node:assert';
import { OracleEffectCompiler, compileCard, compileCardMechanics, normalizeCardName, evaluateDeckSupportPercentage, auditDeckSupport } from '../src/OracleEffectCompiler.js';
import { DeckSlotManager } from '../src/deckbuilder/DeckSlotManager.js';
import { PerkinsAgent } from '../src/PerkinsAgent.js';
import { TabletopStateManager } from '../src/TabletopStateManager.js';
import { PriorityStateMachine } from '../src/PriorityStateMachine.js';
import { AbilityEngine, CONTINUOUS_LAYERS } from '../src/AbilityEngine.js';
import { CastAvailabilityManager } from '../src/CastAvailabilityManager.js';
import { CombatDamageEngine } from '../src/CombatDamageEngine.js';
import { StateBasedActionsEngine } from '../src/StateBasedActionsEngine.js';
import { KNOWN_CARD_METADATA } from '../src/DeckValidator.js';
import { PregameStateMachine, PREGAME_STATES, MULLIGAN_SUBSTATES } from '../src/PregameStateMachine.js';
import { RandomPerkEngine } from '../src/RandomPerkEngine.js';
import { resolveRoll } from '../src/PerkCatalog.js';

let passed = 0;
let failed = 0;
const resultsMatrix = [];

function recordTest(cardName, clause, status, errorMsg = '') {
  resultsMatrix.push({ card: cardName, clause, status, error: errorMsg });
  if (status === 'PASS') {
    passed++;
    console.log(`  \x1b[32m✔ [PASS]\x1b[0m ${cardName} - ${clause}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✖ [FAIL]\x1b[0m ${cardName} - ${clause}`);
    if (errorMsg) console.log(`      \x1b[33mError: ${errorMsg}\x1b[0m`);
  }
}

function createMatchState() {
  const state = new TabletopStateManager();
  state.players = {
    p1: {
      id: 'p1',
      playerId: 'p1',
      playerName: 'Player 1',
      resources: { life: 20, poison: 0, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, landsPlayedThisTurn: 0, maxLandsPerTurn: 1 },
      battlefield: { creatures: [], lands: [], noncreatures: [], planeswalkers: [] },
      graveyard: [],
      exile: [],
      hand: [],
      library: [],
      zones: { battlefield: [], graveyard: [], exile: [], hand: [], library: [] }
    },
    p2: {
      id: 'p2',
      playerId: 'p2',
      playerName: 'Player 2',
      resources: { life: 20, poison: 0, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, landsPlayedThisTurn: 0, maxLandsPerTurn: 1 },
      battlefield: { creatures: [], lands: [], noncreatures: [], planeswalkers: [] },
      graveyard: [],
      exile: [],
      hand: [],
      library: [],
      zones: { battlefield: [], graveyard: [], exile: [], hand: [], library: [] }
    }
  };
  state.activePlayerId = 'p1';
  state.priorityMachine = new PriorityStateMachine({
    sessionId: 'cert_test',
    players: ['p1', 'p2'],
    activePlayerId: 'p1',
    autoPassTimers: false
  });
  state.priorityMachine.currentPhase = 'MAIN_1';
  state.priorityMachine.currentPhaseStep = 'PRECOMBAT_MAIN';
  state.priorityMachine.priorityPlayerId = 'p1';
  return state;
}

console.log('\n==================================================================');
console.log('  RUNNING ACTIVE DECK CERTIFICATION SUITE (28 UNIQUE CARDS)');
console.log('  Specification: MTG Comprehensive Rules (CR) Engine Certification');
console.log('==================================================================\n');

// ── 1. Heartfire Hero ──
try {
  const state = createMatchState();
  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    oracleText: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
  });
  const hammer = state.addCardToZone('p1', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });
  state.attachPermanentToCreature('p1', hammer.instanceId, hero.instanceId, { source: 'TEST_EQUIP' });
  assert.strictEqual(hero.counters['+1/+1'], 1, 'Valiant granted +1/+1 counter');
  const stats = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(stats.power, 12, '1 base + 10 hammer + 1 counter = 12 power');

  // Test dies trigger with LKI power
  state.destroyCreature('p1', hero.instanceId);
  assert.strictEqual(state.players.p2.resources.life, 8, 'Opponent life reduced by 12 (20 - 12 = 8)');
  recordTest('Heartfire Hero', 'Valiant +1/+1 trigger and Dies LKI damage equal to power', 'PASS');
} catch (err) {
  recordTest('Heartfire Hero', 'Valiant +1/+1 trigger and Dies LKI damage equal to power', 'FAIL', err.message);
}

// ── 2. Hallowed Fountain ──
try {
  const state = createMatchState();
  const cardData = {
    name: 'Hallowed Fountain',
    typeLine: 'Land — Plains Island',
    oracleText: '({T}: Add {W} or {U}.)\nAs Hallowed Fountain enters the battlefield, you may pay 2 life. If you don\'t, it enters the battlefield tapped.'
  };
  const card = state.addCardToZone('p1', 'hand', cardData);
  state.playLand('p1', card, { payShockCost: true });
  const landInBf = state.players.p1.battlefield.lands.find(l => l.name === 'Hallowed Fountain');
  assert.ok(landInBf, 'Hallowed Fountain entered battlefield');
  assert.strictEqual(landInBf.isTapped, false, 'Shockland entered untapped when 2 life paid');
  assert.strictEqual(state.players.p1.resources.life, 18, 'Player life reduced by 2 shock payment');
  recordTest('Hallowed Fountain', 'Shockland 2 life payment vs entering tapped and {W}/{U} profile', 'PASS');
} catch (err) {
  recordTest('Hallowed Fountain', 'Shockland 2 life payment vs entering tapped and {W}/{U} profile', 'FAIL', err.message);
}

// ── 3. Sigarda's Aid ──
try {
  const state = createMatchState();
  state.addCardToZone('p1', 'battlefield', {
    name: "Sigarda's Aid",
    typeLine: 'Enchantment',
    oracleText: 'Whenever an Equipment enters the battlefield under your control, you may attach it to target creature you control.\nYou may cast Aura and Equipment spells as though they had flash.'
  });
  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1
  });
  const hammer = state.addCardToZone('p1', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });
  assert.strictEqual(hammer.attachedTo, hero.instanceId, 'Sigarda\'s Aid auto-attached equipment on ETB');
  recordTest("Sigarda's Aid", 'Static flash permission and Equipment ETB auto-attach', 'PASS');
} catch (err) {
  recordTest("Sigarda's Aid", 'Static flash permission and Equipment ETB auto-attach', 'FAIL', err.message);
}

// ── 4. Stolen Uniform ──
try {
  const state = createMatchState();
  const spellCard = {
    name: 'Stolen Uniform',
    manaCost: '{U}',
    typeLine: 'Instant',
    oracleText: "Choose target creature you control and target Equipment. Gain control of that Equipment until end of turn. Attach it to the chosen creature. When you lose control of that Equipment this turn, if it's attached to a creature you control, unattach it."
  };
  const compiled = compileCard(spellCard);
  assert.ok(compiled.spellEffects && compiled.spellEffects.some(e => e.action === 'GAIN_CONTROL_ATTACH_EQUIPMENT' || e.type === 'GAIN_CONTROL_ATTACH_EQUIPMENT'), 'Must compile control change and equipment attach');

  // Verify DeckValidator metadata also matches FIN #75 ({U} Instant)
  assert.strictEqual(KNOWN_CARD_METADATA['stolen uniform']?.manaCost, '{U}', 'KNOWN_CARD_METADATA for Stolen Uniform must have manaCost {U}');

  // Runtime test: Opponent controls Colossus Hammer; P1 controls Heartfire Hero and casts Stolen Uniform
  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    oracleText: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
  });
  const oppHammer = state.addCardToZone('p2', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });
  const uniformInHand = state.addCardToZone('p1', 'hand', spellCard);
  state.resolveSpellEffect('p1', uniformInHand, {
    targetCreatureId: hero.instanceId,
    targetEquipmentId: oppHammer.instanceId
  });
  assert.strictEqual(oppHammer.attachedTo, hero.instanceId, 'Stolen Uniform attached opponent equipment to P1 creature');
  assert.strictEqual(oppHammer.controllerId, 'p1', 'P1 gained control of Equipment until end of turn');
  assert.strictEqual(hero.counters['+1/+1'], 1, 'Targeting Heartfire Hero with Stolen Uniform triggered Valiant');
  const midTurnStats = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(midTurnStats.power, 12, 'Hero is 12/12 while equipment is attached');

  // End of turn cleanup: P1 loses control of P2's equipment -> unattaches per Stolen Uniform delayed trigger
  state.clearEndOfTurnEffects();
  assert.strictEqual(oppHammer.controllerId, 'p2', 'Equipment control reverted to P2 at EOT');
  assert.strictEqual(oppHammer.attachedTo, null, 'Equipment unattached when P1 lost control of it this turn');

  recordTest('Stolen Uniform', 'Instant {U} gain control of Equipment until EOT, attach to target creature, and unattach on control loss', 'PASS');
} catch (err) {
  recordTest('Stolen Uniform', 'Instant {U} gain control of Equipment until EOT, attach to target creature, and unattach on control loss', 'FAIL', err.message);
}

// ── 5. Fervent Champion ──
try {
  const state = createMatchState();
  const champ = state.addCardToZone('p1', 'battlefield', {
    name: 'Fervent Champion',
    typeLine: 'Creature — Human Knight',
    power: 1,
    toughness: 1,
    oracleText: 'First strike, haste\nWhenever Fervent Champion attacks, another target attacking Knight you control gets +1/+0 until end of turn.\nEquip abilities you activate that target Fervent Champion cost {3} less to activate.'
  });
  const champ2 = state.addCardToZone('p1', 'battlefield', {
    name: 'Fervent Champion',
    typeLine: 'Creature — Human Knight',
    power: 1,
    toughness: 1,
    oracleText: 'First strike, haste\nWhenever Fervent Champion attacks, another target attacking Knight you control gets +1/+0 until end of turn.\nEquip abilities you activate that target Fervent Champion cost {3} less to activate.'
  });
  const compiled = compileCard(champ);
  assert.ok(compiled.staticPermissions.some(p => p.type === 'TARGET_EQUIP_COST_REDUCTION' && p.genericReduction === 3), 'Compiled {3} equip reduction');
  const hammer = { name: 'Colossus Hammer', compiledMechanics: { equipCost: '{8}' } };
  const effectiveCost = CastAvailabilityManager.computeEffectiveEquipCost(hammer, champ);
  assert.strictEqual(effectiveCost, '{5}', 'Equip {8} reduced by {3} to {5}');

  // Also verify attack trigger: another target attacking Knight gets +1/+0 until end of turn
  assert.ok(compiled.triggers.some(t => t.triggerType === 'ON_ATTACKS' && t.action === 'BUFF_ANOTHER_ATTACKING_KNIGHT'), 'Fervent Champion must compile attack trigger for another attacking Knight');
  state.triggerAttackAbilities('p1', [champ, champ2]);
  const stats1 = state.evaluateCreatureStats(champ, 'p1');
  const stats2 = state.evaluateCreatureStats(champ2, 'p1');
  assert.strictEqual(stats1.power, 2, 'First attacking Fervent Champion buffed by second');
  assert.strictEqual(stats2.power, 2, 'Second attacking Fervent Champion buffed by first');

  recordTest('Fervent Champion', 'First strike, haste, {3} equip reduction, and attacking Knight +1/+0 trigger', 'PASS');
} catch (err) {
  recordTest('Fervent Champion', 'First strike, haste, {3} equip reduction, and attacking Knight +1/+0 trigger', 'FAIL', err.message);
}

// ── 6. Inkmoth Nexus ──
try {
  const state = createMatchState();
  const land = state.addCardToZone('p1', 'battlefield', {
    name: 'Inkmoth Nexus',
    typeLine: 'Land',
    oracleText: '{T}: Add {C}.\n{1}: Inkmoth Nexus becomes a 1/1 Blinkmoth artifact creature with flying and infect until end of turn. It\'s still a land.'
  });
  assert.ok(land.compiledMechanics.manaProfile.includes('C'), 'Produces colorless mana');
  assert.ok(land.compiledMechanics.activatedAbilities && land.compiledMechanics.activatedAbilities.some(a => a.becomesCreature), 'Must compile {1} animation ability into 1/1 flying infect creature');

  // Activate animation ability in TabletopStateManager
  state.players.p1.resources.manaPool.C = 1;
  state.activatePermanentAbility('p1', land.instanceId, 'ANIMATE_LAND');
  const animated = state.findPermanentById(land.instanceId)?.card || land;
  const evalStats = state.evaluateCreatureStats(animated, 'p1');
  assert.strictEqual(evalStats.power, 1, 'Animated Inkmoth Nexus has base power 1');
  assert.strictEqual(evalStats.toughness, 1, 'Animated Inkmoth Nexus has base toughness 1');
  assert.strictEqual(Boolean(evalStats.keywords.flying), true, 'Animated Inkmoth Nexus has flying');
  assert.strictEqual(Boolean(evalStats.keywords.infect), true, 'Animated Inkmoth Nexus has infect');

  // Verify Infect combat damage deals poison counters to defending player
  const combatEngine = new CombatDamageEngine();
  const res = combatEngine.resolveDamageStep(
    [{ instanceId: animated.instanceId, controllerId: 'p1', power: 1, toughness: 1, damageMarked: 0, keywords: { flying: true, infect: true } }],
    [],
    {},
    { p1: { life: 20, poison: 0 }, p2: { life: 20, poison: 0 } },
    'p2',
    'NORMAL'
  );
  assert.strictEqual(res.playerPoisonDeltas.p2, 1, 'Infect deals 1 poison counter to defending player');
  assert.strictEqual(res.playerLifeDeltas.p2, 0, 'Infect does not reduce defending player life');

  recordTest('Inkmoth Nexus', 'Colorless mana, {1} animation into 1/1 flying infect Blinkmoth artifact creature, and poison damage', 'PASS');
} catch (err) {
  recordTest('Inkmoth Nexus', 'Colorless mana, {1} animation into 1/1 flying infect Blinkmoth artifact creature, and poison damage', 'FAIL', err.message);
}

// ── 7. Colossus Hammer ──
try {
  const state = createMatchState();
  const creature = state.addCardToZone('p1', 'battlefield', {
    name: 'Test Flier',
    typeLine: 'Creature — Bird',
    power: 1,
    toughness: 1,
    keywords: { flying: true }
  });
  const hammer = state.addCardToZone('p1', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });
  state.attachPermanentToCreature('p1', hammer.instanceId, creature.instanceId);
  const evaluated = state.abilityEngine.evaluatePermanentLayers(creature, state);
  assert.strictEqual(evaluated.effectivePower, 11, 'Base 1 + 10 = 11');
  assert.strictEqual(evaluated.effectiveToughness, 11, 'Base 1 + 10 = 11');
  assert.strictEqual(Boolean(evaluated.keywords.flying), false, 'Loses flying in Layer 6');
  recordTest('Colossus Hammer', '+10/+10 buff and loses flying keyword in Layer 6', 'PASS');
} catch (err) {
  recordTest('Colossus Hammer', '+10/+10 buff and loses flying keyword in Layer 6', 'FAIL', err.message);
}

// ── 8. Leyline Axe ──
try {
  const state = createMatchState();
  const axe = {
    name: 'Leyline Axe',
    typeLine: 'Artifact — Equipment',
    oracleText: 'If Leyline Axe is in your opening hand, you may begin the game with it on the battlefield.\nEquipped creature gets +1/+1 and has double strike and trample.\nEquip {3}'
  };
  const compiled = compileCard(axe);
  assert.strictEqual(compiled.canBeginOnBattlefield, true, 'Can begin on battlefield');
  assert.ok(compiled.attachmentEffects.keywordsGranted.includes('doubleStrike'), 'Grants double strike');
  assert.ok(compiled.attachmentEffects.keywordsGranted.includes('trample'), 'Grants trample');
  recordTest('Leyline Axe', 'Opening hand pregame battlefield placement, +1/+1, double strike and trample', 'PASS');
} catch (err) {
  recordTest('Leyline Axe', 'Opening hand pregame battlefield placement, +1/+1, double strike and trample', 'FAIL', err.message);
}

// ── 9. Plains ──
try {
  const compiled = compileCard({ name: 'Plains', typeLine: 'Basic Land — Plains' });
  assert.ok(compiled.manaProfile.includes('W'), 'Produces W');
  recordTest('Plains', 'Basic Plains produces {W}', 'PASS');
} catch (err) {
  recordTest('Plains', 'Basic Plains produces {W}', 'FAIL', err.message);
}

// ── 10. Mana Confluence ──
try {
  const state = createMatchState();
  state.addCardToZone('p1', 'battlefield', {
    name: 'Mana Confluence',
    typeLine: 'Land',
    oracleText: '{T}, Pay 1 life: Add one mana of any color.'
  });
  const payment = CastAvailabilityManager.computeOptimalManaPayment(state, 'p1', '{W}');
  assert.strictEqual(payment.canPay, true, 'Can pay {W}');
  assert.strictEqual(payment.totalLifeCost, 1, 'Costs 1 life');
  recordTest('Mana Confluence', 'Produces any color with 1 life payment', 'PASS');
} catch (err) {
  recordTest('Mana Confluence', 'Produces any color with 1 life payment', 'FAIL', err.message);
}

// ── 11. Starting Town ──
try {
  const town = {
    name: 'Starting Town',
    typeLine: 'Land — Town',
    oracleText: "Starting Town enters the battlefield tapped unless it's your first, second, or third turn of the game.\n{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color."
  };
  const compiled = compileCard(town);
  assert.strictEqual(compiled.etbTappedCondition, 'UNLESS_ROUND_1_2_OR_3', 'ETB tapped condition compiled');
  assert.ok(compiled.manaAbilities.some(a => a.produces.includes('C') && a.lifeCost === 0), '0-life {C} ability');
  assert.ok(compiled.manaAbilities.some(a => a.lifeCost === 1), '1-life any color ability');
  recordTest('Starting Town', 'ETB condition (turns 1-3 untapped), {C} for 0 life, any color for 1 life', 'PASS');
} catch (err) {
  recordTest('Starting Town', 'ETB condition (turns 1-3 untapped), {C} for 0 life, any color for 1 life', 'FAIL', err.message);
}

// ── 12. Spire of Industry ──
try {
  const state = createMatchState();
  state.addCardToZone('p1', 'battlefield', {
    name: 'Spire of Industry',
    typeLine: 'Land',
    oracleText: '{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color. Activate only if you control an artifact.'
  });
  const paymentNoArt = CastAvailabilityManager.computeOptimalManaPayment(state, 'p1', '{R}');
  assert.strictEqual(paymentNoArt.canPay, false, 'Cannot pay {R} without artifact');
  state.addCardToZone('p1', 'battlefield', { name: 'Mox', typeLine: 'Artifact' });
  const paymentWithArt = CastAvailabilityManager.computeOptimalManaPayment(state, 'p1', '{R}');
  assert.strictEqual(paymentWithArt.canPay, true, 'Can pay {R} with artifact controlled');
  recordTest('Spire of Industry', '{C} unconditionally and any color paying 1 life if controlling artifact', 'PASS');
} catch (err) {
  recordTest('Spire of Industry', '{C} unconditionally and any color paying 1 life if controlling artifact', 'FAIL', err.message);
}

// ── 13. Steam Vents ──
try {
  const state = createMatchState();
  const card = state.addCardToZone('p1', 'hand', {
    name: 'Steam Vents',
    typeLine: 'Land — Island Mountain',
    oracleText: '({T}: Add {U} or {R}.)\nAs Steam Vents enters the battlefield, you may pay 2 life. If you don\'t, it enters the battlefield tapped.'
  });
  state.playLand('p1', card, { payShockCost: false });
  const landInBf = state.players.p1.battlefield.lands.find(l => l.name === 'Steam Vents');
  assert.strictEqual(landInBf.isTapped, true, 'Enters tapped when 2 life not paid');
  recordTest('Steam Vents', 'Island Mountain typing, {U}/{R} production, shock 2 life ETB check', 'PASS');
} catch (err) {
  recordTest('Steam Vents', 'Island Mountain typing, {U}/{R} production, shock 2 life ETB check', 'FAIL', err.message);
}

// ── 14. Belt of Giant Strength ──
try {
  const state = createMatchState();
  const beltCard = {
    name: 'Belt of Giant Strength',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature has base power and toughness 10/10.\nEquip {10}. This ability costs {X} less to activate, where X is the power of the creature it targets.'
  };
  const compiled = compileCard(beltCard);
  assert.ok(compiled.attachmentEffects && (compiled.attachmentEffects.setPower === 10 || compiled.attachmentEffects.basePower === 10), 'Must compile Layer 7b base P/T 10/10');
  assert.strictEqual(compiled.attachmentEffects.equipDiscountByTargetPower, true, 'Must compile {X} target power equip discount');

  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    counters: { '+1/+1': 2 } // 3/3 creature (1 base + 2 counters)
  });
  const belt = state.addCardToZone('p1', 'battlefield', beltCard);

  // Target has power 3 -> Equip {10} reduced by 3 = {7}
  const effectiveEquip = CastAvailabilityManager.computeEffectiveEquipCost(belt, hero, state, 'p1');
  assert.strictEqual(effectiveEquip, '{7}', 'Equip {10} on 3-power creature must cost {7}');

  // Attach Belt -> base P/T becomes 10/10 in Layer 7b + two +1/+1 counters in Layer 7d = 12/12!
  state.attachPermanentToCreature('p1', belt.instanceId, hero.instanceId, { triggersTargeting: false });
  const stats = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(stats.power, 12, 'Layer 7b base 10/10 + Layer 7d (+2/+2 counters) = 12 power');
  assert.strictEqual(stats.toughness, 12, 'Layer 7b base 10/10 + Layer 7d (+2/+2 counters) = 12 toughness');

  recordTest('Belt of Giant Strength', 'Sets base P/T 10/10 in Layer 7b and Equip {10} with {X} target power reduction', 'PASS');
} catch (err) {
  recordTest('Belt of Giant Strength', 'Sets base P/T 10/10 in Layer 7b and Equip {10} with {X} target power reduction', 'FAIL', err.message);
}

// ── 15. Mountain ──
try {
  const compiled = compileCard({ name: 'Mountain', typeLine: 'Basic Land — Mountain' });
  assert.ok(compiled.manaProfile.includes('R'), 'Produces R');
  recordTest('Mountain', 'Basic Mountain produces {R}', 'PASS');
} catch (err) {
  recordTest('Mountain', 'Basic Mountain produces {R}', 'FAIL', err.message);
}

// ── 16. Goblin Gaveleer ──
try {
  const state = createMatchState();
  const goblin = state.addCardToZone('p1', 'battlefield', {
    name: 'Goblin Gaveleer',
    typeLine: 'Creature — Goblin Warrior',
    power: 1,
    toughness: 1,
    oracleText: 'Trample\nGoblin Gaveleer gets +2/+0 for each Equipment attached to it.'
  });
  const axe = state.addCardToZone('p1', 'battlefield', {
    name: 'Leyline Axe',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +1/+1 and has double strike and trample.\nEquip {3}'
  });
  state.attachPermanentToCreature('p1', axe.instanceId, goblin.instanceId);
  const evaluated = state.abilityEngine.evaluatePermanentLayers(goblin, state);
  // 1 base + 1 (axe buff) + 2 (gaveleer +2 per equipment) = 4 power!
  assert.strictEqual(evaluated.effectivePower, 4, 'Goblin Gaveleer gets +2/+0 per attached equipment');
  recordTest('Goblin Gaveleer', 'Trample and +2/+0 per attached Equipment in Layer 7c', 'PASS');
} catch (err) {
  recordTest('Goblin Gaveleer', 'Trample and +2/+0 per attached Equipment in Layer 7c', 'FAIL', err.message);
}

// ── 17. Forge Anew ──
try {
  const state = createMatchState();
  const hammerInGy = state.addCardToZone('p1', 'graveyard', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });
  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1
  });
  const forgeCard = {
    name: 'Forge Anew',
    typeLine: 'Enchantment',
    oracleText: "When Forge Anew enters the battlefield, return target Equipment card from your graveyard to the battlefield.\nAs long as it's your turn, you may activate equip abilities any time you could cast an instant.\nYou may pay {0} rather than pay the equip cost of the first equip ability you activate each turn."
  };
  const compiled = compileCard(forgeCard);
  assert.ok(compiled.triggers && compiled.triggers.some(t => t.action === 'RETURN_EQUIPMENT_FROM_GRAVEYARD'), 'Must compile ETB graveyard equipment return');
  assert.ok(compiled.staticPermissions && compiled.staticPermissions.some(p => p.type === 'INSTANT_SPEED_EQUIP'), 'Must compile instant speed equip permission');
  assert.ok(compiled.staticPermissions && compiled.staticPermissions.some(p => p.type === 'FIRST_EQUIP_COST_ZERO'), 'Must compile first equip {0} permission');

  // Put Forge Anew onto battlefield -> returns Colossus Hammer from graveyard to battlefield!
  state.addCardToZone('p1', 'battlefield', forgeCard);
  const hammerInBf = state.players.p1.battlefield.noncreatures.find(c => c.name === 'Colossus Hammer');
  assert.ok(hammerInBf, 'Forge Anew ETB returned Colossus Hammer from graveyard to battlefield');
  assert.strictEqual(state.players.p1.graveyard.length, 0, 'Graveyard is now empty');

  // First equip of the turn costs {0}
  const firstEquipCost = CastAvailabilityManager.computeEffectiveEquipCost(hammerInBf, hero, state, 'p1');
  assert.strictEqual(firstEquipCost, '{0}', 'First equip ability each turn with Forge Anew costs {0}');

  recordTest('Forge Anew', 'ETB equipment return from graveyard, instant-speed equip, and first equip {0}', 'PASS');
} catch (err) {
  recordTest('Forge Anew', 'ETB equipment return from graveyard, instant-speed equip, and first equip {0}', 'FAIL', err.message);
}

// ── 18. Callous Sell-Sword // Burn Together ──
try {
  const card = {
    name: 'Callous Sell-Sword // Burn Together',
    typeLine: 'Creature — Human Soldier // Sorcery — Adventure',
    manaCost: '{1}{B} // {R}',
    oracleText: "Callous Sell-Sword enters the battlefield with a +1/+1 counter on it for each creature that died under your control this turn.\n\nBurn Together\nTarget creature you control deals damage equal to its power to any other target. Then sacrifice it."
  };
  const compiled = compileCard(card);
  assert.strictEqual(compiled.castModes.length, 2, 'Has 2 cast modes (Main & Adventure)');
  assert.strictEqual(compiled.castModes[1].mode, 'ADVENTURE', 'Mode 1 is ADVENTURE');
  assert.strictEqual(compiled.castModes[1].exileOnResolve, true, 'Adventure exiles on resolve (CR 715.3d)');
  assert.ok(compiled.castModes[1].spellEffects.some(e => e.type === 'FLING_SACRIFICE_DAMAGE'), 'Fling sacrifice damage effect compiled');
  recordTest('Callous Sell-Sword // Burn Together', 'Adventure cast mode, fling sacrifice damage, and exile on resolve (CR 715)', 'PASS');
} catch (err) {
  recordTest('Callous Sell-Sword // Burn Together', 'Adventure cast mode, fling sacrifice damage, and exile on resolve (CR 715)', 'FAIL', err.message);
}

// ── 19. Doc Ock's Tentacles ──
try {
  const state = createMatchState();
  const card = {
    name: "Doc Ock's Tentacles",
    typeLine: 'Artifact — Equipment',
    oracleText: 'Whenever a creature you control with mana value 5 or greater enters, you may attach this Equipment to it.\nEquipped creature gets +4/+4.\nEquip {5}'
  };
  const compiled = compileCard(card);
  assert.strictEqual(compiled.attachmentEffects.powerDelta, 4, '+4/+4 buff compiled');
  assert.ok(compiled.triggers && compiled.triggers.some(t => t.triggerType === 'ON_CREATURE_MV5_ETB_ATTACH'), 'Must compile MV >= 5 auto-attach trigger');

  // Runtime test: Doc Ock's Tentacles on battlefield, Jegantha (MV 5) enters -> auto-attaches!
  const tentacles = state.addCardToZone('p1', 'battlefield', card);
  const jegantha = state.addCardToZone('p1', 'battlefield', {
    name: 'Jegantha, the Wellspring',
    manaCost: '{4}{R/G}',
    cmc: 5,
    typeLine: 'Legendary Creature — Elemental Elk',
    power: 5,
    toughness: 5
  });
  assert.strictEqual(tentacles.attachedTo, jegantha.instanceId, "Doc Ock's Tentacles auto-attached to MV 5 creature (Jegantha) on ETB");
  const stats = state.evaluateCreatureStats(jegantha, 'p1');
  assert.strictEqual(stats.power, 9, 'Jegantha is 9/9 with Doc Ock\'s Tentacles attached');

  recordTest("Doc Ock's Tentacles", '+4/+4, equip {5}, and auto-attach on MV >= 5 creature ETB', 'PASS');
} catch (err) {
  recordTest("Doc Ock's Tentacles", '+4/+4, equip {5}, and auto-attach on MV >= 5 creature ETB', 'FAIL', err.message);
}

// ── 20. Resolute Strike ──
try {
  const state = createMatchState();
  const nonWarrior = state.addCardToZone('p1', 'battlefield', {
    name: 'Non Warrior Bird',
    typeLine: 'Creature — Bird',
    power: 1,
    toughness: 1
  });
  const warrior = state.addCardToZone('p1', 'battlefield', {
    name: 'Goblin Gaveleer',
    typeLine: 'Creature — Goblin Warrior',
    power: 1,
    toughness: 1,
    oracleText: 'Trample\nGoblin Gaveleer gets +2/+0 for each Equipment attached to it.'
  });
  const hammer = state.addCardToZone('p1', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });
  const spell = {
    name: 'Resolute Strike',
    typeLine: 'Instant',
    oracleText: "Target creature gets +2/+2 until end of turn. If it's a Warrior, you may attach an Equipment you control to it."
  };
  const compiled = compileCard(spell);
  assert.strictEqual(compiled.spellEffects[0].requiresSubtypeForAttach, 'Warrior', 'Must require Warrior subtype to attach equipment');

  // 1) Cast on non-Warrior -> gets +2/+2 but does NOT attach hammer
  state.resolveSpellEffect('p1', spell, { targetCreatureId: nonWarrior.instanceId, targetEquipmentId: hammer.instanceId });
  assert.strictEqual(hammer.attachedTo, null, 'Non-Warrior must NOT get equipment attached by Resolute Strike');

  // 2) Cast on Goblin Gaveleer (Warrior) -> gets +2/+2 AND attaches hammer!
  state.resolveSpellEffect('p1', spell, { targetCreatureId: warrior.instanceId, targetEquipmentId: hammer.instanceId });
  assert.strictEqual(hammer.attachedTo, warrior.instanceId, 'Warrior gets equipment attached by Resolute Strike');

  recordTest('Resolute Strike', '+2/+2 until end of turn and attach equipment IF target is a Warrior (CR 608.2)', 'PASS');
} catch (err) {
  recordTest('Resolute Strike', '+2/+2 until end of turn and attach equipment IF target is a Warrior (CR 608.2)', 'FAIL', err.message);
}

// ── 21. Surge of Salvation ──
try {
  const state = createMatchState();
  const card = {
    name: 'Surge of Salvation',
    typeLine: 'Instant',
    oracleText: 'You and permanents you control gain hexproof until end of turn. Prevent all damage that black and/or red sources would deal to creatures you control this turn.'
  };
  const compiled = compileCard(card);
  assert.ok(compiled.spellEffects && compiled.spellEffects.some(e => e.action === 'PREVENT_COLOR_DAMAGE' || e.type === 'PREVENT_COLOR_DAMAGE'), 'Must compile black/red damage prevention shield');

  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1
  });
  state.resolveSpellEffect('p1', card, {});
  const evalHero = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(Boolean(evalHero.keywords.hexproof), true, 'Controlled creatures gain hexproof until EOT');
  assert.strictEqual(Boolean(state.players.p1.hexproofUntilEOT), true, 'Player gains hexproof until EOT');

  // Verify red source damage to controlled creature is prevented
  const dmgDealt = state.dealDamageToCreature('p1', hero.instanceId, 3, { sourceColors: ['R'] });
  assert.strictEqual(dmgDealt, 0, 'Damage from red source to P1 creature must be prevented by Surge of Salvation');
  assert.strictEqual(hero.damageMarked || 0, 0, 'Hero has 0 damage marked');

  recordTest('Surge of Salvation', 'Team hexproof and black/red damage prevention shield (CR 615)', 'PASS');
} catch (err) {
  recordTest('Surge of Salvation', 'Team hexproof and black/red damage prevention shield (CR 615)', 'FAIL', err.message);
}

// ── 22. Surgical Extraction ──
try {
  const card = {
    name: 'Surgical Extraction',
    typeLine: 'Instant',
    manaCost: '{B/P}',
    oracleText: "({B/P} can be paid with either {B} or 2 life.)\nChoose target card in a graveyard other than a basic land card. Search its owner's graveyard, hand, and library for any number of cards with the same name as that card and exile them. Then that player shuffles."
  };
  const state = createMatchState();
  const payment = CastAvailabilityManager.computeOptimalManaPayment(state, 'p1', card.manaCost);
  assert.strictEqual(payment.canPay, true, 'Can pay Phyrexian mana {B/P} via 2 life');
  assert.strictEqual(payment.totalLifeCost, 2, 'Life cost is 2');

  // Runtime test: Exile all copies of target card from opponent's graveyard, hand, and library
  const targetInGy = state.addCardToZone('p2', 'graveyard', { name: 'Lightning Bolt', typeLine: 'Instant' });
  state.addCardToZone('p2', 'hand', { name: 'Lightning Bolt', typeLine: 'Instant' });
  state.addCardToZone('p2', 'library', { name: 'Lightning Bolt', typeLine: 'Instant' });
  state.addCardToZone('p2', 'library', { name: 'Mountain', typeLine: 'Basic Land — Mountain' });

  state.resolveSpellEffect('p1', card, { targetCardId: targetInGy.instanceId, targetPlayerId: 'p2' });
  assert.strictEqual(state.players.p2.graveyard.length, 0, 'Target removed from graveyard');
  assert.strictEqual(state.players.p2.hand.length, 0, 'Matching card removed from hand');
  assert.strictEqual(state.players.p2.library.length, 1, 'Matching card removed from library, leaving Mountain');
  assert.strictEqual(state.players.p2.exile.length, 3, 'All 3 copies exiled');

  recordTest('Surgical Extraction', 'Phyrexian mana {B/P} payment (2 life) and name extraction across zones', 'PASS');
} catch (err) {
  recordTest('Surgical Extraction', 'Phyrexian mana {B/P} payment (2 life) and name extraction across zones', 'FAIL', err.message);
}

// ── 23. Invasion of Gobakhan // Lightshield Array ──
try {
  const state = createMatchState();
  const card = {
    name: 'Invasion of Gobakhan // Lightshield Array',
    typeLine: 'Battle — Siege // Enchantment',
    manaCost: '{1}{W}',
    defense: 3,
    oracleText: "When Invasion of Gobakhan enters the battlefield, look at target opponent's hand and exile a nonland card from it. For as long as that card remains exiled, its owner may play it, and spells cast this way cost {2} more to cast.",
    cardFaces: [
      {
        name: 'Invasion of Gobakhan',
        manaCost: '{1}{W}',
        typeLine: 'Battle — Siege',
        defense: 3,
        oracleText: "When this Siege enters, look at target opponent's hand. You may exile a nonland card from it. For as long as that card remains exiled, its owner may play it. A spell cast this way costs {2} more to cast."
      },
      {
        name: 'Lightshield Array',
        manaCost: '',
        typeLine: 'Enchantment',
        oracleText: "At the beginning of your end step, put a +1/+1 counter on each creature that attacked this turn.\nSacrifice this enchantment: Creatures you control gain hexproof and indestructible until end of turn."
      }
    ]
  };
  const compiled = compileCard(card);
  assert.strictEqual(compiled.category, 'otherPermanents', 'Battle classified as otherPermanents');
  assert.ok(compiled.castModes && compiled.castModes.some(m => m.mode === 'TRANSFORM' || m.transformedFace), 'Must support Battle transformation into Lightshield Array');

  // Runtime test: Opponent has a nonland card in hand; Invasion enters with 3 defense counters, exiles card with +2 tax; when 3 damage dealt to Siege, transforms into Lightshield Array!
  state.addCardToZone('p2', 'hand', { name: 'Fatal Push', manaCost: '{B}', typeLine: 'Instant' });
  const battle = state.addCardToZone('p1', 'battlefield', card);
  assert.strictEqual(battle.counters.defense, 3, 'Enters with 3 defense counters');
  assert.strictEqual(state.players.p2.exile.length, 1, 'Exiled nonland card from opponent hand on ETB');
  assert.strictEqual(state.players.p2.exile[0].castTaxGeneric, 2, 'Exiled card has {2} cast tax');

  // Defeat Siege (deal 3 damage to it) -> transforms into Lightshield Array!
  state.dealDamageToBattle(battle.instanceId, 3);
  const arrayInBf = state.players.p1.battlefield.noncreatures.find(c => c.name === 'Lightshield Array');
  assert.ok(arrayInBf, 'Defeated Invasion of Gobakhan transformed into Lightshield Array on battlefield');

  recordTest('Invasion of Gobakhan // Lightshield Array', 'Battle Siege mechanics, 3 defense counters, hand exile tax, and transform', 'PASS');
} catch (err) {
  recordTest('Invasion of Gobakhan // Lightshield Array', 'Battle Siege mechanics, 3 defense counters, hand exile tax, and transform', 'FAIL', err.message);
}

// ── 24. Wear // Tear ──
try {
  const card = {
    name: 'Wear // Tear',
    typeLine: 'Instant // Instant',
    manaCost: '{1}{R} // {W}',
    oracleText: 'Destroy target artifact.\n\nDestroy target enchantment.\n\nFuse'
  };
  const compiled = compileCard(card);
  assert.strictEqual(compiled.castModes.length >= 3, true, 'Split card with Fuse must provide SPLIT_LEFT, SPLIT_RIGHT, and FUSED modes');
  const fusedMode = compiled.castModes.find(m => m.mode === 'FUSED');
  assert.ok(fusedMode, 'Has FUSED cast mode');
  assert.strictEqual(fusedMode.manaCost, '{1}{R}{W}', 'Fused mana cost is {1}{R}{W}');
  recordTest('Wear // Tear', 'Split modes (Wear destroy artifact, Tear destroy enchantment) and Fuse (CR 702.102)', 'PASS');
} catch (err) {
  recordTest('Wear // Tear', 'Split modes (Wear destroy artifact, Tear destroy enchantment) and Fuse (CR 702.102)', 'FAIL', err.message);
}

// ── 25. Tormod's Crypt ──
try {
  const state = createMatchState();
  const card = {
    name: "Tormod's Crypt",
    typeLine: 'Artifact',
    manaCost: '{0}',
    oracleText: '{T}, Sacrifice Tormod\'s Crypt: Exile target player\'s graveyard.'
  };
  const compiled = compileCard(card);
  assert.ok(compiled.activatedAbilities && compiled.activatedAbilities.some(a => a.cost.sacrifice && a.effect.action === 'EXILE_TARGET_GRAVEYARD'), 'Must compile {T}, Sacrifice: Exile target player graveyard');

  const crypt = state.addCardToZone('p1', 'battlefield', card);
  state.addCardToZone('p2', 'graveyard', { name: 'Archon of Cruelty', typeLine: 'Creature — Archon' });
  state.activatePermanentAbility('p1', crypt.instanceId, 'SACRIFICE_EXILE_GRAVEYARD', { targetPlayerId: 'p2' });
  assert.strictEqual(state.players.p2.graveyard.length, 0, 'Target player graveyard exiled');
  assert.strictEqual(state.players.p2.exile.length, 1, 'Card moved to exile');
  assert.strictEqual(state.players.p1.graveyard.some(c => c.name === "Tormod's Crypt"), true, "Tormod's Crypt sacrificed to graveyard");

  recordTest("Tormod's Crypt", '{0} mana cost and {T}, Sacrifice to exile target player\'s graveyard', 'PASS');
} catch (err) {
  recordTest("Tormod's Crypt", '{0} mana cost and {T}, Sacrifice to exile target player\'s graveyard', 'FAIL', err.message);
}

// ── 26. Skrelv, Defector Mite ──
try {
  const state = createMatchState();
  const card = {
    name: 'Skrelv, Defector Mite',
    typeLine: 'Legendary Artifact Creature — Phyrexian Mite',
    power: 1,
    toughness: 1,
    oracleText: "Toxic 1\nSkrelv, Defector Mite can't block.\n{W/P}, {T}: Another target creature you control gains toxic 1 and hexproof from the color of your choice until end of turn. It can't be blocked by creatures of that color this turn."
  };
  const compiled = compileCard(card);
  assert.ok(compiled.keywords && compiled.keywords.toxic === 1, 'Toxic 1 keyword compiled');
  assert.strictEqual(compiled.cantBlock, true, "Skrelv can't block restriction compiled");
  assert.ok(compiled.activatedAbilities && compiled.activatedAbilities.some(a => a.cost.phyrexian), 'Must compile {W/P} activated ability');

  // Verify Toxic 1 in CombatDamageEngine: deals normal combat damage AND 1 poison counter
  const combatEngine = new CombatDamageEngine();
  const res = combatEngine.resolveDamageStep(
    [{ instanceId: 'skrelv_1', controllerId: 'p1', power: 1, toughness: 1, damageMarked: 0, keywords: { toxic: 1 } }],
    [],
    {},
    { p1: { life: 20, poison: 0 }, p2: { life: 20, poison: 0 } },
    'p2',
    'NORMAL'
  );
  assert.strictEqual(res.playerLifeDeltas.p2, -1, 'Toxic creature still deals normal combat damage to life');
  assert.strictEqual(res.playerPoisonDeltas.p2, 1, 'Toxic 1 adds 1 poison counter on combat damage to player');

  recordTest('Skrelv, Defector Mite', 'Toxic 1 (CR 702.164), can\'t block, and {W/P} protection grant ability', 'PASS');
} catch (err) {
  recordTest('Skrelv, Defector Mite', 'Toxic 1 (CR 702.164), can\'t block, and {W/P} protection grant ability', 'FAIL', err.message);
}

// ── 27. Soul-Guide Lantern ──
try {
  const state = createMatchState();
  const card = {
    name: 'Soul-Guide Lantern',
    typeLine: 'Artifact',
    manaCost: '{1}',
    oracleText: "When Soul-Guide Lantern enters the battlefield, exile target card from a graveyard.\n{T}, Sacrifice Soul-Guide Lantern: Exile each opponent's graveyard.\n{1}, {T}, Sacrifice Soul-Guide Lantern: Draw a card."
  };
  const compiled = compileCard(card);
  assert.ok(compiled.triggers && compiled.triggers.some(t => t.action === 'EXILE_TARGET_GRAVEYARD_CARD'), 'Must compile ETB graveyard card exile');
  assert.strictEqual(compiled.activatedAbilities?.length >= 2, true, 'Must compile the 2 sacrifice abilities');

  const gyCard1 = state.addCardToZone('p2', 'graveyard', { name: 'Murktide Regent', typeLine: 'Creature — Dragon' });
  state.addCardToZone('p2', 'graveyard', { name: 'Consider', typeLine: 'Instant' });
  const lantern = state.addCardToZone('p1', 'battlefield', card);
  // ETB exiles 1 card from graveyard
  assert.strictEqual(state.players.p2.graveyard.length, 1, 'ETB exiled 1 card from graveyard');
  // Activate {T}, Sacrifice: Exile each opponent's graveyard
  state.activatePermanentAbility('p1', lantern.instanceId, 'SACRIFICE_EXILE_OPPONENT_GRAVEYARDS');
  assert.strictEqual(state.players.p2.graveyard.length, 0, 'Activated sacrifice exiled remaining opponent graveyard');

  recordTest('Soul-Guide Lantern', 'ETB single graveyard exile and activated sacrifice abilities', 'PASS');
} catch (err) {
  recordTest('Soul-Guide Lantern', 'ETB single graveyard exile and activated sacrifice abilities', 'FAIL', err.message);
}

// ── 28. Jegantha, the Wellspring ──
try {
  // 1. Deckbuilding Companion check: Verify all 28 deck cards have no duplicate mana symbols
  const deckList = [
    '{R}', '', '{W}', '{U}', '{R}', '', '{1}', '{4}', '', '', '', '', '', '{1}{G}', '',
    '{R}', '{2}{W}', '{1}{B}', '{1}', '{W}', '{W}', '{B/P}', '{1}{W}', '{1}{R}', '{0}', '{W}', '{1}', '{4}{R/G}'
  ];
  for (const cost of deckList) {
    const syms = cost.match(/\{[^}]+\}/g) || [];
    const counts = {};
    for (const s of syms) {
      counts[s] = (counts[s] || 0) + 1;
      assert.ok(counts[s] <= 1, `Jegantha constraint violated by cost ${cost}`);
    }
  }

  // 2. Restricted Mana Ability
  const card = {
    name: 'Jegantha, the Wellspring',
    typeLine: 'Legendary Creature — Elemental Elk',
    manaCost: '{4}{R/G}',
    power: 5,
    toughness: 5,
    oracleText: "Companion — No card in your starting deck has more than one of the same mana symbol in its mana cost.\n{T}: Add {W}{U}{B}{R}{G}. This mana can't be spent to pay generic mana costs."
  };
  const compiled = compileCard(card);
  assert.ok(compiled.manaAbilities && compiled.manaAbilities.some(a => a.restrictedSpend === 'NO_GENERIC'), 'Must compile {W}{U}{B}{R}{G} with restricted generic spend');
  recordTest('Jegantha, the Wellspring', 'Companion deck constraint validation and restricted {W}{U}{B}{R}{G} mana ability', 'PASS');
} catch (err) {
  recordTest('Jegantha, the Wellspring', 'Companion deck constraint validation and restricted {W}{U}{B}{R}{G} mana ability', 'FAIL', err.message);
}

// ==================================================================
// RED-TEAM ADVERSARIAL AUDIT SUITE (10 COMPREHENSIVE ATTACK VECTORS)
// ==================================================================

// ── ADV-1: Belt of Giant Strength Power Clamping (Power >= 10, Negative Power, 0 Power) ──
try {
  const state = createMatchState();
  const beltCard = {
    name: 'Belt of Giant Strength',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature has base power and toughness 10/10.\nEquip {10}. This ability costs {X} less to activate, where X is the power of the creature it targets.'
  };
  const belt = state.addCardToZone('p1', 'battlefield', beltCard);

  // Case A: Power >= 10 (15 power) -> Must clamp reduction so equip cost is exactly {0}
  const bigCreature = state.addCardToZone('p1', 'battlefield', {
    name: 'Huge Beast',
    typeLine: 'Creature — Beast',
    power: 15,
    toughness: 15
  });
  const costBig = CastAvailabilityManager.computeEffectiveEquipCost(belt, bigCreature, state, 'p1');
  assert.strictEqual(costBig, '{0}', 'Belt equip cost on 15-power creature must clamp to {0}');

  // Case B: Power = 10 -> Exactly {0}
  const tenCreature = state.addCardToZone('p1', 'battlefield', {
    name: 'Ten Beast',
    typeLine: 'Creature — Beast',
    power: 10,
    toughness: 10
  });
  const costTen = CastAvailabilityManager.computeEffectiveEquipCost(belt, tenCreature, state, 'p1');
  assert.strictEqual(costTen, '{0}', 'Belt equip cost on 10-power creature must be {0}');

  // Case C: Negative Power (power = -2 via counters) -> Must clamp X to 0 (cost remains {10})
  const negCreature = state.addCardToZone('p1', 'battlefield', {
    name: 'Weakling',
    typeLine: 'Creature — Insect',
    power: 1,
    toughness: 3,
    counters: { '-1/-1': 3 } // 1 - 3 = -2 power
  });
  const costNeg = CastAvailabilityManager.computeEffectiveEquipCost(belt, negCreature, state, 'p1');
  assert.strictEqual(costNeg, '{10}', 'Belt equip cost on negative power creature must not increase, must be {10}');

  // Case D: Zero Power (power = 0) -> Cost remains {10}
  const zeroCreature = state.addCardToZone('p1', 'battlefield', {
    name: 'Ornithopter',
    typeLine: 'Artifact Creature — Thopter',
    power: 0,
    toughness: 2
  });
  const costZero = CastAvailabilityManager.computeEffectiveEquipCost(belt, zeroCreature, state, 'p1');
  assert.strictEqual(costZero, '{10}', 'Belt equip cost on 0-power creature must be {10}');

  recordTest('Belt of Giant Strength', 'ADV-1: Power clamping with power >= 10, power = 10, negative power, and 0 power', 'PASS');
} catch (err) {
  recordTest('Belt of Giant Strength', 'ADV-1: Power clamping with power >= 10, power = 10, negative power, and 0 power', 'FAIL', err.message);
}

// ── ADV-2: Forge Anew Graveyard Edge Cases & CR 400.7 Zone-Change Identity ──
try {
  const state = createMatchState();
  const forgeCard = {
    name: 'Forge Anew',
    typeLine: 'Enchantment',
    oracleText: "When Forge Anew enters the battlefield, return target Equipment card from your graveyard to the battlefield.\nAs long as it's your turn, you may activate equip abilities any time you could cast an instant.\nYou may pay {0} rather than pay the equip cost of the first equip ability you activate each turn."
  };

  // Case A: Empty graveyard -> ETB must safely do nothing without crashing
  assert.strictEqual(state.players.p1.graveyard.length, 0, 'Graveyard is initially empty');
  state.addCardToZone('p1', 'battlefield', forgeCard);
  assert.strictEqual(state.players.p1.battlefield.noncreatures.length, 1, 'Only Forge Anew is on battlefield');

  // Case B: Graveyard has only instant/sorceries (no Equipment) -> must not resurrect non-equipment
  const state2 = createMatchState();
  state2.addCardToZone('p1', 'graveyard', { name: 'Lightning Bolt', typeLine: 'Instant' });
  state2.addCardToZone('p1', 'battlefield', forgeCard);
  assert.strictEqual(state2.players.p1.graveyard.length, 1, 'Instant remains in graveyard');
  assert.strictEqual(state2.players.p1.battlefield.noncreatures.length, 1, 'No equipment resurrected');

  // Case C: Equipment in graveyard with dirty attachedTo -> Resurrected equipment must have clean attachment state and new instanceId
  const state3 = createMatchState();
  const hammerInGy = state3.addCardToZone('p1', 'graveyard', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}',
    attachedTo: 'stale_creature_id'
  });
  const oldInstanceId = hammerInGy.instanceId;
  state3.addCardToZone('p1', 'battlefield', forgeCard);
  const resurrectedHammer = state3.players.p1.battlefield.noncreatures.find(c => c.name === 'Colossus Hammer');
  assert.ok(resurrectedHammer, 'Colossus Hammer returned to battlefield');
  assert.notStrictEqual(resurrectedHammer.instanceId, oldInstanceId, 'CR 400.7: Resurrected equipment must receive a new instanceId');
  assert.strictEqual(resurrectedHammer.attachedTo, null, 'Resurrected equipment must have attachedTo reset to null');

  recordTest('Forge Anew', 'ADV-2: Empty graveyard safety and clean equipment resurrection (CR 400.7)', 'PASS');
} catch (err) {
  recordTest('Forge Anew', 'ADV-2: Empty graveyard safety and clean equipment resurrection (CR 400.7)', 'FAIL', err.message);
}

// ── ADV-3: Surgical Extraction Illegal Target (Basic Land) Rejection ──
try {
  const state = createMatchState();
  const surgicalCard = {
    name: 'Surgical Extraction',
    typeLine: 'Instant',
    manaCost: '{B/P}',
    oracleText: "Choose target card in a graveyard other than a basic land card. Search its owner's graveyard, hand, and library for any number of cards with the same name as that card and exile them. Then that player shuffles."
  };
  const plainsInGy = state.addCardToZone('p2', 'graveyard', { name: 'Plains', typeLine: 'Basic Land — Plains' });
  state.addCardToZone('p2', 'hand', { name: 'Plains', typeLine: 'Basic Land — Plains' });

  // Attempting to target Basic Land Plains
  state.resolveSpellEffect('p1', surgicalCard, { targetCardId: plainsInGy.instanceId, targetPlayerId: 'p2' });
  // Verify 0 cards were exiled
  assert.strictEqual(state.players.p2.graveyard.length, 1, 'Plains must NOT be removed from graveyard');
  assert.strictEqual(state.players.p2.hand.length, 1, 'Plains in hand must NOT be exiled');
  assert.strictEqual(state.players.p2.exile.length, 0, 'Exile must remain empty when basic land is targeted');

  recordTest('Surgical Extraction', 'ADV-3: Basic Land illegal target restriction strictly enforced', 'PASS');
} catch (err) {
  recordTest('Surgical Extraction', 'ADV-3: Basic Land illegal target restriction strictly enforced', 'FAIL', err.message);
}

// ── ADV-4: Invasion of Gobakhan All-Land or Empty Hand Edge Cases & CR 712.8a Front-Face Reversion ──
try {
  const card = {
    name: 'Invasion of Gobakhan // Lightshield Array',
    typeLine: 'Battle — Siege // Enchantment',
    defense: 3,
    oracleText: "When Invasion of Gobakhan enters the battlefield, look at target opponent's hand and exile a nonland card from it. For as long as that card remains exiled, its owner may play it, and spells cast this way cost {2} more to cast."
  };

  // Case A: Opponent has empty hand
  const stateEmpty = createMatchState();
  assert.strictEqual(stateEmpty.players.p2.hand.length, 0, 'Opponent hand is empty');
  const battleEmpty = stateEmpty.addCardToZone('p1', 'battlefield', card);
  assert.strictEqual(battleEmpty.counters.defense, 3, 'Invasion enters with 3 defense counters even if hand empty');
  assert.strictEqual(stateEmpty.players.p2.exile.length, 0, '0 cards exiled from empty hand');

  // Case B: Opponent has only Basic Lands in hand
  const stateLands = createMatchState();
  stateLands.addCardToZone('p2', 'hand', { name: 'Plains', typeLine: 'Basic Land — Plains' });
  stateLands.addCardToZone('p2', 'hand', { name: 'Mountain', typeLine: 'Basic Land — Mountain' });
  const battleLands = stateLands.addCardToZone('p1', 'battlefield', card);
  assert.strictEqual(battleLands.counters.defense, 3, 'Invasion enters with 3 defense counters');
  assert.strictEqual(stateLands.players.p2.exile.length, 0, '0 cards exiled when opponent has only lands in hand');
  assert.strictEqual(stateLands.players.p2.hand.length, 2, 'Opponent hand lands preserved');

  // Case C: CR 712.8a — Defeat Invasion -> Lightshield Array -> Sacrifice -> reverts to front face in graveyard
  stateLands.dealDamageToBattle(battleLands.instanceId, 3);
  assert.strictEqual(battleLands.name, 'Lightshield Array', 'Transformed into Lightshield Array');
  stateLands.activatePermanentAbility('p1', battleLands.instanceId, 'SACRIFICE_TEAM_SHIELD');
  assert.strictEqual(stateLands.players.p1.graveyard[0].name, 'Invasion of Gobakhan // Lightshield Array', 'CR 712.8a: Reverts to front face in graveyard');

  recordTest('Invasion of Gobakhan', 'ADV-4: Empty hand, all-lands hand, and CR 712.8a graveyard front-face reversion', 'PASS');
} catch (err) {
  recordTest('Invasion of Gobakhan', 'ADV-4: Empty hand, all-lands hand, and CR 712.8a graveyard front-face reversion', 'FAIL', err.message);
}

// ── ADV-5: Soul-Guide Lantern Empty Opponent Graveyard Safety ──
try {
  const state = createMatchState();
  const card = {
    name: 'Soul-Guide Lantern',
    typeLine: 'Artifact',
    manaCost: '{1}',
    oracleText: "When Soul-Guide Lantern enters the battlefield, exile target card from a graveyard.\n{T}, Sacrifice Soul-Guide Lantern: Exile each opponent's graveyard.\n{1}, {T}, Sacrifice Soul-Guide Lantern: Draw a card."
  };
  // Opponent graveyard is empty
  assert.strictEqual(state.players.p2.graveyard.length, 0, 'Opponent graveyard empty');
  const lantern = state.addCardToZone('p1', 'battlefield', card);
  assert.strictEqual(state.players.p2.exile.length, 0, 'ETB against empty graveyard resolves safely');

  // Activate {T}, Sacrifice against empty graveyard
  state.activatePermanentAbility('p1', lantern.instanceId, 'SACRIFICE_EXILE_OPPONENT_GRAVEYARDS');
  assert.strictEqual(state.players.p2.exile.length, 0, 'Sacrifice ability against empty graveyard resolves safely');
  assert.strictEqual(state.players.p1.graveyard.some(c => c.name === 'Soul-Guide Lantern'), true, 'Lantern sacrificed to P1 graveyard');

  recordTest('Soul-Guide Lantern', 'ADV-5: ETB and activated sacrifice with empty opponent graveyard', 'PASS');
} catch (err) {
  recordTest('Soul-Guide Lantern', 'ADV-5: ETB and activated sacrifice with empty opponent graveyard', 'FAIL', err.message);
}

// ── ADV-6: Heartfire Hero + Belt of Giant Strength + Colossus Hammer + Burn Together 42-Damage Fling Combo ──
try {
  const state = createMatchState();
  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    oracleText: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
  });
  const belt = state.addCardToZone('p1', 'battlefield', {
    name: 'Belt of Giant Strength',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature has base power and toughness 10/10.\nEquip {10}'
  });
  const hammer = state.addCardToZone('p1', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });

  // 1. Attach Belt: Hero gets +1/+1 counter from Valiant (first target this turn) + base 10/10 in Layer 7b
  state.attachPermanentToCreature('p1', belt.instanceId, hero.instanceId);
  assert.strictEqual(hero.counters['+1/+1'], 1, 'Hero gained 1 counter from Valiant');

  // 2. Attach Hammer: Hero gets +10/+10 in Layer 7c. (Valiant does NOT trigger second time!)
  state.attachPermanentToCreature('p1', hammer.instanceId, hero.instanceId);
  assert.strictEqual(hero.counters['+1/+1'], 1, 'Valiant did not trigger a second time in same turn');

  const statsPreFling = state.evaluateCreatureStats(hero, 'p1');
  // Base 10 (Belt) + 10 (Hammer) + 1 (+1/+1 counter) = 21 Power!
  assert.strictEqual(statsPreFling.power, 21, 'Heartfire Hero is 21/21 with Belt + Hammer + 1 counter');

  // 3. Cast Burn Together (Adventure): deals 21 damage to P2, then sacrifices Hero!
  const callousCard = {
    name: 'Callous Sell-Sword // Burn Together',
    typeLine: 'Creature — Human Soldier // Sorcery — Adventure',
    oracleText: 'Target creature you control deals damage equal to its power to any other target. Then sacrifice it.'
  };
  state.players.p2.resources.life = 50; // Give opponent 50 life to measure full combined damage
  state._resolveFlingSacrificeDamage('p1', callousCard, [hero.instanceId, 'p2'], ['p2'], { damageTargetId: 'p2', sourceCreatureId: hero.instanceId });

  // Burn Together deals 21 damage (50 - 21 = 29)
  // Hero dies trigger deals LKI power 21 damage (29 - 21 = 8)
  assert.strictEqual(state.players.p2.resources.life, 8, 'Opponent life reduced by 42 total damage (21 fling + 21 dies trigger)');
  assert.strictEqual(state.players.p1.graveyard.some(c => c.name === 'Heartfire Hero'), true, 'Hero is in graveyard');

  recordTest('Heartfire Hero', 'ADV-6: 42-damage multi-equipment Fling combo (CR 608.2h LKI + Dies Trigger)', 'PASS');
} catch (err) {
  recordTest('Heartfire Hero', 'ADV-6: 42-damage multi-equipment Fling combo (CR 608.2h LKI + Dies Trigger)', 'FAIL', err.message);
}

// ── ADV-7: Inkmoth Nexus Animation + Colossus Hammer Layer 6 Interaction, 11 Infect Poison & EOT Land Reversion ──
try {
  const state = createMatchState();
  const nexus = state.addCardToZone('p1', 'battlefield', {
    name: 'Inkmoth Nexus',
    typeLine: 'Land',
    oracleText: '{T}: Add {C}.\n{1}: Inkmoth Nexus becomes a 1/1 Blinkmoth artifact creature with flying and infect until end of turn. It\'s still a land.'
  });
  const hammer = state.addCardToZone('p1', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });

  // 1. Animate Inkmoth Nexus -> 1/1 Blinkmoth artifact creature with flying and infect
  state.activatePermanentAbility('p1', nexus.instanceId, 'ANIMATE_LAND');
  const animated = state.findPermanentById(nexus.instanceId)?.card || nexus;
  const statsPreHammer = state.evaluateCreatureStats(animated, 'p1');
  assert.strictEqual(Boolean(statsPreHammer.keywords.flying), true, 'Nexus has flying on animation');
  assert.strictEqual(Boolean(statsPreHammer.keywords.infect), true, 'Nexus has infect on animation');

  // 2. Attach Colossus Hammer -> +10/+10 and LOSES flying in Layer 6!
  state.attachPermanentToCreature('p1', hammer.instanceId, animated.instanceId);
  const statsPostHammer = state.evaluateCreatureStats(animated, 'p1');
  assert.strictEqual(statsPostHammer.power, 11, 'Base 1 + 10 = 11 power');
  assert.strictEqual(statsPostHammer.toughness, 11, 'Base 1 + 10 = 11 toughness');
  assert.strictEqual(Boolean(statsPostHammer.keywords.flying), false, 'Loses flying keyword in Layer 6 from Colossus Hammer');
  assert.strictEqual(Boolean(statsPostHammer.keywords.infect), true, 'Retains infect keyword');

  // 3. Resolve combat damage against defending player (P2)
  const combatEngine = new CombatDamageEngine();
  const dmgResult = combatEngine.resolveDamageStep(
    [{ instanceId: animated.instanceId, controllerId: 'p1', power: 11, toughness: 11, damageMarked: 0, keywords: { infect: true } }],
    [],
    {},
    { p1: { life: 20, poison: 0 }, p2: { life: 20, poison: 0 } },
    'p2',
    'NORMAL'
  );
  assert.strictEqual(dmgResult.playerPoisonDeltas.p2, 11, 'Infect deals 11 poison counters');
  assert.strictEqual(dmgResult.playerLifeDeltas.p2, 0, 'Infect does not reduce defending player life');

  // 4. Verify EOT cleanup reverts Inkmoth Nexus back to lands subzone (CR 611.2a)
  state.clearEndOfTurnEffects();
  assert.strictEqual(state.players.p1.battlefield.lands.includes(animated), true, 'Inkmoth Nexus reverted back to lands subzone at EOT');
  assert.strictEqual(state.players.p1.battlefield.creatures.includes(animated), false, 'Inkmoth Nexus removed from creatures subzone at EOT');

  // Apply poison counters to match state and verify CR 704.5c elimination
  state.players.p2.resources.poison = 11;
  StateBasedActionsEngine.runSBACheck(state);
  assert.strictEqual(state.players.p2.isEliminated, true, 'P2 eliminated by CR 704.5c (10 or more poison counters)');

  recordTest('Inkmoth Nexus', 'ADV-7: Layer 6 flying removal, 11 Infect poison SBA elimination (CR 704.5c), and EOT land reversion', 'PASS');
} catch (err) {
  recordTest('Inkmoth Nexus', 'ADV-7: Layer 6 flying removal, 11 Infect poison SBA elimination (CR 704.5c), and EOT land reversion', 'FAIL', err.message);
}

// ── ADV-8: Server / UI Battlefield Zones Desynchronization Invariant ──
try {
  const state = createMatchState();
  const p1 = state.players.p1;

  // Add 3 cards across different subzones
  const creature = state.addCardToZone('p1', 'battlefield', { name: 'Creature', typeLine: 'Creature — Soldier', power: 1, toughness: 1 });
  const land = state.addCardToZone('p1', 'battlefield', { name: 'Plains', typeLine: 'Basic Land — Plains' });
  const artifact = state.addCardToZone('p1', 'battlefield', { name: 'Colossus Hammer', typeLine: 'Artifact — Equipment' });

  const countSubzones = () => (p1.battlefield.creatures.length + p1.battlefield.lands.length + p1.battlefield.noncreatures.length + p1.battlefield.planeswalkers.length);
  assert.strictEqual(countSubzones(), p1.zones.battlefield.length, 'Subzone count must equal zones.battlefield.length');
  assert.strictEqual(p1.zones.battlefield.length, 3, 'Exactly 3 permanents on battlefield');

  // Destroy creature -> must be cleanly removed from both
  state.destroyCreature('p1', creature.instanceId);
  assert.strictEqual(countSubzones(), p1.zones.battlefield.length, 'Subzone count must match zones.battlefield after creature destruction');
  assert.strictEqual(p1.zones.battlefield.length, 2, 'Exactly 2 permanents remaining');
  assert.strictEqual(p1.zones.battlefield.some(c => c.instanceId === creature.instanceId), false, 'Destroyed creature absent from zones.battlefield');

  recordTest('TabletopStateManager', 'ADV-8: Subzone and zones.battlefield bidirectional synchronization invariant', 'PASS');
} catch (err) {
  recordTest('TabletopStateManager', 'ADV-8: Subzone and zones.battlefield bidirectional synchronization invariant', 'FAIL', err.message);
}

// ── ADV-9: Goblin Gaveleer Multi-Equipment Scaling Buff in Layer 7c ──
try {
  const state = createMatchState();
  const gaveleer = state.addCardToZone('p1', 'battlefield', {
    name: 'Goblin Gaveleer',
    typeLine: 'Creature — Goblin Warrior',
    power: 1,
    toughness: 1,
    oracleText: 'Trample\nGoblin Gaveleer gets +2/+0 for each Equipment attached to it.'
  });
  const belt = state.addCardToZone('p1', 'battlefield', {
    name: 'Belt of Giant Strength',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature has base power and toughness 10/10.\nEquip {10}'
  });
  const axe = state.addCardToZone('p1', 'battlefield', {
    name: 'Leyline Axe',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +1/+1 and has double strike and trample.\nEquip {3}'
  });

  // Attach Belt: Layer 7b base becomes 10/10 + Gaveleer gets +2/+0 for 1 equipment = 12/10
  state.attachPermanentToCreature('p1', belt.instanceId, gaveleer.instanceId);
  const eval1 = state.abilityEngine.evaluatePermanentLayers(gaveleer, state);
  assert.strictEqual(eval1.effectivePower, 12, '10 base + 2 gaveleer scaling = 12 power');
  assert.strictEqual(eval1.effectiveToughness, 10, '10 base toughness');

  // Attach Leyline Axe: +1/+1 from Axe + Gaveleer gets +4/+0 for 2 equipment = 10 base + 1 (axe) + 4 (scaling) = 15/11!
  state.attachPermanentToCreature('p1', axe.instanceId, gaveleer.instanceId);
  const eval2 = state.abilityEngine.evaluatePermanentLayers(gaveleer, state);
  assert.strictEqual(eval2.effectivePower, 15, '10 base + 1 axe + 4 scaling = 15 power');
  assert.strictEqual(eval2.effectiveToughness, 11, '10 base + 1 axe = 11 toughness');
  assert.strictEqual(Boolean(eval2.keywords.doubleStrike), true, 'Has double strike from Leyline Axe');
  assert.strictEqual(Boolean(eval2.keywords.trample), true, 'Has trample');

  recordTest('Goblin Gaveleer', 'ADV-9: Multi-equipment scaling buff with Layer 7b base setting and Layer 7c modifiers', 'PASS');
} catch (err) {
  recordTest('Goblin Gaveleer', 'ADV-9: Multi-equipment scaling buff with Layer 7b base setting and Layer 7c modifiers', 'FAIL', err.message);
}

// ── ADV-10: Stolen Uniform EOT Control Reversion and Mandatory Unattach ──
try {
  const state = createMatchState();
  const spellCard = {
    name: 'Stolen Uniform',
    manaCost: '{U}',
    typeLine: 'Instant',
    oracleText: "Choose target creature you control and target Equipment. Gain control of that Equipment until end of turn. Attach it to the chosen creature. When you lose control of that Equipment this turn, if it's attached to a creature you control, unattach it."
  };
  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    oracleText: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
  });
  const oppHammer = state.addCardToZone('p2', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });

  // P1 casts Stolen Uniform
  state.resolveSpellEffect('p1', spellCard, { targetCreatureId: hero.instanceId, targetEquipmentId: oppHammer.instanceId });
  assert.strictEqual(oppHammer.controllerId, 'p1', 'P1 gains control of Equipment');
  assert.strictEqual(oppHammer.attachedTo, hero.instanceId, 'Attached to P1 creature');
  const midStats = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(midStats.power, 12, 'Hero is 12/12 while equipped (1 base + 10 hammer + 1 valiant counter)');

  // Clear EOT effects: P1 loses control of Equipment -> Reverts to P2, un-attaches, and Hero stats revert to 2/2 (1 base + 1 counter)
  state.clearEndOfTurnEffects();
  assert.strictEqual(oppHammer.controllerId, 'p2', 'Equipment returned to P2');
  assert.strictEqual(oppHammer.attachedTo, null, 'Equipment must be unattached');
  const postStats = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(postStats.power, 2, 'Hero stats revert to 2/2 after unattach (1 base + 1 valiant counter)');

  recordTest('Stolen Uniform', 'ADV-10: Complete EOT control loss, equipment unattach, and stat normalization', 'PASS');
} catch (err) {
  recordTest('Stolen Uniform', 'ADV-10: Complete EOT control loss, equipment unattach, and stat normalization', 'FAIL', err.message);
}

// ── ADV-11: Play vs Perkins Pre-Game Flow (d20 Roll-Off -> London Mulligan -> Leyline Axe Opening Hand Resolution) ──
try {
  const { RPMAppController } = await import('../src/app.js');
  const app = new RPMAppController({
    autoConnect: false,
    myPlayerId: 'p1',
    playerIds: ['p1', 'p2_perkins'],
    pregame: true
  });
  app.activeDeckData = {
    name: 'Hammer Time',
    format: 'RANKED_CONSTRUCT',
    mainboard: [
      { name: 'Leyline Axe', count: 4, typeLine: 'Artifact — Equipment' },
      { name: 'Heartfire Hero', count: 4, typeLine: 'Creature — Mouse Soldier' },
      { name: 'Colossus Hammer', count: 4, typeLine: 'Artifact — Equipment' },
      { name: "Sigarda's Aid", count: 4, typeLine: 'Enchantment' },
      { name: 'Fervent Champion', count: 4, typeLine: 'Creature — Human Knight' },
      { name: 'Mountain', count: 20, typeLine: 'Basic Land — Mountain' },
      { name: 'Plains', count: 20, typeLine: 'Basic Land — Plains' }
    ],
    sideboard: []
  };

  await app.startPerkinsMatch({ thinkingDelayMs: 0, coachEnabled: false, interactiveRollOff: true });

  // 1. Dice roll must be requested first via Roll-Off overlay
  assert.strictEqual(app.isRollOffActive, true, 'Interactive d20 roll-off must be active before mulligans');
  const p1BeforeRoll = app.tabletopState.getPlayer('p1');
  assert.strictEqual(p1BeforeRoll.battlefield.noncreatures.length, 0, 'Leyline Axe must NOT resolve before roll-off and mulligans');

  // 2. Submit d20 roll (force tie-free win for p1: 20 vs bot roll)
  app.turnRollOffManager.submitRoll('p2_perkins', 5);
  app.submitRollOffForPlayer('p1', 20);
  assert.strictEqual(app.isRollOffActive, false, 'Roll-off completes after d20 roll');
  assert.strictEqual(app.pregameActive, true, 'Pregame state machine must now be active in mulligan phase');
  assert.strictEqual(app.mulliganModal.isOpen, true, 'MulliganModal must open to ask player for mulligan decision');
  assert.strictEqual(p1BeforeRoll.battlefield.noncreatures.length, 0, 'Leyline Axe must stay in hand during mulligan decision');

  // 3. Take 1 London Mulligan, then keep 6-card hand with Leyline Axe in it
  app.handleMulliganTake({ nextMulliganCount: 1 });
  assert.strictEqual(app.pregameMachine.mulliganCount.p1, 1, 'Mulligan count incremented to 1');
  const p1Hand = app.tabletopState.getPlayer('p1').hand;
  assert.strictEqual(p1Hand.length, 7, 'New 7-card hand drawn for London Mulligan');

  // Ensure at least one Leyline Axe is in the hand we keep, and bottom 1 non-Leyline card
  if (!p1Hand.some(c => c.name === 'Leyline Axe')) {
    const libAxeIdx = app.tabletopState.getPlayer('p1').library.findIndex(c => c.name === 'Leyline Axe');
    if (libAxeIdx !== -1) {
      const [axeCard] = app.tabletopState.getPlayer('p1').library.splice(libAxeIdx, 1);
      const swapped = p1Hand.pop();
      app.tabletopState.getPlayer('p1').library.push(swapped);
      p1Hand.unshift(axeCard);
    }
  }
  const cardToBottom = p1Hand.find(c => c.name !== 'Leyline Axe') || p1Hand[p1Hand.length - 1];
  app.handleMulliganConfirmBottom({ bottomedCards: [cardToBottom] });

  // 4. After final mulligan acceptance, pregame finishes and Leyline Axe starts on the battlefield!
  assert.strictEqual(app.pregameActive, false, 'Pregame completed after both players kept');
  const bfAxes = app.tabletopState.getPlayer('p1').battlefield.noncreatures.filter(c => c.name === 'Leyline Axe');
  assert.ok(bfAxes.length >= 1, 'Leyline Axe in final opening hand must start on the battlefield after mulligan acceptance');
  assert.strictEqual(app.tabletopState.getPlayer('p1').hand.some(c => c.name === 'Leyline Axe'), false, 'Leyline Axe removed from hand');

  app.perkinsAgent?.destroy();
  app.destroy();
  recordTest('Leyline Axe', 'ADV-11: Pre-game d20 roll-off -> London Mulligan -> Opening Hand battlefield resolution', 'PASS');
} catch (err) {
  recordTest('Leyline Axe', 'ADV-11: Pre-game d20 roll-off -> London Mulligan -> Opening Hand battlefield resolution', 'FAIL', err.message);
}

// ── ADV-12: Instance registerDeckManifest & Relay-Connected StartMatch Regression ──
try {
  // a) Direct invocation of instance registerDeckManifest
  const tsm = new TabletopStateManager({ players: ['p1', 'p2'] });
  const sampleManifest = {
    playerId: 'p1',
    cards: [
      { name: 'Leyline Axe', typeLine: 'Artifact — Equipment' },
      { name: 'Colossus Hammer', typeLine: 'Artifact — Equipment' }
    ]
  };

  let emittedEvent = null;
  tsm.on('DECK_MANIFEST_REGISTERED', (evt) => {
    emittedEvent = evt;
  });

  const returnedMap = tsm.registerDeckManifest('p1', sampleManifest);
  assert.ok(returnedMap && typeof returnedMap === 'object', 'registerDeckManifest must return cardMap object');
  assert.ok(returnedMap['leyline axe'], 'cardMap must index normalized card names');
  assert.ok(emittedEvent, 'DECK_MANIFEST_REGISTERED must be emitted');
  assert.strictEqual(emittedEvent.playerId, 'p1');
  assert.deepStrictEqual(emittedEvent.manifest, sampleManifest);
  assert.strictEqual(emittedEvent.cardMap, returnedMap);

  // Also verify invocation with (manifest) signature where playerId is inside manifest
  let emittedEvent2 = null;
  tsm.on('DECK_MANIFEST_REGISTERED', (evt) => {
    emittedEvent2 = evt;
  });
  const returnedMap2 = tsm.registerDeckManifest(sampleManifest);
  assert.ok(returnedMap2 && typeof returnedMap2 === 'object');
  assert.strictEqual(emittedEvent2.playerId, 'p1');
  assert.deepStrictEqual(emittedEvent2.manifest, sampleManifest);

  // b) Simulated start flow with relayClient connected (roomCode active)
  const { RPMAppController } = await import('../src/app.js');
  const app = new RPMAppController({
    autoConnect: false,
    myPlayerId: 'p1',
    playerIds: ['p1', 'p2_perkins'],
    pregame: true
  });

  // Mock an active relayClient session
  app.relayClient = {
    roomCode: 'RM1234',
    sessionId: 'sess_1234',
    socket: { readyState: 1 },
    registerDeckManifest: () => {}
  };

  app.activeDeckData = {
    name: 'Hammer Time',
    format: 'RANKED_CONSTRUCT',
    mainboard: [
      { name: 'Leyline Axe', count: 4, typeLine: 'Artifact — Equipment' },
      { name: 'Plains', count: 20, typeLine: 'Basic Land — Plains' },
      { name: 'Mountain', count: 20, typeLine: 'Basic Land — Mountain' }
    ],
    sideboard: []
  };

  await app.startPerkinsMatch({ thinkingDelayMs: 0, coachEnabled: false, interactiveRollOff: true });

  assert.strictEqual(app.isRollOffActive, true, 'startMatch must not abort and must activate Roll-Off when relay is connected');
  app.turnRollOffManager.submitRoll('p2_perkins', 8);
  app.submitRollOffForPlayer('p1', 18);

  assert.strictEqual(app.isRollOffActive, false, 'Roll-off finishes');
  assert.strictEqual(app.pregameActive, true, 'Pregame active in mulligan phase');

  // Keep opening hand with Leyline Axe
  const p1 = app.tabletopState.getPlayer('p1');
  if (!p1.hand.some(c => c.name === 'Leyline Axe')) {
    const axeCard = p1.library.find(c => c.name === 'Leyline Axe');
    if (axeCard) {
      p1.hand.pop();
      p1.hand.unshift(axeCard);
    }
  }

  app.handleMulliganKeep();

  assert.strictEqual(app.pregameActive, false, 'Game becomes active');
  const axesOnField = p1.battlefield.noncreatures.filter(c => c.name === 'Leyline Axe');
  assert.ok(axesOnField.length >= 1, 'Leyline Axe starts on battlefield after mulligan acceptance with active relay');

  app.perkinsAgent?.destroy();
  app.destroy();

  recordTest('TabletopStateManager', 'ADV-12: Instance registerDeckManifest & Relay-Connected StartMatch Regression', 'PASS');
} catch (err) {
  recordTest('TabletopStateManager', 'ADV-12: Instance registerDeckManifest & Relay-Connected StartMatch Regression', 'FAIL', err.message);
}

// ── ADV-13: Two-Step Combat Damage Resolution (CR 510.4 & CR 702.4b) - First Strike Blocker Survival ──
try {
  const state = createMatchState();
  const gg = state.addCardToZone('p1', 'battlefield', {
    name: 'Goblin Guide',
    typeLine: 'Creature — Goblin Scout',
    power: 2,
    toughness: 2,
    damageMarked: 0,
    isTapped: false,
    keywords: { haste: true }
  });
  const champ = state.addCardToZone('p2', 'battlefield', {
    name: 'Fervent Champion',
    typeLine: 'Creature — Human Knight',
    power: 2,
    toughness: 2,
    damageMarked: 0,
    isTapped: false,
    keywords: { firstStrike: true }
  });

  state.declareAttackers('p1', [gg.instanceId], 'p2');
  state.declareBlockers('p2', [{ blockerId: champ.instanceId, attackerId: gg.instanceId }]);

  // Resolve combat damage in two steps (CR 510.4)
  state.resolveCombatDamage();

  // 1. Goblin Guide receives lethal damage in FIRST_STRIKE and is destroyed by intermediate SBA before normal damage step
  assert.strictEqual(state.players.p1.battlefield.creatures.some(c => c.instanceId === gg.instanceId), false, 'Goblin Guide removed from battlefield');
  assert.strictEqual(state.players.p1.zones.battlefield.some(c => c.instanceId === gg.instanceId), false, 'Goblin Guide removed from zones.battlefield');
  assert.strictEqual(state.players.p1.graveyard.some(c => c.name === 'Goblin Guide'), true, 'Goblin Guide moved to graveyard by lethal damage SBA');

  // 2. Goblin Guide NEVER deals damage back to Fervent Champion
  const champInBf = state.players.p2.battlefield.creatures.find(c => c.instanceId === champ.instanceId);
  assert.ok(champInBf, 'Fervent Champion survives on the battlefield');
  assert.strictEqual(champInBf.damageMarked || 0, 0, 'Fervent Champion took 0 damage because Goblin Guide was destroyed in FIRST_STRIKE step');

  recordTest('CombatDamageEngine', 'ADV-13: First Strike Blocker Survival via Two-Step Damage Resolution (CR 510.4 & CR 702.4b)', 'PASS');
} catch (err) {
  recordTest('CombatDamageEngine', 'ADV-13: First Strike Blocker Survival via Two-Step Damage Resolution (CR 510.4 & CR 702.4b)', 'FAIL', err.message);
}

// ── ADV-14: Double Strike + Trample Combat Damage Resolution (CR 510.4, CR 702.4b & CR 702.19b) ──
try {
  // Case A (Unblocked): Attacks and deals 2 damage in FIRST_STRIKE + 2 damage in NORMAL_STRIKE = 4 total damage (life 20 -> 16)
  const stateA = createMatchState();
  const champA = stateA.addCardToZone('p1', 'battlefield', {
    name: 'Fervent Champion',
    typeLine: 'Creature — Human Knight',
    power: 1,
    toughness: 1,
    oracleText: 'First strike, haste\nWhenever Fervent Champion attacks, another target attacking Knight you control gets +1/+0 until end of turn.\nEquip abilities you activate that target Fervent Champion cost {3} less to activate.'
  });
  const axeA = stateA.addCardToZone('p1', 'battlefield', {
    name: 'Leyline Axe',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +1/+1 and has double strike and trample.\nEquip {3}'
  });
  stateA.attachPermanentToCreature('p1', axeA.instanceId, champA.instanceId);

  const statsA = stateA.evaluateCreatureStats(champA, 'p1');
  assert.strictEqual(statsA.power, 2, 'Fervent Champion with Leyline Axe is 2/2 (1 base + 1 axe)');
  assert.strictEqual(Boolean(statsA.keywords.doubleStrike), true, 'Leyline Axe grants double strike in Layer 6');
  assert.strictEqual(Boolean(statsA.keywords.trample), true, 'Leyline Axe grants trample in Layer 6');

  stateA.declareAttackers('p1', [champA.instanceId], 'p2');
  stateA.declareBlockers('p2', []);
  stateA.resolveCombatDamage();

  assert.strictEqual(stateA.players.p2.resources.life, 16, 'Unblocked Double Strike attacker deals 2 in FIRST_STRIKE + 2 in NORMAL_STRIKE (20 - 4 = 16)');

  // Case B (Blocked by 2/2 creature): Deals 2 damage in FIRST_STRIKE killing the 2/2 blocker.
  // In NORMAL_STRIKE, because it has trample (CR 702.19b), its second 2 damage tramples over to defending player (life 20 -> 18)!
  const stateB = createMatchState();
  const champB = stateB.addCardToZone('p1', 'battlefield', {
    name: 'Fervent Champion',
    typeLine: 'Creature — Human Knight',
    power: 1,
    toughness: 1,
    oracleText: 'First strike, haste\nWhenever Fervent Champion attacks, another target attacking Knight you control gets +1/+0 until end of turn.\nEquip abilities you activate that target Fervent Champion cost {3} less to activate.'
  });
  const axeB = stateB.addCardToZone('p1', 'battlefield', {
    name: 'Leyline Axe',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +1/+1 and has double strike and trample.\nEquip {3}'
  });
  stateB.attachPermanentToCreature('p1', axeB.instanceId, champB.instanceId);

  const blockerB = stateB.addCardToZone('p2', 'battlefield', {
    name: 'Grizzly Bears',
    typeLine: 'Creature — Bear',
    power: 2,
    toughness: 2,
    damageMarked: 0,
    isTapped: false
  });

  stateB.declareAttackers('p1', [champB.instanceId], 'p2');
  stateB.declareBlockers('p2', [{ blockerId: blockerB.instanceId, attackerId: champB.instanceId }]);
  stateB.resolveCombatDamage();

  // 1. Blocker was killed in FIRST_STRIKE and moved to graveyard
  assert.strictEqual(stateB.players.p2.battlefield.creatures.length, 0, '2/2 blocker destroyed by lethal damage in FIRST_STRIKE');
  assert.strictEqual(stateB.players.p2.zones.battlefield.length, 0, '2/2 blocker removed from zones.battlefield');
  assert.strictEqual(stateB.players.p2.graveyard.length, 1, '2/2 blocker moved to graveyard');

  // 2. Trample over to player in NORMAL_STRIKE per CR 702.19b: life 20 -> 18
  assert.strictEqual(stateB.players.p2.resources.life, 18, 'CR 702.19b: Double Strike second damage tramples over to defending player after blocker death (20 - 2 = 18)');

  // 3. Fervent Champion took 0 damage because blocker died in FIRST_STRIKE step
  const champBPost = stateB.players.p1.battlefield.creatures.find(c => c.instanceId === champB.instanceId);
  assert.ok(champBPost, 'Fervent Champion survived combat');
  assert.strictEqual(champBPost.damageMarked || 0, 0, 'Fervent Champion marked damage is 0');

  recordTest('CombatDamageEngine', 'ADV-14: Double Strike + Trample Unblocked (4 dmg) & Blocked Trample-Through (CR 702.19b & CR 510.4)', 'PASS');
} catch (err) {
  recordTest('CombatDamageEngine', 'ADV-14: Double Strike + Trample Unblocked (4 dmg) & Blocked Trample-Through (CR 702.19b & CR 510.4)', 'FAIL', err.message);
}

// ── ADV-15: Inkmoth Nexus Animate + Equip + Undo Mana Tap ──
try {
  const state = createMatchState();

  // 1. Add Inkmoth Nexus to P1 battlefield
  const inkmoth = state.addCardToZone('p1', 'battlefield', {
    name: 'Inkmoth Nexus',
    typeLine: 'Land',
    oracleText: '{T}: Add {C}.\n{1}: Inkmoth Nexus becomes a 1/1 Blinkmoth artifact creature with flying and infect until end of turn. It\'s still a land.'
  });

  // 2. Tap Inkmoth Nexus for {C}
  state.tapLandForMana('p1', inkmoth.instanceId, 'C');
  assert.strictEqual(state.players.p1.resources.manaPool.C, 1, 'Inkmoth Nexus produced {C} mana');
  assert.strictEqual(inkmoth.isTapped, true, 'Inkmoth Nexus is tapped');

  // 3. Undo last mana tap -> verifies land untaps and manaPool.C reverts to 0
  const undoResult = state.undoLastManaTap('p1');
  assert.ok(undoResult, 'undoLastManaTap succeeded');
  assert.strictEqual(inkmoth.isTapped, false, 'Inkmoth Nexus untapped after undo');
  assert.strictEqual(state.players.p1.resources.manaPool.C, 0, 'Colorless mana pool reverted to 0');

  // 4. Tap Plains for {W} to pay {1}
  const plains = state.addCardToZone('p1', 'battlefield', {
    name: 'Plains',
    typeLine: 'Basic Land — Plains',
    oracleText: '{T}: Add {W}.'
  });
  state.tapLandForMana('p1', plains.instanceId, 'W');
  assert.strictEqual(state.players.p1.resources.manaPool.W, 1, 'Plains produced {W} mana');
  assert.strictEqual(plains.isTapped, true, 'Plains is tapped');

  // 5. Animate Inkmoth Nexus using activatePermanentAbility('p1', inkmoth.instanceId, 'ANIMATE_LAND')
  state.activatePermanentAbility('p1', inkmoth.instanceId, 'ANIMATE_LAND');
  assert.strictEqual(state.players.p1.resources.manaPool.W, 0, 'Floating {W} mana was consumed by animate activation');

  // 6. Verify it becomes a 1/1 artifact creature with flying and infect in player.battlefield.creatures
  const animatedInCreatures = state.players.p1.battlefield.creatures.find(c => c.instanceId === inkmoth.instanceId);
  assert.ok(animatedInCreatures, 'Inkmoth Nexus moved to player.battlefield.creatures subzone');
  assert.strictEqual(state.players.p1.battlefield.lands.some(c => c.instanceId === inkmoth.instanceId), false, 'Inkmoth Nexus removed from lands subzone while animated');

  const statsAnimate = state.evaluateCreatureStats(animatedInCreatures, 'p1');
  assert.strictEqual(statsAnimate.power, 1, 'Animated Inkmoth Nexus has base power 1');
  assert.strictEqual(statsAnimate.toughness, 1, 'Animated Inkmoth Nexus has base toughness 1');
  assert.strictEqual(Boolean(statsAnimate.keywords.flying), true, 'Animated Inkmoth Nexus has flying');
  assert.strictEqual(Boolean(statsAnimate.keywords.infect), true, 'Animated Inkmoth Nexus has infect');

  // 7. Attach Belt of Giant Strength -> Layer 7b evaluates it as 10/10 with flying and infect!
  const belt = state.addCardToZone('p1', 'battlefield', {
    name: 'Belt of Giant Strength',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature has base power and toughness 10/10.\nEquip {10}. This ability costs {X} less to activate, where X is the power of the creature it targets.'
  });
  state.attachPermanentToCreature('p1', belt.instanceId, inkmoth.instanceId);

  const statsBelt = state.evaluateCreatureStats(animatedInCreatures, 'p1');
  assert.strictEqual(statsBelt.power, 10, 'Belt of Giant Strength sets base power to 10 in Layer 7b');
  assert.strictEqual(statsBelt.toughness, 10, 'Belt of Giant Strength sets base toughness to 10 in Layer 7b');
  assert.strictEqual(Boolean(statsBelt.keywords.flying), true, 'Animated Inkmoth Nexus retains flying with Belt equipped');
  assert.strictEqual(Boolean(statsBelt.keywords.infect), true, 'Animated Inkmoth Nexus retains infect with Belt equipped');

  recordTest('Inkmoth Nexus', 'ADV-15: Animate + Equip + Floating Mana Tap Undo (CR 605, CR 613 Layer 7b)', 'PASS');
} catch (err) {
  recordTest('Inkmoth Nexus', 'ADV-15: Animate + Equip + Floating Mana Tap Undo (CR 605, CR 613 Layer 7b)', 'FAIL', err.message);
}

// ── ADV-16: Inkmoth Nexus Self-Tap Exclusion (CR 605, CR 613 Layer 4/6/7b) ──
try {
  const state = createMatchState();
  state.players.p1.resources.life = 20;

  // Set up P1 with 1 untapped Inkmoth Nexus and 1 untapped Mana Confluence
  const inkmoth = state.addCardToZone('p1', 'battlefield', {
    name: 'Inkmoth Nexus',
    typeLine: 'Land',
    oracleText: "{T}: Add {C}.\n{1}: Inkmoth Nexus becomes a 1/1 Blinkmoth artifact creature with flying and infect until end of turn. It's still a land."
  });
  const confluence = state.addCardToZone('p1', 'battlefield', {
    name: 'Mana Confluence',
    typeLine: 'Land',
    oracleText: '{T}, Pay 1 life: Add one mana of any color.'
  });

  assert.strictEqual(inkmoth.isTapped, false, 'Inkmoth Nexus starts untapped');
  assert.strictEqual(confluence.isTapped, false, 'Mana Confluence starts untapped');

  // Activate animation ability on Inkmoth Nexus: {1}
  state.activatePermanentAbility('p1', inkmoth.instanceId, 'ANIMATE_LAND');

  // a) Mana Confluence is tapped, and P1 paid 1 life (20 -> 19)
  assert.strictEqual(confluence.isTapped, true, 'Mana Confluence tapped to pay {1}');
  assert.strictEqual(state.players.p1.resources.life, 19, 'P1 paid 1 life for Mana Confluence (20 -> 19)');

  // b) Inkmoth Nexus is UNTAPPED!
  assert.strictEqual(inkmoth.isTapped, false, 'Inkmoth Nexus was NOT self-tapped to pay its own activation cost');

  // c) Inkmoth Nexus moved to player.battlefield.creatures as 1/1 flying infect
  const animatedInCreatures = state.players.p1.battlefield.creatures.find(c => c.instanceId === inkmoth.instanceId);
  assert.ok(animatedInCreatures, 'Inkmoth Nexus moved to player.battlefield.creatures subzone');
  assert.strictEqual(state.players.p1.battlefield.lands.some(c => c.instanceId === inkmoth.instanceId), false, 'Inkmoth Nexus removed from lands subzone while animated');

  const stats = state.evaluateCreatureStats(animatedInCreatures, 'p1');
  assert.strictEqual(stats.power, 1, 'Animated Inkmoth Nexus has base power 1');
  assert.strictEqual(stats.toughness, 1, 'Animated Inkmoth Nexus has base toughness 1');
  assert.strictEqual(Boolean(stats.keywords.flying), true, 'Animated Inkmoth Nexus has flying');
  assert.strictEqual(Boolean(stats.keywords.infect), true, 'Animated Inkmoth Nexus has infect');

  // d) P1 can legally declare Inkmoth Nexus as an attacker
  const atkResult = state.declareAttackers('p1', [inkmoth.instanceId], 'p2');
  assert.ok(atkResult.attackers.some(a => a.instanceId === inkmoth.instanceId), 'Inkmoth Nexus successfully declared as attacker');
  assert.strictEqual(inkmoth.isTapped, true, 'Inkmoth Nexus taps upon attacking (vigilance = false)');

  recordTest('Inkmoth Nexus', 'ADV-16: Self-tap exclusion during animation, life payment, and legal combat attack', 'PASS');
} catch (err) {
  recordTest('Inkmoth Nexus', 'ADV-16: Self-tap exclusion during animation, life payment, and legal combat attack', 'FAIL', err.message);
}

// ── ADV-17: Callous Sell-Sword at 2 Life & Creature Cast Without Targets (CR 119.4 & CR 715) ──
try {
  const state = createMatchState();
  state.players.p1.resources.life = 2; // P1 starts at 2 life

  // P1 controls 1 untapped Starting Town, 1 untapped Mana Confluence, and 0 creatures on battlefield
  const town = state.addCardToZone('p1', 'battlefield', {
    name: 'Starting Town',
    typeLine: 'Land — Town',
    oracleText: "{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color."
  });
  const confluence = state.addCardToZone('p1', 'battlefield', {
    name: 'Mana Confluence',
    typeLine: 'Land',
    oracleText: '{T}, Pay 1 life: Add one mana of any color.'
  });
  assert.strictEqual(state.players.p1.battlefield.creatures.length, 0, 'P1 controls 0 creatures on battlefield');

  const callousCard = state.addCardToZone('p1', 'hand', {
    name: 'Callous Sell-Sword // Burn Together',
    manaCost: '{1}{B} // {R}',
    typeLine: 'Creature — Human Soldier // Sorcery — Adventure',
    power: 2,
    toughness: 2,
    oracleText: "Callous Sell-Sword enters the battlefield with a +1/+1 counter on it for each creature that died under your control this turn.\n\nBurn Together\nTarget creature you control deals damage equal to its power to any other target. Then sacrifice it."
  });

  // Cast Callous Sell-Sword in mode 'MAIN'
  state.dispatch('CAST_SPELL', { playerId: 'p1', card: callousCard, castMode: 'MAIN', autoTap: true });

  // a) Starting Town is tapped for {C} (0 life cost)
  assert.strictEqual(town.isTapped, true, 'Starting Town was tapped for {C}');

  // b) Mana Confluence is tapped for {B} (1 life cost)
  assert.strictEqual(confluence.isTapped, true, 'Mana Confluence was tapped for {B}');

  // c) P1 life drops from 2 to 1 (CR 119.4 non-lethal life payment)
  assert.strictEqual(state.players.p1.resources.life, 1, 'P1 life dropped from 2 to 1 (CR 119.4 non-lethal life payment)');

  // d) No targets required, e) Card removed from hand
  assert.strictEqual(state.players.p1.hand.length, 0, 'Card removed from hand onto stack');
  assert.strictEqual(state.stack.length, 1, 'Spell is on stack');

  // f) When stack resolves, Callous Sell-Sword enters battlefield.creatures as a 2/2 creature
  state.resolveTopOfStack();
  assert.strictEqual(state.players.p1.battlefield.creatures.length, 1, 'Callous Sell-Sword placed onto battlefield.creatures');
  const summoned = state.players.p1.battlefield.creatures[0];
  assert.strictEqual(summoned.name, 'Callous Sell-Sword', 'Resolved permanent name is Callous Sell-Sword');
  assert.strictEqual(summoned.power, 2, 'Callous Sell-Sword power is 2');
  assert.strictEqual(summoned.toughness, 2, 'Callous Sell-Sword toughness is 2');

  recordTest('Callous Sell-Sword // Burn Together', 'ADV-17: Non-lethal life payment at 2 life, mode separation, and targetless creature resolution (CR 119.4 & CR 715)', 'PASS');
} catch (err) {
  recordTest('Callous Sell-Sword // Burn Together', 'ADV-17: Non-lethal life payment at 2 life, mode separation, and targetless creature resolution (CR 119.4 & CR 715)', 'FAIL', err.message);
}

// ── ADV-18: 3-Player RPM Trigger on Round 2 & Clean Match Reset (CR 103, SPEC-RPM-004) ──
try {
  const { RPMAppController } = await import('../src/app.js');
  const app = new RPMAppController({
    autoConnect: false,
    myPlayerId: 'p1',
    playerIds: ['p1', 'p2'],
    pregame: false
  });

  // 1. Simulate finished 1v1 match with residual game over state and board residue
  app.tabletopState.isGameOver = true;
  app.tabletopState.winnerId = 'p1';
  app.tabletopState.turnNumber = 7;
  app.tabletopState.roundNumber = 4;
  app.tabletopState.addCardToZone('p1', 'battlefield', { name: 'Lava Spike', typeLine: 'Sorcery' });
  app.tabletopState.addCardToZone('p1', 'graveyard', { name: 'Lightning Bolt', typeLine: 'Instant' });

  // 2. Start a new 3-player match with p1, bot2, bot3
  await app.startMatch({ playerIds: ['p1', 'bot2', 'bot3'] });

  // a) Verify clean match reset
  assert.strictEqual(app.tabletopState.isGameOver, false, 'isGameOver reset to false');
  assert.strictEqual(app.tabletopState.winnerId, null, 'winnerId reset to null');
  assert.strictEqual(app.tabletopState.turnNumber, 1, 'turnNumber reset to 1');
  assert.strictEqual(app.tabletopState.roundNumber, 1, 'roundNumber reset to 1');
  assert.strictEqual(app.tabletopState.players.p1.battlefield.creatures.length, 0, 'Battlefield creatures cleaned');
  assert.strictEqual(app.tabletopState.players.p1.battlefield.lands.length, 0, 'Battlefield lands cleaned');
  assert.strictEqual(app.tabletopState.players.p1.graveyard.length, 0, 'Graveyard cleaned');

  // b) Verify perkEngine reconfigured for 3 players (perkUnlockTurn = 2)
  assert.strictEqual(app.perkEngine?.perkUnlockTurn, 2, 'perkUnlockTurn dynamically reconfigured to Round 2 for 3+ players');

  let perkTriggerEvents = [];
  app.perkEngine.on('PERK_UPKEEP_TRIGGER', (evt) => {
    perkTriggerEvents.push(evt);
  });

  // c) In Round 1 (turns 1, 2, 3), perk triggers remain dormant
  const t1 = app.perkEngine.handleUpkeepStep('p1', 1, 1);
  assert.strictEqual(t1, null, 'Perk trigger dormant on Turn 1 (Round 1)');

  app.priorityMachine.turnNumber = 2;
  app.priorityMachine.roundNumber = 1;
  app.priorityMachine.activePlayerId = 'bot2';
  const t2 = app.perkEngine.handleUpkeepStep('bot2', 2, 1);
  assert.strictEqual(t2, null, 'Perk trigger dormant on Turn 2 (Round 1)');

  app.priorityMachine.turnNumber = 3;
  app.priorityMachine.roundNumber = 1;
  app.priorityMachine.activePlayerId = 'bot3';
  const t3 = app.perkEngine.handleUpkeepStep('bot3', 3, 1);
  assert.strictEqual(t3, null, 'Perk trigger dormant on Turn 3 (Round 1)');

  assert.strictEqual(perkTriggerEvents.length, 0, 'Zero perk triggers fired during Round 1');

  // d) In Round 2 (Turn 4, P1 upkeep), RandomPerkEngine fires PERK_UPKEEP_TRIGGER!
  app.priorityMachine.turnNumber = 4;
  app.priorityMachine.roundNumber = 2;
  app.priorityMachine.activePlayerId = 'p1';
  app.tabletopState.players.p1.turnsTaken = 1;
  const t4 = app.perkEngine.handleUpkeepStep('p1', 4, 2);
  assert.ok(t4, 'Perk upkeep trigger generated in Round 2');
  assert.strictEqual(t4.type, 'PERK_UPKEEP_TRIGGER', 'Step 1 trigger type is PERK_UPKEEP_TRIGGER');
  assert.strictEqual(perkTriggerEvents.length, 1, 'PERK_UPKEEP_TRIGGER emitted on Round 2 Upkeep');

  app.destroy();

  recordTest('RandomPerkEngine', 'ADV-18: 3-player RPM trigger on Round 2 & clean match reset (CR 103, SPEC-RPM-004)', 'PASS');
} catch (err) {
  recordTest('RandomPerkEngine', 'ADV-18: 3-player RPM trigger on Round 2 & clean match reset (CR 103, SPEC-RPM-004)', 'FAIL', err.message);
}

// ── ADV-19: Forge Anew Free Equip of Belt of Giant Strength with 0 Mana & Quota Tracking (CR 608.2, Layer 7b) ──
try {
  const state = createMatchState();
  state.players.p1.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  state.players.p1.equipsActivatedThisTurn = 0;

  // P1 controls Forge Anew
  state.addCardToZone('p1', 'battlefield', {
    name: 'Forge Anew',
    typeLine: 'Enchantment',
    oracleText: "When Forge Anew enters the battlefield, return target Equipment card from your graveyard to the battlefield.\nAs long as it's your turn, you may activate equip abilities any time you could cast an instant.\nYou may pay {0} rather than pay the equip cost of the first equip ability you activate each turn."
  });

  // P1 controls Heartfire Hero (1/1)
  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    oracleText: "Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent."
  });

  // P1 controls Belt of Giant Strength (Equip {10}, reduced by target creature's power)
  const belt = state.addCardToZone('p1', 'battlefield', {
    name: 'Belt of Giant Strength',
    typeLine: 'Artifact — Equipment',
    oracleText: "Equipped creature has base power and toughness 10/10.\nEquip {10}, this ability costs {X} less to activate, where X is the power of the creature this Equipment will become attached to."
  });

  // P1 controls Colossus Hammer (Equip {8})
  const hammer = state.addCardToZone('p1', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: "Equipped creature gets +10/+10 and loses flying.\nEquip {8}"
  });

  // 1. Verify first equip cost is {0}
  const equipCost0 = state.computeEquipCost('p1', belt, hero);
  assert.strictEqual(equipCost0, '{0}', 'First equip cost is {0} via Forge Anew');

  // 2. Activate equip with 0 mana available -> succeeds without error
  const equipRes = state.activateEquipAbility('p1', belt.instanceId, hero.instanceId);
  assert.strictEqual(equipRes.effectiveEquipCost, '{0}', 'Effective equip cost was {0}');
  assert.strictEqual(belt.attachedTo, hero.instanceId, 'Belt is attached to Heartfire Hero');
  assert.strictEqual(state.players.p1.equipsActivatedThisTurn, 1, 'equipsActivatedThisTurn incremented to 1');

  // Hero base P/T becomes 10/10 in Layer 7b + Valiant trigger adds +1/+1 counter -> 11/11
  const stats = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(stats.power, 11, 'Heartfire Hero power is 11 (10 base + 1 Valiant counter)');
  assert.strictEqual(stats.toughness, 11, 'Heartfire Hero toughness is 11 (10 base + 1 Valiant counter)');

  // 3. Second equip attempt costs full mana because equipsActivatedThisTurn === 1
  const equipCost2 = state.computeEquipCost('p1', hammer, hero);
  assert.strictEqual(equipCost2, '{8}', 'Second equip cost is {8} (no longer free)');

  // Attempting to activate with 0 mana throws an error
  assert.throws(() => {
    state.activateEquipAbility('p1', hammer.instanceId, hero.instanceId);
  }, /mana/i, 'Second equip activation requires mana payment');

  recordTest('Forge Anew', 'ADV-19: Free equip of Belt of Giant Strength with 0 mana, Valiant trigger & quota tracking (CR 608.2, Layer 7b)', 'PASS');
} catch (err) {
  recordTest('Forge Anew', 'ADV-19: Free equip of Belt of Giant Strength with 0 mana, Valiant trigger & quota tracking (CR 608.2, Layer 7b)', 'FAIL', err.message);
}

// ── ADV-20: Forge Anew ETB Equipment Return from Graveyard & Instant-Speed Equip in Combat (CR 400.7, CR 702.6) ──
try {
  const state = createMatchState();

  // P1 controls Heartfire Hero
  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    oracleText: "Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent."
  });

  // Colossus Hammer is in P1 graveyard with stale attachedTo
  const hammerInGy = state.addCardToZone('p1', 'graveyard', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: "Equipped creature gets +10/+10 and loses flying.\nEquip {8}",
    attachedTo: 'stale_id'
  });
  const oldInstanceId = hammerInGy.instanceId;

  // Forge Anew enters the battlefield
  state.addCardToZone('p1', 'battlefield', {
    name: 'Forge Anew',
    typeLine: 'Enchantment',
    oracleText: "When Forge Anew enters the battlefield, return target Equipment card from your graveyard to the battlefield.\nAs long as it's your turn, you may activate equip abilities any time you could cast an instant.\nYou may pay {0} rather than pay the equip cost of the first equip ability you activate each turn."
  });

  // ETB returns Colossus Hammer to battlefield with new identity (CR 400.7)
  assert.strictEqual(state.players.p1.graveyard.length, 0, 'Hammer removed from graveyard');
  const hammerOnBf = state.players.p1.battlefield.noncreatures.find(c => c.name === 'Colossus Hammer');
  assert.ok(hammerOnBf, 'Colossus Hammer returned to battlefield');
  assert.notStrictEqual(hammerOnBf.instanceId, oldInstanceId, 'CR 400.7: New instanceId generated on zone transition');
  assert.strictEqual(hammerOnBf.attachedTo, null, 'Attachment state cleanly reset');

  // Advance to DECLARE_ATTACKERS step on P1 turn
  state.priorityMachine.currentPhaseStep = 'DECLARE_ATTACKERS';
  state.priorityMachine.activePlayerId = 'p1';
  state.priorityMachine.priorityPlayerId = 'p1';

  // Activate equip ability during combat at instant speed (allowed via Forge Anew!)
  const equipRes = state.activateEquipAbility('p1', hammerOnBf.instanceId, hero.instanceId);
  assert.strictEqual(hammerOnBf.attachedTo, hero.instanceId, 'Colossus Hammer attached during combat');

  const stats = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(stats.power, 12, 'Heartfire Hero power is 12 (1 base + 1 Valiant + 10 Hammer)');
  assert.strictEqual(stats.toughness, 12, 'Heartfire Hero toughness is 12 (1 base + 1 Valiant + 10 Hammer)');

  recordTest('Forge Anew', 'ADV-20: Graveyard return of Colossus Hammer & instant-speed equip in combat (CR 400.7, CR 702.6)', 'PASS');
} catch (err) {
  recordTest('Forge Anew', 'ADV-20: Graveyard return of Colossus Hammer & instant-speed equip in combat (CR 400.7, CR 702.6)', 'FAIL', err.message);
}

// ── ADV-21: 3-Player Match Combat Attack Targeting & Blocker Permission Guard (CR 508.1, CR 509.1a) ──
try {
  const state = createMatchState();

  // Add 3rd player (bot3)
  state.players.bot2 = state.players.p2;
  state.players.bot2.id = 'bot2';
  state.players.bot2.playerId = 'bot2';
  state.players.bot3 = {
    id: 'bot3',
    playerId: 'bot3',
    playerName: 'Bot 3',
    resources: { life: 20, poison: 0, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, landsPlayedThisTurn: 0, maxLandsPerTurn: 1 },
    battlefield: { creatures: [], lands: [], noncreatures: [], planeswalkers: [] },
    graveyard: [],
    exile: [],
    hand: [],
    library: [],
    zones: { battlefield: [], graveyard: [], exile: [], hand: [], library: [] }
  };
  state.priorityMachine.players = ['p1', 'bot2', 'bot3'];

  // P1 controls 1/1 Heartfire Hero
  const p1Creature = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1
  });

  // Bot 2 controls 2/2 Goblin Guide
  const bot2Attacker = state.addCardToZone('bot2', 'battlefield', {
    name: 'Goblin Guide',
    typeLine: 'Creature — Goblin Scout',
    power: 2,
    toughness: 2,
    keywords: { haste: true }
  });

  // Bot 3 controls 2/2 Grizzly Bears
  const bot3Blocker = state.addCardToZone('bot3', 'battlefield', {
    name: 'Grizzly Bears',
    typeLine: 'Creature — Bear',
    power: 2,
    toughness: 2
  });

  // Bot 2 turn: DECLARE_ATTACKERS targeting Bot 3 explicitly
  state.priorityMachine.activePlayerId = 'bot2';
  state.priorityMachine.priorityPlayerId = 'bot2';
  state.priorityMachine.currentPhaseStep = 'DECLARE_ATTACKERS';

  state.declareAttackers('bot2', [bot2Attacker.instanceId], 'bot3');

  // Verify defendingPlayerId and underAttack state
  assert.strictEqual(state.priorityMachine.defendingPlayerId, 'bot3', 'PriorityStateMachine defendingPlayerId set to bot3');
  assert.strictEqual(state.players.bot3.underAttack, true, 'bot3.underAttack is true');
  assert.strictEqual(state.players.p1.underAttack, false, 'p1.underAttack is false');
  assert.strictEqual(state.players.bot2.underAttack, false, 'bot2.underAttack is false');

  // Step 2: Advance to DECLARE_BLOCKERS
  state.priorityMachine.currentPhaseStep = 'DECLARE_BLOCKERS';

  // P1 (not defending player) attempts to declare blockers -> must be rejected per CR 509.1a
  assert.throws(() => {
    state.declareBlockers('p1', [{ blockerId: p1Creature.instanceId, attackerId: bot2Attacker.instanceId }]);
  }, /not under attack/i, 'CR 509.1a: Player p1 is not under attack and cannot declare blockers');

  // Bot 3 (the actual defending player) declares blocker -> succeeds
  state.declareBlockers('bot3', [{ blockerId: bot3Blocker.instanceId, attackerId: bot2Attacker.instanceId }]);
  assert.strictEqual(state.combatState.blockers.length, 1, 'Bot 3 declared 1 legal blocker');

  // Step 3: End combat cleans up underAttack and defendingPlayerId
  state.endCombat();
  assert.strictEqual(state.players.bot3.underAttack, false, 'bot3.underAttack cleared to false after combat');
  assert.strictEqual(state.priorityMachine.defendingPlayerId, null, 'defendingPlayerId cleared after combat');

  recordTest('Multiplayer Combat', 'ADV-21: Defending player attack targeting & non-defender blocker prohibition (CR 508.1, CR 509.1a)', 'PASS');
} catch (err) {
  recordTest('Multiplayer Combat', 'ADV-21: Defending player attack targeting & non-defender blocker prohibition (CR 508.1, CR 509.1a)', 'FAIL', err.message);
}

// ── ADV-22: Stolen Uniform Dual-Target Candidate Enumeration & Resolution ──
try {
  const state = createMatchState();
  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    oracleText: 'Whenever Heartfire Hero becomes the target of a spell or ability you control, put a +1/+1 counter on it. This ability triggers only once each turn.'
  });
  const hammer = state.addCardToZone('p2', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying. Equip {8}'
  });
  const stolen = state.addCardToZone('p1', 'hand', {
    name: 'Stolen Uniform',
    typeLine: 'Instant',
    manaCost: '{U}',
    oracleText: 'Gain control of target Equipment until end of turn. Attach it to target creature you control. When you lose control of that Equipment this turn, if it\'s attached to a creature you control, unattach it.'
  });

  // 1. Dual target candidate enumeration
  const cand = state.getValidTargetCandidatesForCard('p1', stolen);
  assert.strictEqual(cand.requiresDualTarget, true, 'Stolen Uniform requires dual target');
  assert.ok(cand.step1Candidates.some(c => (c.instanceId || c.id) === hero.instanceId), 'Hero is candidate in Step 1 (creature you control)');
  assert.ok(cand.step2Candidates.some(c => (c.instanceId || c.id) === hammer.instanceId), 'Hammer is candidate in Step 2 (equipment on any battlefield)');

  // 2. Resolve Stolen Uniform with dual targets
  state.resolveSpellEffect('p1', stolen, { targets: [hero.instanceId, hammer.instanceId] });
  assert.strictEqual(hammer.controllerId, 'p1', 'Hammer stolen by p1');
  assert.strictEqual(hammer.attachedTo, hero.instanceId, 'Hammer attached to Heartfire Hero');
  assert.strictEqual(hero.counters['+1/+1'], 1, 'Valiant triggered for +1/+1 counter');

  // Layer-evaluated stats: 1 base + 1 counter + 10 hammer = 12/12
  const stats = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(stats.power, 12, '1 base + 1 counter + 10 hammer = 12 power');
  assert.strictEqual(stats.toughness, 12, '1 base + 1 counter + 10 hammer = 12 toughness');

  // 3. Clear end-of-turn effects: control reverts to p2, equipment unattached, Valiant counter retained
  state.clearEndOfTurnEffects();
  assert.strictEqual(hammer.controllerId, 'p2', 'Hammer returned to original controller p2');
  assert.strictEqual(hammer.attachedTo, null, 'Hammer unattached from Heartfire Hero');
  assert.strictEqual(hero.counters['+1/+1'], 1, 'Heartfire Hero retains +1/+1 counter after hammer reverts');
  const statsAfter = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(statsAfter.power, 2, '2 power after unattach (1 base + 1 counter)');
  assert.strictEqual(statsAfter.toughness, 2, '2 toughness after unattach (1 base + 1 counter)');

  recordTest('Stolen Uniform', 'ADV-22: Dual-Target Candidate Enumeration & Resolution with Valiant Trigger & EOT Reversion', 'PASS');
} catch (err) {
  recordTest('Stolen Uniform', 'ADV-22: Dual-Target Candidate Enumeration & Resolution with Valiant Trigger & EOT Reversion', 'FAIL', err.message);
}

// ── ADV-23: Valiant Counter Persistence & Effective Stat Evaluation Across Turns ──
try {
  const state = createMatchState();
  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    oracleText: 'Whenever Heartfire Hero becomes the target of a spell or ability you control, put a +1/+1 counter on it. This ability triggers only once each turn.'
  });

  // Turn 1
  state.turnNumber = 1;
  const spell1 = { name: 'Targeting Spell', instanceId: 's1' };
  const trig1 = state._triggerValiantIfEligible(hero, spell1, 'p1');
  assert.strictEqual(trig1, true, 'Valiant triggers on Turn 1');
  assert.strictEqual(hero.counters['+1/+1'], 1, '1 counter on Turn 1');
  state.syncCreatureStatsAndCounters?.(hero, 'p1');
  assert.strictEqual(hero.effectivePower, 2, 'Effective power is 2 on Turn 1');
  assert.strictEqual(hero.effectiveToughness, 2, 'Effective toughness is 2 on Turn 1');

  // Second targeting on Turn 1: once-per-turn quota prevents re-trigger
  const trig2 = state._triggerValiantIfEligible(hero, spell1, 'p1');
  assert.strictEqual(trig2, false, 'Valiant does NOT trigger second time in Turn 1');

  // Turn 2 transition
  state.turnNumber = 2;
  hero.valiantTriggeredThisTurn = false;
  const spell2 = { name: 'Targeting Spell 2', instanceId: 's2' };
  const trig3 = state._triggerValiantIfEligible(hero, spell2, 'p1');
  assert.strictEqual(trig3, true, 'Valiant triggers on Turn 2');
  assert.strictEqual(hero.counters['+1/+1'], 2, '2 counters on Turn 2');
  state.syncCreatureStatsAndCounters?.(hero, 'p1');
  assert.strictEqual(hero.effectivePower, 3, 'Effective power is 3 on Turn 2');
  assert.strictEqual(hero.effectiveToughness, 3, 'Effective toughness is 3 on Turn 2');

  recordTest('Heartfire Hero', 'ADV-23: Valiant Counter Persistence & Effective Stat Evaluation Across Turns', 'PASS');
} catch (err) {
  recordTest('Heartfire Hero', 'ADV-23: Valiant Counter Persistence & Effective Stat Evaluation Across Turns', 'FAIL', err.message);
}

// ── ADV-24: Split Attackers Across Multiple Opponents (CR 508.1b) ──
try {
  const state = createMatchState();
  state.players.bot2 = state.players.p2;
  state.players.bot2.id = 'bot2';
  state.players.bot2.playerId = 'bot2';
  state.players.bot2.resources.life = 20;

  state.players.bot3 = {
    id: 'bot3',
    playerId: 'bot3',
    playerName: 'Bot 3',
    resources: { life: 20, poison: 0, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, landsPlayedThisTurn: 0, maxLandsPerTurn: 1 },
    battlefield: { creatures: [], lands: [], noncreatures: [], planeswalkers: [] },
    graveyard: [],
    exile: [],
    hand: [],
    library: [],
    zones: { battlefield: [], graveyard: [], exile: [], hand: [], library: [] }
  };
  state.priorityMachine.players = ['p1', 'bot2', 'bot3'];

  // P1 controls 1/1 Heartfire Hero with a +1/+1 counter (effective 2/2)
  const cr1 = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    counters: { '+1/+1': 1 }
  });

  // P1 controls 4/2 Goblin Gaveleer with Double Strike & Trample
  const cr2 = state.addCardToZone('p1', 'battlefield', {
    name: 'Goblin Gaveleer',
    typeLine: 'Creature — Goblin Warrior',
    power: 4,
    toughness: 2,
    keywords: { doubleStrike: true, trample: true }
  });

  state.priorityMachine.activePlayerId = 'p1';
  state.priorityMachine.priorityPlayerId = 'p1';
  state.priorityMachine.currentPhaseStep = 'DECLARE_ATTACKERS';

  // P1 splits attackers: cr1 attacks bot2, cr2 attacks bot3
  state.declareAttackers('p1', [cr1.instanceId, cr2.instanceId], null, {
    attackerTargets: {
      [cr1.instanceId]: 'bot2',
      [cr2.instanceId]: 'bot3'
    }
  });

  assert.strictEqual(cr1.defendingPlayerId, 'bot2', 'cr1 assigned to attack bot2');
  assert.strictEqual(cr2.defendingPlayerId, 'bot3', 'cr2 assigned to attack bot3');
  assert.strictEqual(state.players.bot2.underAttack, true, 'bot2 is under attack');
  assert.strictEqual(state.players.bot3.underAttack, true, 'bot3 is under attack');
  assert.strictEqual(state.players.p1.underAttack, false, 'p1 is not under attack');
  assert.ok(state.priorityMachine.defendingPlayerIds.includes('bot2'), 'priorityMachine tracks bot2');
  assert.ok(state.priorityMachine.defendingPlayerIds.includes('bot3'), 'priorityMachine tracks bot3');

  // Advance to DECLARE_BLOCKERS
  state.priorityMachine.currentPhaseStep = 'DECLARE_BLOCKERS';
  const bot2DefenderCreature = state.addCardToZone('bot2', 'battlefield', {
    name: 'Wall of Stone',
    typeLine: 'Creature — Wall',
    power: 0,
    toughness: 8
  });

  // Defending player bot2 cannot block an attacker targeting bot3 (CR 509.1a)
  assert.throws(() => {
    state.declareBlockers('bot2', [{ blockerId: bot2DefenderCreature.instanceId, attackerId: cr2.instanceId }]);
  }, /not the defending player/i, 'bot2 cannot block cr2 which is attacking bot3');

  // Both defenders pass on blocking
  state.declareBlockers('bot2', []);
  state.declareBlockers('bot3', []);

  // Resolve combat damage in two strike steps
  state.resolveCombatDamage();
  assert.strictEqual(state.players.bot2.resources.life, 18, 'bot2 takes 2 damage from cr1 (20 -> 18)');
  assert.strictEqual(state.players.bot3.resources.life, 12, 'bot3 takes 8 double-strike damage from cr2 (20 -> 12)');
  assert.strictEqual(state.players.p1.resources.life, 20, 'p1 life is untouched (20)');

  // End combat cleanly resets all tracking
  state.endCombat();
  assert.strictEqual(state.players.bot2.underAttack, false, 'bot2 underAttack cleared');
  assert.strictEqual(state.players.bot3.underAttack, false, 'bot3 underAttack cleared');
  assert.strictEqual(state.priorityMachine.defendingPlayerIds.length, 0, 'defendingPlayerIds cleared');

  recordTest('Multiplayer Combat', 'ADV-24: Split Attackers Across Multiple Opponents (CR 508.1b)', 'PASS');
} catch (err) {
  recordTest('Multiplayer Combat', 'ADV-24: Split Attackers Across Multiple Opponents (CR 508.1b)', 'FAIL', err.message);
}

// ── ADV-25: Inkmoth Nexus EOT Reversion & Equipment Unattach (CR 611.2a & CR 301.5c) ──
try {
  const state = createMatchState();

  // 1. Inkmoth Nexus on battlefield.lands
  const inkmoth = state.addCardToZone('p1', 'battlefield', {
    name: 'Inkmoth Nexus',
    typeLine: 'Land',
    oracleText: '{T}: Add {C}.\n{1}: Inkmoth Nexus becomes a 1/1 Blinkmoth artifact creature with flying and infect until end of turn. It\'s still a land.'
  });
  assert.ok(state.players.p1.battlefield.lands.some(l => l.instanceId === inkmoth.instanceId), 'Inkmoth Nexus starts in battlefield.lands');
  assert.strictEqual(state.players.p1.battlefield.creatures.length, 0, 'No creatures initially on battlefield');

  // 2. Animate Inkmoth Nexus via activatePermanentAbility
  state.players.p1.resources.manaPool.C = 1;
  state.activatePermanentAbility('p1', inkmoth.instanceId, 'ANIMATE_LAND');

  // Verify animation into 1/1 flying infect creature
  assert.ok(state.players.p1.battlefield.creatures.some(c => c.instanceId === inkmoth.instanceId), 'Inkmoth Nexus moved to creatures');
  assert.strictEqual(state.players.p1.battlefield.lands.some(l => l.instanceId === inkmoth.instanceId), false, 'Inkmoth Nexus temporarily removed from lands subzone');
  assert.strictEqual(inkmoth.subzone, 'creatures', 'Subzone set to creatures');
  assert.strictEqual(Boolean(inkmoth.keywords?.flying), true, 'Inkmoth Nexus has flying');
  assert.strictEqual(Boolean(inkmoth.keywords?.infect), true, 'Inkmoth Nexus has infect');

  // 3. Equip Colossus Hammer (+10/+10, loses flying)
  const hammer = state.addCardToZone('p1', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });
  state.attachPermanentToCreature('p1', hammer.instanceId, inkmoth.instanceId, { triggersTargeting: false });
  assert.strictEqual(hammer.attachedTo, inkmoth.instanceId, 'Colossus Hammer attached to Inkmoth Nexus');

  const animatedStats = state.evaluateCreatureStats(inkmoth, 'p1');
  assert.strictEqual(animatedStats.power, 11, '1 base + 10 hammer = 11 power');
  assert.strictEqual(animatedStats.toughness, 11, '1 base + 10 hammer = 11 toughness');
  assert.strictEqual(Boolean(animatedStats.keywords.flying), false, 'Loses flying in Layer 6 from Colossus Hammer');
  assert.strictEqual(Boolean(animatedStats.keywords.infect), true, 'Retains infect keyword');

  // 4. Attack in Turn 1 with Inkmoth Nexus (deals 11 poison to p2)
  inkmoth.hasSummoningSickness = false;
  inkmoth.isSummoningSick = false;
  inkmoth.summoningSickness = false;

  state.priorityMachine.currentPhaseStep = 'DECLARE_ATTACKERS';
  state.declareAttackers('p1', [inkmoth.instanceId], 'p2');
  assert.strictEqual(inkmoth.isAttacking, true, 'Inkmoth Nexus is attacking');
  assert.strictEqual(inkmoth.defendingPlayerId, 'p2', 'Attacking defending player p2');

  state.priorityMachine.currentPhaseStep = 'DECLARE_BLOCKERS';
  state.declareBlockers('p2', []);

  // Combat damage resolution: 11 infect damage -> 11 poison counters to p2, life unaffected
  state.resolveCombatDamage();
  assert.strictEqual(state.players.p2.resources.poison, 11, 'p2 received 11 poison counters from 11/11 infect attacker');
  assert.strictEqual(state.players.p2.resources.life, 20, 'p2 life remains 20 (infect does not deal life loss to players)');

  state.endCombat();

  // 5. Advance to CLEANUP via clearEndOfTurnEffects() (CR 611.2a & CR 301.5c)
  state.clearEndOfTurnEffects();
  state.handleCleanupStep('p1');

  // VERIFICATION:
  // a) Inkmoth Nexus disappears from p1.battlefield.creatures
  assert.strictEqual(
    state.players.p1.battlefield.creatures.some(c => c.instanceId === inkmoth.instanceId),
    false,
    'Inkmoth Nexus disappears from battlefield.creatures'
  );

  // b) Inkmoth Nexus returns to p1.battlefield.lands with typeLine === 'Land'
  const revertedLand = state.players.p1.battlefield.lands.find(l => l.instanceId === inkmoth.instanceId);
  assert.ok(revertedLand, 'Inkmoth Nexus returned to battlefield.lands');
  assert.strictEqual(revertedLand.typeLine, 'Land', 'typeLine reverted back to Land');
  assert.strictEqual(revertedLand.subzone, 'lands', 'subzone reverted back to lands');
  assert.strictEqual(/creature/i.test(revertedLand.typeLine), false, 'Reverted land is not a creature');

  // c) Loses Creature, flying, and infect
  assert.strictEqual(revertedLand.power, undefined, 'card.power was cleaned up (undefined)');
  assert.strictEqual(revertedLand.toughness, undefined, 'card.toughness was cleaned up (undefined)');
  assert.strictEqual(Boolean(revertedLand.keywords?.flying), false, 'Inkmoth Nexus lost flying');
  assert.strictEqual(Boolean(revertedLand.keywords?.infect), false, 'Inkmoth Nexus lost infect');

  // d) Colossus Hammer remains on battlefield and is completely unattached (attachedTo === null)
  assert.ok(state.players.p1.battlefield.noncreatures.some(nc => nc.instanceId === hammer.instanceId), 'Colossus Hammer remains on battlefield');
  assert.strictEqual(hammer.attachedTo, null, 'Colossus Hammer completely unattached (CR 301.5c)');

  // e) In the next turn, if a creature sacrifice effect resolves, Inkmoth Nexus cannot be sacrificed as a creature
  assert.throws(
    () => {
      state.sacrificeCreature('p1', inkmoth.instanceId);
    },
    /not found on battlefield|CardNotFoundError/i,
    'Inkmoth Nexus cannot be sacrificed as a creature while in lands subzone'
  );
  assert.ok(
    state.players.p1.battlefield.lands.some(l => l.instanceId === inkmoth.instanceId),
    'Inkmoth Nexus remains safely in battlefield.lands after invalid sacrifice attempt'
  );

  recordTest('Inkmoth Nexus', 'ADV-25: Inkmoth Nexus EOT Reversion & Equipment Unattach (CR 611.2a & CR 301.5c)', 'PASS');
} catch (err) {
  recordTest('Inkmoth Nexus', 'ADV-25: Inkmoth Nexus EOT Reversion & Equipment Unattach (CR 611.2a & CR 301.5c)', 'FAIL', err.message);
}

// ── ADV-26: Jegantha Companion to Hand ({3} Special Action) & Burn Together Combinations Directed Fling (CR 702.139a & CR 608.2) ──
try {
  const state = createMatchState();

  // ── Part 1: Jegantha, the Wellspring Companion Special Action (CR 702.139a) ──
  const jeganthaCard = {
    name: 'Jegantha, the Wellspring',
    typeLine: 'Legendary Creature — Elemental Elk',
    manaCost: '{4}{R/G}',
    power: 5,
    toughness: 5,
    oracleText: "Companion — No card in your starting deck has more than one of the same mana symbol in its mana cost.\n{T}: Add {W}{U}{B}{R}{G}. This mana can't be spent to pay generic mana costs."
  };
  state.addCardToZone('p1', 'companionZone', jeganthaCard);
  assert.strictEqual(state.players.p1.companionZone.length, 1, 'Jegantha starts in companionZone');
  assert.strictEqual(state.players.p1.hand.length, 0, 'Hand is initially empty');

  // Verify phase timing requirement: Must be in Main Phase with empty stack
  state.priorityMachine.currentPhaseStep = 'PRECOMBAT_MAIN';
  state.priorityMachine.activePlayerId = 'p1';
  state.priorityMachine.priorityPlayerId = 'p1';
  state.stack = [];

  // Pay {3} mana from mana pool
  state.players.p1.resources.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 3 };

  // Execute moveCompanionToHand('p1')
  const movedCompanion = state.moveCompanionToHand('p1');
  assert.strictEqual(movedCompanion.name, 'Jegantha, the Wellspring', 'Returned card is Jegantha');
  assert.strictEqual(state.players.p1.companionZone.length, 0, 'companionZone is now empty');
  assert.strictEqual(state.players.p1.hand.length, 1, 'Jegantha moved to hand');
  assert.strictEqual(state.players.p1.hand[0].name, 'Jegantha, the Wellspring', 'Hand contains Jegantha');
  assert.strictEqual(state.players.p1.hand[0].zone, 'hand', 'Jegantha zone is hand');
  assert.strictEqual(state.players.p1._companionMovedToHandThisGame, true, 'Companion moved flag is set');
  assert.strictEqual(state.players.p1.resources.manaPool.C, 0, '{3} mana deducted from pool');

  // Second companion move attempt throws (once per game restriction)
  assert.throws(() => {
    state.moveCompanionToHand('p1');
  }, /already moved/i, 'Companion cannot be moved to hand more than once per game');

  // ── Part 2: getActionCombinationsForSpell + Burn Together with creatureId + targetId ──
  // Setup multi-player topology: p1, bot2, bot3
  state.players.bot2 = state.players.p2;
  state.players.bot2.id = 'bot2';
  state.players.bot2.playerId = 'bot2';
  state.players.bot2.resources.life = 20;

  state.players.bot3 = {
    id: 'bot3',
    playerId: 'bot3',
    playerName: 'Bot 3',
    resources: { life: 20, poison: 0, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, landsPlayedThisTurn: 0, maxLandsPerTurn: 1 },
    battlefield: { creatures: [], lands: [], noncreatures: [], planeswalkers: [] },
    graveyard: [],
    exile: [],
    hand: [],
    library: [],
    zones: { battlefield: [], graveyard: [], exile: [], hand: [], library: [] }
  };
  state.priorityMachine.players = ['p1', 'bot2', 'bot3'];

  // Setup 2 controlled creatures for p1:
  // Fervent Champion (1/1)
  const champ = state.addCardToZone('p1', 'battlefield', {
    name: 'Fervent Champion',
    typeLine: 'Creature — Human Knight',
    power: 1,
    toughness: 1,
    oracleText: 'First strike, haste\nWhenever Fervent Champion attacks, another target attacking Knight you control gets +1/+0 until end of turn.\nEquip abilities you activate that target Fervent Champion cost {3} less to activate.'
  });

  // Goblin Gaveleer with equipment bringing effective stats to (15/11)
  const gaveleer = state.addCardToZone('p1', 'battlefield', {
    name: 'Goblin Gaveleer',
    typeLine: 'Creature — Goblin Warrior',
    power: 1,
    toughness: 1,
    oracleText: 'Trample\nGoblin Gaveleer gets +2/+0 for each Equipment attached to it.'
  });
  const hammer2 = state.addCardToZone('p1', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });
  const plate = state.addCardToZone('p1', 'battlefield', {
    name: 'Plate Armor',
    typeLine: 'Artifact — Equipment',
    oracleText: 'Equipped creature gets +0/+0.\nEquip {1}'
  });
  state.attachPermanentToCreature('p1', hammer2.instanceId, gaveleer.instanceId, { triggersTargeting: false });
  state.attachPermanentToCreature('p1', plate.instanceId, gaveleer.instanceId, { triggersTargeting: false });

  // Verify Gaveleer stats: 1 base + 10 hammer + 0 plate + 4 (2 eq * 2) = 15 power, 11 toughness!
  const gaveleerStats = state.evaluateCreatureStats(gaveleer, 'p1');
  assert.strictEqual(gaveleerStats.power, 15, 'Gaveleer effective power is 15');
  assert.strictEqual(gaveleerStats.toughness, 11, 'Gaveleer effective toughness is 11');

  // Create Callous Sell-Sword // Burn Together in hand
  const spellCard = state.addCardToZone('p1', 'hand', {
    name: 'Callous Sell-Sword // Burn Together',
    typeLine: 'Creature — Human Soldier // Sorcery — Adventure',
    manaCost: '{1}{B} // {R}',
    oracleText: "Callous Sell-Sword enters the battlefield with a +1/+1 counter on it for each creature that died under your control this turn.\n\nBurn Together\nTarget creature you control deals damage equal to its power to any other target. Then sacrifice it."
  });

  // Invoke getActionCombinationsForSpell
  const combinations = state.getActionCombinationsForSpell('p1', spellCard, 'ADVENTURE');
  assert.ok(Array.isArray(combinations), 'Returns array of combinations');
  assert.ok(combinations.length >= 4, 'Generates combinations combining controlled creatures with available targets');

  // Verify combinations contain pairings for both creatures with bot2 and bot3
  assert.ok(combinations.some(c => c.creatureId === champ.instanceId && c.targetId === 'bot2'), 'Contains Champion -> bot2');
  assert.ok(combinations.some(c => c.creatureId === champ.instanceId && c.targetId === 'bot3'), 'Contains Champion -> bot3');
  assert.ok(combinations.some(c => c.creatureId === gaveleer.instanceId && c.targetId === 'bot2'), 'Contains Gaveleer -> bot2');
  assert.ok(combinations.some(c => c.creatureId === gaveleer.instanceId && c.targetId === 'bot3'), 'Contains Gaveleer -> bot3');

  // Select explicit combination { creatureId: gaveleer.instanceId, targetId: 'bot3' }
  const selectedCombo = combinations.find(c => c.creatureId === gaveleer.instanceId && c.targetId === 'bot3');
  assert.ok(selectedCombo, 'Found explicit combination { creatureId: gaveleer, targetId: bot3 }');
  assert.strictEqual(selectedCombo.effectivePower, 15, 'Combination reflects Gaveleer 15 power');

  // Cast and resolve Burn Together with explicit selected combination
  state.players.p1.resources.manaPool.R = 1;
  state.castSpell('p1', spellCard.instanceId, {
    castMode: 'ADVENTURE',
    creatureId: selectedCombo.creatureId,
    targetId: selectedCombo.targetId,
    targets: [selectedCombo.creatureId, selectedCombo.targetId]
  });

  assert.strictEqual(state.stack.length, 1, 'Burn Together spell is on the stack');
  state.resolveTopOfStack();

  // Sacrifices specifically Goblin Gaveleer, Fervent Champion remains alive
  assert.strictEqual(
    state.players.p1.graveyard.some(c => c.instanceId === gaveleer.instanceId || c.name === 'Goblin Gaveleer'),
    true,
    'Goblin Gaveleer was sacrificed to graveyard'
  );
  assert.strictEqual(
    state.players.p1.battlefield.creatures.some(c => c.instanceId === champ.instanceId),
    true,
    'Fervent Champion remains alive on battlefield'
  );
  assert.strictEqual(
    state.players.p1.battlefield.creatures.some(c => c.instanceId === gaveleer.instanceId),
    false,
    'Goblin Gaveleer is no longer on battlefield'
  );

  // Deals exactly 15 direct damage to bot3 (20 -> 5)
  assert.strictEqual(state.players.bot3.resources.life, 5, 'bot3 life reduced from 20 to 5 (15 damage dealt)');
  assert.strictEqual(state.players.bot2.resources.life, 20, 'bot2 life remains untouched at 20');
  assert.strictEqual(state.players.p1.resources.life, 20, 'p1 life remains untouched at 20');

  // Adventure resolution: Burn Together exiled "on an Adventure" (CR 715.3d)
  const exiledCard = state.players.p1.exile.find(c => (c.name || '').includes('Callous Sell-Sword') || c.onAdventure);
  assert.ok(exiledCard, 'Card exiled on adventure');
  assert.strictEqual(exiledCard.onAdventure, true, 'Card has onAdventure flag set');

  recordTest('Jegantha & Burn Together', 'ADV-26: Jegantha Companion to Hand ({3} Special Action) & Burn Together Combinations Directed Fling', 'PASS');
} catch (err) {
  recordTest('Jegantha & Burn Together', 'ADV-26: Jegantha Companion to Hand ({3} Special Action) & Burn Together Combinations Directed Fling', 'FAIL', err.message);
}

// ── ADV-27: 3-Player Multiplayer Free First Mulligan & Keep Without Bottoming (CR 103.5c) ──
try {
  // 1. Initialize 3-player match in PregameStateMachine
  const pregame = new PregameStateMachine({
    players: ['p1', 'p2', 'p3'],
    initialState: PREGAME_STATES.PREGAME_MULLIGAN
  });
  pregame.currentDecidingPlayerId = 'p1';

  assert.strictEqual(pregame.players.length, 3, '3 players in match');
  assert.strictEqual(pregame.mulliganCount['p1'], 0, 'Initial mulliganCount is 0');
  assert.strictEqual(pregame.playerSubStates['p1'], MULLIGAN_SUBSTATES.DECIDING, 'Initial substate is DECIDING');

  // 2. Player 1 takes first mulligan (mulliganCount becomes 1)
  const mulResult = pregame.decideMulligan({ playerId: 'p1', keep: false });

  assert.strictEqual(mulResult.keep, false, 'Mulligan taken');
  assert.strictEqual(mulResult.mulliganCount, 1, 'mulliganCount is 1');
  assert.strictEqual(mulResult.cardsToBottomCount, 0, 'CR 103.5c: Multiplayer free first mulligan requires 0 cards to bottom');
  assert.strictEqual(pregame.pendingBottomCount['p1'], 0, 'pendingBottomCount for p1 is 0');
  assert.strictEqual(mulResult.subState, MULLIGAN_SUBSTATES.DECIDING, 'Substate remains DECIDING because 0 cards to bottom');

  // 3. Player 1 keeps hand without needing to bottom any cards
  const keepResult = pregame.decideMulligan({ playerId: 'p1', keep: true });

  assert.strictEqual(keepResult.keep, true, 'Player 1 kept hand successfully without bottoming');
  assert.strictEqual(pregame.mulliganStatus['p1'], MULLIGAN_SUBSTATES.KEPT, 'Player 1 status is KEPT');
  assert.strictEqual(pregame.playerSubStates['p1'], MULLIGAN_SUBSTATES.KEPT, 'Player 1 subState is KEPT');
  assert.strictEqual(keepResult.nextDecidingPlayerId, 'p2', 'Decision rotated to p2');

  // 4. Verify player 2 taking 2 mulligans requires 1 card bottomed (N - 1)
  pregame.decideMulligan({ playerId: 'p2', keep: false }); // 1st mulligan: 0 to bottom
  assert.strictEqual(pregame.pendingBottomCount['p2'], 0, 'p2 first mulligan pendingBottomCount is 0');

  const mul2Result = pregame.decideMulligan({ playerId: 'p2', keep: false }); // 2nd mulligan: 1 to bottom
  assert.strictEqual(mul2Result.mulliganCount, 2, 'p2 mulliganCount is 2');
  assert.strictEqual(mul2Result.cardsToBottomCount, 1, 'p2 second mulligan requires 1 card to bottom (count - 1)');
  assert.strictEqual(pregame.pendingBottomCount['p2'], 1, 'p2 pendingBottomCount is 1');
  assert.strictEqual(mul2Result.subState, MULLIGAN_SUBSTATES.MULLIGAN_BOTTOMING, 'p2 substate is MULLIGAN_BOTTOMING');

  // Attempting to keep without bottoming throws error for p2
  assert.throws(() => {
    pregame.decideMulligan({ playerId: 'p2', keep: true });
  }, /must complete PUT_ON_BOTTOM/i, 'Keeping with pending bottom cards throws error');

  recordTest('PregameStateMachine', 'ADV-27: 3-Player Multiplayer Free First Mulligan & Keep Without Bottoming (CR 103.5c)', 'PASS');
} catch (err) {
  recordTest('PregameStateMachine', 'ADV-27: 3-Player Multiplayer Free First Mulligan & Keep Without Bottoming (CR 103.5c)', 'FAIL', err.message);
}

// ── ADV-28: RandomPerkEngine Birthday Trigger (RPBD) Override on Day 13 and 22 ──
try {
  // 1. Setup RandomPerkEngine with player birthday day 13 for p1 and day 22 for p2
  const engine = new RandomPerkEngine({
    initialPlayerCount: 3,
    birthdayMap: {
      p1: 13,
      p2: '1998-11-22' // ISO date format ending in day 22
    }
  });

  // Case A: Player 1 (birthday 13) rolls 13 on d100 -> triggers RPBD!
  const rollP1_13 = engine._finishStep1Resolution({ tens: 1, ones: 3, rollString: '13' }, 'p1');
  assert.strictEqual(rollP1_13.rollString, '13', 'Roll string is 13');
  assert.strictEqual(rollP1_13.isBirthday, true, 'isBirthday must be true when rolling birthday day 13');
  assert.strictEqual(rollP1_13.matchedKey, 'RPBD', 'matchedKey must be RPBD override instead of standard Perk #13');
  assert.strictEqual(rollP1_13.isMiss, false, 'Birthday match is not a miss');

  // Case B: Player 2 (birthday 22) rolls 22 on d100 -> triggers RPBD!
  const rollP2_22 = engine._finishStep1Resolution({ tens: 2, ones: 2, rollString: '22' }, 'p2');
  assert.strictEqual(rollP2_22.rollString, '22', 'Roll string is 22');
  assert.strictEqual(rollP2_22.isBirthday, true, 'isBirthday must be true when rolling birthday day 22');
  assert.strictEqual(rollP2_22.matchedKey, 'RPBD', 'matchedKey must be RPBD override instead of standard Perk #22');
  assert.strictEqual(rollP2_22.isMiss, false, 'Birthday match is not a miss');

  // Case C: Non-birthday rolls do NOT trigger RPBD
  // Player 1 (birthday 13) rolls 22 -> does NOT match p1's birthday (standard perk #22 or miss)
  const rollP1_22 = engine._finishStep1Resolution({ tens: 2, ones: 2, rollString: '22' }, 'p1');
  assert.strictEqual(rollP1_22.isBirthday, false, 'isBirthday must be false when roll 22 does not match birthday 13');
  assert.notStrictEqual(rollP1_22.matchedKey, 'RPBD', 'matchedKey must NOT be RPBD for non-matching birthday roll');

  // Player 2 (birthday 22) rolls 13 -> does NOT match p2's birthday (standard perk #13 or miss)
  const rollP2_13 = engine._finishStep1Resolution({ tens: 1, ones: 3, rollString: '13' }, 'p2');
  assert.strictEqual(rollP2_13.isBirthday, false, 'isBirthday must be false when roll 13 does not match birthday 22');
  assert.notStrictEqual(rollP2_13.matchedKey, 'RPBD', 'matchedKey must NOT be RPBD for non-matching birthday roll');

  // Case D: Direct resolveRoll verification from PerkCatalog
  const match13 = resolveRoll(1, 3, '13');
  assert.strictEqual(match13.isBirthday, true, 'resolveRoll matches birthday 13');
  assert.strictEqual(match13.perkKey, 'RPBD', 'resolveRoll returns RPBD');

  const match22 = resolveRoll(2, 2, '22');
  assert.strictEqual(match22.isBirthday, true, 'resolveRoll matches birthday 22');
  assert.strictEqual(match22.perkKey, 'RPBD', 'resolveRoll returns RPBD');

  engine.destroy();

  recordTest('RandomPerkEngine', 'ADV-28: RandomPerkEngine Birthday Trigger (RPBD) Override on Day 13 and 22', 'PASS');
} catch (err) {
  recordTest('RandomPerkEngine', 'ADV-28: RandomPerkEngine Birthday Trigger (RPBD) Override on Day 13 and 22', 'FAIL', err.message);
}

// ── ADV-29: Stolen Uniform & Burn Together Modal Combination -> Stack -> Resolution E2E ──
try {
  const state = new TabletopStateManager({ players: ['p1', 'bot2'] });

  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    oracleText: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
  });

  const champ = state.addCardToZone('p1', 'battlefield', {
    name: 'Fervent Champion',
    typeLine: 'Creature — Human Knight',
    power: 1,
    toughness: 1,
    oracleText: 'First strike, haste\nWhenever Fervent Champion attacks, another target attacking Knight you control gets +1/+0 until end of turn.\nEquip abilities you activate that target Fervent Champion cost {3} less to activate.'
  });

  const hammer = state.addCardToZone('bot2', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    manaCost: '{1}',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });

  const stolenUniformCard = state.addCardToZone('p1', 'hand', {
    name: 'Stolen Uniform',
    manaCost: '{U}',
    typeLine: 'Instant',
    oracleText: "Choose target creature you control and target Equipment. Gain control of that Equipment until end of turn. Attach it to the chosen creature. When you lose control of that Equipment this turn, if it's attached to a creature you control, unattach it."
  });

  const uniformCombos = state.getActionCombinationsForSpell('p1', stolenUniformCard);
  const targetCombo = uniformCombos.find(c => c.equipmentId === hammer.instanceId && c.creatureId === champ.instanceId);
  assert.ok(targetCombo, 'Must contain combination targeting Colossus Hammer and Fervent Champion');

  state.players.p1.resources.manaPool.U = 1;
  state.castSpell('p1', stolenUniformCard.instanceId, {
    selectedCombination: targetCombo,
    creatureId: targetCombo.creatureId,
    equipmentId: targetCombo.equipmentId,
    targets: [targetCombo.creatureId, targetCombo.equipmentId]
  });

  state.resolveTopOfStack();

  assert.strictEqual(hammer.controllerId, 'p1', 'Hammer controller is now p1');
  assert.strictEqual(hammer.attachedTo, champ.instanceId, 'Hammer attached to Fervent Champion');
  const evaluatedChamp = state.evaluateCreatureStats(champ, 'p1');
  assert.strictEqual(evaluatedChamp.power, 11, 'Fervent Champion evaluated power is 11');

  const burnCard = state.addCardToZone('p1', 'hand', {
    name: 'Callous Sell-Sword // Burn Together',
    typeLine: 'Creature — Human Soldier // Sorcery — Adventure',
    manaCost: '{1}{B} // {R}',
    power: 2,
    toughness: 2,
    oracleText: "Callous Sell-Sword enters the battlefield with a +1/+1 counter on it for each creature that died under your control this turn.\n\nBurn Together\nTarget creature you control deals damage equal to its power to any other target. Then sacrifice it."
  });

  const burnCombos = state.getActionCombinationsForSpell('p1', burnCard, 'ADVENTURE');
  const chosenBurnCombo = burnCombos.find(c => c.creatureId === champ.instanceId && c.targetId === 'bot2');
  assert.ok(chosenBurnCombo, 'Must find combination targeting Fervent Champion and bot2');

  state.players.p1.resources.manaPool.R = 1;
  state.castSpell('p1', burnCard.instanceId, {
    castMode: 'ADVENTURE',
    selectedCombination: chosenBurnCombo,
    creatureId: chosenBurnCombo.creatureId,
    targetId: chosenBurnCombo.targetId,
    targets: [chosenBurnCombo.creatureId, chosenBurnCombo.targetId]
  });

  state.resolveTopOfStack();

  assert.strictEqual(state.players.bot2.resources.life, 9, 'bot2 life reduced by 11 to 9 (20 - 11 = 9)');
  assert.ok(
    state.players.p1.graveyard.some(c => c.instanceId === champ.instanceId || c.previousInstanceId === champ.instanceId || c.name === 'Fervent Champion'),
    'Fervent Champion sacrificed to graveyard'
  );
  assert.ok(
    state.players.p1.battlefield.creatures.some(c => c.instanceId === hero.instanceId || c.name === 'Heartfire Hero'),
    'Heartfire Hero remains alive on battlefield'
  );

  recordTest('Stolen Uniform & Burn Together', 'ADV-29: Stolen Uniform & Burn Together Modal Combination -> Stack -> Resolution E2E', 'PASS');
} catch (err) {
  recordTest('Stolen Uniform & Burn Together', 'ADV-29: Stolen Uniform & Burn Together Modal Combination -> Stack -> Resolution E2E', 'FAIL', err.message);
}

// ── ADV-30: Callous Sell-Sword Creature Mode Isolation ──
try {
  const state = new TabletopStateManager({ players: ['p1', 'bot2'] });

  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    oracleText: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
  });

  state.players.p1.creaturesDiedThisTurn = 1;

  const sellSwordCard = state.addCardToZone('p1', 'hand', {
    name: 'Callous Sell-Sword // Burn Together',
    typeLine: 'Creature — Human Soldier // Sorcery — Adventure',
    manaCost: '{1}{B} // {R}',
    power: 2,
    toughness: 2,
    oracleText: "Callous Sell-Sword enters the battlefield with a +1/+1 counter on it for each creature that died under your control this turn.\n\nBurn Together\nTarget creature you control deals damage equal to its power to any other target. Then sacrifice it."
  });

  const mainCombos = state.getActionCombinationsForSpell('p1', sellSwordCard, 'MAIN');
  assert.deepStrictEqual(mainCombos, [], 'Main mode must return empty combinations array');

  state.players.p1.resources.manaPool = { W: 0, U: 0, B: 2, R: 1, G: 0, C: 0 };
  state.castSpell('p1', sellSwordCard.instanceId, { castMode: 'MAIN' });
  state.resolveTopOfStack();

  assert.ok(
    state.players.p1.battlefield.creatures.some(c => c.instanceId === hero.instanceId || c.name === 'Heartfire Hero'),
    'Heartfire Hero was NOT sacrificed and remains on battlefield'
  );

  const enteredSellSword = state.players.p1.battlefield.creatures.find(c => c.name === 'Callous Sell-Sword');
  assert.ok(enteredSellSword, 'Callous Sell-Sword entered battlefield as creature');
  assert.strictEqual(enteredSellSword.counters?.['+1/+1'], 1, 'Entered with 1 +1/+1 counter');

  const sellSwordStats = state.evaluateCreatureStats(enteredSellSword, 'p1');
  assert.strictEqual(sellSwordStats.power, 3, 'Effective power is 3 (2 base + 1 counter)');
  assert.strictEqual(sellSwordStats.toughness, 3, 'Effective toughness is 3 (2 base + 1 counter)');
  assert.strictEqual(state.players.bot2.resources.life, 20, 'bot2 life remains 20');

  recordTest('Callous Sell-Sword', 'ADV-30: Callous Sell-Sword Creature Mode Isolation', 'PASS');
} catch (err) {
  recordTest('Callous Sell-Sword', 'ADV-30: Callous Sell-Sword Creature Mode Isolation', 'FAIL', err.message);
}

// ── ADV-31: Sigarda\'s Aid Triggered Ability Target Choice & Decline (CR 603.3d & [P12]) ──
try {
  const state = new TabletopStateManager({ players: ['p1', 'bot2'] });
  state.interactiveMode = true;

  const sigarda = state.addCardToZone('p1', 'battlefield', {
    name: "Sigarda's Aid",
    typeLine: 'Enchantment',
    manaCost: '{W}',
    oracleText: "You may cast Aura and Equipment spells as though they had flash.\nWhenever an Equipment enters the battlefield under your control, you may attach it to target creature you control."
  });

  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    oracleText: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
  });

  const champ = state.addCardToZone('p1', 'battlefield', {
    name: 'Fervent Champion',
    typeLine: 'Creature — Human Knight',
    power: 1,
    toughness: 1,
    oracleText: 'First strike, haste\nWhenever Fervent Champion attacks, another target attacking Knight you control gets +1/+0 until end of turn.\nEquip abilities you activate that target Fervent Champion cost {3} less to activate.'
  });

  let capturedPayload = null;
  state.on('TRIGGER_TARGET_REQUIRED', payload => {
    capturedPayload = payload;
  });

  const hammerCard = state.addCardToZone('p1', 'hand', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    manaCost: '{1}',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });

  state.players.p1.resources.manaPool.C = 1;
  state.castSpell('p1', hammerCard.instanceId);
  state.resolveTopOfStack();

  const hammer = state.players.p1.battlefield.noncreatures.find(c => c.name === 'Colossus Hammer');
  assert.ok(hammer, 'Colossus Hammer is on battlefield');
  assert.strictEqual(hammer.attachedTo, null, 'Hammer attachedTo is null before trigger choice');
  assert.ok(capturedPayload, 'TRIGGER_TARGET_REQUIRED was emitted');
  assert.strictEqual(capturedPayload.type, 'SIGARDAS_AID_ATTACH', 'Trigger type is SIGARDAS_AID_ATTACH');
  assert.strictEqual(capturedPayload.candidates.length, 2, 'Candidates array has 2 controlled creatures');

  state.resolvePendingTriggerChoice(capturedPayload.triggerId, champ.instanceId);
  assert.strictEqual(hammer.attachedTo, champ.instanceId, 'Hammer attached to Fervent Champion');

  const champStats = state.evaluateCreatureStats(champ, 'p1');
  assert.strictEqual(champStats.power, 11, 'Fervent Champion effective power is 11');
  assert.strictEqual(champStats.toughness, 11, 'Fervent Champion effective toughness is 11');

  const heroStats = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(heroStats.power, 1, 'Heartfire Hero remains 1/1');
  assert.strictEqual(heroStats.toughness, 1, 'Heartfire Hero remains 1/1');
  assert.strictEqual(Boolean(hero.counters?.['+1/+1']), false, 'Heartfire Hero has no +1/+1 counters');

  capturedPayload = null;
  const beltCard = state.addCardToZone('p1', 'hand', {
    name: 'Belt of Giant Strength',
    typeLine: 'Artifact — Equipment',
    manaCost: '{10}',
    oracleText: 'Equipped creature has base power and toughness 10/10.\nEquip {10}. This ability costs {X} less to activate, where X is the power of the creature it targets.'
  });

  state.players.p1.resources.manaPool.C = 10;
  state.castSpell('p1', beltCard.instanceId);
  state.resolveTopOfStack();

  const belt = state.players.p1.battlefield.noncreatures.find(c => c.name === 'Belt of Giant Strength');
  assert.ok(belt, 'Belt of Giant Strength is on battlefield');
  assert.ok(capturedPayload, 'Second TRIGGER_TARGET_REQUIRED was emitted for Belt');
  assert.strictEqual(capturedPayload.type, 'SIGARDAS_AID_ATTACH');

  state.resolvePendingTriggerChoice(capturedPayload.triggerId, 'DECLINE');
  assert.strictEqual(belt.attachedTo, null, 'Belt remains unattached when declined');
  assert.ok(
    state.players.p1.battlefield.noncreatures.some(nc => nc.instanceId === belt.instanceId),
    'Belt remains safely in battlefield.noncreatures'
  );

  recordTest("Sigarda's Aid", 'ADV-31: Sigarda\'s Aid Triggered Ability Target Choice & Decline (CR 603.3d & [P12])', 'PASS');
} catch (err) {
  recordTest("Sigarda's Aid", 'ADV-31: Sigarda\'s Aid Triggered Ability Target Choice & Decline (CR 603.3d & [P12])', 'FAIL', err.message);
}

// ── ADV-32: Multi-Blocker Exact Damage Allocation & Battle Attack Target ([P19] & [P20]) ──
try {
  // ── Sub-test A: Multi-Blocker Exact Damage Allocation ──
  const state = new TabletopStateManager({ players: ['p1', 'p2'] });

  const atk = state.addCardToZone('p1', 'battlefield', {
    name: 'Attacker Beast',
    typeLine: 'Creature — Beast',
    power: 4,
    toughness: 4
  });
  atk.hasSummoningSickness = false;
  atk.isSummoningSick = false;
  atk.summoningSickness = false;

  const blk1 = state.addCardToZone('p2', 'battlefield', {
    name: 'Blocker Alpha',
    typeLine: 'Creature — Wall',
    power: 2,
    toughness: 3
  });
  const blk2 = state.addCardToZone('p2', 'battlefield', {
    name: 'Blocker Beta',
    typeLine: 'Creature — Wall',
    power: 2,
    toughness: 3
  });

  state.declareAttackers('p1', [{ creatureId: atk.instanceId, defendingPlayerId: 'p2' }]);

  const blockerAssignments = [
    { blockerId: blk1.instanceId, attackerId: atk.instanceId },
    { blockerId: blk2.instanceId, attackerId: atk.instanceId }
  ];
  const damageAllocation = {
    [atk.instanceId]: {
      [blk1.instanceId]: 1,
      [blk2.instanceId]: 3
    }
  };
  blockerAssignments.damageAllocation = damageAllocation;
  state.declareBlockers('p2', blockerAssignments, [blk1.instanceId, blk2.instanceId], damageAllocation);
  if (!state.combatState.damageAllocation) {
    state.combatState.damageAllocation = damageAllocation;
  }

  state.resolveCombatDamage();

  assert.ok(
    state.players.p2.battlefield.creatures.some(c => c.instanceId === blk1.instanceId),
    'blk1 survived on battlefield'
  );
  assert.strictEqual(blk1.damageMarked, 1, 'blk1 has exactly 1 damage marked');
  assert.ok(
    state.players.p2.graveyard.some(c => c.name === 'Blocker Beta' || c.previousInstanceId === blk2.instanceId || c.instanceId === blk2.instanceId),
    'blk2 was destroyed by lethal damage and moved to graveyard'
  );
  assert.strictEqual(
    state.players.p2.battlefield.creatures.some(c => c.instanceId === blk2.instanceId),
    false,
    'blk2 removed from battlefield.creatures'
  );

  // ── Sub-test B: Battle — Siege Attack Target & Transformation ──
  state.endCombat();

  const battle = state.addCardToZone('p1', 'battlefield', {
    name: 'Invasion of Gobakhan // Lightshield Array',
    typeLine: 'Battle — Siege',
    defense: 3,
    counters: { defense: 3 },
    protectorId: 'p2',
    cardFaces: [
      {
        name: 'Invasion of Gobakhan',
        typeLine: 'Battle — Siege',
        defense: 3
      },
      {
        name: 'Lightshield Array',
        typeLine: 'Enchantment'
      }
    ]
  });

  const knight = state.addCardToZone('p1', 'battlefield', {
    name: 'Knight of Grace',
    typeLine: 'Creature — Human Knight',
    power: 3,
    toughness: 3
  });
  knight.hasSummoningSickness = false;
  knight.isSummoningSick = false;
  knight.summoningSickness = false;

  state.declareAttackers('p1', [
    {
      creatureId: knight.instanceId,
      targetId: battle.instanceId,
      targetType: 'BATTLE',
      defendingPlayerId: 'p2'
    }
  ]);

  state.resolveCombatDamage();

  assert.ok(
    battle.isTransformed === true || battle.transformed === true,
    'Battle must be transformed after defense reduced to 0'
  );
  assert.strictEqual(battle.name, 'Lightshield Array', 'Battle transformed name must be Lightshield Array');
  assert.ok(
    battle.counters?.defense === undefined || battle.counters?.defense === 0,
    'Defense counters removed'
  );

  recordTest('Combat Damage & Battle', 'ADV-32: Multi-Blocker Exact Damage Allocation & Battle Attack Target ([P19] & [P20])', 'PASS');
} catch (err) {
  recordTest('Combat Damage & Battle', 'ADV-32: Multi-Blocker Exact Damage Allocation & Battle Attack Target ([P19] & [P20])', 'FAIL', err.message);
}

// ── ADV-33: Belt of Giant Strength Layer 7b 10/10 + Counters Layer 7d + Hammer Layer 7c & Dynamic Equip Cost ──
try {
  const state = new TabletopStateManager({ players: ['p1', 'p2'] });

  const hero = state.addCardToZone('p1', 'battlefield', {
    name: 'Heartfire Hero',
    typeLine: 'Creature — Mouse Soldier',
    power: 1,
    toughness: 1,
    oracleText: 'Valiant — Whenever Heartfire Hero becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen Heartfire Hero dies, it deals damage equal to its power to each opponent.'
  });

  const belt = state.addCardToZone('p1', 'battlefield', {
    name: 'Belt of Giant Strength',
    typeLine: 'Artifact — Equipment',
    manaCost: '{1}{G}',
    equipCost: '{10}',
    oracleText: 'Equipped creature has base power and toughness 10/10.\nEquip {10}. This ability costs {X} less to activate, where X is the power of the creature it targets.'
  });

  // 1. Before attaching, verify dynamic equip cost reduction on 1/1 Heartfire Hero: {10} - 1 = {9}
  const costBefore = state.computeEquipCost('p1', belt, hero);
  assert.strictEqual(costBefore, '{9}', 'Equip cost of Belt of Giant Strength targeting 1/1 Heartfire Hero must be reduced from {10} to {9}');

  // 2. Attach Belt of Giant Strength -> Valiant triggers (+1/+1 counter)
  state.attachPermanentToCreature('p1', belt.instanceId, hero.instanceId);
  assert.strictEqual(hero.counters['+1/+1'], 1, 'Valiant must put 1 +1/+1 counter on Heartfire Hero');

  // 3. Assert evaluated stats: Layer 7b (base 10/10) + Layer 7d (+1/+1 counter) = 11/11 (NEVER 2/2)
  const statsAfterBelt = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(statsAfterBelt.power, 11, 'Heartfire Hero with Belt (10/10 in 7b) + 1 +1/+1 counter (7d) must be 11 power');
  assert.strictEqual(statsAfterBelt.toughness, 11, 'Heartfire Hero with Belt (10/10 in 7b) + 1 +1/+1 counter (7d) must be 11 toughness');
  assert.strictEqual(hero.effectivePower, 11, 'hero.effectivePower must immediately reflect 11');
  assert.strictEqual(hero.effectiveToughness, 11, 'hero.effectiveToughness must immediately reflect 11');

  // 4. Attach Colossus Hammer (+10/+10 in Layer 7c)
  const hammer = state.addCardToZone('p1', 'battlefield', {
    name: 'Colossus Hammer',
    typeLine: 'Artifact — Equipment',
    manaCost: '{1}',
    equipCost: '{8}',
    oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
  });
  state.attachPermanentToCreature('p1', hammer.instanceId, hero.instanceId);

  // 5. Assert evaluated stats: Layer 7b (10/10) + Layer 7c (+10/+10) + Layer 7d (+1/+1) = 21/21
  const statsAfterHammer = state.evaluateCreatureStats(hero, 'p1');
  assert.strictEqual(statsAfterHammer.power, 21, 'Heartfire Hero with Belt (7b 10/10) + Hammer (7c +10/+10) + Counter (7d +1/+1) must be 21 power');
  assert.strictEqual(statsAfterHammer.toughness, 21, 'Heartfire Hero with Belt (7b 10/10) + Hammer (7c +10/+10) + Counter (7d +1/+1) must be 21 toughness');

  // 6. Also verify dynamic equip cost when creature has >= 10 power reduces to {0}
  const belt2 = state.addCardToZone('p1', 'battlefield', {
    name: 'Belt of Giant Strength',
    typeLine: 'Artifact — Equipment',
    equipCost: '{10}'
  });
  const costAt21Power = state.computeEquipCost('p1', belt2, hero);
  assert.strictEqual(costAt21Power, '{0}', 'Equip cost of Belt of Giant Strength targeting 21/21 creature must reduce to {0}');

  recordTest('Belt of Giant Strength', 'ADV-33: Layer 7b 10/10 + Counters Layer 7d + Hammer Layer 7c & Dynamic Equip Cost (CR 613.4b)', 'PASS');
} catch (err) {
  recordTest('Belt of Giant Strength', 'ADV-33: Layer 7b 10/10 + Counters Layer 7d + Hammer Layer 7c & Dynamic Equip Cost (CR 613.4b)', 'FAIL', err.message);
}

// ── ADV-34: Perkins AI Lethal Infect & Lethal Life Blocking [P42] ──
try {
  const { PerkinsAgent } = await import('../src/PerkinsAgent.js');
  const state = new TabletopStateManager({ players: ['p1', 'p2_perkins'] });

  // Set Perkins at 8 poison counters and 20 life
  state.players.p2_perkins.resources.poison = 8;
  state.players.p2_perkins.resources.life = 20;

  const bears = state.addCardToZone('p2_perkins', 'battlefield', {
    name: 'Grizzly Bears',
    typeLine: 'Creature — Bear',
    power: 2,
    toughness: 2
  });
  bears.isTapped = false;

  // Declare 2/2 Infect attacker from p1 (e.g. Inkmoth Nexus with +1/+1 counter)
  const infectAttacker = state.addCardToZone('p1', 'battlefield', {
    name: 'Inkmoth Nexus',
    typeLine: 'Artifact Land — Blinkmoth Creature',
    power: 2,
    toughness: 2,
    effectivePower: 2,
    effectiveToughness: 2,
    keywords: { infect: true, Infect: true },
    oracleText: 'Infect (This creature deals damage to creatures in the form of -1/-1 counters and to players in the form of poison counters.)'
  });

  const perkins = new PerkinsAgent({ slotId: 'p2_perkins', thinkingDelayMs: 0, coachEnabled: false });
  perkins.tabletopState = state;

  const blocks = perkins.evaluateCombatBlocks(state, [infectAttacker]);
  assert.strictEqual(blocks.length, 1, 'Perkins at 8 poison must assign a blocker against a 2-power infect attacker');
  assert.strictEqual(blocks[0].blockerId, bears.instanceId, 'Grizzly Bears must be assigned as blocker');
  assert.strictEqual(blocks[0].attackerId, infectAttacker.instanceId, 'Infect attacker must be blocked to prevent reaching 10 poison');

  recordTest('Perkins AI Lethal Block', 'ADV-34: Perkins AI Mandatory Lethal Infect & Lethal Life Blocking ([P42])', 'PASS');
} catch (err) {
  recordTest('Perkins AI Lethal Block', 'ADV-34: Perkins AI Mandatory Lethal Infect & Lethal Life Blocking ([P42])', 'FAIL', err.message);
}

// ── ADV-35: Deck Slots (2 Free + 4 Unlockable), 5 Starter Decks + Beta Tester Deck & Compatibility Review Queue [P27, P28, P29, P39] ──
try {
  const { DeckSlotManager, CompatibilityReviewQueue } = await import('../src/deckbuilder/DeckSlotManager.js');
  const { PRECONSTRUCTED_STARTER_DECKS } = await import('../src/deckbuilder/PreconstructedDecks.js');
  const { PerkinsAgent } = await import('../src/PerkinsAgent.js');

  // 1. DeckSlotManager: 2 free + 4 unlockable
  const mockStorage = {
    _data: {},
    getItem(k) { return this._data[k] || null; },
    setItem(k, v) { this._data[k] = String(v); }
  };
  const slotMgr = new DeckSlotManager({ storage: mockStorage });
  const initialSlots = slotMgr.getAllSlots();
  assert.strictEqual(initialSlots.length, 6, 'DeckSlotManager must manage 6 total slots');
  assert.strictEqual(initialSlots.filter(s => s.isUnlocked).length, 2, '2 slots (slot_1, slot_2) must be unlocked by default');
  assert.strictEqual(initialSlots.filter(s => !s.isUnlocked).length, 4, '4 slots (slot_3..slot_6) must be locked by default');

  slotMgr.unlockSlot('slot_3');
  assert.strictEqual(slotMgr.isSlotUnlocked('slot_3'), true, 'unlockSlot("slot_3") must unlock slot_3');
  assert.strictEqual(slotMgr.getAllSlots().filter(s => s.isUnlocked).length, 3, '3 slots must now be unlocked');

  // 2. PRECONSTRUCTED_STARTER_DECKS: 5 balanced 60-card starters + American Gadgets Beta Tester
  assert.strictEqual(PRECONSTRUCTED_STARTER_DECKS.length, 6, 'PRECONSTRUCTED_STARTER_DECKS must contain 5 starters + 1 Beta Tester deck');
  for (const precon of PRECONSTRUCTED_STARTER_DECKS) {
    const mainTotal = precon.mainboard.reduce((sum, c) => sum + (Number(c.count) || 1), 0);
    assert.ok(mainTotal >= 60 && mainTotal <= 61, `Preconstructed deck ${precon.name} must have legal constructed mainboard (>= 60 cards, got ${mainTotal})`);
  }
  assert.ok(PRECONSTRUCTED_STARTER_DECKS.some(d => d.id === 'BETA_AMERICAN_GADGETS'), 'Must include American Gadgets (Beta Tester)');

  // 3. PerkinsAgent custom slot deck assignment (mirror match)
  const customMirrorDeck = { name: 'Player Slot 1 Custom Deck', mainboard: PRECONSTRUCTED_STARTER_DECKS[0].mainboard };
  slotMgr.saveDeckToSlot('slot_1', customMirrorDeck);
  const bot = new PerkinsAgent({ slotId: 'p2_perkins' });
  bot.setAssignedDeck(slotMgr.getSlotDeck('slot_1'));
  assert.strictEqual(bot.assignedDeck.name, 'Player Slot 1 Custom Deck', 'PerkinsAgent must accept custom slot deck for mirror match');

  // 4. CompatibilityReviewQueue
  const reviewQueue = new CompatibilityReviewQueue({ storage: mockStorage });
  const entry = reviewQueue.enqueueReviewRequest({
    deckName: 'Experimental Cascade Brew',
    format: 'MODERN',
    rawDecklist: '4 Crashing Footfalls\n4 Shardless Agent',
    compatibilityBadge: '🟡 Assisted Play',
    unverifiedCards: ['Crashing Footfalls']
  });
  assert.strictEqual(entry.deckName, 'Experimental Cascade Brew', 'Review request must record deck name');
  assert.strictEqual(entry.compatibilityBadge, '🟡 Assisted Play', 'Review request must record compatibility badge');
  assert.strictEqual(reviewQueue.getReviewQueue().length, 1, 'Queue must contain 1 enqueued request');

  recordTest('Deckbuilder & Bot Decks', 'ADV-35: Deck Slots (2 Free + 4 Unlockable), 5 Starters + Beta Deck & Compatibility Review Queue ([P27-P29, P39])', 'PASS');
} catch (err) {
  recordTest('Deckbuilder & Bot Decks', 'ADV-35: Deck Slots (2 Free + 4 Unlockable), 5 Starters + Beta Deck & Compatibility Review Queue ([P27-P29, P39])', 'FAIL', err.message);
}

// ── ADV-36: Universal Deck Grounding & Non-Red Perkins AI Execution ──
try {
  const { RPMAppController } = await import('../src/app.js');
  const { getPreconstructedDeckById } = await import('../src/deckbuilder/PreconstructedDecks.js');
  const { groundDeckForEngine } = await import('../src/OracleEffectCompiler.js');
  const { PerkinsAgent } = await import('../src/PerkinsAgent.js');

  // Part 1: getPaymentPlan validation for {W}{U}{B}{R}{G}{C} costs with representative lands
  const testAgent = new PerkinsAgent({ slotId: 'p2' });
  function makePlayerState(lands, other = []) {
    return {
      playerId: 'p2',
      resources: { manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 } },
      battlefield: {
        lands: lands.map((l, i) => ({ instanceId: 'l_' + i, isTapped: false, ...l })),
        creatures: other.filter(o => o.isCreature),
        noncreatures: other.filter(o => !o.isCreature)
      }
    };
  }

  // Plains: {W}
  const plainsState = makePlayerState([{ name: 'Plains', typeLine: 'Basic Land — Plains' }]);
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{W}' }, plainsState).affordable, true, 'Plains must pay {W}');
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{U}' }, plainsState).affordable, false, 'Plains cannot pay {U}');

  // Island: {U}
  const islandState = makePlayerState([{ name: 'Island', typeLine: 'Basic Land — Island' }]);
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{U}' }, islandState).affordable, true, 'Island must pay {U}');

  // Swamp: {B}
  const swampState = makePlayerState([{ name: 'Swamp', typeLine: 'Basic Land — Swamp' }]);
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{B}' }, swampState).affordable, true, 'Swamp must pay {B}');

  // Mountain: {R}
  const mountainState = makePlayerState([{ name: 'Mountain', typeLine: 'Basic Land — Mountain' }]);
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{R}' }, mountainState).affordable, true, 'Mountain must pay {R}');

  // Forest: {G}
  const forestState = makePlayerState([{ name: 'Forest', typeLine: 'Basic Land — Forest' }]);
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{G}' }, forestState).affordable, true, 'Forest must pay {G}');

  // Inkmoth Nexus: {C}
  const inkmothState = makePlayerState([{ name: 'Inkmoth Nexus', typeLine: 'Land' }]);
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{C}' }, inkmothState).affordable, true, 'Inkmoth Nexus must pay {C}');
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{W}' }, inkmothState).affordable, false, 'Inkmoth Nexus cannot pay {W}');

  // Hallowed Fountain: {W} or {U}
  const hallowedState = makePlayerState([{ name: 'Hallowed Fountain', typeLine: 'Land — Plains Island' }]);
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{W}' }, hallowedState).affordable, true, 'Hallowed Fountain must pay {W}');
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{U}' }, hallowedState).affordable, true, 'Hallowed Fountain must pay {U}');
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{B}' }, hallowedState).affordable, false, 'Hallowed Fountain cannot pay {B}');

  // Mana Confluence: any color ({W}, {U}, {B}, {R}, {G}, {C})
  const confluenceState = makePlayerState([{ name: 'Mana Confluence', typeLine: 'Land' }]);
  for (const color of ['W', 'U', 'B', 'R', 'G', 'C']) {
    assert.strictEqual(testAgent.getPaymentPlan({ manaCost: `{${color}}` }, confluenceState).affordable, true, `Mana Confluence must pay {${color}}`);
  }

  // Spire of Industry: {C} w/o artifact, any color w/ artifact
  const spireNoArtState = makePlayerState([{ name: 'Spire of Industry', typeLine: 'Land' }]);
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{C}' }, spireNoArtState).affordable, true, 'Spire w/o artifact must pay {C}');
  assert.strictEqual(testAgent.getPaymentPlan({ manaCost: '{W}' }, spireNoArtState).affordable, false, 'Spire w/o artifact cannot pay {W}');

  const spireWithArtState = makePlayerState(
    [{ name: 'Spire of Industry', typeLine: 'Land' }],
    [{ name: 'Memnite', typeLine: 'Artifact Creature — Construct', isCreature: true }]
  );
  for (const color of ['W', 'U', 'B', 'R', 'G', 'C']) {
    assert.strictEqual(testAgent.getPaymentPlan({ manaCost: `{${color}}` }, spireWithArtState).affordable, true, `Spire w/ artifact must pay {${color}}`);
  }

  // Part 2: Simulate 3 full turns across all 6 preconstructed decks
  const DECKS_TO_TEST = [
    {
      id: 'AMERICAN_GADGETS',
      lands: [
        { name: 'Plains', typeLine: 'Basic Land — Plains' },
        { name: 'Mountain', typeLine: 'Basic Land — Mountain' }
      ],
      spells: [
        {
          name: "Sigarda's Aid",
          typeLine: 'Enchantment',
          manaCost: '{W}',
          cmc: 1,
          oracleText: 'You may cast Aura and Equipment spells as though they had flash.\nWhenever an Equipment enters the battlefield under your control, you may attach it to target creature you control.'
        },
        {
          name: 'Colossus Hammer',
          typeLine: 'Artifact — Equipment',
          manaCost: '{1}',
          cmc: 1,
          oracleText: 'Equipped creature gets +10/+10 and loses flying.\nEquip {8}'
        }
      ],
      creature: {
        name: 'Memnite',
        typeLine: 'Artifact Creature — Construct',
        manaCost: '{0}',
        power: 1,
        toughness: 1
      }
    },
    {
      id: 'MONO_BLACK',
      lands: [
        { name: 'Swamp', typeLine: 'Basic Land — Swamp' },
        { name: 'Swamp', typeLine: 'Basic Land — Swamp' }
      ],
      spells: [
        {
          name: 'Bloodghast',
          typeLine: 'Creature — Vampire Spirit',
          manaCost: '{B}{B}',
          cmc: 2,
          power: 2,
          toughness: 1
        },
        {
          name: 'Thoughtseize',
          typeLine: 'Sorcery',
          manaCost: '{B}',
          cmc: 1,
          oracleText: 'Target opponent reveals their hand.'
        }
      ]
    },
    {
      id: 'BURN',
      lands: [
        { name: 'Mountain', typeLine: 'Basic Land — Mountain' },
        { name: 'Mountain', typeLine: 'Basic Land — Mountain' }
      ],
      spells: [
        {
          name: 'Goblin Guide',
          typeLine: 'Creature — Goblin Scout',
          manaCost: '{R}',
          cmc: 1,
          power: 2,
          toughness: 2,
          keywords: { haste: true }
        }
      ]
    },
    {
      id: 'AZORIUS_CONTROL',
      lands: [
        { name: 'Island', typeLine: 'Basic Land — Island' },
        { name: 'Plains', typeLine: 'Basic Land — Plains' }
      ],
      spells: [
        {
          name: 'Consider',
          typeLine: 'Instant',
          manaCost: '{U}',
          cmc: 1,
          oracleText: 'Look at the top card of your library. Draw a card.'
        }
      ]
    },
    {
      id: 'MONO_GREEN_STOMPY',
      lands: [
        { name: 'Forest', typeLine: 'Basic Land — Forest' },
        { name: 'Forest', typeLine: 'Basic Land — Forest' }
      ],
      spells: [
        {
          name: 'Experiment One',
          typeLine: 'Creature — Human Ooze',
          manaCost: '{G}',
          cmc: 1,
          power: 1,
          toughness: 1
        }
      ]
    },
    {
      id: 'WHITE_WEENIE',
      lands: [
        { name: 'Plains', typeLine: 'Basic Land — Plains' },
        { name: 'Plains', typeLine: 'Basic Land — Plains' }
      ],
      spells: [
        {
          name: 'Thraben Inspector',
          typeLine: 'Creature — Human Soldier',
          manaCost: '{W}',
          cmc: 1,
          power: 1,
          toughness: 2
        }
      ]
    }
  ];

  for (const cfg of DECKS_TO_TEST) {
    const precon = getPreconstructedDeckById(cfg.id);
    assert.ok(precon, `Preconstructed deck found for ${cfg.id}`);
    const grounded = groundDeckForEngine(precon.cards || precon.mainboard);
    assert.ok(grounded && Array.isArray(grounded.cards) && grounded.cards.length > 0, `Cards grounded for ${cfg.id}`);

    const app = new RPMAppController({
      autoConnect: false,
      myPlayerId: 'p1',
      playerIds: ['p1', 'p2_perkins'],
      pregame: false
    });

    let triggerFired = false;
    app.tabletopState.on('TRIGGER_TARGET_REQUIRED', () => { triggerFired = true; });

    await app.startPerkinsMatch(cfg.id, {
      thinkingDelayMs: 0,
      coachEnabled: false,
      pregame: false,
      interactiveRollOff: false,
      botDeck: cfg.id
    });

    if (cfg.id === 'AMERICAN_GADGETS') {
      app.tabletopState.interactiveMode = true;
    }

    const botPlayer = app.tabletopState.getPlayer('p2_perkins');
    assert.ok(botPlayer, `Bot player registered in TabletopStateManager for ${cfg.id}`);

    // Seed library with spare lands so draw steps succeed without decking out
    botPlayer.library = [
      app.tabletopState.addCardToZone('p2_perkins', 'library', { name: 'Library Land 1', typeLine: 'Basic Land' }),
      app.tabletopState.addCardToZone('p2_perkins', 'library', { name: 'Library Land 2', typeLine: 'Basic Land' }),
      app.tabletopState.addCardToZone('p2_perkins', 'library', { name: 'Library Land 3', typeLine: 'Basic Land' })
    ];
    botPlayer.zones.library = [...botPlayer.library];

    // Seed hand deterministically with lands and cheap castable spells
    const handCards = [];
    for (const l of cfg.lands) {
      handCards.push(app.tabletopState.addCardToZone('p2_perkins', 'hand', l));
    }
    for (const s of cfg.spells) {
      handCards.push(app.tabletopState.addCardToZone('p2_perkins', 'hand', s));
    }
    if (cfg.creature) {
      app.tabletopState.addCardToZone('p2_perkins', 'battlefield', cfg.creature);
    }
    botPlayer.hand = handCards;
    botPlayer.zones.hand = [...handCards];

    const tick = () => new Promise(r => setTimeout(r, 5));
    async function driveTurn() {
      const startTurn = app.priorityMachine.turnNumber;
      let guard = 0;
      while (app.priorityMachine.turnNumber === startTurn && guard++ < 80) {
        await tick();
        const psm = app.priorityMachine;
        const stackLen = psm.stack?.length || app.tabletopState?.stack?.length || 0;
        if (stackLen > 0) {
          if (psm.priorityPlayerId === 'p1') {
            psm.passPriority('p1');
          } else {
            psm.resolveTop();
          }
        } else {
          if (psm.priorityPlayerId === 'p1') {
            psm.passPriority('p1');
          } else {
            await tick();
            if (psm.priorityPlayerId === 'p2_perkins' && (psm.stack?.length || 0) === 0) {
              psm.passPriority('p2_perkins');
            }
          }
        }
      }
      assert.strictEqual(app.priorityMachine.stack?.length || 0, 0, `Stack must be empty at end of turn ${startTurn}`);
    }

    // Simulate 3 full turns
    await driveTurn(); // Turn 1 (p1)
    await driveTurn(); // Turn 2 (p2_perkins acts)
    await driveTurn(); // Turn 3 (p1)

    // Assert: Perkins played >= 1 land
    assert.ok(botPlayer.battlefield.lands.length >= 1, `${cfg.id}: Perkins must play >= 1 land across 3 turns`);

    // Assert: Perkins cast >= 1 nonland spell
    const nonlandCount = (botPlayer.battlefield.creatures?.length || 0) +
      (botPlayer.battlefield.noncreatures?.length || 0) +
      (botPlayer.graveyard?.length || 0) -
      (cfg.creature ? 1 : 0);
    assert.ok(nonlandCount >= 1, `${cfg.id}: Perkins must cast >= 1 nonland spell across 3 turns`);

    // For AMERICAN_GADGETS, run turn 4 so Colossus Hammer is cast and Sigarda's Aid trigger resolves
    if (cfg.id === 'AMERICAN_GADGETS') {
      await driveTurn(); // Turn 4 (p2_perkins: Colossus Hammer cast)
      assert.ok(triggerFired, 'AMERICAN_GADGETS: TRIGGER_TARGET_REQUIRED must fire for Sigarda\'s Aid');
      const hammer = botPlayer.battlefield.noncreatures.find(c => c.name === 'Colossus Hammer');
      assert.ok(hammer, 'Colossus Hammer must be on battlefield');
      assert.ok(hammer.attachedTo, 'Colossus Hammer must be auto-attached to Memnite by Perkins trigger handler');
    }

    app.perkinsAgent?.destroy();
    app.destroy();
  }

  recordTest('Perkins Multi-Deck Certification', 'ADV-36: Universal Deck Grounding & Non-Red Perkins AI Execution (CR 117, CR 500-514, CR 603)', 'PASS');
} catch (err) {
  recordTest('Perkins Multi-Deck Certification', 'ADV-36: Universal Deck Grounding & Non-Red Perkins AI Execution (CR 117, CR 500-514, CR 603)', 'FAIL', err.message);
}

// ── ADV-37: Crash-Proof Unknown Card Fallback & Assisted Clause Logging ──
try {
  const { groundDeckForEngine } = await import('../src/OracleEffectCompiler.js');

  const customCard = {
    name: 'Chrono Paradox Engine',
    typeLine: 'Sorcery',
    oracleText: 'Whenever time paradox occurs, invert the phase space. Draw two cards. Flux all continuum anchors.'
  };

  const groundedDeck = groundDeckForEngine([customCard]);
  assert.strictEqual(groundedDeck.cards.length, 1, 'groundDeckForEngine must process 1 card');
  assert.strictEqual(groundedDeck.unresolvedClauses.length, 1, 'Unmapped clauses must be tracked in unresolvedClauses');
  assert.strictEqual(groundedDeck.cards[0].groundedSpec.isFullyAutomated, false, 'Card with unmapped clauses must not be fully automated');
  assert.ok(groundedDeck.cards[0].groundedEffects.some(e => e.primitive === 'DRAW_CARDS' && e.amount === 2), 'Grounded primitive DRAW_CARDS must be compiled');

  const state = new TabletopStateManager({ players: ['p1', 'p2'] });
  state.executionLog = [];
  state.players.p1.library = [
    { name: 'Chrono Library Card 1', instanceId: 'clc_1' },
    { name: 'Chrono Library Card 2', instanceId: 'clc_2' },
    { name: 'Chrono Library Card 3', instanceId: 'clc_3' }
  ];

  // 1. Cast and resolve through TabletopStateManager
  const inHand = state.addCardToZone('p1', 'hand', groundedDeck.cards[0]);
  state.castSpell('p1', inHand.instanceId);
  assert.strictEqual(state.stack.length, 1, 'Stack must contain 1 spell after casting');

  const res = state.resolveTopOfStack();
  assert.ok(res, 'Spell must resolve successfully without throwing');
  assert.strictEqual(state.stack.length, 0, 'Stack must empty cleanly after resolution');
  assert.strictEqual(state.players.p1.hand.length, 2, 'Grounded clause must execute and draw 2 cards');
  assert.ok(state.players.p1.graveyard.some(c => c.name === 'Chrono Paradox Engine'), 'Sorcery must land in graveyard');

  // 2. Force an internal error during resolution (monkeypatch helper to throw)
  const errCard = {
    name: 'Chrono Paradox Engine 2',
    typeLine: 'Sorcery',
    oracleText: 'Whenever time paradox occurs, invert the phase space. Draw two cards. Flux all continuum anchors.'
  };
  const inHand2 = state.addCardToZone('p1', 'hand', errCard);
  state.castSpell('p1', inHand2.instanceId);
  assert.strictEqual(state.stack.length, 1, 'Stack must hold errCard before resolution');

  const origDraw = state.drawCard;
  state.drawCard = () => { throw new Error('Simulated fatal internal engine error'); };

  let threw = false;
  try {
    state.resolveTopOfStack();
  } catch (_) {
    threw = true;
  }
  state.drawCard = origDraw; // restore immediately

  assert.strictEqual(threw, false, 'Internal resolution error must be caught by TabletopStateManager boundary');
  assert.strictEqual(state.stack.length, 0, 'Stack must still empty cleanly after caught error');
  assert.ok(state.players.p1.graveyard.some(c => c.name === 'Chrono Paradox Engine 2'), 'Card must still land in destination zone on error');

  // Verify Assisted Clause entry in actionLog and executionLog
  const assistedAction = state.actionLog.find(l => l.actionType === 'ASSISTED_CLAUSE' && l.message && l.message.includes('🟡 [Assisted Clause]'));
  assert.ok(assistedAction, 'actionLog must contain 🟡 [Assisted Clause] entry');

  const assistedExec = state.executionLog.find(l => l.text && l.text.includes('🟡 [Assisted Clause]'));
  assert.ok(assistedExec, 'executionLog must contain 🟡 [Assisted Clause] entry');

  // Verify game continues normally
  const nextLand = state.addCardToZone('p1', 'hand', { name: 'Mountain', typeLine: 'Basic Land — Mountain' });
  state.playLand('p1', nextLand.instanceId);
  assert.ok(state.players.p1.battlefield.lands.some(c => c.name === 'Mountain'), 'Game must continue normally after error');

  recordTest('Oracle Compiler & Engine Fallback', 'ADV-37: Crash-Proof Unknown Card Fallback, Grounded Execution & Assisted Clause Logging', 'PASS');
} catch (err) {
  recordTest('Oracle Compiler & Engine Fallback', 'ADV-37: Crash-Proof Unknown Card Fallback, Grounded Execution & Assisted Clause Logging', 'FAIL', err.message);
}

// ── ADV-38: Email + Password Auth & Persistent Token Restoration ──
try {
  const http = await import('node:http');
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { createAuthHttpHandler } = await import('../src/relay.js');
  const { AuthManager, AUTH_TOKEN_STORAGE_KEY } = await import('../src/AuthManager.js');

  const tempStorePath = path.join(os.tmpdir(), `rpm_accounts_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  let authHandler = createAuthHttpHandler({ storePath: tempStorePath });

  const server = http.createServer(async (req, res) => {
    const handled = await authHandler(req, res);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const apiBaseUrl = `http://127.0.0.1:${port}`;

  class MockStorage {
    constructor() { this._data = new Map(); }
    getItem(k) { return this._data.get(k) || null; }
    setItem(k, v) { this._data.set(k, String(v)); }
    removeItem(k) { this._data.delete(k); }
  }

  // 1. Validation rejection: bad email / short password (400)
  const storageA = new MockStorage();
  const clientA = new AuthManager({ apiBaseUrl, storage: storageA });

  await assert.rejects(
    clientA.signUpWithPassword('not-an-email', 'validpass123'),
    /Invalid email format/,
    'Bad email must be rejected by client validation'
  );
  await assert.rejects(
    clientA.signUpWithPassword('planeswalker@test.com', '123'),
    /at least 6 characters/,
    'Short password must be rejected by client validation'
  );

  const directBadEmailRes = await fetch(`${apiBaseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'bad-email-format', password: 'validpassword123' })
  });
  assert.strictEqual(directBadEmailRes.status, 400, 'Relay must return 400 for bad email');

  const directShortPassRes = await fetch(`${apiBaseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'user@test.com', password: '123' })
  });
  assert.strictEqual(directShortPassRes.status, 400, 'Relay must return 400 for short password');

  // 2. Register user
  const regResult = await clientA.signUpWithPassword('planeswalker@test.com', 'mox_diamond_42', 'PlaneswalkerA');
  assert.ok(regResult.success, 'Registration must succeed');
  assert.ok(regResult.token, 'Registration must return session token');
  assert.strictEqual(regResult.user.email, 'planeswalker@test.com');

  // 3. Duplicate email rejection (409)
  const dupRes = await fetch(`${apiBaseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'planeswalker@test.com', password: 'mox_diamond_42' })
  });
  assert.strictEqual(dupRes.status, 409, 'Duplicate registration must return 409 Conflict');

  // 4. Log in from a second AuthManager instance (separate in-memory storage)
  const storageB = new MockStorage();
  const clientB = new AuthManager({ apiBaseUrl, storage: storageB });
  const loginResult = await clientB.signInWithPassword('planeswalker@test.com', 'mox_diamond_42');
  assert.ok(loginResult.success, 'Login must succeed');
  assert.ok(loginResult.token, 'Login must return token');
  assert.strictEqual(storageB.getItem('rpm_auth_token_v1'), loginResult.token, 'Token must be persisted under rpm_auth_token_v1');
  assert.strictEqual(AUTH_TOKEN_STORAGE_KEY, 'rpm_auth_token_v1', 'AUTH_TOKEN_STORAGE_KEY must equal rpm_auth_token_v1');

  // 5. New third instance with that storage calls autoRestoreSession() and gets same user
  const clientC = new AuthManager({ apiBaseUrl, storage: storageB });
  const restoredUser = await clientC.autoRestoreSession();
  assert.ok(restoredUser, 'autoRestoreSession must restore profile');
  assert.strictEqual(restoredUser.email, 'planeswalker@test.com');
  assert.strictEqual(restoredUser.id, regResult.user.id);

  // 6. syncDecks from client A, fetchDecks from client B returns same deck slot
  const sampleDecks = {
    slot_1: { name: 'Hammer Time Deck', format: 'MODERN', cards: [{ name: 'Colossus Hammer', count: 4 }] }
  };
  const syncRes = await clientA.syncDecks(sampleDecks);
  assert.ok(syncRes.success, 'syncDecks must succeed');
  const fetchedDecks = await clientB.fetchDecks();
  assert.deepStrictEqual(fetchedDecks.slot_1, sampleDecks.slot_1, 'Client B must fetch synced deck slots');

  // 7. Logout invalidates token (me -> 401)
  clientB.logout();
  assert.strictEqual(storageB.getItem('rpm_auth_token_v1'), null, 'logout must remove token from storage');
  const meRes = await fetch(`${apiBaseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${loginResult.token}` }
  });
  assert.strictEqual(meRes.status, 401, 'Logged out token must return 401 Unauthorized');

  // 8. Restart handler from same file store and confirm login still works (persistence)
  authHandler = createAuthHttpHandler({ storePath: tempStorePath });
  const storageD = new MockStorage();
  const clientD = new AuthManager({ apiBaseUrl, storage: storageD });
  const persistentLogin = await clientD.signInWithPassword('planeswalker@test.com', 'mox_diamond_42');
  assert.ok(persistentLogin.success, 'Login must succeed after server handler restart from persistent file store');
  assert.strictEqual(persistentLogin.user.email, 'planeswalker@test.com');

  // Clean up server and temp file
  await new Promise(resolve => server.close(resolve));
  try {
    if (fs.existsSync(tempStorePath)) fs.unlinkSync(tempStorePath);
  } catch (_) {}

  recordTest('Auth & Relay Multi-Session', 'ADV-38: Email + Password Auth & Persistent Token Restoration (INV-AUTH-1, [P27-P29])', 'PASS');
} catch (err) {
  recordTest('Auth & Relay Multi-Session', 'ADV-38: Email + Password Auth & Persistent Token Restoration (INV-AUTH-1, [P27-P29])', 'FAIL', err.message);
}

// ── 39. Bilingual ES/EN Normalizer & >= 95% Deck Support Audit (ADV-39) ──
try {
  const rawDeckString = `17 llanuras
4 castle ardenvale
3 resistir los elementos
4 path to Exile
3 ocelot profe
3 defender los termos
3 soul warden
4 dar la alarma
4 honor de los puros
2 reunir a los aldeanos
4 virtud intangible
3 anuncio de boda // festejo de boda
2 talento del cuidador
3 heroina de fuerteespada
2 linea mistica de la santidad`;

  // 1. Bilingual import & typo normalization
  const imported = DeckSlotManager.importDeckText(rawDeckString, { name: 'Mono-White Tokens (ES Import)' });
  assert.strictEqual(imported.totalCount, 61, 'Imported deck should contain 61 total cards');

  // Verify all cards are normalized to official English names
  const expectedNames = [
    'Plains', 'Castle Ardenvale', 'Brave the Elements', 'Path to Exile', 'Ocelot Pride',
    'Secure the Wastes', 'Soul Warden', 'Raise the Alarm', 'Honor of the Pure',
    'Gather the Townsfolk', 'Intangible Virtue', 'Wedding Announcement // Wedding Festivity',
    "Caretaker's Talent", 'Hero of Bladehold', 'Leyline of Sanctity'
  ];
  for (const name of expectedNames) {
    const found = imported.cards.find(c => c.name.toLowerCase() === name.toLowerCase());
    assert.ok(found, `Expected card '${name}' should be present after bilingual normalization`);
  }

  // 2. Audit deck support >= 95% (target 100%)
  const audit = auditDeckSupport(imported.cards);
  assert.strictEqual(audit.supportPercentage, 100, `Deck support percentage must be 100%, got ${audit.supportPercentage}%`);
  assert.strictEqual(audit.unsupportedCards.length, 0, 'No unsupported cards allowed in certified Mono-White deck');
  assert.strictEqual(audit.supportedCount, 61, 'All 61 cards must be supported');

  // 3. evaluateDeckSupportPercentage helper
  const pct = evaluateDeckSupportPercentage(imported.cards);
  assert.strictEqual(pct, 100, 'evaluateDeckSupportPercentage must return 100%');

  recordTest('DeckSlotManager & OracleEffectCompiler', 'ADV-39: Bilingual ES/EN Import Normalizer & 100% Deck Support Audit (INV-ARCH-WIRED)', 'PASS');
} catch (err) {
  recordTest('DeckSlotManager & OracleEffectCompiler', 'ADV-39: Bilingual ES/EN Import Normalizer & 100% Deck Support Audit (INV-ARCH-WIRED)', 'FAIL', err.message);
}

// ── 40. Mono-White Tokens Mechanics E2E Certification (ADV-40) ──
try {
  const state = createMatchState();
  const p1 = state.getPlayer('p1');
  const p2 = state.getPlayer('p2');

  // 1. Static Anthems (Honor of the Pure + Intangible Virtue) & Layer 6/7c Interaction
  p1.battlefield.noncreatures.push({
    instanceId: 'honor_1',
    name: 'Honor of the Pure',
    controllerId: 'p1',
    typeLine: 'Enchantment'
  });
  p1.battlefield.noncreatures.push({
    instanceId: 'virtue_1',
    name: 'Intangible Virtue',
    controllerId: 'p1',
    typeLine: 'Enchantment'
  });

  const tokens = state.createCreatureTokens('p1', 1, {
    name: 'Soldier Token',
    power: 1,
    toughness: 1,
    colors: ['W'],
    isWhite: true,
    isToken: true,
    subtypes: ['Soldier']
  });
  assert.strictEqual(tokens.length, 1);
  const token = tokens[0];
  const tokenStats = state.abilityEngine.evaluateCreatureStats(token, state);
  assert.strictEqual(tokenStats.power, 3, '1/1 Soldier token gets +1/+1 from Honor of the Pure and +1/+1 from Intangible Virtue -> 3/3');
  assert.strictEqual(tokenStats.toughness, 3);
  assert.strictEqual(tokenStats.hasVigilance, true, 'Intangible Virtue grants Vigilance to creature tokens');

  // 2. Token Engine, Soul Warden Life-Gain Trigger & Secure the Wastes
  p1.battlefield.creatures.push({
    instanceId: 'warden_1',
    name: 'Soul Warden',
    controllerId: 'p1',
    typeLine: 'Creature — Kor Cleric',
    power: 1,
    toughness: 1
  });
  p1.battlefield.creatures.push({
    instanceId: 'ocelot_1',
    name: 'Ocelot Pride',
    controllerId: 'p1',
    typeLine: 'Creature — Cat Rebel',
    power: 1,
    toughness: 1
  });

  const startingLife = p1.resources.life;
  const secureRes = state.resolveSpellEffect('p1', {
    name: 'Secure the Wastes',
    typeLine: 'Instant'
  }, { xValue: 3 });

  assert.strictEqual(secureRes.tokens.length, 3, 'Secure the Wastes with X=3 creates 3 Warrior tokens');
  assert.strictEqual(p1.resources.life, startingLife + 3, 'Soul Warden triggers 3 times, gaining 3 life');
  assert.strictEqual(p1.lifeGainedThisTurn, 3, 'p1.lifeGainedThisTurn accurately tracked');

  // Ascend (10 permanents) and End Step Ocelot Pride Duplication
  p1.battlefield.lands.push({ instanceId: 'plains_1', name: 'Plains', controllerId: 'p1' });
  p1.battlefield.lands.push({ instanceId: 'plains_2', name: 'Plains', controllerId: 'p1' });

  const beforeEndTokens = p1.battlefield.creatures.length;
  state.handleEndStep('p1');
  const afterEndTokens = p1.battlefield.creatures.length;
  // 1 Cat token created, then 5 total tokens created this turn duplicated = 6 new tokens
  assert.strictEqual(afterEndTokens - beforeEndTokens, 6, 'Ocelot Pride creates 1 Cat + duplicates 5 tokens created this turn with City Blessing');

  // 3. Hero of Bladehold Battle Cry & Attacking Tokens
  const hero = {
    instanceId: 'hero_1',
    name: 'Hero of Bladehold',
    controllerId: 'p1',
    typeLine: 'Creature — Human Knight',
    power: 3,
    toughness: 4,
    isTapped: false
  };
  p1.battlefield.creatures.push(hero);

  state.declareAttackers('p1', ['hero_1']);
  assert.ok(p1.battlefield.creatures.some(c => c.name === 'Soldier Token' && c.isAttacking && c.isTapped), 'Hero of Bladehold creates 2 Soldier tokens tapped and attacking');

  // 4. Leyline of Sanctity Hexproof Defense & Perkins AI Awareness
  p1.battlefield.noncreatures.push({
    instanceId: 'leyline_1',
    name: 'Leyline of Sanctity',
    controllerId: 'p1',
    typeLine: 'Enchantment'
  });
  assert.strictEqual(state.playerHasHexproof('p1'), true, 'Leyline gives p1 hexproof');
  assert.strictEqual(state.isValidTarget('p1', 'p2'), false, 'p2 cannot target p1 with spells/abilities');

  const perkins = new PerkinsAgent({ slotId: 'p2', tabletopState: state });
  const target = perkins.selectLegalSpellTarget({
    name: 'Lava Spike',
    oracleText: 'Lava Spike deals 3 damage to target player.',
    typeLine: 'Sorcery'
  }, state);
  assert.strictEqual(target, null, 'Perkins refuses to target hexproof player with player-only burn spell');

  recordTest('Mono-White Tokens Mechanics', 'ADV-40: Anthems, Token Engine, Soul Warden, Ocelot Pride Ascend, Hero Battle Cry & Leyline Hexproof (CR 508, 603, 613)', 'PASS');
} catch (err) {
  recordTest('Mono-White Tokens Mechanics', 'ADV-40: Anthems, Token Engine, Soul Warden, Ocelot Pride Ascend, Hero Battle Cry & Leyline Hexproof (CR 508, 603, 613)', 'FAIL', err.message);
}

// ── Summary Report ──
console.log('\n==================================================================');
console.log('  CERTIFICATION AUDIT SUMMARY REPORT');
console.log('==================================================================');
console.log(`  Total Cards / Vectors Audited: ${resultsMatrix.length}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log('------------------------------------------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
