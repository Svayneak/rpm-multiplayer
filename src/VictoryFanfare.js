/**
 * VictoryFanfare.js - User Profile, Multiplayer Elo Engine & Victory Fanfare Audio Player
 * 
 * Subsystem for RPM Modern Tabletop Companion.
 * 
 * Enforces Architectural Invariants:
 * - INV-AUDIO-1: Browser Autoplay Policy & Interaction Priming
 * - INV-AUDIO-2: 1500ms Watchdog & Autonomous 8-Bit Chiptune Fallback
 * - INV-AUDIO-3: Drift-Resilient Hardware-Accurate Stop
 * - INV-AUDIO-4: 8-12s Instagram-Style A-to-B Window
 * - INV-AUDIO-5: Zero-Sum Multi-Player Elo Conservation (2 to 6 players)
 * - INV-AUDIO-6: Monotonic Milestone Deck Slot Progression & Anti-Regression
 * - INV-AUDIO-7: Bounded 50-Match History Ring Buffer & 16KB Storage Guard
 * - INV-HARNESS-2: Clean Process Teardown & Zero Lingering Timers
 * 
 * Specifications: SPEC-RPM-FANFARE-011, DEC-013, DEC-014, DEC-015
 * Audio References: Audio Notes 2, 4, 5, 7
 * 
 * @module VictoryFanfare
 */

// =============================================================================
// Constants & Milestone Tables
// =============================================================================

export const DEFAULT_PROFILE_ELO = 1200;
export const DEFAULT_K_FACTOR = 32;
export const MAX_MATCH_HISTORY_LENGTH = 50;
export const MAX_PAYLOAD_BYTES = 16384;
export const MIN_FANFARE_DURATION = 8.0;
export const MAX_FANFARE_DURATION = 12.0;
export const DEFAULT_WATCHDOG_TIMEOUT_MS = 1500;

/**
 * Deck slot progression milestone requirements (Audio Note 5, INV-AUDIO-6).
 */
export const DECK_SLOT_MILESTONES = Object.freeze([
  { slot: 1, minWins: 0, minPerks: 0, title: 'Apprentice Deck' },
  { slot: 2, minWins: 5, minPerks: 10, title: 'Journeyman Slot' },
  { slot: 3, minWins: 15, minPerks: 25, title: 'Adept Slot' },
  { slot: 4, minWins: 30, minPerks: 50, title: 'Veteran Slot' },
  { slot: 5, minWins: 50, minPerks: 100, title: 'Grandmaster Slot' }
]);

/**
 * 4-note ascending retro arpeggio notes (INV-AUDIO-2):
 * C4 (261.63 Hz), E4 (329.63 Hz), G4 (392.00 Hz), C5 (523.25 Hz).
 */
export const CHIPTUNE_NOTES = Object.freeze([
  { freq: 261.63, start: 0.00, duration: 0.18, pitch: 'C4' },
  { freq: 329.63, start: 0.18, duration: 0.18, pitch: 'E4' },
  { freq: 392.00, start: 0.36, duration: 0.18, pitch: 'G4' },
  { freq: 523.25, start: 0.54, duration: 1.46, pitch: 'C5' }
]);

// =============================================================================
// Helper Functions & Quota Guards
// =============================================================================

/**
 * Calculates UTF-8 byte length for data.
 * @param {any} data
 * @returns {number}
 */
export function calculatePayloadBytes(data) {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  if (typeof Buffer !== 'undefined') {
    return Buffer.byteLength(serialized, 'utf8');
  }
  return new TextEncoder().encode(serialized).length;
}

/**
 * Creates a default fanfare audio configuration.
 * @returns {Object}
 */
export function createDefaultFanfareConfig() {
  return {
    sourceType: 'CHIPTUNE',
    uri: '',
    sourceUrl: '',
    videoId: null,
    startSeconds: 0,
    endSeconds: 10,
    duration: 10,
    volume: 0.8,
    label: 'Default 8-Bit Chiptune'
  };
}

/**
 * Creates a default user profile object adhering to SPEC-RPM-FANFARE-011.
 * @param {string} [userId='default_user']
 * @param {string} [username='Planeswalker']
 * @returns {Object}
 */
