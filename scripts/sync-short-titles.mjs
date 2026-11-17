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
 * NO SILENT STOP, AND ONE SUMMARY A NIGHT. main() returns ONLY through
 * `finish()`, which every way out of the script reaches, the crash handler
 * included. finish() prints the run's TROUBLE line when it has a reason (a
 * non-zero exit always has one) and, every time, exactly one
 * "SHORT TITLES SUMMARY:" line (lib/short-titles-summary.mjs), the state-based
 * backstop the daily health report checks (lib/pipeline-health.mjs).
 * tests/short-titles-stalls.unit.spec.ts lists every outcome in a table and
 * fails when a `return` in main() does not go through finish(), when an
 * outcome has no row, or when the exit code is set anywhere else.
 *
 * THE HISTORY. data/short-titles-trend.json keeps the last 14 nights'
 * { day, titled, bills } so the summary can say how many bills had a name a
 * week ago. A missing (while the titles file exists) or damaged history is
 * started afresh with one TROUBLE line; it never stops the night.
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
 * Env, for a scratch fill or an offline test: SHORT_TITLES_FILE,
 * SHORT_TITLES_RETRY_FILE and SHORT_TITLES_TREND_FILE (write elsewhere), SHORT_TITLES_BILLS (read another
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
import {
  nextTrend,
  nightSummary,
  serializeTrend,
  SHORT_TITLES_TREND_PATH,
  summaryLine,
  verifyShortTitlesTrend,
} from '../lib/short-titles-summary.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const OUT = process.env.SHORT_TITLES_FILE || SHORT_TITLES_PATH;
const RETRY_OUT = process.env.SHORT_TITLES_RETRY_FILE || SHORT_TITLES_RETRY_PATH;
const TREND_OUT = process.env.SHORT_TITLES_TREND_FILE || SHORT_TITLES_TREND_PATH;
const BILLS = process.env.SHORT_TITLES_BILLS || 'data/bills.json';
const CAP = process.env.SHORT_TITLES_MAX ? Number(process.env.SHORT_TITLES_MAX) : SHORT_TITLES_MAX_PER_NIGHT;
const REQUEST_TIMEOUT_MS = Number(process.env.SHORT_TITLES_REQUEST_TIMEOUT_MS) || 20_000;
const BUDGET_MS = Number(process.env.SHORT_TITLES_BUDGET_MS) || 20 * 60_000;
const RETRY_DELAY_MS = Number(process.env.SHORT_TITLES_RETRY_DELAY_MS) || 2000;
const TODAY = /^\d{4}-\d{2}-\d{2}$/.test(process.env.SHORT_TITLES_TODAY ?? '') ? process.env.SHORT_TITLES_TODAY : new Date().toISOString().slice(0, 10);
/** The one-run override: set by a person on a manual run, never honoured on a schedule. */
const ALLOW_DROP = process.env.SHORT_TITLES_ALLOW_DROP === '1' && process.env.GITHUB_EVENT_NAME !== 'schedule';
const API = 'https://api.congress.gov/v3';

/** What the summary line will say, filled in as the run learns it (a crash prints what is known). */
const summary = { day: TODAY };

/** Print one TROUBLE line (and its annotation). Used for troubles that do not end the run; finish() prints the last one. */
function trouble(reason, { error = false } = {}) {
  console.log(`SHORT TITLES TROUBLE: ${reason}`);
  console.log(`::${error ? 'error' : 'warning'}::short titles: ${reason}`);
}

/**
 * THE ONLY WAY OUT. Prints the run's TROUBLE line when it has a reason (a
 * non-zero code without one still gets a line, so no exit is ever silent),
 * then exactly one SUMMARY line, then sets the exit code. Returns the code.
 */
function finish({ code, outcome, reason = null }) {
  if (reason) trouble(reason, { error: code !== 0 });
  else if (code !== 0) trouble(`the step ended with code ${code} and no reason (outcome ${outcome}); this is a bug in scripts/sync-short-titles.mjs`, { error: true });
  console.log(summaryLine({ ...summary, outcome }));
  process.exitCode = code;
  return code;
}

let requests = 0;

/**
 * One page: at most two requests, each with a ceiling. Messages never carry
 * the URL (the URL holds the key). A failure of the source or of access (no
 * answer in time, while connecting or while reading the body; a network
 * error; a 403; a 429; a 5xx; a 200 whose body is an HTML page) is a
 * TransportFailure: it counts toward the 10-in-a-row stop and never toward
 * "the source has changed". Any other answer is judged as this bill's.
 */
async function fetchPage(bill, offset) {
  const url = new URL(`${API}${billApiPath(bill, '/titles')}`);
  url.searchParams.set('limit', String(SHORT_TITLES_PAGE_SIZE));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('format', 'json');
  url.searchParams.set('api_key', process.env.CONGRESS_API_KEY ?? '');
  const timedOut = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';
  let last = 'no answer';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (requests >= SHORT_TITLES_MAX_REQUESTS) throw new OutOfRequests(`the night's ${SHORT_TITLES_MAX_REQUESTS}-request cap is spent`);
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    requests++;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      last = timedOut(e) ? `no answer within ${REQUEST_TIMEOUT_MS} ms` : 'network error';
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = `HTTP ${res.status}`;
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new TransportFailure(`HTTP ${res.status}: access refused (check CONGRESS_API_KEY)`);
    if (!res.ok) throw new Refused(`HTTP ${res.status}`);
    let text;
    try {
      text = await res.text();
    } catch (e) {
      last = timedOut(e) ? `the answer stopped arriving within ${REQUEST_TIMEOUT_MS} ms` : 'the connection broke while reading the answer';
      continue;
    }
    try {
      return JSON.parse(text);
    } catch {
      if (/html/i.test(res.headers.get('content-type') ?? '') || /^\s*</.test(text)) {
        throw new TransportFailure(`HTTP ${res.status} with an HTML page instead of an answer`);
      }
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
  let bills;
  try {
    bills = JSON.parse(readFileSync(BILLS, 'utf8'));
    if (!Array.isArray(bills)) throw new Error('not a list of bills');
  } catch (e) {
    return finish({ code: 1, outcome: 'corpus-unreadable', reason: `the corpus (${BILLS}) could not be read (${e?.message ?? e}), so 0 bills were read; nothing was written` });
  }
  summary.bills = bills.length;
  let before;
  try {
    before = readJsonFile(OUT);
  } catch (e) {
    return finish({ code: 1, outcome: 'titles-file-unreadable', reason: `${OUT} is not valid JSON (${e?.message ?? e}), so 0 bills were read; nothing was written. Restore it from git` });
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
  let trend;
  try {
    trend = readJsonFile(TREND_OUT);
    if (trend !== null && verifyShortTitlesTrend({ data: trend }).failures.length) throw new Error('not the expected shape');
  } catch (e) {
    trend = null;
    trouble(`${TREND_OUT} could not be used (${e?.message ?? e}); the 14-night history was started afresh, so "a week ago" is unknown for a week`);
  }
  if (trend === null && before !== null && existsSync(TREND_OUT) === false) {
    trouble(`${TREND_OUT} is missing while ${OUT} exists; the 14-night history was started afresh, so "a week ago" is unknown for a week`);
  }
  trend = trend ?? { nights: [] };
  Object.assign(summary, nightSummary({ day: TODAY, bills, titles: before, retry, trend, read: 0, lost: 0 }));

  if (!process.env.CONGRESS_API_KEY) {
    return finish({ code: 1, outcome: 'no-key', reason: 'CONGRESS_API_KEY is not set, so 0 bills could be read; nothing was written' });
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
  const settled = settleNight({ night, bills, before, allowDrop: ALLOW_DROP });
  for (const n of settled.notes) console.log(n);
  for (const f of settled.failures) console.error(`::error::${f}`);
  console.log(
    `short titles: ${requests} request(s), ${night.read} bill(s) read (${night.withTitles} with a short title, ${night.dropped} whose short titles the record dropped), ${night.changed} entr${night.changed === 1 ? 'y' : 'ies'} new or changed, ${night.failed} failed, ${Math.round((Date.now() - started) / 1000)} s`,
  );
  // The troubles that do not end the run print now; the one that sets a non-zero code is finish()'s reason.
  const ending = settled.code !== 0 ? settled.troubles.find((t) => t.error) ?? settled.troubles[settled.troubles.length - 1] : null;
  for (const t of settled.troubles) if (t !== ending) trouble(t.reason, { error: t.error });

  // What will stand after tonight: tonight's files when they are written, else what was there.
  const titlesAfter = settled.write?.titles ? JSON.parse(settled.write.text) : before ?? {};
  const retryAfter = settled.write ? JSON.parse(settled.write.retryText) : retry;
  Object.assign(summary, nightSummary({ day: TODAY, bills, titles: titlesAfter, retry: retryAfter, trend, read: night.read, lost: night.dropped }));
  const trendText = serializeTrend(nextTrend(trend, { day: TODAY, titled: summary.titled, bills: bills.length }));
  const outcome = !settled.write
    ? /would fall/.test(ending?.reason ?? '') ? 'drop-floor' : 'refused-by-gate'
    : night.sourceChanged ? 'source-changed' : night.trouble ? 'stopped-early' : 'done';

  if (DRY_RUN) {
    console.log('--dry-run: nothing written');
    return finish({ code: settled.code, outcome: 'dry-run', reason: ending?.reason ?? null });
  }
  const written = [];
  try {
    if (settled.write?.titles) {
      writeFileSync(OUT, settled.write.text);
      written.push(OUT);
    } else if (settled.write) console.log(`short titles: no bill read, so ${OUT} is left as it was`);
    if (settled.write) {
      const retryBefore = existsSync(RETRY_OUT) ? readFileSync(RETRY_OUT, 'utf8') : null;
      if (settled.write.retryText !== (retryBefore ?? '{}\n')) {
        writeFileSync(RETRY_OUT, settled.write.retryText);
        written.push(RETRY_OUT);
      }
    }
    writeFileSync(TREND_OUT, trendText);
    written.push(TREND_OUT);
  } catch (e) {
    const notWritten = [OUT, RETRY_OUT, TREND_OUT].filter((p) => !written.includes(p));
    return finish({
      code: 1,
      outcome: 'write-error',
      reason: `could not write the files (${e?.message ?? e}); written: ${written.length ? written.join(', ') : 'none'}; not written: ${notWritten.join(', ')} (${night.read} bill(s) read tonight)`,
    });
  }
  return finish({ code: settled.code, outcome, reason: ending?.reason ?? null });
}

main().catch((e) => finish({ code: 1, outcome: 'crashed', reason: `the step crashed (${e?.message ?? e}); nothing more was written` }));
