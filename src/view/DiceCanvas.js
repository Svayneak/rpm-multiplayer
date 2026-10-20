/**
 * src/view/DiceCanvas.js
 * 3D Physics Dice Box Singleton powered by @3d-dice/dice-box and Ammo.js WASM.
 * 
 * Enforces Architectural Invariants:
 * - INV-DICE-3D-1: 3D Dice Engine Integration & Headless Test Bypass
 * 
 * Specification: SPEC-RPM-DICE-018
 * @module DiceCanvas
 */

const CANVAS_SELECTOR = '#dice-canvas';
const DICE_BOX_ASSET_PATH = '/assets/dice-box/';

/**
 * Calibrated scale matrix: die type × orientation.
 */
const DICE_SCALE = Object.freeze({
  d10: { portrait: 5.5, landscape: 7.5 },
  d20: {
    single: { portrait: 5.0, landscape: 6.5 },
    multi:  { portrait: 4.0, landscape: 5.5 }
  }
});

const AUTO_CLEAR_DELAY_MS = 3500; // 3.5s after roll completion
const FADE_DURATION_MS = 400;     // 400ms CSS fade-out

/**
 * Returns true if running in a real browser environment with Web Worker & Canvas support.
 * In headless Node.js tests or CI, returns false to bypass 3D physics rendering cleanly.
 * @returns {boolean}
 */
export function is3DSupported() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }
  if (typeof window.Worker === 'undefined') {
    return false;
  }
  const hasCanvas = typeof HTMLCanvasElement !== 'undefined' || typeof OffscreenCanvas !== 'undefined';
  return Boolean(hasCanvas);
}

/**
 * Normalizes d10 result (smooth theme 0-9 faces). Defensively converts 10 to 0.
 * @param {number|any} v
 * @returns {number}
 */
function normalizeD10(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n === 10 ? 0 : ((n % 10 + 10) % 10);
}

export class DiceCanvas {
  constructor() {
    this._box = null;
    this._initPromise = null;
    this._pendingPercentile = null; // { resolve }
    this._pendingD20 = null;        // { playerId, resolve }
    this._pendingMultiD20 = null;   // { playerIds, resolve }
    this._autoClearTimer = null;
    this._fadeTimer = null;
  }

  is3DSupported() {
    return is3DSupported();
  }

  /**
   * Initializes the 3D DiceBox instance.
   * If running in headless/Node.js, resolves immediately.
   * @returns {Promise<void>}
   */
  async init() {
    if (!this.is3DSupported()) {
      return Promise.resolve();
    }
    if (this._initPromise) {
      return this._initPromise;
    }
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    try {
      const modUrl = new URL('../../assets/lib/dice-box/dice-box.es.min.js', import.meta.url).href;
      const mod = await import(/* @vite-ignore */ modUrl);
      const DiceBox = mod.default ?? mod.DiceBox ?? mod;

      this._box = new DiceBox({
        id: 'dice-canvas-el',
        container: CANVAS_SELECTOR,
        assetPath: DICE_BOX_ASSET_PATH,
        theme: 'smooth',
        scale: this._pickScale('d20'),
        gravity: 1.8,
        mass: 1.2,
        friction: 0.85,
        restitution: 0.1,
        throwForce: 3.2,
        startingHeight: 7,
        spinForce: 5,
        settleTimeout: 3500,
        enableShadows: true,
        shadowTransparency: 0.4,
        offscreen: true
      });

      this._box.onRollComplete = (results) => this._handleRollComplete(results);
      await this._box.init();
    } catch (err) {
      console.warn('[DiceCanvas] 3D DiceBox init fallback:', err);
      this._box = null;
    }
  }

  /**
   * Cleans up canvas and state timers.
   */
  teardown() {
    this._cancelAutoClear();
    try {
      this._box?.clear?.();
    } catch (_) {}
    this._box = null;
    this._initPromise = null;
    this._pendingPercentile = null;
    this._pendingD20 = null;
    this._pendingMultiD20 = null;
  }

  /**
   * Clears dice from the screen immediately.
   */
  clear() {
    this._cancelAutoClear();
    this._pendingPercentile = null;
    this._pendingD20 = null;
    this._pendingMultiD20 = null;
    try {
      this._box?.clear?.();
    } catch (_) {}
  }

  /**
   * Roll percentile 2d10 dice (tens and ones).
   * Returns [tens, ones] where tens and ones are numbers in range 0..9.
   * In headless Node.js tests, returns synchronous RNG digits.
   * 
   * @param {Object} [options={}]
   * @returns {Promise<[number, number]>}
   */
  async rollPercentile(options = {}) {
    if (!this.is3DSupported()) {
      const tens = Math.floor(Math.random() * 10);
      const ones = Math.floor(Math.random() * 10);
      return [tens, ones];
    }

    await this.init();
    if (!this._box) {
      const tens = Math.floor(Math.random() * 10);
      const ones = Math.floor(Math.random() * 10);
      return [tens, ones];
    }

    return new Promise((resolve) => {
      this.clear();
      const throwForce = Number.isFinite(options.throwForce)
        ? Math.min(4.8, Math.max(2.8, options.throwForce))
        : 3.2;

      this._box.updateConfig({
        scale: this._pickScale('d10', 2),
        throwForce,
        gravity: 1.8
      });

      this._pendingPercentile = { resolve };
      this._playRollSound();

      this._box.roll([
        { qty: 1, sides: 10, themeColor: '#8A2BE2' },
        { qty: 1, sides: 10, themeColor: '#7FFFD4' }
      ]);
    });
  }