export function createDefaultProfile(userId = 'default_user', username = 'Planeswalker') {
  const now = Date.now();
  const id = userId || 'default_user';
  return {
    id,
    userId: id,
    username: username || 'Planeswalker',
    elo: DEFAULT_PROFILE_ELO,
    matchesPlayed: 0,
    totalMatches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    totalPerksRolled: 0,
    totalPerksTriggered: 0,
    maxPerksSingleGame: 0,
    unlockedDeckSlots: 1,
    activeDeckId: null,
    activeDeckSlotIndex: 0,
    fanfareConfig: createDefaultFanfareConfig(),
    matchHistory: [],
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Extracts the 11-character YouTube video ID from various URL formats or raw ID.
 * Supports: watch?v=, youtu.be/, embed/, shorts/, v/, or raw 11-char ID.
 * Throws Error if input is malformed or invalid.
 * 
 * @param {string} input
 * @returns {string} 11-character video ID
 */
export function parseYouTubeVideoId(input) {
  if (typeof input !== 'string') {
    throw new Error('Invalid YouTube input: must be a non-empty string');
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Invalid YouTube input: string is empty');
  }

  // 1. Raw 11-character video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  // 2. Full URL patterns
  const match = trimmed.match(
    /(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  if (match && match[1]) {
    return match[1];
  }

  throw new Error(`Invalid YouTube URL or Video ID: ${trimmed}`);
}

/** Alias for parseYouTubeVideoId */
export const parseYouTubeId = parseYouTubeVideoId;

/**
 * Validates and normalizes FanfareConfig adhering to INV-AUDIO-4.
 * Enforces:
 * - 0 <= startSeconds < endSeconds
 * - 8.0 <= duration <= 12.0 seconds
 * If options.clamp is true, clamps duration into [8.0, 12.0]; otherwise throws error.
 * 
 * @param {Object} config
 * @param {Object} [options={ clamp: true }]
 * @returns {Object} Validated & normalized config
 */
export function validateFanfareConfig(config, options = { clamp: true }) {
  if (!config || typeof config !== 'object') {
    throw new Error('FanfareConfig must be a valid object');
  }

  const sourceType = config.sourceType || 'CHIPTUNE';
  if (!['YOUTUBE', 'DIRECT_MP3', 'CHIPTUNE'].includes(sourceType)) {
    throw new Error(`Invalid sourceType: "${sourceType}". Must be 'YOUTUBE', 'DIRECT_MP3', or 'CHIPTUNE'.`);
  }

  const startSeconds = typeof config.startSeconds === 'number' ? config.startSeconds : 0;
  let endSeconds = typeof config.endSeconds === 'number' ? config.endSeconds : (startSeconds + 10);

  if (startSeconds < 0) {
    throw new Error(`INV-AUDIO-4 Violation: startSeconds (${startSeconds}) must be >= 0`);
  }

  if (endSeconds <= startSeconds) {
    throw new Error(`INV-AUDIO-4 Violation: endSeconds (${endSeconds}) must be greater than startSeconds (${startSeconds})`);
  }

  let duration = endSeconds - startSeconds;

  if (options && options.clamp === false) {
    if (duration < MIN_FANFARE_DURATION || duration > MAX_FANFARE_DURATION) {
      throw new Error(
        `INV-AUDIO-4 Violation: Fanfare duration (${duration}s) must be between ${MIN_FANFARE_DURATION} and ${MAX_FANFARE_DURATION} seconds`
      );
    }
  } else {
    // Clamping mode (default)
    if (duration < MIN_FANFARE_DURATION) {
      duration = MIN_FANFARE_DURATION;
      endSeconds = startSeconds + MIN_FANFARE_DURATION;
    } else if (duration > MAX_FANFARE_DURATION) {
      duration = MAX_FANFARE_DURATION;
      endSeconds = startSeconds + MAX_FANFARE_DURATION;
    }
  }

  const uri = config.uri || config.sourceUrl || '';
  let videoId = null;
  if (sourceType === 'YOUTUBE' && uri) {
    videoId = parseYouTubeVideoId(uri);
  } else if (config.videoId) {
    videoId = parseYouTubeVideoId(config.videoId);
  }

  const volume = typeof config.volume === 'number'
    ? Math.max(0, Math.min(1.0, config.volume))
    : 0.8;

  return {
    sourceType,
    uri,
    sourceUrl: uri,
    videoId,
    startSeconds,
    endSeconds,
    duration,
    volume,
    label: config.label || (sourceType === 'CHIPTUNE' ? '8-Bit Retro Chiptune' : 'Custom Fanfare')
  };
}

/**
 * Evaluates deck slot milestones based on lifetime wins and perks (INV-AUDIO-6).
 * Enforces monotonic anti-regression: S(t2) >= S(t1).
 * 
 * @param {number} currentWins
 * @param {number} totalPerks
 * @param {number} [previouslyUnlockedSlots=1]
 * @returns {Object} Progress report
 */
export function evaluateDeckSlots(currentWins, totalPerks, previouslyUnlockedSlots) {
  let earnedSlots = 1;
  for (let i = 1; i < DECK_SLOT_MILESTONES.length; i++) {
    const milestone = DECK_SLOT_MILESTONES[i];
    if (currentWins >= milestone.minWins || totalPerks >= milestone.minPerks) {
      earnedSlots = milestone.slot;
    }
  }

  // If invoked with (wins, perks), return slot integer directly
  if (arguments.length < 3) {
    return earnedSlots;
  }

  const prev = previouslyUnlockedSlots ?? 1;
  // Enforce Monotonic Anti-Regression Law (INV-AUDIO-6)
  const finalSlots = Math.max(prev, earnedSlots);
  const unlockedJustNow = finalSlots > prev;
  const nextMilestone = DECK_SLOT_MILESTONES.find(m => m.slot === finalSlots + 1) || null;

  return {
    currentSlots: finalSlots,
    maxSlots: 5,
    nextSlot: nextMilestone ? nextMilestone.slot : null,
    winsNeeded: nextMilestone ? Math.max(0, nextMilestone.minWins - currentWins) : 0,
    perksNeeded: nextMilestone ? Math.max(0, nextMilestone.minPerks - totalPerks) : 0,
    currentWins,
    currentPerks: totalPerks,
    unlockedJustNow,
    unlockedTitle: unlockedJustNow ? DECK_SLOT_MILESTONES[finalSlots - 1].title : undefined
  };
}

/**
 * Browser Autoplay Priming (INV-AUDIO-1).
 * Resumes AudioContext and plays a 1-sample silent buffer on user gesture.
 * 
 * @param {AudioContext} audioCtx
 */
export function primeAudio(audioCtx) {
  if (!audioCtx) return;

  const unlock = () => {
    try {
      if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
        audioCtx.resume().catch(() => {});
      }
      if (typeof audioCtx.createBuffer === 'function') {
        const buffer = audioCtx.createBuffer(1, 1, 22050);
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        if (audioCtx.destination) {
          source.connect(audioCtx.destination);
        }
        if (source.start) {
          source.start(0);
        }
      }
    } catch (_) {}

    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      ['click', 'touchstart', 'keydown'].forEach(evt =>
        window.removeEventListener(evt, unlock, true)
      );
    }
  };

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    ['click', 'touchstart', 'keydown'].forEach(evt =>
      window.addEventListener(evt, unlock, true)
    );
  } else {
    // If running in test or environment without window event listeners
    unlock();
  }
}

/**
 * Renders the 1-tap fallback banner when browser autoplay is blocked (INV-AUDIO-1).
 * 
 * @param {HTMLElement} container
 * @param {Function} onPlay
 * @returns {HTMLElement} The created banner overlay
 */
export function renderFallbackBanner(container, onPlay) {
  if (typeof document === 'undefined') {
    return null;
  }

  const overlay = document.createElement('div');
  overlay.id = 'rpm-fanfare-fallback-banner';
  overlay.className = 'fanfare-banner-overlay';

  const button = document.createElement('button');
  button.id = 'rpm-fanfare-trigger-btn';
  button.className = 'fanfare-btn';
  button.textContent = '🏆 VICTORY! Tap to Play Fanfare 🎵';

  button.onclick = (e) => {
    if (e && typeof e.stopPropagation === 'function') {
      e.stopPropagation();
    }
    if (typeof onPlay === 'function') {
      try { onPlay(); } catch (_) {}
    }
    if (typeof overlay.remove === 'function') {
      overlay.remove();
    }
  };

  overlay.appendChild(button);
  if (container && typeof container.appendChild === 'function') {
    container.appendChild(overlay);
  }
  return overlay;
}

// =============================================================================
// Elo Rating Engine (FIDE 1v1 & Multi-Player Zero-Sum FFA)
// =============================================================================

export class EloCalculator {
  /**
   * Standard 1v1 FIDE Elo calculation (DEC-013).
   * 
   * @param {Object|number} playerA - Player object or rating number
   * @param {Object|number} playerB - Player object or rating number
   * @param {number|string|boolean} outcomeA - 1.0 (win), 0.5 (draw), 0.0 (loss)
   * @param {number} [K=32] - K-factor
   * @returns {Array<Object>} [resultA, resultB] with .playerA and .playerB properties
   */
  static calculate1v1(playerA, playerB, outcomeA, K = DEFAULT_K_FACTOR) {
    const idA = typeof playerA === 'object' && playerA !== null ? (playerA.id || playerA.playerId || 'PlayerA') : 'PlayerA';
    const idB = typeof playerB === 'object' && playerB !== null ? (playerB.id || playerB.playerId || 'PlayerB') : 'PlayerB';
    const rA = typeof playerA === 'number' ? playerA : (playerA.currentElo ?? playerA.elo ?? DEFAULT_PROFILE_ELO);
    const rB = typeof playerB === 'number' ? playerB : (playerB.currentElo ?? playerB.elo ?? DEFAULT_PROFILE_ELO);

    let sA;
    if (typeof outcomeA === 'number') {
      sA = outcomeA;
    } else if (outcomeA === 'win' || outcomeA === true) {
      sA = 1.0;
    } else if (outcomeA === 'draw') {
      sA = 0.5;
    } else {
      sA = 0.0;
    }
    const sB = 1.0 - sA;

    const eA = 1.0 / (1.0 + Math.pow(10, (rB - rA) / 400.0));
    const eB = 1.0 - eA;

    const deltaA = Math.round(K * (sA - eA));
    const deltaB = -deltaA; // Zero-sum identity

    const resA = {
      playerId: idA,
      id: idA,
      preElo: rA,
      postElo: Math.max(100, rA + deltaA),
      deltaElo: deltaA,
      expectedScore: eA,
      actualScore: sA
    };

    const resB = {
      playerId: idB,
      id: idB,
      preElo: rB,
      postElo: Math.max(100, rB + deltaB),
      deltaElo: deltaB,
      expectedScore: eB,
      actualScore: sB
    };

    const result = [resA, resB];
    result.playerA = resA;
    result.playerB = resB;
    return result;
  }

  /** Alias for calculate1v1 */
  static calculate1v1Elo(playerA, playerB, outcomeA, K = DEFAULT_K_FACTOR) {
    return EloCalculator.calculate1v1(playerA, playerB, outcomeA, K);
  }

  /**
   * Multi-Player Free-for-All (2 to 6 players) Elo calculation (INV-AUDIO-5).
   * Decomposes into virtual pairwise matches normalized by K / (N - 1).
   * Strictly guarantees zero-sum conservation: sum(deltaElo) === 0.
   * 
   * @param {Array<Object>} participants - Array of { id, currentElo/elo, rank, username }
   * @param {number} [K=32] - K-factor
   * @returns {Array<Object>} Array of results
   */
  static calculateMultiplayer(participants, K = DEFAULT_K_FACTOR) {
    if (!Array.isArray(participants) || participants.length < 2 || participants.length > 6) {
      throw new Error(
        `Invalid participant count: ${participants ? participants.length : 0}. Must be between 2 and 6.`
      );
    }

    const N = participants.length;
    if (N === 2) {
      const p0 = participants[0];
      const p1 = participants[1];
      let outcome0 = 0.5;
      if (p0.rank < p1.rank) outcome0 = 1.0;
      else if (p0.rank > p1.rank) outcome0 = 0.0;
      return EloCalculator.calculate1v1(p0, p1, outcome0, K);
    }

    const actualScores = new Map();
    const expectedScores = new Map();
    const rawDeltas = new Map();
    const roundedDeltas = new Map();

    for (let i = 0; i < N; i++) {
      const p = participants[i];
      actualScores.set(p.id, 0);
      expectedScores.set(p.id, 0);
    }

    // Pairwise decomposition
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const pA = participants[i];
        const pB = participants[j];
        const eloA = pA.currentElo ?? pA.elo ?? DEFAULT_PROFILE_ELO;
        const eloB = pB.currentElo ?? pB.elo ?? DEFAULT_PROFILE_ELO;

        let sA, sB;
        if (pA.rank < pB.rank) {
          sA = 1.0;
          sB = 0.0;
        } else if (pA.rank > pB.rank) {
          sA = 0.0;
          sB = 1.0;
        } else {
          sA = 0.5;
          sB = 0.5;
        }

        actualScores.set(pA.id, actualScores.get(pA.id) + sA);
        actualScores.set(pB.id, actualScores.get(pB.id) + sB);

        const eA = 1.0 / (1.0 + Math.pow(10, (eloB - eloA) / 400.0));
        const eB = 1.0 - eA;

        expectedScores.set(pA.id, expectedScores.get(pA.id) + eA);
        expectedScores.set(pB.id, expectedScores.get(pB.id) + eB);
      }
    }

    const scaleFactor = K / (N - 1);
    let totalRoundedSum = 0;

    for (let i = 0; i < N; i++) {
      const p = participants[i];
      const diff = actualScores.get(p.id) - expectedScores.get(p.id);
      const rawDelta = scaleFactor * diff;
      rawDeltas.set(p.id, rawDelta);
      const rounded = Math.round(rawDelta);
      roundedDeltas.set(p.id, rounded);
      totalRoundedSum += rounded;
    }

    // Zero-sum residual absorption (INV-AUDIO-5)
    while (totalRoundedSum !== 0) {
      if (totalRoundedSum > 0) {
        let bestP = participants[0];
        let maxDiff = -Infinity;
        for (let i = 0; i < N; i++) {
          const p = participants[i];
          const diff = roundedDeltas.get(p.id) - rawDeltas.get(p.id);
          if (diff > maxDiff) {
            maxDiff = diff;
            bestP = p;
          }
        }
        roundedDeltas.set(bestP.id, roundedDeltas.get(bestP.id) - 1);
        totalRoundedSum -= 1;
      } else {
        let bestP = participants[0];
        let maxDiff = -Infinity;
        for (let i = 0; i < N; i++) {
          const p = participants[i];
          const diff = rawDeltas.get(p.id) - roundedDeltas.get(p.id);
          if (diff > maxDiff) {
            maxDiff = diff;
            bestP = p;
          }
        }
        roundedDeltas.set(bestP.id, roundedDeltas.get(bestP.id) + 1);
        totalRoundedSum += 1;
      }
    }

    return participants.map(p => {
      const deltaElo = roundedDeltas.get(p.id);
      const preElo = p.currentElo ?? p.elo ?? DEFAULT_PROFILE_ELO;
      const postElo = Math.max(100, preElo + deltaElo);
      return {
        playerId: p.id,
        id: p.id,
        username: p.username || 'Planeswalker',
        preElo,
        postElo,
        deltaElo,
        expectedScore: expectedScores.get(p.id),
        actualScore: actualScores.get(p.id),
        rank: p.rank
      };
    });
  }

  /** Alias for calculateMultiplayer */
  static calculateMultiplayerElo(participants, K = DEFAULT_K_FACTOR) {
    return EloCalculator.calculateMultiplayer(participants, K);
  }
}

