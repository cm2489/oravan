import { isSignalFresh } from './signal-window';
import type { StatusLabelKey } from './types';

/**
 * DOES A BIG QUESTION VEHICLE CARD WEAR THE AMBER "On the floor calendar"
 * MARK? (components/MomentVehicleCard.tsx, which cannot be rendered in a
 * Node unit test because next-intl's navigation does not load there; this is
 * its rule, pure, so tests/floor-session.unit.spec.ts can hold it.)
 *
 * Three conditions, all needed:
 *   - the status earns the mark: `floor_vote`, a fresh calendar placement
 *     (an aged one arrives as `floor_vote_stale` and prints in ink);
 *   - the printed date is inside the 14-day window the page publishes;
 *   - the chamber is meeting (2026-11-18, docs/record-truth.md §5): the
 *     caller passes `floorSuspended` from lib/floor-session.ts
 *     `calendarMarkSuspended`, the bill page's own reading.
 */
export function calendarMarkShows({
  statusKey,
  lastActionDate,
  floorSuspended = false,
  now = Date.now(),
}: {
  statusKey: StatusLabelKey;
  lastActionDate: string | null;
  floorSuspended?: boolean;
  now?: number;
}): boolean {
  return statusKey === 'floor_vote' && isSignalFresh(lastActionDate, now) && !floorSuspended;
}
