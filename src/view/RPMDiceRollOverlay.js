/**
 * src/view/RPMDiceRollOverlay.js
 * Interactive Step 1 RPM Upkeep Emblem Modal Overlay & Draggable 2d10 Roll Viewport.
 * 
 * Ported from rpmrevival:
 * - 2d10 pentagonal trapezohedron visual presentation (Violet Tens & Aquamarine Ones)
 * - Draggable Roll Button (#btn-draggable-dice-roll) with tension stretch & aim trail feedback
 * - Skip Button (#btn-skip-dice-roll) "No lanzar (Skip)"
 * - Result Banner (#rpm-roll-result-banner) with ~1.5s celebratory inspection before Step 2 queuing
 * 
 * Specification: SPEC-RPM-PERK-009 & SPEC-RPM-DICE-018
 * @module RPMDiceRollOverlay
 */

import { diceCanvas } from './DiceCanvas.js';
import { diceShaker } from './DiceShaker.js';
import { getPerkDefinition } from '../PerkCatalog.js';

export class RPMDiceRollOverlay {
  /**
   * @param {Object} [options={}]
   * @param {HTMLElement|string} [options.container]
   * @param {RPMAppController} [options.app]
   * @param {number} [options.bannerDurationMs=1500]
   */
  constructor(options = {}) {
    this.container = options.container || null;
    this.app = options.app || null;
    this.bannerDurationMs = options.bannerDurationMs ?? 1500;
    this.diceCanvas = options.diceCanvas || diceCanvas;

    this.element = null;
    this.isOpen = false;
    this._isRolling = false;
    this._isDragging = false;
    this._currentData = null;
    this._autoCloseTimer = null;

    this._dragStart = { x: 0, y: 0 };
    this._dragCurrent = { x: 0, y: 0 };
    this._activePointerId = null;

    this._boundPointerDown = this._onPointerDown.bind(this);
    this._boundPointerMove = this._onPointerMove.bind(this);
    this._boundPointerUp = this._onPointerUp.bind(this);
    this._boundPointerCancel = this._onPointerCancel.bind(this);
    this._boundClickRoll = this._onClickRoll.bind(this);
    this._boundClickSkip = this._onClickSkip.bind(this);
    this._boundKeyDown = this._onKeyDown.bind(this);

    if (typeof document !== 'undefined' && this.container) {
      this.init();
    }
  }

  /**
   * Mounts the overlay into the specified DOM container.
   * @param {HTMLElement} container
   */
  mount(container) {
    if (!container) return;
    this.container = container;
    this.init();
  }

