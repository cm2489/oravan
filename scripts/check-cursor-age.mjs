/**
 * THE CURSOR-PROGRESS ALARM — the one check in the nightly that runs AFTER the
 * commit, and the only one allowed to (owner ruling 2026-08-12, N8-A2).
 *
 * WHY IT LEFT verify-sync.mjs. A stalled cursor says "we are behind"; it does
 * not say "the corpus is damaged". Those are different claims and they had
 * been wearing the same mechanism: the ceiling lived inside verify-sync.mjs,
 * which runs BEFORE sync-bills.yml's commit step, so on day 11 the commit was
 * skipped and NOTHING landed — not the night's already-paid AI decodes, not
 * coverage, not nominations, not the Moment updates. The backlog the check was
 * complaining about got strictly worse every night it fired, with no
 * self-healing path: the same stall recurs tomorrow, so main simply stops
 * advancing until a human intervenes.
 *
 * It is also, and this is the part that decides it, LESS honest that way. The
 * site's own freshness math reads the very same `lastSync`
 * (lib/freshness-state.ts, FRESHNESS_DEAD_WINDOW_DAYS = 21). Refusing the
 * commit freezes the site's staleness signal at an even older value, so
 * blocking the write makes the page claim to be fresher than it is. Committing
 * the frozen cursor and shouting is the truthful pair.
 *
 * SO: every INTEGRITY check stays where it was — parity, schema, corpus
 * uniformity, the count-drop floor, floor-signals evidence, moment-updates
 * retention, and the cursor's own FORMAT (a bare-date or fractional-seconds
 * cursor is corruption, not lateness: it 400s Congress.gov on every request
 * and has shipped two multi-day outages). Only the AGE comparison moved. A run
 * that trips this goes red, loudly, and the night's data is on main.
 *
 * WHY 10 DAYS, unchanged from verify-sync.mjs's 2026-07-16 promotion: it is
 * deliberately generous against a decode backlog that legitimately holds the
 * high-water mark back for real nights, and it sits comfortably below
 * lib/freshness-state.ts's FRESHNESS_DEAD_WINDOW_DAYS = 21 — the site's own
 * "this has gone genuinely dead" ceiling for the SAME value — so this fires
 * well before a visitor could see a dishonest "quiet week".
 *
 * Pure judgement + a thin script body, the same split as verifyMomentUpdates
 * and verifyFloorSignals: tests/nightly-pipeline.unit.spec.ts imports
 * cursorAgeVerdict directly, and pins both that this constant lives HERE
 * rather than in verify-sync.mjs and that the workflow runs this step after
 * the commit.
 */
import { readFileSync } from 'node:fs';

export const CURSOR_MAX_AGE_DAYS = 10;

/**
 * @param {{lastSync: unknown, now?: number}} args
 * @returns {{ok: boolean, ageDays: number | null, message: string}}
 */
export function cursorAgeVerdict({ lastSync, now = Date.now() }) {
  const parsed = typeof lastSync === 'string' ? Date.parse(lastSync) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    // The SHAPE of lastSync is verify-sync.mjs's business (it is corruption,
    // and it is caught before the commit). Reaching here with an unparseable
    // value means that gate was skipped or bypassed, so say so rather than
    // pretending to have measured an age.
    return {
      ok: false,
      ageDays: null,
      message: `sync-state.json lastSync (${JSON.stringify(lastSync)}) is not a parseable datetime — the pre-commit format gate in scripts/verify-sync.mjs should have caught this before the commit step`,
    };
  }
  const ageDays = (now - parsed) / 86_400_000;
  if (ageDays > CURSOR_MAX_AGE_DAYS) {
    return {
      ok: false,
      ageDays,
      message:
        `corpus cursor is ${Math.round(ageDays)} days old (lastSync ${lastSync}), past the ${CURSOR_MAX_AGE_DAYS}-day ceiling — ` +
        'the ascending backlog scan has stopped making real progress. THE NIGHT\'S DATA IS COMMITTED (this check runs after the commit, on purpose); ' +
        'what is broken is PROGRESS, not the corpus. Dispatch sync-bills.yml with a raised max_updates (and max_new_decodes with it) to drain the cohort.',
    };
  }
  return { ok: true, ageDays, message: `corpus cursor is ${ageDays.toFixed(1)} days old (ceiling ${CURSOR_MAX_AGE_DAYS})` };
}

// Script body only when executed directly — the same argv[1] guard
// scripts/sync-bills.mjs uses, so importing the judgement above reads no file.
if (/(^|\/)check-cursor-age\.mjs$/.test(process.argv[1] ?? '')) {
  const state = JSON.parse(readFileSync('data/sync-state.json', 'utf8'));
  const verdict = cursorAgeVerdict({ lastSync: state.lastSync });
  if (!verdict.ok) {
    console.error(`::error::${verdict.message}`);
    process.exit(1);
  }
  console.log(verdict.message);
}
