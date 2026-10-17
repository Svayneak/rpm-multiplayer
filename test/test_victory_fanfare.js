/**
 * Acceptance Test Suite for Feature 11: User Profile & Victory Fanfare Audio Player
 * Document ID: SPEC-RPM-FANFARE-011
 * Decisions: DEC-013, DEC-014, DEC-015
 * Audio References: Audio Notes 2, 4, 5, 7
 * 
 * Formal Acceptance Test Matrix:
 * - TC-FANFARE-01: Standard 1v1 FIDE Elo Symmetry (DEC-013, FIDE)
 * - TC-FANFARE-02: Asymmetric 1v1 Elo Upset Calculation (DEC-013, FIDE)
 * - TC-FANFARE-03: Multi-Player FFA Zero-Sum Conservation (INV-AUDIO-5)
 * - TC-FANFARE-04: 6-Player Pod Pairwise Elo Scaling (INV-AUDIO-5)
 * - TC-FANFARE-05: Deck Slot Milestone Progression by Wins (INV-AUDIO-6, Audio Note 5)
 * - TC-FANFARE-06: Deck Slot Milestone Progression by Perks (INV-AUDIO-6, Audio Note 5)
 * - TC-FANFARE-07: Monotonic Anti-Regression Law (INV-AUDIO-6)
 * - TC-FANFARE-08: Single-Match Perk High Watermark (Audio Note 4)
 * - TC-FANFARE-09: Bounded 50-Match Ring Buffer & 16KB Storage (INV-AUDIO-7)
 * - TC-FANFARE-10: Instagram A-to-B Duration Window Validation (INV-AUDIO-4, DEC-013)
 * - TC-FANFARE-11: YouTube Video ID Extraction Engine (DEC-014)
 * - TC-FANFARE-12: Browser Autoplay Priming & Suspended State Fallback (INV-AUDIO-1)
 * - TC-FANFARE-13: Autonomous 8-Bit Chiptune Retro Arpeggio (INV-AUDIO-2)
 * - TC-FANFARE-14: 1500ms Fallback Watchdog on Network Failure (INV-AUDIO-2)
 * - TC-FANFARE-15: Drift-Resilient Hardware-Accurate Stop (INV-AUDIO-3)
 * - TC-FANFARE-16: Profile Storage Headless & Isomorphic Fallback (INV-STORAGE-1, INV-AUDIO-7)
 */

