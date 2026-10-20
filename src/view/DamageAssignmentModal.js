/**
 * DamageAssignmentModal.js - Combat Damage Assignment & Manual Override Modal
 * 
 * Part of RPM Multiplayer - Feature 20
 * Specification: SPEC-RPM-COMBAT-DAMAGE-020 (INV-DAMAGE-ASSIGN-1)
 * 
 * Implements:
 * - Interactive combat damage assignment sliders/steppers for multiple blockers
 * - Trample remainder assignment to defending player
 * - Real-time power balance validator ensuring total assigned === attacker power
 * 
 * @module DamageAssignmentModal
 */

export class DamageAssignmentModal {
  /**
   * @param {Object} [options={}]
   * @param {HTMLElement} [options.container]
   * @param {Function} [options.onConfirmAssignment]
   * @param {Function} [options.onCancel]
   */
  constructor(options = {}) {
    this.container = options.container || (typeof document !== 'undefined' ? document.body : null);
    this.onConfirmAssignment = options.onConfirmAssignment || (() => {});
    this.onCancel = options.onCancel || (() => {});

    this.isOpen = false;
    this.element = null;
    this.attacker = null;
    this.blockers = [];
    this.assignments = new Map(); // blockerId or 'PLAYER' -> number
    this.totalPower = 0;
    this.hasTrample = false;

    if (typeof document !== 'undefined') {
      this.init();
    }
  }

  init() {
    if (this.element || !this.container) return;

    this.element = document.createElement('div');
    this.element.className = 'damage-assign-backdrop hidden';
    this.element.style.display = 'none';
    this.element.id = 'damage-assignment-modal';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', 'Assign Combat Damage');

    this.element.innerHTML = `
      <div class="damage-assign-panel">
        <div class="damage-assign-header">
          <div class="assign-title-row">
            <h2 class="damage-assign-title" id="damage-assign-title">Assign Combat Damage</h2>
            <button class="damage-btn-close" id="damage-btn-close" aria-label="Close">×</button>
          </div>
          <div class="assign-power-tracker">
            <span>Attacker Power: <strong id="assign-attacker-power">0</strong></span>
            <span>Assigned: <strong id="assign-total-assigned">0</strong></span>
            <span>Remaining: <strong id="assign-power-remaining">0</strong></span>
          </div>
        </div>

        <div class="damage-assign-targets-list" id="damage-assign-targets-list"></div>

        <div class="damage-assign-footer">
          <button class="btn btn-secondary" id="damage-btn-cancel">Cancel</button>
          <button class="btn btn-primary" id="damage-btn-confirm" disabled>Confirm Damage</button>
        </div>
      </div>
    `;

    this.container.appendChild(this.element);

    this.element.querySelector('#damage-btn-close')?.addEventListener('click', () => this.handleCancel());
    this.element.querySelector('#damage-btn-cancel')?.addEventListener('click', () => this.handleCancel());
    this.element.querySelector('#damage-btn-confirm')?.addEventListener('click', () => this.handleConfirm());
  }

  /**
   * Opens the damage assignment modal.
   * 
   * @param {Object} options
   * @param {Object} options.attacker
   * @param {Array<Object>} options.blockers
   * @param {number} options.attackerPower
   * @param {Object} [options.suggestedAssignments]
   */
  open({ attacker, blockers = [], attackerPower, suggestedAssignments = {} }) {
    this.attacker = attacker;
    this.blockers = Array.isArray(blockers) ? [...blockers] : [];
    this.totalPower = Math.max(0, Number(attackerPower) || 0);
    this.hasTrample = !!(attacker?.keywords?.trample || /trample/i.test(attacker?.text || ''));
    this.assignments.clear();

    // Initialize with suggested or 0
    for (const b of this.blockers) {
      this.assignments.set(b.instanceId, suggestedAssignments[b.instanceId] || 0);
    }
    if (this.hasTrample) {
      this.assignments.set('PLAYER', suggestedAssignments.PLAYER || 0);
    }

    this.isOpen = true;
    if (!this.element) this.init();
    if (!this.element) return;

    this.element.style.display = 'flex';
    this.element.classList.remove('hidden');
    this.render();
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
    const assignedTotal = this.getTotalAssigned();
    if (assignedTotal !== this.totalPower) return;

    const blockerMap = {};
    for (const b of this.blockers) {
      blockerMap[b.instanceId] = this.assignments.get(b.instanceId) || 0;
    }
    const playerDamage = this.assignments.get('PLAYER') || 0;

    this.close();
    this.onConfirmAssignment({
      attackerId: this.attacker?.instanceId,
      blockerAssignments: blockerMap,
      playerDamage
    });
  }

