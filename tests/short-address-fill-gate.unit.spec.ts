import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  decodeNameTables,
  encodeNameTables,
  nameAddressTarget,
  NAME_ADDRESS_RESERVED,
  SHORT_ADDRESS_CONGRESS,
  shortAddressFallbackCongresses,
  type ShortTitleFile,
} from '../lib/short-address';
import { gateNameTables, nameTablesForBuild, refusalLine, type GateBill } from '../lib/short-address-build';
import { pageviewSurfaceForPath } from '../lib/usage';

/*
 * THE FILL GATE (hotfix, 2026-11-17; lib/short-address-build.ts gateNameTables).
 * On the night of Nov 17, 2026 the first nightly read 300 of 3,335 bills, and
 * oravan.org/laken-riley-act opened H.R. 29 because its twin S. 5 had not been
 * read: Oravan picked between two bills. A name opens a bill only when every
 * bill Oravan tracks in that Congress has been read or tried, no other of those
 * bills makes the same name, and no unread one's stored title makes it.
 * Fixtures only (the real files as committed on main at 6fe67774, copied into
 * tests/fixtures/first-fill-2026-11-17/), no clock.
 */

const FIX = path.join(process.cwd(), 'tests/fixtures/first-fill-2026-11-17');
const REAL_BILLS = JSON.parse(fs.readFileSync(path.join(FIX, 'bills.json'), 'utf8')) as GateBill[];
const REAL_TITLES = JSON.parse(fs.readFileSync(path.join(FIX, 'short-titles.json'), 'utf8')) as ShortTitleFile;
const LOCALES = ['en', 'es'];
const C = 119;
const bill = (bill_type: string, bill_number: number, title: string, congress_number = C): GateBill => ({ bill_type, bill_number, congress_number, title });
const entry = (...titles: string[]) => ({ titles, as_of: '2026-11-01', read_on: '2026-11-17' });
const failed = { failures: 1, last_tried: '2026-11-17', reason: 'HTTP 503' };

/** The table exactly as the build makes it: encode, then the gate. */
function table(bills: GateBill[], titles: ShortTitleFile, retry: Record<string, unknown> = {}, order = [C]) {
  const reserved = new Set(NAME_ADDRESS_RESERVED);
  const gate = gateNameTables(encodeNameTables(bills, titles, order, reserved), bills, titles, retry, order, reserved);
  const tables = decodeNameTables(gate.encoded);
  return { ...gate, open: (name: string) => nameAddressTarget(`/${name}`, LOCALES, 'en', tables), tables };
}

const S5 = bill('s', 5, 'Laken Riley Act');
const HR29 = bill('hr', 29, 'Laken Riley Act');
const HR9770 = bill('hr', 9770, 'Continuing Appropriations Act, 2027');
const HR10136 = bill('hr', 10136, 'Crossett Experimental Forest Act of 2026');

test('the live case: H.R. 29 read, S. 5 not: laken-riley-act opens nothing; nor once S. 5 is read (shared); a unique name opens only when the fill is complete', () => {
  const corpus = [S5, HR29, HR9770, HR10136];
  // Tonight: H.R. 29 and H.R. 10136 read, S. 5 and H.R. 9770 not yet.
  const tonight = table(corpus, { 'hr-29-119': entry('Laken Riley Act'), 'hr-10136-119': entry('Crossett Experimental Forest Act of 2026') });
  expect(tonight.open('laken-riley-act')).toBeNull();
  expect(tonight.open('crossett-experimental-forest-act-of-2026')).toBeNull();
  expect(tonight.encoded).toBe('');
  expect(tonight.line).toMatch(/^OFF from the 119th Congress on: 2 of its 4 bills read, 2 never read or tried/);
  // S. 5 read too, H.R. 9770 still not: still nothing at all.
  const more = table(corpus, { 'hr-29-119': entry('Laken Riley Act'), 's-5-119': entry('Laken Riley Act'), 'hr-10136-119': entry('Crossett Experimental Forest Act of 2026') });
  expect(more.open('laken-riley-act')).toBeNull();
  expect(more.open('crossett-experimental-forest-act-of-2026')).toBeNull();
  // Every bill read: the shared name opens nothing, the unique ones open their bills.
  const full = table(corpus, {
    'hr-29-119': entry('Laken Riley Act'),
    's-5-119': entry('Laken Riley Act'),
    'hr-10136-119': entry('Crossett Experimental Forest Act of 2026'),
    'hr-9770-119': entry('Continuing Appropriations Act, 2027'),
  });
  // Shared by two read bills: since the owner's card 193 (#510) it opens the page that lists them.
  expect(full.open('laken-riley-act')).toBe('/names/119/laken-riley-act');
  expect(full.tables[0].names.get('laken-riley-act')).toBeNull();
  expect(full.open('crossett-experimental-forest-act-of-2026')).toBe('/bills/hr-10136-119');
  expect(full.open('continuing-appropriations-act-2027')).toBe('/bills/hr-9770-119');
  expect(full.line).toBe('ON for the 119th Congress: 4 bills, 4 read, 0 tried and waiting; 0 name(s) held back by a bill not read yet');
});

