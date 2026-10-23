# Micro-Audit & Hotfix: Creature Spell Resolution Traceability

- **Date:** 2026-10-21
- **Scope:** Resolution pipeline of permanent creature spells between `src/app.js`, `src/PriorityStateMachine.js`, and `src/TabletopStateManager.js`.
- **Status:** Resolved & Verified (All 27 suites passing with `EXIT_CODE 0`).

---

## 1. Executive Summary & Root Cause Diagnosis

1. **Stack Desynchronization & Guard Abort:**  
   `src/app.js` pushed cast items exclusively to `PriorityStateMachine.stack` without synchronizing `TabletopStateManager.stack`. When `PriorityStateMachine.resolveTop()` popped the stack item and invoked `TabletopStateManager.handleStackResolution`, Step 1 could not find the item on `TabletopStateManager.stack` (`stackIdx === -1`), falling through to Step 2 where `undefined === undefined` falsely matched un-instanced cards on the battlefield or in graveyard and aborted resolution.

2. **Residual Targets & False CR 608.2b Fizzle:**  
   In `src/app.js`, `targets: payload.targets || action.targets || payload.targetId || action.targetId` assigned target metadata to non-targeted creature spells. In `TabletopStateManager.handleStackResolution`, target legality was evaluated unconditionally via CR 608.2b, falsely triggering `SPELL_FIZZLED` and sending the creature directly to the graveyard whenever targets were missing or stale.

3. **State-Based Actions (CR 704.5f) Zero-Toughness Death:**  
   When a creature spell resolved without explicit toughness (`toughness === undefined`), `StateBasedActionsEngine.runSBACheck()` evaluated `Number(card.toughness) || 0 <= 0` under CR 704.5f immediately after resolution, moving the newly placed creature from `player.battlefield.creatures` to `player.graveyard`.

---

## 2. In-Depth Traceability Analysis

```
[UI / Action Pipeline]
       │
       ▼
app.js::dispatchAction('CAST_SPELL')
       │
       ├──► PriorityStateMachine.pushStack(item)   <── (Previously desynced from TabletopStateManager)
       │
       ▼ (Priority passes / All players pass)
PriorityStateMachine.resolveTop()
       │
       ├──► tabletopState.handleStackResolution(resolvedItem)
       │         │
       │         ├── 1. Idempotency Guard (Step 1 findIndex / Step 2 alreadyOnField check)
       │         │      Fix: hasValidId guard prevents 'undefined === undefined' aborts.
       │         │
       │         ├── 2. CR 608.2b Target Validation
       │         │      Fix: Restrict fizzle checks to isInstantOrSorcery || isAura.
       │         │
       │         ├── 3. CR 400.7 Zone-Change Object Creation
       │         │      Fix: Hydrate base power/toughness (>= 1) and push to player.battlefield.creatures.
       │         │
       │         └── 4. State-Based Actions (runSBACheck)
       │                Fix: Creature survives CR 704.5f check with toughness > 0.
       │
       ▼
[Creature on Battlefield: player.battlefield.creatures.length === 1]
```

---

## 3. Surgical Code Modifications

### 3.1 `src/TabletopStateManager.js`
- **Bi-Directional Sync in `_handleCastSpell`:** Automatically pushes to `this.priorityMachine.pushStack` if the Priority State Machine is wired and the item is not already queued.
- **Idempotency Guard Hardening in `handleStackResolution`:** Added `hasValidId = Boolean(originalCard.instanceId)` to ensure un-instanced cards never match `undefined === undefined` in Step 2.
- **CR 608.2b Target Restriction:** Defined `isTargetableSpell = isInstantOrSorcery || isAura`. Non-aura permanent spells (Creatures, Artifacts, Planeswalkers) bypass spell target fizzling per MTG CR 302.1 / CR 115.1.
- **Power / Toughness Preservation:** Preserved and hydrated base stats upon battlefield entry (`card.power = Number(card.power ?? originalCard.power ?? 1)`, `card.toughness = Number(card.toughness ?? originalCard.toughness ?? 1)`).
- **Deck Mechanic Hydration:** Enhanced `hydrateCardMechanics` to explicitly set `typeLine: 'Creature — ...'` for starter creatures (`Goblin Guide`, `Monastery Swiftspear`).

### 3.2 `src/PriorityStateMachine.js`
- **Synchronized Stack in `pushStack`:** Ensures any item pushed to `PriorityStateMachine.stack` is simultaneously synchronized to `this.tabletopState.stack` if wired and not already present.

### 3.3 `src/app.js`
- **Sanitized Cast Targets in `case 'CAST_SPELL'`:** Formats targets strictly for targetable spell types (`instant`, `sorcery`, `aura`) while passing `targets: []` and `targetId: null` for permanent spells.
- **Dual Stack Placement:** Directly verifies and synchronizes the card to `this.tabletopState.stack`.

---

## 4. Verification & Testing

### 4.1 End-to-End Orchestration Test
Added test case in `test/test_tabletop_orchestration.js`:
- Casts a creature spell (`Grizzly Bears`, `{1}{G}`, 2/2) via `TabletopStateManager.castSpell()`.
- Verifies both `TabletopStateManager.stack` and `PriorityStateMachine.stack` hold the spell.
- Resolves via `PriorityStateMachine.resolveTop()`.
- Asserts:
  - `tsm.stack.length === 0`
  - `psm.stack.length === 0`
  - `player.battlefield.creatures.length === 1`
  - `player.battlefield.creatures[0].name === 'Grizzly Bears'`
  - `player.battlefield.creatures[0].power === 2`
  - `player.battlefield.creatures[0].toughness === 2`
  - Residual target payloads do not trigger false fizzles.

### 4.2 Test Suite Execution Evidence
- `node test/test_tabletop_orchestration.js` -> `13 passed, 0 failed`
- `npm test` (`node test/run_all.js`) -> `27 suites passed, 0 failed` (100% pass)
