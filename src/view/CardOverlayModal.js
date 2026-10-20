/**
 * CardOverlayModal.js
 * Scryfall Card Overlay Modal Component
 * 
 * Accessible, high-resolution card inspection modal for RPM Tabletop UI.
 * Features vector mana-glyph typography, dark-theme styling, format legality badge,
 * and multi-trigger dismissal (backdrop tap, close button, Escape key).
 * 
 * Part of RPM Multiplayer - Feature 7
 * Document ID: SPEC-RPM-UI-007
 * 
 * @module CardOverlayModal
 */

import { ScryfallService } from '../ScryfallService.js';
import { getHydratedCardMetadata } from '../DeckbuilderAI.js';

/**
 * Formats a Scryfall/MTG mana cost string into andrewgioia/mana vector glyph HTML tags.
 * Example: "{2}{U}{U}" -> '<i class="ms ms-2 ms-cost"></i><i class="ms ms-u ms-cost"></i><i class="ms ms-u ms-cost"></i>'
 * 
 * @param {string} costString Raw mana cost string e.g. "{1}{R}"
 * @returns {string} Sanitized HTML string of <i> vector glyphs
 */
export function formatManaSymbols(costString) {
  if (!costString || typeof costString !== 'string') return '';
  return costString.replace(/\{([A-Za-z0-9\/\-]+)\}/g, (_match, rawSymbol) => {
    const symbol = rawSymbol.toLowerCase().replace(/[\/\-]/g, '');
    let glyphClass = symbol;
    if (symbol === 't') glyphClass = 'tap';
    else if (symbol === 'q') glyphClass = 'untap';
    // Validate character safety to prevent XSS
    if (!/^[a-z0-9]+$/.test(glyphClass)) {
      return '';
    }
    return `<i class="ms ms-${glyphClass} ms-cost"></i>`;
  });
}

/**
 * High-resolution Scryfall Card Preview Modal Component
 */
export class CardOverlayModal {
  /**
   * @param {Object} [options={}]
   * @param {HTMLElement} [options.container] DOM container to attach the modal to
   * @param {Function} [options.onClose] Callback invoked when the modal is closed
   */
  constructor(options = {}) {
    this.container = options.container || null;
    this.onClose = options.onClose || null;
    this.scryfallService = options.scryfallService || new ScryfallService({ cacheAdapter: options.storageAdapter });
    this.element = null;
    this.isOpen = false;
    this._previouslyFocusedElement = null;

    this._boundKeyDown = this._handleKeyDown.bind(this);
    this._boundBackdropClick = this._handleBackdropClick.bind(this);

    this.init();

    if (this.container && typeof this.container.appendChild === 'function') {
      this.mount(this.container);
    }
  }

  /**
   * Builds the modal DOM structure
   */
  init() {
    if (typeof document === 'undefined') return;

    const backdrop = document.createElement('div');
    backdrop.id = 'card-overlay-modal';
    backdrop.className = 'modal-backdrop hidden';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'modal-card-name');

    backdrop.innerHTML = `
      <div class="modal-card-dialog">
        <button class="modal-close-btn" aria-label="Close modal">&times;</button>
        <div class="modal-card-layout">
          <div class="modal-image-col">
            <div class="modal-image-wrapper">
              <img class="modal-card-image modal-card-art" src="" alt="Card Art" loading="eager" />
              <div class="modal-image-spinner hidden"></div>
            </div>
          </div>
          <div class="modal-details-col">
            <div class="modal-header-row">
              <h2 id="modal-card-name" class="modal-card-name"></h2>
              <div class="modal-mana-cost"></div>
            </div>
            <div class="modal-typeline modal-card-typeline"></div>
            <hr class="modal-divider" />
            <div class="modal-oracle-text modal-card-oracle"></div>
            <div class="modal-stats-row modal-card-stats">
              <div class="modal-pt-loyalty"></div>
            </div>
            <div class="modal-footer-row">
              <span class="modal-badge badge-modern-legal">Modern Legal</span>
              <span class="modal-set-info"></span>
            </div>
          </div>
        </div>
      </div>
    `.trim();

