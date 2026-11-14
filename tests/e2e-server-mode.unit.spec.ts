import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/*
 * tests/e2e-server.mjs's E2E_SERVER_MODE switch.
 *
 * ci.yml builds the app once and every E2E shard serves that same build with
 * E2E_SERVER_MODE=start. The promise that makes that safe: a shard with no
 * build refuses at once instead of quietly building its own, because a shard
 * that built for itself would be testing a build nobody else checked, and a
 * missing artifact would look like a slow but green run.
 *
 * Each refusal runs in an empty temporary directory, so there is no .next to
 * find, and must end in well under the time a build would take.
 */

const ROOT = process.cwd();
const SERVER = join(ROOT, 'tests/e2e-server.mjs');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

function runIn(cwd: string, mode: string) {
  const started = Date.now();
  const r = spawnSync(TSX, [SERVER], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, E2E_SERVER_MODE: mode, ANTHROPIC_API_KEY: '', PW_PORT: '3999' },
  });
  return { ...r, ms: Date.now() - started };
}

test.describe('E2E_SERVER_MODE', () => {
  let dir: string;
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'e2e-server-mode-'));
  });
  test.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('start with no finished build in .next refuses at once, and never builds', () => {
    const r = runIn(dir, 'start');
    expect(r.error, 'the process must exit by itself, not hit the timeout').toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no .next/BUILD_ID found');
    expect(r.stdout, 'nothing may start a build').not.toMatch(/next build/);
    expect(r.ms).toBeLessThan(20_000);
  });

  test('an unknown mode refuses with exit 1', () => {
    const r = runIn(dir, 'bulid');
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown E2E_SERVER_MODE "bulid"');
  });

  test('the default is still build-then-start, so a local run behaves as it always has', () => {
    const src = readFileSync(SERVER, 'utf8');
    expect(src).toMatch(/process\.env\.E2E_SERVER_MODE \|\| 'both'/);
    expect(src).toContain('both: `npm run build && npx next start -p ${PORT}`');
    expect(src).toContain("build: 'npm run build',");
    expect(src).toContain('start: `npx next start -p ${PORT}`');
  });
});
