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
 * Unlike sync-bills.mjs, there is no freeze-on-incomplete-work high-water
 * mark, because there is no per-record work that can be left undone: every
 * record this run reads is fully resolved by reading it (no decode, no
 * budget, no gate). The one thing that CAN be incomplete is the paging
 * itself, so the cursor advances to the run start ONLY when the scan drained
 * (`complete`); otherwise it advances to the newest updateDate actually
 * read, so the next run resumes exactly there and never skips a window.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { toISODateTime } from './congress-fetch.mjs';
import {
  fetchNominationsSince,
  nominationSlug,
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

const { items, rawSeen, complete } = await fetchNominationsSince(cursor, { maxRecords: MAX_RECORDS });
console.log(`read ${rawSeen} raw records, ${items.length} civilian${complete ? '' : ' (scan capped — more upstream)'}`);

let added = 0;
let refreshed = 0;
let newestUpdate = null;
for (const item of items) {
  const slug = nominationSlug(item);
  const known = bySlug.get(slug);
  if (known) {
    refreshNominationFields(known, item);
    refreshed++;
  } else {
    bySlug.set(slug, toNominationRecord(item));
    added++;
  }
  if (item.updateDate && (!newestUpdate || item.updateDate > newestUpdate)) {
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

// Advance only as far as we actually read. See the header's cursor note.
state.nominationsLastSync = toISODateTime(
  complete ? runStart : (newestUpdate ?? cursor ?? runStart)
);

writeFileSync('data/nominations.json', JSON.stringify(out));
writeFileSync('data/sync-state.json', JSON.stringify(state, null, 2));

const counts = {};
for (const n of out) counts[n.status] = (counts[n.status] ?? 0) + 1;
console.log(
  `DONE: ${added} added, ${refreshed} refreshed, corpus ${out.length} (was ${before}); ` +
    `cursor -> ${state.nominationsLastSync}`
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
