import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { EMBEDS_PAGES_PUBLIC, HIDDEN_PAGES } from '../lib/site';
import { localeRoutes } from './routes';

/*
 * The /embeds pages are hidden until embeds come back. Owner, 2026-09-28
 * (open-questions page, item F, option a): "Hide the embeds pages and terms
 * until embeds come back. Nothing half-filled stays public. Embeds come back
 * with filled terms."
 *
 * One constant, lib/site.ts's EMBEDS_PAGES_PUBLIC, hides both pages and every
 * link to them; tests/embeds-hidden.spec.ts checks that on the built site.
 * This file pins what a build cannot see: the filled-terms rule, the /partners
 * intro, and the list of everything the flip brings back (at the bottom).
 */

const PLACEHOLDER = '[FOUNDER:';

test('embeds come back only with filled terms: the guard stays off while a placeholder remains', () => {
  for (const [locale, m] of [
    ['en', en],
    ['es', es],
  ] as const) {
    const unfilled = Object.entries(m.embedsTerms)
      .filter(([, text]) => text.includes(PLACEHOLDER))
      .map(([key]) => `embedsTerms.${key}`);
    if (unfilled.length > 0) {
      expect(
        EMBEDS_PAGES_PUBLIC,
        `${locale}: ${unfilled.join(', ')} still hold a placeholder, so the /embeds pages stay hidden`,
      ).toBe(false);
    }
  }
});

/*
 * /partners stays public and says, in its intro, that the embeds aren't open
 * to new sites right now. That sentence is only true while the pages are
 * hidden, so flipping the guard fails here until the intro is rewritten
 * (tests/plans-claim.unit.spec.ts does the same for the plans sentence).
 */
const NOT_OPEN = { en: /aren’t open to new sites right now/, es: /no están abiertos a sitios nuevos/ } as const;

test('the /partners intro says the embeds are closed exactly while the pages are hidden', () => {
  for (const [locale, m] of [
    ['en', en],
    ['es', es],
  ] as const) {
    if (EMBEDS_PAGES_PUBLIC) expect(m.partners.intro, locale).not.toMatch(NOT_OPEN[locale]);
    else expect(m.partners.intro, locale).toMatch(NOT_OPEN[locale]);
  }
});

test('the hidden list names real static pages, and is empty once the guard is on', () => {
  const statics = new Set(
    localeRoutes()
      .filter((r) => r.kind === 'page' && !r.dynamic)
      .map((r) => r.pattern),
  );
  for (const path of HIDDEN_PAGES) {
    expect(statics.has(path), `${path} is hidden, but app/[locale] has no such page`).toBe(true);
  }
  expect([...HIDDEN_PAGES]).toEqual(EMBEDS_PAGES_PUBLIC ? [] : ['/embeds', '/embeds/terms']);
});

/*
 * What comes back when EMBEDS_PAGES_PUBLIC flips to true: every file outside
 * tests that imports the guard (or HIDDEN_PAGES, which derives from it) from
 * lib/site.ts, and what that file turns back on. The second test keeps the
 * list whole, so a new surface that follows the guard has to be named here.
 */
const COMES_BACK: Record<string, string> = {
  'app/[locale]/embeds/page.tsx': 'the /embeds page, both languages',
  'app/[locale]/embeds/terms/page.tsx': 'the /embeds/terms page, both languages',
  'app/sitemap.ts': 'their sitemap entries',
  'components/Footer.tsx': 'the footer link',
  'app/llms.txt/route.ts': 'the llms.txt Embeds line',
  'app/[locale]/follow/page.tsx': 'the /follow embeds section',
  'app/[locale]/partners/page.tsx': 'the /partners "Build your embed" button',
  'app/embed/action-panel/page.tsx': 'the widget refusal link to /embeds (it points at /partners while hidden)',
  // Owner, 2026-09-29: "brand off". This one spends money: at most 250
  // Anthropic calls a day, about $2/day, per the route's own header. While
  // hidden, POST answers 404 before any limiter, fetch or model call
  // (tests/brand-off.unit.spec.ts).
  'app/api/brand/route.ts': "POST /api/brand, the configurator's paid theme suggestion",
};

const IMPORTS_GUARD = /import\s*\{[^}]*\b(?:EMBEDS_PAGES_PUBLIC|HIDDEN_PAGES)\b[^}]*\}\s*from\s*'@\/lib\/site'/;

function codeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...codeFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

test('every surface on the flip list still reads the guard', () => {
  for (const file of Object.keys(COMES_BACK)) {
    expect(readFileSync(file, 'utf8'), `${file} no longer imports the guard from lib/site.ts`).toMatch(
      IMPORTS_GUARD,
    );
  }
});

test('the flip list is whole: no other file reads the guard', () => {
  const readers = ['app', 'components', 'lib']
    .flatMap(codeFiles)
    .filter((file) => IMPORTS_GUARD.test(readFileSync(file, 'utf8')))
    .sort();
  expect(readers, 'a file follows EMBEDS_PAGES_PUBLIC but is missing from COMES_BACK above').toEqual(
    Object.keys(COMES_BACK).sort(),
  );
});
