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
 * from seat sets alone (docs/ideation/2026-07-05-build-gtm-strategy.md
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
