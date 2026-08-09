/**
 * Twice-daily hot-bill refresh (audit §4 Alt B / §5 item 3). REFRESH-ONLY:
 * updates status/last_action_date/last_action_text/urgency_score/issue_tags
 * for bills ALREADY in data/bills.json, using the same "~100 most-recently-
 * updated across the whole 119th Congress" Congress.gov window
 * scripts/sync-bills.mjs's recent-first pass uses (scripts/congress-fetch.mjs,
 * shared so the two scripts can't drift).
 *
 *   node --env-file=.env.local scripts/hot-bills.mjs
 *
 * Decodes NOTHING. A brand-new bill discovered here is left for the nightly
 * sync (scripts/sync-bills.mjs) - that script is the only place the
 * decode-before-publish gate runs, so this script must never publish an
 * undecoded bill. Zero Anthropic usage: needs only CONGRESS_API_KEY. This is
 * the tradeoff named up front in the audit's Alt B - a bill that's brand new
 * AND breaking mid-day still waits until the next 07:30 UTC nightly sync to
 * actually appear on the site; only bills already in the corpus get same-day
 * status/urgency freshness from this pass.
 *
 * Runs 2x/day (.github/workflows/hot-bills.yml, 17:00 + 22:00 UTC - inside
 * the US legislative day) between nightly syncs, so a floor vote or markup
 * that happens mid-day is reflected in effectiveUrgency (lib/urgency.mjs)
 * same-day instead of sitting stale until the next morning's sync. Also
 * directly improves lib/freshness.ts's `newestAction` signal (scanned live
 * from data/bills.json's last_action_date values), independent of
 * data/sync-state.json - this script intentionally never touches
 * sync-state.json; that file's lastRun/lastSync are the NIGHTLY sync's own
 * "did the job run" / "how far has the backlog scan processed" signals, and
 * conflating a same-day refresh pass with the sync cursor would work against
 * lib/freshness-state.ts's honesty model, not for it.
 *
 * Since 2026-08-09 the run refuses to spend anything on a window that isn't
 * actually recent (assessRecentWindow), because for a week in July 2026 it
 * did exactly that in green — see the tripwire's comment below.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  CONGRESS,
  RECENT_WINDOW_MAX_STALE_DAYS,
  assessRecentWindow,
  cg,
  fetchRecentlyUpdated,
  refreshBillFields,
  slugOf,
  updateSlug,
} from './congress-fetch.mjs';

const FETCH_LIMIT = Number(process.env.HOT_BILLS_FETCH_LIMIT ?? 100);

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const bySlug = new Map(bills.map((b) => [slugOf(b), b]));

console.log(`hot-bill refresh: fetching up to ${FETCH_LIMIT} most-recently-updated bills`);
const recent = await fetchRecentlyUpdated(FETCH_LIMIT);

// ---- recency tripwire (2026-08-09) --------------------------------------
// This script used to consume the window blind. Between 2026-07-16 and
// 2026-07-23 the descending sort silently stopped applying (a percent-encoded
// "+" that Congress.gov ignores without erroring - the full account is in
// assessRecentWindow's comment in scripts/congress-fetch.mjs, lines 65-71 of
// that file for the encoding itself), so this job spent a week refreshing the
// OLDEST hundred bills of the Congress twice a day and reporting "100
// refreshed" in green. Nothing downstream could catch it; only the DATES in
// the page can. Check them before spending ~100 detail requests on them.
//
// Fail rather than warn-and-continue: this runs twice a day, not hourly, so a
// red is a signal and not noise; and refreshing an eighteen-month-old window
// is not merely useless, it writes a corpus-wide no-op commit that makes the
// pipeline look alive while the freshness it exists to provide is gone.
// Exiting BEFORE the write means a bad window commits nothing at all.
const window = assessRecentWindow(recent, { maxStaleDays: RECENT_WINDOW_MAX_STALE_DAYS });
if (!window.ok) {
  console.log(`::error::hot-bill refresh aborted - ${window.reason}. Newest updateDate seen: ${window.newest ?? '(none)'}. The "most recently updated" window is not returning recent bills; check the sort parameter reaches Congress.gov as "updateDate+desc" (scripts/congress-fetch.mjs's fetchRecentlyUpdated) before trusting any freshness this job reports. Nothing was written.`);
  process.exit(1);
}
console.log(`window recency OK: newest updateDate ${window.newest} (${window.staleDays}d old, limit ${RECENT_WINDOW_MAX_STALE_DAYS}d)`);

let refreshed = 0, newSkipped = 0, partialSkipped = 0, failed = 0;
for (const u of recent) {
  const type = u.type.toLowerCase();
  const slug = updateSlug(u);
  const existing = bySlug.get(slug);
  if (!existing) {
    newSkipped++; // brand-new bill - decode-before-publish waits for the nightly sync
    continue;
  }
  try {
    const { bill: d } = await cg(`/bill/${CONGRESS}/${type}/${u.number}`);
    // A 200 with no readable latestAction leaves the bill exactly as it was
    // rather than downgrading it to committee/null - counted and logged here
    // because this workflow has no verify step that would catch it later.
    if (refreshBillFields(existing, d) === 'refreshed') refreshed++;
    else partialSkipped++;
  } catch (e) {
    failed++;
    console.error(`FAIL ${slug}: ${e.message}`);
  }
}

writeFileSync('data/bills.json', JSON.stringify(bills));
console.log(
  `DONE: ${refreshed} refreshed, ${newSkipped} new bill(s) skipped (nightly sync decodes those), ${partialSkipped} skipped: partial payload (left untouched), ${failed} failed; corpus ${bills.length}`
);
if (failed > recent.length / 2) process.exit(1); // mostly-failed run: don't let CI commit garbage
