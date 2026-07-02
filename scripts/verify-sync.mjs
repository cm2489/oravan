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
 *   - EN/ES parity broke: a decoded bill without a bills-es.json entry, or
 *     an ES entry pointing at a bill that doesn't exist
 *
 * WARNS (::warning, never fails) on corpus staleness: the cursor is weeks
 * behind BY DESIGN while the 361-bill decode backlog drains (the high-water
 * mark freezes at the oldest bill still awaiting decode — see
 * docs/solutions/pinned-sync-cursor.md). A wall-clock staleness failure
 * would fire every night until the backlog clears; revisit the threshold
 * once these warnings stop.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

  if (!state.lastSync || !/T/.test(state.lastSync) || Number.isNaN(Date.parse(state.lastSync))) {
    fail(
      `sync-state.json lastSync (${JSON.stringify(state.lastSync)}) is not a full ISO-8601 datetime — Congress.gov 400s on bare-date fromDateTime cursors (PR #16)`
    );
  } else {
    const cursorAgeDays = (Date.now() - Date.parse(state.lastSync)) / 86_400_000;
    if (cursorAgeDays > 7) {
      warn(
        `corpus cursor is ${Math.round(cursorAgeDays)} days old (lastSync ${state.lastSync}). Expected while the decode backlog drains; if this warning persists after the backlog clears, promote it to a failure.`
      );
    }
  }
}

if (failed) process.exit(1);
console.log('sync verification passed');
