/*
 * THE HOMEPAGE'S READINGS — Home option B (owner, 2026-09-29, typed: "Home
 * Page - Option B, This week first, then Big Questions."; the v2 wireframe of
 * the same day draws it).
 *
 * Two things the page needs that no other surface computes, both read from
 * the record and nothing else:
 *
 *   1. THE BIG QUESTIONS, NEWEST RECORD ACTION FIRST. The wireframe's order
 *      (its "Guesses to confirm": "Big Questions sorted newest record action
 *      first (live uses file order)"). The key is the date the row PRINTS —
 *      the question-level status line's own date (lib/moment-status.mjs
 *      questionStatus) — so the dates down the list only ever descend. Ties
 *      go to the newest action on any vehicle, then to the newest day the
 *      live layer recorded, then to the file order the page used before.
 *
 *   2. THE ROW'S SHORT STATUS LINE. The /questions card prints the long line
 *      (`moments.status.line.*`); a homepage row has room for a few words, so
 *      it prints `homeLine.*`, a short twin of the SAME closed vocabulary
 *      (tests/home.unit.spec.ts pins one short line per key, in both
 *      languages). Nothing here reads the record a second way: the key, the
 *      chamber and the date are questionStatus's lead line, untouched. The
 *      one addition is a tally on `failed`, and it comes from the very
 *      sentence the key was read from (lib/floor-text.mjs statusBasisText,
 *      then recordedTally) — "Failed of passage in Senate by Yea-Nay Vote.
 *      49 - 50." prints 49–50, and a sentence that carries no tally prints
 *      none.
 *
 * The clock is a defaulted parameter (the idiom of lib/moments.ts), so the
 * statically generated page never calls an impure function in a component
 * body and a test can pin the frame.
 */
import { getBill } from './core/bills';
import { recordedTally, statusBasisText } from './floor-text.mjs';
import type { StatusLine } from './moment-status.mjs';
import { questionStatus } from './moment-status.mjs';
import { latestUpdateDay } from './moment-updates';
import { getLiveMoments, vehicleKind, type MomentWithState } from './moments';
import { latestVehicleAction, vehicleStatuses } from './moments-ui';

/** What the order reads, per question. Plain data, so the comparator is pure. */
export interface RecordOrderKey {
  /** The date the row prints: the lead status line's `date`. */
  leadDate: string | null;
  /** The newest `last_action_date` on any of the question's vehicles. */
  latestAction: string | null;
  /** The newest day the live layer recorded for the question. */
  latestUpdate: string | null;
  /** Position in data/moments.json — the order the page used before. */
  index: number;
}

/** Newest first; a missing date sorts after every real one. */
function newestFirst(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b.localeCompare(a);
}

/** Newest record action first; see the header for the tie order. */
export function byNewestRecord(a: RecordOrderKey, b: RecordOrderKey): number {
  return (
    newestFirst(a.leadDate, b.leadDate) ||
    newestFirst(a.latestAction, b.latestAction) ||
    newestFirst(a.latestUpdate, b.latestUpdate) ||
    a.index - b.index
  );
}

/** A tally the record printed, or none. */
export type HomeTally = { yeas: number; nays: number } | null;

export interface HomeQuestionRow {
  moment: MomentWithState;
  /** questionStatus's lead line, or null when no vehicle resolves. */
  lead: StatusLine | null;
  /** Set only on a `failed` lead, from the sentence the key was read from. */
  tally: HomeTally;
  order: RecordOrderKey;
}

/**
 * The tally the lead line may print. Only a `failed` line carries one: it is
 * the one key whose sentence is itself a vote ("Failed of passage in Senate by
 * Yea-Nay Vote. 49 - 50."). The other keys' sentences are placements,
 * receipts or motions, and a number beside them would be a number about a
 * different event than the words it sits next to.
 */
export function leadTally(
  lead: StatusLine | null,
  bill: Parameters<typeof statusBasisText>[0] | null | undefined
): HomeTally {
  if (!lead || lead.key !== 'failed' || !bill) return null;
  return recordedTally(statusBasisText(bill));
}

/** The live Big Questions, as homepage rows, newest record action first. */
export function homeQuestionRows(now: number = Date.now()): HomeQuestionRow[] {
  return getLiveMoments(now)
    .map((moment, index) => {
      const statuses = vehicleStatuses(moment.vehicles, now);
      const lead = questionStatus(statuses.map((s) => s.line)).lead;
      // The vehicle the lead line was read from — questionStatus returns one
      // of the lines it was handed, so identity finds it.
      const leadVehicle = lead ? statuses.find((s) => s.line === lead)?.vehicle : undefined;
      const leadBill =
        leadVehicle && vehicleKind(leadVehicle) === 'bill' ? getBill(leadVehicle.slug) : undefined;
      return {
        moment,
        lead,
        tally: leadTally(lead, leadBill),
        order: {
          leadDate: lead?.date ?? null,
          latestAction: latestVehicleAction(moment.vehicles),
          latestUpdate: latestUpdateDay(moment.id) ?? null,
          index,
        },
      };
    })
    .sort((a, b) => byNewestRecord(a.order, b.order));
}
