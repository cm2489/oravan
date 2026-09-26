import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Pure, I/O-free module (no keys, no network, no fs) — see lib/conversation.mjs's
// header for the whole design these pin, and which critic patch each rule is.
import {
  ARTICLE_URL_MAX_LENGTH,
  buildConversation,
  CONVERSATION_MAX_BYTES,
  CONVERSATION_READABLE_SCHEMAS,
  CONVERSATION_SCHEMA,
  conversationEvidence,
  conversationPool,
  conversationTier,
  committedDarkFeeds,
  CORROBORATION_MIN_RATED_OUTLETS,
  DARK_LEAN_ALARM_DAYS,
  darkFeeds,
  darkLeans,
  daysBetween,
  enteredCorroborated,
  FEED_DARK_ALARM_DAYS,
  feedStatuses,
  isConsecutiveWeek,
  leanOf,
  leanStatuses,
  materialFingerprint,
  MOST_VIEWED_MIN_WEEKS,
  MOST_VIEWED_CARD_CAP,
  normalizeArticleUrl,
  normalizeDomain,
  observeMostViewed,
  observeOutlets,
  OUTLET_WINDOW_DAYS,
  rollFeedHealth,
  rollLeanHealth,
  shouldWrite,
  verifyConversation,
} from '../lib/conversation.mjs';
// The verdict half of the re-decode trigger. Owned by the docket ladder's
// module and shared UNCHANGED with the conversation lamp's queue — "is this
// decode still about this bill" must mean one thing on both paths.
import { redecodeVerdict } from '../scripts/floor-signals-parse.mjs';
// The band's posture rule, pure over a fixture — used only to prove the
// per-feed block (source_status.feeds) never flips the band to its fallback.
import { conversationPostureOf } from '../lib/conversation';
import { extractMostViewedRanked, extractMostViewedSlugs } from '../scripts/newsdesk-match.mjs';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

// congress.gov's real weekly most-viewed feed, fetched live 2026-08-12 and
// committed unmodified. Ten <li> entries; #9 is S.Res.817, an untracked simple
// resolution, which is why rank 10 must survive as 10.
const MOST_VIEWED = fixture('congress-most-viewed-2026-08-09.xml');

const BIAS: Record<string, string> = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'media-bias.json'), 'utf8')
).outlets;

