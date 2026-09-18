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
// The "we checked" heartbeat that lives OUTSIDE floor-signals.json on purpose
// — see scripts/floor-signals-parse.mjs's FLOOR_SIGNALS_CHECKED_PATH header
// and lib/docket.mjs's floorSignalsHealthy. Committed like floor-signals.json
// itself (never a cache), so this import is always safe.
import floorSignalsChecked from '@/data/floor-signals-checked.json';
import {
  DOCKET_TIERS,
  TIER_BAND,
  SIGNAL_STALE_HOURS,
  announcementAnswered,
  bandForRung,
  chamberNextMeetingFrom,
  chamberSessionFrom,
  compareDocket,
  docketKey,
  docketRung,
  entersFloorWatch,
  floorAnsweredChamber,
  floorSignalsHealthy,
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
  announcementAnswered,
  bandForRung,
  compareDocket,
  docketKey,
  docketRung,
  entersFloorWatch,
  floorAnsweredChamber,
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

/** One chamber's next sitting as `_meta.next_meeting` stores it: the digest's
 *  own printed line, and the date derived from it by filling in the year. */
export interface FloorNextMeeting {
  date?: string | null;
  label?: string | null;
}

export interface FloorSignalsFile {
  _meta: {
    schema: string;
    fetched_at: string;
    sources: Record<
      string,
      { status: FloorSourceStatus; detail?: string; url?: string; published?: string | null }
    >;
    /** `senate` / `house` -> a ChamberSession, plus `basis` -> the sentence
     *  naming the document they were read out of. Keyed, never iterated. */
    in_session?: Record<string, string>;
    /** Null on the stale-digest branch, where the writer asserts no meeting at
     *  all rather than one read out of a document that has stopped describing
     *  the present. */
    next_meeting?: Record<string, FloorNextMeeting | null> | null;
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
/** `{ schema, checked_at }` — the merge input for `floorSignalsHealthy`. */
const CHECKED = floorSignalsChecked as unknown as { checked_at?: string | null };

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
  const stamp = Date.parse(floorSignalsHealthy(meta, CHECKED).fetched_at ?? '');
  if (!Number.isFinite(stamp) || now - stamp > SIGNAL_STALE_HOURS * 3_600_000) return 'unknown';
  const sources = Object.values(meta?.sources ?? {});
  if (sources.length === 0) return 'unknown';
  return sources.every((s) => s.status === 'ok' || s.status === 'quiet') ? 'quiet' : 'unknown';
}

/** Is a chamber meeting? Three literals and nothing else — see
 *  `chamberSessionFrom`'s three routes to `unknown`. */
export type ChamberSession = 'in_session' | 'out_of_session' | 'unknown';

/**
 * IS THE HOUSE / THE SENATE MEETING, as of now.
 *
 * The same shape as `floorSourcesPosture` above and read under the same
 * freshness rule (SIGNAL_STALE_HOURS): the file is committed and the site is
 * statically generated from it, so a page can only be as current as the last
 * hourly write, and a write that stopped happening must decay to `unknown`
 * rather than keep asserting a chamber's schedule.
 *
 * The rule itself lives in lib/docket.mjs so a unit test can exercise all
 * three branches without the data import; this is the typed door onto it.
 */
export function chamberSession(
  chamber: 'house' | 'senate',
  now: number = Date.now()
): ChamberSession {
  return chamberSessionFrom(FILE._meta, chamber, now, CHECKED) as ChamberSession;
}

/**
 * WHEN THE CHAMBER MEETS NEXT — `{ iso, label }`, or null when the file names
 * no meeting still ahead for it.
 *
 * `label` is the Daily Digest's own line ("9 a.m., Thursday, August 13"),
 * ENGLISH VERBATIM like every other quoted fragment here (ruling V4); `iso` is
 * our arithmetic on it. A surface that shows a reader the meeting shows the
 * label, exactly as `coversDisplay` does for an announcement's horizon.
 */
export function chamberNextMeeting(
  chamber: 'house' | 'senate',
  now: number = Date.now()
): { iso: string | null; label: string | null } | null {
  return chamberNextMeetingFrom(FILE._meta, chamber, now) as {
    iso: string | null;
    label: string | null;
  } | null;
}

/**
 * WHERE THE SESSION VERDICT CAME FROM — the Daily Digest's own URL and its own
 * publication date, so anything that prints `chamberSession` or
 * `chamberNextMeeting` can attribute it to the document instead of to us. Null
 * when the file carries no daily-digest source at all.
 */
export function floorSessionSource(): { url: string | null; published: string | null } | null {
  const src = FILE._meta?.sources?.['daily-digest'];
  if (!src) return null;
  const url = typeof src.url === 'string' && src.url ? src.url : null;
  const published = typeof src.published === 'string' && src.published ? src.published : null;
  return url || published ? { url, published } : null;
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
 *
 * IT TAKES THE BILL, NOT JUST THE SLUG (owner decision D13, 2026-09-18), and
 * the gate is `rungFor` rather than `signalIsLive` alone — the same one line
 * the bill page already ran (`rung.tier === 't0' ? rung.announced : null`). A
 * slug-only resolver could not see the bill's own record, so an announcement
 * the chamber's vote had already spent stayed available to the crown through a
 * bill that reached the pool on a LOWER rung: a measure the House passed on
 * Tuesday and the Senate then placed on its calendar is a live T2, and the
 * crown would have printed "On the House floor schedule" over it. Two surfaces
 * reading one record run one gate.
 */
export function announcementFor(
  bill: { status?: string; last_action_text?: string | null; last_action_date?: string | null },
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
  const rung = rungFor(bill, slug, now);
  if (rung.tier !== 't0' || !rung.announced) return null;
  const t0 = rung.announced;
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

/** When the committed signal file was last refreshed OR last honestly
 *  reconfirmed — the "as of" stamp A-1 requires beside any T0 claim. Merges
 *  floor-signals.json's own stamp with floor-signals-checked.json's (see
 *  `floorSignalsHealthy`), so a reconfirmed-but-unchanged hour still moves
 *  this forward instead of reading as days-old. */
export function floorSignalsCheckedAt(): string | null {
  const stamp = floorSignalsHealthy(FILE._meta, CHECKED).fetched_at;
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
