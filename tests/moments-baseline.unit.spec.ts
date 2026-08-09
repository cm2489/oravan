import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/*
 * GATE-COVERAGE: the new-vehicle terminality rule (owner ruling 2026-08-09,
 * shipped in #180) needs data/moments.json as main has it, or it cannot tell
 * a vehicle being ADDED from one that already persists on a settled moment.
 * When that baseline could not resolve, the gate printed a warning and
 * SKIPPED the rule — and ci.yml checks a PR out at depth 1, which has no
 * origin/main ref. So on the one runner that is the merge gate, the rule was
 * enforced entirely by the gate's own in-gate fallback fetch, nothing tested
 * that the fetch resolved, and a skipped rule and a passed rule printed the
 * same green check.
 *
 * Closed on both sides: ci.yml now fetches origin/main before the gate runs
 * (so resolution is free and offline rather than a network call), and passes
 * --require-baseline (so an unresolvable baseline is a hard failure). These
 * tests pin the wiring — the rollover-tripwire.unit.spec.ts posture, because
 * workflow YAML is not executable from here — and prove the flag has teeth.
 */

const CI = join(process.cwd(), '.github/workflows/ci.yml');
const readCi = () => readFileSync(CI, 'utf8');

function runGate(args: string[], env: Record<string, string> = {}) {
  return spawnSync('node', ['scripts/check-moments.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/*
 * How the "no baseline" case is reproduced without unplugging the network.
 * MOMENTS_BASE_REF (the gate's own documented override) points at a ref that
 * does not exist, which defeats resolution path 1; GIT_ALLOW_PROTOCOL=none
 * makes git refuse https, which defeats the fallback fetch on path 2. Both
 * are stock git/gate behavior — no test-only backdoor was added to the gate
 * to make it fail.
 */
const NO_BASELINE = { MOMENTS_BASE_REF: 'refs/oravan/no-such-baseline', GIT_ALLOW_PROTOCOL: 'none' };

test.describe('the gate reports which baseline it resolved', () => {
  test('a resolvable baseline is stated out loud, with the ref that answered', () => {
    const result = runGate([]);
    expect(result.status, result.stderr).toBe(0);
    expect(
      result.stdout,
      'the gate must SAY the baseline resolved — "the rule ran" and "the rule was skipped" ' +
        'printed the same green check until it did'
    ).toMatch(/new-vehicle terminality baseline resolved from \S+ \(\d+ vehicle pair\(s\)\)/);
  });

  test('without the baseline it says SKIPPED, not passed', () => {
    const result = runGate([], NO_BASELINE);
    expect(result.status, 'locally this stays a warning, so a laptop offline can still run the gate').toBe(0);
    expect(result.stderr).toMatch(/::warning::check-moments: no baseline/);
    expect(result.stderr).toMatch(/SKIPPED, not passed/);
    expect(result.stdout).not.toMatch(/baseline resolved/);
  });
});

test.describe('--require-baseline has teeth', () => {
  test('it fails when the baseline cannot resolve', () => {
    const result = runGate(['--require-baseline'], NO_BASELINE);
    expect(result.status, 'an unresolvable baseline must be a CI failure, not a warning').toBe(1);
    expect(result.stderr).toMatch(/::error::check-moments: no baseline/);
    expect(result.stderr).toMatch(/--require-baseline was passed/);
  });

  test('it is a no-op when the baseline resolves — the flag does not change the verdict, only the floor', () => {
    const withFlag = runGate(['--require-baseline']);
    const without = runGate([]);
    expect(withFlag.status, withFlag.stderr).toBe(0);
    expect(without.status, without.stderr).toBe(0);
    expect(withFlag.stdout).toContain('check-moments passed');
  });
});

test.describe('CI is wired so the baseline is there before the gate looks', () => {
  test('ci.yml fetches origin/main ahead of the Moments gate', () => {
    const yml = readCi();
    const fetchAt = yml.indexOf('git fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main');
    expect(fetchAt, 'the origin/main fetch step must exist').toBeGreaterThan(-1);
    const gateAt = yml.indexOf('node scripts/check-moments.mjs');
    expect(gateAt, 'the Moments gate step must exist').toBeGreaterThan(-1);
    expect(fetchAt, 'the fetch has to happen BEFORE the gate, or it resolves nothing').toBeLessThan(gateAt);
  });

  test('ci.yml runs the Moments gate with --require-baseline', () => {
    // Without the flag the gate falls back to a warning, and the whole point
    // of the fetch above is lost the first time it fails.
    expect(readCi()).toMatch(/run: node scripts\/check-moments\.mjs --require-baseline/);
  });

  test('the checkout the fetch corrects is still the shallow one this is written for', () => {
    // If ci.yml ever gains `fetch-depth: 0`, origin/main is present already
    // and the added step is redundant rather than wrong — but the comment
    // above it would be describing a checkout that no longer exists. This
    // fails loudly at that moment so the reasoning gets updated with it.
    const yml = readCi();
    expect(yml).toMatch(/uses: actions\/checkout@v\d+/);
    expect(yml, 'no fetch-depth override — the depth-1 default is what makes the fetch step necessary').not.toMatch(
      /fetch-depth:/
    );
  });
});
