import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CURSOR_RE,
  VOTES_SCHEMA,
  VoteParseError,
  houseClerkDate,
  parseHouseApi,
  parseHouseClerkXml,
  parseSenateMenu,
  parseSenateXml,
  positionOf,
  resolveBillId,
  senateDate,
  sessionForYear,
  verifyVotes,
} from '../lib/votes-core.mjs';
import { memberPosition, votesForBill, votingMember } from '../lib/votes';
import type { Legislator, Vacancy, VotesFile } from '../lib/types';

/*
 * Roll-call votes (plan item C1a, the data half). Fixtures in
 * tests/fixtures/votes are the REAL records, fetched 2026-09-24, redacted to a
 * few members each. The redaction also rewrote each fixture's TOTALS to match
 * the members it kept (the record's own totals are for the full chamber), so
 * the totals-vs-positions check still has something true to compare:
 *   house-api-*-119-2-308     Congress.gov API, H.R. 5334 motion to concur
 *   clerk-roll300-rule.xml    clerk.house.gov, the H.Res. 1530 RULE vote
 *   senate-vote-119-2-00234   senate.gov, cloture on the motion to proceed to H.R. 3633
 *   senate-vote-…-00240-…     senate.gov, cloture on an amendment to S. 4668
 *   senate-vote-menu-119-2    senate.gov per-session menu, rolls 232-238
 */

const fx = (name: string) => readFileSync(join(process.cwd(), 'tests/fixtures/votes', name), 'utf8');
const fxJson = (name: string) => JSON.parse(fx(name));
const corpus = new Set(['hr-3633-119', 'hr-5334-119', 's-4668-119']);
const lis: Record<string, string> = { S440: 'A000382', S428: 'A000383', S337: 'C001088' };
const lisToBioguide = (id: string) => lis[id] ?? null;

test.describe('House parse', () => {
  test('Congress.gov API: positions, totals, bill, date, source', () => {
    const { roll, members } = parseHouseApi(
      fxJson('house-api-detail-119-2-308.json'),
      fxJson('house-api-members-119-2-308.json'),
      { corpus, sourceUrl: 'https://clerk.house.gov/evs/2026/roll308.xml' }
    );
    expect(roll.id).toBe('h-119-2-308');
    expect(roll.bill).toBe('hr-5334-119');
    expect(roll.date).toBe('2026-09-16');
    expect(roll.question).toBe('On Motion to Concur in the Senate Amendments');
    expect(roll.result).toBe('Passed');
    expect(roll.totals).toEqual({ yea: 2, nay: 1, present: 0, notVoting: 1 });
    expect(roll.votes.yea).toHaveLength(2);
    expect(roll.votes.nay).toHaveLength(1);
    expect(roll.votes.notVoting).toHaveLength(1);
    expect(roll.source).toBe('https://clerk.house.gov/evs/2026/roll308.xml');
    expect(members.every((m) => /^[A-Z]\d{6}$/.test(m.id) && m.state.length === 2)).toBe(true);
  });

  test('Clerk XML fallback: Aye/No are counted as yea/nay, exactly as the Clerk totals them', () => {
    const xml = fx('clerk-roll300-rule.xml').replace('<legis-num>H RES 1530</legis-num>', '<legis-num>H R 3633</legis-num>');
    const { roll } = parseHouseClerkXml(xml, { corpus, sourceUrl: 'https://clerk.house.gov/evs/2026/roll300.xml' });
    expect(roll.id).toBe('h-119-2-300');
    expect(roll.date).toBe('2026-09-15');
    expect(roll.bill).toBe('hr-3633-119');
    expect(roll.votes).toEqual({ yea: ['A000055'], nay: ['A000370'], present: [], notVoting: ['D000032'] });
    expect(roll.totals).toEqual({ yea: 1, nay: 1, present: 0, notVoting: 1 });
  });

  test('a RULE vote never attaches to the bills it schedules', () => {
    // The real roll 300 is H.Res. 1530, whose vote-desc names H.R. 9576, H.R.
    // 10326 and H.R. 5334. The rule is its own measure; the record says so.
    const { roll } = parseHouseClerkXml(fx('clerk-roll300-rule.xml'), { corpus: new Set(['hr-5334-119', 'hr-9576-119']) });
    expect(roll.bill).toBeNull();
  });
});

