import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

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
 * Every [locale] page that must be prerendered HTML, in BOTH locales. The
 * list is deliberately the whole flat surface rather than a sample: a
 * regression that catches one page catches all of them, but a regression that
 * catches only the newest page is exactly what a sample misses.
 *
 * Absent on purpose: `/reps` (reads searchParams — legitimately dynamic),
 * `/nominations/[slug]` (declares no generateStaticParams on purpose; see its
 * page comment) and the [...rest] catch-all.
 */
const STATIC_PAGES = [
  '',
  '/about',
  '/bills',
  '/citations',
  '/embeds',
  '/embeds/terms',
  '/glossary',
  '/mcp',
  '/partners',
  '/privacy',
  '/questions',
  '/record',
  '/terms',
  '/why-call',
] as const;

function routes(): Record<string, unknown> {
  if (!existsSync(MANIFEST)) {
    throw new Error(
      `No ${MANIFEST}. This spec reads the output of a production build; run \`npx next build\` first ` +
        `(playwright.config.ts's webServer does it automatically unless PW_NO_WEBSERVER is set).`,
    );
  }
  return JSON.parse(readFileSync(MANIFEST, 'utf8')).routes ?? {};
}

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
