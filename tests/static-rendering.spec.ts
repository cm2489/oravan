import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { getAllLegislators, getVacancies, vacancySlug } from '../lib/core';
import { briefWindow } from '../lib/today';
import { voteMembersPath } from '../lib/vote-members-path';
import { allRollCalls } from '../lib/votes';
import { localeRoutes, staticLocalePages } from './routes';

/*
 * README principle 2 ("Static-first … baked into statically generated pages")
 * and CLAUDE.md's architecture line were, for a stretch, claims nothing
 * checked. On the production build of 2026-09-18 EVERY [locale] route was
 * marked `ƒ Dynamic`, `.next/prerender-manifest.json` held 10 non-image
 * entries — feeds and metadata files, not one page — and live responses came
 * back `x-vercel-cache: MISS` with `cache-control: private, no-cache,
 * no-store`, while both documents went on promising prerendered pages.
 *
 * ── THE MECHANISM, WRITTEN DOWN BECAUSE ITS FILE IS GONE ──
 *
 * The trigger was `app/[locale]/loading.tsx`, a route-level loading boundary
 * sitting at the root of every [locale] route. As a SERVER component it called
 * next-intl's `useTranslations`, and when Next renders that boundary's
 * fallback, `setRequestLocale(locale)` — which the layout and every page do
 * call — has not populated next-intl's per-request locale cache. So the call
 * fell through to next-intl's last-resort path, `getCachedRequestLocale() ||
 * (await headers()).get(...)` in its RequestLocale module. `headers()` is a
 * dynamic API, so the boundary opted its whole segment into dynamic
 * rendering — and that segment was the entire site. Instrumenting next-intl's
 * fallback across a full build counted 6,004 header reads, every one of them
 * rooted at that file and no other. (The frames are the measurement; that the
 * fallback renders in a pass where no layout has run above it is the
 * inference drawn from them.)
 *
 * That file is now DELETED, by #253 — which arrived at the same file from a
 * different symptom: the implicit Suspense boundary a `loading.tsx` creates
 * makes Next flush a 200 shell before a page's own `notFound()` can set the
 * status, so unknown paths soft-404ed (vercel/next.js#75543). Deleting it
 * fixed both, and production now serves `/`, `/why-call`, `/es` and bill pages
 * with `x-vercel-cache: PRERENDER`. Nothing in this static-JSON site suspends
 * on data fetching, so nothing was lost.
 *
 * So this spec does not fix anything — the posture is already correct. It
 * exists because nothing could SEE the posture: the site renders identically
 * whether a page is prerendered or built per request, and only the hosting
 * bill and the cache headers differ. That is why the regression survived, and
 * why it took a second, louder bug to find the file. This asserts the posture
 * itself, from the build's own manifest, so the next such regression fails a
 * check instead of quietly costing money.
 *
 * Pure Node — it takes no `page` fixture and launches no browser. It reads the
 * artifact of the `next build` that playwright.config.ts's webServer already
 * runs before any test, so it costs nothing extra in CI. Run locally with
 * PW_NO_WEBSERVER=1 and no prior build and it fails loudly with instructions
 * rather than skipping — a skipped posture check and a passed one print the
 * same green tick, which is the failure mode that let this ship.
 */

const MANIFEST = join(process.cwd(), '.next/prerender-manifest.json');
const LOCALE_DIR = join(process.cwd(), 'app/[locale]');

/**
 * THE PAGES THAT RENDER ON DEMAND, AND WHY — CLAUDE.md rule 2 ("the few that
 * do not are named, with the reason, in tests/static-rendering.spec.ts").
 * Keyed by the route as it sits under app/[locale]. Every other page must
 * prerender, and the registry test below fails on a page that is in neither
 * camp — a new route has to be given one answer or the other.
 */
const RENDERED_ON_DEMAND: Record<string, string> = {
  '/reps':
    'reads searchParams (the ZIP lookup) — legitimately dynamic; its per-member children ' +
    '/reps/[bioguide] ARE static, pinned separately below',
  '/nominations/[slug]': 'declares no generateStaticParams on purpose; see its page comment',
  '/[...rest]': 'the locale catch-all: every path no real route claims is a 404',
};

/**
 * PER-REQUEST WORK BEYOND PAGES, AND WHY — CLAUDE.md rule 2 names proxy.ts,
 * the route handlers under app/api/ and the embed portrait proxy. Inside
 * proxy.ts, one piece of work goes beyond locale negotiation and the two
 * counts, and it is named here with its reason:
 *
 *   short addresses (2026-09-29): /hr9340 is answered with a 307 to the
 *   bill's page. A redirect cannot be a prerendered page, and generating one
 *   config redirect per bill (~6,450 rules) would be matched in order on
 *   every request and would forward the query string. The proxy instead does
 *   one pattern test and one bit test against a ~3 KB bitset that
 *   next.config.ts builds from data/bills.json at BUILD time. The test below
 *   pins that the corpus itself never enters the proxy bundle.
 */
