/**
 * src/AuthManager.js
 * PostgREST 365-Day Authentication, Device Handover, AI Settings & Bug Reporting
 * 
 * Part of RPM Multiplayer - Feature 15
 * Document ID: SPEC-RPM-ONBOARD-015
 * Enforces Architectural Invariants:
 * - INV-AUTH-1: Authentication Gate & 365-Day Session Persistence
 * - INV-ONBOARD-1: Mandatory Deck Creator Gate
 * - INV-TELEMETRY-1: Event Logging & Non-Blocking Audit Trail
 * - INV-ARCH-HEADLESS: Strict typeof guards on browser globals
 * 
 * @module AuthManager
 */

import { EventEmitter } from './EventEmitter.js';

export const SUPABASE_URL = (typeof process !== 'undefined' && process.env?.SUPABASE_URL) || 'https://naacgdwtglvcumaccime.supabase.co';
export const SUPABASE_ANON_KEY = (typeof process !== 'undefined' && (process.env?.SUPABASE_SERVICE_ROLE_KEY || process.env?.SUPABASE_ANON_KEY)) || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5hYWNnZHd0Z2x2Y3VtYWNjaW1lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5Nzc2NDUsImV4cCI6MjEwMzU1MzY0NX0.QzVkPr7-aKYLTxVc6RzB_maVBykHBUvtvIIZm-522JE';

export const AUTH_STORAGE_KEY = 'rpm_auth_session';
export const AUTH_TOKEN_STORAGE_KEY = 'rpm_auth_token_v1';
export const TELEMETRY_STORAGE_KEY = 'rpm_telemetry_buffer';
export const MAX_TELEMETRY_BUFFER_SIZE = 100;
export const TOKEN_EXPIRY_DAYS = 365;

/**
 * Detects client device label ('MOBILE' | 'DESKTOP') with safe typeof guards.
 * @returns {'MOBILE'|'DESKTOP'}
 */
export function getDeviceLabel() {
  if (typeof window !== 'undefined') {
    const isSmallScreen = typeof window.innerWidth === 'number' && window.innerWidth < 768;
    const isMobileUa = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    if (isSmallScreen || isMobileUa) return 'MOBILE';
  }
  return 'DESKTOP';
}

/**
 * 5 Tournament Modern Starter Archetypes (Section 5.1)
 */
