import { expect, test } from '@playwright/test';
// Imported from the nightly script ITSELF, not a copy - this is the exact
// predicate scripts/sync-bills.mjs evaluates at the end of every run.
//
// That import is also, on its own, a regression test for the argv[1] guard
// that now wraps that script's body: without the guard, importing the module
// runs a live sync and this whole file dies at import time on a missing
// CONGRESS_API_KEY. If this spec ever fails to load, look there first.
import {
  MOSTLY_FAILED_FLOOR,
  mostlyFailedVerdict,
  shouldAbortMostlyFailed,
} from '../scripts/sync-bills.mjs';

/*
 * Pins the minimum-sample floor on the nightly's "mostly failed" abort.
 *
 * The abort exists so a genuinely broken night can't be committed. What it
 * actually did was end healthy nights: `failed > updated.length / 2` was
 * evaluated against the ascending backlog pass's window, which - now that
 * the cursor is caught up - is routinely one or two bills. One transient
 * Congress.gov 500 then satisfied "more than half" and exited 1 from the
 * FIRST step of sync-bills.yml, throwing away the AI decodes the run had
 * already paid for and skipping nominations, coverage, Moment updates and
 * portraits for the whole night.
 *
 * The floor makes "majority" mean something before it is allowed to cost a
 * night. It deliberately does NOT make the abort the only guard - it never
 * was: scripts/verify-sync.mjs still fails the run, before anything is
 * committed, when the corpus doesn't parse, EN/ES parity breaks, the bill
 * count drops, or lastRun didn't advance.
 */

const abort = shouldAbortMostlyFailed as (failed: number, total: number) => boolean;
const FLOOR = MOSTLY_FAILED_FLOOR as number;

type Tallies = { ascendingFailed?: number; forceFailed?: number; windowSize?: number };
type Verdict = { abort: boolean; underFloor: boolean; ignoredForceFailures: number };
const verdict = mostlyFailedVerdict as (t: Tallies) => Verdict;

test.describe('shouldAbortMostlyFailed (nightly "mostly failed" abort)', () => {
  test('the floor is 8 - retuning it is a deliberate act, not a drive-by', () => {
    // Pinned so a change to the constant has to come here and say why.
    expect(FLOOR).toBe(8);
  });

  test('a quiet night with one transient failure does NOT end the run', () => {
    // The exact shape of the bug: a 1-2 bill window, one flaky refresh.
    expect(abort(1, 1)).toBe(false);
    expect(abort(1, 2)).toBe(false);
    expect(abort(2, 2)).toBe(false);
    expect(abort(2, 3)).toBe(false);
  });

  test('a big pass that really did mostly fail still aborts', () => {
    expect(abort(5, 8)).toBe(true);
    expect(abort(51, 100)).toBe(true);
    expect(abort(300, 500)).toBe(true);
    // MAX_UPDATES is 500, so this is the largest window the sync can produce.
    expect(abort(500, 500)).toBe(true);
  });

  test('at the floor exactly, the majority test resumes - and stays STRICTLY more than half', () => {
    expect(abort(4, 8)).toBe(false); // exactly half, at the floor: not a majority
    expect(abort(5, 8)).toBe(true); // one more than half: a majority
    expect(abort(250, 500)).toBe(false); // exactly half, far above the floor
    expect(abort(251, 500)).toBe(true);
  });

  test('one bill under the floor, nothing aborts - the trade this fix makes', () => {
    // Stated plainly because it IS the cost: a 7-bill pass that failed
    // outright rides on to the gates instead of exiting here. That is the
    // intended trade - verify-sync.mjs (corpus parse, EN/ES parity, >2%
    // count drop, lastRun advanced) is what fails such a night, and it runs
    // before a single byte is committed.
    expect(abort(7, 7)).toBe(false);
    expect(abort(FLOOR - 1, FLOOR - 1)).toBe(false);
    expect(abort(FLOOR, FLOOR)).toBe(true);
  });

  test('an empty or clean pass never aborts', () => {
    expect(abort(0, 0)).toBe(false); // nothing updated tonight - nothing to judge
    expect(abort(0, 1)).toBe(false);
    expect(abort(0, 500)).toBe(false);
    expect(abort(1, 500)).toBe(false);
  });
});

/*
 * The NUMERATOR's scope, which was the other half of the same bug.
 *
 * `failed` was compared against the ascending pass's `updated.length` while
 * also absorbing failures from the force-slug direct-fetch loop - a loop that
 * contributes nothing to that window. FORCE_DECODE_SLUGS is owner input for a
 * manual catch-up run (or newsdesk.mjs's in-process trigger list), so a single
 * typo'd or untracked slug counted against a denominator it was never part of:
 * on a quiet night - window of 2, one bad slug - that alone satisfied "more
 * than half" and ended a run whose backlog scan was perfectly healthy.
 *
 * Keeping the two tallies apart is now a property of the code (the verdict
 * function takes forceFailed and provably never feeds it to the predicate)
 * rather than a comment asking to be believed.
 */
test.describe('mostlyFailedVerdict (which failures the abort is allowed to judge)', () => {
  test('a bad FORCE_DECODE_SLUGS entry cannot end a healthy night', () => {
    // The exact shape: a big, healthy ascending window; the owner's force list
    // has one dud in it.
    const v = verdict({ ascendingFailed: 0, forceFailed: 1, windowSize: 10 });
    expect(v.abort).toBe(false);
    expect(v.ignoredForceFailures).toBe(1);
    // Folded in the old way, this is 1 of 10 - still fine. The quiet-night
    // shape below is where it actually cost a run.
  });

  test('force-slug failures are excluded even when they would have flipped the verdict', () => {
    // 5 of 8 was an abort; 0 of 8 is not. Same run, and the only difference is
    // whose failures get counted.
    expect(verdict({ ascendingFailed: 0, forceFailed: 5, windowSize: 8 }).abort).toBe(false);
    expect(abort(5, 8)).toBe(true); // what the old, conflated counter computed
    // A whole force list that failed still can't end the night on its own.
    expect(verdict({ ascendingFailed: 0, forceFailed: 40, windowSize: 40 }).abort).toBe(false);
  });

  test('a genuinely broken backlog scan still aborts, force list or not', () => {
    expect(verdict({ ascendingFailed: 5, forceFailed: 0, windowSize: 8 }).abort).toBe(true);
    expect(verdict({ ascendingFailed: 300, forceFailed: 2, windowSize: 500 }).abort).toBe(true);
  });

  test('the under-floor log fires on the same runs it always did', () => {
    // Over half, under the floor: logged, never fatal.
    const v = verdict({ ascendingFailed: 2, forceFailed: 0, windowSize: 3 });
    expect(v.abort).toBe(false);
    expect(v.underFloor).toBe(true);
    // An aborting run is not ALSO reported as under-floor.
    expect(verdict({ ascendingFailed: 5, forceFailed: 0, windowSize: 8 }).underFloor).toBe(false);
    // A clean run is neither.
    const clean = verdict({ ascendingFailed: 0, forceFailed: 0, windowSize: 12 });
    expect(clean.abort).toBe(false);
    expect(clean.underFloor).toBe(false);
    // ...and force failures don't drag the under-floor log in either.
    expect(verdict({ ascendingFailed: 0, forceFailed: 3, windowSize: 3 }).underFloor).toBe(false);
  });

  test('a night with nothing to judge is silent', () => {
    const v = verdict({});
    expect(v.abort).toBe(false);
    expect(v.underFloor).toBe(false);
    expect(v.ignoredForceFailures).toBe(0);
  });
});