import assert from 'node:assert/strict';
import {
  ProfileManager,
  UserProfileManager,
  EloCalculator,
  ChiptuneSynthesizer,
  VictoryFanfareEngine,
  VictoryFanfare,
  AudioEngine,
  validateFanfareConfig,
  parseYouTubeVideoId,
  parseYouTubeId,
  evaluateDeckSlots,
  primeAudio,
  renderFallbackBanner,
  createDefaultProfile,
  createDefaultFanfareConfig,
  calculatePayloadBytes,
  DECK_SLOT_MILESTONES,
  CHIPTUNE_NOTES,
  DEFAULT_PROFILE_ELO,
  DEFAULT_K_FACTOR,
  MAX_MATCH_HISTORY_LENGTH,
  MAX_PAYLOAD_BYTES,
  MIN_FANFARE_DURATION,
  MAX_FANFARE_DURATION,
  DEFAULT_WATCHDOG_TIMEOUT_MS
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

// =============================================================================
// Test Fixtures & Mocks
// =============================================================================

function createMockAudioContext(initialState = 'running') {
  let currentTime = 100.0;
  const createdOscillators = [];
  const createdGains = [];
  let bufferSourceCreated = null;

  const mockCtx = {
    state: initialState,
    get currentTime() {
      return currentTime;
    },
    set currentTime(val) {
      currentTime = val;
    },
    destination: { id: 'hardware_dac_destination' },
    resume: async () => {
      mockCtx.state = 'running';
    },
    createBuffer: (channels, length, sampleRate) => {
      return { channels, length, sampleRate, data: new Float32Array(length) };
    },
    createBufferSource: () => {
      const source = {
        buffer: null,
        connect: (dest) => { source.connectedTo = dest; },
        start: (when) => { source.startedAt = when; },
        stop: (when) => { source.stoppedAt = when; }
      };
      bufferSourceCreated = source;
      return source;
    },
    createGain: () => {
      const gainNode = {
        gain: {
          value: 1.0,
          setValueAtTime: (val, time) => { gainNode.gain.setValueCalls.push({ val, time }); },
          linearRampToValueAtTime: (val, time) => { gainNode.gain.linearRampCalls.push({ val, time }); },
          exponentialRampToValueAtTime: (val, time) => { gainNode.gain.exponentialRampCalls.push({ val, time }); },
          setValueCalls: [],
          linearRampCalls: [],
          exponentialRampCalls: []
        },
        connect: (dest) => { gainNode.connectedTo = dest; },
        disconnect: () => { gainNode.disconnected = true; }
      };
      createdGains.push(gainNode);
      return gainNode;
    },
    createOscillator: () => {
      const osc = {
        type: 'sine',
        frequency: {
          value: 440,
          setValueAtTime: (val, time) => { osc.frequency.setValueCalls.push({ val, time }); },
          setValueCalls: []
        },
        connect: (dest) => { osc.connectedTo = dest; },
        start: (when) => { osc.startCalls.push(when); },
        stop: (when) => { osc.stopCalls.push(when); },
        startCalls: [],
        stopCalls: []
      };
      createdOscillators.push(osc);
      return osc;
    },
    close: async () => {
      mockCtx.state = 'closed';
    },
    _getCreatedOscillators: () => createdOscillators,
    _getCreatedGains: () => createdGains,
    _getBufferSource: () => bufferSourceCreated
  };

  return mockCtx;
}

function createMockDOM() {
  const elements = [];
  const container = {
    children: [],
    appendChild: (child) => {
      container.children.push(child);
      child.parentNode = container;
      return child;
    }
  };

  function createElement(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      children: [],
      onclick: null,
      parentNode: null,
      appendChild: (child) => {
        el.children.push(child);
        child.parentNode = el;
        return child;
      },
      remove: () => {
        if (el.parentNode && el.parentNode.children) {
          const idx = el.parentNode.children.indexOf(el);
          if (idx !== -1) el.parentNode.children.splice(idx, 1);
        }
      }
    };
    elements.push(el);
    return el;
  }

  return { container, createElement, elements };
}

// =============================================================================
// Test Suite Execution
// =============================================================================

console.log('=== RUNNING FEATURE 11: USER PROFILE & VICTORY FANFARE ACCEPTANCE TEST SUITE (SPEC-RPM-FANFARE-011) ===\n');

// -----------------------------------------------------------------------------
// TC-FANFARE-01: Standard 1v1 FIDE Elo Symmetry (DEC-013, FIDE)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-01: Standard 1v1 FIDE Elo Symmetry (DEC-013, FIDE)', () => {
  const pA = { id: 'player_A', currentElo: 1200 };
  const pB = { id: 'player_B', currentElo: 1200 };

  // Player A wins (outcomeA = 1.0), K = 32
  const results = EloCalculator.calculate1v1(pA, pB, 1.0, 32);

  assert.strictEqual(results.length, 2);
  const [resA, resB] = results;

  assert.strictEqual(resA.deltaElo, 16, 'Player A delta should be +16');
  assert.strictEqual(resA.postElo, 1216, 'Player A post-Elo should be 1216');
  assert.strictEqual(resB.deltaElo, -16, 'Player B delta should be -16');
  assert.strictEqual(resB.postElo, 1184, 'Player B post-Elo should be 1184');

  // Strict Zero-Sum Conservation
  assert.strictEqual(resA.deltaElo + resB.deltaElo, 0, 'Net Elo delta sum must be exactly 0');
});

