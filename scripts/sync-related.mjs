/**
 * Nightly: read the official record's "Identical bill" relations for the
 * bills that carry stored press coverage, into data/related-bills.json.
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
 * WHICH BILLS, AND HOW MANY A NIGHT. Only bills with stored coverage are
 * looked up: a twin's articles can only come from a bill that has some, and
 * twinsOf reads each relation in both directions, so the bill on the other
 * side needs no call of its own. Bills never looked at go first, then the
 * ones looked at longest ago; a bill looked at in the last RECHECK_DAYS is
 * skipped. At most RELATED_PER_NIGHT calls a night.
 *
 * COST: $0. One free Congress.gov request per bill looked at (at most
 * RELATED_PER_NIGHT = 200 a night; the key's limit is 5,000 an hour). No
 * Anthropic call, no news API call.
 *
 * WHAT IT PRINTS, so the daily health report can read every outcome
 * (lib/pipeline-health.mjs, parseRelatedTrouble, and its alarms):
 *   - `RELATED START: …` first, before anything can fail. A log with this
 *     line and neither of the two below is a crash the report alarms on.
 *   - `RELATED DONE: looked up N of M planned (F failed; …` when it wrote.
 *     A request that fails leaves that bill as it was (old relations, old
 *     check day), so it stays first in line for the next night; the report
 *     alarms when half or more of a night's lookups failed.
 *   - `RELATED STOPPED: <why>. data/related-bills.json was left as it was.`
 *     on every other way it ends: no key, every lookup failed, the new file
 *     failed its own gate, or anything thrown. Printed as an ::error::
 *     annotation too. The file is never left half-written (written to a
 *     temporary name, then renamed).
 *
 * With no CONGRESS_API_KEY and no file yet, it writes an empty, valid file
 * (how the committed file was made) and still prints STOPPED: in the nightly
 * the key is always set, so a missing key there is a fault.
 *
 * The step is continue-on-error in sync-bills.yml: whatever happens here, the
 * rest of the night still commits. scripts/verify-sync.mjs re-checks the file
 * before the commit and, if it is damaged, puts back the committed copy rather
 * than failing the night (and prints STOPPED for the report).
 */
console.log('RELATED START: reading the record\'s "Identical bill" relations for bills with stored coverage');

const STOPPED_TAIL = 'data/related-bills.json was left as it was.';
// Belt and braces: no request error should carry the key, but nothing this
// prints may ever show one, so any api_key=… is cut out of what it prints.
const redact = (s) => String(s).replace(/api_key=[^&\s]*/gi, 'api_key=[redacted]');
const stop = (why) => {
  const line = `RELATED STOPPED: ${redact(why)}. ${STOPPED_TAIL}`;
  console.log(`::error::${line}`);
  process.exitCode = 1;
};

try {
  // Imported after the START line, so a module that fails to load still
  // leaves a START line with no DONE (the crash case the report reads).
  const { existsSync, readFileSync, renameSync, writeFileSync } = await import('node:fs');
  const { billApiPath, cg } = await import('./congress-fetch.mjs');
  const { RELATED_BILLS_PATH, emptyRelatedBills, identicalFromRecord, planRelatedRun, serializeRelatedBills, verifyRelatedBills } =
    await import('../lib/related-bills.mjs');

  const envNum = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const PER_NIGHT = envNum('RELATED_PER_NIGHT', 200);
  const RECHECK_DAYS = envNum('RELATED_RECHECK_DAYS', 7);
  const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  const slugOf = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
  const writeAtomic = (text) => {
    const tmp = `${RELATED_BILLS_PATH}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, RELATED_BILLS_PATH);
  };

  const prior = existsSync(RELATED_BILLS_PATH) ? readJSON(RELATED_BILLS_PATH) : null;
  const file = prior ?? emptyRelatedBills();
  if (!file._checkedAt || typeof file._checkedAt !== 'object') file._checkedAt = {};

  if (!process.env.CONGRESS_API_KEY) {
    if (!prior) writeAtomic(serializeRelatedBills(file));
    stop(`CONGRESS_API_KEY is not set, so nothing was looked up${prior ? '' : ' (an empty file was written, since none existed)'}`);
  } else {
    const bills = readJSON('data/bills.json');
    const bySlug = new Map(bills.map((b) => [slugOf(b), b]));
    const coverage = readJSON('data/coverage.json');
    const candidates = Object.keys(coverage).filter((k) => !k.startsWith('_') && bySlug.has(k));
    const plan = planRelatedRun({ candidates, checkedAt: file._checkedAt, today, perNight: PER_NIGHT, recheckDays: RECHECK_DAYS });

    let ok = 0;
    let failed = 0;
    let firstError = null;
    let gained = 0;
    let lost = 0;
    for (const slug of plan) {
      let payload;
      try {
        payload = await cg(billApiPath(bySlug.get(slug), '/relatedbills'), { limit: '250' });
      } catch (e) {
        failed++;
        firstError ??= String(e?.message ?? e);
        console.log(`FAIL ${slug}: ${redact(e?.message ?? e)}`);
        continue;
      }
      ok++;
      const rows = identicalFromRecord(payload, slug);
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
      if ((payload?.pagination?.count ?? 0) > 250) {
        console.log(`::warning::${slug} has ${payload.pagination.count} related bills; only the first 250 were read`);
      }
    }

    if (ok === 0 && plan.length > 0) {
      stop(`all ${plan.length} lookups failed (the first: ${firstError})`);
    } else {
      const text = serializeRelatedBills(file);
      const { failures } = verifyRelatedBills({
        data: JSON.parse(text),
        fileBytes: Buffer.byteLength(text),
        today,
        knownSlugs: new Set(bySlug.keys()),
      });
      if (failures.length) {
        for (const f of failures) console.log(f);
        stop(`the new file failed its own gate (${failures.length} finding(s); the first: ${failures[0]})`);
      } else {
        writeAtomic(text);
        const carrying = Object.keys(file).filter((k) => !k.startsWith('_')).length;
        console.log(
          `RELATED DONE: looked up ${ok} of ${plan.length} planned (${failed} failed; ${candidates.length} bills with coverage); ${gained} relation(s) added, ${lost} removed; ${carrying} bills carry an identical bill. Congress.gov requests: ${ok + failed}. Cost: $0.`
        );
      }
    }
  }
} catch (e) {
  stop(`it threw: ${e?.message ?? e}`);
}
