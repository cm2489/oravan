/*
 * THE TS DOOR ONTO THE CONVERSATION LAMP — the committed evidence file, the one
 * posture question a consumer must ask before it may claim anything, and the
 * pure selection the "In the news" band runs on.
 *
 * Same split as lib/docket.ts + lib/docket.mjs: the RULES live in
 * lib/conversation.mjs (plain .mjs, so scripts/newsdesk.mjs, the CI gate and
 * the nightly verify all read the identical evidence module), and this module
 * adds the TypeScript surface, the one data import, and the SELECTION — which
 * belongs on the consumer side because it is a display cut, not a rule about
 * what the evidence means.
 *
 * ---- WHAT THIS REPLACES -------------------------------------------------
 * #215's interim policy: the band was selected from data/coverage.json's stored
 * articles, ordered by coverage tier and outlet count, gated to the 14-day
 * signal window. That gate fixed a real lie (twelve straight days of the same
 * six bills, four of them on articles 16–109 days old under a present-tense
 * heading) but it could only ever choose among bills the nightly 600-bill
 * coverage sweep happened to have refreshed. The lamp reads a purpose-built,
 * day-granular, committed evidence file instead — and, critically, it can SAY
 * WHY each card is there in counted facts a reader can check.
 *
 * THE INTERIM POLICY IS NOT DELETED. It is the fallback, exactly as it stands
 * today (lib/coverage.ts's rankNews), for every state in which the lamp cannot
 * honestly speak: no file, an unknown schema, a file no run has written, or one
 * that has not been refreshed inside CONVERSATION_STALE_HOURS. In that state
 * the band renders the same cards it renders today and the captions are
 * DROPPED rather than guessed — design B2's degradation table, fail-quiet.
 *
 * ---- THE FOUR PATCHES, ON THE CONSUMER SIDE ------------------------------
 * B-1  There is no single-outlet path to select FROM: `conversationPool` only
 *      ever returns c1/c2, and lib/conversation.mjs has no rung a lone outlet
 *      can reach. Nothing here can re-open it — the tier is not recomputed
 *      here, it is read.
 * B-2  Most-viewed cannot fill the band: a card with no rated article beside it
 *      is capped at MOST_VIEWED_ONLY_CARD_CAP (2) of the six, and the cap
 *      constant is imported from the module that motivates it rather than
 *      re-declared here, so writer and renderer cannot drift.
 * B-3  Only rated outlets are counted, because only rated outlets are IN
 *      `outlets7d` — the split happens at write time and the gate fails the
 *      build if an unrated domain appears there.
 * B-4  Nothing to do here; the basket rebalance and the dark-lean alarm ride
 *      the writer. What this side owns is the consequence: a caption never
 *      claims a spread it does not hold (see `newsSpread`).
 */
import conversationData from '../data/conversation.json';
import {
  CONVERSATION_SCHEMA,
  MOST_VIEWED_ONLY_CARD_CAP,
  OUTLET_WINDOW_DAYS,
  conversationEvidence,
  conversationPool,
  conversationTier,
} from './conversation.mjs';
import type { Lean } from './types';

export {
  CONVERSATION_SCHEMA,
  MOST_VIEWED_ONLY_CARD_CAP,
  OUTLET_WINDOW_DAYS,
  conversationEvidence,
  conversationPool,
  conversationTier,
};

/**
 * How long the committed file may go unrefreshed before the lamp stops
 * speaking and the band falls back to #215's stored-coverage gate.
 *
 * THREE DAYS, and the number comes from the writer's own contract rather than
 * from taste. scripts/newsdesk.mjs runs hourly but writes only on a MATERIAL
 * change (an hourly cron must never become an hourly deploy), and the one
 * change that arrives on its own is the daily window prune — so a live lamp
 * with any evidence at all restamps at least daily, and a lamp holding nothing
 * at all restamps whenever the first observation lands. Three missed days is
 * therefore not "a quiet week"; it is "the writer is not running", and a
 * present-tense claim about this week must not outlive the machinery that
 * checks it.
 */
export const CONVERSATION_STALE_HOURS = 72;

export interface ConversationOutlet {
  domain: string;
  lean: Lean;
  firstSeen: string;
  lastSeen: string;
}

export interface ConversationMostViewed {
  weeksOnList: number;
  lastRank: number;
  lastSeen: string;
  lastWeek: string | null;
}

export interface ConversationEntry {
  outlets7d: ConversationOutlet[];
  /** Recorded for observability and counted by NOTHING (critic B-3). */
  unratedOutlets7d: { domain: string; firstSeen: string; lastSeen: string }[];
  mostViewed: ConversationMostViewed | null;
}

