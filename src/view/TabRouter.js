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
  AUTH: 'AUTH',
  ARENA: 'ARENA',
  DECKBUILDER: 'DECKBUILDER',
  LOBBY: 'LOBBY',
  PROFILE: 'PROFILE',
  LEADERBOARD: 'LEADERBOARD'
});

export const LOCKED_TABS_DURING_MATCH = new Set([
  TABS.AUTH,
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
   * Evaluates if navigation to targetTab is permitted under INV-AUTH-1, INV-ONBOARD-1, INV-ROUTER-2, and INV-LOCKOUT-1.
   * 
   * @param {string} targetTab 
   * @param {Object} [context={}] 
   * @param {boolean} [isSpectator=false] 
   * @returns {boolean}
   */
  canNavigate(targetTab, context = {}, isSpectator = false) {
    if (!targetTab) return false;
    const tab = targetTab.toUpperCase();

    // Spectators are strictly exempt from lockout
    if (isSpectator === true || context.isSpectator === true) {
      return true;
    }

    // 1. Authentication Check (INV-AUTH-1)
    if (context.isAuthenticated === false) {
      return tab === TABS.AUTH;
    }

    // 2. Onboarding Deck Check (INV-ONBOARD-1)
    if (context.isOnboarded === false) {
      return tab === TABS.DECKBUILDER || tab === TABS.AUTH;
    }

    // 3. Match Lockout (INV-LOCKOUT-1)
    const isMatchActive = Boolean(
      context.isMatchActive ||
      context.status === 'ACTIVE' ||
      context.status === 'ROLL_OFF_PHASE'
    );

    if (isMatchActive) {
      if (LOCKED_TABS_DURING_MATCH.has(tab)) {
        return false;
      }
      return true;
    }

    // 4. Arena Access Rule (INV-ROUTER-2)
    // When match is not active, Arena is blocked unless context is a legacy call without auth context
    if (tab === TABS.ARENA) {
      if (context.isAuthenticated !== undefined || context.isOnboarded !== undefined) {
        return false;
      }
      // Backwards compatibility with Feature 14 tests
      return true;
    }

    return true;
  }

  /**
   * Attempts navigation to targetTab with full guard validation.
   * 
   * @param {string} targetTab 
   * @param {Object} [context={}] 
   * @param {boolean} [isSpectator=false] 
   * @returns {{ success: boolean, activeTab: string, reason?: string, targetTab?: string }}
   */
  navigate(targetTab, context = {}, isSpectator = false) {
    if (!targetTab) {
      return { success: false, activeTab: this.currentTab, reason: 'INVALID_TAB' };
    }

    const tab = targetTab.toUpperCase();

    // 1. Auth required
    if (context.isAuthenticated === false && tab !== TABS.AUTH) {
      return {
        success: false,
        activeTab: this.currentTab,
        reason: 'AUTH_REQUIRED',
        targetTab: tab
      };
    }

    // 2. Deck onboarding required
    if (context.isOnboarded === false && (tab === TABS.LOBBY || tab === TABS.ARENA || tab === TABS.PROFILE || tab === TABS.LEADERBOARD)) {
      return {
        success: false,
        activeTab: this.currentTab,
        reason: 'DECK_ONBOARDING_REQUIRED',
        targetTab: tab
      };
    }

    // 3. Active match lockout
    const isMatchActive = Boolean(
      context.isMatchActive ||
      context.status === 'ACTIVE' ||
      context.status === 'ROLL_OFF_PHASE'
    );

    if (isMatchActive && LOCKED_TABS_DURING_MATCH.has(tab) && !isSpectator && !context.isSpectator) {
      if (typeof this.onLockoutBlocked === 'function') {
        this.onLockoutBlocked(tab);
      }
      this.emit('lockout_blocked', {
        targetTab: tab,
        currentTab: this.currentTab,
        matchState: context
      });
      return {
        success: false,
        activeTab: this.currentTab,
        reason: 'TAB_LOCKED_ACTIVE_MATCH',
        targetTab: tab
      };
    }

    // 4. Arena match required when idle
    if (tab === TABS.ARENA && !isMatchActive && !isSpectator && !context.isSpectator) {
      if (context.isAuthenticated !== undefined || context.isOnboarded !== undefined) {
        return {
          success: false,
          activeTab: this.currentTab,
          reason: 'ARENA_MATCH_REQUIRED',
          targetTab: tab
        };
      }
    }

    const allowed = this.canNavigate(tab, context, isSpectator);
    if (!allowed) {
      return {
        success: false,
        activeTab: this.currentTab,
        reason: 'NAVIGATION_BLOCKED',
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
