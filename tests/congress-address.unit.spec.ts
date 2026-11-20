import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { congressTerm } from '../lib/congress.mjs';
import { shareAddress, shortSharePath, type ShareTables } from '../lib/share-address';
import { sharedNamePagesFrom, sharedNamePath } from '../lib/shared-names';
import {
  congressAddressPath,
  decodeNameTables,
  decodeShortAddressFallback,
  decodeShortAddressIndex,
  encodeNameTables,
  encodeShortAddressFallback,
  encodeShortAddressIndex,
  NAME_ADDRESS_RESERVED,
  nameAddressRefusal,
  nameAddressTarget,
  nameSlug,
  parseCongressAddress,
  shortAddressFallbackCongresses,
  shortAddressTarget,
  type ShortAddressBill,
  type ShortAddressPolicy,
  type ShortTitleFile,
} from '../lib/short-address';
import { gateNameTables, reservedNames } from '../lib/short-address-build';
import { topRouteSegments } from '../lib/route-segments.mjs';

/*
 * THE ADDRESS THAT CARRIES ITS CONGRESS (the owner's card 196, Nov 19, 2026,
 * 12:50 PM ET: "Build a short address that carries the Congress and never
 * changes, and have Share copy that."). oravan.org/hr1109-119 opens H.R. 1109
 * of the 119th Congress, today and after the change of Congress.
 *
 * Fixtures only: the 3,335 bills and the 300-entry titles file as committed on
 * main on Nov 17, 2026 (tests/fixtures/first-fill-2026-11-17/). The change of
 * Congress is an injected policy, never the real clock.
 */

