import { expect, test } from '@playwright/test';
import {
  billSlug,
  getFloorFeatureCandidates,
  getNewsBills,
  getTeasers,
  getTopActions,
  isSettledFloor,
} from '../lib/core/bills';
import { getCoverage, coverageTier, newestArticleDate, rankNews } from '../lib/coverage';
import { FLOOR_SETTLED, floorSettledChamber } from '../lib/journey';
import { SIGNAL_WINDOW_DAYS, isSignalFresh } from '../lib/urgency.mjs';
import { CLOCK_SKEW_MS, corpus, slugOf } from './corpus';

/*
 * THE TWO VISIBILITY GATES ON THE "WHAT IS HAPPENING RIGHT NOW" SURFACES
 * (2026-08-12).
 *
 * (a) A `floor_vote` bill whose floor question the record has ALREADY ANSWERED
 *     is not act-now material. Measured on the committed corpus that day:
 *     s-5271-119 — "Cloture on the motion to proceed to the measure not invoked
 *     in Senate by Yea-Nay Vote. 52 - 46." — held rank 2 of the homepage
 *     shortlist, and travelled from the same pool into MCP `whats_moving` and
 *     both public feeds.
 *
 * (b) The "In the news" band selected on coverage TIER alone, with no recency
 *     input at all, and served the same six bills for twelve straight days —
 *     four of them on articles 16, 77, 86 and 109 days old — under a heading
 *     that reads in the present tense.
 *
 * Both halves are pinned the same way: fixtures for the rule, then a corpus
 * sweep for the claim, each sweep carrying a NON-VACUITY guard so it cannot
 * quietly become an assertion about an empty set. Counts are asserted as RANGES
 * — the corpus moves nightly and a pinned number is a scheduled false red.
 */

/* ---------------------------------------------------------------------- *
 * (a) The settled-floor exclusion
 * ---------------------------------------------------------------------- */

