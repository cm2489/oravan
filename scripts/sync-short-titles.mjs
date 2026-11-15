/**
 * Nightly READ OF THE RECORD'S SHORT TITLES: data/short-titles.json.
 *
 *   node --env-file=.env.local scripts/sync-short-titles.mjs [--dry-run]
 *
 * Needs CONGRESS_API_KEY. No Anthropic key, no AI, no spend: one free
 * Congress.gov request per bill, /bill/{congress}/{type}/{number}/titles, and
 * the short titles the record itself labels as the bill's (lib/short-titles.mjs
 * says exactly which). They feed the name addresses
 * (oravan.org/continuing-appropriations-act-2027, lib/short-address.ts);
 * nothing a page prints reads them.
 *
 * WHICH BILLS. At most SHORT_TITLES_MAX_PER_NIGHT (500; the SHORT_TITLES_MAX
 * env var overrides it for a catch-up dispatch) a night: first every corpus
 * bill never read, most urgent first, then every bill whose last action moved
 * since its titles were read, then every bill not read for
 * SHORT_TITLES_REFRESH_DAYS (56), longest unread first. The first fill of a
 * 3,300-bill corpus takes about seven nights.
 *
 * WHAT A NIGHT CAN COST, from this file's own numbers. Each bill is at most
 * two requests (one retry, only on a 429, a 5xx, a timeout or a network
 * error), each with a 20-second ceiling: at most 1,000 requests a night
 * against the key's 5,000 an hour, and 500 on a night with no retry. The loop
 * stops after SHORT_TITLES_MAX_CONSECUTIVE_FAILURES (10) failed reads in a
 * row, or once SHORT_TITLES_BUDGET_MS (20 minutes) have passed, saying so in
 * one line; whatever was read before is still written, and the next night
 * resumes. sync-bills.yml also gives the step `timeout-minutes: 25`, and the
 * step is `continue-on-error`, so it can never hold or fail the night's bill
 * sync, its gates or its commit.
 *
 * WHAT A READ IS. lib/short-titles.mjs's readTitlesAnswer: an answer counts
 * only when it is plainly about THIS bill (its `request` names the same
 * congress, type and number), carries no error, and holds a non-empty list of
 * titles (every bill has an official title). Anything else is a failed read
 * and leaves what was stored untouched. A non-empty list with no title
 * labelled a short title is a bill with no short title, stored as [].
 *
 * WHAT IT NEVER DOES. Replace a bill's non-empty titles with none (the record
 * never takes a short title back; that answer is kept as a warning), write a
 * file the gate refuses (verifyShortTitles, which scripts/verify-sync.mjs runs
 * again before the commit), print the key or a URL that carries it, or touch
 * any other file.
 *
 * Env, for a scratch fill or an offline test: SHORT_TITLES_FILE (write
 * somewhere other than data/short-titles.json), SHORT_TITLES_BILLS (read
 * another corpus file), SHORT_TITLES_REQUEST_TIMEOUT_MS, SHORT_TITLES_BUDGET_MS,
 * SHORT_TITLES_RETRY_DELAY_MS.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { billApiPath, slugOf } from './congress-fetch.mjs';
import {
  planShortTitleReads,
  readTitlesAnswer,
  serializeShortTitles,
  SHORT_TITLES_MAX_CONSECUTIVE_FAILURES,
  SHORT_TITLES_MAX_PER_NIGHT,
  SHORT_TITLES_PATH,
  verifyShortTitles,
} from '../lib/short-titles.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const OUT = process.env.SHORT_TITLES_FILE || SHORT_TITLES_PATH;
const BILLS = process.env.SHORT_TITLES_BILLS || 'data/bills.json';
const CAP = process.env.SHORT_TITLES_MAX ? Number(process.env.SHORT_TITLES_MAX) : SHORT_TITLES_MAX_PER_NIGHT;
const REQUEST_TIMEOUT_MS = Number(process.env.SHORT_TITLES_REQUEST_TIMEOUT_MS) || 20_000;
const BUDGET_MS = Number(process.env.SHORT_TITLES_BUDGET_MS) || 20 * 60_000;
const RETRY_DELAY_MS = Number(process.env.SHORT_TITLES_RETRY_DELAY_MS) || 2000;
const API = 'https://api.congress.gov/v3';

let requests = 0;

/**
 * One bill's titles list: at most two requests, each with a ceiling. Throws a
 * plain Error whose message never carries the URL (the URL holds the key).
 */
