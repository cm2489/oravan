import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): mirrors tests/urgency.unit.spec.ts, whose curve
// this ladder replaced as the site's ordering.
import {
  DOCKET_TIERS,
  bandForRung,
  compareDocket,
  docketKey,
  docketRung,
  entersFloorWatch,
  isActNow,
  isDecidingNow,
  isSettledFloor,
  signalIsLive,
  t0Weight,
} from '../lib/docket.mjs';
import { SIGNAL_WINDOW_DAYS } from '../lib/urgency.mjs';
import { floorPendingChamber } from '../lib/journey';
import { billSlug, getFloorFeatureCandidates, getTopActions } from '../lib/core/bills';
import { actNowPoolAt, corpus, decidingNowAt, docketedAt, rungAt, slugOf } from './corpus';

/*
 * THE DOCKET LADDER (lib/docket.mjs) — the ordering that replaced
 * `effectiveUrgency` + `bandFloors` on every surface that answers "what is
 * Congress deciding right now".
 *
 * TWO KINDS OF TEST, and the split is deliberate.
 *
 * FIXTURES pin the RULES: one bill per rung, hand-written, with every date
 * expressed as an offset from a fixed instant. Boundary cases are always ±1 day
 * from a threshold and NEVER on it — a test that asserts the behaviour exactly
 * at the edge pins the comparison operator rather than the rule, and it is the
 * one assertion that legitimately flips when someone changes `<=` to `<` for an
 * unrelated reason.
 *
 * CORPUS SWEEPS pin the SHAPE, as ranges with a non-vacuity guard: the corpus
 * is nightly-synced, so any exact count here would be a scheduled failure. A
 * sweep that would pass on an empty set says so out loud instead (`expect(n)
 * .toBeGreaterThan(0)` before the real assertion), because a vacuous green is
 * the failure mode a corpus sweep is most prone to.
 */

const NOW = Date.parse('2026-08-12T12:00:00Z');
const dayOffset = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);

const CALENDAR = 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 552.';
const CLOTURE_FILED = 'Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4557)';
const CLOTURE_INVOKED = 'Cloture invoked in Senate by Yea-Nay Vote. 86 - 12. Record Vote Number: 402.';
const CLOTURE_DEAD =
  'Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 52 - 46.';
const MTP_CONSIDERED = 'Motion to proceed to measure considered in Senate. (CR S4401-4408)';
const LAID_BEFORE = 'Measure laid before Senate by motion. (consideration: CR S4390-4402)';
const MTP_REJECTED = 'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 52.';
const PASSED = 'Passed Senate without amendment by Unanimous Consent.';
const QUIET = 'Referred to the Committee on Finance.';

function bill(status: string, text: string | null, daysAgo: number) {
  return { status, last_action_text: text, last_action_date: dayOffset(daysAgo) };
}

