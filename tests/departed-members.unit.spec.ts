import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../messages/en.json';
import es from '../messages/es.json';
import departedFile from '../data/departed-members.json';
import { CONGRESS, CONGRESS_POLICY, congressTerm, type CongressPolicy } from '../lib/congress.mjs';
import {
  NEW_MEMBER_LINE_KEY,
  REVIEW_ENV,
  departedWithPage,
  memberTurnover,
  newCongressReview,
  reviewDepartedRecord,
  servedChamber,
  servedLine,
  showsNoVotesYet,
} from '../lib/departed-members';
import { billSponsor } from '../lib/bill-provenance';
import {
  districtsForZip,
  getDepartedMember,
  getDepartedMembers,
  getLegislator,
  hasMemberPage,
  memberTurnover as liveTurnover,
  repsForDistrict,
} from '../lib/core';
import type { DepartedMember, Legislator } from '../lib/types';
import officialDates from '../data/departure-dates.json';
import { OFFICIAL_SOURCES, hasOfficialDate, isRealDay } from '../lib/departed-members';
import legislatorsJson from '../data/legislators.json';
import { portraitKnownMissing } from '../lib/core';

/*
 * MEMBERS AFTER A NEW CONGRESS BEGINS (stage 5, 2026-11-13).
 * lib/departed-members.ts holds the rules; every case here is a fixture.
 * The "today" block pins what is live: the ended list is empty, and the 16
 * members who left mid-term have record pages with official dates.
 */

const CLERK_SOURCE = {
  kind: 'house-clerk' as const,
  url: 'https://clerk.house.gov/Members/ViewVacancies',
  read: '2026-11-13',
};

const ENDED_DAY = congressTerm(CONGRESS).end; // the last day of the tracked Congress
const AFTER: CongressPolicy = { tracked: CONGRESS + 1, ended: [{ number: CONGRESS, ended: ENDED_DAY }] };

function record(over: Partial<DepartedMember> = {}): DepartedMember {
  return {
    bioguide: 'A000001',
    name: 'Alex Example',
    first: 'Alex',
    last: 'Example',
    type: 'rep',
    state: 'OH',
    district: 3,
    party: 'Independent',
    served_until: ENDED_DAY,
    served_until_source: null,
    left_file: ENDED_DAY,
    ...over,
  };
}

const BEFORE: CongressPolicy = { tracked: CONGRESS, ended: [] };
const START_DAY = congressTerm(CONGRESS).start;

test.describe('who keeps a record page', () => {
  test('before the switch: a member who left at the end of the term waits for it', () => {
    expect(memberTurnover(BEFORE)).toBeNull();
    expect(departedWithPage([record()], new Set(), BEFORE)).toEqual([]);
  });

  test('after the switch, a member whose last term ended with the Congress', () => {
    const turnover = memberTurnover(AFTER);
    expect(turnover).toEqual({ ended: { number: CONGRESS, ended: ENDED_DAY }, tracked: CONGRESS + 1 });
    expect(departedWithPage([record()], new Set(), AFTER).map((r) => r.bioguide)).toEqual(['A000001']);
  });

  test('a mid-term date with no official source gets no page: not found, as before (hard rule 6)', () => {
    const unconfirmed = record({ bioguide: 'B000002', served_until: '2026-04-21', served_until_source: null });
    const missing = record({ bioguide: 'C000003', served_until: '2026-04-21' });
    const wrongPlace = record({
      bioguide: 'D000004',
      served_until: '2026-04-21',
      served_until_source: { kind: 'house-clerk', url: 'https://example.com/list', read: '2026-11-13' },
    });
    for (const policy of [BEFORE, AFTER]) {
      expect(departedWithPage([unconfirmed, missing, wrongPlace], new Set(), policy)).toEqual([]);
    }
    // The change of Congress needs no table entry: its date is fixed.
    expect(departedWithPage([record({ served_until_source: null })], new Set(), AFTER)).toHaveLength(1);
  });

  test('a member who left mid-term has a page now and after the switch (owner, 2026-11-13)', () => {
    const mid = record({ bioguide: 'B000002', served_until: '2026-04-21', served_until_source: CLERK_SOURCE });
    expect(departedWithPage([mid], new Set(), BEFORE)).toEqual([mid]);
    expect(departedWithPage([mid], new Set(), AFTER)).toEqual([mid]);
  });

  test('never one with no end date, a day outside the term, or one back in the member file', () => {
    const records = [
      record({ bioguide: 'C000003', served_until: null }),
      record({ bioguide: 'D000004', served_until: '2026-04-21' }),
      record({ bioguide: 'E000005', served_until: START_DAY }), // left at the previous switch
      record({ bioguide: 'F000006', served_until: '2024-06-01' }),
      record({ bioguide: 'G000007', served_until: 'April 2026' }),
    ];
    expect(departedWithPage(records, new Set(['D000004']), BEFORE)).toEqual([]);
    expect(departedWithPage(records, new Set(['D000004']), AFTER)).toEqual([]);
  });

  test('the switch-day record keeps the approved line; every other one prints its own day', () => {
    expect(servedLine(record(), memberTurnover(AFTER))).toEqual({ key: 'departedServed' });
    expect(servedLine(record({ served_until: '2026-04-21' }), memberTurnover(AFTER))).toEqual({
      key: 'departedServedOn',
      date: '2026-04-21',
    });
    expect(servedLine(record({ served_until: '2026-04-21' }), null)).toEqual({ key: 'departedServedOn', date: '2026-04-21' });
  });

  test('the dated line, in both languages', () => {
    expect(en.rep.departedServedOn).toBe('Served in the {chamber} until {date}.');
    expect(es.rep.departedServedOn).toBe('Sirvió en {chamber} hasta el {date}.');
  });

  test('a Congress that ended earlier opens no turnover for the tracked one', () => {
    // Two Congresses back: the list holds it, but it is not the one that just ended.
    expect(memberTurnover({ tracked: CONGRESS + 2, ended: [{ number: CONGRESS, ended: ENDED_DAY }] })).toBeNull();
  });

  test('the served-until line names the chamber they held', () => {
    expect(servedChamber({ type: 'rep' })).toBe('house');
    expect(servedChamber({ type: 'sen' })).toBe('senate');
  });
});

