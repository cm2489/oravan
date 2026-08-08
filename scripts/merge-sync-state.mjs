#!/usr/bin/env node
/**
 * merge-sync-state.mjs — deterministic union resolver for data/sync-state.json.
 *
 * WHY THIS EXISTS (run 31194836148, 2026-08-07)
 * ---------------------------------------------
 * A manually dispatched nightly sync with coverage_top_n=2400 did all of its
 * work — bills, a 2,400-bill coverage pass (339 bills with coverage, 661
 * articles, ~2,373 PAID TheNewsAPI requests and the day's quota, ending in a
 * 429 storm), Moment updates, portraits, both dead-man's-switch verifies — and
 * then threw every byte of it away in the "Commit data" step:
 *
 *     ! [rejected]  main -> main (fetch first)
 *     push rejected, rebasing onto latest main (attempt 1)
 *     CONFLICT (content): Merge conflict in data/sync-state.json
 *     error: could not apply 4032b3e... chore(data): nightly bill sync 2026-08-07
 *
 * PR #166 merged mid-run and added `nominationsLastSync` to this file; the
 * run's own commit rewrote `lastSync`/`lastRun` in the same file. The commit
 * step's retry loop was built for a racing DATA WORKFLOW (a fast-forward
 * problem) and cannot survive a CONTENT conflict: `git rebase` stops mid-
 * rebase, leaving the working tree in a state no later iteration can recover
 * from. (In the incident the loop did not even reach attempt 2 — the step runs
 * under `bash -e`, so the failing `git rebase` killed the script outright. The
 * five attempts were never the backstop they looked like.)
 *
 * Now that feature branches touch this file at all, ANY long sync overlapping
 * ANY such merge fails that way. This module makes that class of conflict
 * resolvable instead of fatal.
 *
 * WHAT MAKES IT SAFE TO RESOLVE
 * -----------------------------
 * data/sync-state.json is a flat object of INDEPENDENT keys — cursors
 * (`lastSync`, `nominationsLastSync`), a display stamp (`lastRun`), and a
 * human-authored `note`. Nothing here is a document whose parts have to agree
 * with each other, so a per-key union is a total, deterministic resolution.
 * That is emphatically NOT true of data/bills.json or any other corpus file,
 * which is why the caller only ever points this script at THIS path and fails
 * loudly on a conflict in anything else.
 *
 * THE MERGE IS 3-WAY, NOT 2-WAY, AND THAT MATTERS
 * -----------------------------------------------
 * Both writers (scripts/sync-bills.mjs, scripts/sync-nominations.mjs) load the
 * whole state object, set their own keys, and write the whole object back. So
 * a sync commit ECHOES every key it does not own — `note` included. A 2-way
 * "take the run's side" union would therefore let a stale echo of `note`
 * clobber a `note` a PR had just rewritten, and it could not tell the
 * difference. Comparing both sides against the merge base (git's stage 1)
 * says exactly which keys each side actually MOVED, so an echo never wins
 * anything.
 *
 * PER-KEY RULE
 * ------------
 *   only the run moved it        -> the run's value
 *   only main moved it           -> main's value      (a PR's new key, or `note`)
 *   both moved it, same value    -> that value        (not a real conflict)
 *   both moved it, timestamps    -> the NEWER one, verbatim
 *   both moved it, anything else -> THROW. Not deterministically resolvable.
 *   neither moved it             -> the base value
 * A key absent on the winning side is absent from the result: a PR that
 * deliberately DELETES a key has that honored rather than silently undone.
 *
 * WHY "NEWER WINS" FOR TIMESTAMPS
 * -------------------------------
 * It makes the resolver monotonic and therefore order-independent: the commit
 * step may rebase several times in one run, and no attempt may ever undo an
 * earlier one. Per key:
 *
 *   lastRun — a display stamp ("Data as of…", lib/freshness.ts) that
 *     verify-sync.mjs requires to have advanced past RUN_STARTED_AT. It has no
 *     event semantics at all; moving it backwards would both understate the
 *     corpus's freshness on the site and risk tripping a later run's
 *     dead-man's-switch. Newer is simply correct.
 *
 *   lastSync / nominationsLastSync — high-water cursors. Backwards costs a
 *     re-fetch of an already-processed window, which is idempotent (bills
 *     upsert by slug; nominations dedupe by slug and refuse to shrink) and
 *     self-heals. FORWARDS permanently skips whatever fell in the gap, and
 *     nothing ever notices. So for a cursor, forward is the DANGEROUS
 *     direction, and "newer wins" is the riskier-looking choice — it is still
 *     the right one here because of who writes these values: each is written
 *     only after the work it covers succeeded (sync-bills.mjs advances to
 *     runStart only on a clean run and to the high-water mark otherwise;
 *     sync-nominations.mjs advances "only as far as we actually read"). A
 *     newer value is therefore always backed by more completed work, never
 *     less.
 *
 *     The one case that rule does not serve is a HUMAN cursor repair — and
 *     this file's own `note` records one (the 2026-07-17/22 fractional-seconds
 *     outage was fixed by hand-editing lastSync). If a repair PR lands while a
 *     sync is in flight AND the sync also moved the same cursor, newer-wins
 *     keeps the sync's value and the repair has to be re-applied. That is why
 *     every both-moved key is logged as a ::warning:: naming both values — the
 *     overwrite is visible in the run log rather than silent. Rare, loud, and
 *     recoverable, versus the alternative of failing the step and burning
 *     another 2,400 paid requests.
 *
 * FORMAT NOTE — DO NOT "NORMALIZE" THE WINNER
 * -------------------------------------------
 * The winning value is copied VERBATIM, never re-serialized through a Date.
 * Congress.gov 400s a fromDateTime that carries fractional seconds, which is
 * what caused outage #2; re-emitting a cursor via toISOString() would append
 * `.000Z` and re-open it. verify-sync.mjs and check-nominations.mjs both pin
 * the seconds-precision shape, so a normalization here would fail the gates —
 * but only on the NEXT run, long after the damage.
 *
 * USAGE
 *   node scripts/merge-sync-state.mjs
 * Run from the REPOSITORY ROOT during a conflicted rebase/merge (both paths
 * below are repo-relative, which is where the workflow runs it). Reads the
 * three index stages for data/sync-state.json, writes the resolved file, and
 * leaves `git add` to the caller. Exits non-zero (loudly) rather than guessing.
 *
 * mergeSyncState() itself is pure and I/O-free — see tests/merge-sync-state.unit.spec.ts.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export const SYNC_STATE_PATH = 'data/sync-state.json';

/** Absence of a key, kept distinct from a key explicitly set to undefined. */
const ABSENT = Symbol('absent');

