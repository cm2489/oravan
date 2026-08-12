/**
 * Post-sync dead-man's-switch. Runs in sync-bills.yml AFTER the sync scripts
 * and BEFORE the commit/push step, so a night where the sync silently did
 * nothing — or damaged the corpus — fails the workflow loudly instead of
 * hiding behind a green checkmark. (Three such silent failures shipped in 19
 * days; see docs/solutions/ for the ledger.)
 *
 * FAILS (exit 1) when the sync itself didn't do its job tonight:
 *   - data/bills.json or data/bills-es.json don't parse or are empty
 *   - sync-state.json's lastRun didn't advance past this run's start
 *     (RUN_STARTED_AT, captured by the workflow before the sync step)
 *   - lastSync is not a full ISO-8601 datetime — the bare-date cursor that
 *     400-looped every night from 2026-06-25 to 07-01 (PR #16)
 *   - the bill count dropped more than 2% vs the committed corpus (the sync
 *     only ever appends, so any real drop means corruption)
 *   - a bills.json record belongs to a Congress this build does not track
 *     (congress_number !== congress-fetch.mjs's CONGRESS) — added 2026-08-11
 *     after two 118th-Congress seed records (s-1776-118, s-5110-118) sat in
 *     the corpus for two months rendering live pages; see offCongressBills
 *   - EN/ES parity broke: a decoded bill without a bills-es.json entry, or
 *     an ES entry pointing at a bill that doesn't exist
 *   - data/floor-signals.json (the T0 announcement layer) doesn't parse,
 *     carries an unknown schema, blew its size ceiling, or holds a signal
 *     with no verbatim English quote, no https source URL or no publication
 *     date — the file whose contents get QUOTED to readers as Congress's own
 *     words is the one place an unevidenced claim must never survive. Skipped
 *     cleanly when the file doesn't exist. The judgement lives in
 *     scripts/floor-signals-parse.mjs (verifyFloorSignals)
 *   - data/moment-updates.json (the v2 live layer) doesn't parse, isn't an
 *     object, carries an unknown _meta.schema, references a moment that
 *     doesn't exist in data/moments.json, lost >50% of its updates overnight,
 *     broke EN/ES parity, went future-dated, blew the size ceiling, or blew
 *     one of the retention caps (revisions per moment, updates per moment,
 *     updates per day). Every part of it is skipped cleanly when the file
 *     doesn't exist — on HEAD or in the working tree. The judgement lives in
 *     lib/verify-moment-updates.mjs; see that file's header for why the
 *     retention caps are checked here as well as in check-moment-updates.mjs.
 *
 * WHAT THIS FILE NO LONGER DOES, and where it went (owner ruling 2026-08-12,
 * N8-A2). The CURSOR-AGE ceiling — "the cursor is more than 10 days old" —
 * used to fail here, which meant it failed BEFORE sync-bills.yml's commit
 * step, which meant a stalled night threw away its own already-paid work:
 * the decodes, coverage, nominations and Moment updates all went unrecorded
 * because a DIFFERENT thing (progress) had stopped. It now lives in
 * scripts/check-cursor-age.mjs and runs as the LAST step of the nightly, after
 * the commit: the run still goes red and still shouts, and the data still
 * lands. See that file's header for the full reasoning, including why
 * committing the frozen cursor is the more honest of the two options.
 *
 * THE SPLIT IS THE POINT, and it is one line: this file asks "is the corpus
 * damaged", check-cursor-age.mjs asks "are we falling behind". The cursor's
 * FORMAT stays here, because a bare-date or fractional-seconds cursor is
 * damage — it 400s Congress.gov on every request and has shipped two
 * multi-day outages — while its AGE is only ever lateness.
 * tests/nightly-pipeline.unit.spec.ts pins which check lives where — and in
 * which order the workflow runs them — so the boundary cannot quietly drift
 * back.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { MOMENT_UPDATES_PATH, verifyMomentUpdates } from '../lib/verify-moment-updates.mjs';
// Import-clean by contract: congress-fetch.mjs reads CONGRESS_API_KEY per
// fetch, never at import, so pulling CONGRESS in here needs no secrets and
// makes no network call. One definition of "the Congress we track" — bumping
// it there bumps this gate too.
import { CONGRESS, offCongressBills } from './congress-fetch.mjs';
// Same split as verifyMomentUpdates above: the judgement lives in a pure
// module the unit spec can reach, this file supplies the bytes.
import { FLOOR_SIGNALS_PATH, verifyFloorSignals } from './floor-signals-parse.mjs';

let failed = false;
const fail = (msg) => {
  console.error(`::error::${msg}`);
  failed = true;
};
const warn = (msg) => console.log(`::warning::${msg}`);

function parse(label, text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`${label} does not parse as JSON: ${e.message}`);
    return null;
  }
}

const slugOf = (b) =>
  `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

// --- corpus integrity -------------------------------------------------------
const bills = parse('data/bills.json', readFileSync('data/bills.json', 'utf8'));
const es = parse('data/bills-es.json', readFileSync('data/bills-es.json', 'utf8'));

if (bills !== null && (!Array.isArray(bills) || bills.length === 0)) {
  fail('data/bills.json is not a non-empty array');
}
if (es !== null && (typeof es !== 'object' || Array.isArray(es))) {
  fail('data/bills-es.json is not an object keyed by slug');
}

// Corpus uniformity: one Congress, no strays (2026-08-11). Independent of the
// ES half below on purpose — a previous-Congress record is a lie about the
// record whether or not its Spanish twin exists. Every failure names its
// slugs; the first 10 are enough to act on and keep a CI annotation readable.
if (Array.isArray(bills) && bills.length > 0) {
  const strays = offCongressBills(bills, CONGRESS);
  if (strays.length) {
    fail(
      `${strays.length} bills.json record(s) are not from the ${CONGRESS}th Congress (${strays.slice(0, 10).join(', ')}${strays.length > 10 ? ', …' : ''}) — every write path is pinned to CONGRESS=${CONGRESS} (scripts/congress-fetch.mjs), so these were seeded or force-fetched, and their pages assert present-tense activity for a Congress this build does not track. Remove them, or bump CONGRESS if the tracked Congress really changed.`
    );
  } else {
    console.log(`corpus uniformity: all ${bills.length} bills are ${CONGRESS}th Congress`);
  }
}

if (Array.isArray(bills) && bills.length > 0 && es && typeof es === 'object') {
  const slugs = new Set(bills.map(slugOf));
  const missingEs = bills
    .filter((b) => b.ai_headline && b.ai_summary && !es[slugOf(b)])
    .map(slugOf);
  const orphanEs = Object.keys(es).filter((k) => !slugs.has(k));
  if (missingEs.length) {
    fail(
      `EN/ES parity broke: ${missingEs.length} decoded bill(s) have no bills-es.json entry (first: ${missingEs[0]})`
    );
  }
  if (orphanEs.length) {
    fail(
      `EN/ES parity broke: ${orphanEs.length} bills-es.json entr(ies) point at bills that don't exist (first: ${orphanEs[0]})`
    );
  }

  // Bill count vs the committed corpus. The sync only appends; a drop >2% is
  // corruption, any drop at all is suspicious.
  try {
    const before = JSON.parse(
      execSync('git show HEAD:data/bills.json', {
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
      })
    );
    if (bills.length < before.length * 0.98) {
      fail(`bill count dropped ${before.length} -> ${bills.length} (>2%)`);
    } else if (bills.length < before.length) {
      warn(`bill count dropped ${before.length} -> ${bills.length} — the sync never removes bills; worth a look`);
    } else {
      console.log(`bill count: ${before.length} -> ${bills.length}`);
    }
  } catch {
    warn('could not read HEAD:data/bills.json for the count comparison (shallow checkout without the file?)');
  }
}

// --- coverage: a partial run must never shrink the coverage file ------------
// Gradual shrink is normal (articles age out, bills go terminal). An
// overnight cliff means a quota-stopped or crashed coverage run replaced the
// file with a partial result. sync-coverage carries unprocessed bills forward
// precisely to prevent that — this is the backstop if that logic regresses.
const coverage = parse('data/coverage.json', readFileSync('data/coverage.json', 'utf8'));
if (coverage && typeof coverage === 'object' && !Array.isArray(coverage)) {
  const covCount = Object.keys(coverage).filter((k) => !k.startsWith('_')).length;
  try {
    const before = JSON.parse(
      execSync('git show HEAD:data/coverage.json', {
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
      })
    );
    const beforeCount = Object.keys(before).filter((k) => !k.startsWith('_')).length;
    if (beforeCount >= 20 && covCount < beforeCount * 0.5) {
      fail(`coverage.json shrank ${beforeCount} -> ${covCount} bills (>50% overnight) — partial coverage run replaced the file`);
    } else if (beforeCount >= 20 && covCount < beforeCount * 0.8) {
      warn(`coverage.json shrank ${beforeCount} -> ${covCount} bills (>20% overnight) — worth a look`);
    } else {
      console.log(`coverage: ${beforeCount} -> ${covCount} bills`);
    }
  } catch {
    warn('could not read HEAD:data/coverage.json for the coverage comparison');
  }
}

// --- moment updates: the live layer must not silently lose its record -------
//
// THE EDITORIAL LAW this guards (v2 spec §2, the project records): "Truth about the record… When the record is
// silent — motive, likelihood, what it really means — Oravan's voice stops."
// A nightly run that quietly halves the timeline, or lands a future-dated
// update, or ships an EN line with no ES sibling, is the live layer telling a
// story the record does not support. Same dead-man's-switch posture as the
// bill and coverage checks above: shrink is the tell, and >50% overnight is
// corruption rather than retention.
//
// ALL OF IT is tolerant of the file not existing — on HEAD (the collector,
// slice S3, is what first writes it) and in the working tree (a branch that
// predates the live layer must still verify cleanly).
//
// The judgement itself lives in lib/verify-moment-updates.mjs — the same split
// scripts/check-moment-updates.mjs uses, so the whole block is reachable from
// tests/moment-updates.unit.spec.ts. This file supplies the bytes.
if (!existsSync(MOMENT_UPDATES_PATH)) {
  console.log(`${MOMENT_UPDATES_PATH} not present — skipping the moment-updates checks`);
} else {
  const updates = parse(MOMENT_UPDATES_PATH, readFileSync(MOMENT_UPDATES_PATH, 'utf8'));
  if (updates !== null) {
    let before = null;
    try {
      before = JSON.parse(
        execSync(`git show HEAD:${MOMENT_UPDATES_PATH}`, {
          encoding: 'utf8',
          maxBuffer: 512 * 1024 * 1024,
          // Silence git's "exists on disk, but not in HEAD" — the expected
          // case on the branch that first adds the file, and a red `fatal:`
          // in a green CI log is exactly the noise that trains people to
          // stop reading logs.
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      );
    } catch {
      // Expected on the branch that first adds the file, and on a shallow
      // checkout — never a failure.
    }

    const { failures, warnings, notes } = verifyMomentUpdates({
      updates,
      moments: parse('data/moments.json', readFileSync('data/moments.json', 'utf8')),
      before,
      fileBytes: statSync(MOMENT_UPDATES_PATH).size,
    });
    for (const n of notes) console.log(n);
    for (const w of warnings) warn(w);
    for (const f of failures) fail(f);
  }
}

// --- floor signals: every T0 claim carries its own evidence -----------------
//
// data/floor-signals.json is written hourly by scripts/floor-signals.mjs and
// is the only file on the site whose contents are QUOTED to a reader as
// Congress's own forward-looking words. So the gate is about evidence, not
// about volume: a signal with no quote, no https source URL, no publication
// date — or a quote in any language but the English of the record (owner
// ruling V4) — is a claim nobody can check, and it fails the run rather than
// reaching a page. Skipped cleanly when the file doesn't exist, exactly like
// the moment-updates block above: a branch that predates the ladder must
// still verify.
if (!existsSync(FLOOR_SIGNALS_PATH)) {
  console.log(`${FLOOR_SIGNALS_PATH} not present — skipping the floor-signals checks`);
} else {
  const signals = parse(FLOOR_SIGNALS_PATH, readFileSync(FLOOR_SIGNALS_PATH, 'utf8'));
  if (signals !== null) {
    const { failures, warnings, notes } = verifyFloorSignals({
      data: signals,
      fileBytes: statSync(FLOOR_SIGNALS_PATH).size,
      knownSlugs: Array.isArray(bills) ? new Set(bills.map(slugOf)) : null,
    });
    for (const n of notes) console.log(n);
    for (const w of warnings) warn(w);
    for (const f of failures) fail(f);
  }
}

// --- sync-state: did tonight's run actually run? ----------------------------
const state = parse('data/sync-state.json', readFileSync('data/sync-state.json', 'utf8'));
if (state) {
  const runStartedAt = process.env.RUN_STARTED_AT;
  if (!runStartedAt) {
    console.log('RUN_STARTED_AT not set (local run?) — skipping the lastRun-advanced check');
  } else if (!state.lastRun || Date.parse(state.lastRun) < Date.parse(runStartedAt)) {
    fail(
      `sync-state.json lastRun (${state.lastRun}) did not advance past this run's start (${runStartedAt}) — the sync did not complete tonight`
    );
  }

  // Strict seconds-precision shape: a bare date 400s Congress.gov (PR #16,
  // the 06-25 outage) and so do Date.toISOString() milliseconds (the
  // 07-17/07-22 outage) - /T/-plus-parseable passed the poisoned .862Z
  // cursor straight through, so pin the exact accepted format instead.
  if (
    !state.lastSync ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(state.lastSync) ||
    Number.isNaN(Date.parse(state.lastSync))
  ) {
    fail(
      `sync-state.json lastSync (${JSON.stringify(state.lastSync)}) is not a seconds-precision ISO-8601 datetime (YYYY-MM-DDTHH:MM:SSZ) — Congress.gov 400s on both bare-date and fractional-seconds fromDateTime cursors (PR #16; 2026-07-17/22 outage)`
    );
  }
  // The cursor's AGE is deliberately not judged here any more — see this
  // file's header and scripts/check-cursor-age.mjs, which runs after the
  // commit so a stalled night keeps the work it paid for.
}

if (failed) process.exit(1);
console.log('sync verification passed');
