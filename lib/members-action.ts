'use server';

import { membersFor, type MembersResult } from '@/lib/members';

/*
 * The members page's lookup, as a server action (2026-11-12): the ZIP, and
 * the refined district when there is one, arrive in the POST body, never in
 * the page's address. See lib/members.ts for why.
 *
 * Two ways in, one function:
 *   - JavaScript on: components/RepsLookup.tsx dispatches it from the page.
 *     Next.js POSTs to the page's own address (/reps or /es/reps, nothing
 *     after it) and the arguments travel in the body.
 *   - JavaScript off, or before hydration: every ZIP form
 *     (components/ZipForm.tsx) is a native form whose action is this
 *     function with the permalink /reps, so the browser POSTs the field to
 *     /reps and the server renders the members from the body.
 *
 * Nothing is logged or stored; the result is plain data (lib/members.ts).
 */
export async function lookupMembers(_previous: MembersResult | null, form: FormData): Promise<MembersResult | null> {
  const zip = form.get('zip');
  const district = form.get('district');
  return membersFor(typeof zip === 'string' ? zip : null, typeof district === 'string' ? district : null);
}
