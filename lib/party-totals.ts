import type { RollCallTotals, VotePosition } from './types';

/*
 * A ROLL CALL'S COUNT BY PARTY, IN PRINT ORDER — what components/PartyTotals.tsx
 * prints as one line of text under a tally. The owner's card l12, 2026-09-29,
 * about PR #363 (which lets a party count on a recorded vote through the
 * Big Questions lint): "Show me these. I don't see them."
 *
 * THE COUNTS are the record's own (data/votes.json `totalsByParty`: the Clerk's
 * party table for the House, each senator's own party letter counted for the
 * Senate; lib/votes-core.mjs). Nothing here adds, rounds or characterizes a
 * number, and a party the record lists at zero is not a group.
 *
 * THE ORDER RULE: the party with the most members on THIS roll call first
 * (every member the record lists for it, in all four positions), then the
 * next largest; a tie goes to the record's letter in alphabetical order. Why
 * this and not a fixed order:
 *   - a fixed order puts the same party first on every vote, forever, and
 *     "which party is named first" is exactly the kind of thing a reader can
 *     fairly read as a tilt;
 *   - alphabetical is a fixed order too (Democrats would always lead);
 *   - size is a fact of the record, the same rule for every party, and it
 *     follows the chamber: whichever party holds more seats on the day of the
 *     vote leads that vote's line, so a change of majority changes the order
 *     with no code change. It is also the order the Clerk's own party table
 *     uses (majority first).
 * Stated plainly, because it is the obvious objection: in the 119th Congress
 * the Republicans are the larger group on every stored roll call in both
 * chambers (measured 2026-09-29: 314 of 314 House, 280 of 280 Senate), so
 * today this rule prints them first everywhere. It is a rule about size that
 * happens to land on one party this Congress, not a rule about that party.
 * The rule reads counts only, never which party a letter is.
 */

/** One party's group on one roll call. */
export interface PartyGroup {
  /** The record's own party letter: "D", "R", "I", or any other it writes. */
  party: string;
  /** Every member of this party the roll call lists, in all four positions. */
  size: number;
  counts: RollCallTotals;
}

const POSITIONS: VotePosition[] = ['yea', 'nay', 'present', 'notVoting'];

/** The groups to print, largest first (see THE ORDER RULE above). Empty when
 *  the roll call carries no count by party. */
export function partyGroups(totalsByParty: Record<string, RollCallTotals> | null | undefined): PartyGroup[] {
  if (!totalsByParty) return [];
  return Object.entries(totalsByParty)
    .map(([party, counts]) => ({ party, counts, size: POSITIONS.reduce((n, p) => n + (counts[p] ?? 0), 0) }))
    .filter((g) => g.size > 0)
    .sort((a, b) => b.size - a.size || (a.party < b.party ? -1 : a.party > b.party ? 1 : 0));
}

/** The positions a group's text names: those it has at least one member in,
 *  in the record's own order (Yea, Nay, Present, Not voting). */
export function positionsToPrint(g: PartyGroup): VotePosition[] {
  return POSITIONS.filter((p) => (g.counts[p] ?? 0) > 0);
}

/** The group names the messages carry (`partyTotals.D` / `.R` / `.I`). Any
 *  other letter the record writes prints as the record writes it. */
export const NAMED_PARTIES = ['D', 'R', 'I'] as const;
export type NamedParty = (typeof NAMED_PARTIES)[number];
const isNamed = (p: string): p is NamedParty => (NAMED_PARTIES as readonly string[]).includes(p);

/** The `partyTotals` translator the line needs: next-intl's `t` for that
 *  namespace, or `createTranslator` in a test. */
export type PartyTotalsT = (key: NamedParty | VotePosition | 'group', values: Record<string, string | number>) => string;

/**
 * The whole line, e.g. "Republicans 4 yes, 47 no, 2 not voting · Democrats
 * 44 yes, 1 no · Independents 2 yes". One template for every group: the name
 * and the numbers are the only things that change from party to party.
 * Empty string when there is nothing to print.
 */
export function partyTotalsLine(totalsByParty: Record<string, RollCallTotals> | null | undefined, t: PartyTotalsT): string {
  return partyGroups(totalsByParty)
    .map((g) =>
      t('group', {
        party: isNamed(g.party) ? t(g.party, { count: g.size }) : g.party,
        counts: positionsToPrint(g)
          .map((p) => t(p, { count: g.counts[p] }))
          .join(', '),
      })
    )
    .join(' · ');
}
