import { expect, test } from '@playwright/test';
import { congressTerm } from '../lib/congress.mjs';
import { shareAddress, shortSharePath, type ShareTables } from '../lib/share-address';
import { sharedNamePagesFrom } from '../lib/shared-names';
import {
  decodeNameTables,
  decodeShortAddressFallback,
  decodeShortAddressIndex,
  encodeNameTables,
  encodeShortAddressFallback,
  encodeShortAddressIndex,
  nameAddressTarget,
  shortAddressFallbackCongresses,
  type ShortAddressBill,
  type ShortAddressPolicy,
  type ShortTitleFile,
} from '../lib/short-address';

/*
 * The link the share panel hands out (DRAFT, waits for the owner;
 * lib/share-address.ts): a record short title's name when this bill alone
 * carries it; else a name it shares, which opens the page listing it (the
 * owner's `share` = b, Nov 15, 2026); else the number; else the full address.
 * Fixtures shaped like the corpus, with real short titles of the record (read
 * 2026-11-14). No live data and no clock: every input is in this file.
 */

const tablesOf = (corpus: ShortAddressBill[], titles: ShortTitleFile, policy: ShortAddressPolicy): ShareTables => ({
  index: decodeShortAddressIndex(encodeShortAddressIndex(corpus, policy.tracked)),
  fallback: decodeShortAddressFallback(encodeShortAddressFallback(corpus, policy)),
  names: decodeNameTables(encodeNameTables(corpus, titles, [policy.tracked, ...shortAddressFallbackCongresses(corpus, policy)], new Set())),
  titles,
  congress: policy.tracked,
});

const TODAY: ShortAddressPolicy = { tracked: 119, ended: [] };
const corpus: ShortAddressBill[] = [
  { bill_type: 'hr', bill_number: 9770, congress_number: 119 },
  { bill_type: 'hr', bill_number: 3633, congress_number: 119 },
  { bill_type: 's', bill_number: 5, congress_number: 119 },
  { bill_type: 'hr', bill_number: 29, congress_number: 119 },
  { bill_type: 'sjres', bill_number: 99, congress_number: 119 },
];
const titles: ShortTitleFile = {
  'hr-9770-119': { titles: ['Continuing Appropriations Act, 2027'] },
  'hr-3633-119': { titles: ['Anti-CBDC Surveillance State Act', 'CLARITY Act of 2025', 'Digital Asset Market Clarity Act', 'Digital Asset Market Clarity Act of 2025'] },
  's-5-119': { titles: ['Laken Riley Act'] },
  'hr-29-119': { titles: ['Laken Riley Act'] },
  'sjres-99-119': { titles: [] },
};

test('a name this bill alone carries; several: the shortest; both languages', () => {
  const t = tablesOf(corpus, titles, TODAY);
  expect(shareAddress(corpus[0], 'en', t)).toBe('https://oravan.org/continuing-appropriations-act-2027');
  expect(shareAddress(corpus[0], 'es', t)).toBe('https://oravan.org/es/continuing-appropriations-act-2027');
  // "anti-cbdc-surveillance-state-act" would be shared in the real corpus; here it is unique, and the shortest wins.
  expect(shortSharePath(corpus[1], t)).toBe('/clarity-act-of-2025');
});

test('a shared name: the name, which opens the page listing both bills; no short title: the number', () => {
  const t = tablesOf(corpus, titles, TODAY);
  expect(shareAddress(corpus[2], 'en', t)).toBe('https://oravan.org/laken-riley-act');
  expect(shareAddress(corpus[3], 'es', t)).toBe('https://oravan.org/es/laken-riley-act');
  expect(nameAddressTarget('/laken-riley-act', ['en', 'es'], 'en', t.names)).toBe('/names/119/laken-riley-act');
  expect(nameAddressTarget('/es/laken-riley-act', ['en', 'es'], 'en', t.names)).toBe('/es/names/119/laken-riley-act');
  expect(shareAddress(corpus[4], 'en', t)).toBe('https://oravan.org/sjres99-119'); // no short title: the address that carries its Congress
});

