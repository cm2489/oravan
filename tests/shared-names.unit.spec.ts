import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { congressTerm } from '../lib/congress.mjs';
import { getAllBills } from '../lib/core';
import { shareAddress, type ShareTables } from '../lib/share-address';
import { inSharedNameOrder, sharedNamePages, sharedNamePagesFrom, sharedNamePath, SHARED_NAME_TYPE_ORDER } from '../lib/shared-names';
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
 * THE PAGE FOR A SHARED NAME (draft #510; the owner's card 193, Nov 14, 2026,
 * 9:13 PM ET: "Build the small page for shared names, so a name never
 * breaks. Then Share copies the name, or the number when a bill has no short
 * title."). Which pages exist, in what order, how the proxy reaches them, what
 * happens when names change, and what Share hands out. Pure Node.
 */

const LOCALES = ['en', 'es'];
const NONE: ReadonlySet<string> = new Set();
const TODAY: ShortAddressPolicy = { tracked: 119, ended: [] };
const SWITCHED: ShortAddressPolicy = { tracked: 120, ended: [{ number: 119, ended: congressTerm(119).end }] };

function world(corpus: ShortAddressBill[], titles: ShortTitleFile, policy: ShortAddressPolicy = TODAY) {
  const order = [policy.tracked, ...shortAddressFallbackCongresses(corpus, policy)];
  const encoded = encodeNameTables(corpus, titles, order, NONE);
  const names = decodeNameTables(encoded);
  const pages = sharedNamePagesFrom(corpus, titles, order, NONE, encoded);
  const tables: ShareTables = {
    index: decodeShortAddressIndex(encodeShortAddressIndex(corpus, policy.tracked)),
    fallback: decodeShortAddressFallback(encodeShortAddressFallback(corpus, policy)),
    names,
    titles,
    congress: policy.tracked,
  };
  return { pages, target: (p: string) => nameAddressTarget(p, LOCALES, 'en', names), tables };
}

const b = (type: string, number: number, congress = 119): ShortAddressBill => ({ bill_type: type, bill_number: number, congress_number: congress });

test('one page per shared name, listing every bill that makes it, in the stated order', () => {
  // The card's own example: the Laken Riley Act, S. 5 and H.R. 29 (real titles of the record, read 2026-11-14).
  const corpus = [b('s', 5), b('hr', 29), b('hr', 9770), b('sjres', 99), b('s', 3), b('hconres', 4), b('hres', 2)];
  const titles: ShortTitleFile = {
    'hr-29-119': { titles: ['Laken Riley Act'] },
    's-5-119': { titles: ['Laken Riley Act'] },
    'hr-9770-119': { titles: ['Continuing Appropriations Act, 2027'] },
    'sjres-99-119': { titles: [] },
    's-3-119': { titles: ['SAFE Act'] },
    'hconres-4-119': { titles: ['Safe Act'] },
    'hres-2-119': { titles: ['SAFE Act'] },
  };
  const { pages, target } = world(corpus, titles);
  expect(pages.map((p) => [p.congress, p.name, p.bills.map((x) => x.slug)])).toEqual([
    [119, 'laken-riley-act', ['hr-29-119', 's-5-119']],
    [119, 'safe-act', ['hconres-4-119', 'hres-2-119', 's-3-119']],
  ]);
  // Each bill keeps its own spelling, as the record writes it.
  expect(pages[1].bills.map((x) => x.titles)).toEqual([['Safe Act'], ['SAFE Act'], ['SAFE Act']]);
  expect(pages[0].bills.map((x) => x.chamber)).toEqual(['house', 'senate']);
  // The proxy sends the name to exactly that page, in both languages, and a unique name to its bill.
  expect(target('/laken-riley-act')).toBe('/names/119/laken-riley-act');
  expect(target('/es/Laken-Riley-Act')).toBe('/es/names/119/laken-riley-act');
  expect(target('/continuing-appropriations-act-2027')).toBe('/bills/hr-9770-119');
  expect(sharedNamePath(119, 'laken-riley-act')).toBe('/names/119/laken-riley-act');
});

test('the order is mechanical: House types then Senate types, as Congress numbers them, then by number', () => {
  expect([...SHARED_NAME_TYPE_ORDER]).toEqual(['hr', 'hjres', 'hconres', 'hres', 's', 'sjres', 'sconres', 'sres']);
  const shuffled = [
    { type: 'sres' as const, number: 1 },
    { type: 's' as const, number: 900 },
    { type: 'hr' as const, number: 30 },
    { type: 's' as const, number: 12 },
    { type: 'hjres' as const, number: 2 },
    { type: 'hr' as const, number: 4 },
  ];
  expect(inSharedNameOrder(shuffled).map((x) => `${x.type}${x.number}`)).toEqual(['hr4', 'hr30', 'hjres2', 's12', 's900', 'sres1']);
});

test('the January rule: the tracked Congress first; a name shared there lists THAT Congress, never an older bill', () => {
  const corpus = [b('hr', 9, 120), b('s', 9, 120), b('hr', 30, 119), b('hr', 22, 119), b('s', 128, 119), b('hr', 31, 120), b('s', 31, 119), b('hr', 32, 119)];
  const titles: ShortTitleFile = {
    'hr-9-120': { titles: ['Twin Act'] }, // shared in the 120th, unique in the 119th
    's-9-120': { titles: ['Twin Act'] },
    'hr-30-119': { titles: ['Twin Act'] },
    'hr-22-119': { titles: ['SAVE Act'] }, // shared in the 119th only
    's-128-119': { titles: ['SAVE Act'] },
    'hr-31-120': { titles: ['Carry Act'] }, // unique in the 120th, shared in the 119th
    's-31-119': { titles: ['Carry Act'] },
    'hr-32-119': { titles: ['Carry Act'] },
  };
  const { pages, target } = world(corpus, titles, SWITCHED);
  expect(pages.map((p) => `${p.congress}/${p.name}`)).toEqual(['120/twin-act', '119/save-act']);
  expect(target('/twin-act')).toBe('/names/120/twin-act');
  expect(target('/save-act')).toBe('/names/119/save-act');
  expect(target('/carry-act')).toBe('/bills/hr-31-120'); // and no page for the 119th's shared "carry-act": unreachable
});

test('when names change: unique becomes shared lands on the page; shared becomes unique lands on the bill; gone is the not-found', () => {
  const two = [b('s', 5), b('hr', 29)];
  const before = world(two, { 's-5-119': { titles: ['Laken Riley Act'] }, 'hr-29-119': { titles: [] } });
  expect(before.target('/laken-riley-act')).toBe('/bills/s-5-119');
  expect(before.pages).toEqual([]);
  // A twin enters with the same short title: the same address now lists both, no longer a 404.
  const twin = world(two, { 's-5-119': { titles: ['Laken Riley Act'] }, 'hr-29-119': { titles: ['Laken Riley Act'] } });
  expect(twin.target('/laken-riley-act')).toBe('/names/119/laken-riley-act');
  expect(twin.pages.map((p) => p.name)).toEqual(['laken-riley-act']);
  // The record drops one bill's title: unique again, back to the bill; the page is gone.
  const back = world(two, { 's-5-119': { titles: [] }, 'hr-29-119': { titles: ['Laken Riley Act'] } });
  expect(back.target('/laken-riley-act')).toBe('/bills/hr-29-119');
  expect(back.pages).toEqual([]);
  // No bill carries it any more: the normal not-found.
  const gone = world(two, { 's-5-119': { titles: [] }, 'hr-29-119': { titles: [] } });
  expect(gone.target('/laken-riley-act')).toBeNull();
});

test('Share: its own name; no short title, the number; a SHARED name, the number (the session’s reading)', () => {
  const corpus = [b('hr', 9770), b('sjres', 99), b('s', 5), b('hr', 29)];
  const titles: ShortTitleFile = {
    'hr-9770-119': { titles: ['Continuing Appropriations Act, 2027'] },
    'sjres-99-119': { titles: [] },
    's-5-119': { titles: ['Laken Riley Act'] },
    'hr-29-119': { titles: ['Laken Riley Act'] },
  };
  const { tables } = world(corpus, titles);
  expect(shareAddress(corpus[0], 'en', tables)).toBe('https://oravan.org/continuing-appropriations-act-2027');
  expect(shareAddress(corpus[1], 'en', tables)).toBe('https://oravan.org/sjres99');
  // The name would land on the list page, where the reader might pick the other bill:
  expect(shareAddress(corpus[2], 'en', tables)).toBe('https://oravan.org/s5');
  expect(shareAddress(corpus[3], 'es', tables)).toBe('https://oravan.org/es/hr29');
});

test('the committed state: no titles file, so no page; the page reads its strings on the server only', () => {
  const titlesFile = join(process.cwd(), 'data/short-titles.json');
  const hasTitles = (() => {
    try {
      readFileSync(titlesFile);
      return true;
    } catch {
      return false;
    }
  })();
  test.skip(hasTitles, 'data/short-titles.json exists: the build test in tests/static-rendering.spec.ts counts the pages');
  expect(sharedNamePages(getAllBills())).toEqual([]);
  expect(Object.keys(en.namesPage).sort()).toEqual(Object.keys(es.namesPage).sort());
  const page = readFileSync(join(process.cwd(), 'app/[locale]/names/[congress]/[name]/page.tsx'), 'utf8');
  expect(page).toContain('export const dynamicParams = false;');
  expect(page).toContain('robots: { index: false');
  expect(page).not.toMatch(/ActionPanel|CallPrompt|call-button|RepsLookup|CoverageSection|ZipForm/);
});