// =============================================================================
// Web Audio 8-Bit Chiptune Synthesizer (INV-AUDIO-2, INV-AUDIO-3)
// =============================================================================

export class ChiptuneSynthesizer {
  constructor(audioContext = null) {
    this.ctx = audioContext;
    this.activeOscillators = [];
    this.masterGain = null;
    this._timer = null;
  }

  getAudioContext() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.ctx = new AudioContextClass();
      }
    }
    return this.ctx;
  }

  /**
   * Plays the 4-note victory arpeggio: C4, E4, G4, C5 (INV-AUDIO-2, INV-AUDIO-3).
   * Scheduled with sub-millisecond precision on Web Audio DSP clock.
   * 
   * @param {number} [volume=0.8]
   * @returns {{ stop: () => void, promise: Promise<void>, activeOscillators: Array<any>, notes: Array<any> }}
   */
  playFanfare(volume = 0.8) {
    const ctx = this.getAudioContext();
    if (!ctx) {
      return {
        stop: () => {},
        promise: Promise.resolve(),
        activeOscillators: [],
        notes: CHIPTUNE_NOTES
      };
    }

    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume().catch(() => {});
    }

    const masterGain = typeof ctx.createGain === 'function' ? ctx.createGain() : null;
    const peakVolume = Math.max(0, Math.min(1.0, volume)) * 0.25;
    const t0 = ctx.currentTime || 0;

    if (masterGain && masterGain.gain && typeof masterGain.gain.setValueAtTime === 'function') {
      masterGain.gain.setValueAtTime(peakVolume, t0);
    }
    if (masterGain && typeof masterGain.connect === 'function' && ctx.destination) {
      masterGain.connect(ctx.destination);
    }
    this.masterGain = masterGain;

    const activeOscillators = [];

    CHIPTUNE_NOTES.forEach(note => {
      if (typeof ctx.createOscillator !== 'function') return;

      const osc = ctx.createOscillator();
      const noteGain = typeof ctx.createGain === 'function' ? ctx.createGain() : null;

      osc.type = 'square';
      const noteStart = t0 + note.start;
      const noteEnd = noteStart + note.duration;

      if (osc.frequency && typeof osc.frequency.setValueAtTime === 'function') {
        osc.frequency.setValueAtTime(note.freq, noteStart);
      } else if (osc.frequency) {
        osc.frequency.value = note.freq;
      }

      // Gain Envelope (INV-AUDIO-3)
      if (noteGain && noteGain.gain) {
        if (typeof noteGain.gain.setValueAtTime === 'function') {
          noteGain.gain.setValueAtTime(0.0001, noteStart);
        }
        if (typeof noteGain.gain.linearRampToValueAtTime === 'function') {
          noteGain.gain.linearRampToValueAtTime(1.0, noteStart + 0.02);
        }
        if (typeof noteGain.gain.exponentialRampToValueAtTime === 'function') {
          noteGain.gain.exponentialRampToValueAtTime(0.001, noteEnd);
        }
      }

      if (osc.connect && noteGain) {
        osc.connect(noteGain);
      }
      if (noteGain && noteGain.connect && masterGain) {
        noteGain.connect(masterGain);
      }

      // Hardware-scheduled start and stop (INV-AUDIO-3)
      if (typeof osc.start === 'function') {
        osc.start(noteStart);
      }
      if (typeof osc.stop === 'function') {
        osc.stop(noteEnd);
      }

      osc._freq = note.freq;
      osc._pitch = note.pitch;
      osc._noteStart = noteStart;
      osc._noteEnd = noteEnd;

      activeOscillators.push(osc);
    });

    this.activeOscillators = activeOscillators;

    const stopHardware = () => {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      activeOscillators.forEach(osc => {
        try {
          if (typeof osc.stop === 'function') osc.stop();
        } catch (_) {}
      });
      try {
        if (masterGain && typeof masterGain.disconnect === 'function') {
          masterGain.disconnect();
        }
      } catch (_) {}
      this.activeOscillators = [];
    };

    const completionPromise = new Promise(resolve => {
      this._timer = setTimeout(() => {
        this._timer = null;
        resolve();
      }, 2000);
    });

    return {
      stop: stopHardware,
      promise: completionPromise,
      activeOscillators,
      notes: CHIPTUNE_NOTES
    };
  }

  destroy() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.activeOscillators.forEach(osc => {
      try {
        if (typeof osc.stop === 'function') osc.stop();
      } catch (_) {}
    });
    this.activeOscillators = [];
    try {
      if (this.masterGain && typeof this.masterGain.disconnect === 'function') {
        this.masterGain.disconnect();
      }
    } catch (_) {}
    this.masterGain = null;
    if (this.ctx && typeof this.ctx.close === 'function') {
      try { this.ctx.close(); } catch (_) {}
    }
  }
}

