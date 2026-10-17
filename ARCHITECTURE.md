# 🏛️ RPM Multiplayer Architecture & Engineering Process Documentation

**System:** RPM Multiplayer (RPM Revival Tabletop Arena)  
**Target Format:** Magic: The Gathering — Modern Format MVP  
**Design Philosophy:** Decentralized Tabletop Simulator Companion (Passive Ledger + Fog-of-War Projection + Priority Bus, NOT an autonomous rules engine)

---

## 1. Engineering Process & Pipeline

To prevent infinite loops, hallucinations, and code drift, the entire engine was built using a **strict 3-Tier Agentic Verification Pipeline**:

```mermaid
flowchart LR
    A["1. Formal Specification<br/>(Argon / Pro Model)"] --> B["2. High-Reasoning Implementation<br/>(Flash Model)"]
    B --> C["3. Empirical Invariant Audit<br/>(Verificator / Pro Model)"]
    C -->|100% Pass| D["Certified Feature Module"]
    C -->|Defect Found| B
```

1. **Tier 1 — Formal Specification (`Argon` / Gemini Pro):**
   - Defines strict input/output contracts, TypeScript interfaces, error hierarchies, and mathematical invariants before any code is written.
   - Resulted in: `SPEC-RPM-INGEST-001`, `SPEC-RPM-ZONE-003`, `SPEC-RPM-PRIORITY-004`, `SPEC-RPM-CHAT-005`, and `SPEC-RPM-UI-007`.
2. **Tier 2 — High-Reasoning Implementation (`Flash`):**
   - Implements modular, zero-dependency ES Modules adhering strictly to the specification documents.
3. **Tier 3 — Independent Verification (`Verificator` / Gemini Pro):**
   - Independent subagent runs unit suites, executes live network tests, probes mathematical boundary conditions, and stress-tests frame rendering budgets before certifying completion.

---

## 2. System Architecture & Topology

The RPM Multiplayer architecture is divided into 5 modular layers:

```mermaid
flowchart TD
    subgraph View["🖥️ View Layer (src/view)"]
        UI["TabletopUI.js (Reactive Keyed Reconciler, <3.7ms)"]
        Modal["CardOverlayModal.js (Scryfall Details & mana-font)"]
        CSS["tabletop.css (Responsive 375px to 1080p+, Retro 8-bit Alarm)"]
    end

    subgraph ChatBus["💬 Dual-Channel & Action Bus Layer"]
        Chat["DualChannelChat.js (Chit-Chat vs Priority-Gated Turn Command)"]
        Lexer["ActionLexer.js (Sub-2ms Bilingual Fast-Path Parser)"]
        Speech["SpeechRecognitionService.js (Spanish Default / English Toggle)"]
    end

    subgraph Priority["⏱️ Priority & Stack Engine"]
        FSM["PriorityStateMachine.js (MTG CR 117 & 12 Phase Steps)"]
        Alarm["StackAlarmManager.js (15-Second Alarm with Pass/Hold Triggers)"]
        Journal["CheckpointJournal (Rollback Snapshots)"]
    end

    subgraph State["🃏 Tabletop State Layer"]
        Tabletop["TabletopStateManager.js (Multiplayer Match State)"]
        Zones["ZoneModel.js (Fisher-Yates, Permanent Cleanup, Invariants)"]
    end

    subgraph Ingestion["📦 Core Ingestion Layer"]
        Parser["DeckParser.js (Dual-Regex Arena/MTGO/Text Ingest)"]
        Scryfall["ScryfallService.js (1-Call Batch Collection & Dual Cache)"]
    end

    View --> ChatBus
    ChatBus --> Priority
    Priority --> State
    State --> Ingestion
```

---

## 3. Subsystem Breakdown

### 1. Core Ingestion Engine ([`src/DeckParser.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/DeckParser.js) & [`src/ScryfallService.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/ScryfallService.js))
- **`DeckParser.js`:** Ingests raw text from clipboard, MTG Arena, MTGO, Moxfield, or Archidekt. Uses a dual-regex engine to parse counts, names with punctuation (e.g. *"Ragavan, Nimble Pilferer"*), set codes `(MH2)`, collector numbers, and sideboards. Captures malformed lines in an errors array without crashing.
- **`ScryfallService.js`:** Calls `POST https://api.scryfall.com/cards/collection`. Automatically chunks requests exceeding 75 cards into batches $\le 75$. Enforces a polite 100ms throttle. Resolves full 75-card Modern decks in **1 single HTTP request** and persists them to `LocalStorage` or in-memory cache for zero-network repeat loads. Normalizes multi-faced cards (DFCs, MDFCs, split cards).