// -----------------------------------------------------------------------------
// TC-FANFARE-02: Asymmetric 1v1 Elo Upset Calculation (DEC-013, FIDE)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-02: Asymmetric 1v1 Elo Upset Calculation (DEC-013, FIDE)', () => {
  const pA = { id: 'player_underdog', currentElo: 1000 };
  const pB = { id: 'player_favorite', currentElo: 1400 };

  // Underdog A (1000) defeats Favorite B (1400) with K = 32
  const results = EloCalculator.calculate1v1(pA, pB, 1.0, 32);
  const [resA, resB] = results;

  // Expected score EA = 1 / (1 + 10^((1400 - 1000) / 400)) = 1 / 11 ~= 0.090909
  assert.ok(Math.abs(resA.expectedScore - (1 / 11)) < 0.001, 'Expected score EA should be approx 1/11');

  // Delta EA = round(32 * (1 - 1/11)) = round(29.0909) = +29
  assert.strictEqual(resA.deltaElo, 29, 'Underdog delta should be +29');
  assert.strictEqual(resA.postElo, 1029, 'Underdog post-Elo should be 1029');
  assert.strictEqual(resB.deltaElo, -29, 'Favorite delta should be -29');
  assert.strictEqual(resB.postElo, 1371, 'Favorite post-Elo should be 1371');

  // Zero-Sum
  assert.strictEqual(resA.deltaElo + resB.deltaElo, 0, 'Zero-sum maintained in upset');
});

// -----------------------------------------------------------------------------
// TC-FANFARE-03: Multi-Player FFA Zero-Sum Conservation (INV-AUDIO-5)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-03: Multi-Player FFA Zero-Sum Conservation (INV-AUDIO-5)', () => {
  const participants = [
    { id: 'p1', currentElo: 1200, rank: 1, username: 'Winner' },
    { id: 'p2', currentElo: 1250, rank: 2, username: 'RunnerUp' },
    { id: 'p3', currentElo: 1150, rank: 3, username: 'Third' },
    { id: 'p4', currentElo: 1300, rank: 4, username: 'Last' }
  ];

  const results = EloCalculator.calculateMultiplayer(participants, 32);
  assert.strictEqual(results.length, 4);

  const sumDeltas = results.reduce((acc, r) => acc + r.deltaElo, 0);
  assert.strictEqual(sumDeltas, 0, 'Multi-player delta sum must be exactly 0 (INV-AUDIO-5)');

  const winner = results.find(r => r.playerId === 'p1');
  const fourth = results.find(r => r.playerId === 'p4');

  assert.ok(winner.deltaElo > 0, `Winner delta (${winner.deltaElo}) must be positive`);
  assert.ok(fourth.deltaElo < 0, `4th place delta (${fourth.deltaElo}) must be negative`);
});

// -----------------------------------------------------------------------------
// TC-FANFARE-04: 6-Player Pod Pairwise Elo Scaling (INV-AUDIO-5)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-04: 6-Player Pod Pairwise Elo Scaling (INV-AUDIO-5)', () => {
  const participants = [
    { id: 'seat1', currentElo: 1200, rank: 1 },
    { id: 'seat2', currentElo: 1200, rank: 2 },
    { id: 'seat3', currentElo: 1200, rank: 3 },
    { id: 'seat4', currentElo: 1200, rank: 4 },
    { id: 'seat5', currentElo: 1200, rank: 5 },
    { id: 'seat6', currentElo: 1200, rank: 6 }
  ];

  const results = EloCalculator.calculateMultiplayer(participants, 32);
  assert.strictEqual(results.length, 6);

  const sumDeltas = results.reduce((acc, r) => acc + r.deltaElo, 0);
  assert.strictEqual(sumDeltas, 0, '6-player pod delta sum must be strictly 0');

  // Verify bounded swing: max rating swing <= K (32)
  for (const r of results) {
    assert.ok(Math.abs(r.deltaElo) <= 32, `Delta (${r.deltaElo}) must be <= K (32)`);
  }
});

