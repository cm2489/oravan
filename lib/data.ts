import 'server-only';
import bills from '@/data/bills.json';
import legislators from '@/data/legislators.json';
import zipDistricts from '@/data/zip-districts.json';
import type { Bill, BillTeaser, District, Legislator } from './types';

const BILLS = bills as Bill[];
const LEGISLATORS = legislators as Legislator[];
const ZIPS = zipDistricts as Record<string, District[]>;

export function billSlug(b: Pick<Bill, 'bill_type' | 'bill_number' | 'congress_number'>): string {
  return `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
}

export function getBill(slug: string): Bill | undefined {
  return BILLS.find((b) => billSlug(b) === slug);
}

export function getAllBills(): Bill[] {
  return BILLS;
}

export function getTeasers(): BillTeaser[] {
  return [...BILLS]
    .sort((a, b) => b.urgency_score - a.urgency_score || (b.last_action_date ?? '').localeCompare(a.last_action_date ?? ''))
    .map((b) => ({
      slug: billSlug(b),
      identifier: b.full_identifier,
      headline: b.ai_headline,
      title: b.short_title ?? b.title,
      status: b.status,
      tags: b.issue_tags ?? [],
      urgency: b.urgency_score,
      lastActionDate: b.last_action_date,
    }));
}

/** Top N most urgent bills that have a decoded summary - the "this week" shortlist. */
export function getTopActions(n = 5): Bill[] {
  return [...BILLS]
    .filter((b) => b.ai_headline && b.status !== 'signed')
    .sort((a, b) => b.urgency_score - a.urgency_score || (b.last_action_date ?? '').localeCompare(a.last_action_date ?? ''))
    .slice(0, n);
}

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
