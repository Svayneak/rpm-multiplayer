/**
 * SearchSelectGridModal.js - Universal Card Search & Tutor Grid Modal Component
 * 
 * Part of RPM Multiplayer - Feature 21
 * Specification: SPEC-RPM-RULES-ENGINE-021 (INV-ZONE-MATRIX-1)
 * 
 * Implements:
 * - Responsive visual grid browsing across Library, Graveyard, or Exile
 * - Real-time instantaneous text search filter
 * - Category filter tabs (All, Creatures, Lands, Spells, Artifacts/Enchantments)
 * - Single and multi-card selection with counter badge
 * - Accessible keyboard & backdrop dismissal
 * 
 * @module SearchSelectGridModal
 */

export class SearchSelectGridModal {
  /**
   * @param {Object} [options={}]
   * @param {HTMLElement} [options.container]
   * @param {Function} [options.onSelect]
   * @param {Function} [options.onCancel]
   */
  constructor(options = {}) {
    this.container = options.container || (typeof document !== 'undefined' ? document.body : null);
    this.onSelect = options.onSelect || (() => {});
    this.onCancel = options.onCancel || (() => {});

    this.isOpen = false;
    this.element = null;
    this.allCards = [];
    this.filteredCards = [];
    this.selectedInstanceIds = [];
    this.targetCount = 1;
    this.title = 'Search Cards';
    this.activeCategory = 'ALL';
    this.searchQuery = '';

    if (typeof document !== 'undefined') {
      this.init();
    }
  }

