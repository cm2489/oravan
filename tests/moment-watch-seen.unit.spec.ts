import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Relative import of the plain .mjs module — the same pattern
// tests/moment-scaffold.unit.spec.ts uses for the rest of this script's
// exports.
import {
  rejectionsSentence,
  resolveDraftCap,
  seenSetAfter,
  slugsWithSignal,
  structuresFor,
} from '../scripts/moment-watch.mjs';
import { DEFAULT_DRAFT_CAP } from '../scripts/moment-draft.mjs';

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
 * THE SECOND PROPERTY: capacity is not forgetting.
 *
 *   A slug leaves the seen-set only on genuine SIGNAL loss. "All six Moment
 *   slots are full" is a fact about us, not about the candidate.
 *
 * The live-cap floor (F4) zeroes `qualifying` outright when openSlots <= 0,
 * and the committed set used to be REPLACED by whatever qualified. Together
 * those said: the night the owner fills the sixth slot, the watcher forgets
 * every candidate it ever issued — and re-fires all of them the day a slot
 * frees. Two nights, tested as two nights, because the bug only exists in the
 * seam between them.
 * ---------------------------------------------------------------------- */

test('THE SLOTS-FULL NIGHT: nothing qualifies, and the set is not wiped', () => {
  // A and B were issued on earlier nights. Tonight the cap zeroes qualifying —
  // but both still clear every other floor, so both are still remembered.
  const next = seenSetAfter({
    qualifying: [],
    newly: [],
    filed: [],
    seen: [A, B],
    withSignal: [A, B],
  });
  expect(next).toEqual([A, B]);
});

test('THE SLOT-REOPENS NIGHT: a remembered candidate does NOT re-fire', () => {
  // The morning after: a slot frees, A and B qualify again. Because the
  // slots-full night kept them, neither is "newly" — which is what the caller
  // computes from the committed set, so this is the assertion that matters.
  const seen = seenSetAfter({ qualifying: [], newly: [], filed: [], seen: [A, B], withSignal: [A, B] });
  const qualifyingNow = [A, B];
  const newlyNow = qualifyingNow.filter((s) => !seen.includes(s));
  expect(newlyNow).toEqual([]);
  expect(seenSetAfter({ qualifying: qualifyingNow, newly: newlyNow, filed: [], seen, withSignal: qualifyingNow })).toEqual([A, B]);
});

test('a slug with no signal left still ages out on a slots-full night (F5 survives)', () => {
  // A kept its signal, B genuinely lost it (stale placement, thinned coverage,
  // or it became a Moment vehicle). Capacity retention must not resurrect B.
  expect(
    seenSetAfter({ qualifying: [], newly: [], filed: [], seen: [A, B], withSignal: [A] }),
  ).toEqual([A]);
});

test('a NEW candidate seen for the first time on a slots-full night is not marked delivered', () => {
  // C has signal but never qualified, so it was never owed an issue. Adding it
  // here would mean it never fires at all once a slot opens — the mirror of
  // the bug, and the reason retention reads the seen-set rather than the
  // signal list.
  expect(
    seenSetAfter({ qualifying: [], newly: [], filed: [], seen: [A], withSignal: [A, C] }),
  ).toEqual([A]);
});

test('a held-back failure is still held back when it is also retained on signal', () => {
  // B qualified, its issue failed, and it has signal. The delivery receipt
  // wins: retention may not launder a candidate whose issue does not exist.
  expect(
    seenSetAfter({ qualifying: [A, B], newly: [B], filed: [], seen: [A], withSignal: [A, B] }),
  ).toEqual([A]);
});

test('withSignal omitted keeps the pre-2026-08-09 arithmetic exactly', () => {
  expect(seenSetAfter({ qualifying: [A], newly: [], filed: [], seen: [A, B] })).toEqual([A]);
});

test('slugsWithSignal asks "would this pass if we had room?" and ignores the cap only', () => {
  const now = Date.parse('2026-08-09T12:00:00Z');
  const base = { tier: 'cross', outlets: 4, lastActionDate: '2026-08-01', floorCalendar: true, status: 'floor_vote' };
  const report = {
    moments: { openSlots: 0 },
    candidates: [
      { ...base, slug: A },
      // Fails the CURRENCY floor, which is real signal loss — never retained.
      { ...base, slug: B, lastActionDate: '2025-01-01' },
    ],
  };
  expect(slugsWithSignal(report, now)).toEqual([A]);
});