test('fill complete, one bill tried and never read: the name its stored title makes opens nothing; every other name opens', () => {
  const corpus = [S5, HR29, HR9770, HR10136];
  const g = table(
    corpus,
    { 'hr-29-119': entry('Laken Riley Act'), 'hr-10136-119': entry('Crossett Experimental Forest Act of 2026'), 'hr-9770-119': entry('Continuing Appropriations Act, 2027') },
    { 's-5-119': failed },
  );
  expect(g.open('laken-riley-act')).toBeNull();
  expect(g.blocked).toEqual(['laken-riley-act (s-5-119 not read yet)']);
  expect(g.open('crossett-experimental-forest-act-of-2026')).toBe('/bills/hr-10136-119');
  expect(g.open('continuing-appropriations-act-2027')).toBe('/bills/hr-9770-119');
  expect(g.line).toContain('1 name(s) held back by a bill not read yet');
  // A bill read once whose refresh failed (in the retry file WITH an entry) holds nothing back: its titles are known.
  const refresh = table(corpus, { 'hr-29-119': entry('Laken Riley Act'), 's-5-119': entry(), 'hr-10136-119': entry('Crossett Experimental Forest Act of 2026'), 'hr-9770-119': entry('Continuing Appropriations Act, 2027') }, { 's-5-119': failed });
  expect(refresh.open('laken-riley-act')).toBe('/bills/hr-29-119');
});

test('fill complete, a name two READ bills share, and a third bill tried and never read whose stored title makes it: the name keeps opening the list page', () => {
  // The merge of main's fill gate into #510 (Nov 19, 2026): a name already shared stays shared, never held back.
  const HR7 = bill('hr', 7, 'Laken Riley Act');
  const corpus = [S5, HR29, HR7, HR9770];
  const g = table(
    corpus,
    { 's-5-119': entry('Laken Riley Act'), 'hr-29-119': entry('Laken Riley Act'), 'hr-9770-119': entry('Continuing Appropriations Act, 2027') },
    { 'hr-7-119': failed },
  );
  expect(g.open('laken-riley-act')).toBe('/names/119/laken-riley-act');
  expect(g.tables[0].names.get('laken-riley-act')).toBeNull();
  expect(g.blocked).toEqual([]);
  expect(g.open('continuing-appropriations-act-2027')).toBe('/bills/hr-9770-119');
});

test('the real partial fill of Nov 17, 2026 (300 of 3,335 read, as committed on main): zero names', () => {
  expect(REAL_BILLS).toHaveLength(3335);
  expect(Object.keys(REAL_TITLES)).toHaveLength(300);
  const order = [SHORT_ADDRESS_CONGRESS, ...shortAddressFallbackCongresses(REAL_BILLS)];
  const g = table(REAL_BILLS, REAL_TITLES, {}, order);
  expect(g.encoded).toBe('');
  expect(g.open('laken-riley-act')).toBeNull();
  expect(g.open('crossett-experimental-forest-act-of-2026')).toBeNull();
  expect(g.line).toBe(
    'OFF from the 119th Congress on: 300 of its 3335 bills read, 3035 never read or tried, so no name opens a bill there or in any Congress searched after it until every one has been read or tried',
  );
  // What the table held before this fix, on the same files: names opening one bill each.
  const before = decodeNameTables(encodeNameTables(REAL_BILLS, REAL_TITLES, order, new Set(NAME_ADDRESS_RESERVED)));
  expect(nameAddressTarget('/laken-riley-act', LOCALES, 'en', before)).toBe('/bills/hr-29-119');
});

