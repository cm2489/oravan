import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import billsJson from '../data/bills.json';
import {
  decodeNameTables,
  decodeShortAddressFallback,
  decodeShortAddressIndex,
  encodeNameTables,
  encodeShortAddressFallback,
  encodeShortAddressIndex,
  NAME_ADDRESS_RESERVED,
  NAME_ADDRESS_LOCALES,
  NAME_ADDRESS_RULING,
  nameAddressAllowed,
  nameAddressRefusal,
  PROXY_MATCHER,
  slugTitle,
  proxySeesPath,
  nameAddressTarget,
  nameSlug,
  namesOfCongress,
  parseShortAddress,
  SHORT_ADDRESS_CONGRESS,
  shortAddressFallbackCongresses,
  shortAddressTarget,
  type ShortAddressBill,
  type ShortAddressPolicy,
  type ShortTitleFile,
} from '../lib/short-address';
import { nameTablesForBuild, readShortTitles, refusalLine, reservedNames } from '../lib/short-address-build';
import { topRouteSegments } from '../lib/route-segments.mjs';
import { isRecordShortTitleType, shortTitlesFromRecord } from '../lib/short-titles.mjs';
import { congressTerm } from '../lib/congress.mjs';
import { APP_DIR, LOCALE_DIR, localeTopSegments } from './routes';
import { routing } from '../i18n/routing';

/*
 * NAME ADDRESSES (lib/short-address.ts): oravan.org/laken-riley-act opens the
 * one bill whose record short title it is. The owner's card 191 (Nov 14,
 * 2026, 1:06 PM ET): "Names beside numbers. Each name comes from the bill's
 * own official short title in the record, never chosen by Oravan."
 * Pure Node. tests/short-address.spec.ts checks the built redirect.
 */

const LOCALES = ['en', 'es'];
const C = SHORT_ADDRESS_CONGRESS;
const NONE: ReadonlySet<string> = new Set();

// --- where a name comes from ----------------------------------------------------

test('the ruling is recorded in the words of the card', () => {
  expect(NAME_ADDRESS_RULING).toContain('Card 191');
  expect(NAME_ADDRESS_RULING).toContain('Nov 14, 2026, 1:06 PM ET');
  expect(NAME_ADDRESS_RULING).toContain(
    '"Names beside numbers. Each name comes from the bill\'s own official short title in the record, never chosen by Oravan."',
  );
});

test('only a title the record labels a short title of the bill is kept', () => {
  // The record's own titleType strings, as Congress.gov's titles list wrote
  // them for H.R. 1, S. 5 and H.R. 4 of the 119th on 2026-11-14.
  for (const type of [
    'Short Title(s) as Introduced',
    'Short Title(s) as Passed House',
    'Short Title(s) as Passed Senate',
    'Short Title(s) as Reported to House',
    'Short Title(s) from PCS (Placed on Senate Calendar) bill text',
    'Short Titles from ENR (Enrolled) bill text',
    'Short Title(s) from Engrossed Amendment Senate bill text',
    'Short Titles from RFS (Referred to Senate) bill text',
    'Short Titles as Enacted',
  ]) {
    expect(isRecordShortTitleType(type), type).toBe(true);
  }
  for (const type of [
    'Display Title',
    'Override Display Title',
    'Official Title as Introduced',
    'Official Title as Enacted',
    'Official Title from EH (Engrossed in House) bill text',
    'Popular Titles',
    'Short Titles as Enacted for portions of this bill',
    'Short Titles for portions of this bill from ENR (Enrolled) bill text',
    'Short Title(s) from Engrossed Amendment Senate for portions of this bill',
    '',
    undefined,
  ]) {
    expect(isRecordShortTitleType(type), String(type)).toBe(false);
  }
  // H.R. 1 of the 119th, as the record lists it (abridged): its popular title
  // is also a short title as passed by the House, so it counts through that
  // label; the FEHB title names only a portion of the bill and does not.
  const hr1 = [
    { titleType: 'Display Title', title: 'An act to provide for reconciliation pursuant to title II of H. Con. Res. 14.' },
    { titleType: 'Short Titles as Enacted for portions of this bill', title: 'FEHB Protection Act of 2025' },
    { titleType: 'Popular Titles', title: 'One Big Beautiful Bill Act' },
    { titleType: 'Short Title(s) as Passed House', title: 'One Big Beautiful Bill Act' },
    { titleType: 'Short Title(s) as Reported to House', title: 'One Big Beautiful Bill Act' },
    { titleType: 'Official Title as Introduced', title: 'To provide for reconciliation pursuant to title II of H. Con. Res. 14.' },
  ];
  expect(shortTitlesFromRecord(hr1)).toEqual(['One Big Beautiful Bill Act']);
  // A popular title alone is never a short title.
  expect(shortTitlesFromRecord([{ titleType: 'Popular Titles', title: 'One Big Beautiful Bill Act' }])).toEqual([]);
  expect(shortTitlesFromRecord(null)).toEqual([]);
});

