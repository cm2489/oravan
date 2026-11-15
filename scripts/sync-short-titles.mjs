/**
 * Nightly READ OF THE RECORD'S SHORT TITLES: data/short-titles.json, with the
 * bills whose last read failed in data/short-titles-retry.json.
 *
 *   node --env-file=.env.local scripts/sync-short-titles.mjs [--dry-run]
 *
 * Needs CONGRESS_API_KEY. No Anthropic key, no AI, no spend: Congress.gov's
 * free titles list for each bill, /bill/{congress}/{type}/{number}/titles, and
 * the short titles the record itself labels as the bill's (lib/short-titles.mjs
 * says exactly which). They feed the name addresses
 * (oravan.org/continuing-appropriations-act-2027, lib/short-address.ts);
 * nothing a page prints reads them.
 *
 * WHICH BILLS (planShortTitleReads). At most SHORT_TITLES_MAX_PER_NIGHT (500;
 * the SHORT_TITLES_MAX env var overrides it for a catch-up dispatch) a night:
 * every bill never read, most urgent first; then every bill whose last action
 * moved; then every bill not read for 56 days; and LAST the bills whose
 * previous read failed and whose wait is over. A bill that fails is written
 * to the retry file with its failure count and the day, and waits 1, 2, 4, 8,
 * 16, then 32 days before it is tried again, at the back of the queue. So no
 * set of bills that always fail can head the queue night after night.
 *
 * WHAT A NIGHT CAN COST, from this file's own numbers. A bill's list comes in
 * pages of 250 titles, at most 4 pages (1,000 titles; a bill with more is that
 * bill's failure, with its own line). Each request is retried once, only on a
 * 429, a 5xx, a timeout or a network error, and has a 20-second ceiling. The
 * night stops at SHORT_TITLES_MAX_REQUESTS (1,200) requests, against the key's
 * 5,000 an hour; in practice one request a bill, about 500.
 *
 * WHEN IT STOPS EARLY, always with one line starting "SHORT TITLES TROUBLE:",
 * which lib/pipeline-health.mjs reads into the daily digest's alarms:
 *   - 10 TRANSPORT failures in a row (no answer, a network error, a 429 or a
 *     5xx): the source is down. An answer that arrived and was refused (empty,
 *     incomplete, about another bill, a 404, reshaped) is that bill's own
 *     failure and never counts toward this;
 *   - the source has changed: once 20 answers have arrived, more than half
 *     of them refused for one and the same reason. No bill is marked failed for
 *     that night's refusals, and the step exits 1 (it stays continue-on-error);
 *   - the 20-minute budget or the request cap ran out.
 * What was read before the stop is still written, and the next night resumes.
 * sync-bills.yml gives the step `timeout-minutes: 25` and `continue-on-error`,
 * so it can never hold or fail the night's bill sync, its gates or its commit.
 *
 * WHAT A READ IS. lib/short-titles.mjs's readTitlesAnswer, on the assembled
 * pages: about THIS bill (`request` names the same congress, type and number,
 * on every page), no error, a non-empty list (every bill has an official
 * title), and exactly as many titles as `pagination.count` says. A failed read
 * changes nothing in data/short-titles.json. A whole answer with no title
 * labelled short is stored as [], also when the bill had short titles before:
 * the record has dropped them, and a name must be a short title the record
 * gives the bill now (hard rule 6).
 *
 * WHAT IT NEVER DOES: write a file its gate refuses (verifyShortTitles and
 * verifyShortTitleRetries, which scripts/verify-sync.mjs runs again before the
 * commit), print the key or a URL that carries it, or touch any other file.
 *
 * Env, for a scratch fill or an offline test: SHORT_TITLES_FILE and
 * SHORT_TITLES_RETRY_FILE (write elsewhere), SHORT_TITLES_BILLS (read another
 * corpus file), SHORT_TITLES_TODAY (the day, YYYY-MM-DD),
 * SHORT_TITLES_REQUEST_TIMEOUT_MS, SHORT_TITLES_BUDGET_MS,
 * SHORT_TITLES_RETRY_DELAY_MS.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { billApiPath, slugOf } from './congress-fetch.mjs';
import {
  planShortTitleReads,
  readTitlesAnswer,
  serializeRetries,
  serializeShortTitles,
  SHORT_TITLES_MAX_CONSECUTIVE_FAILURES,
  SHORT_TITLES_MAX_PAGES,
  SHORT_TITLES_MAX_PER_NIGHT,
  SHORT_TITLES_MAX_REQUESTS,
  SHORT_TITLES_PAGE_SIZE,
  SHORT_TITLES_PATH,
  SHORT_TITLES_RETRY_PATH,
  SOURCE_CHANGE_MIN_ANSWERS,
  verifyShortTitleRetries,
  verifyShortTitles,
} from '../lib/short-titles.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const OUT = process.env.SHORT_TITLES_FILE || SHORT_TITLES_PATH;
const RETRY_OUT = process.env.SHORT_TITLES_RETRY_FILE || SHORT_TITLES_RETRY_PATH;
const BILLS = process.env.SHORT_TITLES_BILLS || 'data/bills.json';
const CAP = process.env.SHORT_TITLES_MAX ? Number(process.env.SHORT_TITLES_MAX) : SHORT_TITLES_MAX_PER_NIGHT;
const REQUEST_TIMEOUT_MS = Number(process.env.SHORT_TITLES_REQUEST_TIMEOUT_MS) || 20_000;
const BUDGET_MS = Number(process.env.SHORT_TITLES_BUDGET_MS) || 20 * 60_000;
const RETRY_DELAY_MS = Number(process.env.SHORT_TITLES_RETRY_DELAY_MS) || 2000;
const TODAY = /^\d{4}-\d{2}-\d{2}$/.test(process.env.SHORT_TITLES_TODAY ?? '') ? process.env.SHORT_TITLES_TODAY : new Date().toISOString().slice(0, 10);
const API = 'https://api.congress.gov/v3';

let requests = 0;

/** A failure of the source itself, not of the bill: it counts toward the breaker. */
class TransportFailure extends Error {}
/** An answer that arrived and is not usable for this bill: the bill's own failure. */
class Refused extends Error {}
/** Tonight's request cap is spent. */
class OutOfRequests extends Error {}

