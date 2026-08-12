/**
 * CI gate for data/conversation.json — the same judgement the nightly
 * dead-man's-switch runs (verifyConversation, lib/conversation.mjs), wired
 * where it actually catches a bad write.
 *
 *   node scripts/check-conversation.mjs
 *   node scripts/check-conversation.mjs --self-test
 *
 * WHY BOTH HERE AND IN verify-sync.mjs — identical reasoning to
 * scripts/check-floor-signals.mjs beside it: the file is written by the HOURLY
 * newsdesk workflow, which commits straight to main and then dispatches ci.yml
 * against the pushed data, while verify-sync.mjs only runs in the NIGHTLY sync.
 * Without this step a bad hourly write would sit on the site until the small
 * hours.
 *
 * WHAT IT IS REALLY PROTECTING. Every caption the news band prints is a
 * counted claim about who published what — "covered by three outlets across the
 * spectrum this week". The counting rule is that only outlets carrying an
 * AllSides lean in data/media-bias.json may corroborate (critic B-3), because
 * an unrated domain is exactly the channel two press-release pickups would walk
 * through. That rule is enforced at write time in lib/conversation.mjs, and it
 * is checked HERE against the real bias table, so a writer regression cannot
 * quietly reopen the single-outlet prioritization channel the repo already
 * closed once on the trigger path.
 *
 * A MISSING file is not a failure: scripts/newsdesk.mjs is what first writes
 * it, and a gate that reddens CI for a file nobody has generated yet teaches
 * people to ignore the gate.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  CONVERSATION_PATH,
  CONVERSATION_SCHEMA,
  OUTLET_WINDOW_DAYS,
  verifyConversation,
} from '../lib/conversation.mjs';

const url = (p) => new URL(`../${p}`, import.meta.url);

const nowISO = new Date().toISOString();
const today = nowISO.slice(0, 10);

// --self-test: prove the gate still rejects the shapes it exists to reject, so
// a refactor that quietly turned it into a no-op is caught by the gate itself —
// the same pattern check-floor-signals/check-claim-truth/check-server-json keep.
if (process.argv.includes('--self-test')) {
  const meta = { schema: CONVERSATION_SCHEMA, fetched_at: nowISO, window_days: OUTLET_WINDOW_DAYS, source_status: {} };
  const rated = { domain: 'foxnews.com', lean: 'right', firstSeen: today, lastSeen: today };
  const bias = { 'foxnews.com': 'right', 'npr.org': 'center' };
  const cases = [
    [
      'an unrated domain counted toward corroboration',
      { _meta: meta, slugs: { 'hr-1-119': { outlets7d: [rated, { domain: 'example-blog.test', lean: 'right', firstSeen: today, lastSeen: today }], unratedOutlets7d: [], mostViewed: null } } },
      bias,
    ],
    [
      'a corroborating outlet with no lean at all',
      { _meta: meta, slugs: { 'hr-1-119': { outlets7d: [{ domain: 'foxnews.com', firstSeen: today, lastSeen: today }], unratedOutlets7d: [], mostViewed: null } } },
      bias,
    ],
    [
      'a rated outlet hidden in the unrated list',
      { _meta: meta, slugs: { 'hr-1-119': { outlets7d: [], unratedOutlets7d: [{ domain: 'npr.org', firstSeen: today, lastSeen: today }], mostViewed: null } } },
      bias,
    ],
    [
      'a lean that disagrees with data/media-bias.json',
      { _meta: meta, slugs: { 'hr-1-119': { outlets7d: [{ domain: 'foxnews.com', lean: 'left', firstSeen: today, lastSeen: today }], unratedOutlets7d: [], mostViewed: null } } },
      bias,
    ],
    [
      'evidence older than the window it claims',
      { _meta: meta, slugs: { 'hr-1-119': { outlets7d: [{ domain: 'foxnews.com', lean: 'right', firstSeen: '2020-01-01', lastSeen: '2020-01-01' }], unratedOutlets7d: [], mostViewed: null } } },
      bias,
    ],
    [
      'a future-dated observation',
      { _meta: meta, slugs: { 'hr-1-119': { outlets7d: [{ domain: 'foxnews.com', lean: 'right', firstSeen: today, lastSeen: '2099-01-01' }], unratedOutlets7d: [], mostViewed: null } } },
      bias,
    ],
    ['an unknown schema', { _meta: { ...meta, schema: 'conversation/v99' }, slugs: {} }, bias],
    ['a window that is not the one this build reads', { _meta: { ...meta, window_days: 30 }, slugs: {} }, bias],
    [
      'a most-viewed block with no weeks on the list',
      { _meta: meta, slugs: { 'hr-1-119': { outlets7d: [], unratedOutlets7d: [], mostViewed: { weeksOnList: 0, lastRank: 3, lastSeen: today } } } },
      bias,
    ],
  ];
  let ok = true;
  for (const [name, data, biasTable] of cases) {
    const { failures } = verifyConversation({ data, fileBytes: 100, bias: biasTable });
    if (failures.length === 0) {
      console.error(`::error::check-conversation --self-test: "${name}" was ACCEPTED by the gate`);
      ok = false;
    }
  }
  const good = {
    _meta: meta,
    slugs: {
      'hr-1-119': {
        outlets7d: [rated, { domain: 'npr.org', lean: 'center', firstSeen: today, lastSeen: today }],
        unratedOutlets7d: [{ domain: 'rollcall.com', firstSeen: today, lastSeen: today }],
        mostViewed: { weeksOnList: 2, lastRank: 3, lastSeen: today, lastWeek: today },
      },
    },
  };
  if (verifyConversation({ data: good, fileBytes: 100, bias }).failures.length > 0) {
    console.error('::error::check-conversation --self-test: a valid document was REJECTED by the gate');
    ok = false;
  }
  if (verifyConversation({ data: { _meta: meta, slugs: {} }, fileBytes: 100, bias }).failures.length > 0) {
    console.error('::error::check-conversation --self-test: a valid EMPTY file was REJECTED by the gate');
    ok = false;
  }
  if (!ok) process.exit(1);
  console.log('check-conversation --self-test passed');
  process.exit(0);
}

if (!existsSync(url(CONVERSATION_PATH))) {
  console.log(`check-conversation: ${CONVERSATION_PATH} does not exist yet — nothing to validate.`);
  process.exit(0);
}

const data = JSON.parse(readFileSync(url(CONVERSATION_PATH), 'utf8'));
const bills = JSON.parse(readFileSync(url('data/bills.json'), 'utf8'));
const bias = JSON.parse(readFileSync(url('data/media-bias.json'), 'utf8')).outlets ?? {};
const { failures, warnings, notes } = verifyConversation({
  data,
  fileBytes: statSync(url(CONVERSATION_PATH)).size,
  knownSlugs: new Set(bills.map((b) => b.full_identifier)),
  bias,
});

for (const n of notes) console.log(`check-conversation: ${n}`);
for (const w of warnings) console.warn(`::warning::check-conversation: ${w}`);
if (failures.length) {
  for (const f of failures) console.error(`::error::check-conversation: ${f}`);
  process.exit(1);
}
console.log('check-conversation passed — every corroborating outlet is AllSides-rated, dated, and inside the 7-day window it claims.');
