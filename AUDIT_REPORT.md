# AUDIT_REPORT.md

- Repositorio: `/home/svayneak/Documents/Svayneak/rpm multiplayer` (git propio, rama `main`, HEAD `afbcb43`, remoto `origin https://github.com/Svayneak/rpm-multiplayer.git`)
- Fecha de auditoría: 2026-10-20
- Alcance: solo lectura sobre fuentes. Probes ad-hoc ejecutados desde `/tmp/aud/*.mjs` (fuera del repo). `git status --short` = limpio antes y después de ejecutar los tests.
- Convención: `INEXISTENTE` = no implementado / sin código de producción que lo invoque. `ACOPLADO/ROTO` = implementado con acoplamiento a UI, hardcodeado o con violación demostrada de la regla MTG.

---

## 1. Stack Tecnológico y Topología de Repositorios Fusionados

### 1.1 Lenguajes, runtimes y frameworks

| Capa | Tecnología | Evidencia |
|:--|:--|:--|
| Runtime | Node.js (v24.15.0 local, npm 11.12.1). ES Modules (`"type": "module"`) | `package.json:5` |
| Lenguaje | JavaScript puro (ESM). Sin TypeScript. Sin transpilación | `git ls-files`: sin `tsconfig`, sin `.ts` |
| Dependencias npm | **Ninguna** (`package.json` no declara `dependencies`/`devDependencies`; no hay `node_modules/` ni lockfile) | `package.json` completo |
| Motor de reglas (lógica de dominio) | `src/TabletopStateManager.js` (1595 L), `src/PriorityStateMachine.js` (1165 L), `src/ZoneModel.js`, `src/ZoneTransitionMatrix.js`, `src/StateBasedActionsEngine.js`, `src/CombatDamageEngine.js`, `src/AbilityEngine.js`, `src/CostModificationEngine.js`, `src/MulliganEngine.js` | `src/` |
| IA / bots | `src/PerkinsAgent.js` (1268 L, heurísticas; sin LLM — DEC-018) | `decisionlog.md:28` |
| Servidor | `server.js` (127 L): `node:http` + relay WebSocket RFC 6455 propio (`src/relay.js`, 1389 L). Cero dependencias externas | `server.js:1-40`, `src/relay.js:20-29` |
| Cliente de red | `src/RelayClient.js` (WebSocket nativo del navegador / implementación inyectable) | `src/RelayClient.js:85` |
| UI | DOM vanilla, sin framework (sin React/Vue). `index.html` (210 L) con `<script type="module">import { RPMAppController } from './src/app.js'` (`index.html:184-185`); `src/app.js` (4997 L, controlador); `src/view/*.js` (TabletopUI 1220 L, modales); CSS: `src/view/tabletop.css` (2666 L), `src/view/harness.css` | `src/view/` |
| Assets de terceros vendorizados | `assets/lib/dice-box/*` (dados 3D, ammo.wasm), `assets/sounds/roll.mp3` | `git show --stat 7331d08` |
| Persistencia | `src/StorageAdapter.js` (510 L; 9 refs a `window/document/localStorage`), migración SQL `specs/migrations/003_player_profiles_and_telemetry.sql` | `src/StorageAdapter.js` |
| Tests | Scripts `node` planos con `node:assert` (sin framework) | `test/*.js` |

Separación motor vs. UI: motor y UI **comparten el mismo paquete** (`package.json` `exports` expone indistintamente `./TabletopStateManager` y `./TabletopUI`, `./tabletop.css`, `./app`). No existe split en workspaces/paquetes. `src/index.js` (561 L, 159 exports) re-exporta ambos; importa en Node sin DOM (verificado: `import('./src/index.js')` OK).

### 1.2 Árbol de directorios (2 niveles, sin dependencias)

