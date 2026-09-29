import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import billsJson from '../data/bills.json';
import {
  decodeShortAddressIndex,
  encodeShortAddressIndex,
  indexHas,
  parseShortAddress,
  SHORT_ADDRESS_CONGRESS,
  SHORT_ADDRESS_ROLLOVER_RULING,
  SHORT_ADDRESS_TYPES,
  shortAddressTarget,
  type ShortAddressBill,
} from '../lib/short-address';
import { APP_DIR, localeTopSegments } from './routes';

/*
 * Short addresses for bills (lib/short-address.ts): /hr9340 opens that bill.
 * Pure Node — no server, no browser. tests/short-address.spec.ts proves the
 * same behaviour against a production build.
 */

const bills = billsJson as unknown as ShortAddressBill[];
const LOCALES = ['en', 'es'];
const INDEX = decodeShortAddressIndex(encodeShortAddressIndex(bills, SHORT_ADDRESS_CONGRESS));
const current = bills.filter((b) => b.congress_number === SHORT_ADDRESS_CONGRESS);

// --- the parser ---------------------------------------------------------------

test('parser: every bill type, with and without a hyphen, in any case', () => {
  const cases: Array<[string, string, number]> = [
    ['hr9340', 'hr', 9340],
    ['HR9340', 'hr', 9340],
    ['Hr9340', 'hr', 9340],
    ['hr-9340', 'hr', 9340],
    ['HR-9340', 'hr', 9340],
    ['s1234', 's', 1234],
    ['S-1234', 's', 1234],
    ['hjres12', 'hjres', 12],
    ['HJRES-12', 'hjres', 12],
    ['sjres12', 'sjres', 12],
    ['SJRes12', 'sjres', 12],
    ['hconres5', 'hconres', 5],
    ['HConRes-5', 'hconres', 5],
    ['sconres5', 'sconres', 5],
    ['hres10', 'hres', 10],
    ['HRes10', 'hres', 10],
    ['sres10', 'sres', 10],
    ['SRES-10', 'sres', 10],
    ['hr1', 'hr', 1],
    ['hr99999', 'hr', 99999],
  ];
  for (const [input, type, number] of cases) {
    expect(parseShortAddress(input), input).toEqual({ type, number });
  }
});

test('parser: the eight measure types Congress numbers, and no others', () => {
  expect([...SHORT_ADDRESS_TYPES].sort()).toEqual(['hconres', 'hjres', 'hr', 'hres', 's', 'sconres', 'sjres', 'sres']);
});

test('parser: rejects everything that is not exactly a type and a number', () => {
  for (const input of [
    '',
    'hr',
    's',
    '9340',
    'hr0',
    'hr09340', // a leading zero is not how a bill number is written
    'hr100000', // six digits: no Congress numbers that high
    'hr--9340',
    'hr_9340',
    'hr 9340',
    'h.r.9340',
    'hr9340x',
    'xhr9340',
    'hr-9340-119', // the canonical slug belongs to /bills/, not here
    'hr9340-119',
    'hamdt5', // amendments are not bills
    'samdt5',
    'pn1', // nominations are out of scope
    'bills',
    'about',
    'hr%2D9340',
    'hr-',
    '-9340',
  ]) {
    expect(parseShortAddress(input), input).toBeNull();
  }
});

test('the corpus holds only bill types the parser knows', () => {
  // A type outside the list would get no short address, silently.
  const types = new Set(bills.map((b) => b.bill_type));
  const unknown = [...types].filter((t) => !(SHORT_ADDRESS_TYPES as readonly string[]).includes(t));
  expect(unknown).toEqual([]);
});

// --- the build-time index ------------------------------------------------------

test('index: every bill of the current Congress resolves, and nothing else does', () => {
  expect(current.length).toBeGreaterThan(1000);
  const missing = current.filter((b) => !indexHas(INDEX, { type: b.bill_type as never, number: b.bill_number }));
  expect(missing.map((b) => `${b.bill_type}${b.bill_number}`)).toEqual([]);

  // Count every bit set in the index: exactly one per current bill.
  let bits = 0;
  for (const bytes of INDEX.values()) for (const byte of bytes) for (let i = 0; i < 8; i++) bits += (byte >> i) & 1;
  expect(bits).toBe(current.length);
});

test('index: small enough to inline into the proxy bundle', () => {
  const encoded = encodeShortAddressIndex(bills, SHORT_ADDRESS_CONGRESS);
  expect(encoded.length).toBeLessThan(8_000);
});

test('index: a malformed or missing index resolves nothing rather than throwing', () => {
  expect(decodeShortAddressIndex(undefined).size).toBe(0);
  expect(decodeShortAddressIndex('').size).toBe(0);
  const bad = decodeShortAddressIndex('hr:!!!not-base64!!!;nocolon');
  expect(indexHas(bad, { type: 'hr', number: 1 })).toBe(false);
  expect(shortAddressTarget('/hr1', LOCALES, 'en', bad)).toBeNull();
});

// --- the redirect target ---------------------------------------------------------

