import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { contrastRatio } from '../lib/contrast';
import { districtsForZip, getAllLegislators, repsForDistrict, vacancyForDistrict } from '../lib/core';
import { houseFinderRows, seatSlug, type FinderMember } from '../lib/house-finder';
import type { District, RollCall, VotePosition } from '../lib/types';
import { votesForBill } from '../lib/votes';
import zipDistricts from '../data/zip-districts.json';
import { colorToken } from './palette';

/*
 * THE SPLIT-ZIP HOUSE FINDER, VERSION A (owner, 2026-09-29, reviewing the
 * settled box on /bills/hconres-89-119 with a split ZIP: "This would be a use
 * of a subtle yellow button (I know color comes later) but there should be a
 * way for them to find those votes in this box here. Can you build that for
 * me? Mock up two versions of how this could look.").
 *
 * Version A lists every House member whose district touches the saved ZIP,
 * each beside their position on the House roll call. These specs pin the row
 * builder (lib/house-finder.ts) against the committed data — the ZIP map, the
 * roster, the vacancies and the roll-call file — and the finder's words in
 * both languages. The rows are built exactly as the panel builds them: from
 * what /api/reps answers for the ZIP (every district's House member and both
 * states' senators, plus the vacant seats).
 */

const tEn = createTranslator({ locale: 'en', messages: en });
const tEs = createTranslator({ locale: 'es', messages: es });

/** What /api/reps answers for a ZIP, reduced to what the panel keeps. */
function lookup(zip: string): { members: FinderMember[]; vacantSeats: District[] } {
  const districts = districtsForZip(zip);
  const seen = new Set<string>();
  const members = districts
    .flatMap((d) => repsForDistrict(d))
    .filter((r) => (seen.has(r.bioguide) ? false : (seen.add(r.bioguide), true)))
    .map(({ bioguide, name, state, type, district }) => ({ bioguide, name, state, type, district }));
  const vacantSeats = districts
    .map((d) => vacancyForDistrict(d))
    .filter((v): v is NonNullable<typeof v> => Boolean(v))
    .map(({ state, district }) => ({ state, district }));
  return { members, vacantSeats };
}

/** bioguide → position, the way lib/settled-votes.ts `fromRollCall` builds it. */
function positionsOf(r: RollCall): Record<string, VotePosition> {
  const out: Record<string, VotePosition> = {};
  for (const p of ['yea', 'nay', 'present', 'notVoting'] as const) for (const id of r.votes[p]) out[id] = p;
  return out;
}

const HCONRES_89_HOUSE = votesForBill('hconres-89-119').find((r) => r.chamber === 'house' && r.roll === 282);

