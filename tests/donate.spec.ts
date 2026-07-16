import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * §6 donations leg (S4-S5). DONATE_URL (lib/site.ts) is null today — the HCB
 * fiscal-sponsorship application was denied 2026-07-15 (teen-builds-only
 * policy) and no replacement rail is chosen — so this build's real,
 * observable behavior is "dark": no Donate affordance exists anywhere, the
 * footer states the founder-funded line, and the About page's support ask
 * paragraph does not render. That's what these e2e tests hold the current
 * build to.
 *
 * The "lit" state (DONATE_URL set) can't be exercised in this same run
 * without a second `next build` under a different constant value - this
 * suite's webServer builds once. See tests/donate.unit.spec.ts for a
 * source-level guard that the wiring itself (every gated surface keying off
 * the one DONATE_URL constant) is intact, so flipping it is guaranteed to
 * be a one-line change and nothing more.
 */

for (const [locale, prefix, messages] of [
  ['en', '', en],
  ['es', '/es', es],
] as const) {
  test.describe(`${locale} locale: donate surfaces are dark`, () => {
    test('footer states the founder-funded line, with no Donate or Support link, but always an About link', async ({
      page,
    }) => {
      await page.goto(`${prefix}/`);
      const footer = page.locator('footer');
      await expect(footer.getByText(messages.common.footer.funding)).toBeVisible();
      await expect(footer.getByText(messages.common.footer.fundingLive)).toHaveCount(0);
      await expect(
        footer.getByRole('link', { name: messages.common.footer.fundingCta })
      ).toHaveCount(0);
      await expect(footer.getByRole('link', { name: messages.common.footer.donate })).toHaveCount(0);
      await expect(footer.getByRole('link', { name: messages.common.footer.about })).toBeVisible();
    });

    test('About page is reachable, states funding independence, but shows no ask copy or link-out', async ({
      page,
    }) => {
      await page.goto(`${prefix}/`);
      await page.locator('footer').getByRole('link', { name: messages.common.footer.about }).click();
      await expect(page).toHaveURL(new RegExp(`${prefix || ''}/about$`));
      await expect(page.getByRole('heading', { name: messages.about.title, level: 1 })).toBeVisible();
      await expect(page.getByText(messages.about.fundingBody)).toBeVisible();
      await expect(page.getByText(messages.about.fundingSupportBody)).toHaveCount(0);
      await expect(page.getByRole('link', { name: messages.about.fundingSupportCta })).toHaveCount(0);
    });

    test('the About page content itself has no form fields or iframes (link-out only, per §6)', async ({
      page,
    }) => {
      await page.goto(`${prefix}/about`);
      // Scoped to the article, not the whole document: the footer's beta
      // feedback dialog has its own (unrelated) honeypot text input.
      expect(await page.locator('article input, article iframe, article form').count()).toBe(0);
    });
  });
}
