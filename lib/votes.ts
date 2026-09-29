/*
 * Roll-call votes — read helpers over data/votes.json, the same posture as
 * lib/moment-updates.ts (pure, deliberately NOT 'server-only').
 *
 * The file is written by scripts/sync-votes.mjs from the official record and
 * gated by scripts/check-votes.mjs; this module only reads. Nothing here
 * renders a string: the UI maps a `VotePosition` to its own translated label
 * (Yea / Nay / Present / Not voting), never to a characterization of it.
 */
import votesJson from '@/data/votes.json';
import type { RollCall, VotePosition, VotesFile, VotingMember } from './types';

const VOTES = votesJson as unknown as VotesFile;
const POSITIONS: VotePosition[] = ['yea', 'nay', 'present', 'notVoting'];

// Newest first. Roll numbers only order votes WITHIN a chamber, so a same-day
// House and Senate pair is split by chamber before roll number.
function newestFirst(a: RollCall, b: RollCall): number {
  return b.date.localeCompare(a.date) || a.chamber.localeCompare(b.chamber) || b.roll - a.roll;
}

const byBill = new Map<string, RollCall[]>();
for (const r of VOTES.rollCalls) {
  const list = byBill.get(r.bill);
  if (list) list.push(r);
  else byBill.set(r.bill, [r]);
}
for (const list of byBill.values()) list.sort(newestFirst);
const members = new Map(VOTES.members.map((m) => [m.id, m]));

/** One position one member holds on one roll call, as the record lists it. */
export interface MemberVote {
  rollCall: RollCall;
  position: VotePosition;
}

/** A member's stored votes on ONE bill, newest first. */
export interface MemberBillVotes {
  /** Corpus bill id (`hr-3633-119`), the roll calls' own `bill` field. */
  bill: string;
  votes: MemberVote[];
}

// Built on first use, not at import: the bill page and /today read this module
// and never ask the member question.
let byMember: Map<string, MemberVote[]> | null = null;
function memberIndex(): Map<string, MemberVote[]> {
  if (byMember) return byMember;
  const index = new Map<string, MemberVote[]>();
  for (const rollCall of VOTES.rollCalls) {
    for (const position of POSITIONS) {
      for (const id of rollCall.votes[position]) {
        const list = index.get(id);
        if (list) list.push({ rollCall, position });
        else index.set(id, [{ rollCall, position }]);
      }
    }
  }
  for (const list of index.values()) list.sort((a, b) => newestFirst(a.rollCall, b.rollCall));
  byMember = index;
  return index;
}

/**
 * Every stored roll call that lists this member — Yea, Nay, Present or Not
 * voting, exactly the record's four words — grouped by bill. Bills are ordered
 * by the member's newest vote on each; inside a bill, newest first. Empty when
 * the record lists the member on no stored roll call (a delegate, a member
 * sworn in after the last one), which is the true answer, not a gap to fill.
 */
export function memberVotesByBill(bioguide: string): MemberBillVotes[] {
  const groups = new Map<string, MemberVote[]>();
  // The index is already newest first, so each bill's first insertion is the
  // member's newest vote on it and Map order is the bill order.
  for (const vote of memberIndex().get(bioguide) ?? []) {
    const list = groups.get(vote.rollCall.bill);
    if (list) list.push(vote);
    else groups.set(vote.rollCall.bill, [vote]);
  }
  return [...groups].map(([bill, votes]) => ({ bill, votes }));
}

/**
 * The most bills the member page's "How they voted" lists: the newest this
 * many from memberVotesByBill, then one line counting the bills left out and
 * pointing to each bill's own page, whose vote record lists every stored roll
 * call and every member on it. A page-weight cap, decided 2026-09-28 on PR
 * #348: every row ships as HTML and again as server-component payload, and a
 * House member's list grows with every roll call the Congress takes.
 *
 * It caps ROLL CALLS as well as bills (2026-09-29, after the 119th Congress
 * back-fill): each row prints only the member's newest vote on its bill and
 * links to the bill page's vote record for the rest, so the page prints at
 * most this many roll calls. Counting bills alone let one bill print every
 * roll call the member cast on it (hr-1-119 has 47), and the heaviest member
 * page, a senator's, measured 998 kB of HTML on the build of 2026-09-29.
 */
export const MEMBER_VOTES_MAX_BILLS = 50;

/** Every stored roll call on a bill, newest first. Empty when there are none,
 *  which for a bill that never reached a recorded vote is the true answer. */
export function votesForBill(billId: string): RollCall[] {
  return byBill.get(billId) ?? [];
}

const HOUSE_XML = /^https:\/\/clerk\.house\.gov\/evs\/(\d{4})\/roll(\d+)\.xml$/;
const SENATE_XML =
  /^(https:\/\/www\.senate\.gov\/legislative\/LIS\/roll_call_votes\/vote\d{4}\/vote_\d{3}_\d_\d{5})\.xml$/;

/**
 * The official page that lists every member's position on this roll call,
 * for a reader to open in a browser. `source` is the record's data file: the
 * Clerk's XML (which names an XSL stylesheet for the browser to draw it with)
 * or the Senate's XML (which names none, so a browser shows the raw tree).
 * Each chamber also publishes the roll call as a web page at a fixed address,
 * made from the same year, session and roll number (a sample of both shapes
 * was fetched from the live sites on 2026-09-29, PR "Alternative: print the
 * full member list only for the newest vote"):
 *
 *   clerk.house.gov/evs/2025/roll144.xml          -> clerk.house.gov/Votes/2025144
 *   senate.gov/.../vote1192/vote_119_2_00244.xml  -> senate.gov/.../vote1192/vote_119_2_00244.htm
 *
 * Anything that does not match those two shapes is returned unchanged, so the
 * link always reaches the official record, in the worst case as its data file.
 * The vote record uses it for the member list of every roll call but the
 * newest, whose list the bill page prints itself (components/VoteRecord.tsx).
 */
export function memberListPage(rollCall: RollCall): string {
  const house = HOUSE_XML.exec(rollCall.source);
  if (house) return `https://clerk.house.gov/Votes/${house[1]}${house[2]}`;
  const senate = SENATE_XML.exec(rollCall.source);
  if (senate) return `${senate[1]}.htm`;
  return rollCall.source;
}

/** How a member voted on one roll call, or null when the record does not
 *  list them (not seated in that chamber on that date). */
export function memberPosition(rollCall: RollCall, bioguide: string): VotePosition | null {
  for (const p of POSITIONS) if (rollCall.votes[p].includes(bioguide)) return p;
  return null;
}

/** The roster record for a member named in any stored roll call: the join
 *  that keeps working after a member leaves data/legislators.json. */
export function votingMember(bioguide: string): VotingMember | undefined {
  return members.get(bioguide);
}

/** The window the file covers, for honest "since" copy. */
export function votesCoverage(): { floor: string; updatedAt: string } {
  return { floor: VOTES._meta.floor, updatedAt: VOTES._meta.updatedAt };
}
