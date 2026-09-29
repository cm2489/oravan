import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, limitsFrom, readCircuit, refusalEvidence } from '../scripts/gdelt-intake.mjs';

// The press-count intake's own log and state carry the evidence for why the
// source refuses requests: when the circuit first opened, when it last
// reopened, when the source last answered, and what a refusal said. Zero
// network: the fetch is injected and the clock is fake.

const NOW = Date.parse('2026-09-28T09:00:00Z');
const BIAS: Record<string, string> = { 'cnn.com': 'left', 'npr.org': 'center', 'foxnews.com': 'right' };
const MOMENTS = {
  'iran-war-powers': {
    status: 'live',
    aliases: { en: ['war powers', 'operation epic fury'], es: [] },
    vehicles: [{ slug: 'hconres-89-119' }],
  },
};
const BILLS = [{ full_identifier: 'hconres-89-119', press_names: null, short_title: null, news_query: 'x', sponsor_bioguide_id: 'J000298' }];
const LIMITS = limitsFrom({});
const FIRST_OPENED = '2026-09-26T18:09:14.000Z';
const OLD_ANSWER = '2026-09-26T18:05:00.000Z';

type Reply = { status: number; body: string; headers?: Record<string, string>; hang?: boolean };

const artList = (): Reply => ({
  status: 200,
  body: JSON.stringify({
    articles: [
      { url: 'https://www.cnn.com/a', url_mobile: '', title: 'Senate votes on war powers', seendate: '20260927T211500Z', socialimage: '', domain: 'cnn.com', language: 'English', sourcecountry: 'United States' },
    ],
  }),
  headers: {},
});

function net(script: (n: number) => Reply) {
  let t = NOW;
  let n = 0;
  const times: number[] = [];
  return {
    times,
    fetchImpl: async () => {
      n++;
      times.push(t - NOW);
      const r = script(n);
      // `hang`: the body never finishes arriving.
      return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: r.headers ?? {}, text: () => (r.hang ? new Promise<string>(() => {}) : Promise.resolve(r.body)) };
    },
    sleep: async (ms: number) => {
      t += ms;
    },
    timer: (ms: number) => {
      let cancelled = false;
      const promise = new Promise<void>((resolve) =>
        setImmediate(() => {
          if (!cancelled) t += ms;
          resolve();
        })
      );
      return { promise, cancel: () => (cancelled = true) };
    },
    clock: () => t,
    count: () => n,
  };
}

const go = async (nt: ReturnType<typeof net>, over: Record<string, unknown> = {}) => {
  const lines: string[] = [];
  const r = await collect({
    moments: MOMENTS,
    bills: BILLS,
    bias: BIAS,
    now: NOW,
    fetchImpl: nt.fetchImpl,
    sleep: nt.sleep,
    timer: nt.timer,
    clock: nt.clock,
    log: (l: string) => lines.push(l),
    ...over,
  } as Parameters<typeof collect>[0]);
  return { ...r, lines };
};

const priorCircuit = (msAgo = LIMITS.circuitCooldownMs + 60_000, extra: Record<string, string> = {}) => ({
  open: true as const,
  reason: '429',
  openedAt: FIRST_OPENED,
  lastTryAt: new Date(NOW - msAgo).toISOString(),
  tries: 4,
  ...extra,
});

const refusal = (): Reply => ({
  status: 429,
  body: `Please limit requests to one every 5 seconds or contact someone@example.test for larger queries. ${'x'.repeat(400)}`,
  headers: {
    date: 'Mon, 28 Sep 2026 09:00:12 GMT',
    server: 'GDELT Server',
    'retry-after': '30',
    'content-type': 'text/plain',
    'x-ratelimit-remaining': '0',
    'set-cookie': 'session=SECRET-COOKIE-VALUE',
    authorization: 'Bearer SECRET-TOKEN',
    'x-something-else': 'NOT-ALLOWED',
    'x-ratelimit-token': 'TOKEN-LIKE-VALUE',
    'retry-debug': 'INTERNAL-HOST',
  },
});

