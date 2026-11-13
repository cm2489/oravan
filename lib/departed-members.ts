/*
 * MEMBERS AFTER A NEW CONGRESS BEGINS (stage 5 of the new-Congress work,
 * 2026-11-13). Pure functions, every input passed in, so
 * tests/departed-members.unit.spec.ts drives them with fixtures and no data
 * file. lib/core/reps.ts feeds them the real files.
 *
 * TWO PAGES CHANGE ON THE SWITCH, AND ONLY THEN.
 *
 *   A member who left. Their page stays at /reps/<bioguide> as a record:
 *   the seat they held, "Served in the {chamber} until January 3, 2027."
 *   (owner, 2026-11-12, the wording as approved) and how they voted. No
 *   phone number, no office, no website, no call: nothing on it may read as
 *   a live way to reach them (hard rule 6). The record comes from
 *   data/departed-members.json (scripts/member_turnover.py), which is empty
 *   today. A page is built only when the record's `served_until` is the last
 *   day of the Congress that just ended, because that is the one date the
 *   approved line states. A member who left mid-term keeps a record in the
 *   file and still has no page (no wording for them is approved).
 *
 *   A new member with no recorded vote. "No recorded votes yet in the 120th
 *   Congress." stands where the vote record would be, instead of the line a
 *   member with no stored roll call gets today. Never for a delegate or the
 *   resident commissioner: they do not cast the floor votes the record
 *   stores, so "yet" would promise something that is not coming; they keep
 *   today's line.
 *
 * WHEN IS "THE SWITCH"? When lib/congress.mjs's ended list holds the
 * Congress right before the tracked one (stage 8 fills it). While that list
 * is empty, memberTurnover() is null and both pages are exactly what they
 * are on main.
 */
import { congressTerm, type CongressPolicy, type EndedCongress } from './congress.mjs';
import type { DepartedMember, Legislator } from './types';

/** The Congress that just ended and the one now tracked, or null when the
 *  tracked Congress has no ended predecessor on the list (every day before
 *  the switch). */
export interface MemberTurnover {
  ended: EndedCongress;
  tracked: number;
}

export function memberTurnover(policy: CongressPolicy): MemberTurnover | null {
  const ended = policy.ended.find((e) => e.number === policy.tracked - 1);
  return ended ? { ended, tracked: policy.tracked } : null;
}

/**
 * The departed records that get a page: their `served_until` is the last day
 * of the Congress that just ended, and they are not back in the member file
 * (the member file wins for anyone sitting). Empty before the switch.
 */
export function departedWithPage(
  records: readonly DepartedMember[],
  current: ReadonlySet<string>,
  turnover: MemberTurnover | null,
): DepartedMember[] {
  if (!turnover) return [];
  return records.filter(
    (r) =>
      r.served_until === turnover.ended.ended &&
      !current.has(r.bioguide) &&
      (r.type === 'rep' || r.type === 'sen'),
  );
}

/**
 * WHICH NEW-MEMBER LINE THE PAGE PRINTS. The owner approved
 * "No recorded votes yet in the 120th Congress." on 2026-11-12. A review on
 * 2026-11-13 found it goes false within days of Jan 3: new members cast roll
 * calls at once (the Speaker's election, bills Oravan does not track), and
 * data/votes.json stores only roll calls on a tracked bill. Asked that day,
 * the owner chose "No recorded votes yet on a bill Oravan tracks."
 * (2026-11-13, 11:19 AM ET), so this value is 'votesNoneYetTracked'. Both
 * strings exist in both languages; the first is kept for the record.
 */
export const NEW_MEMBER_LINE_KEY: 'votesNoneYet' | 'votesNoneYetTracked' = 'votesNoneYetTracked';

/** Which chamber the served-until line names. */
export const servedChamber = (r: Pick<DepartedMember, 'type'>): 'house' | 'senate' =>
  r.type === 'sen' ? 'senate' : 'house';

/** Does the new-member line replace the vote record on this member's page? */
export function showsNoVotesYet({
  turnover,
  voteBills,
  delegate,
  reviewNew = false,
}: {
  turnover: MemberTurnover | null;
  /** How many bills the stored record lists this member voting on. */
  voteBills: number;
  /** A delegate or resident commissioner (components/RepCard.tsx repRoleKey). */
  delegate: boolean;
  /** The local review build treats this member as new (lib/core/reps.ts). */
  reviewNew?: boolean;
}): boolean {
  if (!turnover || delegate) return false;
  return voteBills === 0 || reviewNew;
}

/*
 * THE REVIEW SETTING. A local build for the owner's pictures, never a
 * production one: ORAVAN_REVIEW_NEW_CONGRESS names a few real current members
 * to treat as departed (removed from every lookup, given a record page) and
 * a few to treat as new (their vote record replaced by the new-member line),
 * and pretends the tracked Congress has just ended for the member pages
 * only. The names come from the person running the build, never from this
 * code, so nothing committed here says who leaves:
 *
 *   ORAVAN_REVIEW_NEW_CONGRESS='departed=A000001,B000002;new=C000003'
 *
 * Refused (it throws, so the build fails) whenever the environment looks
 * like a deploy or CI: VERCEL, VERCEL_ENV, CI or GITHUB_ACTIONS set. No
 * workflow and no Vercel setting names the variable;
 * tests/departed-members.unit.spec.ts fails if one ever does.
 */
export const REVIEW_ENV = 'ORAVAN_REVIEW_NEW_CONGRESS';

export interface NewCongressReview {
  departed: ReadonlySet<string>;
  newMembers: ReadonlySet<string>;
  policy: CongressPolicy;
}

const BIOGUIDE_RE = /^[A-Z]\d{6}$/;

export function newCongressReview(
  env: Record<string, string | undefined>,
  tracked: number,
): NewCongressReview | null {
  const raw = env[REVIEW_ENV];
  if (raw === undefined || raw === '') return null;
  const deployLike = ['VERCEL', 'VERCEL_ENV', 'CI', 'GITHUB_ACTIONS'].filter((k) => env[k]);
  if (deployLike.length > 0) {
    throw new Error(`${REVIEW_ENV} is for a local review build only; refusing with ${deployLike.join(', ')} set`);
  }
  const lists: Record<string, string[]> = { departed: [], new: [] };
  for (const part of raw.split(';').filter(Boolean)) {
    const [key, ids = ''] = part.split('=');
    if (!(key in lists)) throw new Error(`${REVIEW_ENV}: unknown list "${key}" (expected departed= and new=)`);
    lists[key] = ids.split(',').filter(Boolean);
    for (const id of lists[key]) if (!BIOGUIDE_RE.test(id)) throw new Error(`${REVIEW_ENV}: "${id}" is not a bioguide id`);
  }
  return {
    departed: new Set(lists.departed),
    newMembers: new Set(lists.new),
    // The tracked Congress just ended, the next one is tracked: the member
    // pages' view of the day after the switch. Bills and every other page
    // keep reading lib/congress.mjs as it is.
    policy: { tracked: tracked + 1, ended: [{ number: tracked, ended: congressTerm(tracked).end }] },
  };
}

/** The departed record the review gives a current member: their seat from
 *  the member file, the ended Congress's last day, and no contact field. */
export function reviewDepartedRecord(l: Legislator, review: NewCongressReview): DepartedMember {
  return {
    bioguide: l.bioguide,
    name: l.name,
    first: l.first,
    last: l.last,
    type: l.type,
    state: l.state,
    district: l.district,
    party: l.party,
    served_until: review.policy.ended[0].ended,
    left_file: review.policy.ended[0].ended,
  };
}
