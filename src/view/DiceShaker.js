/**
 * src/view/DiceShaker.js
 * Interactive touch-hold and shaking HUD for dice rolls.
 * Spawns an ethereal dice-holding aura that tracks finger movements across the screen,
 * rattles dice with dynamic angular jitter, and calculates release throw force.
 * 
 * Enforces Architectural Invariants:
 * - INV-DICE-3D-1: Interactive Shaker HUD with Haptic & Audio Dynamics
 * 
 * Specification: SPEC-RPM-DICE-018
 * @module DiceShaker
 */

export class DiceShaker {
  constructor() {
    this._el = null;
    this._aura = null;
    this._container = null;
    this._tensDie = null;
    this._onesDie = null;
    this._d20Die = null;
    this._hint = null;
    this._active = false;
    this._rafId = null;

    this._targetX = 0;
    this._targetY = 0;
    this._curX = 0;
    this._curY = 0;
    this._prevX = 0;
    this._prevY = 0;
    this._vx = 0;
    this._vy = 0;
    this._prevVx = 0;
    this._prevVy = 0;
    this._lastTime = 0;

    this._lastRattleTime = 0;
    this._shakeCount = 0;
    this._isRotated = false;
    this._isD20 = false;
    this._rotationDeg = 0;
  }

  /**
   * Start holding and shaking dice at initial pointer coordinates (x, y).
   * 
   * @param {number} x - Client X coordinate
   * @param {number} y - Client Y coordinate
   * @param {Object} [options={}] - { isRotated: boolean, isD20: boolean, rotation: number }
   */
  start(x, y, options = {}) {
    if (typeof document === 'undefined') return;
    this._ensureMounted();
    if (!this._el || !this._aura) return;

    this._rotationDeg = options.rotation ?? (options.isRotated ? 180 : 0);
    this._isRotated = this._rotationDeg === 180;
    this._isD20 = Boolean(options.isD20);

    this._targetX = x;
    this._targetY = y;
    this._curX = x;
    this._curY = y;
    this._prevX = x;
    this._prevY = y;
    this._vx = 0;
    this._vy = 0;
    this._prevVx = 0;
    this._prevVy = 0;
    this._lastTime = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    this._lastRattleTime = 0;
    this._shakeCount = 0;
    this._active = true;

    // Configure dice visibility
    if (this._tensDie && this._onesDie && this._d20Die) {
      if (this._isD20) {
        this._tensDie.style.display = 'none';
        this._onesDie.style.display = 'none';
        this._d20Die.style.display = 'flex';
      } else {
        this._tensDie.style.display = 'flex';
        this._onesDie.style.display = 'flex';
        this._d20Die.style.display = 'none';
      }
    }

    // Apply rotation and position
    this._aura.style.left = `${x}px`;
    this._aura.style.top = `${y}px`;
    this._aura.style.transform = `translate(-50%, -50%) rotate(${this._rotationDeg}deg)`;
    this._aura.classList.remove('shaker-burst');

    this._el.classList.remove('hidden');

    if (typeof requestAnimationFrame === 'function') {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = requestAnimationFrame((ts) => this._loop(ts));
    }
  }

  /**
   * Update target finger position during pointermove.
   * @param {number} x
   * @param {number} y
   */
  update(x, y) {
    if (!this._active) return;
    this._targetX = x;
    this._targetY = y;
  }

