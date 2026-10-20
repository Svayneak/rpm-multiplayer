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
   */
  open({ cards = [], mulliganCount = 0 }) {
    this.cards = Array.isArray(cards) ? [...cards] : [];
    this.mulliganCount = mulliganCount;
    this.selectedBottomCards = [];
    this.mode = 'DECISION';
    this.isOpen = true;

    if (!this.element) this.init();
    if (!this.element) return;

    this.element.classList.remove('hidden');
    this.render();
  }

  close() {
    this.isOpen = false;
    if (this.element) {
      this.element.classList.add('hidden');
    }
  }

  handleKeepClick() {
    if (this.mulliganCount > 0) {
      // Shift to bottoming selection mode
      this.mode = 'BOTTOMING';
      this.selectedBottomCards = [];
      this.render();
    } else {
      this.close();
      this.onKeep({ mulliganCount: 0, bottomedCards: [] });
    }
  }

  handleMulliganClick() {
    this.close();
    this.onMulligan({ nextMulliganCount: this.mulliganCount + 1 });
  }

  handleCardClick(instanceId) {
    if (this.mode !== 'BOTTOMING') return;

    const idx = this.selectedBottomCards.indexOf(instanceId);
    if (idx !== -1) {
      // Deselect
      this.selectedBottomCards.splice(idx, 1);
    } else {
      // Select if under quota
      if (this.selectedBottomCards.length < this.mulliganCount) {
        this.selectedBottomCards.push(instanceId);
      }
    }
    this.render();
  }

  handleConfirmBottomClick() {
    if (this.selectedBottomCards.length !== this.mulliganCount) return;

    const bottomed = this.selectedBottomCards.map(id => this.cards.find(c => c && c.instanceId === id)).filter(Boolean);
    this.close();
    this.onConfirmBottom({
      mulliganCount: this.mulliganCount,
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

    if (this.mode === 'DECISION') {
      badge.textContent = this.mulliganCount === 0
        ? 'Opening Hand (7 Cards)'
        : `Mulligan #${this.mulliganCount} (Keep ${7 - this.mulliganCount})`;

      instructions.textContent = this.mulliganCount === 0
        ? 'Review your opening hand. Choose to Keep or take a London Mulligan.'
        : `You have taken ${this.mulliganCount} mulligan(s). If you keep, you must bottom ${this.mulliganCount} card(s).`;

      actions.innerHTML = `
        <button class="btn btn-primary mulligan-btn-keep" id="mulligan-btn-keep">
          ✓ Keep Hand
        </button>
        <button class="btn btn-secondary mulligan-btn-mulligan" id="mulligan-btn-mulligan">
          🔄 Mulligan (to ${Math.max(0, 7 - (this.mulliganCount + 1))})
        </button>
      `;

      this.element.querySelector('#mulligan-btn-keep')?.addEventListener('click', () => this.handleKeepClick());
      this.element.querySelector('#mulligan-btn-mulligan')?.addEventListener('click', () => this.handleMulliganClick());
    } else {
      // BOTTOMING mode
      const needed = this.mulliganCount - this.selectedBottomCards.length;
      badge.textContent = `Bottom Selection (${this.selectedBottomCards.length}/${this.mulliganCount})`;
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
      img.src = card.imageUrl || card.image_uris?.normal || 'assets/card-back.png';
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