```
rpm multiplayer/
├── .build_checkpoint.json        (checkpoint de build agéntico, versionado)
├── .gitignore
├── ARCHITECTURE.md  CREDITS.md  OPEN_SOURCE_MODULES_AUDIT.md  README.md
├── TRANSCRIPCIONES_AUDIOS.md  decisionlog.md
├── SpeechRecognitionService.js   (duplicado en raíz de src/SpeechRecognitionService.js)
├── WhatsApp Ptt *.ogg (9)  Screencast From 2026-10-20 11-26-14.webm   (ignorados por .gitignore *.ogg/*.webm)
├── index.html
├── package.json
├── server.js
├── assets/
│   ├── dice-box/   ├── lib/   └── sounds/
├── specs/
│   ├── FEATURE_1_2 … FEATURE_21 (19 *.md)
│   └── migrations/
├── src/
│   ├── *.js (módulos de dominio/servicios/app)
│   └── view/ (TabletopUI.js, modales, DiceCanvas, TabRouter, *.css)
└── test/
    └── 31 scripts *.js (run_tests.js, test_*.js, verify_audit.js, live_scryfall_test.js)
```

No existe `.agents/` dentro del repo. No existen `.github/`, `.husky/`, `bin/`, ni configs de linter/formatter.

### 1.3 Mapeo de repositorios externos fusionados y mecanismo de comunicación

No hay submódulos ni subtrees: `.gitmodules` inexistente; `git log --all` = 21 commits en una sola rama `main`. La "fusión" es **copia/adaptación manual de lógica** documentada en prosa (`CREDITS.md`, `OPEN_SOURCE_MODULES_AUDIT.md`), sin vínculo versionado a upstream:

| Origen | Licencia | Destino en este repo (fuente: `CREDITS.md`) |
|:--|:--|:--|
| `acocalypso/mtgproxyprint` | MIT | `src/DeckParser.js` (regex de decklists) |
| `blinpete/mtg-builder` | MIT | `src/DeckParser.js` (sideboard / sanitización) |
| `crookedneighbor/scryfall-client` | MIT | `src/ScryfallService.js` (batching ≤75) |
| `andrewgioia/mana` (mana-font) | MIT / OFL-1.1 | `src/view/CardOverlayModal.js`, `src/view/tabletop.css` |
| `natefinch/moxmox` | MIT | `src/ZoneModel.js` (topología de zonas) |
| `untemps/vocal` | MIT | `src/SpeechRecognitionService.js` |
| Repos hermanos locales (mismo workspace, **sin dependencia de código en runtime**): `../rpm-revival` (`CommandDispatcher.js`, `AudioManager.js`), `../snake-game/server/relay.js` | — | Solo referenciados como "base arquitectónica" en `OPEN_SOURCE_MODULES_AUDIT.md:17,20,163`. Imports a `rpm-revival`/`snake-game` en `*.js`/`package.json`: 0 coincidencias |

Mecanismo de comunicación entre componentes fusionados: **inexistente a nivel repositorio** (no hay imports cross-repo, ni API, ni paquete publicado). La comunicación efectiva es interna:
- Intra-proceso: pub/sub por callbacks (`TabletopStateManager.subscribe`/`_notifySubscribers` `src/TabletopStateManager.js:285-300`; `PriorityStateMachine.subscribe/on/emit` `src/PriorityStateMachine.js:284-325`; `EventEmitter` isomórfico `src/EventEmitter.js`).
- Cliente↔servidor: WebSocket relay (`src/relay.js` `createRelayServer`, `server.js:11`); el relay instancia `TabletopStateManager`, `PriorityStateMachine`, `LobbyManager`, etc. en servidor (`src/relay.js:24-29`) y proyecta estado por jugador con `projectState` (`src/TabletopStateManager.js:75`).

---

## 2. Estado del Motor de Reglas (MTG Core Engine)

> Contradicción documental: `ARCHITECTURE.md:6` declara "Passive Ledger … NOT an autonomous rules engine", mientras `specs/FEATURE_21_COMPLETE_MTG_RULE_ENGINE_SPEC.md` y `.build_checkpoint.json` declaran "Complete MTG Rule Engine … 100% Certified". El código confirma implementación parcial (ver abajo).

### 2.1 Mutabilidad del Game State — **Mutación en memoria (NO Event Sourcing, NO inmutable)**

