import 'server-only';
import bills from '@/data/bills.json';
import billsEs from '@/data/bills-es.json';
import legislators from '@/data/legislators.json';
import zipDistricts from '@/data/zip-districts.json';
import { formatCitation } from './format';
import { bandFloors, bandForEff } from './taxonomy';
import { coverageTier, getCoverage, normalizeSource, rankNews } from './coverage';
import type { Bill, District, FeedTeaser, Legislator, NewsBill } from './types';

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

/*
 * Enacted or rejected bills are past the call window: a signed law can't be
 * un-signed by a phone call, and a vetoed bill is settled. They must never
 * rank into now/moving no matter how fresh they look. (A veto can in theory
 * face an override vote, but the status model has no such state, so vetoed
 * reads as terminal here.)
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['signed', 'vetoed']);

export function getTeasers(locale = 'en'): FeedTeaser[] {
  const scored = BILLS.map((raw) => ({
    raw,
    eff: effectiveUrgency(raw.status, raw.last_action_date),
    terminal: TERMINAL_STATUSES.has(raw.status),
  }));
  const byUrgency = (a: (typeof scored)[number], b: (typeof scored)[number]) =>
    b.eff - a.eff || (b.raw.last_action_date ?? '').localeCompare(a.raw.last_action_date ?? '');

  // Active bills claim the now/moving bands by rank; terminal bills are
  // appended and pinned to radar, so they can never displace an actionable
  // bill. Floors come from the active bills alone, so a settled law can't
  // even raise the bar.
  const activeBills = scored.filter((s) => !s.terminal).sort(byUrgency);
  const settledBills = scored.filter((s) => s.terminal).sort(byUrgency);
  const floors = bandFloors(activeBills.map((s) => s.eff));

  return [...activeBills, ...settledBills].map(({ raw, eff, terminal }) => {
    const b = localizeBill(raw, locale);
    return {
      slug: billSlug(b),
      identifier: formatCitation(b.bill_type, b.bill_number),
      headline: b.ai_headline,
      title: b.short_title ?? b.title,
      status: b.status,
      tags: b.issue_tags ?? [],
      band: terminal ? 'radar' : bandForEff(eff, floors),
      lastActionDate: b.last_action_date,
    };
  });
}

/** Top N most urgent bills that have a decoded summary - the "this week" shortlist. */
export function getTopActions(n = 5, locale = 'en'): Bill[] {
  return BILLS
    .filter((b) => b.ai_headline && !TERMINAL_STATUSES.has(b.status))
    .map((b) => ({ b, eff: effectiveUrgency(b.status, b.last_action_date) }))
    .sort((x, y) => y.eff - x.eff || (y.b.last_action_date ?? '').localeCompare(x.b.last_action_date ?? ''))
    .slice(0, n)
    .map(({ b }) => localizeBill(b, locale));
}

/*
 * The "In the news" discovery lens — feeds rankNews real bills with their
 * coverage tier, outlet count, and urgency. The ranking/exclusion policy
 * (cross > neutral, one-sided dropped) lives in lib/coverage so it stays
 * unit-testable; consequence, not partisan attention, decides prominence.
 */
export function getNewsBills(locale = 'en', n = 6): NewsBill[] {
  const items = BILLS.map((raw) => {
    const articles = getCoverage(billSlug(raw));
    return {
      raw,
      tier: coverageTier(articles),
      sources: new Set(articles.map((a) => normalizeSource(a.source))).size,
      urgency: effectiveUrgency(raw.status, raw.last_action_date),
    };
  });
  return rankNews(items, n).map(({ raw, tier, sources }) => {
    const b = localizeBill(raw, locale);
    return {
      slug: billSlug(b),
      identifier: formatCitation(b.bill_type, b.bill_number),
      headline: b.ai_headline,
      title: b.short_title ?? b.title,
      status: b.status,
      tags: b.issue_tags ?? [],
      lastActionDate: b.last_action_date,
      coverageTier: tier as 'cross' | 'neutral',
      sourceCount: sources,
    };
  });
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
