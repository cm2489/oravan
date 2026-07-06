import { expect, test } from '@playwright/test';
import { officeHoursStatus } from '../lib/office-hours';

/*
 * Pure math for the S7 office-hours honesty check. Fixed timestamps below
 * are asserted against their Eastern-time weekday/hour once (see the office
 * hours audit in this PR) so the test data is self-documenting without a
 * live timezone dependency at test time.
 */
const WEEKDAY_MORNING = new Date('2026-07-08T14:00:00Z').getTime(); // Wed 10:00 ET
const WEEKDAY_LATE_NIGHT = new Date('2026-07-08T03:30:00Z').getTime(); // Tue 23:30 ET
const WEEKEND_MIDDAY = new Date('2026-07-12T15:00:00Z').getTime(); // Sun 11:00 ET
const OPEN_BOUNDARY = new Date('2026-07-08T13:00:00Z').getTime(); // Wed 09:00 ET exactly
const JUST_BEFORE_CLOSE = new Date('2026-07-08T21:29:00Z').getTime(); // Wed 17:29 ET
const CLOSE_BOUNDARY = new Date('2026-07-08T21:30:00Z').getTime(); // Wed 17:30 ET exactly

test.describe('officeHoursStatus (S7 honest, generic Eastern-time guide)', () => {
  test('weekday, mid-morning Eastern is open', () => {
    expect(officeHoursStatus(WEEKDAY_MORNING)).toBe('open');
  });

  test('weekday, late night Eastern is closed', () => {
    expect(officeHoursStatus(WEEKDAY_LATE_NIGHT)).toBe('closed');
  });

  test('weekend, regardless of hour, is closed', () => {
    expect(officeHoursStatus(WEEKEND_MIDDAY)).toBe('closed');
  });

  test('boundaries: open at 9:00am and 5:29pm, closed at 5:30pm sharp', () => {
    expect(officeHoursStatus(OPEN_BOUNDARY)).toBe('open');
    expect(officeHoursStatus(JUST_BEFORE_CLOSE)).toBe('open');
    expect(officeHoursStatus(CLOSE_BOUNDARY)).toBe('closed');
  });
});
