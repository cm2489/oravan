import { settledDecision } from './journey';
import type { Bill } from './types';

/*
 * WHAT A CONCURRENT RESOLUTION CAN AND CANNOT DO — the reading behind the
 * explainer that follows an adopted concurrent resolution's line
 * (components/ConcurrentExplainer.tsx).
 *
 * The owner, 2026-09-29, reviewing #368 (H.Con.Res. 86 shown as adopted by
 * both chambers): "What is a concurrent resolution? Add to glossary. We are
 * still at war and this didn't stop the president. It's now September and
 * this passed in June. This needs more explaination because it's confusing."
 *
 * So wherever an adopted concurrent resolution's line is printed — the bill
 * page's record-only panel, its Big Question vehicle card, and the member
 * page's "Right now:" line — one explainer follows it. It says two things,
 * and only two:
 *
 *   1. THE GENERAL TRUTH, for every concurrent resolution both chambers
 *      adopted: it states where both chambers stand, it isn't a law and it
 *      doesn't go to the president (senate.gov, "Types of Legislation":
 *      "do not require the signature of the president and do not have the
 *      force of law").
 *   2. THE WAR POWERS ROUTE, ONLY WHEN THE RECORD SAYS SO. When the measure's
 *      OFFICIAL TITLE invokes section 5(c) of the War Powers Resolution
 *      (50 U.S.C. 1544(c)), a disclosure, "Does this bind the president?",
 *      says what section 5(c) provides, what the Supreme Court held in 1983
 *      in INS v. Chadha, and that the Congressional Research Service calls
 *      section 5(c) "constitutionally suspect", and links the CRS report.
 *      H.Con.Res. 86's title reads "Directing the President, pursuant to
 *      section 5(c) of the War Powers Resolution, to remove United States
 *      Armed Forces from hostilities with Iran."; its enrolled text on
 *      govinfo.gov (BILLS-119hconres86enr) says the same.
 *
 * WHAT IT WILL NOT SAY. Whether the United States is at war, what forces are
 * doing, or whether the president has complied: none of that is in the
 * record. It explains what the resolution can and cannot do, and stops.
 *
 * WHICH RECORDS. Only a concurrent resolution both chambers agreed to in one
 * form — `settledDecision` 'adopted', the same reading that puts the
 * record-only panel on the page (lib/journey.ts). A concurrent resolution
 * that failed, or that one chamber has agreed to, gets the glossary term on
 * its page (the kind of measure it is) and no explainer: nothing was adopted
 * to explain.
 */

/** The record's two concurrent-resolution types. */
const CONCURRENT_TYPES: ReadonlySet<string> = new Set(['hconres', 'sconres']);

/** Is this record a concurrent resolution (H.Con.Res. or S.Con.Res.)? */
export function isConcurrentResolution(bill: Pick<Bill, 'bill_type'>): boolean {
  return CONCURRENT_TYPES.has(String(bill.bill_type).toLowerCase());
}

/**
 * Does the OFFICIAL TITLE invoke section 5(c) of the War Powers Resolution?
 * Read off the record's own words ("pursuant to section 5(c) of the War
 * Powers Resolution"), never off the AI summary: a summary that says "War
 * Powers" about a joint resolution under section 1013 of the 1984 State
 * Department authorization is a different route, which goes to the president.
 */
const WAR_POWERS_5C = /\bsection 5\(c\) of the War Powers Resolution\b/i;

export function invokesWarPowers5c(bill: Pick<Bill, 'title'>): boolean {
  return WAR_POWERS_5C.test(bill.title ?? '');
}

/** What the explainer prints for one record. */
export interface ConcurrentReading {
  /** The War Powers sentence and its CRS source print only when true. */
  warPowers5c: boolean;
}

/**
 * The explainer's reading for a record, or null when it gets none: anything
 * but a concurrent resolution both chambers agreed to in one form.
 */
export function adoptedConcurrentReading(bill: Parameters<typeof settledDecision>[0] & Pick<Bill, 'title'>): ConcurrentReading | null {
  if (!isConcurrentResolution(bill)) return null;
  if (settledDecision(bill)?.kind !== 'adopted') return null;
  return { warPowers5c: invokesWarPowers5c(bill) };
}

/**
 * THE SOURCE for the War Powers sentence. Read 2026-09-29 on congress.gov
 * (the current version, 17, dated March 8, 2019; author Matthew C. Weed).
 * Its "Legislative Veto" section: "Since Section 5(c) requires forces to be
 * removed by the President if Congress so directs by a concurrent
 * resolution, it is constitutionally suspect under the reasoning applied by
 * the Court." The page quotes two words of it. The URL is the report's
 * page as congress.gov serves it: the iran-war-powers Big Question cites the
 * same report as /crs-report/R42699 (data/moments.json `context_refs`),
 * which congress.gov redirects here.
 */
export const CRS_WAR_POWERS_REPORT = {
  url: 'https://www.congress.gov/crs-product/R42699',
  number: 'R42699',
  title: 'The War Powers Resolution: Concepts and Practice',
  /** The version's own date, as the report page prints it. */
  published: '2019-03-08',
} as const;
