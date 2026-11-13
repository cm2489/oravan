import type en from '@/messages/en.json';
import { endedDecision, statusKeyFor, type EndedKind } from './journey';
import type { Bill } from './types';

/*
 * WHAT THE PAID ACTION-PANEL EMBED SHOWS FOR A BILL OF AN ENDED CONGRESS
 * (stage 3 of the new-Congress work, 2026-11-13), as a pure function so CI can
 * run it with an ended Congress (tests/bill-rail.unit.spec.ts); the embed page
 * (app/embed/action-panel/page.tsx) prints these lines in its no-panel frame
 * and mounts no call panel whenever this is non-null.
 *
 *   law        "This is law." and "Became law during the 119th Congress."
 *   presented  the approved "does not yet show what the president did" line
 *   decided    the record's status label ("Rejected", "Adopted by both
 *              chambers") and the long label "Ended with the 119th Congress"
 *   ended      the approved note
 *
 * Null for every bill while no Congress is on the ended list.
 */
type Catalog = typeof en;

export function actionPanelEndedLines(bill: Bill, t: Catalog): { kind: EndedKind; lines: string[] } | null {
  const ended = endedDecision(bill);
  if (!ended) return null;
  const lines =
    ended.kind === 'law'
      ? [t.bill.settled.law, t.bill.ended.lawLine]
      : ended.kind === 'presented'
        ? [t.bill.ended.presented]
        : ended.kind === 'decided'
          ? [t.bills.status[statusKeyFor(bill) as keyof Catalog['bills']['status']], t.bill.ended.statusLong]
          : [t.bill.ended.note];
  return { kind: ended.kind, lines };
}
