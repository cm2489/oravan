import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CURSOR_RE,
  PARTY_RE,
  VOTES_SCHEMA,
  VoteParseError,
  VotePartyDisagreement,
  finishPartyTotals,
  hasPartyTotals,
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
import { MEMBER_VOTES_MAX_BILLS, memberPosition, memberVotesByBill, votesForBill, votingMember } from '../lib/votes';
import { getBill } from '../lib/core';
import type { Legislator, RollCall, Vacancy, VotesFile } from '../lib/types';

/*
 * Roll-call votes (plan item C1a, the data half). Fixtures in
 * tests/fixtures/votes are the REAL records, fetched 2026-09-24, redacted to a
 * few members each. The redaction also rewrote each fixture's TOTALS to match
 * the members it kept (the record's own totals are for the full chamber), so
 * the totals-vs-positions check still has something true to compare. The
 * Clerk fixtures' <totals-by-party> rows and the Congress.gov detail's
 * `votePartyTotal` were rewritten the same way on 2026-09-29, in the record's
 * own shape (the Clerk lists "Independent" at zero when no member is one):
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
    // The detail reply's own party table, keyed by its `voteParty` letter.
    expect(roll.totalsByParty).toEqual({
      D: { yea: 1, nay: 1, present: 0, notVoting: 1 },
      R: { yea: 1, nay: 0, present: 0, notVoting: 0 },
    });
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
    // <totals-by-party>, lettered as the member rows are; the Clerk's
    // "Independent" row at zero counts nobody and is left out.
    expect(roll.totalsByParty).toEqual({
      D: { yea: 0, nay: 1, present: 0, notVoting: 0 },
      R: { yea: 1, nay: 0, present: 0, notVoting: 1 },
    });
  });

  test('Clerk XML: the party table must agree with the member rows, or nothing is stored', () => {
    const xml = fx('clerk-roll300-rule.xml').replace('<legis-num>H RES 1530</legis-num>', '<legis-num>H R 3633</legis-num>');
    // One Republican yea moved to the Democratic row: the totals still add up,
    // but the record now disagrees with itself about who cast them.
    const swapped = xml
      .replace(/(<party>Republican<\/party>\s*<yea-total>)1</, '$10<')
      .replace(/(<party>Democratic<\/party>\s*<yea-total>)0</, '$11<');
    expect(swapped).not.toBe(xml);
    expect(() => parseHouseClerkXml(swapped, { corpus })).toThrow(/disagrees with the member rows/);
    // A party name the table cannot place is not given a guessed letter.
    expect(() => parseHouseClerkXml(xml.replace('<party>Independent</party>', '<party>Libertarian</party>'), { corpus })).toThrow(
      /cannot place/
    );
    // No party table at all: not stored.
    expect(() => parseHouseClerkXml(xml.replace(/<totals-by-party>[\s\S]*?<\/totals-by-party>/g, ''), { corpus })).toThrow(
      /no <totals-by-party>/
    );
    // A member row with no party letter: not stored.
    expect(() => parseHouseClerkXml(xml.replace(' party="D"', ''), { corpus })).toThrow(/without a party letter/);
  });

  test('a Congress.gov party total without a letter is refused', () => {
    const detail = fxJson('house-api-detail-119-2-308.json');
    delete detail.houseRollCallVote.votePartyTotal[0].voteParty;
    delete detail.houseRollCallVote.votePartyTotal[0].party;
    expect(() => parseHouseApi(detail, fxJson('house-api-members-119-2-308.json'), { corpus })).toThrow(/without a party letter/);
  });

  test('Congress.gov: the party table must agree with the members reply, or the Clerk is read instead', () => {
    // One Democratic yea moved to the Republican row: the totals still add up,
    // but the API now disagrees with its own member rows about who cast them.
    const detail = fxJson('house-api-detail-119-2-308.json');
    const rows = detail.houseRollCallVote.votePartyTotal;
    const r = rows.find((p: { voteParty: string }) => p.voteParty === 'R');
    const d = rows.find((p: { voteParty: string }) => p.voteParty === 'D');
    r.yeaTotal += 1;
    d.yeaTotal -= 1;
    const members = fxJson('house-api-members-119-2-308.json');
    const swapped = (() => {
      try {
        parseHouseApi(detail, members, { corpus });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(swapped).toBeInstanceOf(VotePartyDisagreement);
    expect(String((swapped as Error).message)).toMatch(/disagrees with the member rows/);
    // NOT a VoteParseError: scripts/sync-votes.mjs rethrows those and falls
    // back to the Clerk's XML (the roll call's cited source) on anything else.
    expect(swapped).not.toBeInstanceOf(VoteParseError);

    // A member row with no party letter: the table cannot be checked, same path.
    const unlettered = fxJson('house-api-members-119-2-308.json');
    delete unlettered.houseRollCallVoteMemberVotes.results[0].voteParty;
    expect(() => parseHouseApi(fxJson('house-api-detail-119-2-308.json'), unlettered, { corpus })).toThrow(VotePartyDisagreement);
  });

  test('scripts/sync-votes.mjs falls back to the Clerk on a party disagreement, and rethrows only a VoteParseError', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/sync-votes.mjs'), 'utf8');
    const call = src.indexOf('parsed = parseHouseApi(');
    const handler = src.slice(call, src.indexOf('stats.house.viaClerk++', call));
    expect(handler).toMatch(/if \(e instanceof VoteParseError\) throw e;/);
    expect(handler).not.toMatch(/VotePartyDisagreement\) throw/);
    expect(handler).toMatch(/parseHouseClerkXml\(/);
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
    // No party table in the Senate's XML: each member's own <party>, counted.
    expect(roll.totalsByParty).toEqual({
      D: { yea: 0, nay: 1, present: 0, notVoting: 1 },
      R: { yea: 1, nay: 0, present: 0, notVoting: 0 },
    });
  });

  test('a senator with no party letter in the record is refused, not guessed', () => {
    const xml = fx('senate-vote-119-2-00234.xml').replace('<party>R</party>', '<party></party>');
    expect(() => parseSenateXml(xml, { corpus, lisToBioguide })).toThrow(/no party letter/);
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

test.describe('the stored count by party', () => {
  test('finishPartyTotals: letter order, record position order, parties at zero left out', () => {
    expect(
      finishPartyTotals({
        R: { notVoting: 9, present: 0, nay: 132, yea: 77 },
        I: { yea: 0, nay: 0, present: 0, notVoting: 0 },
        D: { yea: 187, nay: 1, present: 0, notVoting: 26 },
      })
    ).toEqual({ D: { yea: 187, nay: 1, present: 0, notVoting: 26 }, R: { yea: 77, nay: 132, present: 0, notVoting: 9 } });
    expect(JSON.stringify(finishPartyTotals({ R: { notVoting: 1, present: 0, nay: 0, yea: 2 } }))).toBe(
      '{"R":{"yea":2,"nay":0,"present":0,"notVoting":1}}'
    );
  });

  test('hasPartyTotals: a roll call written before 2026-09-29 is not held', () => {
    expect(hasPartyTotals({ totalsByParty: { R: { yea: 1, nay: 0, present: 0, notVoting: 0 } } })).toBe(true);
    expect(hasPartyTotals({})).toBe(false);
    expect(hasPartyTotals({ totalsByParty: {} })).toBe(false);
    expect(hasPartyTotals(undefined)).toBe(false);
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
      totalsByParty: { R: { yea: 1, nay: 0, present: 0, notVoting: 0 } },
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
      ['no count by party', (d) => { delete (d.rollCalls[0] as Partial<RollCall>).totalsByParty; }, /no totalsByParty/],
      ['count by party off the tally', (d) => { d.rollCalls[0].totalsByParty!.D.nay = 2; }, /totalsByParty adds up to 2 nay, but totals\.nay is 1/],
      ['a party name where the letter goes', (d) => { const t = d.rollCalls[0].totalsByParty!; d.rollCalls[0].totalsByParty = { Democratic: t.D, R: t.R }; }, /not a party letter/],
      ['a party counting no member', (d) => { d.rollCalls[0].totalsByParty!.I = { yea: 0, nay: 0, present: 0, notVoting: 0 }; }, /counts no member/],
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
      expect(keys).toEqual(['id', 'chamber', 'congress', 'session', 'roll', 'date', 'question', 'result', 'bill', 'totals', 'totalsByParty', 'source', 'votes']);
      expect(Object.keys(r.totals)).toEqual(['yea', 'nay', 'present', 'notVoting']);
      expect(Object.keys(r.votes)).toEqual(['yea', 'nay', 'present', 'notVoting']);
      // The count by party: the record's letters, in letter order.
      const byParty = r.totalsByParty ?? {};
      const parties = Object.keys(byParty);
      expect(parties.every((p) => PARTY_RE.test(p)), `${r.id}: ${parties.join(',')}`).toBe(true);
      expect(parties).toEqual([...parties].sort());
      for (const p of parties) expect(Object.keys(byParty[p])).toEqual(['yea', 'nay', 'present', 'notVoting']);
    }
    for (const m of data.members) expect(Object.keys(m)).toEqual(['id', 'name', 'state', 'chamber']);
    // Nonpartisan by construction: no MEMBER carries a party in this file.
    // The one party data here is each roll call's count by party, keyed by
    // the record's own letter.
    expect(raw).not.toMatch(/"party"/);
  });

  test('every roll call carries its count by party (2026-09-29)', () => {
    const missing = data.rollCalls.filter((r) => !hasPartyTotals(r)).map((r) => r.id);
    expect(missing).toEqual([]);
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

/*
 * THE MEMBER PAGE'S "HOW THEY VOTED" SELECTION (owner, UX inventory R04,
 * 2026-09-28). Recomputed from the committed file at assert time, never a
 * pinned count, so a nightly that adds roll calls cannot break this block —
 * only a selection that drops, duplicates, re-words or mis-orders one can.
 */