  /**
   * Initializes overlay DOM structure and binds listeners.
   */
  init() {
    if (this.element || !this.container) return;

    let el = null;
    if (typeof document !== 'undefined') {
      el = (typeof this.container.querySelector === 'function')
        ? this.container.querySelector('#rpm-dice-roll-overlay')
        : null;

      if (!el) {
        el = document.createElement('div');
        el.id = 'rpm-dice-roll-overlay';
        el.className = 'rpm-dice-roll-overlay hidden';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', 'RPM Emblem 2d10 Dice Roll');
        el.style.display = 'none';

        el.innerHTML = `
          <div class="rpm-dice-overlay-backdrop"></div>
          <div class="rpm-dice-overlay-panel">
            <div class="rpm-overlay-header">
              <span class="rpm-overlay-badge">⚔️ RPM EMBLEM — STEP 1</span>
              <h2 class="rpm-overlay-title">Upkeep Perk Roll</h2>
              <p class="rpm-overlay-subtitle">Arrastra el botón para lanzar con impulso o salta para asegurar tu turno.</p>
            </div>

            <!-- Foreground 2d10 Visual Dice Viewport -->
            <div class="rpm-dice-viewport" id="rpm-overlay-dice-viewport">
              <div class="rpm-die rpm-die-tens" id="overlay-die-tens" title="Tens Die (Violet d10)">
                <div class="die-face-inner">
                  <span class="die-accent-diamond">◆</span>
                  <span class="die-digit-text" id="overlay-tens-digit">0</span>
                </div>
                <span class="die-label-caption">TENS (Violet)</span>
              </div>

              <div class="rpm-die rpm-die-ones" id="overlay-die-ones" title="Ones Die (Aquamarine d10)">
                <div class="die-face-inner">
                  <span class="die-accent-diamond">◆</span>
                  <span class="die-digit-text" id="overlay-ones-digit">0</span>
                </div>
                <span class="die-label-caption">ONES (Aqua)</span>
              </div>
            </div>

            <!-- Tension Aim-Trail Vector (SVG) -->
            <svg class="rpm-aim-trail-canvas" id="rpm-aim-trail" aria-hidden="true" style="display: none;">
              <line class="rpm-aim-trail-line" id="rpm-aim-line" x1="0" y1="0" x2="0" y2="0" />
              <circle class="rpm-aim-trail-puck" id="rpm-aim-puck" cx="0" cy="0" r="10" />
            </svg>

            <!-- Result Inspection Banner (displayed for ~1.5s after roll) -->
            <div id="rpm-roll-result-banner" class="rpm-roll-result-banner hidden" style="display: none;" aria-live="polite">
              <div class="banner-headline" id="banner-result-headline"></div>
              <div class="banner-subtext" id="banner-result-subtext"></div>
            </div>

            <!-- Action Controls -->
            <div class="rpm-overlay-actions" id="rpm-overlay-actions">
              <button id="btn-draggable-dice-roll" class="btn btn-draggable-roll" type="button" title="Arrastra para apuntar impulso, o haz clic para lanzar">
                <span class="btn-roll-icon">🎲</span>
                <span class="btn-roll-text">Lanzar Dados (Drag & Release)</span>
              </button>

              <button id="btn-skip-dice-roll" class="btn btn-skip-roll" type="button" title="Declinar lanzamiento de dados">
                No lanzar (Skip)
              </button>
            </div>
          </div>
        `;

        this.container.appendChild(el);
      }
    }

    this.element = el;
    this._bindEvents();
  }

  _bindEvents() {
    if (!this.element) return;

    const btnRoll = this.element.querySelector('#btn-draggable-dice-roll');
    const btnSkip = this.element.querySelector('#btn-skip-dice-roll');

    if (btnRoll) {
      btnRoll.addEventListener('pointerdown', this._boundPointerDown);
      btnRoll.addEventListener('pointermove', this._boundPointerMove);
      btnRoll.addEventListener('pointerup', this._boundPointerUp);
      btnRoll.addEventListener('pointercancel', this._boundPointerCancel);
      btnRoll.addEventListener('click', this._boundClickRoll);
    }

    if (btnSkip) {
      btnSkip.addEventListener('click', this._boundClickSkip);
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', this._boundKeyDown);
    }
  }

  /**
   * Opens the overlay for human roll confirmation.
   * 
   * @param {Object} data - { playerId, roundNumber, turnNumber, callback }
   */
  open(data = {}) {
    if (this._autoCloseTimer) {
      clearTimeout(this._autoCloseTimer);
      this._autoCloseTimer = null;
    }

    this._currentData = data;
    this.isOpen = true;
    this._isRolling = false;
    this._isDragging = false;

    if (!this.element && this.container) {
      this.init();
    }
    if (!this.element) return;

    // Ensure persistent overlay is re-attached if modal-root was previously manipulated
    if (typeof document !== 'undefined') {
      const modalRoot = (this.container && typeof this.container.querySelector === 'function')
        ? (this.container.querySelector('#modal-root') || this.container)
        : document.querySelector('#modal-root');
      if (this.element && !this.element.isConnected) {
        if (modalRoot) {
          modalRoot.appendChild(this.element);
        } else if (document.body) {
          document.body.appendChild(this.element);
        }
      }
      if (modalRoot) {
        modalRoot.setAttribute('aria-hidden', 'false');
        modalRoot.style.pointerEvents = 'auto';
      }
    }

    // Reset visual state
    this.element.classList.remove('hidden');
    this.element.style.display = 'flex';

    const banner = this.element.querySelector('#rpm-roll-result-banner');
    if (banner) {
      banner.classList.add('hidden');
      banner.style.display = 'none';
      banner.className = 'rpm-roll-result-banner hidden';
    }

    const tensDigit = this.element.querySelector('#overlay-tens-digit');
    const onesDigit = this.element.querySelector('#overlay-ones-digit');
    if (tensDigit) tensDigit.textContent = '0';
    if (onesDigit) onesDigit.textContent = '0';

    const viewport = this.element.querySelector('#rpm-overlay-dice-viewport');
    if (viewport) {
      viewport.classList.remove('is-rolling', 'throw-bounce-settle', 'throw-fast-glide');
    }

    const btnRoll = this.element.querySelector('#btn-draggable-dice-roll');
    const btnSkip = this.element.querySelector('#btn-skip-dice-roll');
    if (btnRoll) {
      btnRoll.disabled = false;
      btnRoll.classList.remove('is-dragging', 'is-rolling');
      btnRoll.style.transform = '';
    }
    if (btnSkip) {
      btnSkip.disabled = false;
    }

    const aimTrail = this.element.querySelector('#rpm-aim-trail');
    if (aimTrail) {
      aimTrail.style.display = 'none';
    }
  }

