import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { DONATE_URL } from '../lib/site';

/*
 * §6 donations leg (S4-S5), rule 9 of the constitution: donations are
 * link-outs only — never a form, iframe or input on an Oravan page, and one
 * Stripe URL constant. DONATE_URL (lib/site.ts) is LIT as of 2026-07-18 — a
 * live Stripe "Support Oravan" payment link, the rail chosen after the HCB
 * fiscal-sponsorship denial (2026-07-15). Every affordance is a link-out to
 * Stripe (target=_blank, noopener) — never an iframe or a payment field on
 * Oravan's own infra. That's what these e2e tests hold the current build to.
 *
 * WHERE the ask appears (a homepage band, the footer, About) is layout and is
 * not pinned here, except for the dated footer line below; WHAT every ask is
 * — a link-out to the one constant — is checked on every page that carries
 * one.
 *
 * Only one state can be exercised per run (this suite's webServer builds
 * once), so the dark state is no longer e2e-covered; see
 * tests/donate.unit.spec.ts for the source-level guards.
 */

const hasToken = (token: string) => new RegExp(`(^|\\s)${token}(\\s|$)`);

for (const [locale, prefix, messages] of [
  ['en', '', en],
  ['es', '/es', es],
] as const) {
  test.describe(`${locale} locale: donate surfaces are lit`, () => {
    // Dated (2026-07 critique round 2): one money ask at the page exit. The
    // former nav "Donate" link was consolidated into the Support CTA, so the
    // footer carries exactly one link to the Stripe rail, never two.
    test('footer states the supporters line with ONE Support CTA link-out to Stripe, and always an About link', async ({
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
      await expect(footer.locator(`a[href="${DONATE_URL}"]`)).toHaveCount(1);
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

    for (const path of ['/', '/about']) {
      test(`every donate link on ${prefix}${path} is a link-out to the one Stripe URL, and nothing on the page embeds a payment`, async ({
        page,
      }) => {
        await page.goto(`${prefix}${path}`);
        const asks = page.locator(`a[href="${DONATE_URL}"]`);
        expect(await asks.count(), 'the lit build carries at least one ask here').toBeGreaterThan(0);
        for (const ask of await asks.all()) {
          await expect(ask).toHaveAttribute('target', '_blank');
          await expect(ask).toHaveAttribute('rel', hasToken('noopener'));
          await expect(ask).toHaveAttribute('rel', hasToken('noreferrer'));
        }
        // Never a payment surface on Oravan's own pages: no frame or form
        // that points at the payment host.
        await expect(page.locator('iframe[src*="stripe"], form[action*="stripe"]')).toHaveCount(0);
      });
    }

    test('the About page content itself has no form fields or iframes (link-out only, per §6)', async ({
      page,
    }) => {
      await page.goto(`${prefix}/about`);
      // Scoped to the article, not the whole document: the footer is not
      // part of the About page's own content.
      expect(await page.locator('article input, article iframe, article form').count()).toBe(0);
    });
  });
}
