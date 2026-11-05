/**
 * MulliganModal.js - Pre-Game London Mulligan Dialog Component
 * 
 * Part of RPM Multiplayer - Feature 21
 * Specification: SPEC-RPM-RULES-ENGINE-021 (INV-MULLIGAN-1)
 * 
 * Implements:
 * - Pre-game 7-card inspection grid
 * - Keep Hand vs. Mulligan decisions
 * - Bottoming selection HUD with ordered `#1`, `#2` badges for $N$ cards
 * - Touch & keyboard accessible (Esc/Enter)
 * 
 * @module MulliganModal
 */

export class MulliganModal {
  /**
   * @param {Object} [options={}]
   * @param {HTMLElement} [options.container]
   * @param {Function} [options.onKeep]
   * @param {Function} [options.onMulligan]
   * @param {Function} [options.onConfirmBottom]
   */
  constructor(options = {}) {
    this.container = options.container || (typeof document !== 'undefined' ? document.body : null);
    this.onKeep = options.onKeep || (() => {});
    this.onMulligan = options.onMulligan || (() => {});
    this.onConfirmBottom = options.onConfirmBottom || (() => {});

    this.isOpen = false;
    this.element = null;
    this.cards = [];
    this.mulliganCount = 0;
    this.cardsToBottomCount = null;
    this.mode = 'DECISION'; // 'DECISION' | 'BOTTOMING'
    this.selectedBottomCards = []; // Array of instanceIds in bottoming order

    if (typeof document !== 'undefined') {
      this.init();
    }
  }

  init() {
    if (this.element || !this.container) return;

    this.element = document.createElement('div');
    this.element.className = 'mulligan-modal-backdrop hidden';
    this.element.style.display = 'none';
    this.element.id = 'mulligan-modal';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', 'London Mulligan');

    this.element.innerHTML = `
      <div class="mulligan-modal-panel">
        <div class="mulligan-modal-header">
          <div class="mulligan-title-wrap">
            <h2 class="mulligan-title" id="mulligan-title">Pre-Game London Mulligan</h2>
            <span class="mulligan-badge" id="mulligan-badge">Hand: 7 Cards</span>
          </div>
          <p class="mulligan-instructions" id="mulligan-instructions">
            Review your opening hand. Choose to Keep or take a Mulligan.
          </p>
        </div>

        <div class="mulligan-cards-grid" id="mulligan-cards-grid"></div>

        <div class="mulligan-actions" id="mulligan-actions">
          <button class="btn btn-primary mulligan-btn-keep" id="mulligan-btn-keep">
            ✓ Keep Hand
          </button>
          <button class="btn btn-secondary mulligan-btn-mulligan" id="mulligan-btn-mulligan">
            🔄 Mulligan
          </button>
        </div>
      </div>
    `;

    this.container.appendChild(this.element);

    // Event listeners
    const keepBtn = this.element.querySelector('#mulligan-btn-keep');
    const mulliganBtn = this.element.querySelector('#mulligan-btn-mulligan');

    keepBtn?.addEventListener('click', () => this.handleKeepClick());
    mulliganBtn?.addEventListener('click', () => this.handleMulliganClick());
  }

  /**
   * Opens the modal with 7 drawn cards.
   * 
   * @param {Object} payload
   * @param {Array<Object>} payload.cards
   * @param {number} [payload.mulliganCount=0]
   * @param {number} [payload.cardsToBottomCount]
   */
  open({ cards = [], mulliganCount = 0, cardsToBottomCount } = {}) {
    this.cards = Array.isArray(cards) ? [...cards] : [];
    this.mulliganCount = mulliganCount;
    this.cardsToBottomCount = typeof cardsToBottomCount === 'number' ? cardsToBottomCount : null;
    this.selectedBottomCards = [];
    this.mode = 'DECISION';
    this.isOpen = true;

    if (!this.element) this.init();
    if (!this.element) return;

    if (!this.element.parentNode) {
      const target = this.container || (typeof document !== 'undefined' ? document.body : null);
      if (target && typeof target.appendChild === 'function') {
        target.appendChild(this.element);
      }
    }

    this.element.style.display = 'flex';
    this.element.classList.remove('hidden');
    this.render();
  }

  _getRequiredBottomCount() {
    return typeof this.cardsToBottomCount === 'number' ? this.cardsToBottomCount : this.mulliganCount;
  }

  close() {
    this.isOpen = false;
    if (this.element) {
      this.element.style.display = 'none';
      this.element.classList.add('hidden');
    }
  }

  handleKeepClick() {
    const requiredBottom = this._getRequiredBottomCount();
    if (requiredBottom > 0) {
      // Shift to bottoming selection mode
      this.mode = 'BOTTOMING';
      this.selectedBottomCards = [];
      this.render();
    } else {
      this.close();
      this.onKeep({ mulliganCount: this.mulliganCount, bottomedCards: [] });
    }
  }

  handleMulliganClick() {
    this.close();
    this.onMulligan({ nextMulliganCount: this.mulliganCount + 1 });
  }

  handleCardClick(instanceId) {
    if (this.mode !== 'BOTTOMING') return;

    const requiredBottom = this._getRequiredBottomCount();
    const idx = this.selectedBottomCards.indexOf(instanceId);
    if (idx !== -1) {
      // Deselect
      this.selectedBottomCards.splice(idx, 1);
    } else {
      // Select if under quota
      if (this.selectedBottomCards.length < requiredBottom) {
        this.selectedBottomCards.push(instanceId);
      }
    }
    this.render();
  }

