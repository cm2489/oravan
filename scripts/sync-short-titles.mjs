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
 * THE NIGHT ITSELF is lib/short-titles-night.mjs's runShortTitlesNight: which
 * bills, what counts as a read, what stops the night, and how a failed bill
 * backs off. This file is only the I/O around it: it reads the files, talks to
 * Congress.gov, runs the gate and writes.
 *
 * WHAT A NIGHT CAN COST, from these files' own numbers: at most 300 bills
 * (SHORT_TITLES_MAX_PER_NIGHT; SHORT_TITLES_MAX overrides it for a catch-up
 * dispatch), at most 400 requests (SHORT_TITLES_MAX_REQUESTS), pages of 250
 * titles up to 4 a bill, one retry a request (only on a 429, a 5xx, a timeout
 * or a network error), 20 seconds a request, 20 minutes a night; the workflow
 * step has `timeout-minutes: 25` and `continue-on-error`.
 *
 * NO SILENT STOP. Every way this script ends a night early, refuses to write,
 * or exits non-zero goes through `trouble()` and `finish()` below and prints
 * one line starting "SHORT TITLES TROUBLE:" with a plain reason and its
 * count; lib/pipeline-health.mjs reads that line into the daily digest's
 * alarms. tests/short-titles.unit.spec.ts lists every such path in a table and
 * fails when this file sets an exit code anywhere but `finish()`.
 *
 * THE ONE-RUN OVERRIDE. When the record really drops short titles from more
 * than a tenth of the titled bills in one night, the gate's floor refuses the
 * file (hard rule 11's count-drop protection) and says so. A person lets one
 * run through by dispatching the nightly by hand with the input
 * `short_titles_allow_drop` ticked (the workflow then sets
 * SHORT_TITLES_ALLOW_DROP=1 for this step and verify-sync only, on that run
 * only). It is ignored on a scheduled run (GITHUB_EVENT_NAME=schedule), and
 * nothing in the record can set it.
 *
 * Env, for a scratch fill or an offline test: SHORT_TITLES_FILE and
 * SHORT_TITLES_RETRY_FILE (write elsewhere), SHORT_TITLES_BILLS (read another
 * corpus file), SHORT_TITLES_TODAY (the day, YYYY-MM-DD),
 * SHORT_TITLES_REQUEST_TIMEOUT_MS, SHORT_TITLES_BUDGET_MS,
 * SHORT_TITLES_RETRY_DELAY_MS.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { billApiPath } from './congress-fetch.mjs';
import {
  SHORT_TITLES_MAX_PER_NIGHT,
  SHORT_TITLES_MAX_REQUESTS,
  SHORT_TITLES_PAGE_SIZE,
  SHORT_TITLES_PATH,
  SHORT_TITLES_RETRY_PATH,
} from '../lib/short-titles.mjs';
import { OutOfRequests, Refused, runShortTitlesNight, settleNight, TransportFailure } from '../lib/short-titles-night.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const OUT = process.env.SHORT_TITLES_FILE || SHORT_TITLES_PATH;
const RETRY_OUT = process.env.SHORT_TITLES_RETRY_FILE || SHORT_TITLES_RETRY_PATH;
const BILLS = process.env.SHORT_TITLES_BILLS || 'data/bills.json';
const CAP = process.env.SHORT_TITLES_MAX ? Number(process.env.SHORT_TITLES_MAX) : SHORT_TITLES_MAX_PER_NIGHT;
const REQUEST_TIMEOUT_MS = Number(process.env.SHORT_TITLES_REQUEST_TIMEOUT_MS) || 20_000;
const BUDGET_MS = Number(process.env.SHORT_TITLES_BUDGET_MS) || 20 * 60_000;
const RETRY_DELAY_MS = Number(process.env.SHORT_TITLES_RETRY_DELAY_MS) || 2000;
const TODAY = /^\d{4}-\d{2}-\d{2}$/.test(process.env.SHORT_TITLES_TODAY ?? '') ? process.env.SHORT_TITLES_TODAY : new Date().toISOString().slice(0, 10);
/** The one-run override: set by a person on a manual run, never honoured on a schedule. */
const ALLOW_DROP = process.env.SHORT_TITLES_ALLOW_DROP === '1' && process.env.GITHUB_EVENT_NAME !== 'schedule';
const API = 'https://api.congress.gov/v3';

/** Print one TROUBLE line (and its annotation). Every early stop or refusal goes through here. */
function trouble(reason, { error = false } = {}) {
  console.log(`SHORT TITLES TROUBLE: ${reason}`);
  console.log(`::${error ? 'error' : 'warning'}::short titles: ${reason}`);
}

/** The ONLY place this file sets its exit code. */
function finish(code) {
  process.exitCode = code;
}

let requests = 0;

/** One page: at most two requests, each with a ceiling. Messages never carry the URL (the URL holds the key). */
async function fetchPage(bill, offset) {
  const url = new URL(`${API}${billApiPath(bill, '/titles')}`);
  url.searchParams.set('limit', String(SHORT_TITLES_PAGE_SIZE));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('format', 'json');
  url.searchParams.set('api_key', process.env.CONGRESS_API_KEY ?? '');
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

/** Read a JSON file, or null when it does not exist. Throws with the parse error's message. */
function readJsonFile(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  const started = Date.now();
  if (!process.env.CONGRESS_API_KEY) {
    trouble('CONGRESS_API_KEY is not set, so 0 bills could be read; nothing was written', { error: true });
    return 1;
  }
  let bills;
  try {
    bills = JSON.parse(readFileSync(BILLS, 'utf8'));
    if (!Array.isArray(bills)) throw new Error('not a list of bills');
  } catch (e) {
    trouble(`the corpus (${BILLS}) could not be read (${e?.message ?? e}), so 0 bills were read; nothing was written`, { error: true });
    return 1;
  }
  let before;
  try {
    before = readJsonFile(OUT);
  } catch (e) {
    trouble(`${OUT} is not valid JSON (${e?.message ?? e}), so 0 bills were read; nothing was written. Restore it from git`, { error: true });
    return 1;
  }
  let retry;
  try {
    retry = readJsonFile(RETRY_OUT) ?? {};
  } catch (e) {
    retry = {};
    trouble(`${RETRY_OUT} is not valid JSON (${e?.message ?? e}); it was started afresh, so bills that were waiting may be tried again tonight`);
  }
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) {
    retry = {};
    trouble(`${RETRY_OUT} is not an object; it was started afresh, so bills that were waiting may be tried again tonight`);
  }

  const night = await runShortTitlesNight({
    bills,
    file: before ?? {},
    retry,
    today: TODAY,
    cap: CAP,
    fetchPage,
    budgetMs: BUDGET_MS,
  });
  for (const line of night.lines) console.log(line);
  const settled = settleNight({
    night,
    bills,
    before,
    allowDrop: ALLOW_DROP,
  });
  for (const n of settled.notes) console.log(n);
  for (const f of settled.failures) console.error(`::error::${f}`);
  console.log(
    `short titles: ${requests} request(s), ${night.read} bill(s) read (${night.withTitles} with a short title, ${night.dropped} whose short titles the record dropped), ${night.changed} entr${night.changed === 1 ? 'y' : 'ies'} new or changed, ${night.failed} failed, ${Math.round((Date.now() - started) / 1000)} s`,
  );
  for (const t of settled.troubles) trouble(t.reason, { error: t.error });
  if (!settled.write) return settled.code;
  if (DRY_RUN) {
    console.log('--dry-run: nothing written');
    return settled.code;
  }
  try {
    if (settled.write.titles) writeFileSync(OUT, settled.write.text);
    else console.log(`short titles: no bill read, so ${OUT} is left as it was`);
    const retryBefore = existsSync(RETRY_OUT) ? readFileSync(RETRY_OUT, 'utf8') : null;
    if (settled.write.retryText !== (retryBefore ?? '{}\n')) writeFileSync(RETRY_OUT, settled.write.retryText);
  } catch (e) {
    trouble(`could not write the files (${e?.message ?? e}); ${night.read} bill(s) read tonight are lost`, { error: true });
    return 1;
  }
  return settled.code;
}

main().then(finish, (e) => {
  trouble(`the step crashed (${e?.message ?? e}); nothing was written`, { error: true });
  finish(1);
});
