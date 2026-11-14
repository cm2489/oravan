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
import relatedBillsData from '../data/related-bills.json';
// The record's "Identical bill" relation, read one hop in both directions
// (lib/related-bills.mjs, import-free; its header says what is left out).
import { twinsOf } from './related-bills.mjs';
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

/** data/related-bills.json: the record's "Identical bill" relations
 *  (scripts/sync-related.mjs). Read only through twinsOf. */
const RELATED = relatedBillsData as unknown as Record<string, unknown>;

/** Bill slug -> the day the nightly sweep last LOOKED (scripts/sync-coverage.mjs's
 *  `_checkedAt` rotation, #158). A '_'-prefixed metadata key, so getCoverage()
 *  has always ignored it. */
const CHECKED_AT = ((coverageData as unknown as Record<string, unknown>)._checkedAt ?? {}) as Record<
  string,
  string
>;

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
 * The most articles a bill's TWINS may add to its box: the nightly's
 * COVERAGE_PER_BILL (scripts/sync-coverage.mjs), the same number a bill may
 * store of its own. A bill's own articles are never pushed out by a twin's,
 * the same "two caps, not one" rule mergeArticles applies to routed rows.
 */
export const TWIN_ARTICLES_MAX = 5;

/** "The same article": the identity the nightly sync dedupes by
 *  (scripts/coverage-query.mjs, articleMatcher): the URL, or the title. */
