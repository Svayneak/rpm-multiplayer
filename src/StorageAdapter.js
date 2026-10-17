/**
 * StorageAdapter.js - Tiered Persistence Engine for RPM Tabletop Companion.
 * 
 * Manages bounded localStorage (10-point guideline memory with 16KB quota guard)
 * and IndexedDB (cards, custom decklists, and Top 10 public showcase).
 * Complies with Invariant INV-STORAGE-1.
 * 
 * Works isomorphically in Node.js (in-memory mock/Map fallback)
 * and Browser (window.localStorage & window.indexedDB).
 * 
 * Specification: SPEC-RPM-DECKAI-010
 * Decision: DEC-013, DEC-015
 * 
 * @module StorageAdapter
 */

/**
 * Calculates UTF-8 payload byte length for a given value or object.
 * @param {any} data
 * @returns {number}
 */
export function calculatePayloadBytes(data) {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  if (typeof Buffer !== 'undefined') {
    return Buffer.byteLength(serialized, 'utf8');
  }
  return new TextEncoder().encode(serialized).length;
}

/**
 * Enforces the 16KB quota guard on guideline payloads.
 * Throws explicit INV-STORAGE-1 Violation if byte length exceeds 16,384 bytes.
 * 
 * @param {any} guidelines
 * @param {number} [maxBytes=16384]
 * @returns {number} Byte length
 */
export function validateAndGuardGuidelineQuota(guidelines, maxBytes = 16384) {
  const byteLength = calculatePayloadBytes(guidelines);
  if (byteLength > maxBytes) {
    throw new Error(
      `INV-STORAGE-1 Violation: Guideline payload size (${byteLength} bytes) exceeds 16KB limit (${maxBytes} bytes)`
    );
  }
  return byteLength;
}

/**
 * Two-tier storage adapter providing bounded localStorage and high-capacity IndexedDB,
 * with seamless in-memory fallback for headless/SSR/Node.js testing environments.
 */
export class StorageAdapter {
  /**
   * @param {Object} [options]
   * @param {string} [options.dbName='RPM_Companion_DB']
   * @param {number} [options.dbVersion=1]
   * @param {string} [options.storagePrefix='rpm_']
   * @param {number} [options.maxGuidelinePayloadBytes=16384]
   * @param {boolean} [options.isHeadless=false]
   */
  constructor(options = {}) {
    this.dbName = options.dbName || 'RPM_Companion_DB';
    this.dbVersion = options.dbVersion || 1;
    this.storagePrefix = options.storagePrefix || 'rpm_';
    this.maxGuidelinePayloadBytes = options.maxGuidelinePayloadBytes || 16384;

    const hasWindow = typeof window !== 'undefined';
    this.isHeadless = options.isHeadless === true || !hasWindow;
    this.hasLocalStorage = hasWindow && typeof window.localStorage !== 'undefined';
    this.hasIndexedDB = hasWindow && typeof window.indexedDB !== 'undefined';

    // In-memory fallback stores
    this._memGuidelines = new Map(); // userId -> Guideline[]
    this._memDecks = new Map();      // deckId -> StoredDeck
    this._memShowcase = [];          // TopShowcaseDeck[]
    this._memCards = new Map();      // cardId -> Card

    this.db = null;
    this._initPromise = null;
  }

  /**
   * Initializes IndexedDB object stores if running in a supported browser environment.
   * @returns {Promise<boolean>}
   */
  async init() {
    if (this.isHeadless || !this.hasIndexedDB) {
      return false;
    }
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = new Promise((resolve) => {
      try {
        const req = window.indexedDB.open(this.dbName, this.dbVersion);

        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('rpm_decks_store')) {
            db.createObjectStore('rpm_decks_store', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('rpm_showcase_store')) {
            db.createObjectStore('rpm_showcase_store', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('rpm_cards_store')) {
            db.createObjectStore('rpm_cards_store', { keyPath: 'id' });
          }
        };

        req.onsuccess = (e) => {
          this.db = e.target.result;
          resolve(true);
        };

        req.onerror = () => {
          // Gracefully fallback to in-memory on IDB error
          this.db = null;
          resolve(false);
        };
      } catch (err) {
        this.db = null;
        resolve(false);
      }
    });

    return this._initPromise;
  }

  // ===========================================================================
  // Guideline Storage (Bounded localStorage, 16KB Quota Guard, INV-STORAGE-1)
  // ===========================================================================

