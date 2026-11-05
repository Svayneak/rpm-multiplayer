# Active Deck Certification & Repair Report

- **Target Deck:** Modern Hammer Time + Jegantha Companion (60 Mainboard / 15 Sideboard — 28 Unique Cards)
- **Pipeline Executed:** `deck-certifier` -> `module-builder` -> `adversarial-critic`
- **Test Suite File:** [`test/test_active_deck_certification.js`](./test/test_active_deck_certification.js) (`38 / 38 PASS`)
- **Unified Runner Status:** `30 / 30` suites passing (`0` failures) via [`test/run_all.js`](./test/run_all.js)

> [!IMPORTANT]
> Every card in the active decklist was cross-referenced against official Scryfall Oracle text and certified against the MTG Comprehensive Rules (CR) across all 7 continuous layers, priority/stack resolution, optimal mana payment, combat damage, and state-based actions.

---

## 1. Card-by-Card Certification Matrix (28 / 28 Unique Cards)

### Mainboard (20 Unique Cards)

| # | Card Name | Qty | Scryfall / Oracle Mechanics Audited & Repaired | Status |
| :-: | :--- | :-: | :--- | :-: |
| 1 | **Heartfire Hero** | 4 | **Valiant** (`ON_BECOMES_TARGET` once per turn by controlled spell/ability -> `+1/+1` counter) + **Dies Trigger** (`ON_DIES` deals damage equal to Last Known Information [LKI] power to each opponent, CR 608.2h). | ✅ **PASS** |
| 2 | **Hallowed Fountain** | 1 | `Land — Plains Island`. Shockland ETB (`pay 2 life` to enter untapped or enter tapped) + `{T}: Add {W} or {U}`. | ✅ **PASS** |
| 3 | **Sigarda's Aid** | 4 | Static permission granting `Flash` to Aura & Equipment spells (`GRANT_FLASH_TO_SPELLS`) + `ON_EQUIPMENT_ETB` free auto-attach trigger to target controlled creature. | ✅ **PASS** |
| 4 | **Stolen Uniform** | 4 | **Fixed Scryfall FIN #75 metadata**: `{U}` Instant (was misconfigured as an Equipment in fallback metadata). Gains control of target Equipment until EOT, attaches it to target creature you control, and unattaches at EOT if still attached when control reverts. | ✅ **PASS** |
| 5 | **Fervent Champion** | 4 | `First strike`, `Haste`, `ON_ATTACKS` trigger (`+1/+0` until EOT to another target attacking Knight you control), and `TARGET_EQUIP_COST_REDUCTION` (`{3}` less to activate equip abilities targeting Fervent Champion). | ✅ **PASS** |
| 6 | **Inkmoth Nexus** | 4 | `{T}: Add {C}` + `{1}:` Animated until EOT into a `1/1 Blinkmoth artifact creature` with `flying` and `infect` (deals damage to creatures as `-1/-1` counters and to players as poison counters; reverts to `Land` at EOT cleanup per CR 611.2a). | ✅ **PASS** |
| 7 | **Colossus Hammer** | 4 | Equipped creature gets `+10/+10` (Layer 7c) and **loses flying** (Layer 6 `keywordsRemoved: ['flying']`, CR 613.1f). Equip `{8}`. | ✅ **PASS** |
| 8 | **Leyline Axe** | 4 | Pregame opening hand action (`START_ON_BATTLEFIELD`, CR 103.6), equipped creature gets `+1/+1` and has `double strike` and `trample`. Equip `{3}`. | ✅ **PASS** |
| 9 | **Plains** | 1 | `Basic Land — Plains` (`{T}: Add {W}`). | ✅ **PASS** |
| 10 | **Mana Confluence** | 4 | `{T}, Pay 1 life: Add one mana of any color` (`W`, `U`, `B`, `R`, `G` with `lifeCost: 1`). | ✅ **PASS** |
| 11 | **Starting Town** | 4 | Fastland ETB regex updated (`unless it's (?:the|your) first, second, or third turn`), `{T}: Add {C}` (`0` life), and `{T}, Pay 1 life: Add one mana of any color`. | ✅ **PASS** |
| 12 | **Spire of Industry** | 4 | `{T}: Add {C}` + `{T}, Pay 1 life: Add one mana of any color. Activate only if you control an artifact` (`requiresArtifact: true`). | ✅ **PASS** |
| 13 | **Steam Vents** | 1 | `Land — Island Mountain`. Shockland ETB (`pay 2 life` or enter tapped) + `{T}: Add {U} or {R}`. | ✅ **PASS** |
| 14 | **Belt of Giant Strength** | 4 | **Layer 7b** sets equipped creature's base P/T to `10/10` (`setPower: 10, setToughness: 10` before Layer 7c buffs and Layer 7d `+1/+1` counters) + Equip `{10}` reduced by `{X}` where `X` is target creature's current power (`equipDiscountByTargetPower: true`). | ✅ **PASS** |
| 15 | **Mountain** | 1 | `Basic Land — Mountain` (`{T}: Add {R}`). | ✅ **PASS** |
| 16 | **Goblin Gaveleer** | 4 | `Trample` + **Layer 7c** `SCALING_BUFF_PER_EQUIPMENT` (`+2/+0` for each Equipment attached to it). | ✅ **PASS** |
| 17 | **Forge Anew** | 2 (+1 SB) | `ON_ETB` returns target Equipment card from graveyard to battlefield (with clean CR 400.7 identity), `INSTANT_SPEED_EQUIP` during your turn, and `FIRST_EQUIP_COST_ZERO` (`{0}` for the first equip ability activated each turn). | ✅ **PASS** |
| 18 | **Callous Sell-Sword // Burn Together** | 4 | Adventure card (`MAIN` creature `{1}{B}` + `ADVENTURE` sorcery `{R}`). `Burn Together` resolves `FLING_SACRIFICE_DAMAGE` (target controlled creature deals damage equal to its power to any other target, then is sacrificed, firing LKI dies triggers) and goes to exile on resolution (CR 715.3d). | ✅ **PASS** |
| 19 | **Doc Ock's Tentacles** | 1 | Equipped creature gets `+4/+4`, Equip `{5}`, and `ON_CREATURE_MV5_ETB_ATTACH` auto-attaches when a creature you control with mana value >= 5 (e.g., `Jegantha, the Wellspring`) enters the battlefield. | ✅ **PASS** |
| 20 | **Resolute Strike** | 1 | `{W}` Instant. Target creature gets `+2/+2` until EOT, and **only if that creature has subtype `Warrior`** (`requiresSubtypeForAttach: 'Warrior'`, e.g., `Goblin Gaveleer`), attaches target controlled Equipment to it. | ✅ **PASS** |

