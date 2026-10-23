# Forensic Architecture Audit: Combat Pipeline, Triggers/Parser, Dual Lands & Logging (`COMBAT_AND_TRIGGERS_AUDIT.md`)

**Audit Mode:** 100% Read-Only Forensic Code Inspection (Zero Source Modifications, Zero Conjecture)  
**Target Repository:** `/home/svayneak/Documents/Svayneak/rpm multiplayer`

---

## 1. Exact Traceability of Combat Flow & Visual Badges (`⚔️` / `🛡️`)

### 1a) Declaring an Attacker: Step-by-Step Pipeline & Exact Mutations

#### Step 1: UI Selection & Local Dispatch (`src/app.js`)
1. **Combat Window Detection (`src/app.js:3920-3936`)**:
   - Inside [`RPMAppController._reconcilePlayerDashboard`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L3879-L4336), `isAttackWindow` is evaluated at lines `3924-3925`:
     ```js
     const isAttackWindow = psmForAttack &&
       (psmForAttack.currentPhaseStep === 'DECLARE_ATTACKERS') &&
       psmForAttack.activePlayerId === this.myPlayerId;
     ```
   - When `isAttackWindow === true`, each creature in the active player's battlefield is tested with [`canDeclareAsAttacker(creature, this.tabletopState, this.myPlayerId)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/CombatDamageEngine.js#L377-L425) (`src/app.js:3933`). Eligible creatures receive CSS class `.attack-candidate` (`src/app.js:4015`), and creatures already in `this._selectedAttackers` (a `Set` initialized at `src/app.js:121`) receive `.selected-attacker` (`src/app.js:4018`).
