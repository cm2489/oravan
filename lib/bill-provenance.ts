/*
 * WHAT A BILL PAGE SAYS ABOUT ITS OWN SOURCES — two record facts the page
 * never printed until the 2026-09-27 audit found them missing (SY-33, SY-25).
 * Pure functions: every lookup is passed in, so tests/copy-truth.unit.spec.ts
 * drives them with synthetic records and no corpus. Nothing here
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
  /**
   * The seat the member held WHEN THEY SPONSORED THIS BILL, in
   * data/legislators.json's vocabulary. Only a member of the originating
   * chamber can sponsor a bill, so it is read off the bill's own type
   * (`s…` Senate, `h…` House) — never off the roster's current seat, which
   * would print "Senator" on a member's old House bills after a move across
   * the Capitol. The roster's seat is the fallback only for a bill type this
   * does not recognise.
   */
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

/** The originating chamber's seat, from Congress.gov's bill type
 *  (`s`, `sres`, `sjres`, `sconres` / `hr`, `hres`, `hjres`, `hconres`). */
function sponsorSeat(billType: string): 'sen' | 'rep' | null {
  const t = billType.trim().toLowerCase();
  if (/^s(?:res|jres|conres)?$/.test(t)) return 'sen';
  if (/^h(?:r|res|jres|conres)$/.test(t)) return 'rep';
  return null;
}

/**
 * The bill's sponsor as the record names them, or null when no stored file
 * names the bioguide id. The id itself comes from Congress.gov via the nightly
 * sync (`sponsor_bioguide_id`); the name and state come from the same roster
 * files the member pages read, and the seat from the bill's own chamber.
 */
export function billSponsor(
  bill: Pick<Bill, 'sponsor_bioguide_id' | 'bill_type'>,
  lookups: SponsorLookups,
): BillSponsor | null {
  const id = bill.sponsor_bioguide_id;
  if (!id) return null;
  const seat = sponsorSeat(bill.bill_type ?? '');
  const sitting = lookups.legislator(id);
  if (sitting) {
    return { bioguide: id, name: sitting.name, type: seat ?? sitting.type, state: sitting.state, hasPage: true };
  }
  const former = lookups.formerMember(id);
  if (former?.name && former.state) {
    return {
      bioguide: id,
      name: former.name,
      type: seat ?? (former.chamber === 'senate' ? 'sen' : 'rep'),
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

export interface CommitteeChangedSince {
  /** The committee action's own date, `YYYY-MM-DD` (`last_action_date`). */
  date: string;
}

/**
 * A COMMITTEE ORDERING THE BILL REPORTED WITH CHANGES, matched on the
 * record's own words in `last_action_text`. Every shape below is one the
 * stored corpus holds (census 2026-09-27), and nothing else is matched:
 *
 *   House  "Ordered to be Reported (Amended) by …"
 *          "Ordered to be Reported in the Nature of a Substitute [(Amended)] by …"
 *          "Ordered to be Reported Unfavorably (Amended) by …"
 *          "Reported (Amended) by the Committee on … H. Rept. …"
 *   Senate "Committee on …. Ordered to be reported with an amendment
 *           [in the nature of a substitute] favorably." / "… with amendments …"
 *
 * Deliberately NOT matched: an order or report "without amendment" (the
 * Senate pattern needs "with an amendment" / "with amendments", which
 * "without amendment" never spells), a plain "Ordered to be Reported by …"
 * (no changes), "Forwarded by Subcommittee to Full Committee (Amended)" (the
 * full committee has not acted), "The committee substitute tabled" (set
 * aside, not adopted), and any report shape the corpus does not hold yet,
 * because an unseen shape cannot be checked against the record. A
 * committee's changes are PROPOSED until the chamber adopts them, which is
 * why the page says "with changes" and "may not reflect them", and never
 * that the bill's text changed.
 */
const COMMITTEE_CHANGED: readonly RegExp[] = [
  /^Ordered to be Reported (?:Unfavorably )?(?:\(Amended\)|in the Nature of a Substitute)/,
  /^Reported \(Amended\) by the Committee on /,
  /\bOrdered to be reported with (?:an amendment|amendments)\b/,
];

/**
 * The committee action that ordered this bill reported with changes AFTER
 * the day of the text the decode describes, or null.
 *
 * Only the LATEST action is stored (`last_action_text` / `last_action_date`),
 * so this sees a markup only while it is still the bill's latest step. Once
 * the reported text is published, the nightly sync's new-text re-decode
 * (scripts/sync-bills.mjs → scripts/bill-decode.mjs `redecodeBill`) moves the
 * stamp to it and this stops firing. Strictly after, and a dated source only,
 * for the same reasons as amendedSince.
 */
export function amendedInCommitteeSince(
  source: DecodeSource | null,
  bill: Pick<Bill, 'last_action_text' | 'last_action_date'>,
): CommitteeChangedSince | null {
  if (!source?.date) return null;
  const text = typeof bill.last_action_text === 'string' ? bill.last_action_text.trim() : '';
  const raw = typeof bill.last_action_date === 'string' ? bill.last_action_date : '';
  if (!text || !DAY_RE.test(raw)) return null;
  const day = raw.slice(0, 10);
  if (day <= source.date) return null;
  if (!COMMITTEE_CHANGED.some((re) => re.test(text))) return null;
  return { date: day };
}

export type ChangedSince =
  | ({ kind: 'floor' } & AmendedSince)
  | ({ kind: 'committee' } & CommitteeChangedSince);

/**
 * ONE QUIET LINE, not a list: of the two record facts that the decoded text
 * may be out of date, the page prints the newer. On the same day the recorded
 * floor vote wins, as the more specific fact.
 */
export function changedSince(
  floor: AmendedSince | null,
  committee: CommitteeChangedSince | null,
): ChangedSince | null {
  if (floor && (!committee || floor.date >= committee.date)) return { kind: 'floor', ...floor };
  if (committee) return { kind: 'committee', ...committee };
  return null;
}