const FIX = path.join(process.cwd(), 'tests/fixtures/first-fill-2026-11-17');
const BILLS = JSON.parse(fs.readFileSync(path.join(FIX, 'bills.json'), 'utf8')) as Array<ShortAddressBill & { title?: string }>;
const TITLES = JSON.parse(fs.readFileSync(path.join(FIX, 'short-titles.json'), 'utf8')) as ShortTitleFile;
const LOCALES = ['en', 'es'];
const TYPES = ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres'] as const;
const TODAY: ShortAddressPolicy = { tracked: 119, ended: [] };
const SWITCHED: ShortAddressPolicy = { tracked: 120, ended: [{ number: 119, ended: congressTerm(119).end }] };
const slugOf = (b: ShortAddressBill) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`;

/** The proxy's lookups, built exactly as next.config.ts builds them, for a corpus and a policy. */
function proxyFor(corpus: ShortAddressBill[], policy: ShortAddressPolicy, names = '') {
  const index = decodeShortAddressIndex(encodeShortAddressIndex(corpus, policy.tracked));
  const fallback = decodeShortAddressFallback(encodeShortAddressFallback(corpus, policy));
  const tables = decodeNameTables(names);
  const target = (p: string) => shortAddressTarget(p, LOCALES, 'en', index, fallback, policy.tracked) ?? nameAddressTarget(p, LOCALES, 'en', tables);
  const share: ShareTables = { index, fallback, names: tables, titles: names ? TITLES : {}, congress: policy.tracked };
  return { target, share };
}

test('the form: every bill type, any letter case, an optional hyphen; anything else is not this address', () => {
  for (const type of TYPES) {
    for (const s of [`${type}1109-119`, `${type.toUpperCase()}1109-119`, `${type}-1109-119`, `${type[0].toUpperCase()}${type.slice(1)}-1109-119`]) {
      expect(parseCongressAddress(s), s).toEqual({ type, number: 1109, congress: 119 });
    }
  }
  for (const bad of ['hr01109-119', 'hr1109-0119', 'hr1109-', 'hr1109--119', 'hr 1109-119', 'hr1109-119-1', 'hr1109.119', 'hr1109-12345', 'hr123456-119', 'x1109-119', 'hr1109_119', 'hr1109']) {
    expect(parseCongressAddress(bad), bad).toBeNull();
  }
});

test('the path is always lower case, whatever case the record gives the type', () => {
  expect(congressAddressPath({ bill_type: 'HR', bill_number: 1109, congress_number: 119 })).toBe('/hr1109-119');
  expect(congressAddressPath({ bill_type: 'SJRes', bill_number: 99, congress_number: 119 })).toBe('/sjres99-119');
});

test('Share never hands out an address that does not open: a bill of a Congress with no table shares its full /bills/ address', () => {
  // A 118th bill the corpus holds but no policy names (no table for its Congress): its Congress-carrying address
  // would be the not-found, so Share falls back to the permanent page address.
  const b118 = { bill_type: 'hr', bill_number: 1, congress_number: 118 };
  const { target, share } = proxyFor([...BILLS, b118], TODAY);
  expect(target(congressAddressPath(b118))).toBeNull();
  expect(shareAddress(b118, 'en', share)).toBe('https://oravan.org/bills/hr-1-118');
  expect(shareAddress(b118, 'es', share)).toBe('https://oravan.org/es/bills/hr-1-118');
});

test('every bill of the corpus opens by its Congress-carrying address, in every typed variant and both languages', () => {
  const { target } = proxyFor(BILLS, TODAY);
  let checked = 0;
  for (const b of BILLS) {
    const p = congressAddressPath(b);
    const to = `/bills/${slugOf(b)}`;
    const hyphen = `/${b.bill_type}-${b.bill_number}-${b.congress_number}`;
    for (const [from, want] of [
      [p, to],
      [`${p}/`, to],
      [p.toUpperCase(), to],
      [hyphen, to],
      [`/en${p}`, to],
      [`/es${p}`, `/es${to}`],
      [`/es${hyphen.toUpperCase()}`, `/es${to}`],
    ] as const) {
      expect(target(from), from).toBe(want);
      checked++;
    }
  }
  expect(BILLS).toHaveLength(3335);
  expect(checked).toBe(3335 * 7);
});

test('a bill the corpus does not hold, and a Congress it holds no table for (past or future), is the normal not-found, never a guess', () => {
  const { target } = proxyFor(BILLS, TODAY);
  const held = new Set(BILLS.map(slugOf));
  let missing = 1;
  while (held.has(`hr-${missing}-119`)) missing++;
  expect(target(`/hr${missing}-119`)).toBeNull();
  expect(target(`/hr${missing}`)).toBeNull();
  const some = BILLS[0];
  expect(target(`/${some.bill_type}${some.bill_number}-120`)).toBeNull(); // a future Congress
  expect(target(`/${some.bill_type}${some.bill_number}-118`)).toBeNull(); // a Congress the corpus does not hold
  expect(target(`/${some.bill_type}${some.bill_number}-9999`)).toBeNull();
});

test('after Jan 3, 2027 (the change of Congress, injected): /hr1109-119 still opens the 119th’s bill while /hr1109 opens the 120th’s', () => {
  const b119 = BILLS.find((b) => b.bill_type === 'hr')!;
  const b120 = { bill_type: 'hr', bill_number: b119.bill_number, congress_number: 120 };
  const corpus = [...BILLS, b120];
  const before = proxyFor(BILLS, TODAY);
  const after = proxyFor(corpus, SWITCHED);
  const carried = congressAddressPath(b119);
  // Today: both forms open the 119th's bill.
  expect(before.target(carried)).toBe(`/bills/${slugOf(b119)}`);
  expect(before.target(`/hr${b119.bill_number}`)).toBe(`/bills/${slugOf(b119)}`);
  // After the change of Congress: the bare number moves to the 120th; the Congress-carrying address does not.
  expect(after.target(`/hr${b119.bill_number}`)).toBe(`/bills/hr-${b119.bill_number}-120`);
  expect(after.target(carried)).toBe(`/bills/${slugOf(b119)}`);
  expect(after.target(`/es${carried}`)).toBe(`/es/bills/${slugOf(b119)}`);
  expect(after.target(`/hr${b119.bill_number}-120`)).toBe(`/bills/hr-${b119.bill_number}-120`);
  expect(after.target(`/hr${b119.bill_number}-121`)).toBeNull();
  // Every 119th bill keeps its address after the change.
  let same = 0;
  for (const b of BILLS) {
    expect(after.target(congressAddressPath(b)), slugOf(b)).toBe(before.target(congressAddressPath(b)));
    same++;
  }
  expect(same).toBe(3335);
  expect(shortAddressFallbackCongresses(corpus, SWITCHED)).toEqual([119]);
});

test('it can never collide: no route, language prefix or public file has its shape, and no name can take it', () => {
  const routes = topRouteSegments(process.cwd());
  expect(routes.length).toBeGreaterThan(5);
  for (const r of [...routes, ...LOCALES, ...NAME_ADDRESS_RESERVED]) expect(parseCongressAddress(r), r).toBeNull();
  for (const entry of fs.readdirSync(path.join(process.cwd(), 'public'))) expect(parseCongressAddress(entry), entry).toBeNull();
  // A name of this shape is refused for every type, whatever a future short title makes.
  const reserved = reservedNames(process.cwd());
  for (const type of TYPES) {
    for (const n of [`${type}1109-119`, `${type}-1109-119`]) expect(nameAddressRefusal(n, reserved), n).toBe('it reads as a number address with its Congress');
    // (hr1-120 read without its hyphens is the bare number hr1120, which the older rule refuses first.)
    expect(nameAddressRefusal(`${type}1-120`, reserved)).toMatch(/^it reads as a number address/);
  }
  // Every name today's stored short titles make, and every name a bill's stored title would make (the
  // names the fill can bring), is never of this shape.
  let names = 0;
  for (const entry of Object.values(TITLES)) {
    for (const t of entry.titles) {
      const n = nameSlug(t);
      if (n) {
        expect(parseCongressAddress(n), n).toBeNull();
        names++;
      }
    }
  }
  for (const b of BILLS) {
    const n = b.title ? nameSlug(b.title) : null;
    if (n) {
      expect(parseCongressAddress(n), n).toBeNull();
      names++;
    }
  }
  expect(names).toBeGreaterThan(1000);
});

test('Share over every bill, both languages: every address it hands out resolves to that bill, while names are off and once they are on', () => {
  // Today: the fill gate keeps every name off (300 of 3,335 read), so every bill shares the Congress-carrying address.
  const order = [TODAY.tracked];
  const reserved = new Set(NAME_ADDRESS_RESERVED);
  const gated = gateNameTables(encodeNameTables(BILLS, TITLES, order, reserved), BILLS, TITLES, {}, order, reserved);
  expect(gated.encoded).toBe('');
  const off = proxyFor(BILLS, TODAY, gated.encoded);
  let resolved = 0;
  for (const b of BILLS) {
    for (const locale of LOCALES) {
      const url = shareAddress(b, locale, off.share);
      const prefix = locale === 'en' ? '' : `/${locale}`;
      expect(url, slugOf(b)).toBe(`https://oravan.org${prefix}${congressAddressPath(b)}`);
      expect(off.target(new URL(url).pathname), url).toBe(`${prefix}/bills/${slugOf(b)}`);
      resolved++;
    }
  }
  expect(resolved).toBe(3335 * 2);
  // The day names switch on (simulated: the 300 bills read form the table): a bill with a name shares the name,
  // which opens it (or its shared page); every other bill still shares the Congress-carrying address.
  const on = proxyFor(BILLS, TODAY, encodeNameTables(BILLS, TITLES, order, reserved));
  let named = 0;
  let carried = 0;
  for (const b of BILLS) {
    const p = shortSharePath(b, on.share)!;
    const to = on.target(p);
    if (p === congressAddressPath(b)) {
      carried++;
      expect(to, p).toBe(`/bills/${slugOf(b)}`);
    } else {
      named++;
      expect(to === `/bills/${slugOf(b)}` || /^\/names\/119\/[a-z0-9-]+$/.test(to ?? ''), `${slugOf(b)} ${p} -> ${to}`).toBe(true);
    }
  }
  expect(named).toBeGreaterThan(100);
  expect(named + carried).toBe(3335);
  test.info().annotations.push({ type: 'share once names are on (simulated)', description: `${named} by name, ${carried} by the Congress-carrying address` });
});

