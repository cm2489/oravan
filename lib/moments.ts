/*
 * Moments data access — pure functions over data/moments.json, the same
 * posture as lib/core/bills.ts (deliberately NOT 'server-only'; route
 * handlers and future agent surfaces are legitimate callers too).
 *
 * Lifecycle is computed AT READ TIME, never stored — the same discipline as
 * urgency (lib/urgency.mjs) and freshness (lib/freshness-state.ts): a stored
 * "settled" flag would freeze a verdict the corpus has already moved past
 * (the stale-CFPB-on-top failure shape, docs/solutions/
 * stale-urgency-freeze.md). A moment whose vehicles are ALL in
 * TERMINAL_STATUSES simply reads as settled the moment the nightly sync
 * lands the last terminal status; nobody has to remember to edit
 * moments.json. The curve of states is pinned by tests/moments.unit.spec.ts.
 */
import momentsJson from '@/data/moments.json';
import { getBill } from './core/bills';
import { TERMINAL_STATUSES } from './urgency.mjs';
import type { Category } from './taxonomy';

export interface Localized {
  en: string;
  es: string;
}

export interface LocalizedList {
  en: string[];
  es: string[];
}

/**
 * The qualifying-signal types a moment may cite — MUST match
 * lib/moments-gate.mjs's SIGNAL_TYPES (pinned equal by
 * tests/moments.unit.spec.ts AND asserted at runtime by
 * scripts/check-moments.mjs, the same belt-and-braces the terminal-status set
 * gets; the gate keeps its own copy because that module stays import-free —
 * see its header).
 *
 * This was a bare string union until 2026-08-06. A union has no runtime value,
 * so every caller that needed to ENUMERATE the members — the questions page's
 * "is this a type we have a label for?" check — hand-copied the list, giving
 * three copies and no pin between any of them. A missed copy degrades
 * silently: the page falls through to printing the raw slug (`tier0_floor`)
 * where a translated label belongs, in both languages, with nothing red.
 * Declaring the array and deriving the union gives one enumerable source and
 * keeps the type exactly as narrow as before.
 *
 * Every member needs a `moments.signalType.<member>` string in BOTH
 * messages/en.json and messages/es.json before it can ship.
 */
export const QUALIFYING_SIGNAL_TYPES = [
  'tier0_floor',
  'tier0_scheduled',
  'tier0_most_viewed',
  'press',
] as const;

export type QualifyingSignalType = (typeof QUALIFYING_SIGNAL_TYPES)[number];

export interface QualifyingSignal {
  type: QualifyingSignalType;
  /** Clickable evidence for the reviewer — tier-0 feed items or ≥2 lean-diverse articles. */
  refs: string[];
}

export interface MomentVehicle {
  /** A bill's full_identifier in data/bills.json — the moment may not exist without it. */
  slug: string;
  /** What a yes vote does and what a no vote does, in parallel neutral clauses. */
  role: Localized;
}

export type ContextRefKind = 'crs' | 'cbo' | 'gao';

/**
 * A hand-curated link into the institutional record — a CRS report, CBO
 * score, or GAO finding — added by the owner when a moment opens (v2 spec
 * §5). Grounds the v2 state summaries; host-allowlisted by the gate.
 */
export interface ContextRef {
  kind: ContextRefKind;
  url: string;
  /** Optional display title; when present it renders, so it is bilingual. */
  title?: Localized;
}

/** Stored status. 'settled' is deliberately NOT representable here — it is
 *  computed from vehicle statuses at read time (see momentState). */
export type StoredMomentStatus = 'live' | 'retired';

/**
 * Read-time lifecycle state (spec §4.3):
 *  - live:    shown everywhere
 *  - settled: every vehicle terminal — the fight is over; computed, never stored
 *  - stale:   review_by passed without a renewing PR — the zombie-curation tripwire
 *  - retired: stored owner decision
 */
export type MomentState = 'live' | 'settled' | 'stale' | 'retired';

export interface MomentEntry {
  name: Localized;
  summary: Localized;
  /** Search-only terms, never rendered. */
  aliases: LocalizedList;
  category: Category;
  vehicles: MomentVehicle[];
  qualifying_signal: QualifyingSignal;
  /** Optional institutional grounding (CRS/CBO/GAO) — see ContextRef. */
  context_refs?: ContextRef[];
  opened: string;
  review_by: string;
  status: StoredMomentStatus;
}