- Estado = objetos mutables: `this.players = {}`, `this.stack = []` (`src/TabletopStateManager.js:168-169`), arrays por zona mutados con `push/splice` (`handleStackResolution`, `src/TabletopStateManager.js:1295-1360`).
- Motores de reglas mutan el estado recibido: `StateBasedActionsEngine.runSBACheck` asigna `player.isEliminated = true` (`src/StateBasedActionsEngine.js:46`); `ZoneTransitionMatrix.resetCardIdentity` muta la carta (`src/ZoneTransitionMatrix.js:43-62`).
- Existe un `actionLog` append-only (`src/TabletopStateManager.js:176,415`) y `sequenceId`, pero **no hay reducer ni replay**: el log no reconstruye estado. Event Sourcing: `INEXISTENTE`.
- Snapshots: `CheckpointJournal` (`src/PriorityStateMachine.js:141-204`) guarda `JSON.stringify` solo de `{sessionId, players[], activePlayerId, priorityPlayerId, currentPhaseStep, turnNumber, consecutivePassCount, stack, isTurnEnded}` (`extractDomainState`, `src/PriorityStateMachine.js:126-137`). **No incluye zonas, vida, maná ni battlefield**; `rollbackToCheckpoint` (`:849-876`) restaura únicamente esos campos → rollback de estado de juego completo: `INEXISTENTE`.
- Determinismo: IDs y shuffle no inyectables/seedables — `Math.random` en `src/ZoneModel.js:77,120`, `src/PriorityStateMachine.js:87,99`, `src/AbilityEngine.js:111,176`; `Date.now()` en IDs/timestamps (`src/ZoneModel.js:72`, `src/ZoneTransitionMatrix.js:121`, `src/AbilityEngine.js:110`). Excepción: `MulliganEngine` usa CSPRNG (`src/MulliganEngine.js:27-28`, con rama `window.crypto`).

### 2.2 Cambio de zonas e identidad de objetos (Regla 400.7) — **ACOPLADO/ROTO**

- Implementación declarada: `ZoneTransitionMatrix.moveCard` → `resetCardIdentity` (`src/ZoneTransitionMatrix.js:43-62, 75-124`). Solo resetea atributos (`damageMarked=0`, `isTapped=false`, `counters={}`, `grantedAbilities=[]`, `zone`, `hasSummoningSickness`).
- Violación de 400.7 (objeto nuevo): `moveCard` devuelve **el mismo objeto y el mismo `instanceId`**. Probe ejecutado (`/tmp/aud/dup.mjs`): `id before/after moveCard: inst_Y inst_Y same object: true`. Cualquier referencia (stack item, objetivo, efecto continuo con `sourceId`) sigue apuntando a la "misma" carta tras cambiar de zona.
- `fromZone` se valida solo contra `ZONES` (`:79-84`); `ZoneModel.removeCardFromZone` busca la carta (`:91`) sin restringirla a `fromZone` → no se verifica que la carta estuviera en `fromZone` (el mensaje de error `:93` lo sugiere, la condición no).
- Bypass del camino principal: la resolución de la pila NO usa `ZoneTransitionMatrix`. `TabletopStateManager.handleStackResolution` hace `player.battlefield.creatures.push(card)` directo (`src/TabletopStateManager.js:1295-1352`) sin reset de identidad ni contadores. Probe (`dup.mjs`): carta con `counters:{'+1/+1':2}` conserva contadores al pasar `stack→battlefield`.
- `handleStackResolution` **no es idempotente**: dos invocaciones con la misma carta dejan `creatures after 2x resolution: 2 ids ['inst_X','inst_X']` (probe). Se invoca desde `PriorityStateMachine.resolveTop` (`src/PriorityStateMachine.js:906-911`, solo si `this.tabletopState` está seteado) y, además, desde dos suscriptores en la UI (`src/app.js:1729-1735` y `:1751-1756`) → posible doble resolución según el cableado (no reproducida end-to-end: en el probe `dup2.mjs` con un único suscriptor resultó 1 criatura). Errores tragados (`console.warn` / `catch (_) {}`).
- Zonas modeladas: `library, hand, battlefield, graveyard, exile, stack` (`src/ZoneTransitionMatrix.js:26-33`). Command zone y tokens/copias como objetos de zona propios: `INEXISTENTE`.

### 2.3 La Pila (Stack) y máquina de estados de Prioridad