// =============================================================================
// Victory Fanfare Audio Engine
// =============================================================================

export class VictoryFanfareEngine {
  constructor(options = {}) {
    this.audioContext = options.audioContext || null;
    this.chiptuneSynth = options.chiptuneSynth || new ChiptuneSynthesizer(this.audioContext);
    this.watchdogTimeoutMs = options.watchdogTimeoutMs || DEFAULT_WATCHDOG_TIMEOUT_MS;
    this.container = options.container || null;

    this.activeSession = null;
    this._watchdogTimer = null;
    this._htmlAudio = null;
    this._ytPlayer = null;
    this._activeBanner = null;
    this._onFallbackTriggered = null;
  }

  primeAudio(audioCtx) {
    if (audioCtx) {
      this.audioContext = audioCtx;
    }
    primeAudio(this.audioContext);
  }

  validateConfig(config, options) {
    return validateFanfareConfig(config, options);
  }

  parseYouTubeId(urlOrId) {
    return parseYouTubeVideoId(urlOrId);
  }

  playChiptune(volume = 0.8) {
    const session = this.chiptuneSynth.playFanfare(volume);
    this.activeSession = {
      type: 'CHIPTUNE',
      stop: session.stop,
      promise: session.promise
    };
    return session;
  }

  stopFanfare() {
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    if (this.activeSession) {
      if (typeof this.activeSession.stop === 'function') {
        try { this.activeSession.stop(); } catch (_) {}
      }
      this.activeSession = null;
    }
    this.abortExternalStream();
    if (this._activeBanner) {
      try {
        if (typeof this._activeBanner.remove === 'function') {
          this._activeBanner.remove();
        }
      } catch (_) {}
      this._activeBanner = null;
    }
  }