export interface Moment extends MomentEntry {
  id: string;
}

export interface MomentWithState extends Moment {
  state: MomentState;
}

const MOMENTS = momentsJson as unknown as Record<string, MomentEntry>;

const DAY_MS = 86_400_000;

/**
 * The lifecycle computation, pure and clock-injectable so tests can pin it.
 * `statusFor` maps a vehicle slug to its current bill status (undefined when
 * the slug is unknown — an unknown vehicle can never read as terminal, so a
 * broken slug fails toward "live", where CI and review will catch it, never
 * toward a silent "settled").
 *
 * Precedence: retired (owner decision) > settled (the normal death) > stale
 * (review_by elapsed) > live. An unparseable review_by fails toward 'stale',
 * the same fail-toward-caveat posture as lib/freshness-state.ts.
 */
export function computeMomentState(
  moment: Pick<MomentEntry, 'status' | 'vehicles' | 'review_by'>,
  statusFor: (slug: string) => string | undefined,
  now: number = Date.now(),
): MomentState {
  if (moment.status === 'retired') return 'retired';
  const statuses = moment.vehicles.map((v) => statusFor(v.slug));
  const settled =
    statuses.length > 0 && statuses.every((s) => s !== undefined && TERMINAL_STATUSES.has(s));
  if (settled) return 'settled';
  const reviewBy = new Date(moment.review_by).getTime();
  // The review_by day itself still counts as reviewed; stale starts the day after.
  if (!Number.isFinite(reviewBy) || now >= reviewBy + DAY_MS) return 'stale';
  return 'live';
}

const corpusStatus = (slug: string): string | undefined => getBill(slug)?.status;

function withState(id: string, entry: MomentEntry, now: number): MomentWithState {
  return { id, ...entry, state: computeMomentState(entry, corpusStatus, now) };
}

/** Every moment in the file, states computed against the live corpus. */
export function getMoments(now: number = Date.now()): MomentWithState[] {
  return Object.entries(MOMENTS).map(([id, entry]) => withState(id, entry, now));
}

/** The moments the indexes and the homepage strip promote. */
export function getLiveMoments(now: number = Date.now()): MomentWithState[] {
  return getMoments(now).filter((m) => m.state === 'live');
}

export function getMoment(id: string, now: number = Date.now()): MomentWithState | undefined {
  const entry = MOMENTS[id];
  return entry ? withState(id, entry, now) : undefined;
}

/** True when every vehicle of the moment is in a terminal status — the
 *  "this fight is settled" rendering. Unknown ids are not settled. */
export function isSettled(id: string, now: number = Date.now()): boolean {
  return getMoment(id, now)?.state === 'settled';
}

/**
 * The visibility rule for the bill → moment backlink, pure and
 * fixture-testable (the same split as computeMomentState above: the rule is
 * pinned by tests/moments-backlink.unit.spec.ts, the corpus binding is not).
 *
 * live + stale only. A settled question would send a reader who came to make
 * a call to a page that opens "this is over" — the backlink is a live route,
 * not an archive cross-reference — and retired is the owner's decision to
 * take a moment off every surface. Stale STAYS: the review tripwire already
 * renders its own caveat on the moment page, and silently withdrawing the
 * route as well would be a second editorial act nobody asked for. Same
 * live-or-stale set /questions's own index section uses.
 */
export function momentsForBill(moments: MomentWithState[], slug: string): MomentWithState[] {
  return moments.filter(
    (m) =>
      (m.state === 'live' || m.state === 'stale') && m.vehicles.some((v) => v.slug === slug)
  );
}

/**
 * The moments a bill is a vehicle of (repositioning spec §7.2) — the bill
 * page's "part of a bigger question" line.
 *
 * Computed at read time over the same getMoments() every other surface
 * reads, deliberately NOT a build-time reverse index: an index would freeze
 * the state this file's header exists to keep unfrozen, and a moment that
 * settles overnight would keep backlinking until somebody remembered to
 * rebuild it. The corpus is ≤6 moments with a handful of vehicles each, so
 * the scan is free.
 */
export function getMomentsForBill(slug: string, now: number = Date.now()): MomentWithState[] {
  return momentsForBill(getMoments(now), slug);
}