test.describe('Senate parse', () => {
  test('cloture on the motion to proceed to H.R. 3633 counts for hr-3633-119', () => {
    const { roll, members } = parseSenateXml(fx('senate-vote-119-2-00234.xml'), {
      corpus,
      sourceUrl: 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00234.xml',
      lisToBioguide,
    });
    expect(roll.id).toBe('s-119-2-234');
    expect(roll.bill).toBe('hr-3633-119');
    expect(roll.date).toBe('2026-09-15');
    expect(roll.question).toBe('On Cloture on the Motion to Proceed H.R. 3633');
    expect(roll.result).toBe('Cloture on the Motion to Proceed Rejected');
    expect(roll.totals).toEqual({ yea: 1, nay: 1, present: 0, notVoting: 1 });
    expect(roll.votes).toEqual({ yea: ['A000382'], nay: ['A000383'], present: [], notVoting: ['C001088'] });
    expect(members.map((m) => m.state).sort()).toEqual(['DE', 'MD', 'OK']);
  });

  test('an amendment vote resolves through amendment_to_document_number', () => {
    const { roll } = parseSenateXml(fx('senate-vote-119-2-00240-amendment.xml'), { corpus, lisToBioguide: () => 'X000001' });
    expect(roll.bill).toBe('s-4668-119');
    expect(roll.question).toContain('S.Amdt. 6776 to S. 4668');
  });

  test('a senator whose LIS id maps to no one is refused, not guessed', () => {
    expect(() => parseSenateXml(fx('senate-vote-119-2-00234.xml'), { corpus, lisToBioguide: () => null })).toThrow(VoteParseError);
  });

  test('the per-session menu: dates from <congress_year>, issues verbatim', () => {
    const menu = parseSenateMenu(fx('senate-vote-menu-119-2.xml'));
    expect(menu.map((v) => v.roll)).toEqual([238, 237, 236, 235, 234, 233, 232]);
    const v234 = menu.find((v) => v.roll === 234)!;
    expect(v234).toMatchObject({ date: '2026-09-15', issue: 'H.R. 3633' });
    expect(resolveBillId([v234.issue, v234.question], corpus, 119)).toBe('hr-3633-119');
    // Nomination votes (PN…) are not bills and never resolve.
    expect(resolveBillId([menu.find((v) => v.roll === 233)!.issue], corpus, 119)).toBeNull();
  });

  test('record date formats', () => {
    expect(senateDate('September 15, 2026,  02:19 PM')).toBe('2026-09-15');
    expect(houseClerkDate('15-Sep-2026')).toBe('2026-09-15');
    expect(() => senateDate('yesterday')).toThrow(VoteParseError);
  });
});

