/**
 * THE NIGHTLY STATUS RE-DERIVATION PASS (2026-09-24).
 *
 * A bill's stored `status` is `mapStatus(last_action_text)`
 * (scripts/congress-fetch.mjs), but it is only ever computed when the sync
 * REFRESHES the bill — i.e. when Congress.gov reports the bill updated. So
 * every matcher improvement left the corpus wrong until each affected bill
 * happened to move again: on 2026-09-24 hconres-86-119 still read `committee`
 * three months after both chambers had agreed to it, because its last action
 * ("Message on Senate action sent to the House.") never changed again after
 * the rule that reads it landed. This pass closes that gap: every night, for
 * every bill, the stored status is compared with what the CURRENT matcher
 * reads from the stored sentence, and a disagreement is corrected.
 *
 * WHAT IT WRITES, AND WHY ONLY THAT. Exactly what `refreshBillFields` writes
 * from the status and nothing else: `status`, and `urgency_score`, recomputed
 * by calling the same `urgencyScore(status, last_action_date)` the sync calls
 * (never a copy). The sentence and its date are untouched — this pass reads
 * the record, it never re-dates it. A bill whose stored text is empty is
 * skipped, for the reason `readableAction` gives: no text supports no
 * conclusion, and mapStatus(undefined) falling through to `committee` is the
 * exact rewrite refreshBillFields refuses to make.
 *
 * THE SPANISH CORPUS. data/bills-es.json is keyed by slug and today carries
 * only the translated `headline`/`summary`/`sections` — no status. The pass
 * still reads it and mirrors any status-bearing field an entry carries, so if
 * the Spanish record ever gains one the two cannot drift; it never adds or
 * removes an entry, so verify-sync.mjs's EN/ES parity gate is unaffected by
 * construction. When nothing in it changes, the file is not rewritten.
 *
 * THE GUARD. A matcher bug must not flip the corpus silently. If more than
 * MAX_CHANGE_FRACTION (2%) of the corpus would change in one night, the pass
 * prints the full list, writes NOTHING, and exits 1. It runs before
 * verify-sync.mjs and before the commit (.github/workflows/sync-bills.yml),
 * so a tripped guard reds the run before anything lands — correct for a
 * corpus claim, which is what a status is (see the N8-A2 split pinned in
 * tests/nightly-pipeline.unit.spec.ts). A deliberate large correction is a
 * one-off local run with the guard read and understood, not a nightly event.
 *
 * AMBIGUOUS SENTENCES need CONGRESS_API_KEY: they are resolved from the
 * action before them (see planRederive). Without the key the pass still runs
 * and leaves those bills exactly as they are, with a WARN line per slug.
 *
 * Usage: node scripts/rederive-status.mjs [--dry-run]
 *        (locally: node --env-file=.env.local scripts/rederive-status.mjs --dry-run)
 *   --dry-run  print what would change (and whether the guard would trip),
 *              write nothing, exit 0 unless the guard would trip.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAmbiguousAction, mapStatus, resolveAmbiguousStatus, slugOf, urgencyScore } from './congress-fetch.mjs';

export const MAX_CHANGE_FRACTION = 0.02;

/**
 * Every bill whose stored status disagrees with what the current matcher
 * reads from its stored last action. Never mutates.
 *
 * AMBIGUOUS LAST ACTIONS (congress-fetch.mjs's AMBIGUOUS_WITHOUT_CONTEXT) are
 * never read from the sentence itself: every such bill is resolved from the
 * action BEFORE it via `resolveAmbiguousStatus` — including one whose stored
 * status already agrees with mapStatus's passage default, because that
 * default is exactly the claim that has to be checked (H.Con.Res. 38 and
 * H.R. 2262 both FAILED in the House under that sentence). When the lookup
 * cannot be made (no key, Congress.gov down) the stored status stands and a
 * warning names the slug. On 2026-09-24 that was 13 bills: 13 free requests.
 *
 * @param {Array<Record<string, any>>} bills
 * @param {{ resolve?: typeof resolveAmbiguousStatus }} [opts]
 * @returns {Promise<{ changes: Array<{ slug: string, from: string, to: string, basis?: string }>, warnings: string[] }>}
 */
export async function planRederive(bills, { resolve = resolveAmbiguousStatus } = {}) {
  const changes = [];
  const warnings = [];
  for (const b of bills) {
    if (!b?.last_action_text) continue;
    if (isAmbiguousAction(b.last_action_text)) {
      const resolved = await resolve(b);
      if (!resolved) {
        warnings.push(
          `WARN ${slugOf(b)}: ambiguous last action ("${b.last_action_text}") and the action before it could not be read; status kept at ${b.status}`
        );
        continue;
      }
      if (resolved.status !== b.status) {
        changes.push({ slug: slugOf(b), from: b.status, to: resolved.status, basis: resolved.basis });
      }
      continue;
    }
    const to = mapStatus(b.last_action_text);
    if (to !== b.status) changes.push({ slug: slugOf(b), from: b.status, to });
  }
  return { changes, warnings };
}

