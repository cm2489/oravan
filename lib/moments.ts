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
import { getNomination } from './core/nominations';
import { TERMINAL_NOMINATION_STATUSES } from './nomination-status.mjs';
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
  /* FLOOR ACTION, which is not calendar placement — added 2026-08-09 after
     two live moments printed "On the floor schedule" over records whose
     LATEST action was a motion on the floor (S.4668: cloture motion on the
     motion to proceed presented 2026-08-05; S.4784: motion to proceed made
     2026-07-27). Both had been placed on the Senate calendar earlier, on
     June 24 and June 15 — a true past fact and a false present tense, and
     one that had aged out of the 45-day window the same page prints two
     paragraphs below the chip. The bill corpus already draws this line:
     `statusKeyFor` in lib/journey.ts returns `floor_activity` rather than
     `floor_vote` when the last action of a floor_vote bill does not say a
     chamber placed it on a calendar, so the vehicle card on those two pages
     read "Floor activity" while the signal chip above it claimed a schedule.
     One record, two labels, one of them wrong. Chamber-NEUTRAL on purpose,
     unlike `tier0_exec_calendar` below, whose calendar only the Senate has:
     the House takes floor action too, and a Senate-only label over a House
     record would be the exact falsehood this type exists to retire.

     NOTE FOR THE NEXT EDITOR: scripts/check-moments.mjs reads this array out
     of the source text and treats every single-quoted span inside it as a
     member, so comments in here carry no apostrophes and no quoted code. */
  'tier0_floor_action',
  'tier0_scheduled',
  'tier0_most_viewed',
  /* The nomination analogue of `tier0_floor`, added 2026-08-06 with the
     nomination surface. A bill reaching a floor calendar and a nomination
     reaching the Senate EXECUTIVE Calendar are the same class of fact — the
     chamber has scheduled it for itself — but they are different calendars
     with different names, and folding a nomination into `tier0_floor` would
     make the label on /questions ("On the floor schedule") false about the
     record it stands over. Same reason the two corpora are two files. */
  'tier0_exec_calendar',
  'press',
] as const;

export type QualifyingSignalType = (typeof QUALIFYING_SIGNAL_TYPES)[number];

export interface QualifyingSignal {
  type: QualifyingSignalType;
  /** Clickable evidence for the reviewer — tier-0 feed items or ≥2 lean-diverse articles. */
  refs: string[];
}

/**
 * What KIND of thing a moment's vehicle is — the discriminator that decides
 * which corpus its slug resolves in, which terminal-status set ends its life,
 * and (see lib/journey.ts's VOTING_CHAMBERS) which chamber can vote on it.
 *
 * MUST match lib/moments-gate.mjs's VEHICLE_KINDS — pinned equal by
 * tests/moments.unit.spec.ts AND asserted at runtime by
 * scripts/check-moments.mjs, the same belt-and-braces the terminal-status and
 * signal-type sets get. The gate keeps its own copy because that module stays
 * import-free (see its header).
 *
 * The two namespaces are structurally disjoint — every bill slug is
 * `hr-…`/`s-…`/`hjres-…`/`sjres-…`/`hconres-…`/`sconres-…`, every nomination
 * slug is `pn-…` (lib/core/nominations.ts) — so a mis-kinded vehicle cannot
 * silently resolve against the wrong corpus. It fails the gate loudly.
 */
export const VEHICLE_KINDS = ['bill', 'nomination'] as const;

export type VehicleKind = (typeof VEHICLE_KINDS)[number];

export interface MomentVehicle {
  /** The vehicle's identifier in ITS corpus: a bill's `full_identifier` in
   *  data/bills.json, or a nomination's slug in data/nominations.json. The
   *  moment may not exist without one that resolves. */
  slug: string;
  /** What a yes vote does and what a no vote does, in parallel neutral clauses. */
  role: Localized;
  /**
   * OPTIONAL ON THE WIRE, and absent means 'bill'.
   *
   * That default is the whole no-migration guarantee: every vehicle authored
   * before 2026-08-06 is a bill, so the field simply does not appear in
   * data/moments.json and does not need to. Making it required would force a
   * rewrite of the file for zero information gained, and would put a
   * hand-editable `kind: "bill"` on every future entry for a reader to get
   * wrong. Never make it required.
   *
   * Read it through `vehicleKind()` below, never directly — that is what
   * keeps "absent means bill" stated exactly once.
   */
  kind?: VehicleKind;
}

/**
 * THE ONE normalizer. Every consumer — the lifecycle computation, the gate's
 * slug resolution, the index card's freshness date, the collector's scope
 * filter — goes through this, so the "absent means bill" rule lives in one
 * place instead of being re-derived (and eventually re-derived WRONG) at each
 * call site.
 */
export const vehicleKind = (v: Pick<MomentVehicle, 'kind'>): VehicleKind => v.kind ?? 'bill';

