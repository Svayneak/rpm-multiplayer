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
 * - Equip / Attach assisted target workflow
 * 
 * @module PermanentActionDrawer
 */

export class PermanentActionDrawer {
  /**
   * @param {Object} [options={}]
   * @param {HTMLElement} [options.container]
   * @param {Function} [options.onActivateAbility]
   * @param {Function} [options.onTapForMana]
   * @param {Function} [options.onEquipToCreature]
   * @param {Function} [options.getFriendlyCreatures]
   * @param {Array<Object>} [options.friendlyCreatures]
   */
  constructor(options = {}) {
    this.container = options.container || (typeof document !== 'undefined' ? document.body : null);
    this.onActivateAbility = options.onActivateAbility || (() => {});
    this.onTapForMana = options.onTapForMana || (() => {});
    this.onEquipToCreature = options.onEquipToCreature || (() => {});
    this.getFriendlyCreatures = options.getFriendlyCreatures || null;
    this.friendlyCreatures = Array.isArray(options.friendlyCreatures) ? options.friendlyCreatures : [];

    this.isOpen = false;
    this.element = null;
    this.card = null;
    this.playerId = null;
    this.anchorEl = null;
    this.context = {};

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
          <div class="drawer-equip-action" id="drawer-equip-action" style="display: none;">
            <button class="btn btn-primary drawer-btn-equip" id="drawer-btn-equip">
              ⚔️ Equip to Creature
            </button>
            <div class="drawer-creature-select-list" id="drawer-creature-select-list" style="display: none; margin-top: 6px; flex-direction: column; gap: 4px;"></div>
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
    this.element.querySelector('#drawer-btn-equip')?.addEventListener('click', () => {
      this._handleEquipClick();
    });
  }

  _handleEquipClick() {
    if (!this.card || !this.playerId) return;

    let creatures = [];
    if (this.context && Array.isArray(this.context.friendlyCreatures) && this.context.friendlyCreatures.length > 0) {
      creatures = this.context.friendlyCreatures;
    } else if (typeof this.getFriendlyCreatures === 'function') {
      creatures = this.getFriendlyCreatures(this.playerId) || [];
    } else if (Array.isArray(this.friendlyCreatures)) {
      creatures = this.friendlyCreatures;
    }

    const selectListEl = this.element.querySelector('#drawer-creature-select-list');
    if (selectListEl) {
      selectListEl.innerHTML = '';
      selectListEl.style.display = 'flex';
    }

    if (!creatures || creatures.length === 0) {
      if (selectListEl) {
        selectListEl.innerHTML = '<div class="drawer-empty-creatures" style="font-size: 0.75rem; color: #94a3b8; padding: 4px;">No creatures available to equip.</div>';
      }
      return;
    }

    if (selectListEl) {
      for (const targetCreature of creatures) {
        const costStr = this._getEquipCostForCreature(targetCreature);
        const btn = document.createElement('button');
        btn.className = 'btn btn-secondary btn-sm drawer-creature-target-btn';
        btn.textContent = `🎯 ${targetCreature.name || 'Creature'} (Cost: ${costStr})`;
        btn.setAttribute('data-target-id', targetCreature.instanceId || targetCreature.id || '');
        btn.addEventListener('click', () => {
          this.close();
          this.onEquipToCreature({ equipment: this.card, targetCreature, playerId: this.playerId });
        });
        selectListEl.appendChild(btn);
      }
    }

    const cardName = (this.card?.name || '').toLowerCase();
    const isVariableCost = cardName.includes('belt of giant strength') ||
      /equip\s*\{.*x.*\}/i.test(this.card?.oracleText || '') ||
      (this.card?.compiledMechanics?.equipCost && /x/i.test(this.card.compiledMechanics.equipCost));

    if (creatures.length === 1 && !isVariableCost) {
      const targetCreature = creatures[0];
      this.close();
      this.onEquipToCreature({ equipment: this.card, targetCreature, playerId: this.playerId });
    }
  }

  _getEquipCostForCreature(targetCreature) {
    if (this.context?.tabletopState && typeof this.context.tabletopState.computeEquipCost === 'function') {
      try {
        const cost = this.context.tabletopState.computeEquipCost(this.playerId, this.card, targetCreature);
        if (cost !== undefined && cost !== null) {
          const str = String(cost);
          return str.startsWith('{') ? str : `{${str}}`;
        }
      } catch (_) {}
    }

    const crName = (targetCreature?.name || '').toLowerCase();
    const crText = (targetCreature?.oracleText || targetCreature?.text || '').toLowerCase();
    const staticPerms = targetCreature?.compiledMechanics?.staticPermissions || [];
    const hasReduction = crName.includes('fervent champion') ||
      staticPerms.some(sp => sp.type === 'TARGET_EQUIP_COST_REDUCTION') ||
      /equip abilities.*target.*cost \{?3\}? less/i.test(crText);

    let rawCost = this.card?.compiledMechanics?.equipCost || this.card?.equipCost;
    if (!rawCost) {
      const m = (this.card?.oracleText || this.card?.text || '').match(/equip(?:—|\s+)\{?([^}\n.]+)\}?/i);
      rawCost = m ? m[1].trim() : '3';
    }
    const cleanCost = String(rawCost).replace(/[{}]/g, '');
    const num = parseInt(cleanCost, 10);