test.describe('isSettledFloor (the vocabulary gate on the act-now pool)', () => {
  const bill = (status: string, last_action_text: string | null) => ({ status, last_action_text });

  test('a defeat is settled — the real corpus texts this was built for', () => {
    // Verbatim from data/bills.json, 2026-08-12.
    expect(
      isSettledFloor(
        bill(
          'floor_vote',
          'Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 52 - 46. Record Vote Number: 301.'
        )
      )
    ).toBe(true);
    expect(
      isSettledFloor(
        bill('floor_vote', 'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 48 - 50.')
      )
    ).toBe(true);
    expect(
      isSettledFloor(
        bill(
          'floor_vote',
          'Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 48. Record Vote Number: 187.'
        )
      )
    ).toBe(true);
  });

  test('a live floor fact is NOT settled — a placement, a cloture motion presented', () => {
    expect(
      isSettledFloor(bill('floor_vote', 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 552.'))
    ).toBe(false);
    expect(
      isSettledFloor(bill('floor_vote', 'Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4557)'))
    ).toBe(false);
    expect(isSettledFloor(bill('floor_vote', 'Considered by Senate. (CR S4001)'))).toBe(false);
  });

  test('a DATED CALENDAR PLACEMENT wins over a settled word elsewhere in the sentence', () => {
    // The same carve-out floorSettledChamber makes: a placement is a live fact
    // whatever else its sentence happens to mention. 0 corpus texts sit in this
    // overlap today, so this is the promise, not an observation.
    expect(
      isSettledFloor(
        bill('floor_vote', 'Motion to reconsider rejected. Placed on Senate Legislative Calendar under General Orders. Calendar No. 400.')
      )
    ).toBe(false);
  });

  test('only floor_vote is gated — the vocabulary means nothing at another stage', () => {
    // "rejected" in a committee sentence is not a floor answer, and a bill in
    // committee never reaches the act-now floor on its status base anyway.
    expect(isSettledFloor(bill('committee', 'Amendment rejected in committee.'))).toBe(false);
    expect(isSettledFloor(bill('passed_chamber', 'Motion to table rejected.'))).toBe(false);
  });

  test('a missing action text is never settled (nothing to read)', () => {
    expect(isSettledFloor(bill('floor_vote', null))).toBe(false);
    expect(isSettledFloor(bill('floor_vote', ''))).toBe(false);
  });

  test('the vocabulary is lib/journey.ts\'s FLOOR_SETTLED — one constant, not a private copy', () => {
    for (const word of ['rejected', 'not invoked', 'failed', 'withdrawn', 'indefinitely postponed']) {
      expect(FLOOR_SETTLED.test(`Motion ${word} in Senate.`), word).toBe(true);
      expect(isSettledFloor(bill('floor_vote', `Motion ${word} in Senate.`)), word).toBe(true);
    }
  });
});

test.describe('the settled exclusion over the committed corpus', () => {
  const floorVotes = corpus.filter((b) => b.status === 'floor_vote');
  const settled = floorVotes.filter(isSettledFloor);

  test('NON-VACUITY: the corpus really does carry settled floor texts', () => {
    // Every assertion below is about a set this one proves is non-empty. Range,
    // never a count: 18 of 356 on 2026-08-12, and it turns over nightly.
    expect(floorVotes.length).toBeGreaterThan(50);
    expect(settled.length).toBeGreaterThan(0);
    expect(settled.length).toBeLessThan(floorVotes.length);
  });

  test('it agrees with floorSettledChamber wherever that function commits', () => {
    // The two read the same vocabulary; isSettledFloor is deliberately the
    // WIDER of the pair (it does not also require a readable chamber), so
    // every text floorSettledChamber classifies must be settled here, and the
    // reverse containment is not asserted.
    for (const b of floorVotes) {
      if (floorSettledChamber(b.last_action_text) !== null) {
        expect(isSettledFloor(b), slugOf(b)).toBe(true);
      }
    }
  });

  test('NO settled bill reaches the act-now shortlist', () => {
    const pool = getTopActions(10_000);
    // Non-vacuity: an empty shortlist would satisfy this trivially. A quiet
    // week is legitimate, so it skips with a reason rather than failing.
    test.skip(pool.length === 0, 'quiet week: the shortlist is empty right now');
    for (const b of pool) expect(isSettledFloor(b), billSlug(b)).toBe(false);
  });

  test('NO settled bill reaches the crown\'s candidate pool', () => {
    const pool = getFloorFeatureCandidates();
    test.skip(pool.length === 0, 'quiet week: no floor-feature candidates right now');
    for (const b of pool) expect(isSettledFloor(b), billSlug(b)).toBe(false);
  });

  test('NO settled bill sits in /bills\' "Act now" band', () => {
    // The equivalence hasActNow owes /bills: the quiet-week claim keys on the
    // pool, so the band it claims to describe must agree.
    const teasers = getTeasers();
    const now = teasers.filter((t) => t.band === 'now');
    test.skip(now.length === 0, 'quiet week: the "Act now" band is empty right now');
    const settledSlugs = new Set(settled.map(slugOf));
    for (const t of now) expect(settledSlugs.has(t.slug), t.slug).toBe(false);
  });

  test('DEMOTED, NOT HIDDEN: every settled bill is still listed, and still decodable', () => {
    const listed = new Set(getTeasers().map((t) => t.slug));
    for (const b of settled) expect(listed.has(slugOf(b)), slugOf(b)).toBe(true);
    // And the corpus keeps them: /bills, search, and their own pages are
    // untouched by this change.
    expect(getTeasers().length).toBe(corpus.length);
  });

  test('the demotion is STRUCTURAL now, not a cap applied after scoring', () => {
    /*
     * `demoteSettled(band, settled)` used to run after the floors had already
     * scored a settled bill into "now". With the docket ladder the exclusion is
     * the rung itself — a settled text fails T1's rule-0 guard and lands on T4
     * carrying `just_decided` — so there is no band left to cap. This pins the
     * result rather than the retired mechanism: every settled bill sits in the
     * radar band, annotated, and none of them is anywhere else.
     */
    const bySlug = new Map(getTeasers().map((t) => [t.slug, t]));
    for (const b of settled) {
      const teaser = bySlug.get(slugOf(b));
      expect(teaser, slugOf(b)).toBeTruthy();
      expect(teaser!.band, slugOf(b)).toBe('radar');
    }
    // The annotation only fires inside the signal window (an eight-month-old
    // defeat is not news), so it is asserted as a range with its own guard.
    const annotated = getTeasers().filter((t) => t.annotation === 'just_decided');
    expect(annotated.length).toBeLessThanOrEqual(settled.length);
    for (const t of annotated) expect(t.band).toBe('radar');
  });
});

/* ---------------------------------------------------------------------- *
 * (b) The news-band recency gate
 * ---------------------------------------------------------------------- */

test.describe('newestArticleDate', () => {
  const art = (publishedAt: string | null) => ({ publishedAt });

  test('returns the newest date, whatever order the articles arrived in', () => {
    expect(newestArticleDate([art('2026-04-26'), art('2026-08-10'), art('2026-05-19')])).toBe('2026-08-10');
  });

  test('ignores undated articles rather than treating them as new', () => {
    expect(newestArticleDate([art(null), art('2026-07-01'), art(null)])).toBe('2026-07-01');
  });

  test('all-undated and empty both return null — and null never passes the gate', () => {
    expect(newestArticleDate([])).toBeNull();
    expect(newestArticleDate([art(null), art(null)])).toBeNull();
    expect(isSignalFresh(null)).toBe(false);
  });
});

test.describe('the news band\'s recency gate', () => {
  // Midnight UTC, so `daysAgo(d)` is exactly d days old and the window's edge
  // can be pinned to the day. The mid-day case is pinned separately below.
  const now = Date.parse('2026-08-12T00:00:00Z');
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString().slice(0, 10);

  test('the gate is the published signal window, not a second number', () => {
    // Same 14 days amber and the homepage crown run on. Two clocks for one
    // present-tense claim is how two surfaces end up disagreeing.
    expect(SIGNAL_WINDOW_DAYS).toBe(14);
  });

  test('fresh coverage passes, stale coverage is excluded', () => {
    const item = (newestArticle: string | null, sources = 5) =>
      ({ tier: 'cross' as const, sources, urgency: 0.5, newestArticle });

    expect(rankNews([item(daysAgo(0))], 10, now)).toHaveLength(1);
    // The edge itself: exactly the window passes, one day past it does not.
    expect(rankNews([item(daysAgo(SIGNAL_WINDOW_DAYS))], 10, now)).toHaveLength(1);
    expect(rankNews([item(daysAgo(SIGNAL_WINDOW_DAYS + 1))], 10, now)).toHaveLength(0);
    // The four ages the committed band was actually serving on 2026-08-12,
    // plus the 34-day one it served at n=7 the same day.
    for (const age of [16, 34, 77, 86, 109]) {
      expect(rankNews([item(daysAgo(age))], 10, now), `${age} days`).toHaveLength(0);
    }
    // Undated coverage fails closed, and a future date is a scheduled article,
    // not a stale one (isSignalFresh's own rule).
    expect(rankNews([item(null)], 10, now)).toHaveLength(0);
    expect(rankNews([item(daysAgo(-3))], 10, now)).toHaveLength(1);
  });

  test('an article date is a DAY, so the edge rounds toward exclusion', () => {
    // Stored dates are bare ISO days, read as midnight UTC. Half a day into
    // 2026-08-12 an article dated exactly 14 days earlier is 14.5 days old and
    // correctly falls out — the fail-closed direction, and the same rounding
    // isSignalFresh has always applied to a legislative signal.
    const midday = Date.parse('2026-08-12T12:00:00Z');
    const item = (newestArticle: string) =>
      ({ tier: 'cross' as const, sources: 5, urgency: 0.5, newestArticle });
    expect(rankNews([item('2026-07-29')], 10, midday)).toHaveLength(0);
    expect(rankNews([item('2026-07-30')], 10, midday)).toHaveLength(1);
  });

  test('the gate never re-orders what survives it', () => {
    const item = (tier: 'cross' | 'neutral', sources: number, age: number) =>
      ({ tier, sources, urgency: 0.5, newestArticle: daysAgo(age) });
    // A 13-day-old cross-spectrum story still outranks a same-day neutral one:
    // breadth decides prominence, recency only decides membership.
    const r = rankNews([item('neutral', 9, 0), item('cross', 2, 13)], 10, now);
    expect(r.map((x) => x.tier)).toEqual(['cross', 'neutral']);
  });
});

test.describe('the news band over the committed corpus', () => {
  // Captured BEFORE the call below, and the assertions read the window at
  // `at - CLOCK_SKEW_MS`: getNewsBills judges freshness at its own instant,
  // which is at or after this one, and isSignalFresh only ever expires — so a
  // bill it returned was fresh at every earlier instant too. Asserting at the
  // LATER end would be strictly stronger than what the function promises and
  // would flake on an article sitting exactly at the boundary.
  const at = Date.now();
  const band = getNewsBills('en', 6);

  const covered = corpus
    .map((b) => ({ slug: slugOf(b), articles: getCoverage(slugOf(b)) }))
    .filter((c) => c.articles.length > 0)
    .map((c) => ({ ...c, tier: coverageTier(c.articles), newest: newestArticleDate(c.articles) }))
    .filter((c) => c.tier === 'cross' || c.tier === 'neutral');

  test('NON-VACUITY: the corpus holds rankable coverage on both sides of the window', () => {
    // Without a stale side, "the band carries nothing stale" would be a claim
    // about a gate that never fires. 56 bills carry rankable (cross/neutral)
    // coverage on 2026-08-12, 13 of them inside the window — asserted as
    // ranges, because the nightly sync moves both numbers.
    expect(covered.length).toBeGreaterThan(10);
    expect(covered.filter((c) => isSignalFresh(c.newest, at)).length).toBeGreaterThan(0);
    expect(covered.filter((c) => !isSignalFresh(c.newest, at)).length).toBeGreaterThan(0);
  });

  test('every bill in the band is covered inside the signal window', () => {
    test.skip(band.length === 0, 'no coverage inside the window right now — the honest empty band');
    for (const b of band) {
      const newest = newestArticleDate(getCoverage(b.slug));
      expect(newest, b.slug).not.toBeNull();
      expect(isSignalFresh(newest, at - CLOCK_SKEW_MS), `${b.slug} @ ${newest}`).toBe(true);
    }
  });

  test('the band never exceeds the cap it was asked for, and may legitimately be shorter', () => {
    expect(band.length).toBeLessThanOrEqual(6);
    expect(getNewsBills('en', 2).length).toBeLessThanOrEqual(2);
  });

  test('one-sided coverage is still excluded — the recency gate replaced nothing', () => {
    const oneSided = new Set(
      corpus
        .map((b) => slugOf(b))
        .filter((s) => coverageTier(getCoverage(s)) === 'one_sided')
    );
    for (const b of band) expect(oneSided.has(b.slug), b.slug).toBe(false);
  });
});
