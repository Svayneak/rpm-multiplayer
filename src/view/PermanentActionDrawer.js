/**
 * PermanentActionDrawer.js - Battlefield Permanent Ability Action Drawer Popover
 * 
 * Part of RPM Multiplayer - Feature 21
 * Specification: SPEC-RPM-RULES-ENGINE-021 (INV-ABILITY-ENGINE-1)
 * 
 * Implements:
 * - Battlefield permanent ability popover drawer
 * - Tap for mana shortcut if land or mana producer
 * - Activated abilities list with cost breakdown badges
 * - Instant activation dispatcher
 * 
 * @module PermanentActionDrawer
 */

export class PermanentActionDrawer {
  /**
   * @param {Object} [options={}]
   * @param {HTMLElement} [options.container]
   * @param {Function} [options.onActivateAbility]
   * @param {Function} [options.onTapForMana]
   */
  constructor(options = {}) {
    this.container = options.container || (typeof document !== 'undefined' ? document.body : null);
    this.onActivateAbility = options.onActivateAbility || (() => {});
    this.onTapForMana = options.onTapForMana || (() => {});

    this.isOpen = false;
    this.element = null;
    this.card = null;
    this.playerId = null;

    if (typeof document !== 'undefined') {
      this.init();
    }
  }

  init() {
    if (this.element || !this.container) return;

    this.element = document.createElement('div');
    this.element.className = 'permanent-action-drawer hidden';
    this.element.style.display = 'none';
    this.element.id = 'permanent-action-drawer';

    this.element.innerHTML = `
      <div class="drawer-panel">
        <div class="drawer-header">
          <div class="drawer-title-row">
            <h3 class="drawer-card-name" id="drawer-card-name">Permanent Actions</h3>
            <button class="drawer-btn-close" id="drawer-btn-close">×</button>
          </div>
          <span class="drawer-card-type" id="drawer-card-type">Creature</span>
        </div>

        <div class="drawer-body" id="drawer-body">
          <div class="drawer-mana-action" id="drawer-mana-action">
            <button class="btn btn-secondary drawer-btn-tap-mana" id="drawer-btn-tap-mana">
              ⚡ Tap for Mana
            </button>
          </div>
          <div class="drawer-abilities-list" id="drawer-abilities-list"></div>
        </div>
      </div>
    `;

    this.container.appendChild(this.element);

    this.element.querySelector('#drawer-btn-close')?.addEventListener('click', () => this.close());
    this.element.querySelector('#drawer-btn-tap-mana')?.addEventListener('click', () => {
      if (this.card && this.playerId) {
        this.close();
        this.onTapForMana({ card: this.card, playerId: this.playerId });
      }
    });
  }

  /**
   * Opens the drawer for a specific battlefield permanent.
   * 
   * @param {Object} options
   * @param {Object} options.card
   * @param {string} options.playerId
   * @param {Array<Object>} [options.abilities=[]]
   */
  open({ card, playerId, abilities = [] }) {
    this.card = card;
    this.playerId = playerId;
    this.isOpen = true;

    if (!this.element) this.init();
    if (!this.element) return;

    this.element.style.display = 'block';
    this.element.classList.remove('hidden');

    const nameEl = this.element.querySelector('#drawer-card-name');
    const typeEl = this.element.querySelector('#drawer-card-type');
    const manaActionEl = this.element.querySelector('#drawer-mana-action');
    const abilitiesListEl = this.element.querySelector('#drawer-abilities-list');

    if (nameEl) nameEl.textContent = card?.name || 'Permanent';
    if (typeEl) {
      typeEl.textContent = `${card?.typeLine || ''} ${card?.isTapped ? '(Tapped)' : '(Untapped)'}`;
    }

    // Is it a land or does it produce mana?
    const isLand = /land/i.test(card?.typeLine || card?.type || '');
    if (manaActionEl) {
      manaActionEl.style.display = (isLand && !card.isTapped) ? 'block' : 'none';
    }

    if (abilitiesListEl) {
      abilitiesListEl.innerHTML = '';
      const list = Array.isArray(abilities) && abilities.length > 0 ? abilities : (card?.abilities || []);
      if (list.length === 0 && !isLand) {
        abilitiesListEl.innerHTML = '<div class="drawer-empty-abilities">No activated abilities on this permanent.</div>';
      } else {
        for (const ability of list) {
          const abItem = document.createElement('div');
          abItem.className = 'drawer-ability-item';
          abItem.innerHTML = `
            <div class="ability-text">${ability.text || ability.description || 'Ability'}</div>
            <button class="btn btn-primary btn-sm drawer-btn-activate">Activate</button>
          `;
          abItem.querySelector('.drawer-btn-activate')?.addEventListener('click', () => {
            this.close();
            this.onActivateAbility({ card: this.card, ability, playerId: this.playerId });
          });
          abilitiesListEl.appendChild(abItem);
        }
      }
    }
  }

  close() {
    this.isOpen = false;
    if (this.element) {
      this.element.style.display = 'none';
      this.element.classList.add('hidden');
    }
  }
}

export default PermanentActionDrawer;
