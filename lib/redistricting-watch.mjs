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

/* ------------------------------------------------------------------------ *
 * Standing-issue rendering.
 *
 * The watch used to file one `gh issue create` per changed state per run,
 * with no issue-level dedupe at all - the only dedupe was value-level (the
 * committed rdh_lastmod advances, so the same hop never re-fires). That is
 * correct tripwire behaviour and still produced nine open issues in six
 * weeks, eight of them from a single upstream event: RDH bulk-touched eight
 * state pages within 28 minutes on 2026-07-24 (issues #119-#126), which is a
 * site-wide republish, not eight map events. Nothing reads those issues -
 * no product code, no workflow, no MCP tool - so their only job is to be
 * READ by the owner, and nine identical-looking titles is worse at that job
 * than one.
 *
 * So: one rolling, pinned issue, body rewritten from the committed watch
 * file every run (the status board below) plus one comment per run that
 * detected something. Same pattern daily-metrics.yml already ships. These
 * renderers are pure and live here, not in the workflow YAML, so they are
 * unit-testable (tests/redistricting-watch.unit.spec.ts) and the workflow-
 * side shell stays a label upsert, a title lookup, and two `gh` calls.
 * ------------------------------------------------------------------------ */

/** Title of the single rolling issue. The workflow looks this up EXACTLY. */
export const STANDING_ISSUE_TITLE = 'Redistricting watch (standing)';

/** At least this many tracked states must move together to read as a republish. */
export const BULK_MIN_STATES = 6;

/** ...and they must also be at least this share of everything tracked. */
export const BULK_MIN_SHARE = 0.6;

/** ...within this span. The 2026-07-24 batch spanned ~28 minutes end to end. */
export const BULK_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Markdown table cells: a literal pipe would silently split the column. */
function cell(value) {
  return String(value ?? '').replaceAll('|', '\\|');
}

function isoDay(today) {
  const t = today instanceof Date ? today : new Date(today);
  return t.toISOString().slice(0, 10);
}

/**
 * True when a run's changes look like RDH re-publishing its whole state
 * section rather than N separate map events: a supermajority of the tracked
 * states, at least BULK_MIN_STATES of them, all landing within
 * BULK_WINDOW_MS of each other. Deliberately conservative - a false negative
 * just means the comment omits a hint, while a false positive would tell the
 * owner to ignore real news.
 *
 * @param {Array<{newLastmod: string}>} changed
 * @param {number} trackedCount
 * @returns {boolean}
 */
export function isBulkRepublish(changed, trackedCount) {
  if (!Array.isArray(changed) || changed.length < BULK_MIN_STATES) return false;
  if (!(trackedCount > 0) || changed.length / trackedCount < BULK_MIN_SHARE) return false;
  const times = changed.map((c) => new Date(c?.newLastmod ?? '').getTime());
  // An unparseable timestamp means we cannot establish "near-identical" at
  // all; say nothing rather than guess.
  if (times.some((t) => !Number.isFinite(t))) return false;
  return Math.max(...times) - Math.min(...times) <= BULK_WINDOW_MS;
}

/**
 * The rolling issue's BODY: a status board over every tracked state, rebuilt
 * from the committed watch file on every run so the top of the issue is
 * always current rather than a pile of history.
 *
 * @param {Record<string, WatchEntry & {checked?: string}>} committed
 * @param {string|Date} today
 * @returns {string} markdown
 */
