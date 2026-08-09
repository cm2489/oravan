import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Relative import of the plain .mjs module — the same pattern
// tests/moment-scaffold.unit.spec.ts uses for the rest of this script's
// exports.
import { seenSetAfter } from '../scripts/moment-watch.mjs';

/*
 * THE PROPERTY THIS FILE EXISTS FOR:
 *
 *   A candidate slug enters the committed seen-set if and only if its issue
 *   actually exists. Filed => never re-filed. Not filed => stays unseen and
 *   retries.
 *
 * It is here because this workflow has already shipped one duplicate-issue
 * incident, and because the two ways of getting it wrong point in opposite
 * directions:
 *
 *   - Nothing gets committed, so everything re-files. That is what produced
 *     #173–#175 out of #167–#169 — through the untracked-file guard, fixed in
 *     #176. The loop's own `bash -e` / bare `gh issue create` shape reaches
 *     the identical outcome by a route #176 did not touch: one failed call
 *     kills the step, the commit step never runs. Never observed, which is
 *     precisely why it survived a fix aimed at the same symptom.
 *   - Everything gets committed, so a failure is swallowed. The obvious fix —
 *     let the loop keep going and commit afterwards — writes "everything above
 *     the floor" as delivered, which marks the FAILED candidate as notified
 *     and drops it silently. Same bug, opposite sign.
 *
 * So the arithmetic gets a pure function (seenSetAfter) and the wiring that
 * feeds it gets a static pin, because the wiring is YAML and a static
 * assertion is the honest form of that guarantee here — the same posture
 * tests/rollover-tripwire.unit.spec.ts takes over refresh-legislators.yml.
 *
 * ZERO network, zero repo writes: seenSetAfter is pure, and the workflow is
 * read as text.
 */

/* Chosen so LEXICAL order is A, B, C — seenSetAfter returns a sorted array
 * (the skip-rewrite guard compares serialized sorted arrays), so a fixture
 * whose alphabetical order differs from its reading order would make every
 * expectation below a puzzle. */
const A = 'hr-1-119';
const B = 'hr-2-119';
const C = 's-3-119';

test('the flag absent means "not tracking delivery": every qualifying slug is written, unchanged from before --filed existed', () => {
  expect(seenSetAfter({ qualifying: [B, A], newly: [B] })).toEqual([A, B]);
  expect(seenSetAfter({ qualifying: [B, A], newly: [B], filed: null })).toEqual([A, B]);
});

test('a filed candidate is committed as seen, so it can never re-file', () => {
  expect(seenSetAfter({ qualifying: [A, B], newly: [B], filed: [B] })).toEqual([A, B]);
});

test('a candidate whose issue failed stays UNSEEN, so the next run retries it', () => {
  expect(seenSetAfter({ qualifying: [A, B], newly: [B], filed: [] })).toEqual([A]);
});

test('THE PARTIAL-LOOP SHAPE: commit the successes, hold back only the failure', () => {
  // Three newly-qualifying candidates, the middle one's `gh issue create`
  // fails. The pre-fix workflow committed nothing and would have re-filed all
  // three; a naive fix would have committed all three and dropped the middle.
  const next = seenSetAfter({ qualifying: [A, B, C], newly: [A, B, C], filed: [A, C] });
  expect(next).toEqual([A, C]);
  expect(next).not.toContain(B);
});

test('an already-seen slug is not collateral damage of a failure elsewhere in the loop', () => {
  // A was filed on an earlier night and is not in `newly`; B fails today.
  // A must stay in the set — it is not something this run owed an issue for.
  expect(seenSetAfter({ qualifying: [A, B], newly: [B], filed: [] })).toEqual([A]);
});

test('a slug that dropped below the floor still leaves the set (F5: re-qualifying is itself news)', () => {
  // C is not in `qualifying` any more, so it is simply absent — the held-back
  // logic must not resurrect it.
  expect(seenSetAfter({ qualifying: [A], newly: [], filed: [] })).toEqual([A]);
});

test('a `filed` entry that is not newly qualifying is harmless, never additive', () => {
  // The workflow counts an already-existing issue as filed; that slug may or
  // may not be in `newly`. Either way the output is a subset of `qualifying`.
  expect(seenSetAfter({ qualifying: [A], newly: [], filed: [A, B, C] })).toEqual([A]);
});

