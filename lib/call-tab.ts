/*
 * WHERE THE CALL TAB GOES, AS THE PAGE DECLARES IT (owner, 2026-09-29: "nav 1").
 *
 * The Call tab sits in the header, which lives in the locale layout and so
 * cannot see the page under it: it does not know whether a bill page's
 * decision is still open, or how many open bills a Big Question holds. The
 * page does. So the page says where the tab should go (components/
 * CallTabTarget.tsx), and the header reads it from here.
 *
 * The rules come from the wireframe index's "Where the Call tab goes" table
 * (v2, 2026-09-29). A page that declares nothing sends the tab to the Call
 * hub, which is the table's answer for home, the lists, Reps, Today, the flat
 * pages, a settled bill page and a member page:
 *
 *   an open bill page          → its own call panel (#act)
 *   a nomination with a script → its own call panel (#act)
 *   a Big Question             → `questionCallTarget` below: its own panel
 *                                (#act) with one open bill, its "Still open"
 *                                list (#still-open) with several
 *   anything else              → /call
 *
 * This module holds one string in memory, in the browser only. Nothing is
 * stored, nothing leaves the page, and the server render always answers null
 * (the hub), so a reader with JavaScript off gets the hub everywhere.
 *
 * TOKENS, NOT A PLAIN SETTER. On a client-side navigation React runs the old
 * page's effect cleanup and the new page's effect in one commit. A cleanup
 * that blindly wrote null could land after the new page's claim and wipe it,
 * so each claim gets a token and a release only clears its own.
 */

export const CALL_HUB_PATH = '/call';

let current: { token: number; href: string } | null = null;
let nextToken = 1;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/** Claim the Call tab for this page. Returns the token `release` needs. */
export function claimCallTab(href: string): number {
  const token = nextToken++;
  current = { token, href };
  notify();
  return token;
}

/** Give the Call tab back, but only if this claim still holds it. */
export function releaseCallTab(token: number): void {
  if (current?.token !== token) return;
  current = null;
  notify();
}

export function subscribeCallTab(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The declared target, or null when the page declared none. */
export function callTabSnapshot(): string | null {
  return current?.href ?? null;
}

/** The server has no page state to read, so it always answers "the hub". */
export function callTabServerSnapshot(): string | null {
  return null;
}

/** The call panel's own heading id (components/ActionPanel.tsx), on a bill
 *  page and on a Big Question that carries the panel itself. */
export const CALL_PANEL_ANCHOR = '#act';

/** The id of a Big Question's "Still open" list heading. Stable: the Call
 *  tab, and anything else that wants the list, points at it. */
export const STILL_OPEN_ID = 'still-open';
export const STILL_OPEN_ANCHOR = `#${STILL_OPEN_ID}`;

/** The kind of each callable vehicle — the cards whose button reads
 *  "Read + call" (app/[locale]/questions/[id]). The union is restated rather
 *  than imported, because this module ships to the browser (the header reads
 *  it) and lib/moments.ts carries the whole corpus. */
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

/**
 * A Big Question's Call target (the index's "Where the Call tab goes" table,
 * v2, 2026-09-29):
 *
 *   one open bill       → the in-page call panel, `#act` (Q6 b);
 *   several open, or one open nomination
 *                       → the question's "Still open" list, `#still-open`,
 *                         because each card there lands on its own vehicle's
 *                         panel and the question's context holds (v1's
 *                         inference, accepted by Claude's ruling 8);
 *   nothing open        → null: nothing to call here, so the Call hub.
 */
export function questionCallTarget(callableKinds: readonly CallableKind[]): string | null {
  if (questionHasPanel(callableKinds)) return CALL_PANEL_ANCHOR;
  if (callableKinds.length > 0) return STILL_OPEN_ANCHOR;
  return null;
}

/** An in-page anchor ("#act") is followed by the browser itself; anything
 *  else is a route the locale-aware Link resolves. */
export function isInPageTarget(href: string): boolean {
  return href.startsWith('#');
}
