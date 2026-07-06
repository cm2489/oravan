/*
 * Redistricting Data Hub "What's New" tripwire — pure core (S24, §9.1(f)
 * item 3). Plain .mjs with JSDoc types, no side effects, following
 * lib/salt.mjs's pattern so the weekly workflow script
 * (scripts/check-redistricting-watch.mjs) and the unit spec
 * (tests/redistricting-watch.unit.spec.ts) import the exact logic that runs
 * in production.
 *
 * Verified live 2026-07-06: RDH's "What's New" page
 * (https://redistrictingdatahub.org/data/whats-new/) has no RSS/Atom/JSON
 * feed, no /feed or /rss endpoint, and no wp-json API reference in its HTML
 * - a reverse-chronological list meant for human browsing or their email
 * newsletter, not machine consumption. What RDH *does* publish is a
 * standard WordPress-SEO-plugin XML sitemap
 * (https://redistrictingdatahub.org/state-sitemap.xml) with a <lastmod> for
 * every /state/{slug}/ page - real, machine-parseable, and (unlike a raw
 * hash-diff of the "What's New" listing) scoped to exactly the states this
 * file tracks, so it doesn't fire on unrelated page churn elsewhere on that
 * listing.
 *
 * This module treats a tracked state's lastmod moving as a TRIPWIRE only:
 * "something on RDH's page for this state changed since we last looked."
 * It does not parse *what* changed from the HTML (that would be fragile
 * scraping of prose RDH can restyle at any time) and it never derives or
 * writes a new `status`/`note` itself - those stay human-authored, updated
 * only after someone actually reads the change. See
 * docs/solutions/two-clock-district-boundaries.md for the full decision
 * record this implements.
 */

/** RDH's standard XML sitemap covering every /state/{slug}/ page. */
export const RDH_STATE_SITEMAP_URL = 'https://redistrictingdatahub.org/state-sitemap.xml';

/**
 * Extract {slug -> lastmod ISO string} for every /state/{slug}/ entry in a
 * WordPress-style sitemap document. Regex-based on purpose (stdlib-only, no
 * XML-parser dependency, matching this repo's other verifier scripts) - RDH's
 * sitemap is a flat, predictable <url><loc/><lastmod/></url> list (verified
 * against a live fetch 2026-07-06), not arbitrary namespaced XML that would
 * need a real parser.
 *
 * @param {string} xml
 * @returns {Map<string, string>} slug (lowercase, e.g. "texas") -> lastmod
 */
export function parseStateSitemap(xml) {
  const out = new Map();
  const blockRe = /<url>([\s\S]*?)<\/url>/g;
  let block;
  while ((block = blockRe.exec(xml))) {
    const body = block[1];
    const locMatch = /<loc>\s*https?:\/\/[^<]*\/state\/([a-z0-9-]+)\/?\s*<\/loc>/i.exec(body);
    if (!locMatch) continue;
    const lastmodMatch = /<lastmod>\s*([^<\s][^<]*?)\s*<\/lastmod>/i.exec(body);
    if (!lastmodMatch) continue;
    out.set(locMatch[1].toLowerCase(), lastmodMatch[1]);
  }
  return out;
}

/**
 * @typedef {{ status: string, note: string, rdh_url: string, rdh_lastmod: string, verified: string }} WatchEntry
 */

/**
 * @param {string} url
 * @returns {string|null} the /state/{slug}/ slug, or null if the URL doesn't match
 */
function slugFromUrl(url) {
  const m = /\/state\/([a-z0-9-]+)\/?$/i.exec(url ?? '');
  return m ? m[1].toLowerCase() : null;
}

/**
 * Diff this run's freshly-fetched lastmods against the committed watch file.
 * Pure - takes the fetch result already parsed, so tests never touch the
 * network. Mirrors vacancy_diff.py's shape: a plain comparison against
 * exactly what's currently committed, no hidden state.
 *
 * @param {Record<string, WatchEntry>} committed  data/redistricting-watch.json, keyed by USPS state code
 * @param {Map<string, string>} freshBySlug  parseStateSitemap's output
 * @returns {{
 *   changed: Array<{state: string, prevLastmod: string, newLastmod: string, url: string}>,
 *   missing: string[]
 * }}
 */
export function diffWatch(committed, freshBySlug) {
  const changed = [];
  const missing = [];
  for (const [state, entry] of Object.entries(committed)) {
    const slug = slugFromUrl(entry.rdh_url);
    const fresh = slug ? freshBySlug.get(slug) : undefined;
    if (fresh === undefined) {
      missing.push(state);
      continue;
    }
    if (fresh !== entry.rdh_lastmod) {
      changed.push({ state, prevLastmod: entry.rdh_lastmod, newLastmod: fresh, url: entry.rdh_url });
    }
  }
  return { changed, missing };
}

/**
 * True when the fetch/parse itself looks broken rather than reality - every
 * single tracked state came back missing. Mirrors vacancy_diff.py's
 * ANOMALOUS_SHRINK_THRESHOLD idea: a structural failure (RDH restructured
 * the sitemap, the fetch errored into an empty/wrong document, etc.) must
 * never masquerade as "nothing changed," and the baseline must not be
 * updated on top of it.
 *
 * @param {string[]} missing
 * @param {number} trackedCount
 * @returns {boolean}
 */
export function isStructuralFailure(missing, trackedCount) {
  return trackedCount > 0 && missing.length === trackedCount;
}
