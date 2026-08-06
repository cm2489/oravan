/*
 * Moment-updates data access — pure functions over data/moment-updates.json,
 * the same posture as lib/moments.ts and lib/core/bills.ts (deliberately NOT
 * 'server-only'; route handlers and future agent surfaces are legitimate
 * callers too).
 *
 * ---------------------------------------------------------------------------
 * THE EDITORIAL LAW this file renders under (owner-settled 2026-07-25,
 * the project records §2):
 *
 *   "Truth about the record, attribution about the spin. When the record
 *    speaks, we say it plainly — numbers, dates, tallies, text — even when
 *    plainness lands harder on one side. Balance is not achieved by blunting
 *    facts. When the record is silent — motive, likelihood, what it really
 *    means — Oravan's voice stops, and named sources speak or nobody does.
 *    Speculation never wears our voice."
 *
 * The law is enforced at WRITE time by lib/moment-updates-gate.mjs; this file
 * only reads. Two structural consequences it does carry:
 *   - `record` travels with every non-press update, so a page can render the
 *    government's verbatim text beside the decoded one-liner and a wrong
 *    decode is falsifiable in one click (§2.4).
 *   - Quiet days are COMPUTED by groupByDay, never stored as fake updates.
 *    Emptiness is a first-class render here (§3).
 * ---------------------------------------------------------------------------
 *
 * DEPENDENCY DIRECTION, on purpose: this module imports nothing from
 * lib/moments.ts and lib/moments.ts must never import this. A moment exists
 * without updates; updates without a moment are a gate violation, not a
 * runtime concern. Keeping the arrow one-way means the hand-authored file and
 * the machine-authored file never load each other, and the moments pages that
 * predate the live layer keep working with an empty updates file.
 */
import updatesJson from '@/data/moment-updates.json';
import {
  RENDER_DAY_CAP,
  RETENTION_DAYS,
  SCHEMA_VERSION,
  groupByDay,
} from './moment-updates-gate.mjs';

export type UpdateClass =
  | 'vote'
  | 'status_change'
  | 'floor_action'
  | 'scheduled'
  | 'press_cluster'
  | 'correction';

export type UpdateSourceKind = 'congress_actions' | 'tier0_feed' | 'press';

export type MediaLean = 'left' | 'center' | 'right';

export interface Localized {
  en: string;
  es: string;
}

export interface UpdateSource {
  kind: UpdateSourceKind;
  /** Clickable evidence — always https. */
  refs: string[];
  /** Outlet domains (press clusters only). */
  outlets?: string[];
  /** Display names the attribution lint checks the text against. */
  outlet_names?: string[];
  /**
   * The SET of distinct AllSides leans present in this cluster — deduped and
   * sorted, so `['center', 'left', 'right']` however many outlets carried
   * each. It is NOT parallel to `outlets` and DO NOT ZIP IT: three outlets can
   * produce one entry, and unrated outlets contribute none at all. The name
   * says `_set` because this field sits between `outlets` and `outlet_names`,
   * which ARE positional and same-length by construction, and a plural
   * `leans` there read like a third parallel array. (Corrected 2026-08-06:
   * the doc claimed same-order-as-`outlets`, which the collector never
   * produced — see scripts/moment-updates-map.mjs's pressClusterToCandidate.)
   *
   * The only thing that consumes lean at all is the write-time publishability
   * guardrail (`clusterIsPublishable`), which asks a set question — "is every
   * partisan lean here on ONE side?" — so a set is what the field should be.
   * Never rendered: no lean badge, no AllSides chrome, ever (v1 spec §3.3,
   * pinned by tests/moments.spec.ts and documented in components/
   * MomentTimeline.tsx's ATTRIBUTION, NEVER LEAN promise).
   */
  lean_set?: MediaLean[];
}

export interface RollCall {
  chamber: 'house' | 'senate';
  number: number;
}

/**
 * The verbatim government record an update decodes (§2.4 — "the record ships
 * beside the voice"). Null ONLY on a press_cluster, which decodes coverage
 * rather than the record.
 */
export interface UpdateRecord {
  action_text: string;
  action_code: string | null;
  action_type: string;
  source_system: string;
  roll_call?: RollCall;
}

export interface MomentUpdate {
  id: string;
  class: UpdateClass;
  /** A bill slug from THIS moment's vehicles[]. */
  vehicle: string;
  /** The LEGISLATIVE day (ET), not the UTC bucket. */
  day: string;
  occurred_at: string;
  occurred_precision: 'day' | 'time';
  /** When the pipeline saw it — back-dating is legible, never invisible. */
  recorded_at: string;
  text: Localized;
  source: UpdateSource;
  record: UpdateRecord | null;
  /** Present on `correction`: the id of the update being corrected. */
  corrects?: string;
  /** Honesty labeling: true when a model wrote the one-liner. */
  ai: boolean;
}

export interface SummaryRevision {
  id: string;
  generated_at: string;
  as_of_day: string;
  text: Localized;
  grounded_in: {
    vehicle_statuses: Record<string, string>;
    update_ids: string[];
    refs?: string[];
  };
  changed_because: string[];
  model: string;
}

export interface MomentUpdatesEntry {
  updates: MomentUpdate[];
  summary_revisions: SummaryRevision[];
}

