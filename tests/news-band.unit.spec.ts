import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFormatter, createTranslator } from 'next-intl';
import {
  CONVERSATION_SCHEMA,
  CONVERSATION_STALE_HOURS,
  MOST_VIEWED_CARD_CAP,
  NEWS_CAPTION_KINDS,
  OUTLET_WINDOW_DAYS,
  conversationBandPool,
  conversationPosture,
  newsSpread,
  selectConversationBand,
  type ConversationPoolItem,
  type ConversationSelection,
  type NewsCaption,
  type NewsCaptionKind,
} from '../lib/conversation';
import { conversationPool } from '../lib/conversation.mjs';
import { getNewsBills } from '../lib/core/bills';
import { getCoverage, coverageTier, newestArticleDate } from '../lib/coverage';
import { isSignalFresh } from '../lib/urgency.mjs';
import { CLOCK_SKEW_MS, corpus, slugOf } from './corpus';

/*
 * THE NEWS BAND UNDER THE CONVERSATION LAMP (design B, patched).
 *
 * WHAT THIS PINS, and why fixtures carry almost all of it: data/conversation.json
 * is written by the hourly newsdesk and is legitimately near-empty during a
 * recess — it ships as an empty seed in this branch, and the corpus is in the
 * August recess. A suite that only asserted over the committed file would be
 * vacuous exactly when it mattered, so the POLICY is pinned on fixtures (which
 * are the whole selection, deterministic and clock-injected) and the corpus is
 * asserted as ranges with an explicit non-vacuity guard.
 *
 * The four mandatory patches, and where each is pinned here:
 *   B-1  a single outlet renders NOTHING and PRINTS nothing — there is no rung
 *        for it to reach, the pool the selector reads cannot contain one, and
 *        the one card that may legitimately have a lone article behind it (the
 *        most-viewed pairing route) never says so.
 *   B-2  most-viewed needs two consecutive weeks or a rated article, and EVERY
 *        card admitted by the list — either route — counts against
 *        MOST_VIEWED_CARD_CAP of six.
 *   B-3  only AllSides-rated outlets are counted (enforced at write time; here
 *        the consequence is pinned — an unrated domain contributes no count).
 *   B-4  the writer's business, but its consequence is here: a caption never
 *        claims a spread it does not hold.
 *
 * THE 2026-08-12 VERIFICATION ROUND is pinned in sections 2, 3 and 8. Two
 * findings, both against the `most-viewed + one rated article` route that
 * design B-2's own OR sanctions: as shipped it walked past the card cap (five
 * of six cards could rest on one view count and one newsroom apiece) and it
 * rendered that lone newsroom's lean as a caption ("covered by 1 outlet:
 * left") — a single-outlet claim on the homepage, which is the display half of
 * the channel B-1 closes. The route stays; the cap counts it and the caption
 * does not mention it.
 */

