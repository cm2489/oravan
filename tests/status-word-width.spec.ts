import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * THE LONGEST STATUS WORD NEVER WIDENS THE PAGE (re-check of #523, round 5).
 *
 * "Back in the House to settle the changes" / "De vuelta en la Cámara para
 * resolver los cambios" (bills.status.passed_back_*) are the longest status
 * words the site prints. components/BillCard.tsx kept its status chunk on one
 * line from 360px up, so H.R. 5349's card pushed /bills and its sponsor's
 * member page up to 121px past the screen at every width from 360 to 430px.
 *
 * WHY THE 320 TESTS DID NOT CATCH IT, on record: the webkit-320 project runs
 * at 320px only, and below 22.5rem (360px) that chunk was already allowed to
 * wrap, so at 320 it wrapped and nothing overflowed. The fault lived only
 * between 360 and 430px, which no reflow test measured.
 *
 * WHAT THIS TEST DOES. It sets its own viewport (360, 390 and 430), loads a
 * real list of cards, writes each longest word into a real card's status
 * chunk (the Senate form has no bill in the data today, so it is forced the
 * same way), and asserts the document is no wider than the viewport and the
 * word's box stays inside it. It runs in the webkit-mobile and webkit-desktop
 * projects (it is not tagged @reflow: the reflow project is pinned to 320,
 * which is exactly the width that missed this).
 */

const WORDS = {
  es: [es.bills.status.passed_back_house, es.bills.status.passed_back_senate],
  en: [en.bills.status.passed_back_house, en.bills.status.passed_back_senate],
};

/** Every status label of a language, the text a card's status chunk holds. */
const LABELS = { es: Object.values(es.bills.status), en: Object.values(en.bills.status) } as const;

async function forceStatus(page: Page, labels: readonly string[], word: string): Promise<number> {
  return page.evaluate(
    ({ labels, word }) => {
      // The card's status chunk: the span whose first text node is a status label.
      let n = 0;
      for (const span of Array.from(document.querySelectorAll('span'))) {
        const first = span.firstChild;
        if (first?.nodeType !== Node.TEXT_NODE) continue;
        if (!labels.includes((first.textContent ?? '').trim())) continue;
        first.textContent = word;
        span.setAttribute('data-forced-status', '');
        n++;
      }
      return n;
    },
    { labels: [...labels], word }
  );
}

async function overflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    let worst = 0;
    // Only the forced chunks: a filter row that scrolls sideways on purpose
    // holds spans past the screen and is not this test's business.
    for (const el of Array.from(document.querySelectorAll('[data-forced-status]'))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) worst = Math.max(worst, r.right - vw);
    }
    return { page: doc.scrollWidth - vw, element: Math.ceil(worst) };
  });
}

for (const lang of ['es', 'en'] as const) {
  for (const width of [360, 390, 430]) {
    test(`/bills: the longest ${lang} status word stays inside a ${width}px screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(lang === 'es' ? '/es/bills' : '/bills');
      for (const word of WORDS[lang]) {
        const n = await forceStatus(page, LABELS[lang], word);
        expect(n, 'cards with a status chunk on the page').toBeGreaterThan(0);
        const o = await overflow(page);
        expect(o.page, `${word}: the page scrolls sideways by ${o.page}px`).toBeLessThanOrEqual(0);
        expect(o.element, `${word}: a status chunk ends ${o.element}px past the screen`).toBeLessThanOrEqual(0);
      }
    });
  }
}
