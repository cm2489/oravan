import { endedDecision, finishedDecision, type EndedDecision, type SettledDecision } from './journey';
import type { Bill } from './types';

/*
 * WHAT STANDS IN THE BILL PAGE'S RAIL, AND WHAT POINTS AT A CALL — the bill
 * page's one decision about call apparatus, as a pure function (stage 3 of the
 * new-Congress work, 2026-11-13).
 *
 * Page 1, rule 6: a settled decision shows no call apparatus, and a bill of an
 * ended Congress is the same in that respect. Until this file the bill page
 * (app/[locale]/bills/[id]/page.tsx) made the decision inline, so the only way
 * to test the ended page was a review build, which CI refuses by design
 * (lib/ended-state.mjs). Now the page reads every call-apparatus switch from
 * here, tests/bill-rail.unit.spec.ts runs this function over fixtures with an
 * ended Congress in CI, and the same spec pins that the page renders the call
 * panel, the floating call button, the "see how a call works" demo and the
 * header's Call-tab target ONLY through these fields.
 *
 *   panel          'call'    the call panel (components/ActionPanel.tsx);
 *                  'settled' the record-only panel (components/SettledPanel.tsx):
 *                            a law, a rejected final vote, an adopted
 *                            concurrent resolution (lib/journey.ts
 *                            finishedDecision);
 *                  'ended'   components/EndedPanel.tsx: a bill of an ended
 *                            Congress that Congress did not finish.
 *   endedKey       the approved sentence the ended panel prints.
 *   floatingCall, walkthrough, callTabTarget
 *                  true only when the panel is the call panel.
 *
 * With the ended list empty (until the January 2027 switch) `ended` is null
 * for every bill, and this answers exactly what the page answered before.
 */
export interface BillRail {
  panel: 'call' | 'settled' | 'ended';
  settled: SettledDecision | null;
  ended: EndedDecision | null;
  endedKey: 'bill.ended.note' | 'bill.ended.presented' | null;
  floatingCall: boolean;
  walkthrough: boolean;
  callTabTarget: boolean;
}

export function billRail(bill: Bill): BillRail {
  const settled = finishedDecision(bill);
  const ended = endedDecision(bill);
  const endedKey =
    ended?.kind === 'presented' ? 'bill.ended.presented' : ended?.kind === 'ended' ? 'bill.ended.note' : null;
  const panel = settled ? 'settled' : endedKey ? 'ended' : 'call';
  const call = panel === 'call';
  return { panel, settled, ended, endedKey, floatingCall: call, walkthrough: call, callTabTarget: call };
}
