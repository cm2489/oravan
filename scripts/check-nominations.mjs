/**
 * The SENATE NOMINATION data gate. Runs in CI beside check-moments.mjs, and
 * again (with --strict) right after scripts/sync-nominations.mjs writes.
 *
 *   node scripts/check-nominations.mjs            # CI: structure hard, novel text warns
 *   node scripts/check-nominations.mjs --strict   # nightly sync: novel text fails too
 *
 * Stdlib only, plus the import-free lib/nomination-status.mjs — so this runs
 * on bare node with no TS loader, like the other check-*.mjs gates.
 *
 * ── WHAT IS HARD, AND WHAT ONLY WARNS, AND WHY THE SPLIT EXISTS ────────────
 * Every check below is a HARD failure except one: the sweep for action text
 * no rule in lib/nomination-status.mjs classifies.
 *
 * The hard checks all test OUR CODE against data it produced — slug identity,
 * the stored status matching what the mapper returns for the stored sentence,
 * the terminal-set drift pin, the civilian-only filter. They cannot break
 * because Congress did something new; they break only if a change to this
 * repo broke them, which is exactly what a PR-blocking gate is for.
 *
 * The unclassified sweep is different in kind: it tests DATA, and the data
 * changes nightly. Owner ruling 2026-08-04 (the journey-corpus sweep,
 * scripts/check-journey-corpus.mjs) settled this shape once already — a
 * novel record sentence landed by the nightly sync must not red the CI of
 * unrelated PRs. It fires where the data changes. So here it prints a
 * ::warning:: in the PR-CI run (visible, attributable, non-blocking) and
 * fails hard under --strict, which only the sync step passes. An
 * unclassified record is also HONEST, not corrupt: lib/nomination-status.mjs
 * returns `unclassified` and every surface must render neutral, claim-free
 * copy for it — the posture of lib/journey.ts's floorActionChamber rule 7.
 *
 * The tripwire additionally refuses to pass on a corpus too small to prove
 * anything, the same guard check-journey-corpus.mjs applies with its
 * `floorVote.length < 50` floor: a sweep over an empty file is not a clean
 * sweep, it is no sweep.
 *
 * NAMING: "nomination" here always means a SENATE nomination (PN), never the
 * "domain nomination" family in lib/embed-referrer.ts.
 */
import { readFileSync } from 'node:fs';
import {
  NOMINATION_STATUSES,
  STORED_NOMINATION_STATUSES,
  TERMINAL_NOMINATION_STATUSES,
  UNCLASSIFIED_NOMINATION_STATUS,
  execCalendarNumber,
  mapNominationStatus,
} from '../lib/nomination-status.mjs';
import { congressGovNominationUrl, nominationSlug } from './nominations-fetch.mjs';

const STRICT = process.argv.includes('--strict');

/* A sweep over a near-empty corpus proves nothing. 500 is well under the 857
   civilian nominations the 119th Congress held on 2026-08-06 and well over
   anything a truncated or half-written file would contain. */
const MIN_CORPUS = 500;

/* The six uniformed services are the ONLY `organization` values Congress.gov
   puts on military nominations, and they never appear on a civilian one:
   measured 2026-08-06 over all 2,039 records of the 119th, the military set
   is exactly {Coast Guard, Navy, Air Force, Army, Space Force, Marine Corps,
   null} and its intersection with the 80 civilian organizations is empty.
   The REAL filter is nominationType.isCivilian in scripts/nominations-fetch.mjs;
   this is a redundant tripwire that catches that filter silently inverting or
   being dropped, which would otherwise show up only as a file that quadrupled
   in size. If a genuine CIVILIAN nomination ever carries one of these strings,
   narrow this check — do not delete it. */
const MILITARY_ORGANIZATIONS = new Set([
  'Coast Guard', 'Navy', 'Air Force', 'Army', 'Space Force', 'Marine Corps',
]);

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);

/* ---- 0. The constant sets must not have drifted apart. -------------------
   Same belt-and-braces check-moments.mjs runs on TERMINAL_VEHICLE_STATUSES:
   a runtime assertion so the gate does not depend on a test it never runs. */
for (const s of TERMINAL_NOMINATION_STATUSES) {
  if (!NOMINATION_STATUSES.includes(s)) {
    fail(`TERMINAL_NOMINATION_STATUSES member "${s}" is not in NOMINATION_STATUSES — lib/nomination-status.mjs's two sets have drifted`);
  }
}
if (STORED_NOMINATION_STATUSES.length !== NOMINATION_STATUSES.length + 1) {
  fail(`STORED_NOMINATION_STATUSES should be the ${NOMINATION_STATUSES.length} classified statuses plus "${UNCLASSIFIED_NOMINATION_STATUS}"; it has ${STORED_NOMINATION_STATUSES.length} members`);
}