- **Dos pilas independientes**: `PriorityStateMachine.stack` (items; `pushStack/popStack` `src/PriorityStateMachine.js:468-515`) y `TabletopStateManager.stack` (CardInstance; `src/TabletopStateManager.js:169,694`). Sincronización vía `handleStackResolution` + cableado en `src/app.js` → **ACOPLADO/ROTO** (el pegamento stack↔zonas vive en el controlador de UI).
- Prioridad implementada: `PASS_PRIORITY` con `consecutivePassCount` vs `players.length`, rotación `nextPlayer` (`src/PriorityStateMachine.js:365-371, 1046-1110`), `assertHasPriority` (`:380`), 7 y 12 pasos de turno (`SEVEN_PHASE_STEPS`/`TWELVE_PHASE_STEPS` `:24-49`), alarma de 15 s con auto-pass (`StackAlarmManager`, `:265`).
- Desviación demostrable de CR 117.4: atajo `opponentYieldedOnSingleSpell` (stack de 1 elemento, 2 jugadores, `sourcePlayerId===activePlayerId`, el oponente pasa) resuelve sin que todos hayan pasado (`src/PriorityStateMachine.js:1046-1075`).
- Resolución (`resolveTop`, `:888-935`): hace `popStack`, restaura prioridad al jugador activo, llama `handleStackResolution`, emite `STACK_RESOLVE`. **No ejecuta el efecto del hechizo/habilidad**: `handleStackResolution` solo enruta la carta a battlefield/graveyard por `typeLine` (`src/TabletopStateManager.js:1295-1352`). Resolución de efectos (daño, counterspell, targets, fizzle CR 608.2b): `INEXISTENTE`.
- No hay SBA en el ciclo de prioridad (CR 117.5): `grep SBA` en `PriorityStateMachine.js` = 0 coincidencias. Los triggers (`AbilityEngine.queueTrigger/flushTriggersAPNAP`) y `createActivatedAbilityStackItem`/`canActivateAbility` **no son invocados por código de producción** (`grep` en `src/` fuera de `AbilityEngine.js`/`index.js` = 0; solo `test/`). APNAP: utilidad aislada, **sin cableado** → `INEXISTENTE` en el flujo real. Mismo estado para `CostModificationEngine` (sin invocaciones en `src/` salvo re-export `src/index.js:253-256`).

### 2.4 Acciones Basadas en Estado (SBA) — implementación **PARCIAL**

`StateBasedActionsEngine.runSBACheck` (`src/StateBasedActionsEngine.js:33-190`): bucle iterativo con tope `maxLoops = 25`. Reglas implementadas: 704.5a (vida ≤0), 704.5c (veneno ≥10), 704.5q (aniquilación +1/+1/-1/-1), 704.5f (toughness ≤0), 704.5g (daño letal; respeta indestructible), 704.5h (deathtouch). Purga de daño en cleanup (`purgeCleanupMarkedDamage` `:196`, CR 514.2).
- `INEXISTENTE`: 704.5b (robar de biblioteca vacía — se maneja fuera de SBA con evento `EMPTY_LIBRARY_DRAW`, `src/TabletopStateManager.js:503-536`), 704.5d (tokens fuera de battlefield), 704.5i (planeswalker loyalty 0; el campo `loyalty` solo se copia, `:1451`), 704.5j (legend rule), 704.5m/n (auras/equipamiento ilegales), reglas de commander. `grep legend|token` en `StateBasedActionsEngine.js` = 0.
- Disparo: **no automático por prioridad**. `runSBACheck` se invoca solo tras `dealDamage`, `loseLife`, `enterWithoutCasting`, `reanimate`, `flicker` y cleanup (`src/TabletopStateManager.js:878,884,893,910,927,1570`) o por acción explícita `RUN_SBA_CHECK` (`:401`). No se invoca tras `handleStackResolution`, `playLand`, `castSpell` ni al otorgar prioridad.

### 2.5 Sistema de Capas (Layers 1-7) — **ACOPLADO/ROTO (parcial y sin productores)**

`AbilityEngine.evaluatePermanentLayers` (`src/AbilityEngine.js:233-322`) con `CONTINUOUS_LAYERS` (`:26-38`):

| Capa | Estado | Evidencia |
|:--|:--|:--|
| 1 Copy | `INEXISTENTE` (sin `case`; cae a `default: effect.apply`) | `:263-318` |
| 2 Control | `INEXISTENTE` (idem) | idem |
| 3 Text | `INEXISTENTE` (idem) | idem |
| 4 Type | callback genérico `effect.apply` | `:264-266` |
| 5 Color | callback genérico `effect.apply` | `:268-270` |
| 6 Abilities | keywords concedidos/removidos + `apply` | `:272-282` |
| 7a CDA P/T | `INEXISTENTE` (constante sin `case`) | `:33` |
| 7b / 7c / 7d / 7e | Implementados (set / modificador / contadores / switch) | `:284-313` |

