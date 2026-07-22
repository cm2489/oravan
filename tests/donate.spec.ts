import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { DONATE_URL } from '../lib/site';

/*
 * §6 donations leg (S4-S5). DONATE_URL (lib/site.ts) is LIT as of
 * 2026-07-18 — a live Stripe "Support Oravan" payment link, the rail
 * chosen after the HCB fiscal-sponsorship denial (2026-07-15) — so this
 * build's real, observable behavior is: the footer states the
 * founder-and-supporters line with a Support CTA and a Donate nav link,
 * and the About page renders its support ask. Every affordance is a
 * link-out to Stripe (target=_blank, noopener) — never an iframe or a
 * payment field on Oravan's own infra. That's what these e2e tests hold
 * the current build to.
 *
 * Only one state can be exercised per run (this suite's webServer builds
 * once), so the dark state is no longer e2e-covered; see
 * tests/donate.unit.spec.ts for the source-level guard that every gated
 * surface keys off the one DONATE_URL constant, which is what keeps
 * darkening it back down a one-line change.
 */

for (const [locale, prefix, messages] of [
  ['en', '', en],
  ['es', '/es', es],
] as const) {
  test.describe(`${locale} locale: donate surfaces are lit`, () => {
    test('footer states the supporters line, with Support CTA and Donate link-outs to Stripe, and always an About link', async ({
      page,
    }) => {
      await page.goto(`${prefix}/`);
      const footer = page.locator('footer');
      await expect(footer.getByText(messages.common.footer.fundingLive)).toBeVisible();
      await expect(footer.getByText(messages.common.footer.funding)).toHaveCount(0);
      const cta = footer.getByRole('link', { name: messages.common.footer.fundingCta });
      await expect(cta).toBeVisible();
      await expect(cta).toHaveAttribute('href', DONATE_URL!);
      await expect(cta).toHaveAttribute('target', '_blank');
      const donate = footer.getByRole('link', { name: messages.common.footer.donate });
      await expect(donate).toBeVisible();
      await expect(donate).toHaveAttribute('href', DONATE_URL!);
      await expect(footer.getByRole('link', { name: messages.common.footer.about })).toBeVisible();
    });

    test('About page is reachable, states funding independence, and shows the ask copy with a Stripe link-out', async ({
      page,
    }) => {
      await page.goto(`${prefix}/`);
      await page.locator('footer').getByRole('link', { name: messages.common.footer.about }).click();
      await expect(page).toHaveURL(new RegExp(`${prefix || ''}/about$`));
      await expect(page.getByRole('heading', { name: messages.about.title, level: 1 })).toBeVisible();
      await expect(page.getByText(messages.about.fundingBody)).toBeVisible();
      await expect(page.getByText(messages.about.fundingSupportBody)).toBeVisible();
      // Scoped to #main: the footer's Support CTA (same label, every page)
      // would otherwise strict-mode-collide with the About ask link.
      const ask = page.locator('#main').getByRole('link', { name: messages.about.fundingSupportCta });
      await expect(ask).toBeVisible();
      await expect(ask).toHaveAttribute('href', DONATE_URL!);
      await expect(ask).toHaveAttribute('rel', 'noopener noreferrer');
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
