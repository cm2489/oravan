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
 * The HCB-hosted donation page URL (§6 of the build/GTM strategy). Null
 * until the HCB fiscal-sponsorship application clears — that's paperwork,
 * not code, and is in flight separately. Every donate affordance (footer
 * link, About/Support page ask copy) reads this one constant and renders
 * nothing when it's null, so flipping this to the live HCB URL is the
 * entire code change needed to light up donations everywhere at once.
 *
 * Always link out (target="_blank", rel="noopener noreferrer") — never
 * iframe HCB's page in, and never add a payment field anywhere on Oravan's
 * own infra. See docs/ideation/2026-07-05-build-gtm-strategy.md §6.
 */
export const DONATE_URL: string | null = null;
