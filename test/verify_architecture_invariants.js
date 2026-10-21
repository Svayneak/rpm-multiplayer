#!/usr/bin/env node
/**
 * test/verify_architecture_invariants.js - Architectural Validation Gate
 *
 * Static (source-level) invariants enforced on every `npm test` run. Exits 1 on
 * any violation and prints a strict report.
 *
 *   INV-ARCH-HEADLESS   No file in src/ outside the browser allow-list may reference
 *                       `window.` / `document.` without a `typeof` guard.
 *   INV-ARCH-WIRED      Core rule engines must be imported AND invoked by at least
 *                       one production module in src/ (src/index.js barrel excluded).
 *                       Engines not yet wired are tracked in KNOWN_UNWIRED_ENGINES;
 *                       a ratchet test fails as soon as one becomes wired so the
 *                       list is kept honest.
 *   INV-ARCH-SUITES     Every test suite file in test/ is executed by test/run_all.js
 *                       (no orphan suites, no alias/stub suites).
 *   INV-ARCH-NO-DUPES   No duplicate copy of a src/ module lives in the project root.
 *
 * The runtime counterpart of CR 400.7 identity (new instanceId on zone change) is
 * asserted in test/test_mtg_rule_engine.js (TC-RULES-06).
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_SUITES } from './run_all.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(TEST_DIR, '..');
const SRC_DIR = join(ROOT_DIR, 'src');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Paths (relative to project root, POSIX style) allowed to touch browser globals freely. */
export const HEADLESS_ALLOWLIST = Object.freeze([
  'src/view/',                     // whole directory
  'src/app.js',
  'src/StorageAdapter.js',
  'src/VictoryFanfare.js',
  'src/RelayClient.js',
  'src/SpeechRecognitionService.js'
]);

/** Engines that must be wired into production code. */
export const REQUIRED_ENGINES = Object.freeze([
  'AbilityEngine',
  'CostModificationEngine',
  'ZoneTransitionMatrix',
  'StateBasedActionsEngine',
  'CombatDamageEngine'
]);

/**
 * Engines that are currently NOT imported+invoked by any production module.
 * Unblock these in the next Goal: wire the engine, then remove it from this list
 * (the ratchet test below will fail until you do).
 *
 *  - CostModificationEngine: TabletopStateManager parses mana costs with its own
 *    private `_parseManaCostString` and never routes CAST_SPELL through
 *    CostModificationEngine.calculateFinalCost (CR 601.2f is untested in prod flow).
 */
export const KNOWN_UNWIRED_ENGINES = Object.freeze([]);

/** Production files excluded from the wiring analysis (barrels / re-exports). */
const WIRING_EXCLUDED_FILES = Object.freeze(['src/index.js']);

/**
 * Test files intentionally NOT executed by run_all.js, with the reason.
 * Anything else under test/ must be listed in run_all.js ALL_SUITES.
 */
export const SUITE_EXCLUSIONS = Object.freeze({
  'run_all.js': 'unified runner itself',
  'live_scryfall_test.js': 'hits the live Scryfall API (network) - run via `npm run test:live`',
  'verify_audit.js': 'standalone legacy audit script (not part of the historical npm test chain)'
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toPosix = p => p.split(sep).join('/');
const rel = p => toPosix(relative(ROOT_DIR, p));

function walkJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkJs(full));
    else if (/\.(m?js)$/.test(entry)) out.push(full);
  }
  return out.sort();
}

/**
 * Replaces comments and string/template literal contents with spaces while
 * preserving line structure, so regex scans only see executable code.
 * Template literal `${...}` expressions are kept as code.
 */
