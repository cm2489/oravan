/*
 * ONE NIGHT OF THE SHORT-TITLES READ, as a function (2026-11-15).
 *
 * scripts/sync-short-titles.mjs is the I/O around this: it reads the files,
 * hands in a `fetchPage` that talks to Congress.gov, and writes what comes
 * back. Keeping the night itself here, with the network passed in, is what
 * lets tests/short-titles.unit.spec.ts drive a hundred and twenty nights in a
 * second and check that no input the record can send stalls the read for
 * good.
 *
 * THE RULES IT KEEPS (each pinned by a test):
 *   - PER-BILL PROBLEMS STAY PER-BILL. An answer that arrived and is refused
 *     (about another bill, reshaped, empty, incomplete, a 404, a short title
 *     the file's own gate would refuse) fails THAT bill: it keeps what it had,
 *     goes to the retry file and backs off. Nothing about one bill can stop
 *     the others.
 *   - ONLY THE SOURCE STOPS THE NIGHT: 10 transport failures in a row (no
 *     answer, a network error, a 429, a 5xx), the request cap, the time budget,
 *     or the source having changed. Every stop is a `trouble` the script
 *     prints as one "SHORT TITLES TROUBLE:" line.
 *   - THE SOURCE HAS CHANGED when, over the whole night, among the answers from
 *     bills that were NOT already waiting in the retry file, at least 20
 *     arrived and more than half of them were refused for one and the same
 *     reason. Bills retrying never count toward it, and it is judged at the end
 *     of the night, so a run of bad bills at the head of the queue cannot trip
 *     it before the healthy bills behind them answer.
 *   - BILLS PILING UP: settleNight says so every night while the retry file
 *     holds more than a tenth of the corpus (and more than 50 bills), whatever
 *     the cause.
 *   - EVERY BILL REFUSED TONIGHT IS RECORDED, also on a night that stopped
 *     early, so it backs off and moves behind healthy bills.
 */
import {
  planShortTitleReads,
  readTitlesAnswer,
  serializeRetries,
  serializeShortTitles,
  verifyShortTitleRetries,
  verifyShortTitles,
  SHORT_TITLES_MAX_CONSECUTIVE_FAILURES,
  SHORT_TITLES_MAX_PAGES,
  SHORT_TITLES_MAX_PER_NIGHT,
  SHORT_TITLES_PAGE_SIZE,
  SOURCE_CHANGE_MIN_ANSWERS,
} from './short-titles.mjs';
import { trendFileWarnings } from './short-titles-summary.mjs';

/** A failure of the source itself, not of the bill: it counts toward the breaker. */
export class TransportFailure extends Error {}
/** An answer that arrived and is not usable for this bill: the bill's own failure. */
export class Refused extends Error {}
/** Tonight's request cap is spent. */
export class OutOfRequests extends Error {}
/** The step's time budget ran out between two pages of one bill (2026-11-18). */
export class OutOfTime extends Error {}

const slugOf = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

/** Every page of one bill's list, assembled, then judged as one answer. */
export async function readBill(bill, fetchPage, outOfTime = () => false) {
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
    // The budget is checked between PAGES too, not only between bills: four slow pages of one bill must
    // not carry the step past its own ceiling (the news desk's step is killed at 3 minutes).
    if (outOfTime()) throw new OutOfTime('the budget ran out between two pages of one bill');
    const next = await fetchPage(bill, page * SHORT_TITLES_PAGE_SIZE);
    const judged = readTitlesAnswer({ ...next, pagination: { count: Array.isArray(next?.titles) ? next.titles.length : -1 } }, bill);
    if (!judged.ok) return { ok: false, reason: `page ${page + 1}: ${judged.reason}` };
    titles.push(...next.titles);
  }
  return readTitlesAnswer({ ...first, titles }, bill);
}