---

### Sideboard & Companion (8 Additional Unique Cards)

| # | Card Name | Qty | Scryfall / Oracle Mechanics Audited & Repaired | Status |
| :-: | :--- | :-: | :--- | :-: |
| 21 | **Surge of Salvation** | 2 | `{W}` Instant. Grants `hexproof` to you and permanents you control until EOT + creates a `PREVENT_COLOR_DAMAGE` shield preventing all damage that black and/or red sources would deal to creatures you control this turn (CR 615). | ✅ **PASS** |
| 22 | **Surgical Extraction** | 1 | `{B/P}` Instant. Phyrexian mana solver (`{B}` or `2 life`) + `SURGICAL_EXTRACT_NAME` exiles target non-basic-land card from a graveyard and all cards with the same name from its owner's graveyard, hand, and library. | ✅ **PASS** |
| 23 | **Invasion of Gobakhan // Lightshield Array** | 2 | `{1}{W}` `Battle — Siege // Enchantment` (Defense `3`). Enters with 3 defense counters; ETB exiles a nonland card from opponent's hand with `{2}` cast tax (`castTaxGeneric: 2`). When defense reaches `0` via `dealDamageToBattle`, transforms into `Lightshield Array` (which can be sacrificed to grant team `hexproof` + `indestructible` until EOT). | ✅ **PASS** |
| 24 | **Wear // Tear** | 2 | Split Instant with `Fuse` (`SPLIT_LEFT` `Wear` `{1}{R}` destroys target artifact; `SPLIT_RIGHT` `Tear` `{W}` destroys target enchantment; `FUSED` `{1}{R}{W}` resolves both). | ✅ **PASS** |
| 25 | **Tormod's Crypt** | 1 | `{0}` Artifact. `{T}, Sacrifice Tormod's Crypt: Exile target player's graveyard` (`SACRIFICE_EXILE_GRAVEYARD`). | ✅ **PASS** |
| 26 | **Skrelv, Defector Mite** | 1 | `{W}` Legendary Artifact Creature (`1/1`). `Toxic 1` (CR 702.164: deals normal combat damage plus 1 poison counter on combat damage to a player), `can't block` restriction (`cantBlock: true`), and `{W/P}, {T}:` grants another target creature `toxic 1`, `hexproof` from chosen color, and can't be blocked by creatures of that color until EOT. | ✅ **PASS** |
| 27 | **Soul-Guide Lantern** | 2 | `{1}` Artifact. `ON_ETB` exiles target card from a graveyard; `{T}, Sacrifice:` exiles each opponent's graveyard; `{1}, {T}, Sacrifice:` draws a card. | ✅ **PASS** |
| 28 | **Jegantha, the Wellspring** | 1 | `{4}{R/G}` Companion (`5/5`). Verified companion deckbuilding restriction across all 28 cards (no card has duplicate mana symbols in its cost) + `{T}: Add {W}{U}{B}{R}{G}` with `restrictedSpend: 'NO_GENERIC'`. | ✅ **PASS** |