test('a bill with its own name AND a shared one shares its own name', () => {
  const both = { ...titles, 'hr-29-119': { titles: ['Laken Riley Act', 'Detain Act'] } };
  const t = tablesOf(corpus, both, TODAY);
  expect(shortSharePath(corpus[3], t)).toBe('/detain-act');
  expect(shortSharePath(corpus[2], t)).toBe('/laken-riley-act');
});

test('every shared name handed out opens a page that lists that very bill', () => {
  const policy = TODAY;
  const t = tablesOf(corpus, titles, policy);
  const pages = sharedNamePagesFrom(corpus, titles, [policy.tracked], new Set(), encodeNameTables(corpus, titles, [policy.tracked], new Set()));
  let checked = 0;
  for (const b of corpus) {
    const path = shortSharePath(b, t)!;
    const page = pages.find((p) => `/${p.name}` === path);
    if (!page) continue;
    checked++;
    expect(page.congress).toBe(b.congress_number);
    expect(page.bills.map((x) => x.slug)).toContain(`${b.bill_type}-${b.bill_number}-${b.congress_number}`);
  }
  expect(checked).toBe(2);
});

test('before the nightly fills the titles (and while names are off): every bill shares the address that carries its Congress', () => {
  const t = tablesOf(corpus, {}, TODAY);
  expect(corpus.map((b) => shareAddress(b, 'en', t))).toEqual([
    'https://oravan.org/hr9770-119',
    'https://oravan.org/hr3633-119',
    'https://oravan.org/s5-119',
    'https://oravan.org/hr29-119',
    'https://oravan.org/sjres99-119',
  ]);
});

test('after the switch: an ended bill whose name the new Congress took shares the address that carries its own Congress', () => {
  const switched: ShortAddressPolicy = { tracked: 120, ended: [{ number: 119, ended: congressTerm(119).end }] };
  const both = [...corpus, { bill_type: 'hr', bill_number: 9770, congress_number: 120 }];
  const t = tablesOf(both, { ...titles, 'hr-9770-120': { titles: ['Continuing Appropriations Act, 2027'] } }, switched);
  expect(shareAddress(corpus[0], 'en', t)).toBe('https://oravan.org/hr9770-119');
  expect(shareAddress(both[5], 'en', t)).toBe('https://oravan.org/continuing-appropriations-act-2027');
  // S. 5's name is still shared only in the 119th, so it opens the 119th's page listing S. 5 and H.R. 29.
  expect(shareAddress(corpus[2], 'es', t)).toBe('https://oravan.org/es/laken-riley-act');
  expect(nameAddressTarget('/es/laken-riley-act', ['en', 'es'], 'en', t.names)).toBe('/es/names/119/laken-riley-act');
  expect(shareAddress(corpus[4], 'es', t)).toBe('https://oravan.org/es/sjres99-119');
});

test('after the switch: a 119th bill whose SHARED name a 120th bill took never hands out that name', () => {
  const switched: ShortAddressPolicy = { tracked: 120, ended: [{ number: 119, ended: congressTerm(119).end }] };
  const both = [...corpus, { bill_type: 'hr', bill_number: 7, congress_number: 120 }];
  const t = tablesOf(both, { ...titles, 'hr-7-120': { titles: ['Laken Riley Act'] } }, switched);
  // The name now opens the 120th's H.R. 7, so the 119th's S. 5 and H.R. 29 share the addresses that carry their Congress.
  expect(nameAddressTarget('/laken-riley-act', ['en', 'es'], 'en', t.names)).toBe('/bills/hr-7-120');
  expect(shortSharePath(corpus[2], t)).toBe('/s5-119');
  expect(shareAddress(corpus[3], 'en', t)).toBe('https://oravan.org/hr29-119');
  expect(shortSharePath(both[5], t)).toBe('/laken-riley-act');
});

test('the address never carries a query, a stance or anything but the bill', () => {
  const t = tablesOf(corpus, titles, TODAY);
  for (const b of corpus) for (const l of ['en', 'es']) {
    expect(shareAddress(b, l, t)).toMatch(/^https:\/\/oravan\.org(?:\/es)?\/(?:[a-z0-9]+(?:-[a-z0-9]+)*|bills\/[a-z]+-\d+-\d+)$/);
  }
});