/**
 * Whether a night's change count is small enough to apply unattended.
 * @param {number} changed @param {number} total
 */
export function guardVerdict(changed, total) {
  const limit = Math.floor(total * MAX_CHANGE_FRACTION);
  return { ok: changed <= limit, changed, total, limit };
}

/**
 * Apply a plan to the EN corpus (array) and the ES corpus (object keyed by
 * slug) in place, in lockstep. Returns whether the ES corpus was touched.
 * @param {Array<Record<string, any>>} bills
 * @param {Record<string, Record<string, any>>} es
 * @param {Array<{ slug: string, from?: string, to: string }>} changes
 */
export function applyRederive(bills, es, changes) {
  const bySlug = new Map(bills.map((b) => [slugOf(b), b]));
  let esTouched = false;
  for (const { slug, to } of changes) {
    const b = bySlug.get(slug);
    if (!b) continue;
    b.status = to;
    b.urgency_score = urgencyScore(to, b.last_action_date ?? null);
    const e = es?.[slug];
    if (e && Object.prototype.hasOwnProperty.call(e, 'status')) {
      e.status = to;
      if (Object.prototype.hasOwnProperty.call(e, 'urgency_score')) e.urgency_score = b.urgency_score;
      esTouched = true;
    }
  }
  return { esTouched };
}

/** One printed line per change, stable order. */
function listLines(changes) {
  return changes
    .map((c) => `  ${c.slug}: ${c.from} -> ${c.to}${c.basis ? `  (read from: "${c.basis}")` : ''}`)
    .join('\n');
}

/**
 * The whole pass over a pair of corpora, file-free so tests can drive it.
 * @param {Array<Record<string, any>>} bills
 * @param {Record<string, Record<string, any>>} es
 * @param {{ dryRun?: boolean, resolve?: typeof resolveAmbiguousStatus }} [opts]
 * @returns {Promise<{ code: number, log: string[], warnings: string[], changes: Array<{slug:string,from:string,to:string,basis?:string}>, wrote: { en: boolean, es: boolean } }>}
 */
export async function runRederive(bills, es, { dryRun = false, resolve = resolveAmbiguousStatus } = {}) {
  const log = [];
  const { changes, warnings } = await planRederive(bills, { resolve });
  const verdict = guardVerdict(changes.length, bills.length);
  if (!verdict.ok) {
    log.push(
      `REDERIVE_GUARD_TRIPPED: ${changes.length} of ${bills.length} bills would change status tonight, above the ${Math.round(MAX_CHANGE_FRACTION * 100)}% ceiling (${verdict.limit}). A matcher change that moves this much of the corpus must be read by a person first - NOTHING was written.`,
      listLines(changes)
    );
    return { code: 1, log, warnings, changes, wrote: { en: false, es: false } };
  }
  if (dryRun) {
    log.push(`DRY RUN: ${changes.length} of ${bills.length} bills would change status (guard limit ${verdict.limit}); nothing written.`);
    if (changes.length) log.push(listLines(changes));
    return { code: 0, log, warnings, changes, wrote: { en: false, es: false } };
  }
  const { esTouched } = applyRederive(bills, es, changes);
  log.push(
    `DONE: rederive-status changed ${changes.length} of ${bills.length} bills` +
      (changes.length ? `: ${changes.map((c) => `${c.slug} ${c.from}->${c.to}`).join(', ')}` : '')
  );
  return { code: 0, log, warnings, changes, wrote: { en: changes.length > 0, es: esTouched } };
}

// Script body only when executed directly — the same argv[1] guard
// scripts/check-cursor-age.mjs uses, so importing the functions above reads
// no file.
if (/(^|\/)rederive-status\.mjs$/.test(process.argv[1] ?? '')) {
  const dryRun = process.argv.includes('--dry-run');
  const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
  const es = JSON.parse(readFileSync('data/bills-es.json', 'utf8'));
  // `.then`, not top-level await: the test suite loads this module through
  // require(), which refuses any ESM graph containing a top-level await.
  runRederive(bills, es, { dryRun }).then(
    ({ code, log, warnings, wrote }) => {
      for (const w of warnings) console.warn(w);
      for (const line of log) (code ? console.error : console.log)(line);
      // Written together, as sync-bills.mjs's writeCorpus does; the ES file
      // only when an entry in it actually changed, so a no-op night leaves it
      // byte-identical.
      if (wrote.en) writeFileSync('data/bills.json', JSON.stringify(bills));
      if (wrote.es) writeFileSync('data/bills-es.json', JSON.stringify(es));
      process.exit(code);
    },
    (e) => {
      console.error(`rederive-status: ${e?.message ?? e} - nothing written`);
      process.exit(1);
    }
  );
}
