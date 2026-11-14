import { expect, test } from '@playwright/test';
import { easternDay } from '../lib/eastern-day';
import { etDay } from '../lib/moment-updates-gate.mjs';

/*
 * lib/eastern-day.ts is the client-safe copy of the gate's `etDay`, kept
 * separate so a browser bundle never pulls in the 2,000-line gate module. A
 * copy is only safe if it is pinned: these are the instants where an Eastern
 * day and a UTC day come apart, across both clock changes of 2026.
 */
const instants = [
  '2026-03-08T06:59:59Z', // 01:59:59 EST, the hour before spring-forward
  '2026-03-08T07:00:00Z', // 03:00 EDT
  '2026-11-01T05:59:59Z', // 01:59:59 EDT, the hour that repeats
  '2026-11-01T06:00:00Z', // 01:00:00 EST
  '2026-11-14T04:59:59Z', // 23:59:59 EST on the 13th
  '2026-11-14T05:00:00Z', // 00:00:00 EST on the 14th
  '2026-07-04T03:59:59Z', // 23:59:59 EDT on the 3rd
  '2026-07-04T04:00:00Z', // 00:00:00 EDT on the 4th
  '2026-12-31T23:59:59Z',
  '2027-01-01T04:59:59Z', // still the 31st in Eastern
  '2027-01-01T05:00:00Z',
];

test.describe('easternDay', () => {
  for (const iso of instants) {
    test(`${iso} reads the same day as the gate's etDay`, () => {
      expect(easternDay(Date.parse(iso))).toBe(etDay(Date.parse(iso)));
    });
  }

  test('names the Eastern day, not the UTC day', () => {
    expect(easternDay(Date.parse('2026-11-14T04:59:59Z'))).toBe('2026-11-13');
    expect(easternDay(Date.parse('2026-11-14T05:00:00Z'))).toBe('2026-11-14');
  });

  test('an unparseable instant is the empty string, never a wrong day', () => {
    expect(easternDay(Number.NaN)).toBe('');
  });
});
