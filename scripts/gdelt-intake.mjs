/**
 * Per-question press intake from GDELT — which AllSides-rated outlets covered
 * each live Big Question this week, as checkable evidence.
 *
 *   node scripts/gdelt-intake.mjs
 *
 * No key, no secret, no model call, $0. Reads data/moments.json,
 * data/bills.json, data/media-bias.json and (for the run log's comparison
 * only) data/conversation.json; writes data/question-press.json and a small
 * circuit-state file outside data/ (GDELT_STATE_PATH), and nothing else. The
 * design, the query shape and the alias rules are in lib/question-press.mjs's
 * header — read that first.
 *
 * ---- WHERE IT RUNS: ITS OWN WORKFLOW, OFF EVERY OTHER COMMIT PATH -------------
 * .github/workflows/question-press.yml, twice a day, in its OWN concurrency
 * group — not `data-sync`, and not a step of newsdesk.yml. The build before
 * this one ran as a newsdesk step BEFORE the newsdesk's "Commit data", so a
 * slow or refusing GDELT held up every hourly commit behind it. Now a GDELT
 * outage can only make THIS workflow slow: it writes one file no other
 * workflow writes (data/question-press.json), so its push is a fast-forward
 * problem for everyone else, never a content conflict — the same "disjoint
 * files plus rebase-retry" footing refresh-legislators.yml stands on.
 *
 * ---- CADENCE: once per question per UTC day -----------------------------------
 * Each run searches only the live questions whose `checkedOn` is not today,
 * oldest check first, each over the days since its last check
 * (`windowStartDay`). The second daily run is a retry for whatever the first
 * could not finish. A day the collector did not run at all loses nothing: the
 * next search starts from the last day checked.
 *
 * ---- WRITES: at most once a day, unless the counts change ---------------------
 * `shouldWrite` (lib/question-press.mjs) is the rule: the first run of a UTC
 * day that checked something writes once; any other run writes only when a
 * count actually moved. A day on which nothing could be checked writes
 * nothing at all.
 *
 * ---- BUDGETS: TIME AND COUNT, checked before every request --------------------
 *   - a RUN deadline (GDELT_RUN_DEADLINE_MS, 10 min) and a PER-QUESTION
 *     deadline (GDELT_QUESTION_DEADLINE_MS, 4 min). Before each request —
 *     and before each spacing wait and each 429 backoff — the collector checks
 *     that the request could still finish (its full timeout) inside both. One
 *     slow question therefore costs at most its own deadline, then the run
 *     moves on to the next; the run as a whole never outlives its deadline.
 *   - a request cap (GDELT_MAX_REQUESTS, 40, retries and pages included), and a
 *     question the remaining cap cannot even start (one request per term) is
 *     not started.
 *   - every request has ONE timeout (GDELT_TIMEOUT_MS, 30 s) covering the
 *     headers AND the body. A body that never finishes arriving is a request
 *     that got no answer, exactly like a connection that never opened.
 *
 * ---- GDELT'S RATE LIMIT AND THE CIRCUIT BREAKER --------------------------------
 * GDELT asks for one request every five seconds per IP and answers 429
 * otherwise; GitHub runners share IPs, so a 429 is normal weather.
 *   - at least GDELT_SPACING_MS (6 s) between requests, always;
 *   - a 429 waits 30 s, then 90 s — two retries per request, never more;
 *   - the CIRCUIT OPENS, and the run makes no further request, on: a request
 *     still 429 after its retries; SILENT_CIRCUIT (2) requests in a row with no
 *     answer (network error, timeout, or a body that hung); or
 *     REFUSAL_CIRCUIT (3) queries in a row GDELT refused as queries (the
 *     failure that sank the first build: every run would otherwise spend its
 *     whole budget on queries GDELT will never run);
 *   - THE CIRCUIT IS PERSISTED (GDELT_STATE_PATH, carried between runs in the
 *     Actions cache). A later run inside GDELT_CIRCUIT_COOLDOWN_MS (6 h) of
 *     the last failed attempt makes NO request. After the cooldown the run is
 *     HALF-OPEN: its first request gets no 429 backoff and a single silent
 *     answer is enough — if GDELT is still refusing, the run ends after ONE
 *     request and at most one timeout, and the circuit stays open. A cache
 *     miss reads as a closed circuit, which costs one ordinary run at worst.
 *   - any other failure (5xx, an empty body, a malformed body) fails THAT
 *     question for this run, without spending its remaining searches, since a
 *     question only updates when every one of its searches answered.
 * The User-Agent names this project honestly. Nothing here imitates a browser
 * or works around a rate limit; the backoff IS the respect for it.
 *
 * ---- EXIT CODES ---------------------------------------------------------------
 * 0 on every GDELT outcome, including a run the circuit skipped entirely (it
 * says so in a ::warning::). 1 only when the document it built fails
 * lib/question-press.mjs's own gate — it then refuses to write, so a damaged
 * file can never reach the commit step.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { dirname } from 'node:path';
import {
  GDELT_MAX_QUERY_CHARS,
  GDELT_MAX_RECORDS,
  QUERY_SHAPE,
  QUESTION_PRESS_PATH,
  QUESTION_PRESS_WINDOW_DAYS,
  admitArticles,
  buildGdeltQuery,
  buildQuestionPress,
  eligibleDomainsByLean,
  gdeltUrl,
  lampLeanCounts,
  leanParity,
  parseArtList,
  questionTerms,
  seenStamp,
  shouldWrite,
  termTitleHits,
  titleTermShare,
  verifyQuestionPress,
  windowStartDay,
} from '../lib/question-press.mjs';
import { RATED_LEANS, dayKey } from '../lib/conversation.mjs';
import { PRESS_ALLOWLIST_PATH, loadPressOutletPolicy } from '../lib/press-outlets.mjs';

export const USER_AGENT = 'oravan-gdelt-intake/1.0 (+https://github.com/cm2489/oravan)';

/** Requests in a row with no answer at all (network error, timeout, a body
 *  that never finished) that open the circuit. */