export function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const templateDepth = []; // brace depth stack for nested `${}` expressions
  let braceDepth = 0;

  const blank = ch => (ch === '\n' ? '\n' : ' ');

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // Line comment
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += blank(src[i]); i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    // Quoted strings
    if (ch === '"' || ch === "'") {
      const q = ch;
      out += q; i++;
      while (i < n && src[i] !== q && src[i] !== '\n') {
        if (src[i] === '\\') { out += ' '; i++; }
        out += blank(src[i] ?? ''); i++;
      }
      if (i < n) { out += src[i]; i++; }
      continue;
    }
    // Template literal (or resuming after a `${}` expression)
    if (ch === '`' || (ch === '}' && templateDepth.length && templateDepth[templateDepth.length - 1] === braceDepth)) {
      if (ch === '}') templateDepth.pop();
      out += ch; i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { out += ' '; i++; out += blank(src[i] ?? ''); i++; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          out += '${'; i += 2;
          templateDepth.push(braceDepth);
          break;
        }
        out += blank(src[i]); i++;
      }
      if (i < n && src[i] === '`') { out += '`'; i++; }
      continue;
    }
    if (ch === '{') braceDepth++;
    if (ch === '}') braceDepth--;
    out += ch; i++;
  }
  return out;
}

const BROWSER_GLOBAL_RE = /(?<![\w$.])(window|document)\s*\??\.\s*[A-Za-z_$]/g;
const GUARD_LOOKBACK_LINES = 3;

/**
 * Returns unguarded `window.` / `document.` references in a source string.
 * A reference is considered guarded if a `typeof window|document` check appears
 * on the same line or within the previous GUARD_LOOKBACK_LINES lines
 * (covers multi-line ternaries and `if (typeof window !== 'undefined') {` blocks).
 */
export function findUnguardedBrowserRefs(source) {
  const code = stripCommentsAndStrings(source);
  const lines = code.split('\n');
  const violations = [];
  lines.forEach((line, idx) => {
    BROWSER_GLOBAL_RE.lastIndex = 0;
    let m;
    while ((m = BROWSER_GLOBAL_RE.exec(line)) !== null) {
      const global = m[1];
      const window = lines.slice(Math.max(0, idx - GUARD_LOOKBACK_LINES), idx + 1).join('\n');
      const guardRe = new RegExp(`typeof\\s+(globalThis\\.)?${global}\\b`);
      if (!guardRe.test(window)) {
        violations.push({ line: idx + 1, global, text: source.split('\n')[idx].trim() });
      }
    }
  });
  return violations;
}

/**
 * Parses static and dynamic imports of `engineName` (from './<engineName>.js' or
 * any relative path resolving to src/<engineName>.js) and returns the local
 * binding names, plus whether any binding is invoked (call, `new`, or member call).
 */
export function analyzeEngineUsage(source, fileAbsPath, engineName) {
  const code = stripCommentsAndStrings(source);
  const engineAbs = join(SRC_DIR, `${engineName}.js`);
  const locals = new Set();

  // Need original text for specifiers (strings are blanked in `code`).
  const importRe = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(source)) !== null) {
    const [, clause, spec] = m;
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(fileAbsPath), spec.endsWith('.js') ? spec : `${spec}.js`);
    if (target !== engineAbs) continue;

    const nsMatch = clause.match(/\*\s+as\s+([\w$]+)/);
    if (nsMatch) locals.add(`${nsMatch[1]}.${engineName}`).add(`${nsMatch[1]}.default`);

    const defMatch = clause.match(/^\s*([\w$]+)\s*(,|$)/);
    if (defMatch) locals.add(defMatch[1]);

    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const [imported, alias] = part.trim().split(/\s+as\s+/);
        if (!imported) continue;
        if (imported === engineName || imported === 'default') locals.add(alias || imported);
      }
    }
  }

  // Dynamic import: const { X } = await import('./X.js')
  const dynRe = new RegExp(`import\\(\\s*['"][^'"]*\\/${engineName}(\\.js)?['"]\\s*\\)`);
  const hasDynamicImport = dynRe.test(source);
  if (hasDynamicImport) locals.add(engineName);

  const invoked = [...locals].some(local => {
    const esc = local.replace(/[.$]/g, ch => `\\${ch}`);
    const callRe = new RegExp(
      `(?<![\\w$.])(new\\s+${esc}\\s*\\(|${esc}\\s*\\.\\s*[\\w$]+\\s*\\(|${esc}\\s*\\()`
    );
    // Strip the import statements themselves before checking invocation.
    const body = code.replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]*['"]\s*;?/g, '');
    return callRe.test(body);
  });

  return { imported: locals.size > 0, locals: [...locals], invoked };
}

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const report = [];

