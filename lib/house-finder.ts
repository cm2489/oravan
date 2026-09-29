import type { District, VotePosition } from './types';

/*
 * THE SPLIT-ZIP HOUSE FINDER, VERSION B — the pure half of
 * components/SettledHouseFinder.tsx.
 *
 * The owner, 2026-09-29, reviewing the settled box on /bills/hconres-89-119
 * with a ZIP that spans more than one House district: "Great edge case on the
 * house district/zip situation here. This would be a use of a subtle yellow
 * button (I know color comes later) but there should be a way for them to find
 * those votes in this box here. Can you build that for me? Mock up two
 * versions of how this could look."
 *
 * Version B asks for the street address (the /reps refinement, POST
 * /api/district) and then shows ONE member: the one whose district the
 * address is in, beside the position data/votes.json records for them on that
 * House roll call. When the address check fails it falls back to every seat
 * the ZIP spans, each member beside their own recorded position.
 *
 * Everything here reads what the page already holds: the reps lookup's answer
 * for the saved ZIP (GET /api/reps — the members and the vacant seats of the
 * ZIP's districts) and the roll call's positions the server rendered into the
 * page for every visitor alike. Nothing is fetched and nothing is stored.
 */

/** A House member as the reps lookup answers them — only what the panel prints. */
export interface FinderMember {
  bioguide: string;
  name: string;
  state: string;
  district: number | null;
}

/** One House seat the saved ZIP spans: its member, or null when it is vacant. */
export interface HouseSeat {
  state: string;
  district: number;
  member: FinderMember | null;
}

/**
 * The ZIP's House seats, one per district, in state-then-district order: each
 * House member the lookup listed, and each vacant seat it listed. A member the
 * lookup gives no district for is left out rather than guessed at.
 */
export function houseSeats(
  members: readonly (FinderMember & { type: 'sen' | 'rep' })[],
  vacancies: readonly District[]
): HouseSeat[] {
  const seats: HouseSeat[] = [];
  const seen = new Set<string>();
  const add = (state: string, district: number, member: FinderMember | null) => {
    const key = `${state}-${district}`;
    if (seen.has(key)) return;
    seen.add(key);
    seats.push({ state, district, member });
  };
  for (const m of members) {
    if (m.type !== 'rep' || m.district === null) continue;
    add(m.state, m.district, { bioguide: m.bioguide, name: m.name, state: m.state, district: m.district });
  }
  for (const v of vacancies) add(v.state, v.district, null);
  return seats.sort((a, b) => a.state.localeCompare(b.state) || a.district - b.district);
}

/**
 * The short code for a seat, the way the Clerk writes it: "TX-10". An at-large
 * seat (district 0) is the state alone.
 */
export function seatCode(d: District): string {
  return d.district === 0 ? d.state : `${d.state}-${d.district}`;
}

/** What the address answered, read against the ZIP's own seats. */
export type FinderAnswer =
  /** One of the ZIP's seats: its member (or null, vacant). */
  | { kind: 'seat'; seat: HouseSeat }
  /** A district the ZIP map does not list for this ZIP. The panel does not
   *  hold that seat's member, so it says so and links to /reps, which does. */
  | { kind: 'outside'; district: District };

export function answerFor(seats: readonly HouseSeat[], d: District): FinderAnswer {
  const seat = seats.find((s) => s.state === d.state && s.district === d.district);
  return seat ? { kind: 'seat', seat } : { kind: 'outside', district: { state: d.state, district: d.district } };
}

/**
 * A member's position on the roll call, from the roll call's own lists. Null
 * means the roll call lists them nowhere: "No recorded vote", never a guess.
 */
export function positionOf(
  positions: Readonly<Record<string, VotePosition>> | null,
  bioguide: string
): VotePosition | null {
  return positions && Object.hasOwn(positions, bioguide) ? positions[bioguide] : null;
}

/** Why the finder is showing every seat instead of one. */
export type FallbackReason = 'chosen' | 'unavailable' | 'rateLimited';
