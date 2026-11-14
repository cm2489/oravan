import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { NextRequest } from 'next/server';
import billsJson from '../data/bills.json';
import {
  decodeShortAddressIndex,
  encodeShortAddressIndex,
  SHORT_ADDRESS_CONGRESS,
  shortAddressTarget,
  type ShortAddressBill,
} from '../lib/short-address';
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
const current = bills.filter((b) => b.congress_number === SHORT_ADDRESS_CONGRESS);

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
  // The lookup sees the pathname only (NextRequest keeps the query apart).
  expect(proxyBody).toContain(
    'shortAddressTarget(req.nextUrl.pathname, routing.locales, routing.defaultLocale, SHORT_ADDRESS_INDEX)',
  );
  // The redirect is the target path on this site's own origin. The query,
  // search params and headers of the request are never read for it.
  const redirect = codeOf(proxySource.slice(proxySource.indexOf('function shortAddressRedirect'), proxySource.indexOf('/*\n * The two things')));
  expect(redirect).toContain('new URL(target, req.nextUrl.origin)');
  expect(redirect).not.toMatch(/search|query|headers\.get|cookies|ip\b/i);
  expect(redirect).toContain("res.headers.set('Cache-Control', 'no-store')");
  // Nothing in the proxy logs.
  expect(codeOf(proxySource)).not.toMatch(/console\./);
});

test('driven: a burst of short-address requests leaves one daily "short" count on the wire, and nothing about path, bill, query, language or visitor', async () => {
  const restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  const restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });
  try {
    const hr = current.find((b) => b.bill_type === 'hr')!;
    const s = current.find((b) => b.bill_type === 's')!;
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
    const redirected = [
      `/hr${hr.bill_number}`,
      `/HR-${hr.bill_number}`,
      `/es/hr${hr.bill_number}`,
      `/hr${hr.bill_number}?stance=support`,
      `/es/s${s.bill_number}?stance=oppose&utm_source=probe`,
    ];
    const notRedirected = ['/hr99999', '/hres10'];

    const targets: string[] = [];
    for (const path of [...redirected, ...notRedirected]) {
      const r = req(path);
      // Exactly proxy.ts's call shape.
      const shortTarget =
        r.method === 'GET' || r.method === 'HEAD'
          ? shortAddressTarget(r.nextUrl.pathname, LOCALES, 'en', INDEX)
          : null;
      if (shortTarget) targets.push(shortTarget);
      const surface: PageviewSurface = shortTarget ? 'short' : pageviewSurfaceForPath(r.nextUrl.pathname, LOCALES);
      if (isCountablePageviewRequest(r)) await notePageview(surface);
    }

    // Every redirect target is a bare bill path: no query, no stance.
    expect(targets).toHaveLength(redirected.length);
    for (const target of targets) expect(target).toMatch(/^(\/es)?\/bills\/[a-z]+-\d+-\d+$/);

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
      `hr${hr.bill_number}`,
      `-${hr.bill_number}-`,
      `s${s.bill_number}`,
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
  } finally {
    restoreFetch();
    restoreEnv();
  }
});
