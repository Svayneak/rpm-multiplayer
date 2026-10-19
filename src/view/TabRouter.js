/**
 * TabRouter.js
 * Decoupled Top-Level Navigation & Tab Lockout Middleware
 * 
 * Part of RPM Multiplayer - Feature 14
 * Document ID: SPEC-RPM-PLATFORM-014
 * Enforces Architectural Invariants:
 * - INV-LOCKOUT-1: Tab Lockout Invariant (Arena Active = Non-Battle Tabs Disabled)
 * 
 * @module TabRouter
 */

import { EventEmitter } from '../EventEmitter.js';

export const TABS = Object.freeze({
  ARENA: 'ARENA',
  DECKBUILDER: 'DECKBUILDER',
  LOBBY: 'LOBBY',
  PROFILE: 'PROFILE',
  LEADERBOARD: 'LEADERBOARD'
});

export const LOCKED_TABS_DURING_MATCH = new Set([
  TABS.DECKBUILDER,
  TABS.PROFILE,
  TABS.LEADERBOARD,
  TABS.LOBBY
]);

/**
 * TabRouter
 * Manages top-level application navigation with strict lockout state machine guards.
 */
export class TabRouter extends EventEmitter {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.initialTab='LOBBY']
   * @param {Function} [options.onTabChange]
   * @param {Function} [options.onLockoutBlocked]
   */
  constructor(options = {}) {
    super();
    this.currentTab = (options.initialTab || TABS.LOBBY).toUpperCase();
    this.onTabChange = options.onTabChange || null;
    this.onLockoutBlocked = options.onLockoutBlocked || null;
  }

  /**
   * Returns current active tab.
   * @returns {string}
   */
  getCurrentTab() {
    return this.currentTab;
  }

  /**
   * Evaluates if navigation to targetTab is permitted under INV-LOCKOUT-1.
   * 
   * @param {string} targetTab 
   * @param {Object} [matchState={}] 
   * @param {boolean} [isSpectator=false] 
   * @returns {boolean}
   */
  canNavigate(targetTab, matchState = {}, isSpectator = false) {
    if (!targetTab) return false;
    const tab = targetTab.toUpperCase();

    // Arena is always accessible
    if (tab === TABS.ARENA) {
      return true;
    }

    // Spectators are strictly exempt from lockout
    if (isSpectator === true) {
      return true;
    }

    // When an active match is in progress, non-battle tabs are locked
    const isMatchActive = matchState && (matchState.status === 'ACTIVE' || matchState.isMatchActive === true);
    if (isMatchActive) {
      if (LOCKED_TABS_DURING_MATCH.has(tab)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Attempts navigation to targetTab.
   * 
   * @param {string} targetTab 
   * @param {Object} [matchState={}] 
   * @param {boolean} [isSpectator=false] 
   * @returns {{ success: boolean, activeTab: string, reason?: string }}
   */
  navigate(targetTab, matchState = {}, isSpectator = false) {
    if (!targetTab) {
      return { success: false, activeTab: this.currentTab, reason: 'INVALID_TAB' };
    }

    const tab = targetTab.toUpperCase();
    const allowed = this.canNavigate(tab, matchState, isSpectator);

    if (!allowed) {
      if (typeof this.onLockoutBlocked === 'function') {
        this.onLockoutBlocked(tab);
      }
      this.emit('lockout_blocked', {
        targetTab: tab,
        currentTab: this.currentTab,
        matchState
      });
      return {
        success: false,
        activeTab: this.currentTab,
        reason: 'TAB_LOCKED_ACTIVE_MATCH',
        targetTab: tab
      };
    }

    const prevTab = this.currentTab;
    this.currentTab = tab;

    if (typeof this.onTabChange === 'function') {
      this.onTabChange(tab, prevTab);
    }
    this.emit('tab_changed', {
      tab,
      prevTab
    });

    return {
      success: true,
      activeTab: tab,
      prevTab
    };
  }

  /**
   * Resets active tab without lockout check (e.g. on match concede or completion).
   * @param {string} [tab=TABS.LOBBY] 
   */
  reset(tab = TABS.LOBBY) {
    const prevTab = this.currentTab;
    this.currentTab = tab.toUpperCase();
    this.emit('tab_changed', {
      tab: this.currentTab,
      prevTab
    });
  }
}

export default TabRouter;