export const STARTER_ARCHETYPES = Object.freeze({
  MODERN_BURN_R: {
    id: 'MODERN_BURN_R',
    code: 'STARTER_RED_BURN',
    name: 'Mono-Red Burn',
    archetype: 'Aggro / Direct Damage',
    colorIdentity: ['R'],
    previewCards: ['Goblin Guide', 'Monastery Swiftspear', 'Eidolon of the Great Revel', 'Lightning Bolt'],
    mainboard: [
      { name: 'Mountain', count: 16, cmc: 0, type: 'Land' },
      { name: 'Sunbaked Canyon', count: 4, cmc: 0, type: 'Land' },
      { name: 'Goblin Guide', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Monastery Swiftspear', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Eidolon of the Great Revel', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Lightning Bolt', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Lava Spike', count: 4, cmc: 1, type: 'Sorcery' },
      { name: 'Rift Bolt', count: 4, cmc: 3, type: 'Sorcery' },
      { name: 'Skewer the Critics', count: 4, cmc: 3, type: 'Sorcery' },
      { name: 'Boros Charm', count: 4, cmc: 2, type: 'Instant' },
      { name: 'Searing Blaze', count: 4, cmc: 2, type: 'Instant' },
      { name: 'Roiling Vortex', count: 4, cmc: 2, type: 'Enchantment' }
    ]
  },
  MODERN_MURKTIDE_UR: {
    id: 'MODERN_MURKTIDE_UR',
    code: 'STARTER_IZZET_MURKTIDE',
    name: 'Izzet Murktide',
    archetype: 'Tempo / Counter-Burn',
    colorIdentity: ['U', 'R'],
    previewCards: ['Murktide Regent', "Dragon's Rage Channeler", 'Ragavan, Nimble Pilferer', 'Counterspell'],
    mainboard: [
      { name: 'Steam Vents', count: 4, cmc: 0, type: 'Land' },
      { name: 'Spirebluff Canal', count: 4, cmc: 0, type: 'Land' },
      { name: 'Island', count: 6, cmc: 0, type: 'Land' },
      { name: 'Mountain', count: 4, cmc: 0, type: 'Land' },
      { name: 'Murktide Regent', count: 4, cmc: 7, type: 'Creature' },
      { name: "Dragon's Rage Channeler", count: 4, cmc: 1, type: 'Creature' },
      { name: 'Ragavan, Nimble Pilferer', count: 2, cmc: 1, type: 'Creature' },
      { name: 'Brazen Borrower', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Lightning Bolt', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Counterspell', count: 4, cmc: 2, type: 'Instant' },
      { name: 'Expressive Iteration', count: 4, cmc: 2, type: 'Sorcery' },
      { name: 'Consider', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Opt', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Unholy Heat', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Spell Pierce', count: 4, cmc: 1, type: 'Instant' }
    ]
  },
  MODERN_YAWGMOTH_BG: {
    id: 'MODERN_YAWGMOTH_BG',
    code: 'STARTER_GOLGARI_YAWGMOTH',
    name: 'Golgari Yawgmoth',
    archetype: 'Combo / Sacrifice Midrange',
    colorIdentity: ['B', 'G'],
    previewCards: ['Yawgmoth, Thran Physician', 'Young Wolf', 'Strangleroot Geist', 'Chord of Calling'],
    mainboard: [
      { name: 'Overgrown Tomb', count: 4, cmc: 0, type: 'Land' },
      { name: 'Blooming Marsh', count: 4, cmc: 0, type: 'Land' },
      { name: 'Forest', count: 8, cmc: 0, type: 'Land' },
      { name: 'Swamp', count: 6, cmc: 0, type: 'Land' },
      { name: 'Yawgmoth, Thran Physician', count: 4, cmc: 4, type: 'Creature' },
      { name: 'Young Wolf', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Strangleroot Geist', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Wall of Roots', count: 4, cmc: 2, type: 'Creature' },
      { name: 'Birds of Paradise', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Delighted Halfling', count: 4, cmc: 1, type: 'Creature' },
      { name: 'Grist, the Hunger Tide', count: 4, cmc: 3, type: 'Planeswalker' },
      { name: 'Chord of Calling', count: 4, cmc: 3, type: 'Instant' },
      { name: 'Eldritch Evolution', count: 4, cmc: 3, type: 'Sorcery' },
      { name: 'Fatal Push', count: 2, cmc: 1, type: 'Instant' }
    ]
  },
  MODERN_TRON_G: {
    id: 'MODERN_TRON_G',
    code: 'STARTER_MONO_GREEN_TRON',
    name: 'Mono-Green Tron',
    archetype: 'Big Mana / Eldrazi',
    colorIdentity: ['G', 'C'],
    previewCards: ["Urza's Tower", 'Karn Liberated', 'Wurmcoil Engine', 'Ulamog, the Ceaseless Hunger'],
    mainboard: [
      { name: "Urza's Tower", count: 4, cmc: 0, type: 'Land' },
      { name: "Urza's Power Plant", count: 4, cmc: 0, type: 'Land' },
      { name: "Urza's Mine", count: 4, cmc: 0, type: 'Land' },
      { name: 'Forest', count: 5, cmc: 0, type: 'Land' },
      { name: 'Boseiju, Who Endures', count: 2, cmc: 0, type: 'Land' },
      { name: 'Expedition Map', count: 4, cmc: 1, type: 'Artifact' },
      { name: 'Chromatic Sphere', count: 4, cmc: 1, type: 'Artifact' },
      { name: 'Chromatic Star', count: 4, cmc: 1, type: 'Artifact' },
      { name: 'Oblivion Stone', count: 4, cmc: 3, type: 'Artifact' },
      { name: 'Sylvan Scrying', count: 4, cmc: 2, type: 'Sorcery' },
      { name: 'Ancient Stirrings', count: 4, cmc: 1, type: 'Sorcery' },
      { name: 'Karn Liberated', count: 4, cmc: 7, type: 'Planeswalker' },
      { name: 'Karn, the Great Creator', count: 4, cmc: 4, type: 'Planeswalker' },
      { name: 'Wurmcoil Engine', count: 4, cmc: 6, type: 'Artifact Creature' },
      { name: 'Sundering Titan', count: 1, cmc: 8, type: 'Artifact Creature' },
      { name: 'Ulamog, the Ceaseless Hunger', count: 4, cmc: 10, type: 'Creature' }
    ]
  },
  MODERN_RHINOS_URG: {
    id: 'MODERN_RHINOS_URG',
    code: 'STARTER_TEMUR_RHINOS',
    name: 'Temur Rhinos',
    archetype: 'Cascade / Footfalls Midrange',
    colorIdentity: ['U', 'R', 'G'],
    previewCards: ['Shardless Agent', 'Violent Outburst', 'Crashing Footfalls', 'Force of Negation'],
    mainboard: [
      { name: 'Breeding Pool', count: 4, cmc: 0, type: 'Land' },
      { name: 'Stomping Ground', count: 4, cmc: 0, type: 'Land' },
      { name: 'Steam Vents', count: 4, cmc: 0, type: 'Land' },
      { name: 'Island', count: 4, cmc: 0, type: 'Land' },
      { name: 'Forest', count: 3, cmc: 0, type: 'Land' },
      { name: 'Mountain', count: 3, cmc: 0, type: 'Land' },
      { name: 'Shardless Agent', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Violent Outburst', count: 4, cmc: 3, type: 'Instant' },
      { name: 'Crashing Footfalls', count: 4, cmc: 0, type: 'Sorcery' },
      { name: 'Fire // Ice', count: 4, cmc: 2, type: 'Instant' },
      { name: 'Dead // Gone', count: 4, cmc: 1, type: 'Instant' },
      { name: 'Brazen Borrower', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Bonecrusher Giant', count: 4, cmc: 3, type: 'Creature' },
      { name: 'Subtlety', count: 4, cmc: 4, type: 'Creature' },
      { name: 'Fury', count: 2, cmc: 5, type: 'Creature' },
      { name: 'Force of Negation', count: 4, cmc: 3, type: 'Instant' }
    ]
  }
});

export const STARTER_ALIASES = Object.freeze({
  STARTER_RED_BURN: STARTER_ARCHETYPES.MODERN_BURN_R,
  STARTER_IZZET_MURKTIDE: STARTER_ARCHETYPES.MODERN_MURKTIDE_UR,
  STARTER_GOLGARI_YAWGMOTH: STARTER_ARCHETYPES.MODERN_YAWGMOTH_BG,
  STARTER_MONO_GREEN_TRON: STARTER_ARCHETYPES.MODERN_TRON_G,
  STARTER_TEMUR_RHINOS: STARTER_ARCHETYPES.MODERN_RHINOS_URG,
  R: STARTER_ARCHETYPES.MODERN_BURN_R,
  UR: STARTER_ARCHETYPES.MODERN_MURKTIDE_UR,
  BG: STARTER_ARCHETYPES.MODERN_YAWGMOTH_BG,
  G: STARTER_ARCHETYPES.MODERN_TRON_G,
  URG: STARTER_ARCHETYPES.MODERN_RHINOS_URG
});

export function getStarterDeck(codeOrKey) {
  if (!codeOrKey) return null;
  const key = String(codeOrKey).trim();
  if (STARTER_ARCHETYPES[key]) return STARTER_ARCHETYPES[key];
  if (STARTER_ALIASES[key]) return STARTER_ALIASES[key];
  return null;
}

export function calculateAge(dobString) {
  if (!dobString) return 0;
  const birth = new Date(dobString);
  if (isNaN(birth.getTime())) return 0;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

export function generateUUID() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [...bytes].map((b, i) =>
      ([4, 6, 8, 10].includes(i) ? '-' : '') + b.toString(16).padStart(2, '0')
    ).join('');
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

class MemoryStorage {
  constructor() {
    this._store = new Map();
  }
  getItem(k) { return this._store.has(k) ? this._store.get(k) : null; }
  setItem(k, v) { this._store.set(k, String(v)); }
  removeItem(k) { this._store.delete(k); }
  clear() { this._store.clear(); }
}

/**
 * AuthManager
 * Orchestrates relay PostgREST authentication, device takeover handover,
 * 365-day sessions, AI preferences, bug telemetry, and offline fallback.
 */
export class AuthManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.supabaseUrl = options.supabaseUrl || SUPABASE_URL;
    this.supabaseAnonKey = options.supabaseAnonKey || SUPABASE_ANON_KEY;
    this.storageKey = options.storageKey || AUTH_STORAGE_KEY;
    this.telemetryStorageKey = options.telemetryStorageKey || TELEMETRY_STORAGE_KEY;
    this.storage = options.storage || (typeof localStorage !== 'undefined' ? localStorage : new MemoryStorage());
    this.apiBaseUrl = options.apiBaseUrl ?? '';
    this.fetchImpl = options.fetchImpl || options.fetch || (typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);
    this.fetch = this.fetchImpl;
    this.authTokenKey = options.authTokenKey || AUTH_TOKEN_STORAGE_KEY;
    this.deviceLabel = options.deviceLabel || getDeviceLabel();

    this.session = null;
    this.user = null;

    this._loadSession();
  }

  _getStoredToken() {
    try {
      if (this.storage && typeof this.storage.getItem === 'function') {
        const t = this.storage.getItem(this.authTokenKey);
        if (t) return t;
      }
      if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
        return localStorage.getItem(this.authTokenKey);
      }
    } catch (_) {}
    return null;
  }

  _setStoredToken(token) {
    try {
      if (this.storage && typeof this.storage.setItem === 'function') {
        this.storage.setItem(this.authTokenKey, token);
      }
      if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
        localStorage.setItem(this.authTokenKey, token);
      }
    } catch (_) {}
  }

  _removeStoredToken() {
    try {
      if (this.storage && typeof this.storage.removeItem === 'function') {
        this.storage.removeItem(this.authTokenKey);
      }
      if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
        localStorage.removeItem(this.authTokenKey);
      }
    } catch (_) {}
  }

  _loadSession() {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const session = JSON.parse(raw);
      if (session && session.user && session.accessToken) {
        if (!session.expiresAt || session.expiresAt > Date.now()) {
          this.session = session;
          this.user = session.user;
          if (this.user.active_deck_id && !this.user.activeDeckId) {
            this.user.activeDeckId = this.user.active_deck_id;
          }
          if (this.user.activeDeckId) {
            this.user.onboarded = true;
          }
        } else {
          this.storage.removeItem(this.storageKey);
        }
      }
    } catch (_) {}
  }

  _persistSession() {
    try {
      if (this.session) {
        this.storage.setItem(this.storageKey, JSON.stringify(this.session));
      } else {
        this.storage.removeItem(this.storageKey);
      }
    } catch (_) {}
  }

  isAuthenticated() {
    return Boolean(this.session && this.user && this.session.accessToken);
  }

  getCurrentUser() {
    return this.user ? { ...this.user } : null;
  }

  hasActiveDeck() {
    return Boolean(this.user && (this.user.activeDeckId || this.user.active_deck_id));
  }

  isOnboarded() {
    return Boolean(this.user && (this.user.onboarded || this.hasActiveDeck()));
  }

  /**
   * Registers a new account with Email + Password via PostgREST Relay Proxy.
   * Eliminates direct /auth/v1/signup calls to prevent 429 rate limit errors.
   */
  async signUpWithPassword(email, password, displayName = '') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(String(email).trim())) {
      throw new Error('Invalid email format');
    }
    if (!password || String(password).length < 6) {
      throw new Error('Password must be at least 6 characters');
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanDisplayName = String(displayName || '').trim() || cleanEmail.split('@')[0];
    const deviceLabel = this.deviceLabel || getDeviceLabel();

    if (!this.fetchImpl) {
      throw new Error('Fetch API is not available.');
    }

    const res = await this.fetchImpl(`${this.apiBaseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: cleanEmail,
        password: String(password),
        displayName: cleanDisplayName,
        deviceLabel
      })
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || errJson.message || `Registration failed: ${res.status}`);
    }

    const resData = await res.json();
    const token = resData.token;
    const user = resData.user;

    const profile = {
      id: user.id,
      email: user.email,
      username: user.displayName || cleanDisplayName,
      displayName: user.displayName || cleanDisplayName,
      dob: '2000-01-01',
      elo: user.elo ?? 1200,
      activeDeckId: user.activeDeckId || null,
      onboarded: Boolean(user.activeDeckId),
      unlockedSlots: user.unlockedSlots || 2,
      ai_settings: user.ai_settings || { preferred_deck: 'STARTER_WHITE_WEENIE', difficulty: 'BALANCED' },
      decks: user.decks || {},
      createdAt: user.createdAt || new Date().toISOString(),
      updatedAt: user.updatedAt || new Date().toISOString()
    };

    const session = {
      accessToken: token,
      user: profile,
      deviceLabel,
      isDevBypass: false,
      expiresAt: Date.now() + 86400000 * TOKEN_EXPIRY_DAYS
    };

    this._setStoredToken(token);
    this.session = session;
    this.user = profile;
    this._persistSession();

    this.emit('auth_state_changed', { session, user: profile });
    this.emit('login', { session, user: profile });

    return { success: true, token, user: profile, session };
  }

  /**
   * Signs in an existing Planeswalker account with Email + Password.
   */
  async signInWithPassword(email, password) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(String(email).trim())) {
      throw new Error('Invalid email format');
    }
    if (!password) {
      throw new Error('Password is required');
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const deviceLabel = this.deviceLabel || getDeviceLabel();

    if (!this.fetchImpl) {
      throw new Error('Fetch API is not available.');
    }

    const res = await this.fetchImpl(`${this.apiBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cleanEmail, password: String(password), deviceLabel })
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || errJson.message || 'Invalid credentials');
    }

    const resData = await res.json();
    const token = resData.token;
    const user = resData.user;
    const decks = resData.decks || user.decks || {};

    const profile = {
      id: user.id,
      email: user.email,
      username: user.displayName || user.username || cleanEmail.split('@')[0],
      displayName: user.displayName || user.username || cleanEmail.split('@')[0],
      dob: '2000-01-01',
      elo: user.elo ?? 1200,
      activeDeckId: user.activeDeckId || null,
      onboarded: Boolean(user.activeDeckId),
      unlockedSlots: user.unlockedSlots || 2,
      ai_settings: user.ai_settings || { preferred_deck: 'STARTER_WHITE_WEENIE', difficulty: 'BALANCED' },
      decks,
      createdAt: user.createdAt || new Date().toISOString(),
      updatedAt: user.updatedAt || new Date().toISOString()
    };

    const session = {
      accessToken: token,
      user: profile,
      deviceLabel,
      isDevBypass: false,
      expiresAt: Date.now() + 86400000 * TOKEN_EXPIRY_DAYS
    };

    this._setStoredToken(token);
    this.session = session;
    this.user = profile;
    this._persistSession();

    this.emit('auth_state_changed', { session, user: profile });
    this.emit('login', { session, user: profile });

    return { success: true, token, user: profile, session, decks };
  }

  /**
   * Automatically restores active session from 365-day stored token.
   */
  async autoRestoreSession() {
    const token = this._getStoredToken() || this.session?.accessToken;
    if (!token) {
      this._loadSession();
      return this.user;
    }

    if (this.fetchImpl) {
      try {
        const res = await this.fetchImpl(`${this.apiBaseUrl}/api/auth/me`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (res.ok) {
          const data = await res.json();
          if (data && data.user) {
            const u = data.user;
            const profile = {
              id: u.id,
              email: u.email,
              username: u.displayName || u.username || u.email?.split('@')[0] || 'Planeswalker',
              displayName: u.displayName || u.username || u.email?.split('@')[0] || 'Planeswalker',
              dob: '2000-01-01',
              elo: u.elo ?? 1200,
              activeDeckId: u.activeDeckId || null,
              onboarded: Boolean(u.activeDeckId),
              unlockedSlots: u.unlockedSlots || 2,
              ai_settings: u.ai_settings || {},
              decks: u.decks || {},
              createdAt: u.createdAt || new Date().toISOString(),
              updatedAt: u.updatedAt || new Date().toISOString()
            };

            const session = {
              accessToken: token,
              user: profile,
              isDevBypass: false,
              expiresAt: Date.now() + 86400000 * TOKEN_EXPIRY_DAYS
            };

            this._setStoredToken(token);
            this.session = session;
            this.user = profile;
            this._persistSession();
            this.emit('auth_state_changed', { session, user: profile });
            return this.user;
          }
        } else if (res.status === 401) {
          this._removeStoredToken();
          if (this.session && this.session.accessToken === token) {
            this.session = null;
            this.user = null;
            this._persistSession();
          }
        }
      } catch (_) {}
    }

    this._loadSession();
    return this.user;
  }

  /**
   * Updates player AI settings profile ([D16]).
   * @param {Object} aiSettings
   */
  async updateAiSettings(aiSettings = {}) {
    const token = this._getStoredToken() || this.session?.accessToken;
    if (this.user) {
      this.user.ai_settings = { ...(this.user.ai_settings || {}), ...aiSettings };
      this._persistSession();
    }

    if (!token || !this.fetchImpl) return { success: true, ai_settings: this.user?.ai_settings };

    try {
      const res = await this.fetchImpl(`${this.apiBaseUrl}/api/auth/ai-settings`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ai_settings: aiSettings })
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return { success: true, ai_settings: data.ai_settings || this.user?.ai_settings };
      }
    } catch (_) {}

    return { success: true, ai_settings: this.user?.ai_settings };
  }

  /**
   * Submits a match bug report with state snapshot and recent trace events ([D39]).
   * @param {string} roomId
   * @param {string} notes
   * @param {Object} [snapshot]
   * @param {Array} [traceEvents]
   */
  async reportBug(roomId, notes = '', snapshot = null, traceEvents = []) {
    const token = this._getStoredToken() || this.session?.accessToken;
    const payload = {
      roomId: roomId || 'UNKNOWN',
      notes: String(notes || '').trim(),
      snapshot,
      traceEvents: Array.isArray(traceEvents) ? traceEvents.slice(-100) : [],
      clientInfo: {
        deviceLabel: this.deviceLabel || getDeviceLabel(),
        reportedAt: new Date().toISOString()
      }
    };

    if (!this.fetchImpl) return { success: false, error: 'Fetch unavailable' };

    try {
      const res = await this.fetchImpl(`${this.apiBaseUrl}/api/matches/report-bug`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        this.emit('bug_reported', { roomId, reportId: data.reportId });
        return { success: true, reportId: data.reportId };
      }
      return { success: false, status: res.status };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Synchronizes saved deck slots with relay server ([D15]).
   */
  async syncDecks(decks) {
    const token = this._getStoredToken() || this.session?.accessToken;
    if (!token || !this.fetchImpl) {
      if (this.user) {
        this.user.decks = decks;
        this._persistSession();
      }
      return { success: true, decks };
    }

    try {
      const res = await this.fetchImpl(`${this.apiBaseUrl}/api/auth/decks`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ decks })
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const updatedDecks = data.decks || decks;
        if (this.user) {
          this.user.decks = updatedDecks;
          this._persistSession();
        }
        return { success: true, decks: updatedDecks };
      }
    } catch (_) {}

    if (this.user) {
      this.user.decks = decks;
      this._persistSession();
    }
    return { success: true, decks };
  }

  /**
   * Fetches saved deck slots from relay server.
   */
  async fetchDecks() {
    const token = this._getStoredToken() || this.session?.accessToken;
    if (!token || !this.fetchImpl) {
      return this.user?.decks || {};
    }

    try {
      const res = await this.fetchImpl(`${this.apiBaseUrl}/api/auth/decks`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (res.ok) {
        const data = await res.json();
        const decks = data.decks || {};
        if (this.user) {
          this.user.decks = decks;
          this._persistSession();
        }
        return decks;
      }
    } catch (_) {}

    return this.user?.decks || {};
  }

  logout() {
    const token = this._getStoredToken() || this.session?.accessToken;
    if (token && this.fetchImpl) {
      try {
        this.fetchImpl(`${this.apiBaseUrl}/api/auth/logout`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        }).catch(() => {});
      } catch (_) {}
    }
    this._removeStoredToken();
    this.session = null;
    this.user = null;
    try {
      this.storage.removeItem(this.storageKey);
    } catch (_) {}
    this.emit('auth_state_changed', { session: null, user: null });
    this.emit('logout');
  }

  // Developer bypass fallback
  async instantDevLogin(email, username = '', dob = '2000-01-01') {
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!email || !emailRegex.test(String(email).trim())) {
      throw new Error('Invalid email format');
    }
    const cleanEmail = String(email).trim().toLowerCase();

    if (dob) {
      const birth = new Date(dob);
      if (!isNaN(birth.getTime())) {
        const today = new Date();
        let age = today.getFullYear() - birth.getFullYear();
        const m = today.getMonth() - birth.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
          age--;
        }
        if (age < 13) {
          throw new Error('Registration requires player to be at least 13 years of age.');
        }
      }
    }

    const userId = generateUUID();
    let existingProfile = await this._fetchProfileByEmail(cleanEmail).catch(() => null);

    const profile = existingProfile || {
      id: userId,
      email: cleanEmail,
      username: username ? String(username).trim() : cleanEmail.split('@')[0],
      dob: String(dob).trim(),
      elo: 1200,
      activeDeckId: null,
      onboarded: false,
      ai_settings: { preferred_deck: 'STARTER_WHITE_WEENIE', difficulty: 'BALANCED' },
      decks: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (existingProfile) {
      if (username) profile.username = String(username).trim();
      if (dob) profile.dob = String(dob).trim();
    }

    await this._upsertProfile(profile).catch(() => {});

    const session = {
      accessToken: `dev_bypass_${userId}_${Date.now()}`,
      user: profile,
      isDevBypass: true,
      expiresAt: Date.now() + 86400000 * TOKEN_EXPIRY_DAYS
    };
    this.session = session;
    this.user = profile;
    this._persistSession();
    this.emit('auth_state_changed', { session, user: profile });
    this.emit('login', { session, user: profile });
    return { success: true, session, user: profile };
  }

  // Legacy Supabase OTP Magic Link Fallback
  async sendMagicLink(email) {
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!email || !emailRegex.test(String(email).trim())) {
      throw new Error('Invalid email format');
    }
    const cleanEmail = String(email).trim();
    const fetchFn = this.fetchImpl || this.fetch;
    if (!fetchFn) {
      throw new Error('Fetch API is not available.');
    }

    const res = await fetchFn(`${this.supabaseUrl}/auth/v1/otp`, {
      method: 'POST',
      headers: {
        'apikey': this.supabaseAnonKey,
        'Authorization': `Bearer ${this.supabaseAnonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email: cleanEmail, create_user: true })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.msg || errData.error_description || errData.message || `Supabase OTP failed: ${res.status}`);
    }

    this.emit('otp_sent', { email: cleanEmail });
    return { success: true, message: 'OTP sent' };
  }

  async verifyOtp(email, token) {
    const cleanEmail = String(email).trim();
    const cleanToken = String(token).trim();
    const fetchFn = this.fetchImpl || this.fetch;
    if (!fetchFn) {
      throw new Error('Fetch API is not available.');
    }

    const res = await fetchFn(`${this.supabaseUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: {
        'apikey': this.supabaseAnonKey,
        'Authorization': `Bearer ${this.supabaseAnonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email: cleanEmail, token: cleanToken, type: 'magiclink' })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.msg || errData.error_description || errData.message || `OTP verification failed: ${res.status}`);
    }

    const authData = await res.json();
    const accessToken = authData.access_token || authData.token || `token_${Date.now()}`;
    const userId = authData.user?.id || generateUUID();

    let profile = await this._fetchProfileByEmail(cleanEmail, accessToken);
    if (!profile) {
      profile = {
        id: userId,
        email: cleanEmail,
        username: cleanEmail.split('@')[0],
        dob: '2000-01-01',
        elo: 1200,
        activeDeckId: null,
        onboarded: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await this._upsertProfile(profile, accessToken).catch(() => {});
    }

    const session = {
      accessToken,
      user: profile,
      isDevBypass: false,
      expiresAt: Date.now() + 86400000 * TOKEN_EXPIRY_DAYS
    };

    this.session = session;
    this.user = profile;
    this._persistSession();
    this.emit('auth_state_changed', { session, user: profile });
    this.emit('login', { session, user: profile });
    return { success: true, session, user: profile };
  }

  async _fetchProfileByEmail(email, token = null) {
    const fetchFn = this.fetchImpl || this.fetch;
    if (!fetchFn) return null;
    try {
      const res = await fetchFn(
        `${this.supabaseUrl}/rest/v1/player_profiles?email=eq.${encodeURIComponent(email)}&select=*`,
        {
          headers: {
            'apikey': this.supabaseAnonKey,
            'Authorization': `Bearer ${token || this._getStoredToken() || this.supabaseAnonKey}`
          }
        }
      );
      if (!res.ok) return null;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const row = data[0];
        return {
          id: row.id,
          email: row.email,
          username: row.username,
          dob: row.dob,
          elo: row.elo ?? 1200,
          activeDeckId: row.active_deck_id || null,
          onboarded: Boolean(row.active_deck_id),
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  async _upsertProfile(profile, token = null) {
    const fetchFn = this.fetchImpl || this.fetch;
    if (!fetchFn) return;
    try {
      await fetchFn(`${this.supabaseUrl}/rest/v1/player_profiles`, {
        method: 'POST',
        headers: {
          'apikey': this.supabaseAnonKey,
          'Authorization': `Bearer ${token || this._getStoredToken() || this.supabaseAnonKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          id: profile.id,
          email: profile.email,
          username: profile.username,
          dob: profile.dob,
          elo: profile.elo,
          active_deck_id: profile.activeDeckId || null
        })
      });
    } catch (_) {}
  }

  saveActiveDeck(deckId, deckData = null) {
    if (!this.user) throw new Error('Not authenticated');
    this.user.activeDeckId = String(deckId).trim();
    this.user.onboarded = true;
    if (deckData) this.user.activeDeckData = deckData;
    this._persistSession();
    this.emit('active_deck_saved', { deckId, deckData, user: this.user });
    return Promise.resolve(this.user);
  }

  dispatchTelemetry(eventType, cardName = null, details = {}) {
    const event = {
      id: generateUUID(),
      player_id: this.user?.id || null,
      event_type: eventType,
      card_name: cardName || null,
      details: details || {},
      created_at: new Date().toISOString()
    };
    this.emit('telemetry', event);
    this.emit('telemetry_event', event);

    const fetchFn = this.fetchImpl || this.fetch;
    if (typeof fetchFn === 'function') {
      try {
        const p = fetchFn(`${this.apiBaseUrl || this.supabaseUrl}/rest/v1/player_events`, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseAnonKey,
            'Authorization': `Bearer ${this._getStoredToken() || ''}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(event)
        });
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            this._bufferTelemetry(event);
          });
        }
      } catch (_) {
        this._bufferTelemetry(event);
      }
    } else {
      this._bufferTelemetry(event);
    }
  }

  /**
   * Appends event to offline FIFO ring buffer (INV-TELEMETRY-1).
   * @private
   */
  _bufferTelemetry(event) {
    try {
      const raw = this.storage?.getItem(this.telemetryStorageKey);
      const buf = raw ? JSON.parse(raw) : [];
      buf.push(event);
      if (buf.length > 50) {
        buf.shift();
      }
      this.storage?.setItem(this.telemetryStorageKey, JSON.stringify(buf));
    } catch (_) {}
  }

  /**
   * Retrieves array of currently buffered offline telemetry events.
   * @returns {Array<Object>}
   */
  getBufferedTelemetry() {
    try {
      const raw = this.storage?.getItem(this.telemetryStorageKey);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * Flushes offline telemetry buffer.
   * @returns {Promise<number>} Count of flushed events
   */
  async flushTelemetryBuffer() {
    let buf = [];
    try {
      const raw = this.storage?.getItem(this.telemetryStorageKey);
      if (raw) buf = JSON.parse(raw);
    } catch (_) {
      return 0;
    }

    if (!Array.isArray(buf) || buf.length === 0) return 0;
    const count = buf.length;
    const fetchFn = this.fetchImpl || this.fetch;

    if (!fetchFn) {
      throw new Error('Fetch API is not available to flush telemetry buffer.');
    }

    const res = await fetchFn(`${this.apiBaseUrl || this.supabaseUrl}/rest/v1/player_events`, {
      method: 'POST',
      headers: {
        'apikey': this.supabaseAnonKey,
        'Authorization': `Bearer ${this._getStoredToken() || ''}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(buf)
    });

    if (res && (res.ok || res.status < 400)) {
      try {
        this.storage?.removeItem(this.telemetryStorageKey);
      } catch (_) {}
      return count;
    }

    return 0;
  }
}

export default AuthManager;
