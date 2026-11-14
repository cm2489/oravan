/*
 * THE RECORD'S SHORT TITLES FOR EACH BILL (2026-11-14): data/short-titles.json.
 *
 * WHY. The owner's card 191 (Nov 14, 2026, 1:06 PM ET): "Names beside
 * numbers. Each name comes from the bill's own official short title in the
 * record, never chosen by Oravan." A name address (oravan.org/continuing-appropriations-act-2027)
 * is built from these titles and nothing else (lib/short-address.ts,
 * nameSlug). Hard rule 6: the record, quoted, never narrated.
 *
 * WHERE THEY COME FROM. Congress.gov's per-bill titles list,
 * /bill/{congress}/{type}/{number}/titles: one free request per bill. Each
 * entry carries a `titleType` written by the record itself ("Short Title(s)
 * as Introduced", "Short Title(s) as Passed House", "Short Titles from ENR
 * (Enrolled) bill text", "Official Title as Introduced", "Display Title",
 * "Popular Titles", ...). A title is kept ONLY when its type names it a short
 * title of THE BILL (isRecordShortTitleType below): never the display title,
 * never the official long title, never a popular title, never an AI headline,
 * and never a "short title for portions of this bill" (that names a part of
 * the bill, a title or division inside it, not the bill). Kept exactly as the
 * record gives it; nothing here rewrites a word.
 *
 * WHY A FILE OF ITS OWN, NOT bills.json's `short_title`. That field exists
 * (null on every bill) and seven readers fall back to it for the headline a
 * page prints (lib/today.ts, lib/bill-call-panel.ts, lib/jsonld.ts, ...).
 * Filling it would change what pages say; this file changes nothing a page
 * renders. Only next.config.ts reads it, at build time, to build the
 * proxy's name table; no page, no route and no browser bundle imports it.
 *
 * THE FILE. One object, one line per bill, keyed by slug and sorted:
 *   { "s-5-119": { "titles": ["Laken Riley Act"], "as_of": "2025-01-29" }, ... }
 * `titles` is every distinct short title the record gives the bill, in
 * code-point order (empty when it has none: the bill was looked at). `as_of`
 * is the bill's `last_action_date` when its titles were read: short titles
 * are added at reporting, passage and enrolment, each of which is an action,
 * so a bill whose last action moved is read again.
 *
 * IMPORT-FREE ON PURPOSE (no imports, no I/O, no environment), so
 * next.config.ts, scripts/verify-sync.mjs, scripts/sync-short-titles.mjs and
 * the unit specs can all load it.
 */

export const SHORT_TITLES_PATH = 'data/short-titles.json';

/** At most this many titles requests a night (the backfill takes ~7 nights). */
export const SHORT_TITLES_MAX_PER_NIGHT = 500;

/** A title longer than this is not a short title; the gate refuses it. */
export const SHORT_TITLE_MAX_LENGTH = 400;

/**
 * Does the record's own `titleType` name this a short title of the bill?
 * Yes for every "Short Title(s) ..." / "Short Titles ..." type, at every
 * stage and from every text version; no for "... for portions of this bill",
 * and no for every other type (display, official, popular, override).
 * @param {unknown} titleType
 */
export function isRecordShortTitleType(titleType) {
  if (typeof titleType !== 'string') return false;
  if (!/^short titles?\b|^short title\(s\)/i.test(titleType.trim())) return false;
  return !/\bportions?\b/i.test(titleType);
}

/**
 * The short titles of one bill, from the record's titles list
 * (`response.titles`): every distinct title whose type passes
 * isRecordShortTitleType, exactly as written, in code-point order.
 * @param {unknown} titles
 * @returns {string[]}
 */
export function shortTitlesFromRecord(titles) {
  if (!Array.isArray(titles)) return [];
  const out = new Set();
  for (const entry of titles) {
    if (!entry || typeof entry !== 'object') continue;
    if (!isRecordShortTitleType(entry.titleType)) continue;
    if (typeof entry.title !== 'string' || entry.title.trim() === '') continue;
    out.add(entry.title);
  }
  return [...out].sort();
}

const slugOf = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

/**
 * Which bills to read tonight, at most `cap`: first every corpus bill the file
 * has never read (most urgent first), then every bill whose last action moved
 * since its titles were read (most urgent first). Pure.
 * @param {{ bills: any[], file: Record<string, {titles: string[], as_of: string|null}>, cap?: number }} args
 * @returns {{ run: string[], neverRead: number, stale: number, deferred: number }}
 */
export function planShortTitleReads({ bills, file, cap = SHORT_TITLES_MAX_PER_NIGHT }) {
  const urgency = (b) => (Number.isFinite(b?.urgency_score) ? b.urgency_score : 0);
  const byUrgency = (a, b) => urgency(b) - urgency(a) || (slugOf(a) < slugOf(b) ? -1 : 1);
  const never = [];
  const stale = [];
  for (const b of Array.isArray(bills) ? bills : []) {
    const entry = file?.[slugOf(b)];
    if (!entry) never.push(b);
    else if ((entry.as_of ?? null) !== (b.last_action_date ?? null)) stale.push(b);
  }
  never.sort(byUrgency);
  stale.sort(byUrgency);
  const limit = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : SHORT_TITLES_MAX_PER_NIGHT;
  const run = [...never, ...stale].slice(0, limit).map(slugOf);
  return { run, neverRead: never.length, stale: stale.length, deferred: never.length + stale.length - run.length };
}

