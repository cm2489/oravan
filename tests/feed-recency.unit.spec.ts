import { expect, test } from '@playwright/test';
// Relative imports (not '@/'), as in tests/docket.unit.spec.ts.
import { docketRung } from '../lib/docket.mjs';
import { insideSignalWindow, type DocketRung } from '../lib/docket';
import { billSlug, docketSignalFor, getActNowInWindow, getTopActions } from '../lib/core/bills';

/*
 * THE FEED KEEPS WHAT THE HOMEPAGE LEADS WITH (2026-09-29).
 *
 * The MCP `whats_moving` tool and both public feeds publish the act-now pool
 * inside a 7-day window (`getActNowInWindow`). Until 2026-09-29 that window was
 * tested on each bill's own `last_action_date`, so a bill on T0 — named by a
 * chamber's floor notice this week while its own record last moved in July —
 * led the homepage and was missing from the feed whose description says it is
 * "the same list the homepage shows" (S.J.Res. 197: Senate Daily Digest of
 * 2026-09-28, last action 2026-07-14).
 *
 * The window now reads the date of the signal that put the bill in the pool (a
 * live announcement's own date), then the last action. An announcement that is
 * no longer live — pulled, carried forward from a dark source, or past its own
 * horizon — sets no rung and no date, so it can never keep a bill in.
 *
 * Boundaries are ±1 day and never on the threshold, as in docket.unit.spec.ts.
 * The fixtures cannot reach lib/core/mcp.ts (it imports a `server-only`
 * module); the list those surfaces print is `getActNowInWindow`, which
 * whatsMoving calls unchanged apart from its topic filter and its cut.
 */

const NOW = Date.parse('2026-09-29T12:00:00Z');
const DAY = 86_400_000;
const WINDOW_DAYS = 7;
const CUTOFF = NOW - WINDOW_DAYS * DAY;
const dayOffset = (n: number) => new Date(NOW - n * DAY).toISOString().slice(0, 10);

// S.J.Res. 197's own record, dated 77 days before NOW.
const OLD_BILL = {
  status: 'floor_vote',
  last_action_text: 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 456.',
  last_action_date: dayOffset(77),
  congress_gov_url: 'https://www.congress.gov/bill/119th-congress/senate-joint-resolution/197',
};

function signal(over: Record<string, unknown> = {}, entry: Record<string, unknown> = {}) {
  return {
    tier0: {
      source: 'daily-digest',
      chamber: 'senate',
      quote: 'Senate will vote on the motion at 2:15 p.m.',
      quote_lang: 'en',
      quote_kind: 'digest_program_sentence',
      url: 'https://www.congress.gov/119/crec/2026/09/28/d28se6-1.htm',
      published: dayOffset(1),
      covers: dayOffset(0),
      covers_label: '10 a.m., Tuesday, September 29',
      track: 'unspecified',
      certainty: 'consideration',
      ...over,
    },
    fetched_at: new Date(NOW - 3_600_000).toISOString(),
    first_seen: new Date(NOW - 7_200_000).toISOString(),
    stale: false,
    ...entry,
  };
}

const rungOf = (b: typeof OLD_BILL, sig: unknown) => docketRung(b, sig, { now: NOW }) as DocketRung;