test.describe('houseFinderRows — one row per House district in the ZIP', () => {
  test('ZIP 77484 (the owner\'s split-ZIP case): every district, its member, and their H.Con.Res. 89 position', () => {
    test.skip(!HCONRES_89_HOUSE, 'House roll 282 on H.Con.Res. 89 is not in data/votes.json');
    const districts = districtsForZip('77484');
    expect(districts.length, 'ZIP 77484 spans more than one House district').toBeGreaterThan(1);

    const { members, vacantSeats } = lookup('77484');
    const rows = houseFinderRows(members, vacantSeats, positionsOf(HCONRES_89_HOUSE!));

    // Every district in the ZIP, once, and nothing else.
    expect(rows.map((r) => `${r.state}-${r.district}`).sort()).toEqual(
      districts.map((d) => `${d.state}-${d.district}`).sort()
    );
    // Ordered by state, then district number (TX-8 before TX-10 before TX-38).
    const order = rows.map((r) => r.district);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    for (const r of rows) {
      const holder = repsForDistrict(r).find((l) => l.type === 'rep');
      expect(r.member?.bioguide ?? null, `${r.state}-${r.district}`).toBe(holder?.bioguide ?? null);
      if (!r.member) continue;
      // The record's own lists, and nothing else.
      const listed = (['yea', 'nay', 'present', 'notVoting'] as const).find((p) =>
        HCONRES_89_HOUSE!.votes[p].includes(r.member!.bioguide)
      );
      expect(r.position, `${r.member.name}`).toBe(listed ?? null);
    }
  });

  test('senators never become rows, and a district is listed once', () => {
    const members: FinderMember[] = [
      { bioguide: 'S1', name: 'Sen One', state: 'TX', type: 'sen', district: null },
      { bioguide: 'R8', name: 'Rep Eight', state: 'TX', type: 'rep', district: 8 },
      { bioguide: 'R8', name: 'Rep Eight', state: 'TX', type: 'rep', district: 8 },
      { bioguide: 'R10', name: 'Rep Ten', state: 'TX', type: 'rep', district: 10 },
    ];
    const rows = houseFinderRows(members, [], { R8: 'yea' });
    expect(rows.map((r) => r.member?.bioguide)).toEqual(['R8', 'R10']);
  });

  test('a member the roll call does not list has no position — never a borrowed one', () => {
    const members: FinderMember[] = [
      { bioguide: 'R8', name: 'Rep Eight', state: 'TX', type: 'rep', district: 8 },
      { bioguide: 'R10', name: 'Rep Ten', state: 'TX', type: 'rep', district: 10 },
    ];
    const rows = houseFinderRows(members, [], { R8: 'notVoting' });
    expect(rows.map((r) => r.position)).toEqual(['notVoting', null]);
  });

  test('a vacant seat is a row of its own, with no member and no position, linking to the seat\'s page', () => {
    // ZIP 33060 spans FL-20 (vacant in the committed data) and FL-23.
    const fl20 = vacancyForDistrict({ state: 'FL', district: 20 });
    test.skip(!fl20, 'FL-20 is no longer vacant in data/vacancies.json');
    const { members, vacantSeats } = lookup('33060');
    const rows = houseFinderRows(members, vacantSeats, {});
    expect(rows.map((r) => `${r.state}-${r.district}`)).toEqual(['FL-20', 'FL-23']);
    expect(rows[0]).toMatchObject({ member: null, position: null });
    expect(rows[1].member).not.toBeNull();
    expect(seatSlug(rows[0])).toBe('fl-20');
  });

  test('a ZIP across a state line orders by state, then district', () => {
    // ZIP 30165 touches AL-3 and GA-14 in the committed map.
    const { members, vacantSeats } = lookup('30165');
    const rows = houseFinderRows(members, vacantSeats, {});
    expect(rows.map((r) => r.state)).toEqual(['AL', 'GA']);
  });

  test('an at-large member (no district number) is district 0', () => {
    const rows = houseFinderRows(
      [{ bioguide: 'AL1', name: 'At Large', state: 'WY', type: 'rep', district: null }],
      [],
      {}
    );
    expect(rows[0].district).toBe(0);
  });

  test('over every split ZIP in the committed map: one row per district, and every position is the record\'s', () => {
    test.skip(!HCONRES_89_HOUSE, 'House roll 282 on H.Con.Res. 89 is not in data/votes.json');
    const positions = positionsOf(HCONRES_89_HOUSE!);
    const reps = new Set(getAllLegislators().filter((l) => l.type === 'rep').map((l) => l.bioguide));
    let zips = 0;
    for (const [zip, districts] of Object.entries(zipDistricts as Record<string, District[]>)) {
      if (districts.length < 2) continue;
      zips++;
      const { members, vacantSeats } = lookup(zip);
      const rows = houseFinderRows(members, vacantSeats, positions);
      expect(rows.length, zip).toBe(districts.length);
      for (const r of rows) {
        if (!r.member) continue;
        expect(reps.has(r.member.bioguide), `${zip} ${r.member.bioguide} is a House member`).toBe(true);
        expect(r.position, `${zip} ${r.member.bioguide}`).toBe(positions[r.member.bioguide] ?? null);
      }
    }
    expect(zips, 'the committed map holds split ZIPs').toBeGreaterThan(1000);
  });
});