// -----------------------------------------------------------------------------
// TC-FANFARE-05: Deck Slot Milestone Progression by Wins (INV-AUDIO-6, Audio Note 5)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-05: Deck Slot Milestone Progression by Wins (INV-AUDIO-6, Audio Note 5)', () => {
  // 0 wins -> 1 slot
  const p0 = evaluateDeckSlots(0, 0, 1);
  assert.strictEqual(p0.currentSlots, 1);
  assert.strictEqual(p0.unlockedJustNow, false);

  // 5 wins -> 2 slots
  const p5 = evaluateDeckSlots(5, 0, 1);
  assert.strictEqual(p5.currentSlots, 2);
  assert.strictEqual(p5.unlockedJustNow, true);
  assert.strictEqual(p5.unlockedTitle, 'Journeyman Slot');

  // 15 wins -> 3 slots
  const p15 = evaluateDeckSlots(15, 0, 2);
  assert.strictEqual(p15.currentSlots, 3);
  assert.strictEqual(p15.unlockedJustNow, true);
  assert.strictEqual(p15.unlockedTitle, 'Adept Slot');

  // 30 wins -> 4 slots
  const p30 = evaluateDeckSlots(30, 0, 3);
  assert.strictEqual(p30.currentSlots, 4);
  assert.strictEqual(p30.unlockedJustNow, true);
  assert.strictEqual(p30.unlockedTitle, 'Veteran Slot');

  // 50 wins -> 5 slots (maxed)
  const p50 = evaluateDeckSlots(50, 0, 4);
  assert.strictEqual(p50.currentSlots, 5);
  assert.strictEqual(p50.unlockedJustNow, true);
  assert.strictEqual(p50.unlockedTitle, 'Grandmaster Slot');
  assert.strictEqual(p50.nextSlot, null);
});

// -----------------------------------------------------------------------------
// TC-FANFARE-06: Deck Slot Milestone Progression by Perks (INV-AUDIO-6, Audio Note 5)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-06: Deck Slot Milestone Progression by Perks (INV-AUDIO-6, Audio Note 5)', () => {
  // 0 wins, accumulating perks independently
  const p10 = evaluateDeckSlots(0, 10, 1);
  assert.strictEqual(p10.currentSlots, 2, '10 perks should unlock slot 2');

  const p25 = evaluateDeckSlots(0, 25, 2);
  assert.strictEqual(p25.currentSlots, 3, '25 perks should unlock slot 3');

  const p50 = evaluateDeckSlots(0, 50, 3);
  assert.strictEqual(p50.currentSlots, 4, '50 perks should unlock slot 4');

  const p100 = evaluateDeckSlots(0, 100, 4);
  assert.strictEqual(p100.currentSlots, 5, '100 perks should unlock slot 5');
});

// -----------------------------------------------------------------------------
// TC-FANFARE-07: Monotonic Anti-Regression Law (INV-AUDIO-6)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-07: Monotonic Anti-Regression Law (INV-AUDIO-6)', () => {
  const pm = new ProfileManager();
  const userId = 'veteran_player';

  // Seed profile with 3 unlocked slots
  const profile = pm.getProfile(userId);
  profile.unlockedDeckSlots = 3;
  profile.wins = 15;
  pm.saveProfile(profile);

  // Suffer 10 consecutive match losses
  for (let i = 0; i < 10; i++) {
    pm.recordMatch(userId, {
      placement: 2,
      isWinner: false,
      deltaElo: -16
    });
  }

  const updatedProfile = pm.getProfile(userId);
  assert.strictEqual(
    updatedProfile.unlockedDeckSlots,
    3,
    'Unlocked deck slots must NEVER regress on match losses (INV-AUDIO-6)'
  );

  // Even after full stats reset, slots remain permanently unlocked!
  pm.resetStats(userId);
  const resetProfile = pm.getProfile(userId);
  assert.strictEqual(
    resetProfile.unlockedDeckSlots,
    3,
    'Unlocked deck slots must NEVER regress even on stat reset (INV-AUDIO-6)'
  );
  assert.strictEqual(resetProfile.wins, 0);
  assert.strictEqual(resetProfile.losses, 0);
});

