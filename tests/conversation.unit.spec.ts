import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Pure, I/O-free module (no keys, no network, no fs) — see lib/conversation.mjs's
// header for the whole design these pin, and which critic patch each rule is.
import {
  buildConversation,
  CONVERSATION_SCHEMA,
  conversationEvidence,
  conversationPool,
  conversationTier,
  CORROBORATION_MIN_RATED_OUTLETS,
  DARK_LEAN_ALARM_DAYS,
  darkLeans,
  daysBetween,
  enteredCorroborated,
  isConsecutiveWeek,
  leanOf,
  leanStatuses,
  materialFingerprint,
  MOST_VIEWED_MIN_WEEKS,
  MOST_VIEWED_CARD_CAP,
  normalizeDomain,
  observeMostViewed,
  observeOutlets,
  OUTLET_WINDOW_DAYS,
  rollLeanHealth,
  shouldWrite,
  verifyConversation,
} from '../lib/conversation.mjs';
// The verdict half of the re-decode trigger. Owned by the docket ladder's
// module and shared UNCHANGED with the conversation lamp's queue — "is this
// decode still about this bill" must mean one thing on both paths.
import { redecodeVerdict } from '../scripts/floor-signals-parse.mjs';
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

const outlet = (domain: string, lean: string, lastSeen = T, firstSeen = lastSeen) => ({ domain, lean, firstSeen, lastSeen });

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
      observed: ['foxnews.com', 'rollcall.com', 'unknown'],
      bias: BIAS,
      today: T,
    });
    expect(folded.outlets7d).toEqual([outlet('foxnews.com', 'right')]);
    expect(folded.unratedOutlets7d).toEqual([{ domain: 'rollcall.com', firstSeen: T, lastSeen: T }]);
    // the sentinel never becomes an outlet on either side
    expect(JSON.stringify(folded)).not.toContain('unknown');
  });

  test('re-seeing an outlet moves lastSeen and keeps firstSeen', () => {
    const prev = { outlets7d: [outlet('npr.org', 'center', minus(2))], unratedOutlets7d: [] };
    const folded = observeOutlets(prev, { observed: ['npr.org'], bias: BIAS, today: T });
    expect(folded.outlets7d).toEqual([outlet('npr.org', 'center', T, minus(2))]);
  });

  test('an observation that falls out of the 7-day window is dropped, not carried', () => {
    const prev = {
      outlets7d: [outlet('npr.org', 'center', minus(OUTLET_WINDOW_DAYS + 1)), outlet('cbsnews.com', 'left', minus(OUTLET_WINDOW_DAYS))],
      unratedOutlets7d: [{ domain: 'rollcall.com', firstSeen: minus(20), lastSeen: minus(20) }],
    };
    const folded = observeOutlets(prev, { observed: [], bias: BIAS, today: T });
    expect(folded.outlets7d.map((o) => o.domain)).toEqual(['cbsnews.com']);
    expect(folded.unratedOutlets7d).toEqual([]);
  });

  test('a domain that gains a rating stops being an unrated observation', () => {
    const prev = { outlets7d: [], unratedOutlets7d: [{ domain: 'foxnews.com', firstSeen: minus(1), lastSeen: minus(1) }] };
    const folded = observeOutlets(prev, { observed: ['foxnews.com'], bias: BIAS, today: T });
    expect(folded.outlets7d).toEqual([outlet('foxnews.com', 'right', T, minus(1))]);
    expect(folded.unratedOutlets7d).toEqual([]);
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
  outlets?: Map<string, string[]>;
  mostViewed?: { week?: string | null; weekLabel?: string | null; entries: { slug: string; rank: number }[] } | null;
  sourceStatus?: Record<string, unknown>;
  now?: number;
  today?: string;
};

const build = (opts: BuildOpts) =>
  buildConversation({
    previous: opts.previous ?? null,
    outletsBySlug: opts.outlets ?? new Map(),
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
});

/* ------------------------------------------------------------------ *
 * 8 · The gate
 * ------------------------------------------------------------------ */
test.describe('verifyConversation', () => {
  const meta = { schema: CONVERSATION_SCHEMA, fetched_at: `${T}T18:00:00.000Z`, window_days: OUTLET_WINDOW_DAYS, source_status: {} };
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
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [], unratedOutlets7d: [{ domain: 'npr.org', firstSeen: T, lastSeen: T }] } }))).toContain('it belongs in outlets7d');
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
    expect(failuresOf(doc({ 'hr-1-119': { outlets7d: [{ domain: 'foxnews.com', lean: 'right', firstSeen: T, lastSeen: minus(2) }] } }))).toContain('after it was last seen');
  });

  test('an unknown schema, a foreign window and a blown size ceiling all fail', () => {
    expect(failuresOf({ ...doc({}), _meta: { ...meta, schema: 'conversation/v99' } })).toContain('unknown _meta.schema');
    expect(failuresOf({ ...doc({}), _meta: { ...meta, window_days: 30 } })).toContain('evidence window is 7 days');
    expect(failuresOf(doc({}), { fileBytes: 5_000_000 })).toContain('byte ceiling');
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
      data: doc({ 'hr-1-119': { outlets7d: [outlet('foxnews.com', 'right'), outlet('npr.org', 'center')], unratedOutlets7d: [{ domain: 'rollcall.com', firstSeen: T, lastSeen: T }] } }),
      fileBytes: 500,
      now: NOW,
      bias: BIAS,
    });
    expect(notes.join(' ')).toContain('1 corroborated');
    expect(notes.join(' ')).toContain('counted by nothing');
  });
});
