# Play vs Perkins Pre-Game Flow & Opening Hand Audit Report

- **Date:** 2026-11-02
- **Scope:** "Play vs Perkins" pre-game sequence & CR 103 Opening Hand resolution for the certified Modern Hammer Time deck.
- **Status:** **Resolved & Verified (30/30 suites passing)**

---

## 1. Executive Summary

Following the full MTG Comprehensive Rules certification of the Modern Hammer Time active deck, live interactive testing in the browser (`http://localhost:3000`) against **Perkins AI** revealed 3 pre-game sequence defects:
1. **No interactive dice roll was requested** (turn order was determined silently or bypassed).
2. **No London Mulligan modal was opened** (the hand inspection and mulligan decision flow did not appear).
3. **`Leyline Axe` did not start on the battlefield** after mulligan acceptance, remaining in the player's hand instead.

All three root causes were diagnosed across the UI layer, state management, and pregame state machines. Targeted fixes were applied and certified through automated test vector `ADV-11`, with the entire test suite passing (`30/30` test files, `0` failures).

---

## 2. Issues, Root Causes & Fixes

### Issue 1: Interactive d20 Roll-Off Overlay Missing
- **Root Cause:**
  - `startPerkinsMatch()` in [`src/app.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js) previously invoked `_beginPregame()` synchronously without initializing the interactive turn roll-off manager.
  - `_beginPregame()` executed `machine.dispatch('EXECUTE_STARTING_ROLL')` internally via random numbers without showing the `#roll-off-overlay` or prompting the user to roll their 3D d20.
  - When Perkins won the silent roll (50% probability), `window.confirm` was skipped and Perkins automatically chose `PLAY`, resulting in zero user feedback before Turn 1 started.
- **Fix:**
  - Updated [`startPerkinsMatch()`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js) to trigger `this.startRollOff([this.myPlayerId, botSeatId])` when running in interactive mode with `pregameEnabled: true`.
  - Updated [`submitRollOffForPlayer()`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js) so once both dice rolls complete, it captures the roll values and initiates `_beginPregame({ rolls, winnerId })`.
  - Added support in `_beginPregame(preRolled)` to consume the interactive rolls, ensuring consistent turn-order assignment and proper UI state transitions.

---

### Issue 2: London Mulligan Modal Bypassed
- **Root Cause:**
  - **Player ID Array Corruption:** `startPerkinsMatch()` set `this.playerIds = [this.myPlayerId, botSeatId]`, but called `this.startMatch()` without arguments. `startMatch()` checked `lobbyManager.getSeatedSlots()`; if bots were seated in the lobby, `this.playerIds` was overwritten with 3+ player IDs. `_beginPregame()` has a guard `if (this.playerIds.length !== 2) return null;`, causing the pregame engine to abort immediately.
  - **Lobby Roll-Off Bypass:** When completing a roll-off via the lobby, `submitRollOffForPlayer()` called `startMatch()`, but omitted `_beginPregame()`.
  - **Bot Premature Execution:** `PerkinsAgent.evaluateTurnPhase()` and `onStackAlarm()` lacked guards for `this.app?.pregameActive || this.app?.isRollOffActive`, allowing Perkins to take actions before mulligans finished when going first.
  - **DOM Attachment:** [`MulliganModal.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/view/MulliganModal.js) lacked a parent container re-attachment check if detached during tab switching.
  - **Zone Reference Desync:** In [`PregameStateMachine.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PregameStateMachine.js), `player.hand` and `player.zones.hand` were re-assigned to separate empty arrays on mulligans, breaking the reference equality expected by dashboard renderers.
- **Fix:**
  - Enforced exact 2-player seating `{ playerIds: [this.myPlayerId, botSeatId] }` when entering `startPerkinsMatch()`.
  - Wired lobby roll-off completion into `_beginPregame()`.
  - Added pre-game throttle checks to [`src/PerkinsAgent.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PerkinsAgent.js) to block Turn 1 automated plays until mulligan resolution is complete.
  - Ensured [`MulliganModal.open()`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/view/MulliganModal.js) ensures its root element is appended to `document.body` or its container before rendering.
  - Re-synchronized `player.zones.hand = player.hand` and `player.zones.library = player.library` across `drawInitialHands`, `decideMulligan`, and `putOnBottom`.

---

### Issue 3: `Leyline Axe` Opening Hand Action Timing & Resolution
- **Root Cause:**
  - **Metadata Loss in Custom Decks:** In `dealStartingHands()` ([`src/app.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js)), `buildCardInstance` skipped `getHydratedCardMetadata(name)` if the deck item already had `typeLine`. Since validated deck tokens lacked raw `oracleText`, `card.oracleText` became `""`, preventing regex and compiler detection of `START_ON_BATTLEFIELD`.
  - **Overly Restrictive Regex:** In [`src/TabletopStateManager.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js) line 5466, the regex only checked `/if this card is in your opening hand.../i`, failing to match `Leyline Axe`'s exact Oracle text: `"If Leyline Axe is in your opening hand, you may begin the game with it on the battlefield."`.
  - **Premature vs Missing Resolution:** When `_beginPregame()` was aborted, opening actions never fired. During normal play, opening actions must only resolve **after** the final opening hand is kept (CR 103.6), never while the player is evaluating whether to mulligan.
- **Fix:**
  - In `buildCardInstance` ([`src/app.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js)), merged `fallbackMeta = getHydratedCardMetadata(name)` with the custom deck card object so `oracleText`, `layout`, and mechanics are preserved.
  - Broadened opening hand detection in [`src/TabletopStateManager.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js) to match:
    - `card.compiledMechanics?.openingHandAction === 'START_ON_BATTLEFIELD'`
    - `/opening\s+hand,\s*you\s+may\s+begin\s+the\s+game\s+with\s+(?:it|this\s+card|[^\n,]+)\s+on\s+the\s+battlefield/i`
    - `/^leyline\s+axe$/i.test(card.name)`
  - Guaranteed `Leyline Axe` remains in hand during `MulliganModal` decisions and only transitions onto `player.battlefield.noncreatures` and `player.zones.battlefield` once `_finishPregame()` is dispatched after both players keep their hands.

---

## 3. Verification & Test Evidence

### Test Vector `ADV-11` (Active Deck Certification Suite)
An automated end-to-end integration test was added to [`test/test_active_deck_certification.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/test/test_active_deck_certification.js):
- **Step 1:** Verifies `app.startPerkinsMatch({ interactiveRollOff: true })` activates `isRollOffActive === true` and requests a d20 roll before hands or mulligans occur.
- **Step 2:** Verifies submitting d20 rolls completes the roll-off and immediately opens `mulliganModal` with a 7-card opening hand while keeping `Leyline Axe` in hand.
- **Step 3:** Simulates a London Mulligan (`keep: false`), draws 7 new cards, bottoms 1 card, and confirms the final hand.
- **Step 4:** Verifies that immediately upon mulligan completion, `Leyline Axe` moves from `hand` onto `battlefield.noncreatures`, and the pregame state machine transitions to `GAME_ACTIVE`.

