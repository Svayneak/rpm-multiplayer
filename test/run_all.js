#!/usr/bin/env node
/**
 * test/run_all.js - Unified test runner for RPM Multiplayer.
 *
 * Runs every real test suite (the historical `npm test` chain, the `test:modules`
 * unit suites, and finally the architectural invariants gate) as isolated child
 * processes. Each suite owns its own process because many of them call
 * `process.exit()` directly and keep module-level state.
 *
 * Exit code is 0 only if every suite exits 0. Unlike the former `a && b && c`
 * chain, a failure does not hide the results of the remaining suites: all suites
 * run and a consolidated report is printed at the end.
 *
 * Usage:
 *   node test/run_all.js              # run everything
 *   node test/run_all.js --bail       # stop at first failing suite
 *   node test/run_all.js zone combat  # run only suites whose file name matches a filter
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(TEST_DIR, '..');

/** Integration / acceptance suites (former `npm test` chain, in original order). */
export const INTEGRATION_SUITES = Object.freeze([
  'run_tests.js',
  'test_zone_state.js',
  'test_priority_stack.js',
  'test_dual_chat_action.js',
  'test_tabletop_ui.js',
  'test_relay_sync.js',
  'test_random_perk.js',
  'test_deckbuilder_ai.js',
  'test_victory_fanfare.js',
  'test_browser_harness.js',
  'test_multi_client_sync.js',
  'test_perkins_ai.js',
  'test_unified_platform.js',
  'test_onboarding_lobby.js',
  'test_battle_spectator.js',
  'test_battle_stability.js',
  'test_3d_dice_and_integrity.js',
  'test_battle_ux_hardening.js',
  'test_combat_damage_engine.js',
  'test_mtg_rule_engine.js',
  'test_lifecycle_and_concede.js'
]);

/** Module unit suites (former `npm run test:modules`). */
export const MODULE_SUITES = Object.freeze([
  'test_core_engines_unit.js',
  'test_zone_and_combat_unit.js',
  'test_tabletop_orchestration.js',
  'test_pregame_turns_combat.js',
  'test_ui_modals_unit.js',
  'test_perkins_module5.js'
]);

/** Architectural gate - always runs last. */
export const GATE_SUITES = Object.freeze([
  'verify_architecture_invariants.js'
]);

export const ALL_SUITES = Object.freeze([
  ...INTEGRATION_SUITES,
  ...MODULE_SUITES,
  ...GATE_SUITES
]);

function main() {
  const args = process.argv.slice(2);
  const bail = args.includes('--bail');
  const filters = args.filter(a => !a.startsWith('--'));

  const suites = filters.length
    ? ALL_SUITES.filter(s => filters.some(f => s.includes(f)))
    : [...ALL_SUITES];

  if (suites.length === 0) {
    console.error(`[run_all] No suites match filters: ${filters.join(', ')}`);
    process.exit(1);
  }

  const results = [];
  const startAll = Date.now();

  for (const suite of suites) {
    const file = join(TEST_DIR, suite);
    console.log(`\n\x1b[36m▶ [run_all] ${suite}\x1b[0m`);

    if (!existsSync(file)) {
      console.error(`\x1b[31m✖ [run_all] Missing suite file: ${suite}\x1b[0m`);
      results.push({ suite, code: 1, ms: 0, missing: true });
      if (bail) break;
      continue;
    }

    const start = Date.now();
    const proc = spawnSync(process.execPath, [file], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: process.env
    });
    const code = proc.status === null ? 1 : proc.status;
    results.push({ suite, code, ms: Date.now() - start, signal: proc.signal });

    if (code !== 0 && bail) break;
  }

  const failed = results.filter(r => r.code !== 0);
  const totalMs = Date.now() - startAll;

  console.log('\n==================================================================');
  console.log('  RPM MULTIPLAYER - UNIFIED TEST REPORT');
  console.log('==================================================================');
  for (const r of results) {
    const mark = r.code === 0 ? '\x1b[32m✔ PASS\x1b[0m' : '\x1b[31m✖ FAIL\x1b[0m';
    const extra = r.missing ? ' (missing file)' : r.signal ? ` (signal ${r.signal})` : '';
    console.log(`  ${mark}  ${r.suite.padEnd(40)} ${String(r.ms).padStart(6)} ms${extra}`);
  }
  console.log('------------------------------------------------------------------');
  console.log(`  Suites: ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} run (of ${suites.length} selected) in ${totalMs} ms`);
  console.log('==================================================================\n');

  process.exit(failed.length > 0 || results.length < suites.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