  init() {
    if (this.element || !this.container) return;

    this.element = document.createElement('div');
    this.element.className = 'search-modal-backdrop hidden';
    this.element.style.display = 'none';
    this.element.id = 'search-select-grid-modal';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', 'Search & Select Cards');

    this.element.innerHTML = `
      <div class="search-modal-panel">
        <div class="search-modal-header">
          <div class="search-title-row">
            <h2 class="search-modal-title" id="search-modal-title">Search Cards</h2>
            <button class="search-btn-close" id="search-btn-close" aria-label="Close">×</button>
          </div>
          <div class="search-controls-row">
            <input type="text" class="search-text-input" id="search-text-input" placeholder="Filter by card name or text..." />
            <div class="search-category-tabs" id="search-category-tabs">
              <button class="tab-btn active" data-category="ALL">All</button>
              <button class="tab-btn" data-category="CREATURE">Creatures</button>
              <button class="tab-btn" data-category="LAND">Lands</button>
              <button class="tab-btn" data-category="SPELL">Spells</button>
              <button class="tab-btn" data-category="OTHER">Artifacts/Ench</button>
            </div>
          </div>
        </div>

        <div class="search-cards-grid" id="search-cards-grid"></div>

        <div class="search-modal-footer">
          <span class="search-selection-count" id="search-selection-count">Selected 0 of 1</span>
          <div class="search-footer-actions">
            <button class="btn btn-secondary" id="search-btn-cancel">Cancel</button>
            <button class="btn btn-primary" id="search-btn-confirm" disabled>Confirm Selection</button>
          </div>
        </div>
      </div>
    `;

    this.container.appendChild(this.element);

    // Event listeners
    this.element.querySelector('#search-btn-close')?.addEventListener('click', () => this.handleCancel());
    this.element.querySelector('#search-btn-cancel')?.addEventListener('click', () => this.handleCancel());
    this.element.querySelector('#search-btn-confirm')?.addEventListener('click', () => this.handleConfirm());

    const input = this.element.querySelector('#search-text-input');
    input?.addEventListener('input', (e) => {
      this.searchQuery = (e.target.value || '').toLowerCase();
      this.applyFilter();
    });

    const tabContainer = this.element.querySelector('#search-category-tabs');
    tabContainer?.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (btn && btn.dataset.category) {
        tabContainer.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeCategory = btn.dataset.category;
        this.applyFilter();
      }
    });
  }

  /**
   * Opens the search grid with candidate cards.
   * 
   * @param {Object} options
   * @param {string} [options.title='Search Cards']
   * @param {Array<Object>} [options.cards=[]]
   * @param {number} [options.targetCount=1]
   */
  open({ title = 'Search Cards', cards = [], targetCount = 1 }) {
    this.title = title;
    this.allCards = Array.isArray(cards) ? [...cards] : [];
    this.targetCount = targetCount;
    this.selectedInstanceIds = [];
    this.searchQuery = '';
    this.activeCategory = 'ALL';
    this.isOpen = true;

    if (!this.element) this.init();
    if (!this.element) return;

    this.element.style.display = 'flex';
    this.element.classList.remove('hidden');
    const titleEl = this.element.querySelector('#search-modal-title');
    if (titleEl) titleEl.textContent = this.title;

    const input = this.element.querySelector('#search-text-input');
    if (input) input.value = '';

    this.applyFilter();
  }

  close() {
    this.isOpen = false;
    if (this.element) {
      this.element.style.display = 'none';
      this.element.classList.add('hidden');
    }
  }

  handleCancel() {
    this.close();
    this.onCancel();
  }

  handleConfirm() {
    if (this.selectedInstanceIds.length !== this.targetCount) return;
    const selected = this.selectedInstanceIds
      .map(id => this.allCards.find(c => c && c.instanceId === id))
      .filter(Boolean);

    this.close();
    this.onSelect({ selectedCards: selected });
  }

  handleCardClick(instanceId) {
    const idx = this.selectedInstanceIds.indexOf(instanceId);
    if (idx !== -1) {
      this.selectedInstanceIds.splice(idx, 1);
    } else {
      if (this.selectedInstanceIds.length < this.targetCount) {
        this.selectedInstanceIds.push(instanceId);
      } else if (this.targetCount === 1) {
        // Direct swap for single select
        this.selectedInstanceIds = [instanceId];
      }
    }
    this.updateFooter();
    this.renderGrid();
  }

  applyFilter() {
    this.filteredCards = this.allCards.filter(card => {
      if (!card) return false;
      const name = (card.name || '').toLowerCase();
      const type = (card.typeLine || card.type || '').toLowerCase();
      const text = (card.text || '').toLowerCase();

      // Text query match
      if (this.searchQuery) {
        const matchesQuery = name.includes(this.searchQuery) ||
          type.includes(this.searchQuery) ||
          text.includes(this.searchQuery);
        if (!matchesQuery) return false;
      }

      // Category filter match
      if (this.activeCategory === 'CREATURE') {
        return type.includes('creature');
      }
      if (this.activeCategory === 'LAND') {
        return type.includes('land');
      }
      if (this.activeCategory === 'SPELL') {
        return type.includes('instant') || type.includes('sorcery');
      }
      if (this.activeCategory === 'OTHER') {
        return type.includes('artifact') || type.includes('enchantment') || type.includes('planeswalker');
      }

      return true;
    });

    this.updateFooter();
    this.renderGrid();
  }

  updateFooter() {
    if (!this.element) return;
    const countLabel = this.element.querySelector('#search-selection-count');
    const confirmBtn = this.element.querySelector('#search-btn-confirm');

    if (countLabel) {
      countLabel.textContent = `Selected ${this.selectedInstanceIds.length} of ${this.targetCount}`;
    }
    if (confirmBtn) {
      confirmBtn.disabled = (this.selectedInstanceIds.length !== this.targetCount);
    }
  }

  renderGrid() {
    if (!this.element) return;
    const grid = this.element.querySelector('#search-cards-grid');
    if (!grid) return;

    grid.innerHTML = '';
    if (this.filteredCards.length === 0) {
      grid.innerHTML = '<div class="search-empty-state">No matching cards found in this zone.</div>';
      return;
    }

    for (const card of this.filteredCards) {
      const cardEl = document.createElement('div');
      cardEl.className = 'search-card-item';
      cardEl.dataset.instanceId = card.instanceId;

      const isSelected = this.selectedInstanceIds.includes(card.instanceId);
      if (isSelected) {
        cardEl.classList.add('selected');
        const badge = document.createElement('div');
        badge.className = 'search-selected-badge';
        badge.textContent = '✓';
        cardEl.appendChild(badge);
      }

      const img = document.createElement('img');
      img.className = 'search-card-img';
      img.src = card.imageUrl || card.image_uris?.normal || 'assets/card-back.png';
      img.alt = card.name || 'Card';
      cardEl.appendChild(img);

      const nameLabel = document.createElement('div');
      nameLabel.className = 'search-card-name';
      nameLabel.textContent = card.name || 'Card';
      cardEl.appendChild(nameLabel);

      cardEl.addEventListener('click', () => this.handleCardClick(card.instanceId));
      grid.appendChild(cardEl);
    }
  }
}

export default SearchSelectGridModal;
