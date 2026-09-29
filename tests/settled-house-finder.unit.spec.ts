import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { districtsForZip, repsForDistrict, vacancyForDistrict } from '../lib/core';
import { contrastRatio, mixHex } from '../lib/contrast';
import { answerFor, houseSeats, positionOf, seatCode } from '../lib/house-finder';
import type { District, Legislator } from '../lib/types';
import { votesForBill } from '../lib/votes';
import { colorToken } from './palette';

/*
 * THE SPLIT-ZIP HOUSE FINDER, VERSION B (owner, 2026-09-29, reviewing the
 * settled box on /bills/hconres-89-119 with a ZIP that spans more than one
 * House district: "there should be a way for them to find those votes in this
 * box here. Can you build that for me? Mock up two versions of how this could
 * look."). Version B asks for the street address and shows ONE member beside
 * the position data/votes.json records for them; if the address check fails
 * it lists every seat the ZIP spans.
 *
 * The pure half (lib/house-finder.ts) is read against the committed data, the
 * words in both languages, the amber control's contrast computed from the
 * tokens, and the privacy contract by source read.
 */

/** What GET /api/reps answers for a ZIP (app/api/reps/route.ts), rebuilt from
 *  the same lib/core lookups the route runs. */
function repsAnswer(zip: string): { reps: Legislator[]; vacancies: District[] } {
  const districts = districtsForZip(zip);
  const seen = new Set<string>();
  const reps = districts
    .flatMap((d) => repsForDistrict(d))
    .filter((r) => (seen.has(r.bioguide) ? false : (seen.add(r.bioguide), true)));
  const vacancies = districts
    .map((d) => vacancyForDistrict(d))
    .filter((v): v is NonNullable<typeof v> => Boolean(v))
    .map((v) => ({ state: v.state, district: v.district }));
  return { reps, vacancies };
}

/** The owner's case: ZIP 77484 spans TX-8, TX-10 and TX-38. */
const ZIP = '77484';
const HCONRES_89 = 'hconres-89-119';

test.describe('houseSeats — one seat per district the ZIP spans', () => {
  test('77484: three House seats, in district order, senators left out', () => {
    const { reps, vacancies } = repsAnswer(ZIP);
    const seats = houseSeats(reps, vacancies);
    expect(seats.map(seatCode)).toEqual(['TX-8', 'TX-10', 'TX-38']);
    for (const s of seats) {
      expect(s.member, `${seatCode(s)} has a sitting member`).not.toBeNull();
      expect(repsForDistrict(s).find((r) => r.type === 'rep')?.bioguide).toBe(s.member!.bioguide);
    }
  });

  test('a vacant seat is a seat with no member, never a departed one', () => {
    // 33060 spans FL-20 (vacant since 2026-07-05 in data/vacancies.json) and FL-23.
    const zip = '33060';
    test.skip(!vacancyForDistrict({ state: 'FL', district: 20 }), 'FL-20 is no longer vacant');
    const { reps, vacancies } = repsAnswer(zip);
    const seats = houseSeats(reps, vacancies);
    expect(seats.map(seatCode)).toEqual(['FL-20', 'FL-23']);
    expect(seats[0].member).toBeNull();
    expect(seats[1].member).not.toBeNull();
  });

  test('every split ZIP in the committed map: one seat per candidate district, none twice', () => {
    const zips = Object.keys(JSON.parse(readFileSync(join(process.cwd(), 'data/zip-districts.json'), 'utf8')));
    let split = 0;
    for (const zip of zips) {
      const districts = districtsForZip(zip);
      if (districts.length < 2) continue;
      split++;
      const { reps, vacancies } = repsAnswer(zip);
      const seats = houseSeats(reps, vacancies);
      const codes = seats.map(seatCode);
      expect(new Set(codes).size, `${zip}: a seat listed twice`).toBe(codes.length);
      // Every seat is one of the ZIP's districts. A district with neither a
      // member nor a recorded vacancy is the roster's gap, not a seat to
      // invent, so it may be missing — but never replaced by another.
      for (const s of seats) {
        expect(districts.some((d) => d.state === s.state && d.district === s.district), `${zip}: ${seatCode(s)}`).toBe(true);
      }
    }
    expect(split, 'the committed map holds split ZIPs').toBeGreaterThan(1000);
  });

  test('a member the lookup gives no district for is left out, never guessed', () => {
    const rep = { bioguide: 'X000001', name: 'Test Member', state: 'TX', district: null, type: 'rep' as const };
    expect(houseSeats([rep], [])).toEqual([]);
  });
});