/**
 * Run one night. Pure apart from `fetchPage(bill, offset)` (which resolves to
 * the parsed answer or throws TransportFailure, Refused or OutOfRequests) and
 * `now()`. Never throws for anything a bill or the source does.
 * @returns {Promise<{ file: object, retry: object, read: number, changed: number, dropped: number,
 *   failed: number, withTitles: number, trouble: string | null, sourceChanged: boolean, lines: string[] }>}
 */
export async function runShortTitlesNight({
  bills,
  file: fileIn,
  retry: retryIn,
  today,
  cap = SHORT_TITLES_MAX_PER_NIGHT,
  fetchPage,
  budgetMs = 20 * 60_000,
  now = () => Date.now(),
}) {
  const started = now();
  const file = structuredClone(fileIn ?? {});
  const retry = structuredClone(retryIn ?? {});
  const waitingAtStart = new Set(Object.keys(retry));
  const bySlug = new Map(bills.map((b) => [slugOf(b), b]));
  const lines = [];
  const plan = planShortTitleReads({ bills, file, retry, cap, today });
  if (plan.futureDated) {
    lines.push(`::warning::short titles: ${plan.futureDated} retry entr${plan.futureDated === 1 ? 'y was' : 'ies were'} dated after today; treated as due now`);
  }
  lines.push(
    `short titles: ${plan.neverRead} bill(s) never read, ${plan.stale} whose last action moved, ${plan.overdue} due for a refresh, ${plan.retrying} failed before and due again, ${plan.waiting} failed and still waiting; reading ${plan.run.length} tonight (cap ${cap}), ${plan.deferred} left for later nights`,
  );

  let read = 0, changed = 0, dropped = 0, failed = 0, consecutiveTransport = 0, withTitles = 0, freshAnswers = 0;
  const refusedByReason = new Map();
  const failedTonight = new Map();
  let trouble = null;
  let sourceChanged = false;
  /** The reasons of the transport failures in the current unbroken run, for the stop's own words. */
  const transportRun = [];

  for (const slug of plan.run) {
    if (now() - started > budgetMs) {
      trouble = `stopped early: the step's ${Math.round(budgetMs / 60_000)}-minute budget ran out`;
      break;
    }
    const bill = bySlug.get(slug);
    const fresh = !waitingAtStart.has(slug);
    let verdict;
    try {
      verdict = await readBill(bill, fetchPage, () => now() - started > budgetMs);
    } catch (e) {
      if (e instanceof OutOfRequests) {
        trouble = `stopped early: ${e.message}`;
        break;
      }
      if (e instanceof OutOfTime) {
        trouble = `stopped early: the step's ${Math.round(budgetMs / 60_000)}-minute budget ran out (between two pages of one bill)`;
        break;
      }
      if (e instanceof Refused) {
        verdict = { ok: false, reason: e.message };
      } else {
        failed++;
        consecutiveTransport++;
        transportRun.push(e?.message ?? 'no answer');
        failedTonight.set(slug, e?.message ?? 'no answer');
        lines.push(`  ${slug}: not read (${e?.message ?? 'no answer'}); what was stored is unchanged`);
        if (consecutiveTransport >= SHORT_TITLES_MAX_CONSECUTIVE_FAILURES) {
          trouble = stopReason(consecutiveTransport, transportRun);
          break;
        }
        continue;
      }
    }
    consecutiveTransport = 0;
    transportRun.length = 0;
    if (fresh) freshAnswers++;
    if (!verdict.ok) {
      failed++;
      failedTonight.set(slug, verdict.reason);
      lines.push(`  ${slug}: not read (${verdict.reason}); what was stored is unchanged`);
      if (fresh) {
        // One kind per reason, the HTTP status kept ("HTTP 404"), only the counts of an incomplete list folded.
        const kind = verdict.reason.replace(/\(\d+ of \d+\)/g, '(# of #)').replace(/: .*$/, '');
        refusedByReason.set(kind, (refusedByReason.get(kind) ?? 0) + 1);
      }
      continue;
    }
    read++;
    delete retry[slug];
    const titles = verdict.titles;
    const old = file[slug];
    if (old && Array.isArray(old.titles) && old.titles.length > 0 && titles.length === 0) {
      dropped++;
      lines.push(`::warning::${slug}: the record's whole titles list no longer gives a short title (it had ${old.titles.length}); its name stops resolving`);
    }
    if (!old || JSON.stringify(old.titles) !== JSON.stringify(titles)) changed++;
    if (titles.length) withTitles++;
    file[slug] = { titles, as_of: bill.last_action_date ?? null, read_on: today };
  }

  // THE SOURCE HAS CHANGED, judged on the whole night (never partway, where a
  // run of new bad bills at the head of the queue would look like a reshaped
  // source): among tonight's answers from bills that were NOT already waiting
  // in the retry file, at least SOURCE_CHANGE_MIN_ANSWERS arrived and more than
  // half were refused for one and the same reason.
  const top = [...refusedByReason].sort((a, b) => b[1] - a[1])[0];
  if (top && freshAnswers >= SOURCE_CHANGE_MIN_ANSWERS && top[1] * 2 > freshAnswers) {
    sourceChanged = true;
    const change = `the source has changed: ${top[1]} of ${freshAnswers} answers tonight from bills not already retrying were refused for the same reason ("${top[0]}")`;
    trouble = trouble ? `${change}; and ${trouble}` : change;
  }

  // Every bill refused tonight backs off, also on a night that stopped early,
  // so it moves behind healthy bills instead of heading the queue again.
  for (const [slug, reason] of failedTonight) {
    const prev = retry[slug];
    retry[slug] = { failures: Math.min((prev?.failures ?? 0) + 1, 1000), last_tried: today, reason: reason.slice(0, 200) };
  }
  return { file, retry, read, changed, dropped, failed, withTitles, trouble, sourceChanged, lines };
}