  abortExternalStream() {
    if (this._htmlAudio) {
      try {
        this._htmlAudio.pause();
        this._htmlAudio.src = '';
      } catch (_) {}
      this._htmlAudio = null;
    }
    if (this._ytPlayer) {
      try {
        if (typeof this._ytPlayer.destroy === 'function') {
          this._ytPlayer.destroy();
        } else if (typeof this._ytPlayer.stopVideo === 'function') {
          this._ytPlayer.stopVideo();
        }
      } catch (_) {}
      this._ytPlayer = null;
    }
  }

  /**
   * Plays victory fanfare with automatic priming guard and 1500ms watchdog (INV-AUDIO-1, INV-AUDIO-2).
   * 
   * @param {Object} config
   * @param {Function} [onBlockedCallback]
   * @returns {Promise<any>}
   */
  async playFanfare(config, onBlockedCallback) {
    // Atomic singleton lock (Section 10.1)
    this.stopFanfare();

    const validConfig = this.validateConfig(config);

    // Browser Autoplay Policy & Suspended AudioContext Guard (INV-AUDIO-1)
    if (this.audioContext && this.audioContext.state === 'suspended') {
      const resumeAndPlay = async () => {
        try {
          if (this.audioContext && typeof this.audioContext.resume === 'function') {
            await this.audioContext.resume();
          }
        } catch (_) {}
        return this.playFanfare(validConfig);
      };

      let banner = null;
      const targetContainer = this.container || (typeof document !== 'undefined' ? document.body : null);
      if (targetContainer) {
        banner = renderFallbackBanner(targetContainer, resumeAndPlay);
        this._activeBanner = banner;
      }

      if (typeof onBlockedCallback === 'function') {
        onBlockedCallback({
          reason: 'AUTOPLAY_BLOCKED',
          resumeAndPlay,
          banner
        });
      }
      return { blocked: true, banner };
    }

    // Source routing
    if (validConfig.sourceType === 'CHIPTUNE') {
      return this.playChiptune(validConfig.volume);
    }

    if (validConfig.sourceType === 'YOUTUBE') {
      return this._playYouTubeWithWatchdog(validConfig, onBlockedCallback);
    }

    if (validConfig.sourceType === 'DIRECT_MP3') {
      return this._playMp3WithWatchdog(validConfig, onBlockedCallback);
    }

    return this.playChiptune(validConfig.volume);
  }

