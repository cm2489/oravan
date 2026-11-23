/*
 * "AT A GLANCE" — THE BOX AT THE TOP OF A BIG QUESTION (design of 2026-09-26,
 * owner: "This box is great."; owner, 2026-11-22: bills "should be promoted,
 * and highlighted when a vote is coming soon").
 *
 * One bill leads the box, and every row in it is read from the stored record
 * (data/bills.json, data/votes.json, data/floor-signals.json). Nothing here is
 * AI-written and nothing is forecast (page 1, rule 6). Each row has an omit
 * rule: when the record cannot answer a row, the row is left out, never filled.
 *
 *   status line      the lead bill's own Big Questions status line, as every
 *                    other surface prints it (lib/moments-ui.ts
 *                    questionVehicles → lib/floor-session.ts
 *                    siteBillStatusLine): the chamber-session gate of
 *                    docs/record-truth.md §5 rides in it, so a floor claim is
 *                    live only while its chamber is meeting. No second reader.
 *   The bill         its citation and its record title, linked to its page.
 *   Votes so far     a count of the stored roll calls on the bill, by chamber,
 *                    and the newest one's recorded result, tally and date.
 *                    No stored roll call: the row is omitted.
 *   Vote on passage  `passageRow`: the recorded passage roll calls, or "Not
 *                    yet" only when the record shows no chamber has passed it.
 *                    A passage the roll-call file does not hold (a voice vote):
 *                    omitted.
 *   If it passes     `ifItPasses`: only where the next step follows from the
 *                    bill type and the stage on the record. Otherwise omitted.
 *   Call button      to the lead bill's call panel, worded for the chamber the
 *                    panel itself routes to (lib/journey.ts liveCallTarget,
 *                    through lib/bill-call-panel.ts). Never on a settled box.
 *   Members button   to how the reader's members voted, only where the linked
 *                    page prints it.
 *
 * WHICH BILL LEADS (`pickLeadBill`, the brief of 2026-11-22): the open bill
 * with the nearest floor date on the record (a chamber's own published
 * schedule naming it); else the open bill with the newest floor action; else
 * the open bill with the newest action. A settled question (no open bill)
 * leads with the bill whose line the question's own status already leads with.
 */
import type { Bill, RollCall } from './types';
import type { StatusLine, StatusLineKey } from './moment-status.mjs';
import { journeyEnding, settledDecision, type Chamber } from './journey';
import { getBill } from './core';
import { announcementFor } from './docket';
import { easternDay } from './eastern-day';
import { votesForBill } from './votes';
import type { QuestionVehicle } from './moments-ui';

/* ── Which bill leads ─────────────────────────────────────────────────── */

export interface LeadCandidate {
  slug: string;
  /** The day a chamber's own live published schedule names the bill for
   *  (lib/docket.ts announcementFor: `covers`, else `published`), or null. */
  floorDate: string | null;
  /** The newest floor action the record holds: its newest stored roll call,
   *  or its last action when that action is a floor action. */
  floorActionDate: string | null;
  /** The record's last action date. */
  actionDate: string | null;
}

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const valid = (d: string | null): d is string => typeof d === 'string' && Number.isFinite(dayMs(d));

/**
 * THE LEAD-BILL RULE. Ties keep the order the question lists its bills in.
 * `today` is a YYYY-MM-DD day; "nearest" is the smallest distance from it in
 * either direction (a live schedule is about this week, so it is near today).
 */
