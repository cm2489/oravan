import type { UrgencyBand } from './taxonomy';

export type BillStatus =
  | 'committee'
  | 'markup'
  | 'floor_vote'
  | 'passed_chamber'
  | 'conference'
  | 'signed'
  | 'vetoed'
  | 'introduced';

/** Decoded structure. `cost` is null when the bill has no cost dimension. */
export interface DecodedSections {
  tldr: string;
  what: string;
  who: string;
  why: string;
  cost: string | null;
  /** Short fact chips derived from `cost`; prose `cost` is the fallback. */
  costChips?: string[] | null;
}

export interface Bill {
  full_identifier: string;
  congress_number: number;
  bill_type: string;
  bill_number: number;
  title: string;
  short_title: string | null;
  ai_summary: string | null;
  ai_headline: string | null;
  ai_sections?: DecodedSections | null;
  sponsor_bioguide_id: string | null;
  introduced_date: string | null;
  last_action_date: string | null;
  last_action_text: string | null;
  status: BillStatus;
  issue_tags: string[] | null;
  policy_area: string | null;
  urgency_score: number;
  congress_gov_url: string | null;
}

/** What a bill card needs to render (no full summaries). */
export interface BillTeaser {
  slug: string;
  identifier: string;
  headline: string | null;
  title: string;
  status: BillStatus;
  tags: string[];
  lastActionDate: string | null;
}

/** A teaser placed in the urgency feed: a card plus its rank-based band. */
export interface FeedTeaser extends BillTeaser {
  band: UrgencyBand;
}

export interface DistrictOffice {
  city: string | null;
  state: string | null;
  phone: string | null;
}

export interface Legislator {
  bioguide: string;
  name: string;
  first: string;
  last: string;
  type: 'sen' | 'rep';
  state: string;
  district: number | null;
  party: string | null;
  phone: string | null;
  url: string | null;
  offices: DistrictOffice[];
}

export interface District {
  state: string;
  district: number;
}

export type Stance = 'support' | 'oppose' | 'undecided';
export type CallOutcome = 'contact' | 'voicemail' | 'unavailable';

/** Outlet political lean (third-party rating), collapsed to 3 points. */
export type Lean = 'left' | 'center' | 'right';

/**
 * One news article about a bill, as written to data/coverage.json by the
 * nightly sync. Raw publisher fields only — no lean, no AI-authored text.
 */
export interface CoverageArticleRaw {
  title: string;
  url: string;
  /** Outlet as returned by the news API, e.g. "cnn.com". */
  source: string;
  /** Publisher-provided description; null when the API omits it. */
  snippet: string | null;
  /** ISO date string; null when unknown. */
  publishedAt: string | null;
}

/**
 * Render-time shape: a raw article plus the outlet lean joined from the
 * vendored AllSides table. `lean` is null for unrated outlets (no chip).
 */
export interface CoverageArticle extends CoverageArticleRaw {
  lean: Lean | null;
}

/**
 * How a bill's coverage spreads across the press:
 *  'cross' = left and right both present · 'neutral' = 2+ center/unrated only ·
 *  'one_sided' = 2+ outlets all leaning one partisan way (shown, but disclaimed) ·
 *  'none' = too thin to surface.
 */
export type CoverageTier = 'cross' | 'neutral' | 'one_sided' | 'none';