/*
 * Deliberately strict. A loose `!Number.isNaN(Date.parse(v))` test would call
 * plenty of prose a timestamp (V8 happily parses "note 5" and similar), and
 * misclassifying a human `note` as a timestamp is exactly how a "resolvable"
 * conflict would start silently discarding someone's sentence.
 */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isTimestamp(value) {
  return (
    typeof value === 'string' && ISO_DATETIME.test(value) && !Number.isNaN(Date.parse(value))
  );
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const get = (obj, key) => (has(obj, key) ? obj[key] : ABSENT);

/** Structural equality, good enough for JSON scalars plus the ABSENT sentinel. */
function sameValue(a, b) {
  if (a === ABSENT || b === ABSENT) return a === b;
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function assertFlatObject(value, side) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `${SYNC_STATE_PATH}: the ${side} side is not a JSON object (got ${
        Array.isArray(value) ? 'an array' : String(value === null ? 'null' : typeof value)
      }) — refusing to guess at a resolution`
    );
  }
  return value;
}

/**
 * Union two versions of the flat sync-state object against their merge base.
 *
 * Every side is typed `unknown` on purpose: validating them IS this function's
 * job, and the callers are a shell pipeline and a spec, neither of which can
 * promise a shape.
 *
 * @param {object} args
 * @param {unknown} [args.base] stage 1 — the common ancestor. Optional; an absent
 *   base degrades to a 2-way union, which is still safe because every both-moved
 *   non-timestamp key throws.
 * @param {unknown} args.remote stage 2 — origin/main. NOTE the rebase inversion:
 *   during `git rebase`, stage 2 ("ours") is the branch being rebased ONTO, i.e.
 *   main — not this run's work.
 * @param {unknown} args.run    stage 3 — the commit being replayed, i.e. THIS sync
 *   run's commit ("theirs" during a rebase).
 * @returns {{merged: Record<string, unknown>, decisions: Array<{key: string, winner: string, reason: string}>}}
 */
