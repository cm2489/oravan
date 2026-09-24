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
  /**
   * WHEN the stored decode was produced (ISO instant), or null for every bill
   * decoded before 2026-08-12 — and null means UNKNOWN, never old. Nothing
   * may render differently on a null stamp; its one reader is the re-decode
   * trigger (scripts/floor-signals-parse.mjs `redecodeVerdict`), which
   * deliberately declines to fire on it. Written only by
   * scripts/bill-decode.mjs, and only beside the decode it stamps.
   */
  decoded_at?: string | null;
  /**
   * Fingerprint of the exact document the stored decode was written from
   * (scripts/bill-decode.mjs `textFingerprint`), absent on every bill decoded
   * before 2026-09-18. PIPELINE-ONLY — nothing rendered reads it. Its one
   * purpose is to let the re-decode path tell "this bill moved" apart from
   * "this bill's document changed" and decline to pay a model to re-read
   * identical input.
   */
  decode_text_sha?: string | null;
  /**
   * When the stored decode's source document was last confirmed to still be
   * the document Congress serves — a weaker claim than `decoded_at`, which is
   * when a decode was actually written, and deliberately a separate field so
   * neither can be mistaken for the other. PIPELINE-ONLY, read by
   * `redecodeVerdict` as the later of the two freshness days.
   */
  decode_text_verified_at?: string | null;
  sponsor_bioguide_id: string | null;
  introduced_date: string | null;
  last_action_date: string | null;
  last_action_text: string | null;
  /**
   * PIPELINE-WRITTEN, OPTIONAL (2026-09-24). Present only when
   * `last_action_text` is one of the sentences that cannot be read on their
   * own ("Motion to reconsider laid on the table…", "Message on {chamber}
   * action sent to the {other}." — scripts/congress-fetch.mjs's
   * AMBIGUOUS_WITHOUT_CONTEXT): the earlier action `status` was actually read
   * from, e.g. "Passed/agreed to in House: …" or "Failed of passage/not agreed
   * to in House …". Every chamber/tense derivation reads it through
   * lib/floor-text.mjs's `statusBasisText`; the page still SHOWS
   * `last_action_text` as the latest step. Deleted whenever the latest step is
   * not ambiguous. scripts/verify-sync.mjs fails a record that breaks that.
   */
  status_basis_text?: string | null;
  /** The date of `status_basis_text`'s action (YYYY-MM-DD), when Congress.gov
   *  gave one. Never present without `status_basis_text`. */
  status_basis_date?: string | null;
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
  /** The label-gated key (lib/journey statusKeyFor): `floor_activity` for
   *  floor_vote bills whose record shows activity, not a placement, and
   *  `floor_vote_stale` for a placement the record has shown nothing since
   *  (N3, 2026-08-11 — the same fact, in the past tense). */
  statusKey: BillStatus | 'floor_activity' | 'floor_vote_stale';
  tags: string[];
  lastActionDate: string | null;
}

/**
 * A teaser placed in the browse feed: a card plus the band its DOCKET RUNG puts
 * it in (lib/docket.mjs). The band used to be a rank cut off `effectiveUrgency`;
 * since 2026-08-12 it is a fact about the record, so an empty band is a true
 * statement about the week rather than a bug.
 */
export interface FeedTeaser extends BillTeaser {
  band: UrgencyBand;
  /**
   * The rung's own footnote, in ink and never in colour:
   *   `just_decided` the floor took the question up and the answer was no.
   *   `just_passed`  a chamber passed it inside the signal window.
   * Null on every other bill. A surface may print it; none may light amber off
   * it — amber is one dated floor fact that is still AHEAD.
   */
  annotation?: 'just_decided' | 'just_passed' | null;
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
  /** Senate LIS member id (e.g. "S428"), senators only. The Senate's
   *  roll-call XML names senators by this id alone, never by bioguide, so it
   *  is the join key for data/votes.json (scripts/sync-votes.mjs). */
  lis?: string;
}

export interface District {
  state: string;
  district: number;
}

