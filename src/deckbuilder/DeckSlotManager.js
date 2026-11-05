/**
 * src/deckbuilder/DeckSlotManager.js
 * Manages 6 unlockable deck slots and compatibility review requests (INV-ARCH-HEADLESS compliant).
 */

import { groundDeckForEngine, normalizeCardName } from '../OracleEffectCompiler.js';

const STORAGE_KEY_SLOTS = 'rpm_unlocked_deck_slots';
const STORAGE_KEY_DECKS = 'rpm_deck_slots_data';
const STORAGE_KEY_REVIEW = 'rpm_compatibility_review_queue';

const memoryStore = new Map();

function safeGetStorageItem(key) {
  if (typeof localStorage !== 'undefined') {
    try {
      return localStorage.getItem(key);
    } catch (_) {}
  }
  return memoryStore.get(key) || null;
}

function safeSetStorageItem(key, val) {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(key, val);
    } catch (_) {}
  }
  memoryStore.set(key, val);
}

export class DeckSlotManager {
  constructor(options = {}) {
    this.totalSlots = options.totalSlots || 6;
    this._unlockedSlots = new Set(['slot_1', 'slot_2']);
    this._deckData = {};
    this._load();
  }

  _load() {
    const rawUnlocked = safeGetStorageItem(STORAGE_KEY_SLOTS);
    if (rawUnlocked) {
      try {
        const arr = JSON.parse(rawUnlocked);
        if (Array.isArray(arr)) {
          arr.forEach(s => this._unlockedSlots.add(s));
        }
      } catch (_) {}
    }

    const rawDecks = safeGetStorageItem(STORAGE_KEY_DECKS);
    if (rawDecks) {
      try {
        this._deckData = JSON.parse(rawDecks) || {};
      } catch (_) {}
    }
  }

  _save() {
    safeSetStorageItem(STORAGE_KEY_SLOTS, JSON.stringify(Array.from(this._unlockedSlots)));
    safeSetStorageItem(STORAGE_KEY_DECKS, JSON.stringify(this._deckData));
  }

  getSlots() {
    const slots = [];
    for (let i = 1; i <= this.totalSlots; i++) {
      const slotId = `slot_${i}`;
      const isUnlocked = this.isSlotUnlocked(slotId);
      slots.push({
        id: slotId,
        slotId,
        label: `Slot ${i}`,
        unlocked: isUnlocked,
        isUnlocked,
        deck: this._deckData[slotId] || null
      });
    }
    return slots;
  }

  getAllSlots() {
    return this.getSlots();
  }

  getSlot(slotId) {
    if (!slotId) return null;
    return this.getSlots().find(s => s.id === slotId) || null;
  }

  getSlotDeck(slotId) {
    return this.getSlot(slotId)?.deck || null;
  }

  isSlotUnlocked(slotId) {
    return this._unlockedSlots.has(slotId);
  }

  unlockSlot(slotId) {
    if (!slotId) return false;
    this._unlockedSlots.add(slotId);
    this._save();
    return true;
  }

  saveDeckToSlot(slotId, deckPayload = {}) {
    if (!this.isSlotUnlocked(slotId)) {
      throw new Error(`Cannot save to locked slot: ${slotId}`);
    }
    const parsed = (!deckPayload.cards && !deckPayload.mainboard && deckPayload.decklistText)
      ? this.importDeckText(deckPayload.decklistText, { name: deckPayload.name })
      : null;
    const deckRecord = {
      ...deckPayload,
      name: deckPayload.name || parsed?.name || `Deck (${slotId})`,
      cards: deckPayload.cards || deckPayload.mainboard || parsed?.cards || [],
      mainboard: deckPayload.mainboard || deckPayload.cards || parsed?.mainboard || [],
      decklistText: deckPayload.decklistText || deckPayload.rawText || parsed?.decklistText || '',
      slotId,
      savedAt: Date.now()
    };
    try {
      if (deckRecord.cards && deckRecord.cards.length > 0) {
        groundDeckForEngine(deckRecord.cards);
      }
    } catch (_) {}
    this._deckData[slotId] = deckRecord;
    this._save();
    return deckRecord;
  }

  exportDeckText(slotId) {
    const slot = this.getSlot(slotId);
    if (!slot || !slot.deck) return '';
    if (slot.deck.decklistText) return slot.deck.decklistText;
    if (slot.deck.rawText) return slot.deck.rawText;
    const cards = slot.deck.cards || slot.deck.mainboard || [];
    return cards.map(c => `${c.count || 1} ${c.name}`).join('\n');
  }

  static importDeckText(rawText, options = {}) {
    return new DeckSlotManager().importDeckText(rawText, options);
  }

  importDeckText(rawText, options = {}) {
    const lines = (rawText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const cards = [];
    let isSideboard = false;
    const sideboard = [];

    for (const line of lines) {
      if (line.toLowerCase().startsWith('sideboard')) {
        isSideboard = true;
        continue;
      }
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (match) {
        const normalizedName = normalizeCardName(match[2].trim());
        const item = { count: parseInt(match[1], 10) || 1, name: normalizedName };
        if (isSideboard) sideboard.push(item);
        else cards.push(item);
      }
    }

    const totalCount = cards.reduce((sum, c) => sum + c.count, 0);
    try {
      if (cards && cards.length > 0) {
        groundDeckForEngine(cards);
      }
    } catch (_) {}
    return {
      name: options.name || 'Imported Deck',
      cards,
      mainboard: cards,
      sideboard,
      decklistText: rawText,
      totalCount
    };
  }
}

export class CompatibilityReviewQueue {
  constructor() {
    this._queue = [];
    this._load();
  }

  _load() {
    const raw = safeGetStorageItem(STORAGE_KEY_REVIEW);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this._queue = parsed;
      } catch (_) {}
    }
  }

  _save() {
    safeSetStorageItem(STORAGE_KEY_REVIEW, JSON.stringify(this._queue));
  }

  enqueueReviewRequest({ deckName, format, badge, compatibilityBadge, unsupportedCards, unverifiedCards, rawDecklist } = {}) {
    const resolvedBadge = compatibilityBadge || badge || '🟡 Assisted Play';
    const resolvedUnsupported = Array.isArray(unsupportedCards)
      ? unsupportedCards
      : (Array.isArray(unverifiedCards) ? unverifiedCards : []);
    const requestObj = {
      id: 'rev_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
      timestamp: Date.now(),
      deckName: deckName || 'Custom Deck',
      format: format || 'modern',
      badge: resolvedBadge,
      compatibilityBadge: resolvedBadge,
      unsupportedCards: resolvedUnsupported,
      unverifiedCards: resolvedUnsupported,
      rawDecklist: rawDecklist || ''
    };
    this._queue.push(requestObj);
    this._save();
    return requestObj;
  }

  getReviewQueue() {
    return [...this._queue];
  }

  exportReviewRequestJson(requestObj) {
    return JSON.stringify(requestObj || {}, null, 2);
  }
}