// -----------------------------------------------------------------------------
// TC-FANFARE-08: Single-Match Perk High Watermark (Audio Note 4)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-08: Single-Match Perk High Watermark (Audio Note 4)', () => {
  const pm = new ProfileManager();
  const userId = 'perk_master';

  // Game 1: 3 perks
  pm.recordMatch(userId, { perksTriggered: 3, placement: 1 });
  let p = pm.getProfile(userId);
  assert.strictEqual(p.totalPerksTriggered, 3);
  assert.strictEqual(p.maxPerksSingleGame, 3);

  // Game 2: 8 perks (new high watermark)
  pm.recordMatch(userId, { perksTriggered: 8, placement: 1 });
  p = pm.getProfile(userId);
  assert.strictEqual(p.totalPerksTriggered, 11);
  assert.strictEqual(p.maxPerksSingleGame, 8);

  // Game 3: 4 perks (below high watermark)
  pm.recordMatch(userId, { perksTriggered: 4, placement: 2 });
  p = pm.getProfile(userId);
  assert.strictEqual(p.totalPerksTriggered, 15, 'Lifetime total perks must equal 15');
  assert.strictEqual(p.maxPerksSingleGame, 8, 'High watermark must remain 8');
});

// -----------------------------------------------------------------------------
// TC-FANFARE-09: Bounded 50-Match Ring Buffer & 16KB Storage (INV-AUDIO-7)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-09: Bounded 50-Match Ring Buffer & 16KB Storage (INV-AUDIO-7)', () => {
  const pm = new ProfileManager();
  const userId = 'ring_buffer_user';

  // Simulate 75 match completions
  for (let i = 1; i <= 75; i++) {
    pm.recordMatch(userId, {
      matchId: `match_seq_${i}`,
      placement: i % 2 === 0 ? 1 : 2,
      deltaElo: i % 2 === 0 ? 16 : -16,
      perksTriggered: i % 5,
      opponents: [{ id: `opp_${i}`, username: `Opponent ${i}`, deltaElo: -16 }]
    });
  }

  const profile = pm.getProfile(userId);

  // 1. Strictly capped at 50 matches (oldest 25 evicted FIFO)
  assert.strictEqual(profile.matchHistory.length, 50, 'Match history must be capped at 50');
  assert.strictEqual(
    profile.matchHistory[0].matchId,
    'match_seq_26',
    'Oldest preserved match must be match #26'
  );
  assert.strictEqual(
    profile.matchHistory[49].matchId,
    'match_seq_75',
    'Newest match must be match #75'
  );

  // 2. Serialized payload size <= 16,384 bytes
  const bytes = calculatePayloadBytes(profile);
  assert.ok(
    bytes <= 16384,
    `Profile payload size (${bytes} bytes) must not exceed 16KB limit (INV-AUDIO-7)`
  );
});

