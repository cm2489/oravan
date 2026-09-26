/**
 * Per-question press intake from GDELT — which AllSides-rated outlets covered
 * each live Big Question this week, as checkable evidence.
 *
 *   node scripts/gdelt-intake.mjs
 *
 * No key, no secret, no model call, $0. Reads data/moments.json,
 * data/bills.json, data/media-bias.json and (for the run log's comparison
 * only) data/conversation.json; writes data/question-press.json and nothing
 * else. The design, the boundaries and the alias rules are in
 * lib/question-press.mjs's header — read that first.
 *
 * ---- CADENCE: once per question per UTC day ----------------------------------
 * Runs as a step of newsdesk.yml (hourly, in the shared `data-sync`
 * concurrency group). Each run searches only the live questions whose
 * `checkedOn` is not today, oldest first, so the first run after midnight UTC
 * does the day's work and every later run is a no-op that makes no request —
 * unless a search failed, in which case the next hourly run retries just
 * that question. The file changes only when the evidence or a check-day
 * moves, so an hourly step never becomes an hourly deploy.
 *
 * ---- GDELT'S RATE LIMIT (it WILL answer 429) ----------------------------------
 * GDELT's documented ceiling is one request every five seconds per IP, and
 * GitHub runners share IPs, so a 429 is normal weather. The rules, all
 * code-enforced below:
 *   - at least GDELT_SPACING_MS (6 s) between requests, always;
 *   - a 429 waits BACKOFF_MS[0] (30 s) then BACKOFF_MS[1] (90 s) — two
 *     retries per request, never more;
 *   - a request still 429 after its retries OPENS THE CIRCUIT: the run stops
 *     making requests entirely, and the unfinished questions wait for the
 *     next hourly run. No retry storm is possible: at most three requests
 *     reach GDELT in a run where it is refusing us;
 *   - SILENT_CIRCUIT (2) requests in a row that get no HTTP answer at all
 *     (network error, timeout) open the same circuit, so a GDELT that hangs
 *     costs one run at most ~2 × the timeout, not 45 s per question per hour;
 *   - GDELT_MAX_REQUESTS (36, retries included) and GDELT_MAX_RUN_MS (6 min)
 *     cap every run regardless, and a question the remaining request cap
 *     cannot finish is not started;
 *   - any other failure (5xx, GDELT's plain-text query errors) fails THAT
 *     question and the run moves on — without spending the question's
 *     remaining searches, since a question only updates when every search of
 *     every lean succeeded.
 *
 * ---- GDELT'S QUERY-LENGTH LIMIT (measured 2026-09-26) -------------------------
 * GDELT answers a query that is too long with HTTP 200 and the sentence "Your
 * query was too short or too long." Its docs name no limit, and every query
 * the first build of this file made (637–1,120 characters) was over it. Each
 * lean's rated domains are now split into as many searches as it takes to
 * stay under `GDELT_MAX_QUERY_CHARS` (`domainChunks`), and a lean's evidence is
 * the union of its searches. The exact limit is UNMEASURED (below 436), so a
 * refusal is handled, not fatal: the refused group is halved, the run's limit
 * drops to the half's length for every later search, and the lean is
 * re-split — at most log2(group) extra requests, inside the request cap. A
 * single domain still refused fails the question with GDELT's own sentence in
 * the log. The run's summary prints the longest query GDELT answered and the
 * shortest it refused, which is the measurement to set the constant from.
 * The User-Agent names this project honestly. Nothing here imitates a browser
 * or works around a rate limit; the backoff IS the respect for it.
 *
 * ---- EXIT CODES ---------------------------------------------------------------
 * 0 on every GDELT outcome, including a fully rate-limited run (it says so in
 * a ::warning:: and retries next hour). 1 only when the document it built
 * fails lib/question-press.mjs's own gate — it then refuses to write, so a
 * damaged file can never reach the commit step. newsdesk.yml runs this step
 * with continue-on-error so nothing here can ever cost the hour its bill
 * refreshes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  GDELT_MAX_QUERY_CHARS,
  GDELT_MAX_RECORDS,
  QUESTION_PRESS_PATH,
  QUESTION_PRESS_WINDOW_DAYS,
  admitArticles,
  buildGdeltQuery,
  buildQuestionPress,
  domainChunks,
  eligibleDomainsByLean,
  gdeltUrl,
  lampLeanCounts,
  leanParity,
  parseArtList,
  questionTerms,
  shouldWrite,
  termTitleHits,
  timespanFor,
  titleTermShare,
  verifyQuestionPress,
} from '../lib/question-press.mjs';
import { RATED_LEANS, dayKey } from '../lib/conversation.mjs';
import { PRESS_ALLOWLIST_PATH, loadPressOutletPolicy } from '../lib/press-outlets.mjs';

export const USER_AGENT = 'oravan-gdelt-intake/1.0 (+https://github.com/cm2489/oravan)';

/** Requests in a row with no HTTP answer at all (network error, timeout)
 *  that open the circuit for the run. */
