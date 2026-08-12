/*
 * THE TS DOOR ONTO THE DOCKET LADDER — types, the committed signal file, and
 * the two helpers every React/route caller needs.
 *
 * Same split as lib/urgency.mjs + lib/signal-window.ts: the RULES live in
 * lib/docket.mjs (plain .mjs, so scripts/sync-coverage.mjs and
 * scripts/moment-candidates.mjs read the identical ladder under plain node),
 * and this module adds the TypeScript surface and the one data import.
 *
 * data/floor-signals.json is ~1 KB on a recess week and a few KB on a busy one
 * — three orders of magnitude under data/bills.json, which every caller of this
 * module already pulls — so importing it here costs nothing measurable. It is
 * COMMITTED rather than cached (owner ruling V5): a signal that only ever lived
 * in an Actions cache is unauditable history, and this file is the evidence
 * behind a claim printed in the loudest surface on the site.
 */
import floorSignals from '@/data/floor-signals.json';
import {
  DOCKET_TIERS,
  TIER_BAND,
  SIGNAL_STALE_HOURS,
  bandForRung,
  compareDocket,
  docketKey,
  docketRung,
  entersFloorWatch,
  isActNow,
  isDecidingNow,
  isSettledFloor,
  signalIsLive,
  t0Weight,
} from './docket.mjs';
import type { UrgencyBand } from './taxonomy';

export {
  DOCKET_TIERS,
  TIER_BAND,
  SIGNAL_STALE_HOURS,
  bandForRung,
  compareDocket,
  docketKey,
  docketRung,
  entersFloorWatch,
  isActNow,
  isDecidingNow,
  isSettledFloor,
  signalIsLive,
  t0Weight,
};

export type DocketTier = 't0' | 't1' | 't2' | 't3' | 't4';
export type DocketAnnotation = 'just_decided' | 'just_passed';

/** Which document a T0 announcement came out of. Both are the government's
 *  own publication; neither is ever paraphrased or translated (ruling V4). */
export type FloorSignalSource = 'daily-digest' | 'billsthisweek';

/** One announcement, exactly as scripts/floor-signals.mjs stored it. */
export interface FloorSignalTier0 {
  source: FloorSignalSource;
  chamber: 'house' | 'senate';
  /** ENGLISH VERBATIM, always — the gate in scripts/check-floor-signals.mjs
   *  fails the build on any other `quote_lang`. A Spanish surface frames it. */
  quote: string;
  quote_lang: 'en';
  quote_kind: string;
  announcement?: string | null;
  url: string;
  /** The announcing document's own date. */
  published: string;
  /** The next meeting / week the announcement covers, derived from the
   *  source's own printed label, which is kept beside it. */
  covers: string | null;
  covers_label: string | null;
  track: 'rule' | 'suspension' | 'unspecified';
  certainty: 'scheduled_vote' | 'consideration' | 'conditional';
}

export interface FloorSignalEntry {
  tier0: FloorSignalTier0;
  fetched_at: string;
  first_seen: string;
  /** True when the source went dark and this was carried forward. A stale
   *  signal may rank; it may never crown (critic A-1). */
  stale?: boolean;
}

/**
 * The five source states, and only two of them are statements about Congress.
 * `ok` and `quiet` describe the chambers; `data_stale`, `error` and `unknown`
 * describe US, and belong in lib/freshness-state.ts's data_stale posture — a
 * fetch failure must never render as "Congress published no schedule".
 */
export type FloorSourceStatus = 'ok' | 'quiet' | 'data_stale' | 'error' | 'unknown';

export interface FloorSignalsFile {
  _meta: {
    schema: string;
    fetched_at: string;
    sources: Record<string, { status: FloorSourceStatus; detail?: string; url?: string }>;
    in_session?: Record<string, string>;
  };
  signals: Record<string, FloorSignalEntry>;
  nominations: Record<string, FloorSignalEntry>;
}

export interface DocketRung {
  tier: DocketTier;
  annotation: DocketAnnotation | null;
  terminal: boolean;
  weight: number;
  source: FloorSignalSource | null;
  announced: FloorSignalTier0 | null;
}

const FILE = floorSignals as unknown as FloorSignalsFile;

/** The committed signal file. Read through a function so no caller closes over
 *  the import and no test has to reach past this module. */
export function floorSignalsFile(): FloorSignalsFile {
  return FILE;
}

/**
 * THE BILL LADDER'S SIGNALS ONLY. `nominations` is a separate top-level map by
 * deliberate construction (owner ruling V3): the Senate's program is dominated
 * by executive-calendar nominations, and routing one into the bill ladder is
 * meant to be unrepresentable rather than merely unlikely.
 */
export function floorSignalFor(slug: string): FloorSignalEntry | null {
  return FILE.signals?.[slug] ?? null;
}

/**
 * WHAT THE SOURCES SAY ABOUT THEMSELVES, collapsed to the one question an
 * empty surface has to answer honestly (critic A-5): may a bare band claim
 * "Congress published no floor schedule", or is our own pipeline the reason
 * it is empty?
 *
 * `ok`/`quiet` from EVERY source, and a file refreshed inside the same window
 * the ladder trusts, is the only combination that earns `quiet`. A 404 during
 * a recess and a 404 because a URL scheme rotted look identical from here —
 * AP's RSS died exactly that way — so anything else reads `unknown`, which the
 * empty state renders as data_stale rather than as a fact about Congress.
 */