test.describe('pages follow the rule as the file grows (3rd review)', () => {
  const CLERK = { kind: 'house-clerk' as const, url: 'https://clerk.house.gov/Members/ViewVacancies', read: '2026-11-13' };
  const sixteen = Array.from({ length: 16 }, (_, i) =>
    record({ bioguide: `S${String(i).padStart(6, '0')}`, served_until: '2026-04-21', served_until_source: CLERK, left_file: '2026-11-13' }),
  );
  const unconfirmed = record({ bioguide: 'U000001', served_until: '2026-11-10', served_until_source: null, left_file: '2026-11-16' });
  const confirmed = { ...unconfirmed, served_until: '2026-11-11', served_until_source: CLERK };
  const jan3 = Array.from({ length: 80 }, (_, i) =>
    record({ bioguide: `J${String(i).padStart(6, '0')}`, served_until: ENDED_DAY, served_until_source: null, left_file: '2027-01-04' }),
  );
  const dec7 = record({ bioguide: 'D000007', served_until: ENDED_DAY, served_until_source: null, left_file: '2026-12-07' });

  test('a 17th record, unconfirmed: still 16 pages', () => {
    expect(departedWithPage([...sixteen, unconfirmed], new Set(), BEFORE)).toHaveLength(16);
  });

  test('the 17th confirmed: 17 pages', () => {
    expect(departedWithPage([...sixteen, confirmed], new Set(), BEFORE).map((r) => r.bioguide)).toContain('U000001');
    expect(departedWithPage([...sixteen, confirmed], new Set(), BEFORE)).toHaveLength(17);
  });

  test('the Jan 4, 2027 file (16 mid-term plus 80 leaving on Jan 3): 16 pages before the switch, 96 after', () => {
    const file = [...sixteen, ...jan3, dec7];
    expect(departedWithPage(file, new Set(), BEFORE)).toHaveLength(16);
    const after = departedWithPage(file, new Set(), AFTER);
    expect(after).toHaveLength(96);
    // Dec 7 left the file before Jan 3: no "until January 3" page for them.
    expect(after.map((r) => r.bioguide)).not.toContain('D000007');
  });

  test('an impossible day never gets a page', () => {
    expect(isRealDay('2026-02-30')).toBe(false);
    expect(isRealDay('2028-02-29')).toBe(true);
    const bad = record({ bioguide: 'B000009', served_until: '2026-02-30', served_until_source: CLERK });
    expect(departedWithPage([bad], new Set(), BEFORE)).toEqual([]);
    expect(hasOfficialDate({ served_until_source: { ...CLERK, read: '2026-11-31' } })).toBe(false);
  });
});

