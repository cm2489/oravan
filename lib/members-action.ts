'use server';

import { membersFor, type MembersResult } from '@/lib/members';
import { withPortraits } from '@/lib/member-portraits';

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
 *
 * The answer carries the members' pictures too (2026-11-12,
 * lib/member-portraits.ts), so the page draws them without a request that
 * names a member. This action answers only the members page, which always
 * shows them; the home page's saved-ZIP names and the call panel look
 * members up elsewhere and never pay for pictures. A lookup made with
 * JavaScript sends `pictures=after` and gets the names first, the pictures
 * after them in the same response; a native form post gets both at once,
 * as plain data the page's HTML can hold.
 */
export async function lookupMembers(_previous: MembersResult | null, form: FormData): Promise<MembersResult | null> {
  const zip = form.get('zip');
  const district = form.get('district');
  return withPortraits(
    membersFor(typeof zip === 'string' ? zip : null, typeof district === 'string' ? district : null),
    form.get('pictures') === 'after'
  );
}
