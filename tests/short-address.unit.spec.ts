import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import billsJson from '../data/bills.json';
import {
  decodeShortAddressFallback,
  decodeShortAddressIndex,
  encodeShortAddressFallback,
  encodeShortAddressIndex,
  indexHas,
  parseShortAddress,
  SHORT_ADDRESS_CONGRESS,
  SHORT_ADDRESS_ROLLOVER_RULING,
  SHORT_ADDRESS_TYPES,
  shortAddressFallbackCongress,
  shortAddressTarget,
  type ShortAddressBill,
  type ShortAddressPolicy,
} from '../lib/short-address';
import { CONGRESS_POLICY, CURRENT_CONGRESS, ENDED_CONGRESSES, congressTerm } from '../lib/congress.mjs';
import { APP_DIR, LOCALE_DIR, localeTopSegments } from './routes';

/*
 * Short addresses for bills (lib/short-address.ts): /hr9340 opens that bill.
 * Pure Node — no server, no browser. tests/short-address.spec.ts proves the
 * same behaviour against a production build.
 */

const bills = billsJson as unknown as ShortAddressBill[];
const LOCALES = ['en', 'es'];
const INDEX = decodeShortAddressIndex(encodeShortAddressIndex(bills, SHORT_ADDRESS_CONGRESS));
const FALLBACK = decodeShortAddressFallback(encodeShortAddressFallback(bills));
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
  // Non-vacuity: the real corpus. (Right after the January switch the new
  // Congress holds only a few bills; the corpus as a whole is still large.)
  expect(bills.length).toBeGreaterThan(1000);
  expect(current.length).toBeGreaterThan(0);
  const missing = current.filter((b) => !indexHas(INDEX, { type: b.bill_type as never, number: b.bill_number }));
  expect(missing.map((b) => `${b.bill_type}${b.bill_number}`)).toEqual([]);

  // Count every bit set in the index: exactly one per current bill.
  let bits = 0;
  for (const bytes of INDEX.values()) for (const byte of bytes) for (let i = 0; i < 8; i++) bits += (byte >> i) & 1;
  expect(bits).toBe(current.length);
});