test.describe('insideSignalWindow · the fixture', () => {
  test('a bill with an old last action and a live announcement dated yesterday is kept', () => {
    const rung = rungOf(OLD_BILL, signal());
    expect(rung.tier).toBe('t0');
    expect(insideSignalWindow(OLD_BILL, rung, CUTOFF)).toBe(true);
  });

  test('the same bill with the announcement aged out is dropped', () => {
    // A Senate program's horizon is its meeting day plus a short grace; four
    // days on, the announcement is no longer a statement about this week.
    const aged = signal({ published: dayOffset(5), covers: dayOffset(4) });
    const rung = rungOf(OLD_BILL, aged);
    expect(rung.tier).not.toBe('t0');
    expect(rung.announced).toBeNull();
    expect(insideSignalWindow(OLD_BILL, rung, CUTOFF)).toBe(false);
  });

  test('a pulled (carried-forward) or dead-source announcement keeps nothing either', () => {
    const carried = signal({}, { stale: true });
    const dead = signal({}, { fetched_at: new Date(NOW - 49 * 3_600_000).toISOString() });
    for (const sig of [carried, dead]) {
      const rung = rungOf(OLD_BILL, sig);
      expect(rung.announced).toBeNull();
      expect(insideSignalWindow(OLD_BILL, rung, CUTOFF)).toBe(false);
    }
  });

  test('without any announcement the last action decides, one day either side of the window', () => {
    const inside = { ...OLD_BILL, last_action_date: dayOffset(WINDOW_DAYS - 1) };
    const outside = { ...OLD_BILL, last_action_date: dayOffset(WINDOW_DAYS + 1) };
    expect(insideSignalWindow(inside, rungOf(inside, null), CUTOFF)).toBe(true);
    expect(insideSignalWindow(outside, rungOf(outside, null), CUTOFF)).toBe(false);
  });

  test('a live announcement cannot drop a bill its own last action keeps', () => {
    // The fix only ever adds: a live announcement dated before the window
    // leaves a bill whose record moved inside it on the list, as before.
    const fresh = { ...OLD_BILL, last_action_date: dayOffset(2) };
    const rung = rungOf(fresh, signal({ published: dayOffset(WINDOW_DAYS + 1), covers: dayOffset(0) }));
    expect(rung.tier).toBe('t0');
    expect(insideSignalWindow(fresh, rung, CUTOFF)).toBe(true);
  });

  test('no date is invented: an undated bill with no live announcement is left out', () => {
    const undated = { ...OLD_BILL, last_action_date: null as unknown as string };
    expect(insideSignalWindow(undated, rungOf(undated, null), CUTOFF)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The committed data
 * ------------------------------------------------------------------ */

test.describe('the feed and the homepage, over the committed data', () => {
  const inWindow = (d: string | null | undefined, cutoff: number) =>
    Boolean(d) && new Date(d as string).getTime() >= cutoff;

  test('every shortlist bill whose signal is inside the window is on the feed', () => {
    const now = Date.now();
    const cutoff = now - WINDOW_DAYS * DAY;
    // As the homepage calls it (app/[locale]/page.tsx), and the feed's own cut.
    const shortlist = getTopActions(4);
    const feed = new Set(getActNowInWindow(WINDOW_DAYS, 'en', now).slice(0, 10).map(billSlug));
    test.skip(shortlist.length === 0, 'quiet week: the homepage shortlist is empty right now');
    for (const b of shortlist) {
      const slug = billSlug(b);
      const signalDate = docketSignalFor(slug, now)?.evidence?.date ?? b.last_action_date;
      if (inWindow(signalDate, cutoff)) expect(feed.has(slug), slug).toBe(true);
    }
  });

  test('no bill is on the feed that is outside the window by both of its dates', () => {
    const now = Date.now();
    const cutoff = now - WINDOW_DAYS * DAY;
    const listed = getActNowInWindow(WINDOW_DAYS, 'en', now);
    for (const b of listed) {
      const slug = billSlug(b);
      const signalDate = docketSignalFor(slug, now)?.evidence?.date ?? null;
      expect(inWindow(signalDate, cutoff) || inWindow(b.last_action_date, cutoff), slug).toBe(true);
    }
  });

  test('same pool, same order: the feed is the shortlist pool with the window applied, and never drops a bill the old last-action test kept', () => {
    const now = Date.now();
    const cutoff = now - WINDOW_DAYS * DAY;
    const pool = getTopActions(10_000).map(billSlug);
    const listed = getActNowInWindow(WINDOW_DAYS, 'en', now).map(billSlug);
    // Order-preserving subsequence of the pool.
    expect(listed.filter((s) => pool.includes(s))).toEqual(listed);
    expect(pool.filter((s) => listed.includes(s))).toEqual(listed);
    const oldRule = getTopActions(10_000)
      .filter((b) => inWindow(b.last_action_date, cutoff))
      .map(billSlug);
    for (const s of oldRule) expect(listed, s).toContain(s);
  });
});
