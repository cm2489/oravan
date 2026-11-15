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
 *   { "s-5-119": { "titles": ["Laken Riley Act"], "as_of": "2025-01-29", "read_on": "2026-11-15" }, ... }
 * `titles` is every distinct short title the record gives the bill, in
 * code-point order (empty when it has none: the bill was read and its list
 * held no short title). `as_of` is the bill's `last_action_date` when its
 * titles were read: short titles are added at reporting, passage and
 * enrolment, each of which is an action, so a bill whose last action moved
 * is read again. `read_on` is the UTC day it was read: every bill is read
 * again at least every SHORT_TITLES_REFRESH_DAYS, so a correction the record
 * makes without an action is still picked up.
 *
 * A READ COUNTS ONLY WHEN THE ANSWER IS PLAINLY ABOUT THIS BILL
 * (readTitlesAnswer). A failed read changes nothing that was stored. The
 * record's titles list always holds the bill's official title (every bill
 * has one: "Official Title as Introduced"), so an EMPTY list is not "no
 * short title", it is a failed read; a bill with no short title is a list
 * with titles in it and none of them labelled a short title. Read live for
 * H.R. 9770 on 2026-11-15 (tests/fixtures/congress-gov-titles-hr-9770-119.json):
 * top-level `pagination` (`count`), `request` (`billNumber`, `billType`,
 * `billUrl`, `congress`, `contentType`, `format`; the numbers as strings) and
 * `titles` (each `title`, `titleType`, `titleTypeCode`, `updateDate`, and on
 * some `billTextVersionCode`, `billTextVersionName`, `chamberCode`,
 * `chamberName`).
 *
 * IMPORT-FREE ON PURPOSE (no imports, no I/O, no environment), so
 * next.config.ts, scripts/verify-sync.mjs, scripts/sync-short-titles.mjs and
 * the unit specs can all load it.
 */

export const SHORT_TITLES_PATH = 'data/short-titles.json';

/**
 * At most this many bills read a night (the backfill of ~3,300 bills takes
 * ~11 nights). 300, not 500, since 2026-11-15: see SHORT_TITLES_MAX_REQUESTS.
 */
export const SHORT_TITLES_MAX_PER_NIGHT = 300;

/**
 * Every bill is read again at least this often, inside the same nightly cap.
 * 56 days: a 3,300-bill corpus then needs about 60 refresh reads a night on
 * average, an eighth of the cap, leaving the rest for new bills and bills
 * that moved (which are read first); and a short title the record adds or
 * corrects without an action still appears within two months.
 */
export const SHORT_TITLES_REFRESH_DAYS = 56;

/**
 * Stop the night after this many TRANSPORT failures in a row (no answer in
 * time, a network error, a 429 or a 5xx): the source is down, and the next
 * night resumes. An answer that arrived and was refused is that bill's own
 * failure and never counts here.
 */
export const SHORT_TITLES_MAX_CONSECUTIVE_FAILURES = 10;

/** One page of a bill's titles list, and how many pages a bill may take. */
export const SHORT_TITLES_PAGE_SIZE = 250;
/**
 * Four pages, 1,000 titles. The largest list read on 2026-11-14 (all 3,322
 * bills) fitted one page; four leaves room for the biggest bills
 * (authorizations and omnibus spending bills, which carry a short title for
 * each part) while a bill that would need more is a per-bill failure with
 * its own line rather than an unbounded run of requests.
 */
export const SHORT_TITLES_MAX_PAGES = 4;

/**
 * At most this many requests a night, retries and extra pages included,
 * against the key's 5,000 an hour. 400, not 1,200, since 2026-11-15: the
 * other jobs sharing the key in the hour around the nightly can use about
 * 650 requests on a typical night and several thousand on a catch-up night
 * (docs/runbooks/new-congress-switch.md, "Short titles: requests"), so this
 * step keeps its share under a tenth of the hour.
 */
export const SHORT_TITLES_MAX_REQUESTS = 400;

