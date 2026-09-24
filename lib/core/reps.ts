/*
 * Representative/district data access — pure functions over the baked JSON
 * corpus. Extracted from lib/data.ts (S9); see lib/core/index.ts for why.
 */
import legislators from '@/data/legislators.json';
import zipDistricts from '@/data/zip-districts.json';
import vacancies from '@/data/vacancies.json';
import type { District, Legislator, Vacancy } from '../types';

const LEGISLATORS = legislators as Legislator[];
const ZIPS = zipDistricts as Record<string, District[]>;
const VACANCIES = vacancies as Vacancy[];

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

export function portraitUrl(bioguide: string): string {
  return `https://unitedstates.github.io/images/congress/450x550/${bioguide}.jpg`;
}

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

/** The state's senators, for a seat page that has no House member to show. */
export function senatorsForState(state: string): Legislator[] {
  return LEGISLATORS.filter((l) => l.type === 'sen' && l.state === state);
}
