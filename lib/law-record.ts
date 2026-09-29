import { statusBasisText } from './floor-text.mjs';
import { settledDecision } from './journey';
import { settledDecisionDate } from './settled-votes';
import type { Bill } from './types';

/*
 * THE RECORD LINE BEHIND THE WORD "LAW" on a member page's vote card
 * (wireframes v2, member.html, 2026-09-29: "Became law Sep 2, 2026 · Public
 * Law 119-103").
 *
 * Both halves are the record's own: the date is the one it gives for the
 * action the law was read from (lib/settled-votes.ts `settledDecisionDate`,
 * the status basis's date, never another action's), and the number is the
 * one its sentence carries ("Became Public Law No: 119-103."), read with the
 * same pattern lib/moment-status.mjs reads for the Big Question status line.
 * Either half is null when the record does not give it, and the card then
 * prints only what it has.
 *
 * Null on anything that is not a law, by the bill page's own reading
 * (lib/journey.ts `settledDecision` 'law'), so this line and the word "Law"
 * (lib/status-word.ts) can never disagree.
 */

type LawBill = Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'> & {
  status_basis_text?: string | null;
  status_basis_date?: string | null;
};

/** "Became Public Law No: 119-103." — the record's own number for a law. */
const PUBLIC_LAW = /\bPublic Law No:?\s*(\d+-\d+)/i;

export function lawRecord(bill: LawBill): { date: string | null; number: string | null } | null {
  if (settledDecision(bill)?.kind !== 'law') return null;
  return {
    date: settledDecisionDate(bill),
    number: PUBLIC_LAW.exec(statusBasisText(bill) ?? '')?.[1] ?? null,
  };
}
