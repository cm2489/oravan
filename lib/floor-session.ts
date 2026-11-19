/*
 * THE CHAMBER-SESSION GATE FOR THE BIG QUESTIONS STATUS LINE (2026-11-18).
 *
 * docs/record-truth.md §5: a record floor fact may be presented as live only
 * while the chamber it names is meeting. The bill page has done that since
 * 2026-08-15 with two functions: lib/docket.ts `chamberSession` (the Daily
 * Digest's own session verdict, from data/floor-signals.json) and
 * lib/journey.ts `floorFactSuspended` (the rule, with `unknown` failing safe
 * to live). This module hands exactly those two, composed, to
 * lib/moment-status.mjs `billStatusLine`, which cannot import either (it is
 * plain node with no data imports).
 *
 * EVERY SITE SURFACE THAT PRINTS A STATUS LINE GOES THROUGH
 * `siteBillStatusLine`: the Big Question cards, vehicle cards, the still-open
 * rail and the question page's header (all through lib/moments-ui.ts
 * `vehicleStatuses`), the home page's Big Questions band (lib/home.ts, the
 * same function) and the home page's week rows (app/[locale]/page.tsx).
 * tests/floor-session.unit.spec.ts fails if any other file in app/,
 * components/ or lib/ calls `billStatusLine` directly.
 */
import { chamberSession } from './docket';
import { billFloorBand, floorFactSuspended, type ChamberSession, type FloorBandKind } from './journey';
import { billStatusLine, type FloorSuspended, type StatusLine } from './moment-status.mjs';

type Chamber = 'house' | 'senate';

/** The gate over any session source — the seam the unit tests feed frozen
 *  floor-signals fixtures through (lib/docket.mjs `chamberSessionFrom`). */
export function floorSuspendedFrom(sessionOf: (chamber: Chamber) => ChamberSession): FloorSuspended {
  return (kind: FloorBandKind, chamber: Chamber) => floorFactSuspended(kind, sessionOf(chamber));
}

/** The gate the site builds with: the committed data/floor-signals.json, read
 *  at `now` (the build's clock unless a caller passes one). */
export function floorSuspendedAt(now: number = Date.now()): FloorSuspended {
  return floorSuspendedFrom((chamber) => chamberSession(chamber, now));
}

/** One bill's status line as every page prints it: lib/moment-status.mjs's
 *  reading with the session gate applied. */
export function siteBillStatusLine(
  bill: Parameters<typeof billStatusLine>[0],
  now: number = Date.now(),
  floorSuspended: FloorSuspended = floorSuspendedAt(now)
): StatusLine {
  return billStatusLine(bill, now, floorSuspended);
}

/**
 * THE VEHICLE CARD'S AMBER "On the floor calendar" MARK, with the same gate.
 *
 * The card shows the mark on a fresh calendar placement
 * (`statusKey === 'floor_vote'` within the 14-day window). That is a record
 * floor fact, so §5 applies to it exactly as it does on the bill page, whose
 * band reads `billFloorBand(...).suspended`. This asks the bill page's own
 * function, with no announcement (the mark claims a placement, never a
 * schedule).
 */
export function calendarMarkSuspended(
  bill: Parameters<typeof billFloorBand>[0],
  now: number = Date.now(),
  sessionOf: (chamber: Chamber) => ChamberSession = (chamber) => chamberSession(chamber, now)
): boolean {
  return billFloorBand(bill, null, now, sessionOf)?.suspended === true;
}