export function floorSourcesPosture(now: number = Date.now()): 'quiet' | 'unknown' {
  const meta = FILE._meta;
  const stamp = Date.parse(meta?.fetched_at ?? '');
  if (!Number.isFinite(stamp) || now - stamp > SIGNAL_STALE_HOURS * 3_600_000) return 'unknown';
  const sources = Object.values(meta?.sources ?? {});
  if (sources.length === 0) return 'unknown';
  return sources.every((s) => s.status === 'ok' || s.status === 'quiet') ? 'quiet' : 'unknown';
}

/** The rung for one bill, with its signal looked up here so callers never
 *  have to know the file exists. */
export function rungFor(
  bill: { status?: string; last_action_text?: string | null; last_action_date?: string | null },
  slug: string,
  now: number = Date.now()
): DocketRung {
  return docketRung(bill, floorSignalFor(slug), { now }) as DocketRung;
}

/** Band for a bill, straight from its rung — the /bills replacement for
 *  `bandForEff(eff, floors)`. */
export function bandFor(rung: DocketRung): UrgencyBand {
  return bandForRung(rung) as UrgencyBand;
}

/**
 * THE CROWN'S T0 INPUT — the announcement for one bill, or null.
 *
 * Shaped for `selectFloorVoteFeature`'s `announcementOf` resolver, which is how
 * the chamber's schedule reaches a design primitive that must not import data.
 * Returns null the instant `signalIsLive` says the announcement is no longer a
 * statement about this week, so a bill pulled from the schedule stops wearing
 * the crown on the next hourly run (critic A-1).
 */
export function announcementFor(
  slug: string,
  now: number = Date.now()
): {
  quote: string;
  url: string;
  published: string;
  covers: string | null;
  coversLabel: string | null;
  source: FloorSignalSource;
  chamber: 'house' | 'senate';
} | null {
  const signal = floorSignalFor(slug);
  if (!signal || !signalIsLive(signal, { now })) return null;
  const t0 = signal.tier0;
  return {
    quote: t0.quote,
    url: t0.url,
    published: t0.published,
    covers: t0.covers,
    // Both, deliberately: `covers` is the horizon `signalIsLive` computes on,
    // `covers_label` is the sentence the document actually printed. A surface
    // that shows coverage to a reader shows the label (see `coversDisplay`).
    coversLabel: t0.covers_label ?? null,
    source: t0.source,
    chamber: t0.chamber,
  };
}

/**
 * WHAT AN EVIDENCE ROW PRINTS FOR COVERAGE — the source's own words when it
 * printed them, our derived date only as the fallback.
 *
 * Both fields are stored side by side on purpose (scripts/floor-signals-parse
 * .mjs: "the derived date everywhere (`covers_label`) so the reader can check
 * it"), and until 2026-08-12 only the DERIVED one reached a page: the homepage
 * printed `for Aug 13, 2026` where the Daily Digest itself had said
 * "8 a.m., Thursday, August 13". The label is strictly more information — it
 * carries the hour the ISO date cannot hold — and it is the document's own
 * sentence rather than our arithmetic on it, which is the whole standard this
 * panel is held to.
 *
 * It is ENGLISH VERBATIM, like every other quoted fragment here (ruling V4), so
 * `verbatim: true` tells the caller to mark it `lang="en"` and NOT to run it
 * through a date formatter. When the document printed no label the caller
 * formats `covers` itself, in the reader's locale, exactly as it did before.
 */
export function coversDisplay(announcement: {
  covers: string | null;
  coversLabel: string | null;
}): { label: string; verbatim: true } | { iso: string; verbatim: false } | null {
  const label = announcement.coversLabel?.trim();
  if (label) return { label, verbatim: true };
  if (announcement.covers) return { iso: announcement.covers, verbatim: false };
  return null;
}

/** When the committed signal file was last refreshed — the "as of" stamp A-1
 *  requires beside any T0 claim. */
export function floorSignalsCheckedAt(): string | null {
  const stamp = FILE._meta?.fetched_at ?? null;
  return stamp && Number.isFinite(Date.parse(stamp)) ? stamp : null;
}

/**
 * THE EVIDENCE A SURFACE MAY PRINT — one sentence from the record, its date and
 * its URL, for every rung.
 *
 * T0's sentence is the chamber's own announcement (quoted, dated, attributed,
 * at a printed URL). Every other rung's sentence is the bill's own last action
 * — also Congress's words, also dated. Both are ENGLISH VERBATIM in both
 * locales: a translated quote is a paraphrase wearing quotation marks (ruling
 * V4), so the Spanish surfaces frame it in Spanish and print it unchanged.
 */
export interface DocketEvidence {
  sentence: string;
  url: string | null;
  date: string | null;
  kind: 'announcement' | 'record';
  source: FloorSignalSource | null;
}

export function evidenceFor(
  bill: { last_action_text?: string | null; last_action_date?: string | null; congress_gov_url?: string | null },
  rung: DocketRung
): DocketEvidence | null {
  if (rung.announced) {
    return {
      sentence: rung.announced.quote,
      url: rung.announced.url,
      date: rung.announced.published,
      kind: 'announcement',
      source: rung.announced.source,
    };
  }
  const sentence = bill.last_action_text?.trim();
  if (!sentence) return null;
  return {
    sentence,
    url: bill.congress_gov_url ?? null,
    date: bill.last_action_date ?? null,
    kind: 'record',
    source: null,
  };
}