test.describe('lib/votes memberVotesByBill', () => {
  const file = JSON.parse(readFileSync(join(process.cwd(), 'data/votes.json'), 'utf8')) as VotesFile;
  const listed = (id: string) => file.rollCalls.filter((r) => memberPosition(r, id) !== null);
  const everyone = [...new Set(file.rollCalls.flatMap((r) => Object.values(r.votes).flat()))];
  const house = everyone.find((id) => listed(id).some((r) => r.chamber === 'house'))!;
  const senate = everyone.find((id) => listed(id).some((r) => r.chamber === 'senate'))!;

  test('every roll call that lists the member appears once, with the position the record gives', () => {
    for (const id of [house, senate]) {
      const groups = memberVotesByBill(id);
      const flat = groups.flatMap((g) => g.votes);
      expect(flat.map((v) => v.rollCall.id).sort()).toEqual(listed(id).map((r) => r.id).sort());
      expect(flat.filter((v) => v.position !== memberPosition(v.rollCall, id)).map((v) => v.rollCall.id)).toEqual([]);
      expect(groups.flatMap((g) => g.votes.filter((v) => v.rollCall.bill !== g.bill).map((v) => v.rollCall.id))).toEqual([]);
      expect(new Set(groups.map((g) => g.bill)).size).toBe(groups.length);
    }
  });

  // The roster-wide checks below collect every miss and assert ONCE: since
  // the 2026-09-29 back-fill the file holds the whole Congress (~550 members,
  // ~130,000 member-votes), and one expect() per vote took minutes.
  test('the whole roster: no member gains or loses a roll call', () => {
    const misses: string[] = [];
    for (const id of everyone) {
      const got = memberVotesByBill(id).reduce((n, g) => n + g.votes.length, 0);
      const want = listed(id).length;
      if (got !== want) misses.push(`${id}: ${got} listed, ${want} on record`);
    }
    expect(misses).toEqual([]);
  });

  test('newest first — bills by the member’s newest vote, and each bill’s votes newest first', () => {
    const before = (a: RollCall, b: RollCall) =>
      a.date > b.date || (a.date === b.date && (a.chamber < b.chamber || (a.chamber === b.chamber && a.roll > b.roll)));
    const misses: string[] = [];
    for (const id of everyone) {
      const groups = memberVotesByBill(id);
      for (const g of groups) {
        for (let i = 1; i < g.votes.length; i++) {
          if (!before(g.votes[i - 1].rollCall, g.votes[i].rollCall)) misses.push(`${id} ${g.bill}: ${g.votes[i - 1].rollCall.id} before ${g.votes[i].rollCall.id}`);
        }
      }
      for (let i = 1; i < groups.length; i++) {
        if (!before(groups[i - 1].votes[0].rollCall, groups[i].votes[0].rollCall)) misses.push(`${id}: bill ${groups[i - 1].bill} before ${groups[i].bill}`);
      }
    }
    expect(misses).toEqual([]);
  });

  test('"Not voting" is a recorded position and is kept, not dropped', () => {
    const r = file.rollCalls.find((x) => x.votes.notVoting.length > 0);
    test.skip(!r, 'no stored roll call lists a member as not voting');
    const id = r!.votes.notVoting[0];
    const hit = memberVotesByBill(id)
      .flatMap((g) => g.votes)
      .find((v) => v.rollCall.id === r!.id);
    expect(hit?.position).toBe('notVoting');
  });

  test('a member no stored roll call lists gets an empty list, not a guess', () => {
    expect(memberVotesByBill('Z999999')).toEqual([]);
    const legs = JSON.parse(readFileSync(join(process.cwd(), 'data/legislators.json'), 'utf8')) as Legislator[];
    for (const l of legs.filter((x) => !everyone.includes(x.bioguide))) {
      expect(memberVotesByBill(l.bioguide), l.bioguide).toEqual([]);
    }
  });

  // The member page lists the newest MEMBER_VOTES_MAX_BILLS bills and says
  // of the rest that "each bill's page lists its recorded votes". That page
  // renders votesForBill (components/VoteRecord.tsx), so the line is true only
  // while every left-out vote is among its bill's stored roll calls.
  test('past the member-page cap, every left-out vote is on its bill page\'s record', () => {
    expect(Number.isInteger(MEMBER_VOTES_MAX_BILLS) && MEMBER_VOTES_MAX_BILLS > 0).toBe(true);
    const misses: string[] = [];
    for (const id of everyone) {
      for (const g of memberVotesByBill(id).slice(MEMBER_VOTES_MAX_BILLS)) {
        const onBill = new Set(votesForBill(g.bill).map((r) => r.id));
        for (const v of g.votes) if (!onBill.has(v.rollCall.id)) misses.push(`${id} ${v.rollCall.id}`);
      }
    }
    expect(misses).toEqual([]);
  });

  test('every voted bill is a corpus bill the row can show', () => {
    for (const id of [house, senate]) {
      for (const g of memberVotesByBill(id)) expect(getBill(g.bill), g.bill).toBeTruthy();
    }
  });
});
