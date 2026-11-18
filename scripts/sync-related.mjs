/**
 * Nightly: read the official record's "Identical bill" relations into
 * data/related-bills.json.
 *
 *   node --env-file=.env.local scripts/sync-related.mjs
 *
 * WHY (owner, 2026-11-13, his card on a bill's twin: "Yes, show it under the
 * bill as it is."). The bill page's coverage box also lists the articles
 * stored under a bill's twin (lib/coverage.ts, getCoverageWithTwins). This
 * script is where "twin" comes from, and it comes only from Congress.gov's
 * related-bills list, filtered by lib/related-bills.mjs to the record's own
 * "Identical bill" label. See that file's header for what is left out and why.
 *
 * WHICH BILLS. Every corpus bill with stored coverage (a twin's articles can
 * only come from a bill that has some), and every bill the file already
 * holds a relation for (so a relation the record has dropped is removed even
 * when its bill has no coverage). twinsOf reads each relation in both
 * directions, so the other side needs no call of its own. Never-checked bills
 * go first, then the longest ago; a bill checked in the last RECHECK_DAYS (7)
 * waits. So a relation the record drops can still show for up to about 8
 * days (docs/runbooks/related-bills.md says so). At most PER_NIGHT (200)
 * lookups a night. Bills no longer in data/bills.json are pruned first.
 *
 * COST: $0. Free Congress.gov requests only: one per bill, two when the
 * first answer is a 5xx or 429. No Anthropic call, no news API call.
 *
 * TIME (2026-11-17, after the independent check). An ordinary night is about
 * a minute: 520 lookups took 118 s on 2026-11-14, so 200 take about 45 s.
 * Hard bounds, so a slow or hung Congress.gov can never cost the night:
 *   - each attempt gets ATTEMPT_MS (15 s), body included;
 *   - a hang or a network error is NOT retried; a 5xx or 429 is retried once
 *     after PAUSE_MS (3 s): at most 15 + 3 + 15 = 33 s for one bill;
 *   - MAX_FAILS_IN_A_ROW (5) failed lookups in a row stop the run;
 *   - no new lookup starts after BUDGET_MS (5 min) from the start; what was
 *     read by then is written like any night's (2026-11-18), and the bills
 *     not read keep their old check day, so they go first the next night;
 *   - so the run ends within about 5 min + 33 s + a few seconds of reading
 *     and writing. The workflow step also runs it under `timeout 8m` and has
 *     `timeout-minutes: 10` as backstops.
 *
 * WHAT IT PRINTS, so the daily health report can read every outcome
 * (lib/related-bills.mjs: parseRelatedTrouble, relatedAlarms):
 *   - `RELATED START: …` first, before anything can fail. A log with this
 *     line and neither of the two below is a crash (or a kill by the step's
 *     timeout) the report alarms on.
 *   - `RELATED DONE: looked up N of M planned (F failed: a no answer, b an
 *     error status, c a misshapen answer; …` when it wrote, with
 *     `_meta.filled_at` set to today and `_meta.previous_carrying` set to the
 *     number of bills that carried a twin before tonight. A night the time
 *     budget cut short adds `; stopped early after K of M lookups …`. A
 *     lookup that fails leaves that bill as it was, so it stays first in line
 *     the next night; the report alarms when the bills that failed or were
 *     not read are half or more of the plan.
 *   - `RELATED STOPPED: <why>. data/related-bills.json was left as it was.`
 *     on every other ending: no key, five failures in a row, every lookup
 *     failed, the new file failed its own gate, or anything thrown. Printed
 *     as an ::error:: annotation. Whatever tonight read is not written: the
 *     file stays exactly as the night began.
 * The file is written to a temporary name and renamed, so it is never
 * half-written; a kill (SIGTERM) removes the temporary file, and
 * .gitignore keeps a leftover one out of the nightly commit.
 *
 * With no CONGRESS_API_KEY and no file yet, it writes an empty, valid file
 * (how the committed file was made) and still prints STOPPED: in the nightly
 * the key is always set, so a missing key there is a fault.
 *
 * The step is continue-on-error in sync-bills.yml, so this script's own exit
 * code never fails the job. scripts/verify-sync.mjs then checks the file
 * before the commit and fails the night only on damage this script cannot
 * write (lib/related-bills.mjs verifyRelatedBills; a bill that left the
 * corpus or a future date only warns).
 */
console.log('RELATED START: reading the record\'s "Identical bill" relations');

const STOPPED_TAIL = 'data/related-bills.json was left as it was.';
// Belt and braces: no error this prints should carry the key, but nothing it
// prints may ever show one, so any api_key=… is cut out.
const redact = (s) => String(s).replace(/api_key=[^&\s]*/gi, 'api_key=[redacted]');
const stop = (why, tail = STOPPED_TAIL) => {
  console.log(`::error::RELATED STOPPED: ${redact(why)}. ${tail}`);
  process.exitCode = 1;
};

