/*
 * The day a prerendered Big Question page was built for — read from the page,
 * never from the test's own clock.
 *
 * The question pages are static, so their timeline frame ("today", and the
 * fourteen days before it) is fixed by the BUILD. CI builds in one job and
 * tests in six more, minutes later; a run that straddles midnight Eastern put
 * the build on one day and the assertions on the next, and every expectation
 * derived from `timelineDays(id, 14)` with the runner's `Date.now()` was a day
 * out (run 43558569518, 2026-11-14: built 04:50–04:56 UTC, tested 05:01 UTC).
 *
 * `components/MomentTimeline.tsx` prints its newest day as `data-frame-day`.
 * Deriving the frame from that attribute makes the expectation and the page
 * agree by construction, at any hour, with no skew window to tune.
 */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { etDay } from '../lib/moment-updates-gate.mjs';
import { timelineDays } from '../lib/moments-ui';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The page's frame day, 'YYYY-MM-DD' (Eastern). */
export async function frameDay(page: Page): Promise<string> {
  const day = await page.locator('[data-frame-day]').first().getAttribute('data-frame-day');
  expect(day, 'the timeline prints the day its frame was built for').toMatch(DAY_RE);
  return day as string;
}

/** `timelineDays` for the frame the page was built with. Noon UTC is 07:00 or
 *  08:00 Eastern — the same Eastern day under either clock regime. */
export async function frameDays(page: Page, momentId: string, windowDays: number) {
  const day = await frameDay(page);
  return timelineDays(momentId, windowDays, Date.parse(`${day}T12:00:00Z`));
}

/** The Eastern day on the BROWSER's clock — the clock a visitor reads by. */
export async function visitorEtDay(page: Page): Promise<string> {
  return etDay(await page.evaluate(() => Date.now()));
}
