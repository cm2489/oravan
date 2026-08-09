/**
 * Moments CI gate — CLI wrapper (same split as check-rollover-tripwire.mjs /
 * lib/rollover-tripwire.mjs: the logic lives import-free in
 * lib/moments-gate.mjs so the unit suite can import it; this file does the
 * file I/O and the exit code). Same check-script family as
 * check-messages-parity.mjs / check-naming.mjs.
 *
 *   node scripts/check-moments.mjs
 *
 * Validates data/moments.json: schema, bilingual parity, vehicle resolution
 * against data/bills.json (or data/nominations.json, for a vehicle whose
 * `kind` says so), the callable-record rule for nomination vehicles,
 * qualifying-signal shape, dates, the 6-live cap, and the
 * forbidden-vocabulary lint in both languages. Exits 1 on any violation;
 * warnings (terminal vehicles, elapsed review_by) print without failing — see
 * lib/moments-gate.mjs's header for why those are soft.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkMoments,
  lintForbidden,
  SIGNAL_TYPES,
  TERMINAL_NOMINATION_VEHICLE_STATUSES,
  TERMINAL_VEHICLE_STATUSES,
  VEHICLE_KINDS,
  vehicleKind,
} from '../lib/moments-gate.mjs';
import { TERMINAL_NOMINATION_STATUSES } from '../lib/nomination-status.mjs';
import { TERMINAL_STATUSES } from '../lib/urgency.mjs';
import { nominationSlug } from './nominations-fetch.mjs';

// The gate's import-free copy of the terminal set must never drift from the
// real one (also pinned in tests/moments.unit.spec.ts, but a check script
// should not trust a test it doesn't run).
const a = [...TERMINAL_VEHICLE_STATUSES].sort().join(',');
const b = [...TERMINAL_STATUSES].sort().join(',');
if (a !== b) {
  console.error(`::error::check-moments: lib/moments-gate.mjs TERMINAL_VEHICLE_STATUSES (${a}) drifted from lib/urgency.mjs TERMINAL_STATUSES (${b})`);
  process.exit(1);
}

// And the nomination half of the same set, against lib/nomination-status.mjs.
// A drift here would let a CONFIRMED nomination vehicle skip the terminal
// warning — the quiet direction, since the warning is the only thing that
// tells a reviewer a newly-opened moment is already over.
const na = [...TERMINAL_NOMINATION_VEHICLE_STATUSES].sort().join(',');
const nb = [...TERMINAL_NOMINATION_STATUSES].sort().join(',');
if (na !== nb) {
  console.error(`::error::check-moments: lib/moments-gate.mjs TERMINAL_NOMINATION_VEHICLE_STATUSES (${na}) drifted from lib/nomination-status.mjs TERMINAL_NOMINATION_STATUSES (${nb})`);
  process.exit(1);
}

/*
 * Same pin, one file over: the gate's copies of the enumerable constants
 * against lib/moments.ts's — QUALIFYING_SIGNAL_TYPES (the set the UI
 * enumerates) and VEHICLE_KINDS (the set that decides which corpus a vehicle
 * slug is looked up in). Both matter for the same reason the terminal set
 * does, and the signal-type one matters MORE because its failure is silent:
 * the gate would accept a type app/[locale]/questions/[id]/page.tsx has no
 * label for, and that page falls through to printing the raw slug in both
 * languages rather than throwing.
 *
 * lib/moments.ts is TypeScript, and this script runs on bare node with no TS
 * loader, so the constants are read out of the SOURCE TEXT — the same
 * stdlib-only scan scripts/check-server-json.mjs uses for lib/site.ts's
 * SITE_ORIGIN. A regex over source is exactly as brittle as it sounds, which
 * is why an unparseable declaration is a hard failure below rather than a
 * skip: a drift check that quietly stops checking is worse than none.
 *
 * Compared in ORDER, unlike the terminal sets above — both sides are ordered
 * lists (not Sets), so an in-order compare keeps the two declarations
 * readable side by side in a diff.
 */
