/**
 * Zero-survivor naming gate (Oravan migration, done-criterion 3): CI fails on
 * any case-insensitive match of the retired names — the pre-migration product
 * names and the old-app name screened for ported material — in tracked file
 * CONTENTS or FILENAMES, except the founder-exempted-in-writing entries below
 * (docs/migration/decisions.md records each exemption). Modeled on the other
 * self-test-first gates: the patterns are proven against fixtures before the
 * tree is scanned, so a broken regex fails loudly instead of passing silently.
 * Stdlib only.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Pattern sources are assembled from fragments so THIS file carries no banned
// literal and needs no self-exemption (git ls-files scans it like any other).
const FRAG = { r: 'ros' + 'tra', c: 'cab' + 'ina', b: 'be[\\s-]+the[\\s-]+change', s: 's[e\u00E9][\\s-]+el[\\s-]+cambio' };
const PATTERNS = [
  { name: FRAG.r, re: new RegExp(FRAG.r, 'i') },
  { name: FRAG.c, re: new RegExp(FRAG.c, 'i') },
  { name: 'old-app name (EN)', re: new RegExp(FRAG.b, 'i') },
  { name: 'old-app name (ES)', re: new RegExp(FRAG.s, 'i') },
];

// Founder-exempted in writing — see docs/migration/decisions.md (M0, M2, R1, N1).
// `max: Infinity` = verbatim historical record; numeric max = exactly-known
// held literals, so a regression past that count still fails. A stale entry
// (allowlisted file with zero matches) fails too: remove the entry in the
// same PR that removes the last literal.
// Two optional fields, added for N1 (decisions.md, 2026-09-24):
//   `only`       — the exemption covers that ONE pattern name; a match of any
//                  other pattern in the same file still fails as a survivor.
//   `mayBeEmpty` — the entry is exempt from the stale rule, for a generated
//                  file whose normal state is zero matches.
const ALLOWLIST = [
  { path: 'lib/local.ts', max: 4, note: 'M2/M2-bis: legacy localStorage migration keys, both pre-migration generations' },
  { prefix: 'docs/migration/', max: Infinity, note: 'M0/R1: verbatim migration history' },
  // 2026-08-05: the ideation/plans/press/teardown docs moved out of this
  // public repo (owner ruling — business strategy is not open source), so
  // their allowlist entries go with them; a stale entry fails this gate.
  { path: 'docs/solutions/two-clock-district-boundaries.md', max: Infinity, note: 'R1: dated historical record' },
  // N1: the second pattern is also an everyday Spanish noun, and the nightly
  // AI decode writes free Spanish prose here. No regex can tell the noun from
  // the name, so this one file is exempt from that one pattern only.
  { path: 'data/bills-es.json', only: FRAG.c, max: Infinity, mayBeEmpty: true, note: 'N1: nightly Spanish corpus, second pattern only' },
];

// Lockfile churn is npm's business (name field synced from package.json,
// which IS scanned); binaries can't carry the strings meaningfully.
const SKIP = /^package-lock\.json$|\.(png|jpg|jpeg|gif|ico|woff2?)$/;

// --- Self-test: the gate must catch known-bad fixtures before it may pass the tree.
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const FIXTURES_BAD = [
  cap(FRAG.r) + ' rules', FRAG.c.toUpperCase() + '-nine', 'be the' + ' change',
  'Be The' + ' Change', 's\u00E9 el' + ' cambio', 'se  el' + ' cambio', 'data-' + FRAG.r + '-widget',
];
const FIXTURES_GOOD = ['Oravan', 'rostrum', 'cambio climático', 'el cambio llega', 'change the beat'];
for (const s of FIXTURES_BAD) {
  if (!PATTERNS.some((p) => p.re.test(s))) {
    console.error(`::error::check-naming self-test failed: pattern set missed known-bad fixture "${s}"`);
    process.exit(1);
  }
}
for (const s of FIXTURES_GOOD) {
  if (PATTERNS.some((p) => p.re.test(s))) {
    console.error(`::error::check-naming self-test failed: pattern set false-positived on "${s}"`);
    process.exit(1);
  }
}

const allowanceFor = (file) =>
  ALLOWLIST.find((a) => (a.path ? a.path === file : file.startsWith(a.prefix)));

// Scan one file's contents. `allowed` counts the matches its allowance covers;
// `survivors` are matches that fail (no allowance, or a pattern outside `only`).
function scanContent(content, allowance) {
  let allowed = 0;
  const survivors = [];
  content.split('\n').forEach((line, i) => {
    for (const p of PATTERNS) {
      if (!p.re.test(line)) continue;
      if (allowance && (!allowance.only || allowance.only === p.name)) allowed++;
      else survivors.push({ line: i + 1, name: p.name, text: line.trim().slice(0, 120) });
    }
  });
  return { allowed, survivors };
}
const isStale = (a, used) => used === 0 && !a.mayBeEmpty;

// --- Self-test: the N1 scoped exemption behaves as decided, before the tree scan.
{
  const es = 'data/bills-es.json';
  const a = allowanceFor(es);
  const fail = (why) => {
    console.error(`::error::check-naming self-test failed: ${why}`);
    process.exit(1);
  };
  if (!a || a.only !== FRAG.c) fail(`${es} has no allowance scoped to the second pattern`);
  const noun = scanContent(`"summary": "la ${FRAG.c} del avi\u00F3n"`, a);
  if (noun.survivors.length || noun.allowed !== 1) fail(`second-pattern match in ${es} was not exempted`);
  for (const other of [cap(FRAG.r) + ' app', 'be the' + ' change', 's\u00E9 el' + ' cambio']) {
    if (scanContent(other, a).survivors.length !== 1) fail(`"${other}" in ${es} was exempted; only the second pattern may be`);
  }
  if (isStale(a, 0)) fail(`${es} entry trips the stale rule at zero matches`);
  if (!isStale({ path: 'x', max: 1 }, 0)) fail('stale rule no longer fires for an ordinary entry');
  if (scanContent(`${FRAG.c}.prefs`, allowanceFor('messages/es.json')).survivors.length !== 1) {
    fail('second-pattern match outside the exempted file was not caught');
  }
}

const files = execSync('git ls-files', { encoding: 'utf8' }).trim().split('\n');
let failures = 0;
const allowUsage = new Map();

for (const file of files) {
  if (SKIP.test(file)) continue;
  const allowance = allowanceFor(file);

  // Filenames are in scope (a rename can hide in a path). Never allowlisted.
  for (const p of PATTERNS) {
    if (p.re.test(file)) {
      console.error(`::error::check-naming: FILENAME "${file}" matches banned pattern "${p.name}"`);
      failures++;
    }
  }

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue; // unreadable/binary: extensions above cover the committed set
  }
  const { allowed: count, survivors } = scanContent(content, allowance);
  for (const v of survivors) {
    console.error(`::error file=${file},line=${v.line}::check-naming: "${v.name}" survivor: ${v.text}`);
    failures++;
  }
  if (allowance) {
    allowUsage.set(allowance, (allowUsage.get(allowance) ?? 0) + count);
    if (count > allowance.max) {
      console.error(`::error::check-naming: ${file} has ${count} banned matches, allowlist permits ${allowance.max} (${allowance.note})`);
      failures++;
    }
  }
}

// Stale allowlist entries weaken the gate silently — fail them out.
for (const a of ALLOWLIST) {
  if (isStale(a, allowUsage.get(a) ?? 0)) {
    console.error(`::error::check-naming: stale allowlist entry ${a.path ?? a.prefix} (zero matches) — remove it (${a.note})`);
    failures++;
  }
}

if (failures) {
  console.error(`check-naming: ${failures} failure(s). Exemptions live in docs/migration/decisions.md — additions require a written founder decision.`);
  process.exit(1);
}
console.log(`check-naming passed: ${files.length} tracked files scanned, ${ALLOWLIST.length} written exemptions honored.`);
