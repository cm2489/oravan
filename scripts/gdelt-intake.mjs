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
 *   - GDELT_MAX_REQUESTS (36, retries included) and GDELT_MAX_RUN_MS (6 min)
 *     cap every run regardless;
 *   - any other failure (5xx, timeout, GDELT's plain-text query errors) fails
 *     THAT question and the run moves on — without spending the question's
 *     remaining lean searches, since a question only updates when all three
 *     succeed.
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
  shouldWrite,
  termTitleHits,
  timespanFor,
  verifyQuestionPress,
} from '../lib/question-press.mjs';
import { RATED_LEANS, dayKey } from '../lib/conversation.mjs';

export const USER_AGENT = 'oravan-gdelt-intake/1.0 (+https://github.com/cm2489/oravan)';

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

  /** @type {Array<{ id: string, moment: any, terms: string[] }>} */
  const due = [];
  const stats = { requests: 0, rateLimited: 0, circuitOpen: false, budgetStop: null, done: [], failed: [], skipped: [], notDue: [] };
  for (const { id, moment } of live) {
    const { terms, dropped } = questionTerms(moment, billsBySlug);
    for (const d of dropped) log(`gdelt-intake: ${id}: dropped ${d.source} "${d.term}" — ${d.reason}`);
    if (terms.length === 0) {
      stats.skipped.push(id);
      log(`::warning::gdelt-intake: ${id} has no multi-word press vocabulary (aliases are bill-number placeholders and the vehicles carry no multi-word name) — not searched. Real aliases in data/moments.json are the owner's call.`);
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

  const startedAt = clock();
  let lastRequestAt = -Infinity;
  /** @returns {Promise<{ kind: 'ok', body: string } | { kind: 'rate_limited' } | { kind: 'error', error: string } | { kind: 'budget', why: string }>} */
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
        return { kind: 'error', error: `fetch failed: ${err?.message ?? err}` };
      }
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
  /** @type {Map<string, { byLean: Record<string, { returned: number, admitted: number, rejected: number, truncated: boolean }>, admitted: any[] }>} */
  const perQuestion = new Map();
  outer: for (const q of due) {
    const timespanDays = timespanFor(q.checkedOn, today);
    const admittedAll = [];
    const byLean = {};
    let ok = true;
    for (const lean of RATED_LEANS) {
      const domains = domainsByLean[lean];
      if (!domains.length) {
        ok = false;
        log(`::warning::gdelt-intake: ${q.id}: data/media-bias.json rates no ${lean} domains — cannot search every lean, question not updated`);
        break;
      }
      const url = gdeltUrl({ query: buildGdeltQuery({ terms: q.terms, domains }), timespanDays });
      const r = await request(url);
      if (r.kind === 'budget') {
        stats.budgetStop = r.why;
        log(`::warning::gdelt-intake: stopping — ${r.why} reached; ${q.id} and later questions wait for the next run`);
        break outer;
      }
      if (r.kind === 'rate_limited') {
        stats.circuitOpen = true;
        log(`::warning::gdelt-intake: GDELT is still answering 429 after ${limits.backoffMs.length} backoffs — circuit open, no further requests this run. ${q.id} and later questions carry forward and retry next run.`);
        break outer;
      }
      if (r.kind === 'error') {
        ok = false;
        log(`::warning::gdelt-intake: ${q.id} (${lean}): ${r.error} — question not updated this run`);
        break;
      }
      const parsed = parseArtList(r.body);
      if (!parsed.ok) {
        ok = false;
        log(`::warning::gdelt-intake: ${q.id} (${lean}): GDELT answered ${parsed.error} — question not updated this run`);
        break;
      }
      const { admitted, rejected } = admitArticles(parsed.articles, { lean, bias, today });
      byLean[lean] = { returned: parsed.articles.length, admitted: admitted.length, rejected, truncated: parsed.articles.length >= 250 };
      admittedAll.push(...admitted);
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

  const doc = buildQuestionPress({ previous, liveIds, results, bias, today });

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
      const lb = RATED_LEANS.map((l) => `${l[0].toUpperCase()} ${run.byLean[l]?.returned ?? 0}→${run.byLean[l]?.admitted ?? 0}${run.byLean[l]?.truncated ? ' (TRUNCATED at 250)' : ''}`);
      log(`gdelt-intake: ${id}: returned→admitted this run: ${lb.join(', ')}`);
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

  return { doc, write: shouldWrite({ previous, next: doc }), stats, today };
}

async function main() {
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const moments = read('data/moments.json');
  const bills = read('data/bills.json');
  const bias = read('data/media-bias.json').outlets ?? {};
  const previous = existsSync(QUESTION_PRESS_PATH) ? read(QUESTION_PRESS_PATH) : null;
  const conversation = existsSync('data/conversation.json') ? read('data/conversation.json') : null;
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