  /**
   * Release touch: animate outward burst and return calculated throw dynamics.
   * 
   * @param {number} [x]
   * @param {number} [y]
   * @returns {{ throwForce: number, speed: number, shakeCount: number }}
   */
  release(x, y) {
    if (!this._active) {
      return { throwForce: 3.2, speed: 0, shakeCount: 0 };
    }
    this._active = false;
    if (this._rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const dt = Math.max(16, now - this._lastTime);
    const speed = Math.hypot(this._vx, this._vy);

    // Dynamic throw force scaled by release speed and accumulated shake energy
    const energyBonus = Math.min(0.8, this._shakeCount * 0.08);
    const speedBonus = Math.min(0.6, speed * 1.2);
    const throwForce = parseFloat((3.2 + energyBonus + speedBonus).toFixed(2));

    if (this._aura) {
      this._aura.classList.add('shaker-burst');
      setTimeout(() => {
        if (this._el) this._el.classList.add('hidden');
        if (this._aura) this._aura.classList.remove('shaker-burst');
      }, 240);
    } else if (this._el) {
      this._el.classList.add('hidden');
    }

    return { throwForce, speed, shakeCount: this._shakeCount };
  }

  /**
   * Cancel shake immediately without release animation.
   */
  cancel() {
    this._active = false;
    if (this._rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._el) this._el.classList.add('hidden');
    if (this._aura) this._aura.classList.remove('shaker-burst');
  }

  _loop(now) {
    if (!this._active) return;

    const dt = Math.max(16, Math.min(50, now - this._lastTime));
    this._lastTime = now;

    // Smooth spring follow toward finger position
    const followSpeed = 0.35;
    this._curX += (this._targetX - this._curX) * followSpeed;
    this._curY += (this._targetY - this._curY) * followSpeed;

    // Compute velocity
    this._vx = (this._curX - this._prevX) / dt;
    this._vy = (this._curY - this._prevY) / dt;
    const speed = Math.hypot(this._vx, this._vy);

    // Direction reversal / shake detection
    const isReversal = (this._vx * this._prevVx < -0.015) || (this._vy * this._prevVy < -0.015);
    const isFastShake = speed > 0.18;

    if ((isReversal || isFastShake) && (now - this._lastRattleTime > 85)) {
      this._lastRattleTime = now;
      this._shakeCount++;

      this._rattleDice();

      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(12); } catch (_) {}
      }
      if (typeof Audio !== 'undefined') {
        try {
          const audio = new Audio('/assets/sounds/roll.mp3');
          audio.volume = 0.2;
          audio.play().catch(() => {});
        } catch (_) {}
      }
    }

    this._prevVx = this._vx;
    this._prevVy = this._vy;
    this._prevX = this._curX;
    this._prevY = this._curY;

    if (this._aura) {
      const rotDeg = (this._rotationDeg ?? 0) + (this._vx * 15);
      this._aura.style.left = `${this._curX}px`;
      this._aura.style.top = `${this._curY}px`;
      this._aura.style.transform = `translate(-50%, -50%) rotate(${rotDeg}deg)`;
    }

    if (typeof requestAnimationFrame === 'function') {
      this._rafId = requestAnimationFrame((ts) => this._loop(ts));
    }
  }

  _rattleDice() {
    const jitter = (range) => (Math.random() - 0.5) * range;
    if (this._tensDie && this._onesDie) {
      const rot1 = jitter(36);
      const rot2 = jitter(36);
      const tx1 = jitter(10);
      const ty1 = jitter(10);
      const tx2 = jitter(10);
      const ty2 = jitter(10);

      this._tensDie.style.transform = `translate(${tx1}px, ${ty1}px) rotate(${rot1}deg)`;
      this._onesDie.style.transform = `translate(${tx2}px, ${ty2}px) rotate(${rot2}deg)`;
    } else if (this._d20Die) {
      const rot = jitter(45);
      const tx = jitter(12);
      const ty = jitter(12);
      this._d20Die.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg)`;
    }
  }

  _ensureMounted() {
    if (typeof document === 'undefined' || this._el) return;

    let el = document.getElementById('dice-shaker-hud');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dice-shaker-hud';
      el.className = 'dice-shaker-hud pointer-events-none fixed inset-0 z-[9999] hidden';
      el.innerHTML = `
        <div class="shaker-aura">
          <div class="shaker-dice-container">
            <div class="shaker-die die-tens">
              <span class="die-label">80</span>
            </div>
            <div class="shaker-die die-ones">
              <span class="die-label">7</span>
            </div>
            <div class="shaker-die die-d20" style="display: none;">
              <span class="die-label">20</span>
            </div>
          </div>
          <div class="shaker-hint">Shake & Release</div>
        </div>
      `;
      document.body.appendChild(el);
    }

    this._el = el;
    this._aura = el.querySelector('.shaker-aura');
    this._container = el.querySelector('.shaker-dice-container');
    this._tensDie = el.querySelector('.die-tens');
    this._onesDie = el.querySelector('.die-ones');
    this._d20Die = el.querySelector('.die-d20');
    this._hint = el.querySelector('.shaker-hint');
  }
}

export const diceShaker = new DiceShaker();
