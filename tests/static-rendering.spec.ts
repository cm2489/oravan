import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/*
 * README principle 2 ("Static-first … baked into statically generated pages")
 * and CLAUDE.md's architecture line were, for a stretch, claims nothing
 * checked. On the production build of 2026-09-18 EVERY [locale] route was
 * marked `ƒ Dynamic`, `.next/prerender-manifest.json` held 10 non-image
 * entries — feeds and metadata files, not one page — and live responses came
 * back `x-vercel-cache: MISS` with
 * `cache-control: private, no-cache, no-store` — while both documents went on
 * promising prerendered pages. The cause was one file
 * (app/[locale]/loading.tsx, whose header comment has the mechanism), and the
 * reason it survived that long is that no test could tell the difference: the
 * site renders identically either way. Only the bill is different.
 *
 * So this spec asserts the posture itself, from the build's own manifest.
 * Pure Node — it takes no `page` fixture and launches no browser.
 *
 * It reads the artifact of the `next build` that playwright.config.ts's
 * webServer already runs before any test, so it costs nothing extra in CI.
 * Run locally with PW_NO_WEBSERVER=1 and no prior build and it fails loudly
 * with instructions rather than skipping — a skipped posture check and a
 * passed one print the same green tick, which is the failure mode that let
 * this regression ship.
 */

const MANIFEST = join(process.cwd(), '.next/prerender-manifest.json');

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

test('the shared loading boundary stays a client component', () => {
  /*
   * The fast, diagnostic half of this spec: the manifest assertions above say
   * WHAT broke, this one says WHERE. app/[locale]/loading.tsx sits at the root
   * of every [locale] route and Next renders it in its own render, above which
   * no layout — and therefore no setRequestLocale — has run. As a server
   * component its next-intl call falls through to reading a request header,
   * and that one dynamic API marks the entire site dynamic.
   */
  const source = readFileSync(join(process.cwd(), 'app/[locale]/loading.tsx'), 'utf8');
  expect(
    source.trimStart().startsWith("'use client'"),
    "app/[locale]/loading.tsx must stay a client component, or next-intl resolves its locale " +
      'from a request header and every page on the site goes dynamic. See the file comment.',
  ).toBe(true);
});
