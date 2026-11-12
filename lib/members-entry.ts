import type { MembersResult } from '@/lib/members';

/*
 * WHAT THE MEMBERS PAGE SHOWED, KEPT IN ITS OWN HISTORY ENTRY (2026-11-12).
 *
 * Until 2026-11-12 the members page's address held the lookup
 * (/reps?zip=10001&district=NY-12), so Reload kept a refined district and
 * Back went from the refined view to every district. The owner took both out
 * of the address (CLAUDE.md rule 1). This keeps that behaviour without them:
 * the ZIP, and the refined district when there is one, sit in the state
 * object of this tab's own history entry (window.history.pushState /
 * replaceState). The browser keeps that object with the entry, in this tab,
 * across Reload and Back/Forward, and never sends it anywhere: it is not in
 * the address, not in a request, not in web storage, not in a cookie, and
 * not on the server.
 *
 * HOW NEXT.JS 16 TREATS THE STATE OBJECT (node_modules/next, 16.2.12,
 * client/components/app-router.js, read 2026-11-12). The app router replaces
 * window.history.pushState and replaceState with versions that copy its own
 * keys (`__NA`, `__PRIVATE_NEXTJS_INTERNALS_TREE`) into the object passed in
 * and, when a URL is passed, tell the router about it. It installs those
 * versions in an effect of its own root component, and on a page's first
 * render a child's effects run BEFORE the root's: a call made from a page's
 * mount effect reaches the browser's own method, so the router never learns
 * the new address and the entry loses the router's keys (`history.state`
 * became null). Every call here is therefore made after the first render
 * (one tick later, or after a lookup returns), and passes only this page's
 * own key: an object that already holds `__NA` would skip the router's copy.
 * The router keeps a custom key on its own later writes to the same entry
 * (`preserveCustomHistoryState` on restores and history traversal); a
 * navigation to another page makes a new entry with a fresh state, which is
 * what should happen.
 */

/** The one key this page keeps in its history entry's state. */
export const ENTRY_KEY = 'oravanMembers';

/** What the entry remembers: the ZIP, and the refined district ("NY-12"). */
export interface MembersEntry {
  zip: string;
  district?: string;
}

const ZIP_RE = /^\d{5}$/;
const DISTRICT_RE = /^[A-Z]{2}-\d{1,2}$/;

/**
 * The entry a history state object holds, or null. Total: anything else that
 * happens to sit in the state (another script's, a damaged one) reads as
 * nothing rather than as a lookup.
 */
export function readEntry(state: unknown): MembersEntry | null {
  if (typeof state !== 'object' || state === null) return null;
  const v = (state as Record<string, unknown>)[ENTRY_KEY];
  if (typeof v !== 'object' || v === null) return null;
  const { zip, district } = v as Record<string, unknown>;
  if (typeof zip !== 'string' || !ZIP_RE.test(zip)) return null;
  return typeof district === 'string' && DISTRICT_RE.test(district) ? { zip, district } : { zip };
}

/** The entry for the members on screen; null when the ZIP matched nothing. */
export function entryFor(result: MembersResult | null | undefined): MembersEntry | null {
  if (!result || result.districts.length === 0 || !ZIP_RE.test(result.zip)) return null;
  if (!result.refined) return { zip: result.zip };
  const [d] = result.districts;
  return { zip: result.zip, district: `${d.state}-${d.district}` };
}

export function sameEntry(a: MembersEntry | null, b: MembersEntry | null): boolean {
  return a?.zip === b?.zip && a?.district === b?.district;
}

/** Every parameter that ever carried the lookup, and `change`. */
const DROPPED = ['zip', 'district', 'change'];

/**
 * Keep `entry` in this tab's history and drop the lookup's parameters from
 * the address. 'push' makes a new entry (a refinement, or "Show all
 * districts", so Back returns to the view before it); 'replace' rewrites the
 * current one. Browser only, and only after the first render (see above).
 */
export function rememberMembers(entry: MembersEntry | null, mode: 'push' | 'replace') {
  const url = new URL(window.location.href);
  for (const name of DROPPED) url.searchParams.delete(name);
  const clean = `${url.pathname}${url.search}${url.hash}`;
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const state = entry ? { [ENTRY_KEY]: entry } : {};
  // No URL when it is unchanged: the router then has nothing to learn, and
  // only copies its own keys into `state`.
  const address = clean === here ? undefined : clean;
  if (mode === 'push') window.history.pushState(state, '', address);
  else window.history.replaceState(state, '', address);
}

/** The entry the current history entry holds. Browser only. */
export function currentEntry(): MembersEntry | null {
  return readEntry(window.history.state);
}
