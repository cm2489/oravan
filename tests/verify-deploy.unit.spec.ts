import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { buildDescendsFrom } from '../lib/deploy-descends.mjs';

/*
 * GATE-COVERAGE for the deploy dead-man's switch (N11a, 2026-08-12).
 *
 * scripts/verify-deploy.mjs is the only thing standing between "the nightly
 * pushed data" and "production actually serves it" — PR #18 proved a deploy
 * can be dropped with every dashboard green. Until today an unset PROD_URL
 * made it print a ::notice and exit 0, which meant deleting one repository
 * variable would disarm the switch in all four nightly workflows at once and
 * every run would keep printing a green check. That is the failure the script
 * exists to catch, one level up.
 *
 * These tests pin the hard failure. Both cases exit before the poll loop, so
 * nothing here makes a network call and nothing waits on the 12-minute
 * deadline — the script is never invoked with a usable PROD_URL from a test.
 * The workflow-wiring assertions take the rollover-tripwire.unit.spec.ts
 * posture (read the YAML; workflow files are not executable from here).
 */

const REPO = process.cwd();

/** Run the script with a controlled environment. Keys set to `null` are
 *  DELETED rather than blanked, so the test exercises "the variable is not
 *  there", not "the variable is an empty string". */
function runVerifyDeploy(overrides: Record<string, string | null>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  return spawnSync('node', ['scripts/verify-deploy.mjs'], { cwd: REPO, encoding: 'utf8', env });
}

test('an unset PROD_URL fails the run — it must never skip green', () => {
  const result = runVerifyDeploy({ PROD_URL: null, EXPECT_SHA: 'a'.repeat(40) });
  expect(
    result.status,
    'a missing PROD_URL disarms the deploy check in all four nightly workflows; exiting 0 hides that'
  ).toBe(1);
  expect(result.stderr).toMatch(/::error::PROD_URL is missing/);
  // The disarm branch is gone, not merely reworded.
  expect(result.stdout).not.toMatch(/::notice/);
  expect(`${result.stdout}${result.stderr}`).not.toMatch(/skipping post-deploy verification/);
});

test('an empty PROD_URL fails the same way (a blanked variable is a missing one)', () => {
  const result = runVerifyDeploy({ PROD_URL: '', EXPECT_SHA: 'a'.repeat(40) });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/::error::PROD_URL is missing/);
});

test('an unset EXPECT_SHA still fails — the pre-existing treatment is unchanged', () => {
  const result = runVerifyDeploy({ PROD_URL: 'https://example.invalid', EXPECT_SHA: null });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/::error::EXPECT_SHA is missing/);
});

test('the script itself carries no exit-0 path for a missing variable', () => {
  const source = readFileSync(join(REPO, 'scripts/verify-deploy.mjs'), 'utf8');
  expect(source).not.toContain('::notice::PROD_URL');
  // Exactly one process.exit(0): the success path, after production reports
  // the expected SHA. Any second one is a new way to pass without looking.
  expect(source.match(/process\.exit\(0\)/g) ?? []).toHaveLength(1);
});

/*
 * Every workflow that calls the script must still PASS the variable through.
 * A hard failure inside the script is worthless if a step quietly stops
 * setting `PROD_URL:` in its env — the run would then fail for the wrong
 * reason on the wrong night, so pin the wiring beside the behavior.
 */
const CALLERS = ['sync-bills', 'hot-bills', 'newsdesk', 'refresh-legislators'] as const;