// --- the slug rule ----------------------------------------------------------------

test('slug rule: real short titles of the record, with the address each gets, written out', () => {
  // Each title is copied from Congress.gov's titles list for the named bill
  // (read 2026-11-14), and the address is worked out by hand from the rule.
  const table: Array<[string, string, string]> = [
    ['s-5-119', 'Laken Riley Act', 'laken-riley-act'],
    ['hr-4-119', 'Rescissions Act of 2025', 'rescissions-act-of-2025'],
    ['hr-1-119', 'One Big Beautiful Bill Act', 'one-big-beautiful-bill-act'],
    ...REAL_TITLE_CASES,
  ];
  for (const [bill, title, name] of table) expect(nameSlug(title), `${bill}: ${title}`).toBe(name);
});

test('slug rule: accents, apostrophes, ampersands, years, runs of punctuation, and titles with no letter', () => {
  expect(nameSlug('José Martí Act')).toBe('jose-marti-act');
  expect(nameSlug('Ñandú Protection Act')).toBe('nandu-protection-act');
  expect(nameSlug("America's Workforce Act")).toBe('americas-workforce-act');
  expect(nameSlug('America’s Workforce Act')).toBe('americas-workforce-act');
  expect(nameSlug('Research & Development Act')).toBe('research-development-act');
  expect(nameSlug('Farm, Food, and National Security Act of 2026')).toBe('farm-food-and-national-security-act-of-2026');
  expect(nameSlug('U.S.-Israel Defense Partnership Act')).toBe('u-s-israel-defense-partnership-act');
  expect(nameSlug('  The  "SAFE"  Act (Revised) — 2026 ')).toBe('the-safe-act-revised-2026');
  expect(nameSlug('21st Century Cures Act')).toBe('21st-century-cures-act');
  // No word is dropped or added: stop-words and the year stay.
  expect(nameSlug('An Act of the People')).toBe('an-act-of-the-people');
  // A title with no letter gets no name.
  expect(nameSlug('2026')).toBeNull();
  expect(nameSlug('1-2-3')).toBeNull();
  expect(nameSlug('...')).toBeNull();
  expect(nameSlug('')).toBeNull();
});

test('slug rule: a letter or digit outside a-z and 0-9 gives NO name; apostrophe-like marks are deleted', () => {
  // The reviewer's cases (2026-11-15): nothing is dropped or split to make a name.
  for (const title of [
    'Æsir Act',
    'Øresund Bridge Act',
    'Łódź Sister City Act',
    'Straße Safety Act',
    '日本 Japan Act',
    'Ελλάδα Act',
    'Москва Act',
    'Act ٢٠٢٦', // Arabic-Indic digits
  ]) {
    expect(nameSlug(title), title).toBeNull();
  }
  // Apostrophe-like: ' ‘ ’ ʼ ʻ ´ ` are deleted, joining the letters on either side.
  expect(nameSlug('Hawai\u02bbi Native Act')).toBe('hawaii-native-act');
  expect(nameSlug('Ethan\u00b4s Law')).toBe('ethans-law');
  expect(nameSlug('Ethan\u02bcs Law')).toBe('ethans-law');
  expect(nameSlug('Ethan\u2018s Law')).toBe('ethans-law');
  expect(nameSlug('Ethan`s Law')).toBe('ethans-law');
  // Accents still just drop; a ligature and full-width letters decompose to a-z.
  expect(nameSlug('Café Act')).toBe('cafe-act');
  // Since 2026-11-15 a ligature or a full-width letter is not decomposed into
  // letters (NFD, not NFKD): it is outside the allowed set, so no name.
  expect(nameSlug('\ufb01nancial Act')).toBeNull();
  expect(nameSlug('\uff21\uff23\uff25 Act')).toBeNull();
});

