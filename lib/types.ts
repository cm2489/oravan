export type BillStatus =
  | 'committee'
  | 'markup'
  | 'floor_vote'
  | 'passed_chamber'
  | 'conference'
  | 'signed'
  | 'vetoed'
  | 'introduced';

/** A-plus decoded structure. `cost` is null when the bill has no cost dimension. */
export interface DecodedSections {
  tldr: string;
  what: string;
  who: string;
  why: string;
  cost: string | null;
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

/** Trimmed shape sent to the client for the feed (no full summaries). */
export interface BillTeaser {
  slug: string;
  identifier: string;
  headline: string | null;
  title: string;
  status: BillStatus;
  tags: string[];
  urgency: number;
  lastActionDate: string | null;
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