/** One ET day of the timeline, including the days with nothing in them. */
export interface UpdateDayGroup {
  day: string;
  /** Every update on that day, class-priority ordered. */
  updates: MomentUpdate[];
  /** The ≤ RENDER_DAY_CAP that render. */
  rendered: MomentUpdate[];
  /** How many the honest overflow line accounts for. */
  overflow: number;
  /** Nothing was recorded that day — rendered as a quiet day, never padded. */
  quiet: boolean;
  /** Today's silence and last Tuesday's silence are different sentences. */
  isToday: boolean;
}

interface UpdatesFile {
  _meta?: { schema?: number; generated_at?: string };
  [momentId: string]: unknown;
}

const FILE = updatesJson as unknown as UpdatesFile;

const EMPTY: MomentUpdatesEntry = { updates: [], summary_revisions: [] };

function entryFor(id: string): MomentUpdatesEntry {
  if (id === '_meta') return EMPTY;
  const entry = FILE[id] as MomentUpdatesEntry | undefined;
  if (!entry || !Array.isArray(entry.updates)) return EMPTY;
  return {
    updates: entry.updates,
    summary_revisions: Array.isArray(entry.summary_revisions) ? entry.summary_revisions : [],
  };
}

/** When the collector last wrote the file — NEVER restamped on a no-op run. */
export function getUpdatesGeneratedAt(): string | undefined {
  return FILE._meta?.generated_at;
}

/** The stored schema version, so a page can refuse to render a file it doesn't know. */
export function getUpdatesSchema(): number | undefined {
  return FILE._meta?.schema;
}

/**
 * Every stored update for a moment, newest legislative day first. An unknown
 * moment (or one the collector has not reached yet) reads as an empty
 * timeline — which the page renders as quiet days, honestly, rather than as
 * an error.
 */
export function getUpdates(id: string): MomentUpdate[] {
  return entryFor(id).updates;
}

/** The current "Where it stands" summary — the last revision, or undefined. */
export function getCurrentSummary(id: string): SummaryRevision | undefined {
  return entryFor(id).summary_revisions.at(-1) ?? undefined;
}

/** The full dated revision history, oldest first (append-only). */
export function getRevisions(id: string): SummaryRevision[] {
  return entryFor(id).summary_revisions;
}

/**
 * The token a revision carries when a PERSON wrote it. Only the seed
 * revisions the live layer shipped with carry it today; the collector stamps
 * its own model id (`claude-sonnet-5`) on everything it writes.
 */
export const HAND_AUTHORED_MODEL = 'hand-authored';

/**
 * Whether a summary revision is AI text — the provenance the "Where it
 * stands" chip is gated on (pre-launch audit 2026-07-25, constitution-08).
 * `MomentUpdate` carries an explicit `ai` boolean; a `SummaryRevision`
 * carries only `model`, so provenance is read from that.
 *
 * A model string nobody recognizes reads as AI. The failure modes are not
 * symmetric: labeling human text as AI is a small insult, while shipping AI
 * text with no label breaks a CLAUDE.md hard rule — so only the one explicit
 * hand-authored token drops the label.
 */
export function isAiSummary(revision: Pick<SummaryRevision, 'model'>): boolean {
  return revision.model.trim().toLowerCase() !== HAND_AUTHORED_MODEL;
}

/** The most recent legislative day with anything on it, or undefined. */
export function latestUpdateDay(id: string): string | undefined {
  let latest: string | undefined;
  for (const u of getUpdates(id)) {
    if (typeof u.day === 'string' && (latest === undefined || u.day > latest)) latest = u.day;
  }
  return latest;
}

/**
 * The timeline the page renders: a contiguous window of ET days, newest
 * first, every day present including the quiet ones.
 *
 * `now` is injectable so tests can pin the window and so a server render can
 * pass a single clock to every call on the page.
 */
export function groupUpdatesByDay(
  id: string,
  windowDays: number,
  now: number = Date.now(),
): UpdateDayGroup[] {
  return groupByDay(getUpdates(id), windowDays, now) as unknown as UpdateDayGroup[];
}

/** Re-exported so a page never hard-codes a number the gate owns. */
export { RENDER_DAY_CAP, RETENTION_DAYS, SCHEMA_VERSION };

/**
 * THE KILL-SWITCH (v2 spec §2.4), read once at module scope: these pages are
 * statically generated, so this is a property of the BUILD, not of a request.
 *
 * It lives HERE, not in a component, because it has to govern every surface
 * that renders unreviewed AI prose. It originally sat inside MomentTimeline
 * and therefore covered only the one-liners — leaving the Sonnet "Where it
 * stands" paragraph, the largest and most voice-y block on the page, with no
 * off switch at all, which is precisely the thing the armed-from-day-one
 * decision was leaning on (pre-launch audit, 2026-07-25).
 *
 * Timeline items fall back to the government's verbatim record; the summary
 * has no verbatim equivalent to fall back TO, so it renders nothing — the
 * section is already absent when no revision exists, so silence is a shape
 * the page knows how to be.
 */
export const VERBATIM_MODE = process.env.MOMENT_UPDATES_VERBATIM === '1';