/* ---------------------------------------------------------------------- *
 * Moment ids: two candidates in one run may not claim one address.
 * ---------------------------------------------------------------------- */

const CAND = (slug: string) => ({
  slug,
  citation: slug.toUpperCase(),
  status: 'floor_vote',
  lastActionDate: '2026-08-01',
  floorCalendar: true,
  floorChamber: 'senate',
  tier: 'neutral',
  outlets: 3,
  url: `https://www.congress.gov/bill/119th-congress/house-bill/1`,
});

/** Both candidates drafted to the SAME bare name — the House/Senate-companion
 *  shape, which is the ordinary way a measure reaches the floor. */
function twinRun() {
  const rendering = [CAND('hr-1-119'), CAND('s-2-119')];
  const drafts = new Map(
    rendering.map((c) => [c.slug, { drafted: true, name: { en: 'Crypto market structure', es: 'x' } }]),
  );
  return structuresFor(rendering, {
    bySlug: new Map(),
    coverage: {},
    drafts,
    now: Date.parse('2026-08-09T00:00:00Z'),
    takenIds: new Set(['some-existing-moment']),
  });
}

test('two same-night candidates never produce the same moment id', () => {
  const s = twinRun();
  const ids = [...s.values()].map((v) => v.id);
    expect(new Set(ids).size).toBe(2);
  // Duplicate keys are legal JSON: the second silently replaces the first, so
  // "they collide" and "one Big Question is deleted" are the same sentence.
  expect(Object.keys(Object.fromEntries(ids.map((id) => [id, 1])))).toHaveLength(2);
});

test('BOTH issues carry the collision note, not only the second one', () => {
  const s = twinRun();
  for (const slug of ['hr-1-119', 's-2-119']) {
    const notes = s.get(slug)!.notes.join('\n');
    expect(notes, slug).toContain('same run drafted to the same id');
    expect(notes, slug).toContain('crypto-market-structure');
  }
  // Each note names the OTHER candidate — the issues are read separately.
  expect(s.get('hr-1-119')!.notes.join('\n')).toContain('s-2-119');
  expect(s.get('s-2-119')!.notes.join('\n')).toContain('hr-1-119');
});

test('distinct names in one run collide with nothing and say nothing', () => {
  const rendering = [CAND('hr-1-119'), CAND('s-2-119')];
  const drafts = new Map([
    ['hr-1-119', { drafted: true, name: { en: 'Crypto market structure', es: 'x' } }],
    ['s-2-119', { drafted: true, name: { en: 'Rural obstetrics funding', es: 'x' } }],
  ]);
  const s = structuresFor(rendering, { bySlug: new Map(), coverage: {}, drafts, now: Date.now(), takenIds: new Set() });
  expect([...s.values()].map((v) => v.id)).toEqual(['crypto-market-structure', 'rural-obstetrics-funding']);
  for (const v of s.values()) expect(v.notes.join('\n')).not.toContain('same run');
});

/* ---------------------------------------------------------------------- *
 * The spend ceiling, and the sentence about the rejection log.
 * ---------------------------------------------------------------------- */

test('MOMENT_DRAFT_CAP: a non-numeric value can no longer REMOVE the ceiling', () => {
  // `Number('ten')` is NaN and `i >= NaN` is false forever, so the old
  // expression turned a typo into an unbounded night of drafting calls.
  const { cap, warning } = resolveDraftCap('ten');
  expect(cap).toBe(DEFAULT_DRAFT_CAP);
  expect(warning).toContain('MOMENT_DRAFT_CAP');
});

test('MOMENT_DRAFT_CAP: an empty value means "unset", never a silent 0', () => {
  // `Number('')` is 0, so `MOMENT_DRAFT_CAP=` in an env block used to disable
  // drafting entirely with nobody told why.
  expect(resolveDraftCap('')).toEqual({ cap: DEFAULT_DRAFT_CAP, warning: null });
  expect(resolveDraftCap('   ')).toEqual({ cap: DEFAULT_DRAFT_CAP, warning: null });
  expect(resolveDraftCap(undefined)).toEqual({ cap: DEFAULT_DRAFT_CAP, warning: null });
});

