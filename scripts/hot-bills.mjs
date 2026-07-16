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
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CONGRESS, cg, fetchRecentlyUpdated, refreshBillFields, slugOf, updateSlug } from './congress-fetch.mjs';

const FETCH_LIMIT = Number(process.env.HOT_BILLS_FETCH_LIMIT ?? 100);

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const bySlug = new Map(bills.map((b) => [slugOf(b), b]));

console.log(`hot-bill refresh: fetching up to ${FETCH_LIMIT} most-recently-updated bills`);
const recent = await fetchRecentlyUpdated(FETCH_LIMIT);

let refreshed = 0, newSkipped = 0, failed = 0;
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
    refreshBillFields(existing, d);
    refreshed++;
  } catch (e) {
    failed++;
    console.error(`FAIL ${slug}: ${e.message}`);
  }
}

writeFileSync('data/bills.json', JSON.stringify(bills));
console.log(
  `DONE: ${refreshed} refreshed, ${newSkipped} new bill(s) skipped (nightly sync decodes those), ${failed} failed; corpus ${bills.length}`
);
if (failed > recent.length / 2) process.exit(1); // mostly-failed run: don't let CI commit garbage