/* ---- 1. The file parses and is big enough to prove something. ---- */
let corpus;
try {
  corpus = JSON.parse(readFileSync(new URL('../data/nominations.json', import.meta.url), 'utf8'));
} catch (e) {
  console.error(`::error::check-nominations: data/nominations.json is missing or unparseable (${e.message}). It is written by scripts/sync-nominations.mjs and committed; a gate that skips when its data is absent is not a gate.`);
  process.exit(1);
}
if (!Array.isArray(corpus)) {
  console.error('::error::check-nominations: data/nominations.json is not an array');
  process.exit(1);
}
if (corpus.length < MIN_CORPUS) {
  console.error(`::error::check-nominations: only ${corpus.length} nominations — below the ${MIN_CORPUS} floor, so the sweeps below would prove nothing. Check the sync output.`);
  process.exit(1);
}

/* ---- 1b. The persisted cursor is in the ONLY shape Congress.gov accepts.
   Checked HERE and not in scripts/verify-sync.mjs (which pins the bill
   cursor `lastSync` the same way) precisely so a corrupted nomination
   cursor fails in the nomination lane instead of reddening the bill sync.
   Congress.gov 400s on both a bare date and a fractional-seconds timestamp;
   that has already cost two multi-day outages on the bill side. */
try {
  const state = JSON.parse(readFileSync(new URL('../data/sync-state.json', import.meta.url), 'utf8'));
  const cursor = state.nominationsLastSync;
  if (cursor !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(cursor)) {
    fail(`sync-state.json nominationsLastSync (${JSON.stringify(cursor)}) is not a seconds-precision ISO-8601 datetime (YYYY-MM-DDTHH:MM:SSZ) — Congress.gov 400s on both bare-date and fractional-seconds fromDateTime cursors`);
  }
} catch (e) {
  fail(`data/sync-state.json is unreadable (${e.message})`);
}

/* ---- 2. Per-record structure and identity. ---- */
const REQUIRED_STRINGS = ['citation', 'part_number', 'congress_gov_url'];
const NULLABLE_STRINGS = [
  'nominee_description', 'organization', 'received_date', 'last_action_date',
  'last_action_text', 'update_date',
];
const seenSlugs = new Map();
const unclassified = [];

