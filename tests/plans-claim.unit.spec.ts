import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { EMBEDS_PAGES_PUBLIC } from '../lib/site';

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
 *
 * 2026-09-28: the /embeds pages are hidden until embeds come back (lib/site.ts
 * EMBEDS_PAGES_PUBLIC; owner, open-questions F). While they are, no plan is
 * open to a new site — Free included, since its snippet lived on the hidden
 * page — so /partners says so, and embeds.docsPlansBody keeps its sentence
 * for the day the page returns. Flipping the constant back to true makes this
 * spec ask for /partners' "only Free is open" sentence again.
 */

const PLAN_NAMES = {
  en: ['Free', 'Pro', 'Nonprofit', 'Network'],
  es: ['Gratuito', 'Pro', 'Sin fines de lucro', 'Red'],
} as const;

/*
 * The two facts the code above proves, each matched on its own, in any order
 * and any sentence around it — the wording is free to change, the facts are
 * not: (1) only the Free plan is open; (2) there is no checkout for the paid
 * plans.
 */
const FACTS = {
  en: {
    'only Free is open': /\bonly Free is open\b/i,
    'no checkout for the paid plans': /\bcheckout for the paid plans isn[’']t open\b/i,
  },
  es: {
    'only Free is open': /\bsolo está disponible el Gratuito\b/i,
    'no checkout for the paid plans': /\bno se pueden contratar los planes de pago\b/i,
  },
} as const;

/** What /partners says while the /embeds pages are hidden: no plan is open to
 *  a new site, and still no checkout for the paid ones. */
const HIDDEN_FACTS = {
  en: {
    'no plan is open to new sites': /\bnone is open to new sites\b/i,
    'no checkout for the paid plans': FACTS.en['no checkout for the paid plans'],
  },
  es: {
    'no plan is open to new sites': /\bninguno está abierto a sitios nuevos\b/i,
    'no checkout for the paid plans': FACTS.es['no checkout for the paid plans'],
  },
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
    // While /embeds is hidden, /partners makes the hidden-state claim instead
    // (HIDDEN_FACTS); the /embeds sentence is kept for the page's return.
    for (const [surface, text, facts] of [
      ['partners.licensingBody', m.partners.licensingBody, EMBEDS_PAGES_PUBLIC ? FACTS[locale] : HIDDEN_FACTS[locale]],
      ['embeds.docsPlansBody', m.embeds.docsPlansBody, FACTS[locale]],
    ] as const) {
      for (const plan of PLAN_NAMES[locale]) expect(text, `${surface} names ${plan}`).toContain(plan);
      for (const [fact, pattern] of Object.entries(facts)) {
        expect(text, `${surface} says ${fact}`).toMatch(pattern);
      }
    }
    if (!EMBEDS_PAGES_PUBLIC) {
      // And it no longer calls Free open, or points at a page that 404s.
      expect(m.partners.licensingBody).not.toMatch(FACTS[locale]['only Free is open']);
      expect(m.partners.licensingBody).not.toMatch(/embeds page|página de widgets/i);
    }
    // The plan names are the Terms' own, not a second list.
    for (const plan of PLAN_NAMES[locale]) expect(m.embedsTerms.intro).toContain(plan);
  });
}

for (const [locale, m] of [
  ['en', en],
  ['es', es],
] as const) {
  test(`${locale}: about.fundingBody's "none open" sentence follows EMBEDS_PAGES_PUBLIC`, () => {
    // The about page says the partner embeds' plans are not open to new
    // sites. That is true only while the flag is false, so the sentence is
    // pinned to it: flipping the flag must change this string in the same PR.
    const pattern = {
      en: /\bnone open to new sites yet\b/i,
      es: /\bninguno está abierto todavía a sitios nuevos\b/i,
    }[locale];
    if (EMBEDS_PAGES_PUBLIC) {
      expect(m.about.fundingBody, 'about.fundingBody must not say none is open').not.toMatch(pattern);
    } else {
      expect(m.about.fundingBody, 'about.fundingBody says none is open').toMatch(pattern);
    }
  });
}