/** The wait before a failed bill is tried again: 1, 2, 4, 8, 16, then 32 days at most. */
export function retryWaitDays(failures) {
  const n = Number.isInteger(failures) && failures > 0 ? failures : 1;
  return Math.min(2 ** (n - 1), 32);
}

/**
 * THE SOURCE HAS CHANGED: once at least SOURCE_CHANGE_MIN_ANSWERS answers
 * have arrived in a night and more than half of them were refused for one
 * and the same reason, the night stops and says so once, loudly (the
 * "SHORT TITLES TROUBLE:" line lib/pipeline-health.mjs reads into the daily
 * digest's alarms): that is the API changing, not a few odd bills, and no
 * bill is marked as failed for it.
 */
export const SOURCE_CHANGE_MIN_ANSWERS = 20;

/** data/short-titles-retry.json: the bills whose last read failed, with how often and when. */
export const SHORT_TITLES_RETRY_PATH = 'data/short-titles-retry.json';

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

/**
 * Judge one answer from /bill/{congress}/{type}/{number}/titles for `bill`.
 * Returns { ok: true, titles } (the bill's short titles, possibly none) or
 * { ok: false, reason }. Failed: not an object; an `error` field; no
 * `request`, or a `request` naming another congress, type or number; a
 * `titles` that is not a list; an EMPTY list (every bill has an official
 * title, so an empty list is not an answer); no `pagination.count` (a number,
 * or a string of digits), or one that differs from the list's length (an
 * incomplete answer; the script assembles every page first). Pure.
 * @param {unknown} answer
 * @param {{ bill_type: string, bill_number: number, congress_number: number }} bill
 */
export function readTitlesAnswer(answer, bill) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return { ok: false, reason: 'the answer is not an object' };
  if ('error' in answer) return { ok: false, reason: 'the answer carries an error' };
  const req = answer.request;
  if (!req || typeof req !== 'object') return { ok: false, reason: 'the answer does not say which bill it is about' };
  const same =
    String(req.congress ?? '') === String(bill.congress_number) &&
    String(req.billType ?? '').toLowerCase() === String(bill.bill_type).toLowerCase() &&
    String(req.billNumber ?? '') === String(bill.bill_number);
  if (!same) return { ok: false, reason: 'the answer is about another bill' };
  if (!Array.isArray(answer.titles)) return { ok: false, reason: 'the answer has no list of titles' };
  if (answer.titles.length === 0) return { ok: false, reason: 'the list of titles is empty (every bill has an official title)' };
  const raw = answer.pagination?.count;
  const count = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(count)) return { ok: false, reason: 'the answer gives no count of its titles' };
  if (count !== answer.titles.length) return { ok: false, reason: `the list of titles is incomplete (${answer.titles.length} of ${count})` };
  const titles = shortTitlesFromRecord(answer.titles);
  // A short title the file's own gate would refuse fails THIS bill only.
  for (const t of titles) {
    const problem = shortTitleProblem(t);
    if (problem) return { ok: false, reason: `a short title the file cannot hold: ${problem}` };
  }
  return { ok: true, titles };
}

const DAY_MS = 86_400_000;

/**
 * THE ONE TEST OF A SINGLE SHORT TITLE, shared by the bill reader
 * (readTitlesAnswer refuses THAT bill's answer when a title fails it) and the
 * file's gate (verifyShortTitles), so the two can never disagree: a string,
 * not blank, at most SHORT_TITLE_MAX_LENGTH characters, no control character.
 * Returns the problem in plain words, or null.
 * @param {unknown} t
 */
export function shortTitleProblem(t) {
  if (typeof t !== 'string' || t.trim() === '') return 'an empty or non-string title';
  if (t.length > SHORT_TITLE_MAX_LENGTH) return `a title over ${SHORT_TITLE_MAX_LENGTH} characters`;
  if (/[\u0000-\u001f\u007f]/.test(t)) return 'a title with a control character';
  return null;
}