// -----------------------------------------------------------------------------
// TC-FANFARE-10: Instagram A-to-B Duration Window Validation (INV-AUDIO-4, DEC-013)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-10: Instagram A-to-B Duration Window Validation (INV-AUDIO-4, DEC-013)', () => {
  // a) Too short (5.0s) -> clamped to 8.0s in clamping mode, throws error in strict mode
  const clampedShort = validateFanfareConfig({ startSeconds: 0, endSeconds: 5.0 });
  assert.strictEqual(clampedShort.duration, 8.0, 'Duration 5s should clamp to 8.0s');
  assert.strictEqual(clampedShort.endSeconds, 8.0);
  assert.throws(() => {
    validateFanfareConfig({ startSeconds: 0, endSeconds: 5.0 }, { clamp: false });
  }, /INV-AUDIO-4 Violation/);

  // b) Valid (10.0s) -> accepted as 10.0s
  const valid = validateFanfareConfig({ startSeconds: 2.0, endSeconds: 12.0 });
  assert.strictEqual(valid.duration, 10.0);
  assert.strictEqual(valid.startSeconds, 2.0);
  assert.strictEqual(valid.endSeconds, 12.0);

  // c) Too long (15.0s) -> clamped to 12.0s in clamping mode, throws error in strict mode
  const clampedLong = validateFanfareConfig({ startSeconds: 0, endSeconds: 15.0 });
  assert.strictEqual(clampedLong.duration, 12.0, 'Duration 15s should clamp to 12.0s');
  assert.strictEqual(clampedLong.endSeconds, 12.0);
  assert.throws(() => {
    validateFanfareConfig({ startSeconds: 0, endSeconds: 15.0 }, { clamp: false });
  }, /INV-AUDIO-4 Violation/);

  // d) Negative start -> throws validation error
  assert.throws(() => {
    validateFanfareConfig({ startSeconds: -1.0, endSeconds: 9.0 });
  }, /startSeconds.*must be >= 0/);

  // e) endSeconds <= startSeconds -> throws validation error
  assert.throws(() => {
    validateFanfareConfig({ startSeconds: 5.0, endSeconds: 5.0 });
  }, /endSeconds.*must be greater than startSeconds/);
});

// -----------------------------------------------------------------------------
// TC-FANFARE-11: YouTube Video ID Extraction Engine (DEC-014)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-11: YouTube Video ID Extraction Engine (DEC-014)', () => {
  const expectedId = 'dQw4w9WgXcQ';

  // 1. Standard watch URL
  assert.strictEqual(
    parseYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    expectedId
  );
  // 1b. Watch URL with additional query params
  assert.strictEqual(
    parseYouTubeVideoId('https://www.youtube.com/watch?feature=shared&v=dQw4w9WgXcQ&t=42s'),
    expectedId
  );

  // 2. youtu.be short link
  assert.strictEqual(
    parseYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ'),
    expectedId
  );

  // 3. Embed link
  assert.strictEqual(
    parseYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'),
    expectedId
  );

  // 4. Shorts link
  assert.strictEqual(
    parseYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'),
    expectedId
  );

  // 5. Raw 11-char ID
  assert.strictEqual(
    parseYouTubeVideoId('dQw4w9WgXcQ'),
    expectedId
  );

  // 6. Malformed strings throw descriptive Error
  assert.throws(() => {
    parseYouTubeVideoId('https://vimeo.com/123456');
  }, /Invalid YouTube URL/);

  assert.throws(() => {
    parseYouTubeVideoId('javascript:alert(1)');
  }, /Invalid YouTube URL/);

  assert.throws(() => {
    parseYouTubeVideoId('');
  }, /empty/);
});

