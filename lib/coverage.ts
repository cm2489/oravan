/*
 * Read-section data layer: third-party news coverage of a bill, each article
 * labeled with its outlet's lean from the vendored AllSides table.
 *
 * Deliberately NOT 'server-only' (like lib/core): the pure matcher is
 * imported by tests/coverage.unit.spec.ts. getCoverage is only ever called
 * server-side from the bill page. JSON is imported by relative path so the
 * module resolves identically under the Next bundler and the Playwright/esbuild
 * test runner (the '@/' alias isn't exercised by the existing test suite).
 */
import coverageData from '../data/coverage.json';
import mediaBias from '../data/media-bias.json';
// THE CLOCK, from the ONE copy, by the import door lib/ is allowed to use
// directly (components go through lib/signal-window.ts — see its header). The
// "In the news" band is a present-tense claim, so it reads the same
// definition of "now" the amber gate and the homepage crown read.
import { isSignalFresh } from './urgency.mjs';
import type { CoverageArticle, CoverageArticleRaw, CoverageTier, Lean } from './types';

/** AllSides lean keyed by bare outlet domain. */
const LEAN_BY_DOMAIN = mediaBias.outlets as unknown as Record<string, Lean>;

/** Bill slug -> stored articles. '_'-prefixed keys are metadata, never slugs. */
const COVERAGE = coverageData as unknown as Record<string, CoverageArticleRaw[]>;

/**
 * Reduce an API source to a bare lowercase domain for matching: strip scheme,
 * any path, and a leading "www.". Pure — safe to unit-test in isolation.
 */
export function normalizeSource(source: string): string {
  return (source ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

/** Outlet lean from the AllSides table, or null when the outlet is unrated. */
export function leanFor(source: string): Lean | null {
  return LEAN_BY_DOMAIN[normalizeSource(source)] ?? null;
}

/**
 * Classify a bill's coverage by how it spreads across the press. One-sided
 * coverage is still shown (with a disclaimer) and never coverage-boosted in the
 * feed — consequence (urgency), not partisan attention, decides prominence.
 */
export function coverageTier(articles: CoverageArticle[]): CoverageTier {
  const outlets = new Set(articles.map((a) => normalizeSource(a.source)));
  if (outlets.size < 2) return 'none'; // a single outlet isn't "how it's being covered"
  const partisan = new Set(articles.map((a) => a.lean).filter((l) => l === 'left' || l === 'right'));
  if (partisan.size >= 2) return 'cross';
  if (partisan.size === 1) return 'one_sided';
  return 'neutral';
}

/**
 * Articles covering a bill, each enriched with its outlet's lean. Empty when
 * coverage is too thin to surface (tier 'none'); otherwise the full list, and
 * the page renders the section (disclaimed when one-sided).
 */
export function getCoverage(slug: string): CoverageArticle[] {
  const raw = COVERAGE[slug];
  if (!Array.isArray(raw)) return [];
  const articles = raw.map((a) => ({ ...a, lean: leanFor(a.source) }));
  return coverageTier(articles) === 'none' ? [] : articles;
}

/**
 * The newest DATED article stored for a bill, as an ISO day string — the one
 * fact the recency gate below runs on.
 *
 * Undated articles are ignored rather than treated as new: `publishedAt` is
 * nullable in the stored record (TheNewsAPI does not always return one), and
 * reading "no date" as "today" is precisely the direction that manufactures
 * urgency. A bill whose articles are ALL undated therefore returns null and
 * fails the gate — the same fail-closed rule isSignalFresh has always applied
 * to an undated legislative signal. (0 of the 391 bills carrying stored
 * articles are in that state on the 2026-08-12 corpus; the branch exists for
 * the record the sync has not written yet.)
 */
export function newestArticleDate(articles: Pick<CoverageArticle, 'publishedAt'>[]): string | null {
  let newest: string | null = null;
  for (const a of articles) {
    if (a.publishedAt && (newest === null || a.publishedAt > newest)) newest = a.publishedAt;
  }
  return newest;
}

/**
 * Rank bills for the "In the news" discovery lens: cross-spectrum first, then
 * neutral, then by # of outlets, then urgency. One-sided (and none) are dropped
 * — coverage never boosts a partisan-only bill into discovery. Pure, so the
 * ordering is unit-testable; getNewsBills feeds it real bills.
 *
 * THE RECENCY GATE (2026-08-12). Selection used to read the coverage TIER and
 * nothing else, so a bill's band membership was decided entirely by how widely
 * it was once covered and never by when. Under a heading that reads "In the
 * news" — present tense, on the homepage's discovery band — the committed
 * corpus served the same six bills for twelve straight days, four of them on
 * articles from April, May and July — 109, 86, 77 and 16 days old at the time
 * of measurement (2026-08-12T14:02Z) — against a band a reader takes as "what
 * is being written about right now".
 *
 * The gate is SIGNAL_WINDOW_DAYS, deliberately the same 14 days amber and the
 * green panel run on (lib/urgency.mjs), because it answers the same question in
 * a different medium: is this fact still current enough to state in the present
 * tense? Two clocks for one claim is how two surfaces end up disagreeing.
 *
 * A SHORTER BAND IS THE POINT, and an EMPTY one is a legitimate result. Both
 * render sites already guard on `length > 0` and NewsLens returns null on an
 * empty list, so a quiet fortnight in the press drops the section entirely
 * rather than backfilling from the archive — the same honesty rule the "Act
 * now" band's absolute floor buys (lib/taxonomy.ts's v3 history). Ordering is
 * untouched: breadth still decides prominence, never partisan attention.
 *
 * `now` is injectable for the same reason effectiveUrgency's is — a corpus
 * sweep must evaluate every bill at ONE instant. Every production caller takes
 * the default.
 */
const NEWS_TIER_RANK: Record<string, number> = { cross: 0, neutral: 1 };

export function rankNews<
  T extends { tier: CoverageTier; sources: number; urgency: number; newestArticle: string | null },
>(items: T[], n: number, now: number = Date.now()): T[] {
  return items
    .filter((i) => i.tier === 'cross' || i.tier === 'neutral')
    .filter((i) => isSignalFresh(i.newestArticle, now))
    .sort((a, b) => NEWS_TIER_RANK[a.tier] - NEWS_TIER_RANK[b.tier] || b.sources - a.sources || b.urgency - a.urgency)
    .slice(0, n);
}