/**
 * The terminal-status set that ends a vehicle's life, BY KIND. There is no
 * one set: `confirmed` ends a nomination and means nothing on a bill, `signed`
 * ends a bill and means nothing on a nomination. Reusing either set across
 * kinds would make a finished vehicle read as live forever — the manufactured
 * urgency this product refuses — so the lookup is explicit and total over
 * VEHICLE_KINDS (TypeScript fails the build if a kind is added without one).
 */
const TERMINAL_STATUSES_BY_KIND: Record<VehicleKind, ReadonlySet<string>> = {
  bill: TERMINAL_STATUSES,
  nomination: TERMINAL_NOMINATION_STATUSES,
};

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
 * `statusFor` maps a VEHICLE (not a bare slug — the slug alone cannot say
 * which corpus to look in) to its current status, returning undefined when
 * the slug is unknown. An unknown vehicle can never read as terminal, so a
 * broken slug fails toward "live", where CI and review will catch it, never
 * toward a silent "settled".
 *
 * Terminality is per-kind: a bill dies at signed/vetoed, a nomination at
 * confirmed/returned/withdrawn (TERMINAL_STATUSES_BY_KIND above). The two
 * vocabularies do not overlap, so asking the wrong set would answer "not
 * terminal" for every finished vehicle.
 *
 * Precedence: retired (owner decision) > settled (the normal death) > stale
 * (review_by elapsed) > live. An unparseable review_by fails toward 'stale',
 * the same fail-toward-caveat posture as lib/freshness-state.ts.
 */
export function computeMomentState(
  moment: Pick<MomentEntry, 'status' | 'vehicles' | 'review_by'>,
  statusFor: (vehicle: MomentVehicle) => string | undefined,
  now: number = Date.now(),
): MomentState {
  if (moment.status === 'retired') return 'retired';
  const settled =
    moment.vehicles.length > 0 &&
    moment.vehicles.every((v) => {
      const status = statusFor(v);
      return status !== undefined && TERMINAL_STATUSES_BY_KIND[vehicleKind(v)].has(status);
    });
  if (settled) return 'settled';
  const reviewBy = new Date(moment.review_by).getTime();
  // The review_by day itself still counts as reviewed; stale starts the day after.
  if (!Number.isFinite(reviewBy) || now >= reviewBy + DAY_MS) return 'stale';
  return 'live';
}

/*
 * The corpus binding, kind-dispatched. data/nominations.json (~520 KB) is
 * imported DIRECTLY from lib/core/nominations rather than through the
 * lib/core barrel — exactly as that module's header prescribes — so the
 * bundles that never touch moments (the MCP route among them) still never
 * see it.
 *
 * It is wired here in the same change that taught scripts/check-moments.mjs
 * to accept a nomination vehicle, and that pairing is deliberate: a gate that
 * admits a vehicle the reader cannot resolve would let a CONFIRMED nomination
 * read as live forever, which is the exact failure this file's header exists
 * to prevent. Gate and reader learn the kind together or neither does.
 */
const corpusStatus = (vehicle: MomentVehicle): string | undefined =>
  vehicleKind(vehicle) === 'nomination'
    ? getNomination(vehicle.slug)?.status
    : getBill(vehicle.slug)?.status;

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
 *
 * The kind guard on the vehicle match is a no-op TODAY — the two namespaces
 * are structurally disjoint, so a `pn-…` slug can never equal a bill's
 * full_identifier — and it is written down anyway, because "which KIND of
 * backlink is this" stops being obvious the moment a moment can carry either.
 * The invariant belongs in the code that depends on it, not in the reader's
 * head.
 */
export function momentsForVehicle(
  moments: MomentWithState[],
  slug: string,
  kind: VehicleKind
): MomentWithState[] {
  return moments.filter(
    (m) =>
      (m.state === 'live' || m.state === 'stale') &&
      m.vehicles.some((v) => v.slug === slug && vehicleKind(v) === kind)
  );
}

/** The bill-kind backlink — the shape tests/moments-backlink.unit.spec.ts
 *  pins, kept as its own name because that is what every bill-side caller
 *  reads and because "for a bill" is the claim those call sites are making. */
export function momentsForBill(moments: MomentWithState[], slug: string): MomentWithState[] {
  return momentsForVehicle(moments, slug, 'bill');
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

/**
 * The same backlink for a SENATE NOMINATION — the nomination page's "part of
 * a bigger question" line, and (see app/[locale]/nominations/[slug]/page.tsx)
 * the thing that decides whether that page is part of this site's curated
 * index or merely a reachable record.
 */
export function getMomentsForNomination(
  slug: string,
  now: number = Date.now()
): MomentWithState[] {
  return momentsForVehicle(getMoments(now), slug, 'nomination');
}