const slugOf = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

/**
 * Which bills to read tonight, at most `cap`: first every corpus bill the file
 * has never read (most urgent first), then every bill whose last action moved
 * since its titles were read (most urgent first), then every bill not read
 * for SHORT_TITLES_REFRESH_DAYS or more (longest unread first), and LAST the
 * bills whose previous read failed and whose wait (retryWaitDays) is over,
 * longest waiting first. A failed bill still inside its wait is not read, so
 * bills that always fail can never head the queue night after night. Pure.
 * @param {{ bills: any[], file: Record<string, {titles: string[], as_of: string|null, read_on?: string}>, retry?: Record<string, {failures: number, last_tried: string, reason: string}>, cap?: number, today?: string }} args
 * @returns {{ run: string[], neverRead: number, stale: number, overdue: number, retrying: number, waiting: number, deferred: number }}
 */
export function planShortTitleReads({ bills, file, retry = {}, cap = SHORT_TITLES_MAX_PER_NIGHT, today = new Date().toISOString().slice(0, 10) }) {
  const urgency = (b) => (Number.isFinite(b?.urgency_score) ? b.urgency_score : 0);
  const byUrgency = (a, b) => urgency(b) - urgency(a) || (slugOf(a) < slugOf(b) ? -1 : 1);
  const never = [];
  const stale = [];
  const overdue = [];
  const retrying = [];
  let waiting = 0;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const dayOf = (d) => Date.parse(`${d ?? ''}T00:00:00Z`);
  for (const b of Array.isArray(bills) ? bills : []) {
    const slug = slugOf(b);
    const failed = retry?.[slug];
    if (failed) {
      const tried = dayOf(failed.last_tried);
      if (Number.isFinite(tried) && todayMs - tried < retryWaitDays(failed.failures) * DAY_MS) waiting++;
      else retrying.push([b, Number.isFinite(tried) ? tried : 0]);
      continue;
    }
    const entry = file?.[slug];
    if (!entry) never.push(b);
    else if ((entry.as_of ?? null) !== (b.last_action_date ?? null)) stale.push(b);
    else {
      const readMs = dayOf(entry.read_on);
      if (!Number.isFinite(readMs) || todayMs - readMs >= SHORT_TITLES_REFRESH_DAYS * DAY_MS) overdue.push([b, Number.isFinite(readMs) ? readMs : 0]);
    }
  }
  never.sort(byUrgency);
  stale.sort(byUrgency);
  const byOldest = (x, y) => x[1] - y[1] || (slugOf(x[0]) < slugOf(y[0]) ? -1 : 1);
  overdue.sort(byOldest);
  retrying.sort(byOldest);
  const limit = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : SHORT_TITLES_MAX_PER_NIGHT;
  const all = [...never, ...stale, ...overdue.map((x) => x[0]), ...retrying.map((x) => x[0])];
  const run = all.slice(0, limit).map(slugOf);
  return {
    run,
    neverRead: never.length,
    stale: stale.length,
    overdue: overdue.length,
    retrying: retrying.length,
    waiting,
    deferred: all.length - run.length,
  };
}

/** The retry file as written: one line per bill, sorted, bills the corpus no longer holds dropped. */
export function serializeRetries(retry, bills) {
  const held = new Set((Array.isArray(bills) ? bills : []).map(slugOf));
  const keys = Object.keys(retry ?? {}).filter((k) => held.has(k)).sort();
  if (keys.length === 0) return '{}\n';
  const lines = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify({ failures: retry[k].failures, last_tried: retry[k].last_tried, reason: retry[k].reason })}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

/**
 * The file as written: one line per bill, keys sorted, entries for bills the
 * corpus no longer holds dropped.
 * @param {Record<string, {titles: string[], as_of: string|null, read_on?: string|null}>} file
 * @param {any[]} bills
 */
