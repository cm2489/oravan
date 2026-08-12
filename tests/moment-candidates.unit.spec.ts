import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The real modules...
import { coverageTier as libCoverageTier, leanFor as libLeanFor, normalizeSource as libNormalizeSource } from '../lib/coverage';
import type { CoverageArticle, CoverageArticleRaw } from '../lib/types';
// ...and the import-free copies the .mjs report carries, because lib/coverage.ts
// is TypeScript and a plain node script cannot import it (the same split
// scripts/check-moments.mjs lives with). This suite is the pin: the copies are
// only trustworthy while they answer identically on the whole real corpus.
import {
  buildReport,
  coverageTier,
  floorCalendarChamber,
  leanFor,
  lintRejections,
  normalizeSource,
  rankCandidates,
} from '../scripts/moment-candidates.mjs';

const readText = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const read = (p: string) => JSON.parse(readText(p));

/* ------------------------------------------------------------------ *
 * 1 · Drift pin — the copied coverage logic vs. lib/coverage.ts, over
 *     every entry in data/coverage.json. A change to the tier rule that
 *     lands in one file and not the other fails here.
 * ------------------------------------------------------------------ */
test.describe('coverage tier copy is pinned to lib/coverage.ts', () => {
  const coverage: Record<string, CoverageArticleRaw[]> = read('data/coverage.json');
  const slugs = Object.keys(coverage).filter((k) => !k.startsWith('_') && Array.isArray(coverage[k]));

  test('the corpus is non-trivial (the pin below would otherwise prove nothing)', () => {
    expect(slugs.length).toBeGreaterThan(100);
  });

  test('normalizeSource and leanFor agree on every stored source', () => {
    const sources = new Set<string>();
    for (const slug of slugs) for (const a of coverage[slug]) sources.add(a.source);
    expect(sources.size).toBeGreaterThan(50);
    for (const source of sources) {
      expect(normalizeSource(source), source).toBe(libNormalizeSource(source));
      expect(leanFor(source), source).toBe(libLeanFor(source));
    }
  });

  test('coverageTier agrees on every bill in data/coverage.json', () => {
    const seen = new Set<string>();
    for (const slug of slugs) {
      const articles: CoverageArticle[] = coverage[slug].map((a) => ({ ...a, lean: libLeanFor(a.source) }));
      const mine = coverageTier(articles);
      expect(mine, slug).toBe(libCoverageTier(articles));
      seen.add(mine);
    }
    // The corpus must actually exercise more than one branch of the rule.
    expect(seen.size).toBeGreaterThan(1);
  });

  test('coverageTier agrees on the synthetic edges the corpus may not contain', () => {
    const a = (source: string, lean: CoverageArticle['lean']): CoverageArticle => ({
      title: 't',
      url: `https://${source}/x`,
      source,
      snippet: 's',
      publishedAt: null,
      lean,
    });
    const cases: CoverageArticle[][] = [
      [],
      [a('cnn.com', 'left')],
      [a('cnn.com', 'left'), a('cnn.com', 'left')],
      [a('cnn.com', 'left'), a('foxnews.com', 'right')],
      [a('breitbart.com', 'right'), a('dailycaller.com', 'right')],
      [a('breitbart.com', 'right'), a('reuters.com', 'center')],
      [a('reuters.com', 'center'), a('apnews.com', 'center')],
      [a('nextgov.com', null), a('cyberscoop.com', null)],
    ];
    for (const articles of cases) {
      expect(coverageTier(articles), JSON.stringify(articles.map((x) => [x.source, x.lean]))).toBe(
        libCoverageTier(articles)
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2 · Drift pin — the placed-on-calendar regex vs. the amber gate's
 *     source of truth, lib/journey.ts `floorCalendarChamber` (moved
 *     there from the bill page, which now imports it). The pin compares
 *     the regex literal in both sources: the report ranks on the same
 *     evidence the page is willing to print in amber, or the ranking is
 *     claiming something the site itself refuses to claim. The corpus-
 *     wide behavioral pin lives in tests/journey.unit.spec.ts.
 * ------------------------------------------------------------------ */
test.describe('floor-calendar regex copy is pinned to lib/journey.ts', () => {
  const extract = (src: string) => /(\/placed on .*?\/i)\.exec/.exec(src)?.[1];

  test('the report and the shared vocabulary carry the identical regex literal', () => {
    // SOURCE MOVED 2026-08-12, contents unchanged: the four chamber readers and
    // FLOOR_SETTLED live in lib/floor-text.mjs so lib/docket.mjs's ladder can
    // read them under plain node; lib/journey.ts re-exports all of them and
    // every caller is unchanged. This parity pin follows the definition.
    const libPattern = extract(readText('lib/floor-text.mjs'));
    const scriptPattern = extract(readText('scripts/moment-candidates.mjs'));
    expect(libPattern, 'no placed-on-calendar regex found in lib/floor-text.mjs').toBeTruthy();
    expect(scriptPattern).toBe(libPattern);
  });

  test('lib/journey.ts still hands every caller the same functions', () => {
    // The re-export is the compatibility promise: nothing that imported these
    // from lib/journey.ts had to change, and a future refactor that quietly
    // drops one of them fails here rather than in a page.
    const journey = readText('lib/journey.ts');
    for (const name of [
      'FLOOR_SETTLED',
      'floorActionChamber',
      'floorCalendarChamber',
      'floorPendingChamber',
      'floorSettledChamber',
    ]) {
      expect(journey, `lib/journey.ts must still export ${name}`).toContain(name);
    }
    expect(journey).toContain("from './floor-text.mjs'");
  });

  test('it reads the chamber out of the action text, and refuses everything else', () => {
    expect(floorCalendarChamber('Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.')).toBe('senate');
    expect(floorCalendarChamber('Placed on the Union Calendar, Calendar No. 219.')).toBe('house');
    expect(floorCalendarChamber('Placed on the House Calendar, Calendar No. 8.')).toBe('house');
    // The bills the status field calls floor_vote without a calendar placement.
    expect(floorCalendarChamber('Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 51.')).toBeNull();
    expect(floorCalendarChamber(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 3 · Ranking — proximity first, volume strictly last (spec §9
 *     decision 3, decided 2026-07-31).
 * ------------------------------------------------------------------ */
type Fixture = Parameters<typeof rankCandidates>[0][number];

/*
 * THE FIRST TWO KEYS CHANGED ON 2026-08-12: `floorCalendar` (a boolean) and
 * `urgency` (a scalar) became the docket rung and the last-action date, read
 * from lib/docket.mjs rather than re-derived here. The boolean could not see a
 * chamber's own floor announcement or a ripening cloture motion at all. The
 * three keys below it — coverage tier, cross-spectrum breadth, outlet count,
 * with article volume strictly last — are untouched, and the tests for them
 * below are unchanged.
 *
 * THE THIRD KEY ARRIVED THE SAME DAY (the conversation lamp): `conversationRank`
 * — c1 (two or more rated outlets published in the last 7 days) before c2
 * (congress.gov's own most-viewed list, with a second fact beside it) before c0
 * — sits directly under the docket keys and above the three stored-coverage
 * ones. The default below is c0 (rank 2), so every pre-existing test in this
 * file exercises the identical comparison it always did.
 */
const candidate = (over: Partial<Fixture> & { slug: string }): Fixture => ({
  docketRank: 4, // t4, the residual rung
  lastActionDate: '2026-07-20',
  conversationRank: 2, // c0 — no conversation evidence, the default state
  tier: 'neutral',
  partisanLeans: 0,
  outlets: 2,
  articles: 1,
  ...over,
});

test.describe('candidate ranking', () => {
  test('a bill on a louder rung outranks a more recent bill on a quieter one', () => {
    const ranked = rankCandidates([
      candidate({ slug: 'recent-but-quiet', lastActionDate: '2026-08-11' }),
      candidate({ slug: 'announced', docketRank: 0, lastActionDate: '2026-06-01' }),
      candidate({ slug: 'calendared', docketRank: 2, lastActionDate: '2026-07-01' }),
    ]);
    expect(ranked.map((c) => c.slug)).toEqual(['announced', 'calendared', 'recent-but-quiet']);
  });

  test('within the same rung, the most recent action decides', () => {
    const ranked = rankCandidates([
      candidate({ slug: 'stale', docketRank: 2, lastActionDate: '2026-07-01' }),
      candidate({ slug: 'fresh', docketRank: 2, lastActionDate: '2026-08-10' }),
      candidate({ slug: 'mid', docketRank: 2, lastActionDate: '2026-08-01' }),
    ]);
    expect(ranked.map((c) => c.slug)).toEqual(['fresh', 'mid', 'stale']);
  });

  test('article volume never outranks cross-spectrum breadth', () => {
    const ranked = rankCandidates([
      candidate({ slug: 'loud-neutral', tier: 'neutral', outlets: 5, articles: 5 }),
      candidate({ slug: 'quiet-cross', tier: 'cross', partisanLeans: 2, outlets: 2, articles: 1 }),
    ]);
    expect(ranked.map((c) => c.slug)).toEqual(['quiet-cross', 'loud-neutral']);
  });

  test('article count breaks a tie only when everything above it is equal', () => {
    const ranked = rankCandidates([
      candidate({ slug: 'b', articles: 1 }),
      candidate({ slug: 'a', articles: 4 }),
    ]);
    expect(ranked.map((c) => c.slug)).toEqual(['a', 'b']);
  });

  /* ---- the conversation tier (2026-08-12, design B's comparator) ---- */

  test('corroborated conversation outranks stored-coverage breadth on the same rung and date', () => {
    // The C-tier is measured, dated, seven-day evidence; the coverage tier is a
    // read on an article list the nightly sweep refreshes ~600 bills at a time.
    // When the docket cannot separate two candidates, the fresher evidence does.
    const ranked = rankCandidates([
      candidate({ slug: 'wide-but-old', tier: 'cross', partisanLeans: 2, outlets: 6, articles: 5 }),
      candidate({ slug: 'corroborated-this-week', conversationRank: 0, tier: 'neutral', outlets: 2, articles: 1 }),
    ]);
    expect(ranked.map((c) => c.slug)).toEqual(['corroborated-this-week', 'wide-but-old']);
  });

  test('c1 outranks c2, and c2 outranks no evidence at all', () => {
    const ranked = rankCandidates([
      candidate({ slug: 'none', conversationRank: 2 }),
      candidate({ slug: 'most-viewed', conversationRank: 1 }),
      candidate({ slug: 'corroborated', conversationRank: 0 }),
    ]);
    expect(ranked.map((c) => c.slug)).toEqual(['corroborated', 'most-viewed', 'none']);
  });

  test('conversation NEVER outranks the docket — proximity is still first', () => {
    // The whole boundary of design B in one assertion: press evidence orders
    // what the record cannot separate, and never the other way round.
    const ranked = rankCandidates([
      candidate({ slug: 'corroborated-but-quiet-docket', docketRank: 4, conversationRank: 0 }),
      candidate({ slug: 'announced-no-press', docketRank: 0, conversationRank: 2 }),
    ]);
    expect(ranked.map((c) => c.slug)).toEqual(['announced-no-press', 'corroborated-but-quiet-docket']);
  });

  test('a more recent action still outranks conversation evidence on the same rung', () => {
    const ranked = rankCandidates([
      candidate({ slug: 'older-but-corroborated', docketRank: 2, lastActionDate: '2026-07-01', conversationRank: 0 }),
      candidate({ slug: 'newer-no-press', docketRank: 2, lastActionDate: '2026-08-10', conversationRank: 2 }),
    ]);
    expect(ranked.map((c) => c.slug)).toEqual(['newer-no-press', 'older-but-corroborated']);
  });
});

/* ------------------------------------------------------------------ *
 * 4 · The press bar itself.
 * ------------------------------------------------------------------ */
test.describe('the press bar', () => {
  const bill = (over: Record<string, unknown>) => ({
    full_identifier: 'x',
    bill_type: 's',
    bill_number: 1,
    title: 'T',
    ai_headline: 'H',
    status: 'committee',
    last_action_date: '2026-07-20',
    last_action_text: 'Read twice and referred to the Committee on Finance.',
    congress_gov_url: null,
    ...over,
  });

  test('keeps cross/neutral, drops one-sided, vehicles (any Moment status), and terminal bills', () => {
    const bills = [
      bill({ full_identifier: 'cross-1' }),
      bill({ full_identifier: 'neutral-1' }),
      bill({ full_identifier: 'one-sided-1' }),
      bill({ full_identifier: 'live-vehicle' }),
      bill({ full_identifier: 'retired-vehicle' }),
      bill({ full_identifier: 'signed-1', status: 'signed' }),
      bill({ full_identifier: 'uncovered' }),
    ];
    const crossArticles = [
      { title: 't', url: 'u', source: 'cnn.com', snippet: 's', publishedAt: null },
      { title: 't', url: 'u', source: 'foxnews.com', snippet: 's', publishedAt: null },
    ];
    const neutralArticles = [
      { title: 't', url: 'u', source: 'reuters.com', snippet: 's', publishedAt: null },
      { title: 't', url: 'u', source: 'apnews.com', snippet: 's', publishedAt: null },
    ];
    const oneSidedArticles = [
      { title: 't', url: 'u', source: 'breitbart.com', snippet: 's', publishedAt: null },
      { title: 't', url: 'u', source: 'dailycaller.com', snippet: 's', publishedAt: null },
    ];
    const coverage = {
      _note: 'metadata keys are never slugs',
      'cross-1': crossArticles,
      'neutral-1': neutralArticles,
      'one-sided-1': oneSidedArticles,
      'live-vehicle': crossArticles,
      'retired-vehicle': crossArticles,
      'signed-1': crossArticles,
    };
    const moments = {
      open: { status: 'live', vehicles: [{ slug: 'live-vehicle' }] },
      closed: { status: 'retired', vehicles: [{ slug: 'retired-vehicle' }] },
    };

    const report = buildReport({
      bills,
      coverage,
      moments,
      rejections: { entries: [], warnings: [] },
      now: Date.parse('2026-07-31T00:00:00Z'),
    });

    expect(report.candidates.map((c: { slug: string }) => c.slug)).toEqual(['cross-1', 'neutral-1']);
    expect(report.funnel).toEqual({ covered: 6, tierQualified: 5, alreadyVehicle: 2, terminal: 1 });
    expect(report.histogram).toEqual({ cross: 4, neutral: 1, one_sided: 1, none: 0 });
    expect(report.moments).toEqual({ live: 1, cap: 6, openSlots: 5 });
    expect(report.standing_line).toContain('never creates, proposes, or drafts a Moment');
    // No conversation file passed: every candidate reads c0, which changes no
    // order. An absent evidence file is the normal state of a fresh clone.
    expect(report.candidates.map((c: { conversationTier: string }) => c.conversationTier)).toEqual(['c0', 'c0']);
  });

  test('the conversation tier is read from the committed evidence, and reorders a docket tie', () => {
    const bills = [bill({ full_identifier: 'cross-1' }), bill({ full_identifier: 'neutral-1' })];
    const articles = (a: string, b: string) => [
      { title: 't', url: 'u', source: a, snippet: 's', publishedAt: null },
      { title: 't', url: 'u', source: b, snippet: 's', publishedAt: null },
    ];
    const coverage = {
      // cross-1 has the WIDER stored coverage (cross-spectrum, 2 outlets)...
      'cross-1': articles('cnn.com', 'foxnews.com'),
      'neutral-1': articles('reuters.com', 'apnews.com'),
    };
    const now = Date.parse('2026-07-31T00:00:00Z');
    const day = '2026-07-31';
    // ...and neutral-1 is the one two rated outlets published about THIS WEEK.
    const conversation = {
      slugs: {
        'neutral-1': {
          outlets7d: [
            { domain: 'foxnews.com', lean: 'right', firstSeen: day, lastSeen: day },
            { domain: 'cnn.com', lean: 'left', firstSeen: day, lastSeen: day },
          ],
          unratedOutlets7d: [],
          mostViewed: null,
        },
      },
    };

    const ranked = buildReport({
      bills,
      coverage,
      moments: {},
      rejections: { entries: [], warnings: [] },
      conversation,
      now,
    }).candidates as { slug: string; conversationTier: string; conversationOutlets: number }[];

    expect(ranked.map((c) => c.slug)).toEqual(['neutral-1', 'cross-1']);
    expect(ranked[0].conversationTier).toBe('c1');
    expect(ranked[0].conversationOutlets).toBe(2);
    expect(ranked[1].conversationTier).toBe('c0');
  });
});

/* ------------------------------------------------------------------ *
 * 5 · The rejection log warn-lint — warnings only, never a failure.
 * ------------------------------------------------------------------ */
test.describe('rejection-log lint', () => {
  const valid = {
    date: '2026-08-04',
    topic: 'A question with no bill',
    why_no_vehicle: 'Nothing has been introduced in either chamber.',
    evidence: ['https://www.congress.gov/search?q=x (0 results)'],
    revisit_when: 'A bill is introduced.',
  };

  test('the repo\'s own docs/moment-rejections.json lints clean', () => {
    expect(lintRejections(read('docs/moment-rejections.json'))).toEqual([]);
  });

  test('an absent file and a well-formed entry produce no warnings', () => {
    expect(lintRejections(null)).toEqual([]);
    expect(lintRejections([valid])).toEqual([]);
    expect(lintRejections([{ _readme: 'metadata is skipped' }, valid])).toEqual([]);
  });

  test('missing fields, empty evidence, and a bad date each warn', () => {
    const warnings = lintRejections([
      { ...valid, topic: '' },
      { ...valid, evidence: [] },
      { ...valid, date: '08/04/2026' },
      'not an object',
    ]);
    expect(warnings.some((w: string) => w.includes('[0].topic'))).toBe(true);
    expect(warnings.some((w: string) => w.includes('[1].evidence'))).toBe(true);
    expect(warnings.some((w: string) => w.includes('[2].date'))).toBe(true);
    expect(warnings.some((w: string) => w.includes('[3]'))).toBe(true);
  });
});