test('output is sorted, so the skip-rewrite-if-unchanged guard compares like with like', () => {
  // scripts/moment-watch.mjs only writes the file when the set moves; that
  // comparison is JSON.stringify over sorted arrays, so an unsorted return
  // here would rewrite _meta.updated nightly and hand the workflow a
  // timestamp-only diff to commit — and therefore deploy.
  expect(seenSetAfter({ qualifying: [C, A, B], newly: [], filed: [] })).toEqual([A, B, C]);
});

/* ---------------------------------------------------------------------- *
 * The wiring, pinned as text.
 * ---------------------------------------------------------------------- */

const WATCH_WORKFLOW = join(process.cwd(), '.github/workflows/moment-watch.yml');
const yml = () => readFileSync(WATCH_WORKFLOW, 'utf8');

/** The `run:` body of one named step, up to the next step's `- name:`. */
function stepBody(name: string): string {
  const text = yml();
  const start = text.indexOf(`- name: ${name}`);
  expect(start, `workflow step "${name}" not found`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n      - name: ');
  return rest.slice(0, end === -1 ? undefined : end);
}

test('the issue loop records each candidate pass/fail instead of dying on the first failure', () => {
  const body = stepBody('Open an issue per new candidate');
  // A bare `gh issue create` as its own statement is the pre-fix shape: under
  // `bash -e` it kills the step. It must sit inside a conditional that
  // records the outcome.
  expect(body).toMatch(/if node scripts\/moment-watch\.mjs --mode=push --only="\$slug"/);
  expect(body).toMatch(/&& gh issue create/);
  expect(body).toMatch(/failed="\$\{failed:\+\$failed,\}\$slug"/);
  expect(body).toMatch(/filed="\$\{filed:\+\$filed,\}\$slug"/);
});

test('the loop publishes both lists as step outputs', () => {
  const body = stepBody('Open an issue per new candidate');
  expect(body).toMatch(/^\s*id: file$/m);
  expect(body).toMatch(/echo "filed=\$filed" >> "\$GITHUB_OUTPUT"/);
  expect(body).toMatch(/echo "failed=\$failed" >> "\$GITHUB_OUTPUT"/);
});

test('an issue that already exists counts as filed rather than being opened twice', () => {
  const body = stepBody('Open an issue per new candidate');
  expect(body).toMatch(/gh issue list --label moment-candidate --state all/);
  expect(body).toMatch(/grep -Fxq "Big Question candidate: \$slug"/);
});

test('the seen-set commit is handed the delivery receipt, through the environment', () => {
  const body = stepBody('Commit the seen-set');
  expect(body).toMatch(/FILED: \$\{\{ steps\.file\.outputs\.filed \}\}/);
  expect(body).toMatch(/--commit-seen --no-draft --filed="\$FILED"/);
});

test('a failed candidate still reddens the run — AFTER the successes are committed', () => {
  const text = yml();
  const commit = text.indexOf('- name: Commit the seen-set');
  const fail = text.indexOf('- name: Fail the run if any candidate could not be filed');
  expect(fail).toBeGreaterThan(commit);
  expect(stepBody('Fail the run if any candidate could not be filed')).toMatch(/exit 1/);
  expect(text).toMatch(/if: steps\.mode\.outputs\.mode == 'push' && steps\.file\.outputs\.failed != ''/);
});

test("no step in this job uses always(): a genuine earlier failure must skip the commit, not force it", () => {
  // The tempting fix for the original incident was `if: always()` on the
  // commit step. That inverts the safe direction — a failed "Build report"
  // would then commit a seen-set derived from nothing.
  //
  // Comment lines are stripped first, and that is not a convenience: the
  // workflow explains this exact decision in a comment that necessarily
  // contains the phrase, and an assertion that fires on its own rationale is
  // a rule nobody can document.
  const code = yml()
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  expect(code).not.toMatch(/if:\s*always\(\)/);
});

test('the fix for the pre-existing untracked-file guard is not regressed', () => {
  // PR #176: `git diff` exits 0 for an untracked file, which is exactly the
  // state of the first run that ever writes the seen-set.
  const body = stepBody('Commit the seen-set');
  expect(body).toMatch(/git status --porcelain -- data\/candidates-seen\.json/);
});
