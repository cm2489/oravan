/*
 * BILL FIXTURES BY PROPERTY, NEVER BY SLUG.
 *
 * The bill-page and call-flow specs used to name their bills — hr-5582-119,
 * sjres-99-119, sconres-38-119 and friends — and warned in their own comments
 * that "a corpus refresh that breaks one breaks all of them together". Every
 * helper here asks the committed corpus instead for the first bill with the
 * property a test is actually about, through the SAME functions the page
 * renders with (lib/core for the record and its Spanish overlay, lib/journey
 * for the stepper), so a fixture can never disagree with the page about what
 * it is.
 *
 * `referenceBill()` throws when the corpus holds nothing that fits: a decoded
 * bill sitting in committee is the corpus's most common state, and its absence
 * would mean the corpus is broken, not quiet. Every other helper returns null
 * for its spec to skip with a reason — a concurrent resolution or a signed law
 * can genuinely be absent (a fresh Congress starts with none), and a skip that
 * says so is honest where a 404 on a named slug is not.
 *
 * tests/corpus.ts stays the time-parameterised mirror of the ranking pools;
 * this file is plain selection, and reads the clock in one place
 * (`floorActivityBill`), guarded by that file's `CLOCK_SKEW_MS`.
 */
import floorSignalsJson from '../data/floor-signals.json';
import votesJson from '../data/votes.json';
import { billSlug, getAllBills, getBill, localizeBill } from '../lib/core';
import { formatCitation } from '../lib/format';
import {
  billFloorBand,
  deriveJourney,
  statusKeyFor,
  type JourneyEnding,
  type JourneyState,
} from '../lib/journey';
import type { Bill, RollCall } from '../lib/types';
import { CLOCK_SKEW_MS } from './corpus';

export interface BillFixture {
  slug: string;
  /** The English record, as lib/core serves it. */
  bill: Bill;
  /** The same bill through the Spanish overlay the /es page renders. */
  es: Bill;
  /** What the stepper will say about it (lib/journey `deriveJourney`). */
  journey: JourneyState;
  /** "H.R. 5582" — lib/format's citation, the one the page prints. */
  citation: string;
  /** The ICU select values BillJourney passes: origin chamber and its opposite. */
  chamber: 'House' | 'Senate';
  other: 'House' | 'Senate';
}

function fixture(bill: Bill): BillFixture {
  const journey = deriveJourney(bill);
  const chamber = journey.origin === 'house' ? 'House' : 'Senate';
  return {
    slug: billSlug(bill),
    bill,
    es: localizeBill(bill, 'es'),
    journey,
    citation: formatCitation(bill.bill_type, bill.bill_number),
    chamber,
    other: chamber === 'House' ? 'Senate' : 'House',
  };
}

/** Any slug the chamber-schedule file names at all. The bill page swaps its
 *  status label for the schedule's own when one is live, so the quiet
 *  fixtures stay clear of every named slug rather than re-derive liveness. */
const SCHEDULED = new Set(
  Object.keys((floorSignalsJson as { signals?: Record<string, unknown> }).signals ?? {})
);

const hasEveryAnswer = (b: Bill) =>
  Boolean(b.ai_headline && b.ai_sections?.what && b.ai_sections.who && b.ai_sections.why && b.ai_sections.cost);

/**
 * THE QUIET, COMPLETE BILL PAGE: an ordinary bill (H.R. or S.) in committee,
 * decoded with all five answers — cost included — in BOTH languages, with a
 * Spanish headline of its own, named in no chamber schedule. Its stepper says
 * `nowCommittee` (a sentence with no clock), ends at the President's desk and
 * still shows the "if the other chamber changes it" trailer. Its call panel
 * routes nowhere in particular, so every member is listed in plain order.
 */
export function referenceBill(): BillFixture {
  const hit = getAllBills().find((b) => {
    if (b.bill_type !== 'hr' && b.bill_type !== 's') return false;
    if (SCHEDULED.has(billSlug(b)) || !hasEveryAnswer(b)) return false;
    const es = localizeBill(b, 'es');
    if (es === b || !es.ai_headline || es.ai_headline === b.ai_headline) return false;
    if (!es.ai_sections || es.ai_sections === b.ai_sections || !hasEveryAnswer(es)) return false;
    const j = deriveJourney(b);
    return j.nowKey === 'nowCommittee' && j.ending === 'president' && j.showTrailer;
  });
  if (!hit) throw new Error('no decoded committee-stage bill with every answer in both languages');
  return fixture(hit);
}

/** A bill the President signed — the stepper's completed journey. */
export function signedBill(): BillFixture | null {
  const hit = getAllBills().find((b) => b.ai_headline && deriveJourney(b).isLaw);
  return hit ? fixture(hit) : null;
}

/**
 * A vehicle whose fifth step is `ending`, with the trailer still ahead so the
 * sentence that explains the ending is on the page too. 'bothChambers' finds a
 * concurrent resolution; 'states' an Article V amendment proposal.
 */
export function billEndingAt(ending: Exclude<JourneyEnding, 'president'>): BillFixture | null {
  const hit = getAllBills().find((b) => {
    const j = deriveJourney(b);
    return j.ending === ending && j.showTrailer;
  });
  return hit ? fixture(hit) : null;
}

/** An ordinary joint resolution (a CRA disapproval, a continuing
 *  resolution…) — the vehicle type the Article V title test must leave on
 *  the presented path. */
export function jointResolutionToPresident(): BillFixture | null {
  const hit = getAllBills().find(
    (b) => (b.bill_type === 'hjres' || b.bill_type === 'sjres') && deriveJourney(b).ending === 'president'
  );
  return hit ? fixture(hit) : null;
}

/**
 * A decoded bill whose status label is `floor_activity` and whose page carries
 * no floor band — no schedule entry, and no pending motion fresh enough to
 * light one — so the credibility block prints the shared status key and
 * nothing stronger. The rail-zip C1 test is about exactly that routing: floor
 * ACTIVITY must never be printed as "On the floor calendar".
 *
 * The band is judged at the EARLY end of the clock-skew window: freshness only
 * ever expires, so no band then means no band whenever `next build` ran.
 */
export function floorActivityBill(): BillFixture | null {
  const early = Date.now() - CLOCK_SKEW_MS;
  const hit = getAllBills().find(
    (b) =>
      Boolean(b.ai_sections) &&
      !SCHEDULED.has(billSlug(b)) &&
      statusKeyFor(b.status, b.last_action_text, b.last_action_date) === 'floor_activity' &&
      billFloorBand(b, null, early) === null
  );
  return hit ? fixture(hit) : null;
}

const ROLL_CALLS = (votesJson as unknown as { rollCalls: RollCall[] }).rollCalls;

/**
 * A corpus bill whose stored roll calls are ALL in `chamber` — so its vote
 * record's newest entry is that chamber's, and the members strip can say the
 * other chamber has recorded nothing. Sorted by slug so the pick is stable
 * while the file only grows.
 */
export function billWithRollCallsOnlyIn(chamber: RollCall['chamber']): string | null {
  const chambers = new Map<string, Set<RollCall['chamber']>>();
  for (const r of ROLL_CALLS) {
    const set = chambers.get(r.bill) ?? new Set();
    set.add(r.chamber);
    chambers.set(r.bill, set);
  }
  const slug = [...chambers.entries()]
    .filter(([bill, set]) => set.size === 1 && set.has(chamber) && getBill(bill))
    .map(([bill]) => bill)
    .sort()[0];
  return slug ?? null;
}
