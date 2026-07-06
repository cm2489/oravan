import { expect, test, type Page } from '@playwright/test';
import coverageData from '../data/coverage.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { mockScriptApi, seedZip } from './helpers';

/*
 * The "surface the call" behavior: a floating Make-the-call button keeps the
 * primary action reachable on a long bill page, but stands down whenever another
 * call CTA (the inline prompt or the action panel) is on screen — never two at
 * once. Data-driven: any real bill page carries the surfaces; use a covered bill
 * (guaranteed valid + long enough that the inline prompt sits below the fold).
 */
const slug = Object.keys(coverageData).find((k) => !k.startsWith('_'));

test('the floating call button surfaces the action and yields to on-screen CTAs', async ({ page }) => {
  test.skip(!slug, 'no bills in current data');
  await page.goto(`/bills/${slug}`);

  const fab = page.locator('[data-floating-call]');
  await expect(fab).toHaveAttribute('href', '#act');
  // At the top of a long page no other CTA is on screen — the button is shown.
  await expect(fab).toHaveCSS('opacity', '1');

  // Bring the inline prompt into view — the floating button fades out (inert).
  await page.locator('[data-call-cta]').first().scrollIntoViewIfNeeded();
  await expect(fab).toHaveCSS('opacity', '0');
  await expect(fab).toHaveAttribute('aria-hidden', 'true');

  // Scroll back to a reading gap — it returns.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(fab).toHaveCSS('opacity', '1');
});

/*
 * S7 — the call-moment slice. The moment of actually dialing gets: a pre-dial
 * reassurance beat that never gates the tel: links, an honest client-clock
 * office-hours line (Eastern only — see lib/office-hours.ts), and a polished
 * clipboard copy with a screen-reader announcement. Zero Anthropic calls:
 * /api/script is mocked throughout.
 */
const BILL = '/bills/sjres-99-119'; // same stable slug flow.spec.ts / es-parity.spec.ts drive
const STANCES = ['support', 'oppose', 'undecided'] as const;

// Fixed clocks, pinned against their Eastern-time weekday/hour (see
// tests/office-hours.unit.spec.ts for the same constants and derivation).
const WEEKDAY_MORNING = new Date('2026-07-08T14:00:00Z').getTime(); // Wed 10:00 ET -> open
const WEEKEND_MIDDAY = new Date('2026-07-12T15:00:00Z').getTime(); // Sun 11:00 ET -> closed

async function openCallMode(page: Page, locale: 'en' | 'es', stance: (typeof STANCES)[number]) {
  const messages = locale === 'en' ? en : es;
  await page.getByRole('button', { name: messages.bill.stance[stance] }).click();
  await expect(page.getByRole('textbox', { name: messages.bill.scriptTitle })).toBeVisible();
  await page.getByRole('button', { name: messages.bill.startCall }).click();
  return page.getByRole('dialog', { name: messages.bill.callTitle });
}

test.describe('S7 pre-dial beat: renders for a fresh caller across all three stance lanes', () => {
  for (const locale of ['en', 'es'] as const) {
    test(`${locale}: every stance opens call mode with the first-call beat, office hours, and tel: links`, async ({
      page,
    }) => {
      const messages = locale === 'en' ? en : es;
      await mockScriptApi(page);
      await page.goto(locale === 'es' ? '/es' + BILL : BILL);
      await seedZip(page, '78501');
      await page.reload();
      // Set the clock after the reload so it's guaranteed live for the
      // interactions below, regardless of whether it survives a navigation.
      await page.clock.setFixedTime(WEEKDAY_MORNING);

      for (const stance of STANCES) {
        const dialog = await openCallMode(page, locale, stance);
        await expect(dialog).toBeVisible();
        // Fresh profile (no calls logged yet): the first-call flavor of the
        // pre-dial beat shows, never the repeat-caller one, for every stance.
        await expect(dialog.getByText(messages.bill.firstCallTitle)).toBeVisible();
        // The honest, time-aware office-hours line sits beside it.
        await expect(dialog.getByText(messages.bill.officeHoursTitle)).toBeVisible();
        await expect(dialog.getByText(messages.bill.officeHoursOpenBody)).toBeVisible();
        // The pre-dial beat never gates the dial affordance underneath it.
        await expect(dialog.locator('a[href^="tel:"]').first()).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      }
    });
  }
});

test('S7 pre-dial beat: a repeat caller sees the general beat, not the first-call one', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, '78501');
  await page.reload();
  await page.clock.setFixedTime(WEEKDAY_MORNING);

  // Log one outcome so callCount becomes 1.
  await page.getByRole('button', { name: en.bill.stance.support }).click();
  await page.getByRole('button', { name: en.bill.startCall }).click();
  let dialog = page.getByRole('dialog', { name: en.bill.callTitle });
  await expect(dialog.getByText(en.bill.firstCallTitle)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: en.bill.outcome.voicemail }).first().click();

  // A different stance, opened after that first logged call, gets the
  // general "before you dial" beat instead of the first-call framing.
  await page.getByRole('button', { name: en.bill.stance.oppose }).click();
  await page.getByRole('button', { name: en.bill.startCall }).click();
  dialog = page.getByRole('dialog', { name: en.bill.callTitle });
  await expect(dialog.getByText(en.bill.preDialTitle)).toBeVisible();
  await expect(dialog.getByText(en.bill.preDialBody)).toBeVisible();
  await expect(dialog.getByText(en.bill.firstCallTitle)).toHaveCount(0);
});

