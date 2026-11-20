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

for (const variant of ['erase', 'saved', 'nozip', 'control'] as const) {
  test(`(v) Back right after Reload: ${variant}`, async ({ page }) => {
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
      if (variant === 'erase') {
        const erase = page.locator('[data-record-erase]');
        await erase.getByRole('button', { name: en.impact.erase }).click();
        await erase.getByRole('button', { name: en.impact.confirmErase }).click();
        await expect(erase.getByRole('status')).toHaveText(en.impact.erased);
      }
      await page.reload();
      if (variant === 'saved') await expect(page.locator('[data-zip-line]')).toContainText(ZIP);
      else await expect(page.getByText(en.reps.noZip)).toBeVisible();
      await expect(page.getByRole('textbox', { name: en.home.zipLabel }).or(page.locator('[data-zip-line]')).first()).toBeVisible();
    }

    await page.evaluate(() => ((window as unknown as { __probeDoc: number }).__probeDoc = 1));
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
    const h1 = await page
      .getByRole('heading', { level: 1 })
      .first()
      .textContent({ timeout: 1000 })
      .catch(() => null);
    console.log(
      `PROBE-V ${variant} [${test.info().project.name}] rep=${test.info().repeatEachIndex} ok=${ok} ms=${ms} url=${url} sameDoc=${sameDoc} h1=${JSON.stringify(h1)} events=${JSON.stringify(events)}`
    );
    expect(ok, `Back did not show the bills page in 20s (url ${url}, h1 ${h1})`).toBe(true);
  });
}