test('fallback: every bill of the ended Congress that the new one has no number for resolves to the ended bill', () => {
  // Runs on the real corpus once lib/congress.mjs lists an ended Congress
  // (from the January 2027 switch on); today there is no fallback table.
  if (FALLBACK === null) return;
  const ended = bills.filter((b) => b.congress_number === FALLBACK.congress);
  expect(ended.length).toBeGreaterThan(1000);
  for (const b of ended) {
    const tracked = indexHas(INDEX, { type: b.bill_type as never, number: b.bill_number });
    const congress = tracked ? SHORT_ADDRESS_CONGRESS : FALLBACK.congress;
    expect(shortAddressTarget(`/${b.bill_type}${b.bill_number}`, LOCALES, 'en', INDEX, FALLBACK)).toBe(
      `/bills/${b.bill_type}-${b.bill_number}-${congress}`,
    );
  }
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
  // Everything under app/[locale], in both locales (the segment names are the
  // same): every route's first segment, and every entry of the folder itself
  // (metadata files such as manifest.webmanifest and opengraph-image too).
  for (const segment of localeTopSegments()) add(segment);
  for (const e of fs.readdirSync(LOCALE_DIR)) add(e);
  // A locale's own folder outside [locale] (app/es/feed serves /es/feed/…):
  // /es/<name> is a shape shortAddressTarget reads, so its names count too.
  for (const locale of LOCALES) {
    const dir = path.join(APP_DIR, locale);
    if (fs.existsSync(dir)) for (const e of fs.readdirSync(dir)) add(e);
  }
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

// --- the Congress constant and the change of Congress -------------------------------

test('short addresses mean the tracked Congress first, read from lib/congress.mjs', () => {
  expect(SHORT_ADDRESS_CONGRESS).toBe(CURRENT_CONGRESS.number);
});

/*
 * THE OWNER'S RULING (decision 190, clicked Saturday, Nov 14, 2026,
 * 12:41 PM ET). The card asked: "Short addresses are built: oravan.org/hr9340
 * opens that bill. Congress reuses bill numbers every two years. Once the new
 * Congress starts, which bill should a short address open?" He chose option
 * a: "The newest Congress, falling back to the ended one when the new one has
 * no such bill yet." The card's examples for a: someone who types
 * oravan.org/hr1 in February 2027 gets "the new H.R. 1 once it exists; until
 * then, the old one, marked as ended"; a link shared in 2026 to
 * oravan.org/hr9340 "keeps opening the old bill, marked as ended, until the
 * new Congress reaches H.R. 9340; then it opens the new one." And its
 * promise: "Whatever you choose, the full address
 * (oravan.org/bills/hr-9340-119) always opens the same bill."
 *
 * Until the switch these tests replaced a guard that failed the switch until
 * he ruled. They pin what he chose, on fixtures shaped like the switch as
 * #486 models it (119 ended, 120 tracked), so the switch itself needs no
 * short-address change: moving the tracked number and filling the ended list
 * in lib/congress.mjs is enough, and next.config.ts builds both tables from
 * whatever the corpus then holds.
 */

test('the ruling is recorded, with its date, in the words of the card', () => {
  expect(SHORT_ADDRESS_ROLLOVER_RULING).not.toBeNull();
  const ruling = SHORT_ADDRESS_ROLLOVER_RULING ?? '';
  expect(ruling).toContain('Decision 190');
  expect(ruling).toContain('Nov 14, 2026, 12:41 PM ET');
  expect(ruling).toContain(
    '"The newest Congress, falling back to the ended one when the new one has no such bill yet."',
  );
});

test('today: nothing has ended, so there is no fallback table and the lookup is the one-table lookup of #404', () => {
  // While lib/congress.mjs lists no ended Congress, the second table is the
  // empty string at build time and decodes to nothing: every short address
  // answers exactly as it did before the ruling.
  if (ENDED_CONGRESSES.length > 0) return; // after the switch: the fixtures below carry the proof
  expect(shortAddressFallbackCongress(bills)).toBeNull();
  expect(encodeShortAddressFallback(bills)).toBe('');
  expect(FALLBACK).toBeNull();
  for (const b of current.slice(0, 200)) {
    const path = `/${b.bill_type}${b.bill_number}`;
    expect(shortAddressTarget(path, LOCALES, 'en', INDEX, FALLBACK)).toBe(shortAddressTarget(path, LOCALES, 'en', INDEX));
  }
});

test('the corpus holds only the tracked Congress and Congresses on the ended list', () => {
  // A bill of any other Congress gets no short address, by design: it is
  // neither the newest nor the ended one. scripts/verify-sync.mjs refuses
  // such a corpus anyway; this says so for short addresses.
  const known = new Set([CONGRESS_POLICY.tracked, ...CONGRESS_POLICY.ended.map((e) => e.number)]);
  const stray = [...new Set(bills.map((b) => b.congress_number))].filter((c) => !known.has(c));
  expect(stray).toEqual([]);
});

/** The switch as tests/congress-ended.unit.spec.ts models it: 119 ended, 120 tracked. */
const SWITCHED: ShortAddressPolicy = Object.freeze({
  tracked: 120,
  ended: Object.freeze([Object.freeze({ number: 119, ended: congressTerm(119).end })]),
});

/** A corpus holding both Congresses: H.R. 1 in both, H.R. 9340 and S. 5 in the 119th only, S. 7 in the 120th only. */
const SWITCHED_CORPUS: ShortAddressBill[] = [
  { bill_type: 'hr', bill_number: 1, congress_number: 119 },
  { bill_type: 'hr', bill_number: 1, congress_number: 120 },
  { bill_type: 'hr', bill_number: 9340, congress_number: 119 },
  { bill_type: 's', bill_number: 5, congress_number: 119 },
  { bill_type: 's', bill_number: 7, congress_number: 120 },
  { bill_type: 'hjres', bill_number: 3, congress_number: 119 },
];

/** What proxy.ts does after the switch: both tables built the way next.config.ts builds them. */
function switchedTarget(
  pathname: string,
  corpus: readonly ShortAddressBill[] = SWITCHED_CORPUS,
  policy: ShortAddressPolicy = SWITCHED,
): string | null {
  const index = decodeShortAddressIndex(encodeShortAddressIndex(corpus, policy.tracked));
  const fallback = decodeShortAddressFallback(encodeShortAddressFallback(corpus, policy));
  return shortAddressTarget(pathname, LOCALES, 'en', index, fallback, policy.tracked);
}

test('after the switch: the newest Congress when it holds the bill', () => {
  // "the new H.R. 1 once it exists"
  expect(switchedTarget('/hr1')).toBe('/bills/hr-1-120');
  expect(switchedTarget('/HR-1')).toBe('/bills/hr-1-120');
  expect(switchedTarget('/es/hr1')).toBe('/es/bills/hr-1-120');
  expect(switchedTarget('/s7')).toBe('/bills/s-7-120');
});

test('after the switch: the ended Congress when the new one has no such bill yet', () => {
  // "keeps opening the old bill, marked as ended, until the new Congress reaches H.R. 9340"
  expect(switchedTarget('/hr9340')).toBe('/bills/hr-9340-119');
  expect(switchedTarget('/HR9340/')).toBe('/bills/hr-9340-119');
  expect(switchedTarget('/en/hr-9340')).toBe('/bills/hr-9340-119');
  expect(switchedTarget('/es/hr9340')).toBe('/es/bills/hr-9340-119');
  expect(switchedTarget('/es/S-5')).toBe('/es/bills/s-5-119');
  expect(switchedTarget('/hjres3')).toBe('/bills/hjres-3-119');
  // "then it opens the new one": the day the corpus holds the 120th's H.R. 9340.
  const reached = [...SWITCHED_CORPUS, { bill_type: 'hr', bill_number: 9340, congress_number: 120 }];
  expect(switchedTarget('/hr9340', reached)).toBe('/bills/hr-9340-120');
  expect(switchedTarget('/es/hr9340', reached)).toBe('/es/bills/hr-9340-120');
});

test('after the switch: a number neither Congress holds is still the normal 404, and the shapes are unchanged', () => {
  for (const pathname of ['/hr2', '/s1', '/hres10', '/hr99999', '/hr-1-119', '/bills/hr1', '/hr1/extra', '/fr/hr1', '/es/es/hr1']) {
    expect(switchedTarget(pathname), pathname).toBeNull();
  }
  // The target is always a bare bill path of one of the two Congresses.
  for (const pathname of ['/hr1', '/es/hr9340', '/S5', '/s7']) {
    expect(switchedTarget(pathname), pathname).toMatch(/^(\/es)?\/bills\/[a-z]+-\d+-(119|120)$/);
  }
});

test('the fallback is the most recently ended Congress the corpus holds, and only one', () => {
  const twoEnded: ShortAddressPolicy = Object.freeze({
    tracked: 121,
    ended: Object.freeze([
      Object.freeze({ number: 119, ended: congressTerm(119).end }),
      Object.freeze({ number: 120, ended: congressTerm(120).end }),
    ]),
  });
  const corpus: ShortAddressBill[] = [
    { bill_type: 'hr', bill_number: 1, congress_number: 121 },
    { bill_type: 'hr', bill_number: 2, congress_number: 120 },
    { bill_type: 'hr', bill_number: 2, congress_number: 119 },
    { bill_type: 'hr', bill_number: 3, congress_number: 119 },
  ];
  expect(shortAddressFallbackCongress(corpus, twoEnded)).toBe(120);
  // Listed in either order, the later-ended one wins.
  expect(shortAddressFallbackCongress(corpus, { ...twoEnded, ended: [...twoEnded.ended].reverse() })).toBe(120);
  expect(switchedTarget('/hr1', corpus, twoEnded)).toBe('/bills/hr-1-121');
  expect(switchedTarget('/hr2', corpus, twoEnded)).toBe('/bills/hr-2-120');
  // "the ended one": one fallback Congress, never a walk back through older ones.
  expect(switchedTarget('/hr3', corpus, twoEnded)).toBeNull();
  // An ended Congress the corpus holds none of is skipped.
  expect(shortAddressFallbackCongress(corpus.filter((b) => b.congress_number !== 120), twoEnded)).toBe(119);
  // A Congress the corpus holds but the ended list does not name is never a fallback.
  expect(shortAddressFallbackCongress(corpus, { tracked: 121, ended: [] })).toBeNull();
  expect(shortAddressFallbackCongress(SWITCHED_CORPUS, SWITCHED)).toBe(119);
});

test('the full address always opens the same bill: short addresses never touch /bills/', () => {
  // The card's promise: "the full address (oravan.org/bills/hr-9340-119)
  // always opens the same bill." No full address is a short address, before
  // or after the switch.
  for (const pathname of ['/bills/hr-9340-119', '/es/bills/hr-9340-119', '/bills/hr-1-120', '/hr-9340-119']) {
    expect(switchedTarget(pathname), pathname).toBeNull();
    expect(shortAddressTarget(pathname, LOCALES, 'en', INDEX, FALLBACK), pathname).toBeNull();
  }
});

test('a malformed fallback table means no fallback, never a throw', () => {
  for (const bad of [undefined, '', '119', '@hr:AQ==', '0@hr:AQ==', 'x@hr:AQ==', '119@', '119@hr:!!!', '119@nocolon']) {
    expect(decodeShortAddressFallback(bad), String(bad)).toBeNull();
  }
  expect(decodeShortAddressFallback('119@hr:Ag==')?.congress).toBe(119);
});

test('both tables together stay small enough to inline into the proxy bundle', () => {
  // A full 119th and a full 120th corpus: two tables of the size measured today.
  const encoded = encodeShortAddressIndex(bills, SHORT_ADDRESS_CONGRESS);
  expect(encoded.length * 2 + 10).toBeLessThan(16_000);
});
