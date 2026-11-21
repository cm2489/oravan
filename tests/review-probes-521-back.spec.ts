import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';

/*
 * REVIEWER PROBE (v) FOR PR #521 (throwaway, never merged): Back right after
 * Reload. Run with --repeat-each and --retries=0. Each run logs one line
 * "PROBE-V <variant> ..." with how long Back took to show the earlier page,
 * whether the document changed, and every main-frame navigation seen.
 */
test.skip(!process.env.REVIEW_PROBES, 'reviewer probes run only in the probe workflow');

const ZIP = '78501';

async function seed(page: Page) {
  await page.addInitScript((prefs: string) => {
    if (window.name.includes('probe-seeded')) return;
    window.name += ' probe-seeded';
    localStorage.setItem('oravan.prefs', prefs);
  }, JSON.stringify({ zip: ZIP }));
}

function nav(page: Page, key: 'reps' | 'bills' | 'moments') {
  return page
    .getByRole('navigation', { name: en.common.nav.primaryLabel })
    .getByRole('link', { name: new RegExp(`^(${en.common.nav[key]}|${en.common.navShort[key]})$`) });
}

const billsHeading = (page: Page) => page.getByRole('heading', { level: 1, name: en.bills.title });

/** Records when a popstate listener is added to window, and when popstate fires. */
const WATCH = () => {
  const w = window as unknown as { __probe: { adds: number[]; pops: number[] } };
  w.__probe = { adds: [], pops: [] };
  window.addEventListener('popstate', () => w.__probe.pops.push(Math.round(performance.now())), true);
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
    if (this === window && type === 'popstate') w.__probe.adds.push(Math.round(performance.now()));
    return (add as unknown as (...a: unknown[]) => void).call(this, type, ...rest);
  } as typeof EventTarget.prototype.addEventListener;
};
const hydrated = (page: Page) =>
  page.waitForFunction(() => {
    const f = document.querySelector('nav a[href$="/bills"]');
    return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps$'));
  });

for (const variant of ['erase', 'erase-hydrated', 'nozip', 'control'] as const) {
  test(`(v2) Back right after Reload: ${variant}`, async ({ page }) => {
    await page.addInitScript(WATCH);
    const events: string[] = [];
    let t0 = 0;
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) events.push(`nav+${t0 ? Date.now() - t0 : 0} ${new URL(f.url()).pathname}`);
    });
    page.on('load', () => events.push(`load+${t0 ? Date.now() - t0 : 0}`));
    page.on('console', (m) => {
      if (m.type() === 'error') events.push(`console.error ${m.text().slice(0, 120)}`);
    });
    page.on('pageerror', (e) => events.push(`pageerror ${String(e).slice(0, 120)}`));

    if (variant === 'control') {
      await page.goto('/today');
      await nav(page, 'bills').click();
      await expect(billsHeading(page)).toBeVisible();
      await nav(page, 'moments').click();
      await expect(page).toHaveURL(/\/questions$/);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    } else {
      if (variant !== 'nozip') await seed(page);
      await page.goto('/reps');
      if (variant === 'nozip') await expect(page.getByText(en.reps.noZip)).toBeVisible();
      else await expect(page.locator('[data-zip-line]')).toContainText(ZIP);
      await nav(page, 'bills').click();
      await expect(billsHeading(page)).toBeVisible();
      await nav(page, 'reps').click();
      if (variant === 'nozip') await expect(page.getByText(en.reps.noZip)).toBeVisible();
      else await expect(page.locator('[data-zip-line]')).toContainText(ZIP);
      if (variant.startsWith('erase')) {
        const erase = page.locator('[data-record-erase]');
        await erase.getByRole('button', { name: en.impact.erase }).click();
        await erase.getByRole('button', { name: en.impact.confirmErase }).click();
        await expect(erase.getByRole('status')).toHaveText(en.impact.erased);
      }
      await page.reload();
      await expect(page.getByText(en.reps.noZip)).toBeVisible();
      if (variant === 'erase-hydrated') await hydrated(page);
      await expect(page.getByRole('textbox', { name: en.home.zipLabel }).or(page.locator('[data-zip-line]')).first()).toBeVisible();
    }

    const tPre = await page.evaluate(() => {
      (window as unknown as { __probeDoc: number }).__probeDoc = 1;
      return Math.round(performance.now());
    });
    t0 = Date.now();
    await page.goBack({ waitUntil: 'commit' }).catch((e) => events.push(`goBack threw ${String(e).slice(0, 80)}`));
    const ok = await billsHeading(page)
      .waitFor({ timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    const ms = Date.now() - t0;
    const sameDoc = await page
      .evaluate(() => (window as unknown as { __probeDoc?: number }).__probeDoc === 1)
      .catch(() => 'evaluate failed');
    const url = new URL(page.url()).pathname;
    const watch = await page.evaluate(() => (window as unknown as { __probe?: unknown }).__probe ?? null).catch(() => null);
    const tBack = await page.evaluate(() => Math.round(performance.now())).catch(() => null);
    const h1 = await page
      .getByRole('heading', { level: 1 })
      .first()
      .textContent({ timeout: 1000 })
      .catch(() => null);
    let recovered: string | null = null;
    if (!ok) {
      await nav(page, 'bills').click().catch(() => null);
      recovered = (await billsHeading(page).waitFor({ timeout: 10_000 }).then(() => 'header link works', () => 'header link does not help'));
    }
    console.log(
      `PROBE-V ${variant} [${test.info().project.name}] rep=${test.info().repeatEachIndex} ok=${ok} ms=${ms} url=${url} sameDoc=${sameDoc} h1=${JSON.stringify(h1)} watch=${JSON.stringify(watch)} backAt=${tPre} nowAfter=${tBack} recovered=${recovered} events=${JSON.stringify(events)}`
    );
    expect(ok, `Back did not show the bills page in 20s (url ${url}, h1 ${h1})`).toBe(true);
  });
}
