/*
 * THE ROUTE REGISTRY — every route under app/[locale], read off the
 * filesystem once, plus the one concrete probe URL per route and per
 * app/api and app/embed segment that the sweep specs fetch.
 *
 * Why (2026-09-27 audit, trap-analysis §4 "Corpus fixtures and registries"):
 * five specs each kept their own hand-written list of the site's pages —
 * hreflang's PATHS, sitemap's STATIC_PATH_COUNT, static-rendering's
 * STATIC_PAGES, zero-cookies' ROUTES and frame-posture's segment maps. Adding
 * a page meant editing five files, and forgetting one did not fail anything:
 * the page simply went unchecked for hreflang, cookies or prerendering. Read
 * from the tree, a new page is covered by all five the day it lands, and a
 * new DYNAMIC route fails loudly until it is given a probe below.
 *
 * What stays in the specs themselves is the part that is a decision rather
 * than a list: static-rendering names the pages that render on demand and
 * why (CLAUDE.md rule 2), and frame-posture states what each surface's
 * frame-ancestors answer is.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  briefDate,
  decodedBillSlug,
  memberBioguide,
  nominationSlugSample,
  questionId,
} from './corpus-samples';

export const APP_DIR = path.join(process.cwd(), 'app');
export const LOCALE_DIR = path.join(APP_DIR, '[locale]');

export type Locale = 'en' | 'es';
export const LOCALES: readonly Locale[] = ['en', 'es'];

export interface LocaleRoute {
  /** The locale-relative route as the router sees it: '/' for the homepage,
   *  '/bills/[id]' for a dynamic one. */
  pattern: string;
  /** `page` (a page.tsx) or `handler` (a route.ts, e.g. the PWA manifest). */
  kind: 'page' | 'handler';
  /** The first directory under app/[locale] ('' for the homepage). */
  segment: string;
  /** Carries at least one [param] segment. */
  dynamic: boolean;
  /** A [...catchAll] or [[...optional]] segment. */
  catchAll: boolean;
}

const PAGE_FILE = /^page\.(tsx|ts|jsx|js)$/;
const ROUTE_FILE = /^route\.(tsx|ts|jsx|js)$/;

/** App Router folder conventions: `_private` folders and `@slot` parallel
 *  routes add no URL; `(group)` folders add no segment. */
function urlSegment(dir: string): string | null {
  if (dir.startsWith('(') && dir.endsWith(')')) return null;
  return dir;
}

function walk(absDir: string, fsSegments: string[], urlSegments: string[]): LocaleRoute[] {
  const out: LocaleRoute[] = [];
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const pattern = '/' + urlSegments.join('/');
  const dynamic = urlSegments.some((s) => s.startsWith('['));
  const catchAll = urlSegments.some((s) => s.startsWith('[...') || s.startsWith('[[...'));
  const segment = fsSegments[0] ?? '';
  for (const e of entries) {
    if (e.isFile() && (PAGE_FILE.test(e.name) || ROUTE_FILE.test(e.name))) {
      out.push({ pattern, kind: PAGE_FILE.test(e.name) ? 'page' : 'handler', segment, dynamic, catchAll });
    }
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('@')) continue;
    const seg = urlSegment(e.name);
    out.push(
      ...walk(path.join(absDir, e.name), [...fsSegments, e.name], seg ? [...urlSegments, seg] : urlSegments)
    );
  }
  return out;
}

