/*
 * THE MEMBERS PAGE'S LOOKUP, as plain data (2026-11-12).
 *
 * /reps used to render its members from its own address, /reps?zip=NNNNN
 * (and ?district=NY-12 after the street-address refinement). A web address
 * lands in the host's request logs, in browser history and in every link
 * someone shares, so the owner took the ZIP out of it on 2026-11-12 (CLAUDE.md
 * rule 1). The ZIP now reaches the server only in a POST body: the server
 * action in lib/members-action.ts reads it, calls membersFor() below, and
 * answers with this plain object, which components/RepsLookup.tsx renders.
 *
 * PLAIN DATA ON PURPOSE. With JavaScript off, Next.js hands an action's
 * return value to the HTML render as React form state, and it reaches the
 * browser through JSON.stringify. So nothing in a MembersResult may be a
 * React element, a function, a Date or a class instance: strings, numbers,
 * booleans, arrays and plain objects only.
 *
 * Pure over the baked JSON, like lib/core: nothing is logged or stored, and
 * the ZIP lives only for the length of the call.
 */
import {
  districtsForZip,
  repsForDistrict,
  specialElectionsFor,
  vacancyForDistrict,
  vacancySlug,
} from '@/lib/core';
import { parseDistrictParam } from '@/lib/district';
import type { Legislator, SeatElections } from '@/lib/types';

export interface MembersDistrict {
  state: string;
  district: number;
  /** House member first, then the senators (repsForDistrict's order). */
  reps: Legislator[];
  /** The vacant seat's page, when the House seat has no occupant. */
  vacancyHref: string | null;
  elections?: SeatElections;
}

export interface MembersResult {
  /**
   * What the reader typed, trimmed and cut to 10 characters. A five-digit ZIP
   * whenever `districts` is non-empty; anything else matched nothing.
   */
  zip: string;
  /** The districts shown: the one refined district, or every candidate. */
  districts: MembersDistrict[];
  /** True when a street address narrowed a split ZIP to one district. */
  refined: boolean;
  /** The refined district is not among the ZIP's own candidates. */
  refinedOutsideZip: boolean;
}

const ZIP_RE = /^\d{5}$/;

/**
 * The members for a ZIP, optionally narrowed to one district ("NY-12", the
 * only thing the street-address form keeps). null when there is no ZIP at
 * all, which is the page's prompt. The rules are the ones the page applied to
 * its address before 2026-11-12, unchanged: a district that names no actual
 * House seat, or arrives without a valid ZIP, is ignored and the ZIP's
 * candidate districts render as usual.
 */
export function membersFor(rawZip: string | null | undefined, rawDistrict?: string | null): MembersResult | null {
  const zip = (rawZip ?? '').trim().slice(0, 10);
  if (!zip) return null;
  const valid = ZIP_RE.test(zip);
  const candidates = valid ? districtsForZip(zip) : [];
  const parsed = valid ? parseDistrictParam(rawDistrict ?? undefined) : null;
  const refined = parsed && repsForDistrict(parsed).some((r) => r.type === 'rep') ? parsed : null;
  const refinedOutsideZip =
    !!refined &&
    candidates.length > 0 &&
    !candidates.some((c) => c.state === refined.state && c.district === refined.district);
  const shown = refined ? [refined] : candidates;
  return {
    zip,
    districts: shown.map((d) => {
      const vacancy = vacancyForDistrict(d);
      const elections = vacancy ? specialElectionsFor(vacancy) : undefined;
      return {
        state: d.state,
        district: d.district,
        reps: repsForDistrict(d),
        vacancyHref: vacancy ? `/reps/${vacancySlug(vacancy)}` : null,
        ...(elections ? { elections } : {}),
      };
    }),
    refined: !!refined,
    refinedOutsideZip,
  };
}
