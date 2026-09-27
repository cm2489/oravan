/*
 * WHAT A BILL PAGE SAYS ABOUT ITS OWN SOURCES — two record facts the page
 * never printed until the 2026-09-27 audit found them missing (SY-33, SY-25).
 * Pure functions: every lookup is passed in, so tests/bill-provenance.unit
 * .spec.ts drives them with synthetic records and no corpus. Nothing here
 * fetches, writes, calls a model, or renders a string — the page maps every
 * field to a message key.
 *
 * NEVER A GUESS. Each helper returns null whenever the stored record does not
 * hold the fact, and a null prints nothing. That is the whole contract: a
 * missing line is an honest gap, a guessed line is a false claim.
 */
import type { Bill, Legislator, RollCall, VotingMember } from './types';

// ---- SY-33: the sponsor ----------------------------------------------------

export interface BillSponsor {
  bioguide: string;
  name: string;
  /** Senate or House seat, in data/legislators.json's own vocabulary. */
  type: 'sen' | 'rep';
  state: string;
  /**
   * True only when the member has a page on this site: /reps/[bioguide] is
   * generated from data/legislators.json, so a sponsor who has left Congress
   * is printed without a link rather than linked to a 404.
   */
  hasPage: boolean;
}

export interface SponsorLookups {
  /** The sitting roster (lib/core/reps.ts `getLegislator`). */
  legislator: (bioguide: string) => Pick<Legislator, 'bioguide' | 'name' | 'type' | 'state'> | undefined;
  /** Members named in a stored roll call (lib/votes.ts `votingMember`) — the
   *  join that still knows a name after a member leaves the roster. */
  formerMember: (bioguide: string) => VotingMember | undefined;
}

/**
 * The bill's sponsor as the record names them, or null when no stored file
 * names the bioguide id. The id itself comes from Congress.gov via the nightly
 * sync (`sponsor_bioguide_id`); the name, seat and state come from the same
 * roster files the member pages read.
 */
export function billSponsor(
  bill: Pick<Bill, 'sponsor_bioguide_id'>,
  lookups: SponsorLookups,
): BillSponsor | null {
  const id = bill.sponsor_bioguide_id;
  if (!id) return null;
  const sitting = lookups.legislator(id);
  if (sitting) {
    return { bioguide: id, name: sitting.name, type: sitting.type, state: sitting.state, hasPage: true };
  }
  const former = lookups.formerMember(id);
  if (former?.name && former.state) {
    return {
      bioguide: id,
      name: former.name,
      type: former.chamber === 'senate' ? 'sen' : 'rep',
      state: former.state,
      hasPage: false,
    };
  }
  return null;
}

// ---- SY-25: which text the decode describes --------------------------------

export interface DecodeSource {
  /** Congress.gov's own name for the text version, English verbatim
   *  ("Reported to Senate", "Enrolled Bill"). */
  version: string;
  /** The version's calendar day, `YYYY-MM-DD`, or null when Congress.gov
   *  dates it with nothing (it serves `Enrolled Bill` with `date: null`). */
  date: string | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * The text version the stored decode was produced from, or null when the
 * record does not say.
 *
 * `text_version_type` / `text_version_date` are written ONLY at decode time
 * (scripts/bill-decode.mjs `completeDecode` / `redecodeBill`, via
 * scripts/text-version.mjs `textVersionStamp`), from the version actually
 * read — or, on the no-spend path, from a version whose text was proven
 * byte-identical as model input to the one the decode was written from. So
 * the stamp names the text the decode describes. Every bill decoded before
 * that stamp existed carries neither field, and gets no line: unknown is not
 * the same as old, and it is never printed as either.
 */
export function decodeSource(
  bill: Pick<Bill, 'ai_summary' | 'ai_sections' | 'text_version_type' | 'text_version_date'>,
): DecodeSource | null {
  if (!bill.ai_summary && !bill.ai_sections) return null;
  const version = typeof bill.text_version_type === 'string' ? bill.text_version_type.trim() : '';
  if (!version) return null;
  const raw = typeof bill.text_version_date === 'string' ? bill.text_version_date : '';
  return { version, date: DAY_RE.test(raw) ? raw.slice(0, 10) : null };
}

export interface AmendedSince {
  chamber: 'house' | 'senate';
  /** The roll call's own date, `YYYY-MM-DD`. */
  date: string;
  roll: number;
  source: string;
}

/**
 * A FLOOR AMENDMENT TO THE BILL ITSELF, AGREED TO. The one shape of that fact
 * the stored roll calls carry today, matched on the record's own words: the
 * Senate's result "Amendment Agreed to" on a question naming exactly one
 * amendment ("On the Amendment S.Amdt. 6776 to S. 4668"). A question that
 * names a second amendment ("… S.Amdt. 2 to S.Amdt. 1 to H.R. 1") amends
 * the AMENDMENT, not the bill, and may yet fall with it, so it is excluded.
 *
 * Deliberately NOT matched, because none of them is a stored fact that the
 * bill's text changed after the decoded version: House "…Pass, as Amended"
 * (the amendment it adopts can be the committee amendment the reported text
 * already carries, and the record line does not say which), a motion to
 * table, a cloture vote, and anything adopted by voice vote or unanimous
 * consent (data/votes.json holds recorded votes only). An unrecognised shape
 * prints nothing.
 */
function isAgreedAmendmentToBill(r: Pick<RollCall, 'chamber' | 'question' | 'result'>): boolean {
  if (r.chamber !== 'senate') return false;
  if (r.result.trim() !== 'Amendment Agreed to') return false;
  const amendments = r.question.match(/\b[SH]\.Amdt\./g) ?? [];
  return /^On the Amendment\b/.test(r.question) && amendments.length === 1;
}

/**
 * The newest recorded vote agreeing to an amendment to this bill AFTER the
 * day of the text the decode describes, or null.
 *
 * Strictly after: a vote on the version's own day cannot be ordered against
 * the version from dates alone, so it is not claimed. No dated source, no
 * claim either — "since that text" needs a day to be since.
 *
 * @param rollCalls this bill's stored roll calls (lib/votes.ts `votesForBill`)
 */
export function amendedSince(
  source: DecodeSource | null,
  rollCalls: readonly Pick<RollCall, 'chamber' | 'question' | 'result' | 'date' | 'roll' | 'source'>[],
): AmendedSince | null {
  if (!source?.date) return null;
  let best: AmendedSince | null = null;
  for (const r of rollCalls) {
    if (!DAY_RE.test(r.date) || r.date.slice(0, 10) <= source.date) continue;
    if (!isAgreedAmendmentToBill(r)) continue;
    if (!best || r.date > best.date || (r.date === best.date && r.roll > best.roll)) {
      best = { chamber: r.chamber, date: r.date.slice(0, 10), roll: r.roll, source: r.source };
    }
  }
  return best;
}