    if (!isNaN(num)) {
      const finalCost = hasReduction ? Math.max(0, num - 3) : num;
      return `{${finalCost}}`;
    }

    return String(rawCost).startsWith('{') ? String(rawCost) : `{${rawCost}}`;
  }

  /**
   * Opens the drawer for a specific battlefield permanent.
   * Supports both legacy signature: open({ card, playerId, abilities })
   * and assisted action signature: open(card, playerId, anchorEl, context)
   * 
   * @param {Object} optionsOrCard
   * @param {string} [playerId]
   * @param {HTMLElement} [anchorEl]
   * @param {Object} [context={}]
   */
  open(optionsOrCard, playerId, anchorEl, context = {}) {
    let card = null;
    let pid = null;
    let abilities = [];
    let ctx = {};

    if (optionsOrCard && typeof optionsOrCard === 'object' && ('card' in optionsOrCard || 'playerId' in optionsOrCard)) {
      card = optionsOrCard.card;
      pid = optionsOrCard.playerId || playerId;
      abilities = optionsOrCard.abilities || [];
      this.anchorEl = optionsOrCard.anchorEl || anchorEl || null;
      ctx = { ...optionsOrCard, ...context };
    } else {
      card = optionsOrCard;
      pid = playerId;
      this.anchorEl = anchorEl || null;
      ctx = context || {};
      abilities = ctx.abilities || card?.compiledMechanics?.activatedAbilities || card?.activatedAbilities || card?.abilities || [];
    }

    this.card = card;
    this.playerId = pid;
    this.context = ctx;
    this.isOpen = true;

    if (!this.element) this.init();
    if (!this.element) return;

    this.element.style.display = 'block';
    this.element.classList.remove('hidden');

    const nameEl = this.element.querySelector('#drawer-card-name');
    const typeEl = this.element.querySelector('#drawer-card-type');
    const manaActionEl = this.element.querySelector('#drawer-mana-action');
    const equipActionEl = this.element.querySelector('#drawer-equip-action');
    const selectListEl = this.element.querySelector('#drawer-creature-select-list');
    const abilitiesListEl = this.element.querySelector('#drawer-abilities-list');

    if (nameEl) nameEl.textContent = card?.name || 'Permanent';
    if (typeEl) {
      typeEl.textContent = `${card?.typeLine || ''} ${card?.isTapped ? '(Tapped)' : '(Untapped)'}`;
    }

    const nameLower = (card?.name || '').trim().toLowerCase();
    const isLand = /land/i.test(card?.typeLine || card?.type || '');
    const isInkmoth = nameLower.includes('inkmoth nexus');
    const isStartingTown = nameLower.includes('starting town');
    const isSpireOfIndustry = nameLower.includes('spire of industry');

    if (manaActionEl) {
      if (isInkmoth) {
        manaActionEl.style.display = 'block';
        let html = '<div class="drawer-land-actions" style="display: flex; flex-direction: column; gap: 6px;">';
        if (!card?.isTapped) {
          html += `<button class="btn btn-secondary drawer-btn-tap-mana" id="drawer-btn-tap-c">💎 Tap: Add {C}</button>`;
        }
        html += `<button class="btn btn-primary drawer-btn-animate" id="drawer-btn-animate-blinkmoth">☣️ Pay {1}: Animate 1/1 Infect Blinkmoth (Until EOT)</button>`;
        html += '</div>';
        manaActionEl.innerHTML = html;

        manaActionEl.querySelector('#drawer-btn-tap-c')?.addEventListener('click', () => {
          if (this.card && this.playerId) {
            this.close();
            this.onTapForMana({ card: this.card, playerId: this.playerId, chosenColor: 'C', lifeCost: 0 });
          }
        });

        manaActionEl.querySelector('#drawer-btn-animate-blinkmoth')?.addEventListener('click', () => {
          if (this.card && this.playerId) {
            this.close();
            this.onActivateAbility({
              card: this.card,
              playerId: this.playerId,
              ability: {
                id: 'ANIMATE_LAND',
                action: 'ANIMATE_LAND',
                cost: '{1}',
                requiresTap: false,
                text: '{1}: Animate 1/1 Infect Blinkmoth (Until EOT)'
              }
            });
          }
        });
      } else if (isStartingTown || isSpireOfIndustry) {
        manaActionEl.style.display = !card?.isTapped ? 'block' : 'none';
        if (!card?.isTapped) {
          manaActionEl.innerHTML = `
            <div class="drawer-land-actions" style="display: flex; flex-direction: column; gap: 6px;">
              <button class="btn btn-secondary drawer-btn-tap-mana" id="drawer-btn-tap-c-zero">💎 Tap: Add {C} (0 Life)</button>
              <div class="drawer-any-color-container" style="margin-top: 2px;">
                <div style="font-size: 0.8rem; font-weight: bold; margin-bottom: 4px; color: #f1f5f9;">🌈 Tap, Pay 1 Life: Add Any Color</div>
                <div class="drawer-color-btn-group" style="display: flex; gap: 4px;">
                  <button class="btn btn-sm btn-color-w" data-color="W" style="flex:1; background:#fef08a; color:#1e293b; font-weight:bold; border:none; border-radius:3px; padding:3px 0; cursor:pointer;">{W}</button>
                  <button class="btn btn-sm btn-color-u" data-color="U" style="flex:1; background:#38bdf8; color:#0f172a; font-weight:bold; border:none; border-radius:3px; padding:3px 0; cursor:pointer;">{U}</button>
                  <button class="btn btn-sm btn-color-b" data-color="B" style="flex:1; background:#475569; color:#f8fafc; font-weight:bold; border:none; border-radius:3px; padding:3px 0; cursor:pointer;">{B}</button>
                  <button class="btn btn-sm btn-color-r" data-color="R" style="flex:1; background:#f87171; color:#0f172a; font-weight:bold; border:none; border-radius:3px; padding:3px 0; cursor:pointer;">{R}</button>
                  <button class="btn btn-sm btn-color-g" data-color="G" style="flex:1; background:#4ade80; color:#0f172a; font-weight:bold; border:none; border-radius:3px; padding:3px 0; cursor:pointer;">{G}</button>
                </div>
              </div>
            </div>
          `;

          manaActionEl.querySelector('#drawer-btn-tap-c-zero')?.addEventListener('click', () => {
            if (this.card && this.playerId) {
              this.close();
              this.onTapForMana({ card: this.card, playerId: this.playerId, chosenColor: 'C', lifeCost: 0 });
            }
          });

          const colorBtns = manaActionEl.querySelectorAll('.drawer-color-btn-group button');
          colorBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const chosenColor = btn.getAttribute('data-color') || 'W';
              if (this.card && this.playerId) {
                this.close();
                this.onTapForMana({ card: this.card, playerId: this.playerId, chosenColor, lifeCost: 1 });
              }
            });
          });
        }
      } else {
        manaActionEl.style.display = (isLand && !card?.isTapped) ? 'block' : 'none';
        manaActionEl.innerHTML = `
          <button class="btn btn-secondary drawer-btn-tap-mana" id="drawer-btn-tap-mana">
            ⚡ Tap for Mana
          </button>
        `;
        manaActionEl.querySelector('#drawer-btn-tap-mana')?.addEventListener('click', () => {
          if (this.card && this.playerId) {
            this.close();
            this.onTapForMana({ card: this.card, playerId: this.playerId });
          }
        });
      }
    }

    // Is it an Equipment or Aura?
    const isEquip = Boolean(
      card?.compiledMechanics?.isEquipment ||
      card?.compiledMechanics?.isAura ||
      /equipment|aura/i.test(card?.typeLine || card?.type || '')
    );
    if (equipActionEl) {
      equipActionEl.style.display = isEquip ? 'block' : 'none';
      if (isEquip) {
        const equipBtn = this.element.querySelector('#drawer-btn-equip');
        if (equipBtn) {
          const pState = ctx?.tabletopState?.players?.[pid];
          const hasForgeAnew = Boolean(
            ctx?.hasForgeAnew ||
            pState?.battlefield?.noncreatures?.some(c =>
              /forge anew/i.test(c?.name || '') ||
              c?.compiledMechanics?.staticPermissions?.some(sp => sp.type === 'FIRST_EQUIP_COST_ZERO')
            )
          );
          const equipsActivated = pState?.equipsActivatedThisTurn || 0;
          if (hasForgeAnew && equipsActivated === 0) {
            equipBtn.textContent = '⚔️ Equip to Creature ({0} — Free via Forge Anew!)';
          } else {
            equipBtn.textContent = '⚔️ Equip to Creature';
          }
        }
      }
    }
    if (selectListEl) {
      selectListEl.innerHTML = '';
      selectListEl.style.display = 'none';
    }

    if (abilitiesListEl) {
      abilitiesListEl.innerHTML = '';
      const isForgeAnew = /forge anew/i.test(card?.name || '');
      let list = Array.isArray(abilities) && abilities.length > 0
        ? [...abilities]
        : [...(card?.compiledMechanics?.activatedAbilities || card?.activatedAbilities || card?.abilities || [])];
      if (isInkmoth) {
        list = list.filter(a => a && a.id !== 'ANIMATE_LAND' && a.action !== 'ANIMATE_LAND');
      }
      if (isStartingTown || isSpireOfIndustry) {
        list = list.filter(a => a && !a.isManaAbility && a.action !== 'TAP_MANA');
      }
      const isClass = /class/i.test(card?.typeLine || card?.type || '') ||
        Boolean(card?.classLevel || card?.level || card?.isClass) ||
        /talent/i.test(card?.name || '');
      if (isClass) {
        const currentLevel = Number(card?.classLevel ?? card?.level ?? 1);
        if (currentLevel >= 3) {
          abilitiesListEl.innerHTML = `
            <div class="drawer-static-badge" style="padding: 10px 14px; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; border-radius: 6px; font-size: 0.85rem; color: #6ee7b7; line-height: 1.4;">
              🏆 <strong>Class Level 3 (Max Level) Active:</strong> Creature tokens you control get +2/+2.
            </div>
          `;
          return;
        }

        const nextLevel = currentLevel + 1;
        // Keep non-class abilities or class abilities matching nextLevel
        list = list.filter(a => (!a.isClassLevelUp && a.action !== 'LEVEL_UP_CLASS') || a.targetLevel === nextLevel);

        if (!list.some(a => a.isClassLevelUp || a.action === 'LEVEL_UP_CLASS')) {
          if (nextLevel === 2) {
            list.push({
              id: 'LEVEL_UP_2',
              action: 'LEVEL_UP_CLASS',
              targetLevel: 2,
              cost: { mana: '{W}' },
              timing: 'SORCERY',
              requiresTap: false,
              isClassLevelUp: true,
              text: '{W}: Level 2 — When this Class becomes level 2, create a token that\'s a copy of target token you control.'
            });
          } else if (nextLevel === 3) {
            list.push({
              id: 'LEVEL_UP_3',
              action: 'LEVEL_UP_CLASS',
              targetLevel: 3,
              cost: { mana: '{3}{W}' },
              timing: 'SORCERY',
              requiresTap: false,
              isClassLevelUp: true,
              text: '{3}{W}: Level 3 — Creature tokens you control get +2/+2.'
            });
          }
        }
      }

      if (isForgeAnew) {
        const pState = ctx?.tabletopState?.players?.[pid];
        const usedCount = pState?.equipsActivatedThisTurn || 0;
        abilitiesListEl.innerHTML = `
          <div class="drawer-static-badge" style="padding: 8px 12px; background: rgba(59, 130, 246, 0.15); border: 1px solid #3b82f6; border-radius: 6px; font-size: 0.8rem; color: #93c5fd; line-height: 1.4;">
            ✨ <strong>Static Active:</strong> First Equip each turn costs {0} (Used: ${usedCount}/1 this turn) • Instant-speed Equip on your turn
          </div>
        `;
      } else if (list.length === 0 && !isLand && !isEquip) {
        abilitiesListEl.innerHTML = '<div class="drawer-empty-abilities">No activated abilities on this permanent.</div>';
      } else {
        for (const ability of list) {
          const abItem = document.createElement('div');
          abItem.className = 'drawer-ability-item';
          const isLevelUp = ability.isClassLevelUp || ability.action === 'LEVEL_UP_CLASS';
          const costStr = typeof ability.cost === 'string' ? ability.cost : (ability.cost?.mana || '');
          const btnLabel = isLevelUp ? `⭐ Level Up to Level ${ability.targetLevel || 2}` : 'Activate';
          abItem.innerHTML = `
            <div class="ability-text" style="font-size: 0.85rem; line-height: 1.4; margin-bottom: 6px;">
              ${ability.text || ability.description || 'Ability'}
            </div>
            <button class="btn btn-primary btn-sm drawer-btn-activate" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; font-weight: 600;">
              <span>${btnLabel}</span>
              ${costStr ? `<span class="ability-cost-badge" style="background: rgba(0,0,0,0.25); padding: 2px 6px; border-radius: 4px; font-family: monospace;">${costStr}</span>` : ''}
            </button>
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