  /** Alias for playFanfare */
  async playVictoryFanfare(config, onBlockedCallback) {
    return this.playFanfare(config, onBlockedCallback);
  }

  _playYouTubeWithWatchdog(config, onBlockedCallback) {
    // Arm 1500ms watchdog (INV-AUDIO-2)
    this._watchdogTimer = setTimeout(() => {
      this._watchdogTimer = null;
      this.abortExternalStream();
      this.playChiptune(config.volume);
      if (this._onFallbackTriggered) {
        this._onFallbackTriggered('WATCHDOG_TIMEOUT');
      }
    }, this.watchdogTimeoutMs);

    // If browser and YT API exists
    if (typeof window !== 'undefined' && window.YT && typeof window.YT.Player === 'function') {
      try {
        const playerDiv = document.createElement('div');
        playerDiv.style.display = 'none';
        if (this.container) {
          this.container.appendChild(playerDiv);
        } else if (document.body) {
          document.body.appendChild(playerDiv);
        }

        this._ytPlayer = new window.YT.Player(playerDiv, {
          height: '0',
          width: '0',
          videoId: config.videoId,
          playerVars: {
            autoplay: 1,
            playsinline: 1,
            controls: 0,
            start: Math.floor(config.startSeconds),
            end: Math.ceil(config.endSeconds)
          },
          events: {
            onStateChange: (event) => {
              // 1 = PLAYING
              if (event.data === 1 && this._watchdogTimer) {
                clearTimeout(this._watchdogTimer);
                this._watchdogTimer = null;
              }
            },
            onError: () => {
              if (this._watchdogTimer) {
                clearTimeout(this._watchdogTimer);
                this._watchdogTimer = null;
              }
              this.abortExternalStream();
              this.playChiptune(config.volume);
            }
          }
        });
      } catch (_) {
        // Fallback watchdog handles it or trigger immediately
      }
    }

    const session = {
      type: 'YOUTUBE',
      stop: () => this.stopFanfare(),
      config
    };
    this.activeSession = session;
    return session;
  }