  /**
   * Retrieves guidelines for a user from bounded storage.
   * @param {string} userId
   * @returns {Array<Object>}
   */
  getGuidelines(userId) {
    const uid = userId || 'default_user';
    const key = `${this.storagePrefix}guidelines_${uid}`;

    if (!this.isHeadless && this.hasLocalStorage) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        }
      } catch (_) {
        // Fall back to memory
      }
    }

    const mem = this._memGuidelines.get(uid);
    return mem ? JSON.parse(JSON.stringify(mem)) : [];
  }

  /**
   * Saves guidelines array for a user, enforcing the 16KB quota guard (INV-STORAGE-1).
   * Throws explicit INV-STORAGE-1 Violation if byte size exceeds 16KB without corrupting prior state.
   * 
   * @param {string} userId
   * @param {Array<Object>} guidelines
   * @returns {{ success: boolean; byteLength: number }}
   */
  saveGuidelines(userId, guidelines) {
    const uid = userId || 'default_user';
    if (!Array.isArray(guidelines)) {
      throw new TypeError('guidelines must be an array');
    }

    // Step 1: Enforce 16KB Quota Guard BEFORE writing to storage
    const byteLength = validateAndGuardGuidelineQuota(guidelines, this.maxGuidelinePayloadBytes);

    // Step 2: Persist if validation passed
    const serialized = JSON.stringify(guidelines);
    const key = `${this.storagePrefix}guidelines_${uid}`;

    if (!this.isHeadless && this.hasLocalStorage) {
      try {
        window.localStorage.setItem(key, serialized);
      } catch (err) {
        // If localStorage throws QuotaExceededError or security error, save to memory fallback
        this._memGuidelines.set(uid, JSON.parse(serialized));
        return { success: true, byteLength };
      }
    }

    // Always mirror to in-memory fallback for consistency
    this._memGuidelines.set(uid, JSON.parse(serialized));
    return { success: true, byteLength };
  }

  /**
   * Saves or updates a single guideline for a user.
   * Enforces 10-item cap (drops oldest by timestamp if limit reached) and 16KB quota guard.
   * 
   * @param {string} userId
   * @param {Object} guideline
   * @returns {{ success: boolean; guidelines: Array<Object> }}
   */
  saveGuideline(userId, guideline) {
    const uid = userId || 'default_user';
    if (!guideline || typeof guideline !== 'object') {
      throw new TypeError('guideline must be an object');
    }

    const current = this.getGuidelines(uid);
    const normTag = (guideline.targetTag || '').trim().toUpperCase();

    // Check if replacing existing guideline by ID or targetTag
    const existingIndex = current.findIndex(
      g => (guideline.id && g.id === guideline.id) ||
           (normTag && (g.targetTag || '').trim().toUpperCase() === normTag)
    );

    if (existingIndex !== -1) {
      current[existingIndex] = { ...current[existingIndex], ...guideline };
    } else {
      if (current.length >= 10) {
        // Drop oldest by timestamp
        let oldestIdx = 0;
        for (let i = 1; i < current.length; i++) {
          if ((current[i].timestamp || 0) < (current[oldestIdx].timestamp || 0)) {
            oldestIdx = i;
          }
        }
        current.splice(oldestIdx, 1);
      }
      current.push(guideline);
    }

    this.saveGuidelines(uid, current);
    return { success: true, guidelines: current };
  }

  /**
   * Deletes a specific guideline by ID for a user.
   * @param {string} userId
   * @param {string} guidelineId
   * @returns {boolean} True if found and deleted
   */
  deleteGuideline(userId, guidelineId) {
    const uid = userId || 'default_user';
    const current = this.getGuidelines(uid);
    const filtered = current.filter(g => g.id !== guidelineId);

    if (filtered.length !== current.length) {
      this.saveGuidelines(uid, filtered);
      return true;
    }
    return false;
  }

  // ===========================================================================
  // Deck Storage (IndexedDB / In-Memory Fallback)
  // ===========================================================================

  /**
   * Saves a deck entity to IndexedDB (or in-memory store).
   * Supports both saveDeck(deck) and saveDeck(userId, deck).
   * 
   * @param {string|Object} userIdOrDeck
   * @param {Object} [maybeDeck]
   * @returns {Promise<boolean>}
   */
  async saveDeck(userIdOrDeck, maybeDeck) {
    let deck;
    if (maybeDeck && typeof maybeDeck === 'object') {
      deck = { ...maybeDeck, userId: userIdOrDeck };
    } else if (userIdOrDeck && typeof userIdOrDeck === 'object') {
      deck = { ...userIdOrDeck };
    } else {
      throw new TypeError('Invalid deck argument provided to saveDeck');
    }

    if (!deck.id) {
      deck.id = `deck_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    }

    // Save to memory store
    this._memDecks.set(deck.id, JSON.parse(JSON.stringify(deck)));

    // Save to IndexedDB if available
    if (this.db) {
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction('rpm_decks_store', 'readwrite');
          const store = tx.objectStore('rpm_decks_store');
          const req = store.put(deck);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      } catch (_) {
        // Fallback remains in memory
      }
    }

    return true;
  }

  /**
   * Retrieves a deck by ID.
   * Supports both getDeck(deckId) and getDeck(userId, deckId).
   * 
   * @param {string} userIdOrDeckId
   * @param {string} [maybeDeckId]
   * @returns {Promise<Object|null>}
   */
  async getDeck(userIdOrDeckId, maybeDeckId) {
    const deckId = maybeDeckId || userIdOrDeckId;
    if (!deckId) return null;

    if (this.db) {
      try {
        const result = await new Promise((resolve) => {
          const tx = this.db.transaction('rpm_decks_store', 'readonly');
          const store = tx.objectStore('rpm_decks_store');
          const req = store.get(deckId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
        if (result) return result;
      } catch (_) {
        // Fall back to memory
      }
    }

    const mem = this._memDecks.get(deckId);
    return mem ? JSON.parse(JSON.stringify(mem)) : null;
  }

  /**
   * Retrieves all decks for a user (or all decks if userId is null/undefined).
   * @param {string} [userId]
   * @returns {Promise<Array<Object>>}
   */
  async getDecks(userId = null) {
    let decks = [];

    if (this.db) {
      try {
        decks = await new Promise((resolve) => {
          const tx = this.db.transaction('rpm_decks_store', 'readonly');
          const store = tx.objectStore('rpm_decks_store');
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });
      } catch (_) {
        decks = [];
      }
    }

    if (decks.length === 0) {
      decks = Array.from(this._memDecks.values()).map(d => JSON.parse(JSON.stringify(d)));
    }

    if (userId) {
      return decks.filter(d => d.userId === userId);
    }
    return decks;
  }

  /**
   * Alias for getDecks(userId).
   * @param {string} [userId]
   * @returns {Promise<Array<Object>>}
   */
  async listDecks(userId = null) {
    return this.getDecks(userId);
  }

  // ===========================================================================
  // Top 10 Public Showcase Storage (IndexedDB / In-Memory Fallback)
  // ===========================================================================

  /**
   * Persists the Top 10 public showcase list.
   * @param {Array<Object>} showcaseList
   * @returns {Promise<boolean>}
   */
  async saveTopShowcase(showcaseList) {
    if (!Array.isArray(showcaseList)) {
      throw new TypeError('showcaseList must be an array');
    }

    this._memShowcase = JSON.parse(JSON.stringify(showcaseList));

    if (this.db) {
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction('rpm_showcase_store', 'readwrite');
          const store = tx.objectStore('rpm_showcase_store');
          store.clear();
          for (const item of showcaseList) {
            store.put(item);
          }
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
      } catch (_) {
        // Fallback remains in memory
      }
    }

    return true;
  }

  /**
   * Alias for saveTopShowcase.
   * @param {Array<Object>} showcaseList
   * @returns {Promise<boolean>}
   */
  async saveShowcase(showcaseList) {
    return this.saveTopShowcase(showcaseList);
  }

  /**
   * Retrieves the Top 10 public showcase list.
   * @returns {Promise<Array<Object>>}
   */
  async getTopShowcase() {
    if (this.db) {
      try {
        const idbItems = await new Promise((resolve) => {
          const tx = this.db.transaction('rpm_showcase_store', 'readonly');
          const store = tx.objectStore('rpm_showcase_store');
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });
        if (idbItems && idbItems.length > 0) {
          return idbItems.sort((a, b) => (a.rank || 0) - (b.rank || 0));
        }
      } catch (_) {
        // Fall back to memory
      }
    }

    return JSON.parse(JSON.stringify(this._memShowcase)).sort((a, b) => (a.rank || 0) - (b.rank || 0));
  }

  /**
   * Alias for getTopShowcase.
   * @returns {Promise<Array<Object>>}
   */
  async getShowcase() {
    return this.getTopShowcase();
  }

  // ===========================================================================
  // Clear / Teardown
  // ===========================================================================

  /**
   * Clears all stores (localStorage entries matching prefix, IDB object stores, in-memory maps).
   * @returns {Promise<void>}
   */
  async clearAll() {
    this._memGuidelines.clear();
    this._memDecks.clear();
    this._memShowcase = [];
    this._memCards.clear();

    if (!this.isHeadless && this.hasLocalStorage) {
      try {
        const keysToRemove = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith(this.storagePrefix)) {
            keysToRemove.push(k);
          }
        }
        for (const k of keysToRemove) {
          window.localStorage.removeItem(k);
        }
      } catch (_) {}
    }

    if (this.db) {
      try {
        await new Promise((resolve) => {
          const tx = this.db.transaction(
            ['rpm_decks_store', 'rpm_showcase_store', 'rpm_cards_store'],
            'readwrite'
          );
          tx.objectStore('rpm_decks_store').clear();
          tx.objectStore('rpm_showcase_store').clear();
          tx.objectStore('rpm_cards_store').clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } catch (_) {}
    }
  }

  /**
   * Alias for clearAll.
   * @returns {Promise<void>}
   */
  async clear() {
    return this.clearAll();
  }
}

export default StorageAdapter;