test('slug rule (2026-11-15): a strict allow-list; nothing is split, joined, expanded or added to make a name', () => {
  // The reviewer's cases, through the real function. Each holds a character
  // outside the allowed set after NFD, so each gets NO name.
  const none: Array<[string, string]> = [
    ['America\u2032s Act', 'a prime used as an apostrophe'],
    ['America\uff07s Act', 'a full-width apostrophe'],
    ['America\u201bs Act', 'a reversed quotation mark'],
    ['America\u055as Act', 'the Armenian apostrophe'],
    ['A\u00adct of 2026', 'a soft hyphen inside a word'],
    ['A\u200bct of 2026', 'a zero-width space inside a word'],
    ['A\u200cct of 2026', 'a zero-width non-joiner'],
    ['A\u200dct of 2026', 'a zero-width joiner'],
    ['A\u2060ct of 2026', 'a word joiner'],
    ['\ufeffSafe Act', 'a byte-order mark'],
    ['XYZ\u2122 Act', 'the trade mark sign'],
    ['\u2116 1 Act', 'the numero sign'],
    ['\u00bd Measure Act', 'a vulgar fraction'],
    ['Title \u2161 Act', 'a Roman-numeral character'],
    ['\ufb01nancial Act', 'the fi ligature'],
    ['Sta\ufb00 Act', 'the ff ligature'],
    ['\uff21\uff23\uff25 Act', 'full-width letters'],
    ['Safe\tAct', 'a tab'],
    ['Safe+ Act', 'a plus sign'],
    ['Safe Act #2', 'a number sign'],
  ];
  for (const [title, why] of none) expect(nameSlug(title), why).toBeNull();
  // The allowed punctuation, each turning into a hyphen with no word changed.
  expect(nameSlug('Safe-Act \u2013 Part\u2014One, Two. Three: Four; Five & Six / Seven (Eight) "Nine" \u201cTen\u201d! Eleven?')).toBe(
    'safe-act-part-one-two-three-four-five-six-seven-eight-nine-ten-eleven',
  );
  // A non-breaking space is read as a space: it never joins two words.
  expect(nameSlug('Safe\u00a0Act')).toBe('safe-act');
  // NFD splits only accented letters; the listed apostrophe-like marks are deleted after it.
  expect(nameSlug('Ethan\u00b4s Law')).toBe('ethans-law');
  expect(nameSlug('Hawai\u02bbi Act')).toBe('hawaii-act');
  expect(nameSlug('Jos\u00e9 Mart\u00ed Act')).toBe('jose-marti-act');
  expect(nameSlug('Jose\u0301 Act')).toBe('jose-act'); // an accent already written as a separate mark
  // Two different titles that make the same name are one name.
  expect(nameSlug('SAFE Act')).toBe(nameSlug('Safe Act'));
  expect(nameSlug('Twin Spelling Act')).toBe(nameSlug('Twin-Spelling Act'));
  // The reason is given for the build log.
  expect(slugTitle('XYZ\u2122 Act')).toEqual({ name: null, reason: 'the title holds a character outside the allowed set (U+2122)' });
  expect(slugTitle('2026')).toEqual({ name: null, reason: 'the title has no letter' });
});

test('two different titles that make the same name block each other, like the same title', () => {
  const corpus: ShortAddressBill[] = [
    { bill_type: 'hr', bill_number: 7001, congress_number: C },
    { bill_type: 's', bill_number: 7002, congress_number: C },
  ];
  const titles: ShortTitleFile = { [`hr-7001-${C}`]: { titles: ['SAFE Act'] }, [`s-7002-${C}`]: { titles: ['Safe Act'] } };
  const tables = decodeNameTables(encodeNameTables(corpus, titles, [C], NONE));
  expect(nameAddressTarget('/safe-act', LOCALES, 'en', tables)).toBeNull();
});

test('the build log names every title that gets no address and every shared name', () => {
  const corpus: ShortAddressBill[] = [
    { bill_type: 'hr', bill_number: 7101, congress_number: C },
    { bill_type: 's', bill_number: 7102, congress_number: C },
    { bill_type: 'hr', bill_number: 7103, congress_number: C },
    { bill_type: 'hr', bill_number: 7104, congress_number: C },
    { bill_type: 'hr', bill_number: 7105, congress_number: C },
    { bill_type: 'hr', bill_number: 7106, congress_number: C },
  ];
  const titles: ShortTitleFile = {
    [`hr-7101-${C}`]: { titles: ['Twin Act'] },
    [`s-7102-${C}`]: { titles: ['Twin Act'] },
    [`hr-7103-${C}`]: { titles: ['2026'] },
    [`hr-7104-${C}`]: { titles: ['H.R. 1'] },
    [`hr-7105-${C}`]: { titles: ['Privacy'] },
    [`hr-7106-${C}`]: { titles: ['Clean Act'] },
  };
  const lines: string[] = [];
  encodeNameTables(corpus, titles, [C], new Set(['privacy']), (r) => lines.push(refusalLine(r)));
  expect(lines).toEqual([
    `short-address names: hr-7103-${C} "2026" -> no name left out: the title has no letter`,
    `short-address names: hr-7104-${C} "H.R. 1" -> "h-r-1" left out: it reads as a number address`,
    `short-address names: hr-7105-${C} "Privacy" -> "privacy" left out: a route or reserved word of that name`,
    `short-address names: "twin-act" opens nothing: shared by 2 bills, so it opens none of them (hr-7101-${C} s-7102-${C})`,
  ]);
});