---

## 2. Adversarial Red-Team Audit Matrix (`ADV-1` – `ADV-10`)

| Vector ID | Target Card / Subsystem | Red-Team Attack Scenario & Edge-Case Verified | Status |
| :---: | :--- | :--- | :---: |
| **ADV-1** | `Belt of Giant Strength` | **Power Clamping:** Equipping onto a 15-power or 10-power creature clamps cost to `{0}` (never negative); equipping onto a creature with `-2` power (via `-1/-1` counters) or `0` power clamps discount to `0` so equip cost stays `{10}`. | ✅ **PASS** |
| **ADV-2** | `Forge Anew` | **CR 400.7 Zone Identity & Empty GY:** ETB on empty graveyard or instant-only graveyard safely no-ops; returning an Equipment from graveyard assigns a brand-new `instanceId` and resets stale `attachedTo` to `null`. | ✅ **PASS** |
| **ADV-3** | `Surgical Extraction` | **CR 115.1a Basic Land Target Guard:** Attempting to target a `Basic Land — Plains` in the graveyard is strictly ignored/rejected (`0` cards exiled from graveyard, hand, or library). | ✅ **PASS** |
| **ADV-4** | `Invasion of Gobakhan` | **Empty/All-Land Hand & CR 712.8a DFC Graveyard Reversion:** ETB safely handles empty hand or all-land hand (`0` cards exiled, still gets 3 defense counters). When transformed into `Lightshield Array` and sacrificed, reverts to front face (`Invasion of Gobakhan // Lightshield Array`) in the graveyard. | ✅ **PASS** |
| **ADV-5** | `Soul-Guide Lantern` | **Empty Opponent Graveyard:** Both ETB trigger and `{T}, Sacrifice` ability resolve cleanly without error when opponent's graveyard is empty. | ✅ **PASS** |
| **ADV-6** | `Heartfire Hero` + `Belt` + `Hammer` + `Burn Together` | **42-Damage Multi-Equipment Fling Combo:** `Belt` sets base P/T to `10/10` (Layer 7b) + Valiant adds one `+1/+1` counter on first equip (and does **not** double-trigger on second equip) + `Colossus Hammer` adds `+10/+10` (Layer 7c) = `21/21`. Casting `Burn Together` deals `21` fling damage + sacrifices `Heartfire Hero`, whose `ON_DIES` LKI trigger deals another `21` damage = **42 total damage**. | ✅ **PASS** |
| **ADV-7** | `Inkmoth Nexus` + `Colossus Hammer` | **Layer 6 Flying Loss + 11 Infect Poison + CR 611.2a EOT Reversion:** Animated `Inkmoth Nexus` (`1/1` flying, infect) equipped with `Colossus Hammer` becomes `11/11` with `infect` and **loses `flying`** in Layer 6; deals `11` poison counters (eliminating opponent via CR 704.5c SBA); reverts to `battlefield.lands` at EOT cleanup. | ✅ **PASS** |
| **ADV-8** | `TabletopStateManager` | **Subzone vs. `zones.battlefield` Sync Invariant:** Adding and destroying permanents across `creatures`, `lands`, and `noncreatures` keeps `player.battlefield.*` subzones and `player.zones.battlefield` 100% synchronized. | ✅ **PASS** |
| **ADV-9** | `Goblin Gaveleer` | **Multi-Equipment Layer 7b + 7c Stack:** `Goblin Gaveleer` equipped with `Belt of Giant Strength` (`10/10` Layer 7b) + `Leyline Axe` (`+1/+1` Layer 7c, double strike, trample) + Gaveleer scaling (`+4/+0` for 2 Equipments in Layer 7c) evaluates to exact `15/11` with `double strike` and `trample`. | ✅ **PASS** |
| **ADV-10** | `Stolen Uniform` | **EOT Control Loss & Mandatory Unattach:** Stealing an opponent's `Colossus Hammer` and attaching it to `Heartfire Hero` makes Hero `12/12` (`1` base + `1` Valiant counter + `10` Hammer); at `clearEndOfTurnEffects()`, Hammer returns to opponent's control, unattaches from Hero, and Hero's stats normalize to `2/2`. | ✅ **PASS** |
| **ADV-25** | `Inkmoth Nexus` | **EOT Reversion & Mandatory Equipment Unattach (CR 611.2a & CR 301.5c):** Animate Inkmoth Nexus to 1/1 flying infect, equip Colossus Hammer to 11/11, attack dealing 11 poison counters to opponent, and execute `handleCleanupStep` / `clearEndOfTurnEffects()`. Inkmoth Nexus reverts to `battlefield.lands` with `typeLine: 'Land'`, P/T cleared, Colossus Hammer unattached (`attachedTo: null`), and immune to subsequent creature sacrifice effects. | ✅ **PASS** |
| **ADV-26** | `Callous Sell-Sword // Burn Together` | **Explicit Combination Selection & Directed Fling (CR 608.2b & CR 608.2c):** With Fervent Champion (1/1) and Goblin Gaveleer (15/11) on table against 2 opponents (`bot2`, `bot3`), `getActionCombinationsForSpell` produces full pairwise candidates. Resolving selected combo `{ creatureId: gaveleer, targetId: 'bot3' }` sacrifices Goblin Gaveleer, leaves Champion alive, and deals exact 15 damage to `bot3`. | ✅ **PASS** |