async function fetchTitles(bill) {
  const key = process.env.CONGRESS_API_KEY;
  if (!key) throw new Error('CONGRESS_API_KEY missing');
  const url = new URL(`${API}${billApiPath(bill, '/titles')}`);
  url.searchParams.set('limit', '250');
  url.searchParams.set('format', 'json');
  url.searchParams.set('api_key', key);
  let last = 'no answer';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    requests++;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break; // a 4xx other than 429 will not change on a retry
    } catch (e) {
      last = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `no answer within ${REQUEST_TIMEOUT_MS} ms` : 'network error';
    }
  }
  throw new Error(last);
}

const started = Date.now();
const today = new Date().toISOString().slice(0, 10);
const bills = JSON.parse(readFileSync(BILLS, 'utf8'));
const file = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const before = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const bySlug = new Map(bills.map((b) => [slugOf(b), b]));

const plan = planShortTitleReads({ bills, file, cap: CAP, today });
console.log(
  `short titles: ${plan.neverRead} bill(s) never read, ${plan.stale} whose last action moved, ${plan.overdue} due for a refresh; reading ${plan.run.length} tonight (cap ${CAP}), ${plan.deferred} left for later nights`
);

let read = 0, changed = 0, kept = 0, failed = 0, consecutive = 0, withTitles = 0;
let stoppedBecause = null;
for (const slug of plan.run) {
  if (Date.now() - started > BUDGET_MS) {
    stoppedBecause = `the step's ${Math.round(BUDGET_MS / 60_000)}-minute budget ran out`;
    break;
  }
  const bill = bySlug.get(slug);
  let verdict;
  try {
    verdict = readTitlesAnswer(await fetchTitles(bill), bill);
  } catch (e) {
    verdict = { ok: false, reason: e?.message ?? 'failed' };
  }
  if (!verdict.ok) {
    failed++;
    consecutive++;
    console.log(`  ${slug}: not read (${verdict.reason}); what was stored is unchanged`);
    if (consecutive >= SHORT_TITLES_MAX_CONSECUTIVE_FAILURES) {
      stoppedBecause = `${consecutive} reads in a row failed`;
      break;
    }
    continue;
  }
  consecutive = 0;
  read++;
  const titles = verdict.titles;
  const old = file[slug];
  if (old && Array.isArray(old.titles) && old.titles.length > 0 && titles.length === 0) {
    kept++;
    console.log(`::warning::${slug}: the record answered with no short title where it had ${old.titles.length}; kept the earlier ones`);
    file[slug] = { titles: old.titles, as_of: bill.last_action_date ?? null, read_on: today };
    continue;
  }
  if (!old || JSON.stringify(old.titles) !== JSON.stringify(titles)) changed++;
  if (titles.length) withTitles++;
  file[slug] = { titles, as_of: bill.last_action_date ?? null, read_on: today };
}
if (stoppedBecause) {
  console.log(`::warning::short titles: stopped early because ${stoppedBecause}; ${read} bill(s) read are kept, the rest wait for the next night`);
}

const text = serializeShortTitles(file, bills);
const { failures, notes } = verifyShortTitles({ data: JSON.parse(text), bills, before });
for (const n of notes) console.log(n);
console.log(
  `short titles: ${requests} request(s), ${read} bill(s) read (${withTitles} with a short title), ${changed} entr${changed === 1 ? 'y' : 'ies'} new or changed, ${kept} kept over an empty answer, ${failed} failed, ${Math.round((Date.now() - started) / 1000)} s`
);
if (failures.length) {
  for (const f of failures) console.error(`::error::${f}`);
  console.error(`::error::${OUT} not written: the gate refused it`);
  process.exit(1);
}
if (DRY_RUN) console.log('--dry-run: nothing written');
else if (read > 0) writeFileSync(OUT, text);
else console.log(`short titles: no bill read, so ${OUT} is left as it was`);
