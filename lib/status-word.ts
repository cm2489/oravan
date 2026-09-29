import { decisionState } from './docket.mjs';
import { concurrentAdoptedBy } from './floor-text.mjs';
import { settledDecision, type SettledDecision } from './journey';
import type { Bill } from './types';

/*
 * ONE WORD FOR WHERE A MEASURE ENDED UP — a closed set of five (wireframes
 * v2, 2026-09-29, Claude's ruling 11, drawn on member.html and on the
 * several-bills Big Question page).
 *
 *   open      a decision on the measure is still possible: in committee, on a
 *             calendar, passed one chamber, or a motion to take it up or to
 *             discharge it failed and the record lets it come back;
 *   law       it is law ("Became Public Law No.": signed, or a veto
 *             overridden);
 *   agreed    a resolution that goes to no president was agreed to by every
 *             chamber it needs ("Agreed to" is the record's own verb; "Law"
 *             would be false: concurrent resolutions "are not submitted to the
 *             president and thus do not have the force of law", senate.gov
 *             glossary);
 *   rejected  the measure itself lost its vote ("Failed of passage"). A failed
 *             MOTION about it is not this; that stays open;
 *   vetoed    the president vetoed it and no override has passed.
 *
 * Every word is read from the record, never from the bill type alone, and
 * through the same two readers the bill page and the MCP envelope use, so the
 * word can never disagree with the panel beside it:
 *
 *   1. lib/journey.ts `settledDecision` — the bill page's own reading (the
 *      record-only panel stands where it answers non-null);
 *   2. lib/docket.mjs `decisionState` — the MCP envelope's reading, which is
 *      never narrower than (1) and settles one shape (1) does not: a failed
 *      passage vote whose sentence names no chamber. That shape reads as
 *      `rejected` here too, because the record's sentence is a failed vote on
 *      the measure itself. The corpus held none on 2026-09-29.
 *
 * A veto is last because neither reader settles it: an override vote is still
 * possible (owner, 2026-09-29, pick (a)), so a vetoed bill keeps the call
 * panel and the word says what happened to it.
 *
 * Shown as text in small ink capitals, never as a colour (page 1, rule 3).
 * The words are `bills.statusWord.*` in messages/en.json and es.json.
 */
export const STATUS_WORDS = ['open', 'law', 'agreed', 'rejected', 'vetoed'] as const;
export type StatusWord = (typeof STATUS_WORDS)[number];

type StatusWordBill = Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'> & {
  status_basis_text?: string | null;
  status_basis_date?: string | null;
};

export function statusWord(bill: StatusWordBill): StatusWord {
  const settled = settledDecision(bill);
  if (settled?.kind === 'law') return 'law';
  if (settled?.kind === 'adopted') return 'agreed';
  if (settled?.kind === 'rejected') return 'rejected';
  const state = decisionState(bill).state;
  if (state === 'enacted') return 'law';
  if (state === 'settled') return concurrentAdoptedBy(bill) ? 'agreed' : 'rejected';
  if (bill.status === 'vetoed') return 'vetoed';
  return 'open';
}

/**
 * THE RECORD'S OUTCOME SENTENCE for a settled decision — the chamber, the
 * record's tally and the action's date, first (owner, 2026-09-28 and
 * 2026-09-29, on the settled box: "The Senate rejected it, 49–50, on
 * September 24, 2026."). The bill page's record-only panel prints the same
 * sentence from the same keys (`bill.settled.*`) through its own private
 * `settledOutcomeText` in app/[locale]/bills/[id]/page.tsx, which this
 * mirrors argument for argument; the question page's settled rows print it
 * from here. `date` is the record's own date for that action
 * (lib/settled-votes.ts settledDecisionDate), already formatted; null leaves
 * the date out rather than borrow another action's.
 */
export function settledOutcomeSentence(
  t: (key: string, values?: Record<string, string | number>) => string,
  settled: SettledDecision,
  date: string | null
): string {
  const when = { hasDate: date ? 'yes' : 'none', date: date ?? '' };
  switch (settled.kind) {
    case 'law':
      return t('bill.settled.law');
    case 'rejected':
      return t('bill.settled.rejected', {
        chamber: settled.chamber === 'house' ? 'House' : 'Senate',
        tally: settled.tally ? 'yes' : 'none',
        yeas: settled.tally?.yeas ?? 0,
        nays: settled.tally?.nays ?? 0,
        ...when,
      });
    case 'adopted':
      return t('bill.settled.adopted', when);
  }
}