Defectos adicionales: (a) sin sistema de dependencias (CR 613.8); (b) orden por `timestamp`, pero `registerStaticEffect` no asigna timestamp (`(a.timestamp||0)`, `:213`) → orden indeterminado entre efectos de igual capa; (c) `isCreature` se calcula una sola vez (`:237`) → una capa 4 que convierta un permanente en criatura no afecta a la capa 7; (d) **no hay productores de efectos**: `registerStaticEffect` no se invoca en `src/` (solo en `test/*`) y no existe parser texto→efecto → en producción `staticEffects` está siempre vacío; (e) único consumidor: `StateBasedActionsEngine` (`src/StateBasedActionsEngine.js:97`) vía `TabletopStateManager.abilityEngine` (`:175`), solo para toughness de criaturas.

---

## 3. Acoplamiento Motor-Interfaz (Headless vs. UI)

### 3.1 Viabilidad de ejecución 100% headless por CLI

- Núcleo headless ejecutable: `TabletopStateManager`, `PriorityStateMachine`, `ZoneTransitionMatrix`, `StateBasedActionsEngine`, `CombatDamageEngine`, `AbilityEngine` no referencian `document`/`window`. Verificado: `import('./src/index.js')` OK en Node; probes `/tmp/aud/dup.mjs` y `dup2.mjs` instancian el motor sin DOM.
- **No existe entrada CLI**: sin campo `bin` en `package.json`, sin runner de partida. `npm start` = `node server.js` (servidor HTTP/WS). Simulación headless de partida completa (p.ej. Perkins vs Perkins sin DOM) como comando: `INEXISTENTE`.
- Refs a globals de navegador en módulos fuera de `src/view/`: `src/app.js` (44 `document.`/`window.`), `src/VictoryFanfare.js` (17), `src/StorageAdapter.js` (9), `src/MulliganEngine.js` (2; guard `typeof window`), `src/RelayClient.js` (1), `src/SpeechRecognitionService.js` (1). `MulliganEngine` (motor de reglas) con rama `window.crypto` = acoplamiento menor, protegido por `typeof`.
- **Flujo de reglas dependiente de la UI**: la integración `PriorityStateMachine → TabletopStateManager` (resolución de pila) y `resetTurnQuotas` en cambio de turno se cablea en `src/app.js:1723-1760` (`RPMAppController`, controlador de DOM). Sin `RPMAppController` (o sin setear `psm.tabletopState` manualmente) la resolución de pila no mueve cartas de zona. Clasificación: **ACOPLADO/ROTO**.
- Tests de UI/app usan DOM simulado ad hoc (11 archivos con `createElement`/`document` stub: `test_tabletop_ui.js`, `test_browser_harness.js`, `test_battle_stability.js`, `test_ui_modals_unit.js`, `test_multi_client_sync.js`, etc.).
- Lógica de juego dentro de `src/app.js` (4997 L; 40 ocurrencias de `catch (_)` / `catch {}` vacíos): jugar tierra (`canPlayLand/playLand`), `autoTapForMana`, conceder (`eliminatePlayer`), cast (`src/app.js:586-1070`) se orquestan desde el controlador de UI.

### 3.2 Mecanismo de consumo de estado por la interfaz

- Modelo **push por callback + reconciliación DOM**: `TabletopUI` se suscribe a `ttsm.subscribe`, `psm.subscribe`, `chat.subscribe` (`src/view/TabletopUI.js:126-169`) y `RPMAppController` a `tabletopState`/`priorityMachine` (`src/app.js:~1700-1760`), invocando `reconcileDOM()`.
- Multi-cliente: el servidor relay mantiene estado autoritativo y envía proyección con fog-of-war por espectador (`projectState`, `src/TabletopStateManager.js:75-110`; `src/relay.js`); el cliente consume vía `src/RelayClient.js`.
- Sin capa de comandos/queries tipada, sin esquema de mensajes versionado, sin store inmutable: la UI lee objetos mutables del motor (`this.tabletopState.players[...]`, `src/app.js:891,926,972,1001`).