export const SILENT_CIRCUIT = 2;

/** Queries in a row GDELT refused AS QUERIES ("too short or too long") that
 *  open the circuit. One refused term is that term's problem; three in a row
 *  means GDELT's rules moved, and every further request would be refused too. */
export const REFUSAL_CIRCUIT = 3;

/** Where the circuit state lives between runs: outside data/, never committed
 *  (.gitignore), carried by the workflow's Actions cache. */
export const DEFAULT_STATE_PATH = '.gdelt-state/state.json';

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d;
};

/** @param {Record<string, string | undefined>} env */
export function limitsFrom(env = {}) {
  return {
    spacingMs: num(env.GDELT_SPACING_MS, 6_000),
    backoffMs: [num(env.GDELT_BACKOFF_1_MS, 30_000), num(env.GDELT_BACKOFF_2_MS, 90_000)],
    maxRequests: num(env.GDELT_MAX_REQUESTS, 40),
    runDeadlineMs: num(env.GDELT_RUN_DEADLINE_MS, 10 * 60_000),
    questionDeadlineMs: num(env.GDELT_QUESTION_DEADLINE_MS, 4 * 60_000),
    timeoutMs: num(env.GDELT_TIMEOUT_MS, 30_000),
    // A full 250-record page is paged backwards in time this many times at
    // most per term (lib/question-press.mjs: the cut is a cut in time).
    maxPagesPerTerm: num(env.GDELT_MAX_PAGES_PER_TERM, 4),
    circuitCooldownMs: num(env.GDELT_CIRCUIT_COOLDOWN_MS, 6 * 3_600_000),
    // The measured query-length cap (lib/question-press.mjs). Overridable for
    // local re-measurement only; never set in the workflow.
    maxQueryChars: num(env.GDELT_MAX_QUERY_CHARS, GDELT_MAX_QUERY_CHARS),
    // Local measurement only: search every live question even if it was
    // already checked today, and ignore an open circuit. Never set in the
    // workflow.
    force: env.GDELT_FORCE === '1',
  };
}

