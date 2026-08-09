/**
 * Nightly SENATE NOMINATION sync. Updates data/nominations.json from
 * Congress.gov's nomination list endpoint, then CI commits the diff.
 *
 *   node --env-file=.env.local scripts/sync-nominations.mjs
 *
 * Needs CONGRESS_API_KEY. NO Anthropic key, no AI, no spend of any kind: this
 * pipeline stores the government's own sentences and a status derived from
 * them by lib/nomination-status.mjs's rule table, and nothing else.
 *
 * ── WHY THIS IS A SEPARATE SCRIPT AND A SEPARATE WORKFLOW STEP ─────────────
 * The precedent is scripts/sync-coverage.mjs: a distinct concern, its own
 * entry point, its own step in sync-bills.yml, its own data file. Nothing
 * here can redden the bill sync. The bill corpus is the product's spine —
 * a nomination-side outage (Congress.gov changing a field, a novel action
 * shape, a rate limit) must never be able to cost a night of bill statuses,
 * and folding this into sync-bills.mjs would make exactly that possible.
 * The workflow step is additionally `continue-on-error: true`, matching the
 * Moment-updates step for the same reason.
 *
 * That `continue-on-error` is exactly why the structural gate had to move IN
 * HERE (2026-08-09). It makes every verdict downstream of this script
 * advisory, so a structurally corrupt corpus written to disk was committed
 * and deployed no matter what scripts/check-nominations.mjs said about it.
 * This script now runs those checks on the corpus it has built and refuses to
 * WRITE a failing one — the bill sync keeps its night, and nothing corrupt
 * can reach the commit, because nothing corrupt reaches the disk.
 *
 * ── CIVILIAN ONLY ──────────────────────────────────────────────────────────
 * See scripts/nominations-fetch.mjs's header. 859 of the 119th Congress's
 * 2,039 nominations are civilian; the other 1,180 are bulk military
 * promotion lists with no description and no nameable human.
 *
 * ── COST ───────────────────────────────────────────────────────────────────
 * Measured 2026-08-06: 95 nominations changed in the preceding 24 hours, so
 * a nightly incremental run is ONE free HTTP request at limit=250. The
 * one-time backfill is 9. Congress.gov's key is already a build-time secret;
 * this adds no new secret and no new quota.
 *
 * ── CURSOR SEMANTICS ───────────────────────────────────────────────────────
 * `data/sync-state.json`'s NEW `nominationsLastSync` key. It is deliberately
 * separate from `lastSync` (the bill cursor): the two pipelines make
 * independent progress, and a shared cursor would let a nomination-side
 * stall silently rewind the bill backlog scan or vice versa. When the key is
 * absent or empty this run does a FULL BACKFILL of the Congress instead.
 *
 * The cursor advances to the run start ONLY when the scan drained
 * (`complete`); otherwise it advances to the newest updateDate actually
 * read, so the next run resumes exactly there and never skips a window.
 *
 * Amended 2026-08-09: it does not advance AT ALL through a scan that read raw
 * records and wrote none of them, and the high-water mark counts only records
 * the run actually wrote. The old unconditional advance made the one silent,
 * permanent failure this script has — an upstream shape change (a renamed
 * `nominationType`) freezing the corpus forever while every night logged a
 * clean success. See the guard above the write for the two conditions and why
 * one is an error and the other only a warning.
 *
 * Per-record work CAN now be left undone, which is the other half of the same
 * amendment: a reply carrying no readable `latestAction` is skipped whole
 * rather than written (scripts/nominations-fetch.mjs's fail-closed guard), so
 * a degraded night can no longer blank a confirmed nomination's official
 * sentence and reopen its call rail.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { checkNominationCorpus } from './check-nominations.mjs';
import { toISODateTime } from './congress-fetch.mjs';
import {
  fetchNominationsSince,
  nominationScanVerdict,
  nominationSlug,
  readableNominationAction,
  refreshNominationFields,
  toNominationRecord,
} from './nominations-fetch.mjs';

// Raw API records read per run before the scan stops and defers the rest to
// the next night. 2,500 comfortably covers the whole 119th Congress (2,039),
// so the backfill completes in one run; a nightly incremental never comes
// close (95 on the busiest measured day).
const MAX_RECORDS = Number(process.env.MAX_NOMINATION_RECORDS ?? 2500);

const readJSON = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};

const state = readJSON('data/sync-state.json', {});
const existing = readJSON('data/nominations.json', []);

// Keyed by slug, which is also what dedupes the API's own duplicate rows:
// offset paging over a `sort=updateDate` window with many tied timestamps is
// not a stable order, and the 2026-08-06 full read returned PN129-12 and
// PN55-49 twice each (byte-identical). A Map absorbs that silently and
// correctly; an array append would have written both.
const bySlug = new Map(existing.map((n) => [nominationSlug({
  number: n.pn_number,
  partNumber: n.part_number,
  congress: n.congress_number,
}), n]));
const before = bySlug.size;

const cursor = state.nominationsLastSync ? toISODateTime(state.nominationsLastSync) : null;
const runStart = new Date().toISOString();
console.log(
  cursor
    ? `nomination sync since ${cursor}`
    : 'nomination sync: no cursor — FULL BACKFILL of the 119th Congress'
);

const { items, rawSeen, complete, shape } = await fetchNominationsSince(cursor, { maxRecords: MAX_RECORDS });
console.log(
  `read ${rawSeen} raw records (${shape.civilian} civilian, ${shape.military} military` +
    `${shape.unrecognized ? `, ${shape.unrecognized} UNRECOGNIZED` : ''})` +
    `${complete ? '' : ' (scan capped — more upstream)'}`
);

let added = 0;
let refreshed = 0;
let skippedPartial = 0;
let newestUpdate = null;
for (const item of items) {
  const slug = nominationSlug(item);
  const known = bySlug.get(slug);
  if (known) {
    // A reply with no readable latestAction leaves the record byte-identical
    // rather than blanking its official sentence and downgrading its status
    // to `unclassified` — see refreshNominationFields' fail-closed guard.
    if (refreshNominationFields(known, item) === 'refreshed') refreshed++;
    else skippedPartial++;
  } else {
    // Same refusal one step earlier: an unreadable reply mints nothing at
    // all, rather than a permanent record whose status was never read.
    const record = toNominationRecord(item);
    if (record) {
      bySlug.set(slug, record);
      added++;
    } else {
      skippedPartial++;
    }
  }
  // The cursor high-water mark counts only records we actually WROTE. A
  // skipped-partial record must not drag the cursor past itself: doing so
  // would retire the one thing that brings it back, since the next run's
  // window starts after the updateDate we just banked.
  if (
    item.updateDate &&
    (!newestUpdate || item.updateDate > newestUpdate) &&
    readableNominationAction(item)
  ) {
    newestUpdate = item.updateDate;
  }
}

/* Stable order so a nightly diff shows only what actually changed. bills.json
   is stored in arrival order, which is fine for a file nobody reads by eye;
   this one sorts by (number, part) so a reviewer can find a citation and so
   git never reports a thousand-line reshuffle because Congress.gov returned
   a page in a different order. */