export const SILENT_CIRCUIT = 2;

/** GDELT's answer to a query past its length limit (HTTP 200, plain text):
 *  "Your query was too short or too long." */
export const TOO_LONG = /too short or too long/i;

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/** @param {Record<string, string | undefined>} env */
export function limitsFrom(env = {}) {
  return {
    spacingMs: num(env.GDELT_SPACING_MS, 6_000),
    backoffMs: [num(env.GDELT_BACKOFF_1_MS, 30_000), num(env.GDELT_BACKOFF_2_MS, 90_000)],
    maxRequests: num(env.GDELT_MAX_REQUESTS, 36),
    maxRunMs: num(env.GDELT_MAX_RUN_MS, 6 * 60_000),
    timeoutMs: num(env.GDELT_TIMEOUT_MS, 45_000),
    // The measured query-length ceiling (lib/question-press.mjs). Overridable
    // for local re-measurement only; never set in the workflow.
    maxQueryChars: num(env.GDELT_MAX_QUERY_CHARS, GDELT_MAX_QUERY_CHARS),
    // Local measurement only: search every live question even if it was
    // already checked today. Never set in the workflow.
    force: env.GDELT_FORCE === '1',
  };
}

/**
 * The whole collection, with every side effect injected: `fetchImpl`,
 * `sleep` and `clock` are the network and the wall clock, so the tests drive
 * it with no network and no waiting.
 *
 * @param {{
 *   moments: Record<string, any>,
 *   bills: any[],
 *   bias: Record<string, string>,
 *   previous?: any,
 *   conversation?: any,
 *   now: number,
 *   fetchImpl: (url: string, init: any) => Promise<{ status: number, ok: boolean, text: () => Promise<string> }>,
 *   sleep: (ms: number) => Promise<void>,
 *   clock?: () => number,
 *   limits?: ReturnType<typeof limitsFrom>,
 *   log?: (line: string) => void,
 * }} input
 */