/** A real, cancellable timer — the production `timer`. @param {number} ms */
export function realTimer(ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let t;
  const promise = new Promise((resolve) => {
    t = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(t) };
}

const TIMED_OUT = Symbol('timed out');

/**
 * The production `fetchImpl`: a plain HTTPS GET on node:https, NOT the global
 * fetch. Measured 2026-09-26 from the build machine: GDELT's TLS handshake
 * took 9.2–9.7 s on every one of four handshakes (TCP connect: 45 ms), and
 * Node's global fetch (undici) abandons any connection whose TCP+TLS setup
 * passes 10 s — `UND_ERR_CONNECT_TIMEOUT`, which is exactly how two of this
 * pass's live requests and several of the previous pass's died before
 * reaching GDELT at all. node:https has no connect ceiling of its own, so the
 * collector's one per-request timeout (GDELT_TIMEOUT_MS, headers + body) is
 * the only clock; and a keep-alive agent lets a run reuse one handshake for
 * as many requests as GDELT keeps the connection open.
 */
export const gdeltAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });

/**
 * @param {string} url
 * @param {{ headers?: Record<string, string>, signal?: AbortSignal }} [init]
 * @returns {Promise<{ status: number, ok: boolean, text: () => Promise<string> }>}
 */
export function httpsFetch(url, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, agent: gdeltAgent, signal }, (res) => {
      const chunks = [];
      let ended = false;
      const body = new Promise((done, fail) => {
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          ended = true;
          done(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', fail);
        res.on('close', () => {
          if (!ended) fail(new Error('the connection closed before the body finished'));
        });
      });
      body.catch(() => {});
      const status = res.statusCode ?? 0;
      resolve({ status, ok: status >= 200 && status < 300, text: () => body });
    });
    req.on('error', reject);
  });
}

/**
 * The whole collection, with every side effect injected: `fetchImpl`,
 * `sleep`, `timer` and `clock` are the network and the wall clock, so the
 * tests drive it with no network and no waiting. `circuit` is the persisted
 * breaker state from the previous run (null = closed); the result's
 * `circuit` is what to persist for the next one.
 *
 * @param {{
 *   moments: Record<string, any>,
 *   bills: any[],
 *   bias: Record<string, string>,
 *   previous?: any,
 *   conversation?: any,
 *   circuit?: { open: true, reason: string, openedAt: string, lastTryAt: string, tries: number } | null,
 *   now: number,
 *   fetchImpl: (url: string, init: any) => Promise<{ status: number, ok: boolean, text: () => Promise<string> }>,
 *   sleep: (ms: number) => Promise<void>,
 *   timer?: (ms: number) => { promise: Promise<unknown>, cancel: () => void },
 *   clock?: () => number,
 *   limits?: ReturnType<typeof limitsFrom>,
 *   log?: (line: string) => void,
 * }} input
 */