const PER_REQUEST_IN_PROXY: Record<string, string> = {
  'lib/short-address.ts':
    'short addresses for bills: a constant-time bit test against a build-time bitset, ' +
    'answered with a 307; no corpus in the bundle',
};

/**
 * The dynamic routes whose prerendered ids each have their own test below
 * (the id set is the route's own generateStaticParams, recomputed here).
 */
const PRERENDERED_DYNAMIC = ['/bills/[id]', '/questions/[id]', '/reps/[bioguide]', '/today/[date]'];

/**
 * Every [locale] page that must be prerendered HTML, in BOTH locales: every
 * page with no dynamic segment (read off the tree by tests/routes.ts), less
 * the ones named above. Deliberately the whole flat surface rather than a
 * sample: a regression that catches one page catches all of them, but a
 * regression that catches only the newest page is exactly what a sample
 * misses. Paths are locale-relative with the homepage as '' (so
 * `/${locale}${path}` is the manifest key).
 */
const STATIC_PAGES = staticLocalePages()
  .filter((path) => !(path in RENDERED_ON_DEMAND))
  .map((path) => (path === '/' ? '' : path));

function routes(): Record<string, unknown> {
  if (!existsSync(MANIFEST)) {
    throw new Error(
      `No ${MANIFEST}. This spec reads the output of a production build; run \`npx next build\` first ` +
        `(playwright.config.ts's webServer does it automatically unless PW_NO_WEBSERVER is set).`,
    );
  }
  return JSON.parse(readFileSync(MANIFEST, 'utf8')).routes ?? {};
}

test('every [locale] page route is either prerendered or named here as rendered on demand', () => {
  const pages = localeRoutes().filter((r) => r.kind === 'page');
  const unclassified = pages
    .filter((r) => r.dynamic)
    .map((r) => r.pattern)
    .filter((p) => !PRERENDERED_DYNAMIC.includes(p) && !(p in RENDERED_ON_DEMAND));
  expect(
    unclassified,
    'A dynamic [locale] route with no answer: add its prerender test below (and list it in ' +
      'PRERENDERED_DYNAMIC), or name it in RENDERED_ON_DEMAND with the reason.',
  ).toEqual([]);

  // No stale entries: every route either list names still exists on disk.
  const patterns = new Set(pages.map((r) => r.pattern));
  const stale = [...PRERENDERED_DYNAMIC, ...Object.keys(RENDERED_ON_DEMAND)].filter((p) => !patterns.has(p));
  expect(stale, 'named routes that no longer exist under app/[locale]').toEqual([]);

  // And the flat list is never vacuous: the homepage is always in it.
  expect(STATIC_PAGES).toContain('');
});

test('every flat [locale] page is prerendered as static HTML, in both languages', () => {
  const prerendered = routes();
  const missing = ['en', 'es'].flatMap((locale) =>
    STATIC_PAGES.map((path) => `/${locale}${path}`).filter((route) => !(route in prerendered)),
  );
  expect(
    missing,
    'These [locale] routes are server-rendered on demand instead of prerendered — ' +
      'something in their tree reached for a dynamic API (headers/cookies/connection/searchParams). ' +
      'Reproduce with `npx next build` and read the ƒ/● column, then bisect with ' +
      "`export const dynamic = 'error'` on one page to make Next name the API.",
  ).toEqual([]);
});

test('the decoded corpus is prerendered, not rendered per request', () => {
  const prerendered = routes();
  const bills = Object.keys(prerendered).filter((r) => /^\/(en|es)\/bills\/[^/]+$/.test(r));
  const questions = Object.keys(prerendered).filter((r) => /^\/(en|es)\/questions\/[^/]+$/.test(r));

  // Floors, not exact counts: the corpus grows nightly. What is being pinned
  // is that these routes prerender AT ALL and in both languages — a corpus
  // that renders on demand is the expensive, cacheless posture README
  // principle 2 says this site does not have.
  expect(bills.length).toBeGreaterThan(200);
  expect(questions.length).toBeGreaterThan(4);
  expect(bills.some((r) => r.startsWith('/en/'))).toBe(true);
  expect(bills.some((r) => r.startsWith('/es/'))).toBe(true);
});