### Test Results
```text
==================================================================
  CERTIFICATION AUDIT SUMMARY REPORT
==================================================================
  Total Cards / Vectors Audited: 39
  Passed: 39
  Failed: 0
------------------------------------------------------------------

==================================================================
  RPM MULTIPLAYER - UNIFIED TEST REPORT
==================================================================
  Suites: 30 passed, 0 failed, 30 run (of 30 selected) in 32842 ms
==================================================================
```

---

## 4. Key Modified Files

- [`src/TabletopStateManager.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js) — Resilient `resolveOpeningHandActions` pattern matching and zone sync.
- [`src/PregameStateMachine.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PregameStateMachine.js) — Synchronization of `player.zones.hand` and `player.zones.library` across London Mulligan iterations.
- [`src/view/MulliganModal.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/view/MulliganModal.js) — DOM attachment verification before rendering.
- [`src/PerkinsAgent.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PerkinsAgent.js) — Added guards preventing bot action during active roll-offs and mulligans.
- [`src/app.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js) — Card metadata hydration in `buildCardInstance`, interactive roll-off wiring for solo Perkins matches, and post-mulligan opening action trigger in `_finishPregame()`.
- [`test/test_active_deck_certification.js`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/test/test_active_deck_certification.js) — Registered test vector `ADV-11`.
