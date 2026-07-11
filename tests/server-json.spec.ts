import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/*
 * S12 — the MCP registry server.json validation gate. Same shape as
 * tests/key-namespaces.spec.ts and tests/embed-fingerprinting.spec.ts: the
 * gate must (a) pass on the shipped server.json and (b) prove it still
 * catches violations, so a --self-test mode is run too. S12's own Done
 * criterion is literally "server.json validates" — this is that criterion.
 */

function runGate(...args: string[]) {
  return spawnSync('node', ['scripts/check-server-json.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

test('server.json validates against the official schema rules and the version/SITE_ORIGIN cross-checks', () => {
  const result = runGate();
  expect(result.stderr, 'gate must report no violations').toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('server.json validates');
});

test('the gate still has teeth: every seeded violation fixture is caught, the clean fixture passes', () => {
  const result = runGate('--self-test');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/all \d+ seeded violations caught/);
});

test('server.json declares the real deployed Streamable HTTP endpoint', () => {
  const doc = JSON.parse(readFileSync('server.json', 'utf8'));
  expect(doc.remotes).toHaveLength(1);
  expect(doc.remotes[0]).toMatchObject({
    type: 'streamable-http',
    url: 'https://oravan.org/api/mcp/mcp',
  });
});

test('server.json version stays in sync with package.json (belt-and-suspenders on top of the gate)', () => {
  const server = JSON.parse(readFileSync('server.json', 'utf8'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(server.version).toBe(pkg.version);
});
