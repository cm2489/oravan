import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * The plans claim, pinned (plan item B8, 2026-09-24).
 *
 * /partners used to say "pricing isn't published yet" while /embeds named
 * four plans and offered a "Manage your subscription" portal — two pages
 * describing the same product differently. What the code proves today:
 *
 *   - the embeds Terms name four plans (Free, Pro, Nonprofit, Network);
 *   - the only Stripe links anywhere in the app are the donation Payment
 *     Link (DONATE_URL) and the billing-portal LOGIN (BILLING_PORTAL_URL) —
 *     there is no checkout link for any embeds plan, so no paid plan can be
 *     bought from this site;
 *   - the webhook that would provision a paid tenant is 503-dark without
 *     STRIPE_WEBHOOK_SECRET (CLAUDE.md; tests/stripe-webhook.unit.spec.ts).
 *
 * So both pages now say the same true thing: four plans are named, only
 * Free is open, checkout isn't open and prices aren't published. This spec
 * fails the moment a checkout link appears in app code — at which point the
 * sentence below is false, and partners.licensingBody + embeds.docsPlansBody
 * (+ embeds.docsActionPanelBody's "no token can be issued today") must be
 * rewritten in both languages in that same PR.
 */

const PLAN_NAMES = {
  en: ['Free', 'Pro', 'Nonprofit', 'Network'],
  es: ['Gratuito', 'Pro', 'Sin fines de lucro', 'Red'],
} as const;

const NOT_OPEN = {
  en: /only Free is open today[\s\S]*checkout for the paid plans isn’t open yet, and their prices aren’t published/i,
  es: /hoy solo está disponible el Gratuito[\s\S]*todavía no se pueden contratar los planes de pago y sus precios no están publicados/i,
} as const;

test('no embeds-plan checkout link exists anywhere in app code', () => {
  // Every Stripe-hosted URL in shipped code. `git grep` scans tracked files
  // only, so a local scratch file can't make this pass or fail.
  const hits = execSync(
    "git grep -n -E '(buy|checkout|billing)\\.stripe\\.com' -- app components lib public proxy.ts",
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  const sources = hits.map((line) => line.split(':')[0]);
  // Exactly two: the donation Payment Link and the billing-portal login,
  // both in lib/site.ts. Neither sells an embeds plan.
  expect(sources, hits.join('\n')).toEqual(['lib/site.ts', 'lib/site.ts']);
  const site = readFileSync('lib/site.ts', 'utf8');
  expect(site).toMatch(/export const DONATE_URL[^\n]*buy\.stripe\.com/);
  expect(site).toMatch(/export const BILLING_PORTAL_URL = 'https:\/\/billing\.stripe\.com\/p\/login\//);
});

for (const [locale, m] of [
  ['en', en],
  ['es', es],
] as const) {
  test(`${locale}: /partners and /embeds make the same plans claim`, () => {
    for (const [surface, text] of [
      ['partners.licensingBody', m.partners.licensingBody],
      ['embeds.docsPlansBody', m.embeds.docsPlansBody],
    ] as const) {
      for (const plan of PLAN_NAMES[locale]) expect(text, `${surface} names ${plan}`).toContain(plan);
      expect(text, `${surface} says only Free is open`).toMatch(NOT_OPEN[locale]);
    }
    // The plan names are the Terms' own, not a second list.
    for (const plan of PLAN_NAMES[locale]) expect(m.embedsTerms.intro).toContain(plan);
  });
}