export async function collect({
  moments,
  bills,
  bias,
  previous = null,
  conversation = null,
  circuit = null,
  now,
  fetchImpl,
  sleep,
  timer = realTimer,
  clock = Date.now,
  limits = limitsFrom({}),
  log = console.log,
}) {
  const today = dayKey(now);
  const billsBySlug = new Map((bills ?? []).map((b) => [b.full_identifier, b]));
  const domainsByLean = eligibleDomainsByLean(bias);
  const live = Object.entries(moments ?? {})
    .filter(([, m]) => m?.status === 'live')
    .map(([id, m]) => ({ id, moment: m }));
  const liveIds = live.map((q) => q.id).sort();

  // A standing condition (a question with no searchable vocabulary) is worth
  // ONE ::warning:: a day, not one per run: the first run of a UTC day is the
  // one whose previous file was pruned against an earlier day.
  const firstRunToday = previous?._meta?.as_of !== today;
  const standing = (line) => log(firstRunToday ? `::warning::${line}` : line);

  /** @type {Array<{ id: string, moment: any, terms: string[], checkedOn: string | null }>} */
  const due = [];
  const stats = {
    requests: 0,
    rateLimited: 0,
    circuitOpen: false,
    circuitWhy: /** @type {string | null} */ (null),
    circuitSkipped: false,
    budgetStop: /** @type {string | null} */ (null),
    /** @type {string[]} */ done: [],
    /** @type {string[]} */ failed: [],
    /** @type {string[]} */ skipped: [],
    /** @type {string[]} */ notDue: [],
    /** @type {Array<{ id: string, term: string, chars: number, answer: string }>} */ refused: [],
    /** query lengths GDELT answered with an article list — the runner-side record of what it accepts */
    /** @type {number[]} */ answeredLengths: [],
  };
  for (const { id, moment } of live) {
    const { terms, dropped } = questionTerms(moment, billsBySlug, { maxQueryChars: limits.maxQueryChars });
    for (const d of dropped) log(`gdelt-intake: ${id}: dropped ${d.source} "${d.term}" — ${d.reason}`);
    if (terms.length === 0) {
      stats.skipped.push(id);
      standing(`gdelt-intake: ${id} has no multi-word press vocabulary (aliases are bill-number placeholders and the vehicles carry no multi-word name) — not searched. Real aliases in data/moments.json are the owner's call.`);
      continue;
    }
    const checkedOn = previous?.questions?.[id]?.checkedOn ?? null;
    if (checkedOn === today && !limits.force) {
      stats.notDue.push(id);
      continue;
    }
    due.push({ id, moment, terms, checkedOn });
  }
  // Oldest check first (never-checked first of all), so a run that stops
  // early never starves the same question two days running.
  due.sort((a, b) => String(a.checkedOn ?? '').localeCompare(String(b.checkedOn ?? '')) || a.id.localeCompare(b.id));
  if (due.length === 0) log(`gdelt-intake: nothing due — every searchable live question was checked today (${today}).`);

  // ---- the persisted circuit ---------------------------------------------------
  /** @type {typeof circuit} */
  let nextCircuit = circuit?.open ? { ...circuit } : null;
  let halfOpen = false;
  if (circuit?.open && due.length > 0) {
    const since = clock() - Date.parse(circuit.lastTryAt);
    if (Number.isFinite(since) && since < limits.circuitCooldownMs && !limits.force) {
      stats.circuitSkipped = true;
      stats.circuitOpen = true;
      stats.circuitWhy = circuit.reason;
      log(
        `::warning::gdelt-intake: the GDELT circuit has been open since ${circuit.openedAt} (${circuit.reason}); the last attempt was ${Math.round(since / 60_000)} min ago, inside the ${Math.round(limits.circuitCooldownMs / 60_000)}-min cooldown — no request this run. ${due.length} question(s) wait.`
      );
      due.length = 0;
    } else {
      halfOpen = true;
      log(`gdelt-intake: the GDELT circuit is open (${circuit.reason}, since ${circuit.openedAt}) — half-open: one request decides whether this run goes on.`);
    }
  }
  const openCircuit = (reason) => {
    stats.circuitOpen = true;
    stats.circuitWhy = reason;
    const at = new Date(clock()).toISOString();
    nextCircuit = { open: true, reason, openedAt: circuit?.open ? circuit.openedAt : at, lastTryAt: at, tries: (circuit?.open ? circuit.tries ?? 0 : 0) + 1 };
  };

  const runStart = clock();
  const runDeadline = runStart + limits.runDeadlineMs;
  let lastRequestAt = -Infinity;
  let silentInARow = 0;
  let refusedInARow = 0;

  /** Race a promise against the per-request timeout; never leaves a timer or
   *  an unhandled rejection behind. */
  const within = async (promise, ms) => {
    promise.catch(() => {});
    const t = timer(Math.max(1, ms));
    try {
      return await Promise.race([promise, t.promise.then(() => TIMED_OUT)]);
    } finally {
      t.cancel();
    }
  };

  /**
   * One GDELT request, with every budget checked BEFORE anything is waited
   * for or sent.
   * @param {string} url
   * @param {number} questionDeadline
   * @returns {Promise<
   *   { kind: 'ok', body: string } | { kind: 'rate_limited' } | { kind: 'silent', error: string } |
   *   { kind: 'error', error: string } | { kind: 'budget', why: string } | { kind: 'question_deadline' }>}
   */
  const request = async (url, questionDeadline) => {
    for (let attempt = 0; ; attempt++) {
      if (stats.requests >= limits.maxRequests) return { kind: 'budget', why: `request cap ${limits.maxRequests}` };
      const wait = Math.max(0, lastRequestAt + limits.spacingMs - clock());
      const finishBy = clock() + wait + limits.timeoutMs;
      if (finishBy > runDeadline) return { kind: 'budget', why: `run deadline ${Math.round(limits.runDeadlineMs / 1000)} s` };
      if (finishBy > questionDeadline) return { kind: 'question_deadline' };
      if (wait > 0) await sleep(wait);
      lastRequestAt = clock();
      stats.requests++;
      const ac = new AbortController();
      /** @type {any} */
      let res;
      try {
        res = await within(Promise.resolve().then(() => fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: ac.signal })), limits.timeoutMs);
      } catch (err) {
        silentInARow++;
        const code = err?.cause?.code ?? err?.name;
        return { kind: 'silent', error: `no answer: ${err?.message ?? err}${code ? ` (${code})` : ''}` };
      }
      if (res === TIMED_OUT) {
        ac.abort();
        silentInARow++;
        return { kind: 'silent', error: `no answer within ${limits.timeoutMs} ms` };
      }
      if (res.status === 429) {
        silentInARow = 0;
        stats.rateLimited++;
        if (halfOpen || attempt >= limits.backoffMs.length) return { kind: 'rate_limited' };
        const backoff = limits.backoffMs[attempt];
        const retryBy = clock() + Math.max(backoff, limits.spacingMs) + limits.timeoutMs;
        if (retryBy > runDeadline) return { kind: 'budget', why: `run deadline ${Math.round(limits.runDeadlineMs / 1000)} s (a 429 backoff would pass it)` };
        if (retryBy > questionDeadline) return { kind: 'question_deadline' };
        log(`gdelt-intake: 429 from GDELT — backing off ${backoff} ms (retry ${attempt + 1} of ${limits.backoffMs.length})`);
        await sleep(backoff);
        continue;
      }
      // The headers arrived; the body gets what is left of the SAME timeout.
      // A body that never finishes is a request that was never answered.
      /** @type {any} */
      let body;
      try {
        body = await within(Promise.resolve().then(() => res.text()), limits.timeoutMs - (clock() - lastRequestAt));
      } catch (err) {
        ac.abort();
        silentInARow++;
        return { kind: 'silent', error: `the body broke off: ${err?.message ?? err}` };
      }
      if (body === TIMED_OUT) {
        ac.abort();
        silentInARow++;
        return { kind: 'silent', error: `HTTP ${res.status} arrived but its body did not finish within ${limits.timeoutMs} ms` };
      }
      silentInARow = 0;
      if (!res.ok) return { kind: 'error', error: `HTTP ${res.status}` };
      return { kind: 'ok', body: String(body) };
    }
  };

  /** @type {Map<string, { terms: string[], admitted: any[] }>} */
  const results = new Map();
  /** @type {Map<string, { perTerm: Array<{ term: string, requests: number, returned: number, unrated: number, outOfWindow: number, unreadable: number, admitted: number, byLean: Record<string, number>, truncated: boolean, refused: boolean }>, admitted: any[] }>} */
  const perQuestion = new Map();
  outer: for (const q of due) {
    if (stats.requests + q.terms.length > limits.maxRequests) {
      stats.budgetStop = `request cap ${limits.maxRequests}`;
      log(`::warning::gdelt-intake: stopping — ${q.id} needs at least ${q.terms.length} requests and the run has ${limits.maxRequests - stats.requests} left of its cap; it and later questions wait for the next run`);
      break;
    }
    if (clock() + limits.timeoutMs > runDeadline) {
      stats.budgetStop = `run deadline ${Math.round(limits.runDeadlineMs / 1000)} s`;
      log(`::warning::gdelt-intake: stopping — the run deadline leaves no room for ${q.id}; it and later questions wait for the next run`);
      break;
    }
    const questionDeadline = Math.min(clock() + limits.questionDeadlineMs, runDeadline);
    const startDay = windowStartDay(q.checkedOn, today);
    /** @type {string[]} */
    const searched = [];
    const admittedAll = [];
    const perTerm = [];
    let ok = true;
    terms: for (const term of q.terms) {
      const query = buildGdeltQuery(term);
      const tally = { term, requests: 0, returned: 0, unrated: 0, outOfWindow: 0, unreadable: 0, admitted: 0, byLean: { left: 0, center: 0, right: 0 }, truncated: false, refused: false };
      /** @type {number | string} */
      let end = now;
      let refusedThisTerm = false;
      for (;;) {
        const r = await request(gdeltUrl({ query, startDay, end }), questionDeadline);
        if (r.kind === 'budget') {
          stats.budgetStop = r.why;
          stats.failed.push(q.id);
          log(`::warning::gdelt-intake: stopping — ${r.why} reached during ${q.id}; it is not updated, and it and later questions wait for the next run`);
          break outer;
        }
        if (r.kind === 'question_deadline') {
          ok = false;
          log(`::warning::gdelt-intake: ${q.id}: its ${Math.round(limits.questionDeadlineMs / 1000)}-s deadline would pass before "${term}" could be searched — question not updated this run; the run moves on to the next question`);
          break terms;
        }
        if (r.kind === 'rate_limited') {
          openCircuit('429');
          log(
            `::warning::gdelt-intake: GDELT is still answering 429${halfOpen ? ' on the half-open probe' : ` after ${limits.backoffMs.length} backoffs`} — circuit open, no further requests this run or for ${Math.round(limits.circuitCooldownMs / 60_000)} min. ${q.id} and later questions carry forward.`
          );
          stats.failed.push(q.id);
          break outer;
        }
        if (r.kind === 'silent' && (halfOpen || silentInARow >= SILENT_CIRCUIT)) {
          openCircuit('no answer');
          log(
            `::warning::gdelt-intake: ${halfOpen ? 'the half-open probe' : `${silentInARow} requests in a row`} got no answer from GDELT (${r.error}) — circuit open, no further requests this run or for ${Math.round(limits.circuitCooldownMs / 60_000)} min. ${q.id} and later questions carry forward.`
          );
          stats.failed.push(q.id);
          break outer;
        }
        if (r.kind === 'silent' || r.kind === 'error') {
          ok = false;
          log(`::warning::gdelt-intake: ${q.id} ("${term}"): ${r.error} — question not updated this run`);
          break terms;
        }
        // GDELT answered with a 200. That closes a half-open circuit: whatever
        // the body says, GDELT is answering again.
        if (halfOpen) {
          halfOpen = false;
          nextCircuit = null;
          log('gdelt-intake: GDELT answered the half-open probe — circuit closed.');
        }
        tally.requests += 1;
        const parsed = parseArtList(r.body);
        if (!parsed.ok && parsed.kind === 'refused') {
          refusedInARow++;
          refusedThisTerm = true;
          tally.refused = true;
          stats.refused.push({ id: q.id, term, chars: query.length, answer: parsed.error });
          log(`::warning::gdelt-intake: ${q.id}: GDELT refused the ${query.length}-character query for "${term}" (${parsed.error}) — the term is left out of this search and out of the stored terms; nothing else about the question changes.`);
          if (refusedInARow >= REFUSAL_CIRCUIT) {
            openCircuit('queries refused');
            log(`::warning::gdelt-intake: ${refusedInARow} queries in a row refused as queries — GDELT's rules have moved; circuit open, no further requests this run or for ${Math.round(limits.circuitCooldownMs / 60_000)} min. Re-measure the query shape (lib/question-press.mjs, GDELT_MAX_QUERY_CHARS).`);
            stats.failed.push(q.id);
            break outer;
          }
          break;
        }
        refusedInARow = 0;
        if (!parsed.ok) {
          ok = false;
          log(`::warning::gdelt-intake: ${q.id} ("${term}"): GDELT answered with ${parsed.kind === 'empty' ? 'an empty body' : `a malformed body (${parsed.error})`} — never read as "no coverage"; question not updated this run`);
          break terms;
        }
        stats.answeredLengths.push(query.length);
        const a = admitArticles(parsed.articles, { bias, today });
        tally.returned += parsed.articles.length;
        tally.unrated += a.unrated;
        tally.outOfWindow += a.outOfWindow;
        tally.unreadable += a.unreadable;
        tally.admitted += a.admitted.length;
        for (const x of a.admitted) tally.byLean[x.lean] += 1;
        admittedAll.push(...a.admitted);
        if (parsed.articles.length < GDELT_MAX_RECORDS) break; // the whole window is in hand
        // A full page: GDELT had more. Page backwards in time from the oldest
        // article it returned — a cut in time, the same instant for every lean.
        const oldest = parsed.articles.map((x) => seenStamp(x.seendate)).filter(Boolean).sort()[0] ?? null;
        const endStamp = typeof end === 'number' ? null : end;
        if (!oldest || tally.requests >= limits.maxPagesPerTerm || (endStamp !== null && oldest >= endStamp)) {
          tally.truncated = true;
          break;
        }
        end = oldest;
      }
      perTerm.push(tally);
      if (refusedThisTerm) continue;
      searched.push(term);
      if (tally.truncated) {
        log(`::warning::gdelt-intake: ${q.id}: "${term}" still filled GDELT's ${GDELT_MAX_RECORDS}-record page after ${tally.requests} page(s) — the oldest part of its window was NOT seen, for every lean alike (a cut in time, newest kept). A heavy week, not a quiet one.`);
      }
      // A response whose articles carry no usable link or seen-date is what a
      // changed response shape looks like — never let it read as "0 outlets".
      if (tally.returned > 0 && tally.unreadable === tally.returned) {
        log(`::warning::gdelt-intake: ${q.id}: GDELT returned ${tally.returned} article(s) for "${term}" and not one had a usable link and seen-date — if GDELT's fields changed, a zero here is a parse failure, not an absence`);
      }
    }
    if (!ok) {
      stats.failed.push(q.id);
      continue;
    }
    if (searched.length === 0) {
      stats.failed.push(q.id);
      log(`::warning::gdelt-intake: ${q.id}: GDELT refused every one of its queries — question not updated this run`);
      continue;
    }
    results.set(q.id, { terms: searched, admitted: admittedAll });
    perQuestion.set(q.id, { perTerm, admitted: admittedAll });
    stats.done.push(q.id);
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
  log(`gdelt-intake: query shape ${QUERY_SHAPE}; rated domains per lean — left ${domainsByLean.left.length}, center ${domainsByLean.center.length}, right ${domainsByLean.right.length}`);
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
      for (const t of run.perTerm) {
        if (t.refused) {
          log(`gdelt-intake: ${id}: "${t.term}" — REFUSED by GDELT as a query; not searched, not in the stored terms`);
          continue;
        }
        log(
          `gdelt-intake: ${id}: "${t.term}" — returned ${t.returned} in ${t.requests} page(s)${t.truncated ? ' (TRUNCATED)' : ''}: ` +
            `${t.admitted} from rated outlets (L${t.byLean.left}/C${t.byLean.center}/R${t.byLean.right}), ${t.unrated} unrated, ${t.outOfWindow} outside the window, ${t.unreadable} unreadable`
        );
      }
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
      `Requests ${stats.requests} (429s ${stats.rateLimited}) in ${Math.round((clock() - runStart) / 1000)} s; updated ${stats.done.length}, failed/waiting ${stats.failed.length}, not searchable ${stats.skipped.length}, already checked today ${stats.notDue.length}` +
      `${stats.circuitOpen ? `; circuit OPEN (${stats.circuitWhy})` : ''}.`
  );
  if (stats.answeredLengths.length || stats.refused.length) {
    log(
      `gdelt-intake: query length — longest GDELT answered this run ${stats.answeredLengths.length ? Math.max(...stats.answeredLengths) : 'none'}, ` +
        `refused as queries ${stats.refused.length ? stats.refused.map((r) => `${r.chars} ("${r.term}")`).join(', ') : 'none'} (cap ${limits.maxQueryChars}).`
    );
  }

  const write = shouldWrite({ previous, next: doc });
  return { doc, write, stats, today, circuit: nextCircuit };
}