// -----------------------------------------------------------------------------
// TC-FANFARE-12: Browser Autoplay Priming & Suspended State Fallback (INV-AUDIO-1)
// -----------------------------------------------------------------------------
await runAsyncTest('TC-FANFARE-12: Browser Autoplay Priming & Suspended State Fallback (INV-AUDIO-1)', async () => {
  const mockCtx = createMockAudioContext('suspended');
  const mockDOM = createMockDOM();

  // Temporarily set global document for banner creation
  const originalDoc = globalThis.document;
  globalThis.document = {
    createElement: mockDOM.createElement
  };

  try {
    const engine = new VictoryFanfareEngine({
      audioContext: mockCtx,
      container: mockDOM.container
    });

    let blockedCallbackFired = false;
    let resumeFn = null;

    const result = await engine.playFanfare(
      { sourceType: 'CHIPTUNE' },
      ({ reason, resumeAndPlay, banner }) => {
        blockedCallbackFired = true;
        resumeFn = resumeAndPlay;
        assert.strictEqual(reason, 'AUTOPLAY_BLOCKED');
        assert.ok(banner, 'Fallback banner element must be provided');
      }
    );

    assert.strictEqual(blockedCallbackFired, true, 'onBlockedCallback must be invoked when suspended');
    assert.strictEqual(result.blocked, true);

    // Verify 1-tap fallback banner is surfaced in DOM
    const banner = mockDOM.container.children.find(c => c.id === 'rpm-fanfare-fallback-banner');
    assert.ok(banner, 'Fallback banner must be attached to container');
    const button = banner.children.find(b => b.id === 'rpm-fanfare-trigger-btn');
    assert.ok(button, 'Banner button must exist');
    assert.strictEqual(button.textContent, '🏆 VICTORY! Tap to Play Fanfare 🎵');

    // Simulate 1-tap user gesture (primeAudio + button click)
    primeAudio(mockCtx);
    assert.strictEqual(mockCtx.state, 'running', 'primeAudio must resume AudioContext');
    assert.ok(mockCtx._getBufferSource(), 'primeAudio must start 1-sample silent buffer');

    // Resuming and playing works cleanly
    const playResult = await resumeFn();
    assert.ok(playResult, 'Fanfare starts on resume');

    engine.destroy();
  } finally {
    globalThis.document = originalDoc;
  }
});

// -----------------------------------------------------------------------------
// TC-FANFARE-13: Autonomous 8-Bit Chiptune Retro Arpeggio (INV-AUDIO-2)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-13: Autonomous 8-Bit Chiptune Retro Arpeggio (INV-AUDIO-2)', () => {
  const mockCtx = createMockAudioContext('running');
  const synth = new ChiptuneSynthesizer(mockCtx);

  const session = synth.playFanfare(0.8);
  assert.ok(session, 'Fanfare session created');

  const oscillators = session.activeOscillators;
  assert.strictEqual(oscillators.length, 4, 'Must generate exactly 4 sequential oscillators');

  const expectedNotes = [
    { freq: 261.63, pitch: 'C4' },
    { freq: 329.63, pitch: 'E4' },
    { freq: 392.00, pitch: 'G4' },
    { freq: 523.25, pitch: 'C5' }
  ];

  for (let i = 0; i < 4; i++) {
    const osc = oscillators[i];
    const exp = expectedNotes[i];
    assert.strictEqual(osc.type, 'square', `Oscillator ${i} must be square wave`);
    assert.strictEqual(osc._freq, exp.freq, `Oscillator ${i} frequency must match ${exp.freq} (${exp.pitch})`);
    assert.strictEqual(osc._pitch, exp.pitch);
    assert.strictEqual(osc.startCalls.length, 1, `Oscillator ${i} start scheduled`);
    assert.strictEqual(osc.stopCalls.length, 1, `Oscillator ${i} stop scheduled`);
  }

  synth.destroy();
});

// -----------------------------------------------------------------------------
// TC-FANFARE-14: 1500ms Fallback Watchdog on Network Failure (INV-AUDIO-2)
// -----------------------------------------------------------------------------
await runAsyncTest('TC-FANFARE-14: 1500ms Fallback Watchdog on Network Failure (INV-AUDIO-2)', async () => {
  const mockCtx = createMockAudioContext('running');
  const engine = new VictoryFanfareEngine({
    audioContext: mockCtx,
    watchdogTimeoutMs: 1500
  });

  let watchdogFired = false;
  engine._onFallbackTriggered = (reason) => {
    if (reason === 'WATCHDOG_TIMEOUT') {
      watchdogFired = true;
    }
  };

  const startTime = Date.now();

  // Play YouTube fanfare without active browser network
  await engine.playFanfare({
    sourceType: 'YOUTUBE',
    uri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    startSeconds: 0,
    endSeconds: 10,
    volume: 0.8
  });

  assert.strictEqual(engine.activeSession.type, 'YOUTUBE');

  // Wait for 1500ms watchdog
  await new Promise(resolve => setTimeout(resolve, 1550));

  const elapsed = Date.now() - startTime;
  assert.ok(elapsed >= 1500, `Watchdog wait time (${elapsed}ms) must be >= 1500ms`);
  assert.strictEqual(watchdogFired, true, 'Watchdog must trigger fallback to chiptune after 1500ms timeout');
  assert.strictEqual(engine.activeSession.type, 'CHIPTUNE', 'Active session must transition to CHIPTUNE');

  engine.destroy();
});

