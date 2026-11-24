/*
 * CALL ANCHORS ON A PAGE — where an in-page call control points.
 *
 * Until 2026-11-24 this module also held the phone bar's Call tab target: a
 * page declared where the tab should go and the header read it. The owner
 * took the Call tab off the phone bar that day (his pick on the mock-up card
 * "The phone bar: which tabs stay?": "Four tabs: Home · Bills · Big
 * Questions · Reps"; his note of 2026-11-23: "every page has a "call" button
 * close by"), so that plumbing is gone. The Call hub stays at /call, linked
 * from the footer on every page.
 *
 * What is left is shared by the question page, its vehicle cards and the
 * "At a glance" box: the call panel's own anchor, the "Still open" list's id,
 * whether a Big Question carries the call panel itself, and how an in-page
 * anchor is told from a route.
 */

/** The call panel's own heading id (components/ActionPanel.tsx), on a bill
 *  page and on a Big Question that carries the panel itself. */
export const CALL_PANEL_ANCHOR = '#act';

/** The id of a Big Question's "Still open" list heading, a stable anchor
 *  for anything that wants to point at the list. */
export const STILL_OPEN_ID = 'still-open';

/** The kind of each callable vehicle — the cards whose button reads
 *  "Read + call" (app/[locale]/questions/[id]). The union is restated rather
 *  than imported, because this module ships to the browser (the vehicle card
 *  and the "At a glance" box read it) and lib/moments.ts carries the whole
 *  corpus. */
type CallableKind = 'bill' | 'nomination';

/**
 * DOES THIS BIG QUESTION CARRY THE CALL PANEL ITSELF? (wireframes v2,
 * 2026-09-29, UX question Q6 answered "b".) Exactly when it runs through one
 * vehicle still open to a decision and that vehicle is a bill: the bill page's
 * own panel then sits on the question page (lib/bill-call-panel.ts). A lone
 * open nomination keeps its card, which lands on the nomination page's own
 * panel; the wireframes draw no nomination panel on a question page.
 */
export function questionHasPanel(callableKinds: readonly CallableKind[]): boolean {
  return callableKinds.length === 1 && callableKinds[0] === 'bill';
}

/** An in-page anchor ("#act") is followed by the browser itself; anything
 *  else is a route the locale-aware Link resolves. */
export function isInPageTarget(href: string): boolean {
  return href.startsWith('#');
}