test.describe('the new-member line', () => {
  const turnover = memberTurnover(AFTER);
  test('only after the switch, only with no recorded vote, never for a delegate', () => {
    expect(showsNoVotesYet({ turnover, voteBills: 0, delegate: false })).toBe(true);
    expect(showsNoVotesYet({ turnover, voteBills: 3, delegate: false })).toBe(false);
    expect(showsNoVotesYet({ turnover, voteBills: 0, delegate: true })).toBe(false);
    expect(showsNoVotesYet({ turnover: null, voteBills: 0, delegate: false })).toBe(false);
  });
  test('the review build can show it for a member who has votes, and only after the switch', () => {
    expect(showsNoVotesYet({ turnover, voteBills: 3, delegate: false, reviewNew: true })).toBe(true);
    expect(showsNoVotesYet({ turnover: null, voteBills: 3, delegate: false, reviewNew: true })).toBe(false);
  });
});

test.describe('the sponsor line links a member who left only when their page exists', () => {
  const bill = { sponsor_bioguide_id: 'A000001', bill_type: 'hr' };
  const formerMember = () => ({ id: 'A000001', name: 'Alex Example', state: 'OH', chamber: 'house' as const });
  const legislator = () => undefined;
  test('without the lookup (every caller before stage 5): named, not linked', () => {
    expect(billSponsor(bill, { legislator, formerMember })?.hasPage).toBe(false);
  });
  test('with it: linked when the record page exists, not otherwise', () => {
    expect(billSponsor(bill, { legislator, formerMember, hasPage: () => true })?.hasPage).toBe(true);
    expect(billSponsor(bill, { legislator, formerMember, hasPage: () => false })?.hasPage).toBe(false);
  });
});

test.describe('the review setting', () => {
  test('off unless named; never with a deploy or CI in the environment', () => {
    expect(newCongressReview({}, CONGRESS)).toBeNull();
    expect(newCongressReview({ [REVIEW_ENV]: '' }, CONGRESS)).toBeNull();
    for (const k of ['VERCEL', 'VERCEL_ENV', 'CI', 'GITHUB_ACTIONS']) {
      expect(() => newCongressReview({ [REVIEW_ENV]: 'departed=A000001', [k]: '1' }, CONGRESS)).toThrow(/local review build only/);
    }
  });

  test('reads its two lists strictly and pretends only the member pages have switched', () => {
    const r = newCongressReview({ [REVIEW_ENV]: 'departed=A000001,B000002;new=C000003' }, CONGRESS)!;
    expect([...r.departed]).toEqual(['A000001', 'B000002']);
    expect([...r.newMembers]).toEqual(['C000003']);
    expect(r.policy).toEqual(AFTER);
    expect(() => newCongressReview({ [REVIEW_ENV]: 'departed=Smith' }, CONGRESS)).toThrow(/not a bioguide/);
    expect(() => newCongressReview({ [REVIEW_ENV]: 'gone=A000001' }, CONGRESS)).toThrow(/unknown list/);
  });

  test('a review record keeps the seat and drops every contact field', () => {
    const r = newCongressReview({ [REVIEW_ENV]: 'departed=A000001' }, CONGRESS)!;
    const l: Legislator = {
      bioguide: 'A000001', name: 'Alex Example', first: 'Alex', last: 'Example', type: 'rep', state: 'OH',
      district: 3, party: 'Independent', phone: '202-225-0000', url: 'https://example.house.gov',
      offices: [{ city: 'X', state: 'OH', phone: '1' }],
    };
    const d = reviewDepartedRecord(l, r);
    expect(d).toEqual(record());
    expect(Object.keys(d)).not.toEqual(expect.arrayContaining(['phone']));
  });

  test('no workflow, package script or Next config names it', () => {
    const files = [
      ...readdirSync('.github/workflows').map((f) => join('.github/workflows', f)),
      'package.json',
      'next.config.ts',
    ];
    expect(files.filter((f) => readFileSync(f, 'utf8').includes(REVIEW_ENV))).toEqual([]);
  });
});