/**
 * When the retry file holds more than this share of the corpus (and at least
 * RETRY_PILE_MIN bills), the night says so every night: bills are piling up
 * faster than they heal, whatever the cause (the source reshaped for good,
 * a path moved, a new kind of answer nobody foresaw). It is the state-based
 * backstop to the event-based rules above.
 */
/**
 * WHAT A STOP AFTER TEN TRANSPORT FAILURES IN A ROW SAYS, in words that name
 * what happened (round 6, 2026-11-17): every one an HTTP 429 is the key's
 * hourly request limit; every one a 401 or 403 is the key being refused; any
 * other mix is the source not answering usably. settleNight adds how many
 * bills read before it are kept. Pure.
 */
export function stopReason(count, reasons) {
  if (reasons.length > 0 && reasons.every((r) => /^HTTP 429\b/.test(r))) {
    return `stopped early: Congress.gov answered HTTP 429 to ${count} requests in a row, so the key's hourly request limit was reached`;
  }
  if (reasons.length > 0 && reasons.every((r) => /^HTTP 40[13]\b/.test(r))) {
    return `stopped early: Congress.gov refused the key ${count} times in a row (${reasons[reasons.length - 1].replace(/:.*$/, '')}): check CONGRESS_API_KEY`;
  }
  return `stopped early: ${count} requests in a row got no usable answer from Congress.gov (no answer, an error page or a broken connection)`;
}

export const RETRY_PILE_SHARE = 0.1;
export const RETRY_PILE_MIN = 50;

/**
 * THE END OF A NIGHT, decided in one place for the script and the tests: run
 * the gate on the files the night would write, apply the drop floor and its
 * one-run override, and list every trouble with a plain reason. Pure.
 * @returns {{ code: 0 | 1, write: { text: string, retryText: string, titles: boolean } | null,
 *   troubles: Array<{ reason: string, error: boolean, sourceChanged: boolean }>, notes: string[], failures: string[],
 *   overrideUsed: boolean }}
 */
