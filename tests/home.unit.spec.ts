import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { STATUS_LINE_KEYS, type StatusLine } from '../lib/moment-status.mjs';
import { byNewestRecord, homeQuestionRows, leadTally, type RecordOrderKey } from '../lib/home';
import {
  memberRole,
  namedMembers,
  readLookup,
  savedZipDistrict,
  type LookupAnswer,
} from '../lib/home-zip';
import { getLiveMoments } from '../lib/moments';
import { momentStatus } from '../lib/moments-ui';

/*
 * HOME OPTION B's readings (owner, 2026-09-29: "Home Page - Option B, This
 * week first, then Big Questions."). The e2e half — the order of the bands,
 * the whole-row links, the saved-ZIP hero — is tests/home-b.spec.ts.
 */

const key = (over: Partial<RecordOrderKey>): RecordOrderKey => ({
  leadDate: null,
  latestAction: null,
  latestUpdate: null,
  index: 0,
  ...over,
});

test.describe('Big Questions: newest record action first', () => {
  test('the printed date leads the order', () => {
    const rows = [
      key({ leadDate: '2026-07-27', index: 0 }),
      key({ leadDate: '2026-09-24', index: 1 }),
      key({ leadDate: '2026-09-02', index: 2 }),
    ];
    expect([...rows].sort(byNewestRecord).map((r) => r.index)).toEqual([1, 2, 0]);
  });

  test('ties go to the newest vehicle action, then the newest recorded day, then file order', () => {
    const a = key({ leadDate: '2026-09-24', latestAction: '2026-09-24', latestUpdate: '2026-09-24', index: 0 });
    const b = key({ leadDate: '2026-09-24', latestAction: '2026-09-24', latestUpdate: '2026-09-28', index: 3 });
    const c = key({ leadDate: '2026-09-24', latestAction: '2026-09-25', latestUpdate: null, index: 5 });
    const d = key({ leadDate: '2026-09-24', latestAction: '2026-09-24', latestUpdate: '2026-09-24', index: 1 });
    expect([a, b, c, d].sort(byNewestRecord).map((r) => r.index)).toEqual([5, 3, 0, 1]);
  });

  test('an undated question sorts after every dated one', () => {
    const rows = [key({ index: 0 }), key({ leadDate: '2025-01-01', index: 1 })];
    expect([...rows].sort(byNewestRecord).map((r) => r.index)).toEqual([1, 0]);
  });

  test('over the committed corpus: every live question, once, dates never rising', () => {
    const rows = homeQuestionRows();
    expect(rows.map((r) => r.moment.id).sort()).toEqual(getLiveMoments().map((m) => m.id).sort());
    const dates = rows.map((r) => r.order.leadDate).filter((d): d is string => d !== null);
    expect(dates, 'the printed dates descend down the list').toEqual([...dates].sort().reverse());
    // The row prints the SAME lead line the question page and the /questions
    // card print — the homepage reads nothing a second way.
    for (const r of rows) {
      const lead = momentStatus(r.moment.vehicles).lead;
      expect(r.lead?.key, r.moment.id).toBe(lead?.key);
      expect(r.lead?.date, r.moment.id).toBe(lead?.date);
    }
  });
});

test.describe('the short status line', () => {
  const line = (over: Partial<StatusLine>): StatusLine => ({
    key: 'failed',
    chamber: 'senate',
    passedBy: null,
    law: null,
    date: '2026-09-24',
    text: null,
    terminal: true,
    rank: 30,
    ...over,
  });
  const bill = (text: string) => ({
    bill_type: 'hconres',
    status: 'floor_vote',
    last_action_text: text,
    last_action_date: '2026-09-24',
  });

  test('a failed vote carries the tally from the sentence the key was read from', () => {
    expect(
      leadTally(line({}), bill('Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.'))
    ).toEqual({ yeas: 49, nays: 50 });
  });

  test('no tally when the sentence has none, and never on another key', () => {
    expect(leadTally(line({}), bill('Motion to proceed rejected in Senate by Voice Vote.'))).toBeNull();
    expect(
      leadTally(
        line({ key: 'onFloor' }),
        bill('Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 25.')
      )
    ).toBeNull();
    expect(leadTally(null, bill('Failed of passage in Senate by Yea-Nay Vote. 49 - 50.'))).toBeNull();
  });

  for (const [lang, messages] of [
    ['en', en],
    ['es', es],
  ] as const) {
    test(`${lang}: one short line for every key of the closed vocabulary, every argument filled`, () => {
      const t = createTranslator({ locale: lang, messages, namespace: 'homeLine' });
      for (const k of STATUS_LINE_KEYS) {
        for (const chamber of ['house', 'senate', 'other']) {
          for (const tally of ['none', 'yes']) {
            const out = t(k as never, { chamber, law: 'none', tally, yeas: 49, nays: 50 } as never) as string;
            expect(out, `${lang} homeLine.${k}`).not.toMatch(/[{}]/);
            expect(out.length, `${lang} homeLine.${k}`).toBeGreaterThan(5);
          }
        }
      }
      const signed = t('signed' as never, { law: '119-103' } as never) as string;
      expect(signed).toContain('119-103');
      const failed = t('failed' as never, { chamber: 'senate', tally: 'yes', yeas: 49, nays: 50 } as never) as string;
      expect(failed).toContain('49–50');
    });
  }

  test('the owner\'s style: "the president", lowercase, in both languages (2026-09-29)', () => {
    const all = JSON.stringify([en.homeLine, es.homeLine]);
    expect(all).not.toMatch(/President|Presidente/);
    expect(en.homeLine.vetoed).toContain('the president');
  });
});

