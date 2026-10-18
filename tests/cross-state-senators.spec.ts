import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billWithRollCallsOnlyIn, referenceBill } from './corpus-fixtures';
import { mockScriptApi, seedZip } from './helpers';

/*
 * SENATORS ACROSS A STATE LINE, AS RENDERED (2026-09-29). The wording is
 * pinned by key in tests/cross-state-senators.unit.spec.ts; this spec pins
 * that each split-ZIP surface prints that line over the members it lists.
 *
 *   19973  crosses a state line: Delaware at-large and Maryland's 1st. Every
 *          surface lists both states' senators, which is why no line may say
 *          the senators are the same whichever district is yours.
 *   10001  split inside one state: NY-10 and NY-12, New York's two senators.
 *
 * Every name and count is read from data/*.json at test time and every label
 * from messages/*.json by key, so a roster change or a rewording does not
 * redden this file; only a broken promise does.
 */

type Legislator = { bioguide: string; name: string; type: 'sen' | 'rep'; state: string };
const read = (f: string) => JSON.parse(readFileSync(join(process.cwd(), f), 'utf8'));
const ZIPS = read('data/zip-districts.json') as Record<string, { state: string; district: number }[]>;
const LEGISLATORS = read('data/legislators.json') as Legislator[];

const CROSS_STATE = '19973';
const IN_STATE = '10001';
const MESSAGES = { en, es } as const;
const prefix = (locale: 'en' | 'es') => (locale === 'en' ? '' : '/es');

/** The senators of every state the ZIP's districts sit in. */
function senatorsFor(zip: string): Legislator[] {
  const states = new Set(ZIPS[zip].map((d) => d.state));
  return LEGISLATORS.filter((l) => l.type === 'sen' && states.has(l.state));
}

const CASES = [
  { zip: CROSS_STATE, states: 2 },
  { zip: IN_STATE, states: 1 },
] as const;

const BILL = `/bills/${referenceBill().slug}`;
const SENATE_BILL = billWithRollCallsOnlyIn('senate');

for (const locale of ['en', 'es'] as const) {
  const m = MESSAGES[locale];

  for (const { zip, states } of CASES) {
    test(`${locale}: /reps?zip=${zip} prints the state-scoped senators line over every state's senators`, async ({
      page,
    }) => {
      expect(new Set(ZIPS[zip].map((d) => d.state)).size).toBe(states);
      const t = createTranslator({ locale, messages: m, namespace: 'reps' });
      await page.goto(`${prefix(locale)}/reps?zip=${zip}`);
      await expect(page.locator('[data-multi-district]')).toHaveText(
        t('multiDistrict', { count: ZIPS[zip].length })
      );
      const senators = senatorsFor(zip);
      expect(senators).toHaveLength(2 * states);
      for (const s of senators) {
        await expect(page.getByText(s.name, { exact: true }).first()).toBeVisible();
      }
    });

    test(`${locale}: bill call panel, ZIP ${zip}: the state-scoped senators line over every state's senators`, async ({
      page,
    }) => {
      await mockScriptApi(page);
      await page.goto(prefix(locale) + BILL);
      await seedZip(page, zip);
      await page.reload();
      await page.getByRole('radio', { name: m.bill.stance.support }).click();
      await expect(page.getByRole('textbox', { name: m.bill.scriptTitle })).toBeVisible();

      await expect(page.getByText(m.bill.callWhoMulti)).toBeVisible();
      const rows = page.locator('[data-rep-name]');
      for (const s of senatorsFor(zip)) {
        await expect(rows.filter({ hasText: s.name })).toHaveCount(1);
      }
    });

    test(`${locale}: vote record members strip, ZIP ${zip}: senators only, and the state-scoped line`, async ({
      page,
    }) => {
      test.skip(!SENATE_BILL, 'no open bill with Senate-only roll calls in data/votes.json today');
      await page.goto(`${prefix(locale)}/bills/${SENATE_BILL}`);
      await seedZip(page, zip);
      await page.reload();
      const strip = page.locator('[data-vote-delegation]');
      await expect(strip).toBeVisible();
      const senators = senatorsFor(zip);
      await expect(strip.locator('[data-vote-delegate]')).toHaveCount(senators.length);
      for (const s of senators) {
        await expect(strip.locator(`[data-vote-delegate="${s.bioguide}"]`)).toBeVisible();
      }
      await expect(strip).toContainText(m.votes.delegation.multiDistrict);
    });
  }

  test(`${locale}: embed rep lookup, ZIP ${CROSS_STATE}: the state-scoped line over both states' senators`, async ({
    page,
  }) => {
    await page.goto(`/embed/rep-lookup?locale=${locale}`);
    await page.getByLabel(m.home.zipLabel).fill(CROSS_STATE);
    await page.getByRole('button', { name: m.home.zipCta }).click();
    await expect(page.getByText(m.embed.multiDistrictBody)).toBeVisible();
    for (const s of senatorsFor(CROSS_STATE)) {
      await expect(page.getByText(s.name, { exact: true })).toBeVisible();
    }
  });
}