/**
 * One page: at most two requests, each with a ceiling. Messages never carry
 * the URL (the URL holds the key).
 */
async function fetchPage(bill, offset) {
  const key = process.env.CONGRESS_API_KEY;
  if (!key) throw new TransportFailure('CONGRESS_API_KEY missing');
  const url = new URL(`${API}${billApiPath(bill, '/titles')}`);
  url.searchParams.set('limit', String(SHORT_TITLES_PAGE_SIZE));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('format', 'json');
  url.searchParams.set('api_key', key);
  let last = 'no answer';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (requests >= SHORT_TITLES_MAX_REQUESTS) throw new OutOfRequests(`the night's ${SHORT_TITLES_MAX_REQUESTS}-request cap is spent`);
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    requests++;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      last = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `no answer within ${REQUEST_TIMEOUT_MS} ms` : 'network error';
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = `HTTP ${res.status}`;
      continue;
    }
    if (!res.ok) throw new Refused(`HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Refused('the answer is not JSON');
    }
  }
  throw new TransportFailure(last);
}

/** Every page of one bill's list, assembled, then judged as one answer. */
async function readBill(bill) {
  const first = await fetchPage(bill, 0);
  const judgedFirst = readTitlesAnswer(first, bill);
  // A whole first page, or a refusal that more pages cannot fix: done.
  if (judgedFirst.ok || !Array.isArray(first?.titles) || !/incomplete/.test(judgedFirst.reason)) return judgedFirst;
  const raw = first.pagination?.count;
  const count = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  const pages = Math.ceil(count / SHORT_TITLES_PAGE_SIZE);
  if (!(pages > 1)) return judgedFirst;
  if (pages > SHORT_TITLES_MAX_PAGES) {
    return { ok: false, reason: `the bill has ${count} titles, more than the ${SHORT_TITLES_MAX_PAGES * SHORT_TITLES_PAGE_SIZE} this step reads` };
  }
  const titles = [...first.titles];
  for (let page = 1; page < pages; page++) {
    const next = await fetchPage(bill, page * SHORT_TITLES_PAGE_SIZE);
    const judged = readTitlesAnswer({ ...next, pagination: { count: Array.isArray(next?.titles) ? next.titles.length : -1 } }, bill);
    if (!judged.ok) return { ok: false, reason: `page ${page + 1}: ${judged.reason}` };
    titles.push(...next.titles);
  }
  return readTitlesAnswer({ ...first, titles }, bill);
}

const started = Date.now();
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const bills = JSON.parse(readFileSync(BILLS, 'utf8'));
const before = readJson(OUT);
const file = before ? structuredClone(before) : {};
const retry = readJson(RETRY_OUT) ?? {};
const bySlug = new Map(bills.map((b) => [slugOf(b), b]));

const plan = planShortTitleReads({ bills, file, retry, cap: CAP, today: TODAY });
console.log(
  `short titles: ${plan.neverRead} bill(s) never read, ${plan.stale} whose last action moved, ${plan.overdue} due for a refresh, ${plan.retrying} failed before and due again, ${plan.waiting} failed and still waiting; reading ${plan.run.length} tonight (cap ${CAP}), ${plan.deferred} left for later nights`
);

let read = 0, changed = 0, dropped = 0, failed = 0, consecutiveTransport = 0, withTitles = 0, answers = 0;
const refusedByReason = new Map();
/** Tonight's per-bill failures, written to the retry file unless the source changed. */
const failedTonight = new Map();
let trouble = null;
let sourceChanged = false;
for (const slug of plan.run) {
  if (Date.now() - started > BUDGET_MS) {
    trouble = `stopped early: the step's ${Math.round(BUDGET_MS / 60_000)}-minute budget ran out`;
    break;
  }
  const bill = bySlug.get(slug);
  let verdict;
  try {
    verdict = await readBill(bill);
    answers++;
  } catch (e) {
    if (e instanceof OutOfRequests) {
      trouble = `stopped early: ${e.message}`;
      break;
    }
    if (e instanceof Refused) {
      answers++;
      verdict = { ok: false, reason: e.message };
    } else {
      failed++;
      consecutiveTransport++;
      failedTonight.set(slug, e?.message ?? 'no answer');
      console.log(`  ${slug}: not read (${e?.message ?? 'no answer'}); what was stored is unchanged`);
      if (consecutiveTransport >= SHORT_TITLES_MAX_CONSECUTIVE_FAILURES) {
        trouble = `stopped early: ${consecutiveTransport} requests in a row got no usable answer from Congress.gov (the source is down)`;
        break;
      }
      continue;
    }
  }
  consecutiveTransport = 0;
  if (!verdict.ok) {
    failed++;
    failedTonight.set(slug, verdict.reason);
    // One reason per kind: the counts that tell a reshaped API from a few odd bills.
    const kind = verdict.reason.replace(/\(\d+ of \d+\)|\d+/g, '#');
    refusedByReason.set(kind, (refusedByReason.get(kind) ?? 0) + 1);
    console.log(`  ${slug}: not read (${verdict.reason}); what was stored is unchanged`);
    const [topReason, topCount] = [...refusedByReason].sort((a, b) => b[1] - a[1])[0];
    if (answers >= SOURCE_CHANGE_MIN_ANSWERS && topCount * 2 > answers) {
      sourceChanged = true;
      trouble = `the source has changed: ${topCount} of ${answers} answers tonight were refused for the same reason ("${topReason}"); stopped, and no bill is marked as failed for it`;
      break;
    }
    continue;
  }
  read++;
  delete retry[slug];
  const titles = verdict.titles;
  const old = file[slug];
  if (old && Array.isArray(old.titles) && old.titles.length > 0 && titles.length === 0) {
    dropped++;
    console.log(`::warning::${slug}: the record's whole titles list no longer gives a short title (it had ${old.titles.length}); its name stops resolving`);
  }
  if (!old || JSON.stringify(old.titles) !== JSON.stringify(titles)) changed++;
  if (titles.length) withTitles++;
  file[slug] = { titles, as_of: bill.last_action_date ?? null, read_on: TODAY };
}

