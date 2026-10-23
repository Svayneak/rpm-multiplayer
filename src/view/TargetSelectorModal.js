/**
 * TargetSelectorModal.js - Legal Spell Target Selection Modal
 * 
 * Part of RPM Multiplayer - Feature 19
 * Specification: SPEC-RPM-BATTLE-UX-019 (INV-TARGET-MENU-1)
 * 
 * Implements:
 * - Interactive legal target selection for spells (e.g. Lightning Bolt)
 * - Automatic legality filtering:
 *   - Hexproof (CR 702.11): Cannot be targeted by opponents
 *   - Shroud (CR 702.18): Cannot be targeted by anyone
 *   - Protection from Quality/Color (CR 702.16): Cannot be targeted by spells of that quality
 * - Visual target list highlighting legal targets and dimming invalid ones with status badges
 * 
 * @module TargetSelectorModal
 */

export class TargetSelectorModal {
  /**
   * @param {Object} [options={}]
   * @param {HTMLElement} [options.container]
   * @param {Function} [options.onSelectTarget]
   * @param {Function} [options.onCancel]
   */
  constructor(options = {}) {
    this.container = options.container || (typeof document !== 'undefined' ? document.body : null);
    this.onSelectTarget = options.onSelectTarget || (() => {});
    this.onCancel = options.onCancel || (() => {});

    this.isOpen = false;
    this.element = null;
    this.spell = null;
    this.casterPlayerId = null;
    this.tabletopState = null;
    this.candidateTargets = [];

    if (typeof document !== 'undefined') {
      this.init();
    }
  }