test('the proxy can see every name in both languages: names its matcher skips are refused', () => {
  // PROXY_MATCHER is proxy.ts's own `config.matcher`, character for character.
  const proxy = fs.readFileSync(path.join(process.cwd(), 'proxy.ts'), 'utf8');
  const literal = /matcher:\s*'([^']+)'/.exec(proxy)?.[1];
  expect(literal?.replace(/\\\\/g, '\\')).toBe(PROXY_MATCHER);
  expect([...NAME_ADDRESS_LOCALES]).toEqual([...routing.locales]);
  // What the matcher skips, in English (the reviewer's /apiary-fixture-act case):
  for (const p of ['/api', '/apiary-fixture-act', '/api-security-act', '/_next', '/_vercel', '/embed', '/embed/x', '/a.b']) {
    expect(proxySeesPath(p), p).toBe(false);
  }
  for (const p of ['/es/apiary-fixture-act', '/embed-act', '/embeds', '/hr1', '/continuing-appropriations-act-2027', '/rapid-act']) {
    expect(proxySeesPath(p), p).toBe(true);
  }
  for (const name of ['apiary-fixture-act', 'api-security-act', 'apis-act']) {
    expect(nameAddressRefusal(name, NONE), name).toContain('matcher');
  }
  expect(nameAddressAllowed('embed-act', NONE)).toBe(true);
  expect(nameAddressAllowed('rapid-act', NONE)).toBe(true);
  // A fixture table with a name at every prefix the matcher excludes: none of
  // them is in it, and every name in it resolves the same in English and Spanish.
  const corpus: ShortAddressBill[] = ['Apiary Fixture Act', 'API Security Act', 'Embed', 'Embed Act', 'Next Act', 'Vercel Act', 'Rapid Act'].map(
    (_, i) => ({ bill_type: 'hr', bill_number: 9000 + i, congress_number: C }),
  );
  const titles: ShortTitleFile = Object.fromEntries(
    ['Apiary Fixture Act', 'API Security Act', 'Embed', 'Embed Act', 'Next Act', 'Vercel Act', 'Rapid Act'].map((t, i) => [`hr-${9000 + i}-${C}`, { titles: [t] }]),
  );
  const tables = decodeNameTables(encodeNameTables(corpus, titles, [C], reservedNames()));
  expect([...tables[0].names.keys()].sort()).toEqual(['embed-act', 'next-act', 'rapid-act', 'vercel-act']);
  for (const table of tables) for (const name of table.names.keys()) everyLanguageAlike(name, tables);
});

/** A name in a table: the proxy runs on it in every language, and it answers the same bill in each. */
function everyLanguageAlike(name: string, tables: ReturnType<typeof decodeNameTables>) {
  expect(proxySeesPath(`/${name}`), name).toBe(true);
  const en = nameAddressTarget(`/${name}`, LOCALES, 'en', tables);
  for (const l of NAME_ADDRESS_LOCALES) {
    expect(proxySeesPath(`/${l}/${name}`), `/${l}/${name}`).toBe(true);
    const t = nameAddressTarget(`/${l}/${name}`, LOCALES, 'en', tables);
    expect(t, `/${l}/${name}`).toBe(l === 'en' ? en : en && `/${l}${en}`);
  }
}

test('a name is an address only when it is 4 to 200 characters, never a number address, never reserved', () => {
  const reserved = new Set(['bills', 'privacy']);
  expect(nameAddressAllowed('laken-riley-act', reserved)).toBe(true);
  expect(nameAddressAllowed('bills', reserved)).toBe(false);
  expect(nameAddressAllowed('privacy', reserved)).toBe(false);
  // A title that slugs to a number address never becomes a name.
  for (const title of ['HR 1', 'hr1', 'S. 2', 'S-2', 'HJRES 12', 'hconres5']) {
    const name = nameSlug(title)!;
    expect(parseShortAddress(name), title).not.toBeNull();
    expect(nameAddressAllowed(name, NONE), title).toBe(false);
  }
  // "H.R. 1" slugs to h-r-1. The parser does not read it as a number address,
  // but it looks like one, so it is refused as number-like (2026-11-15): with
  // its hyphens removed it is "hr1".
  expect(nameSlug('H.R. 1')).toBe('h-r-1');
  expect(parseShortAddress('h-r-1')).toBeNull();
  for (const name of ['h-r-1', 'h-r-9340', 's-j-res-5', 'h-con-res-12', 'hj-res-3']) {
    expect(nameAddressRefusal(name, NONE), name).toBe('it reads as a number address');
  }
  expect(nameAddressAllowed('hr1-act', NONE)).toBe(true); // a number inside a longer name is fine
  expect(nameAddressAllowed('abc', NONE)).toBe(false); // under 4: a locale-sized word
  expect(nameAddressAllowed('abcd', NONE)).toBe(true);
  expect(nameAddressAllowed('a'.repeat(200), NONE)).toBe(true);
  expect(nameAddressAllowed('a'.repeat(201), NONE)).toBe(false);
  expect(nameAddressAllowed('1234', NONE)).toBe(false); // no letter
  expect(nameAddressAllowed('-act', NONE)).toBe(false);
  expect(nameAddressAllowed('act--x', NONE)).toBe(false);
});