test('Share over every bill of TODAY’s committed corpus, both languages: names as the build has them, and simulated on (every unread bill tried); every address opens that bill or a list page that lists it', () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/bills.json'), 'utf8')) as Array<ShortAddressBill & { title?: string }>;
  const titlesPath = path.join(process.cwd(), 'data/short-titles.json');
  const titles = (fs.existsSync(titlesPath) ? JSON.parse(fs.readFileSync(titlesPath, 'utf8')) : {}) as ShortTitleFile;
  const order = [TODAY.tracked];
  const reserved = reservedNames(process.cwd());
  const counts: Record<string, number> = {};
  for (const [label, retry] of [
    ['as built', {} as Record<string, unknown>],
    ['simulated on', Object.fromEntries(corpus.filter((b) => !titles[slugOf(b)]).map((b) => [slugOf(b), { failures: 1 }]))],
  ] as const) {
    const gated = gateNameTables(encodeNameTables(corpus, titles, order, reserved), corpus, titles, retry, order, reserved);
    const index = decodeShortAddressIndex(encodeShortAddressIndex(corpus, TODAY.tracked));
    const fallback = decodeShortAddressFallback(encodeShortAddressFallback(corpus, TODAY));
    const names = decodeNameTables(gated.encoded);
    const share: ShareTables = { index, fallback, names, titles, congress: TODAY.tracked };
    const pages = new Map(sharedNamePagesFrom(corpus, titles, order, reserved, gated.encoded).map((p) => [sharedNamePath(p.congress, p.name), p]));
    for (const b of corpus) {
      for (const locale of LOCALES) {
        const prefix = locale === 'en' ? '' : `/${locale}`;
        const p = new URL(shareAddress(b, locale, share)).pathname;
        const to = shortAddressTarget(p, LOCALES, 'en', index, fallback, TODAY.tracked) ?? nameAddressTarget(p, LOCALES, 'en', names);
        const key = `${label}: ${p.startsWith(`${prefix}/bills/`) ? 'full' : parseCongressAddress(p.replace(/^\/es/, '').slice(1)) ? 'congress' : to?.includes('/names/') ? 'shared name' : 'name'}`;
        counts[key] = (counts[key] ?? 0) + 1;
        if (p.startsWith(`${prefix}/bills/`)) continue; // only when no short address opens it
        if (to?.startsWith(`${prefix}/names/`)) {
          const page = pages.get(to.slice(prefix.length));
          expect(page?.bills.some((x) => x.slug === slugOf(b)), `${slugOf(b)} ${p} -> ${to}`).toBe(true);
        } else {
          expect(to, `${slugOf(b)} ${p}`).toBe(`${prefix}/bills/${slugOf(b)}`);
        }
      }
    }
  }
  expect(counts['as built: full'] ?? 0).toBe(0);
  test.info().annotations.push({ type: 'today’s corpus', description: `${corpus.length} bills; ${JSON.stringify(counts)}` });
});
