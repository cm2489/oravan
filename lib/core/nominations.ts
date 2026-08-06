/*
 * Senate nomination data access — pure functions over the baked JSON corpus,
 * mirroring lib/core/bills.ts exactly: no 'server-only' coupling, so a route
 * handler or a future agent surface can import it the same way a page can.
 *
 * NAMING: "nomination" here always means a SENATE NOMINATION (a presidential
 * nomination, PN, sent to the Senate for advice and consent). It is unrelated
 * to the "domain nomination" family in lib/embed-referrer.ts and
 * scripts/check-key-namespaces.mjs, which is an embed-privacy mechanism for
 * referrer domains. See lib/nomination-status.mjs's header.
 *
 * DELIBERATELY NOT RE-EXPORTED FROM lib/core/index.ts. That barrel exists so
 * `import { x } from '@/lib/core'` gets everything lib/data.ts used to
 * export; adding this module would pull data/nominations.json (~520 KB) into
 * every bundle that touches the barrel — including the MCP route, which
 * renders no nomination and should carry none of this. Callers import
 * 'lib/core/nominations' directly, exactly as the barrel's own header
 * describes for the rep-only case. The reason held when nothing rendered a
 * nomination and it holds now that something does: the cost of the barrel is
 * paid by every bundle, and only the nomination surfaces need the corpus.
 *
 * WHO IMPORTS THIS, AND WHY (amended 2026-08-06, second time — this header
 * has now been wrong twice about its own reach, first reading "NOTHING IN THE
 * APP IMPORTS THIS YET" and then "Nothing RENDERS a nomination yet". Both
 * stopped being true in the same day's work; a stale law is how the next
 * drift gets justified, so if you add a caller, amend this list in the same
 * change):
 *
 *   VALUES —
 *     app/[locale]/nominations/[slug]/page.tsx  the nomination page itself
 *     app/api/script/route.ts                   the nomination call script
 *     app/[locale]/questions/[id]/page.tsx      a nomination VEHICLE's card
 *     app/sitemap.ts                            the page's sitemap entry
 *     lib/moments.ts, lib/moments-ui.ts         status + callability lookups
 *
 *   TYPES ONLY (no data/nominations.json in their bundles) —
 *     lib/journey.ts, lib/nomination-script.ts, components/MomentNominationCard.tsx
 *
 * Still true, and the part that keeps the moments lookups honest: NO MCP TOOL
 * exposes a nomination, and no moment in data/moments.json carries one — so
 * lib/moments.ts's and lib/moments-ui.ts's lookups are unreached on today's
 * corpus. They are wired because the CI gate now accepts such a vehicle, and
 * a gate that admits a record the reader cannot resolve would let a confirmed
 * nomination read as live forever.
 */
import nominations from '@/data/nominations.json';
import {
  NOMINATION_STATUSES,
  STORED_NOMINATION_STATUSES,
  TERMINAL_NOMINATION_STATUSES,
  execCalendarNumber,
  isTerminalNominationStatus,
  mapNominationStatus,
} from '../nomination-status.mjs';

export {
  NOMINATION_STATUSES,
  STORED_NOMINATION_STATUSES,
  TERMINAL_NOMINATION_STATUSES,
  execCalendarNumber,
  isTerminalNominationStatus,
  mapNominationStatus,
};

/**
 * One of the nine classified statuses, or `unclassified` — the honest verdict
 * when no rule in lib/nomination-status.mjs matches the record sentence.
 * Surfaces MUST render `unclassified` as neutral, claim-free copy; see that
 * module's header and lib/journey.ts's floorActionChamber rule 7.
 *
 * Typed as a string union rather than derived from the .mjs constant because
 * that module is plain JS with JSDoc — the union is the TS-side pin, and
 * tests/nomination-status.unit.spec.ts asserts the two agree.
 */
export type NominationStatus =
  | 'received'
  | 'hearing'
  | 'reported'
  | 'exec_calendar'
  | 'floor'
  | 'scheduled'
  | 'confirmed'
  | 'returned'
  | 'withdrawn'
  | 'unclassified';

/** One civilian Senate nomination, as stored in data/nominations.json. */
export interface Nomination {
  /** Congress.gov's own citation and the record's identity, e.g. "PN730-18". */
  citation: string;
  congress_number: number;
  /** The PN number. NOT unique on its own — see `part_number`. */
  pn_number: number;
  /** Zero-padded part, verbatim from the API ("00" when unpartitioned). A
   *  single presidential message nominating many people is split into parts
   *  that all share one `pn_number`, so identity is (number, part). */
  part_number: string;
  /** Congress.gov's official description sentence, verbatim — never
   *  rewritten, summarized, or AI-touched. Null for the 14 civilian records
   *  (all Foreign Service promotion lists) that carry none. */
  nominee_description: string | null;
  /** The receiving agency or body, e.g. "The Judiciary". */
  organization: string | null;
  /** When the Senate received the nomination. */
  received_date: string | null;
  last_action_date: string | null;
  last_action_text: string | null;
  status: NominationStatus;
  /** The Senate Executive Calendar number, when the record prints one. Null
   *  on "Calendar No. DESK" (assigned-later placeholder), on the
   *  Privileged-Nomination-section placement (no number at all), and on
   *  every non-placement sentence. */
  exec_calendar_number: number | null;
  update_date: string | null;
  congress_gov_url: string;
}

const NOMINATIONS = nominations as Nomination[];

/**
 * The corpus slug: `pn-{number}-{part}-{congress}`, with the part omitted
 * when zero — `pn-730-18-119`, `pn-932-119`. Reproduces the citation's own
 * arithmetic (leading zeros stripped: partNumber "02" cites as "PN730-2").
 *
 * The `pn-` prefix keeps this namespace structurally disjoint from every bill
 * slug (`hr-…`, `s-…`, `hjres-…`, `sjres-…`, `hconres-…`, `sconres-…`), so
 * the two can share a map without collision. Kept identical to
 * scripts/nominations-fetch.mjs's nominationSlug by
 * tests/nomination-status.unit.spec.ts, which compares the two over the
 * whole committed corpus.
 */
export function nominationSlug(
  n: Pick<Nomination, 'pn_number' | 'part_number' | 'congress_number'>
): string {
  const part = Number(n.part_number ?? 0);
  const base = `pn-${n.pn_number}`;
  return (Number.isInteger(part) && part > 0 ? `${base}-${part}` : base) + `-${n.congress_number}`;
}

export function getNomination(slug: string): Nomination | undefined {
  return NOMINATIONS.find((n) => nominationSlug(n) === slug);
}

export function getAllNominations(): Nomination[] {
  return NOMINATIONS;
}

/**
 * Nominations still inside the advice-and-consent window — the only ones a
 * call could bear on. Confirmed, returned, and withdrawn are past it.
 */
export function getPendingNominations(): Nomination[] {
  return NOMINATIONS.filter((n) => !isTerminalNominationStatus(n.status));
}
