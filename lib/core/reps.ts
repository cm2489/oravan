/*
 * Representative/district data access — pure functions over the baked JSON
 * corpus. Extracted from lib/data.ts (S9); see lib/core/index.ts for why.
 */
import legislators from '@/data/legislators.json';
import departedMembers from '@/data/departed-members.json';
import zipDistricts from '@/data/zip-districts.json';
import vacancies from '@/data/vacancies.json';
import specialElections from '@/data/special-elections.json';
import { CONGRESS_POLICY } from '../congress.mjs';
import {
  departedWithPage,
  memberTurnover as turnoverFor,
  newCongressReview,
  reviewDepartedRecord,
  type MemberTurnover,
} from '../departed-members';
import type { DepartedMember, District, Legislator, SeatElections, Vacancy } from '../types';

const ROSTER = legislators as Legislator[];
/*
 * The local review setting (lib/departed-members.ts, REVIEW_ENV): null on
 * every deploy and CI build, where it throws if set. While it is null the
 * roster below is the member file's own array, untouched, and the departed
 * list is data/departed-members.json.
 */
const REVIEW = newCongressReview(process.env, CONGRESS_POLICY.tracked);
const LEGISLATORS = REVIEW ? ROSTER.filter((l) => !REVIEW.departed.has(l.bioguide)) : ROSTER;
const TURNOVER = turnoverFor(REVIEW ? REVIEW.policy : CONGRESS_POLICY);
const DEPARTED_WITH_PAGE = departedWithPage(
  [
    ...(departedMembers as DepartedMember[]),
    ...(REVIEW
      ? ROSTER.filter((l) => REVIEW.departed.has(l.bioguide)).map((l) => reviewDepartedRecord(l, REVIEW))
      : []),
  ],
  new Set(LEGISLATORS.map((l) => l.bioguide)),
  REVIEW ? REVIEW.policy : CONGRESS_POLICY,
);
const ZIPS = zipDistricts as Record<string, District[]>;
const VACANCIES = vacancies as Vacancy[];
const SPECIAL_ELECTIONS = specialElections as Record<string, SeatElections>;

export function districtsForZip(zip: string): District[] {
  return ZIPS[zip] ?? [];
}

export function repsForDistrict(d: District): Legislator[] {
  const senators = LEGISLATORS.filter((l) => l.type === 'sen' && l.state === d.state);
  const rep = LEGISLATORS.filter((l) => l.type === 'rep' && l.state === d.state && (l.district ?? 0) === d.district);
  return [...rep, ...senators];
}

/**
 * The seat's vacancy record, or undefined when it currently has a
 * representative. data/vacancies.json is derived by scripts/vacancy_diff.py
 * from seat sets alone (the project records (kept out of this repo)
 * §9.1(f)) - repsForDistrict above never needs to change: an empty `rep`
 * filter result already reflects a vacant seat correctly, this just names
 * it explicitly so every surface can say so instead of quietly showing
 * fewer cards than expected.
 */
export function vacancyForDistrict(d: District): Vacancy | undefined {
  return VACANCIES.find((v) => v.state === d.state && v.district === d.district);
}

export function getLegislator(bioguide: string): Legislator | undefined {
  return LEGISLATORS.find((l) => l.bioguide === bioguide);
}

export { portraitUrl } from '../portrait-url';

/** Every sitting member in the baked roster (senators, representatives, delegates). */
export function getAllLegislators(): Legislator[] {
  return LEGISLATORS;
}

/** Every currently vacant House seat. */
export function getVacancies(): Vacancy[] {
  return VACANCIES;
}

/*
 * A vacant seat has no bioguide to key a page on, and data/vacancies.json is
 * built so it CANNOT carry the departed member's (see the Vacancy type). So a
 * vacant seat's page is keyed on the seat itself - "fl-20" - under the same
 * /reps/[bioguide] segment. The two id shapes cannot collide: a bioguide is
 * one capital letter and six digits (BIOGUIDE_RE), a seat slug is two
 * lower-case letters, a hyphen and a number.
 */
export function vacancySlug(v: Pick<Vacancy, 'state' | 'district'>): string {
  return `${v.state}-${v.district}`.toLowerCase();
}

export function getVacancyBySlug(slug: string): Vacancy | undefined {
  return VACANCIES.find((v) => vacancySlug(v) === slug);
}

/**
 * The seat's special-election dates from the FEC, with the day they were
 * checked, or undefined when the weekly sync has not recorded the seat yet
 * (then a page says nothing about an election rather than something unchecked).
 */
export function specialElectionsFor(v: Pick<Vacancy, 'state' | 'district'>): SeatElections | undefined {
  return SPECIAL_ELECTIONS[vacancySlug(v)];
}

/** The state's senators, for a seat page that has no House member to show. */
export function senatorsForState(state: string): Legislator[] {
  return LEGISLATORS.filter((l) => l.type === 'sen' && l.state === state);
}

/*
 * MEMBERS WHO LEFT (stage 5 of the new-Congress work; lib/departed-members.ts
 * has the rules). Never part of a lookup, a seat or "your members": only the
 * page at /reps/<bioguide> reads these. Empty until the switch.
 */

/** The Congress that just ended and the tracked one, or null before the switch. */
export function memberTurnover(): MemberTurnover | null {
  return TURNOVER;
}

/** Every member who left and keeps a record page. */
export function getDepartedMembers(): DepartedMember[] {
  return DEPARTED_WITH_PAGE;
}

/** A member who left and keeps a record page, or undefined. */
export function getDepartedMember(bioguide: string): DepartedMember | undefined {
  return DEPARTED_WITH_PAGE.find((d) => d.bioguide === bioguide);
}

/** Does /reps/<bioguide> resolve: a sitting member, or one who left and
 *  keeps a record page? (Roll-call lists and sponsor lines link only then.) */
export function hasMemberPage(bioguide: string): boolean {
  return Boolean(getLegislator(bioguide) ?? getDepartedMember(bioguide));
}

/** The local review build treats this sitting member as new. Always false
 *  outside it. */
export function reviewTreatsAsNew(bioguide: string): boolean {
  return REVIEW?.newMembers.has(bioguide) ?? false;
}
