/*
 * Pure office-hours math for the S7 "before you dial" honesty check. Scoped
 * to Eastern Time (the DC office's own timezone) on purpose: district
 * offices span every US timezone (flow I8), and Oravan has no per-office
 * hours data to do better than a generic guide - see docs/ideation/
 * 2026-07-05-build-gtm-strategy.md §5. This never claims a specific office
 * is open or closed - only whether *right now* falls inside the typical
 * Mon-Fri Congressional business-hours window, so the caller can read the
 * after-hours case as "voicemail is likely, and that's a fine first call"
 * rather than a guess dressed up as certainty.
 */

export type OfficeHoursStatus = 'open' | 'closed';

/** Typical Congressional office hours, Eastern Time - a generic guide, not
 *  per-office data (none exists; exact hours vary by office). */
export const OFFICE_HOURS_OPEN_HOUR = 9; // 9:00 AM ET
export const OFFICE_HOURS_CLOSE_HOUR = 17.5; // 5:30 PM ET

const WEEKEND = new Set(['Sat', 'Sun']);

export function officeHoursStatus(now: number = Date.now()): OfficeHoursStatus {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date(now));

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  let hour = Number(get('hour'));
  const minute = Number(get('minute'));
  if (hour === 24) hour = 0; // some engines format midnight as "24" under hour12:false

  if (WEEKEND.has(weekday)) return 'closed';

  const fractionalHour = hour + minute / 60;
  const withinHours =
    fractionalHour >= OFFICE_HOURS_OPEN_HOUR && fractionalHour < OFFICE_HOURS_CLOSE_HOUR;
  return withinHours ? 'open' : 'closed';
}