if (!sourceChanged) {
  for (const [slug, reason] of failedTonight) {
    const prev = retry[slug];
    retry[slug] = { failures: Math.min((prev?.failures ?? 0) + 1, 1000), last_tried: TODAY, reason: reason.slice(0, 200) };
  }
}
if (trouble) {
  console.log(`SHORT TITLES TROUBLE: ${trouble}; ${read} bill(s) read before it are kept`);
  console.log(`::${sourceChanged ? 'error' : 'warning'}::short titles: ${trouble}`);
}

const text = serializeShortTitles(file, bills);
const retryText = serializeRetries(retry, bills);
const verdictTitles = verifyShortTitles({ data: JSON.parse(text), bills, before });
const verdictRetry = verifyShortTitleRetries({ data: JSON.parse(retryText), bills });
for (const n of [...verdictTitles.notes, ...verdictRetry.notes]) console.log(n);
console.log(
  `short titles: ${requests} request(s), ${read} bill(s) read (${withTitles} with a short title, ${dropped} whose short titles the record dropped), ${changed} entr${changed === 1 ? 'y' : 'ies'} new or changed, ${failed} failed, ${Math.round((Date.now() - started) / 1000)} s`
);
const failures = [...verdictTitles.failures, ...verdictRetry.failures];
if (failures.length) {
  for (const f of failures) console.error(`::error::${f}`);
  console.error(`::error::${OUT} and ${RETRY_OUT} not written: the gate refused them`);
  process.exit(1);
}
if (DRY_RUN) console.log('--dry-run: nothing written');
else {
  if (read > 0) writeFileSync(OUT, text);
  else console.log(`short titles: no bill read, so ${OUT} is left as it was`);
  const retryBefore = existsSync(RETRY_OUT) ? readFileSync(RETRY_OUT, 'utf8') : null;
  if (retryText !== (retryBefore ?? '{}\n')) writeFileSync(RETRY_OUT, retryText);
}
if (sourceChanged) process.exit(1);
