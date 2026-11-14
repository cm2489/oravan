/**
 * Nightly READ OF THE RECORD'S SHORT TITLES: data/short-titles.json.
 *
 *   node --env-file=.env.local scripts/sync-short-titles.mjs [--dry-run]
 *
 * Needs CONGRESS_API_KEY. No Anthropic key, no AI, no spend: one free
 * Congress.gov request per bill, /bill/{congress}/{type}/{number}/titles, and
 * the short titles the record itself labels as the bill's (lib/short-titles.mjs
 * says exactly which). They feed the name addresses (oravan.org/continuing-appropriations-act-2027,
 * lib/short-address.ts); nothing a page prints reads them.
 *
 * HOW MANY REQUESTS. At most SHORT_TITLES_MAX_PER_NIGHT (500; the
 * SHORT_TITLES_MAX env var overrides it for a catch-up dispatch) a night:
 * first every corpus bill never read, most urgent first, then every bill whose
 * last action moved since its titles were read. The first fill of a
 * 3,300-bill corpus takes about seven nights; after that a night reads the
 * bills that moved (a few hundred at most). Congress.gov allows 5,000
 * requests an hour per key, and the cap keeps this step well inside what the
 * rest of the nightly leaves.
 *
 * WHAT IT NEVER DOES. Replace a bill's non-empty titles with none (a failed
 * or empty answer keeps what the file had; the record never takes a short
 * title back), write a file the gate refuses (lib/short-titles.mjs's
 * verifyShortTitles, which scripts/verify-sync.mjs runs again before the
 * commit), or touch any other file.
 *
 * A SEPARATE SCRIPT AND STEP, continue-on-error (the sync-votes.mjs
 * precedent): a titles-side outage must never cost the night's bill statuses.
 *
 * SHORT_TITLES_FILE (env) writes somewhere other than data/short-titles.json:
 * for a read-only scratch fill that must leave the repository untouched.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { billApiPath, cg, slugOf } from './congress-fetch.mjs';
import {
  planShortTitleReads,
  serializeShortTitles,
  SHORT_TITLES_MAX_PER_NIGHT,
  SHORT_TITLES_PATH,
  shortTitlesFromRecord,
  verifyShortTitles,
} from '../lib/short-titles.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const OUT = process.env.SHORT_TITLES_FILE || SHORT_TITLES_PATH;
const CAP = process.env.SHORT_TITLES_MAX ? Number(process.env.SHORT_TITLES_MAX) : SHORT_TITLES_MAX_PER_NIGHT;

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const file = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const bySlug = new Map(bills.map((b) => [slugOf(b), b]));

const plan = planShortTitleReads({ bills, file, cap: CAP });
console.log(
  `short titles: ${plan.neverRead} bill(s) never read, ${plan.stale} whose last action moved; reading ${plan.run.length} tonight (cap ${CAP}), ${plan.deferred} left for later nights`
);

let requests = 0, changed = 0, kept = 0, failed = 0, withTitles = 0;
for (const slug of plan.run) {
  const bill = bySlug.get(slug);
  let titles;
  try {
    requests++;
    // limit=250: the titles list of one bill is one page (the longest seen
    // on 2026-11-14 held 30 entries).
    const res = await cg(billApiPath(bill, '/titles'), { limit: '250' });
    titles = shortTitlesFromRecord(res?.titles);
  } catch (e) {
    failed++;
    console.log(`  ${slug}: could not read its titles (${e?.message ?? e}); left as it was`);
    continue;
  }
  const old = file[slug];
  if (old && Array.isArray(old.titles) && old.titles.length > 0 && titles.length === 0) {
    kept++;
    console.log(`::warning::${slug}: the record answered with no short title where it had ${old.titles.length}; kept the earlier ones`);
    file[slug] = { titles: old.titles, as_of: bill.last_action_date ?? null };
    continue;
  }
  if (!old || JSON.stringify(old.titles) !== JSON.stringify(titles)) changed++;
  if (titles.length) withTitles++;
  file[slug] = { titles, as_of: bill.last_action_date ?? null };
}

const text = serializeShortTitles(file, bills);
const before = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const { failures, notes } = verifyShortTitles({ data: JSON.parse(text), bills, before });
for (const n of notes) console.log(n);
console.log(
  `short titles: ${requests} request(s), ${withTitles} of them with a short title, ${changed} entr${changed === 1 ? 'y' : 'ies'} new or changed, ${kept} kept over an empty answer, ${failed} failed`
);
if (failures.length) {
  for (const f of failures) console.error(`::error::${f}`);
  console.error(`::error::${OUT} not written: the gate refused it`);
  process.exit(1);
}
if (DRY_RUN) console.log('--dry-run: nothing written');
else writeFileSync(OUT, text);