/**
 * The file as written: one line per bill, keys sorted, entries for bills the
 * corpus no longer holds dropped.
 * @param {Record<string, {titles: string[], as_of: string|null}>} file
 * @param {any[]} bills
 */
export function serializeShortTitles(file, bills) {
  const held = new Set((Array.isArray(bills) ? bills : []).map(slugOf));
  const keys = Object.keys(file ?? {}).filter((k) => held.has(k)).sort();
  if (keys.length === 0) return '{}\n';
  const lines = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify({ titles: file[k].titles, as_of: file[k].as_of ?? null })}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

const SLUG = /^(hr|s|hjres|sjres|hconres|sconres|hres|sres)-[1-9]\d{0,4}-[1-9]\d{0,3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * THE GATE (hard rule 11), run by scripts/verify-sync.mjs before the nightly
 * commit and by scripts/sync-short-titles.mjs before it writes. Returns
 * failures (the night does not commit) and notes.
 *   - not an object keyed by slug, or a key that is not a bill slug;
 *   - a key the corpus does not hold;
 *   - an entry that is not exactly { titles, as_of };
 *   - `titles` not an array of distinct, non-empty strings of at most
 *     SHORT_TITLE_MAX_LENGTH characters with no control character, in
 *     code-point order;
 *   - `as_of` neither null nor a YYYY-MM-DD date;
 *   - against the committed file (`before`): the bills carrying a short title
 *     fell by more than 10%, or a bill that had titles lost all of them while
 *     the corpus still holds it (a title never leaves the record once given).
 * @param {{ data: unknown, bills: any[], before?: unknown }} args
 * @returns {{ failures: string[], notes: string[] }}
 */
export function verifyShortTitles({ data, bills, before = null }) {
  const failures = [];
  const notes = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { failures: [`${SHORT_TITLES_PATH} is not an object keyed by bill slug`], notes };
  }
  const held = new Set((Array.isArray(bills) ? bills : []).map(slugOf));
  let withTitles = 0;
  for (const [slug, entry] of Object.entries(data)) {
    if (!SLUG.test(slug)) {
      failures.push(`${SHORT_TITLES_PATH}: "${slug}" is not a bill slug`);
      continue;
    }
    if (!held.has(slug)) failures.push(`${SHORT_TITLES_PATH}: ${slug} is not in data/bills.json`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      failures.push(`${SHORT_TITLES_PATH}: ${slug} is not an object`);
      continue;
    }
    const keys = Object.keys(entry).sort().join(',');
    if (keys !== 'as_of,titles') failures.push(`${SHORT_TITLES_PATH}: ${slug} has fields [${keys}], expected [as_of,titles]`);
    if (!(entry.as_of === null || (typeof entry.as_of === 'string' && DATE.test(entry.as_of)))) {
      failures.push(`${SHORT_TITLES_PATH}: ${slug} as_of is neither null nor a YYYY-MM-DD date`);
    }
    const titles = entry.titles;
    if (!Array.isArray(titles)) {
      failures.push(`${SHORT_TITLES_PATH}: ${slug} titles is not an array`);
      continue;
    }
    for (const t of titles) {
      if (typeof t !== 'string' || t.trim() === '') failures.push(`${SHORT_TITLES_PATH}: ${slug} has an empty or non-string title`);
      else if (t.length > SHORT_TITLE_MAX_LENGTH) failures.push(`${SHORT_TITLES_PATH}: ${slug} has a title over ${SHORT_TITLE_MAX_LENGTH} characters`);
      else if (CONTROL.test(t)) failures.push(`${SHORT_TITLES_PATH}: ${slug} has a title with a control character`);
    }
    const strings = titles.filter((t) => typeof t === 'string');
    if (new Set(strings).size !== strings.length) failures.push(`${SHORT_TITLES_PATH}: ${slug} repeats a title`);
    if (strings.join('\u0000') !== [...strings].sort().join('\u0000')) failures.push(`${SHORT_TITLES_PATH}: ${slug} titles are not in code-point order`);
    if (titles.length > 0) withTitles++;
  }
  notes.push(`${SHORT_TITLES_PATH}: ${Object.keys(data).length} bill(s) read, ${withTitles} with at least one short title`);
  if (before && typeof before === 'object' && !Array.isArray(before)) {
    const had = Object.entries(before).filter(([, e]) => Array.isArray(e?.titles) && e.titles.length > 0);
    if (had.length >= 20 && withTitles < had.length * 0.9) {
      failures.push(`${SHORT_TITLES_PATH}: bills with a short title fell ${had.length} -> ${withTitles} (>10% overnight)`);
    }
    for (const [slug] of had) {
      if (!held.has(slug)) continue;
      const now = data[slug];
      if (now && Array.isArray(now.titles) && now.titles.length === 0) {
        failures.push(`${SHORT_TITLES_PATH}: ${slug} had short titles and now has none (the record never takes one back)`);
      }
    }
  }
  return { failures, notes };
}