test.describe('the hero with a saved ZIP', () => {
  const sen1 = { bioguide: 'S1', name: 'Pat One', type: 'sen' as const, state: 'WA', district: null };
  const sen2 = { bioguide: 'S2', name: 'Sam Two', type: 'sen' as const, state: 'WA', district: null };
  const rep7 = { bioguide: 'R7', name: 'Lee Seven', type: 'rep' as const, state: 'WA', district: 7 };
  const rep9 = { bioguide: 'R9', name: 'Kim Nine', type: 'rep' as const, state: 'WA', district: 9 };
  const single: LookupAnswer = { reps: [rep7, sen1, sen2], multiDistrict: false, vacancies: [] };

  test('names the senators, then the House member', () => {
    expect(namedMembers(single).map((r) => r.bioguide)).toEqual(['S1', 'S2', 'R7']);
    expect(savedZipDistrict(single)).toEqual({ state: 'WA', district: 7 });
  });

  test('a ZIP spanning two districts names only the senators, and no district', () => {
    const multi: LookupAnswer = { reps: [sen1, sen2, rep7, rep9], multiDistrict: true, vacancies: [] };
    expect(namedMembers(multi).map((r) => r.bioguide)).toEqual(['S1', 'S2']);
    expect(savedZipDistrict(multi)).toBeNull();
  });

  test('a ZIP crossing a state line names nobody, so the hero keeps the ZIP form', () => {
    // 19973 (Delaware and Maryland) answers with four senators, and only two
    // of them are the reader's; the line cannot say which two.
    const de1 = { bioguide: 'D1', name: 'Dee One', type: 'sen' as const, state: 'DE', district: null };
    const de2 = { bioguide: 'D2', name: 'Dee Two', type: 'sen' as const, state: 'DE', district: null };
    const deRep = { bioguide: 'DR', name: 'Dee Rep', type: 'rep' as const, state: 'DE', district: 0 };
    const crossing: LookupAnswer = { reps: [deRep, de1, de2, sen1, sen2, rep7], multiDistrict: true, vacancies: [] };
    expect(namedMembers(crossing)).toEqual([]);
  });

  test('a vacant seat still names its district', () => {
    const vacant: LookupAnswer = {
      reps: [sen1, sen2],
      multiDistrict: false,
      vacancies: [{ state: 'TX', district: 23 }],
    };
    expect(namedMembers(vacant).map((r) => r.bioguide)).toEqual(['S1', 'S2']);
    expect(savedZipDistrict(vacant)).toEqual({ state: 'TX', district: 23 });
  });

  test('roles: senator, delegate for DC and the territories, representative otherwise', () => {
    expect(memberRole(sen1)).toBe('senator');
    expect(memberRole(rep7)).toBe('representative');
    expect(memberRole({ type: 'rep', state: 'DC' })).toBe('delegate');
    expect(memberRole({ type: 'rep', state: 'PR' })).toBe('delegate');
  });

  test('an answer it cannot read names nobody (the form stays)', () => {
    expect(readLookup(null)).toBeNull();
    expect(readLookup({ error: 'rate_limited' })).toBeNull();
    expect(readLookup({ reps: [{ name: 'no id' }] })?.reps).toEqual([]);
    expect(readLookup({ reps: [sen1], multiDistrict: 'yes' })?.multiDistrict).toBe(false);
  });

  /*
   * The member's title, per language. English uses the chamber titles the
   * wireframe draws ("Sen. Maria Cantwell"). Spanish names the chamber after
   * the name instead: "Sen." and "Rep." are English abbreviations ("Rep." reads
   * as "república" in Spanish), and the record carries no gender, so
   * "la senadora" / "el senador" is not available.
   */
  const TITLED = {
    en: { senator: 'Sen. Pat One', delegate: 'Del. Pat One', representative: 'Rep. Pat One' },
    es: { senator: 'Pat One (Senado)', delegate: 'Pat One (Cámara)', representative: 'Pat One (Cámara)' },
  } as const;

  for (const [lang, messages] of [
    ['en', en],
    ['es', es],
  ] as const) {
    test(`${lang}: the member titles and the ZIP line render every branch`, () => {
      const t = createTranslator({ locale: lang, messages, namespace: 'homeZip' });
      for (const role of ['senator', 'delegate', 'representative'] as const) {
        const out = t('member' as never, { role, name: 'Pat One' } as never) as string;
        expect(out).toBe(TITLED[lang][role]);
      }
      const withPlace = t('where' as never, { zip: '98103', hasPlace: 'yes', place: 'WA 7' } as never) as string;
      expect(withPlace).toContain('98103');
      expect(withPlace).toContain('WA 7');
      const without = t('where' as never, { zip: '98103', hasPlace: 'no', place: '' } as never) as string;
      expect(without).not.toMatch(/·\s*·/);
    });
  }
});

/*
 * THE LATEST-VOTE BLOCK IS NEUTRAL (rule 3). tests/nonpartisan-render.unit
 * .spec.ts holds the vote surfaces to "a vote position is words, never a
 * colour"; this block is a vote surface too, so the same two scans run over
 * it here.
 */
test.describe('components/HomeLatestVote.tsx: a vote position is words, never a colour', () => {
  const source = readFileSync(join(process.cwd(), 'components/HomeLatestVote.tsx'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  test('no style or class expression reads a vote position or a party', () => {
    for (const m of code.matchAll(/\b(className|style)\s*=\s*(\{[^}]*\}\}?|"[^"]*")/g)) {
      expect(m[2], m[0]).not.toMatch(/\b(yea|nay|present|notVoting|position|party)\b/i);
    }
  });

  test('no partisan colour family and no colour literal', () => {
    expect(code).not.toMatch(/-(red|rose|pink|orange|blue|sky|indigo|cyan|violet|purple|fuchsia)-\d/);
    expect(code).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