  /**
   * Closes the overlay and cleans up active timers.
   */
  close() {
    this.isOpen = false;
    this._isRolling = false;
    this._isDragging = false;
    this._currentData = null;

    if (this._autoCloseTimer) {
      clearTimeout(this._autoCloseTimer);
      this._autoCloseTimer = null;
    }

    if (this.element) {
      this.element.classList.add('hidden');
      this.element.style.display = 'none';
    }

    if (typeof document !== 'undefined') {
      const modalRoot = (this.container && typeof this.container.querySelector === 'function')
        ? (this.container.querySelector('#modal-root') || this.container)
        : document.querySelector('#modal-root');
      if (modalRoot) {
        const hasOtherModals = Boolean(
          modalRoot.querySelector('.modal-dialog-box, #target-selector-modal:not(.hidden), #victory-modal-wrapper, #deckbuilder-modal-wrapper, #recap-modal-wrapper')
        );
        if (!hasOtherModals) {
          modalRoot.setAttribute('aria-hidden', 'true');
          modalRoot.style.pointerEvents = 'none';
        }
      }
    }
  }

  /**
   * Teardown listeners and DOM.
   */
  destroy() {
    this.close();
    if (typeof document !== 'undefined') {
      try {
        document.removeEventListener('keydown', this._boundKeyDown);
      } catch (_) {}
    }
    if (this.element && this.element.parentElement) {
      this.element.parentElement.removeChild(this.element);
    }
    this.element = null;
  }

  // ─── Interactive Draggable Roll Mechanics ──────────────────────────────────

  _onPointerDown(ev) {
    if (this._isRolling) return;
    this._isDragging = true;
    this._activePointerId = ev.pointerId;
    this._dragStart = { x: ev.clientX, y: ev.clientY };
    this._dragCurrent = { x: ev.clientX, y: ev.clientY };

    const btn = ev.currentTarget;
    if (btn) {
      btn.classList.add('is-dragging');
      try {
        if (typeof btn.setPointerCapture === 'function') {
          btn.setPointerCapture(ev.pointerId);
        }
      } catch (_) {}
    }

    // Launch shaker HUD aura if available
    if (typeof diceShaker !== 'undefined' && typeof diceShaker.start === 'function') {
      diceShaker.start(ev.clientX, ev.clientY, { isD20: false });
    }
  }

  _onPointerMove(ev) {
    if (!this._isDragging || (this._activePointerId !== null && ev.pointerId !== this._activePointerId)) {
      return;
    }

    this._dragCurrent = { x: ev.clientX, y: ev.clientY };
    const dx = ev.clientX - this._dragStart.x;
    const dy = ev.clientY - this._dragStart.y;
    const dist = Math.hypot(dx, dy);

    // Apply visual spring / tension transform
    const btn = this.element?.querySelector('#btn-draggable-dice-roll');
    if (btn) {
      const stretchDamp = 0.35;
      const tx = dx * stretchDamp;
      const ty = dy * stretchDamp;
      const scale = 1 + Math.min(0.18, dist * 0.001);
      btn.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    }

    // Update aim-trail line
    const aimTrail = this.element?.querySelector('#rpm-aim-trail');
    const aimLine = this.element?.querySelector('#rpm-aim-line');
    const aimPuck = this.element?.querySelector('#rpm-aim-puck');
    if (aimTrail && aimLine && aimPuck && dist > 10) {
      aimTrail.style.display = 'block';
      aimLine.setAttribute('x1', String(this._dragStart.x));
      aimLine.setAttribute('y1', String(this._dragStart.y));
      aimLine.setAttribute('x2', String(ev.clientX));
      aimLine.setAttribute('y2', String(ev.clientY));
      aimPuck.setAttribute('cx', String(ev.clientX));
      aimPuck.setAttribute('cy', String(ev.clientY));
    }

    if (typeof diceShaker !== 'undefined' && typeof diceShaker.update === 'function') {
      diceShaker.update(ev.clientX, ev.clientY);
    }
  }