test.describe('the approved wording (owner, 2026-11-12), exactly', () => {
  test('English and Spanish', () => {
    expect(en.rep.departedServed).toBe('Served in the {chamber} until January 3, 2027.');
    expect(es.rep.departedServed).toBe('Sirvió en {chamber} hasta el 3 de enero de 2027.');
    expect(en.rep.votesNoneYet).toBe('No recorded votes yet in the 120th Congress.');
    expect(es.rep.votesNoneYet).toBe('Todavía no hay votos registrados en el Congreso 120.');
    expect(en.rep.departedChamber).toEqual({ house: 'House', senate: 'Senate' });
    expect(es.rep.departedChamber).toEqual({ house: 'la Cámara de Representantes', senate: 'el Senado' });
  });

  test('a record page never calls the member sitting or one of "your members"', () => {
    expect(en.rep.formerRole).toEqual({
      senator: 'Former Senator',
      representative: 'Former Representative',
      delegate: 'Former Delegate',
    });
    // Spanish: "exintegrante" has one form for everyone, so no gendered form
    // is forced on the member (the sitting labels use "Senador/a").
    expect(es.rep.formerRole).toEqual({
      senator: 'Exintegrante del Senado',
      representative: 'Exintegrante de la Cámara de Representantes',
      delegate: 'Exintegrante de la Cámara de Representantes',
    });
    expect(en.rep.crumbRecord).toBe('Current members of Congress');
    expect(es.rep.crumbRecord).toBe('Miembros actuales del Congreso');
  });

  test('the new-member line is the approved one until the owner picks the other; both exist', () => {
    // Change NEW_MEMBER_LINE_KEY (lib/departed-members.ts) and this line together.
    expect(NEW_MEMBER_LINE_KEY).toBe('votesNoneYetTracked');
    expect(en.rep.votesNoneYetTracked).toBe('No recorded votes yet on a bill Oravan tracks.');
    expect(es.rep.votesNoneYetTracked).toBe('Todavía no hay votos registrados sobre un proyecto de los que sigue Oravan.');
  });

  test('names the switch the code is aimed at, so a later Congress needs new wording first', () => {
    // Before the switch the turnover is the tracked Congress ending; after it,
    // the ended entry. Either way the lines must name that day and the next
    // Congress. At the 121st this fails until the owner approves new lines.
    const turnover = liveTurnover() ?? memberTurnover(AFTER)!;
    expect(turnover.ended.ended).toBe('2027-01-03');
    expect(en.rep.departedServed).toContain('January 3, 2027');
    expect(en.rep.votesNoneYet).toContain(`${turnover.tracked}th Congress`);
    expect(es.rep.votesNoneYet).toContain(`Congreso ${turnover.tracked}`);
  });
});

test.describe('data/departed-members.json', () => {
  const ALLOWED = new Set([
    'bioguide', 'name', 'first', 'last', 'type', 'state', 'district', 'party',
    'served_until', 'served_until_source', 'left_file',
  ]);
  test('every record has the shape scripts/member_turnover.py writes, and no way to contact anyone', () => {
    const rows = departedFile as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    const seen = new Set<string>();
    for (const r of rows as Record<string, unknown>[]) {
      expect(String(r.bioguide)).toMatch(/^[A-Z]\d{6}$/);
      expect(seen.has(String(r.bioguide))).toBe(false);
      seen.add(String(r.bioguide));
      expect(Object.keys(r).filter((k) => !ALLOWED.has(k))).toEqual([]);
      expect(['rep', 'sen']).toContain(r.type);
      expect(String(r.state)).toMatch(/^[A-Z]{2}$/);
      expect(isRealDay(r.left_file), String(r.left_file)).toBe(true);
      if (r.served_until !== null) expect(isRealDay(r.served_until), String(r.served_until)).toBe(true);
    }
  });
});