---

## 4. Infraestructura de Validación Determinista (Testing & CI)

### 4.1 Test runner, linter y compilador

| Elemento | Estado |
|:--|:--|
| Test runner | Ninguno (scripts `node test/*.js` encadenados con `&&`; assertions con `node:assert`) |
| Linter (ESLint/Biome) | `INEXISTENTE` (sin config ni dependencia) |
| Formatter (Prettier) | `INEXISTENTE` |
| Compilador / type-check (tsc, JSDoc check) | `INEXISTENTE` (JS puro, `tsconfig` ausente) |
| CI (`.github/workflows`, etc.) | `INEXISTENTE` (`git ls-files` sin `.github`) |
| Hooks pre-commit (husky/lefthook) | `INEXISTENTE` en el repo |
| Cobertura (c8/nyc/`--experimental-test-coverage`) | `INEXISTENTE` — no configurada; no medida |

### 4.2 Conteo real de tests y comando exacto

Comando: `cd "/home/svayneak/Documents/Svayneak/rpm multiplayer" && npm test`
Resultado ejecutado: **exit 0**, 29.4 s, 19 suites encadenadas (`package.json` scripts.test), 0 fallos.
- Suma de los resúmenes por suite (`passed`): 13+15+12+17+18+14+14+14+16+16+12+17+14+16+16+16+8+12+16 = **276 tests aprobados, 0 fallidos**.
- Líneas `[PASS]` en la salida: 196 (algunas suites usan otro formato de reporte).
- Segundo comando: `npm run test:modules` (exit 0): Module1 12/12, Module2 11/11, Module3 9/9, Module4 9/9, Module5 4/4 = **45 tests**. Estas 5 suites (`test_core_engines_unit.js`, `test_zone_and_combat_unit.js`, `test_tabletop_orchestration.js`, `test_ui_modals_unit.js`, `test_perkins_module5.js`) **NO están incluidas en `npm test`** → `npm test` no valida los commits module-1..6 en su totalidad.
- `test:live` (`test/live_scryfall_test.js`) requiere red; excluido de `npm test` y no ejecutado.
- Discrepancias con `.build_checkpoint.json`: declara `fullRegression: PASSED (20/20 Suites)` — `npm test` ejecuta 19 suites; declara `module4Unit: 7/7` — real 9/9.
- Archivos stub: `test/priority_state_machine_test.js` (4 L), `test/tabletop_state_test.js` (4 L), `test/test_dual_chat_action_bus.js` (7 L), `test/test_dice_bot_integrity.js` (11 L) — sin aserciones sustanciales.
- Cobertura: `INEXISTENTE` (sin herramienta; valor no medido).
- Tests de reglas MTG (`test/test_mtg_rule_engine.js`, 16 casos TC-RULES-01..16) validan las utilidades por separado con fixtures sintéticas; no cubren: capas 1-3/7a, SBA 704.5b/d/i/j, resolución de efectos de hechizos, ni rutas de cableado `app.js`. TC-RULES-06 aprueba "Zone-Change Card Identity Reset (CR 400.7)" aun cuando `instanceId` y objeto se conservan (ver 2.2).

### 4.3 Serialización de estado (snapshots JSON/YAML)

- Fixtures/golden files JSON/YAML de tests: `INEXISTENTE` (`ls test | grep -iE "json|snap|fixture"` = vacío; únicos `.json` versionados fuera de assets: `package.json`, `.build_checkpoint.json`).
- Serialización en runtime: solo `CheckpointJournal.serializedState` (`JSON.stringify` parcial, ver 2.1) y `projectState` (proyección por jugador, no persistible). Export/import de partida completa y comparación determinista de estados: `INEXISTENTE`.
- Determinismo de tests comprometido por `Math.random`/`Date.now` sin semilla ni reloj inyectado (ver 2.1).

---

## 5. Configuración Actual del Flujo Agéntico y Puntos de Falla

### 5.1 Inventario de `.agents/`

Dentro del repo `rpm multiplayer`: **no existe** `.agents/`, ni `.claude/`, ni scripts de orquestación (`package.json` solo define scripts de test/start). Artefactos agénticos en el repo: `decisionlog.md` (380 L, DEC-001..DEC-020), `.build_checkpoint.json` (checkpoint de 6 módulos, `status: COMPLETED`, `lastUpdated 2026-10-20T17:02:00-03:00`), `specs/FEATURE_*.md` (19 specs), `ARCHITECTURE.md §1` (pipeline 3-Tier Argon→Flash→Verificator: sin implementación ejecutable; solo prosa).

