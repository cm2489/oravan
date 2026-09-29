/*
 * ONE ROLL CALL'S MEMBER LIST, as the vote record's "How members voted"
 * disclosure shows it: every member the record lists, grouped by the record's
 * four positions, each group sorted by last name. Server-side only (it reads
 * data/votes.json and data/legislators.json); the build writes one file per
 * roll call through app/votes/[file]/route.ts, and the browser fetches the one
 * a reader opens (components/VoteMembers.tsx). The URL shape and the file's
 * type live in lib/vote-members-path.ts, which a client module may import.
 *
 * NAMES come from data/legislators.json joined on bioguide, with the roster in
 * votes.json as the fallback for a member who has since left, exactly as the
 * list did when it was printed into the page. State follows the name; party
 * never does.
 */
import { getLegislator } from '@/lib/core';
import type { RollCall, VotePosition } from '@/lib/types';
import { allRollCalls, rollCallById, votingMember } from '@/lib/votes';
import { voteMembersFileName, type VoteMember, type VoteMembersFile } from '@/lib/vote-members-path';

const POSITIONS: VotePosition[] = ['yea', 'nay', 'present', 'notVoting'];
const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;

interface Named {
  id: string;
  name: string;
  state: string;
  last: string;
}

function named(id: string): Named {
  const l = getLegislator(id);
  if (l) return { id, name: l.name, state: l.state, last: l.last };
  const m = votingMember(id);
  const name = m?.name ?? id;
  const parts = name.replace(/,/g, '').split(/\s+/).filter((p) => !SUFFIX.test(p));
  return { id, name, state: m?.state ?? '', last: parts[parts.length - 1] ?? name };
}

function byLastName(a: Named, b: Named) {
  return a.last.localeCompare(b.last, 'en') || a.name.localeCompare(b.name, 'en');
}

/** The member list for one roll call, ready to serialize. */
export function voteMembersFor(r: RollCall): VoteMembersFile {
  return {
    id: r.id,
    groups: POSITIONS.filter((p) => r.votes[p].length > 0).map((position) => ({
      position,
      members: r.votes[position]
        .map(named)
        .sort(byLastName)
        .map((m): VoteMember => [m.id, m.name, m.state]),
    })),
  };
}

/** Every file name the build writes under /votes, one per stored roll call. */
export function voteMemberFileNames(): string[] {
  return allRollCalls().map((r) => voteMembersFileName(r.id));
}

/** The list behind one file name (`h-119-1-6.json`), or null for any other name. */
export function voteMembersForFile(file: string): VoteMembersFile | null {
  if (!file.endsWith('.json')) return null;
  const r = rollCallById(file.slice(0, -'.json'.length));
  return r ? voteMembersFor(r) : null;
}