export function pickLeadBill<C extends LeadCandidate>(candidates: readonly C[], today: string): C | null {
  if (candidates.length === 0) return null;
  const t = dayMs(today);
  const firstBy = (pool: readonly C[], score: (c: C) => number): C | null => {
    let best: C | null = null;
    let bestScore = Infinity;
    for (const c of pool) {
      const s = score(c);
      if (s < bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return best;
  };
  const scheduled = candidates.filter((c) => valid(c.floorDate));
  if (scheduled.length > 0) return firstBy(scheduled, (c) => Math.abs(dayMs(c.floorDate!) - t));
  const floored = candidates.filter((c) => valid(c.floorActionDate));
  if (floored.length > 0) return firstBy(floored, (c) => -dayMs(c.floorActionDate!));
  const acted = candidates.filter((c) => valid(c.actionDate));
  if (acted.length > 0) return firstBy(acted, (c) => -dayMs(c.actionDate!));
  return candidates[0];
}

/** Status-line keys that report something a chamber did, or can do, on its
 *  floor. A committee step, a passage notice ("Received in the Senate") and
 *  the record's own words are not floor actions here. */
const FLOOR_LINE_KEYS: ReadonlySet<StatusLineKey> = new Set([
  'onFloor',
  'clotureFiled',
  'onCalendar',
  'passedOnCalendar',
  'failed',
  'failedReconsider',
]);

/** The newest floor action the record holds for one bill. */
export function floorActionDate(
  bill: Pick<Bill, 'status' | 'last_action_date'>,
  line: Pick<StatusLine, 'key'>,
  rollCalls: readonly Pick<RollCall, 'date'>[]
): string | null {
  const dates: string[] = [];
  for (const r of rollCalls) if (valid(r.date)) dates.push(r.date);
  if ((bill.status === 'floor_vote' || FLOOR_LINE_KEYS.has(line.key)) && valid(bill.last_action_date ?? null)) {
    dates.push(bill.last_action_date!);
  }
  return dates.sort().at(-1) ?? null;
}

/* ── Votes so far ─────────────────────────────────────────────────────── */

export interface RecordedVote {
  chamber: Chamber;
  date: string;
  /** Verbatim from the record ("Passed", "Cloture Motion Agreed to"). */
  result: string;
  yeas: number;
  nays: number;
}

export interface VotesSoFar {
  house: number;
  senate: number;
  newest: RecordedVote;
}

const recorded = (r: RollCall): RecordedVote => ({
  chamber: r.chamber,
  date: r.date,
  result: r.result,
  yeas: r.totals.yea,
  nays: r.totals.nay,
});

/** The stored roll calls, counted by chamber, with the newest one. Null when
 *  the file holds none for the bill: the row is omitted. `rollCalls` is
 *  newest first (lib/votes.ts votesForBill). */
export function votesSoFar(rollCalls: readonly RollCall[]): VotesSoFar | null {
  if (rollCalls.length === 0) return null;
  return {
    house: rollCalls.filter((r) => r.chamber === 'house').length,
    senate: rollCalls.filter((r) => r.chamber === 'senate').length,
    newest: recorded(rollCalls[0]),
  };
}

/* ── Vote on passage ──────────────────────────────────────────────────── */

/*
 * A vote to pass the measure, as the roll-call file words its question
 * (every shape measured over data/votes.json on 2026-11-22). The House's
 * "On Agreeing to the Resolution" counts only on the measure's own roll call
 * (the file files a rule's vote under the rule, not under the bill it makes
 * in order). A vote to concur in the other chamber's amendment is not a
 * passage vote and is not read here.
 */
const PASSAGE_QUESTION =
  /^\s*On (?:Passage\b|Motion to Suspend the Rules and Pass\b|Agreeing to the (?:Concurrent |Joint )?Resolution\b|the (?:Joint |Concurrent )?Resolution\b)/i;

export function isPassageVote(r: Pick<RollCall, 'question'>): boolean {
  return PASSAGE_QUESTION.test(r.question);
}

/** Status-line keys under which the record shows a chamber has passed it. */
const PASSED_KEYS: ReadonlySet<StatusLineKey> = new Set([
  'signed',
  'vetoed',
  'presented',
  'bothAgreed',
  'passedBack',
  'passedOnCalendar',
  'heldAtDesk',
  'passedWaiting',
]);
const NOT_PASSED_STATUSES = new Set(['introduced', 'committee', 'markup', 'floor_vote']);
/* A sentence that reports a chamber passing the measure, or agreeing to it.
   "Failed of passage" and a motion "agreed to" (to proceed, cloture) are not. */
const PASSAGE_WORDS =
  /\bpassed\b|\bresolution agreed to\b|\bagreed to (?:in (?:the )?(?:house|senate) )?(?:without|with an?) amendments?\b/i;
/* A recorded passage result that is not a passage. */
const FAILED_RESULT = /\b(?:failed|defeated|rejected|not agreed)\b/i;

/**
 * NO CHAMBER HAS PASSED IT, BY THE RECORD — every test must agree, so a
 * record that might hold a passage never reads as "Not yet": a pre-passage
 * status bucket, a status line that reports no passage, a last action (and
 * the sentence its status was read from) that does not report one, and no
 * stored passage roll call whose result is not a failure.
 */
export function noChamberHasPassed(
  bill: Pick<Bill, 'status' | 'last_action_text'> & { status_basis_text?: string | null },
  line: Pick<StatusLine, 'key'>,
  rollCalls: readonly RollCall[]
): boolean {
  if (!NOT_PASSED_STATUSES.has(bill.status)) return false;
  if (PASSED_KEYS.has(line.key)) return false;
  if (PASSAGE_WORDS.test(`${bill.last_action_text ?? ''} ${bill.status_basis_text ?? ''}`)) return false;
  return rollCalls.filter(isPassageVote).every((r) => FAILED_RESULT.test(r.result));
}

export type PassageRow = { kind: 'recorded'; votes: RecordedVote[] } | { kind: 'notYet' } | null;

/**
 * THE "VOTE ON PASSAGE" ROW.
 *   recorded  the newest stored passage roll call in each chamber, House
 *             first: its recorded result, tally and date;
 *   notYet    no stored passage roll call, and `noChamberHasPassed`;
 *   null      anything else (a passage the roll-call file does not hold, such
 *             as a voice vote): the row is omitted.
 */
export function passageRow(
  bill: Pick<Bill, 'status' | 'last_action_text'> & { status_basis_text?: string | null },
  line: Pick<StatusLine, 'key'>,
  rollCalls: readonly RollCall[]
): PassageRow {
  const passage = rollCalls.filter(isPassageVote);
  if (passage.length > 0) {
    const votes: RecordedVote[] = [];
    for (const chamber of ['house', 'senate'] as const) {
      const r = passage.find((x) => x.chamber === chamber);
      if (r) votes.push(recorded(r));
    }
    return { kind: 'recorded', votes };
  }
  return noChamberHasPassed(bill, line, rollCalls) ? { kind: 'notYet' } : null;
}

/* ── If it passes ─────────────────────────────────────────────────────── */

export type IfItPasses = {
  /** The chamber whose passage the sentence is about. */
  chamber: Chamber;
  /** 'pass' — it has not passed this chamber yet; 'sameForm' — the other
   *  chamber passed it, so it is this chamber's passage in the same form;
   *  'concur' — this chamber is asked to agree to the other's changes. */
  step: 'pass' | 'sameForm' | 'concur';
  /** What follows mechanically. */
  then: 'otherChamber' | 'president' | 'adopted' | 'states';
} | null;

const origin = (billType: string): Chamber => (billType.toLowerCase().startsWith('h') ? 'house' : 'senate');
const SIMPLE_RESOLUTION = new Set(['hres', 'sres']);

/**
 * THE "IF IT PASSES" ROW — only where the next step follows from the bill
 * type and the stage on the record. No forecast, no "expected".
 *
 *   no chamber has passed it (`noChamberHasPassed`; a failed passage vote
 *     counts as not passed) →
 *     its originating chamber passes it, and it goes to the other chamber;
 *   passed by one chamber, waiting on the other (passedWaiting, heldAtDesk,
 *     passedOnCalendar) → if the other chamber passes it in the same form,
 *     it goes to the president — or, for a concurrent resolution, both
 *     chambers have agreed to it and it goes to no president; for a joint
 *     resolution proposing a constitutional amendment, to the states
 *     (lib/journey.ts journeyEnding, the stepper's own reading);
 *   the same, when the originating chamber's passage is a stored roll call
 *     and the status line names the other chamber's floor;
 *   back with the originating chamber (passedBack) → if it agrees to the
 *     other chamber's changes, the same ending.
 *
 * Omitted (null) for everything else: a simple resolution (no second
 * chamber), a line that names a chamber other than the one the rule would
 * name, a stage whose next step the record does not settle ('second', a
 * veto, a bill already sent to the president), and anything settled.
 */
export function ifItPasses(
  bill: Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date' | 'title'> & {
    status_basis_text?: string | null;
  },
  line: Pick<StatusLine, 'key' | 'chamber'>,
  rollCalls: readonly RollCall[]
): IfItPasses {
  const type = bill.bill_type.toLowerCase();
  if (SIMPLE_RESOLUTION.has(type)) return null;
  if (settledDecision(bill)) return null;
  const from = origin(type);
  const other: Chamber = from === 'house' ? 'senate' : 'house';
  const ending = journeyEnding(type, bill.title);
  const finalStep = ending === 'president' ? 'president' : ending === 'bothChambers' ? 'adopted' : 'states';

  if (noChamberHasPassed(bill, line, rollCalls)) {
    if (line.chamber && line.chamber !== from) return null;
    return { chamber: from, step: 'pass', then: 'otherChamber' };
  }
  // The originating chamber's passage is a stored roll call while the status
  // bucket still reads the floor (H.R. 3633: the House passed it 294–134, and
  // its record now sits on the Senate floor): the other chamber's same-form
  // passage is next, exactly as when the status line says so.
  const passedIn = rollCalls.filter((r) => isPassageVote(r) && !FAILED_RESULT.test(r.result));
  if (
    bill.status === 'floor_vote' &&
    passedIn.length > 0 &&
    passedIn.every((r) => r.chamber === from) &&
    line.chamber === other &&
    !PASSED_KEYS.has(line.key)
  ) {
    return { chamber: other, step: 'sameForm', then: finalStep };
  }
  if (line.key === 'passedWaiting' || line.key === 'heldAtDesk' || line.key === 'passedOnCalendar') {
    if (line.chamber !== other) return null;
    return { chamber: other, step: 'sameForm', then: finalStep };
  }
  if (line.key === 'passedBack') {
    if (line.chamber !== from) return null;
    return { chamber: from, step: 'concur', then: finalStep };
  }
  return null;
}

/* ── The whole box, read from the record ──────────────────────────────── */

export interface Glance {
  /** True when no bill in the question is still open: the box shows the
   *  record's outcome and no call (page 1, rule 6). */
  settled: boolean;
  slug: string;
  bill: Bill;
  /** The lead bill's status line, the very object the page's vehicle list
   *  prints for it. */
  line: StatusLine;
  votes: VotesSoFar | null;
  passage: PassageRow;
  next: IfItPasses;
  /** Where "how your members voted" is printed for this bill, or null:
   *  the bill page's vote record (`#votes`, with its "your members" strip)
   *  while the decision is open, the record-only panel (`#act`) once the
   *  record settles it — in both cases only when a roll call is stored. */
  membersAnchor: '#votes' | '#act' | null;
  /** How many other bills the question holds. */
  otherBills: number;
}

/**
 * The box for one question, from the vehicles the page already lists
 * (lib/moments-ui.ts questionVehicles) and the line the question's own
 * status leads with (lib/moment-status.mjs questionStatus). Null when there
 * is no bill to lead with (an empty question, or one whose only open
 * vehicles are nominations, which keep their own cards).
 */
export function questionGlance(
  vehicles: readonly QuestionVehicle[],
  questionLead: StatusLine | null,
  now: number = Date.now()
): Glance | null {
  const bills = vehicles.filter((v) => v.kind === 'bill');
  const open = bills.filter((v) => v.open);
  const anyOpen = vehicles.some((v) => v.open);
  let leadVehicle: QuestionVehicle | null = null;

  if (open.length > 0) {
    const candidates = open.flatMap((v) => {
      const raw = getBill(v.vehicle.slug);
      if (!raw) return [];
      const announced = announcementFor(raw, v.vehicle.slug, now);
      return [
        {
          v,
          slug: v.vehicle.slug,
          floorDate: announced ? (announced.covers ?? announced.published) : null,
          floorActionDate: floorActionDate(raw, v.line, votesForBill(v.vehicle.slug)),
          actionDate: raw.last_action_date ?? null,
        },
      ];
    });
    leadVehicle = pickLeadBill(candidates, easternDay(now))?.v ?? null;
  } else if (!anyOpen && bills.length > 0) {
    leadVehicle =
      bills.find((v) => v.line === questionLead) ??
      [...bills].sort((a, b) => (b.line.date ?? '').localeCompare(a.line.date ?? ''))[0];
  }
  if (!leadVehicle) return null;

  const slug = leadVehicle.vehicle.slug;
  const bill = getBill(slug);
  if (!bill) return null;
  const settled = !leadVehicle.open;
  const rollCalls = votesForBill(slug);
  const line = leadVehicle.line;
  const passage = passageRow(bill, line, rollCalls);
  return {
    settled,
    slug,
    bill,
    line,
    votes: votesSoFar(rollCalls),
    passage,
    next: settled ? null : ifItPasses(bill, line, rollCalls),
    membersAnchor: rollCalls.length === 0 ? null : settledDecision(bill) ? '#act' : '#votes',
    otherBills: bills.length - 1,
  };
}