  _onPointerUp(ev) {
    if (!this._isDragging) return;
    this._isDragging = false;

    const btn = this.element?.querySelector('#btn-draggable-dice-roll');
    if (btn) {
      btn.classList.remove('is-dragging');
      btn.style.transform = '';
      try {
        if (typeof btn.releasePointerCapture === 'function' && this._activePointerId !== null) {
          btn.releasePointerCapture(this._activePointerId);
        }
      } catch (_) {}
    }
    this._activePointerId = null;

    const aimTrail = this.element?.querySelector('#rpm-aim-trail');
    if (aimTrail) {
      aimTrail.style.display = 'none';
    }

    const dx = ev.clientX - this._dragStart.x;
    const dy = ev.clientY - this._dragStart.y;
    const dist = Math.hypot(dx, dy);

    let throwForce = 3.2;
    if (typeof diceShaker !== 'undefined' && typeof diceShaker.release === 'function') {
      const shakeRes = diceShaker.release(ev.clientX, ev.clientY);
      throwForce = shakeRes?.throwForce || throwForce;
    } else {
      throwForce = parseFloat(Math.min(4.8, Math.max(2.8, 3.2 + dist * 0.015)).toFixed(2));
    }

    const impulse = {
      x: -dx,
      y: -dy,
      dist,
      force: throwForce
    };

    this._executeRoll(impulse);
  }

  _onPointerCancel(ev) {
    if (!this._isDragging) return;
    this._isDragging = false;
    this._activePointerId = null;

    const btn = this.element?.querySelector('#btn-draggable-dice-roll');
    if (btn) {
      btn.classList.remove('is-dragging');
      btn.style.transform = '';
    }
    const aimTrail = this.element?.querySelector('#rpm-aim-trail');
    if (aimTrail) {
      aimTrail.style.display = 'none';
    }
    if (typeof diceShaker !== 'undefined' && typeof diceShaker.cancel === 'function') {
      diceShaker.cancel();
    }
  }

  _onClickRoll(ev) {
    // If click was triggered without dragging, roll with baseline impulse
    if (this._isRolling) return;
    const dist = Math.hypot(this._dragCurrent.x - this._dragStart.x, this._dragCurrent.y - this._dragStart.y);
    if (dist < 6) {
      this._executeRoll({ x: 0, y: -100, dist: 0, force: 3.2 });
    }
  }

  _onClickSkip(ev) {
    if (this._isRolling) return;
    this._executeSkip();
  }

  _onKeyDown(ev) {
    if (!this.isOpen || this._isRolling) return;
    if (ev.key === 'Escape') {
      this._executeSkip();
    }
  }

  // ─── Roll and Skip Executions ─────────────────────────────────────────────

