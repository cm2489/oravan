/*
 * The urgency curve — the ONE copy. Imported by lib/core/bills.ts (the live
 * site's feed ordering), scripts/sync-coverage.mjs (which must agree with the
 * site on which bills are "top band"), and scripts/sync-bills.mjs (which
 * shares STATUS_BASE for its stored sync-time score). Plain .mjs with JSDoc
 * types so the TS lib, the node scripts, and the unit test all import it
 * unchanged.
 *
 * Read-time urgency, not stored: stored scores freeze the freshness bonus at
 * sync time, so a bill calendared six weeks ago keeps outranking everything
 * (the stale-CFPB-on-top bug — docs/solutions/stale-urgency-freeze.md).
 * Recompute from status + last action date with a staleness decay: no penalty
 * for two weeks, then a linear slide that drops a stale floor placement below
 * an active committee fight.
 *
 * The curve is pinned by tests/urgency.unit.spec.ts — tune it there first.
 */

/** Base urgency per bill status. @type {Record<string, number>} */
export const STATUS_BASE = {
  floor_vote: 0.9,
  passed_chamber: 0.75,
  conference: 0.75,
  markup: 0.65,
  committee: 0.45,
  signed: 0.3,
  vetoed: 0.3,
  introduced: 0.2,
};

/*
 * Enacted or rejected bills are past the call window: a signed law can't be
 * un-signed by a phone call, and a vetoed bill is settled. They must never
 * rank into now/moving no matter how fresh they look. (A veto can in theory
 * face an override vote, but the status model has no such state, so vetoed
 * reads as terminal here.)
 */
export const TERMINAL_STATUSES = new Set(['signed', 'vetoed']);

/**
 * Effective urgency at read time: status base + short freshness bonus
 * (+0.1 inside 3 days, +0.05 inside 7) − staleness decay (0.015/day after
 * day 14, capped at 0.45), clamped to [0.05, 1] and rounded to 3 decimals.
 *
 * `now` defaults to the real clock (every production caller); tests pass an
 * explicit instant to ask "what would the score be at time t" — the
 * corpus-stability guard in tests/corpus.ts needs the curve evaluated at
 * both ends of a CI run's build→assert window.
 *
 * @param {string} status
 * @param {string | null} lastActionDate
 * @param {number} [now]
 * @returns {number}
 */
export function effectiveUrgency(status, lastActionDate, now = Date.now()) {
  const base = STATUS_BASE[status] ?? 0.2;
  if (!lastActionDate) return base;
  const days = (now - new Date(lastActionDate).getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return base;
  const bonus = days < 3 ? 0.1 : days < 7 ? 0.05 : 0;
  const decay = days <= 14 ? 0 : Math.min(0.45, (days - 14) * 0.015);
  return Math.round(Math.max(0.05, Math.min(1, base + bonus - decay)) * 1000) / 1000;
}
