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
          <button class="btn btn-primary btn-confirm-combination" id="target-btn-confirm" data-testid="btn-confirm-target-modal" style="display: none;" disabled>Confirm Selection</button>
          <button class="btn btn-secondary btn-cancel-target" id="target-btn-cancel">Cancel Spell</button>
        </div>
      </div>
    `;

    this.container.appendChild(this.element);

    this.element.querySelector('#target-btn-close')?.addEventListener('click', () => this.handleCancel());
    this.element.querySelector('#target-btn-cancel')?.addEventListener('click', () => this.handleCancel());
    this.element.querySelector('#target-btn-confirm, #btn-confirm-target-modal, .btn-confirm-combination')?.addEventListener('click', () => this.handleConfirm());
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

    const dualCandidates = tabletopState?.getValidTargetCandidatesForCard?.(casterPlayerId, spell);
    if (dualCandidates?.requiresDualTarget) {
      return this.openDualTarget({
        spell,
        step1Prompt: dualCandidates.step1Prompt,
        step1Candidates: dualCandidates.step1Candidates || dualCandidates.candidatesStep1 || dualCandidates.creatures || [],
        step2Prompt: dualCandidates.step2Prompt,
        step2Candidates: dualCandidates.step2Candidates || dualCandidates.candidatesStep2 || dualCandidates.equipment || [],
        onComplete: (data) => {
          if (typeof onSelectTarget === 'function') onSelectTarget(data);
          else if (typeof this.onSelectTarget === 'function') this.onSelectTarget(data);
        },
        onCancel: () => {
          if (typeof onCancel === 'function') onCancel();
          else if (typeof this.onCancel === 'function') this.onCancel();
        }
      });
    }

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

  /**
   * Opens sequential two-target selection modal (e.g. creature + equipment for Magnetic Theft).
   * 
   * @param {Object} options
   * @param {Object} [options.spell]
   * @param {string} [options.step1Prompt]
   * @param {Array} [options.step1Candidates]
   * @param {string} [options.step2Prompt]
   * @param {Array|Function} [options.step2Candidates]
   * @param {Function} [options.onComplete]
   * @param {Function} [options.onCancel]
   */
  openDualTarget({ spell, step1Prompt, step1Candidates = [], step2Prompt, step2Candidates = [], onComplete, onCancel } = {}) {
    this.spell = spell || this.spell;
    this.isOpen = true;
    this._selectedStep1Target = null;
    this._dualOnComplete = onComplete;
    this._dualOnCancel = onCancel;

    if (!this.element) this.init();
    if (!this.element) return;

    if (this.container && this.element.parentElement !== this.container) {
      this.container.appendChild(this.element);
    }

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
    const instEl = this.element.querySelector('#target-instructions');
    const listEl = this.element.querySelector('#target-candidates-list');

    const renderCandidates = (candidates, onSelect) => {
      if (!listEl) return;
      listEl.innerHTML = '';
      const items = Array.isArray(candidates) ? candidates : [];
      for (const raw of items) {
        const target = {
          id: raw.id || raw.instanceId,
          type: raw.type || (raw.card ? 'CREATURE' : 'PERMANENT'),
          name: raw.name || 'Target',
          subtitle: raw.subtitle || (raw.power !== undefined ? `${raw.power}/${raw.toughness}` : (raw.typeLine || raw.type || '')),
          isLegal: raw.isLegal !== false,
          reason: raw.reason,
          ...raw
        };
        target.id = target.id || raw.instanceId || raw.id;

        const itemEl = document.createElement('div');
        itemEl.className = `target-candidate-item target-candidate-row ${target.isLegal ? 'legal' : 'illegal'}`;
        itemEl.style.pointerEvents = target.isLegal ? 'auto' : 'default';

        itemEl.innerHTML = `
          <div class="target-item-info">
            <span class="target-item-name">${target.name}</span>
            <span class="target-item-sub">${target.subtitle || ''}</span>
          </div>
          <div class="target-item-badge">
            ${target.isLegal ? '<span class="badge-legal">Legal</span>' : `<span class="badge-illegal">${target.reason || 'Illegal'}</span>`}
          </div>
        `;

        if (target.isLegal) {
          itemEl.addEventListener('click', () => onSelect(target));
        }
        listEl.appendChild(itemEl);
      }
    };

    const runStep2 = (step1Target) => {
      if (titleEl) {
        titleEl.textContent = step2Prompt || `Choose Equipment for ${this.spell?.name || 'Spell'}`;
      }
      if (instEl) {
        instEl.textContent = `Step 2 of 2: Choose target Equipment (attaching to ${step1Target.name})`;
      }
      const s2List = typeof step2Candidates === 'function' ? step2Candidates(step1Target) : step2Candidates;
      renderCandidates(s2List, (step2Target) => {
        const selectedStep1 = this._selectedStep1Target;
        this.close();
        if (typeof onComplete === 'function') {
          onComplete({
            targetId: selectedStep1.id,
            equipmentId: step2Target.id,
            targets: [selectedStep1.id, step2Target.id],
            target1: selectedStep1,
            target2: step2Target
          });
        }
      });
    };

    // Step 1
    if (titleEl) {
      titleEl.textContent = step1Prompt || `Choose Creature for ${this.spell?.name || 'Spell'}`;
    }
    if (instEl) {
      instEl.textContent = 'Step 1 of 2: Choose target creature you control';
    }
    renderCandidates(step1Candidates, (target) => {
      this._selectedStep1Target = target;
      runStep2(target);
    });
  }

  /**
   * Opens the combination selector modal for multi-target or compound actions
   * (e.g. Burn Together sacrifice + damage target, Stolen Uniform equipment + creature,
   * or sacrifice choice for effects like Perk #66).
   *
   * @param {Object} options
   * @param {Object} [options.spell] - Spell card or source action
   * @param {Array<Object>} [options.combinations] - Array of combination descriptors
   * @param {string} [options.prompt] - Modal title / instruction header
   * @param {Function} [options.onSelectCombination] - Callback invoked with chosen combination
   * @param {Function} [options.onCancel] - Callback invoked if user cancels
   */
  openCombinationSelector({ spell, combinations = [], prompt, onSelectCombination, onConfirm, onCancel } = {}) {
    this.spell = spell || this.spell;
    this.isOpen = true;
    this.isCombinationMode = true;
    this.isTriggerTargetMode = false;
    this.combinations = Array.isArray(combinations) ? combinations : [];
    this.onConfirm = onConfirm || onSelectCombination;
    this._combinationOnSelect = this.onConfirm;
    this._combinationOnCancel = onCancel;
    this.selectedCombination = this.combinations[0] || null;
    this.selectedComboId = this.selectedCombination?.id || (this.combinations[0] ? '0' : null);
    this._selectedCombination = this.selectedCombination;

    if (!this.element) this.init();
    if (!this.element) return;

    if (this.container && this.element.parentElement !== this.container) {
      this.container.appendChild(this.element);
    }

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
    const instEl = this.element.querySelector('#target-instructions');
    const listEl = this.element.querySelector('#target-candidates-list');
    const confirmBtn = this.element.querySelector('#target-btn-confirm, #btn-confirm-target-modal, .btn-confirm-combination');
    const cancelBtn = this.element.querySelector('#target-btn-cancel');

    if (titleEl) {
      titleEl.textContent = prompt || (this.spell?.name ? `Acción: ${this.spell.name}` : 'Seleccionar Combinación');
    }
    if (instEl) {
      instEl.textContent = 'Haz clic en una combinación para seleccionarla y confirma tu elección.';
    }
    if (cancelBtn) {
      cancelBtn.style.display = 'inline-block';
      cancelBtn.textContent = 'Cancel';
    }

    if (confirmBtn) {
      confirmBtn.style.display = 'inline-block';
      confirmBtn.disabled = this.combinations.length === 0;
    }

    if (!listEl) return;
    listEl.innerHTML = '';

    if (this.combinations.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'target-empty-msg';
      emptyEl.style.padding = '16px';
      emptyEl.style.textAlign = 'center';
      emptyEl.style.color = '#94a3b8';
      emptyEl.textContent = 'No hay combinaciones válidas disponibles.';
      listEl.appendChild(emptyEl);
      return;
    }

    this.combinations.forEach((combo, idx) => {
      const itemEl = document.createElement('div');
      const isFirst = (idx === 0);
      itemEl.className = `target-candidate-item target-candidate-row target-combination-row combination-option-item legal ${isFirst ? 'selected' : ''}`;
      itemEl.setAttribute('data-combo-idx', String(idx));
      if (combo.id) itemEl.setAttribute('data-combo-id', String(combo.id));
      itemEl.style.cursor = 'pointer';

      let displayTitle = combo.label || combo.text || combo.name;
      let subtitle = combo.subtitle || combo.description || '';

      if (!displayTitle) {
        if (combo.creatureName && combo.targetName) {
          const dmg = combo.damage !== undefined ? `${combo.damage} DMG` : (combo.power !== undefined ? `${combo.power} DMG` : '');
          displayTitle = `🔥 Sacrificar ${combo.creatureName}${dmg ? ` (${dmg})` : ''} ➔ Dañar a ${combo.targetName}`;
        } else if (combo.equipmentName && (combo.creatureName || combo.targetName)) {
          displayTitle = `🛡️ Anexar ${combo.equipmentName} ➔ a ${combo.targetName || combo.creatureName}`;
        } else if (combo.name) {
          const pt = (combo.power !== undefined && combo.toughness !== undefined) ? ` (${combo.power}/${combo.toughness})` : '';
          displayTitle = `💀 Sacrificar ${combo.name}${pt}`;
        } else {
          displayTitle = `Opción #${idx + 1}`;
        }
      }

      itemEl.innerHTML = `
        <div class="target-item-info">
          <span class="target-item-name" style="font-weight: 600;">${displayTitle}</span>
          ${subtitle ? `<span class="target-item-sub" style="font-size: 0.78rem; opacity: 0.75; display: block; margin-top: 2px;">${subtitle}</span>` : ''}
        </div>
        <div class="target-item-badge">
          <span class="badge-legal">Legal</span>
        </div>
      `;

      const selectCombo = () => {
        this.selectedCombination = combo;
        this.selectedComboId = combo.id || String(idx);
        this._selectedCombination = combo;
        listEl.querySelectorAll('.combination-option-item, .target-combination-row').forEach(el => el.classList.remove('selected'));
        itemEl.classList.add('selected');
        if (confirmBtn) {
          confirmBtn.disabled = false;
        }
      };

      itemEl.addEventListener('click', selectCombo);
      itemEl.addEventListener('dblclick', () => {
        selectCombo();
        this.handleConfirm();
      });

      listEl.appendChild(itemEl);
    });

    if (this.combinations.length > 0) {
      this.selectedCombination = this.combinations[0];
      this.selectedComboId = this.selectedCombination?.id || '0';
      this._selectedCombination = this.selectedCombination;
      const firstRow = listEl.querySelector('.combination-option-item, .target-combination-row');
      if (firstRow) firstRow.classList.add('selected');
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  handleConfirm() {
    if (this.isTriggerTargetMode) {
      const chosenId = this.selectedCandidateId;
      const resolve = this._triggerOnResolve;
      this.close();
      if (typeof resolve === 'function') resolve(chosenId);
      return;
    }
    if (this.isCombinationMode) {
      const chosen = this.selectedCombination || this._selectedCombination || (this.combinations && this.combinations[0]);
      const cb = this.onConfirm || this._combinationOnSelect;
      this.close();
      if (typeof cb === 'function') cb(chosen);
      return;
    }
  }

  handleConfirmCombination() {
    return this.handleConfirm();
  }

  openTriggerTargetSelector(choicePayload = {}, onResolve) {
    if (!this.element) this.init();
    if (!this.element) return;

    this.isOpen = true;
    this.isCombinationMode = false;
    this.isTriggerTargetMode = true;
    this._triggerOnResolve = onResolve;

    if (this.container && this.element.parentElement !== this.container) {
      this.container.appendChild(this.element);
    }

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
    const instEl = this.element.querySelector('#target-instructions');
    const listEl = this.element.querySelector('#target-candidates-list');
    const confirmBtn = this.element.querySelector('#target-btn-confirm, #btn-confirm-target-modal, .btn-confirm-combination');
    const cancelBtn = this.element.querySelector('#target-btn-cancel');

    if (titleEl) {
      titleEl.textContent = `⚡ ${choicePayload.sourceName || "Sigarda's Aid"}: ¿Anexar ${choicePayload.equipmentName || 'efecto'} a qué criatura?`;
    }
    if (instEl) {
      instEl.textContent = 'Selecciona una criatura objetivo para anexar el equipo.';
    }

    let declineBtn = this.element.querySelector('#btn-decline-trigger-modal');
    if (choicePayload.isOptional !== false) {
      if (!declineBtn) {
        declineBtn = document.createElement('button');
        declineBtn.id = 'btn-decline-trigger-modal';
        declineBtn.className = 'btn btn-secondary btn-decline-trigger-modal';
        const footer = this.element.querySelector('.target-modal-footer');
        if (footer) footer.insertBefore(declineBtn, cancelBtn);
      }
      declineBtn.style.display = 'inline-block';
      declineBtn.textContent = `✋ Rechazar (Dejar ${choicePayload.equipmentName || 'equipo'} desanexado)`;
      declineBtn.onclick = () => {
        this.close();
        if (typeof onResolve === 'function') onResolve('DECLINE');
      };
      if (cancelBtn) cancelBtn.style.display = 'none';
    } else {
      if (declineBtn) declineBtn.style.display = 'none';
      if (cancelBtn) cancelBtn.style.display = 'inline-block';
    }

    const candidates = Array.isArray(choicePayload.candidates) ? choicePayload.candidates : [];
    this.selectedCandidateId = candidates[0]?.id || candidates[0]?.instanceId || null;

    if (confirmBtn) {
      confirmBtn.style.display = 'inline-block';
      confirmBtn.disabled = !this.selectedCandidateId;
    }

    if (!listEl) return;
    listEl.innerHTML = '';

    candidates.forEach((c, idx) => {
      const cId = c.id || c.instanceId;
      const ptStr = c.pt || (c.power !== undefined && c.toughness !== undefined ? `${c.power}/${c.toughness}` : '');
      const itemEl = document.createElement('div');
      itemEl.className = `target-candidate-item target-candidate-row combination-option-item legal ${idx === 0 ? 'selected' : ''}`;
      itemEl.setAttribute('data-candidate-id', cId);
      itemEl.style.cursor = 'pointer';

      itemEl.innerHTML = `
        <div class="target-item-info">
          <span class="target-item-name" style="font-weight: 600;">🎯 Anexar ${choicePayload.equipmentName || ''} ➔ a ${c.name} ${ptStr ? `(${ptStr})` : ''}</span>
          ${c.subtitle ? `<span class="target-item-sub" style="font-size: 0.78rem; opacity: 0.75; display: block; margin-top: 2px;">${c.subtitle}</span>` : ''}
        </div>
        <div class="target-item-badge">
          <span class="badge-legal">Legal</span>
        </div>
      `;

      const selectCandidate = () => {
        this.selectedCandidateId = cId;
        listEl.querySelectorAll('.target-candidate-item').forEach(el => el.classList.remove('selected'));
        itemEl.classList.add('selected');
        if (confirmBtn) confirmBtn.disabled = false;
      };

      itemEl.addEventListener('click', selectCandidate);
      itemEl.addEventListener('dblclick', () => {
        selectCandidate();
        this.handleConfirm();
      });

      listEl.appendChild(itemEl);
    });
  }

  /**
   * Helper for creature sacrifice choice modal (e.g. Perk #66 or sacrifice triggers).
   * 
   * @param {Object} options
   */
  openSacrificeSelector({ spell, candidates = [], prompt, onSelectCandidate, onCancel } = {}) {
    const combinations = candidates.map(c => {
      const pt = (c.power !== undefined && c.toughness !== undefined) ? ` (${c.power}/${c.toughness})` : '';
      return {
        type: 'SACRIFICE',
        creatureId: c.instanceId || c.id,
        card: c,
        name: c.name,
        power: c.power,
        toughness: c.toughness,
        targetId: c.instanceId || c.id,
        label: `💀 Sacrificar ${c.name || 'Criatura'}${pt}`
      };
    });

    return this.openCombinationSelector({
      spell,
      combinations,
      prompt: prompt || 'Elige una criatura para sacrificar:',
      onSelectCombination: (chosen) => {
        if (typeof onSelectCandidate === 'function') {
          onSelectCandidate(chosen.card || chosen);
        }
      },
      onCancel
    });
  }

  close() {
    this.isOpen = false;
    this.isCombinationMode = false;
    this.isTriggerTargetMode = false;
    this.selectedCombination = null;
    this.selectedComboId = null;
    this.selectedCandidateId = null;
    this._triggerOnResolve = null;
    this._selectedStep1Target = null;
    this._dualOnComplete = null;
    this._dualOnCancel = null;
    this._combinationOnSelect = null;
    this._combinationOnCancel = null;
    this._selectedCombination = null;
    if (this.element) {
      this.element.style.display = 'none';
      this.element.classList.add('hidden');
      this.element.classList.remove('open', 'active');
      const confirmBtn = this.element.querySelector('#target-btn-confirm, #btn-confirm-target-modal, .btn-confirm-combination');
      if (confirmBtn) {
        confirmBtn.style.display = 'none';
        confirmBtn.disabled = true;
      }
      const declineBtn = this.element.querySelector('#btn-decline-trigger-modal');
      if (declineBtn) {
        declineBtn.style.display = 'none';
      }
      const cancelBtn = this.element.querySelector('#target-btn-cancel');
      if (cancelBtn) {
        cancelBtn.style.display = 'inline-block';
        cancelBtn.textContent = 'Cancel Spell';
      }
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
    if (this.isTriggerTargetMode) {
      const resolve = this._triggerOnResolve;
      this.close();
      if (typeof resolve === 'function') resolve('DECLINE');
      return;
    }
    const comboCancel = this._combinationOnCancel;
    const dualCancel = this._dualOnCancel;
    this.close();
    if (typeof comboCancel === 'function') {
      comboCancel();
    } else if (typeof dualCancel === 'function') {
      dualCancel();
    } else if (typeof this.onCancel === 'function') {
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
