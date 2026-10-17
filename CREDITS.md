# 📜 Open-Source Credits, Attributions & License Compliance

**Project:** RPM Multiplayer (RPM Revival Tabletop Arena)  
**Date:** October 17, 2026  
**License Compliance Status:** ✅ **100% Permissive Open-Source Compatible**

---

## 1. License Verification & Reusability Statement

> **Yes, all investigated and adapted repositories use highly permissive open-source licenses (predominantly the MIT License and SIL Open Font License 1.1).**

These licenses explicitly permit:
- ✅ Commercial and non-commercial reuse.
- ✅ Full modification and adaptation of the code.
- ✅ Distribution and sublicensing.
- ✅ Integration into private or proprietary repositories.

The only universal condition is **retaining copyright and attribution notices**, which this document provides.

---

## 2. Directory of Attributions & Repository Owners

### 1. `acocalypso/mtgproxyprint`
- **Author / Owner:** `@acocalypso`
- **Repository:** [https://github.com/acocalypso/mtgproxyprint](https://github.com/acocalypso/mtgproxyprint)
- **License:** **MIT License**
- **Contribution / Adapted Logic:** Dual-regex parsing architecture for MTG decklists handling card counts, multi-word names with punctuation, and bracket/parentheses set annotations. Adapted inside `src/DeckParser.js`.

---

### 2. `blinpete/mtg-builder`
- **Author / Owner:** `@blinpete`
- **Repository:** [https://github.com/blinpete/mtg-builder](https://github.com/blinpete/mtg-builder)
- **License:** **MIT License**
- **Contribution / Adapted Logic:** Sideboard section state transition patterns and clipboard import sanitization. Adapted inside `src/DeckParser.js`.

---

### 3. `crookedneighbor/scryfall-client`
- **Author / Owner:** `@crookedneighbor`
- **Repository:** [https://github.com/crookedneighbor/scryfall-client](https://github.com/crookedneighbor/scryfall-client)
- **License:** **MIT License**
- **Contribution / Adapted Logic:** Automatic array batching and chunking logic for Scryfall's `/cards/collection` endpoint ($\le 75$ cards per request). Adapted inside `src/ScryfallService.js`.

---

### 4. `andrewgioia/mana` (`mana-font`)
- **Author / Owner:** Andrew Gioia (`@andrewgioia`)
- **Repository:** [https://github.com/andrewgioia/mana](https://github.com/andrewgioia/mana)
- **License:** 
  - **CSS / Code:** **MIT License**
  - **Font Files:** **SIL Open Font License (OFL) 1.1**
  - **Card / Mana Artwork:** Copyright © Wizards of the Coast LLC.
- **Contribution / Adapted Logic:** Vector glyph typography and CSS class mappings (`ms ms-w`, `ms ms-u`, `ms ms-tap`, `ms ms-cost`) for high-fidelity mana cost rendering. Integrated inside `src/view/CardOverlayModal.js` and `src/view/tabletop.css`.

---

### 5. `natefinch/moxmox`
- **Author / Owner:** Nate Finch (`@natefinch`)
- **Repository:** [https://github.com/natefinch/moxmox](https://github.com/natefinch/moxmox)
- **License:** **MIT License**
- **Contribution / Adapted Logic:** P2P MTG zone topology abstractions (battlefield partitioning, graveyard, library, and hand state models). Adapted inside `src/ZoneModel.js`.

---

### 6. `untemps/vocal`
- **Author / Owner:** Vincent Touzet (`@untemps`)
- **Repository:** [https://github.com/untemps/vocal](https://github.com/untemps/vocal)
- **License:** **MIT License**
- **Contribution / Adapted Logic:** Browser `SpeechRecognition` normalization, vendor prefix fallback (`webkitSpeechRecognition`), and event stream handling. Adapted inside `src/SpeechRecognitionService.js`.

---

## 3. Third-Party Service & IP Disclaimers

### Scryfall API
- **Provider:** Scryfall LLC ([https://scryfall.com](https://scryfall.com))
- **Terms:** Used in strict accordance with Scryfall's API Guidelines (polite 100ms request throttling, custom `User-Agent: RPM-Multiplayer/1.0`, and collection batch endpoints).

### Wizards of the Coast
- **Intellectual Property:** Magic: The Gathering, card names, card text, mana symbols, and game mechanics are copyright © Wizards of the Coast LLC, a subsidiary of Hasbro, Inc.
- **Fan Content Policy:** RPM Multiplayer is unofficial fan content permitted under the **Wizards of the Coast Fan Content Policy**. It is not approved, endorsed, or affiliated with Wizards of the Coast.
