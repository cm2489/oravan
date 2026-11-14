/*
 * The America/New_York calendar day of an instant, as 'YYYY-MM-DD' — the
 * client-safe twin of `etDay` in lib/moment-updates-gate.mjs.
 *
 * Why a second copy: the gate module is the write-time law for the whole
 * updates file (2,000+ lines, none of it a browser's business), and a client
 * component must not pull it into a page bundle just to ask what day it is.
 * This file imports nothing, the same posture as lib/freshness-state.ts.
 * tests/eastern-day.unit.spec.ts pins the two against each other across the
 * clock changes and the midnights, so they cannot drift.
 *
 * Why it exists at all: the Big Question pages are prerendered, so the "today"
 * the server computes is the build's. A visitor's own clock is the only
 * "today" that is true when they read — see components/MomentQuietDay.tsx.
 */
export function easternDay(now: number): string {
  const d = new Date(now);
  if (!Number.isFinite(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