test.describe('S7 office-hours note: honest, time-aware, Eastern-only', () => {
  test('inside typical business hours: the "likely to answer live" framing shows', async ({ page }) => {
    await mockScriptApi(page);
    await page.goto(BILL);
    await seedZip(page, '78501');
    await page.reload();
    await page.clock.setFixedTime(WEEKDAY_MORNING);
    await page.getByRole('button', { name: en.bill.stance.support }).click();
    await expect(page.getByText(en.bill.officeHoursOpenBody)).toBeVisible();
    await expect(page.getByText(en.bill.officeHoursClosedBody)).toHaveCount(0);
  });

  test('outside business hours (weekend): the voicemail-as-the-plus framing shows, never an apology', async ({
    page,
  }) => {
    await mockScriptApi(page);
    await page.goto(BILL);
    await seedZip(page, '78501');
    await page.reload();
    await page.clock.setFixedTime(WEEKEND_MIDDAY);
    await page.getByRole('button', { name: en.bill.stance.support }).click();
    await expect(page.getByText(en.bill.officeHoursClosedBody)).toBeVisible();
    await expect(page.getByText(en.bill.officeHoursOpenBody)).toHaveCount(0);
    // Never "sorry" / "unfortunately" language — voicemail is a plus, not a caveat.
    await expect(page.getByText(/sorry|unfortunately/i)).toHaveCount(0);
  });

  test('Spanish locale renders the same honest note, localized', async ({ page }) => {
    await mockScriptApi(page);
    await page.goto('/es' + BILL);
    await seedZip(page, '78501');
    await page.reload();
    await page.clock.setFixedTime(WEEKEND_MIDDAY);
    await page.getByRole('button', { name: es.bill.stance.support }).click();
    await expect(page.getByText(es.bill.officeHoursTitle)).toBeVisible();
    await expect(page.getByText(es.bill.officeHoursClosedBody)).toBeVisible();
  });
});

test.describe('S7 clipboard copy: one tap, visible confirmation, aria-live announcement', () => {
  async function stubClipboard(page: Page) {
    await page.addInitScript(() => {
      const w = window as unknown as { __copied: string | null };
      w.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (t: string) => {
            w.__copied = t;
            return Promise.resolve();
          },
        },
      });
    });
  }

  test('copying the script from the panel shows confirmation and announces it', async ({ page }) => {
    await mockScriptApi(page);
    await stubClipboard(page);
    await page.goto(BILL);
    await seedZip(page, '78501');
    await page.reload();
    await page.getByRole('button', { name: en.bill.stance.support }).click();

    await page.getByRole('button', { name: en.bill.copyScript, exact: true }).click();
    await expect(page.getByRole('button', { name: en.bill.scriptCopied })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: en.bill.scriptCopied })).toHaveCount(1);

    const copied = await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied);
    expect(copied).toContain('MOCKED SCRIPT BODY');
  });

  test('the copy button inside call mode uses the same confirmation idiom', async ({ page }) => {
    await mockScriptApi(page);
    await stubClipboard(page);
    await page.goto(BILL);
    await seedZip(page, '78501');
    await page.reload();
    await page.getByRole('button', { name: en.bill.stance.support }).click();
    await page.getByRole('button', { name: en.bill.startCall }).click();

    const dialog = page.getByRole('dialog', { name: en.bill.callTitle });
    await dialog.getByRole('button', { name: en.bill.copyScript, exact: true }).click();
    await expect(dialog.getByRole('button', { name: en.bill.scriptCopied })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: en.bill.scriptCopied })).toHaveCount(1);

    const copied = await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied);
    expect(copied).toContain('MOCKED SCRIPT BODY');
  });

  test('spanish confirmation and announcement are localized', async ({ page }) => {
    await mockScriptApi(page);
    await stubClipboard(page);
    await page.goto('/es' + BILL);
    await seedZip(page, '78501');
    await page.reload();
    await page.getByRole('button', { name: es.bill.stance.support }).click();
    await page.getByRole('button', { name: es.bill.copyScript, exact: true }).click();
    await expect(page.getByRole('button', { name: es.bill.scriptCopied })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: es.bill.scriptCopied })).toHaveCount(1);
  });
});

test('S7: call mode survives a visibilitychange/blur-return with its content intact', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, '78501');
  await page.reload();
  await page.getByRole('button', { name: en.bill.stance.support }).click();
  await page.getByRole('button', { name: en.bill.startCall }).click();

  const dialog = page.getByRole('dialog', { name: en.bill.callTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/MOCKED SCRIPT BODY/)).toBeVisible();

  // Simulate the app-switch to the Phone app and back: the tab is hidden,
  // then visible again, with no navigation and no explicit re-render trigger.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });

  // Nothing reset: same dialog, same script, dial links still present.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/MOCKED SCRIPT BODY/)).toBeVisible();
  await expect(dialog.locator('a[href^="tel:"]').first()).toBeVisible();
});