test('MOMENT_DRAFT_CAP: a real ceiling is honoured, including a deliberate 0', () => {
  expect(resolveDraftCap('3').cap).toBe(3);
  expect(resolveDraftCap('0')).toEqual({ cap: 0, warning: null });
  expect(resolveDraftCap('-1').cap).toBe(DEFAULT_DRAFT_CAP);
  expect(resolveDraftCap('2.5').cap).toBe(DEFAULT_DRAFT_CAP);
  expect(resolveDraftCap('Infinity').cap).toBe(DEFAULT_DRAFT_CAP);
});

test('the rejection-log sentence is DERIVED, never the hardcoded "currently empty"', () => {
  // It said "and it is currently empty" on every issue ever opened, which
  // stopped being true at PR #158 and stayed wrong because nothing re-read it.
  expect(rejectionsSentence([])).toContain('currently empty');
  expect(rejectionsSentence([{}])).toContain('1 entry');
  expect(rejectionsSentence([{}, {}])).toContain('2 entries');
  expect(rejectionsSentence(null)).toContain('not currently readable');
});

test('the real docs/moment-rejections.json is not described as empty', () => {
  const rejections = JSON.parse(readFileSync(join(process.cwd(), 'docs/moment-rejections.json'), 'utf8'));
  expect(Array.isArray(rejections)).toBe(true);
  expect(rejections.length).toBeGreaterThan(0);
  expect(rejectionsSentence(rejections)).not.toContain('currently empty');
});

/* ---------------------------------------------------------------------- *
 * The wiring, pinned as text.
 * ---------------------------------------------------------------------- */

const WATCH_WORKFLOW = join(process.cwd(), '.github/workflows/moment-watch.yml');
const yml = () => readFileSync(WATCH_WORKFLOW, 'utf8');

/** Comment lines removed. Not a convenience: these workflows explain their
 *  own decisions in comments that necessarily quote the shape being rejected
 *  ("`git pull --rebase`", "`if: always()`"), and an assertion that fires on
 *  its own rationale is a rule nobody can document. */
const withoutComments = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

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
  // Comment lines are stripped first — see withoutComments for why that is a
  // rule rather than a convenience.
  expect(withoutComments(yml())).not.toMatch(/if:\s*always\(\)/);
});

test('a fetch failure is retried, not reported as a conflict a human must resolve', () => {
  // This was the ONE rebase-retry block of the five data workflows that ran
  // fetch and rebase as a single `git pull --rebase`: any non-zero exit — a
  // transient GitHub 500, a dropped connection — printed "rebase conflict in:
  // <unknown> - a human must resolve it" and killed the remaining attempts.
  // `<unknown>` was the tell: there were no unmerged paths because there was
  // no rebase.
  const body = withoutComments(stepBody('Commit the seen-set'));
  expect(body).not.toMatch(/git pull --rebase/);
  expect(body).toMatch(/if ! git fetch origin "\$\{GITHUB_REF_NAME\}"; then/);
  expect(body).toMatch(/fetch failed \(attempt \$i\) - retrying/);
  expect(body).toMatch(/if git rebase "origin\/\$\{GITHUB_REF_NAME\}"; then/);
  // …and a genuine stopped rebase still fails on the spot, naming the file.
  expect(body).toMatch(/git rebase --abort \|\| true/);
  expect(body).toMatch(/::error::rebase conflict in/);
});

test('every data workflow separates fetch failure from rebase conflict the same way', () => {
  // The shape, not the wording: a fetch guard that CONTINUES, and a rebase
  // guard that exits. Pinned across the set so the next one written cannot
  // quietly reintroduce the single-`pull` shape.
  for (const wf of ['sync-bills', 'hot-bills', 'newsdesk', 'refresh-legislators', 'moment-watch']) {
    const code = withoutComments(readFileSync(join(process.cwd(), `.github/workflows/${wf}.yml`), 'utf8'));
    expect(code, wf).toMatch(/if ! git fetch origin/);
    expect(code, wf).toMatch(/fetch failed \(attempt \$i\) - retrying/);
    expect(code, wf).not.toMatch(/git pull --rebase/);
  }
});

test('the fix for the pre-existing untracked-file guard is not regressed', () => {
  // PR #176: `git diff` exits 0 for an untracked file, which is exactly the
  // state of the first run that ever writes the seen-set.
  const body = stepBody('Commit the seen-set');
  expect(body).toMatch(/git status --porcelain -- data\/candidates-seen\.json/);
});