export function serializeShortTitles(file, bills) {
  const held = new Set((Array.isArray(bills) ? bills : []).map(slugOf));
  const keys = Object.keys(file ?? {}).filter((k) => held.has(k)).sort();
  if (keys.length === 0) return '{}\n';
  const lines = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify({ titles: file[k].titles, as_of: file[k].as_of ?? null, read_on: file[k].read_on ?? null })}`);
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
 *   (a key the corpus no longer holds is a NOTE: unused, pruned on the next write);
 *   - an entry that is not exactly { titles, as_of, read_on };
 *   - `titles` not an array of distinct, non-empty strings of at most
 *     SHORT_TITLE_MAX_LENGTH characters with no control character, in
 *     code-point order;
 *   - `as_of` neither null nor a YYYY-MM-DD date; `read_on` not a date;
 *   - against the committed file (`before`): the bills carrying a short title
 *     fell by more than 10% (one bill losing its titles is a NOTE: the record
 *     can drop a short title, and the name goes with it). `allowDrop` (the
 *     one-run override a person sets for a real mass change) turns that one
 *     failure into a note; `dropFloor` says whether the floor was crossed.
 * @param {{ data: unknown, bills: any[], before?: unknown }} args
 * @returns {{ failures: string[], notes: string[] }}
 */
export function verifyShortTitles({ data, bills, before = null, allowDrop = false }) {
  const failures = [];
  const notes = [];
  /** @type {{ from: number, to: number } | null} */
  let dropFloor = null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { failures: [`${SHORT_TITLES_PATH} is not an object keyed by bill slug`], notes, dropFloor };
  }
  const held = new Set((Array.isArray(bills) ? bills : []).map(slugOf));
  let withTitles = 0;
  const notHeld = [];
  for (const [slug, entry] of Object.entries(data)) {
    if (!SLUG.test(slug)) {
      failures.push(`${SHORT_TITLES_PATH}: "${slug}" is not a bill slug`);
      continue;
    }
    // A bill the corpus no longer holds is a note, not damage: the name table
    // only walks the corpus's bills, and the next write prunes the entry.
    if (!held.has(slug)) notHeld.push(slug);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      failures.push(`${SHORT_TITLES_PATH}: ${slug} is not an object`);
      continue;
    }
    const keys = Object.keys(entry).sort().join(',');
    if (keys !== 'as_of,read_on,titles') failures.push(`${SHORT_TITLES_PATH}: ${slug} has fields [${keys}], expected [as_of,read_on,titles]`);
    if (!(typeof entry.read_on === 'string' && DATE.test(entry.read_on))) {
      failures.push(`${SHORT_TITLES_PATH}: ${slug} read_on is not a YYYY-MM-DD date`);
    }
    if (!(entry.as_of === null || (typeof entry.as_of === 'string' && DATE.test(entry.as_of)))) {
      failures.push(`${SHORT_TITLES_PATH}: ${slug} as_of is neither null nor a YYYY-MM-DD date`);
    }
    const titles = entry.titles;
    if (!Array.isArray(titles)) {
      failures.push(`${SHORT_TITLES_PATH}: ${slug} titles is not an array`);
      continue;
    }
    for (const t of titles) {
      const problem = shortTitleProblem(t);
      if (problem) failures.push(`${SHORT_TITLES_PATH}: ${slug} has ${problem}`);
    }
    const strings = titles.filter((t) => typeof t === 'string');
    if (new Set(strings).size !== strings.length) failures.push(`${SHORT_TITLES_PATH}: ${slug} repeats a title`);
    if (strings.join('\u0000') !== [...strings].sort().join('\u0000')) failures.push(`${SHORT_TITLES_PATH}: ${slug} titles are not in code-point order`);
    if (titles.length > 0) withTitles++;
  }
  notes.push(`${SHORT_TITLES_PATH}: ${Object.keys(data).length} bill(s) read, ${withTitles} with at least one short title`);
  if (notHeld.length) {
    notes.push(`${SHORT_TITLES_PATH}: ${notHeld.length} entr${notHeld.length === 1 ? 'y' : 'ies'} for a bill data/bills.json no longer holds (${notHeld.slice(0, 5).join(', ')}${notHeld.length > 5 ? ', …' : ''}); unused, and pruned on the next write`);
  }
  if (before && typeof before === 'object' && !Array.isArray(before)) {
    const had = Object.entries(before).filter(([, e]) => Array.isArray(e?.titles) && e.titles.length > 0);
    if (had.length >= 20 && withTitles < had.length * 0.9) {
      dropFloor = { from: had.length, to: withTitles };
      // THE ONE-RUN OVERRIDE for a real mass change (SHORT_TITLES_ALLOW_DROP,
      // set by a person on one manual run; never on a schedule): a note, not a failure.
      if (allowDrop) notes.push(`${SHORT_TITLES_PATH}: bills with a short title fell ${had.length} -> ${withTitles} (>10% overnight), let through by the one-run override`);
      else failures.push(`${SHORT_TITLES_PATH}: bills with a short title fell ${had.length} -> ${withTitles} (>10% overnight)`);
    }
    for (const [slug] of had) {
      if (!held.has(slug)) continue;
      const now = data[slug];
      if (now && Array.isArray(now.titles) && now.titles.length === 0) {
        // A whole, valid answer that no longer lists a short title: the record
        // dropped it, and a name must be a short title the record gives NOW
        // (hard rule 6). A failed read never gets here: it changes nothing.
        notes.push(`${SHORT_TITLES_PATH}: ${slug} had short titles and the record now gives it none`);
      }
    }
  }
  return { failures, notes, dropFloor };
}

/**
 * THE GATE for data/short-titles-retry.json (hard rule 11): an object keyed
 * by bill slug; each entry exactly { failures, last_tried, reason }: a whole
 * number from 1 to 1,000, a YYYY-MM-DD date, a non-empty reason of at most
 * 200 characters with no control character. A key the corpus no longer holds
 * is a note (pruned on the next write).
 * @param {{ data: unknown, bills: any[] }} args
 * @returns {{ failures: string[], notes: string[] }}
 */
export function verifyShortTitleRetries({ data, bills }) {
  const failures = [];
  const notes = [];
  const P = SHORT_TITLES_RETRY_PATH;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { failures: [`${P} is not an object keyed by bill slug`], notes };
  const held = new Set((Array.isArray(bills) ? bills : []).map(slugOf));
  let notHeld = 0;
  for (const [slug, e] of Object.entries(data)) {
    if (!SLUG.test(slug)) {
      failures.push(`${P}: "${slug}" is not a bill slug`);
      continue;
    }
    if (!held.has(slug)) notHeld++;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      failures.push(`${P}: ${slug} is not an object`);
      continue;
    }
    const keys = Object.keys(e).sort().join(',');
    if (keys !== 'failures,last_tried,reason') failures.push(`${P}: ${slug} has fields [${keys}], expected [failures,last_tried,reason]`);
    if (!(Number.isInteger(e.failures) && e.failures >= 1 && e.failures <= 1000)) failures.push(`${P}: ${slug} failures is not a whole number from 1 to 1000`);
    if (!(typeof e.last_tried === 'string' && DATE.test(e.last_tried))) failures.push(`${P}: ${slug} last_tried is not a YYYY-MM-DD date`);
    if (!(typeof e.reason === 'string' && e.reason.trim() !== '' && e.reason.length <= 200 && !CONTROL.test(e.reason))) {
      failures.push(`${P}: ${slug} reason is not a short line of text`);
    }
  }
  notes.push(`${P}: ${Object.keys(data).length} bill(s) waiting to be tried again`);
  if (notHeld) notes.push(`${P}: ${notHeld} entr${notHeld === 1 ? 'y' : 'ies'} for a bill data/bills.json no longer holds; pruned on the next write`);
  return { failures, notes };
}
