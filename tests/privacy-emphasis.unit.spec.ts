import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { PRIVACY_BOLD, PRIVACY_PARAGRAPHS, type PrivacyParagraph, withoutTags } from './privacy-bold';

/*
 * /privacy bolds each paragraph's promise (owner's pick, 2026-09-29: Version
 * 2, "bold key phrases, no new words, no headers"). The tags live in
 * messages/*.json, so this spec pins the catalog and next-intl's own parse of
 * it; tests/privacy-emphasis.spec.ts pins the same phrases on the rendered
 * page, by role. The phrase lists are in tests/privacy-bold.ts.
 */

const PAGE = readFileSync(join(process.cwd(), 'app/[locale]/privacy/page.tsx'), 'utf8');

/** The page's paragraph order, read from its source so the lists cannot drift from it. */
function pageOrder(): string[] {
  const list = PAGE.match(/\(\[([^\]]+)\] as const\)\.map/);
  expect(list, 'the privacy page renders its paragraphs from one literal list').not.toBeNull();
  return [...list![1].matchAll(/'(p\d+)'/g)].map((m) => m[1]);
}

const boldIn = (message: string) => [...message.matchAll(/<strong>(.*?)<\/strong>/g)].map((m) => m[1]);

test('the pinned lists cover exactly the paragraphs the page renders', () => {
  expect([...pageOrder()].sort()).toEqual([...PRIVACY_PARAGRAPHS].sort());
});

for (const [locale, catalog] of [
  ['en', en],
  ['es', es],
] as const) {
  const privacy = catalog.privacy as Record<string, string>;

  test(`${locale}: each paragraph bolds exactly its pinned phrases, and no others`, () => {
    for (const key of PRIVACY_PARAGRAPHS) {
      expect(typeof privacy[key], key).toBe('string');
      expect(boldIn(privacy[key]), `${locale} privacy.${key}`).toEqual(PRIVACY_BOLD[locale][key]);
    }
  });

  test(`${locale}: the only tag in privacy.* is a balanced, unnested <strong>`, () => {
    for (const [key, message] of Object.entries(privacy)) {
      const tags = [...message.matchAll(/<\/?\w+>/g)].map((m) => m[0]);
      // open, close, open, close … : never a second open before a close
      // (nesting), never a stray close, never another tag name.
      tags.forEach((tag, i) =>
        expect(tag, `${locale} privacy.${key} tag #${i}`).toBe(i % 2 === 0 ? '<strong>' : '</strong>')
      );
      expect(tags.length % 2, `${locale} privacy.${key} leaves a <strong> open`).toBe(0);
      // An ICU apostrophe right before `<` opens a quoted literal and the tag
      // would print as text. The English copy is full of apostrophes.
      expect(message, `${locale} privacy.${key}`).not.toMatch(/'</);
    }
  });

  test(`${locale}: the title, the closing line and the contact line carry no tag`, () => {
    // p5 is semibold as a whole, as it shipped; bold inside it would barely show.
    for (const key of ['title', 'p5', 'contact']) expect(privacy[key], key).not.toMatch(/</);
  });

  test(`${locale}: next-intl parses each paragraph into the same phrases and the same words`, () => {
    const t = createTranslator({ locale, messages: catalog, namespace: 'privacy' });
    for (const key of PRIVACY_PARAGRAPHS) {
      const marked = t.markup(key, { strong: (chunks) => `[${chunks}]` });
      const bold = [...marked.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
      expect(bold, `${locale} privacy.${key}`).toEqual(PRIVACY_BOLD[locale][key]);
      // No new words: the parsed text is the catalog string without its tags.
      expect(t.markup(key, { strong: (chunks) => chunks }), `${locale} privacy.${key}`).toBe(
        withoutTags(privacy[key])
      );
    }
  });
}

test('EN and ES bold the same number of phrases in every paragraph', () => {
  for (const key of PRIVACY_PARAGRAPHS) {
    expect(PRIVACY_BOLD.es[key as PrivacyParagraph].length, key).toBe(PRIVACY_BOLD.en[key].length);
  }
});

test('the page maps the tag to a semantic <strong> and keeps the closing line semibold', () => {
  expect(PAGE).toMatch(/const strong = \(chunks: ReactNode\) => <strong[ >]/);
  expect(PAGE).toMatch(/t\.rich\(p, \{ strong \}\)/);
  // Plain t() on a tagged message would not render the bold.
  expect(PAGE).not.toMatch(/\{t\(p\)\}/);
  expect(PAGE).toMatch(/p === 'p5' \? 'font-semibold'/);
});