function it(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✔ [PASS]\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \x1b[31m✖ [FAIL]\x1b[0m ${name}`);
    console.error(`    ${String(err.message).split('\n').join('\n    ')}`);
    report.push({ name, message: err.message });
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

console.log('\n==================================================================');
console.log('  ARCHITECTURE INVARIANTS GATE (static analysis)');
console.log('==================================================================\n');

const srcFiles = walkJs(SRC_DIR);

console.log('--- 0. Analyzer self-checks ---');

it('stripCommentsAndStrings removes comments and literal contents but keeps code', () => {
  const sample = [
    "// window.alert('x')",
    "/* document.body */ const a = 1;",
    "const s = 'window.location';",
    "const t = `document.title ${window.innerWidth}`;"
  ].join('\n');
  const out = stripCommentsAndStrings(sample);
  assert.equal(out.split('\n').length, 4, 'line structure preserved');
  assert.ok(!/window\.alert/.test(out), 'line comment stripped');
  assert.ok(!/document\.body/.test(out), 'block comment stripped');
  assert.ok(!/window\.location/.test(out), 'string literal stripped');
  assert.ok(!/document\.title/.test(out), 'template text stripped');
  assert.ok(/window\.innerWidth/.test(out), 'template expression kept');
});

it('findUnguardedBrowserRefs flags bare refs and accepts typeof-guarded refs', () => {
  assert.equal(findUnguardedBrowserRefs('const w = window.innerWidth;').length, 1);
  assert.equal(findUnguardedBrowserRefs('document.querySelector("#a");').length, 1);
  assert.equal(findUnguardedBrowserRefs("const w = typeof window !== 'undefined' ? window.innerWidth : 0;").length, 0);
  assert.equal(findUnguardedBrowserRefs(
    "const c = (typeof window !== 'undefined' && window.crypto)\n  ? window.crypto\n  : null;"
  ).length, 0, 'multi-line ternary guard');
  assert.equal(findUnguardedBrowserRefs("if (typeof document !== 'undefined') {\n  document.title = 'x';\n}").length, 0);
  assert.equal(findUnguardedBrowserRefs("if (typeof window !== 'undefined') {}\ndocument.title = 'x';").length, 1,
    'a window guard does not guard document');
  assert.equal(findUnguardedBrowserRefs('const myWindow = obj.window.x; this.document.y();').length, 0,
    'member access on other objects is not a global ref');
});

it('analyzeEngineUsage distinguishes imported-only from imported+invoked', () => {
  const fake = join(SRC_DIR, 'Fake.js');
  const onlyImport = "import { CombatDamageEngine } from './CombatDamageEngine.js';\nconst x = 1;";
  const staticCall = "import { CombatDamageEngine } from './CombatDamageEngine.js';\nCombatDamageEngine.dealDamage({}, s);";
  const ctor = "import AbilityEngine from './AbilityEngine.js';\nconst e = new AbilityEngine();";
  const aliased = "import { ZoneTransitionMatrix as ZTM } from './ZoneTransitionMatrix.js';\nZTM.moveCard(p, 'a', 'hand', 'exile');";
  const commented = "import { CombatDamageEngine } from './CombatDamageEngine.js';\n// CombatDamageEngine.dealDamage();";
  const other = "import { CombatDamageEngine } from './elsewhere/CombatDamageEngine.js';\nCombatDamageEngine.dealDamage();";

  assert.deepEqual(
    [analyzeEngineUsage(onlyImport, fake, 'CombatDamageEngine').imported, analyzeEngineUsage(onlyImport, fake, 'CombatDamageEngine').invoked],
    [true, false]
  );
  assert.equal(analyzeEngineUsage(staticCall, fake, 'CombatDamageEngine').invoked, true);
  assert.equal(analyzeEngineUsage(ctor, fake, 'AbilityEngine').invoked, true);
  assert.equal(analyzeEngineUsage(aliased, fake, 'ZoneTransitionMatrix').invoked, true);
  assert.equal(analyzeEngineUsage(commented, fake, 'CombatDamageEngine').invoked, false, 'commented calls ignored');
  assert.equal(analyzeEngineUsage(other, fake, 'CombatDamageEngine').imported, false, 'path must resolve to src/<Engine>.js');
});

// ---------------------------------------------------------------------------
console.log('\n--- 1. INV-ARCH-HEADLESS: no unguarded browser globals outside allow-list ---');

const isAllowlisted = relPath => HEADLESS_ALLOWLIST.some(entry =>
  entry.endsWith('/') ? relPath.startsWith(entry) : relPath === entry
);

it('allow-list entries exist on disk (no stale exemptions)', () => {
  const stale = HEADLESS_ALLOWLIST.filter(e => !existsSync(join(ROOT_DIR, e)));
  assert.deepEqual(stale, [], `Stale HEADLESS_ALLOWLIST entries: ${stale.join(', ')}`);
});

const headlessScanned = srcFiles.filter(f => !isAllowlisted(rel(f)));

it(`headless modules (${headlessScanned.length} files) contain no unguarded window./document. references`, () => {
  assert.ok(headlessScanned.length > 0, 'expected headless modules to scan');
  const violations = [];
  for (const file of headlessScanned) {
    for (const v of findUnguardedBrowserRefs(readFileSync(file, 'utf8'))) {
      violations.push(`${rel(file)}:${v.line}  [${v.global}]  ${v.text}`);
    }
  }
  assert.deepEqual(violations, [], `Unguarded browser global references:\n${violations.join('\n')}`);
});

// ---------------------------------------------------------------------------
console.log('\n--- 2. INV-ARCH-WIRED: rule engines imported and invoked by production code ---');

const productionFiles = srcFiles.filter(f => !WIRING_EXCLUDED_FILES.includes(rel(f)));

function findWiringConsumers(engineName) {
  const engineFile = join(SRC_DIR, `${engineName}.js`);
  return productionFiles
    .filter(f => f !== engineFile)
    .map(f => ({ file: rel(f), ...analyzeEngineUsage(readFileSync(f, 'utf8'), f, engineName) }))
    .filter(r => r.imported);
}

const wiring = Object.fromEntries(REQUIRED_ENGINES.map(e => [e, findWiringConsumers(e)]));

it('every required engine module exists in src/', () => {
  const missing = REQUIRED_ENGINES.filter(e => !existsSync(join(SRC_DIR, `${e}.js`)));
  assert.deepEqual(missing, [], `Missing engine modules: ${missing.join(', ')}`);
});

it('KNOWN_UNWIRED_ENGINES only references required engines', () => {
  const unknown = KNOWN_UNWIRED_ENGINES.filter(e => !REQUIRED_ENGINES.includes(e));
  assert.deepEqual(unknown, [], `Unknown entries in KNOWN_UNWIRED_ENGINES: ${unknown.join(', ')}`);
});

for (const engine of REQUIRED_ENGINES.filter(e => !KNOWN_UNWIRED_ENGINES.includes(e))) {
  it(`${engine} is imported AND invoked by a production module`, () => {
    const consumers = wiring[engine];
    const invokers = consumers.filter(c => c.invoked).map(c => c.file);
    assert.ok(
      invokers.length > 0,
      `${engine} is dead code in production. Importers: [${consumers.map(c => c.file).join(', ') || 'none'}], ` +
      'none of them invoke it. Wire it or add it to KNOWN_UNWIRED_ENGINES with a justification.'
    );
    console.log(`      ↳ invoked by: ${invokers.join(', ')}`);
  });
}

for (const engine of KNOWN_UNWIRED_ENGINES) {
  it(`[KNOWN_UNWIRED ratchet] ${engine} is still unwired (remove from KNOWN_UNWIRED_ENGINES once wired)`, () => {
    const invokers = wiring[engine].filter(c => c.invoked).map(c => c.file);
    assert.deepEqual(
      invokers, [],
      `${engine} is now invoked by [${invokers.join(', ')}]. ` +
      'Remove it from KNOWN_UNWIRED_ENGINES in test/verify_architecture_invariants.js to lock the invariant in.'
    );
    console.warn(`      \x1b[33m⚠ ${engine} has no production invoker (tracked debt for next Goal)\x1b[0m`);
  });
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. INV-ARCH-SUITES: every test suite is executed by test/run_all.js ---');

const testFiles = readdirSync(TEST_DIR).filter(f => f.endsWith('.js')).sort();

it('run_all.js references only existing suite files', () => {
  const missing = ALL_SUITES.filter(s => !testFiles.includes(s));
  assert.deepEqual(missing, [], `run_all.js lists missing suites: ${missing.join(', ')}`);
});

it('no orphan test files (each is in run_all.js or SUITE_EXCLUSIONS with a reason)', () => {
  const orphans = testFiles.filter(f => !ALL_SUITES.includes(f) && !(f in SUITE_EXCLUSIONS));
  assert.deepEqual(orphans, [], `Orphan test files not executed by npm test: ${orphans.join(', ')}`);
});

it('no alias/stub suites (every executed suite contains its own assertions)', () => {
  const stubs = ALL_SUITES.filter(s => {
    const code = stripCommentsAndStrings(readFileSync(join(TEST_DIR, s), 'utf8'));
    const hasAssertions = /\bassert(\.\w+)?\s*\(/.test(code);
    return !hasAssertions;
  });
  assert.deepEqual(stubs, [], `Suites without assertions (aliases/stubs): ${stubs.join(', ')}`);
});

it('no suite is listed twice in run_all.js', () => {
  const dupes = ALL_SUITES.filter((s, i) => ALL_SUITES.indexOf(s) !== i);
  assert.deepEqual(dupes, [], `Duplicated suites: ${dupes.join(', ')}`);
});

it('package.json "test" script runs the unified runner', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
  assert.match(pkg.scripts?.test || '', /node\s+test\/run_all\.js/, 'npm test must invoke test/run_all.js');
});

// ---------------------------------------------------------------------------
console.log('\n--- 4. INV-ARCH-NO-DUPES: no root-level copies of src/ modules ---');

it('project root holds no duplicate of a src/ module', () => {
  const srcNames = new Set(readdirSync(SRC_DIR).filter(f => f.endsWith('.js')));
  const rootDupes = readdirSync(ROOT_DIR).filter(f => srcNames.has(f));
  assert.deepEqual(rootDupes, [], `Duplicate modules in project root (keep only src/ copy): ${rootDupes.join(', ')}`);
});

// ---------------------------------------------------------------------------

console.log('\n==================================================================');
console.log(`  ARCHITECTURE GATE RESULTS: ${passed} passed, ${failed} failed`);
if (KNOWN_UNWIRED_ENGINES.length) {
  console.log(`  Tracked debt (KNOWN_UNWIRED_ENGINES): ${KNOWN_UNWIRED_ENGINES.join(', ')}`);
}
console.log('==================================================================\n');

if (failed > 0) {
  console.error('\x1b[31mARCHITECTURE GATE FAILED:\x1b[0m');
  for (const r of report) console.error(`  - ${r.name}`);
  process.exit(1);
}