test('the January order: an incomplete Congress holds no names and the search stops there, never reaching an older bill', () => {
  const old = [bill('s', 5, 'Laken Riley Act'), bill('hr', 7, 'Old Unique Act')];
  const neu = [bill('hr', 1, 'New Act', 120), bill('hr', 2, 'Second New Act', 120)];
  const corpus = [...old, ...neu];
  const oldRead = { 's-5-119': entry('Laken Riley Act'), 'hr-7-119': entry('Old Unique Act') };
  const order = [120, 119];
  // The 120th read in full: its names open, and an older Congress read in full answers names the 120th does not hold.
  const both = table(corpus, { ...oldRead, 'hr-1-120': entry('New Act'), 'hr-2-120': entry('Second New Act') }, {}, order);
  expect(both.open('new-act')).toBe('/bills/hr-1-120');
  expect(both.open('old-unique-act')).toBe('/bills/hr-7-119');
  // The 120th not read in full: nothing opens, not even a name only the 119th holds.
  const partial = table(corpus, { ...oldRead, 'hr-1-120': entry('New Act') }, {}, order);
  expect(partial.encoded).toBe('');
  expect(partial.open('old-unique-act')).toBeNull();
  expect(partial.open('new-act')).toBeNull();
  // The 120th in full and the 119th not: the 120th's names open, the 119th holds nothing.
  const oldPartial = table(corpus, { 's-5-119': entry('Laken Riley Act'), 'hr-1-120': entry('New Act'), 'hr-2-120': entry('Second New Act') }, {}, order);
  expect(oldPartial.open('new-act')).toBe('/bills/hr-1-120');
  expect(oldPartial.open('laken-riley-act')).toBeNull();
  expect(oldPartial.line).toMatch(/^ON for the 120th Congress: .*; OFF from the 119th Congress on: 1 of its 2 bills read, 1 never read or tried/);
  // An unread 120th bill whose stored title makes an old name stops the search there: the old bill is not opened.
  const shadow = table([...old, bill('hr', 1, 'Old Unique Act', 120)], { ...oldRead }, { 'hr-1-120': failed }, order);
  expect(shadow.open('old-unique-act')).toBeNull();
  expect(shadow.open('laken-riley-act')).toBe('/bills/s-5-119');
});

test('a blocked name is the normal not-found path, counted under the same page shape as before', () => {
  const g = table([S5, HR29], { 'hr-29-119': entry('Laken Riley Act') });
  expect(g.open('laken-riley-act')).toBeNull();
  // Not a redirect, so the proxy hands it on; it counts as any unknown path does ('other'), nothing about the name.
  expect(pageviewSurfaceForPath('/laken-riley-act', LOCALES)).toBe('other');
  expect(pageviewSurfaceForPath('/es/laken-riley-act', LOCALES)).toBe('other');
});

