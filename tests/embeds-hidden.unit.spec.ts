import { expect, test } from '@playwright/test';
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
 * This file pins the two things a build cannot see.
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
const NOT_OPEN = { en: /aren't open to new sites right now/, es: /no están abiertos a sitios nuevos/ } as const;

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