  _playMp3WithWatchdog(config, onBlockedCallback) {
    // Arm 1500ms watchdog (INV-AUDIO-2)
    this._watchdogTimer = setTimeout(() => {
      this._watchdogTimer = null;
      this.abortExternalStream();
      this.playChiptune(config.volume);
      if (this._onFallbackTriggered) {
        this._onFallbackTriggered('WATCHDOG_TIMEOUT');
      }
    }, this.watchdogTimeoutMs);

    if (typeof Audio !== 'undefined') {
      try {
        const audio = new Audio(config.uri || config.sourceUrl);
        this._htmlAudio = audio;
        audio.volume = config.volume;
        audio.currentTime = config.startSeconds;

        audio.onplaying = () => {
          if (this._watchdogTimer) {
            clearTimeout(this._watchdogTimer);
            this._watchdogTimer = null;
          }
        };

        // Drift-resilient stop (INV-AUDIO-3)
        audio.ontimeupdate = () => {
          if (audio.currentTime >= config.endSeconds) {
            this.stopFanfare();
          }
        };

        audio.onerror = () => {
          if (this._watchdogTimer) {
            clearTimeout(this._watchdogTimer);
            this._watchdogTimer = null;
          }
          this.abortExternalStream();
          this.playChiptune(config.volume);
        };

        const playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(err => {
            if (this._watchdogTimer) {
              clearTimeout(this._watchdogTimer);
              this._watchdogTimer = null;
            }
            if (err && err.name === 'NotAllowedError') {
              if (typeof onBlockedCallback === 'function') {
                const resumeAndPlay = () => audio.play();
                const banner = typeof document !== 'undefined'
                  ? renderFallbackBanner(this.container || document.body, resumeAndPlay)
                  : null;
                this._activeBanner = banner;
                onBlockedCallback({ reason: 'NOT_ALLOWED', resumeAndPlay, banner });
              }
            } else {
              this.abortExternalStream();
              this.playChiptune(config.volume);
            }
          });
        }
      } catch (_) {
        // Fallback watchdog or direct chiptune
      }
    }

    const session = {
      type: 'DIRECT_MP3',
      stop: () => this.stopFanfare(),
      config
    };
    this.activeSession = session;
    return session;
  }

  destroy() {
    this.stopFanfare();
    if (this.chiptuneSynth) {
      this.chiptuneSynth.destroy();
    }
  }

  teardown() {
    this.destroy();
  }
}

// =============================================================================
// User Profile Manager & Storage Quota Guard (INV-AUDIO-6, INV-AUDIO-7)
// =============================================================================

export class ProfileManager {
  constructor(options = {}) {
    this.storageAdapter = options.storageAdapter || null;
    this.storagePrefix = options.storagePrefix || 'rpm_';
    this.maxPayloadBytes = options.maxPayloadBytes || MAX_PAYLOAD_BYTES;
    this._memProfiles = new Map();

    const hasWindow = typeof window !== 'undefined';
    this.hasLocalStorage = hasWindow && typeof window.localStorage !== 'undefined';
  }

  /**
   * Retrieves profile for userId, or initializes default profile.
   * 
   * @param {string} [userId='default_user']
   * @returns {Object} Deep clone of profile
   */
  getProfile(userId = 'default_user') {
    const uid = userId || 'default_user';

    // 1. In-memory cache
    if (this._memProfiles.has(uid)) {
      return JSON.parse(JSON.stringify(this._memProfiles.get(uid)));
    }

    // 2. localStorage
    if (this.hasLocalStorage) {
      try {
        const item = window.localStorage.getItem(`${this.storagePrefix}profile_${uid}`);
        if (item) {
          const parsed = JSON.parse(item);
          this._memProfiles.set(uid, parsed);
          return JSON.parse(JSON.stringify(parsed));
        }
      } catch (_) {}
    }

    // 3. Initialize default
    const freshProfile = createDefaultProfile(uid, 'Planeswalker');
    this._memProfiles.set(uid, freshProfile);
    return JSON.parse(JSON.stringify(freshProfile));
  }

  /**
   * Saves profile enforcing INV-AUDIO-7 (50-match circular ring buffer & 16KB quota guard).
   * 
   * @param {Object} profile
   * @returns {Object} Saved profile
   */
  saveProfile(profile) {
    if (!profile || typeof profile !== 'object') {
      throw new Error('Profile must be a valid object');
    }

    const uid = profile.userId || profile.id || 'default_user';
    profile.id = uid;
    profile.userId = uid;
    profile.updatedAt = Date.now();

    // Enforce 50-match circular ring buffer (INV-AUDIO-7)
    if (Array.isArray(profile.matchHistory)) {
      if (profile.matchHistory.length > MAX_MATCH_HISTORY_LENGTH) {
        profile.matchHistory = profile.matchHistory.slice(-MAX_MATCH_HISTORY_LENGTH);
      }
    } else {
      profile.matchHistory = [];
    }

    // Enforce 16KB Storage Quota Guard (INV-AUDIO-7)
    let serialized = JSON.stringify(profile);
    let bytes = calculatePayloadBytes(serialized);

    while (bytes > this.maxPayloadBytes && profile.matchHistory.length > 0) {
      profile.matchHistory.shift(); // Evict oldest match FIFO
      serialized = JSON.stringify(profile);
      bytes = calculatePayloadBytes(serialized);
    }

    if (bytes > this.maxPayloadBytes) {
      throw new Error(
        `INV-AUDIO-7 Violation: Profile payload size (${bytes} bytes) exceeds 16KB limit (${this.maxPayloadBytes} bytes)`
      );
    }

    const cloned = JSON.parse(serialized);
    this._memProfiles.set(uid, cloned);

    if (this.hasLocalStorage) {
      try {
        window.localStorage.setItem(`${this.storagePrefix}profile_${uid}`, serialized);
      } catch (_) {}
    }

    return cloned;
  }