export function settleNight({ night, bills, before, allowDrop = false }) {
  const troubles = [];
  if (night.trouble) troubles.push({ reason: `${night.trouble}; ${night.read} bill(s) read before it are kept`, error: night.sourceChanged, sourceChanged: night.sourceChanged });
  const text = serializeShortTitles(night.file, bills);
  const retryText = serializeRetries(night.retry, bills);
  const titlesVerdict = verifyShortTitles({ data: JSON.parse(text), bills, before, allowDrop });
  const retryVerdict = verifyShortTitleRetries({ data: JSON.parse(retryText), bills });
  const notes = [...titlesVerdict.notes, ...retryVerdict.notes];
  const failures = [...titlesVerdict.failures, ...retryVerdict.failures];
  const drop = titlesVerdict.dropFloor;
  const waiting = Object.keys(JSON.parse(retryText)).length;
  const pileLimit = Math.max(RETRY_PILE_MIN, Math.ceil(RETRY_PILE_SHARE * bills.length));
  if (waiting > pileLimit) {
    troubles.push({
      reason: `${waiting} of ${bills.length} bills are waiting to be read again (more than ${pileLimit}); the most common reason is "${commonReason(night.retry)}"`,
      error: false,
      sourceChanged: false,
    });
  }
  if (drop && allowDrop) {
    troubles.push({ reason: `bills with a short title fell ${drop.from} -> ${drop.to} (more than 10% in one night); the one-run override let it through`, error: false, sourceChanged: false });
  }
  if (failures.length) {
    if (drop && !allowDrop && failures.length === 1) {
      troubles.push({
        reason: `bills with a short title would fall ${drop.from} -> ${drop.to}, more than 10% in one night, so nothing was written (${night.read} bill(s) read). If the record really changed this much, dispatch the nightly once by hand with short_titles_allow_drop ticked`,
        error: true,
        sourceChanged: false,
      });
    } else {
      troubles.push({
        reason: `the file's gate refused tonight's files (${failures.length} problem(s); first: ${failures[0]}), so nothing was written (${night.read} bill(s) read)`,
        error: true,
        sourceChanged: false,
      });
    }
    return { code: 1, write: null, troubles, notes, failures, overrideUsed: false };
  }
  return { code: night.sourceChanged ? 1 : 0, write: { text, retryText, titles: night.read > 0 }, troubles, notes, failures, overrideUsed: Boolean(drop && allowDrop) };
}

function commonReason(retry) {
  const counts = new Map();
  for (const e of Object.values(retry ?? {})) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
}

/**
 * THE PRE-COMMIT CHECK of the three short-titles files, as scripts/verify-sync.mjs
 * runs it (hard rule 11), in one function so a test can drive the same input
 * through it and through settleNight and see that the two agree. Each file
 * that is absent (null) is skipped. Pure.
 *
 * THE TREND FILE ONLY WARNS (round 6, 2026-11-17). The 14-night history is a
 * diagnostic, not corpus: a damaged one is restarted by the step itself on its
 * next run, and on a night that ends before the step rewrites it (no key, an
 * unreadable corpus or titles file) failing here would have blocked the commit
 * of ALL the night's data. So its findings are `warnings`, never `failures`,
 * whatever its bytes (`trendText`, the raw file, so even text that is not JSON
 * is a warning). CI's scripts/check-short-titles.mjs refuses a damaged one in a
 * pull request, so none reaches main that way.
 * @param {{ titles: unknown | null, retry: unknown | null, trendText?: string | null, bills: any[], before: unknown | null, allowDrop?: boolean }} args
 * @returns {{ failures: string[], notes: string[], warnings: string[] }}
 */
export function verifyShortTitlesFiles({ titles, retry, trendText = null, bills, before, allowDrop = false }) {
  const failures = [];
  const notes = [];
  if (titles !== null && titles !== undefined) {
    const v = verifyShortTitles({ data: titles, bills, before, allowDrop });
    failures.push(...v.failures);
    notes.push(...v.notes);
  }
  if (retry !== null && retry !== undefined) {
    const v = verifyShortTitleRetries({ data: retry, bills });
    failures.push(...v.failures);
    notes.push(...v.notes);
  }
  const warnings = trendFileWarnings(trendText);
  return { failures, notes, warnings };
}
