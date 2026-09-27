import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { DONATE_URL } from '../lib/site';

/*
 * §6 donate guard, rule 9 of the constitution: donations are link-outs only —
 * never a form, iframe or input on an Oravan page; never a partisan payment
 * rail; never a false nonprofit claim; one Stripe URL constant.
 *
 * What is pinned here is those promises, not how a component spells its JSX:
 * the rendered behaviour (every ask is a target=_blank, noopener link-out to
 * DONATE_URL) is checked live by tests/donate.spec.ts, and "the only Stripe
 * URLs in shipped code are the constants in lib/site.ts" by
 * tests/plans-claim.unit.spec.ts.
 *
 * History: the HCB fiscal-sponsorship application was denied 2026-07-15
 * (teen-builds-only policy), so the former DonateSupport section and its
 * fiscal-sponsor/tax-deductibility claims were retired - the last test
 * below pins that no such claim ever returns to user-facing copy while
 * the project has no sponsor behind it.
 */

/** The files that render a donate ask today. */
const DONATE_SURFACES = [
  'lib/site.ts',
  'components/Footer.tsx',
  'app/[locale]/about/page.tsx',
  'app/[locale]/page.tsx',
];

test.describe('DONATE_URL wiring (§6)', () => {
  test('is lit: the exact live Stripe payment link, https, link-out only', () => {
    // Pinned to the exact URL (not just "some string") so a typo'd or
    // test-mode link can't ship: this is the live "Support Oravan"
    // custom-amount payment link minted 2026-07-18.
    expect(DONATE_URL).toBe('https://buy.stripe.com/00w8wIcX74px0CH8EJ8k804');
  });

  test('the About page never embeds a payment: no iframe, input or form in its source', () => {
    const page = readFileSync('app/[locale]/about/page.tsx', 'utf8');
    expect(page).not.toMatch(/<iframe/i);
    expect(page).not.toMatch(/<input/i);
    expect(page).not.toMatch(/<form/i);
  });

  test('no partisan-rail processor is named anywhere near the donate surfaces (§6 hard exclusion)', () => {
    const forbidden = /actblue|winred|anedot/i;
    for (const file of DONATE_SURFACES) {
      expect(readFileSync(file, 'utf8')).not.toMatch(forbidden);
    }
    for (const messages of ['messages/en.json', 'messages/es.json']) {
      expect(readFileSync(messages, 'utf8')).not.toMatch(forbidden);
    }
  });

  test('no fiscal-sponsor / 501(c)(3) / nonprofit-rail claim survives in user-facing messages (HCB denied 2026-07-15)', () => {
    // Affirmative-claim markers only: the truthful "not tax-deductible"
    // disclosure in about.fundingSupportBody is required copy, so a blanket
    // "tax-deductible" match would false-positive on the negation.
    const forbidden = /fiscal sponsor|patrocinador fiscal|501\s*\(\s*c\s*\)|hack\s*foundation|hack\s*club|hackclub/i;
    for (const messages of ['messages/en.json', 'messages/es.json']) {
      expect(readFileSync(messages, 'utf8')).not.toMatch(forbidden);
    }
  });
});
