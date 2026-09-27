/*
 * BILL FIXTURES BY PROPERTY, NEVER BY SLUG — derived from the committed
 * corpus; never a slug, a citation or a headline typed into a spec.
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
 * A spec that needs "a decoded bill still in committee" asks for one here and
 * reads its citation, headline and dates off the record it gets back. Naming a
 * bill instead meant a nightly re-sync that moved that one bill (a new action,
 * a re-decode, a status change) reddened every spec that named it at once, for
 * reasons that had nothing to do with what those specs protect. A derived
 * fixture simply picks the next bill that fits.
 *
 * `referenceBill()` and `decodedCommitteeBill()` throw when the corpus holds
 * nothing that fits: a decoded bill sitting in committee is the corpus's most
 * common state, and its absence would mean the corpus is broken, not quiet.
 * Every other helper returns null for its spec to skip with a reason — a
 * concurrent resolution or a signed law can genuinely be absent (a fresh
 * Congress starts with none), and a skip that says so is honest where a 404
 * on a named slug is not.
 *
 * The embed-card helpers (`decodedCommitteeBill`, `undecodedCommitteeBill`,
 * `esDecodedFloorActivityBill`) are plain shape queries picked in slug order,
 * so a run is deterministic for a given corpus.
 *
 * tests/corpus.ts stays the time-parameterised mirror of the ranking pools;
 * this file is plain selection, and reads the clock in one place
 * (`floorActivityBill`), guarded by that file's `CLOCK_SKEW_MS`.
 */
import billsEsJson from '../data/bills-es.json';
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
  /** "H.R. 5582" — lib/format's citation, the one the page and a card print. */
  citation: string;
  /** The ICU select values BillJourney passes: origin chamber and its opposite. */
  chamber: 'House' | 'Senate';
  other: 'House' | 'Senate';
  /** The English AI headline, or null for an undecoded bill. */
  headline: string | null;
  /** The Spanish AI headline from data/bills-es.json, or null — never the
   *  English fallback `es` carries when there is no Spanish decode. */
  esHeadline: string | null;
  /** What a card with no decode prints instead: short title, else title. */
  officialTitle: string;
  lastActionDate: string | null;
}

/** The Spanish decodes, keyed by slug — read raw so `esHeadline` is null
 *  when a bill has none, rather than the English headline localizeBill
 *  falls back to. */
const ES = billsEsJson as unknown as Record<string, { headline?: string | null }>;

function fixture(bill: Bill): BillFixture {
  const slug = billSlug(bill);
  const journey = deriveJourney(bill);
  const chamber = journey.origin === 'house' ? 'House' : 'Senate';
  return {
    slug,
    bill,
    es: localizeBill(bill, 'es'),
    journey,
    citation: formatCitation(bill.bill_type, bill.bill_number),
    chamber,
    other: chamber === 'House' ? 'Senate' : 'House',
    headline: bill.ai_headline,
    esHeadline: ES[slug]?.headline ?? null,
    officialTitle: bill.short_title ?? bill.title,
    lastActionDate: bill.last_action_date,
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

/*
 * THE EMBED-CARD FIXTURES. The same corpus lib/core serves, walked in slug
 * order so each pick is deterministic for a given corpus.
 */
const BILLS_BY_SLUG = [...getAllBills()].sort((a, b) => {
  const x = billSlug(a);
  const y = billSlug(b);
  return x < y ? -1 : x > y ? 1 : 0;
});

/**
 * True when searching the /embeds configurator for this bill's headline can
 * only return this bill: its filter matches the query as a substring of every
 * bill's citation, title and headline (components/EmbedConfigurator.tsx).
 */
function headlineIsUnique(b: Bill): boolean {
  const q = (b.ai_headline ?? '').toLowerCase();
  if (!q) return false;
  return (
    BILLS_BY_SLUG.filter(
      (o) =>
        formatCitation(o.bill_type, o.bill_number).toLowerCase().includes(q) ||
        (o.short_title ?? o.title).toLowerCase().includes(q) ||
        (o.ai_headline ?? '').toLowerCase().includes(q)
    ).length === 1
  );
}

/**
 * A DECODED bill whose card label is plain `committee` — a status with no
 * clock in it, so the label cannot change between the build and the
 * assertion — with a dated last action, and a headline no other bill's text
 * contains (so a search for it finds exactly this bill). The corpus holds
 * well over a thousand of these; finding none means the corpus itself is
 * broken, so this throws rather than skipping.
 */
export function decodedCommitteeBill(): BillFixture {
  const bill = BILLS_BY_SLUG.find(
    (b) => b.ai_headline && b.status === 'committee' && b.last_action_date && headlineIsUnique(b)
  );
  if (!bill) throw new Error('corpus holds no decoded committee bill with a unique headline');
  return fixture(bill);
}

/**
 * A bill with NO AI headline, in committee — the card prints its official
 * title and must never print the AI label. Rare (two bills on 2026-09-27), so
 * null when the corpus holds none and the caller skips with a reason.
 */
export function undecodedCommitteeBill(): BillFixture | null {
  const bill = BILLS_BY_SLUG.find((b) => !b.ai_headline && b.status === 'committee');
  return bill ? fixture(bill) : null;
}

/**
 * A decoded bill with a Spanish decode whose record is `floor_vote` but whose
 * last action names NO calendar — a rejected motion to proceed, a motion to
 * reconsider tabled — so the label gate (lib/journey.ts's statusKeyFor) must
 * print `floor_activity`, never `floor_vote`. That branch reads no clock.
 * Null when the corpus holds none.
 */
export function esDecodedFloorActivityBill(): BillFixture | null {
  const bill = BILLS_BY_SLUG.find(
    (b) =>
      b.ai_headline &&
      ES[billSlug(b)]?.headline &&
      b.status === 'floor_vote' &&
      statusKeyFor(b.status, b.last_action_text, b.last_action_date) === 'floor_activity'
  );
  return bill ? fixture(bill) : null;
}
