/**
 * src/AuthManager.js
 * Supabase Magic Link OTP, Instant Dev Bypass, Profile Hydration & Telemetry Buffer
 * 
 * Part of RPM Multiplayer - Feature 15
 * Document ID: SPEC-RPM-ONBOARD-015
 * Enforces Architectural Invariants:
 * - INV-AUTH-1: Authentication Gate & Session Persistence
 * - INV-ONBOARD-1: Mandatory Deck Creator Gate
 * - INV-TELEMETRY-1: Event Logging & Non-Blocking Audit Trail
 * 
 * @module AuthManager
 */

import { EventEmitter } from './EventEmitter.js';

export const SUPABASE_URL = 'https://naacgdwtglvcumaccime.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5hYWNnZHd0Z2x2Y3VtYWNjaW1lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5Nzc2NDUsImV4cCI6MjEwMzU1MzY0NX0.QzVkPr7-aKYLTxVc6RzB_maVBykHBUvtvIIZm-522JE';

export const AUTH_STORAGE_KEY = 'rpm_auth_session';
export const TELEMETRY_STORAGE_KEY = 'rpm_telemetry_buffer';
export const MAX_TELEMETRY_BUFFER_SIZE = 100;

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

// Alias mapping for flexible starter archetype lookups
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

/**
 * Resolves starter archetype by code or key.
 * @param {string} codeOrKey 
 * @returns {Object|null}
 */
export function getStarterDeck(codeOrKey) {
  if (!codeOrKey) return null;
  const key = String(codeOrKey).trim();
  if (STARTER_ARCHETYPES[key]) return STARTER_ARCHETYPES[key];
  if (STARTER_ALIASES[key]) return STARTER_ALIASES[key];
  return null;
}

/**
 * Calculates player age based on YYYY-MM-DD Date of Birth.
 * @param {string} dobString 
 * @returns {number}
 */
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

/**
 * Cryptographic UUID v4 Generator.
 * @returns {string}
 */
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

/**
 * Headless In-Memory LocalStorage Mock.
 */
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
 * Orchestrates Supabase Magic Link OTP, instant developer bypass,
 * profile hydration, and non-blocking telemetry event auditing.
 */
