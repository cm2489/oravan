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
  showsNoVotesYet,
} from '../lib/departed-members';
import { billSponsor } from '../lib/bill-provenance';
import { getDepartedMembers, hasMemberPage, memberTurnover as liveTurnover } from '../lib/core';
import type { DepartedMember, Legislator } from '../lib/types';

/*
 * MEMBERS AFTER A NEW CONGRESS BEGINS (stage 5, 2026-11-13).
 * lib/departed-members.ts holds the rules; every case here is a fixture.
 * The last block pins that none of it is live today: the ended list is empty,
 * data/departed-members.json is empty, and nothing gets a page or a new line.
 */

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
    left_file: ENDED_DAY,
    ...over,
  };
}

test.describe('who keeps a record page', () => {
  test('nobody before the switch: no turnover, no page', () => {
    expect(memberTurnover({ tracked: CONGRESS, ended: [] })).toBeNull();
    expect(departedWithPage([record()], new Set(), null)).toEqual([]);
  });

  test('after the switch, a member whose last term ended with the Congress', () => {
    const turnover = memberTurnover(AFTER);
    expect(turnover).toEqual({ ended: { number: CONGRESS, ended: ENDED_DAY }, tracked: CONGRESS + 1 });
    expect(departedWithPage([record()], new Set(), turnover).map((r) => r.bioguide)).toEqual(['A000001']);
  });

  test('never a member who left mid-term, one with no end date yet, or one back in the member file', () => {
    const turnover = memberTurnover(AFTER);
    const records = [
      record({ bioguide: 'B000002', served_until: '2026-04-21' }),
      record({ bioguide: 'C000003', served_until: null }),
      record({ bioguide: 'D000004' }),
    ];
    expect(departedWithPage(records, new Set(['D000004']), turnover)).toEqual([]);
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
    expect(NEW_MEMBER_LINE_KEY).toBe('votesNoneYet');
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
  const ALLOWED = new Set(['bioguide', 'name', 'first', 'last', 'type', 'state', 'district', 'party', 'served_until', 'left_file']);
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
      expect(String(r.left_file)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (r.served_until !== null) expect(String(r.served_until)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

test.describe('dormant today', () => {
  // Stage 8 must update this test when it fills lib/congress.mjs's ended list.
  test('the ended list is empty, so no turnover, no departed page, no new-member line', () => {
    expect(CONGRESS_POLICY.ended).toEqual([]);
    expect(liveTurnover()).toBeNull();
    expect(getDepartedMembers()).toEqual([]);
    // A member who left mid-Congress (named in today's roll calls) still has no page.
    expect(hasMemberPage('C001078')).toBe(false);
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