const out = [...bySlug.values()].sort(
  (a, b) => a.pn_number - b.pn_number || Number(a.part_number) - Number(b.part_number)
);

// Never shrink: records this run did not see are carried forward untouched
// (they are in `bySlug` already). A run that read nothing therefore rewrites
// the same file rather than emptying it — the same "a partial night can only
// update or add, never silently shrink" property sync-coverage.mjs holds.
if (out.length < before) {
  console.error(`::error::sync-nominations: corpus would SHRINK ${before} -> ${out.length}; refusing to write.`);
  process.exit(1);
}

/* ── THE CURSOR MAY NOT ADVANCE THROUGH A SCAN THAT PRODUCED NOTHING ───────
   The cursor is the only thing that decides which window the next run reads,
   so advancing it is a claim: "everything before this point is handled." A
   run that read raw records and wrote NONE of them cannot support that claim,
   and advancing anyway is the one failure mode of this script that is both
   permanent and completely silent — every night afterwards reads a window
   starting after records it never ingested, finds nothing, advances again,
   and logs a clean success over a corpus frozen forever.

   TWO CONDITIONS, and they are different in kind.

   (1) shape.unrecognized > 0 — EXACT, and an error. Every live record carries
       nominationType.isCivilian XOR .isMilitary (re-measured over all 2,077
       records of the 119th on 2026-08-09). A record carrying neither cannot
       happen without an upstream change: a renamed field, a restructured
       object, a dropped one. That is precisely the shape change that would
       make isCivilianNomination return false across the board while every
       log line still read like a quiet night. It is not a blip and it does
       not heal itself, so the run exits non-zero at the very end (after the
       write, which is deliberate — see the exit at the bottom of this file).

   (2) rawSeen > 0 && added + refreshed === 0 — BROADER, and only a warning.
       Everything else that can produce a scan with nothing to show for it:
       a night of degraded replies (every record skipped_partial), or simply
       a window in which only military bulk lists moved. The second is a
       perfectly ordinary night, which is exactly why this cannot be an error
       — a gate that fires on normal nights gets ignored, and then it is not
       a gate. Holding the cursor is free either way: the window is
       re-read next run, the ingest is idempotent, and MAX_RECORDS (2,500)
       comfortably exceeds the whole Congress, so a held cursor cannot
       snowball into an unreadable window.

   No consecutive-zero counter is persisted for (2). It was considered and
   rejected: a counter is a heuristic standing in for "did the filter break",
   and condition (1) answers that question exactly, with no false positives to
   train anyone to ignore it. A counter on top would fire on a quiet stretch
   of military-only nights — real, harmless, and indistinguishable to it. */