const momentsTs = readFileSync(new URL('../lib/moments.ts', import.meta.url), 'utf8');
const readTsStringList = (name) => {
  const declaration = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(momentsTs);
  if (!declaration) {
    console.error(`::error::check-moments: could not find \`export const ${name} = [...] as const;\` in lib/moments.ts — that drift check cannot run. If the declaration moved or changed shape, update this scan; do not delete it.`);
    process.exit(1);
  }
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};
for (const [name, gateCopy] of [
  ['QUALIFYING_SIGNAL_TYPES', SIGNAL_TYPES],
  ['VEHICLE_KINDS', VEHICLE_KINDS],
]) {
  const c = gateCopy.join(',');
  const d = readTsStringList(name).join(',');
  if (c !== d) {
    console.error(`::error::check-moments: lib/moments-gate.mjs copy (${c}) drifted from lib/moments.ts ${name} (${d})`);
    process.exit(1);
  }
}

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const moments = read('data/moments.json');
const bills = read('data/bills.json');
const nominations = read('data/nominations.json');

/*
 * The slug of one STORED nomination row.
 *
 * scripts/nominations-fetch.mjs's nominationSlug takes an API LIST ITEM
 * ({number, partNumber, congress}), not a data/nominations.json row
 * ({pn_number, part_number, congress_number}) — and because it reads missing
 * fields rather than throwing on them, handing it a stored row returns the
 * cheerful garbage "pn-undefined-119" for EVERY record, collapsing the whole
 * corpus into a one-element set. (Written that way here first, on 2026-08-06,
 * and caught only by seeding a vehicle by hand.) The same three-line adapter
 * appears at scripts/check-nominations.mjs:157 and scripts/sync-nominations.mjs:78;
 * it is repeated rather than shared because both of those are N1's and this
 * gate must not reach across into them, but the collapse tripwire below is
 * what makes the repetition safe.
 */
const storedNominationSlug = (n) =>
  nominationSlug({ number: n.pn_number, partNumber: n.part_number, congress: n.congress_number });

/*
 * One slug set and one status lookup PER KIND. Both are built unconditionally
 * even though data/moments.json holds no nomination vehicle today: a gate
 * that only wires up the corpus it currently needs is a gate that fails open
 * the first time the data changes.
 *
 * Importing scripts/nominations-fetch.mjs costs nothing here — its
 * CONGRESS_API_KEY is checked by cg() at first fetch, never at import.
 */
const nominationSlugs = new Set(nominations.map(storedNominationSlug));

/* THE COLLAPSE TRIPWIRE. Every stored nomination has a distinct slug —
   scripts/check-nominations.mjs proves that against the same file — so any
   shortfall here means the adapter above stopped reading the row's fields and
   this gate is now validating vehicles against a corpus of one. That is a
   fail-OPEN, and it is invisible until somebody authors the vehicle it lets
   through wrong, which is exactly how long it went unnoticed the first time. */
if (nominationSlugs.size !== nominations.length) {
  console.error(`::error::check-moments: ${nominations.length} nominations collapsed to ${nominationSlugs.size} distinct slug(s) — the stored-row slug adapter is reading the wrong fields, so nomination vehicles would be validated against a corpus that is not there. Fix the adapter; do not delete this check.`);
  process.exit(1);
}

/*
 * THE CALLABLE-RECORD SET — the nominations whose Congress.gov record actually
 * carries the description sentence, which is the only thing a nomination's call
 * script is ever grounded in (lib/nomination-script.ts's header).
 *
 * Built as a SECOND set rather than by narrowing `nominationSlugs` above, so
 * the gate can tell the two failures apart: a slug nobody has ever heard of is
 * "does not exist in data/nominations.json — never invent nomination facts",
 * and a real record with nothing to write a script from gets its own sentence
 * naming the field. Collapsing them would have told an author to go looking for
 * a typo in a slug that is correct.
 */
const describedNominationSlugs = new Set(
  nominations
    .filter((n) => typeof n.nominee_description === 'string' && n.nominee_description.trim() !== '')
    .map(storedNominationSlug)
);

const slugsByKind = {
  bill: new Set(bills.map((x) => x.full_identifier)),
  nomination: nominationSlugs,
};
const statusByKind = {
  bill: new Map(bills.map((x) => [x.full_identifier, x.status])),
  nomination: new Map(nominations.map((n) => [storedNominationSlug(n), n.status])),
};
const statusFor = (vehicle) => statusByKind[vehicleKind(vehicle)]?.get(vehicle.slug);