/** Every page and route handler under app/[locale], sorted by pattern. */
export function localeRoutes(): LocaleRoute[] {
  return walk(LOCALE_DIR, [], []).sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** The locale-relative paths of every page with no dynamic segment:
 *  '/', '/about', '/embeds/terms', … */
export function staticLocalePages(): string[] {
  return localeRoutes()
    .filter((r) => r.kind === 'page' && !r.dynamic)
    .map((r) => r.pattern);
}

/** The first directory under app/[locale] of every route, deduplicated. */
export function localeTopSegments(): string[] {
  return [...new Set(localeRoutes().map((r) => r.segment).filter(Boolean))].sort();
}

/**
 * One concrete path per DYNAMIC route, drawn from the committed corpus
 * (tests/corpus-samples.ts) so a rotated record can never turn a probe into
 * a 404 that happens to carry the right header. A dynamic route missing here
 * makes `unresolvedLocaleRoutes()` non-empty and every sweep spec fails on it.
 */
export const DYNAMIC_ROUTE_PROBES: Record<string, () => string> = {
  '/bills/[id]': () => `/bills/${decodedBillSlug()}`,
  '/questions/[id]': () => `/questions/${questionId()}`,
  '/reps/[bioguide]': () => `/reps/${memberBioguide()}`,
  '/nominations/[slug]': () => `/nominations/${nominationSlugSample()}`,
  '/today/[date]': () => `/today/${briefDate()}`,
  // The locale catch-all: a path no real route claims (a true 404 inside the
  // locale boundary).
  '/[...rest]': () => '/this-page-does-not-exist-404',
};

/** Dynamic routes on disk with no probe in DYNAMIC_ROUTE_PROBES. */
export function unresolvedLocaleRoutes(): string[] {
  return localeRoutes()
    .filter((r) => r.dynamic && !(r.pattern in DYNAMIC_ROUTE_PROBES))
    .map((r) => r.pattern);
}

/** The locale-relative path to fetch for a route: its own pattern when static,
 *  its corpus probe when dynamic. */
export function probePathFor(route: LocaleRoute): string {
  if (!route.dynamic) return route.pattern;
  const probe = DYNAMIC_ROUTE_PROBES[route.pattern];
  if (!probe) {
    throw new Error(
      `tests/routes.ts: app/[locale]${route.pattern} has no probe — add one to DYNAMIC_ROUTE_PROBES.`
    );
  }
  return probe();
}

/**
 * The URL a browser requests for a locale-relative path. Pages follow the
 * site's `as-needed` prefix (English bare, Spanish under /es). Route handlers
 * are addressed with the locale spelled out, because proxy.ts's matcher skips
 * any path with a dot in it — the layout links the manifest as
 * `/${locale}/manifest.webmanifest` for the same reason.
 */
export function localeUrl(locale: Locale, localePath: string, kind: LocaleRoute['kind'] = 'page'): string {
  if (kind === 'handler') return `/${locale}${localePath}`;
  if (locale === 'en') return localePath;
  return localePath === '/' ? '/es' : `/es${localePath}`;
}

export interface LocaleProbe {
  route: LocaleRoute;
  locale: Locale;
  url: string;
}

/** Every route under app/[locale], in the given locales, as a fetchable URL. */
export function localeProbes(locales: readonly Locale[] = LOCALES): LocaleProbe[] {
  const routes = localeRoutes();
  return locales.flatMap((locale) =>
    routes.map((route) => ({ route, locale, url: localeUrl(locale, probePathFor(route), route.kind) }))
  );
}

/** The top-level directories of an app/ subtree (app/api, app/embed), for the
 *  coverage guards below. */
export function appTopLevelDirs(rel: string): string[] {
  const dir = path.join(APP_DIR, rel);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
}

/**
 * One fetchable URL per app/api/* segment. A plain GET on purpose: POST-only
 * handlers answer 405, the tenant read answers 403 without its key, and the
 * webhook answers 405/503 — every one still a response the site's headers
 * apply to, and none of them spends anything.
 */
export const API_PROBES: Record<string, string> = {
  brand: '/api/brand',
  district: '/api/district',
  feedback: '/api/feedback',
  mcp: '/api/mcp/mcp',
  reps: '/api/reps?zip=78501',
  script: '/api/script',
  stripe: '/api/stripe/webhook',
  tenant: '/api/tenant/impressions',
};

/** One fetchable URL per app/embed/* segment, bill slugs and member ids drawn
 *  from the committed corpus. */
export function embedProbes(): Record<string, string> {
  return {
    'rep-lookup': '/embed/rep-lookup?locale=en',
    'bill-card': `/embed/bill-card?locale=en&slug=${decodedBillSlug()}`,
    // Same-origin portrait proxy: 404s while no Blob store is armed, still
    // under /embed/:path*.
    portrait: `/embed/portrait/${memberBioguide()}`,
    // Paid-tier panel: no token renders the "unauthorized" refusal state.
    'action-panel': `/embed/action-panel?locale=en&slug=${decodedBillSlug()}`,
  };
}
