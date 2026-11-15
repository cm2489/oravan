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
import { SHORT_TITLES_PATH, verifyShortTitles } from '../lib/short-titles.mjs';

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
    ['a bill the corpus does not hold', { ...good, 's-6-119': { titles: [], as_of: null, ...R } }, null, true],
    ['an extra field', { ...good, 's-5-119': { titles: ['Laken Riley Act'], as_of: null, ...R, popular: 'x' } }, null, true],
    ['an empty title', { ...good, 's-5-119': { titles: [' '], as_of: null, ...R } }, null, true],
    ['a repeated title', { ...good, 's-5-119': { titles: ['A Act', 'A Act'], as_of: null, ...R } }, null, true],
    ['titles out of order', { ...good, 's-5-119': { titles: ['B Act', 'A Act'], as_of: null, ...R } }, null, true],
    ['a control character', { ...good, 's-5-119': { titles: ['A\nAct'], as_of: null, ...R } }, null, true],
    ['a bad as_of', { ...good, 's-5-119': { titles: [], as_of: 'yesterday', ...R } }, null, true],
    ['no read_on', { ...good, 's-5-119': { titles: [], as_of: null } }, null, true],
    ['a bad read_on', { ...good, 's-5-119': { titles: [], as_of: null, read_on: 'today' } }, null, true],
    ['a bill that lost its titles overnight', { ...good, 's-5-119': { titles: [], as_of: null, ...R } }, good, true],
  ];
  let bad = 0;
  for (const [label, data, before, shouldFail] of cases) {
    const { failures } = verifyShortTitles({ data, bills, before });
    if ((failures.length > 0) !== shouldFail) {
      bad++;
      console.error(`::error::self-test: ${label}: expected ${shouldFail ? 'a failure' : 'no failure'}, got ${JSON.stringify(failures)}`);
    }
  }
  if (bad) process.exit(1);
  console.log(`check-short-titles self-test: ${cases.length} case(s) behave`);
  process.exit(0);
}

if (!existsSync(SHORT_TITLES_PATH)) {
  console.log(`${SHORT_TITLES_PATH} not present — nothing to check (the nightly writes it)`);
  process.exit(0);
}
const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
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
process.exit(failures.length ? 1 : 0);