/*
 * The chrome copy gets the SAME vocabulary lint as the curated content.
 *
 * The lint only ever read data/moments.json, so the surrounding UI strings —
 * which sit beside that content and read as the same voice — were ungoverned.
 * Three English strings had drifted to "fight", a word this project's own
 * table bans in a Moment's prose, while their Spanish siblings had
 * independently chosen neutral words (pre-launch audit, 2026-07-25). A rule
 * that governs the paragraph but not the heading above it is half a rule.
 */
const messages = { en: read('messages/en.json'), es: read('messages/es.json') };
const chromeViolations = [];
for (const [lang, doc] of Object.entries(messages)) {
  const walk = (node, path) => {
    for (const [k, v] of Object.entries(node ?? {})) {
      const at = path ? `${path}.${k}` : k;
      if (typeof v === 'string') {
        for (const word of lintForbidden(v, lang)) {
          chromeViolations.push(`messages/${lang}.json ${at}: forbidden vocabulary "${word}" — Moments chrome shares the curated voice (spec §3.3)`);
        }
      } else if (v && typeof v === 'object') {
        walk(v, at);
      }
    }
  };
  walk(doc.moments, 'moments');
  // The `nominations` namespace is Moments chrome too — it renders inside the
  // vehicles grid on /questions/[id] and on the nomination page that grid
  // links to, in the same voice, so it takes the same lint. Adding the
  // namespace without adding it here would have re-opened exactly the gap the
  // 2026-07-25 audit closed: a rule that governs the paragraph but not the
  // heading above it is half a rule.
  walk(doc.nominations, 'nominations');
}

/*
 * The baseline for the new-vehicle terminality rule (owner ruling 2026-08-09):
 * data/moments.json as main has it, so the gate can tell a vehicle being ADDED
 * from one that already persists on a settled moment. Resolution order:
 *
 *   1. MOMENTS_BASE_REF, or the local `origin/main` ref — free, offline.
 *   2. A depth-1 fetch of origin/main, because ci.yml checks out at depth 1
 *      and a PR run has no origin/main ref without it. FETCH_HEAD is exactly
 *      "main as of this run", which is the same baseline the merge will face.
 *   3. Neither — a LOUD warning and the rule is skipped, never guessed. On
 *      pushes to main both refs equal HEAD, every pair is on the baseline,
 *      and the rule is a deliberate no-op: enforcement lives at PR time, the
 *      only path a moment enters this file (bots never write it).
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const git = (args, opts = {}) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts });
function baselineVehiclePairs() {
  const ref = process.env.MOMENTS_BASE_REF ?? 'origin/main';
  let base;
  try {
    base = JSON.parse(git(['show', `${ref}:data/moments.json`]));
  } catch {
    try {
      git(['fetch', '--no-tags', '--depth=1', 'origin', 'main'], { stdio: 'ignore' });
      base = JSON.parse(git(['show', 'FETCH_HEAD:data/moments.json']));
    } catch {
      return undefined;
    }
  }
  const pairs = new Set();
  for (const [id, m] of Object.entries(base)) {
    for (const v of m?.vehicles ?? []) if (v?.slug) pairs.add(`${id}|${v.slug}`);
  }
  return pairs;
}
const baselineVehicles = baselineVehiclePairs();
if (baselineVehicles === undefined) {
  console.warn('::warning::check-moments: no baseline for data/moments.json (no origin/main ref and the fetch failed) — the new-vehicle terminality rule was SKIPPED, not passed');
}

const { violations, warnings } = checkMoments(moments, slugsByKind, statusFor, {
  describedNominationSlugs,
  baselineVehicles,
});

for (const w of warnings) console.warn(`::warning::check-moments: ${w}`);
violations.push(...chromeViolations);
if (violations.length) {
  for (const v of violations) console.error(`::error::check-moments: ${v}`);
  console.error(`check-moments: ${violations.length} violation(s) in data/moments.json`);
  process.exit(1);
}
console.log('check-moments passed: data/moments.json is schema-valid, bilingual, vocabulary-clean, and inside the live cap.');
