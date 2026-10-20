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
    this.element.id = 'target-selector-modal';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', 'Select Spell Target');

    this.element.innerHTML = `
      <div class="target-modal-panel">
        <div class="target-modal-header">
          <div class="target-title-row">
            <h2 class="target-modal-title" id="target-modal-title">Select Target for Spell</h2>
            <button class="target-btn-close" id="target-btn-close" aria-label="Close">×</button>
          </div>
          <p class="target-instructions" id="target-instructions">
            Choose a valid target. Targets with Hexproof, Shroud, or Protection are illegal.
          </p>
        </div>

        <div class="target-candidates-list" id="target-candidates-list"></div>

        <div class="target-modal-footer">
          <button class="btn btn-secondary" id="target-btn-cancel">Cancel Spell</button>
        </div>
      </div>
    `;

    this.container.appendChild(this.element);

    this.element.querySelector('#target-btn-close')?.addEventListener('click', () => this.handleCancel());
    this.element.querySelector('#target-btn-cancel')?.addEventListener('click', () => this.handleCancel());
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

    if (target.type === 'CREATURE') {
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
   * Opens the targeting modal for the spell.
   * 
   * @param {Object} options
   * @param {Object} options.spell - Spell card instance
   * @param {string} options.casterPlayerId
   * @param {Object} options.tabletopState
   */
  open({ spell, casterPlayerId, tabletopState }) {
    this.spell = spell;
    this.casterPlayerId = casterPlayerId;
    this.tabletopState = tabletopState;
    this.isOpen = true;

    if (!this.element) this.init();
    if (!this.element) return;

    this.element.classList.remove('hidden');
    const titleEl = this.element.querySelector('#target-modal-title');
    if (titleEl) {
      titleEl.textContent = `Target for ${spell?.name || 'Spell'}`;
    }

    this.gatherCandidates();
    this.render();
  }

  close() {
    this.isOpen = false;
    if (this.element) {
      this.element.classList.add('hidden');
    }
  }

  handleCancel() {
    this.close();
    this.onCancel();
  }

  handleTargetClick(target) {
    if (!target.isLegal) return;
    this.close();
    this.onSelectTarget({
      targetId: target.id,
      targetType: target.type,
      targetName: target.name
    });
  }

  gatherCandidates() {
    this.candidateTargets = [];
    if (!this.tabletopState) return;

    // 1. Players
    for (const [pid, player] of Object.entries(this.tabletopState.players || {})) {
      const legality = TargetSelectorModal.evaluateTargetLegality(
        { id: pid, type: 'PLAYER', player },
        this.spell,
        this.casterPlayerId
      );
      this.candidateTargets.push({
        id: pid,
        type: 'PLAYER',
        name: player.name || `Player ${pid}`,
        subtitle: `Life: ${player.resources?.life ?? 20}`,
        isLegal: legality.isLegal,
        reason: legality.reason
      });
    }

    // 2. Creatures on Battlefield
    for (const [pid, player] of Object.entries(this.tabletopState.players || {})) {
      const creatures = player.battlefield?.creatures || [];
      for (const card of creatures) {
        const legality = TargetSelectorModal.evaluateTargetLegality(
          { id: card.instanceId, type: 'CREATURE', card },
          this.spell,
          this.casterPlayerId
        );
        this.candidateTargets.push({
          id: card.instanceId,
          type: 'CREATURE',
          name: card.name,
          subtitle: `${card.power || 0}/${card.toughness || 0} (${player.name || pid})`,
          imageUrl: card.imageUrl || card.image_uris?.normal,
          card,
          isLegal: legality.isLegal,
          reason: legality.reason
        });
      }
    }
  }

  render() {
    if (!this.element) return;
    const list = this.element.querySelector('#target-candidates-list');
    if (!list) return;

    list.innerHTML = '';
    for (const target of this.candidateTargets) {
      const itemEl = document.createElement('div');
      itemEl.className = `target-candidate-item ${target.isLegal ? 'legal' : 'illegal'}`;

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