// -----------------------------------------------------------------------------
// TC-FANFARE-15: Drift-Resilient Hardware-Accurate Stop (INV-AUDIO-3)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-15: Drift-Resilient Hardware-Accurate Stop (INV-AUDIO-3)', () => {
  const mockCtx = createMockAudioContext('running');
  mockCtx.currentTime = 50.0; // Simulated hardware audio clock

  const synth = new ChiptuneSynthesizer(mockCtx);
  const session = synth.playFanfare(0.8);

  const oscillators = session.activeOscillators;
  assert.strictEqual(oscillators.length, 4);

  // Verify hardware DSP stop timestamps: stop(audioCtx.currentTime + noteStart + duration)
  // C4: 50.0 + 0.00 + 0.18 = 50.18
  assert.strictEqual(oscillators[0].stopCalls[0], 50.18);
  // E4: 50.0 + 0.18 + 0.18 = 50.36
  assert.strictEqual(oscillators[1].stopCalls[0], 50.36);
  // G4: 50.0 + 0.36 + 0.18 = 50.54
  assert.strictEqual(oscillators[2].stopCalls[0], 50.54);
  // C5: 50.0 + 0.54 + 1.46 = 52.00
  assert.strictEqual(oscillators[3].stopCalls[0], 52.00);

  synth.destroy();
});

// -----------------------------------------------------------------------------
// TC-FANFARE-16: Profile Storage Headless & Isomorphic Fallback (INV-STORAGE-1, INV-AUDIO-7)
// -----------------------------------------------------------------------------
runTest('TC-FANFARE-16: Profile Storage Headless & Isomorphic Fallback (INV-STORAGE-1, INV-AUDIO-7)', () => {
  // Confirm headless environment: window is undefined
  assert.strictEqual(typeof window, 'undefined', 'Test runner must be headless Node.js');

  const pm = new ProfileManager();
  const userId = 'headless_user_1';

  // Retrieve fresh default profile
  const p1 = pm.getProfile(userId);
  assert.strictEqual(p1.userId, userId);
  assert.strictEqual(p1.elo, 1200);
  assert.strictEqual(p1.unlockedDeckSlots, 1);
  assert.strictEqual(p1.fanfareConfig.sourceType, 'CHIPTUNE');

  // Modify and save
  p1.elo = 1350;
  p1.wins = 12;
  p1.fanfareConfig = validateFanfareConfig({
    sourceType: 'CHIPTUNE',
    startSeconds: 0,
    endSeconds: 10,
    volume: 0.9,
    label: 'Custom Chiptune Track'
  });

  pm.saveProfile(p1);

  // Roundtrip verification from in-memory fallback
  const loaded = pm.getProfile(userId);
  assert.strictEqual(loaded.elo, 1350);
  assert.strictEqual(loaded.wins, 12);
  assert.strictEqual(loaded.fanfareConfig.volume, 0.9);
  assert.strictEqual(loaded.fanfareConfig.label, 'Custom Chiptune Track');
});

// =============================================================================
// Suite Summary & Exit Reporting
// =============================================================================

console.log('\n==================================================================');
console.log(`ACCEPTANCE TEST RESULTS: ${passed} passed, ${failed} failed`);
console.log('==================================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