    backdrop.addEventListener('click', this._boundBackdropClick);

    const closeBtn = backdrop.querySelector('.modal-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hide();
      });
    }

    // Stop clicks inside the dialog from propagating to the backdrop
    const dialog = backdrop.querySelector('.modal-card-dialog');
    if (dialog) {
      dialog.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    this.element = backdrop;
  }

  /**
   * Mounts modal to a parent DOM node
   * @param {HTMLElement} container 
   */
  mount(container) {
    if (!container || !this.element) return;
    this.container = container;
    if (this.element.parentNode !== container) {
      container.appendChild(this.element);
    }
  }

  /**
   * Displays modal with hydrated card details
   * @param {Object} cardData
   */
  show(cardData = {}) {
    if (!this.element) {
      this.init();
    }

    // Ensure attached to DOM
    if (!this.element.parentNode) {
      const target = this.container || (typeof document !== 'undefined' ? document.body : null);
      if (target && typeof target.appendChild === 'function') {
        target.appendChild(this.element);
      }
    }

    if (typeof document !== 'undefined' && document.activeElement) {
      this._previouslyFocusedElement = document.activeElement;
    }

    const dialog = this.element.querySelector('.modal-card-dialog');
    const spinner = this.element.querySelector('.modal-image-spinner');

    const renderData = (data) => {
      if (!this.element) return;
      // Populate Card Name
      const nameEl = this.element.querySelector('.modal-card-name');
      if (nameEl) {
        nameEl.textContent = data.name || 'Unknown Card';
      }

      // Populate Mana Cost Glyphs
      const manaCostEl = this.element.querySelector('.modal-mana-cost');
      if (manaCostEl) {
        if (data.manaCost) {
          manaCostEl.innerHTML = formatManaSymbols(data.manaCost);
          manaCostEl.style.display = '';
        } else {
          manaCostEl.innerHTML = '';
          manaCostEl.style.display = 'none';
        }
      }

      // Populate Typeline
      const typelineEl = this.element.querySelector('.modal-typeline');
      if (typelineEl) {
        typelineEl.textContent = data.typeLine || '';
      }

      // Populate Oracle Rules Text
      const oracleEl = this.element.querySelector('.modal-oracle-text');
      if (oracleEl) {
        oracleEl.textContent = data.oracleText || '';
      }

      // Populate High-Res Card Art
      const imgEl = this.element.querySelector('.modal-card-image');
      if (imgEl) {
        if (data.imageUri) {
          imgEl.src = data.imageUri;
          imgEl.alt = data.name || 'Card art';
          imgEl.style.display = '';
        } else {
          imgEl.src = '';
          imgEl.alt = '';
          imgEl.style.display = 'none';
        }
      }

      // Populate Stats Row (P/T or Loyalty)
      const statsRow = this.element.querySelector('.modal-stats-row');
      const ptLoyaltyEl = this.element.querySelector('.modal-pt-loyalty');
      if (statsRow && ptLoyaltyEl) {
        if (data.power !== undefined && data.toughness !== undefined) {
          ptLoyaltyEl.textContent = `${data.power} / ${data.toughness}`;
          statsRow.style.display = '';
        } else if (data.loyalty !== undefined && data.loyalty !== null) {
          ptLoyaltyEl.textContent = `Loyalty: ${data.loyalty}`;
          statsRow.style.display = '';
        } else {
          ptLoyaltyEl.textContent = '';
          statsRow.style.display = 'none';
        }
      }

      // Populate Modern Legal Badge
      const legalBadge = this.element.querySelector('.badge-modern-legal');
      if (legalBadge) {
        if (data.modernLegal !== false) {
          legalBadge.style.display = '';
        } else {
          legalBadge.style.display = 'none';
        }
      }

      // Populate Set & Collector Info
      const setInfoEl = this.element.querySelector('.modal-set-info');
      if (setInfoEl) {
        const parts = [];
        if (data.set) parts.push(data.set.toUpperCase());
        if (data.collectorNumber) parts.push(`#${data.collectorNumber}`);
        if (data.rarity) parts.push(data.rarity.charAt(0).toUpperCase() + data.rarity.slice(1));
        setInfoEl.textContent = parts.join(' · ');
      }
    };

    // First render with provided data
    renderData(cardData);

    const hasRichArt = Boolean(cardData.imageUri && cardData.oracleText);

    if (hasRichArt) {
      if (dialog) dialog.classList.remove('card-modal-skeleton-shimmer');
      if (spinner) spinner.classList.add('hidden');
    } else {
      // Show skeleton loader (INV-INSPECT-1)
      if (dialog) dialog.classList.add('card-modal-skeleton-shimmer');
      if (spinner) spinner.classList.remove('hidden');

      if (cardData.name && this.scryfallService && typeof this.scryfallService.fetchCardByName === 'function') {
        this.fetchPromise = this.scryfallService.fetchCardByName(cardData.name)
          .then((fetched) => {
            if (fetched) {
              Object.assign(cardData, fetched);
              renderData(cardData);
            }
          })
          .catch((err) => {
            console.warn('[CardOverlayModal] Failed to fetch card metadata:', err);
          })
          .finally(() => {
            if (dialog) dialog.classList.remove('card-modal-skeleton-shimmer');
            if (spinner) spinner.classList.add('hidden');
          });
      }
    }

    // Make modal visible
    this.element.classList.remove('hidden');
    this.element.classList.add('visible');
    this.isOpen = true;

    // Attach Escape listener
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', this._boundKeyDown);
    }

    // Focus close button for accessibility
    const closeBtn = this.element.querySelector('.modal-close-btn');
    if (closeBtn && typeof closeBtn.focus === 'function') {
      closeBtn.focus();
    }

    return this.fetchPromise || Promise.resolve();
  }

  /**
   * Alias for show()
   * @param {Object} cardData
   */
  open(cardData) {
    return this.show(cardData);
  }

  /**
   * Hides the modal and restores focus
   */
  hide() {
    if (!this.element) return;

    this.element.classList.remove('visible');
    this.element.classList.add('hidden');
    this.isOpen = false;

    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', this._boundKeyDown);
    }

    if (this._previouslyFocusedElement && typeof this._previouslyFocusedElement.focus === 'function') {
      this._previouslyFocusedElement.focus();
    }

    if (typeof this.onClose === 'function') {
      this.onClose();
    }
  }

  /**
   * Alias for hide()
   */
  close() {
    return this.hide();
  }

  /**
   * Handles keyboard dismissal and focus trapping
   * @param {KeyboardEvent} event
   * @private
   */
  _handleKeyDown(event) {
    if (event.key === 'Escape' || event.keyCode === 27) {
      this.hide();
      return;
    }

    // Modal Focus Isolation: Trap Tab navigation within modal dialog
    if (event.key === 'Tab') {
      const dialog = this.element?.querySelector('.modal-card-dialog');
      if (!dialog) return;

      const buttons = dialog.querySelectorAll('button');
      const inputs = dialog.querySelectorAll('input');
      const focusables = [...buttons, ...inputs].filter(el => !el.disabled);
      if (focusables.length === 0) return;

      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];

      if (event.shiftKey) {
        if (typeof document !== 'undefined' && document.activeElement === firstEl) {
          event.preventDefault?.();
          lastEl.focus?.();
        }
      } else {
        if (typeof document !== 'undefined' && document.activeElement === lastEl) {
          event.preventDefault?.();
          firstEl.focus?.();
        }
      }
    }
  }

  /**
   * Handles backdrop click dismissal
   * @param {MouseEvent} event
   * @private
   */
  _handleBackdropClick(event) {
    if (event.target === this.element) {
      this.hide();
    }
  }

  /**
   * Clean up and remove from DOM
   */
  destroy() {
    this.hide();
    if (this.element) {
      this.element.removeEventListener('click', this._boundBackdropClick);
      if (this.element.parentNode) {
        this.element.parentNode.removeChild(this.element);
      }
      this.element = null;
    }
  }
}
