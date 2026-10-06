import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from '@playwright/test';
import { HeadlineOrTitle } from '../components/HeadlineOrTitle';

/*
 * AN ENGLISH FALLBACK TITLE ON A SPANISH PAGE IS MARKED lang="en" (rule 7).
 *
 * The record's bill title is English on /es too. When a bill card has no
 * decoded headline it prints that title, and without `lang="en"` a screen
 * reader reads English words with Spanish pronunciation. The bill-card family
 * goes through components/HeadlineOrTitle.tsx so a card cannot forget the mark.
 *
 * Two things are held. The component marks the title and only the title (a
 * decoded headline, which is in the page's language, is never marked). And
 * each card in the family still goes through the component: the cards import
 * next-intl's navigation, which does not load under Node, so they cannot be
 * rendered here, and the source is read instead.
 */

const render = (headline: string | null, title: string) =>
  renderToStaticMarkup(createElement(HeadlineOrTitle, { headline, title }));

test('the fallback title is marked lang="en"', () => {
  expect(render(null, 'To provide for reconciliation')).toBe(
    '<span lang="en">To provide for reconciliation</span>'
  );
});

test('a decoded headline is printed as is, never marked', () => {
  expect(render('Un proyecto de ley sobre vivienda', 'To provide for housing')).toBe(
    'Un proyecto de ley sobre vivienda'
  );
});

test('a title is escaped, not interpreted', () => {
  expect(render(null, 'A <b>bill</b> & more')).toBe('<span lang="en">A &lt;b&gt;bill&lt;/b&gt; &amp; more</span>');
});

const FAMILY = [
  'components/BillCard.tsx',
  'components/MomentVehicleCard.tsx',
  'components/NewsLens.tsx',
  'components/embed/BillCardWidget.tsx',
];

for (const file of FAMILY) {
  test(`${file} prints its fallback title through HeadlineOrTitle`, () => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    expect(src, 'imports the component').toContain('HeadlineOrTitle');
    // The unmarked shape: `headline ?? title` in any of the names the family uses.
    expect(src, 'no bare headline-or-title fallback').not.toMatch(
      /\bheadline\s*\?\?\s*(?:[\w.]*\.)?(?:title|officialTitle)\b/
    );
  });
}

test('the nomination card marks the government sentence it prints', () => {
  const src = readFileSync(join(__dirname, '..', 'components/MomentNominationCard.tsx'), 'utf8');
  expect(src).toMatch(/description \? <span lang="en">\{description\}<\/span>/);
  expect(src).not.toMatch(/\{description \?\? /);
});
