/**
 * Nightly: read the official record's "Identical bill" relations for the
 * bills that carry stored press coverage, into data/related-bills.json.
 *
 *   node --env-file=.env.local scripts/sync-related.mjs
 *
 * WHY (owner, 2026-11-13, his card on a bill's twin: "Yes, show it under the
 * bill as it is."). The bill page's coverage box also lists the articles
 * stored under a bill's twin (lib/coverage.ts, coverageForBillWithTwins). This
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
 * FAILURES. A request that fails leaves that bill exactly as it was (its old
 * relations and its old check day). A night on which every request fails
 * leaves the file byte-for-byte as it was. With no CONGRESS_API_KEY the
 * script only makes sure the file exists (an empty, valid one), so the site
 * builds before the first night has run.
 *
 * The gate on what this writes is lib/related-bills.mjs's verifyRelatedBills,
 * run by scripts/verify-sync.mjs before the nightly commit and by
 * scripts/check-related-bills.mjs in CI.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { billApiPath, cg } from './congress-fetch.mjs';
import {
  RELATED_BILLS_PATH,
  emptyRelatedBills,
  identicalFromRecord,
  planRelatedRun,
  verifyRelatedBills,
} from '../lib/related-bills.mjs';

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

/** Write in a stable order, so a night with no change is no diff. */
function serialize(file) {
  const out = { _note: file._note, _meta: file._meta, _checkedAt: {} };
  for (const k of Object.keys(file._checkedAt ?? {}).sort()) out._checkedAt[k] = file._checkedAt[k];
  for (const k of Object.keys(file).filter((k) => !k.startsWith('_')).sort()) out[k] = file[k];
  return `${JSON.stringify(out, null, 1)}\n`;
}

async function main() {
  const prior = existsSync(RELATED_BILLS_PATH) ? readJSON(RELATED_BILLS_PATH) : null;
  const file = prior ?? emptyRelatedBills();
  if (!file._checkedAt || typeof file._checkedAt !== 'object') file._checkedAt = {};

  if (!process.env.CONGRESS_API_KEY) {
    if (!prior) writeFileSync(RELATED_BILLS_PATH, serialize(file));
    console.log(
      `CONGRESS_API_KEY missing — no related-bills lookup tonight; ${prior ? `${RELATED_BILLS_PATH} left as it was` : `wrote an empty ${RELATED_BILLS_PATH}`}.`
    );
    return;
  }

  const bills = readJSON('data/bills.json');
  const bySlug = new Map(bills.map((b) => [slugOf(b), b]));
  const coverage = readJSON('data/coverage.json');
  const candidates = Object.keys(coverage).filter((k) => !k.startsWith('_') && bySlug.has(k));
  const plan = planRelatedRun({ candidates, checkedAt: file._checkedAt, today, perNight: PER_NIGHT, recheckDays: RECHECK_DAYS });

  let ok = 0;
  let failed = 0;
  let gained = 0;
  let lost = 0;
  for (const slug of plan) {
    let payload;
    try {
      payload = await cg(billApiPath(bySlug.get(slug), '/relatedbills'), { limit: '250' });
    } catch (e) {
      failed++;
      console.log(`FAIL ${slug}: ${e?.message ?? e}`);
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
    console.log(`::warning::related bills: all ${plan.length} lookups failed — ${RELATED_BILLS_PATH} left as it was`);
    return;
  }
  const text = serialize(file);
  const { failures } = verifyRelatedBills({ data: JSON.parse(text), fileBytes: Buffer.byteLength(text), today, knownSlugs: new Set(bySlug.keys()) });
  if (failures.length) {
    for (const f of failures) console.log(`::error::${f}`);
    console.log(`related bills: the new file fails its own gate — ${RELATED_BILLS_PATH} left as it was`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(RELATED_BILLS_PATH, text);
  const carrying = Object.keys(file).filter((k) => !k.startsWith('_')).length;
  console.log(
    `RELATED DONE: looked up ${ok} of ${plan.length} planned (${failed} failed; ${candidates.length} bills with coverage); ${gained} relation(s) added, ${lost} removed; ${carrying} bills carry an identical bill. Congress.gov requests: ${ok + failed}. Cost: $0.`
  );
}

main().catch((e) => {
  console.error(`::error::related bills: ${e?.message ?? e}`);
  process.exitCode = 1;
});
