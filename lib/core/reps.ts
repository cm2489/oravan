/*
 * Representative/district data access — pure functions over the baked JSON
 * corpus. Extracted from lib/data.ts (S9); see lib/core/index.ts for why.
 */
import legislators from '@/data/legislators.json';
import zipDistricts from '@/data/zip-districts.json';
import type { District, Legislator } from '../types';

const LEGISLATORS = legislators as Legislator[];
const ZIPS = zipDistricts as Record<string, District[]>;

export function districtsForZip(zip: string): District[] {
  return ZIPS[zip] ?? [];
}

export function repsForDistrict(d: District): Legislator[] {
  const senators = LEGISLATORS.filter((l) => l.type === 'sen' && l.state === d.state);
  const rep = LEGISLATORS.filter((l) => l.type === 'rep' && l.state === d.state && (l.district ?? 0) === d.district);
  return [...rep, ...senators];
}

export function getLegislator(bioguide: string): Legislator | undefined {
  return LEGISLATORS.find((l) => l.bioguide === bioguide);
}

export function portraitUrl(bioguide: string): string {
  return `https://unitedstates.github.io/images/congress/450x550/${bioguide}.jpg`;
}