Workspace padre `/home/svayneak/Documents/Svayneak/.agents/` (el directorio padre no es repo git; no versionado junto al repo auditado):

| Ruta | Contenido real |
|:--|:--|
| `.agents/arch-auditor.md` | Subagente `arch-auditor` (`kind: local`, `subagent: true`): 4 invariantes (solo lectura, cero conjeturas, anti-maquillaje, estilo técnico) |
| `.agents/audit-goal.txt` | Spec de esta auditoría (5 secciones) |
| `.agents/hooks.json` | `identity-guard` (PreInvocation → `scripts/identity-hook.sh`) y `execution-harness` (PreToolUse, matcher `run_command\|write_to_file\|replace_file_content` → `python3 .agents/harness/guard.py`) |
| `.agents/harness/guard.py` (13.7 KB), `config.json`, `bwrap-sandbox.sh`, `test_guard.py` | Guardia de ejecución: patrones destructivos (`rm -r`, `git reset --hard`, `git push -f`, `dd`, `mkfs`, `supabase db reset`…), `protectedPaths`, allowlists de instaladores/build; sandbox `bwrap` (RO sobre `/` y `$HOME`, RW en workspace, `--share-net`) |
| `.agents/scripts/identity-hook.sh` | Wrapper que invoca `../scripts/check-identity.sh` (existe en `/home/svayneak/Documents/Svayneak/scripts/check-identity.sh`; la ruta relativa depende del cwd) y emite JSON `injectSteps` |
| `.agents/rules/` | `decision-log.md` (regla obligatoria de `decisionlog.md`), `memory.md` (Supabase MCP, Cloudflare/Wrangler, GitHub auth), `workspace-harness.md` |
| `.agents/skills/wrap-session/SKILL.md` | Skill de cierre de sesión → `Performance and systems/` |
| `.agents/plugins/local-mcp/` (`mcp_config.json`, `plugin.json`) | MCP: `supabase` (URL remota con project_ref), `pantry-to-plate` (`npx tsx` local; `env` contiene `SUPABASE_SERVICE_ROLE_KEY` en el archivo — valor omitido en este reporte), `chrome-devtools` (`chrome-devtools-mcp@1.11.0`, flags de aislamiento) |
| `/home/svayneak/Documents/Svayneak/.claude/` | `settings.json` (env de identidad git + hook `SessionStart` → `scripts/check-identity.sh`), `settings.local.json`, `git-identity.json` |
| `/home/svayneak/Documents/Svayneak/Performance and systems/` | `day_results_*.md`, `prompt_log_*.md` (bitácora manual de sesiones) |
| `/home/svayneak/Documents/Svayneak/scripts/` | `check-identity.sh`, `setup-identity.sh` (identidad git); `seed-dev.*`, `translate_mkv_subtitles.py` (no relacionados con el repo auditado) |

Observaciones de configuración:
- Orquestación multi-agente (Argon/Flash/Verificator) descrita en `ARCHITECTURE.md` **sin scripts, hooks ni runner** que la ejecuten: `INEXISTENTE` como mecanismo determinista; depende de la disciplina del operador.
- No existe gate automatizado entre "agente declara COMPLETED" y evidencia: `.build_checkpoint.json` contiene métricas (20/20, 7/7) inconsistentes con la ejecución real (ver 4.2).
- Credencial `SUPABASE_SERVICE_ROLE_KEY` en `.agents/plugins/local-mcp/mcp_config.json` en texto plano; el padre no es repo git (riesgo si se versiona).
- `guard.py` matcher (`hooks.json`) cubre `run_command|write_to_file|replace_file_content`; no cubre otras herramientas de escritura (`edit_file`, `notebook_edit`).

### 5.2 Últimos 10 commits (`git log -n 10 --oneline`)

