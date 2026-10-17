# ⚔️ RPM Multiplayer Modern Tabletop Companion

> Authoritative, zero-dependency digital companion for remote and asynchronous **Magic: The Gathering (Modern)** and **Random Perk Magic (RPM)** multiplayer battles (2 to 6 players).

[![Tests](https://img.shields.io/badge/tests-119%20passed-brightgreen.svg)]()
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20external-blue.svg)]()
[![License](https://img.shields.io/badge/license-MIT-green.svg)]()

---

## 📖 Overview

The **RPM Multiplayer Modern Tabletop Companion** combines the tactile freedom of a physical tabletop with authoritative server-side room synchronization, zero-knowledge Fog-of-War masking, 15-second Stack Alarms, automated Scryfall card inspection, an offline deterministic AI deckbuilder, and custom victory fanfare audio playback.

Designed strictly under the **Tabletop Simulator Companion Paradigm** (DEC-001): human players maintain board authority and declare actions, while the software provides room synchronization, priority enforcement, dice rolling, and life/zone tracking without non-computable rules-engine overhead.

---

## 🚀 Key Features

1. **Card Ingestion & Scryfall Batching (`src/DeckParser.js`, `src/ScryfallService.js`)**:
   - Ingests exports from MTG Arena, MTGO, Moxfield, Archidekt, and plain text.
   - Resolves full 75-card tournament decks in **1 single HTTP POST request** to Scryfall `/cards/collection` in <1100ms.
   - Dual-layer cache with multi-faced card (DFC/MDFC/Split) normalization.
2. **Tabletop Zones & Fog-of-War (`src/TabletopStateManager.js`, `src/ZoneModel.js`)**:
   - Private zones (Hand, Library) vs. Public zones (Battlefield subzones, Graveyard, Stack, Exile).
   - Zero-Knowledge Fog-of-War (`projectState`): Opponents receive masked `{ instanceId: 'hidden' }` tokens over the wire and in the DOM.
3. **Priority State Machine & 15s Stack Alarm (`src/PriorityStateMachine.js`, `src/StackAlarmManager.js`)**:
   - Orchestrates all 12 MTG turn steps with strict priority gating (CR 117).
   - 15-second Stack Alarm countdown when spells or perks enter the stack with instant Pass / Hold controls.
   - 50-snapshot checkpoint rollback journal.
4. **Dual-Channel Priority Chat & Fast-Path Lexer (`src/DualChannelChat.js`, `src/ActionLexer.js`)**:
   - Unrestricted Chit-Chat tab vs. Priority-gated Turn Command tab with red lock badge.
   - Bilingual (ES/EN) regex lexer running in **0.004ms/call** producing 1-tap staged confirmation chips.
5. **Multiplayer WebSocket Relay Server (`src/relay.js`, `src/RelayClient.js`)**:
   - Zero external dependencies using standard Node.js built-ins (`http`, `crypto`, `buffer`).
   - Supports 2 to 6 seated players + unlimited spectators.
   - 6-character Crockford Base32 join codes (`ARENA-1`) with 256-bit cryptographic seat tokens.
   - Authoritative monotonic sequencer (`seq: 1, 2, 3...`) with automatic gap retransmission.
   - 90-second total match disconnect bank with unpaused 15s Stack Alarm auto-passing.
   - Dynamic Active Priority Ring skipping eliminated players (`INV-RING-1`) and CR 800.4a stack purge (`INV-RING-2`).
6. **Random Perk Upkeep Emblem (`src/RandomPerkEngine.js`, `src/PerkCatalog.js`)**:
   - Static Command Zone Emblem triggering at the start of each player's UPKEEP.
   - Turn unlock scaling: Turn 2+ for 3–6 players, Turn 4+ for 1v1 duels.
   - Server-authoritative cryptographic 2 d10 rolling (`crypto.randomInt`).
   - Two-step stack flow: Upkeep trigger resolves to roll $\to$ on hit, validates CR 603.3d legal targets before entering stack $\to$ opponents respond during 15s alarm $\to$ resolves effects on tabletop.
   - 12 canonical perks + Birthday Match (`RPBD`), with CR 608.2c partial execution for Perk #13.
7. **Deckbuilder AI Agent (`src/DeckbuilderAI.js`, `src/StorageAdapter.js`)**:
   - 10-point guideline memory with 👍 / 👎 preference curation and 16KB quota guard.
   - Deterministic recency conflict resolution.
   - 100% offline Mode A generation: 5 tournament starter archetypes and single-color beginner decks with balanced 22–24 land curves.
   - Top 10 public player showcase with logarithmic damped composite scoring.
8. **User Profile & Victory Fanfare (`src/VictoryFanfare.js`)**:
   - Standard 1v1 FIDE Elo ($K=32$, starting 1200) + multi-player FFA pairwise decomposition strictly zero-sum ($\sum \Delta R = 0$).
   - Milestone deck slot unlocks (1 to 5 slots) with monotonic anti-regression.
   - Instagram-style A-to-B audio selector (8–12s window) with YouTube IFrame API and HTML5 `<audio>`.
   - Browser autoplay priming + autonomous 8-bit synthetic retro chiptune fallback.
9. **Browser Integration Harness (`index.html`, `src/app.js`)**:
   - Responsive single-page application mounting all systems with unidirectional data flow (strict `'LOCAL'` vs `'REMOTE'` origin tagging eliminating circular broadcast storms).
   - Sub-millisecond reactive DOM reconciliation (~0.30ms/frame, well within 16ms 60 FPS budget).

---

## 🛠️ Quick Start

### Prerequisites
- Node.js v18.0.0 or higher.
- No external npm dependencies required (`package.json` uses zero production dependencies).

### Installation & Local Run
```bash
# Clone the repository
git clone https://github.com/Svayneak/rpm-multiplayer.git
cd rpm-multiplayer

# Run full automated test suite (119 unit & acceptance tests)
npm test

# Start the standalone server (Frontend + WebSocket Relay)
npm start
```

Visit `http://localhost:3000` in your web browser.

---

## 🚢 Hosting & Deployment

The application is engineered for instant, zero-configuration deployment to any cloud PaaS (Render, Fly.io, Railway, Heroku, or standard VPS).

### Deploy to Render
1. Push this repository to GitHub.
2. In the Render Dashboard, click **New +** $\to$ **Web Service**.
3. Connect your GitHub repository.
4. Configure:
   - **Environment:** `Node`
   - **Build Command:** *(leave empty or `npm test`)*
   - **Start Command:** `npm start`
5. Render automatically sets the `PORT` environment variable. `server.js` detects it and binds both static assets and the WebSocket relay to that port.

### Deploy to Fly.io
```bash
fly launch
fly deploy
```

---

## 🧪 Testing

The repository contains an exhaustive suite of 119 unit and acceptance tests covering every formal invariant:

```bash
# Run all test suites
npm test

# Run individual feature test suites
npm run test:ingest    # Features 1 & 2: Ingestion & Scryfall
npm run test:zone      # Feature 3: Tabletop Zones & FoW
npm run test:priority  # Feature 4: Priority & Stack Flow
npm run test:chat      # Features 5 & 6: Dual Chat & Lexer
npm run test:ui        # Feature 7: Accordion UI & Modal
npm run test:relay     # Feature 8: WebSocket Relay & Seating
npm run test:perk      # Feature 9: Random Perk Emblem
npm run test:deckai    # Feature 10: Deckbuilder AI
npm run test:fanfare   # Feature 11: Profile & Victory Audio
npm run test:harness   # Feature 12: Playable Browser Harness
```

---

## 📜 Legal & Credits

- Magic: The Gathering is a trademark of Wizards of the Coast LLC, a subsidiary of Hasbro, Inc. This project is unofficial fan content permitted under the [Wizards of the Coast Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). Not approved/endorsed by Wizards.
- Scryfall API data and images are courtesy of [Scryfall](https://scryfall.com/).
- Mana font vector icons courtesy of [Andrew Gioia / Mana Font](https://andrewgioia.github.io/mana/).
- Complete open-source code attributions and licensing details are cataloged in [`CREDITS.md`](CREDITS.md).

---

## 📄 License

MIT © [Svayneak](https://github.com/Svayneak)