  /**
   * Records match outcome, updates Elo, rolls perks, progresses deck slots, and appends to ring buffer.
   * 
   * @param {string} userId
   * @param {Object} matchData
   * @returns {Object} Updated profile
   */
  recordMatch(userId, matchData = {}) {
    const profile = this.getProfile(userId);

    // Match counts
    profile.matchesPlayed = (profile.matchesPlayed || 0) + 1;
    profile.totalMatches = profile.matchesPlayed;

    // Outcome tracking
    const isWin = matchData.placement === 1 || matchData.isWinner === true || matchData.outcome === 'win';
    const isDraw = matchData.isDraw === true || matchData.outcome === 'draw';

    if (isWin) {
      profile.wins = (profile.wins || 0) + 1;
    } else if (isDraw) {
      profile.draws = (profile.draws || 0) + 1;
    } else {
      profile.losses = (profile.losses || 0) + 1;
    }

    // Elo update
    const preElo = profile.elo || DEFAULT_PROFILE_ELO;
    if (typeof matchData.postElo === 'number') {
      profile.elo = matchData.postElo;
    } else if (typeof matchData.deltaElo === 'number') {
      profile.elo = Math.max(100, preElo + matchData.deltaElo);
    }

    // Perk counters (Audio Note 4)
    const perks = matchData.perksTriggered ?? matchData.perksInMatch ?? matchData.perksRolled ?? matchData.perks ?? 0;
    profile.totalPerksTriggered = (profile.totalPerksTriggered || 0) + perks;
    profile.totalPerksRolled = profile.totalPerksTriggered;
    profile.maxPerksSingleGame = Math.max(profile.maxPerksSingleGame || 0, perks);

    // Deck slot milestone progression (Audio Note 5, INV-AUDIO-6)
    const slotProgress = evaluateDeckSlots(
      profile.wins,
      profile.totalPerksTriggered,
      profile.unlockedDeckSlots || 1
    );
    profile.unlockedDeckSlots = slotProgress.currentSlots;

    // Ring buffer history entry (INV-AUDIO-7)
    const record = {
      matchId: matchData.matchId || `match_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: matchData.timestamp || Date.now(),
      playerCount: matchData.playerCount || 2,
      format: matchData.format || (matchData.playerCount > 2 ? 'multiplayer' : '1v1'),
      placement: matchData.placement ?? (isWin ? 1 : 2),
      preElo: matchData.preElo ?? preElo,
      postElo: profile.elo,
      deltaElo: matchData.deltaElo ?? (profile.elo - preElo),
      perksTriggered: perks,
      opponents: matchData.opponents || []
    };

    if (!Array.isArray(profile.matchHistory)) {
      profile.matchHistory = [];
    }
    profile.matchHistory.push(record);
    if (profile.matchHistory.length > MAX_MATCH_HISTORY_LENGTH) {
      profile.matchHistory = profile.matchHistory.slice(-MAX_MATCH_HISTORY_LENGTH);
    }

    const saved = this.saveProfile(profile);
    saved.lastSlotProgress = slotProgress;
    return saved;
  }

  /**
   * Sets fanfare audio configuration for user.
   * 
   * @param {string} userId
   * @param {Object} config
   * @returns {Object} Updated profile
   */
  setFanfareConfig(userId, config) {
    const profile = this.getProfile(userId);
    profile.fanfareConfig = validateFanfareConfig(config);
    return this.saveProfile(profile);
  }

  /**
   * Unlocks an additional deck slot up to max 5.
   * 
   * @param {string} userId
   * @returns {Object} Updated profile
   */
  unlockDeckSlot(userId) {
    const profile = this.getProfile(userId);
    if (profile.unlockedDeckSlots < 5) {
      profile.unlockedDeckSlots += 1;
    }
    return this.saveProfile(profile);
  }

  /**
   * Sets currently active deck slot index.
   * 
   * @param {string} userId
   * @param {number} slotIndex
   * @returns {Object} Updated profile
   */
  setActiveDeckSlot(userId, slotIndex) {
    const profile = this.getProfile(userId);
    if (typeof slotIndex !== 'number' || slotIndex < 0 || slotIndex >= profile.unlockedDeckSlots) {
      throw new Error(
        `Invalid slotIndex: ${slotIndex}. Must be between 0 and ${profile.unlockedDeckSlots - 1}.`
      );
    }
    profile.activeDeckSlotIndex = slotIndex;
    profile.activeDeckId = `deck_slot_${slotIndex + 1}`;
    return this.saveProfile(profile);
  }

  /**
   * Resets competitive stats while preserving unlocked deck slots (Anti-Regression Law, INV-AUDIO-6).
   * 
   * @param {string} userId
   * @returns {Object} Updated profile
   */
  resetStats(userId) {
    const profile = this.getProfile(userId);
    profile.elo = DEFAULT_PROFILE_ELO;
    profile.wins = 0;
    profile.losses = 0;
    profile.draws = 0;
    profile.matchesPlayed = 0;
    profile.totalMatches = 0;
    profile.totalPerksRolled = 0;
    profile.totalPerksTriggered = 0;
    profile.maxPerksSingleGame = 0;
    profile.matchHistory = [];
    // Note: profile.unlockedDeckSlots is strictly preserved!
    return this.saveProfile(profile);
  }
}

// Aliases for compatibility
export const VictoryFanfare = VictoryFanfareEngine;
export const AudioEngine = VictoryFanfareEngine;
export const UserProfileManager = ProfileManager;

export default {
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
};
