/*
 * The one way the site's own pages ask /api/reps for a ZIP's members: a POST
 * with the ZIP in a JSON body, never in the request's web address.
 *
 * Why the body (2026-10-06): the hosting provider's request logs keep each
 * request's path with its query string, next to the caller's network address
 * and user agent. A lookup written as `/api/reps?zip=…` left the visitor's ZIP
 * in those logs, which made "used in memory, never stored" untrue of the
 * host. A request body is not part of the logged address, so the ZIP is read
 * by the route, matched in memory, and gone. /api/district has sent the
 * street address the same way since #373.
 *
 * scripts/check-zip-urls.mjs fails CI if client or server code puts a ZIP
 * back into the address of a request to Oravan's own routes.
 */
export const REPS_LOOKUP_PATH = '/api/reps';

/** POST the ZIP to /api/reps. The caller reads the Response exactly as before. */
export function lookupReps(zip: string): Promise<Response> {
  return fetch(REPS_LOOKUP_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ zip }),
  });
}
