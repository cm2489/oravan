import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Relative import of the plain .mjs module - same pattern as
// tests/urgency.unit.spec.ts importing lib/urgency.mjs: the logic tested
// here is exactly what scripts/check-rollover-tripwire.mjs runs weekly.
import { ROLLOVER_DEADLINE, WARNING_START, rolloverWarning } from '../lib/rollover-tripwire.mjs';

/*
 * Pins the 119th -> 120th Congress rollover tripwire (S24, two-clock model,
 * docs/solutions/two-clock-district-boundaries.md): silent before the
 * warning window opens, loud (but never failing) once it does, and louder
 * in tone the closer today is to the Jan 3, 2027 deadline.
 */

test('constants match the dated plan: ~1 month of lead time before the 120th Congress is sworn in', () => {
  expect(WARNING_START).toBe('2026-12-01');
  expect(ROLLOVER_DEADLINE).toBe('2027-01-03');
});

test('before Dec 1, 2026: silent (no swap is needed yet per the two-clock model)', () => {
  expect(rolloverWarning('2026-07-06')).toBeNull();
  expect(rolloverWarning('2026-11-30')).toBeNull();
});

test('on/after Dec 1, 2026: a loud warning naming the literal and the file to bump', () => {
  const msg = rolloverWarning('2026-12-01');
  expect(msg).not.toBeNull();
  expect(msg).toMatch(/119th -> 120th Congress rollover/);
  expect(msg).toMatch(/CENSUS_QUERY\.layers/);
  expect(msg).toMatch(/119th Congressional Districts/);
  expect(msg).toMatch(/zip-districts\.json/);
  expect(msg).toMatch(/two-clock-district-boundaries\.md/);
});

test('countdown counts down as the deadline approaches', () => {
  expect(rolloverWarning('2026-12-01')).toMatch(/33 day\(s\) until Jan 3, 2027/);
  expect(rolloverWarning('2027-01-02')).toMatch(/1 day\(s\) until Jan 3, 2027/);
  expect(rolloverWarning('2027-01-03')).toMatch(/0 day\(s\) until Jan 3, 2027/);
});

test('past the deadline: still warns, now framed as overdue rather than counting down', () => {
  const msg = rolloverWarning('2027-01-10');
  expect(msg).toMatch(/7 day\(s\) PAST the Jan 3, 2027 deadline/);
});

test('accepts a Date object, not just an ISO string', () => {
  expect(rolloverWarning(new Date('2026-06-01T00:00:00Z'))).toBeNull();
  expect(rolloverWarning(new Date('2026-12-15T00:00:00Z'))).not.toBeNull();
});

/*
 * The DATE logic above is only half the guarantee. The other half is the
 * WIRING, and it is the fragile half: the tripwire runs from one weekly job
 * (.github/workflows/refresh-legislators.yml) whose earlier steps depend on
 * two unrelated third parties, and one of them - the Redistricting Data Hub
 * sitemap poll - exits 1 BY DESIGN when RDH restructures their site. Under
 * GitHub's default `if: success()` that would silently skip this step every
 * week until a human noticed, and a skipped tripwire is indistinguishable
 * from a tripwire that hasn't fired yet.
 *
 * This is workflow YAML, so the honest test is static - the same grep-level
 * posture as tests/pregen-route-posture.unit.spec.ts, where the strongest
 * form of the guarantee is asserted against the source text itself. It pins
 * the decoupling so a future edit that drops `if: always()` (or reorders the
 * job in a way that re-couples the step) fails CI with an explanation
 * attached, rather than going quiet until Jan 2027.
 */
const REFRESH_WORKFLOW = join(process.cwd(), '.github/workflows/refresh-legislators.yml');

test('the weekly workflow still runs this tripwire at all', () => {
  // Guards against the assertion below passing only because the step was
  // deleted rather than because it is correctly decoupled.
  const yml = readFileSync(REFRESH_WORKFLOW, 'utf8');
  expect(yml).toMatch(/run: node scripts\/check-rollover-tripwire\.mjs/);
});

test('the tripwire step is decoupled: `if: always()`, so an upstream third-party failure cannot silently skip a dated deadline', () => {
  const yml = readFileSync(REFRESH_WORKFLOW, 'utf8');
  const step = yml.slice(yml.indexOf('119th -> 120th Congress rollover tripwire'));
  const body = step.slice(0, step.indexOf('run: node scripts/check-rollover-tripwire.mjs'));
  expect(body).toMatch(/^\s*if: always\(\)$/m);
});