  init() {
    if (this.element || !this.container) return;

    this.element = document.createElement('div');
    this.element.className = 'target-modal-backdrop hidden';
    this.element.style.display = 'none';
    this.element.id = 'target-selector-modal';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', 'Select Spell Target');
    this.element.style.pointerEvents = 'auto';
    this.element.style.zIndex = '10000';

    this.element.innerHTML = `
      <div class="target-modal-panel">
        <div class="target-modal-header">
          <div class="target-title-row">
            <h2 class="target-modal-title" id="target-modal-title">Select Target for Spell</h2>
            <button class="target-btn-close btn-close-modal" id="target-btn-close" aria-label="Close">×</button>
          </div>
          <p class="target-instructions" id="target-instructions">
            Choose a valid target. Targets with Hexproof, Shroud, or Protection are illegal.
          </p>
        </div>

        <div class="target-candidates-list" id="target-candidates-list"></div>

        <div class="target-modal-footer">
          <button class="btn btn-secondary btn-cancel-target" id="target-btn-cancel">Cancel Spell</button>
        </div>
      </div>
    `;

    this.container.appendChild(this.element);

    this.element.querySelector('#target-btn-close')?.addEventListener('click', () => this.handleCancel());
    this.element.querySelector('#target-btn-cancel')?.addEventListener('click', () => this.handleCancel());
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) {
        this.handleCancel();
      }
    });
  }

  /**
   * Evaluates legality of targeting a candidate permanent or player.
   * 
   * @param {Object} target - { id, type: 'PLAYER'|'CREATURE', card?, player? }
   * @param {Object} spell - Spell being cast
   * @param {string} casterPlayerId - Casting player ID
   * @returns {{ isLegal: boolean, reason?: string }}
   */
  static evaluateTargetLegality(target, spell, casterPlayerId) {
    if (!target) return { isLegal: false, reason: 'INVALID_TARGET' };

    const spellColors = spell?.colors || (spell?.manaCost ? (spell.manaCost.match(/[WUBRG]/gi) || []) : []);
    const normalizedSpellColors = spellColors.map(c => String(c).toUpperCase());

    if (target.type === 'PLAYER') {
      // Check player hexproof (e.g. Leyline of Sanctity)
      const playerHexproof = target.player?.hasHexproof || target.player?.keywords?.hexproof;
      if (playerHexproof && target.id !== casterPlayerId) {
        return { isLegal: false, reason: 'PLAYER_HEXPROOF' };
      }
      return { isLegal: true };
    }

    if (target.type === 'CREATURE' || target.type === 'PERMANENT') {
      const card = target.card;
      if (!card) return { isLegal: false, reason: 'CARD_NOT_FOUND' };

      const isOpponent = (card.controllerId || card.ownerId) !== casterPlayerId;

      // 1. Shroud (CR 702.18): Cannot be targeted by anyone
      if (card.keywords?.shroud || /shroud/i.test(card.text || '')) {
        return { isLegal: false, reason: 'SHROUD' };
      }

      // 2. Hexproof (CR 702.11): Cannot be targeted by opponents
      if (isOpponent && (card.keywords?.hexproof || /hexproof/i.test(card.text || ''))) {
        return { isLegal: false, reason: 'HEXPROOF' };
      }

      // 3. Protection (CR 702.16): Protection from color
      if (card.keywords?.protection || /protection from/i.test(card.text || '')) {
        for (const col of normalizedSpellColors) {
          const colorName = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' }[col];
          const regex = new RegExp(`protection from ${colorName}`, 'i');
          if (regex.test(card.text || '') || (card.keywords?.protection && card.keywords.protection.includes(col))) {
            return { isLegal: false, reason: `PROTECTION_FROM_${col}` };
          }
        }
      }

      return { isLegal: true };
    }

    return { isLegal: true };
  }

  /**
   * Mounts the modal element into a container if not already mounted.
   * @param {HTMLElement} container
   */
  mount(container) {
    if (!container) return;
    this.container = container;
    if (!this.element) {
      this.init();
    } else if (this.element.parentNode !== container) {
      container.appendChild(this.element);
    }
  }

  /**
   * Opens the targeting modal for the spell.
   * Supports both open({ spell, casterPlayerId, tabletopState, onSelectTarget, onCancel })
   * and open(spell, tabletopState, casterPlayerId, { onSelectTarget, onCancel }).
   * 
   * @param {Object} spellOrOptions - Spell card instance or options object
   * @param {Object} [tabletopStateArg]
   * @param {string} [casterPlayerIdArg]
   * @param {Object} [extraOptions]
   */
  open(spellOrOptions, tabletopStateArg, casterPlayerIdArg, extraOptions = {}) {
    let spell, tabletopState, casterPlayerId, onSelectTarget, onCancel;

    if (spellOrOptions && typeof spellOrOptions === 'object' && spellOrOptions.spell) {
      spell = spellOrOptions.spell;
      casterPlayerId = spellOrOptions.casterPlayerId || casterPlayerIdArg;
      tabletopState = spellOrOptions.tabletopState || tabletopStateArg;
      onSelectTarget = spellOrOptions.onSelectTarget;
      onCancel = spellOrOptions.onCancel;
    } else {
      spell = spellOrOptions;
      tabletopState = tabletopStateArg;
      casterPlayerId = casterPlayerIdArg;
      onSelectTarget = extraOptions?.onSelectTarget;
      onCancel = extraOptions?.onCancel;
    }

    if (typeof onSelectTarget === 'function') this.onSelectTarget = onSelectTarget;
    if (typeof onCancel === 'function') this.onCancel = onCancel;

    this.spell = spell;
    this.tabletopState = tabletopState;
    this.casterPlayerId = casterPlayerId;
    this.isOpen = true;

    if (!this.element) this.init();
    if (!this.element) return;

    // Ensure mounted in container if detached
    if (this.container && this.element.parentElement !== this.container) {
      this.container.appendChild(this.element);
    }

    // Unblock pointer-events on host if in #modal-root
    const host = this.element.closest?.('#modal-root') || this.container?.closest?.('#modal-root') || (this.container?.id === 'modal-root' ? this.container : null);
    if (host) {
      host.setAttribute('aria-hidden', 'false');
      host.style.pointerEvents = 'auto';
    }

    this.element.style.display = 'flex';
    this.element.style.pointerEvents = 'auto';
    this.element.style.zIndex = '10000';
    this.element.classList.remove('hidden');
    this.element.classList.add('open', 'active');
    const titleEl = this.element.querySelector('#target-modal-title');
    if (titleEl) {
      titleEl.textContent = `Target for ${this.spell?.name || 'Spell'}`;
    }

    this.gatherCandidates();
    this.render();
  }

  close() {
    this.isOpen = false;
    if (this.element) {
      this.element.style.display = 'none';
      this.element.classList.add('hidden');
      this.element.classList.remove('open', 'active');
    }

    // Restore host aria-hidden if no other modals are active
    const host = this.element?.closest?.('#modal-root') || this.container?.closest?.('#modal-root') || (this.container?.id === 'modal-root' ? this.container : null);
    if (host) {
      const remainingModals = host.querySelectorAll('.modal-backdrop:not(.hidden):not([style*="display: none"]), .target-modal-backdrop:not(.hidden):not([style*="display: none"]), .mulligan-modal-backdrop:not(.hidden):not([style*="display: none"]), .modal-dialog-box');
      if (remainingModals.length === 0) {
        host.setAttribute('aria-hidden', 'true');
        host.style.pointerEvents = '';
      }
    }
  }

  handleCancel() {
    this.close();
    if (typeof this.onCancel === 'function') {
      this.onCancel();
    }
  }

  handleTargetClick(target) {
    if (!target.isLegal) return;
    this.close();
    if (typeof this.onSelectTarget === 'function') {
      this.onSelectTarget({
        targetId: target.id,
        targetType: target.type,
        targetName: target.name,
        target: target
      });
    }
  }

  gatherCandidates() {
    this.candidateTargets = [];
    if (!this.tabletopState) return;

    const targetType = String(this.spell?.effect?.targetType || this.spell?.targetType || 'any').toLowerCase();
    const allowPlayers = (targetType === 'any' || targetType === 'player' || targetType === 'player_or_planeswalker' || targetType === 'opponent');
    const allowCreatures = (targetType === 'any' || targetType === 'creature' || targetType === 'permanent' || targetType === 'creature_or_planeswalker');
    const allowOtherPermanents = (targetType === 'permanent');

    const gathered = [];

    // 1. Players
    if (allowPlayers) {
      for (const [pid, player] of Object.entries(this.tabletopState.players || {})) {
        if (player.isEliminated) continue;
        if (targetType === 'opponent' && pid === this.casterPlayerId) continue;

        const isOpponent = pid !== this.casterPlayerId;
        const legality = TargetSelectorModal.evaluateTargetLegality(
          { id: pid, type: 'PLAYER', player },
          this.spell,
          this.casterPlayerId
        );
        gathered.push({
          id: pid,
          type: 'PLAYER',
          isOpponent,
          controllerId: pid,
          name: player.name || `Player ${pid}`,
          subtitle: `Life: ${player.resources?.life ?? 20}`,
          isLegal: legality.isLegal,
          reason: legality.reason
        });
      }
    }

    // 2. Permanents on Battlefield
    for (const [pid, player] of Object.entries(this.tabletopState.players || {})) {
      if (player.isEliminated) continue;
      const isOpponent = pid !== this.casterPlayerId;

      if (allowCreatures) {
        const creatures = Array.isArray(player.battlefield?.creatures)
          ? player.battlefield.creatures
          : (Array.isArray(player.zones?.battlefield) ? player.zones.battlefield.filter(c => /creature/i.test(c.type || c.typeLine || '')) : []);

        for (const card of creatures) {
          if (!card) continue;
          const stats = this.tabletopState.abilityEngine?.evaluateCreatureStats
            ? this.tabletopState.abilityEngine.evaluateCreatureStats(card, this.tabletopState)
            : { power: card.power ?? 0, toughness: card.toughness ?? 0 };
          const legality = TargetSelectorModal.evaluateTargetLegality(
            { id: card.instanceId, type: 'CREATURE', card },
            this.spell,
            this.casterPlayerId
          );
          gathered.push({
            id: card.instanceId,
            type: 'CREATURE',
            isOpponent,
            controllerId: pid,
            name: card.name,
            subtitle: `${stats.power}/${stats.toughness} (${player.name || pid})`,
            imageUrl: card.imageUrl || card.image_uris?.normal,
            card,
            isLegal: legality.isLegal,
            reason: legality.reason
          });
        }
      }

      if (allowOtherPermanents) {
        const otherCards = [
          ...(player.battlefield?.lands || []),
          ...(player.battlefield?.noncreatures || []),
          ...(player.battlefield?.planeswalkers || [])
        ];
        for (const card of otherCards) {
          if (!card) continue;
          const legality = TargetSelectorModal.evaluateTargetLegality(
            { id: card.instanceId, type: 'PERMANENT', card },
            this.spell,
            this.casterPlayerId
          );
          gathered.push({
            id: card.instanceId,
            type: 'PERMANENT',
            isOpponent,
            controllerId: pid,
            name: card.name,
            subtitle: `${card.typeLine || card.type || 'Permanent'} (${player.name || pid})`,
            imageUrl: card.imageUrl || card.image_uris?.normal,
            card,
            isLegal: legality.isLegal,
            reason: legality.reason
          });
        }
      }
    }

    // Prioritize opponents first, followed by caster's own targets
    gathered.sort((a, b) => {
      if (a.isOpponent && !b.isOpponent) return -1;
      if (!a.isOpponent && b.isOpponent) return 1;
      return 0;
    });

    this.candidateTargets = gathered;
  }

  render() {
    if (!this.element) return;
    const list = this.element.querySelector('#target-candidates-list');
    if (!list) return;

    list.innerHTML = '';
    for (const target of this.candidateTargets) {
      const itemEl = document.createElement('div');
      itemEl.className = `target-candidate-item target-candidate-row ${target.isLegal ? 'legal' : 'illegal'}`;
      itemEl.style.pointerEvents = target.isLegal ? 'auto' : 'default';

      itemEl.innerHTML = `
        <div class="target-item-info">
          <span class="target-item-name">${target.name}</span>
          <span class="target-item-sub">${target.subtitle}</span>
        </div>
        <div class="target-item-badge">
          ${target.isLegal ? '<span class="badge-legal">Legal</span>' : `<span class="badge-illegal">${target.reason || 'Illegal'}</span>`}
        </div>
      `;

      if (target.isLegal) {
        itemEl.addEventListener('click', () => this.handleTargetClick(target));
      }

      list.appendChild(itemEl);
    }
  }
}

export default TargetSelectorModal;