test.describe('answerFor and positionOf — what the address answers, and the record for it', () => {
  const house = votesForBill(HCONRES_89).find((r) => r.chamber === 'house');

  test('H.Con.Res. 89, House roll 282: each 77484 member beside the position the roll call lists', () => {
    test.skip(!house, 'the House roll call on H.Con.Res. 89 is not in data/votes.json');
    expect(house!.roll).toBe(282);
    expect(house!.date).toBe('2026-07-23');
    expect([house!.totals.yea, house!.totals.nay]).toEqual([214, 208]);
    const positions: Record<string, string> = {};
    for (const p of ['yea', 'nay', 'present', 'notVoting'] as const) for (const id of house!.votes[p]) positions[id] = p;

    const { reps, vacancies } = repsAnswer(ZIP);
    const seats = houseSeats(reps, vacancies);
    for (const s of seats) {
      const listed = (['yea', 'nay', 'present', 'notVoting'] as const).find((p) => house!.votes[p].includes(s.member!.bioguide));
      expect(positionOf(positions as never, s.member!.bioguide), seatCode(s)).toBe(listed ?? null);
    }
  });

  test('a member the roll call lists nowhere has no position — "No recorded vote", never a guess', () => {
    expect(positionOf({ A000001: 'yea' }, 'B000002')).toBeNull();
    expect(positionOf(null, 'A000001')).toBeNull();
    // An inherited object key is not a member.
    expect(positionOf({}, 'constructor')).toBeNull();
  });

  test('an address inside the ZIP names one seat; one outside it names the district only', () => {
    const { reps, vacancies } = repsAnswer(ZIP);
    const seats = houseSeats(reps, vacancies);
    const inside = answerFor(seats, { state: 'TX', district: 10 });
    expect(inside.kind).toBe('seat');
    expect(inside.kind === 'seat' && seatCode(inside.seat)).toBe('TX-10');
    expect(answerFor(seats, { state: 'TX', district: 7 })).toEqual({
      kind: 'outside',
      district: { state: 'TX', district: 7 },
    });
  });

  test('an at-large seat is the state alone', () => {
    expect(seatCode({ state: 'WY', district: 0 })).toBe('WY');
    expect(seatCode({ state: 'TX', district: 38 })).toBe('TX-38');
  });
});

test.describe('the finder\'s words, in both languages', () => {
  const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'bill.houseFinder' });
  const tEs = createTranslator({ locale: 'es', messages: es, namespace: 'bill.houseFinder' });

  test('every string exists in both languages and the Spanish is not an English copy', () => {
    const keys = Object.keys(en.bill.houseFinder).sort();
    expect(Object.keys(es.bill.houseFinder).sort()).toEqual(keys);
    for (const key of keys as (keyof typeof en.bill.houseFinder)[]) {
      expect(es.bill.houseFinder[key], key).not.toBe(en.bill.houseFinder[key]);
    }
  });

  test('the fallback line says why, for each reason, and counts the ZIP\'s seats', () => {
    const args = { count: 3, zip: ZIP };
    expect(tEn('fallback', { ...args, reason: 'unavailable' })).toBe(
      "We couldn't check the address right now, so here is the House member for each of the 3 districts ZIP 77484 spans."
    );
    expect(tEn('fallback', { ...args, reason: 'rateLimited' })).toBe(
      "You've checked several addresses in a short time, so here is the House member for each of the 3 districts ZIP 77484 spans."
    );
    expect(tEn('fallback', { ...args, reason: 'chosen' })).toBe(
      'Here is the House member for each of the 3 districts ZIP 77484 spans.'
    );
    expect(tEs('fallback', { ...args, reason: 'unavailable' })).toBe(
      'No pudimos revisar la dirección en este momento, así que aquí está el representante de cada uno de los 3 distritos que abarca el código postal 77484.'
    );
    expect(tEs('fallback', { ...args, reason: 'chosen' })).toBe(
      'Aquí está el representante de cada uno de los 3 distritos que abarca el código postal 77484.'
    );
  });

  test('the found line names the district and repeats the address promise', () => {
    expect(tEn('found', { district: 'TX-10' })).toBe(
      'Your district is TX-10, found from the street address you entered. The address was used once and never stored.'
    );
    expect(tEs('found', { district: 'TX-10' })).toBe(
      'Tu distrito es TX-10, según la dirección que escribiste. La dirección se usó una sola vez y nunca se guardó.'
    );
  });

  test('no phone number and no ask — this is the record-only panel', () => {
    for (const messages of [en, es]) {
      for (const text of Object.values(messages.bill.houseFinder)) {
        expect(text).not.toMatch(/\(\d{3}\)|\d{3}-\d{4}/);
        expect(text).not.toMatch(/\bcall\b|\bllam/i);
      }
    }
  });
});