// --- never choosing between bills -----------------------------------------------

/** A small corpus in the tracked Congress, with real titles. */
const CORPUS: ShortAddressBill[] = [
  { bill_type: 's', bill_number: 5, congress_number: C },
  { bill_type: 'hr', bill_number: 4, congress_number: C },
  { bill_type: 'hr', bill_number: 22, congress_number: C },
  { bill_type: 's', bill_number: 128, congress_number: C },
  { bill_type: 'hr', bill_number: 1, congress_number: C },
];
const TITLES: ShortTitleFile = {
  [`s-5-${C}`]: { titles: ['Laken Riley Act'] },
  // Several short titles, two of which slug alike: one bill, three titles, two names.
  [`hr-4-${C}`]: { titles: ['Rescissions Act of 2025', 'RESCISSIONS ACT OF 2025', 'Second Name Act'] },
  [`hr-22-${C}`]: { titles: ['SAVE Act'] },
  [`s-128-${C}`]: { titles: ['SAVE Act'] },
  [`hr-1-${C}`]: { titles: ['One Big Beautiful Bill Act', 'Privacy', 'HR 1'] },
};
const tablesOf = (corpus = CORPUS, titles = TITLES, order = [C], reserved: ReadonlySet<string> = new Set(['privacy'])) =>
  decodeNameTables(encodeNameTables(corpus, titles, order, reserved));

test('a name resolves only when exactly one bill of the Congress carries it', () => {
  const names = namesOfCongress(CORPUS, TITLES, C, new Set(['privacy']));
  expect([...names.keys()].sort()).toEqual([
    'laken-riley-act',
    'one-big-beautiful-bill-act',
    'rescissions-act-of-2025',
    'save-act',
    'second-name-act',
  ]);
  expect([...names.get('save-act')!].sort()).toEqual(['hr22', 's128']);
  expect([...names.get('rescissions-act-of-2025')!]).toEqual(['hr4']); // two titles, one bill: unique
  const tables = tablesOf();
  const target = (p: string) => nameAddressTarget(p, LOCALES, 'en', tables);
  expect(target('/laken-riley-act')).toBe(`/bills/s-5-${C}`);
  expect(target('/rescissions-act-of-2025')).toBe(`/bills/hr-4-${C}`);
  expect(target('/second-name-act')).toBe(`/bills/hr-4-${C}`); // each short title resolves
  expect(target('/save-act')).toBeNull(); // shared: never chosen
  expect(target('/es/save-act')).toBeNull();
  expect(target('/privacy')).toBeNull(); // reserved: left out at build time
  expect(target('/hr-1')).toBeNull(); // a number-shaped title is never a name
});

test('the encoded table: sorted names, the bill after "=", nothing after it for a shared name', () => {
  expect(encodeNameTables(CORPUS, TITLES, [C], new Set(['privacy']))).toBe(
    `${C}@laken-riley-act=s5,one-big-beautiful-bill-act=hr1,rescissions-act-of-2025=hr4,save-act=,second-name-act=hr4`,
  );
  expect(encodeNameTables(CORPUS, {}, [C], NONE)).toBe('');
  expect(decodeNameTables('')).toEqual([]);
});

test('a malformed table or entry is skipped, never a throw, and never an open redirect', () => {
  for (const bad of [undefined, '', '|', '119', '119@', '@a=s5', 'x@abcd=s5', '0@abcd=s5', '119@=s5', '119@abcd=evil.com', '119@abcd=//evil', '119@ABCD=s5', '119@abcd=hr05', '119@abcd=hr1-119']) {
    const tables = decodeNameTables(bad);
    expect(nameAddressTarget('/abcd', LOCALES, 'en', tables), String(bad)).toBeNull();
  }
  const ok = decodeNameTables('119@abcd=s5,bad entry,efgh=,ijkl=hjres3|nope|118@abcd=hr9');
  expect(ok.map((t) => t.congress)).toEqual([119, 118]);
  expect(nameAddressTarget('/abcd', LOCALES, 'en', ok, )).toBe('/bills/s-5-119');
  expect(nameAddressTarget('/ijkl', LOCALES, 'en', ok)).toBe('/bills/hjres-3-119');
  expect(nameAddressTarget('/efgh', LOCALES, 'en', ok)).toBeNull();
});

// --- the redirect target ---------------------------------------------------------------