test.describe('the press-count intake logs the evidence for a refusing source', () => {
  test('a fresh open after an answered request writes lastAnsweredAt, no reopenedAt, and logs the times', async () => {
    const nt = net((n) => (n === 1 ? artList() : refusal()));
    const { circuit, lines } = await go(nt);
    expect(circuit).toMatchObject({ open: true, reason: '429', tries: 1 });
    expect(circuit?.lastAnsweredAt).toBe(new Date(NOW).toISOString());
    expect(circuit?.reopenedAt).toBeUndefined();
    const line = lines.find((l) => /^gdelt-intake: the GDELT circuit is open \(429; /.test(l));
    expect(line).toContain(`first opened ${circuit?.openedAt}`);
    expect(line).toContain('last reopened never');
    expect(line).toContain(`last answered ${circuit?.lastAnsweredAt}`);
  });

  test('an answered probe updates lastAnsweredAt; the reopen records reopenedAt and keeps the first-opened time', async () => {
    const nt = net((n) => (n === 1 ? artList() : refusal()));
    const { circuit, lines } = await go(nt, { circuit: priorCircuit(LIMITS.circuitCooldownMs + 60_000, { lastAnsweredAt: OLD_ANSWER }) });
    expect(circuit).toMatchObject({ open: true, reason: '429', openedAt: FIRST_OPENED, tries: 5 });
    expect(circuit?.lastAnsweredAt).toBe(new Date(NOW).toISOString());
    expect(circuit?.lastAnsweredAt).not.toBe(OLD_ANSWER);
    expect(circuit?.reopenedAt).toBe(circuit?.lastTryAt);
    const line = lines.find((l) => /^gdelt-intake: the GDELT circuit is open \(429; /.test(l));
    expect(line).toContain(`first opened ${FIRST_OPENED}`);
    expect(line).toContain(`last reopened ${circuit?.reopenedAt}`);
    expect(line).toContain(`last answered ${circuit?.lastAnsweredAt}`);
    // The existing wording at the start of the half-open line is unchanged.
    expect(lines.some((l) => /^gdelt-intake: the GDELT circuit is open \(429, since 2026-09-26T18:09:14.000Z[;)]/.test(l))).toBe(true);
  });

  test('a probe that is refused again keeps lastAnsweredAt and reopenedAt as they were', async () => {
    const nt = net(() => refusal());
    const prior = priorCircuit(LIMITS.circuitCooldownMs + 60_000, { lastAnsweredAt: OLD_ANSWER, reopenedAt: '2026-09-27T18:40:00.000Z' });
    const { circuit } = await go(nt, { circuit: prior });
    expect(nt.count()).toBe(1);
    expect(circuit).toMatchObject({ openedAt: FIRST_OPENED, lastAnsweredAt: OLD_ANSWER, reopenedAt: '2026-09-27T18:40:00.000Z', tries: 5 });
  });

  test('inside the cooldown: no request, state carried unchanged, and the skip line names all three times', async () => {
    const nt = net(() => refusal());
    const prior = priorCircuit(60_000, { lastAnsweredAt: OLD_ANSWER, reopenedAt: '2026-09-27T18:40:00.000Z' });
    const { circuit, lines } = await go(nt, { circuit: prior });
    expect(nt.count()).toBe(0);
    expect(circuit).toEqual(prior);
    const line = lines.find((l) => /^::warning::gdelt-intake: the GDELT circuit has been open since /.test(l));
    expect(line).toContain(`first opened ${FIRST_OPENED}`);
    expect(line).toContain('last reopened 2026-09-27T18:40:00.000Z');
    expect(line).toContain(`last answered ${OLD_ANSWER}`);
    expect(line).toMatch(/no request this run/);
  });

  test('a refusal logs the status, the allowed headers and the first 200 characters of the body, and nothing else', async () => {
    const nt = net(() => refusal());
    const { lines } = await go(nt, { circuit: priorCircuit() });
    const line = lines.find((l) => /GDELT refused a request/.test(l)) ?? '';
    expect(line).toContain('HTTP 429');
    expect(line).toContain('date: Mon, 28 Sep 2026 09:00:12 GMT');
    expect(line).toContain('server: GDELT Server');
    expect(line).toContain('retry-after: 30');
    expect(line).toContain('content-type: text/plain');
    expect(line).toContain('x-ratelimit-remaining: 0');
    expect(line).toContain('Please limit requests to one every 5 seconds or contact');
    expect(line).not.toMatch(/set-cookie|SECRET|authorization|x-something-else|NOT-ALLOWED/i);
    // Only exact names are printed: near-misses are not.
    expect(line).not.toMatch(/x-ratelimit-token|retry-debug|TOKEN-LIKE|INTERNAL-HOST/);
    const body = /body starts: "(.*)"$/.exec(line)?.[1] ?? '';
    expect(body.length).toBe(200);
    expect(lines.join('\n')).not.toMatch(/SECRET/);
  });

  test('every 429 in a backoff run is logged, and another non-answer status is too without moving lastAnsweredAt', async () => {
    const nt = net(() => refusal());
    const { lines } = await go(nt);
    expect(lines.filter((l) => /GDELT refused a request — HTTP 429/.test(l))).toHaveLength(nt.count());
    const five = net(() => ({ status: 503, body: 'try later', headers: { server: 'GDELT Server', 'x-other': 'no' } }));
    const r = await go(five, { circuit: priorCircuit(LIMITS.circuitCooldownMs + 60_000, { lastAnsweredAt: OLD_ANSWER }) });
    const line = r.lines.find((l) => /GDELT refused a request — HTTP 503/.test(l)) ?? '';
    expect(line).toContain('server: GDELT Server');
    expect(line).toContain('"try later"');
    expect(line).not.toContain('x-other');
    // A 503 is not an answer: lastAnsweredAt stays what it was.
    expect(r.circuit?.lastAnsweredAt).toBe(OLD_ANSWER);
  });

  test('a 503 does not set lastAnsweredAt: the next question is refused and the reopened circuit carries none', async () => {
    const moments = {
      ...MOMENTS,
      'second-question': { status: 'live', aliases: { en: ['second topic'], es: [] }, vehicles: [{ slug: 'hr-1-119' }] },
    };
    const bills = [...BILLS, { full_identifier: 'hr-1-119', press_names: null, short_title: null, news_query: 'y', sponsor_bioguide_id: 'J000298' }];
    const nt = net((n) => (n === 1 ? { status: 503, body: 'try later', headers: {} } : refusal()));
    const r = await go(nt, { moments, bills });
    expect(nt.count()).toBeGreaterThan(1);
    expect(r.circuit).toMatchObject({ open: true, reason: '429' });
    expect(r.circuit?.lastAnsweredAt).toBeUndefined();
    expect(r.lines.some((l) => /last answered never on record/.test(l))).toBe(true);
  });

  test('refusalEvidence: headers may be a Headers object or absent; an unread body says so', () => {
    const h = new Headers({ Server: 'GDELT Server', 'Set-Cookie': 'a=b', 'Retry-After': '5' });
    const line = refusalEvidence({ status: 429, headers: h }, null);
    expect(line).toContain('server: GDELT Server');
    expect(line).toContain('retry-after: 5');
    expect(line).not.toMatch(/cookie/i);
    expect(line).toContain('(body not yet received)');
    expect(refusalEvidence({ status: 429 }, 'hi')).toContain('(none of the loggable ones)');
  });

  test('readCircuit keeps the extra fields; a state file without them still reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gdelt-evidence-'));
    const withNew = join(dir, 'a.json');
    writeFileSync(withNew, JSON.stringify({ circuit: priorCircuit(1000, { lastAnsweredAt: OLD_ANSWER, reopenedAt: OLD_ANSWER }) }));
    expect(readCircuit(withNew)).toMatchObject({ lastAnsweredAt: OLD_ANSWER, reopenedAt: OLD_ANSWER });
    const old = join(dir, 'b.json');
    writeFileSync(old, JSON.stringify({ circuit: priorCircuit(1000) }));
    const c = readCircuit(old);
    expect(c).toMatchObject({ open: true, openedAt: FIRST_OPENED });
    expect(c?.lastAnsweredAt).toBeUndefined();
  });

  test('a 429 whose body never finishes changes no request time and no lastTryAt (fake clock, main\'s constants)', async () => {
    // main's constants: a 429 waits 30 s, then 90 s; spacing is 6 s.
    const [b1, b2] = [30_000, 90_000];
    expect(LIMITS.spacingMs).toBe(6_000);
    const hung = net(() => ({ ...refusal(), hang: true }));
    const prompt = net(() => refusal());
    const a = await go(hung);
    const b = await go(prompt);
    // Requests go out at 0, +30 s, +30 s +90 s: the same with and without a body.
    expect(hung.times).toEqual([0, b1, b1 + b2]);
    expect(hung.times).toEqual(prompt.times);
    expect(a.circuit?.lastTryAt).toBe(new Date(NOW + b1 + b2).toISOString());
    expect(a.circuit?.lastTryAt).toBe(b.circuit?.lastTryAt);
    expect(a.circuit).toMatchObject({ open: true, reason: '429', tries: 1 });
    expect(a.lines.some((l) => /GDELT refused a request — HTTP 429.*\(body not yet received\)/.test(l))).toBe(true);
    // Half-open probe: one request at the start, lastTryAt is that moment, not 30 s later.
    const probe = net(() => ({ ...refusal(), hang: true }));
    const p = await go(probe, { circuit: priorCircuit(LIMITS.circuitCooldownMs + 60_000) });
    expect(probe.times).toEqual([0]);
    expect(p.circuit?.lastTryAt).toBe(new Date(NOW).toISOString());
  });
});