function signal(over: Record<string, unknown> = {}, entry: Record<string, unknown> = {}) {
  return {
    tier0: {
      source: 'daily-digest',
      chamber: 'senate',
      quote: 'Senator Thune: the Senate will vote on the motion to invoke cloture on H.R. 3633.',
      quote_lang: 'en',
      quote_kind: 'digest_program_sentence',
      url: 'https://www.congress.gov/119/crec/2026/08/10/d10au6-1.htm',
      published: dayOffset(1),
      covers: dayOffset(-1),
      covers_label: '10 a.m., Thursday, August 13',
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

const tierOf = (b: ReturnType<typeof bill>, sig: unknown = null) =>
  docketRung(b, sig, { now: NOW }).tier;

/* ------------------------------------------------------------------ *
 * The rungs
 * ------------------------------------------------------------------ */

test.describe('docketRung · one fixture per rung', () => {
  test('T0: a live announcement, whatever the derived status says', () => {
    // THE F2 CASE, and the reason T0 admits any status: when a measure reaches
    // the floor Congress overwrites the action text and the sync derives
    // `committee` from what is left. A status gate made the week's biggest
    // bills invisible.
    expect(tierOf(bill('committee', 'Message on Senate action sent to the House.', 4), signal())).toBe('t0');
    expect(tierOf(bill('floor_vote', CALENDAR, 2), signal())).toBe('t0');
  });

  test('T1: the record says a vote is ripening — including the two rungs the backtest measured as missing', () => {
    expect(tierOf(bill('floor_vote', CLOTURE_FILED, 2))).toBe('t1');
    // K7(a): H.R. 6500 dropped out of the ladder for two days while it was
    // being debated on the Senate floor.
    expect(tierOf(bill('committee', MTP_CONSIDERED, 2))).toBe('t1');
    // K7(b): H.R. 5334 vanished between its 86-12 cloture and its 86-11 passage.
    expect(tierOf(bill('committee', CLOTURE_INVOKED, 2))).toBe('t1');
    expect(tierOf(bill('committee', LAID_BEFORE, 2))).toBe('t1');
  });

  test('T2: a dated calendar placement inside the window', () => {
    expect(tierOf(bill('floor_vote', CALENDAR, 2))).toBe('t2');
  });

  test('T3: it just cleared a gate, and a passage carries the just-passed annotation', () => {
    const passed = docketRung(bill('passed_chamber', PASSED, 2), null, { now: NOW });
    expect(passed.tier).toBe('t3');
    expect(passed.annotation).toBe('just_passed');
    const markup = docketRung(bill('markup', 'Ordered to be Reported by Voice Vote.', 2), null, { now: NOW });
    expect(markup.tier).toBe('t3');
    expect(markup.annotation).toBeNull();
  });

  test('T4: everything else, and a settled floor question is annotated rather than promoted', () => {
    expect(tierOf(bill('committee', QUIET, 2))).toBe('t4');
    for (const text of [CLOTURE_DEAD, MTP_REJECTED]) {
      const rung = docketRung(bill('floor_vote', text, 2), null, { now: NOW });
      expect(rung.tier, text).toBe('t4');
      expect(rung.annotation, text).toBe('just_decided');
    }
  });

  test('terminal bills are pinned to T4 and can never be annotated or announced', () => {
    for (const status of ['signed', 'vetoed']) {
      const rung = docketRung(bill(status, PASSED, 1), signal(), { now: NOW });
      expect(rung.tier, status).toBe('t4');
      expect(rung.terminal, status).toBe(true);
      expect(rung.annotation, status).toBeNull();
      expect(rung.announced, status).toBeNull();
    }
  });
});

test.describe('docketRung · the clock, checked either side of the window and never on it', () => {
  const inside = SIGNAL_WINDOW_DAYS - 1;
  const outside = SIGNAL_WINDOW_DAYS + 1;

  test('T1/T2/T3 hold one day inside the signal window', () => {
    expect(tierOf(bill('floor_vote', CLOTURE_FILED, inside))).toBe('t1');
    expect(tierOf(bill('floor_vote', CALENDAR, inside))).toBe('t2');
    expect(tierOf(bill('passed_chamber', PASSED, inside))).toBe('t3');
  });

  test('and every one of them falls to T4 one day outside it', () => {
    expect(tierOf(bill('floor_vote', CLOTURE_FILED, outside))).toBe('t4');
    expect(tierOf(bill('floor_vote', CALENDAR, outside))).toBe('t4');
    expect(tierOf(bill('passed_chamber', PASSED, outside))).toBe('t4');
  });

  test('an undated record is never fresh — the same rule amber has always run on', () => {
    const undated = { status: 'floor_vote', last_action_text: CLOTURE_FILED, last_action_date: null };
    expect(docketRung(undated, null, { now: NOW }).tier).toBe('t4');
  });

  test('a T0 announcement does NOT read the bill clock: the schedule has its own', () => {
    // The announcement is about the week ahead; the bill's last action can be
    // months old and about something else entirely. That is the point of it.
    expect(tierOf(bill('committee', QUIET, 400), signal())).toBe('t0');
  });
});

/* ------------------------------------------------------------------ *
 * T0 liveness — critic A-1
 * ------------------------------------------------------------------ */

test.describe('signalIsLive · a schedule stops being a claim about this week', () => {
  test('a live, re-observed announcement counts', () => {
    expect(signalIsLive(signal(), { now: NOW })).toBe(true);
  });

  test('a carried-forward signal does not — a dark source may rank, never crown', () => {
    expect(signalIsLive(signal({}, { stale: true }), { now: NOW })).toBe(false);
  });

  test('a file that stopped being refreshed does not: a dead workflow cannot keep asserting a schedule', () => {
    const stale = signal({}, { fetched_at: new Date(NOW - 47 * 3_600_000).toISOString() });
    const dead = signal({}, { fetched_at: new Date(NOW - 49 * 3_600_000).toISOString() });
    expect(signalIsLive(stale, { now: NOW })).toBe(true);
    expect(signalIsLive(dead, { now: NOW })).toBe(false);
  });

  test('an announcement whose own horizon has passed does not', () => {
    // A House week-list covers 7 days; a Senate program covers its meeting.
    expect(signalIsLive(signal({ source: 'billsthisweek', covers: dayOffset(6) }), { now: NOW })).toBe(true);
    expect(signalIsLive(signal({ source: 'billsthisweek', covers: dayOffset(9) }), { now: NOW })).toBe(false);
    expect(signalIsLive(signal({ covers: dayOffset(1) }), { now: NOW })).toBe(true);
    expect(signalIsLive(signal({ covers: dayOffset(4) }), { now: NOW })).toBe(false);
  });

  test('a signal with no tier0 block, or an unparseable stamp, is never live', () => {
    expect(signalIsLive(null, { now: NOW })).toBe(false);
    expect(signalIsLive({ fetched_at: 'not a date', tier0: {} }, { now: NOW })).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Ordering
 * ------------------------------------------------------------------ */

const key = (slug: string, b: ReturnType<typeof bill>, sig: unknown = null) =>
  docketKey({ slug, date: b.last_action_date, rung: docketRung(b, sig, { now: NOW }) });

test.describe('compareDocket', () => {
  test('the rung wins before anything else — an announcement beats a fresher placement', () => {
    const announced = key('zzz-1-119', bill('committee', QUIET, 300), signal());
    const placement = key('aaa-1-119', bill('floor_vote', CALENDAR, 0));
    expect([placement, announced].sort(compareDocket)[0]).toBe(announced);
  });

  test('T1 outranks T2: a chamber acting this week beats a queue position', () => {
    const pending = key('zzz-1-119', bill('floor_vote', CLOTURE_FILED, 5));
    const placed = key('aaa-1-119', bill('floor_vote', CALENDAR, 0));
    expect([placed, pending].sort(compareDocket)[0]).toBe(pending);
  });

  test('inside T0, significance beats alphabetics — critic A-2', () => {
    // The measured failure this pins: a 30-bill Monday puts a continuing
    // resolution and a post-office renaming on the same rung with the same
    // date, and a date-then-slug tiebreak hands the crown to whichever is
    // alphabetically earlier.
    const rule = key('zzz-1-119', bill('committee', QUIET, 1), signal({ source: 'billsthisweek', track: 'rule' }));
    const suspension = key(
      'aaa-1-119',
      bill('committee', QUIET, 1),
      signal({ source: 'billsthisweek', track: 'suspension' })
    );
    expect([suspension, rule].sort(compareDocket)[0]).toBe(rule);
  });

  test('t0Weight orders the Senate dialect too: a stated vote, then consideration, then a conditional', () => {
    expect(t0Weight({ certainty: 'scheduled_vote', track: 'unspecified' })).toBeLessThan(
      t0Weight({ certainty: 'consideration', track: 'unspecified' })
    );
    expect(t0Weight({ certainty: 'consideration', track: 'unspecified' })).toBeLessThan(
      t0Weight({ certainty: 'conditional', track: 'unspecified' })
    );
    expect(t0Weight({ track: 'rule', certainty: 'consideration' })).toBeLessThan(
      t0Weight({ track: 'suspension', certainty: 'consideration' })
    );
  });

  test('inside a rung: newest action first, then slug — deterministic across runs', () => {
    const older = key('aaa-1-119', bill('floor_vote', CALENDAR, 5));
    const newer = key('zzz-1-119', bill('floor_vote', CALENDAR, 1));
    expect([older, newer].sort(compareDocket)[0]).toBe(newer);
    const tieA = key('aaa-1-119', bill('floor_vote', CALENDAR, 3));
    const tieZ = key('zzz-1-119', bill('floor_vote', CALENDAR, 3));
    expect([tieZ, tieA].sort(compareDocket)[0]).toBe(tieA);
  });

  test('the tier list is the ordering, and every rung maps to a band', () => {
    expect(DOCKET_TIERS).toEqual(['t0', 't1', 't2', 't3', 't4']);
    for (const tier of DOCKET_TIERS) expect(['now', 'moving', 'radar']).toContain(bandForRung({ tier }));
  });
});

/* ------------------------------------------------------------------ *
 * Bands and pools
 * ------------------------------------------------------------------ */

test.describe('band mapping · the band IS the rung', () => {
  test('Deciding now = T0 ∪ T1 · Moving = T2 ∪ T3 · radar = T4', () => {
    expect(bandForRung({ tier: 't0' })).toBe('now');
    expect(bandForRung({ tier: 't1' })).toBe('now');
    // critic A-3, backtest K3: a bill that just passed a chamber used to land
    // in radar — on the day the Senate passed the continuing resolution 90-6.
    expect(bandForRung({ tier: 't2' })).toBe('moving');
    expect(bandForRung({ tier: 't3' })).toBe('moving');
    expect(bandForRung({ tier: 't4' })).toBe('radar');
  });

  test('a terminal bill is pinned to radar from any rung', () => {
    expect(bandForRung({ tier: 't0', terminal: true })).toBe('radar');
  });

  test('the act-now pool is exactly one rung wider than the lead band', () => {
    expect(DOCKET_TIERS.filter((t: string) => isDecidingNow({ tier: t }))).toEqual(['t0', 't1']);
    expect(DOCKET_TIERS.filter((t: string) => isActNow({ tier: t }))).toEqual(['t0', 't1', 't2']);
    // THE AE3 DIRECTION THAT MATTERS: the pool contains the band, so "the
    // homepage says the week is quiet" still implies "the lead band is empty".
    for (const tier of DOCKET_TIERS) {
      if (isDecidingNow({ tier })) expect(isActNow({ tier }), tier).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Corpus sweeps — ranges, with a non-vacuity guard on each
 * ------------------------------------------------------------------ */

test.describe('the live corpus', () => {
  test('every bill lands on exactly one rung, and the rungs partition the corpus', () => {
    expect(corpus.length).toBeGreaterThan(100);
    const counts: Record<string, number> = {};
    for (const b of corpus) {
      const tier = rungAt(b, NOW).tier;
      expect(DOCKET_TIERS, slugOf(b)).toContain(tier);
      counts[tier] = (counts[tier] ?? 0) + 1;
    }
    expect(Object.values(counts).reduce((a, n) => a + n, 0)).toBe(corpus.length);
    // The radar rung holds the long tail on any real corpus; the live rungs may
    // all be empty on a recess week, and that is the honest output.
    expect(counts.t4).toBeGreaterThan(corpus.length / 2);
  });

  test('no bill whose floor question the record has answered reaches the act-now pool', () => {
    const settled = corpus.filter(isSettledFloor);
    expect(settled.length, 'no settled floor texts in the corpus — this sweep would be vacuous').toBeGreaterThan(0);
    const pool = new Set(actNowPoolAt(NOW).map(slugOf));
    for (const b of settled) expect(pool.has(slugOf(b)), slugOf(b)).toBe(false);
  });

  test('the lead band is a subset of the act-now pool', () => {
    const pool = new Set(actNowPoolAt(NOW).map(slugOf));
    for (const b of decidingNowAt(NOW)) expect(pool.has(slugOf(b)), slugOf(b)).toBe(true);
  });

  test('the ordering is a total order: sorting twice gives the same sequence', () => {
    const once = docketedAt(NOW).map((e) => slugOf(e.b));
    const twice = docketedAt(NOW).map((e) => slugOf(e.b));
    expect(once).toEqual(twice);
    expect(new Set(once).size).toBe(once.length);
  });

  test('the shortlist, the crown pool and the MCP tool all read the same pool', () => {
    const pool = new Set(actNowPoolAt(Date.now()).map(slugOf));
    const shortlist = getTopActions(10_000);
    test.skip(shortlist.length === 0, 'quiet week: the shortlist is empty right now');
    for (const b of shortlist) expect(pool.has(billSlug(b)), billSlug(b)).toBe(true);
    for (const b of getFloorFeatureCandidates()) expect(pool.has(billSlug(b)), billSlug(b)).toBe(true);
  });

  test('T1 is a superset of the crown\'s pending gate, over every floor text in the corpus', () => {
    // The two predicates are deliberately different widths (see
    // entersFloorWatch's header). This pins the direction: everything the crown
    // may CALL pending is at least ranked, and never the reverse.
    const pending = corpus.filter((b) => floorPendingChamber(b.last_action_text));
    expect(pending.length, 'no pending floor texts in the corpus — vacuous').toBeGreaterThan(0);
    for (const b of pending) expect(entersFloorWatch(b.last_action_text), slugOf(b)).toBe(true);
  });
});

/*
 * THE AGENT-FACING SHAPE (MCP `whats_moving`'s `signal` block and the feeds
 * that inherit it) is pinned in tests/mcp-tools.spec.ts and tests/feed.spec.ts
 * instead of here. It cannot live in a unit spec: lib/core/mcp.ts imports
 * lib/freshness.ts, which is `server-only`, so importing it under the unit
 * runner fails at module load. The pool those surfaces read is pinned above.
 */
