import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { NextRequest } from 'next/server';
import billsJson from '../data/bills.json';
import {
  decodeNameTables,
  decodeShortAddressFallback,
  decodeShortAddressIndex,
  encodeNameTables,
  encodeShortAddressFallback,
  encodeShortAddressIndex,
  nameAddressTarget,
  SHORT_ADDRESS_CONGRESS,
  shortAddressTarget,
  type NameTables,
  type ShortAddressBill,
  type ShortAddressFallback,
  type ShortAddressIndex,
} from '../lib/short-address';
import { congressTerm } from '../lib/congress.mjs';
import {
  isCountablePageviewRequest,
  notePageview,
  pageviewSurfaceForPath,
  pageviewUsageKey,
  usageDayKey,
  type PageviewSurface,
} from '../lib/usage';
import { COUNTERS_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * CLAUDE.md RULE 1 FOR SHORT ADDRESSES (/hr9340 -> the bill page; #404).
 *
 * What the feature may keep: one integer per UTC day under the page-view
 * label 'short' (owner, card d3, 2026-09-26: "one number a day, nothing
 * about who"; his go of 2026-11-13). Nothing about the path, the bill, the
 * query, the language or the visitor may be stored or logged, and the
 * redirect must never carry a query (a shared link never carries a stance).
 *
 * proxy.ts cannot be imported in a unit spec (next-intl's middleware is ESM
 * the unit runner cannot resolve; tests/distinct-addresses.unit.spec.ts has
 * the same note), so this pins it the way that spec does: the SOURCE for
 * where and how the count is made, and a DRIVEN burst of proxy.ts's exact
 * call shape against the counters mock for what reaches the wire.
 * tests/short-address.spec.ts checks the built redirect itself (status,
 * Location without a query, no Set-Cookie).
 */

const LOCALES = ['en', 'es'];
const bills = billsJson as unknown as ShortAddressBill[];
const INDEX = decodeShortAddressIndex(encodeShortAddressIndex(bills, SHORT_ADDRESS_CONGRESS));
const FALLBACK = decodeShortAddressFallback(encodeShortAddressFallback(bills));
/** One bill of a type whose short address the site answers today (tracked table, else a fallback), or undefined. */
const answered = (type: string) =>
  bills.find((b) => b.bill_type === type && shortAddressTarget(`/${type}${b.bill_number}`, LOCALES, 'en', INDEX, FALLBACK) !== null);

/** Collapse whitespace, so a call reads the same however it is wrapped. */
const flat = (source: string) => source.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/,? \)/g, ')');

/** Code only: comments may name anything in prose. */
const codeOf = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const proxySource = readFileSync(join(process.cwd(), 'proxy.ts'), 'utf8');
const proxyBody = (() => {
  const from = proxySource.indexOf('export default function proxy');
  return proxySource.slice(from, proxySource.indexOf('\n}\n', from) + 2);
})();

test('source: the lookup module stores, logs and fetches nothing, and reads no environment', () => {
  const code = codeOf(readFileSync(join(process.cwd(), 'lib/short-address.ts'), 'utf8'));
  for (const forbidden of [
    /console\./,
    /\bfetch\(/,
    /process\.env/,
    /localStorage|sessionStorage|document\.cookie|cookies\(/,
    /upstash|noteUsage|notePageview|redis/i,
    /\bawait\b|\basync\b/,
  ]) {
    expect(code, String(forbidden)).not.toMatch(forbidden);
  }
});

test('source: proxy.ts counts a short address as the literal label and builds the redirect from the target alone', () => {
  // The label is a literal chosen by a boolean; nothing from the request
  // reaches it.
  expect(proxyBody).toContain("shortTarget ? 'short' : pageviewSurfaceForPath(req.nextUrl.pathname, routing.locales)");
  // The lookup sees the pathname only (NextRequest keeps the query apart),
  // and the two build-time tables: the tracked Congress's and, once a
  // Congress has ended, the fallback (the owner's ruling of Nov 14, 2026).
  // A NAME address (card 191, Nov 14, 2026) is asked only when the number
  // lookup answered null, with the pathname and the build-time name tables
  // alone, and its answer lands in the same `shortTarget`, so the label
  // below is the same one word for both.
  expect(flat(proxyBody)).toContain(
    'shortAddressTarget(req.nextUrl.pathname, routing.locales, routing.defaultLocale, SHORT_ADDRESS_INDEX, SHORT_ADDRESS_FALLBACK) ?? nameAddressTarget(req.nextUrl.pathname, routing.locales, routing.defaultLocale, SHORT_ADDRESS_NAMES)',
  );
  expect(proxyBody.match(/nameAddressTarget\(/g)).toHaveLength(1);
  // Both tables come from build-time constants, decoded once at module load.
  const tables = codeOf(proxySource.slice(0, proxySource.indexOf('function shortAddressRedirect')));
  expect(tables).toContain('decodeShortAddressIndex(process.env.SHORT_ADDRESS_INDEX)');
  expect(tables).toContain('decodeShortAddressFallback(process.env.SHORT_ADDRESS_FALLBACK)');
  expect(tables).toContain('decodeNameTables(process.env.SHORT_ADDRESS_NAMES)');
  // The redirect is the target path on this site's own origin. The query,
  // search params and headers of the request are never read for it.
  const redirect = codeOf(proxySource.slice(proxySource.indexOf('function shortAddressRedirect'), proxySource.indexOf('/*\n * The two things')));
  expect(redirect).toContain('new URL(target, req.nextUrl.origin)');
  expect(redirect).not.toMatch(/search|query|headers\.get|cookies|ip\b/i);
  expect(redirect).toContain("res.headers.set('Cache-Control', 'no-store')");
  // Nothing in the proxy logs.
  expect(codeOf(proxySource)).not.toMatch(/console\./);
});

/**
 * Drive a burst through exactly proxy.ts's call shape against the counters
 * mock, with the given tables, and check the wire. Each `redirected` path
 * must resolve (through either table) and each `notRedirected` one must not.
 */
async function drivenBurst(
  index: ShortAddressIndex,
  fallback: ShortAddressFallback,
  congress: number,
  redirected: string[],
  notRedirected: string[],
  markers: string[],
  names: NameTables = [],
): Promise<string[]> {
  const restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  const restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });
  try {
    const visitor = { ip: '203.0.113.77', agent: 'Mozilla/5.0 (Probe-Agent-7731)' };
    const req = (path: string, method = 'GET') =>
      new NextRequest(`https://oravan.org${path}`, {
        method,
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'x-forwarded-for': visitor.ip,
          'user-agent': visitor.agent,
          'accept-language': 'es-MX',
          referer: 'https://social.example/post/123',
        },
      });

    const targets: string[] = [];
    for (const path of [...redirected, ...notRedirected]) {
      const r = req(path);
      // Exactly proxy.ts's call shape.
      const shortTarget =
        r.method === 'GET' || r.method === 'HEAD'
          ? (shortAddressTarget(r.nextUrl.pathname, LOCALES, 'en', index, fallback, congress) ??
            nameAddressTarget(r.nextUrl.pathname, LOCALES, 'en', names))
          : null;
      if (shortTarget) targets.push(shortTarget);
      const surface: PageviewSurface = shortTarget ? 'short' : pageviewSurfaceForPath(r.nextUrl.pathname, LOCALES);
      if (isCountablePageviewRequest(r)) await notePageview(surface);
    }

    // Every redirect target is a bare bill path: no query, no stance.
    expect(targets).toHaveLength(redirected.length);
    // (or, since the owner's card 193, a shared name's page: /names/<congress>/<name>)
    for (const target of targets) expect(target).toMatch(/^(\/es)?\/(bills\/[a-z]+-\d+-\d+|names\/\d+\/[a-z0-9]+(-[a-z0-9]+)*)$/);

    // Two keys exist, both bare template labels with a date.
    const day = usageDayKey();
    expect(counters.keys().sort()).toEqual([pageviewUsageKey('other', day), pageviewUsageKey('short', day)].sort());
    expect(counters.store.get(pageviewUsageKey('short', day))?.value).toBe(String(redirected.length));
    expect(counters.store.get(pageviewUsageKey('other', day))?.value).toBe(String(notRedirected.length));

    // Every argument of every command on the wire is a command word, one of
    // those two keys, or a bare number (a TTL, an increment): there is no
    // other place for anything from the request to sit.
    const keys = new Set([pageviewUsageKey('short', day), pageviewUsageKey('other', day)]);
    for (const command of counters.commands) {
      const [verb, ...args] = command;
      expect(verb, command.join(' ')).toMatch(/^[A-Z]+$/);
      for (const arg of args) {
        expect(keys.has(arg) || /^[A-Z]+$/.test(arg) || /^\d+$/.test(arg), `unexpected wire argument "${arg}"`).toBe(true);
      }
    }

    // And, belt and braces, none of what the requests carried.
    const wire = counters.commands.map((c) => c.join(' ')).join('\n');
    for (const marker of [
      ...markers,
      'hr',
      'HR',
      '/es',
      'bills',
      'stance',
      'support',
      'oppose',
      'utm',
      'probe',
      visitor.ip,
      '203.0.113',
      'Probe-Agent',
      'es-MX',
      'social.example',
    ]) {
      expect(wire, `the counters wire must not carry "${marker}"`).not.toContain(marker);
    }
    return targets;
  } finally {
    restoreFetch();
    restoreEnv();
  }
}

test('driven: a burst of short-address requests leaves one daily "short" count on the wire, and nothing about path, bill, query, language or visitor', async () => {
  // Drawn from every bill a short address answers (the tracked Congress, else
  // an ended one), so this holds on switch day with no new bill yet.
  const hr = answered('hr');
  const s = answered('s');
  test.skip(!hr || !s, 'the corpus holds no House bill or no Senate bill a short address can open');
  if (!hr || !s) return;
  await drivenBurst(
    INDEX,
    FALLBACK,
    SHORT_ADDRESS_CONGRESS,
    [
      `/hr${hr.bill_number}`,
      `/HR-${hr.bill_number}`,
      `/es/hr${hr.bill_number}`,
      `/hr${hr.bill_number}?stance=support`,
      `/es/s${s.bill_number}?stance=oppose&utm_source=probe`,
    ],
    ['/hr99999', '/hres10'],
    [`hr${hr.bill_number}`, `-${hr.bill_number}-`, `s${s.bill_number}`],
  );
});

test('driven, after the switch: a fallback to the ended Congress counts the same one word, and nothing about which Congress', async () => {
  // The switch as #486 models it: 119 ended, 120 tracked. The corpus's bill
  // numbers, labelled as the 119th's, are the ended table; a small 120th
  // corpus is the tracked one, with one number the 119th also used and one
  // it did not. Built exactly the way next.config.ts builds them, and from
  // fixtures only, so this holds before and after the real switch.
  const seen = new Set<string>();
  const old: ShortAddressBill[] = [];
  for (const b of bills) {
    const key = `${b.bill_type}${b.bill_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    old.push({ bill_type: b.bill_type, bill_number: b.bill_number, congress_number: 119 });
  }
  const hr = old.find((b) => b.bill_type === 'hr')!;
  const s = old.find((b) => b.bill_type === 's')!;
  const heldHr = new Set(old.filter((b) => b.bill_type === 'hr').map((b) => b.bill_number));
  let fresh = 1;
  while (heldHr.has(fresh)) fresh++;
  const corpus: ShortAddressBill[] = [
    ...old,
    { bill_type: 'hr', bill_number: hr.bill_number, congress_number: 120 },
    { bill_type: 'hr', bill_number: fresh, congress_number: 120 },
  ];
  const policy = { tracked: 120, ended: [{ number: 119, ended: congressTerm(119).end }] };
  const index = decodeShortAddressIndex(encodeShortAddressIndex(corpus, 120));
  const fallback = decodeShortAddressFallback(encodeShortAddressFallback(corpus, policy));
  expect(fallback.map((t) => t.congress)).toEqual([119]);

  const targets = await drivenBurst(
    index,
    fallback,
    120,
    [
      `/hr${hr.bill_number}`, // both hold it: the 120th
      `/hr${fresh}`, // only the 120th
      `/s${s.bill_number}?stance=support`, // only the 119th: the fallback
      `/es/S-${s.bill_number}?stance=oppose&utm_source=probe`,
    ],
    ['/hr99999', '/hres10'],
    [`hr${hr.bill_number}`, `-${hr.bill_number}-`, `s${s.bill_number}`, `hr${fresh}`, '119', '120'],
  );
  expect(targets).toEqual([
    `/bills/hr-${hr.bill_number}-120`,
    `/bills/hr-${fresh}-120`,
    `/bills/s-${s.bill_number}-119`,
    `/es/bills/s-${s.bill_number}-119`,
  ]);
});

/*
 * NAME ADDRESSES (card 191, Nov 14, 2026: "Names beside numbers. Each name
 * comes from the bill's own official short title in the record, never chosen
 * by Oravan."). The same one word, 'short', and nothing about which name was
 * typed: not the name, not a word of it, not the bill, not whether it was a
 * name or a number. Built from fixtures shaped like data/short-titles.json
 * (real short titles of the record, read 2026-11-14), so this holds whether or
 * not the nightly has filled that file yet.
 */
test('driven: name addresses count the same one "short" word, and the typed name never reaches the wire', async () => {
  const corpus: ShortAddressBill[] = [
    { bill_type: 's', bill_number: 5, congress_number: SHORT_ADDRESS_CONGRESS },
    { bill_type: 'hr', bill_number: 4, congress_number: SHORT_ADDRESS_CONGRESS },
    { bill_type: 'hr', bill_number: 22, congress_number: SHORT_ADDRESS_CONGRESS },
    { bill_type: 's', bill_number: 128, congress_number: SHORT_ADDRESS_CONGRESS },
  ];
  const titles = {
    [`s-5-${SHORT_ADDRESS_CONGRESS}`]: { titles: ['Laken Riley Act'] },
    [`hr-4-${SHORT_ADDRESS_CONGRESS}`]: { titles: ['Rescissions Act of 2025'] },
    // Shared by two bills: never resolves.
    [`hr-22-${SHORT_ADDRESS_CONGRESS}`]: { titles: ['SAVE Act'] },
    [`s-128-${SHORT_ADDRESS_CONGRESS}`]: { titles: ['SAVE Act'] },
  };
  const index = decodeShortAddressIndex(encodeShortAddressIndex(corpus, SHORT_ADDRESS_CONGRESS));
  const names = decodeNameTables(encodeNameTables(corpus, titles, [SHORT_ADDRESS_CONGRESS], new Set()));
  expect(names).toHaveLength(1);
  const targets = await drivenBurst(
    index,
    [],
    SHORT_ADDRESS_CONGRESS,
    [
      '/laken-riley-act',
      '/LAKEN-RILEY-ACT',
      '/es/laken-riley-act?stance=oppose&utm_source=probe',
      '/rescissions-act-of-2025?stance=support',
      '/s5', // a number beside them
      '/save-act', // shared by two bills: the page that lists both (card 193)
      '/es/SAVE-ACT?stance=support',
    ],
    ['/laken-riley', '/laken-riley-act-of-2025', '/hr99999'],
    ['laken', 'riley', 'rescission', 'save', 'act', 's5', '-5-', 'hr4'],
    names,
  );
  expect(targets).toEqual([
    `/bills/s-5-${SHORT_ADDRESS_CONGRESS}`,
    `/bills/s-5-${SHORT_ADDRESS_CONGRESS}`,
    `/es/bills/s-5-${SHORT_ADDRESS_CONGRESS}`,
    `/bills/hr-4-${SHORT_ADDRESS_CONGRESS}`,
    `/bills/s-5-${SHORT_ADDRESS_CONGRESS}`,
    `/names/${SHORT_ADDRESS_CONGRESS}/save-act`,
    `/es/names/${SHORT_ADDRESS_CONGRESS}/save-act`,
  ]);
  // The page itself is counted under the existing 'other' page shape, and nothing about the name.
  expect(pageviewSurfaceForPath(`/names/${SHORT_ADDRESS_CONGRESS}/save-act`, LOCALES)).toBe('other');
  expect(pageviewSurfaceForPath(`/es/names/${SHORT_ADDRESS_CONGRESS}/save-act`, LOCALES)).toBe('other');
});