/**
 * Read the persisted circuit; anything unreadable is a closed circuit (the
 * cost of a wrong "closed" is one ordinary run).
 * @param {string} path
 */
export function readCircuit(path) {
  try {
    if (!existsSync(path)) return null;
    const s = JSON.parse(readFileSync(path, 'utf8'))?.circuit;
    return s && s.open === true && typeof s.lastTryAt === 'string' && Number.isFinite(Date.parse(s.lastTryAt)) ? s : null;
  } catch {
    return null;
  }
}

async function main() {
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const moments = read('data/moments.json');
  const bills = read('data/bills.json');
  const bias = read('data/media-bias.json').outlets ?? {};
  const previous = existsSync(QUESTION_PRESS_PATH) ? read(QUESTION_PRESS_PATH) : null;
  const conversation = existsSync('data/conversation.json') ? read('data/conversation.json') : null;
  const statePath = process.env.GDELT_STATE_PATH || DEFAULT_STATE_PATH;
  // The owner's outlet floor is "rated, plus an optional approved allowlist"
  // (lib/press-outlets.mjs). This intake takes the rated half only, because
  // every count here is per lean and an allowlisted outlet has none. Say so
  // out loud the day an allowlist exists, rather than let an approved outlet
  // go silently uncounted.
  const policy = loadPressOutletPolicy({ readJSON: read, exists: existsSync });
  if (policy.allowlistSize > 0) {
    console.log(
      `::warning::gdelt-intake: ${PRESS_ALLOWLIST_PATH} approves ${policy.allowlistSize} outlet(s) beyond the AllSides-rated set; this intake counts rated outlets only (its counts are per lean) — allowlisted outlets are not counted until a lean-less bucket is added to lib/question-press.mjs.`
    );
  }
  const now = Date.now();
  const { doc, write, circuit } = await collect({
    moments,
    bills,
    bias,
    previous,
    conversation,
    circuit: readCircuit(statePath),
    now,
    fetchImpl: httpsFetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    limits: limitsFrom(process.env),
  });
  gdeltAgent.destroy();
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({ circuit }, null, 2)}\n`);
  if (!write) {
    console.log(`gdelt-intake: ${QUESTION_PRESS_PATH} not written — no count moved, and the file already carries today's check or nothing was checked today.`);
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