export async function collect({ moments, bills, bias, previous = null, conversation = null, now, fetchImpl, sleep, clock = Date.now, limits = limitsFrom({}), log = console.log }) {
  const today = dayKey(now);
  const billsBySlug = new Map((bills ?? []).map((b) => [b.full_identifier, b]));
  const domainsByLean = eligibleDomainsByLean(bias);
  const live = Object.entries(moments ?? {})
    .filter(([, m]) => m?.status === 'live')
    .map(([id, m]) => ({ id, moment: m }));
  const liveIds = live.map((q) => q.id).sort();

  // A standing condition (a question with no searchable vocabulary) is worth
  // ONE ::warning:: a day, not one per hourly run: the first run of a UTC day
  // is the one whose previous file was pruned against an earlier day.
  const firstRunToday = previous?._meta?.as_of !== today;
  const standing = (line) => log(firstRunToday ? `::warning::${line}` : line);

  /** @type {Array<{ id: string, moment: any, terms: string[], checkedOn: string | null, requests: number }>} */
  const due = [];
  const stats = {
    requests: 0,
    rateLimited: 0,
    circuitOpen: false,
    circuitWhy: null,
    budgetStop: null,
    done: [],
    failed: [],
    skipped: [],
    notDue: [],
    /** query lengths GDELT answered with an article list / refused as too long — the runner-side measurement of its limit */
    answeredLengths: [],
    refusedLengths: [],
  };
  // The query-length limit this run plans under. Starts at the configured
  // value; a "too short or too long" answer lowers it for the rest of the run.
  let queryLimit = limits.maxQueryChars;
  for (const { id, moment } of live) {
    const { terms, dropped } = questionTerms(moment, billsBySlug);
    for (const d of dropped) log(`gdelt-intake: ${id}: dropped ${d.source} "${d.term}" — ${d.reason}`);
    if (terms.length === 0) {
      stats.skipped.push(id);
      standing(`gdelt-intake: ${id} has no multi-word press vocabulary (aliases are bill-number placeholders and the vehicles carry no multi-word name) — not searched. Real aliases in data/moments.json are the owner's call.`);
      continue;
    }
    // Every lean's domains, split so each query fits GDELT's length limit.
    const plan = RATED_LEANS.map((lean) => ({ lean, chunks: domainChunks({ terms, domains: domainsByLean[lean], maxChars: limits.maxQueryChars }) }));
    if (plan.some((p) => p.chunks === null)) {
      stats.skipped.push(id);
      standing(`gdelt-intake: ${id}: its search terms alone do not fit GDELT's ${limits.maxQueryChars}-character query limit beside one domain — not searched. Shorter aliases in data/moments.json are the owner's call.`);
      continue;
    }
    const checkedOn = previous?.questions?.[id]?.checkedOn ?? null;
    if (checkedOn === today && !limits.force) {
      stats.notDue.push(id);
      continue;
    }
    due.push({ id, moment, terms, checkedOn, requests: 0 });
  }
  // Oldest check first (never-checked first of all), so a run that stops
  // early never starves the same question two days running.
  due.sort((a, b) => String(a.checkedOn ?? '').localeCompare(String(b.checkedOn ?? '')) || a.id.localeCompare(b.id));
  if (due.length === 0) log(`gdelt-intake: nothing due — every searchable live question was checked today (${today}).`);

  const startedAt = clock();
  let lastRequestAt = -Infinity;
  // Consecutive requests that got no HTTP answer at all (network error or
  // timeout). A hang costs up to `timeoutMs` per request, so a GDELT that has
  // stopped answering opens the circuit the same way a GDELT that answers 429
  // does, instead of adding minutes to every hourly run until it recovers.
  let silentInARow = 0;
  /** @returns {Promise<{ kind: 'ok', body: string } | { kind: 'rate_limited' } | { kind: 'silent', error: string } | { kind: 'error', error: string } | { kind: 'budget', why: string }>} */
  const request = async (url) => {
    for (let attempt = 0; ; attempt++) {
      if (stats.requests >= limits.maxRequests) return { kind: 'budget', why: `request cap ${limits.maxRequests}` };
      if (clock() - startedAt >= limits.maxRunMs) return { kind: 'budget', why: `run-time cap ${limits.maxRunMs} ms` };
      const wait = lastRequestAt + limits.spacingMs - clock();
      if (wait > 0) await sleep(wait);
      lastRequestAt = clock();
      stats.requests++;
      let res;
      try {
        res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(limits.timeoutMs) });
      } catch (err) {
        silentInARow++;
        const code = err?.cause?.code ?? err?.name;
        return { kind: 'silent', error: `no answer: ${err?.message ?? err}${code ? ` (${code})` : ''}` };
      }
      silentInARow = 0;
      if (res.status === 429) {
        stats.rateLimited++;
        if (attempt >= limits.backoffMs.length) return { kind: 'rate_limited' };
        log(`gdelt-intake: 429 from GDELT — backing off ${limits.backoffMs[attempt]} ms (retry ${attempt + 1} of ${limits.backoffMs.length})`);
        await sleep(limits.backoffMs[attempt]);
        continue;
      }
      if (!res.ok) return { kind: 'error', error: `HTTP ${res.status}` };
      try {
        return { kind: 'ok', body: await res.text() };
      } catch (err) {
        return { kind: 'error', error: `body read failed: ${err?.message ?? err}` };
      }
    }
  };

  /** @type {Map<string, { terms: string[], admitted: any[] }>} */
  const results = new Map();
  /** @type {Map<string, { byLean: Record<string, { requests: number, returned: number, admitted: number, rejected: number, truncated: boolean }>, admitted: any[] }>} */
  const perQuestion = new Map();
  outer: for (const q of due) {
    // Re-plan at this run's limit, which a refusal earlier in the run may
    // have lowered (see TOO_LONG below).
    const plan = RATED_LEANS.map((lean) => ({ lean, chunks: domainChunks({ terms: q.terms, domains: domainsByLean[lean], maxChars: queryLimit }) }));
    if (plan.some((p) => p.chunks === null)) {
      stats.failed.push(q.id);
      log(`::warning::gdelt-intake: ${q.id}: its search terms do not fit this run's lowered ${queryLimit}-character query limit beside one domain — not searched this run`);
      continue;
    }
    q.requests = plan.reduce((n, p) => n + /** @type {string[][]} */ (p.chunks).length, 0);
    // Never start a question the request cap cannot finish: a question moves
    // only when every group of every lean answered, so a half-searched one
    // would spend requests and record nothing.
    if (q.requests > limits.maxRequests) {
      stats.failed.push(q.id);
      log(`::warning::gdelt-intake: ${q.id} needs ${q.requests} requests (its lean domains split to fit GDELT's query limit), more than the per-run cap of ${limits.maxRequests} — not searched`);
      continue;
    }
    if (stats.requests + q.requests > limits.maxRequests) {
      stats.budgetStop = `request cap ${limits.maxRequests}`;
      log(`::warning::gdelt-intake: stopping — ${q.id} needs ${q.requests} more requests and the run has ${limits.maxRequests - stats.requests} left of its cap; it and later questions wait for the next run`);
      break;
    }
    const timespanDays = timespanFor(q.checkedOn, today);
    const admittedAll = [];
    const byLean = {};
    let ok = true;
    leans: for (const { lean, chunks } of plan) {
      if (!chunks?.length) {
        ok = false;
        log(`::warning::gdelt-intake: ${q.id}: data/media-bias.json rates no ${lean} domains — cannot search every lean, question not updated`);
        break;
      }
      const tally = { requests: 0, returned: 0, admitted: 0, rejected: 0, truncated: false };
      let queue = [...chunks];
      while (queue.length) {
        const domains = /** @type {string[]} */ (queue.shift());
        const query = buildGdeltQuery({ terms: q.terms, domains });
        const url = gdeltUrl({ query, timespanDays });
        const r = await request(url);
        if (r.kind === 'budget') {
          stats.budgetStop = r.why;
          log(`::warning::gdelt-intake: stopping — ${r.why} reached; ${q.id} and later questions wait for the next run`);
          break outer;
        }
        if (r.kind === 'rate_limited') {
          stats.circuitOpen = true;
          stats.circuitWhy = '429';
          log(`::warning::gdelt-intake: GDELT is still answering 429 after ${limits.backoffMs.length} backoffs — circuit open, no further requests this run. ${q.id} and later questions carry forward and retry next run.`);
          break outer;
        }
        if (r.kind === 'silent' && silentInARow >= SILENT_CIRCUIT) {
          stats.circuitOpen = true;
          stats.circuitWhy = 'no answer';
          log(`::warning::gdelt-intake: ${silentInARow} requests in a row got no answer from GDELT (${r.error}) — circuit open, no further requests this run. ${q.id} and later questions carry forward and retry next run.`);
          break outer;
        }
        if (r.kind === 'silent' || r.kind === 'error') {
          ok = false;
          log(`::warning::gdelt-intake: ${q.id} (${lean}): ${r.error} — question not updated this run`);
          break leans;
        }
        const parsed = parseArtList(r.body);
        if (!parsed.ok && TOO_LONG.test(parsed.error) && domains.length > 1) {
          // GDELT refused the query's length. Halve this group, lower the
          // run's limit to the half's length so every later search is planned
          // under it too, and re-split what is left of this lean. Each refusal
          // halves the group, so this ends in at most log2(group) refusals;
          // the request cap bounds it regardless.
          const half = domains.slice(0, Math.ceil(domains.length / 2));
          const lowered = buildGdeltQuery({ terms: q.terms, domains: half }).length;
          stats.refusedLengths.push(query.length);
          log(
            `::warning::gdelt-intake: GDELT refused a ${query.length}-character query as too long — this run now plans searches at ≤${lowered} characters. ` +
              `GDELT_MAX_QUERY_CHARS (${limits.maxQueryChars}) is above GDELT's real limit and should be lowered to the largest length it answered (see the summary line).`
          );
          queryLimit = Math.min(queryLimit, lowered);
          const replanned = domainChunks({ terms: q.terms, domains: [domains, ...queue].flat(), maxChars: queryLimit });
          if (!replanned) {
            // A longer domain name left in this lean no longer fits beside the
            // terms: searching the rest would silently skip it, so the whole
            // question waits rather than record a lean with a hole in it.
            ok = false;
            log(`::warning::gdelt-intake: ${q.id} (${lean}): a remaining domain does not fit the lowered ${queryLimit}-character limit beside the terms — question not updated this run`);
            break leans;
          }
          queue = replanned;
          continue;
        }
        if (!parsed.ok) {
          ok = false;
          log(`::warning::gdelt-intake: ${q.id} (${lean}): GDELT answered ${parsed.error} — question not updated this run`);
          break leans;
        }
        stats.answeredLengths.push(query.length);
        const { admitted, rejected } = admitArticles(parsed.articles, { lean, bias, today });
        tally.requests += 1;
        tally.returned += parsed.articles.length;
        tally.admitted += admitted.length;
        tally.rejected += rejected;
        tally.truncated ||= parsed.articles.length >= GDELT_MAX_RECORDS;
        admittedAll.push(...admitted);
      }
      byLean[lean] = tally;
      // GDELT was restricted to this lean's rated domains, so everything it
      // returns should be admissible. Returned-but-none-admitted means the
      // response shape or the admission rules disagree with reality — and if
      // it went unremarked, "0 outlets" would read as an absence finding.
      if (tally.returned > 0 && tally.admitted === 0) {
        log(`::warning::gdelt-intake: ${q.id} (${lean}): GDELT returned ${tally.returned} article(s) and none was admitted — check the returned→admitted line; if GDELT's response fields changed, a zero here is a parse failure, not an absence`);
      }
    }
    if (ok) {
      results.set(q.id, { terms: q.terms, admitted: admittedAll });
      perQuestion.set(q.id, { byLean, admitted: admittedAll });
      stats.done.push(q.id);
    } else {
      stats.failed.push(q.id);
    }
  }
  for (const q of due) if (!stats.done.includes(q.id) && !stats.failed.includes(q.id)) stats.failed.push(q.id);

  // A question with no usable search terms has no entry at all — not a carried
  // one with yesterday's terms. Absence means "not searched", never "no
  // coverage", and an entry whose terms the question no longer has would be a
  // record of a search nobody can re-run.
  const searchableIds = liveIds.filter((id) => !stats.skipped.includes(id));
  const doc = buildQuestionPress({ previous, liveIds: searchableIds, results, bias, today });

  // ---- the lean-parity log (plan §4: measured, not assumed) ------------------
  const total = { left: new Set(), center: new Set(), right: new Set() };
  log(
    `gdelt-intake: rated domains searched per lean — left ${domainsByLean.left.length}, center ${domainsByLean.center.length}, right ${domainsByLean.right.length}`
  );
  for (const id of liveIds) {
    const entry = doc.questions[id];
    const moment = moments[id];
    const lamp = lampLeanCounts(conversation, (moment?.vehicles ?? []).map((v) => v.slug), today);
    if (!entry) {
      log(`gdelt-intake: ${id}: no evidence (${stats.skipped.includes(id) ? 'not searchable' : 'never checked successfully'}); lamp holds L${lamp.left.length}/C${lamp.center.length}/R${lamp.right.length}`);
      continue;
    }
    const p = leanParity(entry, domainsByLean);
    for (const o of entry.outlets) total[o.lean].add(o.domain);
    const pct = (x) => `${Math.round(x * 100)}%`;
    const inLamp = new Set([...lamp.left, ...lamp.center, ...lamp.right]);
    const gdeltDomains = new Set(entry.outlets.map((o) => o.domain));
    const overlap = [...gdeltDomains].filter((d) => inLamp.has(d)).length;
    const onlyLamp = [...inLamp].filter((d) => !gdeltDomains.has(d)).length;
    log(
      `gdelt-intake: ${id} [checked ${entry.checkedOn}${stats.done.includes(id) ? ', this run' : ', carried'}] ` +
        `rated outlets L${p.left.outlets}/${p.left.searched} (${pct(p.left.share)}) ` +
        `C${p.center.outlets}/${p.center.searched} (${pct(p.center.share)}) ` +
        `R${p.right.outlets}/${p.right.searched} (${pct(p.right.share)}); ` +
        `links L${p.left.articles}/C${p.center.articles}/R${p.right.articles}. ` +
        `Lamp (vehicles, 7d): L${lamp.left.length}/C${lamp.center.length}/R${lamp.right.length}; ` +
        `in both ${overlap}, lamp-only ${onlyLamp}, GDELT-only ${gdeltDomains.size - overlap}.`
    );
    const run = perQuestion.get(id);
    if (run) {
      const lb = RATED_LEANS.map(
        (l) =>
          `${l[0].toUpperCase()} ${run.byLean[l]?.returned ?? 0}→${run.byLean[l]?.admitted ?? 0} in ${run.byLean[l]?.requests ?? 0} request(s)${run.byLean[l]?.truncated ? ' (a request TRUNCATED at 250)' : ''}`
      );
      log(`gdelt-intake: ${id}: returned→admitted this run: ${lb.join(', ')}`);
      // The precision reading (lib/question-press.mjs, titleTermShare): a
      // full-text match is the ceiling, a title naming a term is the floor.
      const share = titleTermShare(run.admitted, entry.terms);
      log(
        `gdelt-intake: ${id}: precision — admitted articles whose TITLE names a search term: ` +
          RATED_LEANS.map((l) => `${l[0].toUpperCase()} ${share[l].titled}/${share[l].admitted}`).join(', ') +
          ' (the rest matched a term and a congressional word somewhere in the body)'
      );
      const hits = termTitleHits(run.admitted, entry.terms);
      for (const [term, h] of Object.entries(hits)) {
        log(`gdelt-intake: ${id}: term "${term}" in titles L${h.left}/C${h.center}/R${h.right}`);
      }
    }
  }
  log(
    `gdelt-intake: distinct rated outlets across all questions — left ${total.left.size}, center ${total.center.size}, right ${total.right.size}. ` +
      `Requests ${stats.requests} (429s ${stats.rateLimited}); updated ${stats.done.length}, failed/waiting ${stats.failed.length}, not searchable ${stats.skipped.length}, already checked today ${stats.notDue.length}.`
  );
  if (stats.answeredLengths.length || stats.refusedLengths.length) {
    log(
      `gdelt-intake: query length — longest GDELT answered this run ${stats.answeredLengths.length ? Math.max(...stats.answeredLengths) : 'none'}, ` +
        `shortest it refused as too long ${stats.refusedLengths.length ? Math.min(...stats.refusedLengths) : 'none'} ` +
        `(configured limit ${limits.maxQueryChars}, run ended at ${queryLimit}).`
    );
  }
  // A whole run that searched and admitted nothing, across every question it
  // finished, is far more likely a parse or admission failure than a week in
  // which no rated outlet covered any live question. Say so, loudly.
  const admittedThisRun = [...perQuestion.values()].reduce((n, r) => n + r.admitted.length, 0);
  if (stats.done.length > 0 && admittedThisRun === 0) {
    log(
      `::warning::gdelt-intake: ${stats.done.length} question(s) searched in every lean and not one article was admitted — before reading this as "no coverage", check the returned→admitted lines above`
    );
  }

  // No file yet and nothing to put in one (every search refused, say): write
  // nothing. An empty first file would be a commit and a deploy that records
  // no evidence at all.
  const nothingToRecord = !previous && Object.keys(doc.questions).length === 0;
  return { doc, write: !nothingToRecord && shouldWrite({ previous, next: doc }), stats, today };
}