export function mergeSyncState({ base, remote, run }) {
  const b = assertFlatObject(base ?? {}, 'base');
  const r = assertFlatObject(remote, 'remote (origin/main)');
  const m = assertFlatObject(run, 'run (this sync commit)');

  // Key order: the run's own order first, so a clean resolution is
  // byte-identical to what the sync would have written unraced; then keys only
  // main or the base knew about, appended in their own order.
  const keys = [];
  for (const source of [m, r, b]) {
    for (const k of Object.keys(source)) if (!keys.includes(k)) keys.push(k);
  }

  const merged = {};
  const decisions = [];

  for (const key of keys) {
    const baseValue = get(b, key);
    const remoteValue = get(r, key);
    const runValue = get(m, key);

    const runMoved = !sameValue(runValue, baseValue);
    const remoteMoved = !sameValue(remoteValue, baseValue);

    let winner;
    let decision;

    if (sameValue(runValue, remoteValue)) {
      // Includes "neither moved it" and "both made the identical edit".
      winner = runValue;
      decision = { key, winner: 'agreed', reason: 'both sides hold the same value' };
    } else if (runMoved && !remoteMoved) {
      winner = runValue;
      decision = { key, winner: 'run', reason: 'only this run moved it' };
    } else if (remoteMoved && !runMoved) {
      winner = remoteValue;
      decision = {
        key,
        winner: 'remote',
        reason: 'only origin/main moved it (this run merely echoed the base value)',
      };
    } else if (isTimestamp(runValue) && isTimestamp(remoteValue)) {
      const runNewer = Date.parse(runValue) >= Date.parse(remoteValue);
      winner = runNewer ? runValue : remoteValue;
      decision = {
        key,
        winner: runNewer ? 'run' : 'remote',
        reason: `both sides moved it; newer timestamp wins (run=${runValue}, origin/main=${remoteValue})`,
      };
    } else {
      throw new Error(
        `${SYNC_STATE_PATH}: key "${key}" was changed on BOTH sides and is not a pair of ` +
          `timestamps, so there is no deterministic union ` +
          `(origin/main=${JSON.stringify(remoteValue === ABSENT ? null : remoteValue)}, ` +
          `run=${JSON.stringify(runValue === ABSENT ? null : runValue)}). Resolve by hand.`
      );
    }

    if (winner !== ABSENT) merged[key] = winner;
    else decision.reason += ' — key deleted';
    decisions.push(decision);
  }

  return { merged, decisions };
}

// ---------------------------------------------------------------- CLI ------

function readStage(stage) {
  try {
    return execFileSync('git', ['show', `:${stage}:${SYNC_STATE_PATH}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Stage 1 legitimately does not exist when both sides ADDED the file.
    return null;
  }
}

function fail(message) {
  console.error(`::error::merge-sync-state: ${message}`);
  process.exit(1);
}

function main() {
  const baseText = readStage(1);
  const remoteText = readStage(2);
  const runText = readStage(3);

  if (remoteText === null || runText === null) {
    fail(
      `${SYNC_STATE_PATH} is not conflicted in the index (missing stage ` +
        `${remoteText === null ? '2' : '3'}). This script only ever runs on a live conflict.`
    );
  }

  let base = {};
  if (baseText !== null && baseText.trim() !== '') {
    try {
      base = JSON.parse(baseText);
    } catch (e) {
      // Degrade to a 2-way union rather than throw away the run's paid work:
      // the base is only used to attribute WHICH side moved a key, and without
      // it every both-moved non-timestamp key still fails loudly below.
      console.warn(
        `::warning::merge-sync-state: the merge base of ${SYNC_STATE_PATH} does not parse ` +
          `(${e.message}); falling back to a 2-way union.`
      );
      base = {};
    }
  }

  let remote;
  let run;
  try {
    remote = JSON.parse(remoteText);
  } catch (e) {
    fail(`origin/main's ${SYNC_STATE_PATH} does not parse (${e.message})`);
  }
  try {
    run = JSON.parse(runText);
  } catch (e) {
    fail(`this run's ${SYNC_STATE_PATH} does not parse (${e.message})`);
  }

  let result;
  try {
    result = mergeSyncState({ base, remote, run });
  } catch (e) {
    fail(e.message);
  }

  for (const d of result.decisions) {
    const bothMoved = d.reason.startsWith('both sides moved it');
    const line = `  ${d.key}: ${d.winner} — ${d.reason}`;
    if (bothMoved) console.warn(`::warning::merge-sync-state: ${line.trim()}`);
    else console.log(line);
  }

  // Match this run's own trailing-newline convention so the resolved file is
  // byte-identical to what the sync would have committed had nothing raced it.
  const trailer = runText.endsWith('\n') ? '\n' : '';
  writeFileSync(SYNC_STATE_PATH, `${JSON.stringify(result.merged, null, 2)}${trailer}`);
  console.log(
    `merge-sync-state: resolved ${SYNC_STATE_PATH} by union (${
      Object.keys(result.merged).length
    } keys). Caller must \`git add\` it.`
  );
}

/*
 * Only run the CLI when node executed this file directly, so the unit spec can
 * import mergeSyncState() without touching git. Every read lives inside main(),
 * so a bare import does no I/O at all.
 *
 * The guard tests process.argv[1] rather than `import.meta.url`, copying
 * scripts/moment-updates.mjs — which learned it the hard way and says so:
 * Playwright's transform `require()`s an imported .mjs, and any `import.meta`
 * in the module makes it emit CJS `exports.…` into a file node then loads as
 * ESM ("ReferenceError: exports is not defined in ES module scope", which
 * collects ZERO tests rather than failing one). Same reason there is no
 * top-level await here.
 *
 * Anchored on the path separator, not a bare endsWith, so a future
 * scripts/*merge-sync-state.mjs could never trigger this one.
 */
if (/(^|\/)merge-sync-state\.mjs$/.test(process.argv[1] ?? '')) main();
