/**
 * ScryfallService.js - High performance batch fetcher and cache layer for Scryfall.
 * 
 * Implements Section 3 of SPEC-RPM-INGEST-001:
 * - Scryfall /cards/collection batch API integration with max 75 cards per batch.
 * - Pluggable CacheStorageAdapter (LocalStorageCacheAdapter and MemoryCacheAdapter).
 * - Polite rate limiting (100ms throttle between outbound network calls).
 * - User-Agent: RPM-Multiplayer/1.0 compliance.
 * - HTTP 429 exponential backoff and HTTP 5xx linear retry logic.
 * - Multi-faced, MDFC, and split card normalization.
 * - Modern legality flag extraction.
 * 
 * @module ScryfallService
 */

/**
 * In-memory cache storage adapter for Node.js, headless test, or SSR environments.
 */
export class MemoryCacheAdapter {
  constructor() {
    /** @type {Map<string, string>} */
    this.storage = new Map();
  }

  /**
   * Retrieves a cached value by key.
   * @param {string} key
   * @returns {string | null}
   */
  getItem(key) {
    return this.storage.has(key) ? this.storage.get(key) : null;
  }

  /**
   * Stores a key-value pair in memory.
   * @param {string} key
   * @param {string} value
   */
  setItem(key, value) {
    this.storage.set(key, String(value));
  }

  /**
   * Checks if key exists in cache.
   * @param {string} key
   * @returns {boolean}
   */
  hasItem(key) {
    return this.storage.has(key);
  }

  /**
   * Clears all cached items.
   */
  clear() {
    this.storage.clear();
  }
}

/**
 * Persistent localStorage cache adapter for browser environments.
 */
export class LocalStorageCacheAdapter {
  /**
   * @param {string} [prefix='rpm_scryfall_v1_']
   */
  constructor(prefix = 'rpm_scryfall_v1_') {
    this.prefix = prefix;
  }

  /**
   * Retrieves an item from localStorage.
   * @param {string} key
   * @returns {string | null}
   */
  getItem(key) {
    if (typeof localStorage === 'undefined') return null;
    try {
      return localStorage.getItem(this.prefix + key);
    } catch {
      return null;
    }
  }

  /**
   * Saves an item to localStorage.
   * @param {string} key
   * @param {string} value
   */
  setItem(key, value) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.prefix + key, String(value));
    } catch (e) {
      // Gracefully handle quota exceeded or private browsing restrictions
      console.warn('LocalStorage quota exceeded or unavailable', e);
    }
  }

  /**
   * Checks if an item exists in localStorage.
   * @param {string} key
   * @returns {boolean}
   */
  hasItem(key) {
    if (typeof localStorage === 'undefined') return false;
    try {
      return localStorage.getItem(this.prefix + key) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Clears all items belonging to this adapter prefix.
   */
  clear() {
    if (typeof localStorage === 'undefined') return;
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(this.prefix)) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch (e) {
      console.warn('Failed to clear LocalStorage items', e);
    }
  }
}

/**
 * Service for batch hydration of MTG deck cards via Scryfall API.
 */