  async _executeRoll(impulse = { force: 3.2 }) {
    if (this._isRolling) return;
    this._isRolling = true;

    const btnRoll = this.element?.querySelector('#btn-draggable-dice-roll');
    const btnSkip = this.element?.querySelector('#btn-skip-dice-roll');
    if (btnRoll) {
      btnRoll.disabled = true;
      btnRoll.classList.add('is-rolling');
    }
    if (btnSkip) {
      btnSkip.disabled = true;
    }

    const callback = this._currentData?.callback;
    let rollResult = null;
    let settledTens = null;
    let settledOnes = null;

    const is3D = Boolean(
      this.diceCanvas &&
      typeof this.diceCanvas.is3DSupported === 'function' &&
      this.diceCanvas.is3DSupported()
    );

    if (is3D) {
      // 3D WebGL physics roll first
      try {
        const timeoutPromise = new Promise((resolve) => {
          setTimeout(() => {
            const fbTens = Math.floor(Math.random() * 10);
            const fbOnes = Math.floor(Math.random() * 10);
            resolve([fbTens, fbOnes]);
          }, 4500);
        });

        const [rawTens, rawOnes] = await Promise.race([
          this.diceCanvas.rollPercentile({ throwForce: impulse?.force || 1.0 }),
          timeoutPromise
        ]);

        settledTens = Number(rawTens) % 10;
        settledOnes = Number(rawOnes) % 10;
        const rollString = `${settledTens}${settledOnes}`;

        if (typeof callback === 'function') {
          rollResult = await Promise.resolve(callback({
            action: 'ROLL',
            roll: { tens: settledTens, ones: settledOnes, rollString },
            impulse,
            deferStep2: true
          }));
        }
      } catch (err) {
        console.warn('[RPMDiceRollOverlay] 3D roll execution error:', err);
      }
    } else {
      // 2D canvas / headless / fallback: callback generates authoritative roll
      if (typeof callback === 'function') {
        try {
          rollResult = await Promise.resolve(callback({
            action: 'ROLL',
            impulse,
            deferStep2: true
          }));
        } catch (err) {
          console.warn('[RPMDiceRollOverlay] Error executing roll callback:', err);
        }
      }
    }

    // Default fallback if no callback
    if (!rollResult || rollResult.tens === undefined) {
      const tens = settledTens !== null ? settledTens : Math.floor(Math.random() * 10);
      const ones = settledOnes !== null ? settledOnes : Math.floor(Math.random() * 10);
      rollResult = {
        tens,
        ones,
        rollString: `${tens}${ones}`,
        isMiss: true,
        queueStep2: () => null
      };
    }

    const tens = rollResult.tens;
    const ones = rollResult.ones;
    const rollString = rollResult.rollString || `${tens}${ones}`;

    // Run 2d10 visual dice animation in overlay
    const viewport = this.element?.querySelector('#rpm-overlay-dice-viewport');
    if (viewport) {
      viewport.classList.remove('throw-bounce-settle', 'throw-fast-glide');
      // Alternate animation curve
      const animClass = (tens + ones) % 2 === 0 ? 'throw-bounce-settle' : 'throw-fast-glide';
      viewport.classList.add('is-rolling', animClass);
    }

    const tensDigit = this.element?.querySelector('#overlay-tens-digit');
    const onesDigit = this.element?.querySelector('#overlay-ones-digit');
    if (tensDigit) tensDigit.textContent = String(tens);
    if (onesDigit) onesDigit.textContent = String(ones);

    // Display Result Banner
    const banner = this.element?.querySelector('#rpm-roll-result-banner');
    const bannerHeadline = this.element?.querySelector('#banner-result-headline');
    const bannerSubtext = this.element?.querySelector('#banner-result-subtext');

    if (banner && bannerHeadline && bannerSubtext) {
      banner.classList.remove('hidden', 'banner-hit', 'banner-miss');
      banner.style.display = 'block';

      if (!rollResult.isMiss && rollResult.matchedKey) {
        const perkKey = rollResult.matchedKey;
        const def = getPerkDefinition(perkKey);
        const perkName = rollResult.perkName || def?.name || `Perk #${perkKey}`;
        banner.classList.add('banner-hit');
        bannerHeadline.textContent = `🎉 PERK #[${perkKey}]: ${perkName}`;
        bannerSubtext.textContent = def?.effectDescription || 'Efecto de Perk preparado para la pila (Step 2)';
      } else {
        banner.classList.add('banner-miss');
        bannerHeadline.textContent = `💨 Roll [${rollString}] — No Match`;
        bannerSubtext.textContent = 'Sin coincidencia de perk este turno. Turno continúa normalmente.';
      }
    }

    // Retain banner for ~1.5s before closing and queuing Step 2
    this._autoCloseTimer = setTimeout(() => {
      this.close();
      if (typeof rollResult.queueStep2 === 'function') {
        try {
          rollResult.queueStep2();
        } catch (err) {
          console.warn('[RPMDiceRollOverlay] Error queuing Step 2:', err);
        }
      }
    }, this.bannerDurationMs);
  }

  _executeSkip() {
    const callback = this._currentData?.callback;
    if (typeof callback === 'function') {
      try {
        callback({ action: 'SKIP' });
      } catch (_) {}
    }
    this.close();
  }
}

export default RPMDiceRollOverlay;