test('redirect target: the canonical bill page, English bare, Spanish under /es, never a query', () => {
  const sample = current.find((b) => b.bill_type === 'hr')!;
  const slug = `hr-${sample.bill_number}-${SHORT_ADDRESS_CONGRESS}`;
  expect(shortAddressTarget(`/hr${sample.bill_number}`, LOCALES, 'en', INDEX)).toBe(`/bills/${slug}`);
  expect(shortAddressTarget(`/HR-${sample.bill_number}`, LOCALES, 'en', INDEX)).toBe(`/bills/${slug}`);
  expect(shortAddressTarget(`/hr${sample.bill_number}/`, LOCALES, 'en', INDEX)).toBe(`/bills/${slug}`);
  expect(shortAddressTarget(`/en/hr${sample.bill_number}`, LOCALES, 'en', INDEX)).toBe(`/bills/${slug}`);
  expect(shortAddressTarget(`/es/hr${sample.bill_number}`, LOCALES, 'en', INDEX)).toBe(`/es/bills/${slug}`);

  // One of every type the corpus holds.
  for (const type of new Set(current.map((b) => b.bill_type))) {
    const bill = current.find((b) => b.bill_type === type)!;
    expect(shortAddressTarget(`/${type.toUpperCase()}${bill.bill_number}`, LOCALES, 'en', INDEX)).toBe(
      `/bills/${type}-${bill.bill_number}-${SHORT_ADDRESS_CONGRESS}`,
    );
  }

  // The target is always a bare path: nothing from the request rides along.
  for (const b of current.slice(0, 50)) {
    const target = shortAddressTarget(`/es/${b.bill_type}${b.bill_number}`, LOCALES, 'en', INDEX)!;
    expect(target).toMatch(/^\/es\/bills\/[a-z]+-\d+-\d+$/);
  }
});

test('redirect target: unknown numbers, other shapes and deeper paths are not short addresses', () => {
  const held = new Set(current.filter((b) => b.bill_type === 'hr').map((b) => b.bill_number));
  let unheld = 1;
  while (held.has(unheld)) unheld++;
  for (const pathname of [
    `/hr${unheld}`, // a real-looking number the corpus does not hold
    '/hr99999',
    '/hres10', // parses, but the corpus holds no simple resolutions today
    '/',
    '/bills',
    '/es',
    '/es/bills',
    '/fr/hr1', // not a locale
    '/es/es/hr1',
    '/bills/hr1',
    '/hr1/extra',
    '/es/hr1/extra',
  ]) {
    expect(shortAddressTarget(pathname, LOCALES, 'en', INDEX), pathname).toBeNull();
  }
});

// --- no collisions with a real route -------------------------------------------------

/** Every name that can be the first segment of a URL on this site. */
function topLevelNames(): string[] {
  const names = new Set<string>();
  const add = (name: string) => {
    names.add(name);
    names.add(name.replace(/\.[^.]+$/, '')); // /robots.ts serves /robots.txt; test both spellings
  };
  // app/ itself: route folders and metadata/route files (llms.txt, robots.ts,
  // sitemap.ts, icon.svg, …). Route groups add no segment; look inside them.
  const walkTop = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '[locale]' || e.name.startsWith('_') || e.name.startsWith('@')) continue;
      if (e.isDirectory() && e.name.startsWith('(') && e.name.endsWith(')')) {
        walkTop(path.join(dir, e.name));
        continue;
      }
      add(e.name);
    }
  };
  walkTop(APP_DIR);
  // Everything under app/[locale], in both locales (the segment names are the same).
  for (const segment of localeTopSegments()) add(segment);
  // Files served from public/.
  for (const e of fs.readdirSync(path.join(process.cwd(), 'public'))) add(e);
  // The config redirects' old names (next.config.ts) and Next's own prefixes.
  for (const name of ['moments', 'impact', '_next', '_vercel', 'api', 'embed', 'en', 'es']) add(name);
  return [...names].sort();
}

test('no short address shadows a real route, in either locale', () => {
  const names = topLevelNames();
  // The list is real, not vacuous.
  for (const expected of ['bills', 'call', 'today', 'reps', 'questions', 'about', 'api', 'embed', 'votes', 'feed']) {
    expect(names).toContain(expected);
  }
  const collisions = names.filter((name) => parseShortAddress(name) !== null);
  expect(collisions, 'a route segment that reads as a short address would be shadowed by the redirect').toEqual([]);
});

// --- the Congress constant (owner decision pending: card d2) -------------------------

test('the Congress constant is the corpus Congress, and a rollover fails loudly until the owner rules', () => {
  const congresses = [...new Set(bills.map((b) => b.congress_number))].sort((a, b) => a - b);
  expect(congresses, `SHORT_ADDRESS_CONGRESS (${SHORT_ADDRESS_CONGRESS}) holds no bill in the corpus`).toContain(
    SHORT_ADDRESS_CONGRESS,
  );

  const byAddress = new Map<string, Set<number>>();
  for (const b of bills) {
    const key = `${b.bill_type}${b.bill_number}`;
    const set = byAddress.get(key) ?? new Set<number>();
    set.add(b.congress_number);
    byAddress.set(key, set);
  }
  const shared = [...byAddress].filter(([, set]) => set.size > 1).map(([key, set]) => `${key} (${[...set].join(', ')})`);
  const newer = congresses.filter((c) => c > SHORT_ADDRESS_CONGRESS);

  if (SHORT_ADDRESS_ROLLOVER_RULING === null) {
    const message =
      'BILL NUMBERS HAVE RESTARTED. The corpus now holds a Congress other than the one short addresses ' +
      `mean (SHORT_ADDRESS_CONGRESS = ${SHORT_ADDRESS_CONGRESS}), so /hr1 could name two bills. What a short ` +
      'address means after the rollover is the OWNER\'S decision (card d2, "Decide in December"). Do not ' +
      'just bump the constant: get his ruling, quote it in SHORT_ADDRESS_ROLLOVER_RULING ' +
      '(lib/short-address.ts), set the constant to match it, and then update this test.';
    expect(newer, message).toEqual([]);
    expect(shared.slice(0, 20), message).toEqual([]);
  }
});