const T = '2026-08-12';
const NOW = Date.parse(`${T}T18:00:00Z`);
const minus = (days: number) => new Date(Date.parse(`${T}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** The article link a fixture observation carries (B-5): canonical, so what
 *  the writer stores is byte-identical to what the fixture expects. */
const link = (domain: string, story = 'story') => `https://www.${domain}/politics/${story}`;
/** One observation as scripts/newsdesk.mjs hands it over. */
const seen = (outlet: string, story = 'story') => ({ outlet, url: link(outlet, story) });
const outlet = (domain: string, lean: string, lastSeen = T, firstSeen = lastSeen) => ({
  domain,
  lean,
  firstSeen,
  lastSeen,
  url: link(domain),
});
const unratedEntry = (domain: string, lastSeen = T, firstSeen = lastSeen) => ({ domain, firstSeen, lastSeen, url: link(domain) });

/* ------------------------------------------------------------------ *
 * 1 · The rated-outlet rule (critic B-3) — who may corroborate at all
 * ------------------------------------------------------------------ */
test.describe('leanOf — the B-3 gate', () => {
  test('returns the AllSides lean for a rated domain', () => {
    expect(leanOf('foxnews.com', BIAS)).toBe('right');
    expect(leanOf('washingtontimes.com', BIAS)).toBe('right');
    expect(leanOf('cnbc.com', BIAS)).toBe('center');
    expect(leanOf('politico.com', BIAS)).toBe('left');
  });

  test('returns null for an unrated domain — including the congress trade pub in our own basket', () => {
    // rollcall.com is deliberately in the press basket and deliberately absent
    // from data/media-bias.json. It contributes headlines; it corroborates
    // nothing.
    expect(BIAS['rollcall.com']).toBeUndefined();
    expect(leanOf('rollcall.com', BIAS)).toBeNull();
    expect(leanOf('some-content-farm.example', BIAS)).toBeNull();
  });

  test('the unresolved-outlet sentinel is not a domain', () => {
    expect(normalizeDomain('unknown')).toBeNull();
    expect(leanOf('unknown', BIAS)).toBeNull();
    expect(leanOf('', BIAS)).toBeNull();
    expect(leanOf(null, BIAS)).toBeNull();
  });

  test('normalizes scheme, www and path before the lookup', () => {
    expect(leanOf('https://www.NPR.org/politics', BIAS)).toBe('center');
  });
});

test.describe('observeOutlets — rated and unrated are split at WRITE time', () => {
  test('a rated outlet lands in outlets7d with its lean; an unrated one lands beside it, counted by nothing', () => {
    const folded = observeOutlets(undefined, {
      observed: [seen('foxnews.com'), seen('rollcall.com'), { outlet: 'unknown', url: 'https://news.google.com/x' }],
      bias: BIAS,
      today: T,
    });
    expect(folded.outlets7d).toEqual([outlet('foxnews.com', 'right')]);
    expect(folded.unratedOutlets7d).toEqual([unratedEntry('rollcall.com')]);
    // the sentinel never becomes an outlet on either side
    expect(JSON.stringify(folded)).not.toContain('unknown');
  });

  test('re-seeing an outlet moves lastSeen and keeps firstSeen', () => {
    const prev = { outlets7d: [outlet('npr.org', 'center', minus(2))], unratedOutlets7d: [] };
    const folded = observeOutlets(prev, { observed: [seen('npr.org')], bias: BIAS, today: T });
    expect(folded.outlets7d).toEqual([outlet('npr.org', 'center', T, minus(2))]);
  });

  test('an observation that falls out of the 7-day window is dropped, not carried', () => {
    const prev = {
      outlets7d: [outlet('npr.org', 'center', minus(OUTLET_WINDOW_DAYS + 1)), outlet('cbsnews.com', 'left', minus(OUTLET_WINDOW_DAYS))],
      unratedOutlets7d: [unratedEntry('rollcall.com', minus(20))],
    };
    const folded = observeOutlets(prev, { observed: [], bias: BIAS, today: T });
    expect(folded.outlets7d.map((o) => o.domain)).toEqual(['cbsnews.com']);
    expect(folded.unratedOutlets7d).toEqual([]);
  });

  test('a domain that gains a rating stops being an unrated observation', () => {
    const prev = { outlets7d: [], unratedOutlets7d: [unratedEntry('foxnews.com', minus(1))] };
    const folded = observeOutlets(prev, { observed: [seen('foxnews.com')], bias: BIAS, today: T });
    expect(folded.outlets7d).toEqual([outlet('foxnews.com', 'right', T, minus(1))]);
    expect(folded.unratedOutlets7d).toEqual([]);
  });

  test('a domain the table has JUST rated moves across without waiting to be seen again', () => {
    // The regression: only carried RATED entries were re-judged, so a bias-
    // table edit left the new domain's carried entries in the unrated list —
    // exactly what the gate's "rates it — it belongs in outlets7d" check
    // fails on — until the outlet happened to publish again. abcnews.com sat
    // in two unrated lists on 2026-09-25 with an alias rating proposed.
    const bias = { ...BIAS, 'example-wire.test': 'center' };
    const prev = { outlets7d: [], unratedOutlets7d: [unratedEntry('example-wire.test', minus(3), minus(4))] };
    const folded = observeOutlets(prev, { observed: [], bias, today: T });
    expect(folded.outlets7d.map((o) => [o.domain, o.lean, o.firstSeen, o.lastSeen])).toEqual([['example-wire.test', 'center', minus(4), minus(3)]]);
    expect(folded.unratedOutlets7d).toEqual([]);
    // ...and a whole document built after the edit passes the gate that edit
    // would otherwise have failed.
    const doc = buildConversation({ previous: { slugs: { 'hr-1-119': prev } }, bias, now: NOW, today: T });
    expect(verifyConversation({ data: doc, fileBytes: 1000, now: NOW, bias }).failures).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 1b · B-5 — every observation carries the link to its story
 *      (conversation/v2, owner ruling 2026-09-26: the band's "every count
 *      comes from stored evidence you can check" is made true by storing it)
 * ------------------------------------------------------------------ */
test.describe('B-5: the article link', () => {
  test('normalizeArticleUrl accepts http(s) article links and returns the canonical form', () => {
    expect(normalizeArticleUrl('https://www.foxnews.com/politics/story?utm_source=rss')).toBe(
      'https://www.foxnews.com/politics/story?utm_source=rss'
    );
    // Google News redirect links are what the aggregator feed serves; stored as given.
    expect(normalizeArticleUrl('https://news.google.com/rss/articles/CBMiabc?oc=5')).toBe('https://news.google.com/rss/articles/CBMiabc?oc=5');
    // surrounding whitespace from a feed body is trimmed; the host is lower-cased by the URL standard
    expect(normalizeArticleUrl('  https://WWW.NPR.org/x  ')).toBe('https://www.npr.org/x');
  });

  test('normalizeArticleUrl refuses anything a reader could not safely follow', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com/x',
      '/relative/path',
      'https://localhost/x', // no dotted host
      'https://user:pass@example.com/x', // embedded credentials
      'https://example.com/a b', // whitespace inside
      `https://example.com/${'a'.repeat(ARTICLE_URL_MAX_LENGTH)}`,
      '',
      null,
      undefined,
      42,
    ]) {
      expect(normalizeArticleUrl(bad as unknown as string), String(bad).slice(0, 40)).toBeNull();
    }
  });

  test('an observation with no checkable link records NOTHING — a count must trace to a story', () => {
    const folded = observeOutlets(undefined, {
      observed: [
        'foxnews.com', // bare outlet, no link
        { outlet: 'npr.org', url: 'javascript:alert(1)' },
        { outlet: 'cbsnews.com', url: null },
      ],
      bias: BIAS,
      today: T,
    });
    expect(folded).toEqual({ outlets7d: [], unratedOutlets7d: [] });
  });

  test('a Map<outlet, url> — the newsdesk accumulator — folds in directly', () => {
    const folded = observeOutlets(undefined, {
      observed: new Map([['foxnews.com', link('foxnews.com')], ['rollcall.com', link('rollcall.com')]]),
      bias: BIAS,
      today: T,
    });
    expect(folded.outlets7d).toEqual([outlet('foxnews.com', 'right')]);
    expect(folded.unratedOutlets7d).toEqual([unratedEntry('rollcall.com')]);
  });

  test('a second story from the same outlet on the same day keeps the first link — no byte moves', () => {
    const first = observeOutlets(undefined, { observed: [seen('foxnews.com', 'morning')], bias: BIAS, today: T });
    const again = observeOutlets(first, { observed: [seen('foxnews.com', 'evening')], bias: BIAS, today: T });
    expect(again).toEqual(first);
    expect(again.outlets7d[0].url).toBe(link('foxnews.com', 'morning'));
  });

  test('the first story on a NEW day replaces the link along with the date', () => {
    const before = { outlets7d: [{ ...outlet('foxnews.com', 'right', minus(1)), url: link('foxnews.com', 'yesterday') }] };
    const folded = observeOutlets(before, { observed: [seen('foxnews.com', 'today')], bias: BIAS, today: T });
    expect(folded.outlets7d).toEqual([{ domain: 'foxnews.com', lean: 'right', firstSeen: minus(1), lastSeen: T, url: link('foxnews.com', 'today') }]);
  });

  test('the link moves WITH an entry when the bias table re-rates its domain', () => {
    // An owner edit to data/media-bias.json can rate a domain that was only
    // ever unrated. Its carried entry must arrive in outlets7d still holding
    // its link — otherwise the gate would red the next hourly write for an
    // entry nobody could have linked.
    const bias = { ...BIAS, 'example-wire.test': 'center' };
    const prev = { outlets7d: [], unratedOutlets7d: [unratedEntry('example-wire.test', minus(2))] };
    const folded = observeOutlets(prev, { observed: [], bias, today: T });
    expect(folded.outlets7d).toEqual([{ domain: 'example-wire.test', lean: 'center', firstSeen: minus(2), lastSeen: minus(2), url: link('example-wire.test') }]);
  });

  test('a v1-era entry with no link is carried as it was — no url key invented', () => {
    const legacy = { domain: 'npr.org', lean: 'center', firstSeen: minus(1), lastSeen: minus(1) };
    const folded = observeOutlets({ outlets7d: [legacy] }, { observed: [], bias: BIAS, today: T });
    expect(folded.outlets7d).toEqual([legacy]);
    expect('url' in folded.outlets7d[0]).toBe(false);
  });

  test('a carried link that is not canonical is dropped rather than carried', () => {
    const tainted = { ...outlet('npr.org', 'center', minus(1)), url: 'javascript:alert(1)' };
    const folded = observeOutlets({ outlets7d: [tainted] }, { observed: [], bias: BIAS, today: T });
    expect('url' in folded.outlets7d[0]).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · The tiers — B-1 (one outlet admits nothing) and B-2 (most-viewed
 *     is never sufficient alone)
 * ------------------------------------------------------------------ */
test.describe('conversationTier', () => {
  test('two rated outlets is C1 — corroborated', () => {
    const entry = { outlets7d: [outlet('foxnews.com', 'right'), outlet('cbsnews.com', 'left', minus(1))] };
    const ev = conversationEvidence(entry, { today: T });
    expect(ev.tier).toBe('c1');
    expect(ev.ratedOutlets).toBe(CORROBORATION_MIN_RATED_OUTLETS);
    expect(ev.leanSpread).toEqual(['left', 'right']);
    expect(ev.newestSeen).toBe(T);
  });

  test('B-1: ONE rated outlet renders nothing, ever', () => {
    const ev = conversationEvidence({ outlets7d: [outlet('politico.com', 'left')] }, { today: T });
    expect(ev.tier).toBe('c0');
    expect(ev.reason).toBe('single-outlet');
  });

  test('B-3: one rated outlet plus any number of UNRATED ones is still one outlet', () => {
    const entry = {
      outlets7d: [outlet('foxnews.com', 'right')],
      unratedOutlets7d: [
        { domain: 'rollcall.com', firstSeen: T, lastSeen: T },
        { domain: 'aggregated-pickup.example', firstSeen: T, lastSeen: T },
        { domain: 'another-pickup.example', firstSeen: T, lastSeen: T },
      ],
    };
    expect(conversationTier(entry, { today: T })).toBe('c0');
    expect(conversationEvidence(entry, { today: T }).ratedOutlets).toBe(1);
  });

  test('B-2: a first-week most-viewed appearance with no article renders nothing', () => {
    const entry = { outlets7d: [], mostViewed: { weeksOnList: 1, lastRank: 1, lastSeen: T, lastWeek: T } };
    const ev = conversationEvidence(entry, { today: T });
    expect(ev.tier).toBe('c0');
    expect(ev.reason).toBe('most-viewed-alone');
  });

  test('B-2: most-viewed becomes C2 on two consecutive weeks', () => {
    const entry = { outlets7d: [], mostViewed: { weeksOnList: MOST_VIEWED_MIN_WEEKS, lastRank: 1, lastSeen: T, lastWeek: T } };
    expect(conversationEvidence(entry, { today: T }).reason).toBe('most-viewed-weeks');
    expect(conversationTier(entry, { today: T })).toBe('c2');
  });

  test('B-2: most-viewed becomes C2 with one corroborating rated article', () => {
    const entry = {
      outlets7d: [outlet('cnbc.com', 'center')],
      mostViewed: { weeksOnList: 1, lastRank: 4, lastSeen: T, lastWeek: T },
    };
    expect(conversationEvidence(entry, { today: T }).reason).toBe('most-viewed-plus-article');
  });

  test('a most-viewed observation older than the window stops counting', () => {
    const entry = {
      outlets7d: [],
      mostViewed: { weeksOnList: 4, lastRank: 1, lastSeen: minus(OUTLET_WINDOW_DAYS + 1), lastWeek: minus(OUTLET_WINDOW_DAYS + 1) },
    };
    expect(conversationTier(entry, { today: T })).toBe('c0');
  });

  test('an empty entry is C0 and says why', () => {
    expect(conversationEvidence({}, { today: T })).toMatchObject({ tier: 'c0', reason: 'no-corroboration', ratedOutlets: 0 });
  });

  test('the most-viewed card cap is a published number, not a local constant', () => {
    // Critic B-2's third clause. Consumers import THIS — and since 2026-08-12
    // it counts EVERY card the list admits, not only the ones with no article
    // beside them (lib/conversation.ts's selectConversationBand, section 3 of
    // tests/news-band.unit.spec.ts).
    expect(MOST_VIEWED_CARD_CAP).toBe(2);
  });
});

test.describe('conversationPool', () => {
  test('C1 before C2, then more outlets, then newest, then slug', () => {
    const doc = {
      slugs: {
        'hr-2-119': { outlets7d: [outlet('foxnews.com', 'right'), outlet('npr.org', 'center')] },
        'hr-3-119': { outlets7d: [outlet('foxnews.com', 'right'), outlet('npr.org', 'center'), outlet('cbsnews.com', 'left')] },
        'hr-4-119': { outlets7d: [], mostViewed: { weeksOnList: 3, lastRank: 1, lastSeen: T, lastWeek: T } },
        'hr-5-119': { outlets7d: [outlet('politico.com', 'left')] },
      },
    };
    expect(conversationPool(doc, { today: T }).map((p) => p.slug)).toEqual(['hr-3-119', 'hr-2-119', 'hr-4-119']);
  });

  /* ---- C2 is ordered by the LIST'S OWN RANK (owner ruling 2026-09-26) ---- *
   * Before the ruling C2 shared C1's comparator. A bill the list alone admits
   * has no rated outlets and was last seen the same day as the rest of that
   * week's list, so every tie fell through to the slug: "hr-1-119" sorts
   * first, and H.R. 1 (rank 7, a 2025 law) held a band slot on 25 of the 32
   * days replayed 2026-08-25 -> 2026-09-25 while rank 1 never did.           */
  const listed = (lastRank: number, lastWeek: string | null = '2026-08-09', weeksOnList = 3) => ({
    outlets7d: [],
    mostViewed: { weeksOnList, lastRank, lastSeen: T, lastWeek },
  });

  test('C2: rank 1 before rank 7, whatever the slugs say — the H.R. 1 tiebreak, pinned', () => {
    const doc = { slugs: { 'hr-1-119': listed(7), 'hr-6509-119': listed(1), 's-2296-119': listed(5) } };
    expect(conversationPool(doc, { today: T }).map((p) => p.slug)).toEqual(['hr-6509-119', 's-2296-119', 'hr-1-119']);
  });

  test('C2: an article beside the listing does not buy a better slot — only the rank orders', () => {
    // It used to: rated outlets were C2's first key, so a rank-6 bill with one
    // article outranked a rank-1 bill with none. The card never prints that
    // article (B-1), so it must not decide the order either.
    const doc = {
      slugs: {
        's-5025-119': { outlets7d: [outlet('cbsnews.com', 'left')], mostViewed: { weeksOnList: 1, lastRank: 6, lastSeen: T, lastWeek: '2026-08-09' } },
        'hr-6509-119': listed(1),
      },
    };
    expect(conversationPool(doc, { today: T }).map((p) => p.slug)).toEqual(['hr-6509-119', 's-5025-119']);
  });

  test('C2: the NEWEST list comes first — a rank from an older list is not comparable', () => {
    // A bill that fell off this week's list stays inside the seven-day window
    // for up to a week. Its old rank 1 must not outrank this week's rank 4.
    const doc = { slugs: { 'hr-2-119': listed(1, '2026-08-02'), 'hr-3-119': listed(4, '2026-08-09') } };
    expect(conversationPool(doc, { today: T }).map((p) => p.slug)).toEqual(['hr-3-119', 'hr-2-119']);
  });

  test('C2: a listing with no printed week sorts after every labelled one; equal ranks fall back to slug', () => {
    const doc = { slugs: { 'hr-9-119': listed(1, null), 'hr-8-119': listed(3), 'hr-7-119': listed(3) } };
    expect(conversationPool(doc, { today: T }).map((p) => p.slug)).toEqual(['hr-7-119', 'hr-8-119', 'hr-9-119']);
  });

  test('C1 order is unchanged by the C2 ruling — press is still ordered by breadth', () => {
    const doc = {
      slugs: {
        'hr-1-119': {
          outlets7d: [outlet('foxnews.com', 'right'), outlet('npr.org', 'center')],
          mostViewed: { weeksOnList: 2, lastRank: 9, lastSeen: T, lastWeek: T },
        },
        'hr-2-119': { outlets7d: [outlet('foxnews.com', 'right'), outlet('npr.org', 'center'), outlet('cbsnews.com', 'left')] },
      },
    };
    expect(conversationPool(doc, { today: T }).map((p) => p.slug)).toEqual(['hr-2-119', 'hr-1-119']);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · Most-viewed persistence — ranks, week labels, weeksOnList
 * ------------------------------------------------------------------ */
test.describe('extractMostViewedRanked', () => {
  test('reads the ranks and the feed\'s own printed week off the real feed', () => {
    const parsed = extractMostViewedRanked(MOST_VIEWED);
    expect(parsed.week).toBe('2026-08-09');
    expect(parsed.weekLabel).toBe('Most-Viewed Bills - Week of August 9, 2026');
    expect(parsed.entries.slice(0, 3)).toEqual([
      { slug: 'hr-6509-119', rank: 1 },
      { slug: 'hr-3633-119', rank: 2 },
      { slug: 's-2296-119', rank: 3 },
    ]);
  });

  test('a dropped list item does not renumber the ones after it', () => {
    // Entry 9 is S.Res.817 — a simple resolution this build does not track.
    // Renumbering S.5025 from 10 to 9 would invent a rank congress.gov never
    // published, and the rank is a quoted fact.
    const parsed = extractMostViewedRanked(MOST_VIEWED);
    expect(parsed.entries.find((e) => e.slug === 's-5025-119')).toEqual({ slug: 's-5025-119', rank: 10 });
    expect(parsed.entries.some((e) => e.slug.startsWith('sres'))).toBe(false);
  });

  test('stays a strict projection of the slug extractor the trigger path uses', () => {
    expect(extractMostViewedSlugs(MOST_VIEWED)).toEqual(extractMostViewedRanked(MOST_VIEWED).entries.map((e) => e.slug));
  });

  test('an empty or unparseable body yields nothing rather than guessing', () => {
    expect(extractMostViewedRanked('')).toEqual({ week: null, weekLabel: null, entries: [] });
    expect(extractMostViewedRanked('<rss><channel></channel></rss>').entries).toEqual([]);
  });

  test('a 118th-Congress entry is excluded, not remapped', () => {
    const xml = `<item><title>Most-Viewed Bills - Week of August 9, 2026</title><description><![CDATA[<ol><li><a>H.R.4818</a> [118th] - old</li><li><a>H.R.22</a> [119th] - SAVE Act</li></ol>]]></description></item>`;
    expect(extractMostViewedRanked(xml).entries).toEqual([{ slug: 'hr-22-119', rank: 2 }]);
  });
});

test.describe('observeMostViewed — weeksOnList counts CONSECUTIVE weeks', () => {
  test('a first appearance is week 1', () => {
    expect(observeMostViewed(null, { rank: 4, week: '2026-08-09', today: T })).toEqual({
      weeksOnList: 1,
      lastRank: 4,
      lastSeen: T,
      lastWeek: '2026-08-09',
    });
  });

  test('the next week increments', () => {
    const prev = { weeksOnList: 1, lastRank: 4, lastSeen: '2026-08-04', lastWeek: '2026-08-02' };
    expect(observeMostViewed(prev, { rank: 2, week: '2026-08-09', today: T }).weeksOnList).toBe(2);
  });

  test('re-observing the SAME week on a later day does not double count', () => {
    const prev = { weeksOnList: 2, lastRank: 2, lastSeen: '2026-08-10', lastWeek: '2026-08-09' };
    const next = observeMostViewed(prev, { rank: 2, week: '2026-08-09', today: T });
    expect(next.weeksOnList).toBe(2);
    expect(next.lastSeen).toBe(T);
  });

  test('a missed week resets the streak to 1 — "two weeks running" must mean it', () => {
    const prev = { weeksOnList: 5, lastRank: 1, lastSeen: '2026-07-20', lastWeek: '2026-07-19' };
    expect(observeMostViewed(prev, { rank: 1, week: '2026-08-09', today: T }).weeksOnList).toBe(1);
  });

  test('an unreadable week label records the rank but never manufactures a second week', () => {
    const prev = { weeksOnList: 1, lastRank: 4, lastSeen: '2026-08-04', lastWeek: '2026-08-02' };
    const next = observeMostViewed(prev, { rank: 3, week: null, today: T });
    expect(next.weeksOnList).toBe(1);
    expect(next.lastRank).toBe(3);
    expect(next.lastWeek).toBe('2026-08-02');
  });

  test('isConsecutiveWeek tolerates a slipped publication but never a skipped week', () => {
    expect(isConsecutiveWeek('2026-08-02', '2026-08-09')).toBe(true);
    expect(isConsecutiveWeek('2026-08-02', '2026-08-10')).toBe(true);
    expect(isConsecutiveWeek('2026-08-02', '2026-08-16')).toBe(false);
    expect(isConsecutiveWeek(null, '2026-08-09')).toBe(false);
  });

  test('daysBetween treats an unparseable stamp as infinitely old (fails toward dropping evidence)', () => {
    expect(daysBetween('not-a-date', T)).toBe(Infinity);
  });
});

/* ------------------------------------------------------------------ *
 * 4 · Churn suppression — an hourly cron must not become an hourly deploy
 * ------------------------------------------------------------------ */
type BuildOpts = {
  previous?: unknown;
  /** slug -> outlet domains; each becomes an observation carrying link(domain). */
  outlets?: Map<string, string[]>;
  mostViewed?: { week?: string | null; weekLabel?: string | null; entries: { slug: string; rank: number }[] } | null;
  sourceStatus?: Record<string, unknown>;
  now?: number;
  today?: string;
};

const build = (opts: BuildOpts) =>
  buildConversation({
    previous: opts.previous ?? null,
    outletsBySlug: new Map([...(opts.outlets ?? new Map<string, string[]>())].map(([slug, domains]) => [slug, domains.map((d) => seen(d))])),
    mostViewed: opts.mostViewed ?? null,
    bias: BIAS,
    sourceStatus: opts.sourceStatus ?? { press: { status: 'ok', feeds_silent: 0, checked_at: 'x' } },
    now: opts.now ?? NOW,
    today: opts.today ?? T,
  });

test.describe('shouldWrite', () => {
  test('the first run always writes', () => {
    expect(shouldWrite({ previous: null, next: build({}) })).toBe(true);
  });

  test('re-seeing the same outlet on the same day writes nothing', () => {
    const first = build({ outlets: new Map([['hr-1-119', ['foxnews.com']]]) });
    const again = build({ previous: first, outlets: new Map([['hr-1-119', ['foxnews.com']]]), now: NOW + 3_600_000 });
    expect(shouldWrite({ previous: first, next: again })).toBe(false);
    // ...and the stamp genuinely moved, which is exactly what must NOT count
    expect(again._meta.fetched_at).not.toBe(first._meta.fetched_at);
  });

  test('a per-run count that flaps does not write; a source STATUS change does', () => {
    const first = build({ sourceStatus: { press: { status: 'ok', feeds_silent: 0, checked_at: 'a' } } });
    const flap = build({ previous: first, sourceStatus: { press: { status: 'ok', feeds_silent: 3, checked_at: 'b' } } });
    expect(shouldWrite({ previous: first, next: flap })).toBe(false);
    const degraded = build({ previous: first, sourceStatus: { press: { status: 'degraded', feeds_silent: 6, checked_at: 'c' } } });
    expect(shouldWrite({ previous: first, next: degraded })).toBe(true);
  });

  test('a LEAN going dark writes — the alarm must land in the committed file, not only in the run log', () => {
    const live = leanStatuses({ right: { last_live: T, first_dark: null } }, { today: T });
    const dark = leanStatuses({ right: { last_live: minus(9), first_dark: null } }, { today: T });
    const first = build({ sourceStatus: { leans: live } });
    const second = build({ previous: first, sourceStatus: { leans: dark } });
    expect(shouldWrite({ previous: first, next: second })).toBe(true);
    // ...and a lean that is merely one more day dark also moves, so the file's
    // own "dark for N days" can never be a number nobody updated.
    const darker = build({ previous: second, sourceStatus: { leans: leanStatuses({ right: { last_live: minus(10), first_dark: null } }, { today: T }) } });
    expect(shouldWrite({ previous: second, next: darker })).toBe(true);
  });

  test('a NEW outlet writes', () => {
    const first = build({ outlets: new Map([['hr-1-119', ['foxnews.com']]]) });
    const second = build({ previous: first, outlets: new Map([['hr-1-119', ['npr.org']]]) });
    expect(shouldWrite({ previous: first, next: second })).toBe(true);
  });

  test('the same outlet on a NEW day writes', () => {
    const first = build({ outlets: new Map([['hr-1-119', ['foxnews.com']]]), today: minus(1) });
    const second = build({ previous: first, outlets: new Map([['hr-1-119', ['foxnews.com']]]), today: T });
    expect(shouldWrite({ previous: first, next: second })).toBe(true);
  });

  test('a most-viewed transition writes', () => {
    const first = build({ mostViewed: { week: '2026-08-02', entries: [{ slug: 'hr-1-119', rank: 1 }] }, today: minus(7) });
    const second = build({
      previous: first,
      mostViewed: { week: '2026-08-09', entries: [{ slug: 'hr-1-119', rank: 1 }] },
      today: T,
    });
    expect(shouldWrite({ previous: first, next: second })).toBe(true);
    expect(second.slugs['hr-1-119'].mostViewed.weeksOnList).toBe(2);
  });

  test('a window prune writes — the file can never keep claiming stale evidence', () => {
    const old = build({ outlets: new Map([['hr-1-119', ['foxnews.com']]]), today: minus(OUTLET_WINDOW_DAYS + 1) });
    const pruned = build({ previous: old, today: T });
    expect(shouldWrite({ previous: old, next: pruned })).toBe(true);
    expect(pruned.slugs['hr-1-119']).toBeUndefined();
  });

  test('materialFingerprint ignores the stamp and the per-run counters, by name', () => {
    const doc = build({ outlets: new Map([['hr-1-119', ['foxnews.com']]]) });
    const print = materialFingerprint(doc);
    expect(print).not.toContain(doc._meta.fetched_at);
    expect(print).toContain('hr-1-119');
  });
});

test.describe('buildConversation', () => {
  test('writes the schema, the window and sorted slugs', () => {
    const doc = build({ outlets: new Map([['s-1-119', ['npr.org']], ['hr-1-119', ['foxnews.com']]]) });
    expect(doc._meta.schema).toBe(CONVERSATION_SCHEMA);
    expect(doc._meta.window_days).toBe(OUTLET_WINDOW_DAYS);
    expect(Object.keys(doc.slugs)).toEqual(['hr-1-119', 's-1-119']);
  });

  test('B-5: every recorded observation carries its link, rated and unrated alike', () => {
    const doc = build({ outlets: new Map([['hr-1-119', ['foxnews.com', 'rollcall.com']]]) });
    expect(doc.slugs['hr-1-119'].outlets7d[0].url).toBe(link('foxnews.com'));
    expect(doc.slugs['hr-1-119'].unratedOutlets7d[0].url).toBe(link('rollcall.com'));
  });

  test('B-5: a first file stamps links_since today, and a later v2 write carries it forward', () => {
    const first = build({ today: minus(3) });
    expect(first._meta.links_since).toBe(minus(3));
    const later = build({ previous: first, today: T });
    expect(later._meta.links_since).toBe(minus(3));
  });

  test('THE UPGRADE: a v1 file becomes v2 on the next write, writes once, and changes no evidence', () => {
    // The shape main holds when this build deploys: conversation/v1, no links,
    // no links_since. The first v2 write must (a) happen even if nothing else
    // moved, so the file stops announcing the old schema, (b) stamp
    // links_since today, and (c) carry every v1 entry exactly as it was —
    // the upgrade has no links to add to evidence it did not observe.
    const v1 = {
      _meta: {
        schema: 'conversation/v1',
        fetched_at: `${T}T10:00:00.000Z`,
        window_days: OUTLET_WINDOW_DAYS,
        source_status: { press: { status: 'ok' } },
      },
      slugs: {
        'hr-1-119': {
          outlets7d: [
            { domain: 'foxnews.com', lean: 'right', firstSeen: minus(1), lastSeen: T },
            { domain: 'npr.org', lean: 'center', firstSeen: T, lastSeen: T },
          ],
          unratedOutlets7d: [{ domain: 'rollcall.com', firstSeen: T, lastSeen: T }],
          mostViewed: null,
        },
      },
    };
    const up = build({ previous: v1, sourceStatus: v1._meta.source_status });
    expect(up._meta.schema).toBe(CONVERSATION_SCHEMA);
    expect(up._meta.links_since).toBe(T);
    expect(up.slugs).toEqual(v1.slugs);
    expect(shouldWrite({ previous: v1, next: up })).toBe(true);
    // ...and the upgraded file passes the gate, though its v1-era entries
    // (seen ON links_since, not after it) carry no link.
    expect(verifyConversation({ data: up, fileBytes: 1000, now: NOW, bias: BIAS }).failures).toEqual([]);
    // One hour later, nothing new observed: no second write.
    const hourLater = build({ previous: up, sourceStatus: v1._meta.source_status, now: NOW + 3_600_000 });
    expect(shouldWrite({ previous: up, next: hourLater })).toBe(false);
  });

  test('every schema this build writes is one it can read, and v1 stays readable', () => {
    expect(CONVERSATION_READABLE_SCHEMAS).toContain(CONVERSATION_SCHEMA);
    // v2 only ADDED fields. Dropping v1 from the list is what a non-additive
    // bump must do, in the same change.
    expect(CONVERSATION_READABLE_SCHEMAS).toContain('conversation/v1');
  });

  test('the real most-viewed feed folds straight in, ranks and all', () => {
    const parsed = extractMostViewedRanked(MOST_VIEWED);
    const doc = build({ mostViewed: parsed });
    expect(doc.slugs['hr-6509-119'].mostViewed).toEqual({ weeksOnList: 1, lastRank: 1, lastSeen: T, lastWeek: '2026-08-09' });
    expect(doc.slugs['hr-6500-119'].mostViewed.lastRank).toBe(8);
    // ...and none of them renders on that alone (critic B-2)
    expect(conversationPool(doc, { today: T })).toEqual([]);
  });

  test('a slug with nothing left inside any window is dropped entirely', () => {
    const previous = {
      slugs: {
        'hr-9-119': { outlets7d: [outlet('npr.org', 'center', minus(30))], unratedOutlets7d: [], mostViewed: { weeksOnList: 1, lastRank: 1, lastSeen: minus(30), lastWeek: minus(30) } },
      },
    };
    expect(build({ previous }).slugs['hr-9-119']).toBeUndefined();
  });

  test('the document it produces passes its own gate', () => {
    const doc = build({
      outlets: new Map([['hr-1-119', ['foxnews.com', 'npr.org', 'rollcall.com', 'unknown']]]),
      mostViewed: extractMostViewedRanked(MOST_VIEWED),
    });
    expect(verifyConversation({ data: doc, fileBytes: 1000, now: NOW, bias: BIAS }).failures).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 5 · The re-decode predicate — ENTERING C1, and only C1
 * ------------------------------------------------------------------ */
test.describe('enteredCorroborated', () => {
  const c1 = { outlets7d: [outlet('foxnews.com', 'right'), outlet('npr.org', 'center')] };
  const c0 = { outlets7d: [outlet('foxnews.com', 'right')] };

  test('a bill that just reached two rated outlets enters', () => {
    expect(
      enteredCorroborated({ previous: { slugs: { 'hr-1-119': c0 } }, next: { slugs: { 'hr-1-119': c1 } }, today: T })
    ).toEqual(['hr-1-119']);
  });

  test('a bill that has BEEN corroborated does not re-enter every hour', () => {
    expect(
      enteredCorroborated({ previous: { slugs: { 'hr-1-119': c1 } }, next: { slugs: { 'hr-1-119': c1 } }, today: T })
    ).toEqual([]);
  });

  test('the first run treats existing corroboration as an entry', () => {
    expect(enteredCorroborated({ previous: null, next: { slugs: { 'hr-1-119': c1 } }, today: T })).toEqual(['hr-1-119']);
  });

  test('C2 never enters — most-viewed alone may not spend a cent (critic B-2)', () => {
    const next = {
      slugs: {
        'hr-2-119': { outlets7d: [], mostViewed: { weeksOnList: 6, lastRank: 1, lastSeen: T, lastWeek: T } },
        'hr-3-119': { outlets7d: [outlet('cnbc.com', 'center')], mostViewed: { weeksOnList: 1, lastRank: 2, lastSeen: T, lastWeek: T } },
      },
    };
    expect(enteredCorroborated({ previous: null, next, today: T })).toEqual([]);
  });

  test('a single rated outlet never enters (critic B-1)', () => {
    expect(enteredCorroborated({ previous: null, next: { slugs: { 'hr-1-119': c0 } }, today: T })).toEqual([]);
  });

  test('a bill that falls back out of C1 stops being queued', () => {
    const faded = { outlets7d: [outlet('foxnews.com', 'right', minus(OUTLET_WINDOW_DAYS + 1)), outlet('npr.org', 'center', minus(9))] };
    expect(enteredCorroborated({ previous: null, next: { slugs: { 'hr-1-119': faded } }, today: T })).toEqual([]);
  });

  // The whole point of the queue, composed with the verdict half it hands off
  // to (scripts/floor-signals-parse.mjs's redecodeVerdict, shared unchanged
  // with the docket ladder's own T0/T1 re-decode path).
  test('hr-6500: entering C1 with the wrong vehicle under the decode queues a re-decode', () => {
    const entered = enteredCorroborated({
      previous: { slugs: { 'hr-6500-119': c0 } },
      next: { slugs: { 'hr-6500-119': c1 } },
      today: T,
    });
    expect(entered).toEqual(['hr-6500-119']);
    expect(
      redecodeVerdict({
        decodedAt: null, // the whole pre-2026-08-12 corpus
        lastActionDate: '2026-08-10',
        corpusTitle: 'AGOA Extension and Enhancement Act of 2026',
        fetchedTitle: 'Continuing Appropriations and Extensions Act, 2027',
      })
    ).toMatchObject({ redecode: true, reason: 'vehicle-swap' });
  });

  test('...and a fine decode on a newly-corroborated bill still spends nothing', () => {
    expect(
      redecodeVerdict({ decodedAt: null, lastActionDate: '2026-08-10', corpusTitle: 'Same Act', fetchedTitle: 'Same Act' })
    ).toMatchObject({ redecode: false, reason: 'null-decoded-at' });
  });
});

/* ------------------------------------------------------------------ *
 * 6 · The dark-lean alarm (critic B-4)
 * ------------------------------------------------------------------ */
test.describe('rollLeanHealth / darkLeans', () => {
  const basketLeans = ['left', 'center', 'right'];

  test('a lean that produced items today is live and silent', () => {
    const health = rollLeanHealth(null, { basketLeans, liveLeans: basketLeans, today: T });
    expect(health.right).toEqual({ last_live: T, first_dark: null });
    expect(darkLeans(health, { today: T })).toEqual([]);
  });

  test('a lean silent for the alarm window is named, with how long', () => {
    const health = { right: { last_live: minus(DARK_LEAN_ALARM_DAYS), first_dark: null }, left: { last_live: T, first_dark: null } };
    const rolled = rollLeanHealth(health, { basketLeans, liveLeans: ['left', 'center'], today: T });
    expect(darkLeans(rolled, { today: T })).toEqual([
      { lean: 'right', darkDays: DARK_LEAN_ALARM_DAYS, lastLive: minus(DARK_LEAN_ALARM_DAYS) },
    ]);
  });

  test('one silent hour is not an alarm', () => {
    const health = rollLeanHealth({ right: { last_live: minus(1), first_dark: null } }, { basketLeans, liveLeans: ['left'], today: T });
    expect(darkLeans(health, { today: T })).toEqual([]);
  });

  test('a lost cache starts the clock at today rather than reading as infinitely dark', () => {
    const health = rollLeanHealth(null, { basketLeans, liveLeans: [], today: T });
    expect(health.right.first_dark).toBe(T);
    expect(darkLeans(health, { today: T })).toEqual([]);
  });

  test('recovery clears the alarm', () => {
    const dark = { right: { last_live: minus(20), first_dark: minus(20) } };
    const recovered = rollLeanHealth(dark, { basketLeans, liveLeans: ['right'], today: T });
    expect(darkLeans(recovered, { today: T })).toEqual([]);
  });

  test('leanStatuses is what the committed file carries, and the gate re-surfaces a dark one', () => {
    const health = { right: { last_live: minus(9), first_dark: null }, left: { last_live: T, first_dark: null } };
    const statuses = leanStatuses(health, { today: T });
    expect(statuses.right).toEqual({ status: 'dark', last_live: minus(9), dark_days: 9 });
    expect(statuses.left.status).toBe('ok');
    const doc = build({ sourceStatus: { leans: statuses } });
    const { warnings } = verifyConversation({ data: doc, fileBytes: 100, now: NOW, bias: BIAS });
    expect(warnings.join(' ')).toContain('right-rated half of the press basket');
  });

  test('an unrated lean label can never enter the health record', () => {
    const health = rollLeanHealth(null, { basketLeans: ['right', 'unrated', ''], liveLeans: ['right'], today: T });
    expect(Object.keys(health)).toEqual(['right']);
  });
});

/* ------------------------------------------------------------------ *
 * 6b · The per-feed dark alarm (2026-09-25)
 * ------------------------------------------------------------------ */
test.describe('rollFeedHealth / darkFeeds / feedStatuses', () => {
  type Feed = { name: string; url: string; domain: string | null; lean: string | null };
  const FOX: Feed = { name: 'Fox News Politics', url: 'https://fox.example/politics.xml', domain: 'foxnews.com', lean: 'right' };
  const WT: Feed = { name: 'Washington Times Politics', url: 'https://wt.example/politics/', domain: 'washingtontimes.com', lean: 'right' };
  const GN: Feed = { name: 'Google News (congress bill query)', url: 'https://news.example/rss', domain: null, lean: null };
  const live = (f: Feed, items = 20) => ({ ...f, items, error: null });
  const failed = (f: Feed, error = 'HTTP 403') => ({ ...f, items: 0, error });
  const plus = (days: number) => new Date(Date.parse(`${T}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  test('THE WASHINGTON TIMES SHAPE: a feed dead from its first run is named on day 3, while its lean never stops reading ok', () => {
    // The exact failure this alarm exists for. From 2026-08-12 the right lean
    // was Fox + Washington Times; the Times answered every runner with 403 and
    // Fox kept the lean "live", so the lean alarm could never fire.
    let feeds: Record<string, unknown> | null = null;
    let leans: Record<string, unknown> | null = null;
    const seen: { day: number; dark: string[]; darkLeans: string[] }[] = [];
    for (let day = 0; day <= 4; day++) {
      const today = plus(day);
      feeds = rollFeedHealth(feeds, { feeds: [live(FOX), failed(WT)], today });
      leans = rollLeanHealth(leans, { basketLeans: ['right'], liveLeans: ['right'], today });
      seen.push({
        day,
        dark: darkFeeds(feeds, { today }).map((d) => d.name),
        darkLeans: darkLeans(leans, { today }).map((d) => d.lean),
      });
    }
    expect(seen.map((s) => s.dark)).toEqual([[], [], [], [WT.name], [WT.name]]);
    expect(seen.every((s) => s.darkLeans.length === 0)).toBe(true);
    const [alarm] = darkFeeds(feeds, { today: plus(3) });
    expect(alarm).toMatchObject({ name: WT.name, domain: 'washingtontimes.com', lean: 'right', darkDays: 3, lastLive: null, lastError: 'HTTP 403' });
    expect(FEED_DARK_ALARM_DAYS).toBe(3);
  });

  test('a 200 with zero parseable items is dark exactly like a non-200', () => {
    const health = rollFeedHealth(null, { feeds: [{ ...WT, items: 0, error: null }], today: T });
    expect(health[WT.name]).toMatchObject({ last_live: null, first_dark: T, last_error: '0 items' });
  });

  test('a feed live yesterday and silent for three days is named, with the day it was last live', () => {
    const health = { [FOX.name]: { url: FOX.url, domain: FOX.domain, lean: 'right', last_live: minus(3), first_dark: minus(2), last_error: 'HTTP 500' } };
    const rolled = rollFeedHealth(health, { feeds: [failed(FOX, 'HTTP 500')], today: T });
    expect(darkFeeds(rolled, { today: T })).toEqual([
      { name: FOX.name, domain: 'foxnews.com', lean: 'right', darkDays: 3, lastLive: minus(3), since: minus(3), lastError: 'HTTP 500' },
    ]);
  });

  test('one failed run on a day the feed already delivered is not dark at all', () => {
    const morning = rollFeedHealth(null, { feeds: [live(FOX)], today: T });
    const afternoon = rollFeedHealth(morning, { feeds: [failed(FOX, 'The operation was aborted due to timeout')], today: T });
    expect(feedStatuses(afternoon, { today: T })[FOX.name]).toMatchObject({ status: 'ok', last_live: T, dark_days: 0 });
  });

  test('two dark days are counted but not alarmed', () => {
    const health = { [FOX.name]: { url: FOX.url, domain: FOX.domain, lean: 'right', last_live: minus(2), first_dark: minus(1), last_error: 'HTTP 403' } };
    const rolled = rollFeedHealth(health, { feeds: [failed(FOX)], today: T });
    expect(darkFeeds(rolled, { today: T })).toEqual([]);
    expect(feedStatuses(rolled, { today: T })[FOX.name]).toMatchObject({ status: 'ok', dark_days: 2 });
  });

  test('recovery clears the alarm and ends the streak', () => {
    const dark = { [WT.name]: { url: WT.url, domain: WT.domain, lean: 'right', last_live: null, first_dark: minus(40), last_error: 'HTTP 403' } };
    const recovered = rollFeedHealth(dark, { feeds: [live(WT)], today: T });
    expect(recovered[WT.name]).toMatchObject({ last_live: T, first_dark: null, last_error: null });
    expect(darkFeeds(recovered, { today: T })).toEqual([]);
  });

  test('a lost cache re-seeds a feed the COMMITTED file already calls dark — a cache eviction cannot silence the alarm', () => {
    const committed = feedStatuses(
      { [WT.name]: { url: WT.url, domain: WT.domain, lean: 'right', last_live: null, first_dark: minus(40), last_error: 'HTTP 403' } },
      { today: minus(1) }
    );
    expect(committed[WT.name].status).toBe('dark');
    const rolled = rollFeedHealth(null, { feeds: [failed(WT)], today: T, committed });
    expect(darkFeeds(rolled, { today: T })).toMatchObject([{ name: WT.name, darkDays: 40, since: minus(40) }]);
  });

  test('a lost cache does NOT seed from a committed ok record, whose last_live may lag behind the truth', () => {
    // The file writes only on a status flip, so an ok record's last_live is as
    // old as the last write. Seeding from it would invent darkness.
    const committed = { [FOX.name]: { status: 'ok', url: FOX.url, last_live: minus(10), first_dark: null, dark_days: 0 } };
    const rolled = rollFeedHealth(null, { feeds: [failed(FOX)], today: T, committed });
    expect(rolled[FOX.name]).toMatchObject({ last_live: null, first_dark: T });
    expect(darkFeeds(rolled, { today: T })).toEqual([]);
  });

  test('a replacement filed under the same name (a new URL) starts over rather than inheriting the old feed’s darkness', () => {
    const old = { [WT.name]: { url: 'https://old.example/feed', domain: WT.domain, lean: 'right', last_live: null, first_dark: minus(40), last_error: 'HTTP 403' } };
    const rolled = rollFeedHealth(old, { feeds: [failed(WT, 'HTTP 404')], today: T });
    expect(rolled[WT.name]).toMatchObject({ url: WT.url, first_dark: T, last_error: 'HTTP 404' });
    expect(darkFeeds(rolled, { today: T })).toEqual([]);
  });

  test('a feed that left the basket leaves the record', () => {
    const before = rollFeedHealth(null, { feeds: [failed(WT), live(FOX)], today: minus(1) });
    const after = rollFeedHealth(before, { feeds: [live(FOX)], today: T });
    expect(Object.keys(after)).toEqual([FOX.name]);
  });

  test('the aggregator is watched too, with no lean; an unrated or unknown lean never enters the record', () => {
    const rolled = rollFeedHealth(null, { feeds: [failed(GN, 'HTTP 503'), { ...live(FOX), lean: 'unrated' }], today: T });
    expect(rolled[GN.name]).toMatchObject({ domain: null, lean: null, last_error: 'HTTP 503' });
    expect(rolled[FOX.name].lean).toBeNull();
  });

  test('feedStatuses is what the committed file carries — url kept, error text bounded', () => {
    const rolled = rollFeedHealth(null, { feeds: [failed(WT, 'x'.repeat(500)), live(FOX)], today: T });
    const statuses = feedStatuses(rolled, { today: T });
    expect(Object.keys(statuses)).toEqual([FOX.name, WT.name].sort());
    expect(statuses[FOX.name]).toEqual({
      status: 'ok', url: FOX.url, domain: 'foxnews.com', lean: 'right', last_live: T, first_dark: null, dark_days: 0, last_error: null,
    });
    expect(statuses[WT.name].last_error?.length).toBe(120);
  });

  test('committedDarkFeeds recomputes the day count from the dates, not from the stored dark_days', () => {
    const status = { feeds: { [WT.name]: { status: 'dark', domain: WT.domain, lean: 'right', last_live: null, first_dark: minus(10), dark_days: 3, last_error: 'HTTP 403' } } };
    expect(committedDarkFeeds(status, { today: T })).toEqual([
      { name: WT.name, domain: 'washingtontimes.com', lean: 'right', darkDays: 10, since: minus(10), lastError: 'HTTP 403' },
    ]);
    expect(committedDarkFeeds({ feeds: { [FOX.name]: { status: 'ok' } } }, { today: T })).toEqual([]);
    expect(committedDarkFeeds({}, { today: T })).toEqual([]);
  });

  test('a FEED going dark writes the file; one more dark day, and a one-run blip, do not', () => {
    const okStatus = feedStatuses(rollFeedHealth(null, { feeds: [live(FOX), live(WT)], today: T }), { today: T });
    const first = build({ sourceStatus: { feeds: okStatus } });
    // A blip: failed the first run of the day after being live yesterday.
    const blip = feedStatuses(
      rollFeedHealth({ [FOX.name]: { url: FOX.url, last_live: minus(1), first_dark: null } }, { feeds: [failed(FOX)], today: T }),
      { today: T }
    );
    expect(blip[FOX.name]).toMatchObject({ status: 'ok', dark_days: 1 });
    expect(shouldWrite({ previous: first, next: build({ previous: first, sourceStatus: { feeds: { ...okStatus, ...blip } } }) })).toBe(false);
    // Crossing the threshold writes: the alarm must land in the committed file.
    const darkStatus = feedStatuses(
      { [WT.name]: { url: WT.url, domain: WT.domain, lean: 'right', last_live: minus(3), first_dark: minus(2), last_error: 'HTTP 403' } },
      { today: T }
    );
    const second = build({ previous: first, sourceStatus: { feeds: { ...okStatus, ...darkStatus } } });
    expect(shouldWrite({ previous: first, next: second })).toBe(true);
    // A fourth dark day is not a commit.
    const darker = feedStatuses(
      { [WT.name]: { url: WT.url, domain: WT.domain, lean: 'right', last_live: minus(4), first_dark: minus(3), last_error: 'HTTP 403' } },
      { today: T }
    );
    expect(shouldWrite({ previous: second, next: build({ previous: second, sourceStatus: { feeds: { ...okStatus, ...darker } } }) })).toBe(false);
    // Swapping a feed out of the basket IS a change.
    const swapped = { [FOX.name]: okStatus[FOX.name], Reason: { ...okStatus[FOX.name], url: 'https://reason.example/feed/' } };
    expect(shouldWrite({ previous: first, next: build({ previous: first, sourceStatus: { feeds: swapped } }) })).toBe(true);
  });

  test('the gate re-surfaces a dark feed BY NAME, as a warning, and the per-feed block is not a schema change', () => {
    const statuses = feedStatuses(
      { [WT.name]: { url: WT.url, domain: WT.domain, lean: 'right', last_live: null, first_dark: minus(44), last_error: 'HTTP 403' } },
      { today: T }
    );
    const doc = build({ sourceStatus: { press: { status: 'ok', feeds_silent: 1, checked_at: 'x' }, feeds: statuses } });
    const { failures, warnings } = verifyConversation({ data: doc, fileBytes: 100, now: NOW, bias: BIAS });
    expect(failures).toEqual([]);
    const text = warnings.join(' ');
    expect(text).toContain('press feed "Washington Times Politics"');
    expect(text).toContain('44 days');
    expect(text).toContain('HTTP 403');
    // lib/conversation.ts's conversationPosture returns `unknown` — silently
    // flipping the homepage band to its stored-coverage fallback — the moment
    // _meta.schema is not one this build reads. The per-feed block rides
    // inside source_status precisely so it needs no schema bump OF ITS OWN:
    // the file keeps whatever schema this build writes (conversation/v2 since
    // #300's article links, which is that change's bump, not this one's), and
    // a file carrying a dark feed still reads as a live band.
    expect(doc._meta.schema).toBe(CONVERSATION_SCHEMA);
    expect(CONVERSATION_READABLE_SCHEMAS).toContain(doc._meta.schema);
    expect(conversationPostureOf(doc, NOW)).toBe('live');
    // ...and the same block on a file a previous build wrote (conversation/v1,
    // still readable) does not change that file's posture either.
    expect(conversationPostureOf({ _meta: { ...doc._meta, schema: 'conversation/v1' } }, NOW)).toBe('live');
  });
});

/* ------------------------------------------------------------------ *
 * 7 · The basket itself (critic B-4's structural half)
 * ------------------------------------------------------------------ */
test.describe('the press basket', () => {
  // Read as TEXT rather than imported: scripts/newsdesk.mjs runs its whole
  // hourly job at import time and needs two API keys to do it. The SOURCES
  // array is a flat literal, so the domains are extractable without executing
  // anything — and this pin is about the shape of the basket, not its code.
  const source = readFileSync(join(__dirname, '..', 'scripts', 'newsdesk.mjs'), 'utf8');
  const block = /const SOURCES = \[([\s\S]*?)\n\];/.exec(source)?.[1] ?? '';
  const feeds = [...block.matchAll(/domain: (?:'([^']*)'|null)/g)].map((m) => m[1] ?? null);

  test('the SOURCES literal is readable and non-trivial', () => {
    expect(feeds.length).toBeGreaterThanOrEqual(10);
  });

  test('NO rated lean depends on a single feed staying alive — the B-4 invariant', () => {
    // The basket before 2026-08-12 was 1 right + 2 left + 2 center: one 404 on
    // the single right-rated feed (the way apnews.com's died, silently) and
    // cross-spectrum corroboration would have skewed with nothing on the page
    // to say so. Every rated lean now has at least two feeds.
    const byLean: Record<string, number> = {};
    for (const domain of feeds) {
      const lean = leanOf(domain, BIAS);
      if (lean) byLean[lean] = (byLean[lean] ?? 0) + 1;
    }
    expect(Object.keys(byLean).sort()).toEqual(['center', 'left', 'right']);
    for (const [lean, count] of Object.entries(byLean)) {
      expect(count, `the ${lean} half of the basket is carried by ${count} feed(s)`).toBeGreaterThanOrEqual(2);
    }
  });

  test('right and left are carried by the same number of distinct rated OUTLETS', () => {
    const domainsFor = (want: string) =>
      new Set(feeds.filter((d) => d && leanOf(d, BIAS) === want));
    expect(domainsFor('right').size).toBe(domainsFor('left').size);
  });

  test('every rated basket domain is a bare, canonical domain data/media-bias.json keys on', () => {
    for (const domain of feeds) {
      if (!domain) continue;
      expect(normalizeDomain(domain)).toBe(domain);
    }
  });

  test('the basket carries no outlet the 2026-09-25 sweep ruled out on its own robots.txt or terms, nor the feed that refused every runner', () => {
    // scripts/newsdesk.mjs's header ("THE 2026-09-25 RIGHT-LEAN SWAP") quotes
    // each clause. The 2026-08-12 header named washingtonexaminer.com as "the
    // first alternate" without ever reading its terms, which require a signed
    // agreement for RSS use — so this list exists to make the next swap read
    // them too. Lifting an entry takes the outlet's written permission (or, for
    // washingtontimes.com, evidence that runners are no longer refused), and a
    // line in that header saying so.
    const ruledOut = [
      'washingtontimes.com', // HTTP 403 to every GitHub runner, 2026-08-12 -> 2026-09-25
      'washingtonexaminer.com', // terms: RSS use requires an agreement
      'nypost.com', // robots.txt notice: automated collection prohibited without written permission
      'breitbart.com', // terms: no bots or automated access
      'dailycaller.com', // terms: no automated means to access
      'thedispatch.com', // terms: no automated scraping or downloading
      'theblaze.com', // terms: no scraping, crawling or spidering
    ];
    for (const domain of ruledOut) expect(feeds, `${domain} is back in SOURCES`).not.toContain(domain);
  });

  test('the invariants above are about CONSTRUCTION; every feed is also watched for LIVENESS, and the verdict reaches the committed file', () => {
    // Two right-rated feeds in this literal did not mean two right-rated feeds
    // delivering: washingtontimes.com answered every runner with 403 from the
    // day it was added. Construction is pinned above; liveness can only be
    // observed at run time, so what is pinned here is that the observation is
    // wired: rolled per feed, persisted in the cache, re-seeded from the
    // committed file, and written into source_status.feeds.
    expect(source).toMatch(/cache\.feedLiveness = rollFeedHealth\(cache\.feedLiveness, \{/);
    expect(source).toMatch(/committed: previousConversation\?\._meta\?\.source_status\?\.feeds/);
    expect(source).toMatch(/feeds: feedStatuses\(cache\.feedLiveness, \{ today \}\)/);
    expect(source).toMatch(/feedLiveness: cache\.feedLiveness/);
    expect(source).toMatch(/for \(const dark of darkFeeds\(cache\.feedLiveness/);
  });

  test('B-5 wiring: the newsdesk hands the lamp each item\'s LINK, not a bare outlet', () => {
    // The failure this pins is silent and total: observeOutlets records
    // nothing for an observation without a checkable link, so a newsdesk that
    // went back to accumulating bare outlet strings would empty the band
    // within a week without a single error. Read as text for the same reason
    // as the SOURCES pin above — the script runs its whole job at import.
    const accumulator = /const addConversationOutlet = \(slug, it\) => \{([\s\S]*?)\n\};/.exec(source)?.[1] ?? '';
    expect(accumulator).toContain('normalizeArticleUrl(it.link)');
    expect(accumulator).toContain('new Map()');
    expect(accumulator).toMatch(/outlets\.set\(outlet, url\)/);
    // ...and the feed item actually carries the link that reads.
    expect(source).toMatch(/link: it\.link,/);
  });
});

/* ------------------------------------------------------------------ *
 * 8 · The gate
 * ------------------------------------------------------------------ */
test.describe('verifyConversation', () => {
  // Links have been stored for a week, so every observation fixture dated
  // after minus(7) is one B-5 REQUIRES a link on.
  const meta = {
    schema: CONVERSATION_SCHEMA,
    fetched_at: `${T}T18:00:00.000Z`,
    window_days: OUTLET_WINDOW_DAYS,
    links_since: minus(7),
    source_status: {},
  };
  const doc = (slugs: Record<string, unknown>) => ({ _meta: meta, slugs });
  const failuresOf = (data: unknown, extra: { fileBytes?: number; knownSlugs?: Set<string> } = {}) =>
    verifyConversation({ data, fileBytes: 500, now: NOW, bias: BIAS, ...extra }).failures.join(' | ');

  test('a valid document passes, and an empty one passes', () => {
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [outlet('foxnews.com', 'right'), outlet('npr.org', 'center')], unratedOutlets7d: [], mostViewed: null } }))).toBe('');
    expect(failuresOf(doc({}))).toBe('');
  });

  test('an unrated domain in the corroborating list fails the build', () => {
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [outlet('rollcall.com', 'center')] } }))).toContain('corroborate nothing');
  });

  test('a rated outlet filed as unrated fails too — the split must be honest in both directions', () => {
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [], unratedOutlets7d: [unratedEntry('npr.org')] } }))).toContain('it belongs in outlets7d');
  });

  test('a lean that disagrees with data/media-bias.json fails', () => {
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [outlet('foxnews.com', 'left')] } }))).toContain('media-bias.json says right');
  });

  test('evidence outside the window it claims fails', () => {
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [outlet('foxnews.com', 'right', minus(30))] } }))).toContain('past the 7-day window');
  });

  test('a future-dated observation fails', () => {
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [outlet('foxnews.com', 'right', '2099-01-01')] } }))).toContain('in the future');
  });

  test('first-seen after last-seen fails', () => {
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [{ ...outlet('foxnews.com', 'right'), firstSeen: T, lastSeen: minus(2) }] } }))).toContain('after it was last seen');
  });

  test('an unknown schema, a foreign window and a blown size ceiling all fail', () => {
    expect(failuresOf({ ...doc({}), _meta: { ...meta, schema: 'conversation/v99' } })).toContain('unknown _meta.schema');
    expect(failuresOf({ ...doc({}), _meta: { ...meta, window_days: 30 } })).toContain('evidence window is 7 days');
    expect(failuresOf(doc({}), { fileBytes: 5_000_000 })).toContain('byte ceiling');
  });

  test('the size ceiling leaves room for a busy week of links, and still trips on a writer that stopped pruning', () => {
    // Largest v1 file in the history: 64 KB (84 rated + 270 unrated entries).
    // With a link on every entry that week is ~170 KB — under the ceiling.
    expect(failuresOf(doc({}), { fileBytes: 170 * 1024 })).toBe('');
    expect(CONVERSATION_MAX_BYTES).toBe(512 * 1024);
    expect(failuresOf(doc({}), { fileBytes: CONVERSATION_MAX_BYTES + 1 })).toContain('byte ceiling');
  });

  /* ---- B-5 at the gate ------------------------------------------------ */
  test('B-5: a rated outlet seen after links_since with no link fails the build', () => {
    const { url: _drop, ...noLink } = outlet('foxnews.com', 'right');
    void _drop;
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [noLink, outlet('npr.org', 'center')] } }))).toContain('not evidence a reader can check');
  });

  test('B-5: so does an UNRATED one — a later rating must be able to move it across with its link', () => {
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [], unratedOutlets7d: [{ domain: 'rollcall.com', firstSeen: T, lastSeen: T }] } }))).toContain('carries none');
  });

  test('B-5: an entry last seen ON or BEFORE links_since may lack a link — v1-era evidence the window retires', () => {
    const legacy = (lastSeen: string) => ({ domain: 'foxnews.com', lean: 'right', firstSeen: lastSeen, lastSeen });
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [legacy(minus(7))] } }))).toBe('');
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [legacy(minus(6))] } }))).toContain('carries none');
  });

  test('B-5: a stored link must be a canonical http(s) URL — never a javascript: value', () => {
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [{ ...outlet('foxnews.com', 'right'), url: 'javascript:alert(1)' }] } }))).toContain('not a canonical http(s) URL');
    // Canonical means byte-identical to what the writer would have stored.
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [{ ...outlet('foxnews.com', 'right'), url: 'https://WWW.FOXNEWS.com/x' }] } }))).toContain('not a canonical http(s) URL');
  });

  test('B-5: a current-schema file with no links_since fails; a v1 file passes with a note', () => {
    expect(failuresOf({ _meta: { ...meta, links_since: undefined }, slugs: {} })).toContain('links_since');
    expect(failuresOf({ _meta: { ...meta, links_since: '2099-01-01' }, slugs: {} })).toContain('in the future');
    const v1 = {
      _meta: { schema: 'conversation/v1', fetched_at: meta.fetched_at, window_days: OUTLET_WINDOW_DAYS, source_status: {} },
      slugs: {
        'hr-1-119': { outlets7d: [{ domain: 'foxnews.com', lean: 'right', firstSeen: T, lastSeen: T }], unratedOutlets7d: [], mostViewed: null },
      },
    };
    const res = verifyConversation({ data: v1, fileBytes: 500, now: NOW, bias: BIAS });
    expect(res.failures).toEqual([]);
    expect(res.notes.join(' ')).toContain('conversation/v1');
  });

  test('a broken most-viewed block fails', () => {
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [], mostViewed: { weeksOnList: 0, lastRank: 1, lastSeen: T } } }))).toContain('weeksOnList');
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [], mostViewed: { weeksOnList: 1, lastRank: 0, lastSeen: T } } }))).toContain('lastRank');
  });

  test('a slug the corpus does not hold is a warning, never a failure', () => {
    const { failures, warnings } = verifyConversation({
      data: doc({ 'hr-99999-119': { outlets7d: [outlet('foxnews.com', 'right'), outlet('npr.org', 'center')] } }),
      fileBytes: 500,
      now: NOW,
      bias: BIAS,
      knownSlugs: new Set(['hr-1-119']),
    });
    expect(failures).toEqual([]);
    expect(warnings.join(' ')).toContain('hr-99999-119');
  });

  test('a non-object, and a .slugs that is not a map, fail loudly rather than throw', () => {
    expect(failuresOf([])).toContain('not a JSON object');
    expect(failuresOf({ _meta: meta, slugs: [] })).toContain('not an object keyed by bill slug');
  });

  test('the notes line counts the tiers and says the unrated ones count for nothing', () => {
    const { notes } = verifyConversation({
      data: doc({ 'hr-1-119': { outlets7d: [outlet('foxnews.com', 'right'), outlet('npr.org', 'center')], unratedOutlets7d: [unratedEntry('rollcall.com')] } }),
      fileBytes: 500,
      now: NOW,
      bias: BIAS,
    });
    expect(notes.join(' ')).toContain('1 corroborated');
    expect(notes.join(' ')).toContain('counted by nothing');
    expect(notes.join(' ')).toContain('2 of 2 rated observation(s) carry an article link');
  });
});
