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
 *   a Big Question             → see app/[locale]/questions/[id]/page.tsx
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

/**
 * A Big Question's Call target, from the hrefs of its callable vehicles — the
 * cards whose button reads "Read + call" (app/[locale]/questions/[id]).
 *
 *   exactly one → that vehicle's own call panel. The wireframe puts that panel
 *                 ON the question page (Q6 b); until that is built, the panel
 *                 is on the bill's page, which is where the card's own
 *                 "Read + call" already goes.
 *   several     → the question's list of them (`listAnchor`), because each
 *                 card lands on its own bill's panel and the question's
 *                 context holds (the index's accepted inference). The
 *                 wireframe's separate "Still open" list is not built yet, so
 *                 the anchor is the whole vehicles section.
 *   none        → null: nothing to call here, so the Call hub.
 */
export function questionCallTarget(callableHrefs: readonly string[], listAnchor: string): string | null {
  if (callableHrefs.length === 1) return callableHrefs[0];
  if (callableHrefs.length > 1) return listAnchor;
  return null;
}

/** An in-page anchor ("#act") is followed by the browser itself; anything
 *  else is a route the locale-aware Link resolves. */
export function isInPageTarget(href: string): boolean {
  return href.startsWith('#');
}