export type ConversationSourceStatus = 'ok' | 'degraded' | 'dark' | 'error' | 'unknown';

export interface ConversationFile {
  _meta: {
    schema: string;
    fetched_at: string;
    window_days: number;
    source_status: {
      press?: { status: ConversationSourceStatus; feeds_total?: number; feeds_silent?: number; checked_at?: string | null };
      most_viewed?: { status: ConversationSourceStatus; week?: string | null; entries?: number; checked_at?: string | null };
      leans?: Record<string, { status: 'ok' | 'dark'; last_live: string | null; dark_days: number }>;
    };
  };
  slugs: Record<string, ConversationEntry>;
}

/** The evidence read for one slug, as lib/conversation.mjs computes it. */
export interface ConversationEvidence {
  tier: 'c0' | 'c1' | 'c2';
  ratedOutlets: number;
  leanSpread: Lean[];
  domains: string[];
  mostViewed: ConversationMostViewed | null;
  weeksOnList: number;
  newestSeen: string | null;
  reason: string;
}

export interface ConversationPoolItem {
  slug: string;
  tier: 'c1' | 'c2';
  evidence: ConversationEvidence;
}

const FILE = conversationData as unknown as ConversationFile;

/** The committed evidence file. Read through a function so no caller closes
 *  over the import and no test has to reach past this module. */
export function conversationFile(): ConversationFile {
  return FILE;
}

/** One slug's stored evidence, or null. */
export function conversationFor(slug: string): ConversationEntry | null {
  return FILE.slugs?.[slug] ?? null;
}

/**
 * MAY THE LAMP SPEAK AT ALL? — the one question every consumer asks first, and
 * the only place the fallback is decided.
 *
 * `live` requires all three: the schema this build knows how to read, a stamp
 * inside CONVERSATION_STALE_HOURS, and a press status that says a run actually
 * observed something (the seed commit ships `unknown`, which means "no newsdesk
 * run has written this file yet" — a state the site will legitimately be in
 * between merge and the first hourly run).
 *
 * DELIBERATELY NOT A FALLBACK TRIGGER: `press: 'dark' | 'degraded'` and
 * `most_viewed: 'error'`. Those describe a source, and the evidence window
 * handles them by itself — an observation nobody re-confirms ages out in seven
 * days, so a dark basket empties the band rather than staling it. Swapping in
 * an OLDER stored-coverage band because the newest source went quiet would be
 * backfilling, which is the failure this whole design exists to end.
 */
export function conversationPosture(now: number = Date.now()): 'live' | 'unknown' {
  const meta = FILE._meta;
  if (meta?.schema !== CONVERSATION_SCHEMA) return 'unknown';
  const stamp = Date.parse(meta?.fetched_at ?? '');
  if (!Number.isFinite(stamp) || now - stamp > CONVERSATION_STALE_HOURS * 3_600_000) return 'unknown';
  const press = meta?.source_status?.press?.status;
  if (!press || press === 'unknown') return 'unknown';
  return 'live';
}

/** The C1/C2 pool for the current file, newest evidence first. Empty when the
 *  lamp is not live — a consumer that ignores the posture still cannot claim
 *  anything from a file this build will not vouch for. */
export function conversationBandPool(now: number = Date.now()): ConversationPoolItem[] {
  if (conversationPosture(now) !== 'live') return [];
  return conversationPool(FILE, { now }) as ConversationPoolItem[];
}

/**
 * HOW A SET OF RATED OUTLETS SPREADS — the same three-way reading
 * lib/coverage.ts's `coverageTier` has always applied to stored articles, kept
 * identical on purpose so "one-sided coverage is never boosted into discovery"
 * means the same thing under the lamp as it did under #215.
 *
 *   cross      both partisan leans present → "across the spectrum" is TRUE
 *   neutral    center-rated outlets only   → a true, weaker claim
 *   one_sided  exactly one partisan lean   → NEVER rendered
 *
 * The one_sided exclusion is not a ranking preference, it is a caption
 * obligation: two outlets that lean the same way are two outlets, and a card
 * that said "across the spectrum" over them would be a counted claim that is
 * false. The nonpartisan-by-construction rule is what makes it a drop rather
 * than a differently-worded card.
 */
export function newsSpread(leans: readonly Lean[]): 'cross' | 'neutral' | 'one_sided' {
  const partisan = new Set(leans.filter((l) => l === 'left' || l === 'right'));
  if (partisan.size >= 2) return 'cross';
  if (partisan.size === 1) return 'one_sided';
  return 'neutral';
}

