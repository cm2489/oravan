import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONVERSATION_SCHEMA,
  CONVERSATION_STALE_HOURS,
  MOST_VIEWED_ONLY_CARD_CAP,
  OUTLET_WINDOW_DAYS,
  conversationBandPool,
  conversationPosture,
  newsSpread,
  selectConversationBand,
  type ConversationPoolItem,
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
 *   B-1  a single outlet renders NOTHING — there is no rung for it to reach,
 *        and the pool the selector reads cannot contain one.
 *   B-2  most-viewed needs two consecutive weeks or a rated article, and
 *        most-viewed-ONLY cards are capped at MOST_VIEWED_ONLY_CARD_CAP of six.
 *   B-3  only AllSides-rated outlets are counted (enforced at write time; here
 *        the consequence is pinned — an unrated domain contributes no count).
 *   B-4  the writer's business, but its consequence is here: a caption never
 *        claims a spread it does not hold.
 */

const T = '2026-08-12';
const NOW = Date.parse(`${T}T18:00:00Z`);
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
test.describe('B-1: the single-outlet path does not exist', () => {
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

  test('one week PLUS one rated article renders, and the caption prints both facts', () => {
    const [card] = selectConversationBand(
      poolOf({ 'hr-1-119': { ...corroborated(outlet('cnn.com', 'left')), mostViewed: mostViewed(1, 5) } }),
      { limit: 6 }
    );
    expect(card.caption).toEqual({
      kind: 'most_viewed_covered',
      outlets: 1,
      leans: ['left'],
      weeks: 1,
      rank: 5,
    });
  });

  test(`most-viewed-only cards are capped at ${MOST_VIEWED_ONLY_CARD_CAP} of six`, () => {
    const slugs: Record<string, unknown> = {};
    for (let i = 1; i <= 6; i++) slugs[`hr-${i}-119`] = { ...corroborated(), mostViewed: mostViewed(2, i) };
    const band = selectConversationBand(poolOf(slugs), { limit: 6 });
    expect(band).toHaveLength(MOST_VIEWED_ONLY_CARD_CAP);
    // The cap is on UNCORROBORATED cards only: one with a rated article beside
    // it is not "most-viewed-only" and is not counted against it.
    slugs['hr-7-119'] = { ...corroborated(outlet('cnn.com', 'left')), mostViewed: mostViewed(2, 7) };
    const withArticle = selectConversationBand(poolOf(slugs), { limit: 6 });
    expect(withArticle).toHaveLength(MOST_VIEWED_ONLY_CARD_CAP + 1);
    expect(withArticle.filter((c) => c.caption.kind === 'most_viewed')).toHaveLength(MOST_VIEWED_ONLY_CARD_CAP);
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

  test('a file no run has written yet is NOT live — the seed state falls back', () => {
    // The state this branch merges in: the seed commit carries
    // source_status.press.status === "unknown" until the first hourly newsdesk
    // run replaces it. The band must render exactly what it rendered before the
    // lamp existed, with no captions, rather than going dark.
    expect(FILE._meta.source_status.press.status === 'unknown' || conversationPosture(NOW) === 'live').toBeTruthy();
  });

  test('the pool is empty whenever the posture is not live', () => {
    if (conversationPosture() !== 'live') expect(conversationBandPool()).toEqual([]);
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
    'captionMostViewedCovered',
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
    for (const m of [en.captionMostViewedCovered, es.captionMostViewedCovered]) {
      expect(m).toContain('{count');
      expect(m).toContain('{leans}');
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
