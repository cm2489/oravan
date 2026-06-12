import 'server-only';
import bills from '@/data/bills.json';
import billsEs from '@/data/bills-es.json';
import legislators from '@/data/legislators.json';
import zipDistricts from '@/data/zip-districts.json';
import { formatCitation } from './format';
import type { Bill, BillTeaser, District, Legislator } from './types';

const BILLS = bills as Bill[];
const ES = billsEs as Record<
  string,
  { headline: string | null; summary: string; sections?: import('./types').DecodedSections }
>;
const LEGISLATORS = legislators as Legislator[];
const ZIPS = zipDistricts as Record<string, District[]>;

/** Overlay the Spanish decoded content when it exists; English is the fallback. */
export function localizeBill(b: Bill, locale: string): Bill {
  if (locale !== 'es') return b;
  const tr = ES[billSlug(b)];
  if (!tr) return b;
  return {
    ...b,
    ai_headline: tr.headline ?? b.ai_headline,
    ai_summary: tr.summary,
    ai_sections: tr.sections ?? b.ai_sections,
  };
}

export function billSlug(b: Pick<Bill, 'bill_type' | 'bill_number' | 'congress_number'>): string {
  return `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
}

/*
 * Read-time urgency. Stored scores freeze the freshness bonus at sync time,
 * so a bill calendared six weeks ago keeps outranking everything (the
 * stale-CFPB-on-top bug). Recompute from status + last action date with a
 * staleness decay: no penalty for two weeks, then a linear slide that drops
 * a stale floor placement below an active committee fight.
 */
const STATUS_BASE: Record<string, number> = {
  floor_vote: 0.9,
  passed_chamber: 0.75,
  conference: 0.75,
  markup: 0.65,
  committee: 0.45,
  signed: 0.3,
  vetoed: 0.3,
  introduced: 0.2,
};

export function effectiveUrgency(status: string, lastActionDate: string | null): number {
  const base = STATUS_BASE[status] ?? 0.2;
  if (!lastActionDate) return base;
  const days = (Date.now() - new Date(lastActionDate).getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return base;
  const bonus = days < 3 ? 0.1 : days < 7 ? 0.05 : 0;
  const decay = days <= 14 ? 0 : Math.min(0.45, (days - 14) * 0.015);
  return Math.round(Math.max(0.05, Math.min(1, base + bonus - decay)) * 1000) / 1000;
}

export function getBill(slug: string): Bill | undefined {
  return BILLS.find((b) => billSlug(b) === slug);
}

export function getAllBills(): Bill[] {
  return BILLS;
}

export function getTeasers(locale = 'en'): BillTeaser[] {
  return BILLS
    .map((raw) => ({ raw, eff: effectiveUrgency(raw.status, raw.last_action_date) }))
    .sort((a, b) => b.eff - a.eff || (b.raw.last_action_date ?? '').localeCompare(a.raw.last_action_date ?? ''))
    .map(({ raw, eff }) => {
      const b = localizeBill(raw, locale);
      return {
        slug: billSlug(b),
        identifier: formatCitation(b.bill_type, b.bill_number),
        headline: b.ai_headline,
        title: b.short_title ?? b.title,
        status: b.status,
        tags: b.issue_tags ?? [],
        urgency: eff,
        lastActionDate: b.last_action_date,
      };
    });
}

/** Top N most urgent bills that have a decoded summary - the "this week" shortlist. */
export function getTopActions(n = 5, locale = 'en'): Bill[] {
  return BILLS
    .filter((b) => b.ai_headline && b.status !== 'signed')
    .map((b) => ({ b, eff: effectiveUrgency(b.status, b.last_action_date) }))
    .sort((x, y) => y.eff - x.eff || (y.b.last_action_date ?? '').localeCompare(x.b.last_action_date ?? ''))
    .slice(0, n)
    .map(({ b }) => localizeBill(b, locale));
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
