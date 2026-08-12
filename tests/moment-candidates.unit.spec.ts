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
 */
const candidate = (over: Partial<Fixture> & { slug: string }): Fixture => ({
  docketRank: 4, // t4, the residual rung
  lastActionDate: '2026-07-20',
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
