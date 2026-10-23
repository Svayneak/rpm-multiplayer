/**
 * src/ProcessTraceLogger.js
 * Deterministic Ring-Buffered Execution & Process Trace Logger
 *
 * Captures monotonic, structured telemetry across:
 * - MANA_TRACE: manaPoolBefore, untappedLandsBefore, spellCost, landsTappedByAutoTap, manaPoolAfter
 * - COMBAT_TRACE: BEGIN_COMBAT, DECLARE_ATTACKERS, DECLARE_BLOCKERS (waitingForDefender), COMBAT_DAMAGE math
 * - TURN_TRACE: caller stack/source on turnNumber & activePlayerId transitions
 * - UI_REJECTION: exact rejection reasons for card, land, attacker, or blocker clicks
 *
 * Exposes `globalThis.__PROCESS_TRACE__` (and `window.__PROCESS_TRACE__` when in browser)
 * and supports JSON / .log export.
 *
 * @module ProcessTraceLogger
 */

export class ProcessTraceLogger {
  /**
   * @param {Object} [options={}]
   * @param {number} [options.maxEntries=500]
   */
  constructor(options = {}) {
    this.maxEntries = options.maxEntries || 500;
    this.entries = [];
    this.seq = 0;
    this.onRecord = typeof options.onRecord === 'function' ? options.onRecord : null;

    if (typeof globalThis !== 'undefined') {
      globalThis.__PROCESS_TRACE__ = this;
    }
    if (typeof window !== 'undefined') {
      window.__PROCESS_TRACE__ = this;
    }
  }

  /**
   * Sets the listener invoked synchronously whenever a trace entry is recorded.
   * @param {Function|null} fn
   */
  setOnRecord(fn) {
    this.onRecord = typeof fn === 'function' ? fn : null;
  }

  /**
   * Records a structured process trace entry.
   *
   * @param {Object} params
   * @param {string} params.category - 'MANA_TRACE' | 'COMBAT_TRACE' | 'TURN_TRACE' | 'UI_REJECTION' | 'PREGAME_TRACE' | 'STACK_TRACE' | 'ACTION_TRACE'
   * @param {string} params.action
   * @param {Object} [params.stateContext={}]
   * @param {Object} [params.payload={}]
   * @returns {Object} Recorded trace entry
   */
  record({ category = 'ACTION_TRACE', action = 'UNKNOWN', stateContext = {}, payload = {} } = {}) {
    const entry = {
      seq: ++this.seq,
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      turn: stateContext.turn ?? 1,
      round: stateContext.round ?? 1,
      phase: stateContext.phase ?? 'BEGINNING',
      step: stateContext.step ?? 'UNTAP',
      activePlayerId: stateContext.activePlayerId ?? null,
      priorityPlayerId: stateContext.priorityPlayerId ?? null,
      defendingPlayerId: stateContext.defendingPlayerId ?? null,
      category,
      action,
      payload: this._cloneSafe(payload)
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    if (typeof globalThis !== 'undefined') {
      globalThis.__PROCESS_TRACE__ = this;
    }
    if (typeof window !== 'undefined') {
      window.__PROCESS_TRACE__ = this;
    }
    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug('[RULE_TRACE]', entry);
    }
    if (typeof this.onRecord === 'function') {
      try {
        this.onRecord(entry);
      } catch (_) {}
    }
    return entry;
  }

  _cloneSafe(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (_) {
      return { note: String(obj) };
    }
  }

  /**
   * Returns all entries or filtered by category string or { category, action } object.
   * @param {string|Object} [filter]
   * @returns {Array<Object>}
   */
  getEntries(filter = null) {
    if (!filter) return [...this.entries];
    if (typeof filter === 'string') {
      return this.entries.filter(e => e.category === filter);
    }
    return this.entries.filter(e => {
      if (filter.category && e.category !== filter.category) return false;
      if (filter.action && e.action !== filter.action) return false;
      return true;
    });
  }

  /**
   * Formats the trace buffer as a human-readable `.log` / JSONL text dump.
   * @returns {string}
   */
  formatAsLogText() {
    return this.entries.map(e => {
      return `[#${String(e.seq).padStart(4, '0')}] [${e.isoTime}] [T${e.turn}/R${e.round} ${e.step}] [Active:${e.activePlayerId} Prio:${e.priorityPlayerId}${e.defendingPlayerId ? ` Def:${e.defendingPlayerId}` : ''}] [${e.category}:${e.action}] ${JSON.stringify(e.payload)}`;
    }).join('\n');
  }

  formatAsText() {
    return this.formatAsLogText();
  }

  /**
   * Exports the full trace as a formatted JSON string.
   * @returns {string}
   */
  toJSONString() {
    return JSON.stringify(this.entries, null, 2);
  }

  /**
   * Alias for JSON export.
   * @returns {string}
   */
  exportAsJSON() {
    return JSON.stringify(this.entries, null, 2);
  }

  /**
   * Clears all recorded trace entries.
   */
  clear() {
    this.entries = [];
    this.seq = 0;
  }
}

export const defaultProcessTraceLogger = new ProcessTraceLogger();
export default ProcessTraceLogger;
