import type { UrgencyBand } from './taxonomy';

/**
 * Every status a bill can carry. The runtime array is the source of truth;
 * `BillStatus` is derived from it so a schema that needs to enumerate the
 * same values at runtime (the MCP `search_bills` tool's zod schema) reads
 * off this array instead of hand-duplicating the union (lib/core/mcp.ts).
 */
export const BILL_STATUSES = [
  'committee',
  'markup',
  'floor_vote',
  'passed_chamber',
  'conference',
  'signed',
  'vetoed',
  'introduced',
] as const;

export type BillStatus = (typeof BILL_STATUSES)[number];

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

/**
 * A House seat with no current occupant (S24 groundwork,
 * docs/ideation/2026-07-05-build-gtm-strategy.md §9.1(f)). Derived purely
 * from seat sets by scripts/vacancy_diff.py - never from a departed
 * member's own stale term data, so this type has no room for a name or
 * bioguide to leak in by accident. `since` is when the weekly refresh first
 * observed the seat empty (bootstrap runs use the seeding date, not a
 * verified resignation date) - it's pipeline bookkeeping for de-duplicating
 * alerts across runs, not asserted to callers as an authoritative event
 * date.
 */
export interface Vacancy {
  state: string;
  district: number;
  since: string;
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

/** A bill featured in the coverage-led "In the news" lens (cross/neutral only). */
export interface NewsBill extends BillTeaser {
  coverageTier: Extract<CoverageTier, 'cross' | 'neutral'>;
  sourceCount: number;
}
