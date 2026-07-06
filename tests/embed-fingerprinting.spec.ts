import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

/*
 * S15 — the no-fingerprinting/no-analytics static gate. Same shape as
 * tests/key-namespaces.spec.ts: the gate must (a) pass on the shipped tree
 * and (b) prove it still catches violations, so a --self-test mode is run
 * too. See scripts/check-embed-fingerprinting.mjs's header comment for the
 * honestly-disclosed limits of a grep-based check like this one.
 */

function runGate(...args: string[]) {
  return spawnSync('node', ['scripts/check-embed-fingerprinting.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

test('the embed source tree is clean: no known fingerprinting API or analytics identifier', () => {
  const result = runGate();
  expect(result.stderr, 'gate must report no violations').toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('embed fingerprinting/analytics gate clean');
});

test('the gate still has teeth: every seeded violation fixture is caught, the clean sample passes', () => {
  const result = runGate('--self-test');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/all \d+ seeded violations caught/);
});
