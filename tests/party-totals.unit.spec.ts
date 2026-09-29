import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { partyGroups, partyTotalsLine, positionsToPrint, type PartyTotalsT } from '../lib/party-totals';
import { settledVoteGroups } from '../lib/settled-votes';
import type { RollCall, RollCallTotals, VotesFile } from '../lib/types';

/*
 * THE COUNT BY PARTY, AS ONE LINE OF TEXT (the owner's card l12, 2026-09-29:
 * "Show me these. I don't see them."). components/PartyTotals.tsx prints
 * lib/party-totals.ts `partyTotalsLine`; these tests drive that function with
 * the REAL messages in both languages and the REAL roll calls in
 * data/votes.json, so what is asserted here is what the page prints.
 */

const translator = (locale: 'en' | 'es'): PartyTotalsT => {
  const t = createTranslator({ locale, messages: locale === 'en' ? en : es, namespace: 'partyTotals' });
  return (key, values) => t(key, values);
};
const tEn = translator('en');
const tEs = translator('es');

const votes = JSON.parse(readFileSync(join(process.cwd(), 'data/votes.json'), 'utf8')) as VotesFile;
const roll = (id: string) => {
  const r = votes.rollCalls.find((x) => x.id === id);
  expect(r, `${id} is in data/votes.json`).toBeTruthy();
  return r as RollCall;
};
const c = (yea: number, nay: number, present = 0, notVoting = 0): RollCallTotals => ({ yea, nay, present, notVoting });

test.describe('the line, in words, for roll calls the owner has looked at', () => {
  test('H.Con.Res. 89, Senate roll 244 (rejected 49–50, 2026-09-24)', () => {
    const r = roll('s-119-2-244');
    expect(partyTotalsLine(r.totalsByParty, tEn)).toBe(
      'Republicans 4 yes, 49 no · Democrats 43 yes, 1 no, 1 not voting · Independents 2 yes'
    );
    expect(partyTotalsLine(r.totalsByParty, tEs)).toBe(
      'Republicanos: 4 sí, 49 no · Demócratas: 43 sí, 1 no, 1 no votó · Independientes: 2 sí'
    );
  });

  test('H.Con.Res. 86, House roll 199 (215–208, 2026-06-03): one Independent reads in the singular', () => {
    const r = roll('h-119-2-199');
    expect(partyTotalsLine(r.totalsByParty, tEn)).toBe(
      'Republicans 4 yes, 207 no, 6 not voting · Democrats 211 yes, 1 not voting · Independent 1 no'
    );
    expect(partyTotalsLine(r.totalsByParty, tEs)).toBe(
      'Republicanos: 4 sí, 207 no, 6 no votaron · Demócratas: 211 sí, 1 no votó · Independiente: 1 no'
    );
  });
});

test.describe('what the line may and may not do', () => {
  test('order: largest group first; a tie goes to the letter; the rule never looks at which party it is', () => {
    expect(partyGroups({ D: c(45, 2), R: c(2, 48), I: c(2, 0) }).map((g) => g.party)).toEqual(['R', 'D', 'I']);
    expect(partyGroups({ D: c(49, 2), R: c(2, 45), I: c(2, 0) }).map((g) => g.party)).toEqual(['D', 'R', 'I']);
    // Equal sizes: the record's letters, alphabetically.
    expect(partyGroups({ R: c(50, 0), D: c(0, 50) }).map((g) => g.party)).toEqual(['D', 'R']);
    // Size counts every member listed, not only those who voted yes or no.
    expect(partyGroups({ D: c(40, 0, 0, 10), R: c(45, 0) }).map((g) => g.party)).toEqual(['D', 'R']);
  });

  test('symmetric: swapping two parties\' numbers swaps their names and nothing else', () => {
    const a = partyTotalsLine({ D: c(45, 2), R: c(2, 48) }, tEn);
    const b = partyTotalsLine({ D: c(2, 48), R: c(45, 2) }, tEn);
    expect(a).toBe('Republicans 2 yes, 48 no · Democrats 45 yes, 2 no');
    expect(b).toBe('Democrats 2 yes, 48 no · Republicans 45 yes, 2 no');
    expect(a.replace(/Republicans|Democrats/g, 'X')).toBe(b.replace(/Republicans|Democrats/g, 'X'));
  });

  test('a position no member holds is not printed; a party with no member is not a group', () => {
    expect(positionsToPrint({ party: 'I', size: 2, counts: c(2, 0) })).toEqual(['yea']);
    expect(partyTotalsLine({ R: c(0, 0), D: c(0, 3, 1) }, tEn)).toBe('Democrats 3 no, 1 present');
    expect(partyTotalsLine({ R: c(0, 0), D: c(0, 3, 2) }, tEs)).toBe('Demócratas: 3 no, 2 presentes');
  });

  test('a letter the messages do not name prints as the record writes it', () => {
    expect(partyTotalsLine({ ID: c(1, 0) }, tEn)).toBe('ID 1 yes');
  });

  test('nothing to print is an empty line, never a guess', () => {
    expect(partyTotalsLine(undefined, tEn)).toBe('');
    expect(partyTotalsLine(null, tEn)).toBe('');
    expect(partyTotalsLine({}, tEn)).toBe('');
  });

  test('no word in the line characterizes a vote or a party, in either language', () => {
    const all = JSON.stringify({ en: en.partyTotals, es: es.partyTotals });
    expect(all).not.toMatch(
      /sided|siding|won|lost|blocked|defeated|party line|partisan|se puso del lado|ganaron|perdieron|bloquearon|partidista/i
    );
    // The same keys in both languages.
    expect(Object.keys(es.partyTotals).sort()).toEqual(Object.keys(en.partyTotals).sort());
  });
});

test.describe('every stored roll call', () => {
  test('prints a line, and the numbers in it add up to the tally', () => {
    const misses: string[] = [];
    for (const r of votes.rollCalls) {
      for (const [locale, t] of [
        ['en', tEn],
        ['es', tEs],
      ] as const) {
        const line = partyTotalsLine(r.totalsByParty, t);
        if (!line) {
          misses.push(`${r.id} ${locale}: empty`);
          continue;
        }
        const sum = [...line.matchAll(/\d+/g)].reduce((n, m) => n + Number(m[0]), 0);
        const want = r.totals.yea + r.totals.nay + r.totals.present + r.totals.notVoting;
        if (sum !== want) misses.push(`${r.id} ${locale}: the line counts ${sum}, the tally ${want}`);
      }
    }
    expect(misses).toEqual([]);
  });
});

test.describe('the settled box carries the same counts', () => {
  test('a vote group read from a roll call carries its count by party; one the file does not hold carries none', () => {
    const house = roll('h-119-2-282');
    const senate = roll('s-119-2-244');
    const bill = {
      last_action_text:
        'Resolution rejected in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.',
      last_action_date: '2026-09-24',
    };
    const groups = settledVoteGroups(bill, { kind: 'rejected', chamber: 'senate' } as never, [senate, house], '2025-01-03');
    expect(groups.map((g) => [g.chamber, g.source])).toEqual([
      ['senate', 'rollCall'],
      ['house', 'rollCall'],
    ]);
    expect(groups[0].totalsByParty).toEqual(senate.totalsByParty);
    expect(groups[1].totalsByParty).toEqual(house.totalsByParty);
    const notHeld = settledVoteGroups(bill, { kind: 'rejected', chamber: 'senate' } as never, [], '2025-01-03');
    expect(notHeld[0].source).toBe('notInFile');
    expect(notHeld[0].totalsByParty).toBeUndefined();
  });
});