const T = '2026-08-12';
const day = (offset: number) => new Date(Date.parse(`${T}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

type Lean = 'left' | 'center' | 'right';
const outlet = (domain: string, lean: Lean, lastSeen = T) => ({ domain, lean, firstSeen: lastSeen, lastSeen });

/** An evidence document, folded through the REAL pool builder so the fixtures
 *  exercise the same tier rules the writer and the CI gate run. */
function poolOf(slugs: Record<string, unknown>): ConversationPoolItem[] {
  return conversationPool({ slugs }, { today: T }) as ConversationPoolItem[];
}

const corroborated = (...outlets: ReturnType<typeof outlet>[]) => ({
  outlets7d: outlets,
  unratedOutlets7d: [],
  mostViewed: null,
});

const mostViewed = (weeksOnList: number, lastRank: number, lastSeen = T) => ({
  weeksOnList,
  lastRank,
  lastSeen,
  lastWeek: '2026-08-09',
});

/* ------------------------------------------------------------------ *
 * 1 · C1 — corroborated press, and the order it renders in
 * ------------------------------------------------------------------ */
test.describe('C1: two or more rated outlets, this week', () => {
  test('orders by distinct rated outlets, then newest evidence, then slug', () => {
    const band = selectConversationBand(
      poolOf({
        'hr-2-119': corroborated(outlet('cnn.com', 'left', day(-3)), outlet('foxnews.com', 'right', day(-3))),
        'hr-1-119': corroborated(
          outlet('cnn.com', 'left'),
          outlet('foxnews.com', 'right'),
          outlet('reuters.com', 'center')
        ),
        'hr-3-119': corroborated(outlet('cnn.com', 'left', T), outlet('foxnews.com', 'right', T)),
      }),
      { limit: 6 }
    );
    // three outlets first; then the two-outlet pair, newest evidence ahead.
    expect(band.map((b) => b.slug)).toEqual(['hr-1-119', 'hr-3-119', 'hr-2-119']);
    expect(band.every((b) => b.tier === 'c1')).toBe(true);
  });

  test('the caption states the counted facts and nothing else', () => {
    const [card] = selectConversationBand(
      poolOf({
        'hr-1-119': corroborated(
          outlet('cnn.com', 'left'),
          outlet('foxnews.com', 'right'),
          outlet('reuters.com', 'center')
        ),
      }),
      { limit: 6 }
    );
    expect(card.caption).toEqual({
      kind: 'corroborated',
      outlets: 3,
      leans: ['center', 'left', 'right'],
      weeks: 0,
      rank: null,
    });
  });

  test('center-only coverage gets the WEAKER caption, never "across the spectrum"', () => {
    const [card] = selectConversationBand(
      poolOf({ 'hr-1-119': corroborated(outlet('reuters.com', 'center'), outlet('npr.org', 'center')) }),
      { limit: 6 }
    );
    expect(card.caption.kind).toBe('corroborated_center');
    expect(newsSpread(card.caption.leans)).toBe('neutral');
  });

  test('one-sided rated coverage is DROPPED, not reworded', () => {
    // Two outlets that lean the same way are two outlets; a card saying "across
    // the spectrum" over them would be a counted claim that is false, and the
    // nonpartisan rule makes that a drop rather than a differently-worded card.
    // Same exclusion lib/coverage.ts's coverageTier has always applied.
    const band = selectConversationBand(
      poolOf({
        'hr-1-119': corroborated(outlet('foxnews.com', 'right'), outlet('washingtontimes.com', 'right')),
        'hr-2-119': corroborated(outlet('cnn.com', 'left'), outlet('msnbc.com', 'left')),
      }),
      { limit: 6 }
    );
    expect(band).toEqual([]);
    expect(newsSpread(['right', 'right'])).toBe('one_sided');
    expect(newsSpread(['left', 'center'])).toBe('one_sided');
  });

  test('evidence outside the seven-day window does not count toward the caption', () => {
    const band = selectConversationBand(
      poolOf({
        'hr-1-119': corroborated(
          outlet('cnn.com', 'left'),
          outlet('foxnews.com', 'right'),
          outlet('reuters.com', 'center', day(-(OUTLET_WINDOW_DAYS + 1)))
        ),
      }),
      { limit: 6 }
    );
    expect(band[0].caption.outlets).toBe(2);
    expect(band[0].caption.leans).toEqual(['left', 'right']);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · B-1 — one outlet admits nothing, anywhere
 * ------------------------------------------------------------------ */
test.describe('B-1: one outlet admits nothing, and is never printed either', () => {
  test('one rated outlet renders nothing', () => {
    expect(selectConversationBand(poolOf({ 'hr-1-119': corroborated(outlet('cnn.com', 'left')) }), { limit: 6 })).toEqual([]);
  });

  test('one rated outlet plus a pile of UNRATED domains still renders nothing', () => {
    // The channel critic B-3 named: two press-release pickups on obscure indexed
    // sites presenting as "two distinct newsrooms". Unrated domains are stored
    // for observability and counted by nothing.
    const band = selectConversationBand(
      poolOf({
        'hr-1-119': {
          outlets7d: [outlet('cnn.com', 'left')],
          unratedOutlets7d: [
            { domain: 'example-wire.test', firstSeen: T, lastSeen: T },
            { domain: 'another-blog.test', firstSeen: T, lastSeen: T },
          ],
          mostViewed: null,
        },
      }),
      { limit: 6 }
    );
    expect(band).toEqual([]);
  });

  test('a single outlet cannot even reach the pool the selector reads', () => {
    expect(poolOf({ 'hr-1-119': corroborated(outlet('cnn.com', 'left')) })).toEqual([]);
  });

  /* ---- THE ONE ROUTE THAT CARRIES A LONE ARTICLE (2026-08-12) --------- *
   * design B-2's OR admits a most-viewed bill with ONE rated article beside
   * it, and that is sanctioned: the government's own list is the fact being
   * reported and the article is corroboration that someone else noticed. What
   * this block pins is the consequence B-1 owns — the article is why the card
   * was ADMITTED and is never something the card SAYS. As shipped it printed
   * "covered by 1 outlet: left", which is a single-outlet claim and a spread
   * claim over one lean, on the homepage.                                  */
  test('most-viewed PLUS one rated article renders — and the caption is the LISTING alone', () => {
    const band = selectConversationBand(
      poolOf({ 'hr-1-119': { ...corroborated(outlet('cnn.com', 'left')), mostViewed: mostViewed(1, 5) } }),
      { limit: 6 }
    );
    expect(band).toHaveLength(1);
    const [card] = band;
    expect(card.tier).toBe('c2');
    // The article is admission evidence, and it stays auditable AS evidence...
    expect(card.evidence.reason).toBe('most-viewed-plus-article');
    expect(card.evidence.ratedOutlets).toBe(1);
    expect(card.evidence.leanSpread).toEqual(['left']);
    // ...and invisible in the caption: no count, no lean, no spread.
    expect(card.caption).toEqual({ kind: 'most_viewed_this_week', outlets: 0, leans: [], weeks: 1, rank: 5 });
  });

  test('a lone article is invisible whichever route admitted the card', () => {
    // The same evidence, admitted by the WEEKS route instead: two consecutive
    // weeks makes the card, one rated outlet sits beside it, and the caption
    // still counts nothing. Neither route may print a one.
    const [card] = selectConversationBand(
      poolOf({ 'hr-1-119': { ...corroborated(outlet('foxnews.com', 'right')), mostViewed: mostViewed(2, 4) } }),
      { limit: 6 }
    );
    expect(card.evidence.ratedOutlets).toBe(1);
    expect(card.caption).toEqual({ kind: 'most_viewed', outlets: 0, leans: [], weeks: 2, rank: 4 });
  });

  test('NO card the selector can emit ever counts exactly one outlet', () => {
    // The structural form of the finding: two outlets is the smallest number
    // this band says out loud, so every caption counts 0 or 2+. A pool built to
    // hit every rung at once, including both most-viewed routes.
    const band = selectConversationBand(
      poolOf({
        'hr-1-119': corroborated(outlet('cnn.com', 'left'), outlet('foxnews.com', 'right')),
        'hr-2-119': corroborated(outlet('reuters.com', 'center'), outlet('npr.org', 'center')),
        'hr-3-119': { ...corroborated(outlet('cnn.com', 'left')), mostViewed: mostViewed(1, 1) },
        'hr-4-119': { ...corroborated(outlet('foxnews.com', 'right')), mostViewed: mostViewed(3, 2) },
        'hr-5-119': { ...corroborated(), mostViewed: mostViewed(2, 3) },
      }),
      { limit: 6, mostViewedCap: 6 }
    );
    expect(band.length).toBeGreaterThan(3); // non-vacuity: the pool really did render
    for (const card of band) {
      expect(card.caption.outlets === 0 || card.caption.outlets >= 2, card.slug).toBe(true);
      // A lean list of one can only exist on the center-only caption, whose
      // string never prints the list (pinned as copy in section 7).
      if (card.caption.leans.length === 1) expect(card.caption.kind, card.slug).toBe('corroborated_center');
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3 · B-2 — most-viewed is never sufficient alone, and never fills the band
 * ------------------------------------------------------------------ */
test.describe('B-2: congress.gov most-viewed', () => {
  test('one week on the list, with no article beside it, renders nothing', () => {
    const band = selectConversationBand(
      poolOf({ 'hr-1-119': { ...corroborated(), mostViewed: mostViewed(1, 3) } }),
      { limit: 6 }
    );
    expect(band).toEqual([]);
  });

  test('two consecutive weeks stands on its own, and says how many', () => {
    const [card] = selectConversationBand(
      poolOf({ 'hr-1-119': { ...corroborated(), mostViewed: mostViewed(2, 3) } }),
      { limit: 6 }
    );
    expect(card.tier).toBe('c2');
    expect(card.caption).toEqual({ kind: 'most_viewed', outlets: 0, leans: [], weeks: 2, rank: 3 });
  });

  test('one week PLUS one rated article is admitted — the OR stands', () => {
    // B-2's own disjunction: two consecutive weeks OR a rated article beside a
    // first-week listing. What the card may SAY about that article is pinned in
    // section 2 (nothing), and what it costs against the cap is pinned below.
    const [card] = selectConversationBand(
      poolOf({ 'hr-1-119': { ...corroborated(outlet('cnn.com', 'left')), mostViewed: mostViewed(1, 5) } }),
      { limit: 6 }
    );
    expect(card.tier).toBe('c2');
    expect(card.evidence.reason).toBe('most-viewed-plus-article');
  });

  test(`most-viewed cards are capped at ${MOST_VIEWED_CARD_CAP} of six — by EITHER route`, () => {
    const slugs: Record<string, unknown> = {};
    for (let i = 1; i <= 6; i++) slugs[`hr-${i}-119`] = { ...corroborated(), mostViewed: mostViewed(2, i) };
    const band = selectConversationBand(poolOf(slugs), { limit: 6 });
    expect(band).toHaveLength(MOST_VIEWED_CARD_CAP);
    // THE 2026-08-12 FINDING, inverted into an assert: the cap used to be
    // written against the weeks route only, so adding cards on the pairing
    // route raised the count. It must not move the total by one.
    for (let i = 7; i <= 10; i++) {
      slugs[`hr-${i}-119`] = { ...corroborated(outlet('cnn.com', 'left')), mostViewed: mostViewed(1, i) };
    }
    const withArticles = selectConversationBand(poolOf(slugs), { limit: 6 });
    expect(withArticles).toHaveLength(MOST_VIEWED_CARD_CAP);
    expect(withArticles.every((c) => c.tier === 'c2')).toBe(true);
  });

  test('a band of six candidates where five depend on most-viewed renders at most two of them', () => {
    // The shape the finding actually threatened: one genuinely corroborated
    // bill and five resting on the view count, in a six-card band. Five of six
    // cards may not be view-count cards, however they were admitted.
    const slugs: Record<string, unknown> = {
      'hr-1-119': corroborated(outlet('cnn.com', 'left'), outlet('foxnews.com', 'right')),
      // three admitted by the pairing route, two by the weeks route
      'hr-2-119': { ...corroborated(outlet('cnn.com', 'left')), mostViewed: mostViewed(1, 1) },
      'hr-3-119': { ...corroborated(outlet('foxnews.com', 'right')), mostViewed: mostViewed(1, 2) },
      'hr-4-119': { ...corroborated(outlet('npr.org', 'center')), mostViewed: mostViewed(1, 3) },
      'hr-5-119': { ...corroborated(), mostViewed: mostViewed(2, 4) },
      'hr-6-119': { ...corroborated(), mostViewed: mostViewed(4, 5) },
    };
    const pool = poolOf(slugs);
    expect(pool).toHaveLength(6); // all six are genuinely eligible…
    const band = selectConversationBand(pool, { limit: 6 });
    expect(band.filter((c) => c.tier === 'c2')).toHaveLength(MOST_VIEWED_CARD_CAP); // …two get in
    expect(band.filter((c) => c.tier === 'c1')).toHaveLength(1);
    expect(band).toHaveLength(1 + MOST_VIEWED_CARD_CAP);
    // A short band is the honest outcome: the cap does not backfill with the
    // cards it just excluded, and it does not reach outside the evidence.
    expect(band.length).toBeLessThan(6);
  });

  test('a stale most-viewed observation stops counting once the window passes it', () => {
    const band = selectConversationBand(
      poolOf({ 'hr-1-119': { ...corroborated(), mostViewed: mostViewed(3, 1, day(-(OUTLET_WINDOW_DAYS + 1))) } }),
      { limit: 6 }
    );
    expect(band).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4 · The band as a whole — order across tiers, caps, renderability
 * ------------------------------------------------------------------ */
test.describe('the selected band', () => {
  const mixed = () => {
    const slugs: Record<string, unknown> = {
      'hr-10-119': corroborated(outlet('cnn.com', 'left'), outlet('foxnews.com', 'right'), outlet('npr.org', 'center')),
      'hr-11-119': corroborated(outlet('cnn.com', 'left'), outlet('foxnews.com', 'right')),
      'hr-12-119': { ...corroborated(), mostViewed: mostViewed(2, 1) },
      'hr-13-119': { ...corroborated(), mostViewed: mostViewed(4, 2) },
      'hr-14-119': { ...corroborated(), mostViewed: mostViewed(2, 3) },
    };
    return poolOf(slugs);
  };

  test('C1 comes first, then C2 — press corroboration before a view count', () => {
    const band = selectConversationBand(mixed(), { limit: 6 });
    expect(band.map((b) => b.tier)).toEqual(['c1', 'c1', 'c2', 'c2']);
    expect(band.map((b) => b.slug)).toEqual(['hr-10-119', 'hr-11-119', 'hr-12-119', 'hr-13-119']);
  });

  test('never exceeds the cap it was asked for, and a shorter band is legitimate', () => {
    expect(selectConversationBand(mixed(), { limit: 2 })).toHaveLength(2);
    expect(selectConversationBand(poolOf({}), { limit: 6 })).toEqual([]);
  });

  test('a slug this build does not hold is skipped, not rendered', () => {
    const band = selectConversationBand(mixed(), {
      limit: 6,
      renderable: (slug) => slug !== 'hr-10-119',
    });
    expect(band.map((b) => b.slug)).not.toContain('hr-10-119');
    expect(band[0].slug).toBe('hr-11-119');
  });

  test('the same evidence always produces the same cards in the same order', () => {
    expect(selectConversationBand(mixed(), { limit: 6 })).toEqual(selectConversationBand(mixed(), { limit: 6 }));
  });
});

/* ------------------------------------------------------------------ *
 * 5 · The posture gate — when the lamp may speak at all
 * ------------------------------------------------------------------ */
test.describe('posture: the fallback is a decision, not an accident', () => {
  const FILE = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'conversation.json'), 'utf8'));

  test('the committed file is the schema this build reads', () => {
    expect(FILE._meta.schema).toBe(CONVERSATION_SCHEMA);
    expect(FILE._meta.window_days).toBe(OUTLET_WINDOW_DAYS);
  });

  test('a file no run has written yet is NOT live, however fresh its stamp', () => {
    // The state this branch merges in: the seed commit carries
    // source_status.press.status === "unknown" until the first hourly newsdesk
    // run replaces it. The band must render exactly what it rendered before the
    // lamp existed, with no captions, rather than going dark — and the stamp
    // must not be able to rescue it, which is what this asserts one second
    // after the file's own fetched_at.
    const justWritten = Date.parse(FILE._meta.fetched_at) + 1_000;
    if (FILE._meta.source_status.press?.status === 'unknown') {
      expect(conversationPosture(justWritten)).toBe('unknown');
    } else {
      // A real run has written it: then a stamp this fresh IS live, and the
      // band is the lamp's. Both branches are legitimate states of main.
      expect(conversationPosture(justWritten)).toBe('live');
    }
  });

  test('the pool is empty whenever the posture is not live', () => {
    if (conversationPosture() !== 'live') expect(conversationBandPool()).toEqual([]);
  });

  test('THE FALLBACK ORDER: stale evidence hands the band back to #215, captionless', () => {
    // The degradation ladder, in the order it is designed to fire:
    //   missing / unknown schema / unrefreshed file → #215's stored-coverage
    //     band, captions DROPPED (never guessed);
    //   file PRESENT and live but thin → a short band, or none at all.
    // This pins the first rung end to end through the real selector: at a clock
    // past the staleness window the posture is unknown, so every card that
    // renders came from stored coverage and carries no caption. An empty band
    // is a legitimate result of the same rung (NewsLens renders nothing), which
    // is why the assertion is over the cards rather than over the count.
    const stale = Date.parse(FILE._meta.fetched_at) + (CONVERSATION_STALE_HOURS + 1) * 3_600_000;
    expect(conversationPosture(stale)).toBe('unknown');
    for (const b of getNewsBills('en', 6, stale)) expect(b.caption, b.slug).toBeNull();
  });

  test('a stamp older than the staleness window can never read as live', () => {
    // Pinned as arithmetic rather than by mutating the import: the window is
    // three days because the writer restamps at least daily whenever it holds
    // any evidence at all (the window prune is itself a material change).
    expect(CONVERSATION_STALE_HOURS).toBe(72);
    const stamp = Date.parse(FILE._meta.fetched_at);
    const wayLater = stamp + (CONVERSATION_STALE_HOURS + 1) * 3_600_000;
    expect(conversationPosture(wayLater)).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ *
 * 6 · The band over the committed corpus — ranges, with the non-vacuity
 *     guard the recess makes necessary
 * ------------------------------------------------------------------ */
test.describe('the news band over the committed corpus', () => {
  const at = Date.now();
  const band = getNewsBills('en', 6, at);
  const live = conversationPosture(at) === 'live';

  test('NON-VACUITY: the corpus can still feed a band in whichever mode is active', () => {
    if (live) {
      // The lamp is speaking: the pool is the evidence, and it may legitimately
      // be empty on a quiet week — but then the band must be empty too, which
      // the next test asserts. What must hold here is that the two agree.
      expect(band.length).toBeLessThanOrEqual(conversationBandPool(at).length);
    } else {
      // The fallback is running: the stored-coverage corpus must still hold
      // rankable coverage on both sides of the signal window, or "the band
      // carries nothing stale" would be a claim about a gate that never fires.
      const covered = corpus
        .map((b) => ({ slug: slugOf(b), articles: getCoverage(slugOf(b)) }))
        .filter((c) => c.articles.length > 0)
        .map((c) => ({ ...c, tier: coverageTier(c.articles), newest: newestArticleDate(c.articles) }))
        .filter((c) => c.tier === 'cross' || c.tier === 'neutral');
      expect(covered.length).toBeGreaterThan(10);
      expect(covered.filter((c) => !isSignalFresh(c.newest, at)).length).toBeGreaterThan(0);
    }
  });

  test('every card carries a caption in lamp mode, and none does in fallback mode', () => {
    // The degradation rule, pinned: captions are DROPPED rather than guessed.
    for (const b of band) expect(Boolean(b.caption), b.slug).toBe(live);
  });

  test('every card links to a bill this build actually holds', () => {
    const slugs = new Set(corpus.map((b) => slugOf(b)));
    for (const b of band) expect(slugs.has(b.slug), b.slug).toBe(true);
  });

  test('the band never exceeds the cap it was asked for', () => {
    expect(band.length).toBeLessThanOrEqual(6);
    expect(getNewsBills('en', 2, at).length).toBeLessThanOrEqual(2);
  });

  test('no card claims a spread it does not hold', () => {
    for (const b of band) {
      if (!b.caption) continue;
      if (b.caption.kind === 'corroborated') expect(newsSpread(b.caption.leans), b.slug).toBe('cross');
      if (b.caption.kind === 'corroborated_center') expect(newsSpread(b.caption.leans), b.slug).toBe('neutral');
      expect(b.caption.outlets, b.slug).toBe(b.sourceCount);
    }
  });

  test('in fallback mode the band is still gated on the signal window (#215 unchanged)', () => {
    test.skip(live, 'the lamp is live — the fallback gate is pinned by fixtures above');
    for (const b of band) {
      const newest = newestArticleDate(getCoverage(b.slug));
      expect(isSignalFresh(newest, at - CLOCK_SKEW_MS), `${b.slug} @ ${newest}`).toBe(true);
    }
  });

  test('one-sided stored coverage is still excluded in fallback mode', () => {
    test.skip(live, 'the lamp is live — its own one-sided exclusion is pinned by fixtures above');
    const oneSided = new Set(
      corpus.map((b) => slugOf(b)).filter((s) => coverageTier(getCoverage(s)) === 'one_sided')
    );
    for (const b of band) expect(oneSided.has(b.slug), b.slug).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 7 · The captions in both languages — bilingual parity is a hard rule,
 *     and a caption that only exists in English is a broken one
 * ------------------------------------------------------------------ */
test.describe('caption copy, EN and ES', () => {
  const en = JSON.parse(readFileSync(join(__dirname, '..', 'messages', 'en.json'), 'utf8')).news;
  const es = JSON.parse(readFileSync(join(__dirname, '..', 'messages', 'es.json'), 'utf8')).news;

  const KEYS = [
    'captionCorroborated',
    'captionCorroboratedCenter',
    'captionMostViewed',
    'captionMostViewedThisWeek',
    'subheadEvidence',
  ] as const;

  test('every caption string exists in both languages', () => {
    for (const key of KEYS) {
      expect(typeof en[key], `en.news.${key}`).toBe('string');
      expect(typeof es[key], `es.news.${key}`).toBe('string');
      expect(es[key], `es.news.${key} must not be the English string`).not.toBe(en[key]);
    }
    for (const lean of ['left', 'center', 'right'] as const) {
      expect(typeof en.lean[lean]).toBe('string');
      expect(typeof es.lean[lean]).toBe('string');
    }
  });

  test('both languages carry the counted argument each caption is built on', () => {
    // The ICU-argument parity gate (scripts/check-messages-parity.mjs) proves
    // EN and ES take the SAME arguments; this pins WHICH argument each caption
    // must carry, so a rewrite cannot quietly stop saying the number.
    for (const m of [en.captionCorroborated, es.captionCorroborated]) expect(m).toContain('{count');
    for (const m of [en.captionCorroborated, es.captionCorroborated]) expect(m).toContain('{leans}');
    for (const m of [en.captionCorroboratedCenter, es.captionCorroboratedCenter]) expect(m).toContain('{count');
    for (const m of [en.captionMostViewed, es.captionMostViewed]) expect(m).toContain('{weeks');
  });

  test('ONLY the cross-spectrum caption may print a lean list', () => {
    // The copy half of the single-lean finding. A lean list of one can only
    // ever belong to `corroborated_center` (two center outlets dedupe to one
    // lean) and to no other kind — so the guarantee "no rendered caption states
    // a spread over one lean" holds as long as no OTHER string prints {leans}.
    // The most-viewed captions must not print an outlet count either: a C2 card
    // holds at most one rated outlet, and one is not a number this band says.
    for (const key of ['captionCorroboratedCenter', 'captionMostViewed', 'captionMostViewedThisWeek'] as const) {
      for (const m of [en[key], es[key]]) expect(m, key).not.toContain('{leans}');
    }
    for (const key of ['captionMostViewed', 'captionMostViewedThisWeek'] as const) {
      for (const m of [en[key], es[key]]) expect(m, key).not.toContain('{count');
    }
  });

  test('no caption asserts anything about a vote, and none is an adjective', () => {
    // The band is a lens on what is being read and written about. It makes no
    // claim about the floor, and it never grades the coverage it counts.
    const forbidden = /\b(vote|votación|scheduled|programad|urgent|urgente|major|importante|widely|ampliamente|masiv)/i;
    for (const key of KEYS) {
      expect(en[key], `en.news.${key}`).not.toMatch(forbidden);
      expect(es[key], `es.news.${key}`).not.toMatch(forbidden);
    }
  });

  test('the fallback deck is still there — a captionless band must not describe captions', () => {
    expect(typeof en.subhead).toBe('string');
    expect(typeof es.subhead).toBe('string');
    expect(en.subhead).not.toBe(en.subheadEvidence);
  });
});

/* ------------------------------------------------------------------ *
 * 8 · The RENDERED caption — the sentence a reader actually sees, in both
 *     languages, formatted by the same next-intl machinery the component
 *     uses. Sections 1–3 pin the counted facts; this pins the WORDS, which
 *     is where the 2026-08-12 finding was visible ("covered by 1 outlet:
 *     left" under a homepage card).
 * ------------------------------------------------------------------ */
test.describe('the rendered caption, EN and ES', () => {
  const MESSAGES = {
    en: JSON.parse(readFileSync(join(__dirname, '..', 'messages', 'en.json'), 'utf8')),
    es: JSON.parse(readFileSync(join(__dirname, '..', 'messages', 'es.json'), 'utf8')),
  };
  const LOCALES = ['en', 'es'] as const;

  /** Every lean word either language can put in a caption, in one alternation —
   *  the thing a most-viewed card must never contain. */
  const LEAN_WORD = /\b(left|center|right|izquierda|centro|derecha)\b/i;
  /** "1 outlet" / "1 medio", in either order of the plural forms. */
  const LONE_OUTLET = /\b1\s+(outlet|medio)\b/i;

  const MESSAGE_KEY: Record<NewsCaptionKind, string> = {
    corroborated: 'captionCorroborated',
    corroborated_center: 'captionCorroboratedCenter',
    most_viewed: 'captionMostViewed',
    most_viewed_this_week: 'captionMostViewedThisWeek',
  };

  /** The SAME switch components/NewsLens.tsx runs, over the same messages and
   *  the same formatter — kept here rather than imported because the component
   *  is a server component and this suite has no request scope. If it drifts,
   *  the exhaustiveness assert below is what catches it. */
  function render(locale: (typeof LOCALES)[number], caption: NewsCaption): string {
    const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'news' });
    const format = createFormatter({ locale });
    const leans = format.list(
      caption.leans.map((lean) => t(`lean.${lean}` as 'lean.left')),
      { type: 'conjunction' }
    ) as string;
    switch (caption.kind) {
      case 'corroborated':
        return t('captionCorroborated', { count: caption.outlets, leans });
      case 'corroborated_center':
        return t('captionCorroboratedCenter', { count: caption.outlets });
      case 'most_viewed':
        return t('captionMostViewed', { weeks: caption.weeks });
      case 'most_viewed_this_week':
        return t('captionMostViewedThisWeek');
    }
  }

  /** One band that reaches all four caption kinds at once. The cap is lifted so
   *  both most-viewed routes render together — this fixture is about the words,
   *  and the cap has its own tests in section 3. */
  const everyKind = (): ConversationSelection[] =>
    selectConversationBand(
      poolOf({
        'hr-1-119': corroborated(outlet('cnn.com', 'left'), outlet('foxnews.com', 'right')),
        'hr-2-119': corroborated(outlet('reuters.com', 'center'), outlet('npr.org', 'center')),
        'hr-3-119': { ...corroborated(), mostViewed: mostViewed(3, 1) },
        'hr-4-119': { ...corroborated(outlet('cnn.com', 'left')), mostViewed: mostViewed(1, 2) },
      }),
      { limit: 6, mostViewedCap: 6 }
    );

  test('every caption kind the selector can emit renders in both languages', () => {
    const kinds = new Set(everyKind().map((c) => c.caption.kind));
    // Non-vacuity AND exhaustiveness: the fixture reaches every kind, and every
    // kind has a string. A kind added later with no copy fails here.
    expect([...kinds].sort()).toEqual([...NEWS_CAPTION_KINDS].sort());
    for (const kind of NEWS_CAPTION_KINDS) {
      for (const locale of LOCALES) expect(typeof MESSAGES[locale].news[MESSAGE_KEY[kind]], `${locale}.${kind}`).toBe('string');
    }
  });

  test('NO rendered caption ever states one outlet or a spread over one lean', () => {
    const cards = everyKind();
    expect(cards.length).toBeGreaterThan(3);
    for (const card of cards) {
      for (const locale of LOCALES) {
        const sentence = render(locale, card.caption);
        expect(sentence.length, `${locale} ${card.slug}`).toBeGreaterThan(0);
        expect(sentence, `${locale} ${card.slug}`).not.toMatch(LONE_OUTLET);
        if (card.caption.kind === 'most_viewed' || card.caption.kind === 'most_viewed_this_week') {
          // The card whose stored evidence holds exactly one left-leaning
          // outlet renders the congress.gov fact and NOTHING about that outlet.
          expect(sentence, `${locale} ${card.slug}`).not.toMatch(LEAN_WORD);
        }
        if (card.caption.kind === 'corroborated') {
          // The one caption that lists leans lists at least two, always.
          expect(card.caption.leans.length, card.slug).toBeGreaterThanOrEqual(2);
          for (const lean of card.caption.leans) {
            expect(sentence, `${locale} ${card.slug}`).toContain(MESSAGES[locale].news.lean[lean]);
          }
        }
      }
    }
  });

  test('the pairing-route card says the same thing in both languages: the listing', () => {
    const card = everyKind().find((c) => c.evidence.reason === 'most-viewed-plus-article')!;
    expect(card.evidence.ratedOutlets).toBe(1);
    expect(render('en', card.caption)).toBe("Among congress.gov's most-viewed bills this week");
    expect(render('es', card.caption)).toBe('Entre los proyectos más vistos de congress.gov esta semana');
  });
});
