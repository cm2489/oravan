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
 *   data/departed-members.json (scripts/member_turnover.py). A page is built
 *   when the record's `served_until` is the last day of the Congress that
 *   just ended (the approved line above), or a day inside the term of the
 *   tracked Congress or an ended one.
 *
 *   MEMBERS WHO LEFT MID-TERM (owner, 2026-11-13, on the page that showed
 *   him the stage 5 pictures). They get the same record page with their real
 *   last day: "Served in the House until April 21, 2026." The 16 who left
 *   the 119th Congress before the file existed were recorded by
 *   scripts/seed-departed-members.py, through the weekly refresh's own code.
 *   Their last day is the OFFICIAL one, never the volunteer historical
 *   file's alone (it was a day off for five of the sixteen): the Clerk of
 *   the House's vacancy list or the Biographical Directory, recorded with
 *   the address and the day read (`served_until_source`, from
 *   data/departure-dates.json). A mid-term record with no official source,
 *   which is how the weekly refresh records a NEW departure, gets no page
 *   (the not-found page, as before) until a pull request confirms the date.
 *   The page prints the sentence only, with no reason added (hard rule 6).
 *
 *   A new member with no recorded vote. "No recorded votes yet on a bill
 *   Oravan tracks." (the owner's choice of 2026-11-13; NEW_MEMBER_LINE_KEY
 *   below) stands where the vote record would be, instead of the line a
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
import type { DepartedMember, DepartureDateSource, Legislator } from './types';

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

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The two official places a mid-term last day may come from
 *  (scripts/member_turnover.py SOURCE_KINDS keeps the same pair). */
export const OFFICIAL_SOURCES: Record<DepartureDateSource['kind'], string> = {
  'house-clerk': 'https://clerk.house.gov/Members/ViewVacancies',
  bioguide: 'https://bioguide.congress.gov/search/bio/',
};

/** Is this record's last day confirmed by an official source? (Hard rule 6:
 *  the volunteer historical file was a day off for five of sixteen.) */
export function hasOfficialDate(r: Pick<DepartedMember, 'served_until_source'>): boolean {
  const src = r.served_until_source;
  if (!src || typeof src !== 'object') return false;
  const prefix = OFFICIAL_SOURCES[src.kind];
  return typeof prefix === 'string' && typeof src.url === 'string' && src.url.startsWith(prefix) && DAY_RE.test(src.read ?? '');
}

/** Did this member leave during the term of the tracked Congress or an ended
 *  one (after its first day, before its last)? The last day itself belongs
 *  to the switch, which has its own line and waits for the ended list. */
function leftMidTerm(servedUntil: string, policy: CongressPolicy): boolean {
  return [policy.tracked, ...policy.ended.map((e) => e.number)].some((n) => {
    const term = congressTerm(n);
    return term.start < servedUntil && servedUntil < term.end;
  });
}

/**
 * The departed records that get a page, and are not back in the member file
 * (the member file wins for anyone sitting): a member whose last day is the
 * last day of the Congress that just ended (after the switch only), or one
 * who left mid-term in the tracked Congress or an ended one (any day).
 */
export function departedWithPage(
  records: readonly DepartedMember[],
  current: ReadonlySet<string>,
  policy: CongressPolicy,
): DepartedMember[] {
  const turnover = memberTurnover(policy);
  return records.filter(
    (r) =>
      typeof r.served_until === 'string' &&
      DAY_RE.test(r.served_until) &&
      !current.has(r.bioguide) &&
      (r.type === 'rep' || r.type === 'sen') &&
      ((turnover !== null && r.served_until === turnover.ended.ended) ||
        (leftMidTerm(r.served_until, policy) && hasOfficialDate(r))),
  );
}

/** Which served-until line a record page prints: the approved switch-day
 *  line, or the dated one with the record's own last day. */
export function servedLine(
  r: Pick<DepartedMember, 'served_until'>,
  turnover: MemberTurnover | null,
): { key: 'departedServed' } | { key: 'departedServedOn'; date: string } {
  return turnover !== null && r.served_until === turnover.ended.ended
    ? { key: 'departedServed' }
    : { key: 'departedServedOn', date: r.served_until as string };
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
    served_until_source: null,
    left_file: review.policy.ended[0].ended,
  };
}