test.describe('the finder\'s words, in both languages', () => {
  test('the button names the ZIP', () => {
    expect(tEn('bill.settled.finderShow', { zip: '77484' })).toBe('Show the House vote for ZIP 77484');
    expect(tEs('bill.settled.finderShow', { zip: '77484' })).toBe(
      'Ver la votación de la Cámara para el código postal 77484'
    );
  });

  test('the split line counts the districts and says one of them is yours — a seat when one is vacant', () => {
    expect(tEn('bill.settled.finderSplit', { count: 2, vacant: 'no' })).toBe(
      'Your ZIP is split between two House districts. One of these members is yours.'
    );
    expect(tEn('bill.settled.finderSplit', { count: 3, vacant: 'yes' })).toBe(
      'Your ZIP is split between 3 House districts. One of these seats is yours.'
    );
    expect(tEs('bill.settled.finderSplit', { count: 2, vacant: 'no' })).toBe(
      'Tu código postal está dividido entre dos distritos de la Cámara. Una de estas personas es tu representante.'
    );
    expect(tEs('bill.settled.finderSplit', { count: 3, vacant: 'yes' })).toBe(
      'Tu código postal está dividido entre 3 distritos de la Cámara. Uno de estos escaños es el tuyo.'
    );
  });

  test('the district label reads TX-8, and an at-large seat says so', () => {
    for (const t of [tEn, tEs]) expect(t('bill.settled.finderDistrict', { state: 'TX', district: '8' })).toBe('TX-8');
    expect(tEn('bill.settled.finderDistrict', { state: 'WY', district: '0' })).toBe('WY at-large');
    expect(tEs('bill.settled.finderDistrict', { state: 'WY', district: '0' })).toBe('WY, distrito único');
  });

  test('every finder string exists in both languages, and the Spanish is not an English copy', () => {
    const enKeys = Object.keys(en.bill.settled).filter((k) => k.startsWith('finder')).sort();
    expect(Object.keys(es.bill.settled).filter((k) => k.startsWith('finder')).sort()).toEqual(enKeys);
    expect(enKeys).toEqual(['finderDistrict', 'finderRefine', 'finderShow', 'finderSplit', 'finderVacant']);
    for (const k of ['finderShow', 'finderSplit', 'finderVacant', 'finderRefine'] as const) {
      expect(es.bill.settled[k], k).not.toBe(en.bill.settled[k]);
    }
  });

  test('no phone number, no ask and no address request in the finder\'s words', () => {
    for (const m of [en, es]) {
      for (const s of Object.entries(m.bill.settled).filter(([k]) => k.startsWith('finder')).map(([, v]) => v)) {
        expect(s).not.toMatch(/\d{3}[-.\s]\d{3}[-.\s]\d{4}|\bcall\b|\bllam/i);
        expect(s).not.toMatch(/\baddress\b.*\?|\bdirección\b.*\?/i);
      }
    }
  });
});

test.describe('the subtle amber control', () => {
  const SOURCE = readFileSync('components/HouseFinder.tsx', 'utf8');
  const BUTTON = /const FINDER_BUTTON =\s*'([^']+)'/.exec(SOURCE)?.[1] ?? '';

  test('ink text on a light amber fill, a line-strong edge, the 8px radius and a 44px height', () => {
    expect(BUTTON, 'FINDER_BUTTON is declared').not.toBe('');
    const classes = BUTTON.split(/\s+/);
    expect(classes).toContain('text-ink');
    expect(classes).toContain('rounded-control');
    expect(classes).toContain('min-h-11');
    expect(classes).toContain('border-line-strong');
    const fill = classes.find((c) => c.startsWith('bg-urgent/'));
    expect(fill, 'a light amber fill, never full amber').toBeDefined();
    // Amber is never the text colour or the control's only edge.
    expect(classes.some((c) => c.startsWith('text-urgent') || c.startsWith('border-urgent'))).toBe(false);
  });

  test('ink on the fill clears AA, computed from the tokens as the browser composites it over paper', () => {
    const alpha = Number(/bg-urgent\/(\d+)/.exec(BUTTON)?.[1]) / 100;
    const amber = colorToken('urgent');
    const paper = colorToken('paper');
    const mix = (i: number) =>
      Math.round(alpha * parseInt(amber.slice(i, i + 2), 16) + (1 - alpha) * parseInt(paper.slice(i, i + 2), 16));
    const fill = `#${[1, 3, 5].map((i) => mix(i).toString(16).padStart(2, '0')).join('')}`;
    expect(contrastRatio(colorToken('ink'), fill)).toBeGreaterThanOrEqual(4.5);
    // The findable edge is line-strong on the panel's paper, not the amber.
    expect(contrastRatio(colorToken('line-strong'), paper)).toBeGreaterThanOrEqual(3);
  });

  test('a disclosure: a real button with aria-expanded and aria-controls', () => {
    expect(SOURCE).toMatch(/<button\s[^>]*type="button"/);
    expect(SOURCE).toMatch(/aria-expanded=\{open\}/);
    expect(SOURCE).toMatch(/aria-controls=\{regionId\}/);
  });

  test('the finder sends nothing: no fetch, no storage write, no address field', () => {
    expect(SOURCE).not.toMatch(/\bfetch\(|localStorage|sessionStorage|<input|<form/);
  });
});
