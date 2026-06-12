/** The 12 CRS-anchored issue categories. Labels live in messages/{locale}.json under "categories". */
export const CATEGORIES = [
  'jobs_economy',
  'health',
  'national_security',
  'environment_energy',
  'government_democracy',
  'crime_justice',
  'family_community',
  'education',
  'immigration',
  'ai_technology',
  'housing',
  'rights_liberties',
] as const;

export type Category = (typeof CATEGORIES)[number];

export type UrgencyBand = 'now' | 'moving' | 'radar';

export function urgencyBand(score: number): UrgencyBand {
  if (score >= 0.75) return 'now';
  if (score >= 0.5) return 'moving';
  return 'radar';
}
