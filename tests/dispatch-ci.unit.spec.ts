import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { appeared } from '../scripts/dispatch-ci.mjs';

/*
 * THE CI DISPATCH, after the 2026-09-21 flake.
 *
 * `gh workflow run ci.yml` returned HTTP 500 on the nightly while the dispatch
 * had actually landed — CI run 35648109859 was created inside that step's own
 * ten-second window. Because the step was a bare one-liner with no
 * continue-on-error, the night went red with its data already safely on main,
 * and the pregen step below it was skipped along with it.
 *
 * The rule these tests defend: A DISPATCH THAT WORKED AND A DISPATCH THAT DID
 * NOT MUST NOT LOOK THE SAME — and neither may collapse into "unknown".
 */

const wf = (name: string) => readFileSync(join(process.cwd(), '.github/workflows', name), 'utf8');

/**
 * The dispatch step, sliced to the NEXT top-level step (or EOF) — the same
 * idiom nightly-pipeline.unit.spec.ts uses, and for a second reason here: a
 * fixed-width window silently stops covering the step as soon as someone adds
 * a comment to it. The first cut of this file used `slice(at, at + 1400)` and
 * went red the moment sync-bills.yml's step grew the note explaining this very
 * script, because `run:` fell off the end of the window.
 */
const dispatchStep = (yml: string) => {
  const at = yml.indexOf('- name: Dispatch CI against the pushed data');
  expect(at, 'dispatch step not found').toBeGreaterThan(0);
  const rest = yml.slice(at);
  const nextStepAt = rest.slice(1).search(/\n {6}- name:/);
  return nextStepAt === -1 ? rest : rest.slice(0, nextStepAt + 1);
};

test.describe('appeared — did a new run actually show up', () => {
  test('two different readable ids is the one true case', () => {
    expect(appeared('100', '101')).toBe(true);
  });

  test('the same id means nothing was created', () => {
    expect(appeared('100', '100')).toBe(false);
  });

  test('an unreadable baseline is "not proven", never success', () => {
    // The dangerous direction. If a failed `gh run list` read as "no runs
    // before", any pre-existing run would look newly created and the script
    // would report a dispatch it never made — the exact failure the step
    // exists to catch.
    expect(appeared(null, '101')).toBe(false);
  });

  test('an unreadable follow-up read is "not proven" too', () => {
    expect(appeared('100', null)).toBe(false);
  });

  test('both unreadable is not success', () => {
    expect(appeared(null, null)).toBe(false);
  });
});

test.describe('every data workflow dispatches CI through the script', () => {
  // moment-approve.yml is deliberately absent: it dispatches ci.yml against a
  // PR branch with its own flags, not main's post-commit suite.
  for (const name of ['sync-bills.yml', 'hot-bills.yml', 'newsdesk.yml', 'refresh-legislators.yml']) {
    test(`${name} uses scripts/dispatch-ci.mjs, not a bare gh workflow run`, () => {
      const step = dispatchStep(wf(name));
      expect(step).toContain('run: node scripts/dispatch-ci.mjs');
      expect(step).not.toMatch(/run: gh workflow run ci\.yml/);
      // It still needs the token to talk to the API at all.
      expect(step).toContain('GH_TOKEN: ${{ github.token }}');
    });
  }
});

test.describe('the dispatch step still fails the run when CI was not dispatched', () => {
  test('no continue-on-error was added to buy the green back', () => {
    // The tempting wrong fix. A dispatch that genuinely did not happen means
    // main's suite never ran against the pushed corpus, which is precisely
    // the 2026-07-25 incident this step was added for. The script narrows
    // WHAT counts as a failure; it must not stop failing.
    expect(dispatchStep(wf('sync-bills.yml'))).not.toContain('continue-on-error');
  });
});
