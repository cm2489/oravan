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

const PATTERNS = [
  { name: 'rostra', re: /rostra/i },
  { name: 'cabina', re: /cabina/i },
  { name: 'be the change', re: /be[\s-]+the[\s-]+change/i },
  { name: 'sé el cambio', re: /s[eé][\s-]+el[\s-]+cambio/i },
];

// Founder-exempted in writing — see docs/migration/decisions.md (M0, M2, R1).
// `max: Infinity` = verbatim historical record; numeric max = exactly-known
// held literals, so a regression past that count still fails. A stale entry
// (allowlisted file with zero matches) fails too: remove the entry in the
// same PR that removes the last literal.
const ALLOWLIST = [
  { path: 'lib/local.ts', max: 4, note: 'M2/M2-bis: legacy localStorage migration keys (cabina.*, rostra.*)' },
  { path: '.github/workflows/refresh-legislators.yml', max: 2, note: 'S8-held `--repo` slugs; flip + remove this entry in the repo-rename PR' },
  { prefix: 'docs/migration/', max: Infinity, note: 'M0/R1: verbatim migration history' },
  { path: 'docs/plans/2026-07-06-002-oravan-migration-kickoff.md', max: Infinity, note: 'M0: migration kickoff, verbatim' },
  { path: 'docs/plans/2026-07-03-001-feat-launch-buildout-plan.md', max: Infinity, note: 'R1: dated historical record' },
  { path: 'docs/plans/2026-07-06-state-expansion-triage-spec.md', max: Infinity, note: 'R1: dated historical record' },
  { path: 'docs/ideation/2026-07-01-post-june-audit-ideation.md', max: Infinity, note: 'R1: dated historical record' },
  { path: 'docs/ideation/2026-07-02-embeds-spec.md', max: Infinity, note: 'R1: dated historical record' },
  { path: 'docs/ideation/2026-07-02-mcp-spec.md', max: Infinity, note: 'R1: dated historical record' },
  { path: 'docs/ideation/2026-07-02-monetization-strategy.md', max: Infinity, note: 'R1: dated historical record' },
  { path: 'docs/ideation/2026-07-05-build-gtm-strategy.md', max: Infinity, note: 'R1: dated historical record' },
  { path: 'docs/solutions/two-clock-district-boundaries.md', max: Infinity, note: 'R1: dated historical record' },
];

// Lockfile churn is npm's business (name field synced from package.json,
// which IS scanned); binaries can't carry the strings meaningfully.
const SKIP = /^package-lock\.json$|\.(png|jpg|jpeg|gif|ico|woff2?)$/;

// --- Self-test: the gate must catch known-bad fixtures before it may pass the tree.
const FIXTURES_BAD = ['Rostra rules', 'CABINA-nine', 'be the change', 'Be The Change', 'sé el cambio', 'se  el cambio', 'data-rostra-widget'];
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
  let count = 0;
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        count++;
        if (!allowance) {
          console.error(`::error file=${file},line=${i + 1}::check-naming: "${p.name}" survivor: ${line.trim().slice(0, 120)}`);
          failures++;
        }
      }
    }
  });
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
  if ((allowUsage.get(a) ?? 0) === 0) {
    console.error(`::error::check-naming: stale allowlist entry ${a.path ?? a.prefix} (zero matches) — remove it (${a.note})`);
    failures++;
  }
}

if (failures) {
  console.error(`check-naming: ${failures} failure(s). Exemptions live in docs/migration/decisions.md — additions require a written founder decision.`);
  process.exit(1);
}
console.log(`check-naming passed: ${files.length} tracked files scanned, ${ALLOWLIST.length} written exemptions honored.`);