test.describe('today', () => {
  // Stage 8 must update this test when it fills lib/congress.mjs's ended list.
  test('the ended list is empty, so no turnover and no new-member line', () => {
    expect(CONGRESS_POLICY.ended).toEqual([]);
    expect(liveTurnover()).toBeNull();
  });

  // These assert the RULE over whatever data/departed-members.json holds
  // (3rd review): the weekly refresh adds records, a confirmation pull request
  // fills them, and the Jan 4, 2027 run adds ~80. No count of today's data.
  type Entry = { bioguide: string; served_until: string; source: DepartedMember['served_until_source'] };
  const TABLE = new Map((officialDates as Entry[]).map((e) => [e.bioguide, e]));
  const RECORDS = departedFile as DepartedMember[];
  const SITTING = new Set((legislatorsJson as { bioguide: string }[]).map((l) => l.bioguide));

  test('every table entry is usable: a real day and an official source', () => {
    expect(TABLE.size).toBe((officialDates as unknown[]).length);
    for (const e of TABLE.values()) {
      expect(isRealDay(e.served_until), `${e.bioguide} ${e.served_until}`).toBe(true);
      expect(hasOfficialDate({ served_until_source: e.source }), e.bioguide).toBe(true);
      expect(SITTING.has(e.bioguide), `${e.bioguide} has an entry but is sitting`).toBe(false);
    }
    expect(Object.keys(OFFICIAL_SOURCES).sort()).toEqual(['bioguide', 'house-clerk']);
  });

  test('a record with an official source matches its table entry exactly', () => {
    for (const r of RECORDS.filter((x) => x.served_until_source)) {
      const e = TABLE.get(r.bioguide);
      expect(e, `${r.bioguide} has a source but no table entry`).toBeTruthy();
      expect(r.served_until).toBe(e!.served_until);
      expect(r.served_until_source).toEqual(e!.source);
    }
  });

  test('pages are exactly the records the rule gives a page', () => {
    const expected = departedWithPage(RECORDS, SITTING, CONGRESS_POLICY).map((r) => r.bioguide).sort();
    expect(getDepartedMembers().map((r) => r.bioguide).sort()).toEqual(expected);
    for (const r of RECORDS) {
      const page = expected.includes(r.bioguide);
      expect(hasMemberPage(r.bioguide), r.bioguide).toBe(page);
      expect(getDepartedMember(r.bioguide) !== undefined, r.bioguide).toBe(page);
    }
  });

  test('a record with no official source has no page, no sitemap entry and no sponsor link', () => {
    for (const r of RECORDS.filter((x) => !x.served_until_source && !(liveTurnover() && x.served_until === liveTurnover()!.ended.ended))) {
      expect(hasMemberPage(r.bioguide), r.bioguide).toBe(false);
      // app/sitemap.ts lists only getDepartedMembers() (pinned below).
      expect(getDepartedMembers().some((d) => d.bioguide === r.bioguide), r.bioguide).toBe(false);
      const sponsor = billSponsor(
        { sponsor_bioguide_id: r.bioguide, bill_type: r.type === 'sen' ? 's' : 'hr' },
        { legislator: () => undefined, formerMember: () => ({ id: r.bioguide, name: r.name, state: r.state, chamber: r.type === 'sen' ? 'senate' : 'house' }), hasPage: hasMemberPage },
      );
      expect(sponsor?.hasPage, r.bioguide).toBe(false);
    }
  });

  test("today's sixteen named members who left mid-term have pages with their official days (owner, 2026-11-13)", () => {
    // Read from the official sources on 2026-11-13. Written as "these are
    // among the pages", so a 17th departure never breaks it.
    const SIXTEEN: Record<string, string> = {
      V000137: '2025-01-10', R000595: '2025-01-20', W000823: '2025-01-20', T000489: '2025-03-05',
      G000551: '2025-03-13', C001078: '2025-05-21', G000590: '2025-07-20', S001207: '2025-11-20',
      G000596: '2026-01-05', L000578: '2026-01-06', M001190: '2026-03-23', G000594: '2026-04-14',
      S001193: '2026-04-14', C001127: '2026-04-21', S001157: '2026-04-22', G000359: '2026-07-11',
    };
    for (const [b, day] of Object.entries(SIXTEEN)) {
      expect(getDepartedMember(b)?.served_until, b).toBe(day);
      expect(hasMemberPage(b), b).toBe(true);
    }
    for (const d of getDepartedMembers()) {
      expect(START_DAY < String(d.served_until) && String(d.served_until) <= ENDED_DAY, d.bioguide).toBe(true);
    }
  });

  test('a member whose photo is missing at the source shows the initials alone (Sylvester Turner)', () => {
    expect(portraitKnownMissing('T000489')).toBe(true);
  });

  test('a member who left is never in a lookup: not a sitting member, not in any seat', () => {
    for (const d of getDepartedMembers()) {
      expect(getLegislator(d.bioguide)).toBeUndefined();
      if (d.type === 'rep') {
        const seat = { state: d.state, district: d.district ?? 0 };
        expect(repsForDistrict(seat).map((l) => l.bioguide)).not.toContain(d.bioguide);
      }
      for (const zip of ['20001', '33313', '07003']) {
        for (const district of districtsForZip(zip)) {
          expect(repsForDistrict(district).map((l) => l.bioguide)).not.toContain(d.bioguide);
        }
      }
    }
  });

  test('only the member page and the sitemap read the departed list', () => {
    const roots = ['app', 'components', 'lib'];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs)$/.test(e.name) && /getDepartedMembers?\(/.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    roots.forEach(walk);
    expect(hits.sort()).toEqual(['app/[locale]/reps/[bioguide]/page.tsx', 'app/sitemap.ts', 'lib/core/reps.ts']);
  });
});
