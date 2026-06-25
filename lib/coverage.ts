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
import type { CoverageArticle, CoverageArticleRaw, Lean } from './types';

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
 * Articles covering a bill, each enriched with its outlet's lean. Returns an
 * empty array when the bill has no coverage (the section then renders nothing).
 */
export function getCoverage(slug: string): CoverageArticle[] {
  const raw = COVERAGE[slug];
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => ({ ...a, lean: leanFor(a.source) }));
}
