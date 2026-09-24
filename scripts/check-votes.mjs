/**
 * Roll-call votes gate: data/votes.json is the government's record of who
 * voted how, and a wrong position attached to a real person is the one error
 * this file must never ship. Runs:
 *
 *   node scripts/check-votes.mjs --self-test   # the gate still rejects what it exists to reject
 *   node scripts/check-votes.mjs               # the committed / freshly synced file
 *
 * in sync-bills.yml BEFORE the commit step (beside verify-sync.mjs — every
 * integrity check is pre-commit, N8-A2), and in ci.yml, because
 * refresh-legislators.yml rewrites the legislators file this gate joins on.
 *
 * FAILS when:
 *   - the file doesn't parse, carries an unknown schema, or blew its size ceiling
 *   - a cursor is not CONGRESS-SESSION-ROLL (a date is damage here, exactly as
 *     a bare-date `lastSync` is damage to the bill sync), or `updatedAt` is not
 *     a seconds-precision ISO-8601 datetime, or is in the future
 *   - a roll call's totals disagree with its per-member positions — the
 *     totals come from the record's own tally (the House detail's party totals,
 *     the Senate's <count>), independently of the member list
 *   - a roll call names a bill that is not in data/bills.json, has no question
 *     or result text, no official source URL, a date before the file's floor or
 *     in the future, a duplicate id, or a member recorded twice
 *   - a member id resolves to nothing: not a current legislator, and not a
 *     roster record whose seat is one the chamber actually has (departed,
 *     replaced and newly sworn members resolve through their roster record;
 *     a House state with a vacancy in data/vacancies.json is reported as such)
 *
 * The judgement lives in lib/votes-core.mjs (verifyVotes) — the same function
 * scripts/sync-votes.mjs runs before it will write the file at all.
 *
 * A MISSING file is not a failure: scripts/sync-votes.mjs is what first
 * writes it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { VOTES_PATH, VOTES_SCHEMA, verifyVotes } from '../lib/votes-core.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

if (process.argv.includes('--self-test')) {
  const now = Date.parse('2026-09-24T12:00:00Z');
  const corpus = new Set(['hr-3633-119']);
  const legislators = [
    { bioguide: 'A000001', type: 'sen', state: 'MD' },
    { bioguide: 'B000002', type: 'sen', state: 'OK' },
    { bioguide: 'C000003', type: 'rep', state: 'NC' },
    { bioguide: 'E000005', type: 'sen', state: 'SC' }, // holds the seat side of the departed senator's state
  ];
  const vacancies = [{ state: 'TX', district: 23, since: '2026-07-05' }];
  const good = () => ({
    _meta: { schema: VOTES_SCHEMA, floor: '2026-05-27', updatedAt: '2026-09-24T04:00:00Z', cursor: { house: '119-2-314', senate: '119-2-241' } },
    rollCalls: [
      {
        id: 's-119-2-234', chamber: 'senate', congress: 119, session: 2, roll: 234, date: '2026-09-15',
        question: 'On Cloture on the Motion to Proceed H.R. 3633', result: 'Cloture on the Motion to Proceed Rejected',
        bill: 'hr-3633-119', totals: { yea: 1, nay: 1, present: 0, notVoting: 1 },
        source: 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00234.xml',
        votes: { yea: ['B000002'], nay: ['A000001'], present: [], notVoting: ['G000359'] },
      },
      {
        id: 'h-119-2-300', chamber: 'house', congress: 119, session: 2, roll: 300, date: '2026-09-15',
        question: 'On Passage', result: 'Passed', bill: 'hr-3633-119', totals: { yea: 1, nay: 0, present: 1, notVoting: 0 },
        source: 'https://clerk.house.gov/evs/2026/roll300.xml',
        votes: { yea: ['C000003'], nay: [], present: ['D000004'], notVoting: [] },
      },
    ],
    members: [
      { id: 'A000001', name: 'A One', state: 'MD', chamber: 'senate' },
      { id: 'B000002', name: 'B Two', state: 'OK', chamber: 'senate' },
      { id: 'C000003', name: 'C Three', state: 'NC', chamber: 'house' },
      { id: 'D000004', name: 'D Four', state: 'TX', chamber: 'house' }, // left a now-vacant TX seat
      { id: 'G000359', name: 'G Departed', state: 'SC', chamber: 'senate' }, // departed senator
    ],
  });
  const run = (data) => verifyVotes({ data, fileBytes: 1000, corpus, legislators, vacancies, now });
  const mutate = (fn) => { const d = good(); fn(d); return d; };
  const cases = [
    ['a total that disagrees with the positions', mutate((d) => { d.rollCalls[0].totals.yea = 2; })],
    ['a bill that is not in the corpus', mutate((d) => { d.rollCalls[0].bill = 'hr-9999-119'; })],
    ['a member id missing from the roster', mutate((d) => { d.members = d.members.filter((m) => m.id !== 'G000359'); })],
    ['a roster member in a seat the chamber does not have', mutate((d) => { d.members.find((m) => m.id === 'G000359').state = 'ZZ'; })],
    ['a bare-date cursor', mutate((d) => { d._meta.cursor.house = '2026-09-16'; })],
    ['a missing cursor', mutate((d) => { delete d._meta.cursor.senate; })],
    ['a fractional-seconds updatedAt', mutate((d) => { d._meta.updatedAt = '2026-09-24T04:00:00.123Z'; })],
    ['a member recorded twice in one roll call', mutate((d) => { d.rollCalls[0].votes.nay.push('B000002'); d.rollCalls[0].totals.nay = 2; })],
    ['an id that does not match its roll call', mutate((d) => { d.rollCalls[0].roll = 235; })],
    ['a roll call before the floor', mutate((d) => { d.rollCalls[0].date = '2026-05-01'; })],
    ['a non-official source URL', mutate((d) => { d.rollCalls[0].source = 'https://example.com/vote.xml'; })],
    ['an unknown schema', mutate((d) => { d._meta.schema = 99; })],
    ['a senate roster entry voting in the house', mutate((d) => { d.rollCalls[1].votes.yea = ['A000001']; })],
  ];
  let ok = true;
  for (const [name, data] of cases) {
    if (run(data).failures.length === 0) {
      console.error(`::error::check-votes --self-test: "${name}" was ACCEPTED by the gate`);
      ok = false;
    }
  }
  const verdict = run(good());
  if (verdict.failures.length > 0) {
    console.error(`::error::check-votes --self-test: a valid document was REJECTED: ${verdict.failures.join('; ')}`);
    ok = false;
  } else if (verdict.resolution.departed !== 1 || verdict.resolution.vacancy !== 1) {
    console.error('::error::check-votes --self-test: the departed / vacant-seat members did not resolve as such');
    ok = false;
  }
  if (!ok) process.exit(1);
  console.log(`check-votes --self-test passed (${cases.length} rejection cases, 1 valid document)`);
  process.exit(0);
}

if (!existsSync(VOTES_PATH)) {
  console.log(`check-votes: ${VOTES_PATH} does not exist yet — nothing to validate.`);
  process.exit(0);
}

let data;
try {
  data = readJson(VOTES_PATH);
} catch (e) {
  console.error(`::error::check-votes: ${VOTES_PATH} does not parse as JSON: ${e.message}`);
  process.exit(1);
}
const { failures, warnings, notes } = verifyVotes({
  data,
  fileBytes: statSync(VOTES_PATH).size,
  corpus: new Set(readJson('data/bills.json').map((b) => b.full_identifier)),
  legislators: readJson('data/legislators.json'),
  vacancies: readJson('data/vacancies.json'),
});
for (const n of notes) console.log(`check-votes: ${n}`);
for (const w of warnings) console.log(`::warning::check-votes: ${w}`);
if (failures.length) {
  for (const f of failures.slice(0, 50)) console.error(`::error::check-votes: ${f}`);
  if (failures.length > 50) console.error(`::error::check-votes: …and ${failures.length - 50} more`);
  process.exit(1);
}
console.log('check-votes passed');