test('the build reads the committed files and prints one line: names on or off, and why', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-gate-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    const corpus = [S5, HR29, HR10136];
    const run = (titles: ShortTitleFile | null, retry: Record<string, unknown> | null) => {
      for (const [f, v] of [['short-titles.json', titles], ['short-titles-retry.json', retry]] as const) {
        const p = path.join(root, 'data', f);
        if (v === null) fs.rmSync(p, { force: true });
        else fs.writeFileSync(p, JSON.stringify(v));
      }
      const lines: string[] = [];
      const encoded = nameTablesForBuild(corpus, root, (r) => lines.push(refusalLine(r)));
      return { encoded, gateLine: lines.filter((l) => /^short-address names: (ON|OFF)/.test(l)) };
    };
    const none = run(null, null);
    expect(none.encoded).toBe('');
    expect(none.gateLine).toEqual(['short-address names: OFF from the 119th Congress on: 0 of its 3 bills read, 3 never read or tried, so no name opens a bill there or in any Congress searched after it until every one has been read or tried']);
    const partial = run({ 'hr-29-119': entry('Laken Riley Act') }, null);
    expect(partial.encoded).toBe('');
    const full = run({ 'hr-29-119': entry('Laken Riley Act'), 'hr-10136-119': entry('Crossett Experimental Forest Act of 2026') }, { 's-5-119': failed });
    const t = decodeNameTables(full.encoded);
    expect(nameAddressTarget('/laken-riley-act', LOCALES, 'en', t)).toBeNull();
    expect(nameAddressTarget('/crossett-experimental-forest-act-of-2026', LOCALES, 'en', t)).toBe('/bills/hr-10136-119');
    expect(full.gateLine).toEqual(['short-address names: ON for the 119th Congress: 3 bills, 2 read, 1 tried and waiting; 1 name(s) held back by a bill not read yet']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stored short_title holds back its name too, when data/bills.json has one (none does today)', () => {
  const unread: GateBill = { ...bill('s', 9, 'A bill to do a thing'), short_title: 'Laken Riley Act' };
  const g = table([HR29, unread], { 'hr-29-119': entry('Laken Riley Act') }, { 's-9-119': failed });
  expect(g.open('laken-riley-act')).toBeNull();
  expect(REAL_BILLS.filter((b) => b.short_title)).toHaveLength(0);
});

// --- follow-ups of #517 (2026-11-18) -----------------------------------------------------------

