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

export type QualifyingSignalType = 'tier0_floor' | 'tier0_scheduled' | 'tier0_most_viewed' | 'press';

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