/**
 * A House seat with no current occupant (S24 groundwork,
 * the project records §9.1(f)). Derived purely
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
 *
 * The runtime array is the source of truth and `CoverageTier` is derived from
 * it, exactly like BILL_STATUSES above. Extracted from the union 2026-08-12:
 * these four words are an INTERNAL VERDICT of our AllSides lookup, not a
 * description of anybody's journalism, so scripts/moment-draft.mjs's
 * enumLeaks() has to know all of them — and a hand-copied list that nothing
 * pins is exactly how `tier0_floor_action` went missing from that guard for
 * three days. tests/moment-draft.unit.spec.ts now pins the copy against this
 * array. lib/coverage.ts's coverageTier() and its import-free twin in
 * scripts/moment-candidates.mjs return these values as literals; the TYPE is
 * what keeps the TS half honest, and the corpus-wide equality sweep in
 * tests/moment-candidates.unit.spec.ts keeps the .mjs twin honest.
 */
export const COVERAGE_TIERS = ['cross', 'neutral', 'one_sided', 'none'] as const;

export type CoverageTier = (typeof COVERAGE_TIERS)[number];

/**
 * A bill featured in the "In the news" band.
 *
 * TWO MODES, and a card says which one it came from by whether it carries a
 * caption (lib/conversation.ts's posture decides; see getNewsBills):
 *
 *  · THE LAMP — selected from data/conversation.json's committed evidence.
 *    `caption` carries the counted facts behind the card, `sourceCount` is the
 *    number of RATED outlets THE CAPTION COUNTS (0 on a most-viewed card, which
 *    counts none — one outlet is never a number this band says out loud), and
 *    `coverageTier` is their spread, null whenever fewer than two outlets are
 *    counted, because a spread over one outlet is one lean.
 *  · THE FALLBACK — #215's stored-coverage recency gate, unchanged.
 *    `caption` is null, because a caption that cannot be checked against
 *    counted evidence is a guess, and the degradation rule is to drop it.
 */
export interface NewsBill extends BillTeaser {
  coverageTier: Extract<CoverageTier, 'cross' | 'neutral'> | null;
  sourceCount: number;
  caption: import('./conversation').NewsCaption | null;
}

/**
 * Roll-call votes (data/votes.json, written by scripts/sync-votes.mjs and
 * gated by scripts/check-votes.mjs). Record data only — the record's own
 * question and result text, its tally, and every member's position. No party
 * is stored; data/legislators.json carries it.
 *
 * The four positions are the record's own vocabulary. The House's "Aye"/"No"
 * on a recorded vote are counted by the Clerk under the same yea/nay totals
 * and are stored as `yea`/`nay`.
 */
export type VotePosition = 'yea' | 'nay' | 'present' | 'notVoting';

export interface RollCallTotals {
  yea: number;
  nay: number;
  present: number;
  notVoting: number;
}

export interface RollCall {
  /** `h-119-2-308` / `s-119-2-234`: chamber initial, congress, session, roll. */
  id: string;
  chamber: 'house' | 'senate';
  congress: number;
  session: number;
  roll: number;
  /** YYYY-MM-DD, the date the record gives (Eastern). */
  date: string;
  /** Verbatim from the record, e.g. "On Cloture on the Motion to Proceed H.R. 3633". */
  question: string;
  /** Verbatim from the record, e.g. "Passed" / "Cloture on the Motion to Proceed Rejected". */
  result: string;
  /** Corpus bill id (`full_identifier`), e.g. `hr-3633-119`. */
  bill: string;
  /** The record's own tally; the gate pins it equal to the per-member lists. */
  totals: RollCallTotals;
  /** The official record this roll call was read from (clerk.house.gov / senate.gov). */
  source: string;
  /** Bioguide ids by position. */
  votes: Record<VotePosition, string[]>;
  /** Senate only, when the Vice President broke a tie. Not a member position. */
  tieBreaker?: { by: string | null; position: VotePosition };
}

/** Every member any stored roll call names — current, departed or replaced —
 *  so a vote can always be attributed after data/legislators.json moves on. */
export interface VotingMember {
  id: string;
  name: string;
  state: string;
  chamber: 'house' | 'senate';
}

export interface VotesFile {
  _meta: {
    schema: number;
    /** Earliest date the file covers (the first run's 120-day lookback). */
    floor: string;
    /** Seconds-precision ISO-8601; when the file last changed. */
    updatedAt: string;
    /** `CONGRESS-SESSION-ROLL`, the highest roll examined per chamber. */
    cursor: { house: string; senate: string };
    sources: Record<string, string>;
  };
  rollCalls: RollCall[];
  members: VotingMember[];
}
