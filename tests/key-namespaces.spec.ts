import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

/*
 * The CI privacy gate must (a) pass on the shipped tree and (b) prove it
 * still catches violations - a gate that can't fail is decoration. The
 * --self-test mode runs every rule against seeded violation fixtures
 * (stance in a counters key, caller hash in a cache key, content
 * identifiers in caller-originating query strings, "anonymized" vocabulary,
 * env/client references outside the registries) and exits nonzero if any
 * seeded violation goes undetected.
 */

function runGate(...args: string[]) {
  return spawnSync('node', ['scripts/check-key-namespaces.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

test('the tree is clean: counters keys carry no content, cache keys carry no callers, no content in caller query strings', () => {
  const result = runGate();
  expect(result.stderr, 'gate must report no violations').toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('key namespaces clean');
});

test('the gate still has teeth: every seeded violation fixture is caught, clean samples pass', () => {
  const result = runGate('--self-test');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/all \d+ seeded violations caught/);
});