  getTotalAssigned() {
    let total = 0;
    for (const val of this.assignments.values()) {
      total += val;
    }
    return total;
  }

  updateDamage(targetKey, delta) {
    const current = this.assignments.get(targetKey) || 0;
    const next = Math.max(0, current + delta);
    const potentialTotal = this.getTotalAssigned() - current + next;

    if (potentialTotal <= this.totalPower) {
      this.assignments.set(targetKey, next);
      this.render();
    }
  }

  render() {
    if (!this.element) return;

    const totalAssigned = this.getTotalAssigned();
    const remaining = this.totalPower - totalAssigned;

    const powerEl = this.element.querySelector('#assign-attacker-power');
    const assignedEl = this.element.querySelector('#assign-total-assigned');
    const remainEl = this.element.querySelector('#assign-power-remaining');
    const confirmBtn = this.element.querySelector('#damage-btn-confirm');
    const list = this.element.querySelector('#damage-assign-targets-list');

    if (powerEl) powerEl.textContent = this.totalPower;
    if (assignedEl) assignedEl.textContent = totalAssigned;
    if (remainEl) {
      remainEl.textContent = remaining;
      remainEl.style.color = remaining === 0 ? '#4ade80' : '#f87171';
    }
    if (confirmBtn) {
      confirmBtn.disabled = (totalAssigned !== this.totalPower);
    }

    if (!list) return;
    list.innerHTML = '';

    // Render Blockers
    for (const blocker of this.blockers) {
      const assigned = this.assignments.get(blocker.instanceId) || 0;
      const row = document.createElement('div');
      row.className = 'assign-target-row';
      row.innerHTML = `
        <div class="target-desc">
          <span class="target-name">${blocker.name || 'Blocker'}</span>
          <span class="target-stats">${blocker.power || 0}/${blocker.toughness || 0} (Marked: ${blocker.damageMarked || 0})</span>
        </div>
        <div class="assign-stepper">
          <button class="btn btn-sm btn-minus" data-key="${blocker.instanceId}">-</button>
          <span class="assigned-val">${assigned}</span>
          <button class="btn btn-sm btn-plus" data-key="${blocker.instanceId}">+</button>
        </div>
      `;

      row.querySelector('.btn-minus')?.addEventListener('click', () => this.updateDamage(blocker.instanceId, -1));
      row.querySelector('.btn-plus')?.addEventListener('click', () => this.updateDamage(blocker.instanceId, 1));
      list.appendChild(row);
    }

    // Render Trample Defending Player Target if Trample is active
    if (this.hasTrample) {
      const assigned = this.assignments.get('PLAYER') || 0;
      const row = document.createElement('div');
      row.className = 'assign-target-row trample-row';
      row.innerHTML = `
        <div class="target-desc">
          <span class="target-name">Defending Player (Trample)</span>
          <span class="target-stats">Excess Combat Damage</span>
        </div>
        <div class="assign-stepper">
          <button class="btn btn-sm btn-minus" data-key="PLAYER">-</button>
          <span class="assigned-val">${assigned}</span>
          <button class="btn btn-sm btn-plus" data-key="PLAYER">+</button>
        </div>
      `;

      row.querySelector('.btn-minus')?.addEventListener('click', () => this.updateDamage('PLAYER', -1));
      row.querySelector('.btn-plus')?.addEventListener('click', () => this.updateDamage('PLAYER', 1));
      list.appendChild(row);
    }
  }
}

export default DamageAssignmentModal;