test('every member-of-Congress page is prerendered, in both languages', () => {
  const prerendered = routes();
  // The ids the route's generateStaticParams declares: every sitting member's
  // bioguide, plus every vacant seat's slug (a vacancy has no bioguide).
  const ids = [
    ...getAllLegislators().map((l) => l.bioguide),
    ...getVacancies().map((v) => vacancySlug(v)),
  ];
  expect(ids.length).toBeGreaterThan(500);
  const missing = ['en', 'es'].flatMap((locale) =>
    ids.map((id) => `/${locale}/reps/${id}`).filter((route) => !(route in prerendered)),
  );
  expect(missing, 'member pages rendered on demand instead of prerendered').toEqual([]);
});

test('every roll call\'s member list is a prerendered static file, not a per-request render', () => {
  // app/votes/[file]/route.ts (2026-09-29): the bill page's "How members
  // voted" list, one JSON file per stored roll call, fetched when a reader
  // opens it. It sits outside app/[locale] (no language: names and the
  // record's positions only), so the registry test above does not see it;
  // this one pins that the build wrote every file ahead of time.
  const prerendered = routes();
  const ids = allRollCalls().map((r) => r.id);
  expect(ids.length).toBeGreaterThan(0);
  const missing = ids.map(voteMembersPath).filter((route) => !(route in prerendered));
  expect(missing, 'roll-call member files rendered on demand instead of prerendered').toEqual([]);
});

test('the daily brief prerenders every dated permalink in its window, in both languages', () => {
  // /today/{date} for today and the 13 days before (lib/today.ts's window).
  // Older dates are not prerendered and 404 at request time — tests/today.spec.ts.
  const prerendered = routes();
  const missing = ['en', 'es'].flatMap((locale) =>
    briefWindow()
      .map((date) => `/${locale}/today/${date}`)
      .filter((route) => !(route in prerendered)),
  );
  expect(missing).toEqual([]);
});

test('any re-added loading boundary under [locale] is a client component', () => {
  /*
   * The fast, diagnostic half: the manifest assertions above say WHAT broke,
   * this one says WHERE to look first.
   *
   * There is no loading.tsx in the tree today and this test does not ask for
   * one — #253 deleted the only one there was, for the soft-404 reason in the
   * header comment, and re-adding a route-level loading boundary anywhere
   * under [locale] would re-open that bug. This is a tripwire for the day
   * someone adds one back anyway: it must not resolve the locale from a
   * server context, or it drags the whole site back to dynamic. A client
   * component reads the locale from the layout's NextIntlClientProvider
   * instead, which is the only shape of this file that is safe on both
   * counts — and it is still a decision to make deliberately, not a detail.
   */
  const offenders = readdirSync(LOCALE_DIR, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name === 'loading.tsx')
    .map((entry) => join(entry.parentPath ?? LOCALE_DIR, entry.name))
    .filter((path) => !readFileSync(path, 'utf8').trimStart().startsWith("'use client'"));

  expect(
    offenders,
    'A server-component loading.tsx under app/[locale] makes next-intl resolve its locale from a ' +
      'request header, which marks every page on the site dynamic. See this file’s header comment — ' +
      'and note that re-adding a loading boundary at all re-opens the soft-404 that #253 fixed.',
  ).toEqual([]);
});

test('the short-address lookup in proxy.ts carries a build-time bitset, never the corpus', () => {
  // Source half: the lookup module imports nothing (so it cannot reach
  // data/), and proxy.ts reaches the corpus only through it.
  for (const file of Object.keys(PER_REQUEST_IN_PROXY)) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source, `${file} must import nothing`).not.toMatch(/^\s*import\s/m);
  }
  const proxy = readFileSync(join(process.cwd(), 'proxy.ts'), 'utf8');
  expect(proxy).toContain("from './lib/short-address'");
  const proxyImports = proxy.split('\n').filter((line) => /^\s*import\s/.test(line));
  expect(proxyImports.join('\n')).not.toMatch(/data\/|bills\.json|lib\/core/);

  // Build half: find the server bundle(s) that hold the short-address
  // pattern and prove none of them carries corpus text.
  const serverDir = join(process.cwd(), '.next/server');
  if (!existsSync(serverDir)) throw new Error('No .next/server: run `npx next build` first (see routes() above).');
  const marker = 'hconres|sconres|hjres|sjres|hres|sres|hr|s';
  const holders = readdirSync(serverDir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => join(e.parentPath ?? serverDir, e.name))
    .filter((file) => readFileSync(file, 'utf8').includes(marker));
  expect(holders.length, 'no built server file holds the short-address lookup').toBeGreaterThan(0);
  for (const file of holders) {
    const text = readFileSync(file, 'utf8');
    expect(text, `${file} carries corpus fields`).not.toContain('full_identifier');
    expect(text, `${file} carries corpus fields`).not.toContain('ai_summary');
  }
});