  handleConfirmBottomClick() {
    const requiredBottom = this._getRequiredBottomCount();
    if (this.selectedBottomCards.length !== requiredBottom) return;

    const bottomed = this.selectedBottomCards.map(id => this.cards.find(c => c && c.instanceId === id)).filter(Boolean);
    this.close();
    this.onConfirmBottom({
      mulliganCount: this.mulliganCount,
      cardsToBottomCount: requiredBottom,
      bottomedCards: bottomed
    });
  }

  render() {
    if (!this.element) return;

    const badge = this.element.querySelector('#mulligan-badge');
    const instructions = this.element.querySelector('#mulligan-instructions');
    const grid = this.element.querySelector('#mulligan-cards-grid');
    const actions = this.element.querySelector('#mulligan-actions');

    if (!grid || !actions) return;

    const requiredBottom = this._getRequiredBottomCount();
    const isFreeFirst = this.mulliganCount > requiredBottom;
    const nextKeepSize = Math.max(0, 7 - (isFreeFirst ? requiredBottom + 1 : this.mulliganCount + 1));

    if (this.mode === 'DECISION') {
      badge.textContent = this.mulliganCount === 0
        ? 'Opening Hand (7 Cards)'
        : `Mulligan #${this.mulliganCount} (Keep ${7 - requiredBottom})`;

      instructions.textContent = this.mulliganCount === 0
        ? 'Review your opening hand. Choose to Keep or take a London Mulligan.'
        : (requiredBottom === 0
          ? `Free Multiplayer Mulligan #${this.mulliganCount} (CR 103.5c): You may keep all 7 cards without bottoming.`
          : `You have taken ${this.mulliganCount} mulligan(s). If you keep, you must bottom ${requiredBottom} card(s).`);

      actions.innerHTML = `
        <button class="btn btn-primary mulligan-btn-keep" id="mulligan-btn-keep">
          ✓ Keep Hand
        </button>
        <button class="btn btn-secondary mulligan-btn-mulligan" id="mulligan-btn-mulligan">
          🔄 Mulligan (to ${nextKeepSize})
        </button>
      `;

      this.element.querySelector('#mulligan-btn-keep')?.addEventListener('click', () => this.handleKeepClick());
      this.element.querySelector('#mulligan-btn-mulligan')?.addEventListener('click', () => this.handleMulliganClick());
    } else {
      // BOTTOMING mode
      const needed = requiredBottom - this.selectedBottomCards.length;
      badge.textContent = `Bottom Selection (${this.selectedBottomCards.length}/${requiredBottom})`;
      instructions.textContent = needed > 0
        ? `Select ${needed} more card(s) to place on the bottom of your library in order.`
        : 'All cards selected. Click Confirm to place them on the bottom of your library.';

      actions.innerHTML = `
        <button class="btn btn-primary" id="mulligan-btn-confirm" ${needed > 0 ? 'disabled' : ''}>
          ✓ Confirm Bottom Cards
        </button>
        <button class="btn btn-secondary" id="mulligan-btn-back">
          ← Back
        </button>
      `;

      this.element.querySelector('#mulligan-btn-confirm')?.addEventListener('click', () => this.handleConfirmBottomClick());
      this.element.querySelector('#mulligan-btn-back')?.addEventListener('click', () => {
        this.mode = 'DECISION';
        this.render();
      });
    }

    // Render Cards Grid
    grid.innerHTML = '';
    for (const card of this.cards) {
      const cardEl = document.createElement('div');
      cardEl.className = 'mulligan-card-item';
      cardEl.dataset.instanceId = card.instanceId;

      const isBottomSelected = this.selectedBottomCards.includes(card.instanceId);
      if (isBottomSelected) {
        cardEl.classList.add('selected-bottom');
        const orderNum = this.selectedBottomCards.indexOf(card.instanceId) + 1;
        const badgeEl = document.createElement('div');
        badgeEl.className = 'bottom-order-badge';
        badgeEl.textContent = `#${orderNum}`;
        cardEl.appendChild(badgeEl);
      }

      const img = document.createElement('img');
      img.className = 'mulligan-card-img';
      const safeTitle = String(card.name || 'MTG').replace(/[<>&'"]/g, '');
      const fallbackSvg = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='308' viewBox='0 0 220 308'><rect width='220' height='308' rx='12' fill='%231e293b' stroke='%23475569' stroke-width='4'/><circle cx='110' cy='140' r='40' fill='%230f172a' stroke='%2338bdf8' stroke-width='3'/><text x='110' y='145' text-anchor='middle' fill='%2338bdf8' font-family='sans-serif' font-size='14' font-weight='bold'>MTG</text><text x='110' y='225' text-anchor='middle' fill='%23f8fafc' font-family='sans-serif' font-size='13' font-weight='bold'>${encodeURIComponent(safeTitle)}</text></svg>`;
      img.onerror = () => {
        img.onerror = null;
        img.src = fallbackSvg;
      };
      img.src = card.imageUri || card.imageUrl || card.image_uris?.normal || card.image_uris?.small || fallbackSvg;
      img.alt = card.name || 'Card';
      cardEl.appendChild(img);

      const nameLabel = document.createElement('div');
      nameLabel.className = 'mulligan-card-name';
      nameLabel.textContent = card.name || 'Unknown';
      cardEl.appendChild(nameLabel);

      cardEl.addEventListener('click', () => this.handleCardClick(card.instanceId));
      grid.appendChild(cardEl);
    }
  }
}

export default MulliganModal;
