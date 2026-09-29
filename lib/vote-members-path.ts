/*
 * WHERE ONE ROLL CALL'S MEMBER LIST LIVES, and its shape.
 *
 * The bill page's vote record prints, for every roll call, the question, the
 * result, the tally, the date and the official record. The member-by-member
 * list is the heavy part (every member of the chamber, on every roll call), so
 * since 2026-09-29 it is not in the page: the build writes one static JSON
 * file per roll call (app/votes/[file]/route.ts, built by lib/vote-members.ts)
 * and the "How members voted" disclosure (components/VoteMembers.tsx) fetches
 * that one file, from this site, when a reader opens it.
 *
 * This module is the one place the URL shape is written, shared by the route
 * that writes the files and the client component that reads them. It imports
 * nothing by value on purpose: a client module imports it, and
 * scripts/check-client-imports.mjs fails any client module whose imports reach
 * data/.
 *
 * The path carries a dot (`.json`), so proxy.ts's matcher skips it: no locale
 * negotiation and no page-view count for a list fetch.
 */
import type { VotePosition } from './types';

/** One member on one roll call: bioguide, display name, state. */
export type VoteMember = [bioguide: string, name: string, state: string];

/** One non-empty position group, members sorted by last name. */
export interface VoteMembersGroup {
  position: VotePosition;
  members: VoteMember[];
}

/** The body of one `/votes/<rollCallId>.json` file. */
export interface VoteMembersFile {
  /** The roll call's own id in data/votes.json (`h-119-1-6`). */
  id: string;
  /** In the record's order (Yea, Nay, Present, Not voting); empty groups left out. */
  groups: VoteMembersGroup[];
}

/** The file name under /votes for one roll call. */
export function voteMembersFileName(rollCallId: string): string {
  return `${rollCallId}.json`;
}

/** The same-origin URL path of one roll call's member list. */
export function voteMembersPath(rollCallId: string): string {
  return `/votes/${voteMembersFileName(rollCallId)}`;
}