try {
  // Imported after the START line, so a module that fails to load still
  // leaves a START line with no DONE (the crash case the report reads).
  const { existsSync, readFileSync, renameSync, rmSync, writeFileSync } = await import('node:fs');
  const { billApiPath } = await import('./congress-fetch.mjs');
  const {
    RELATED_BILLS_PATH,
    carryingCount,
    emptyRelatedBills,
    identicalFromRecord,
    planRelatedRun,
    pruneToCorpus,
    recordAnswerProblem,
    serializeRelatedBills,
    verifyRelatedBills,
  } = await import('../lib/related-bills.mjs');

  const envNum = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const PER_NIGHT = envNum('RELATED_PER_NIGHT', 200);
  const RECHECK_DAYS = envNum('RELATED_RECHECK_DAYS', 7);
  const ATTEMPT_MS = envNum('RELATED_ATTEMPT_TIMEOUT_MS', 15_000);
  const PAUSE_MS = envNum('RELATED_RETRY_PAUSE_MS', 3_000);
  const BUDGET_MS = envNum('RELATED_BUDGET_MS', 300_000);
  const MAX_FAILS_IN_A_ROW = envNum('RELATED_MAX_FAILS_IN_A_ROW', 5);
  const API = 'https://api.congress.gov/v3';
  // The day the run counts as. RELATED_TODAY lets a test drive nights on
  // pinned dates; it is accepted only when it is not after the real UTC day,
  // so this script cannot write a future filled_at or check day.
  const realToday = new Date().toISOString().slice(0, 10);
  const asked = process.env.RELATED_TODAY;
  const today = typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= realToday ? asked : realToday;
  const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const slugOf = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
  const tmp = `${RELATED_BILLS_PATH}.tmp`;
  rmSync(tmp, { force: true });
  // A kill (the step's timeout) must not leave the temporary file behind.
  process.on('SIGTERM', () => {
    rmSync(tmp, { force: true });
    process.exit(143);
  });
  const writeAtomic = (text) => {
    writeFileSync(tmp, text);
    renameSync(tmp, RELATED_BILLS_PATH);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let requests = 0;

  /** An Error that says which kind of failure it was: 'no-answer' (a hang or
   *  a dropped connection), 'status' (an error status), or 'shape' (an answer
   *  not in the documented shape). The DONE line and the health report's
   *  lookups alarm count them by kind. */
  const failure = (kind, message) => Object.assign(new Error(message), { kind });

  /** One bill's related-bills answer, or a thrown failure() saying why not. */
  const lookup = async (path) => {
    for (let attempt = 1; ; attempt++) {
      const url = new URL(`${API}${path}`);
      url.searchParams.set('limit', '250');
      url.searchParams.set('format', 'json');
      url.searchParams.set('api_key', process.env.CONGRESS_API_KEY);
      requests++;
      let res;
      let body;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(ATTEMPT_MS) });
        if (res.ok) body = await res.json();
      } catch (e) {
        // A hang or a dropped connection is not waited out twice.
        const hung = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        throw failure('no-answer', hung ? `no answer within ${ATTEMPT_MS / 1000} s for ${path}` : `could not read the answer for ${path} (${e?.name ?? 'error'})`);
      }
      if (res.ok) return body;
      if ((res.status >= 500 || res.status === 429) && attempt < 2) {
        await sleep(PAUSE_MS);
        continue;
      }
      throw failure('status', `Congress.gov ${res.status} for ${path}`);
    }
  };

  const prior = existsSync(RELATED_BILLS_PATH) ? readJSON(RELATED_BILLS_PATH) : null;

  if (!process.env.CONGRESS_API_KEY) {
    if (!prior) writeAtomic(serializeRelatedBills(emptyRelatedBills(today)));
    stop('CONGRESS_API_KEY is not set, so nothing was looked up', prior ? STOPPED_TAIL : 'No data/related-bills.json existed, so an empty one was written.');
  } else {
    const bills = readJSON('data/bills.json');
    const bySlug = new Map(bills.map((b) => [slugOf(b), b]));
    const corpus = new Set(bySlug.keys());
    const start = prior ?? emptyRelatedBills(today);
    const pruned = pruneToCorpus({ ...start, _checkedAt: start._checkedAt ?? {} }, corpus, today);
    const file = pruned.file;
    const previousCarrying = carryingCount(file);
    const coverage = readJSON('data/coverage.json');
    const withCoverage = Object.keys(coverage).filter((k) => !k.startsWith('_') && corpus.has(k));
    const inFile = Object.keys(file).filter((k) => !k.startsWith('_'));
    const candidates = [...new Set([...withCoverage, ...inFile])];
    const plan = planRelatedRun({ candidates, checkedAt: file._checkedAt, today, perNight: PER_NIGHT, recheckDays: RECHECK_DAYS });

    const began = Date.now();
    let ok = 0;
    let failed = 0;
    let inARow = 0;
    let firstError = null;
    let lastError = null;
    let stopReason = null;
    let stoppedEarly = null;
    const kinds = { 'no-answer': 0, status: 0, shape: 0 };
    let gained = 0;
    let lost = 0;
    for (const slug of plan) {
      if (Date.now() - began > BUDGET_MS) {
        // A clean early stop (2026-11-18): what was read is written below
        // like any night's, and the bills not read keep their old check day,
        // so they are first in line the next night.
        stoppedEarly = { after: ok + failed, of: plan.length };
        break;
      }
      let rows;
      try {
        const payload = await lookup(billApiPath(bySlug.get(slug), '/relatedbills'));
        const problem = recordAnswerProblem(payload);
        if (problem) throw failure('shape', `the answer for ${slug} is not in the documented shape: ${problem}`);
        // Only twins that are corpus bills (2026-11-18). A twin the corpus
        // does not hold has no page and no coverage, so storing it changed
        // nothing a reader sees, and pruneToCorpus took it out again the next
        // night: the file changed on alternate nights for nothing.
        rows = identicalFromRecord(payload, slug).filter((r) => corpus.has(r.slug));
        if ((payload?.pagination?.count ?? 0) > 250) {
          console.log(`::warning::${slug} has ${payload.pagination.count} related bills; only the first 250 were read`);
        }
      } catch (e) {
        failed++;
        inARow++;
        kinds[e?.kind in kinds ? e.kind : 'no-answer']++;
        lastError = redact(e?.message ?? e);
        firstError ??= lastError;
        console.log(`FAIL ${slug}: ${lastError}`);
        if (inARow >= MAX_FAILS_IN_A_ROW) {
          stopReason = `${inARow} lookups in a row failed (the last: ${lastError})`;
          break;
        }
        continue;
      }
      ok++;
      inARow = 0;
      const before = new Set((file[slug] ?? []).map((r) => r.slug));
      const after = new Set(rows.map((r) => r.slug));
      for (const s of after) {
        if (before.has(s)) continue;
        gained++;
        console.log(`identical: ${slug} <-> ${s}`);
      }
      for (const s of before) {
        if (after.has(s)) continue;
        lost++;
        console.log(`no longer listed as identical: ${slug} <-> ${s}`);
      }
      if (rows.length) file[slug] = rows;
      else delete file[slug];
      file._checkedAt[slug] = today;
    }

    if (stopReason) {
      stop(stopReason);
    } else if (ok === 0 && (stoppedEarly ? stoppedEarly.after : plan.length) > 0) {
      stop(`all ${stoppedEarly ? stoppedEarly.after : plan.length} lookups failed (the first: ${firstError})`);
    } else {
      // The day this run finished (the stale alarm's clock) and the count of
      // bills with a twin before tonight (the twin-count alarm's baseline).
      file._meta = { ...file._meta, filled_at: today, previous_carrying: previousCarrying };
      const text = serializeRelatedBills(file);
      const { failures, warnings } = verifyRelatedBills({ data: JSON.parse(text), fileBytes: Buffer.byteLength(text), today, knownSlugs: corpus });
      for (const w of warnings) console.log(`::warning::${w}`);
      if (failures.length) {
        for (const f of failures) console.log(f);
        stop(`the new file failed its own gate (${failures.length} finding(s); the first: ${failures[0]})`);
      } else {
        writeAtomic(text);
        const failedText = failed
          ? `${failed} failed: ${kinds['no-answer']} no answer, ${kinds.status} an error status, ${kinds.shape} a misshapen answer`
          : '0 failed';
        const early = stoppedEarly
          ? `; stopped early after ${stoppedEarly.after} of ${stoppedEarly.of} lookups at the ${BUDGET_MS / 1000}-second time budget, so Congress.gov is answering very slowly, and the ${stoppedEarly.of - stoppedEarly.after} not read go first next night`
          : '';
        console.log(
          `RELATED DONE: looked up ${ok} of ${plan.length} planned (${failedText}; ${candidates.length} candidate bills, ${withCoverage.length} with coverage)${early}; ${gained} relation(s) added, ${lost} removed; ${carryingCount(file)} bills carry an identical bill (${previousCarrying} before tonight); pruned ${pruned.keys} bill(s) and ${pruned.rows} twin row(s) no longer in data/bills.json${pruned.future ? `, and treated ${pruned.future} future check day(s) as never checked` : ''}. Congress.gov requests: ${requests}. Cost: $0.`
        );
      }
    }
  }
} catch (e) {
  stop(`it threw: ${e?.message ?? e}`);
}
