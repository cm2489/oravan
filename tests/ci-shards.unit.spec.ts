import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import config from '../playwright.config';

/*
 * THE SPLIT PULL-REQUEST CHECK (2026-09-29).
 *
 * ci.yml used to be one job that built the app inside Playwright's webServer
 * and then ran every spec, the pure-Node unit specs twice (once per browser
 * project). It is now several jobs: `gates`, `unit` (the unit specs once, no
 * server), `build` (the app once), six `e2e` shards that all serve that one
 * build, and a job named `test` that passes only when all of them did.
 *
 * What these tests defend: a split check must never be able to show green
 * while a part of it was skipped, lost or run against the wrong build. Each
 * of those failure modes is a line of YAML, and YAML is not executable from
 * here, so the lines are pinned by reading the source (the same posture as
 * tests/client-bundle.unit.spec.ts's CI wiring tests).
 */

const ROOT = process.cwd();
const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

/** One job's text: from `  <id>:` to the next two-space job key, or EOF. */
function job(id: string): string {
  const at = ci.indexOf(`\n  ${id}:\n`);
  expect(at, `job "${id}" not found in ci.yml`).toBeGreaterThan(-1);
  const rest = ci.slice(at + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The job ids under `jobs:`. */
function jobIds(): string[] {
  const jobs = ci.slice(ci.indexOf('\njobs:\n'));
  return [...jobs.matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)].map((m) => m[1]);
}

test.describe('the aggregate `test` job', () => {
  test('it keeps the workflow name and the job id that docs and a required check would name', () => {
    expect(ci.startsWith('name: CI\n')).toBe(true);
    expect(jobIds()).toContain('test');
  });

  test('it waits on every job that does work, except the information-only report', () => {
    const t = job('test');
    const needs = t.match(/needs: \[([^\]]*)\]/);
    expect(needs, 'test must list its needs').not.toBeNull();
    const listed = needs![1].split(',').map((s) => s.trim());
    const others = jobIds().filter((id) => id !== 'test' && id !== 'e2e-report');
    expect(listed.sort()).toEqual(others.sort());
  });

  test('it always runs, because a skipped check counts as passing', () => {
    expect(job('test')).toMatch(/\n {4}if: always\(\)\n/);
  });

  test('it demands success from the gates, and success or (docs-only) skipped from the rest', () => {
    const t = job('test');
    expect(t).toContain('NEEDS: ${{ toJSON(needs) }}');
    expect(t).toContain('expect changes success');
    expect(t).toContain('expect gates success');
    for (const id of ['unit', 'build', 'e2e']) {
      expect(t).toContain(`expect ${id} success`);
      expect(t).toContain(`expect ${id} skipped`);
    }
    expect(t).toContain('exit $FAIL');
  });
});

test.describe('the parts', () => {
  test('the gates job waits for nothing, so the corpus gates run on every pull request and every push', () => {
    const g = job('gates');
    expect(g).not.toMatch(/\n {4}needs:/);
    expect(g).not.toMatch(/\n {4}if:/);
    expect(g).toContain('node scripts/check-moments.mjs --require-baseline');
    expect(g).toContain('run: npm run typecheck');
    expect(g).toContain('run: npm run lint');
  });

  test('the unit job runs the unit project once, with no server', () => {
    const u = job('unit');
    expect(u).toContain("if: needs.changes.outputs.docs_only != 'true'");
    expect(u).toMatch(/PW_NO_WEBSERVER: '1'\n\s+run: npx playwright test --project=unit\n/);
    expect(u, 'unit specs need no browser, so the unit job installs none').not.toContain('playwright install');
  });

  test('the build job builds once, and every shard starts that build and never builds', () => {
    const b = job('build');
    expect(b).toContain("if: needs.changes.outputs.docs_only != 'true'");
    expect(b).toMatch(/E2E_SERVER_MODE: build\n\s+run: npx tsx tests\/e2e-server\.mjs\n/);
    const e = job('e2e');
    expect(e).toContain('needs: build');
    expect(e).toMatch(/E2E_SERVER_MODE: start\n\s+run: npx playwright test /);
    expect(e).not.toContain('E2E_SERVER_MODE: build');
  });

  test('the matrix has exactly as many shards as the shard flag divides the suite into', () => {
    const e = job('e2e');
    const matrix = e.match(/shard: \[([^\]]*)\]/);
    const flag = e.match(/--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/);
    expect(matrix).not.toBeNull();
    expect(flag).not.toBeNull();
    const shards = matrix![1].split(',').map((s) => Number(s.trim()));
    const n = Number(flag![1]);
    expect(shards).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(e, 'the job title states the same N').toContain(`name: e2e \${{ matrix.shard }}/${n}`);
    expect(e, 'one red shard must not cancel the others').toContain('fail-fast: false');
  });

  test('the shards run every browser project, and nothing else', () => {
    const e = job('e2e');
    const run = e.match(/run: (npx playwright test [^\n]*)/)![1];
    const projects = [...run.matchAll(/--project=([a-z0-9-]+)/g)].map((m) => m[1]).sort();
    const browser = (config.projects ?? []).map((p) => p.name!).filter((n) => n !== 'unit').sort();
    expect(projects).toEqual(browser);
  });
});

test.describe('playwright.config.ts splits unit specs from browser specs', () => {
  const UNIT = 'tests/example.unit.spec.ts';
  const BROWSER = 'tests/example.spec.ts';
  const matches = (re: unknown, file: string) => re instanceof RegExp && re.test(file);

  test('every browser project ignores unit specs', () => {
    const browser = (config.projects ?? []).filter((p) => p.name !== 'unit');
    expect(browser.map((p) => p.name).sort()).toEqual(['webkit-320', 'webkit-desktop', 'webkit-mobile']);
    for (const p of browser) {
      expect(matches(p.testIgnore, UNIT), `${p.name} must ignore *.unit.spec.ts`).toBe(true);
      expect(matches(p.testIgnore, BROWSER), `${p.name} must still run *.spec.ts`).toBe(false);
    }
  });

  test('the unit project runs unit specs and only unit specs', () => {
    const unit = (config.projects ?? []).find((p) => p.name === 'unit');
    expect(unit).toBeDefined();
    expect(matches(unit!.testMatch, UNIT)).toBe(true);
    expect(matches(unit!.testMatch, BROWSER)).toBe(false);
    expect(unit!.use, 'the unit project needs no device').toBeUndefined();
  });
});
