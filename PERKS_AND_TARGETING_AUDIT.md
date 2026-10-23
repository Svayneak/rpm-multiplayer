# Forensic Architecture Audit: Perks/2d10 Subsystem, Target Selector, Attacker Target Switching & Game-Over Elimination (`PERKS_AND_TARGETING_AUDIT.md`)

**Audit Mode:** 100% Read-Only Forensic Code Inspection (Zero Source Modifications, Zero Conjecture)  
**Target Repository:** `/home/svayneak/Documents/Svayneak/rpm multiplayer`

---

## 1. Current Implementation of the RPM Emblem & 2d10 Dice (`00`–`99`, `13`, `RPBD`)

### 1a) Exact Files, Functions & Line Numbers for `Roll 2d10`, Perk Table & `UPKEEP` Trigger

1. **2d10 Authoritative Dice Roll (`src/RandomPerkEngine.js:26-42`, `290-299` & `src/app.js:1297-1331`)**:
   - [`executeAuthoritativeRoll(prng = null)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/RandomPerkEngine.js#L26-L42) generates `tens` (`0–9`, Violet Die) and `ones` (`0–9`, Aquamarine Die) via `crypto.getRandomValues(new Uint32Array(2))` (`lines 31-35`) or injected `prng`, returning `{ tens, ones, rollString: `${tens}${ones}` }`.
   - [`RandomPerkEngine.rollDice()`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/RandomPerkEngine.js#L290-L292) delegates to `executeAuthoritativeRoll(this.prng)`.
   - In the UI, manual command-lexed rolls call [`RPMAppController.triggerDiceRoll(diceType)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L1297-L1331), which invokes `diceCanvas.rollPercentile()` (`line 1304`) or `executeAuthoritativeRoll()` (`line 1319`), resolves the roll via `resolveRoll`, and updates `#perk-dice-container` via [`handlePerkRolled(roll)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L3149-L3190).

2. **Perk Table Definitions (`00` to `99`, `13`, and `RPBD`) (`src/PerkCatalog.js:9-796`)**:
   - [`PERK_KEYS`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PerkCatalog.js#L9-L13): `['00', '11', '22', '33', '44', '55', '66', '77', '88', '99', '13', 'RPBD']`.
   - [`RPBD_OPTIONS`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PerkCatalog.js#L15-L130): Defines the 5 Birthday Match modes (`RPBD_ATTACK_FORCE`, `RPBD_FREE_SPELLS`, `RPBD_DISCARD_NONLAND`, `RPBD_LIFE_LEECH`, `RPBD_ATTACK_DRAW`).
   - [`CANONICAL_PERKS`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PerkCatalog.js#L132-L684):
     - `'00'` (*Genesis Surge*, `lines 133-159`): Gain 10 life, draw 3 cards.
     - `'11'` (*Overrun Counter*, `lines 161-194`): Put a `+1/+1` counter on each controlled creature.
     - `'22'` (*Divination*, `lines 196-220`): Draw 2 cards.
     - `'33'` (*Vitality Boost*, `lines 222-246`): Gain 10 life.
     - `'44'` (*Exploration*, `lines 248-278`): Draw 1 card + `player.resources.additionalLandsAllowed = (player.resources.additionalLandsAllowed || 0) + 1`.
     - `'55'` (*Cataclysmic Ruin*, `lines 280-375`): Targeted (`PERMANENT`). Strips hexproof/indestructible until EOT and destroys target permanent.
     - `'66'` (*Mutual Sacrifice*, `lines 377-433`): Each player sacrifices a creature and discards a card.
     - `'77'` (*Precognition*, `lines 435-463`): Scry 2, draw 1 card.
     - `'88'` (*Peace Accord*, `lines 465-498`): Each living player draws 2 cards and gains 2 life.
     - `'99'` (*Torment*, `lines 500-588`): Targeted (`PLAYER`). Target opponent discards a card and sacrifices a permanent.
     - `'13'` (*Dark Misfortune*, `lines 590-640`): Active player discards a card and sacrifices a creature.
     - `'RPBD'` (*Birthday Match*, `lines 642-683`): Executes one of the 5 `RPBD_OPTIONS`.
   - [`resolveRoll(tensOrRollString, onesOrBirthdayRoll, birthdayRollArg)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PerkCatalog.js#L730-L789): Matches against `normalizedBirthday` first (`'RPBD'`), then `canonicalDoubles` (`00`..`99`, `13`), else returns `{ isMiss: true, perkKey: null }`.

3. **How It Triggers in `UPKEEP` (`src/RandomPerkEngine.js:86-88, 141-144, 186-267`)**:
   - In [`RandomPerkEngine.initialize()`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/RandomPerkEngine.js#L113-L152), the engine mounts `emblem_random_perk` into `commandZone` and subscribes to `this.priorityStateMachine.on('PHASE_STEP_CHANGED', this._boundPhaseStepChanged)` (`line 142`) and `this.priorityStateMachine.on('STACK_RESOLVE', this._boundStackResolve)` (`line 143`).
   - When `PHASE_STEP_CHANGED` fires with `event.currentPhaseStep === 'UPKEEP'` (`lines 186-197`), [`handleUpkeepStep(activePlayerId, currentTurn)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/RandomPerkEngine.js#L205-L222) checks `currentTurn < this.perkUnlockTurn` (`this.perkUnlockTurn` is `4` for 2 players, `2` for `>= 3` players, set at `line 87`).
   - Once `currentTurn >= this.perkUnlockTurn`, it calls [`this.triggerStep1(targetPlayerId)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/RandomPerkEngine.js#L231-L267).

---

### 1b) Does It Pass Through `PriorityStateMachine.stack` in Two Steps With Priority, or Execute All at Once?

**Design vs. Runtime Reality:**
- **In `RandomPerkEngine.js` (Lines `231-468`), a Two-Step Stack Flow IS implemented**:
  1. **Step 1 (`triggerStep1`, `lines 231-267`)**: Pushes `{ type: 'PERK_UPKEEP_TRIGGER', name: 'Random Perk Upkeep Trigger' }` onto `this.priorityStateMachine.pushStack(step1Item)` (`line 248`), rotates `priorityPlayerId` to `nextPlayerId` (`line 253`), and starts the 15s `stackAlarmManager` (`line 257`).
  2. **Step 1 Resolution (`onStackResolved` → `handleStep1Resolution`, `lines 274-372`)**: When both players pass priority and `PriorityStateMachine.resolveTop()` emits `'STACK_RESOLVE'`, `handleStep1Resolution` rolls the 2d10 (`line 311`), emits `'PERK_ROLLED'` (`line 329`), and if it hits a perk (`!match.isMiss`), calls [`this.triggerStep2(perkKey, declaredTargets, ...)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/RandomPerkEngine.js#L390-L429).
  3. **Step 2 (`triggerStep2`, `lines 390-429`)**: Pushes `{ type: 'PERK_EFFECT_TRIGGER', perkKey, perkName, targets }` onto `this.priorityStateMachine.pushStack(step2Item)` (`line 409`), rotates `priorityPlayerId` to `nextPlayerId` (`line 414`), and starts a fresh 15s alarm (`line 417`).
  4. **Step 2 Resolution (`onStackResolved` → `handleStep2Resolution`, `lines 437-468`)**: When `PERK_EFFECT_TRIGGER` resolves from the stack, it calls `executePerkEffect(item.perkKey, this.stateManager, ...)` (`lines 443-451`).

- **HOWEVER, Three Severe Runtime Bugs Break This Two-Step Flow in Production**:
  1. **Bug 1A — Clicking `⏭️ Next Phase` in `UNTAP` Blasts Past `UPKEEP` While the Trigger Is on the Stack (`src/PriorityStateMachine.js:923-930`)**:
     - Look at [`PriorityStateMachine.nextPhase(playerId)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PriorityStateMachine.js#L923-L930):
       ```js
       if (this.currentPhaseStep === 'UNTAP' || this.currentPhaseStep === 'UPKEEP') {
         while (this.currentPhaseStep !== 'PRECOMBAT_MAIN' && this.currentPhaseStep !== 'MAIN 1' && this.currentPhaseStep !== 'MAIN_1') {
           const prev = this.currentPhaseStep;
           this.advanceStep();
           if (this.currentPhaseStep === prev) break;
         }
         return this.currentPhaseStep;
       }
       ```
     - When the player is in `UNTAP` and clicks `⏭️ Next Phase`, the `while` loop calls `this.advanceStep()` to enter `'UPKEEP'`.
     - Entering `'UPKEEP'` synchronously fires `RandomPerkEngine.onPhaseStepChanged`, which pushes `PERK_UPKEEP_TRIGGER` onto `this.stack` (`stack.length` becomes `1`) and gives priority to the opponent.
     - **Because the `while` loop in `nextPhase()` NEVER checks `if (this.stack.length > 0) break;`**, the very next iteration of the `while` loop immediately calls `this.advanceStep()` again (moving to `DRAW`, drawing a card, and resetting `priorityPlayerId = this.activePlayerId` at `line 822`) and then calls `this.advanceStep()` a third time into `PRECOMBAT_MAIN` (`MAIN 1`) while `PERK_UPKEEP_TRIGGER` is still sitting unresolved on the stack!
  2. **Bug 1B — `TabletopStateManager.handleStackResolution` Puts Perk Triggers Into the Player's Graveyard as Cards (`src/TabletopStateManager.js:2664-2967`)**:
     - When `PriorityStateMachine.resolveTop()` pops `PERK_UPKEEP_TRIGGER` or `PERK_EFFECT_TRIGGER`, it first calls [`this.tabletopState.handleStackResolution(resolvedItem)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PriorityStateMachine.js#L1155) before emitting `'STACK_RESOLVE'` (`line 1168`).
     - Inside [`TabletopStateManager.handleStackResolution`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L2664-L2967), there is **no guard** for `resolvedItem.type === 'PERK_UPKEEP_TRIGGER' || resolvedItem.type === 'PERK_EFFECT_TRIGGER' || resolvedItem.type === 'TRIGGERED_ABILITY' || resolvedItem.type === 'ABILITY'`.
     - Consequently, `handleStackResolution` treats every resolved Perk trigger as a non-permanent card and pushes a cloned object (`Random Perk Upkeep Trigger` and `Exploration`) into `player.graveyard` and `player.zones.graveyard` (`lines 2952-2966`)! (Visible in the user's screenshot as `Grave (5)`).
  3. **Bug 1C — `PriorityStateMachine.resolveTop()` Overwrites Priority Rotation If `STACK_RESOLVE` Listeners Mutate `priorityPlayerId`, and `PerkinsAgent` Doesn't Auto-Respond When Priority Rotates in `RandomPerkEngine`**:
     - In [`RandomPerkEngine.triggerStep1`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/RandomPerkEngine.js#L248-L258) and [`triggerStep2`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/RandomPerkEngine.js#L409-L418), `RandomPerkEngine` mutates `this.priorityStateMachine.priorityPlayerId = nextPlayerId` directly **without emitting `'PRIORITY_CHANGED'`** on `this.priorityStateMachine`!
     - Because [`PerkinsAgent`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PerkinsAgent.js#L211-L222) listens to `'PRIORITY_CHANGED'` on `this.app.priorityMachine` to know when it holds priority to pass on the stack, Perkins AI is never notified via `'PRIORITY_CHANGED'` when `triggerStep1` or `triggerStep2` hands priority to the bot (relying instead on the 15s stack alarm or `onStackResolve`).

---

### 1c) How Perk `#44` (*Exploration*) Is Implemented & Why `_handlePlayLand` / `canPlayLand` Rejects the Second Land Drop

Look at the exact property name mismatch between `src/PerkCatalog.js` and `src/TabletopStateManager.js` / `src/app.js`:

1. **What Perk `#44` Mutates (`src/PerkCatalog.js:260-266`)**:
   ```js
   execute: (state, { activePlayerId }) => {
     const drawRes = state.dispatch('DRAW_CARD', { playerId: activePlayerId, count: 1 });
     const player = state.getPlayer ? state.getPlayer(activePlayerId) : state.players?.[activePlayerId];
     if (player) {
       player.resources = player.resources || {};
       player.resources.additionalLandsAllowed = (player.resources.additionalLandsAllowed || 0) + 1;
     }
   ```
   Perk `#44` increments **`player.resources.additionalLandsAllowed`** (from `0` to `1`), and does **NOT** touch `player.maxLandsPerTurn`, `player.landsPerTurnLimit`, or `player.resources.maxLandsPerTurn`.

2. **What `canPlayLand`, `_handlePlayLand`, and `app.js` Check**:
   - **[`TabletopStateManager.canPlayLand`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L2141-L2147)**:
     ```js
     const played = player.landsPlayedThisTurn ?? player.resources?.landsPlayedThisTurn ?? 0;
     const limit = player.maxLandsPerTurn ?? player.landsPerTurnLimit ?? player.resources?.maxLandsPerTurn ?? 1;
     if (played >= limit) {
       const res = { allowed: false, reason: 'LAND_LIMIT_REACHED', message: `⚠️ You have already played a land this turn (${played}/${limit})` };
     ```
   - **[`TabletopStateManager._handlePlayLand`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L793-L797)**:
     ```js
     const played = player.landsPlayedThisTurn ?? player.resources?.landsPlayedThisTurn ?? 0;
     const limit = player.maxLandsPerTurn ?? player.landsPerTurnLimit ?? player.resources?.maxLandsPerTurn ?? 1;
     if (played >= limit) {
       throw new LandLimitExceededError(`Land drop limit reached for this turn (${played}/${limit}).`);
     }
     ```
   - **[`RPMAppController.dispatchAction` (`case 'PLAY_LAND'`)](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L2615-L2616)**:
     ```js
     const played = p.landsPlayedThisTurn ?? p.resources?.landsPlayedThisTurn ?? 0;
     const limit = p.maxLandsPerTurn ?? p.landsPerTurnLimit ?? p.resources?.maxLandsPerTurn ?? 1;
     ```
3. **Why It Fails**:
   - Because `player.maxLandsPerTurn` is initialized to `1` (`src/TabletopStateManager.js:645, 667`) and **none of those three checks add `(player.resources?.additionalLandsAllowed || 0)` to `limit`**, `limit` remains `1` (`1/1`) even after Perk `#44` resolves!
   - Additionally, neither [`handleUntapStep`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L3184-L3203) nor [`resetTurnQuotas`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L2551-L2560) resets `player.resources.additionalLandsAllowed = 0` when a new turn begins.

---

## 2. Target Selector (`Lightning Bolt` & Targeted Perks)

### 2a) Inspection of `src/view/TargetSelectorModal.js` & Hand Click Flow in `src/app.js`

1. **`TargetSelectorModal` Implementation (`src/view/TargetSelectorModal.js:18-259`)**:
   - `TargetSelectorModal` is a complete UI component that builds `#target-selector-modal` (`line 48`), evaluates Hexproof/Shroud/Protection legality via [`evaluateTargetLegality`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/view/TargetSelectorModal.js#L87-L133), gathers candidate players (`lines 190-205`) and battlefield creatures (`lines 207-227`) in [`gatherCandidates()`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/view/TargetSelectorModal.js#L186-L228), and invokes `this.onSelectTarget({ targetId, targetType, targetName })` (`lines 176-184`) when a legal target row is clicked.

2. **Why Casting `Lightning Bolt` From Hand Never Opens `TargetSelectorModal` (`src/app.js:4389-4400` & `1136-1186`)**:
   - In [`_reconcilePlayerDashboard`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L4389-L4400), clicking `#btn-cast-spell` (`⚡ Cast to Stack`) in the hand popover calls [`this.castSpellToStack(card)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L1136-L1186).
   - Look at `castSpellToStack(card)` (`src/app.js:1136-1186`):
     - Lines `1138-1149`: Validates timing via `canPlayerCastOrPlay`.
     - Lines `1152-1166`: Immediately taps lands via `this.tabletopState.autoTapForMana(this.myPlayerId, card.manaCost)`.
     - Lines `1167-1170`: Removes the card from `p.zones.hand` / `p.hand`.
     - Lines `1172-1184`: Immediately dispatches `CAST_SPELL` **with no `targetId` and no `targets`**, and **never checks if the spell requires a target or calls `this.targetModal.open(...)`**!
   - Consequently, when `Lightning Bolt` resolves in [`TabletopStateManager.handleStackResolution`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L2768-L2786), `rawTargets` is `[]`, so it falls back to `defaultTargetId = oppPid` (`lines 2779-2785`) and **always hits the opponent player's face**, never allowing the player to target an opponent's creature!
   - Furthermore:
     - `this.targetModal.open(...)` is **never called anywhere in `src/app.js`** (0 occurrences in the entire file).
     - [`handleTargetSelected(data)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L5727-L5739) checks `if (this._stagedCast)`, which is never assigned anywhere in `src/app.js`, and calls `this.tabletopState.dispatch('CAST_SPELL', ...)` instead of routing through `castSpellToStack` / `dispatchAction({ type: 'CAST_SPELL', payload: { ..., targetId: data.targetId, targets: [data.targetId] } })`.
     - In [`TargetSelectorModal.gatherCandidates()`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/view/TargetSelectorModal.js#L186-L228), `this.spell?.effect?.targetType` is not checked to filter candidates (e.g. `Lava Spike` has `targetType: 'player_or_planeswalker'` and must only list players/planeswalkers, whereas `Lightning Bolt` has `targetType: 'any'` and lists both players and creatures).

3. **Targeted Perks (`#55 Cataclysmic Ruin` & `#99 Torment`) (`src/RandomPerkEngine.js:361-370`)**:
   - In [`RandomPerkEngine.handleStep1Resolution`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/RandomPerkEngine.js#L361-L370):
     ```js
     let declaredTargets = [];
     if (perkDef?.requiresTargets) {
       const availableTargets = getLegalTargets(perkKey, this.stateManager, activePlayerId);
       if (availableTargets.length > 0) {
         declaredTargets = [availableTargets[0]];
       }
     }
     ```
   - Instead of allowing the active player to select a target (or prioritizing opponent permanents in `CANONICAL_PERKS['55'].getLegalTargets` at `src/PerkCatalog.js:291-309`), `availableTargets[0]` picks the very first permanent of the first player in `state.players` — which is the human player's own first land!

---

## 3. Switching Target Attacker During `DECLARE_BLOCKERS` (`src/app.js`)

Inspection of [`_reconcileOpponents`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L3842-L3945) and [`_reconcilePlayerDashboard`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L4134-L4311) reveals **three exact bugs** preventing the defending player from switching and assigning blockers across multiple attacking creatures:

1. **Bug 3A — Execution Order Inversion in `reconcileDOM()` (`src/app.js:3452` vs `3458`)**:
   - In [`RPMAppController.reconcileDOM()`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L3438-L3472):
     - Line `3452` calls `this._reconcileOpponents()` **BEFORE** line `3458` calls `this._reconcilePlayerDashboard()`.
   - However, `this._activeAttackerTargetId` is initialized/defaulted inside `_reconcilePlayerDashboard()` (`src/app.js:4149-4154`), **after** `_reconcileOpponents()` has already rendered the opponent's creatures!
   - As a result, when the block window first opens, `this._activeAttackerTargetId` is `null` during `_reconcileOpponents()`, so `isSelectedTarget` (`src/app.js:3861`) is `false` for all opponent attackers.

2. **Bug 3B — Clicking an Already-Assigned Blocker After Switching `this._activeAttackerTargetId` Only Unassigns It Instead of Re-Targeting (`src/app.js:4260-4290`)**:
   - Look at lines `4260-4268` of `src/app.js`:
     ```js
     dashboard.querySelectorAll('.blocker-candidate').forEach(chip => {
       chip.addEventListener('click', () => {
         const blockerId = chip.getAttribute('data-instance-id');
         if (!blockerId) return;
         if (this._blockerAssignments.has(blockerId)) {
           this._blockerAssignments.delete(blockerId);
           this.reconcileDOM();
           return;
         }
         const targetAttackerId = this._activeAttackerTargetId;
     ```
   - Because `this._activeAttackerTargetId` defaults to `attackerIds[0]` (`line 4153`), if the player clicks their blocker creature, it gets assigned to `attackerIds[0]`. If the player then clicks the opponent's 2nd attacker (changing `this._activeAttackerTargetId` to `attackerIds[1]`) and clicks their blocker creature to block `attackerIds[1]`, `this._blockerAssignments.has(blockerId)` is `true` (mapped to `attackerIds[0]`), so it **deletes** the blocker assignment instead of updating it to `this._activeAttackerTargetId` (`attackerIds[1]`)! (It should only unassign if `this._blockerAssignments.get(blockerId) === this._activeAttackerTargetId`; if `this._blockerAssignments.get(blockerId) !== this._activeAttackerTargetId`, it should re-assign `blockerId` to the newly selected `this._activeAttackerTargetId`!).

3. **Bug 3C — Clicking an Opponent Attacker Does Not Automatically Assign or Prompt When Only 1 Blocker Exists, and Opponent Creature Cards Have No `.blocker-target-candidate` Cursor/Badge Indicator (`src/app.js:3857-3876`, `3927-3945`)**:
   - In `_reconcileOpponents()` (`src/app.js:3868-3875`), attacking creatures do not display a visual badge indicating which one is currently targeted for blocking (only a subtle inline `box-shadow: 0 0 0 2px #f59e0b` if `isSelectedTarget` is true), nor can the player click an attacker in the `.block-confirm-bar` (`src/app.js:4225`) to switch between multiple attackers directly from their own dashboard.

---

## 4. End of Match When Eliminating the Last Opponent (`ELIMINATED` at `Life: -2`)

### Exact Root Cause: `StateBasedActionsEngine.runSBACheck` Mutates `player.isEliminated = true` Directly Without Calling `tabletopState.eliminatePlayer(pid)` or `app.handlePlayerElimination(pid)`!

Let's trace step by step what happens when `P2_PERKINS` drops to `Life: -2` (via combat damage or spell damage):

1. **Life Drops to `<= 0` (`src/CombatDamageEngine.js:76-82` or `src/TabletopStateManager.js:1229-1242`)**:
   - In combat: [`CombatDamageEngine.dealDamage`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/CombatDamageEngine.js#L76-L82) subtracts `dmg` from `target.resources.life` (`line 81`), leaving `P2_PERKINS` at `life = -2`.
   - In spell resolution (e.g. `Lightning Bolt` / `Lava Spike`): [`TabletopStateManager.handleStackResolution`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L2813) calls `this.adjustLife(targetPid, { delta: -amount })`, which in [`_handleAdjustLife`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1229-L1242) sets `player.resources.life += Number(delta)` (`line 1238`) without checking `<= 0`.

2. **SBA 704.5a Sets `player.isEliminated = true` Silently (`src/StateBasedActionsEngine.js:46-56`)**:
   - Immediately after combat damage (`src/TabletopStateManager.js:1794`) or spell resolution (`src/TabletopStateManager.js:2990`), `this.runSBACheck()` invokes [`StateBasedActionsEngine.runSBACheck`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/StateBasedActionsEngine.js#L46-L56):
     ```js
     // 1. CR 704.5a: Player with 0 or less life loses
     for (const [pid, player] of Object.entries(tabletopState.players || {})) {
       if (!player.isEliminated && (player.resources?.life ?? 20) <= 0) {
         player.isEliminated = true;
         passActions.push({
           type: 'PLAYER_ELIMINATED',
           rule: 'CR 704.5a',
           playerId: pid,
           reason: 'LIFE_ZERO_OR_LESS'
         });
       }
     }
     ```
   - **Look at what is missing right here (`src/StateBasedActionsEngine.js:48-55`)**:
     - It sets `player.isEliminated = true`, which causes [`RPMAppController._reconcileOpponents`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L3765-L3784) to render the gray-out `.player-eliminated-overlay` (`💀 ELIMINATED`) on `P2_PERKINS`.
     - **However, `StateBasedActionsEngine.runSBACheck` NEVER calls [`tabletopState.eliminatePlayer(pid, 'LIFE_ZERO_OR_LESS')`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L373-L451)!**
     - Because `tabletopState.eliminatePlayer` is never called:
       1. `tabletopState.isGameOver = true` (`line 433`) is **never set**.
       2. `tabletopState.winnerId` (`line 432`) is **never set**.
       3. `tabletopState.emit('GAME_OVER', gameOverPayload)` (`line 438`) is **never emitted**!
       4. `this.priorityMachine.eliminatePlayer(playerId)` (`line 425`) is **never called**.
       5. `RPMAppController`'s `onGameOver` listener (`src/app.js:1942-1950`) and `handlePlayerElimination` (`src/app.js:2933-2981`) are **never triggered**!

3. **Why the Match Keeps Advancing Turns (`Round 6 / Turn 7`) Indefinitely**:
   - Because `tabletopState.isGameOver` is still `false` and `this.isMatchActiveFlag` is still `true`:
     - When the human player clicks `⏭️ Next Phase` or `Pass Priority`, [`PriorityStateMachine.nextPlayer`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PriorityStateMachine.js#L542-L559) checks `this.isPlayerEliminated(candidateId)` (`line 553`), skips `p2_perkins` (because `p2_perkins.isEliminated === true`), and wraps right back around to `p1`!
     - Thus, at the end of `p1`'s turn, `advanceStep()` (`src/PriorityStateMachine.js:780-819`) increments `this.turnNumber++` and `this.roundNumber` and starts a new turn for `p1` (`Round 6 / Turn 7`) over and over against a dead opponent!
   - Furthermore, even when `onGameOver` (`src/app.js:1942-1950`) DOES fire:
     - It does **not** stop `this.perkinsAgent` (`this.perkinsAgent.destroy()`),
     - And `#btn-next-phase` (`src/app.js:3593-3601`) and `#btn-pass-priority` (`src/app.js:3983-3992`) only check `this.isSpectator()` instead of also disabling controls when `this.tabletopState?.isGameOver || !this.isMatchActive()`.
