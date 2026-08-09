/*
 * Bill data access — pure functions over the baked JSON corpus. Extracted
 * from lib/data.ts (S9): deliberately NOT 'server-only', unlike the module
 * it replaces. That coupling only ever suited page/RSC callers; a route
 * handler (app/api/mcp) is a legitimate server-side caller too, and future
 * agent surfaces need the same functions without a framework-specific guard
 * in the way. Nothing here changes shape or behavior — see lib/core/index.ts.
 */
import bills from '@/data/bills.json';
import { statusKeyFor } from '../journey';
import billsEs from '@/data/bills-es.json';
import { formatCitation } from '../format';
import { bandFloors, bandForEff } from '../taxonomy';
import { coverageTier, getCoverage, normalizeSource, rankNews } from '../coverage';
import { TERMINAL_STATUSES, effectiveUrgency } from '../urgency.mjs';
import type { Bill, FeedTeaser, NewsBill } from '../types';

export { effectiveUrgency };

const BILLS = bills as Bill[];
const ES = billsEs as Record<
  string,
  { headline: string | null; summary: string; sections?: import('../types').DecodedSections }
>;

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

export function getBill(slug: string): Bill | undefined {
  return BILLS.find((b) => billSlug(b) === slug);
}

export function getAllBills(): Bill[] {
  return BILLS;
}

const byUrgencyDesc = <T extends { eff: number; raw: Pick<Bill, 'last_action_date'> }>(a: T, b: T) =>
  b.eff - a.eff || (b.raw.last_action_date ?? '').localeCompare(a.raw.last_action_date ?? '');

/*
 * The one place the corpus gets scored and split into active/settled with
 * band floors applied (KTD-2) - getTeasers and getTopActions both read this
 * so "Act now" means the same thing everywhere on the site. A third
 * independent copy of this scoring is the exact drift
 * docs/solutions/stale-urgency-freeze.md closed for the urgency curve
 * itself; this keeps the band-floor logic from re-acquiring that problem.
 */
function scoreActiveBills() {
  const scored = BILLS.map((raw) => ({
    raw,
    eff: effectiveUrgency(raw.status, raw.last_action_date),
    terminal: TERMINAL_STATUSES.has(raw.status),
  }));
  // Active bills claim the now/moving bands by rank; terminal bills are
  // appended and pinned to radar, so they can never displace an actionable
  // bill. Floors come from the active bills alone, so a settled law can't
  // even raise the bar.
  const activeBills = scored.filter((s) => !s.terminal).sort(byUrgencyDesc);
  const settledBills = scored.filter((s) => s.terminal).sort(byUrgencyDesc);
  const floors = bandFloors(activeBills.map((s) => s.eff));
  return { activeBills, settledBills, floors };
}

export function getTeasers(locale = 'en'): FeedTeaser[] {
  const { activeBills, settledBills, floors } = scoreActiveBills();

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
      statusKey: statusKeyFor(b.status, b.last_action_text),
      lastActionDate: b.last_action_date,
    };
  });
}

/**
 * Top N most urgent bills that clear the "Act now" floor and have a decoded
 * summary - the "worth a call this week" shortlist. KTD-2: this respects the
 * same absolute+rank floor as getTeasers' "now" band, so a genuinely quiet
 * week returns an empty list here too, instead of backfilling from whatever
 * ranks highest regardless of how urgent it actually is.
 */
export function getTopActions(n = 5, locale = 'en'): Bill[] {
  const { activeBills, floors } = scoreActiveBills();
  return activeBills
    .filter((s) => s.eff >= floors.nowFloor && s.raw.ai_headline)
    .slice(0, n)
    .map(({ raw }) => localizeBill(raw, locale));
}

/**
 * THE CROWN'S CANDIDATE POOL — every decoded floor_vote bill that clears the
 * SAME "Act now" floor getTopActions uses, newest floor action first, with NO
 * top-N truncation.
 *
 * Why it is not just getTopActions(4) (which is what the homepage used to
 * hand selectFloorVoteFeature): the shortlist is a rank-4 cut across every
 * status, so on a busy floor week — several bills drawing cloture motions the
 * same day — the one bill actually standing on a calendar or facing a pending
 * vote could sit at rank 9 and the page would show NO crown at all. A cap
 * that exists to make the panel mean something was quietly deciding whether
 * the panel appeared. The cap-to-one still holds; it is enforced where it
 * belongs, in selectFloorVoteFeature, which reads this whole list and returns
 * at most one bill.
 *
 * The FLOOR is deliberately shared, not re-implemented: same scoreActiveBills,
 * same `floors.nowFloor`, same `ai_headline` requirement. A quiet week returns
 * an empty list here for exactly the reason it returns an empty shortlist
 * there, and a third independent copy of the scoring is the drift
 * docs/solutions/stale-urgency-freeze.md closed once already.
 *
 * NOTE THAT THIS FLOOR IS TIGHTER THAN THE PANEL'S OWN FRESHNESS WINDOW, and
 * that is deliberate rather than an oversight. `nowFloor` sits at 0.95 on the
 * 2026-08-09 corpus, and a `floor_vote` bill scores 1.0 inside 3 days, 0.95
 * inside 7, and 0.9 after — so the pool is in practice "a floor action in the
 * last week", while selectFloorVoteFeature's isSignalFresh would accept 14
 * days. The crown is the WEEK's masthead; a bill whose last floor action was
 * eleven days ago is not what the week is about, and the same floor governed
 * the old getTopActions(4) pool, so nothing narrowed here.
 *
 * 21 bills on the 2026-08-09 corpus (339 active floor_vote bills, 21 of them
 * over the floor; every one of the 339 carries a decode). The corpus moves
 * nightly — recompute, don't trust.
 */
export function getFloorFeatureCandidates(locale = 'en'): Bill[] {
  const { activeBills, floors } = scoreActiveBills();
  return activeBills
    .filter((s) => s.eff >= floors.nowFloor && s.raw.ai_headline && s.raw.status === 'floor_vote')
    .sort((a, b) => (b.raw.last_action_date ?? '').localeCompare(a.raw.last_action_date ?? ''))
    .map(({ raw }) => localizeBill(raw, locale));
}

/**
 * Whether ANY active bill clears the "Act now" floor - decoded or not. The
 * quiet-week claim must key on this, not on getTopActions() being empty:
 * getTopActions also filters on ai_headline, so an undecoded bill that
 * clears the floor would land in /bills' "Act now" band (getTeasers applies
 * no headline filter) while the decoded shortlist reads empty - and "no bill
 * has cleared the bar" would be a false statement (AE3: never a false quiet).
 */
export function hasActNow(): boolean {
  const { activeBills, floors } = scoreActiveBills();
  return activeBills.some((s) => s.eff >= floors.nowFloor);
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
      statusKey: statusKeyFor(b.status, b.last_action_text),
      lastActionDate: b.last_action_date,
      coverageTier: tier as 'cross' | 'neutral',
      sourceCount: sources,
    };
  });
}