---

## 3. Files Modified

1. [`src/DeckValidator.js`](./src/DeckValidator.js) — Updated `KNOWN_CARD_METADATA` for `stolen uniform` (`{U}` Instant) and added all missing mainboard/sideboard cards.
2. [`src/DeckbuilderAI.js`](./src/DeckbuilderAI.js) — Updated `stolen uniform` fallback metadata to match Scryfall FIN #75.
3. [`src/OracleEffectCompiler.js`](./src/OracleEffectCompiler.js) — Added compilation rules for all 28 cards (fastlands, Jegantha restricted mana, Fuse split cards, Battle transform modes, Layer 7b equipment, scaling equipment buffs, ETB/attack triggers, and activated abilities).
4. [`src/AbilityEngine.js`](./src/AbilityEngine.js) — Added Layer 7b equipment base P/T setting (`Belt of Giant Strength`) and Layer 7c per-equipment scaling (`Goblin Gaveleer`).
5. [`src/CastAvailabilityManager.js`](./src/CastAvailabilityManager.js) — Added Phyrexian/hybrid mana payment calculation, `Forge Anew` first-equip `{0}` waiver, and `Belt of Giant Strength` target power equip discount clamping.
6. [`src/CombatDamageEngine.js`](./src/CombatDamageEngine.js) — Added `toxic` poison counter assignment, `cantBlock` enforcement, and `resolveDamageStep`.
7. [`src/TabletopStateManager.js`](./src/TabletopStateManager.js) — Added runtime handlers for ETB triggers, spell effects, battle defense/transformation, activated abilities, EOT cleanup reversion, and unified Valiant tracking.
8. [`test/test_active_deck_certification.js`](./test/test_active_deck_certification.js) & [`test/run_all.js`](./test/run_all.js) — Created and registered the 38-vector deterministic certification test suite.
