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

const byBill = new Map<string, RollCall[]>();
for (const r of VOTES.rollCalls) {
  const list = byBill.get(r.bill);
  if (list) list.push(r);
  else byBill.set(r.bill, [r]);
}
// Newest first. Roll numbers only order votes WITHIN a chamber, so a same-day
// House and Senate pair is split by chamber before roll number.
for (const list of byBill.values()) {
  list.sort((a, b) => b.date.localeCompare(a.date) || a.chamber.localeCompare(b.chamber) || b.roll - a.roll);
}
const members = new Map(VOTES.members.map((m) => [m.id, m]));

/** Every stored roll call on a bill, newest first. Empty when there are none,
 *  which for a bill that never reached a recorded vote is the true answer. */
export function votesForBill(billId: string): RollCall[] {
  return byBill.get(billId) ?? [];
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
