/*
 * WHICH BILLS THE SITE SHOWS AS ENDED (stage 3 of the new-Congress work,
 * 2026-11-13).
 *
 * The owner decided on Nov 12, 2026 to keep the 119th Congress's bills as an
 * archive marked "ended" and to read the 120th alongside them. Stage 2 put the
 * list of ended Congresses in lib/congress.mjs (`ENDED_CONGRESSES`, EMPTY until
 * the switch). This module is the one place the SITE asks that list a
 * question: the bill page, the status labels, the "moving" lists, the script
 * route, the embeds, the MCP replies and llms.txt all read `siteEndedCongress`
 * below, never `ENDED_CONGRESSES` directly.
 *
 * DORMANT. While the list is empty and the review setting below is off, every
 * function here answers "not ended" for every bill, so nothing on the site
 * changes. tests/ended-state.unit.spec.ts pins that.
 *
 * THE REVIEW SETTING, AND ITS GUARD. The owner has to see the ended state
 * before January, and the list stays empty until the switch. So a build may
 * treat ONE Congress as ended for review only:
 *
 *   ORAVAN_REVIEW_ENDED_CONGRESS=119 npm run build
 *
 * It is read once, when this module loads. A review build also bakes the
 * value into its own server and browser code (next.config.ts passes it to
 * Next's `env` option, which replaces `process.env.ORAVAN_REVIEW_ENDED_CONGRESS`
 * at build time), so the pages prerendered at build and the routes rendered
 * on request by `next start` (the embeds, the script route, the MCP server,
 * /bills) read the same value. With the setting off nothing is baked in and
 * the config is unchanged. It cannot reach a deployed site by accident, because
 * `reviewEndedCongressFrom` THROWS when it is set in any of these places:
 *
 *   - a Vercel build or function (`VERCEL` set, or `VERCEL_ENV` set): every
 *     page that imports this module fails to render, so the build fails and
 *     nothing deploys;
 *   - CI (`CI` or `GITHUB_ACTIONS` set): the CI build fails the same way, so a
 *     pull request cannot go green with it on.
 *
 * It also refuses any value but the tracked Congress's number (119 today):
 * the approved wording names the 119th Congress, and a review build of any
 * other Congress would print it over the wrong bills. Pipeline scripts never
 * read it: lib/congress.mjs's CONGRESS_POLICY (what verify-sync and the
 * nightly read) does not change.
 *
 * Import-free apart from lib/congress.mjs, so .mjs gates, lib/*.ts and route
 * handlers can all read it. In a client bundle `process.env` holds none of
 * these names, so the setting is off there; every surface that shows the
 * ended state decides it on the server and passes the result down.
 */
import { CONGRESS, CONGRESS_POLICY, congressOfBill, congressTerm, endedCongress } from './congress.mjs';

/** The review setting's name. */
export const REVIEW_ENDED_ENV = 'ORAVAN_REVIEW_ENDED_CONGRESS';

/** The environment names under which the review setting is refused. */
export const REVIEW_REFUSED_WHERE = Object.freeze(['VERCEL', 'VERCEL_ENV', 'CI', 'GITHUB_ACTIONS']);

/**
 * The Congress a review build treats as ended, or null when the setting is
 * off. Off is: unset, empty, "0", "off" or "false".
 * @param {Record<string, string | undefined>} env
 * @param {number} [tracked] the tracked Congress (a test passes its own)
 * @returns {number | null}
 */