```
afbcb43 fix(ui): prevent modals from blocking viewport on initial app boot
d0e725c feat(module-6): end-to-end integration and acceptance certification for Features 19, 20, 21
5682397 feat(module-5): implement Perkins AI London Mulligan, tutor selection, and legal target heuristics
bd9201f feat(module-4): implement interactive UI modals, target selector, action drawer, and horizontal land badges
f2f4e39 feat(module-3): implement two-tier phase state machine and tabletop state orchestrations
ed9fe64 feat(module-2): implement zone transition matrix, combat damage engine, and SBA engine
9a8c0fd feat(module-1): implement pure core rules engines (MulliganEngine, CostModificationEngine, AbilityEngine)
7331d08 feat(dice-bot): implement Feature 18 3D dice engine, bot cast integrity, and perk activation normalization
c0ba16b feat(stability): implement Feature 17 battle stability, opponent land field, auto-tap engine, priority flow, and card inspection
4ca8ba6 feat(battle): implement lobby spectator hub, 3s countdown, phase strip, and battle rules (Feature 16)
```

Cronología: 21 commits totales (2026-10-17 → 2026-10-20), 1 rama, 0 reverts (`git log --all -i --grep=revert` = 0). Composición de los últimos 10: 9 `feat`, 1 `fix` (`afbcb43`, 2026-10-20 18:47: modales bloqueaban el viewport en boot — 5 modales + CSS + `test_ui_modals_unit.js`). Módulos 1-6 commiteados en 31 minutos (16:31–17:02 del 2026-10-20).

Commits `fix` en todo el historial (6): `afbcb43`, `eeabac5` (multi-client sync/echo suppression, `src/app.js` +198 L), `b750084` (race `DOMContentLoaded`, `index.html`), `7df4930` (no-cache JS/CSS, `server.js`), `d8a9f74` (remoción de builtins `node:` en navegador, EventEmitter isomórfico), `a700407` (wss dinámico, `index.html` + `src/app.js`).

### 5.3 Archivos de mayor recurrencia (`git log --name-only`, historial completo)

| Archivo | Commits que lo tocan | Notas |
|:--|:--|:--|
| `src/app.js` | 11 (5 en los últimos 10; +1390 L netas en últimos 10) | 2 de 6 commits `fix` (`a700407`, `eeabac5`); mayor concentración de lógica de reglas acoplada a UI; 40 `catch` vacíos |
| `src/index.js` | 9 | Re-export manual; crece con cada feature |
| `package.json` | 9 | Lista `test` encadenada manualmente (omite 5 suites de módulos) |
| `src/view/tabletop.css` | 8 (5 en últimos 10; +915 L) | Hot-spot de UI; tocado en `afbcb43` (fix) |
| `index.html` | 8 | 2 de 6 `fix` (`a700407`, `b750084`) |
| `decisionlog.md` | 8 | Registro de decisiones |
| `.build_checkpoint.json` | 6 (todos en últimos 10) | Métricas autoinformadas inconsistentes |
| `src/TabletopStateManager.js` | 5 (4 en últimos 10; +910 L) | Núcleo de estado; dos pilas, `handleStackResolution` no idempotente |
| `src/PerkinsAgent.js`, `src/PriorityStateMachine.js` | 3 c/u en últimos 10 (+643 / +363 L) | — |

Puntos de falla identificados (evidencia arriba):
1. `src/app.js` + `index.html`: recurrencia de `fix` (bootstrap, protocolo, sincronización, modales) → superficie UI/controlador con reglas embebidas; sin tests de integración sobre DOM real (solo stubs).
2. `src/TabletopStateManager.js:1295` `handleStackResolution`: bypass de `ZoneTransitionMatrix`, no idempotente, doble ruta de invocación (PSM y `app.js`).
3. `src/ZoneTransitionMatrix.js:43-124`: 400.7 conservando `instanceId`/objeto; el test TC-RULES-06 no detecta la violación.
4. `src/AbilityEngine.js:233-322`: capas 1-3 y 7a sin implementar, sin productores de efectos, sin timestamp ni dependencias.
5. `package.json` scripts.test: 5 suites de módulos fuera del gate; ausencia de CI, linter, type-check y cobertura.
6. `.build_checkpoint.json`: reporte agéntico "COMPLETED/100% Certified" no verificable ni reproducible (20/20 vs 19 suites; 7/7 vs 9/9).
7. Doc↔código: `ARCHITECTURE.md` ("NOT an autonomous rules engine") vs `FEATURE_21` ("Complete MTG Rule Engine").
