import type { District, Legislator, VotePosition } from './types';

/*
 * THE SPLIT-ZIP HOUSE FINDER, VERSION A — the rows the record-only panel
 * (components/SettledPanel.tsx) prints when a saved ZIP spans more than one
 * House district and the reader asks to see the House vote anyway.
 *
 * Owner, 2026-09-29, reviewing the settled box on /bills/hconres-89-119 with a
 * split ZIP: "Great edge case on the house district/zip situation here. This
 * would be a use of a subtle yellow button (I know color comes later) but
 * there should be a way for them to find those votes in this box here. Can
 * you build that for me? Mock up two versions of how this could look."
 *
 * Version A asks nothing more of the reader. Every House district that
 * touches the ZIP (data/zip-districts.json, as /api/reps already answers it)
 * becomes one row: the district, the member who holds it today, and that
 * member's position on the House roll call the group is about. One of those
 * rows is the reader's; the panel says so and does not guess which.
 *
 * RECORD TRUTH. A position comes only from the roll call's own lists
 * (data/votes.json, carried in by lib/settled-votes.ts). A member the roll
 * call does not list gets `null`, which the panel prints as "No recorded
 * vote" — never inferred, never borrowed from another roll call. A vacant
 * seat is a row of its own with no member and no position.
 *
 * Types only: no roster JSON is imported, so this module stays out of the
 * client bundle's weight (the VacantSeatCard note: the roster never rides
 * into a client component).
 */

/** Only what a finder row prints about a member — never phones, offices or party. */
export type FinderMember = Pick<Legislator, 'bioguide' | 'name' | 'state' | 'type' | 'district'>;

export interface FinderRow {
  state: string;
  /** 0 for an at-large seat. */
  district: number;
  /** The member who holds the seat today; null when the seat is vacant. */
  member: Pick<Legislator, 'bioguide' | 'name' | 'state'> | null;
  /** Their position on this roll call; null when the roll call lists none
   *  for them (or the seat is vacant). */
  position: VotePosition | null;
}

/** The seat's own page slug, as lib/core/reps.ts `vacancySlug` builds it
 *  ("fl-20"), restated here so this module never imports the roster. */
export function seatSlug(d: District): string {
  return `${d.state}-${d.district}`.toLowerCase();
}

/**
 * One row per House district in the ZIP, ordered by state and then district
 * number, so the list reads the same way every time.
 *
 * @param members the ZIP lookup's members (senators are ignored).
 * @param vacantSeats the ZIP lookup's vacant House seats.
 * @param positions bioguide → position for the House roll call.
 */
export function houseFinderRows(
  members: readonly FinderMember[],
  vacantSeats: readonly District[],
  positions: Readonly<Record<string, VotePosition>>
): FinderRow[] {
  const rows: FinderRow[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    if (m.type !== 'rep') continue;
    const district = m.district ?? 0;
    const key = `${m.state}-${district}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      state: m.state,
      district,
      member: { bioguide: m.bioguide, name: m.name, state: m.state },
      position: positions[m.bioguide] ?? null,
    });
  }
  for (const v of vacantSeats) {
    const key = `${v.state}-${v.district}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ state: v.state, district: v.district, member: null, position: null });
  }
  return rows.sort((a, b) => a.state.localeCompare(b.state) || a.district - b.district);
}