test('follow-up 4: an unreadable titles or retry file never fails the build: names OFF, one line saying why', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-gate-bad-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    const corpus = [S5, HR29];
    const good = JSON.stringify({ 'hr-29-119': entry('Laken Riley Act'), 's-5-119': entry('Laken Riley Act') });
    const cases: Array<[string, string | null, string | null, RegExp]> = [
      ['an empty titles file', '', null, /^short-address names: OFF: data\/short-titles\.json could not be read \(.+\), so no name opens a bill until it is fixed/],
      ['titles that are not JSON', '{"hr-29-119":', null, /^short-address names: OFF: data\/short-titles\.json could not be read/],
      ['titles that are null', 'null', null, /^short-address names: OFF: data\/short-titles\.json is not an object/],
      ['titles that are a list', '[]', null, /^short-address names: OFF: data\/short-titles\.json is not an object/],
      ['a retry file of null', good, 'null', /^short-address names: OFF: data\/short-titles-retry\.json is not an object/],
      ['an empty retry file', good, '', /^short-address names: OFF: data\/short-titles-retry\.json could not be read/],
      ['a retry file that is not JSON', good, '{', /^short-address names: OFF: data\/short-titles-retry\.json could not be read/],
    ];
    for (const [label, titles, retry, line] of cases) {
      for (const [f, v] of [['short-titles.json', titles], ['short-titles-retry.json', retry]] as const) {
        const p = path.join(root, 'data', f);
        if (v === null) fs.rmSync(p, { force: true });
        else fs.writeFileSync(p, v);
      }
      const lines: string[] = [];
      let encoded = 'not run';
      expect(() => {
        encoded = nameTablesForBuild(corpus, root, (r) => lines.push(refusalLine(r)));
      }, label).not.toThrow();
      expect(encoded, label).toBe('');
      expect(lines, label).toHaveLength(1);
      expect(lines[0], label).toMatch(line);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('follow-up 6: while names are off, a "shared by" line says it is not in effect; once on, it reads as before', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-gate-lines-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    const both = { 'hr-29-119': entry('Laken Riley Act'), 's-5-119': entry('Laken Riley Act') };
    const run = (corpus: GateBill[]) => {
      fs.writeFileSync(path.join(root, 'data', 'short-titles.json'), JSON.stringify(both));
      const lines: string[] = [];
      nameTablesForBuild(corpus, root, (r) => lines.push(refusalLine(r)));
      return lines.filter((l) => l.includes('shared by'));
    };
    // H.R. 10136 never read: names off for the 119th.
    expect(run([S5, HR29, HR10136])).toEqual([
      'short-address names: "laken-riley-act" opens no single bill: shared by 2 bills, so it opens the page that lists them, /names/119/laken-riley-act (not in effect: names are off for the 119th Congress) (hr-29-119 s-5-119)',
    ]);
    expect(run([S5, HR29])).toEqual(['short-address names: "laken-riley-act" opens no single bill: shared by 2 bills, so it opens the page that lists them, /names/119/laken-riley-act (hr-29-119 s-5-119)']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('follow-up 6: a tried-but-unread bill whose stored title is a description nobody else makes adds no entry and holds nothing back', () => {
  const described = bill('hr', 812, 'To amend title 38, United States Code, to improve the processing of veterans claims, and for other purposes.');
  const g = table([HR29, HR10136, described], { 'hr-29-119': entry('Laken Riley Act'), 'hr-10136-119': entry('Crossett Experimental Forest Act of 2026') }, { 'hr-812-119': failed });
  expect(g.blocked).toEqual([]);
  expect(g.line).toContain('0 name(s) held back by a bill not read yet');
  expect([...g.tables[0].names.keys()].sort()).toEqual(['crossett-experimental-forest-act-of-2026', 'laken-riley-act']);
  // A stored title that another bill DOES make is still held back, here or in an older Congress searched after.
  const twin = table([HR29, { ...S5 }], { 'hr-29-119': entry('Laken Riley Act') }, { 's-5-119': failed });
  expect(twin.blocked).toEqual(['laken-riley-act (s-5-119 not read yet)']);
});

// --- the check of #520 (2026-11-18) ---------------------------------------------------------------

test('check of #520: an entry whose `titles` is not a list never fails the build, makes no name, and is NOT read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-gate-entry-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    const corpus = [S5, HR29, HR10136];
    for (const malformed of [{ titles: 5 }, { titles: {} }]) {
      const titles = { 's-5-119': entry('Laken Riley Act'), 'hr-29-119': malformed, 'hr-10136-119': entry('Crossett Experimental Forest Act of 2026') };
      const run = (retry: Record<string, unknown> | null) => {
        fs.writeFileSync(path.join(root, 'data', 'short-titles.json'), JSON.stringify(titles));
        const p = path.join(root, 'data', 'short-titles-retry.json');
        if (retry === null) fs.rmSync(p, { force: true });
        else fs.writeFileSync(p, JSON.stringify(retry));
        const lines: string[] = [];
        let encoded = 'not run';
        expect(() => {
          encoded = nameTablesForBuild(corpus, root, (r) => lines.push(refusalLine(r)));
        }, JSON.stringify(malformed)).not.toThrow();
        return { t: decodeNameTables(encoded), encoded, gate: lines.find((l) => /^short-address names: (ON|OFF)/.test(l))! };
      };
      // Not read and not tried: the Congress is not read in full, so no name opens (S. 5 does not get laken-riley-act).
      const off = run(null);
      expect(off.encoded).toBe('');
      expect(off.gate).toContain('OFF from the 119th Congress on: 2 of its 3 bills read, 1 never read or tried');
      // Not read but tried: its stored title holds laken-riley-act back; other names open as before.
      const on = run({ 'hr-29-119': failed });
      expect(nameAddressTarget('/laken-riley-act', LOCALES, 'en', on.t)).toBeNull();
      expect(nameAddressTarget('/crossett-experimental-forest-act-of-2026', LOCALES, 'en', on.t)).toBe('/bills/hr-10136-119');
      expect(on.gate).toContain('ON for the 119th Congress: 3 bills, 2 read, 1 tried and waiting; 1 name(s) held back');
    }
    // The encoder alone, given the malformed entry, makes no name for it and leaves the others alone.
    const names = decodeNameTables(encodeNameTables([HR29, HR10136], { 'hr-29-119': { titles: 5 } as never, 'hr-10136-119': entry('Crossett Experimental Forest Act of 2026') }, [C], new Set(NAME_ADDRESS_RESERVED)));
    expect([...names[0].names.keys()]).toEqual(['crossett-experimental-forest-act-of-2026']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