export class AuthManager extends EventEmitter {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.supabaseUrl]
   * @param {string} [options.supabaseAnonKey]
   * @param {string} [options.storageKey]
   * @param {string} [options.telemetryStorageKey]
   * @param {Object} [options.storage]
   * @param {Function} [options.fetch]
   */
  constructor(options = {}) {
    super();
    this.supabaseUrl = options.supabaseUrl || SUPABASE_URL;
    this.supabaseAnonKey = options.supabaseAnonKey || SUPABASE_ANON_KEY;
    this.storageKey = options.storageKey || AUTH_STORAGE_KEY;
    this.telemetryStorageKey = options.telemetryStorageKey || TELEMETRY_STORAGE_KEY;
    this.storage = options.storage || (typeof localStorage !== 'undefined' ? localStorage : new MemoryStorage());
    this.fetch = options.fetch || (typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);

    this.session = null;
    this.user = null;

    this._loadSession();
  }

  /**
   * Internal session loader from persistent storage.
   * @private
   */
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

  /**
   * Internal session persister to storage.
   * @private
   */
  _persistSession() {
    try {
      if (this.session) {
        this.storage.setItem(this.storageKey, JSON.stringify(this.session));
      } else {
        this.storage.removeItem(this.storageKey);
      }
    } catch (_) {}
  }

  /**
   * Checks if user currently has an authenticated session.
   * @returns {boolean}
   */
  isAuthenticated() {
    return Boolean(this.session && this.user && this.session.accessToken);
  }

  /**
   * Returns current hydrated user profile, or null.
   * @returns {Object|null}
   */
  getCurrentUser() {
    return this.user ? { ...this.user } : null;
  }

  /**
   * Checks if current user has an active deck configured.
   * @returns {boolean}
   */
  hasActiveDeck() {
    return Boolean(this.user && (this.user.activeDeckId || this.user.active_deck_id));
  }

  /**
   * Checks if current user has completed mandatory onboarding (INV-ONBOARD-1).
   * @returns {boolean}
   */
  isOnboarded() {
    return Boolean(this.user && (this.user.onboarded || this.hasActiveDeck()));
  }

  /**
   * Initiates Supabase Magic Link OTP email flow (INV-AUTH-1).
   * 
   * @param {string} email 
   * @returns {Promise<{ success: boolean, message?: string }>}
   */
  async sendMagicLink(email) {
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!email || !emailRegex.test(String(email).trim())) {
      throw new Error('Invalid email format');
    }
    const cleanEmail = String(email).trim();

    if (!this.fetch) {
      throw new Error('Fetch API is not available.');
    }

    const res = await this.fetch(`${this.supabaseUrl}/auth/v1/otp`, {
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

  /**
   * Verifies 6-digit OTP code against Supabase Auth API (INV-AUTH-1).
   * 
   * @param {string} email 
   * @param {string} token 
   * @returns {Promise<{ success: boolean, session: Object, user: Object }>}
   */
  async verifyOtp(email, token) {
    const cleanEmail = String(email).trim();
    const cleanToken = String(token).trim();

    if (!this.fetch) {
      throw new Error('Fetch API is not available.');
    }

    const res = await this.fetch(`${this.supabaseUrl}/auth/v1/verify`, {
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
      expiresAt: Date.now() + 86400000 * 7
    };

    this.session = session;
    this.user = profile;
    this._persistSession();
    this.emit('auth_state_changed', { session, user: profile });
    this.emit('login', { session, user: profile });
    return { success: true, session, user: profile };
  }

  /**
   * Instant dev bypass login for rapid testing and headless mock workflows (INV-AUTH-1).
   * Validates age >= 13 years and email format.
   * 
   * @param {string} email 
   * @param {string} [username] 
   * @param {string} [dob] 
   * @returns {Promise<{ success: boolean, session: Object, user: Object }>}
   */
  async instantDevLogin(email, username = '', dob = '2000-01-01') {
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!email || !emailRegex.test(String(email).trim())) {
      throw new Error('Invalid email format');
    }
    const cleanEmail = String(email).trim();

    const age = calculateAge(dob);
    if (age < 13) {
      throw new Error('Registration requires player to be at least 13 years of age.');
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
      expiresAt: Date.now() + 86400000 * 30
    };

    this.session = session;
    this.user = profile;
    this._persistSession();
    this.emit('auth_state_changed', { session, user: profile });
    this.emit('login', { session, user: profile });
    return { success: true, session, user: profile };
  }

  /**
   * Updates user profile attributes in Supabase and local storage.
   * 
   * @param {Object} updates 
   * @returns {Promise<Object>} Updated profile
   */
  async updateProfile(updates = {}) {
    if (!this.user) {
      throw new Error('Cannot update profile: User is not authenticated.');
    }

    Object.assign(this.user, updates);
    if (updates.active_deck_id && !this.user.activeDeckId) {
      this.user.activeDeckId = updates.active_deck_id;
    }
    if (this.user.activeDeckId) {
      this.user.onboarded = true;
    }
    this.user.updatedAt = new Date().toISOString();

    if (this.session) {
      this.session.user = this.user;
    }
    this._persistSession();

    await this._updateProfileOnServer(updates).catch(() => {});

    this.emit('profile_updated', { user: this.user });
    return { ...this.user };
  }

  /**
   * Saves an active deck and sets onboarded = true (INV-ONBOARD-1).
   * 
   * @param {string} deckId 
   * @param {Object} [deckData] 
   * @returns {Promise<Object>} Updated profile
   */
  async saveActiveDeck(deckId, deckData = null) {
    if (!this.user) {
      throw new Error('Cannot save active deck: User is not authenticated.');
    }

    const cleanDeckId = String(deckId).trim();
    this.user.activeDeckId = cleanDeckId;
    this.user.active_deck_id = cleanDeckId;
    this.user.onboarded = true;
    if (deckData) {
      this.user.activeDeckData = deckData;
    }
    this.user.updatedAt = new Date().toISOString();

    if (this.session) {
      this.session.user = this.user;
    }
    this._persistSession();

    await this._updateProfileOnServer({ active_deck_id: cleanDeckId }).catch(() => {});

    this.emit('active_deck_saved', { deckId: cleanDeckId, deckData, user: this.user });
    this.emit('onboarding_completed', { user: this.user });
    this.emit('profile_updated', { user: this.user });
    return { ...this.user };
  }

  /**
   * Clears session and local credentials.
   */
  logout() {
    this.session = null;
    this.user = null;
    try {
      this.storage.removeItem(this.storageKey);
    } catch (_) {}
    this.emit('auth_state_changed', { session: null, user: null });
    this.emit('logout');
  }

  /**
   * Non-blocking telemetry dispatcher (INV-TELEMETRY-1).
   * Dispatches event to Supabase public.player_events.
   * On failure or offline, appends to localStorage FIFO buffer (max 100).
   * 
   * @param {string} eventType 
   * @param {string|null} [cardName=null] 
   * @param {Object} [details={}] 
   */
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

    if (typeof this.fetch === 'function') {
      try {
        const p = this.fetch(`${this.supabaseUrl}/rest/v1/player_events`, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseAnonKey,
            'Authorization': `Bearer ${this._getAuthBearerToken()}`,
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
      const raw = this.storage.getItem(this.telemetryStorageKey);
      const buf = raw ? JSON.parse(raw) : [];
      buf.push(event);
      if (buf.length > MAX_TELEMETRY_BUFFER_SIZE) {
        buf.shift();
      }
      this.storage.setItem(this.telemetryStorageKey, JSON.stringify(buf));
    } catch (_) {}
  }

  /**
   * Retrieves array of currently buffered offline telemetry events.
   * @returns {Array<Object>}
   */
  getBufferedTelemetry() {
    try {
      const raw = this.storage.getItem(this.telemetryStorageKey);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * Flushes offline telemetry buffer to Supabase.
   * @returns {Promise<number>} Count of flushed events
   */
  async flushTelemetryBuffer() {
    let buf = [];
    try {
      const raw = this.storage.getItem(this.telemetryStorageKey);
      if (raw) buf = JSON.parse(raw);
    } catch (_) {
      return 0;
    }

    if (!Array.isArray(buf) || buf.length === 0) return 0;
    const count = buf.length;

    if (!this.fetch) {
      throw new Error('Fetch API is not available to flush telemetry buffer.');
    }

    const res = await this.fetch(`${this.supabaseUrl}/rest/v1/player_events`, {
      method: 'POST',
      headers: {
        'apikey': this.supabaseAnonKey,
        'Authorization': `Bearer ${this._getAuthBearerToken()}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(buf)
    });

    if (!res.ok) {
      throw new Error(`Failed to flush telemetry: ${res.status}`);
    }

    this.storage.removeItem(this.telemetryStorageKey);
    return count;
  }

  /**
   * Resolves valid bearer authorization token for Supabase PostgREST endpoints.
   * If session is a dev bypass or token is not a valid Supabase JWT, defaults to supabaseAnonKey.
   * @param {string|null} [token=null]
   * @returns {string}
   * @private
   */
  _getAuthBearerToken(token = null) {
    if (token && typeof token === 'string' && !token.startsWith('dev_bypass_')) {
      return token;
    }
    if (this.session?.accessToken && !this.session.isDevBypass && typeof this.session.accessToken === 'string' && !this.session.accessToken.startsWith('dev_bypass_')) {
      return this.session.accessToken;
    }
    return this.supabaseAnonKey;
  }

  /**
   * Internal helper to fetch player profile by email.
   * @private
   */
  async _fetchProfileByEmail(email, token = null) {
    if (!this.fetch) return null;
    try {
      const res = await this.fetch(
        `${this.supabaseUrl}/rest/v1/player_profiles?email=eq.${encodeURIComponent(email)}&select=*`,
        {
          headers: {
            'apikey': this.supabaseAnonKey,
            'Authorization': `Bearer ${this._getAuthBearerToken(token)}`
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

  /**
   * Internal helper to upsert player profile.
   * @private
   */
  async _upsertProfile(profile, token = null) {
    if (!this.fetch) return;
    try {
      const payload = {
        id: profile.id,
        email: profile.email,
        username: profile.username,
        dob: profile.dob,
        elo: profile.elo ?? 1200,
        active_deck_id: profile.activeDeckId || profile.active_deck_id || null
      };
      await this.fetch(`${this.supabaseUrl}/rest/v1/player_profiles`, {
        method: 'POST',
        headers: {
          'apikey': this.supabaseAnonKey,
          'Authorization': `Bearer ${this._getAuthBearerToken(token)}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(payload)
      });
    } catch (_) {}
  }

  /**
   * Internal helper to patch player profile on server.
   * @private
   */
  async _updateProfileOnServer(updates, token = null) {
    if (!this.fetch || !this.user?.id) return;
    try {
      await this.fetch(`${this.supabaseUrl}/rest/v1/player_profiles?id=eq.${this.user.id}`, {
        method: 'PATCH',
        headers: {
          'apikey': this.supabaseAnonKey,
          'Authorization': `Bearer ${this._getAuthBearerToken(token)}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updates)
      });
    } catch (_) {}
  }
}

export default AuthManager;
