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
import { auditCardClauses, registerCustomCardBindings, CUSTOM_BINDINGS_STORAGE_KEY } from '../OracleEffectCompiler.js';

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
            <div class="hook-binder-panel" id="modal-hook-binder" style="display: none;"></div>
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

      // Populate Hook Binder Panel (INV-CLAUSE-AUDIT)
      const hookBinderEl = this.element.querySelector('#modal-hook-binder');
      if (hookBinderEl) {
        try {
          const audit = auditCardClauses(data);
          if (audit && audit.clauses && audit.clauses.length > 0) {
            hookBinderEl.style.display = 'block';
            let clausesHtml = '';
            for (const cl of audit.clauses) {
              const isBound = cl.status === 'BOUND';
              clausesHtml += `
                <div class="hook-binder-clause" data-index="${cl.index}">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <span class="${isBound ? 'hook-badge-bound' : 'hook-badge-unbound'}">${isBound ? '🟢 Bound' : '🔴 Unbound'}</span>
                    <span style="font-size:0.7rem; color:#94a3b8;">${cl.source || 'Engine'}</span>
                  </div>
                  <div style="font-style:italic; margin-bottom:6px; color:#cbd5e1; font-size:0.8rem;">"${cl.clauseText}"</div>
                  <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                    <label style="font-size:0.7rem; color:#94a3b8;">Trigger:
                      <select class="hook-trigger-select" data-clause-idx="${cl.index}" style="background:#0f172a; color:#f8fafc; border:1px solid #475569; border-radius:3px; font-size:0.75rem; padding:2px;">
                        <option value="NONE" ${cl.trigger === 'NONE' ? 'selected' : ''}>NONE / STATIC</option>
                        <option value="ON_ENTER_BATTLEFIELD" ${cl.trigger === 'ON_ENTER_BATTLEFIELD' ? 'selected' : ''}>ON_ENTER_BATTLEFIELD</option>
                        <option value="ON_END_STEP" ${cl.trigger === 'ON_END_STEP' ? 'selected' : ''}>ON_END_STEP</option>
                        <option value="ON_LIFE_GAINED" ${cl.trigger === 'ON_LIFE_GAINED' ? 'selected' : ''}>ON_LIFE_GAINED</option>
                        <option value="ON_ATTACK" ${cl.trigger === 'ON_ATTACK' ? 'selected' : ''}>ON_ATTACK</option>
                        <option value="ON_ANOTHER_CREATURE_ETB" ${cl.trigger === 'ON_ANOTHER_CREATURE_ETB' ? 'selected' : ''}>ON_ANOTHER_CREATURE_ETB</option>
                        <option value="ON_UPKEEP" ${cl.trigger === 'ON_UPKEEP' ? 'selected' : ''}>ON_UPKEEP</option>
                      </select>
                    </label>
                    <label style="font-size:0.7rem; color:#94a3b8;">Effect:
                      <select class="hook-primitive-select" data-clause-idx="${cl.index}" style="background:#0f172a; color:#f8fafc; border:1px solid #475569; border-radius:3px; font-size:0.75rem; padding:2px;">
                        <option value="NOOP" ${cl.primitive === 'NOOP' ? 'selected' : ''}>STATIC / NOOP</option>
                        <option value="CREATE_CREATURE_TOKENS" ${cl.primitive === 'CREATE_CREATURE_TOKENS' ? 'selected' : ''}>CREATE_CREATURE_TOKENS</option>
                        <option value="GAIN_LIFE" ${cl.primitive === 'GAIN_LIFE' ? 'selected' : ''}>GAIN_LIFE</option>
                        <option value="DRAW_CARDS" ${cl.primitive === 'DRAW_CARDS' ? 'selected' : ''}>DRAW_CARDS</option>
                        <option value="LEVEL_UP_CLASS" ${cl.primitive === 'LEVEL_UP_CLASS' ? 'selected' : ''}>LEVEL_UP_CLASS</option>
                        <option value="PROTECTION_CHOICE" ${cl.primitive === 'PROTECTION_CHOICE' ? 'selected' : ''}>PROTECTION_CHOICE</option>
                      </select>
                    </label>
                    <button type="button" class="btn btn-xs btn-save-hook" data-clause-idx="${cl.index}" style="background:#2563eb; color:#fff; border:none; border-radius:3px; padding:2px 8px; cursor:pointer; font-size:0.75rem;">💾 Guardar Regla en Motor</button>
                  </div>
                </div>
              `;
            }
            hookBinderEl.innerHTML = `
              <div class="hook-binder-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; border-bottom:1px solid #334155; padding-bottom:6px;">
                <strong style="color:#e2e8f0; font-size:0.85rem;">⚙️ Hooks & Clauses (${audit.boundClauses.length}/${audit.totalClauses})</strong>
                <span style="font-size:0.75rem; color:${audit.isFullyAutomated ? '#4ade80' : '#f87171'}; font-weight:bold;">${audit.supportPercent}% Certified</span>
              </div>
              <div class="hook-binder-clauses-list">${clausesHtml}</div>
            `;

            // Attach listener for save buttons
            const saveButtons = hookBinderEl.querySelectorAll('.btn-save-hook');
            saveButtons.forEach(btn => {
              btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-clause-idx'), 10);
                const targetClause = audit.clauses.find(c => c.index === idx);
                if (!targetClause) return;
                const trigSel = hookBinderEl.querySelector(`.hook-trigger-select[data-clause-idx="${idx}"]`);
                const primSel = hookBinderEl.querySelector(`.hook-primitive-select[data-clause-idx="${idx}"]`);
                const chosenTrigger = trigSel?.value || targetClause.trigger || 'NONE';
                const chosenPrimitive = primSel?.value || targetClause.primitive || 'NOOP';
                const cName = (data.name || '').toLowerCase().trim();
                let storedBindings = {};
                try {
                  if (typeof localStorage !== 'undefined') {
                    const raw = localStorage.getItem(CUSTOM_BINDINGS_STORAGE_KEY);
                    if (raw) storedBindings = JSON.parse(raw) || {};
                  }
                } catch (_) {}
                if (!storedBindings[cName]) storedBindings[cName] = {};
                storedBindings[cName][targetClause.clauseText] = {
                  trigger: chosenTrigger,
                  primitive: chosenPrimitive,
                  condition: targetClause.condition || null,
                  status: 'BOUND'
                };
                try {
                  if (typeof localStorage !== 'undefined') {
                    localStorage.setItem(CUSTOM_BINDINGS_STORAGE_KEY, JSON.stringify(storedBindings));
                  }
                } catch (_) {}
                registerCustomCardBindings(storedBindings);
                renderData(data);
              });
            });
          } else {
            hookBinderEl.style.display = 'none';
          }
        } catch (_) {
          hookBinderEl.style.display = 'none';
        }
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