const urlKey = (a: { url?: string | null }) => (typeof a.url === 'string' ? a.url.trim() : '');
const titleKey = (a: { title?: string | null }) => String(a.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const dayOf = (a: { publishedAt?: string | null }) => {
  const d = String(a.publishedAt ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
};

/**
 * A bill's own articles plus the ones stored under its twins, as one list.
 * Pure, so the rule is pinned on fixtures (tests/twin-coverage.unit.spec.ts).
 *
 * THE RULE (owner, 2026-11-13, his card: "Show news about a bill's twin under
 * the bill? … " — he chose "Yes, show it under the bill as it is."):
 *   - Every own article stays, in its place in the newest-first order.
 *   - A twin's article is added AS IT IS (headline, outlet, date, lean), unless
 *     it is already listed (same URL or same title, the sync's own identity),
 *     so an article stored under both bills is listed once.
 *   - At most TWIN_ARTICLES_MAX twin articles, newest first, undated last.
 *   - The result is newest first; on the same day a bill's own article comes
 *     before a twin's. Undated articles sort after every dated one.
 * `twins` names the twin bills that actually contributed an article, in the
 * order their first article appears, so the box can say whose coverage it is.
 */
export function mergeTwinCoverage<A extends CoverageArticleRaw>(
  own: A[],
  twins: { slug: string; articles: A[] }[],
  cap: number = TWIN_ARTICLES_MAX
): { articles: A[]; twins: string[] } {
  const urls = new Set<string>();
  const titles = new Set<string>();
  const seen = (a: A) => {
    const u = urlKey(a);
    const t = titleKey(a);
    return Boolean((u && urls.has(u)) || (t && titles.has(t)));
  };
  const mark = (a: A) => {
    const u = urlKey(a);
    const t = titleKey(a);
    if (u) urls.add(u);
    if (t) titles.add(t);
  };
  const ownList = (own ?? []).filter((a) => a && typeof a === 'object');
  for (const a of ownList) mark(a);

  const pool: { a: A; from: string; i: number }[] = [];
  let i = 0;
  for (const tw of twins ?? []) {
    for (const a of tw.articles ?? []) {
      if (!a || typeof a !== 'object') continue;
      if (seen(a)) continue;
      mark(a);
      pool.push({ a, from: tw.slug, i: i++ });
    }
  }
  const picked = pool
    .sort((x, y) => dayOf(y.a).localeCompare(dayOf(x.a)) || x.i - y.i)
    .slice(0, Math.max(0, cap));

  const rows = [
    ...ownList.map((a, k) => ({ a, own: 0, k, from: '' })),
    ...picked.map((p, k) => ({ a: p.a, own: 1, k, from: p.from })),
  ].sort((x, y) => dayOf(y.a).localeCompare(dayOf(x.a)) || x.own - y.own || x.k - y.k);

  const from: string[] = [];
  for (const r of rows) if (r.from && !from.includes(r.from)) from.push(r.from);
  return { articles: rows.map((r) => r.a), twins: from };
}

/**
 * What the bill page's box reads before the Big Question rule: the bill's own
 * stored articles plus its twins' (mergeTwinCoverage), each with its outlet's
 * lean, empty when the whole set is too thin (tier 'none', as getCoverage).
 * `twins` lists only bills whose articles are in `articles`.
 *
 * getCoverage is left as it was on purpose: the homepage news band, MCP and
 * the Big Question timeline keep reading a bill's own stored coverage only.
 * His decision is about what is shown UNDER THE BILL.
 */
export function getCoverageWithTwins(slug: string): { articles: CoverageArticle[]; twins: string[] } {
  const enrich = (rows: CoverageArticleRaw[] | undefined): CoverageArticle[] =>
    Array.isArray(rows) ? rows.map((a) => ({ ...a, lean: leanFor(a.source) })) : [];
  const twins = twinsOf(RELATED, slug)
    .filter((s) => Array.isArray(COVERAGE[s]))
    .map((s) => ({ slug: s, articles: enrich(COVERAGE[s]) }));
  const merged = mergeTwinCoverage(enrich(COVERAGE[slug]), twins);
  return coverageTier(merged.articles) === 'none' ? { articles: [], twins: [] } : merged;
}

/**
 * The "Checked" day for a box that may hold twins' articles: the EARLIEST of
 * the bill's own check day and each contributing twin's, so the line never
 * dates a look more recently than every part of the list was looked for.
 * Null (no line) when any of them has no check day. With no twins it is
 * exactly coverageCheckedAt(slug).
 */
export function coverageCheckedAtWithTwins(slug: string, twins: string[]): string | null {
  let earliest: string | null = null;
  for (const s of [slug, ...twins]) {
    const day = coverageCheckedAt(s);
    if (day === null) return null;
    if (earliest === null || day < earliest) earliest = day;
  }
  return earliest;
}

/**
 * What a BILL PAGE's "Read" box may show, given whether the bill is part of a
 * Big Question (a vehicle of a live or stale moment — lib/moments.ts's
 * getMomentsForBill, the same reader that draws the page's "part of a bigger
 * question" line). Pure, so the rule is pinned on fixtures
 * (tests/coverage-box-visibility.unit.spec.ts); the page passes the boolean.
 *
 * THE RULE (owner, 2026-11-13, on his decision card: "Yes, plus one change
 * before press: hide the box on non-Big-Question bills when it shows only one
 * side."). His 2026-09-28 ruling stands as it was ("For now lets just do
 * covereage on the Big Questions so I can monitor how it's doing from a user
 * perspective and then we can add it site wide"): a Big Question bill shows
 * its box one-sided or not, with the one-sided note. What changes is only the
 * other bills: when the box would be one-sided, it is not shown at all.
 *
 * "ONE SIDE" IS NOT A NEW DEFINITION. It is `coverageTier(...) === 'one_sided'`
 * — the condition CoverageSection already reads to print `oneSidedNote`: two or
 * more outlets, and exactly one partisan lean (left or right) among them.
 * Unrated and center outlets do not make a set two-sided. Everything else
 * passes through unchanged (cross, neutral), and so does an empty list.
 */
export function coverageForBillPage(
  articles: CoverageArticle[],
  partOfBigQuestion: boolean
): CoverageArticle[] {
  if (!partOfBigQuestion && coverageTier(articles) === 'one_sided') return [];
  return articles;
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
 * The day the nightly coverage sweep last LOOKED at a bill, as a bare
 * `YYYY-MM-DD`, or null when the map has no entry for it.
 *
 * WHY THIS IS RENDERED AT ALL (2026-08-12). #158 started recording this and
 * nothing ever showed it, so the "Read" section could only ever hedge — a bill
 * whose newest article is 90 days old carried "newer coverage may exist that
 * we haven't collected" whether the sweep had looked last night or last March,
 * and a reader had no way to tell those apart. On the committed corpus that
 * hedge is doing far more apologising than the pipeline now needs: every one
 * of the 391 bills carrying stored articles has a check date, the whole map is
 * within four days, and 903 bills were checked today.
 *
 * It does NOT replace the hedge, and must not be read as doing so — see
 * components/CoverageSection.tsx's guard comment. "We looked on this day" and
 * "nothing newer exists" are different claims; the sweep keeps at most
 * COVERAGE_PER_BILL articles that clear a relevance gate and stops early on
 * the news API's daily quota, so only the first is ever true. Both sentences
 * coexist deliberately: one dates the look, the other bounds it.
 *
 * A DIFFERENT CLOCK from every other date in this section. The article dates
 * are the press's; `checkedAt` on the bill page's stamp is the Congress.gov
 * bill sync's; this one is the news sweep's. Three clocks, three labels, never
 * merged (lib/freshness-state.ts's COVERAGE_AGE_NOTE_DAYS comment makes the
 * same point about the age window).
 *
 * Malformed values return null rather than being printed: the map is machine-
 * written and a date the reader can't trust is worse than no date at all.
 */
export function coverageCheckedAt(slug: string): string | null {
  const day = CHECKED_AT[slug];
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
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
