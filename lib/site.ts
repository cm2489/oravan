/**
 * THE one place the production domain lives. A rename is in flight; when the
 * new domain lands, editing this constant is the entire code change — nothing
 * else in app code may hardcode the origin.
 *
 * Used for canonical share URLs, which are slug-only by rule: no query
 * params, no stance, no locale-tracking params. A shared link must say
 * nothing about the person who shared it.
 */
export const SITE_ORIGIN = 'https://cabina-nine.vercel.app';