test.describe('bill-id resolution from the vote question', () => {
  test('tracked types resolve; simple resolutions and amendments do not', () => {
    expect(resolveBillId(['On Cloture on the Motion to Proceed H.R. 3633'], corpus, 119)).toBe('hr-3633-119');
    expect(resolveBillId(['H RES 1530'], new Set(['hres-1530-119']), 119)).toBeNull();
    expect(resolveBillId(['S.Amdt. 6776', 'S. 4668'], corpus, 119)).toBe('s-4668-119');
  });

  test('the FIRST candidate that names a bill decides, and only a corpus bill counts', () => {
    // A structured field naming a non-corpus bill must not fall through to a
    // corpus bill mentioned later in free text.
    expect(resolveBillId(['HR 9999', 'H.R. 3633'], corpus, 119)).toBeNull();
    expect(resolveBillId([null, undefined, 'H.R. 3633'], corpus, 119)).toBe('hr-3633-119');
  });

  test('the id is built for the vote\'s own Congress', () => {
    expect(resolveBillId(['H.R. 3633'], new Set(['hr-3633-120']), 120)).toBe('hr-3633-120');
  });

  test('positions: the record vocabulary only; anything novel throws', () => {
    expect(['Yea', 'Aye', 'Nay', 'No', 'Present', 'Not Voting'].map(positionOf)).toEqual([
      'yea', 'yea', 'nay', 'nay', 'present', 'notVoting',
    ]);
    expect(() => positionOf('Guilty')).toThrow(VoteParseError);
    expect(() => positionOf('Jeffries')).toThrow(VoteParseError);
  });

  test('sessions of the 119th Congress', () => {
    expect(sessionForYear(119, 2025)).toBe(1);
    expect(sessionForYear(119, 2026)).toBe(2);
    expect(sessionForYear(119, 2027)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The gate, and the departed-member path through it.
 * ------------------------------------------------------------------ */
const legislators = [
  { bioguide: 'A000382', type: 'sen', state: 'OK' },
  { bioguide: 'A000383', type: 'sen', state: 'MD' },
  { bioguide: 'C000127', type: 'sen', state: 'DE' },
];
const vacancies = [{ state: 'TX', district: 23, since: '2026-07-05' }];
const NOW = Date.parse('2026-09-24T12:00:00Z');

function docFromSenate234() {
  const { roll, members } = parseSenateXml(fx('senate-vote-119-2-00234.xml'), {
    corpus,
    sourceUrl: 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00234.xml',
    lisToBioguide,
  });
  return {
    _meta: { schema: VOTES_SCHEMA, floor: '2026-05-27', updatedAt: '2026-09-24T04:00:00Z', cursor: { house: '119-2-314', senate: '119-2-241' } },
    rollCalls: [roll],
    members: members.map((m) => ({ ...m, chamber: 'senate' })),
  };
}
const judge = (data: unknown) => verifyVotes({ data, fileBytes: 1000, corpus, legislators, vacancies, now: NOW });

test.describe('check-votes gate', () => {
  test('a departed senator (not in data/legislators.json) resolves through the roster and passes', () => {
    // C001088 voted on 234 but is not a current legislator in this fixture —
    // the same shape as a senator who has since left or been replaced.
    const v = judge(docFromSenate234());
    expect(v.failures).toEqual([]);
    expect(v.resolution).toEqual({ current: 2, vacancy: 0, departed: 1 });
  });

  test('a departed House member from a now-vacant state resolves as a vacancy', () => {
    const d = docFromSenate234();
    d.rollCalls.push({
      id: 'h-119-2-200', chamber: 'house', congress: 119, session: 2, roll: 200, date: '2026-06-10',
      question: 'On Passage', result: 'Passed', bill: 'hr-3633-119', totals: { yea: 1, nay: 0, present: 0, notVoting: 0 },
      source: 'https://clerk.house.gov/evs/2026/roll200.xml', votes: { yea: ['G000594'], nay: [], present: [], notVoting: [] },
    } as never);
    d.members.push({ id: 'G000594', name: 'Former Member', state: 'TX', chamber: 'house' });
    const v = judge(d);
    expect(v.failures).toEqual([]);
    expect(v.resolution.vacancy).toBe(1);
  });

  test('failure modes', () => {
    const cases: Array<[string, (d: ReturnType<typeof docFromSenate234>) => void, RegExp]> = [
      ['totals disagree', (d) => { d.rollCalls[0].totals.yea = 5; }, /totals\.yea is 5/],
      ['bill not in corpus', (d) => { d.rollCalls[0].bill = 'hr-1-119'; }, /not in data\/bills\.json/],
      ['member missing from roster', (d) => { d.members.pop(); }, /not in the members roster/],
      ['member resolves to no seat', (d) => { d.members[2].state = 'ZZ'; }, /resolves to no legislator/],
      ['bare-date cursor', (d) => { d._meta.cursor.senate = '2026-09-22'; }, /not CONGRESS-SESSION-ROLL/],
      ['fractional-seconds updatedAt', (d) => { d._meta.updatedAt = '2026-09-24T04:00:00.862Z'; }, /seconds-precision/],
      ['future-dated roll call', (d) => { d.rollCalls[0].date = '2026-12-01'; }, /future/],
      ['duplicate member', (d) => { d.rollCalls[0].votes.nay.push(d.rollCalls[0].votes.yea[0]); d.rollCalls[0].totals.nay++; }, /recorded twice/],
    ];
    for (const [name, mutate, re] of cases) {
      const d = docFromSenate234();
      mutate(d);
      const v = judge(d);
      expect(v.failures.some((f: string) => re.test(f)), `${name}: ${v.failures.join(' | ')}`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The committed file: schema pin + the real data passes the real gate.
 * ------------------------------------------------------------------ */
test.describe('data/votes.json', () => {
  const raw = readFileSync(join(process.cwd(), 'data/votes.json'), 'utf8');
  const data = JSON.parse(raw) as VotesFile;

  test('schema is pinned', () => {
    expect(Object.keys(data)).toEqual(['_meta', 'rollCalls', 'members']);
    expect(Object.keys(data._meta)).toEqual(['schema', 'floor', 'updatedAt', 'cursor', 'sources']);
    expect(data._meta.schema).toBe(1);
    expect(CURSOR_RE.test(data._meta.cursor.house) && CURSOR_RE.test(data._meta.cursor.senate)).toBe(true);
    for (const r of data.rollCalls) {
      const keys = Object.keys(r).filter((k) => k !== 'tieBreaker');
      expect(keys).toEqual(['id', 'chamber', 'congress', 'session', 'roll', 'date', 'question', 'result', 'bill', 'totals', 'source', 'votes']);
      expect(Object.keys(r.totals)).toEqual(['yea', 'nay', 'present', 'notVoting']);
      expect(Object.keys(r.votes)).toEqual(['yea', 'nay', 'present', 'notVoting']);
    }
    for (const m of data.members) expect(Object.keys(m)).toEqual(['id', 'name', 'state', 'chamber']);
    // Nonpartisan by construction: the vote record carries no party at all.
    expect(raw).not.toMatch(/"party"/);
  });

  test('the committed file passes the gate against the committed corpus', () => {
    const read = (p: string) => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8'));
    const v = verifyVotes({
      data,
      fileBytes: Buffer.byteLength(raw),
      corpus: new Set((read('data/bills.json') as Array<{ full_identifier: string }>).map((b) => b.full_identifier)),
      legislators: read('data/legislators.json') as Legislator[],
      vacancies: read('data/vacancies.json') as Vacancy[],
    });
    expect(v.failures).toEqual([]);
  });

  test('every senator in data/legislators.json carries an LIS id (the Senate join key)', () => {
    const legs = JSON.parse(readFileSync(join(process.cwd(), 'data/legislators.json'), 'utf8')) as Legislator[];
    const sens = legs.filter((l) => l.type === 'sen');
    expect(sens).toHaveLength(100);
    expect(sens.filter((l) => /^S\d{3}$/.test(l.lis ?? ''))).toHaveLength(100);
  });
});

test.describe('lib/votes read helpers', () => {
  test('votesForBill + memberPosition over the committed file', () => {
    const rolls = votesForBill('hr-3633-119');
    const cloture = rolls.find((r) => r.id === 's-119-2-234');
    expect(cloture, 'the Sep 15 cloture vote on H.R. 3633').toBeTruthy();
    expect(cloture!.totals).toEqual({ yea: 49, nay: 50, present: 0, notVoting: 1 });
    const someNay = cloture!.votes.nay[0];
    expect(memberPosition(cloture!, someNay)).toBe('nay');
    expect(memberPosition(cloture!, 'Z999999')).toBeNull();
    expect(votingMember(someNay)?.chamber).toBe('senate');
    // Newest first.
    for (let i = 1; i < rolls.length; i++) expect(rolls[i - 1].date >= rolls[i].date).toBe(true);
    expect(votesForBill('hr-0-119')).toEqual([]);
  });
});
