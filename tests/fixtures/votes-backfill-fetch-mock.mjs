/**
 * A `--import` preload for tests/votes-backfill.unit.spec.ts: replaces
 * globalThis.fetch BEFORE scripts/sync-votes.mjs evaluates, so a back-fill
 * run makes ZERO network calls (the tests/fixtures/sync-coverage-fetch-mock.mjs
 * precedent). Every URL is answered from tests/fixtures/votes:
 *
 *   MOCK_FIXTURES  the fixtures directory
 *   MOCK_LOG       a file to append one requested URL per line to
 *   MOCK_404       answer 404 to the URL ending in this string
 *   MOCK_CRASH_AT  SIGKILL this process when the URL ending in this string is
 *                  requested — a crash mid-run, with no chance to clean up
 *
 * The Clerk's 2026 index fixture tops out at roll 72, so the walker asks for
 * every roll from 1 up. Rolls 70-72 are real records; every OTHER 2026 roll
 * number answers with roll 71's record (H.R. 6329, not in the test corpus)
 * renumbered to the roll asked for — filler that reads as "a roll call on a
 * bill we do not track", which is what most roll numbers are. Any other URL
 * is a 404. Congress.gov is never reached: no key is set, and
 * scripts/congress-fetch.mjs refuses before it fetches.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FX = process.env.MOCK_FIXTURES;
const read = (name) => readFileSync(join(FX, name), 'utf8');

const SENATE = 'https://www.senate.gov/legislative/LIS';
const ROUTES = {
  'https://clerk.house.gov/evs/2025/index.asp': 'clerk-index-2025-rolls-1-2.html',
  'https://clerk.house.gov/evs/2025/roll001.xml': 'clerk-2025-roll001-quorum.xml',
  'https://clerk.house.gov/evs/2025/roll002.xml': 'clerk-2025-roll002-speaker.xml',
  'https://clerk.house.gov/evs/2026/index.asp': 'clerk-index-2026-rolls-70-72.html',
  'https://clerk.house.gov/evs/2026/roll070.xml': 'clerk-2026-roll070-hr2189.xml',
  'https://clerk.house.gov/evs/2026/roll071.xml': 'clerk-2026-roll071-hr6329.xml',
  'https://clerk.house.gov/evs/2026/roll072.xml': 'clerk-2026-roll072-s2503.xml',
  [`${SENATE}/roll_call_lists/vote_menu_119_1.xml`]: 'senate-vote-menu-119-1.xml',
  [`${SENATE}/roll_call_lists/vote_menu_119_2.xml`]: 'senate-vote-menu-119-2.xml',
  [`${SENATE}/roll_call_votes/vote1191/vote_119_1_00001.xml`]: 'senate-vote-119-1-00001.xml',
  'https://unitedstates.github.io/congress-legislators/legislators-current.json': 'backfill-upstream-current.json',
  'https://unitedstates.github.io/congress-legislators/legislators-historical.json': 'backfill-upstream-historical.json',
};

const ok = (body) => new Response(body, { status: 200 });
const missing = () => new Response('<html>not found</html>', { status: 404 });

globalThis.fetch = async (input) => {
  const url = String(typeof input === 'string' ? input : (input?.url ?? input));
  appendFileSync(process.env.MOCK_LOG, `${url}\n`);
  if (process.env.MOCK_CRASH_AT && url.endsWith(process.env.MOCK_CRASH_AT)) process.kill(process.pid, 'SIGKILL');
  if (process.env.MOCK_404 && url.endsWith(process.env.MOCK_404)) return missing();
  if (ROUTES[url]) return ok(read(ROUTES[url]));
  const filler = /^https:\/\/clerk\.house\.gov\/evs\/2026\/roll(\d{3,})\.xml$/.exec(url);
  if (filler) {
    return ok(read('clerk-2026-roll071-hr6329.xml').replace(/<rollcall-num>\d+<\/rollcall-num>/, `<rollcall-num>${Number(filler[1])}</rollcall-num>`));
  }
  return missing();
};