test('same shapes as number addresses: case-insensitive, a trailing slash, /en and /es, nothing else', () => {
  const tables = tablesOf();
  const target = (p: string) => nameAddressTarget(p, LOCALES, 'en', tables);
  expect(target('/laken-riley-act')).toBe(`/bills/s-5-${C}`);
  expect(target('/LAKEN-RILEY-ACT')).toBe(`/bills/s-5-${C}`);
  expect(target('/Laken-Riley-Act/')).toBe(`/bills/s-5-${C}`);
  expect(target('/en/laken-riley-act')).toBe(`/bills/s-5-${C}`);
  expect(target('/es/laken-riley-act')).toBe(`/es/bills/s-5-${C}`); // the name stays the record's English title
  expect(target('/ES/laken-riley-act')).toBeNull(); // a locale prefix is lower-case, as for number addresses
  for (const near of [
    '/laken-riley',
    '/laken-riley-act-of-2025',
    '/lakenrileyact',
    '/laken_riley_act',
    '/laken--riley-act',
    '/-laken-riley-act',
    '/laken%20riley%20act',
    '/laken-riley-act.html',
    '/laken-riley-act/extra',
    '/bills/laken-riley-act',
    '/es/es/laken-riley-act',
    '/fr/laken-riley-act',
    '/laken riley act',
    `/${'a'.repeat(5000)}`,
    '/',
    '',
  ]) {
    expect(target(near), near).toBeNull();
  }
  // The answer is always a bare bill path of this site.
  for (const p of ['/laken-riley-act', '/es/rescissions-act-of-2025', '/second-name-act']) {
    expect(target(p), p).toMatch(/^(\/es)?\/bills\/[a-z]+-\d+-\d+$/);
  }
});

// --- precedence: a real route, then a number address, then a name ----------------------