### 2. Tabletop Zone State & Fog-of-War ([`src/TabletopStateManager.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js) & [`src/ZoneModel.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/ZoneModel.js))
- **Zone Topology:** Each player possesses private zones (`library`, `hand`) and public zones (`battlefield: { lands, creatures, noncreatures, planeswalkers }`, `graveyard`, `stack`, `exile`).
- **Fog-of-War Projection (`projectState(viewerId)`):** Active owner sees their hand card names and art; opponents receive strictly masked tokens (`{ instanceId: 'hidden', isHidden: true }`) with an accurate count, preventing any DOM inspection cheating. Library order is concealed.
- **State Invariants:** Enforces card conservation ($N=60$), spatial exclusivity, mana floors ($\ge 0$), and battlefield purity (leaving the battlefield resets tapped state and clears counters).

### 3. Stack & Priority Flow State Machine ([`src/PriorityStateMachine.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PriorityStateMachine.js) & [`src/StackAlarmManager.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/StackAlarmManager.js))
- **Canonical Turn Flow:** Orchestrates all 12 MTG turn steps (`UNTAP` $\to$ `UPKEEP` $\to$ `DRAW` $\to$ `PRECOMBAT_MAIN` $\to$ Combat $\to$ `POSTCOMBAT_MAIN` $\to$ `END_STEP` $\to$ `CLEANUP`).
- **Priority Gating:** Only `priorityPlayerId` can dispatch mutating game actions.
- **15-Second Stack Alarm:** Spells entering the stack trigger an automated 15-second countdown. Opponents can tap **`[Pass Priority]`** or **`[Hold / Respond]`** (freezes countdown and unlocks the response window). If the timer expires, it auto-passes.
- **LIFO Stack & Rollbacks:** Spells resolve in strict Last-In, First-Out order. The `CheckpointJournal` captures deep snapshots before every mutation, enabling clean rollbacks if actions are disputed.

### 4. Dual-Channel Chat & Fast-Path Action Bus ([`src/DualChannelChat.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/DualChannelChat.js) & [`src/ActionLexer.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/ActionLexer.js))
- **Channel Isolation:**
  - `CHIT_CHAT`: Open table banter for all players at all times. Zero rules engine overhead, zero state mutation.
  - `TURN_COMMAND`: Strictly priority-gated. Disabled with a lock badge when inactive.
- **Sub-2ms Action Lexer:** Benchmarked at **0.0059ms/call**. Parses bilingual shorthands in Spanish (`"paso"`, `"baja a 16"`, `"bajo isla"`, `"tiro bolt"`) and English (`"pass"`, `"to 17"`, `"play mountain"`, `"cast bolt"`).
- **Staged Intent Chips:** Spoken/typed commands create a floating proposal chip: `[Confirm: Cast Lightning Bolt ({R}) on Ragavan?] [Confirm] [Edit] [Cancel]`. Zero state mutates until the player taps `[Confirm]`.
- **Speech Recognition:** Integrates `SpeechRecognitionService.js` with Spanish (`es-ES`) primary default and English (`en-US`) toggle.

### 5. Minimalist Accordion Tabletop UI ([`src/view/TabletopUI.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/view/TabletopUI.js), [`CardOverlayModal.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/view/CardOverlayModal.js), [`tabletop.css`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/view/tabletop.css))
- **Reactive Keyed Reconciler:** Benchmarked at **3.72ms/frame**, ensuring smooth 60 FPS performance.
- **Opponent Section (Top):** Summary bar (Life, counters, land mana breakdown `<i class="ms ms-r"></i> x2`) + tap-to-expand accordion zone badges (`[Creatures: 2]`, `[Hand: 4]`, etc.).
- **Center Section:** Strict LIFO visual stack queue with prominent top-item styling + 15s alarm timer bar.
- **Player Section (Bottom):** Interactive life controls (`[-]` / `[+]`), floating mana pool chips, and hand drawer expanded by default.
- **Scryfall Overlay Modal:** Accessible preview dialog rendering high-res art, vector `mana-font` glyphs, oracle text, and Modern Legal badges. Dismissible via backdrop tap, `[×]`, or Escape.
- **Responsive Design:** CSS Flexbox/Grid adapting seamlessly from mobile portrait (375px) to 1080p+ widescreen displays.

---

## 4. Test Suite Summary

The repository includes a comprehensive 75-test automated verification suite (`npm test`):
- `SPEC-RPM-INGEST-001`: 13 Tests (Deck parsing, Scryfall collection batching, rate limits, DFCs)
- `SPEC-RPM-ZONE-003`: 15 Tests (Zone models, card conservation, Fog-of-War masking, mana floors)
- `SPEC-RPM-PRIORITY-004`: 12 Tests (Turn steps, APNAP rotation, 15s stack alarm, LIFO stack, rollbacks)
- `SPEC-RPM-CHAT-005`: 17 Tests (Dual-channel gating, sub-2ms lexer, staged chips, speech binding)
- `SPEC-RPM-UI-007`: 18 Tests (DOM reconciliation, accordion drawers, modal accessibility, sub-16ms frames)
- **Live Integration:** 7 Tests against the real Scryfall API (`npm run test:live`)