2. **Clicking a Candidate & Confirming (`src/app.js:4026-4051`)**:
   - Clicking a `.creature-card.attack-candidate` toggles its `instanceId` inside `this._selectedAttackers` (`src/app.js:4028-4035`).
   - Clicking `#btn-confirm-attackers` (`⚔️ Confirm Attackers (N)`) executes lines `4039-4050`:
     ```js
     const ids = Array.from(this._selectedAttackers);
     this._selectedAttackers.clear();
     this.dispatchAction({
       type: 'DECLARE_ATTACKERS',
       playerId: this.myPlayerId,
       attackers: ids,
       payload: { playerId: this.myPlayerId, attackers: ids }
     }, { origin: 'LOCAL' });
     ```
   - *(For Perkins AI Bot)*: In [`PerkinsAgent.evaluateTurnPhase`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PerkinsAgent.js#L866-L891), when `phaseStep === 'COMBAT' || phaseStep === 'DECLARE_ATTACKERS'`, [`evaluateCombatAttacks(state)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PerkinsAgent.js#L956-L1009) returns an array of `instanceId` strings and dispatches `DECLARE_ATTACKERS` (`src/PerkinsAgent.js:874-882`).

#### Step 2: Controller Routing (`src/app.js:2620-2625`, `2692-2722`)
- [`RPMAppController.dispatchAction`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L2478-L2643) handles `case 'DECLARE_ATTACKERS'` at lines `2620-2625`, calling [`this._handleDeclareAttackers(action)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L2692-L2722) and logging to `Turn Cmd` via `this.appendExecutionLog('Combat', ...)`.
- `_handleDeclareAttackers` normalizes `attackerIds` into an array of IDs (`src/app.js:2695-2703`) and calls `this.tabletopState.declareAttackers(targetId, attackerIds)` (`src/app.js:2707`), followed by a UI fallback loop (`src/app.js:2711-2719`) that sets `c.isAttacking = true` and `c.isTapped = true` (unless `c.keywords?.vigilance` or `c.keywords?.Vigilance`) on `p.zones.battlefield` and `p.battlefield.creatures`.

#### Step 3: State & Card Property Mutations (`src/TabletopStateManager.js:1264-1368`)
Inside [`TabletopStateManager.declareAttackers(playerId, attackersList = [])`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1264-L1368):
1. **Empty Attackers Fast-Forward (`1276-1282`)**:
   - If `attackersList.length === 0`, sets `this.combatState = { attackers: [], blockers: [] }`, records trace `'DECLARE_ATTACKERS_EMPTY'`, calls `this.priorityMachine.advanceStep()` (which jumps directly to `'END_COMBAT'` per [`PriorityStateMachine.advanceStep`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PriorityStateMachine.js#L770-L778)), and returns `[]`.
2. **Non-Empty Attackers Validation (`1285-1331`)**:
   - Computes `defaultDefenderId` as the first active player ID `!== playerId` (`1285-1286`).
   - Searches **only** `player.battlefield.creatures` for each attacker `instanceId` (`1300-1309`).
   - Rejects if `card.isTapped` (`1311-1313`), if `!CombatDamageEngine.canDeclareAsAttacker(card, this, playerId)` (`1317-1326`), or if `this._hasKeyword(card, 'defender')` (`1328-1331`).
3. **Exact Card Property Mutations (`1333-1343`)**:
   - `card.isTapped = false` (if `this._hasKeyword(card, 'vigilance')`) or `card.isTapped = true` (`1334-1338`).
   - `card.isAttacking = true` (`1340`).
   - `card.defendingPlayerId = defendingPlayerId` (`1341`).
   - `card.controllerId = card.controllerId || playerId` (`1342`).
4. **Exact Game State & Priority Mutations (`1346-1366`)**:
   - `this.combatState = { attackers: declaredAttackers, blockers: [] }` (`1346-1349`), where `declaredAttackers` holds references to the mutated `card` objects.
   - Resets priority to the active (attacking) player without advancing the phase step (`1351-1354`):
     ```js
     if (this.priorityMachine) {
       this.priorityMachine.priorityPlayerId = playerId;
       this.priorityMachine.consecutivePassCount = 0;
     }
     ```
   - Calls `this.recordTrace('COMBAT_TRACE', 'DECLARE_ATTACKERS', ...)` (`1356-1361`), emits `'ATTACKERS_DECLARED'` (`1363`), and runs `this._fireAttackTriggers(attacker, playerId)` (`1364-1366`).

---

### 1b) Declaring a Blocker: Step-by-Step Pipeline & Exact Linkage Model

#### Step 1: UI Selection & Local Assignment Map (`src/app.js`)
1. **Block Window Detection (`src/app.js:3939-3970`)**:
   - In [`_reconcilePlayerDashboard`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L3939-L3970), `isBlockWindow` is true when all of the following hold (`3942-3947`):
     - `psmForAttack.activePlayerId !== this.myPlayerId`
     - `activeCombatAttackers.length > 0`
     - `!this.tabletopState?.combatState?.blockersDeclared`
     - `psmForAttack.currentPhaseStep === 'DECLARE_BLOCKERS'` **OR** `(psmForAttack.currentPhaseStep === 'DECLARE_ATTACKERS' && psmForAttack.priorityPlayerId === this.myPlayerId)`
   - Notice that the UI opens the blocker declaration window **early** during `'DECLARE_ATTACKERS'` as soon as the attacking player passes priority to the human defender!
2. **Selecting Attacker Target & Blocker Candidate (`src/app.js:3649-3663`, `3730-3749`, `3956-3965`, `4054-4085`)**:
   - `this._activeAttackerTargetId` defaults to `attackerIds[0]` (`src/app.js:3956-3958`) or is switched by clicking an `.opponent-creature-card` with `isAttacking` (`src/app.js:3738-3741`).
   - Clicking an untapped creature `.blocker-candidate` (`src/app.js:4054-4085`) validates the block via [`canBlockAssignment(attackerObj, [blockerObj], this.tabletopState)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/CombatDamageEngine.js#L351-L368) (`src/app.js:4068`) and stores the pair in `this._blockerAssignments` (a UI-local `Map<blockerId, attackerId>` initialized at `src/app.js:122`):
     ```js
     this._blockerAssignments.set(id, targetAttackerId); // src/app.js:4081
     ```
3. **Confirming Blockers (`src/app.js:4087-4160`)**:
   - Clicking `#btn-confirm-blockers` (`🛡️ Confirm Blockers (N)`) converts `this._blockerAssignments` into `assignments = [{ blockerId, attackerId }, ...]` (`src/app.js:4152-4154`) and calls `commitHumanBlocks(assignments)` (`src/app.js:4087-4149`).
   - *(For Perkins AI Bot)*: In [`PerkinsAgent.evaluateTurnPhase`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PerkinsAgent.js#L893-L922), [`evaluateCombatBlocks(state, rawAttackers)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PerkinsAgent.js#L1018-L1101) builds `blocks = [{ blockerId, attackerId }]` and dispatches `DECLARE_BLOCKERS` (`src/PerkinsAgent.js:902-911`).

#### Step 2: How Blocker and Attacker Are Linked in State (`src/TabletopStateManager.js:1412-1510`)
Inside [`TabletopStateManager.declareBlockers(playerId, assignments = [])`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1412-L1510):
1. **Validation (`1430-1484`)**:
   - Validates Menace (`1433-1445`: requires `assignedBlockers.length >= 2` if attacker has `'menace'`).
   - Finds `blocker` in `player.battlefield.creatures` (`1451-1460`), verifies `!blocker.isTapped` (`1462-1464`), finds `attacker` in `this.combatState.attackers` (`1466-1469`), verifies `attacker.defendingPlayerId === playerId` (`1471-1473`), and runs [`CombatDamageEngine.canCreatureBlock(blocker, attacker, this)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/CombatDamageEngine.js#L312-L341) (`1475-1484`).
2. **Exact Linkage Mechanism (`1486-1496`)**:
   - **On the Blocker card object (`1486-1487`)**:
     ```js
     blocker.isBlocking = true;
     blocker.blockingTargetId = attacker.instanceId || attacker.id;
     ```
   - **On the external `this.combatState` object (`1488-1496`)**:
     ```js
     declaredBlockers.push({
       blocker,
       blockerId: blocker.instanceId || blocker.id,
       attackerId: attacker.instanceId || attacker.id
     });
     // ...
     this.combatState.blockers = declaredBlockers;
     this.combatState.blockersDeclared = true;
     ```
   - **On the Attacker card object**: **Nothing is mutated on `attacker`**. There is **no** `attacker.blockedBy` property in the codebase. Later, during `COMBAT_DAMAGE`, [`TabletopStateManager.resolveCombatDamage`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1562-L1580) reconstructs `blockersMap[attackerId]` by iterating `this.combatState.blockers` and grouping `entry.blocker` by `entry.attackerId`.

---

### 1c) Advancing `DECLARE_BLOCKERS` → `COMBAT_DAMAGE` → `MAIN_2`: Why Two 2/2 `Goblin Guide`s Do Not Die & Why `⚔️` / `🛡️` Persist into the Next Turn

Forensic inspection reveals **four distinct, compounding bugs** in the current codebase that explain every symptom observed when two 2/2 `Goblin Guide` creatures engage in combat:

#### Root Cause #1 (The "Zombie Battlefield Array" Bug): SBA Destroys the Creature in `player.battlefield.creatures`, Leaving the Original Mutated Object Alive in `player.zones.battlefield`, Which the UI Immediately Falls Back To!
This is the primary reason two 2/2 creatures that deal lethal combat damage to each other remain visibly on the battlefield in `MAIN_2` and into the next turn with `⚔️` and `🛡️` permanently stuck on them:

1. **Dual Insertion on Resolution (`src/TabletopStateManager.js:2759` & `2795-2796`)**:
   - When a creature spell resolves in [`TabletopStateManager.handleStackResolution`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L2749-L2803), the **exact same `card` object reference** is pushed into **two separate arrays** on the player state:
     - `player.battlefield.creatures.push(card)` (`src/TabletopStateManager.js:2759`)
     - `player.zones.battlefield.push(card)` (`src/TabletopStateManager.js:2796`)
2. **Combat Damage & SBA Execution (`src/TabletopStateManager.js:1545-1666` & `src/StateBasedActionsEngine.js:132-149`)**:
   - When `currentPhaseStep` enters `'COMBAT_DAMAGE'`, [`TabletopStateManager.handlePhaseStepChanged`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L3089-L3090) calls [`this.resolveCombatDamage()`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1545-L1666).
   - [`CombatDamageEngine.resolveCombatStep`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/CombatDamageEngine.js#L252-L302) deals 2 damage from the attacking 2/2 `Goblin Guide` to the blocking 2/2 `Goblin Guide` and 2 damage back (`target.damageMarked = 2` at `src/CombatDamageEngine.js:90`).
   - `resolveCombatDamage()` then calls `this.runSBACheck()` (`src/TabletopStateManager.js:1662`), which executes [`StateBasedActionsEngine.runSBACheck(stateManager)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/StateBasedActionsEngine.js#L24-L195).
   - At lines `132-149` of `src/StateBasedActionsEngine.js`, Rule 704.5g sees `markedDamage (2) >= toughness (2)` and calls:
     ```js
     ZoneTransitionMatrix.moveCard(player, card.instanceId, 'battlefield', 'graveyard');
     ```
3. **Partial Removal (`src/ZoneTransitionMatrix.js:140` → `src/ZoneModel.js:348-388`)**:
   - [`ZoneTransitionMatrix.moveCard`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/ZoneTransitionMatrix.js#L51-L148) calls [`ZoneModel.removeCardFromZone(playerState, instanceId, effectiveStack)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/ZoneModel.js#L397-L406), which locates the card via [`ZoneModel._findCardInPlayer`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/ZoneModel.js#L348-L388).
   - `_findCardInPlayer` searches **only** `playerState.battlefield[sub]` (`src/ZoneModel.js:368-385`) and splices the dead creature out of `player.battlefield.creatures`.
   - **`ZoneModel` and `ZoneTransitionMatrix` NEVER remove the card from `player.zones.battlefield`!**
   - Furthermore, `ZoneTransitionMatrix.moveCard` (`src/ZoneTransitionMatrix.js:95-109`) creates a **new cloned object** (`createZoneChangedObject`) for `player.graveyard`, leaving the **original `card` reference** inside `player.zones.battlefield` with `isAttacking: true`, `isBlocking: true`, `blockingTargetId: '...'`, `isTapped: true`, and `damageMarked: 2`!
4. **UI Reconciliation Fallback Selects the Uncleaned `player.zones.battlefield` (`src/app.js:3608-3612` & `3910-3918`)**:
   - Look at how [`_reconcileOpponents`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L3608-L3612) and [`_reconcilePlayerDashboard`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L3910-L3918) choose which array of creatures to render:
     ```js
     // src/app.js:3608-3612 (Opponent)
     const bCreatures = Array.isArray(oppData?.battlefield?.creatures) ? oppData.battlefield.creatures : [];
     const zCreatures = Array.isArray(oppData?.zones?.battlefield)
       ? oppData.zones.battlefield.filter(c => (c.type_line || c.typeLine || c.type || '').toLowerCase().includes('creature') || c.subzone === 'creatures')
       : [];
     const oppCreatures = bCreatures.length >= zCreatures.length ? bCreatures : zCreatures;
     ```
     ```js
     // src/app.js:3916-3918 (Human Player)
     const bCreatures = Array.isArray(pData?.battlefield?.creatures) ? pData.battlefield.creatures : [];
     const zCreatures = battlefieldCards.filter(c => (c.typeLine || c.type || '').toLowerCase().includes('creature') || c.subzone === 'creatures');
     const creatures = bCreatures.length >= zCreatures.length ? bCreatures : zCreatures;
     ```
   - After SBA destroys the creature in `player.battlefield.creatures`, `bCreatures.length` becomes `0`, while `zCreatures.length` (`player.zones.battlefield`) is still `1`!
   - The ternary `bCreatures.length >= zCreatures.length ? bCreatures : zCreatures` evaluates `0 >= 1` (`false`) and **falls back to rendering `zCreatures` (`player.zones.battlefield`)**!
5. **Why `⚔️` and `🛡️` Persist Forever on Those Creatures (`src/TabletopStateManager.js:1673-1696`)**:
   - When the game enters `'END_COMBAT'` or `'POSTCOMBAT_MAIN'`, [`TabletopStateManager.endCombat()`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1673-L1696) runs:
     ```js
     for (const player of Object.values(this.players)) {
       if (!player || !player.battlefield) continue;
       for (const subzone of Object.values(player.battlefield)) {
         if (!Array.isArray(subzone)) continue;
         for (const card of subzone) {
           card.isAttacking = false;
           card.defendingPlayerId = null;
           card.isBlocking = false;
           card.blockingTargetId = null;
         }
       }
     }
     ```
   - Because `endCombat()` iterates **only** over `player.battlefield` (from which the dead creature was already spliced out during SBA!) and **never** iterates over `player.zones.battlefield`, the zombie creature sitting in `player.zones.battlefield` retains `card.isAttacking = true` (`⚔️` badge rendered at `src/app.js:3689-3694` and `3987-3991`) and `card.isBlocking = true` (`🛡️` badge rendered at `src/app.js:3696-3701` and `3993-3997`) permanently across all subsequent turns!
   - Likewise, in the next turn's `UNTAP` step, [`TabletopStateManager._handleUntapAll`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1095-L1113) iterates only over `player.battlefield[sub]`, so the zombie creature in `player.zones.battlefield` isn't even untapped or recognized by `TabletopStateManager`.

#### Root Cause #2: Perkins AI Refuses to Block a 2/2 `Goblin Guide` with a 2/2 `Goblin Guide` (`src/PerkinsAgent.js:1077-1099`)
When the Human attacks Perkins AI with a 2/2 `Goblin Guide` while Perkins AI controls an untapped 2/2 `Goblin Guide` (and Perkins is at `> 2` life):
- In [`PerkinsAgent.evaluateCombatBlocks(state, rawAttackers)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PerkinsAgent.js#L1018-L1101), because `totalDamage` (`2`) `< currentLife` (`20`) (`src/PerkinsAgent.js:1050`), Perkins enters **Case 2: Non-lethal -> Profitable trade only** (`src/PerkinsAgent.js:1077-1099`):
  ```js
  // Find a blocker that can kill the attacker AND survive (bPower >= aToughness && bToughness > aPower)
  const profitableBlockerIndex = availableBlockers.findIndex(b => {
    const bPower = Number(b.power ?? 0);
    const bToughness = Number(b.toughness ?? 1);
    return bPower >= aToughness && bToughness > aPower;
  });
  ```
- For a 2/2 `Goblin Guide` vs a 2/2 `Goblin Guide`, `bPower >= aToughness` is `2 >= 2` (`true`), but `bToughness > aPower` is `2 > 2` (`false`).
- Perkins AI therefore returns `[]` (zero blocks) and never blocks a 2/2 with a 2/2 unless the attack is lethal to Perkins's life total.

#### Root Cause #3: Clicking `⏭️ Next Phase` Instead of `⚔️ Confirm Attackers` or `🛡️ Confirm Blockers` Skips Combat Steps or Throws `PriorityViolationError`
1. **Clicking `⏭️ Next Phase` during `DECLARE_ATTACKERS` without clicking `⚔️ Confirm Attackers`**:
   - Selecting creatures in the UI only populates `this._selectedAttackers` (`src/app.js:4032`).
   - If the user clicks `#btn-next-phase` (`src/app.js:3379-3396`) directly, it calls `this.priorityMachine.nextPhase(this.myPlayerId)` (`src/app.js:3389`), which calls `this.advanceStep()` (`src/PriorityStateMachine.js:933`).
   - Inside [`PriorityStateMachine.advanceStep()`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PriorityStateMachine.js#L770-L778), because `this._tabletopState.combatState.attackers` is still empty (`[]`), it skips `DECLARE_BLOCKERS` and `COMBAT_DAMAGE` completely and jumps straight to `'END_COMBAT'`!
2. **Clicking `⏭️ Next Phase` during `DECLARE_BLOCKERS` as Defending Player**:
   - When `DECLARE_BLOCKERS` starts, `PriorityStateMachine.advanceStep()` sets `this.priorityPlayerId = this.activePlayerId` (the attacking player, `src/PriorityStateMachine.js:788`).
   - Even after `tabletopState.declareBlockers()` runs (`src/TabletopStateManager.js:1498-1501`), it sets `this.priorityMachine.priorityPlayerId = this.activePlayerId` (the attacker!).
   - If the defending human clicks `#btn-next-phase` (`src/app.js:3386-3393`) while `priorityPlayerId !== this.myPlayerId`, it falls into the `else if` branch (`src/app.js:3388-3389`) and calls `this.priorityMachine.nextPhase(this.myPlayerId)`, which throws `PriorityViolationError: Only active player '...' may advance phase` (`src/PriorityStateMachine.js:917`), caught and swallowed by `console.warn` (`src/app.js:3392`).

#### Root Cause #4: If `SEVEN_PHASE_STEPS` (`use7Steps: true`) Is Used or `MAIN_2` Is Reached Without Hitting `END_COMBAT` (`src/TabletopStateManager.js:3076-3095`)
- Look at [`TabletopStateManager.handlePhaseStepChanged`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L3076-L3095):
  ```js
  if (currentPhaseStep === 'UNTAP') {
    this.handleUntapStep(activePlayerId);
  } else if (currentPhaseStep === 'DRAW') {
    this.handleDrawStep(activePlayerId);
  } else if (currentPhaseStep === 'DECLARE_ATTACKERS') {
    this.combatState = { attackers: [], blockers: [] };
  } else if (currentPhaseStep === 'COMBAT_DAMAGE') {
    this.resolveCombatDamage();
  } else if (currentPhaseStep === 'END_COMBAT') {
    this.endCombat();
  } else if (currentPhaseStep === 'CLEANUP') {
    this.handleCleanupStep();
  }
  ```
- Notice two things:
  1. When `currentPhaseStep === 'DECLARE_ATTACKERS'` (`3086-3087`), it resets `this.combatState = { attackers: [], blockers: [] }` but **does NOT clear `card.isAttacking` or `card.isBlocking`** on battlefield creatures.
  2. `this.endCombat()` is ONLY called when `currentPhaseStep === 'END_COMBAT'`. It is **NOT** called as a defensive guard on `'POSTCOMBAT_MAIN'`, `'END'`, `'CLEANUP'`, or `'UNTAP'`. If `PriorityStateMachine` is ever configured with `use7Steps: true` (`SEVEN_PHASE_STEPS` at `src/PriorityStateMachine.js:25-33`, which has `'COMBAT'` → `'POSTCOMBAT_MAIN'` and lacks `'COMBAT_DAMAGE'` and `'END_COMBAT'`), neither `resolveCombatDamage()` nor `endCombat()` ever executes!

---

## 2. State of Deck Parser & Effect Hydration (`DeckParser.js`, `TabletopStateManager.js`, `AbilityEngine.js`)

### 2a) Exact Lifecycle Timing of Deck Parsing & Card Creation

1. **`DeckParser.parseDecklist(rawText)` (`src/DeckParser.js:75-236`)**:
   - **What it does**: Parses plain-text MTGO/MTGA decklists into `{ mainboard: [{ count, name, set, collectorNumber, section }], sideboard: [...], commander: [...], errors: [...] }`.
   - **When it is called**: **ONLY** inside [`DeckValidator.validateDeck(rawText, format)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/DeckValidator.js#L220), which is invoked by the Deckbuilder UI when clicking Validate/Save (`src/app.js:4806, 4839`).
   - **Crucial Finding**: `DeckParser.parseDecklist` is **NEVER called when starting a match** (`startMatch` or `startPerkinsMatch`)!

2. **Match Initialization (`startMatch` & `startPerkinsMatch` in `src/app.js`)**:
   - **Perkins AI Bot Library Creation (`src/app.js:546-569` and `2359-2382`)**:
     - Iterates over `BEGINNER_DECKS.R.mainboard` (`src/DeckbuilderAI.js`) and builds raw card objects (`src/app.js:554-565` and `2366-2377`) with `{ instanceId, ownerId, controllerId, name: c.name, typeLine: c.type || 'Creature', manaCost: c.manaCost || '{R}', cmc: c.cmc ?? 1, power: c.power ?? 2, toughness: c.toughness ?? 2, isTapped: false, isSummoningSick: false }`.
     - **Does NOT call `TabletopStateManager.hydrateCardMechanics(card)` or `getHydratedCardMetadata(c.name)`** on the bot's library in `startPerkinsMatch`! (So the bot's `Lightning Bolt` and `Lava Spike` in its library do not even have `card.effect` until they are cast in `_handleCastSpell`!).
   - **Human Player (and Fallback) Hand & Library Creation (`dealStartingHands` in `src/app.js:986-1045`)**:
     - Called at the end of `startMatch()` (`src/app.js:595`).
     - **Completely ignores any deck chosen in the Lobby/Deckbuilder!** Instead, it hardcodes:
       - A 7-card opening hand (`starterCardNames` at `src/app.js:987-989`): `['Steam Vents', 'Mountain', 'Swamp', 'Lightning Bolt', 'Goblin Guide', 'Monastery Swiftspear', 'Lava Spike']`.
       - A 53-card library generated by cycling a 12-card array `pool` (`src/app.js:1034-1038`).
     - For each card in `dealStartingHands`, it calls [`getHydratedCardMetadata(name)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/DeckbuilderAI.js#L71-L150) (`src/app.js:997`) and [`TabletopStateManager.hydrateCardMechanics(cardObj)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L175-L204) (`src/app.js:1024-1026`).

3. **Runtime Re-Hydration (`src/TabletopStateManager.js`)**:
   - `TabletopStateManager.hydrateCardMechanics(card)` is also called dynamically when:
     - Playing a land: `_handlePlayLand` (`src/TabletopStateManager.js:783`)
     - Casting a spell: `_handleCastSpell` (`src/TabletopStateManager.js:874`)
     - Resolving the top of the stack: `handleStackResolution` (`src/TabletopStateManager.js:2553` for spells, `2750` for permanents)
     - Adding a card to a zone: `addCardToZone` (`src/TabletopStateManager.js:2908`)

---

### 2b) Exact Contents of `TabletopStateManager.hydrateCardMechanics` Today

Located at [`src/TabletopStateManager.js:175-204`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L175-L204), `hydrateCardMechanics(card)` contains **only a hardcoded 5-card `if / else if` block** matching lowercase `card.name`:

```js
static hydrateCardMechanics(card) {
  if (!card || typeof card !== 'object') return card;
  const name = (card.name || '').trim().toLowerCase();
  if (name === 'lava spike') {
    card.effect = { type: 'DEAL_DAMAGE', amount: 3, targetType: 'player_or_planeswalker' };
    if (!card.typeLine) card.typeLine = 'Sorcery — Arcane';
    if (!card.manaCost) card.manaCost = '{R}';
  } else if (name === 'lightning bolt') {
    card.effect = { type: 'DEAL_DAMAGE', amount: 3, targetType: 'any' };
    if (!card.typeLine) card.typeLine = 'Instant';
    if (!card.manaCost) card.manaCost = '{R}';
  } else if (name === 'goblin guide') {
    if (!card.typeLine) card.typeLine = 'Creature — Goblin Scout';
    card.keywords = { ...(card.keywords || {}), haste: true, Haste: true };
    card.hasSummoningSickness = false;
    card.isSummoningSick = false;
    if (card.power === undefined) card.power = 2;
    if (card.toughness === undefined) card.toughness = 2;
  } else if (name === 'monastery swiftspear') {
    if (!card.typeLine) card.typeLine = 'Creature — Human Monk';
    card.keywords = { ...(card.keywords || {}), haste: true, Haste: true, prowess: true, Prowess: true };
    card.hasSummoningSickness = false;
    card.isSummoningSick = false;
    if (card.power === undefined) card.power = 1;
    if (card.toughness === undefined) card.toughness = 2;
  } else if (name === 'steam vents') {
    card.isShockland = true;
  }
  return card;
}
```
Its companion helper [`getHydratedCardMetadata(cardName)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/DeckbuilderAI.js#L71-L150) in `src/DeckbuilderAI.js` only defines static metadata (`typeLine`, `manaCost`, `cmc`, `power`, `toughness`, `keywords`, `oracleText`, `effect`) for 8 hardcoded cards (`Lava Spike`, `Lightning Bolt`, `Goblin Guide`, `Monastery Swiftspear`, `Steam Vents`, `Mountain`, `Swamp`, `Island`) plus generic name heuristics (`124-149`).

---

### 2c) Status of Trigger Listeners (`CAST_SPELL` for *Prowess* & `DECLARE_ATTACKERS` for `Goblin Guide`)

#### 1. `Monastery Swiftspear` (*Prowess* on `CAST_SPELL`): **NOT CONNECTED IN PRODUCTION**
- **Current State**:
  - `Monastery Swiftspear` receives `card.keywords = { haste: true, Haste: true, prowess: true, Prowess: true }` in `hydrateCardMechanics` (`src/TabletopStateManager.js:195`), and its base P/T is `1/2`.
  - However, **nothing in the codebase ever reads `keywords.prowess` or `keywords.Prowess`!**
  - When a spell is cast:
    - [`RPMAppController.dispatchAction('CAST_SPELL')`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L2510-L2581) pushes the spell onto `this.priorityMachine._stack` (`2566-2572`) without notifying `TabletopStateManager._handleCastSpell` or `AbilityEngine`.
    - Even [`TabletopStateManager._handleCastSpell`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L834-L1016) and [`PriorityStateMachine.dispatch('CAST_SPELL')`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PriorityStateMachine.js#L1191-L1246) contain **zero checks** for creatures with `prowess` on the caster's battlefield.
- **Exact Missing Wiring Required for *Prowess***:
  1. **Trigger Detection on Noncreature `CAST_SPELL`**:
     - In [`TabletopStateManager._handleCastSpell`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L999) (and in [`RPMAppController.dispatchAction` `case 'CAST_SPELL'`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L2565) which currently bypasses `_handleCastSpell`), check if the cast spell is a noncreature spell (`!/creature/i.test(typeLine)`).
     - Scan `player.battlefield.creatures` for any permanent where `this._hasKeyword(c, 'prowess')` is `true`.
  2. **Queueing & Flushing via `AbilityEngine`**:
     - Call [`this.abilityEngine.queueTrigger`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/AbilityEngine.js#L160-L185) with `sourceId: creature.instanceId`, `controllerId: playerId`, `triggerCondition: 'PROWESS_CAST_NONCREATURE'`, and `effectFn` that registers a Layer 7c (`CONTINUOUS_LAYERS.LAYER_7C_MODIFY_PT`) static effect (`powerDelta: +1, toughnessDelta: +1, duration: 'END_OF_TURN'`) via [`this.abilityEngine.registerStaticEffect`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/AbilityEngine.js#L231-L265) (or mutates `creature.tempPowerMod` / evaluates [`this.abilityEngine.evaluateCreatureStats(creature, this)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/AbilityEngine.js#L275-L343)).
     - Call [`this.abilityEngine.flushTriggersAPNAP(activePlayerId, playerOrder)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/AbilityEngine.js#L194-L220) to push the trigger onto `this.priorityMachine._stack`.
  3. **UI & Combat Consumption of Layer 7c Stats + Cleanup Purge**:
     - Currently, `CombatDamageEngine.resolveCombatStep` (`src/CombatDamageEngine.js:264, 286`) reads raw `attacker.power` / `blocker.power` instead of calling `state.abilityEngine.evaluateCreatureStats(creature, state).power`.
     - Currently, [`TabletopStateManager.handleCleanupStep`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L3046-L3050) only clears marked damage (`StateBasedActionsEngine.purgeCleanupMarkedDamage(this)`) and **never clears `END_OF_TURN` effects** from `this.abilityEngine.staticEffects`.

#### 2. `Goblin Guide` (Attack Trigger on `DECLARE_ATTACKERS`): **PARTIALLY CONNECTED VIA HARDCODED BYPASS**
- **Current State (`src/TabletopStateManager.js:1364-1366` & `1379-1403`)**:
  - At the end of [`TabletopStateManager.declareAttackers`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1364-L1366), it loops over `declaredAttackers` and calls [`this._fireAttackTriggers(attacker, playerId)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1379-L1403).
  - `_fireAttackTriggers` checks `if (!attacker || !/goblin guide/i.test(attacker.name || '')) return null;` (`1380`).
  - **What it does wrong**:
    1. **Bypasses the Stack & `AbilityEngine`**: Instead of calling `this.abilityEngine.queueTrigger(...)` and `this.abilityEngine.flushTriggersAPNAP(...)` to put a `'TRIGGERED_ABILITY'` item on `this.priorityMachine._stack`, `_fireAttackTriggers` **resolves immediately and synchronously** inside `declareAttackers` (`1384-1392`), checking `defender.library[0]` and shifting it into `defender.hand` if `/land/i.test(top?.typeLine || top?.type || '')`.
    2. **Invisible to UI & Logs**: Although it emits `'ATTACK_TRIGGER_RESOLVED'` (`1401`), **nothing in `src/app.js` listens to `'ATTACK_TRIGGER_RESOLVED'`**, and `_fireAttackTriggers` does **not** call `this.recordTrace(...)` or `appendExecutionLog(...)`. Thus, the player receives zero visual feedback in `Turn Cmd` or `Trace` when `Goblin Guide`'s trigger reveals the top card of the defending player's library.

---

## 3. Dual Land Mana Production (`Steam Vents`) & Auto-Tap

### 3a) What Happens When Clicking `Steam Vents` on the Battlefield (`src/app.js:4291-4314` → `src/TabletopStateManager.js:2004-2058`)

1. **Direct Click Listener Without Color Argument (`src/app.js:4292-4302`)**:
   - In [`RPMAppController._reconcilePlayerDashboard`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L4291-L4314), clicking any `.land-chip` inside `#battlefield-lands` immediately runs:
     ```js
     const tappedRes = this.tabletopState.tapLandForMana(this.myPlayerId, land.instanceId);
     ```
   - Notice that **no 3rd argument (`chosenColor`) is passed**, and no UI color selector or `PermanentActionDrawer` is opened.
   - *(Note: Even though [`PermanentActionDrawer`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/view/PermanentActionDrawer.js#L1-L145) is instantiated at `src/app.js:277`, `this.actionDrawer.open(...)` is **never called anywhere in `src/app.js`**, and its `onTapMana` callback `handleDrawerTapMana` at `src/app.js:5581-5588` only dispatches `TAP_PERMANENT`, which taps a card without producing any mana).*

2. **Why `tapLandForMana` Always Produces `{R}` and Never `{U}` (`src/TabletopStateManager.js:2004-2140`)**:
   - Inside [`TabletopStateManager.tapLandForMana(playerId, instanceId, chosenColor = null)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L2004-L2058):
     - Line `2028` resolves the mana color to produce:
       ```js
       const color = chosenColor || this._resolveLandManaColor(land);
       ```
     - [`_resolveLandManaColor(land)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L2138-L2140) is implemented as:
       ```js
       _resolveLandManaColor(land) {
         return this._getLandManaProfile(land)[0] || 'C';
       }
       ```
     - [`_getLandManaProfile(land)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L2094-L2130) identifies `Steam Vents` at line `2101`:
       ```js
       if (name.includes('steam vents') || name.includes('volcanic island') || (typeLine.includes('island') && typeLine.includes('mountain'))) return ['R', 'U'];
       ```
   - **Root Cause**: Because `chosenColor` is always `null` when clicking a land in the UI, `tapLandForMana` calls `this._getLandManaProfile(land)[0]`, which **unconditionally takes index `0` (`'R'`)** of `['R', 'U']` and increments `player.resources.manaPool['R'] += 1` (`src/TabletopStateManager.js:2031`). The second element `'U'` is completely unreachable from manual clicks!

### 3b) What Happens During `autoTapForMana` (`src/TabletopStateManager.js:2152-2338`)

In [`TabletopStateManager.autoTapForMana(playerId, manaCostString)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L2152-L2338):
1. **Specific Colored Requirements (`2237-2269`)**:
   - When a spell explicitly requires `{U}` in its `manaCostString`, `autoTapForMana` filters `availableLands` by `l.profile.includes(col)` (`2250`), sorting single-color lands (`a.profile.length - b.profile.length`) before dual lands (`2251`). If `Steam Vents` (`profile: ['R', 'U']`) is tapped to pay `{U}`, it adds `U` to `pool` and immediately consumes `1 U` (`2262-2263`).
2. **Generic Mana Costs (`2275-2285`)**:
   - When paying generic mana costs (e.g., `{1}` or `{2}`), `autoTapForMana` calls `const producedColor = this._resolveLandManaColor(chosen.land)` (`2281`), which again hard-selects index `[0]` (`'R'`).
3. **Bypass in `app.js` When Clicking Hand Cards to Cast (`src/app.js:3833-3848` & `2510-2581`)**:
   - In [`RPMAppController.dispatchAction` (`case 'CAST_SPELL'`)](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L2519-L2538), it calls `this.tabletopState.autoTapForMana(casterId, card.manaCost)` (`2527`) only if `this.tabletopState.canPayManaCost(casterId, card.manaCost)` returns `false`.
   - If the player manually tapped `Steam Vents` beforehand by clicking it, `Steam Vents` was already forced to produce `'R'` (`tapLandForMana`), making it impossible for the player to manually float `{U}` in their mana pool.

---

## 4. Current Logger Architecture (`Turn Cmd`, `Trace (109)` & `actionLog`) & Hook Design

### 4a) Inspection of the Three Existing Logging Channels

#### 1. `Turn Cmd` Panel (`this.executionLog` & `DualChannelChat.turnCommandMessages`)
- **Storage & Population**:
  - Initialized in [`RPMAppController.constructor`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L118) as `this.executionLog = []`.
  - Populated via [`RPMAppController.appendExecutionLog(category, text, meta = {})`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L3232-L3257), which pushes an entry to `this.executionLog` (capped at 200 items) AND pushes `{ id, senderId: meta.playerId || 'SYSTEM', senderName: '[Category]', text, timestamp }` into `this.dualChat.turnCommandMessages` (initialized at [`src/DualChannelChat.js:87`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/DualChannelChat.js#L87)).
- **UI Rendering (`src/app.js:4489-4535`)**:
  - Rendered inside `#chat-messages` by [`_reconcileChat()`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L4489-L4535) when `this.activeChatTab === 'TURN_COMMAND'` and `this.showTraceLog === false`.
- **Current Coverage**:
  - Only logs high-level UI dispatches in `src/app.js`: Stack resolution (`1968`), Turn handover (`1995`), Spell cast (`2577`), Land play (`2613`), Declare attackers count (`2622`), Declare blockers count (`2629`), and Pregame/Mulligan events (`5432-5537`).
  - **Does NOT log**: Phase/step transitions, individual damage assignments, trigger activations, or SBA deaths.

#### 2. `📋 Trace (N)` Button & Drawer View (`ProcessTraceLogger` / `this.traceLogger`)
- **Storage & Population**:
  - Implemented in [`src/ProcessTraceLogger.js:17-132`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/ProcessTraceLogger.js#L17-L132) (`defaultProcessTraceLogger`, singleton exposed at `window.__PROCESS_TRACE__`, ring buffer `maxEntries = 500`).
  - [`TabletopStateManager.recordTrace(category, action, payload)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L2066-L2085) wraps `this.traceLogger.record(category, action, payload)` and automatically injects `{ turn, round, phase, step, activePlayerId, priorityPlayerId, defendingPlayerId }`.
- **UI Rendering (`src/app.js:4349-4362` & `4497-4512`)**:
  - Toggled via `#btn-toggle-trace-log` (`📋 Trace (${traceCount})`) in `#chat-drawer` (`src/app.js:4354, 4494`).
  - Includes toolbar buttons `#btn-copy-trace` (`navigator.clipboard.writeText`), `#btn-download-trace` (downloads `.log` plain text via `formatAsLogText()`), and `#btn-clear-trace` (`src/app.js:4406-4445`).
- **Current Coverage & Blind Spots**:
  - Currently records: `MATCH_START` (`app.js:587`), `DEAL_STARTING_HANDS` (`app.js:1042`), `PHASE_STEP_CHANGED` (`app.js:1985`), `PRIORITY_PASSED` (`app.js:2009`), `BOT_DECISION` (`PerkinsAgent.js:211`), `TAP_LAND_FOR_MANA` (`TabletopStateManager.js:2044`), `AUTO_TAP_FOR_MANA` (`2318`), `PLAY_LAND` (`812`), `CAST_SPELL` (`988`), `DECLARE_ATTACKERS` (`1356`), `DECLARE_BLOCKERS` (`1503`), `COMBAT_DAMAGE_RESOLVED` (`1639`), and `END_COMBAT` (`1695`).
  - **Blind Spots (Not Logged in `ProcessTraceLogger`)**:
    - `StateBasedActionsEngine.runSBACheck` (creature deaths by lethal damage / 0 toughness, player loss at `<= 0` life).
    - Individual `CombatDamageEngine.dealDamage` and `loseLife` mutations.
    - Trigger queueing (`AbilityEngine.queueTrigger`), APNAP flushing (`AbilityEngine.flushTriggersAPNAP`), and `_fireAttackTriggers` (`Goblin Guide`).
    - Stack resolution details (`TabletopStateManager.handleStackResolution`).

#### 3. `TabletopStateManager.actionLog` (`src/TabletopStateManager.js:230, 608-616`)
- **Storage & Population**:
  - Initialized at `src/TabletopStateManager.js:230` (`this.actionLog = []`) and incremented via `this.sequenceCounter` (`231`).
  - Appended in [`TabletopStateManager.dispatch(action)`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L608-L616) as `{ sequenceId, timestamp, actionType, playerId, payload }`, plus ad-hoc pushes in `eliminatePlayer` (`408-415`), `SPELL_FIZZLED` (`2574-2583`), and `DAMAGE_DEALT` (`2651-2665`).
- **Blind Spots**:
  - Completely invisible in the UI.
  - Because `src/app.js` frequently calls direct methods on `tabletopState` (`declareAttackers`, `declareBlockers`, `tapLandForMana`, `autoTapForMana`, `resolveCombatDamage`, `endCombat`) or mutates state directly in `app.js:dispatchAction` (`CAST_SPELL` at `2510-2581`, `CHANGE_LIFE` at `2497-2508`) instead of routing through `tabletopState.dispatch(action)`, `actionLog` misses most combat and priority events.

---

### 4b) Exact Hook Architecture for `StructuredCombatAndRuleLogger`

To record every phase/step transition, attack/block declaration, combat damage calculation, trigger event, and SBA check seamlessly across **UI (`Turn Cmd` + `Trace` drawer)**, **Browser `console` (structured group/table)**, and **auditable JSON export**, hook `StructuredCombatAndRuleLogger` into the following **6 exact locations**:

| # | Subsystem / Event | Exact File & Function | Exact Line(s) to Hook | Structured Event Payload to Emit |
|---|---|---|---|---|
| **1** | **Unified Sink, Console Output & JSON Exporter** | [`src/ProcessTraceLogger.js` — `ProcessTraceLogger.record`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/ProcessTraceLogger.js#L45-L73) & [`src/app.js` — `#btn-download-trace`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/app.js#L4422-L4435) | `src/ProcessTraceLogger.js:65-72` & `src/app.js:4425` | In `ProcessTraceLogger.record()`, add structured `console.debug('[RULE_TRACE]', entry)` and optional callback hook `this.onRecord(entry)` so `RPMAppController` can mirror rule/combat events directly into `appendExecutionLog()` (`Turn Cmd`), and add `exportAsJSON()` (`JSON.stringify(this.entries, null, 2)`) alongside `formatAsLogText()`. |
| **2** | **Phase & Step Transitions + Priority Passes** | [`src/TabletopStateManager.js` — `handlePhaseStepChanged`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L3076-L3095) & [`src/PriorityStateMachine.js` — `advanceStep`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/PriorityStateMachine.js#L833-L841) | `src/TabletopStateManager.js:3077` & `src/PriorityStateMachine.js:833` | Record `PHASE_TRANSITION` with `{ previousStep, currentPhaseStep, activePlayerId, priorityPlayerId, turnNumber, roundNumber, stackSize, combatAttackersCount, combatBlockersCount }`. |
| **3** | **Attacker & Blocker Declarations (Plus Rejected Candidates)** | [`src/TabletopStateManager.js` — `declareAttackers`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1300-L1367) & [`declareBlockers`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1430-L1509) | `src/TabletopStateManager.js:1356-1361` & `1503-1507` | Record `ATTACKERS_DECLARED` (`{ attackers: [{ id, name, power, toughness, isTapped, keywords, defendingPlayerId }], rejectedIds }`) and `BLOCKERS_DECLARED` (`{ assignments: [{ blockerId, blockerName, blockerPT, attackerId, attackerName, attackerPT }] }`). |
| **4** | **Granular Combat Damage Calculation & Assignment** | [`src/CombatDamageEngine.js` — `dealDamage`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/CombatDamageEngine.js#L69-L108), [`resolveCombatStep`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/CombatDamageEngine.js#L252-L302) & [`src/TabletopStateManager.js` — `resolveCombatDamage`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1545-L1666) | `src/CombatDamageEngine.js:97-105` & `src/TabletopStateManager.js:1639-1659` | Record per-source `COMBAT_DAMAGE_STEP` (`{ step: 'FIRST_STRIKE' \| 'NORMAL', sourceId, sourceName, targetId, targetName, amount, isCombatDamage, targetDamageMarkedAfter, targetToughness, targetLifeAfter }`). |
| **5** | **Trigger Queueing, APNAP Flushing & Stack Resolution** | [`src/AbilityEngine.js` — `queueTrigger`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/AbilityEngine.js#L160-L185), [`flushTriggersAPNAP`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/AbilityEngine.js#L194-L220), [`src/TabletopStateManager.js` — `_fireAttackTriggers`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L1379-L1403) & [`handleStackResolution`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/TabletopStateManager.js#L2540-L2803) | `src/AbilityEngine.js:183`, `218`, `src/TabletopStateManager.js:1394-1402`, `2550` | Record `TRIGGER_QUEUED`, `TRIGGER_FLUSHED_APNAP`, and `STACK_ITEM_RESOLVED` with `{ sourceId, sourceName, controllerId, triggerCondition, stackSizeAfter, effectOutcome }`. |
| **6** | **State-Based Actions (SBA) Checks & Zone Transitions** | [`src/StateBasedActionsEngine.js` — `runSBACheck`](file:///home/svayneak/Documents/Svayneak/rpm%20multiplayer/src/StateBasedActionsEngine.js#L24-L195) | `src/StateBasedActionsEngine.js:56-68` (704.5a), `114-125` (704.5f), `135-148` (704.5g), `155-167` (704.5h), `188-194` | Inside `runSBACheck`, whenever `actionsPerformed.length > 0`, call `stateManager.recordTrace('SBA_TRACE', 'SBA_APPLIED', { cycleCount, actions: actionsPerformed })` containing `{ rule, type, instanceId, cardName, ownerId, markedDamage, toughness, fromZone: 'battlefield', toZone: 'graveyard' }`. |
