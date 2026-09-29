/**
 * THE one place the production domain lives. A rename is in flight; when the
 * new domain lands, editing this constant is the entire code change — nothing
 * else in app code may hardcode the origin.
 *
 * Used for canonical share URLs, which are slug-only by rule: no query
 * params, no stance, no locale-tracking params. A shared link must say
 * nothing about the person who shared it.
 */
export const SITE_ORIGIN = 'https://oravan.org';

/**
 * The externally-hosted donation page URL — a live-mode Stripe Payment Link
 * with a customer-chosen amount ("Support Oravan", minted 2026-07-18). This
 * is the rail chosen after the HCB fiscal-sponsorship denial (2026-07-15):
 * a plain payment link, personal support, no sponsor. Every donate
 * affordance (footer funding line + Support CTA, the homepage support band,
 * the About page's "Who pays for this?" ask copy) reads this one constant;
 * setting it back to null darkens all of them at once.
 *
 * Copy rule, non-negotiable: no surface may claim tax-deductibility,
 * nonprofit status, or a fiscal sponsor — contributions are personal
 * support for a founder-funded project (tests/donate.unit.spec.ts pins
 * this against the message files).
 *
 * Always link out (target="_blank", rel="noopener noreferrer") — never
 * iframe a payment page in, and never add a payment field anywhere on
 * Oravan's own infra. See the project records §6
 * (historical record; its HCB-specific plan is superseded by the denial).
 */
export const DONATE_URL: string | null = 'https://buy.stripe.com/00w8wIcX74px0CH8EJ8k804';

/**
 * Stripe's hosted customer-portal login page for embeds subscribers
 * (live mode; verified against the live portal configuration 2026-07-18:
 * payment-method update, invoice history, and cancellation are enabled —
 * plan switching is NOT, so no copy may promise plan changes). Same
 * link-out-only rule as DONATE_URL: never iframed, never a payment field
 * on Oravan's own infra. Subscribers authenticate to Stripe with the email
 * they used at checkout; Oravan itself holds no account or identity.
 */
export const BILLING_PORTAL_URL = 'https://billing.stripe.com/p/login/aFa28k5uF4px0CHdZ38k800';

/**
 * THE ONE GUARD for the partner-embeds pages: /embeds (configurator, preview,
 * snippet, plans, billing-portal link) and /embeds/terms. Hidden on the
 * owner's answer of 2026-09-28 (open-questions page, item F, option a):
 * "Hide the embeds pages and terms until embeds come back. Nothing
 * half-filled stays public. Embeds come back with filled terms." The terms'
 * governing-law clause (embedsTerms.lawBody) still reads "[FOUNDER: fill]".
 *
 * While false, both pages return notFound() in both locales, and every
 * surface that pointed at them follows this constant: app/sitemap.ts, the
 * footer, llms.txt, the /follow embeds section, the /partners button and the
 * action-panel widget's refusal link (which points at /partners instead).
 * The widget routes under /embed/* and public/embed.js are NOT gated — they
 * keep working for any site that already carries them, with rule 12's
 * promises intact.
 *
 * To bring the pages back: fill embedsTerms.lawBody in both languages, then
 * set this to true. tests/embeds-hidden.unit.spec.ts refuses true while the
 * placeholder is still there, and tests/plans-claim.unit.spec.ts then asks
 * for /partners' plans sentence back ("only Free is open").
 */
export const EMBEDS_PAGES_PUBLIC: boolean = false;

/** The locale-relative paths EMBEDS_PAGES_PUBLIC hides — empty when public.
 *  Read by app/sitemap.ts, the footer and tests/routes.ts. */
export const HIDDEN_PAGES: readonly string[] = EMBEDS_PAGES_PUBLIC ? [] : ['/embeds', '/embeds/terms'];

/**
 * The free "what moved this week" feed's public paths, per locale (S21).
 * Locale-explicit static routes — app/feed/whats-moving.{json,xml} for en,
 * app/es/feed/whats-moving.{json,xml} for es — so these are plain paths
 * OUTSIDE the next-intl [locale] tree: link them with a bare <a>, never with
 * next-intl's <Link>, which would prefix them a second time. One definition,
 * read by the footer's Follow column, /follow, and /embeds.
 */
export function feedPaths(locale: string): { json: string; xml: string } {
  const prefix = locale === 'es' ? '/es/feed' : '/feed';
  return { json: `${prefix}/whats-moving.json`, xml: `${prefix}/whats-moving.xml` };
}