export function renderStatusBoard(committed, today) {
  const rows = Object.entries(committed).map(
    ([state, e]) =>
      `| [${cell(state)}](${cell(e.rdh_url)}) | ${cell(e.status)} | ${cell(e.verified)} | ` +
      `${cell(e.checked || '—')} | \`${cell(e.rdh_lastmod)}\` |`
  );

  return [
    `Standing issue for the Redistricting Data Hub (RDH) map-page tripwire. **Leave it open** — the weekly \`Weekly legislators refresh\` workflow rewrites this body every run and adds one comment per run that detected a change. One issue, forever, instead of one per state per detection. Any note you add here belongs in a **comment**; the body is overwritten.`,
    '',
    `## Tracked states (${Object.keys(committed).length})`,
    '',
    '| State | Status | Note verified | Last detected | RDH lastmod |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `_Board as of ${isoDay(today)}, rendered from \`data/redistricting-watch.json\`._`,
    '',
    '**How to read it**',
    '',
    '- **Status** and **Note verified** are the hand-authored `status` and `verified` fields. Automation never writes them.',
    '- **Last detected** is the `checked` field, which advances only when that state’s RDH lastmod moves. Every tracked state is polled every run, so `—` means "polled, never changed since the seed" — not "not looked at".',
    '- **RDH lastmod** is the current baseline. A hop is a TRIPWIRE — "a human should go read RDH’s page for this state" — never an automated reading of *what* changed.',
    '',
    "**When a comment below flags a state:** open its RDH page, see what actually changed, then update that state's `status`/`note` in `data/redistricting-watch.json`. The baseline has already advanced for it, so the same hop never re-fires.",
    '',
    'Mechanism: `scripts/check-redistricting-watch.mjs` + `lib/redistricting-watch.mjs`, weekly from `.github/workflows/refresh-legislators.yml`. Decision record: `docs/solutions/two-clock-district-boundaries.md`.',
    '',
  ].join('\n');
}

/**
 * One comment per run that detected something: exactly which states moved,
 * from what to what, with the RDH page to go read.
 *
 * @param {Array<{state: string, prevLastmod: string, newLastmod: string, url: string}>} changed
 * @param {number} trackedCount
 * @param {string|Date} today
 * @returns {string} markdown
 */
export function renderChangeComment(changed, trackedCount, today) {
  const rows = changed.map(
    (c) =>
      `| ${cell(c.state)} | \`${cell(c.prevLastmod)}\` | \`${cell(c.newLastmod)}\` | ${cell(c.url)} |`
  );

  const lines = [
    `### RDH map-page changes — ${isoDay(today)}`,
    '',
    `${changed.length} of ${trackedCount} tracked states moved in this run.`,
    '',
  ];

  if (isBulkRepublish(changed, trackedCount)) {
    const times = changed.map((c) => new Date(c.newLastmod).getTime());
    const spanMin = Math.round((Math.max(...times) - Math.min(...times)) / 60_000);
    lines.push(
      `> **This reads as an RDH site-wide republish, not ${changed.length} map events.** ` +
        `${changed.length} of ${trackedCount} tracked states moved with near-identical timestamps ` +
        `(all within ${spanMin} minute(s) of each other), which is what a bulk re-publish of RDH's ` +
        'state pages looks like — the 2026-07-24 batch (issues #119–#126) was exactly this. Check one ' +
        'page before treating this as separate map news for every state below.',
      ''
    );
  }

  lines.push(
    '| State | Previous lastmod | New lastmod | RDH page |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    "The baseline in `data/redistricting-watch.json` has already advanced for each state above, so these same hops will not re-fire next week. Update a state's `status`/`note` if its page really changed.",
    ''
  );

  return lines.join('\n');
}

/**
 * Every tracked state that has ever recorded a detection. `checked` is
 * written by scripts/check-redistricting-watch.mjs ONLY inside its
 * changed-state loop, so its presence is exactly "this state's RDH page has
 * moved at least once since the seed" - the existing, already-committed
 * record, with no new schema.
 *
 * @param {Record<string, WatchEntry & {checked?: string}>} committed
 * @returns {Array<{state: string, status: string, checked: string, rdhLastmod: string, url: string}>}
 */
export function statesWithDetections(committed) {
  return Object.entries(committed)
    .filter(([, e]) => typeof e?.checked === 'string' && e.checked !== '')
    .map(([state, e]) => ({
      state,
      status: e.status,
      checked: e.checked,
      rdhLastmod: e.rdh_lastmod,
      url: e.rdh_url,
    }));
}
