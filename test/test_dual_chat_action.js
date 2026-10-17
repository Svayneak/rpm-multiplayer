/**
 * test/test_dual_chat_action.js
 * Comprehensive Acceptance Test Suite for Feature 5 & 6:
 * Dual-Channel Priority Chat & Fast-Path Action Bus with Staged Intent Chips
 * 
 * Document ID: SPEC-RPM-CHAT-005
 */

import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import { DualChannelChat, PriorityGatedChatError, ProposalExpiredError } from '../src/DualChannelChat.js';
import { ActionLexer } from '../src/ActionLexer.js';
import { PriorityStateMachine } from '../src/PriorityStateMachine.js';
import { TabletopStateManager } from '../src/TabletopStateManager.js';

let passedTests = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function runSuite() {
  console.log('\n======================================================');
  console.log('Running Acceptance Test Suite: Dual-Channel & Action Bus');
  console.log('Document ID: SPEC-RPM-CHAT-005');
  console.log('======================================================\n');

  const p1 = 'player_alpha';
  const p2 = 'player_beta';
  const sessionId = 'test_session_56';

  // -------------------------------------------------------------------------
  // TEST 1: Chit-Chat Freedom & Independence
  // -------------------------------------------------------------------------
  test('Test 1: Chit-chat allowed anytime by any player without priority; zero state mutation', () => {
    const psm = new PriorityStateMachine({ sessionId, players: [p1, p2], activePlayerId: p1 });
    const chat = new DualChannelChat({ sessionId, myPlayerId: p2, priorityStateMachine: psm });

    // p2 does not hold priority (p1 holds it initially)
    assert.strictEqual(psm.getPriorityPlayerId(), p1);
    assert.strictEqual(chat.isInputLocked(), true);

    // Player 2 posts to CHIT_CHAT
    const msg = chat.sendChatMessage('CHIT_CHAT', 'Nice play, good luck! 🍀');
    assert.strictEqual(msg.channel, 'CHIT_CHAT');
    assert.strictEqual(msg.senderId, p2);
    assert.strictEqual(msg.text, 'Nice play, good luck! 🍀');
    
    // Invariant check: priority and turn state completely unmodified
    assert.strictEqual(psm.getPriorityPlayerId(), p1);
    assert.strictEqual(psm.getConsecutivePassCount(), 0);
    assert.strictEqual(psm.getStackDepth(), 0);
  });

  // -------------------------------------------------------------------------
  // TEST 2: Priority Gating on Turn Command (Locked)
  // -------------------------------------------------------------------------
  test('Test 2: Turn command strictly rejected with PriorityGatedChatError when player lacks priority', () => {
    const psm = new PriorityStateMachine({ sessionId, players: [p1, p2], activePlayerId: p1 });
    const chat = new DualChannelChat({ sessionId, myPlayerId: p2, priorityStateMachine: psm });

    // p2 attempts to issue a turn command while p1 holds priority
    assert.throws(() => {
      chat.submitTurnCommand('pass');
    }, (err) => {
      return err instanceof PriorityGatedChatError &&
             err.details.attemptedPlayerId === p2 &&
             err.details.priorityPlayerId === p1;
    });

    // Invariant: no proposals created
    assert.strictEqual(chat.getActiveProposal(), null);
  });

  // -------------------------------------------------------------------------
  // TEST 3: Priority Gating on Turn Command (Unlocked)
  // -------------------------------------------------------------------------
  test('Test 3: Turn command permitted when player holds priority (priorityPlayerId === myPlayerId)', () => {
    const psm = new PriorityStateMachine({ sessionId, players: [p1, p2], activePlayerId: p1 });
    const chat = new DualChannelChat({ sessionId, myPlayerId: p1, priorityStateMachine: psm });

    assert.strictEqual(chat.isInputLocked(), false);
    const proposal = chat.submitTurnCommand('pass');

    assert.ok(proposal);
    assert.strictEqual(proposal.actionType, 'PASS_PRIORITY');
    assert.strictEqual(chat.getActiveProposal().id, proposal.id);
  });

  // -------------------------------------------------------------------------
  // TEST 4: Fast-Path Lexer - Priority Passing (Bilingual)
  // -------------------------------------------------------------------------
  test('Test 4: Fast-path lexer correctly parses priority pass shorthands in English & Spanish', () => {
    const enTokens = ['pass', 'go', 'your turn', 'done', 'pass priority'];
    const esTokens = ['paso', 'cedo', 'turno', 'tu turno', 'cedo prioridad', 'paso prioridad'];

    for (const token of enTokens) {
      const res = ActionLexer.parse(token);
      assert.strictEqual(res.actionType, 'PASS_PRIORITY', `Failed for EN token: ${token}`);
      assert.strictEqual(res.confidence, 1.0);
    }

    for (const token of esTokens) {
      const res = ActionLexer.parse(token);
      assert.strictEqual(res.actionType, 'PASS_PRIORITY', `Failed for ES token: ${token}`);
      assert.strictEqual(res.confidence, 1.0);
    }
  });

  // -------------------------------------------------------------------------
  // TEST 5: Fast-Path Lexer - Life Changes (Bilingual)
  // -------------------------------------------------------------------------
  test('Test 5: Fast-path lexer correctly parses life changes (SET and DELTA) in English & Spanish', () => {
    // Set operations
    const setCases = [
      { text: 'to 17', expected: 17 },
      { text: 'baja a 16', expected: 16 },
      { text: 'life 12', expected: 12 },
      { text: 'vida a 14', expected: 14 }
    ];
    for (const c of setCases) {
      const res = ActionLexer.parse(c.text);
      assert.strictEqual(res.actionType, 'ADJUST_LIFE', `Failed on: ${c.text}`);
      assert.strictEqual(res.params.lifeOperation, 'SET');
      assert.strictEqual(res.params.lifeAmount, c.expected);
    }

    // Delta operations
    const deltaCases = [
      { text: 'take 3', expected: -3 },
      { text: 'pierdo 4', expected: -4 },
      { text: '-2', expected: -2 },
      { text: 'gano 2', expected: +2 },
      { text: 'gain 5 life', expected: +5 },
      { text: '+3 vidas', expected: +3 }
    ];
    for (const c of deltaCases) {
      const res = ActionLexer.parse(c.text);
      assert.strictEqual(res.actionType, 'ADJUST_LIFE', `Failed on: ${c.text}`);
      assert.strictEqual(res.params.lifeOperation, 'DELTA');
      assert.strictEqual(res.params.lifeDelta, c.expected);
    }
  });

  // -------------------------------------------------------------------------
  // TEST 6: Fast-Path Lexer - Land Plays (Bilingual)
  // -------------------------------------------------------------------------
  test('Test 6: Fast-path lexer correctly parses land drop shorthands in English & Spanish', () => {
    const landCases = [
      { text: 'play mountain', expected: 'mountain' },
      { text: 'bajo isla', expected: 'isla' },
      { text: 'land blood crypt', expected: 'blood crypt' },
      { text: 'juego bosque', expected: 'bosque' },
      { text: 'drop steam vents', expected: 'steam vents' }
    ];

    for (const c of landCases) {
      const res = ActionLexer.parse(c.text);
      assert.strictEqual(res.actionType, 'PLAY_LAND', `Failed on: ${c.text}`);
      assert.strictEqual(res.params.cardName.toLowerCase(), c.expected.toLowerCase());
    }
  });

  // -------------------------------------------------------------------------
  // TEST 7: Fast-Path Lexer - Simple Spell Casting (Bilingual)
  // -------------------------------------------------------------------------
  test('Test 7: Fast-path lexer correctly parses spell casting and targeted spells', () => {
    const spellCases = [
      { text: 'cast bolt', expectedCard: 'bolt', expectedTarget: null },
      { text: 'tiro bolt a ragavan', expectedCard: 'bolt', expectedTarget: 'ragavan' },
      { text: 'counterspell', expectedCard: 'counterspell', expectedTarget: null },
      { text: 'cast fatal push on tarmogoyf', expectedCard: 'fatal push', expectedTarget: 'tarmogoyf' }
    ];

    for (const c of spellCases) {
      const res = ActionLexer.parse(c.text);
      assert.strictEqual(res.actionType, 'CAST_SPELL', `Failed on: ${c.text}`);
      assert.strictEqual(res.params.cardName.toLowerCase(), c.expectedCard.toLowerCase());
      if (c.expectedTarget) {
        assert.ok(res.params.targets && res.params.targets.length > 0);
        assert.strictEqual(res.params.targets[0].targetName.toLowerCase(), c.expectedTarget.toLowerCase());
      }
    }
  });

  // -------------------------------------------------------------------------
  // TEST 8: Staged Action Proposal Isolation (Zero Blind Mutation)
  // -------------------------------------------------------------------------
  test('Test 8: Submitting turn command generates Staged Proposal without mutating Tabletop or Priority state', () => {
    const psm = new PriorityStateMachine({ sessionId, players: [p1, p2], activePlayerId: p1 });
    const ttsm = new TabletopStateManager({ sessionId, players: [p1, p2] });
    const chat = new DualChannelChat({ sessionId, myPlayerId: p1, priorityStateMachine: psm, tabletopStateManager: ttsm });

    const initialLife = ttsm.getPlayerLife(p1);
    const initialStackDepth = psm.getStackDepth();

    // Command: life change
    const proposal = chat.submitTurnCommand('take 3');
    assert.strictEqual(proposal.status, 'STAGED');
    assert.strictEqual(chat.getActiveProposal().id, proposal.id);

    // Invariant verification: Tabletop state NOT mutated prior to confirmation
    assert.strictEqual(ttsm.getPlayerLife(p1), initialLife, 'Life total was prematurely mutated!');
    assert.strictEqual(psm.getStackDepth(), initialStackDepth, 'Stack depth prematurely altered!');
  });

  // -------------------------------------------------------------------------
  // TEST 9: Action Proposal Confirmation Dispatch
  // -------------------------------------------------------------------------
  test('Test 9: 1-Tap confirmAction(proposalId) successfully dispatches to TabletopStateManager and PriorityStateMachine', () => {
    const psm = new PriorityStateMachine({ sessionId, players: [p1, p2], activePlayerId: p1 });
    const ttsm = new TabletopStateManager({ sessionId, players: [p1, p2] });
    const chat = new DualChannelChat({ sessionId, myPlayerId: p1, priorityStateMachine: psm, tabletopStateManager: ttsm });

    const initialLife = ttsm.getPlayerLife(p1); // 20
    const proposal = chat.submitTurnCommand('take 3');

    // Confirm the proposal
    const result = chat.confirmProposal(proposal.id);
    assert.strictEqual(result.success, true);
    assert.strictEqual(chat.getActiveProposal(), null, 'Active proposal was not cleared after confirmation');

    // State verification
    assert.strictEqual(ttsm.getPlayerLife(p1), initialLife - 3, 'Life change did not apply to tabletop state');
  });

  // -------------------------------------------------------------------------
  // TEST 10: Action Proposal Cancellation
  // -------------------------------------------------------------------------
  test('Test 10: 1-Tap cancelProposal(proposalId) clears staged chip with zero state mutation', () => {
    const psm = new PriorityStateMachine({ sessionId, players: [p1, p2], activePlayerId: p1 });
    const ttsm = new TabletopStateManager({ sessionId, players: [p1, p2] });
    const chat = new DualChannelChat({ sessionId, myPlayerId: p1, priorityStateMachine: psm, tabletopStateManager: ttsm });

    const initialLife = ttsm.getPlayerLife(p1);
    const proposal = chat.submitTurnCommand('take 5');

    // Cancel proposal
    chat.cancelProposal(proposal.id);
    assert.strictEqual(chat.getActiveProposal(), null);

    // Life must remain untouched
    assert.strictEqual(ttsm.getPlayerLife(p1), initialLife);
  });

  // -------------------------------------------------------------------------
  // TEST 11: Ambiguous Intent Resolution via 1-Tap Candidate Selection
  // -------------------------------------------------------------------------
  test('Test 11: Ambiguous shorthand with multiple hand cards triggers candidate list and resolves on 1-tap', () => {
    const mockHand = [
      { instanceId: 'card_1', name: 'Fatal Push', typeLine: 'Instant', manaCost: '{B}' },
      { instanceId: 'card_2', name: 'Unholy Heat', typeLine: 'Instant', manaCost: '{R}' }
    ];

    // Lexer parses broad intent "tiro removal"
    const lexResult = ActionLexer.parse('tiro removal', { handCards: mockHand });
    assert.strictEqual(lexResult.status, 'AMBIGUOUS');
    assert.ok(lexResult.candidates.length === 2);
    assert.strictEqual(lexResult.candidates[0].name, 'Fatal Push');
    assert.strictEqual(lexResult.candidates[1].name, 'Unholy Heat');

    // Resolve ambiguity by selecting candidate 2 ('Unholy Heat')
    const resolvedProposal = ActionLexer.resolveCandidate(lexResult, 'card_2');
    assert.strictEqual(resolvedProposal.status, 'STAGED');
    assert.strictEqual(resolvedProposal.params.cardName, 'Unholy Heat');
    assert.strictEqual(resolvedProposal.params.cardId, 'card_2');
  });

  // -------------------------------------------------------------------------
  // TEST 12: Ambiguous Target Fallback Resolution
  // -------------------------------------------------------------------------
  test('Test 12: Targeted spell without target triggers target ambiguity candidates', () => {
    const mockBattlefield = [
      { targetId: 'perm_1', targetType: 'PERMANENT', targetName: 'Ragavan, Nimble Pilferer' },
      { targetId: 'perm_2', targetType: 'PERMANENT', targetName: 'Dragon\'s Rage Channeler' }
    ];

    const lexResult = ActionLexer.parse('tiro bolt', { 
      handCards: [{ instanceId: 'c_bolt', name: 'Lightning Bolt', typeLine: 'Instant', manaCost: '{R}' }],
      battlefieldPermanents: mockBattlefield 
    });

    assert.strictEqual(lexResult.actionType, 'CAST_SPELL');
    assert.strictEqual(lexResult.params.cardName, 'Lightning Bolt');
    assert.strictEqual(lexResult.status, 'AMBIGUOUS');
    assert.strictEqual(lexResult.candidates.length, 2);

    // Select Ragavan as target
    const resolved = ActionLexer.resolveCandidate(lexResult, 'perm_1');
    assert.strictEqual(resolved.status, 'STAGED');
    assert.strictEqual(resolved.params.targets[0].targetId, 'perm_1');
    assert.strictEqual(resolved.params.targets[0].targetName, 'Ragavan, Nimble Pilferer');
  });

  // -------------------------------------------------------------------------
  // TEST 13: Sub-2ms Fast-Path Execution Benchmark
  // -------------------------------------------------------------------------
  test('Test 13: Sub-2ms execution time benchmark across 1,000 rapid lexer evaluations', () => {
    const sampleInputs = [
      'pass', 'paso', 'go', 'to 17', 'take 3', 'baja a 16', 'gano 2',
      'play mountain', 'bajo isla', 'cast bolt', 'tiro bolt a ragavan', 'counterspell'
    ];

    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const input = sampleInputs[i % sampleInputs.length];
      ActionLexer.parse(input);
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / iterations;

    console.log(`    -> Benchmark: ${iterations} iterations completed in ${elapsed.toFixed(2)}ms (Avg: ${avgMs.toFixed(4)}ms/call)`);
    assert.ok(avgMs < 2.0, `Average parse time ${avgMs}ms exceeded 2.0ms SLA budget!`);
  });

  // -------------------------------------------------------------------------
  // TEST 14: SpeechRecognitionService Integration Pipeline
  // -------------------------------------------------------------------------
  test('Test 14: Speech recognition dictation streams interim results and submits final command on completion', () => {
    let interimBuffer = '';
    let submittedCommand = null;

    // Mock speech recognition callbacks
    const mockSpeechCallbacks = {
      onInterim: (text) => { interimBuffer = text; },
      onFinal: (text) => { submittedCommand = text; }
    };

    // Simulate speech recognition pipeline
    mockSpeechCallbacks.onInterim('tiro b...');
    assert.strictEqual(interimBuffer, 'tiro b...');

    mockSpeechCallbacks.onInterim('tiro bolt a ragavan');
    assert.strictEqual(interimBuffer, 'tiro bolt a ragavan');

    mockSpeechCallbacks.onFinal('tiro bolt a ragavan');
    assert.strictEqual(submittedCommand, 'tiro bolt a ragavan');

    const proposal = ActionLexer.parse(submittedCommand);
    assert.strictEqual(proposal.actionType, 'CAST_SPELL');
    assert.strictEqual(proposal.params.cardName, 'bolt');
    assert.strictEqual(proposal.params.targets[0].targetName, 'ragavan');
  });

  // -------------------------------------------------------------------------
  // TEST 15: Edge Case - Expired Proposal Confirmation
  // -------------------------------------------------------------------------
  test('Test 15: Confirming an expired proposal throws ProposalExpiredError and transitions status to CANCELLED', () => {
    const psm = new PriorityStateMachine({ sessionId, players: [p1, p2], activePlayerId: p1 });
    const chat = new DualChannelChat({ sessionId, myPlayerId: p1, priorityStateMachine: psm });

    const proposal = chat.submitTurnCommand('pass');
    assert.ok(chat.getActiveProposal());

    // Force expiration
    proposal.expiresAt = Date.now() - 5000;

    assert.throws(() => {
      chat.confirmProposal(proposal.id);
    }, (err) => {
      return err instanceof ProposalExpiredError &&
             err.details.proposalId === proposal.id;
    });

    // Verify active proposal cleared and status marked CANCELLED
    assert.strictEqual(chat.getActiveProposal(), null);
    assert.strictEqual(proposal.status, 'CANCELLED');
    assert.strictEqual(chat.proposalHistory[chat.proposalHistory.length - 1].id, proposal.id);
  });

  // -------------------------------------------------------------------------
  // TEST 16: Edge Case - Priority Stolen/Passed Prior to Confirmation
  // -------------------------------------------------------------------------
  test('Test 16: Confirming a proposal after priority was stolen or passed throws PriorityGatedChatError', () => {
    const psm = new PriorityStateMachine({ sessionId, players: [p1, p2], activePlayerId: p1 });
    const chat = new DualChannelChat({ sessionId, myPlayerId: p1, priorityStateMachine: psm });

    // p1 holds priority and stages an action
    const proposal = chat.submitTurnCommand('pass');
    assert.strictEqual(chat.getActiveProposal().id, proposal.id);

    // Turn priority passes or is stolen by p2 before confirmation tap
    psm.dispatch('PASS_PRIORITY', { playerId: p1 });
    assert.strictEqual(psm.getPriorityPlayerId(), p2);

    // p1 attempts to confirm after priority is gone
    assert.throws(() => {
      chat.confirmProposal(proposal.id);
    }, (err) => {
      return err instanceof PriorityGatedChatError &&
             err.details.attemptedPlayerId === p1 &&
             err.details.priorityPlayerId === p2;
    });
  });

  // -------------------------------------------------------------------------
  // TEST 17: Edge Case - Speech Service Live Binding & Priority Lock Gating
  // -------------------------------------------------------------------------
  test('Test 17: Speech recognition service live binding streams interim results and submits on final with voice metadata', () => {
    const psm = new PriorityStateMachine({ sessionId, players: [p1, p2], activePlayerId: p1 });
    const chat = new DualChannelChat({ sessionId, myPlayerId: p1, priorityStateMachine: psm });

    let interimStreamed = '';
    const mockSpeech = {
      onInterim: (text) => { interimStreamed = text; },
      onFinal: null
    };

    chat.attachSpeechService(mockSpeech);

    // Interim streaming
    mockSpeech.onInterim('tiro bolt a ragavan');
    assert.strictEqual(interimStreamed, 'tiro bolt a ragavan');

    // Final speech completion generates staged proposal
    mockSpeech.onFinal('tiro bolt a ragavan');
    const proposal = chat.getActiveProposal();
    assert.ok(proposal);
    assert.strictEqual(proposal.actionType, 'CAST_SPELL');
    assert.strictEqual(proposal.metadata?.isVoiceDictated, true);

    // When priority is lost, speech final does not stage proposals
    chat.cancelProposal(proposal.id);
    psm.dispatch('PASS_PRIORITY', { playerId: p1 }); // priority passes to p2
    assert.strictEqual(chat.isInputLocked(), true);

    mockSpeech.onFinal('pass');
    assert.strictEqual(chat.getActiveProposal(), null, 'Proposal should not be created when input is locked');
  });

  console.log(`\nAll ${passedTests} acceptance tests passed successfully! ✨\n`);
}

runSuite();