test.describe('the amber control, computed from the tokens (page 1, rule 7)', () => {
  const paper = colorToken('paper');
  const ink = colorToken('ink');
  const urgent = colorToken('urgent');
  const src = readFileSync(join(process.cwd(), 'components/SettledHouseFinder.tsx'), 'utf8');
  /** The fill strengths the control's classes use, read from the source. */
  const fills = [...src.matchAll(/bg-urgent\/(\d+)/g)].map((m) => Number(m[1]) / 100);

  test('the control uses a light amber FILL, at rest and on hover, and never a solid one', () => {
    expect(fills.length).toBeGreaterThanOrEqual(2);
    for (const f of fills) expect(f).toBeLessThan(1);
    expect(src).not.toMatch(/\bbg-urgent(?!\/)/);
  });

  test('ink text on every amber fill it uses clears AA (4.5:1) — composited over paper', () => {
    for (const f of fills) {
      const ground = mixHex(paper, urgent, f);
      expect(contrastRatio(ink, ground), `ink on ${f * 100}% amber (${ground})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('its edge is line-strong, which clears 3:1 against the paper around it (1.4.11)', () => {
    expect(src).toMatch(/const AMBER =\s*'[^']*border-line-strong/);
    expect(contrastRatio(colorToken('line-strong'), paper)).toBeGreaterThanOrEqual(3);
  });
});

test.describe('privacy, by source read (page 1, rule 1)', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const finder = strip(readFileSync(join(process.cwd(), 'components/SettledHouseFinder.tsx'), 'utf8'));
  const form = strip(readFileSync(join(process.cwd(), 'components/AddressForm.tsx'), 'utf8'));
  const lib = strip(readFileSync(join(process.cwd(), 'lib/house-finder.ts'), 'utf8'));

  test('the finder and its helpers keep the district in memory: no storage, no URL writes, no logs', () => {
    for (const [name, src] of [
      ['SettledHouseFinder', finder],
      ['house-finder', lib],
    ] as const) {
      expect(src, name).not.toMatch(/localStorage|sessionStorage|setPrefs|indexedDB|document\.cookie/);
      expect(src, name).not.toMatch(/history\.(push|replace)State|router\.|useRouter|location\.(href|assign|replace)/);
      expect(src, name).not.toMatch(/\bconsole\s*\./);
    }
  });

  test('the address travels in a POST body only, and a panel never navigates with it', () => {
    expect(form).toMatch(/fetch\('\/api\/district',\s*\{\s*method: 'POST'/);
    expect(form).toMatch(/body: JSON\.stringify\(\{ address: clean, zip \}\)/);
    expect(form).not.toMatch(/\/api\/district\?/);
    expect(form).not.toMatch(/\bconsole\s*\./);
    // The panel branch hands the district back and returns before /reps's push.
    const found = form.indexOf('panel.onFound(');
    const push = form.indexOf('router.push(');
    expect(found).toBeGreaterThan(-1);
    expect(found).toBeLessThan(push);
    expect(form.slice(found, push)).toMatch(/return;/);
    expect(form).not.toMatch(/localStorage|setPrefs/);
  });
});