  /**
   * Roll a single d20 die for roll-off or initiative.
   * Returns integer in range 1..20.
   * In headless Node.js tests, returns synchronous RNG integer 1..20.
   * 
   * @param {string} playerId
   * @param {Object} [options={}]
   * @returns {Promise<number>}
   */
  async rollD20(playerId, options = {}) {
    if (!this.is3DSupported()) {
      return Math.floor(Math.random() * 20) + 1;
    }

    await this.init();
    if (!this._box) {
      return Math.floor(Math.random() * 20) + 1;
    }

    return new Promise((resolve) => {
      this.clear();
      const throwForce = Number.isFinite(options.throwForce)
        ? Math.min(4.8, Math.max(2.8, options.throwForce))
        : 3.2;

      this._box.updateConfig({
        scale: this._pickScale('d20', 1),
        throwForce,
        gravity: 1.8
      });

      this._pendingD20 = { playerId, resolve };
      this._playRollSound();

      this._box.roll('1d20', { themeColor: options.themeColor || '#f59e0b' });
    });
  }

  /**
   * Roll multiple d20 dice simultaneously for all seated players in roll-off.
   * Returns Record<playerId, number>.
   * 
   * @param {Array<{ playerId: string, colorHex?: string }>} rolls
   * @returns {Promise<Record<string, number>>}
   */
  async rollMultiD20(rolls = []) {
    if (!this.is3DSupported()) {
      const res = {};
      for (const r of rolls) {
        res[r.playerId] = Math.floor(Math.random() * 20) + 1;
      }
      return res;
    }

    await this.init();
    if (!this._box) {
      const res = {};
      for (const r of rolls) {
        res[r.playerId] = Math.floor(Math.random() * 20) + 1;
      }
      return res;
    }

    return new Promise((resolve) => {
      this.clear();
      this._box.updateConfig({
        scale: this._pickScale('d20', rolls.length),
        throwForce: 3.2,
        gravity: 1.8
      });

      this._pendingMultiD20 = {
        playerIds: rolls.map(r => r.playerId),
        resolve
      };
      this._playRollSound();

      this._box.roll(rolls.map(r => ({
        qty: 1,
        sides: 20,
        themeColor: r.colorHex || '#f59e0b'
      })));
    });
  }

  _pickScale(dieType, qty = 1) {
    const isLandscape = (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
      ? (window.matchMedia('(orientation: landscape)').matches)
      : false;
    const orient = isLandscape ? 'landscape' : 'portrait';

    if (dieType === 'd10') {
      return DICE_SCALE.d10[orient];
    }
    if (qty > 2) {
      return DICE_SCALE.d20.multi[orient];
    }
    return DICE_SCALE.d20.single[orient];
  }

  _handleRollComplete(results) {
    const dieValues = [];
    for (const collection of results ?? []) {
      const rolls = collection?.rolls ?? [];
      for (const r of rolls) {
        if (typeof r.value === 'number') dieValues.push(r.value);
      }
    }

    if (this._pendingMultiD20) {
      const { playerIds, resolve } = this._pendingMultiD20;
      this._pendingMultiD20 = null;
      const res = {};
      for (let i = 0; i < playerIds.length; i++) {
        res[playerIds[i]] = dieValues[i] || (Math.floor(Math.random() * 20) + 1);
      }
      this._scheduleAutoClear(AUTO_CLEAR_DELAY_MS);
      if (typeof resolve === 'function') {
        resolve(res);
      }
      return;
    }

    if (this._pendingPercentile) {
      const { resolve } = this._pendingPercentile;
      this._pendingPercentile = null;
      const tens = normalizeD10(dieValues[0]);
      const ones = normalizeD10(dieValues[1]);
      this._scheduleAutoClear(AUTO_CLEAR_DELAY_MS);
      if (typeof resolve === 'function') {
        resolve([tens, ones]);
      }
      return;
    }

    if (this._pendingD20) {
      const { resolve } = this._pendingD20;
      this._pendingD20 = null;
      const value = dieValues[0] || (Math.floor(Math.random() * 20) + 1);
      this._scheduleAutoClear(AUTO_CLEAR_DELAY_MS);
      if (typeof resolve === 'function') {
        resolve(value);
      }
    }
  }

  _playRollSound() {
    if (typeof Audio !== 'undefined') {
      try {
        const audio = new Audio('/assets/sounds/roll.mp3');
        audio.volume = 0.5;
        audio.play().catch(() => {});
      } catch (_) {}
    }
  }

  _scheduleAutoClear(delayMs = AUTO_CLEAR_DELAY_MS) {
    this._cancelAutoClear();
    this._autoClearTimer = setTimeout(() => {
      this._fadeOutAndClear();
    }, delayMs);
  }

  _fadeOutAndClear() {
    const el = (typeof document !== 'undefined') ? document.querySelector(CANVAS_SELECTOR) : null;
    if (el) {
      el.classList.add('is-fading');
    }
    this._fadeTimer = setTimeout(() => {
      this.clear();
    }, FADE_DURATION_MS);
  }

  _cancelAutoClear() {
    if (this._autoClearTimer != null) {
      clearTimeout(this._autoClearTimer);
      this._autoClearTimer = null;
    }
    if (this._fadeTimer != null) {
      clearTimeout(this._fadeTimer);
      this._fadeTimer = null;
    }
    const el = (typeof document !== 'undefined') ? document.querySelector(CANVAS_SELECTOR) : null;
    if (el) {
      el.classList.remove('is-fading');
    }
  }
}

export const diceCanvas = new DiceCanvas();
export const init = diceCanvas.init.bind(diceCanvas);
export const clear = diceCanvas.clear.bind(diceCanvas);
export const teardown = diceCanvas.teardown.bind(diceCanvas);
