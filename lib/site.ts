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
 * The externally-hosted donation page URL. Null until a donation rail
 * exists: the HCB fiscal-sponsorship application was DENIED 2026-07-15
 * (HCB currently sponsors teen hacker builds only), so the rail decision
 * is back with the owner and this stays null until a replacement is chosen
 * and live. Every donate affordance (footer funding line + Donate link,
 * the About page's "Who pays for this?" ask copy) reads this one constant
 * and renders nothing extra when it's null, so flipping this to a live URL
 * is the entire code change needed to light up donations everywhere at once.
 *
 * Copy rule, non-negotiable: no surface may claim tax-deductibility,
 * nonprofit status, or a fiscal sponsor — contributions are personal
 * support for a founder-funded project (tests/donate.unit.spec.ts pins
 * this against the message files).
 *
 * Always link out (target="_blank", rel="noopener noreferrer") — never
 * iframe a payment page in, and never add a payment field anywhere on
 * Oravan's own infra. See docs/ideation/2026-07-05-build-gtm-strategy.md §6
 * (historical record; its HCB-specific plan is superseded by the denial).
 */
export const DONATE_URL: string | null = null;
