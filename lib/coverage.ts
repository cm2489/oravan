/*
 * Read-section data layer: third-party news coverage of a bill, each article
 * labeled with its outlet's lean from the vendored AllSides table.
 *
 * Deliberately NOT 'server-only' (unlike lib/data.ts): the pure matcher is
 * imported by tests/coverage.unit.spec.ts. getCoverage is only ever called
 * server-side from the bill page. JSON is imported by relative path so the
 * module resolves identically under the Next bundler and the Playwright/esbuild
 * test runner (the '@/' alias isn't exercised by the existing test suite).
 */
import coverageData from '../data/coverage.json';
import mediaBias from '../data/media-bias.json';
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
 * Rank bills for the "In the news" discovery lens: cross-spectrum first, then
 * neutral, then by # of outlets, then urgency. One-sided (and none) are dropped
 * — coverage never boosts a partisan-only bill into discovery. Pure, so the
 * ordering is unit-testable; getNewsBills feeds it real bills.
 */
const NEWS_TIER_RANK: Record<string, number> = { cross: 0, neutral: 1 };

export function rankNews<T extends { tier: CoverageTier; sources: number; urgency: number }>(
  items: T[],
  n: number,
): T[] {
  return items
    .filter((i) => i.tier === 'cross' || i.tier === 'neutral')
    .sort((a, b) => NEWS_TIER_RANK[a.tier] - NEWS_TIER_RANK[b.tier] || b.sources - a.sources || b.urgency - a.urgency)
    .slice(0, n);
}
