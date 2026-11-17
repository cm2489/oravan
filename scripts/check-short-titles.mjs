/**
 * Short-titles gate: data/short-titles.json holds the short titles the record
 * labels as each bill's, which name addresses are built from
 * (lib/short-titles.mjs, lib/short-address.ts). Runs:
 *
 *   node scripts/check-short-titles.mjs --self-test   # the gate still rejects what it exists to reject
 *   node scripts/check-short-titles.mjs               # the committed / freshly synced file
 *
 * in ci.yml's gates job. The nightly runs the same judgement twice before
 * anything is committed: scripts/sync-short-titles.mjs will not write a file
 * it refuses, and scripts/verify-sync.mjs re-checks it (hard rule 11).
 *
 * A MISSING file is not a failure: scripts/sync-short-titles.mjs is what
 * first writes it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { SHORT_TITLES_PATH, SHORT_TITLES_RETRY_PATH, verifyShortTitleRetries, verifyShortTitles } from '../lib/short-titles.mjs';
import { SHORT_TITLES_TREND_PATH, verifyShortTitlesTrend } from '../lib/short-titles-summary.mjs';

if (process.argv.includes('--self-test')) {
  const bills = [
    { bill_type: 's', bill_number: 5, congress_number: 119 },
    { bill_type: 'hr', bill_number: 4, congress_number: 119 },
  ];
  const good = {
    's-5-119': { titles: ['Laken Riley Act'], as_of: '2025-01-29', read_on: '2026-11-15' },
    'hr-4-119': { titles: [], as_of: null, read_on: '2026-11-15' },
  };
  const R = { read_on: '2026-11-15' };
  const cases = [
    ['a good file', good, null, false],
    ['not an object', [], null, true],
    ['a key that is not a slug', { ...good, 'laken-riley-act': { titles: [], as_of: null, ...R } }, null, true],
    ['a bill the corpus no longer holds (a note, not a failure)', { ...good, 's-6-119': { titles: [], as_of: null, ...R } }, null, false],
    ['an extra field', { ...good, 's-5-119': { titles: ['Laken Riley Act'], as_of: null, ...R, popular: 'x' } }, null, true],
    ['an empty title', { ...good, 's-5-119': { titles: [' '], as_of: null, ...R } }, null, true],
    ['a repeated title', { ...good, 's-5-119': { titles: ['A Act', 'A Act'], as_of: null, ...R } }, null, true],
    ['titles out of order', { ...good, 's-5-119': { titles: ['B Act', 'A Act'], as_of: null, ...R } }, null, true],
    ['a control character', { ...good, 's-5-119': { titles: ['A\nAct'], as_of: null, ...R } }, null, true],
    ['a bad as_of', { ...good, 's-5-119': { titles: [], as_of: 'yesterday', ...R } }, null, true],
    ['no read_on', { ...good, 's-5-119': { titles: [], as_of: null } }, null, true],
    ['a bad read_on', { ...good, 's-5-119': { titles: [], as_of: null, read_on: 'today' } }, null, true],
    ['a bill the record stopped giving a short title (a note)', { ...good, 's-5-119': { titles: [], as_of: null, ...R } }, good, false],
  ];
  let bad = 0;
  for (const [label, data, before, shouldFail] of cases) {
    const { failures } = verifyShortTitles({ data, bills, before });
    if ((failures.length > 0) !== shouldFail) {
      bad++;
      console.error(`::error::self-test: ${label}: expected ${shouldFail ? 'a failure' : 'no failure'}, got ${JSON.stringify(failures)}`);
    }
  }
  const retryCases = [
    ['a good retry file', { 's-5-119': { failures: 2, last_tried: '2026-11-15', reason: 'HTTP 404' } }, false],
    ['a retry entry with no reason', { 's-5-119': { failures: 2, last_tried: '2026-11-15' } }, true],
    ['a retry count of zero', { 's-5-119': { failures: 0, last_tried: '2026-11-15', reason: 'x' } }, true],
    ['a retry date that is not a date', { 's-5-119': { failures: 1, last_tried: 'today', reason: 'x' } }, true],
    ['a retry key that is not a slug', { 'abc': { failures: 1, last_tried: '2026-11-15', reason: 'x' } }, true],
  ];
  for (const [label, data, shouldFail] of retryCases) {
    const { failures } = verifyShortTitleRetries({ data, bills });
    if ((failures.length > 0) !== shouldFail) {
      bad++;
      console.error(`::error::self-test: ${label}: expected ${shouldFail ? 'a failure' : 'no failure'}, got ${JSON.stringify(failures)}`);
    }
  }
  const trendCases = [
    ['a good history', { nights: [{ day: '2026-11-16', titled: 1, bills: 2 }, { day: '2026-11-17', titled: 1, bills: 2, allow_drop: true }] }, false],
    ['an empty history', { nights: [] }, false],
    ['a history that is a list', [], true],
    ['a night with more titled bills than bills', { nights: [{ day: '2026-11-17', titled: 3, bills: 2 }] }, true],
    ['nights out of order', { nights: [{ day: '2026-11-17', titled: 1, bills: 2 }, { day: '2026-11-16', titled: 1, bills: 2 }] }, true],
    ['an extra field', { nights: [{ day: '2026-11-17', titled: 1, bills: 2, note: 'x' }] }, true],
    ['allow_drop that is not true', { nights: [{ day: '2026-11-17', titled: 1, bills: 2, allow_drop: false }] }, true],
  ];
  for (const [label, data, shouldFail] of trendCases) {
    const { failures } = verifyShortTitlesTrend({ data });
    if ((failures.length > 0) !== shouldFail) {
      bad++;
      console.error(`::error::self-test: ${label}: expected ${shouldFail ? 'a failure' : 'no failure'}, got ${JSON.stringify(failures)}`);
    }
  }
  if (bad) process.exit(1);
  console.log(`check-short-titles self-test: ${cases.length + retryCases.length + trendCases.length} case(s) behave`);
  process.exit(0);
}

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
let sideFilesFailed = false;
// The 14-night history (round 6, 2026-11-17): refused HERE, in a pull request, so a damaged one never
// reaches main that way. The nightly's verify-sync only warns about it, and the gate reads no clock, so a
// file the nightly wrote never turns this red by itself or as days pass.
if (existsSync(SHORT_TITLES_TREND_PATH)) {
  try {
    const { failures } = verifyShortTitlesTrend({ data: JSON.parse(readFileSync(SHORT_TITLES_TREND_PATH, 'utf8')) });
    for (const f of failures) console.error(`::error::${f}`);
    sideFilesFailed ||= failures.length > 0;
  } catch (e) {
    console.error(`::error::${SHORT_TITLES_TREND_PATH} does not parse as JSON: ${e.message}`);
    sideFilesFailed = true;
  }
}
if (existsSync(SHORT_TITLES_RETRY_PATH)) {
  try {
    const { failures, notes } = verifyShortTitleRetries({ data: JSON.parse(readFileSync(SHORT_TITLES_RETRY_PATH, 'utf8')), bills });
    for (const n of notes) console.log(n);
    for (const f of failures) console.error(`::error::${f}`);
    sideFilesFailed = failures.length > 0;
  } catch (e) {
    console.error(`::error::${SHORT_TITLES_RETRY_PATH} does not parse as JSON: ${e.message}`);
    sideFilesFailed = true;
  }
}
if (!existsSync(SHORT_TITLES_PATH)) {
  console.log(`${SHORT_TITLES_PATH} not present — nothing to check (the nightly writes it)`);
  process.exit(sideFilesFailed ? 1 : 0);
}
let data;
try {
  data = JSON.parse(readFileSync(SHORT_TITLES_PATH, 'utf8'));
} catch (e) {
  console.error(`::error::${SHORT_TITLES_PATH} does not parse as JSON: ${e.message}`);
  process.exit(1);
}
const { failures, notes } = verifyShortTitles({ data, bills });
for (const n of notes) console.log(n);
for (const f of failures) console.error(`::error::${f}`);
process.exit(failures.length || sideFilesFailed ? 1 : 0);