for (const n of corpus) {
  const id = n?.citation ?? '(no citation)';
  if (!n || typeof n !== 'object') {
    fail(`a corpus entry is not an object`);
    continue;
  }
  for (const k of REQUIRED_STRINGS) {
    if (typeof n[k] !== 'string' || !n[k]) fail(`${id}: ${k} must be a non-empty string`);
  }
  for (const k of NULLABLE_STRINGS) {
    if (n[k] !== null && typeof n[k] !== 'string') fail(`${id}: ${k} must be a string or null`);
  }
  if (!Number.isInteger(n.pn_number)) fail(`${id}: pn_number must be an integer`);
  if (!Number.isInteger(n.congress_number)) fail(`${id}: congress_number must be an integer`);
  if (n.exec_calendar_number !== null && !Number.isInteger(n.exec_calendar_number)) {
    fail(`${id}: exec_calendar_number must be an integer or null`);
  }

  // Identity is the citation, and the slug must reproduce its arithmetic —
  // `PN{number}` when the part is zero, `PN{number}-{part}` with leading
  // zeros stripped otherwise. A drift here silently collapses distinct
  // people who share a PN number (see nominationSlug's doc comment).
  const part = Number(n.part_number);
  const expectedCitation = `PN${n.pn_number}${Number.isInteger(part) && part > 0 ? `-${part}` : ''}`;
  if (n.citation !== expectedCitation) {
    fail(`${id}: citation disagrees with (pn_number=${n.pn_number}, part_number=${n.part_number}), which would build "${expectedCitation}"`);
  }
  const slug = nominationSlug({
    number: n.pn_number, partNumber: n.part_number, congress: n.congress_number,
  });
  if (!/^pn-\d+(-\d+)?-\d+$/.test(slug)) fail(`${id}: malformed slug "${slug}"`);
  if (seenSlugs.has(slug)) {
    fail(`duplicate slug "${slug}": ${seenSlugs.get(slug)} and ${id} are stored as different records`);
  }
  seenSlugs.set(slug, id);

  const expectedUrl = congressGovNominationUrl(n.pn_number, n.part_number, n.congress_number);
  if (n.congress_gov_url !== expectedUrl) {
    fail(`${id}: congress_gov_url is "${n.congress_gov_url}", builder says "${expectedUrl}"`);
  }

  /* ---- 3. Status: stored value must be what the mapper says TODAY. ----
     This is the code<->data pin. It cannot be broken by novel Senate
     vocabulary (an unseen sentence maps to `unclassified` on both sides);
     it breaks when someone edits a rule in lib/nomination-status.mjs
     without re-running the sync, which would leave the file asserting a
     status the code no longer derives. */
  if (!STORED_NOMINATION_STATUSES.includes(n.status)) {
    fail(`${id}: status "${n.status}" is not in STORED_NOMINATION_STATUSES`);
  }
  const mapped = mapNominationStatus(n.last_action_text);
  if (n.status !== mapped) {
    fail(`${id}: stored status "${n.status}" but mapNominationStatus("${(n.last_action_text ?? '').slice(0, 70)}...") now returns "${mapped}" — re-run scripts/sync-nominations.mjs`);
  }

  /* ---- 4. THE ONE THAT MATTERS. A finished nomination must never carry a
     live status. The bill mapper gets this wrong on 511 live records
     (congress-fetch.mjs:103 matches `yea-nay vote` and returns floor_vote
     for "Confirmed by the Senate by Yea-Nay Vote"), which is why nominations
     have their own mapper at all. Asserted here against the STORED data,
     independently of the mapper, so the corpus itself can never publish a
     pending-vote claim over a finished one. */
  const text = n.last_action_text ?? '';
  if (/\bconfirmed by the senate\b/i.test(text) && n.status !== 'confirmed') {
    fail(`${id}: record says "Confirmed by the Senate" but status is "${n.status}" — a live claim over a finished nomination`);
  }
  if (/\breturned to the president\b/i.test(text) && n.status !== 'returned') {
    fail(`${id}: record says "Returned to the President" but status is "${n.status}"`);
  }
  if (/\bwithdrawal\b/i.test(text) && n.status !== 'withdrawn') {
    fail(`${id}: record says the nomination was withdrawn but status is "${n.status}"`);
  }

  /* ---- 5. The calendar number is a printed fact or it is absent. ----
     "Calendar No. DESK" is the Senate's own placeholder for a placement with
     no number yet; Number('DESK') is NaN, and a NaN that reached a surface
     would print "Calendar No. NaN" beside a real Senate claim. */
  const expectedCalendar = execCalendarNumber(n.last_action_text);
  if (n.exec_calendar_number !== expectedCalendar) {
    fail(`${id}: exec_calendar_number is ${n.exec_calendar_number}, the record text yields ${expectedCalendar}`);
  }
  if (n.exec_calendar_number !== null && n.status !== 'exec_calendar') {
    fail(`${id}: carries calendar number ${n.exec_calendar_number} but status is "${n.status}"`);
  }

  /* ---- 6. Civilian-only tripwire. See MILITARY_ORGANIZATIONS above. ---- */
  if (n.organization && MILITARY_ORGANIZATIONS.has(n.organization)) {
    fail(`${id}: organization "${n.organization}" is a uniformed service — the civilian-only filter in scripts/nominations-fetch.mjs has stopped working`);
  }

  if (n.status === UNCLASSIFIED_NOMINATION_STATUS) unclassified.push(n);
}

/* ---- 7. THE CORPUS TRIPWIRE (warn in CI, fail under --strict). ---- */
for (const n of unclassified) {
  const msg = `check-nominations: unclassified action text on ${n.citation} — add a rule to lib/nomination-status.mjs's mapNominationStatus; until then this record renders neutral, claim-free copy: ${n.last_action_text}`;
  (STRICT ? errors : warnings).push(msg);
}

for (const w of warnings) console.warn(`::warning::${w}`);
for (const e of errors) console.error(`::error::${e}`);

if (errors.length) {
  console.error(`check-nominations: ${errors.length} failure(s) over ${corpus.length} nominations.`);
  process.exit(1);
}
const counts = {};
for (const n of corpus) counts[n.status] = (counts[n.status] ?? 0) + 1;
const pending = corpus.filter((n) => !TERMINAL_NOMINATION_STATUSES.has(n.status)).length;
console.log(
  `check-nominations passed${STRICT ? ' (strict)' : ''}: ${corpus.length} civilian nominations, ` +
    `${pending} pending, ${unclassified.length} unclassified. ` +
    Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')
);