export class ScryfallService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.cacheAdapter] - Custom cache storage adapter.
   * @param {string} [options.apiUrl='https://api.scryfall.com/cards/collection'] - Endpoint URL.
   * @param {number} [options.rateLimitMs=100] - Inter-batch delay in milliseconds.
   * @param {number} [options.timeoutMs=8000] - Network request timeout in milliseconds.
   * @param {Function} [options.fetch] - Custom fetch implementation (useful for tests).
   */
  constructor(options = {}) {
    this.apiUrl = options.apiUrl || 'https://api.scryfall.com/cards/collection';
    this.rateLimitMs = options.rateLimitMs ?? 100;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetchFn = options.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);

    if (options.cacheAdapter) {
      this.cache = options.cacheAdapter;
    } else if (typeof localStorage !== 'undefined') {
      this.cache = new LocalStorageCacheAdapter();
    } else {
      this.cache = new MemoryCacheAdapter();
    }
  }

  /**
   * Generates a normalized cache key for a parsed card token.
   * @param {import('./DeckParser').ParsedDeckCard} card
   * @returns {string}
   */
  _generateCacheKey(card) {
    if (card.set && card.collectorNumber) {
      return `print:${card.set.toLowerCase()}:${String(card.collectorNumber).toLowerCase()}`;
    }
    return `name:${card.name.trim().toLowerCase()}`;
  }

  /**
   * Transforms raw Scryfall API card object into canonical ScryfallCardEntity.
   * Properly normalizes single-faced cards, double-faced cards (DFCs), MDFCs, and split cards.
   * 
   * @param {Record<string, any>} card - Raw Scryfall card JSON payload.
   * @returns {Object} Normalized ScryfallCardEntity.
   */
  _transformScryfallCard(card) {
    // 1. Resolve image URI with fallback cascade
    const imageUri = card.image_uris?.normal ||
                     card.image_uris?.small ||
                     card.card_faces?.[0]?.image_uris?.normal ||
                     card.card_faces?.[0]?.image_uris?.small ||
                     '';

    // 2. Resolve mana cost across single-face or multi-faced card structures
    let manaCost = '';
    if (card.mana_cost !== undefined) {
      manaCost = card.mana_cost;
    } else if (card.card_faces && Array.isArray(card.card_faces)) {
      manaCost = card.card_faces
        .map(face => face.mana_cost)
        .filter(Boolean)
        .join(' // ');
    }

    // 3. Resolve oracle rules text
    let oracleText = '';
    if (card.oracle_text !== undefined) {
      oracleText = card.oracle_text;
    } else if (card.card_faces && Array.isArray(card.card_faces)) {
      oracleText = card.card_faces
        .map(face => face.name ? `${face.name}: ${face.oracle_text || ''}` : (face.oracle_text || ''))
        .join('\n\n');
    }

    // 4. Resolve colors
    const colors = card.colors || card.card_faces?.[0]?.colors || [];

    // 5. Resolve type line
    const typeLine = card.type_line ||
                     card.card_faces?.map(f => f.type_line).filter(Boolean).join(' // ') ||
                     '';

    // 6. Modern format legality
    const modernLegal = Boolean(card.legalities && card.legalities.modern === 'legal');

    return {
      id: card.id,
      name: card.name,
      manaCost,
      typeLine,
      oracleText,
      imageUri,
      colors,
      modernLegal,
      raw: card
    };
  }

  /**
   * Resolves an array of ParsedDeckCard items against Cache and Scryfall Batch API.
   * 
   * @param {Array<import('./DeckParser').ParsedDeckCard>} parsedCards
   * @returns {Promise<Object>} Hydrated cards, notFound registry, and ingestion statistics.
   */
  async fetchDeckCards(parsedCards) {
    if (!Array.isArray(parsedCards) || parsedCards.length === 0) {
      return {
        cards: [],
        notFound: [],
        stats: {
          totalRequested: 0,
          totalResolved: 0,
          cacheHits: 0,
          networkFetches: 0,
          chunksDispatched: 0
        }
      };
    }

    /** @type {Map<number, Object>} index in parsedCards -> HydratedDeckCard */
    const resolvedByIndex = new Map();
    /** @type {Map<string, Array<{ card: import('./DeckParser').ParsedDeckCard, index: number }>>} */
    const identifierMap = new Map();
    const missingIdentifiers = [];
    let cacheHits = 0;

    // Step 1: Check cache for each card token
    for (let i = 0; i < parsedCards.length; i++) {
      const card = parsedCards[i];
      const cacheKey = this._generateCacheKey(card);
      let cached = null;

      try {
        cached = await this.cache.getItem(cacheKey);
      } catch (err) {
        cached = null;
      }

      if (cached) {
        try {
          const entity = JSON.parse(cached);
          resolvedByIndex.set(i, {
            ...entity,
            count: card.count,
            section: card.section
          });
          cacheHits++;
          continue;
        } catch {
          // Corrupted cache entry; fall through to network fetch
        }
      }

      // Construct Scryfall identifier object adhering to Section 3.2 of the spec
      // Note: Scryfall's collection API requires front-face name for split/DFC cards when querying by name
      const queryName = card.name && card.name.includes(' // ')
        ? card.name.split(' // ')[0].trim()
        : card.name;

      const idObj = {};
      if (card.set && card.collectorNumber) {
        idObj.set = card.set.toLowerCase();
        idObj.collector_number = String(card.collectorNumber).toLowerCase();
      } else if (card.set) {
        idObj.name = queryName;
        idObj.set = card.set.toLowerCase();
      } else {
        idObj.name = queryName;
      }

      const idKey = JSON.stringify(idObj);
      if (!identifierMap.has(idKey)) {
        identifierMap.set(idKey, []);
        missingIdentifiers.push(idObj);
      }
      identifierMap.get(idKey).push({ card, index: i });
    }

    // Step 2: If all cards resolved from cache, return immediately
    if (missingIdentifiers.length === 0) {
      const cards = Array.from(resolvedByIndex.entries())
        .sort((a, b) => a[0] - b[0])
        .map(entry => entry[1]);

      return {
        cards,
        notFound: [],
        stats: {
          totalRequested: parsedCards.length,
          totalResolved: cards.length,
          cacheHits,
          networkFetches: 0,
          chunksDispatched: 0
        }
      };
    }

    // Step 3: Partition uncached identifiers into chunks of max 75
    const CHUNK_SIZE = 75;
    const chunks = [];
    for (let i = 0; i < missingIdentifiers.length; i += CHUNK_SIZE) {
      chunks.push(missingIdentifiers.slice(i, i + CHUNK_SIZE));
    }

    const notFoundRegistry = [];
    let networkFetches = 0;

    // Step 4: Dispatch sequential chunk requests with polite throttling
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = await this._postBatchWithRetry(chunk);
      networkFetches += chunk.length;

      // 4a. Process matched cards
      const returnedData = (result && Array.isArray(result.data)) ? result.data : [];
      for (const cardData of returnedData) {
        const entity = this._transformScryfallCard(cardData);

        // Persist to cache under canonical name and specific print
        try {
          await this.cache.setItem(`name:${entity.name.toLowerCase()}`, JSON.stringify(entity));
          // If DFC, also cache under front face name for fast lookup
          if (cardData.card_faces && cardData.card_faces[0]?.name) {
            await this.cache.setItem(`name:${cardData.card_faces[0].name.toLowerCase()}`, JSON.stringify(entity));
          }
          if (cardData.set && cardData.collector_number) {
            const printKey = `print:${cardData.set.toLowerCase()}:${String(cardData.collector_number).toLowerCase()}`;
            await this.cache.setItem(printKey, JSON.stringify(entity));
          }
        } catch (e) {
          console.warn('Failed to cache card entity', e);
        }

        // Match back to original requested cards
        for (const [idKey, cardList] of identifierMap.entries()) {
          const idObj = JSON.parse(idKey);

          // Name matching (canonical name or front face name)
          const nameMatches = Boolean(
            idObj.name && (
              idObj.name.toLowerCase() === entity.name.toLowerCase() ||
              entity.name.toLowerCase().startsWith(idObj.name.toLowerCase() + ' //') ||
              (cardData.card_faces && cardData.card_faces[0]?.name?.toLowerCase() === idObj.name.toLowerCase())
            )
          );

          // Set & Print matching
          const printMatches = Boolean(
            idObj.set && idObj.collector_number &&
            idObj.set.toLowerCase() === cardData.set?.toLowerCase() &&
            idObj.collector_number.toLowerCase() === String(cardData.collector_number || '').toLowerCase()
          );

          // Set + Name matching
          const setNameMatches = Boolean(
            idObj.set && idObj.name &&
            idObj.set.toLowerCase() === cardData.set?.toLowerCase() &&
            nameMatches
          );

          if (printMatches || setNameMatches || (nameMatches && !idObj.set)) {
            for (const { card, index } of cardList) {
              resolvedByIndex.set(index, {
                ...entity,
                count: card.count,
                section: card.section
              });
            }
          }
        }
      }

      // 4b. Process not_found items
      const returnedNotFound = (result && Array.isArray(result.not_found)) ? result.not_found : [];
      for (const missing of returnedNotFound) {
        let requestedName = missing.name || '';
        if (!requestedName && missing.set && missing.collector_number) {
          requestedName = `${missing.set}:${missing.collector_number}`;
        }

        const idKey = JSON.stringify(missing);
        const mappedEntries = identifierMap.get(idKey);
        if (mappedEntries && mappedEntries.length > 0 && mappedEntries[0].card.name) {
          requestedName = mappedEntries[0].card.name;
        }

        notFoundRegistry.push({
          identifier: missing,
          requestedName: requestedName || 'Unknown Card',
          reason: 'Card not found in Scryfall database'
        });
      }

      // 4c. Polite delay between consecutive chunk requests
      if (i < chunks.length - 1 && this.rateLimitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.rateLimitMs));
      }
    }

    // Assemble resolved cards preserving original input order
    const cards = Array.from(resolvedByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(entry => entry[1]);

    return {
      cards,
      notFound: notFoundRegistry,
      stats: {
        totalRequested: parsedCards.length,
        totalResolved: cards.length,
        cacheHits,
        networkFetches,
        chunksDispatched: chunks.length
      }
    };
  }

  /**
   * Dispatches a batch POST request to Scryfall with exponential backoff on 429
   * and linear backoff on 5xx server errors.
   * 
   * @param {Array<Object>} identifiers - Array of <= 75 Scryfall identifier objects.
   * @param {number} [maxRetries=3]
   * @returns {Promise<{ data: Array<Object>, not_found?: Array<Object> }>}
   * @private
   */
  async _postBatchWithRetry(identifiers, maxRetries = 3) {
    let attempt = 0;
    const fetchFunc = this.fetchFn || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!fetchFunc) {
      throw new Error('No fetch implementation available in current environment');
    }

    while (attempt <= maxRetries) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;

      try {
        const response = await fetchFunc(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'RPM-Multiplayer/1.0',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ identifiers }),
          signal: controller ? controller.signal : undefined
        });

        // Handle 429 Rate Limiting
        if (response.status === 429) {
          if (attempt >= maxRetries) {
            throw new Error('Scryfall API error: 429 Too Many Requests (max retries exceeded)');
          }
          attempt++;
          const retryAfterHeader = response.headers && typeof response.headers.get === 'function'
            ? response.headers.get('Retry-After')
            : null;
          const retryAfterSec = retryAfterHeader ? parseFloat(retryAfterHeader) : null;
          const delay = (retryAfterSec && !isNaN(retryAfterSec))
            ? retryAfterSec * 1000
            : 1000 * Math.pow(2, attempt - 1);

          await new Promise(res => setTimeout(res, delay));
          continue;
        }

        // Handle 5xx Server Errors
        if (response.status >= 500 && response.status <= 599) {
          if (attempt >= maxRetries) {
            throw new Error(`Scryfall API server error: ${response.status} ${response.statusText}`);
          }
          attempt++;
          await new Promise(res => setTimeout(res, 500 * attempt));
          continue;
        }

        if (!response.ok) {
          throw new Error(`Scryfall API error: ${response.status} ${response.statusText}`);
        }

        return await response.json();
      } catch (err) {
        if (attempt >= maxRetries) {
          throw err;
        }
        attempt++;
        await new Promise(res => setTimeout(res, 500 * attempt));
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }

    throw new Error('Scryfall request failed after maximum retries');
  }
}

export default {
  ScryfallService,
  MemoryCacheAdapter,
  LocalStorageCacheAdapter
};