/**
 * WHY THIS CARD IS HERE, as counted facts — never as a sentence.
 *
 * Every field is read straight out of data/conversation.json, so every word the
 * renderer builds from it is checkable against the stored evidence: the outlet
 * count is `outlets7d.length` inside the 7-day window, the leans are those
 * outlets' AllSides ratings, the weeks and rank are congress.gov's own list.
 * The STRINGS live in messages/{en,es}.json; this carries no copy, because a
 * caption is a user-facing string and must exist in both languages or neither.
 */
export interface NewsCaption {
  kind: 'corroborated' | 'corroborated_center' | 'most_viewed' | 'most_viewed_covered';
  /** Distinct RATED outlets inside the window. Never counts unrated domains. */
  outlets: number;
  /** Those outlets' leans, deduped and sorted — the spread, readable. */
  leans: Lean[];
  /** Consecutive weeks on congress.gov's most-viewed list; 0 when absent. */
  weeks: number;
  /** Its rank on the most recent list, or null. */
  rank: number | null;
}

export interface ConversationSelection {
  slug: string;
  tier: 'c1' | 'c2';
  caption: NewsCaption;
  evidence: ConversationEvidence;
}

/**
 * THE BAND, SELECTED — C1 first, then C2 under the B-2 rule, capped.
 *
 * Pure over its inputs (the pool, the limit, and a predicate saying which slugs
 * this build can actually render a card for), so the whole policy is unit-
 * testable on fixtures without a corpus — which matters more than usual here,
 * because data/conversation.json is legitimately near-empty during a recess and
 * a corpus-only test would pass vacuously.
 *
 * ORDER comes from the pool and is not re-derived: C1 before C2, more rated
 * outlets first, then newest evidence, then slug. Two runs on the same evidence
 * therefore produce the same six cards in the same order.
 *
 * THE TWO EXCLUSIONS, both of them caption obligations rather than rankings:
 *   · a C1 set that is one-sided (see `newsSpread`) is dropped, not reworded;
 *   · a most-viewed card with NO rated article beside it is capped at
 *     MOST_VIEWED_ONLY_CARD_CAP, because congress.gov's view counts are the
 *     cheapest input in this design to game and must never be able to fill the
 *     band on their own (critic B-2). It is a cap, not a ban: the government's
 *     own weekly list, carried two weeks running, is real public attention and
 *     saying so is honest.
 */
export function selectConversationBand(
  pool: readonly ConversationPoolItem[],
  {
    limit,
    renderable,
    mostViewedOnlyCap = MOST_VIEWED_ONLY_CARD_CAP,
  }: { limit: number; renderable?: (slug: string) => boolean; mostViewedOnlyCap?: number }
): ConversationSelection[] {
  const out: ConversationSelection[] = [];
  let mostViewedOnly = 0;
  for (const item of pool) {
    if (out.length >= limit) break;
    if (renderable && !renderable(item.slug)) continue;
    const { evidence } = item;
    const leans = [...evidence.leanSpread];
    const rank = evidence.mostViewed?.lastRank ?? null;
    if (item.tier === 'c1') {
      const spread = newsSpread(leans);
      if (spread === 'one_sided') continue;
      out.push({
        slug: item.slug,
        tier: 'c1',
        evidence,
        caption: {
          kind: spread === 'cross' ? 'corroborated' : 'corroborated_center',
          outlets: evidence.ratedOutlets,
          leans,
          weeks: evidence.weeksOnList,
          rank,
        },
      });
      continue;
    }
    // C2 — the government's own most-viewed list, admitted only with a second
    // fact beside it (the module already enforced which: two consecutive weeks,
    // or at least one rated article). Both facts are printed.
    if (!evidence.mostViewed) continue; // unreachable via conversationEvidence; a defensive floor, not a policy
    if (evidence.ratedOutlets === 0) {
      if (mostViewedOnly >= mostViewedOnlyCap) continue;
      mostViewedOnly++;
      out.push({
        slug: item.slug,
        tier: 'c2',
        evidence,
        caption: { kind: 'most_viewed', outlets: 0, leans: [], weeks: evidence.weeksOnList, rank },
      });
      continue;
    }
    out.push({
      slug: item.slug,
      tier: 'c2',
      evidence,
      caption: {
        kind: 'most_viewed_covered',
        outlets: evidence.ratedOutlets,
        leans,
        weeks: evidence.weeksOnList,
        rank,
      },
    });
  }
  return out;
}