const verdict = nominationScanVerdict({
  rawSeen,
  added,
  refreshed,
  unrecognized: shape.unrecognized,
});
if (verdict === 'shape_changed') {
  console.error(
    `::error::sync-nominations: ${shape.unrecognized} of ${rawSeen} raw records carry a nominationType that is neither isCivilian nor isMilitary. ` +
      'Congress.gov has changed the shape this sync filters on, so the civilian filter can no longer be trusted. ' +
      'The cursor was NOT advanced, so nothing is lost — re-run after fixing nominationTypeOf in scripts/nominations-fetch.mjs.'
  );
} else if (verdict === 'stalled') {
  console.warn(
    `::warning::sync-nominations: read ${rawSeen} raw records and wrote none (${skippedPartial} skipped as unreadable, ${shape.civilian} civilian seen). ` +
      'The cursor was NOT advanced, so this window is re-read next run. Normal when only military lists moved; investigate if it repeats.'
  );
}

// Advance only as far as we actually read, and only through a scan that
// produced something. See the header's cursor note and the block above.
if (verdict === 'ok') {
  state.nominationsLastSync = toISODateTime(
    complete ? runStart : (newestUpdate ?? cursor ?? runStart)
  );
}

/* ── THE STRUCTURAL GATE RUNS BEFORE THE WRITE, NOT AFTER THE COMMIT ───────
   scripts/check-nominations.mjs's hard checks all test OUR CODE against data
   it produced — slug identity, the citation arithmetic, the stored status
   matching what the mapper derives, the URL builder, the civilian-only
   tripwire. Until 2026-08-09 the only place they ran against FRESH data was a
   sync-bills.yml step marked `continue-on-error: true`, which made every one
   of them advisory exactly where it mattered: a structurally corrupt corpus
   was written, committed and deployed, and the run stayed green. (The step's
   own comment only ever justified advisory treatment for the unclassified
   SWEEP, which is a different check and stays advisory below.)

   Running the gate here instead of hardening that step is what lets both
   promises hold at once. This script's header says nothing in the nomination
   lane may cost the bill sync its night, and a hard workflow step would do
   precisely that — the bill corpus is the product's spine and is already
   committed by the time this runs. A corpus that never reaches disk cannot be
   committed by anything downstream, so the harm is gone without the workflow
   ever having to fail. It is the same posture scripts/verify-sync.mjs holds
   for bills, in the lane that had no equivalent.

   `--strict` is NOT passed: the unclassified sweep stays advisory here for
   the reason its own gate documents (owner ruling 2026-08-04 — an honest
   `unclassified` record must not cost the corpus its night), and keeps
   failing loudly in its own workflow step. */
const structural = checkNominationCorpus(out, state, { strict: false });
for (const w of structural.warnings) console.warn(`::warning::${w}`);
if (structural.errors.length) {
  for (const e of structural.errors) console.error(`::error::${e}`);
  console.error(
    `::error::sync-nominations: ${structural.errors.length} structural failure(s) in the corpus this run built. ` +
      'NOTHING was written — data/nominations.json and data/sync-state.json are untouched on disk, so the damaged corpus cannot be committed or deployed. ' +
      'The previous corpus stands until this is fixed.'
  );
  process.exit(1);
}

writeFileSync('data/nominations.json', JSON.stringify(out));
writeFileSync('data/sync-state.json', JSON.stringify(state, null, 2));

const counts = {};
for (const n of out) counts[n.status] = (counts[n.status] ?? 0) + 1;
console.log(
  `DONE: ${added} added, ${refreshed} refreshed, ${skippedPartial} skipped (unreadable reply), ` +
    `corpus ${out.length} (was ${before}); cursor -> ${state.nominationsLastSync}` +
    `${verdict === 'ok' ? '' : ' (HELD — see the warning above)'}`
);
console.log(`STATUS: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (counts.unclassified) {
  // Not fatal here — an unclassified record is HONEST (it renders neutral,
  // claim-free copy), and refusing to write the whole corpus over one novel
  // Senate sentence would trade a small gap for a stale file. The loud
  // version of this is scripts/check-nominations.mjs's sweep, which names
  // each offending sentence so a rule can be added to
  // lib/nomination-status.mjs.
  console.log(`::warning::sync-nominations: ${counts.unclassified} record(s) carry action text no rule in lib/nomination-status.mjs classifies — run scripts/check-nominations.mjs to see them.`);
}

/* THE SHAPE TRIPWIRE EXITS NON-ZERO, and it does so HERE — after the write,
   not instead of it. The two halves are separate decisions:

     · The records this run DID read are real and were mapped normally, so
       writing them is right; discarding them would throw away good data over
       a problem they are not part of.
     · The cursor is held (above), so nothing this run failed to see is
       skipped, and the next run re-reads the same window.

   What is left is the notification, and it has to be loud: an upstream field
   rename is not self-healing and every night that passes with it unfixed is a
   night the corpus silently stops growing. The workflow step is
   `continue-on-error: true`, so this reddens the STEP and its annotation
   without costing the bill sync its night — exactly the split this lane is
   built on. */
if (verdict === 'shape_changed') process.exit(1);