async function main() {
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const moments = read('data/moments.json');
  const bills = read('data/bills.json');
  const bias = read('data/media-bias.json').outlets ?? {};
  const previous = existsSync(QUESTION_PRESS_PATH) ? read(QUESTION_PRESS_PATH) : null;
  const conversation = existsSync('data/conversation.json') ? read('data/conversation.json') : null;
  // The owner's outlet floor is "rated, plus an optional approved allowlist"
  // (lib/press-outlets.mjs). This intake takes the rated half only, because
  // every search and count here is per lean and an allowlisted outlet has
  // none. Say so out loud the day an allowlist exists, rather than let an
  // approved outlet go silently unsearched.
  const policy = loadPressOutletPolicy({ readJSON: read, exists: existsSync });
  if (policy.allowlistSize > 0) {
    console.log(
      `::warning::gdelt-intake: ${PRESS_ALLOWLIST_PATH} approves ${policy.allowlistSize} outlet(s) beyond the AllSides-rated set; this intake searches rated outlets only (its counts are per lean) — allowlisted outlets are not searched until a lean-less group is added to lib/question-press.mjs.`
    );
  }
  const now = Date.now();
  const { doc, write } = await collect({
    moments,
    bills,
    bias,
    previous,
    conversation,
    now,
    fetchImpl: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    limits: limitsFrom(process.env),
  });
  if (!write) {
    console.log(`gdelt-intake: ${QUESTION_PRESS_PATH} unchanged — nothing written.`);
    return;
  }
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const { failures, warnings, notes } = verifyQuestionPress({ data: doc, fileBytes: Buffer.byteLength(text), bias, moments, now });
  for (const n of notes) console.log(n);
  for (const w of warnings) console.log(`::warning::${w}`);
  if (failures.length) {
    for (const f of failures) console.error(`::error::${f}`);
    console.error(`::error::gdelt-intake: refusing to write ${QUESTION_PRESS_PATH} — the document failed its own gate.`);
    process.exit(1);
  }
  writeFileSync(QUESTION_PRESS_PATH, text);
  console.log(`gdelt-intake: wrote ${QUESTION_PRESS_PATH} (${Object.keys(doc.questions).length} question(s), window ${QUESTION_PRESS_WINDOW_DAYS} days).`);
}

if (/(^|\/)gdelt-intake\.mjs$/.test(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(`::error::gdelt-intake crashed: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
