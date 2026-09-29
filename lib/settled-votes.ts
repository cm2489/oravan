import { recordedTally, statusBasisText } from './floor-text.mjs';
import type { SettledDecision } from './journey';
import type { Bill, RollCall, VotePosition } from './types';

/*
 * "HOW YOUR MEMBERS VOTED", ONE VOTE AT A TIME — the groups the record-only
 * panel (components/SettledPanel.tsx) prints under a settled bill's outcome.
 *
 * Why groups (owner, 2026-09-28, reviewing /bills/hconres-89-119): "It's
 * talking about the Senate but in the 'no call to make' box it talks about the
 * House vote and then says the senators underneath this. That doesn't make
 * sense and is confusing." The panel used to print one list of the reader's
 * three members, each beside the newest roll call in their own chamber, so a
 * Senate outcome sat above a House member's House vote with nothing saying
 * which vote was which. Now every vote is its own group, labeled with its
 * chamber, date and tally, and a member is listed only under a vote their own
 * chamber held. Never two chambers in one list.
 *
 * THE ORDER. On a rejection (since the owner's pick (a), 2026-09-29, the only
 * settled vote: a failed motion or a failed two-thirds suspension vote keeps
 * the call panel), the DECIDING vote comes first — the one the outcome
 * sentence is about — and then
 * the other chamber's newest roll call on the bill, when the vote file holds
 * one. On a law there is no single deciding vote, so each chamber's newest
 * roll call prints, newest first.
 *
 * On an ADOPTED concurrent resolution (2026-09-29, lib/journey.ts
 * `settledDecision` 'adopted') the groups are built exactly as on a
 * rejection: the second chamber's agreement first, the vote that completed
 * it (H.Con.Res. 86: the Senate's record vote 184, 50–48, 2026-06-23), then
 * the other chamber's newest roll call on the measure (its House roll 199,
 * 215–208, 2026-06-03, the only House roll call the file holds on it).
 *
 * THE DECIDING VOTE is found by the roll number the record's own sentence
 * carries ("… Record Vote Number: 244." in the Senate, "… (Roll no. 19)." in
 * the House) and the action's date, so a second roll call on the same day is
 * never mistaken for it. When the vote file does not hold it — H.R. 2262's
 * House vote of 2026-01-13 is older than the file's floor — the group still prints,
 * with the record's own date and tally and the plain statement that the file
 * does not show positions for it. A voice vote records no positions at all,
 * and says that instead.
 */

export type VoteChamber = RollCall['chamber'];

export interface SettledVoteGroup {
  chamber: VoteChamber;
  /** YYYY-MM-DD: the roll call's own date, or the record's date for the action
   *  when the vote file does not hold the roll call. Null when neither has one. */
  date: string | null;
  /** Yeas–nays: the roll call's totals, or the record sentence's own tally. */
  tally: { yeas: number; nays: number } | null;
  /**
   * How the members' positions are known:
   * - `rollCall`: the vote file holds this roll call; `positions` is set.
   * - `beforeFile`: a recorded vote older than the file's floor, so the file
   *   cannot hold it (H.R. 2262's House vote).
   * - `notInFile`: a recorded vote on or after the floor the file does not
   *   hold yet.
   * - `voice`: a voice vote — no member's position was ever recorded.
   */
  source: 'rollCall' | 'beforeFile' | 'notInFile' | 'voice';
  /** bioguide → position; only when `source` is `rollCall`. */
  positions: Record<string, VotePosition> | null;
  /** The vote the outcome sentence is about. */
  deciding: boolean;
}

const POSITIONS: VotePosition[] = ['yea', 'nay', 'present', 'notVoting'];

const VOICE_VOTE = /\bvoice vote\b/i;

type SettledBill = Pick<Bill, 'last_action_text' | 'last_action_date'> & {
  status_basis_text?: string | null;
  status_basis_date?: string | null;
};

/**
 * The date of the action the settled reading came from: the status basis's
 * own date when the pipeline wrote one (the latest step was an ambiguous
 * follow-up sentence), otherwise the latest action's. Never a date the record
 * does not hold: a basis without a date gives null, not the latest action's.
 */
export function settledDecisionDate(bill: SettledBill): string | null {
  if (bill.status_basis_text) return bill.status_basis_date ?? null;
  return bill.last_action_date ?? null;
}

/** The roll number a record sentence carries for its own chamber's vote. */
export function recordedRollNumber(text: string | null | undefined, chamber: VoteChamber): number | null {
  const m =
    chamber === 'house'
      ? /\(Roll no\.\s*(\d+)\)/i.exec(text ?? '')
      : /\bRecord Vote (?:Number|No\.?)\s*:?\s*(\d+)/i.exec(text ?? '');
  return m ? Number(m[1]) : null;
}

function fromRollCall(r: RollCall, deciding: boolean): SettledVoteGroup {
  const positions: Record<string, VotePosition> = {};
  for (const p of POSITIONS) for (const id of r.votes[p]) positions[id] = p;
  return {
    chamber: r.chamber,
    date: r.date,
    tally: { yeas: r.totals.yea, nays: r.totals.nay },
    source: 'rollCall',
    positions,
    deciding,
  };
}

/**
 * The panel's vote groups, in print order.
 *
 * @param rollCalls this bill's roll calls, newest first (lib/votes.ts
 *   `votesForBill`).
 * @param floor the vote file's first date, YYYY-MM-DD (lib/votes.ts
 *   `votesCoverage().floor`).
 */
export function settledVoteGroups(
  bill: SettledBill,
  settled: SettledDecision,
  rollCalls: readonly RollCall[],
  floor: string
): SettledVoteGroup[] {
  if (settled.kind === 'law') {
    const groups: SettledVoteGroup[] = [];
    for (const r of rollCalls) {
      if (groups.some((g) => g.chamber === r.chamber)) continue;
      groups.push(fromRollCall(r, false));
    }
    return groups;
  }

  // A rejection or an adoption: the vote the outcome sentence is about first.
  const chamber = settled.chamber;
  const record = statusBasisText(bill) ?? '';
  const date = settledDecisionDate(bill);
  const roll = recordedRollNumber(record, chamber);
  const inChamber = rollCalls.filter((r) => r.chamber === chamber);
  // By roll number (and the date, since roll numbers restart each session);
  // with no roll number in the sentence, the newest roll call that chamber
  // held on the action's date — the list is newest first, so that is the
  // day's last vote, the one the latest action records.
  const match =
    roll !== null
      ? inChamber.find((r) => r.roll === roll && (date === null || r.date === date))
      : date !== null
        ? inChamber.find((r) => r.date === date)
        : undefined;

  const deciding: SettledVoteGroup = match
    ? fromRollCall(match, true)
    : {
        chamber,
        date,
        tally: recordedTally(record),
        source: VOICE_VOTE.test(record)
          ? 'voice'
          : date !== null && date < floor
            ? 'beforeFile'
            : 'notInFile',
        positions: null,
        deciding: true,
      };

  const other = rollCalls.find((r) => r.chamber !== chamber);
  return other ? [deciding, fromRollCall(other, false)] : [deciding];
}