/** Every first segment a URL on this site can have, read independently of lib/route-segments.mjs. */
function routeNamesIndependently(): string[] {
  const names = new Set<string>();
  const add = (n: string) => {
    if (n.startsWith('[')) return; // a dynamic segment ([...rest]) is not a word a name could equal
    names.add(n.toLowerCase());
    names.add(n.replace(/\.[^.]+$/, '').toLowerCase());
  };
  for (const s of localeTopSegments()) add(s);
  for (const e of fs.readdirSync(LOCALE_DIR)) if (!e.startsWith('[')) add(e);
  for (const e of fs.readdirSync(APP_DIR)) if (!e.startsWith('[')) add(e);
  for (const locale of LOCALES) {
    add(locale);
    const dir = path.join(APP_DIR, locale);
    if (fs.existsSync(dir)) for (const e of fs.readdirSync(dir)) add(e);
  }
  for (const e of fs.readdirSync(path.join(process.cwd(), 'public'))) add(e);
  // The config redirects' sources (next.config.ts), read from the file.
  const config = fs.readFileSync(path.join(process.cwd(), 'next.config.ts'), 'utf8');
  for (const m of config.matchAll(/source: '\/(?:es\/)?([a-z][a-z0-9-]*)/g)) add(m[1]);
  return [...names].sort();
}

test('no name ever shadows a real route: every route segment, file and redirect source is reserved at build time', () => {
  const routes = routeNamesIndependently();
  for (const expected of ['bills', 'call', 'today', 'reps', 'questions', 'about', 'privacy', 'terms', 'api', 'embed', 'embeds', 'votes', 'feed', 'moments', 'impact', 'llms', 'robots', 'sitemap', 'en', 'es']) {
    expect(routes, expected).toContain(expected);
  }
  const reserved = reservedNames();
  const missing = routes.filter((r) => !reserved.has(r));
  expect(missing, 'a route segment the build does not reserve could be shadowed by a bill name').toEqual([]);
  // Every reserved word, and every real route, is refused as a name.
  for (const word of [...NAME_ADDRESS_RESERVED, ...routes]) expect(nameAddressAllowed(word, reserved), word).toBe(false);
});

test('a route added later with a bill name is harmless: the build that adds it reserves the name', () => {
  // A scratch tree with one new page named like a bill's short title.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oravan-routes-'));
  try {
    fs.mkdirSync(path.join(root, 'app', '[locale]', 'laken-riley-act'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', '[locale]', 'laken-riley-act', 'page.tsx'), '');
    fs.mkdirSync(path.join(root, 'app', '[locale]', '(group)', 'save-act'), { recursive: true });
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
    fs.writeFileSync(path.join(root, 'public', 'second-name-act.txt'), '');
    const segments = topRouteSegments(root);
    expect(segments).toEqual(expect.arrayContaining(['laken-riley-act', 'save-act', 'second-name-act', 'en', 'es']));
    const tables = tablesOf(CORPUS, TITLES, [C], new Set([...NAME_ADDRESS_RESERVED, ...segments]));
    expect(nameAddressTarget('/laken-riley-act', LOCALES, 'en', tables)).toBeNull();
    expect(nameAddressTarget('/second-name-act', LOCALES, 'en', tables)).toBeNull();
    expect(nameAddressTarget('/rescissions-act-of-2025', LOCALES, 'en', tables)).toBe(`/bills/hr-4-${C}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a number address always wins over a name, and a name never reads as a number', () => {
  // proxy.ts asks the number lookup first and the name lookup only on null
  // (pinned word for word in tests/short-address-privacy.unit.spec.ts). And
  // no name in a table can parse as a number address, so the order cannot
  // matter for a well-built table.
  const bills = billsJson as unknown as ShortAddressBill[];
  const index = decodeShortAddressIndex(encodeShortAddressIndex(bills, C));
  const fallback = decodeShortAddressFallback(encodeShortAddressFallback(bills));
  const both = (p: string, tables = tablesOf()) =>
    shortAddressTarget(p, LOCALES, 'en', index, fallback) ?? nameAddressTarget(p, LOCALES, 'en', tables);
  const anyHr = bills.find((b) => b.bill_type === 'hr' && b.congress_number === C);
  test.skip(!anyHr, 'no House bill of the tracked Congress');
  expect(both(`/hr${anyHr!.bill_number}`)).toBe(`/bills/hr-${anyHr!.bill_number}-${C}`);
  // A hand-made table naming "h-r-<n>" for another bill: /hr<n> still opens the number, and the
  // build would never write that name (it reads as a number address).
  const lookalike = decodeNameTables(`${C}@h-r-${anyHr!.bill_number}=s5`);
  expect(both(`/hr${anyHr!.bill_number}`, lookalike)).toBe(`/bills/hr-${anyHr!.bill_number}-${C}`);
  expect(nameAddressAllowed(`h-r-${anyHr!.bill_number}`, NONE)).toBe(false);
  // Even a hand-made table naming "hr<n>" for another bill cannot win.
  const rigged = decodeNameTables(`${C}@hr${anyHr!.bill_number}=s5`);
  expect(both(`/hr${anyHr!.bill_number}`, rigged)).toBe(`/bills/hr-${anyHr!.bill_number}-${C}`);
});

// --- the January rule ---------------------------------------------------------------

const SWITCHED: ShortAddressPolicy = { tracked: 120, ended: [{ number: 119, ended: congressTerm(119).end }] };

test('after the switch: the tracked Congress first, then each ended one, the uniqueness test within each', () => {
  const corpus: ShortAddressBill[] = [
    { bill_type: 's', bill_number: 5, congress_number: 119 },
    { bill_type: 'hr', bill_number: 4, congress_number: 119 },
    { bill_type: 'hr', bill_number: 7, congress_number: 120 },
    { bill_type: 'hr', bill_number: 22, congress_number: 119 },
    { bill_type: 's', bill_number: 128, congress_number: 119 },
    { bill_type: 'hr', bill_number: 9, congress_number: 120 },
    { bill_type: 's', bill_number: 9, congress_number: 120 },
    { bill_type: 'hr', bill_number: 30, congress_number: 119 },
    { bill_type: 'hr', bill_number: 31, congress_number: 120 },
    { bill_type: 's', bill_number: 31, congress_number: 119 },
    { bill_type: 'hr', bill_number: 32, congress_number: 119 },
  ];
  const titles: ShortTitleFile = {
    's-5-119': { titles: ['Laken Riley Act'] }, // only in the ended Congress
    'hr-4-119': { titles: ['Rescissions Act'] }, // in both: the new one wins
    'hr-7-120': { titles: ['Rescissions Act'] },
    'hr-22-119': { titles: ['SAVE Act'] }, // shared in the ended one only
    's-128-119': { titles: ['SAVE Act'] },
    'hr-9-120': { titles: ['Twin Act'] }, // shared in the new one; unique in the ended one
    's-9-120': { titles: ['Twin Act'] },
    'hr-30-119': { titles: ['Twin Act'] },
    'hr-31-120': { titles: ['Carry Act'] }, // unique in the new one, shared in the ended one
    's-31-119': { titles: ['Carry Act'] },
    'hr-32-119': { titles: ['Carry Act'] },
  };
  const order = [SWITCHED.tracked, ...shortAddressFallbackCongresses(corpus, SWITCHED)];
  expect(order).toEqual([120, 119]);
  const tables = decodeNameTables(encodeNameTables(corpus, titles, order, NONE));
  const target = (p: string) => nameAddressTarget(p, LOCALES, 'en', tables);
  expect(target('/laken-riley-act')).toBe('/bills/s-5-119');
  expect(target('/es/laken-riley-act')).toBe('/es/bills/s-5-119');
  expect(target('/rescissions-act')).toBe('/bills/hr-7-120');
  expect(target('/save-act')).toBeNull();
  // Shared in the Congress searched first: the not-found, never the older bill.
  expect(target('/twin-act')).toBeNull();
  expect(target('/carry-act')).toBe('/bills/hr-31-120');
  expect(target('/nothing-act')).toBeNull();
  // Switch day, before the new Congress has any bill: every ended name answers from the 119th.
  const old = corpus.filter((b) => b.congress_number === 119);
  const day1 = decodeNameTables(encodeNameTables(old, titles, [120, ...shortAddressFallbackCongresses(old, SWITCHED)], NONE));
  expect(day1.map((t) => t.congress)).toEqual([119]);
  expect(nameAddressTarget('/rescissions-act', LOCALES, 'en', day1)).toBe('/bills/hr-4-119');
  expect(nameAddressTarget('/twin-act', LOCALES, 'en', day1)).toBe('/bills/hr-30-119');
});

// --- the committed corpus ------------------------------------------------------------------

test('the committed state: the table is built from data/short-titles.json alone, and every name it holds is a record short title of its bill', () => {
  const bills = billsJson as unknown as ShortAddressBill[];
  const titles = readShortTitles();
  const encoded = nameTablesForBuild(bills);
  if (Object.keys(titles).length === 0) {
    // Before the nightly first fills the file: no table, so no name resolves
    // and every request behaves exactly as before names existed.
    expect(encoded).toBe('');
    return;
  }
  const tables = decodeNameTables(encoded);
  expect(tables.length).toBeGreaterThan(0);
  const reserved = reservedNames();
  let checked = 0;
  for (const table of tables) {
    for (const [name, address] of table.names) {
      expect(nameAddressAllowed(name, reserved), name).toBe(true);
      everyLanguageAlike(name, tables);
      const carriers = bills.filter(
        (b) =>
          b.congress_number === table.congress &&
          (titles[`${b.bill_type}-${b.bill_number}-${b.congress_number}`]?.titles ?? []).some((t) => nameSlug(t) === name),
      );
      if (address === null) expect(carriers.length, name).toBeGreaterThan(1);
      else {
        expect(carriers.map((b) => `${b.bill_type}${b.bill_number}`), name).toEqual([`${address.type}${address.number}`]);
        checked++;
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
  // Small enough for the proxy bundle: see the size note in the pull request.
  expect(encoded.length).toBeLessThan(400_000);
});

/*
 * Real short titles from the record that exercise the rule's edges (straight
 * and curly apostrophes, an ampersand, accents, an em dash, curly quotes,
 * parentheses, periods, a comma before a year, the longest title in the
 * corpus at 163 characters), copied from a read-only scratch read of
 * Congress.gov's titles lists on 2026-11-14 (written with \u escapes so the
 * exact characters survive any editor), with the address worked out by hand.
 */
const REAL_TITLE_CASES: Array<[string, string, string]> = [
  ['hr-1564-119', "Ethan's Law", 'ethans-law'],
  ['hr-1114-119', 'L\u2019Ouverture Economic Development Plan for Haiti Act of 2025', 'louverture-economic-development-plan-for-haiti-act-of-2025'],
  ['hr-3276-119', 'Local Communities & Bird Habitat Stewardship Act of 2025', 'local-communities-bird-habitat-stewardship-act-of-2025'],
  ['s-2298-119', 'Asunci\u00f3n Valdivia Heat Illness, Injury, and Fatality Prevention Act of 2025', 'asuncion-valdivia-heat-illness-injury-and-fatality-prevention-act-of-2025'],
  ['hr-3709-119', 'Advancing the Mentor-Prot\u00e9g\u00e9 Program for Small Financial Institutions Act', 'advancing-the-mentor-protege-program-for-small-financial-institutions-act'],
  ['hr-4566-119', 'Washington\u2019s Trail\u20141753 National Historic Trail Feasibility Study Act of 2025', 'washingtons-trail-1753-national-historic-trail-feasibility-study-act-of-2025'],
  ['hr-3692-119', 'Captain Accursio \u201cGus\u201d Sanfilippo Young Fishermen\u2019s Development Act', 'captain-accursio-gus-sanfilippo-young-fishermens-development-act'],
  ['hr-1804-119', '7(a) Loan Agent Oversight Act', '7-a-loan-agent-oversight-act'],
  ['hr-9770-119', 'Continuing Appropriations Act, 2027', 'continuing-appropriations-act-2027'],
  ['hr-10817-119', 'U.S.S. Doris Miller Act of 2026', 'u-s-s-doris-miller-act-of-2026'],
  ['hr-1548-119', 'Leveling the Playing Field 2.0 Act', 'leveling-the-playing-field-2-0-act'],
  [
    'hr-4598-119',
    'Technical Corrections to the Northwestern New Mexico Rural Water Projects Act, Taos Pueblo Indian Water Rights Settlement Act, and Aamodt Litigation Settlement Act',
    'technical-corrections-to-the-northwestern-new-mexico-rural-water-projects-act-taos-pueblo-indian-water-rights-settlement-act-and-aamodt-litigation-settlement-act',
  ],
];
