import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { scanText } from '../scripts/check-key-namespaces.mjs';

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

/*
 * The daily distinct-address family (owner ruling 2026-09-25, the
 * 2026-09-27 audit's SY-20; its own day salt added 2026-09-27 on the owner's
 * decision "2. b"). The self-test above proves the family's rules
 * catch hand-written fixtures; these prove they catch a one-line regression
 * in the REAL shipped files, so a fixture that drifted away from what the
 * code actually looks like cannot leave the rule toothless.
 */
function rulesHit(file: string, text: string): string[] {
  return (scanText(file, text) as Array<{ rule: string }>).map((v) => v.rule);
}

test('distinct-address family: the shipped registry and proxy are clean, and a one-line regression in either is caught', () => {
  const registry = 'lib/ratelimit.ts';
  const real = readFileSync(join(process.cwd(), registry), 'utf8');
  expect(rulesHit(registry, real)).toEqual([]);

  // The key literal and the PFADD line these mutations edit must exist, or
  // the mutations below would silently test nothing.
  const literal = '`${keyPrefix()}:uniques:${day}`';
  const pfadd = "['PFADD', key, element]";
  expect(real).toContain(literal);
  expect(real).toContain(pfadd);

  // A route (or any) dimension folded into the key.
  expect(rulesHit(registry, real.replace(literal, '`${keyPrefix()}:uniques:${route}:${day}`'))).toContain('distinct-shape');
  // The raw address added instead of its salted hash.
  expect(rulesHit(registry, real.replace(pfadd, "['PFADD', key, address]"))).toContain('distinct-raw-address');
  // A multi-day sketch.
  expect(
    rulesHit(registry, `${real}\nawait client.cmd(['PFMERGE', 'week', distinctAddressKey(a), distinctAddressKey(b)]);\n`)
  ).toContain('distinct-shape');

  // proxy.ts feeds the sketch but must never build one itself.
  const proxy = readFileSync(join(process.cwd(), 'proxy.ts'), 'utf8');
  expect(rulesHit('proxy.ts', proxy)).toEqual([]);
  expect(
    rulesHit('proxy.ts', `${proxy}\nvoid counters.cmd(['PFADD', \`uniques:\${pageviewSurfaceForPath(p)}\`, h]);\n`)
  ).toContain('distinct-confinement');

  // The sketch's own day salt (hardened 2026-09-27, owner decision "2. b").
  // Each anchor must exist in the shipped file, or its mutation tests nothing.
  const saltLiteral = '`${keyPrefix()}:uniques-salt:${day}`';
  const saltSet = "'NX', 'EXAT', String(distinctSaltExpiresAt(day))";
  const saltDeadline = '/ 1000) + 24 * 60 * 60;\n}';
  const saltCreated = "if (created === 'OK') return remember(fresh);";
  const elementCall = 'distinctAddressElement(address, await distinctDaySalt(client, day, now.getTime()))';
  for (const anchor of [saltLiteral, saltSet, saltDeadline, saltCreated, elementCall]) {
    expect(real, `anchor missing from ${registry}: ${anchor}`).toContain(anchor);
  }
  // A dimension folded into the salt key.
  expect(rulesHit(registry, real.replace(saltLiteral, '`${keyPrefix()}:uniques-salt:${day}:${route}`'))).toContain(
    'distinct-salt-shape'
  );
  // A relative 24h lifetime instead of the end of the UTC day.
  expect(rulesHit(registry, real.replace(saltSet, "'NX', 'EX', '86400'"))).toContain('distinct-salt-expiry');
  // A deadline with a grace period past the end of the day.
  expect(rulesHit(registry, real.replace(saltDeadline, '/ 1000) + 48 * 60 * 60;\n}'))).toContain('distinct-salt-expiry');
  // The salt extended after creation, by the sketch's own 48h deadline.
  expect(
    rulesHit(
      registry,
      real.replace(
        saltCreated,
        "if (created === 'OK') { await client.cmd(['EXPIREAT', key, String(distinctAddressExpiresAt(day))]); return remember(fresh); }"
      )
    )
  ).toContain('distinct-salt-expiry');
  // The sketch fed the rate limiter's salt and hash again.
  expect(rulesHit(registry, real.replace(elementCall, 'callerHash(address, await currentSalt(client))'))).toContain(
    'distinct-salt-separation'
  );

  // Nor may the page-view registry, the one place a page label lives.
  const usage = readFileSync(join(process.cwd(), 'lib/usage.ts'), 'utf8');
  expect(rulesHit('lib/usage.ts', usage)).toEqual([]);
  expect(rulesHit('lib/usage.ts', `${usage}\nawait client.cmd(['PFADD', pageviewUsageKey(surface, day), hash]);\n`)).toContain(
    'distinct-confinement'
  );
  // ...and neither it nor proxy.ts may read the day salt.
  expect(rulesHit('lib/usage.ts', `${usage}\nconst s = await client.cmd(['GET', \`\${keyPrefix()}:uniques-salt:\${day}\`]);\n`)).toContain(
    'distinct-salt-confinement'
  );
  expect(rulesHit('proxy.ts', `${proxy}\nconst k = distinctSaltKey(day);\n`)).toContain('distinct-salt-confinement');
});