export function reviewEndedCongressFrom(env, tracked = CONGRESS) {
  const raw = String(env?.[REVIEW_ENDED_ENV] ?? '').trim();
  if (raw === '' || raw === '0' || /^(off|false)$/i.test(raw)) return null;
  const refusedBy = REVIEW_REFUSED_WHERE.filter((name) => {
    const v = env?.[name];
    return typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  });
  if (refusedBy.length > 0) {
    throw new Error(
      `${REVIEW_ENDED_ENV} is a local review setting and is refused here (${refusedBy.join(', ')} set). ` +
        'Unset it: it must never reach a deployed or CI build.'
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n !== tracked) {
    throw new Error(
      `${REVIEW_ENDED_ENV}=${raw} is not accepted: only the tracked Congress (${tracked}) can be reviewed as ended, ` +
        'because the approved wording names it.'
    );
  }
  return n;
}

/**
 * The policy the site reads: lib/congress.mjs's, plus the reviewed Congress
 * when the review setting is on.
 * @param {import('./congress.mjs').CongressPolicy} base
 * @param {number | null} reviewed
 * @returns {Readonly<import('./congress.mjs').CongressPolicy>}
 */
export function sitePolicyFrom(base, reviewed) {
  if (reviewed === null || base.ended.some((e) => e.number === reviewed)) return base;
  return Object.freeze({
    tracked: base.tracked,
    ended: Object.freeze([...base.ended, Object.freeze({ number: reviewed, ended: congressTerm(reviewed).end })]),
  });
}

const runtimeEnv = typeof process !== 'undefined' && process.env ? process.env : {};

/** The Congress this build reviews as ended (null on every real build). The
 *  setting is read by its literal name so a review build's baked-in value
 *  (next.config.ts) replaces it; the guard's names are read at run time. */
export const REVIEW_ENDED_CONGRESS = reviewEndedCongressFrom({
  ...runtimeEnv,
  [REVIEW_ENDED_ENV]: process.env.ORAVAN_REVIEW_ENDED_CONGRESS,
});

/** The ended list as the site reads it. Equal to CONGRESS_POLICY unless the
 *  review setting is on. */
export const SITE_CONGRESS_POLICY = sitePolicyFrom(CONGRESS_POLICY, REVIEW_ENDED_CONGRESS);

/*
 * THE TEST SETTING. A unit test has to say "119 has ended" for every surface
 * at once (the labels, the ladder, the bill page's reading, the MCP envelope,
 * the script route), and the review setting above is refused in CI by design.
 * So a test wraps its body in `withSitePolicyForTest(policy, fn)`: the policy
 * holds until `fn` returns (or, when `fn` is async, until its promise
 * settles) and is then restored, whatever happened. A unit spec's tests run
 * one after another in one worker, so an awaited call cannot leak into
 * another test. Nothing outside tests/ may call it:
 * tests/ended-state.unit.spec.ts fails if a file under app/, components/,
 * lib/ or scripts/ names it.
 */
/** @type {Readonly<import('./congress.mjs').CongressPolicy>} */
let activePolicy = SITE_CONGRESS_POLICY;

/**
 * Run `fn` with `policy` as the site's ended list, then restore it.
 * TESTS ONLY.
 * @template T
 * @param {import('./congress.mjs').CongressPolicy} policy
 * @param {() => T} fn
 * @returns {T}
 */
export function withSitePolicyForTest(policy, fn) {
  const before = activePolicy;
  activePolicy = policy;
  let out;
  try {
    out = fn();
  } catch (err) {
    activePolicy = before;
    throw err;
  }
  if (out && typeof (/** @type {any} */ (out).then) === 'function') {
    return /** @type {any} */ (out).finally(() => {
      activePolicy = before;
    });
  }
  activePolicy = before;
  return out;
}

/** The ended list the site reads right now (SITE_CONGRESS_POLICY outside a
 *  test). */
export function sitePolicy() {
  return activePolicy;
}

/**
 * The ended Congress a bill (record or slug) belongs to, as `{ number, ended }`
 * with the term's last day, or null when its Congress has not ended.
 * @param {unknown} billOrSlug
 * @param {import('./congress.mjs').CongressPolicy} [policy]
 * @returns {import('./congress.mjs').EndedCongress | null}
 */
export function siteEndedCongress(billOrSlug, policy = activePolicy) {
  return endedCongress(congressOfBill(billOrSlug), policy);
}

/** Does the site show this bill (record or slug) as ended?
 *  @param {unknown} billOrSlug
 *  @param {import('./congress.mjs').CongressPolicy} [policy] */
export function isSiteEndedBill(billOrSlug, policy = activePolicy) {
  return siteEndedCongress(billOrSlug, policy) !== null;
}