for (const workflow of CALLERS) {
  test(`${workflow}.yml runs the deploy check with PROD_URL and EXPECT_SHA in scope`, () => {
    const yaml = readFileSync(join(REPO, `.github/workflows/${workflow}.yml`), 'utf8');
    expect(yaml, 'this workflow is one of the four dead-man\'s switches').toContain(
      'node scripts/verify-deploy.mjs'
    );
    // The step block that runs it: from its `env:` through the run line.
    const step = yaml.slice(0, yaml.indexOf('run: node scripts/verify-deploy.mjs'));
    const tail = step.slice(-400);
    expect(tail).toContain('PROD_URL: ${{ vars.PROD_URL }}');
    expect(tail).toContain('EXPECT_SHA:');
    // The comment above the step used to promise a skip. It no longer can.
    expect(tail).not.toMatch(/Skips with a\s+#?\s*notice/);
  });
}

/*
 * ...and the other half of "fails for the right reason": newsdesk.yml carries
 * `workflow_dispatch`, so it gets run by hand off a branch to validate a change
 * to scripts/newsdesk.mjs. Production is built from refs/heads/main and nothing
 * else, so on such a run the poll asks production for a SHA that can never
 * appear there, burns the 12-minute deadline, and reports red. That is a
 * STRUCTURAL failure, not a caught one, and a dead-man's switch that cries wolf
 * on every branch validation is a dead-man's switch nobody reads.
 *
 * The guard has to AND onto the existing changed-files condition rather than
 * replace it — dropping `changed == 'true'` would send a no-op hourly run
 * hunting for an empty EXPECT_SHA — so pin the whole expression, not just the
 * ref half. Same for the CI dispatch below it: a branch run pushed its data to
 * that branch, so dispatching main's suite would test a corpus it never wrote.
 */
test('newsdesk.yml only verifies the deploy and dispatches CI on main', () => {
  const yaml = readFileSync(join(REPO, '.github/workflows/newsdesk.yml'), 'utf8');
  const GUARD = "if: steps.commit.outputs.changed == 'true' && github.ref == 'refs/heads/main'";

  const verifyAt = yaml.indexOf('- name: Verify the deploy landed');
  const dispatchAt = yaml.indexOf('- name: Dispatch CI against the pushed data');
  expect(verifyAt, 'deploy-verify step not found').toBeGreaterThan(0);
  expect(dispatchAt, 'CI-dispatch step not found').toBeGreaterThan(verifyAt);

  expect(yaml.slice(verifyAt, dispatchAt)).toContain(GUARD);
  expect(yaml.slice(dispatchAt)).toContain(GUARD);
});

/*
 * A newer build counts (2026-10-04). The nightly of 2026-10-03 pushed its data
 * commit, main moved on within minutes, the host built only the newest head,
 * and the exact-SHA poll timed out red although production carried the data.
 * These run against real throwaway git repositories — an "origin" whose main
 * moves on, and a shallow runner-like clone that has only the pushed commit —
 * so no network and no production poll is involved.
 */
test.describe('buildDescendsFrom: a production build that contains the pushed commit', () => {
  let dir: string;
  let origin: string;
  let runner: string;
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (cwd: string, msg: string) => {
    git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', msg);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  let older: string;
  let pushed: string;
  let newer: string;
  let sideBranch: string;

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-deploy-'));
    origin = join(dir, 'origin');
    runner = join(dir, 'runner');
    git(dir, 'init', '-q', '-b', 'main', origin);
    older = commit(origin, 'older');
    pushed = commit(origin, 'the data commit this run pushed');
    // The runner's checkout: shallow, at the pushed commit only.
    git(dir, 'clone', '-q', '--depth=1', `file://${origin}`, runner);
    // Main moves on after the push; the runner has never seen these.
    commit(origin, 'merge one');
    newer = commit(origin, 'merge two (the build production serves)');
    git(origin, 'checkout', '-q', '-b', 'side', older);
    sideBranch = commit(origin, 'a build that never contained the push');
    git(origin, 'checkout', '-q', 'main');
  });
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('a newer main head that contains the pushed commit verifies', () => {
    expect(buildDescendsFrom(pushed, newer, { cwd: runner })).toBe(true);
  });

  test('the exact pushed commit verifies without asking git', () => {
    expect(buildDescendsFrom(pushed, pushed, { cwd: '/nonexistent' })).toBe(true);
  });

  test('an older build does not verify — the deploy has not landed', () => {
    expect(buildDescendsFrom(pushed, older, { cwd: runner })).toBe(false);
  });

  test('a build off another line of history does not verify', () => {
    expect(buildDescendsFrom(pushed, sideBranch, { cwd: runner })).toBe(false);
  });

  test('anything that is not a full SHA, or any git failure, answers false', () => {
    expect(buildDescendsFrom(pushed, null, { cwd: runner })).toBe(false);
    expect(buildDescendsFrom(pushed, 'unknown', { cwd: runner })).toBe(false);
    expect(buildDescendsFrom(pushed, '--upload-pack=x', { cwd: runner })).toBe(false);
    expect(buildDescendsFrom(pushed, 'f'.repeat(40), { cwd: runner })).toBe(false);
    expect(buildDescendsFrom(pushed, newer, { cwd: '/nonexistent' })).toBe(false);
  });

  test('verify-deploy.mjs accepts a descendant through this helper and nothing looser', () => {
    const source = readFileSync(join(REPO, 'scripts/verify-deploy.mjs'), 'utf8');
    expect(source).toContain("import { buildDescendsFrom } from '../lib/deploy-descends.mjs'");
    expect(source).toMatch(/buildDescendsFrom\(EXPECT_SHA, seen\)/);
  });
});
