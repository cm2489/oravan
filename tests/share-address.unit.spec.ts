import { expect, test } from '@playwright/test';
import { congressTerm } from '../lib/congress.mjs';
import { shareAddress, shortSharePath, type ShareTables } from '../lib/share-address';
import {
  decodeNameTables,
  decodeShortAddressFallback,
  decodeShortAddressIndex,
  encodeNameTables,
  encodeShortAddressFallback,
  encodeShortAddressIndex,
  shortAddressFallbackCongresses,
  type ShortAddressBill,
  type ShortAddressPolicy,
  type ShortTitleFile,
} from '../lib/short-address';

/*
 * The link the share panel hands out (DRAFT, waits for the owner;
 * lib/share-address.ts): a record short title's name when this bill alone
 * carries it, else the number, else the full address. Fixtures shaped like
 * the corpus, with real short titles of the record (read 2026-11-14).
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

test('a shared name or no short title: the number', () => {
  const t = tablesOf(corpus, titles, TODAY);
  expect(shareAddress(corpus[2], 'en', t)).toBe('https://oravan.org/s5');
  expect(shareAddress(corpus[3], 'es', t)).toBe('https://oravan.org/es/hr29');
  expect(shareAddress(corpus[4], 'en', t)).toBe('https://oravan.org/sjres99');
});

test('before the nightly fills the titles: every bill shares its number', () => {
  const t = tablesOf(corpus, {}, TODAY);
  expect(corpus.map((b) => shareAddress(b, 'en', t))).toEqual([
    'https://oravan.org/hr9770',
    'https://oravan.org/hr3633',
    'https://oravan.org/s5',
    'https://oravan.org/hr29',
    'https://oravan.org/sjres99',
  ]);
});

test('after the switch: an ended bill whose number and name the new Congress took shares its full address', () => {
  const switched: ShortAddressPolicy = { tracked: 120, ended: [{ number: 119, ended: congressTerm(119).end }] };
  const both = [...corpus, { bill_type: 'hr', bill_number: 9770, congress_number: 120 }];
  const t = tablesOf(both, { ...titles, 'hr-9770-120': { titles: ['Continuing Appropriations Act, 2027'] } }, switched);
  expect(shareAddress(corpus[0], 'en', t)).toBe('https://oravan.org/bills/hr-9770-119');
  expect(shareAddress(both[5], 'en', t)).toBe('https://oravan.org/continuing-appropriations-act-2027');
  expect(shareAddress(corpus[2], 'es', t)).toBe('https://oravan.org/es/s5'); // the 120th has no S. 5 yet
});

test('the address never carries a query, a stance or anything but the bill', () => {
  const t = tablesOf(corpus, titles, TODAY);
  for (const b of corpus) for (const l of ['en', 'es']) {
    expect(shareAddress(b, l, t)).toMatch(/^https:\/\/oravan\.org(?:\/es)?\/(?:[a-z0-9]+(?:-[a-z0-9]+)*|bills\/[a-z]+-\d+-\d+)$/);
  }
});
