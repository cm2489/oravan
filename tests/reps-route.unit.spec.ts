import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { NextRequest } from 'next/server';
import { GET, POST } from '../app/api/reps/route';

/*
 * /api/reps takes the ZIP in a POST body, never in its address (2026-10-06).
 * The host's request logs keep each request's path with its query string, so
 * `GET /api/reps?zip=…` left the visitor's ZIP there next to their network
 * address. The real handler, driven directly: the good ZIP, the bad ZIP, the
 * rate limit (still keyed on the caller alone), and GET's refusal.
 *
 * Upstash is unset in the unit run, so the limiter is the per-instance
 * in-memory window: the same counting, the same 300 ceiling. Each test uses
 * its own caller address so the module-level limiter never carries one
 * test's traffic into another.
 */

let octet = 0;
const nextIp = () => `198.51.100.${++octet}`;

function post(body: unknown, ip: string, contentType = 'application/json') {
  return POST(
    new NextRequest('http://localhost/api/reps', {
      method: 'POST',
      headers: { 'content-type': contentType, 'x-forwarded-for': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

test.describe('POST /api/reps', () => {
  test('a good ZIP answers its members, vacancies and the multi-district flag', async () => {
    const res = await post({ zip: '78501' }, nextIp());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect((body.reps as Array<{ name: string }>).map((r) => r.name)).toEqual(
      expect.arrayContaining(['Monica De La Cruz', 'John Cornyn', 'Ted Cruz'])
    );
    expect(body.vacancies).toEqual([]);
    expect(body.multiDistrict).toBe(false);
  });

  test('a split ZIP says so, and a vacant seat is named (fact only)', async () => {
    const split = await (await post({ zip: '10001' }, nextIp())).json();
    expect(split.multiDistrict).toBe(true);
    const vacant = await (await post({ zip: '33313' }, nextIp())).json();
    expect(vacant.vacancies).toEqual([{ state: 'FL', district: 20 }]);
  });

  test('an unmatched but well-formed ZIP is a 200 with no members (the contract the widgets read)', async () => {
    const res = await post({ zip: '00000' }, nextIp());
    expect(res.status).toBe(200);
    expect((await res.json()).reps).toEqual([]);
  });

  for (const [label, body] of [
    ['letters', { zip: 'abcde' }],
    ['four digits', { zip: '7850' }],
    ['ZIP+4', { zip: '78501-1234' }],
    ['a number, not a string', { zip: 78501 }],
    ['no zip field', { postal: '78501' }],
    ['a JSON array', ['78501']],
    ['JSON null', null],
  ] as const) {
    test(`a bad ZIP (${label}) is a 400 bad_zip that echoes nothing`, async () => {
      const res = await post(body, nextIp());
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('{"error":"bad_zip"}');
    });
  }

  test('a body that is not JSON is a 400 bad_request', async () => {
    const res = await post('zip=78501', nextIp(), 'application/x-www-form-urlencoded');
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('{"error":"bad_request"}');
  });

  test('a ZIP in the address of a POST is not read: only the body counts', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/reps?zip=78501', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_zip' });
  });
});

test.describe('the rate limit is keyed on the caller, never the ZIP', () => {
  test('300 lookups across different ZIPs share one caller counter; the 301st is a bare 429; another caller is untouched', async () => {
    const ip = nextIp();
    const zips = ['78501', '33313', '10001', '20002', '19973'];
    for (let i = 0; i < 300; i++) {
      const res = await post({ zip: zips[i % zips.length] }, ip);
      expect(res.status, `request ${i + 1} is inside the window`).toBe(200);
    }
    // A ZIP this caller has not sent before still lands on the same counter:
    // were the ZIP part of the key, this would be a fresh window and a 200.
    const over = await post({ zip: '90210' }, ip);
    expect(over.status).toBe(429);
    expect(await over.text()).toBe('{"error":"rate_limited"}');
    expect(over.headers.get('retry-after')).toBeNull();
    for (const [name, value] of over.headers.entries()) {
      expect(value, `header "${name}" must not echo the ZIP`).not.toContain('90210');
      expect(value, `header "${name}" must not echo the caller`).not.toContain(ip);
    }

    const fresh = await post({ zip: '90210' }, nextIp());
    expect(fresh.status).toBe(200);
  });

  test('the limiter is consulted before the body is read: a saturated caller gets 429 even for a bad body', async () => {
    const ip = nextIp();
    for (let i = 0; i < 300; i++) await post({ zip: '78501' }, ip);
    const res = await post('not json', ip, 'text/plain');
    expect(res.status).toBe(429);
  });

  test('the route source hands the limiter callerIp() and nothing else', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('app/api/reps/route.ts', 'utf8');
    const calls = [...source.matchAll(/limiter\.isLimited\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls).toEqual(['ip']);
    expect(source).toMatch(/const ip = callerIp\(req\.headers\);/);
  });
});

test.describe('GET /api/reps (the decision: refused, so the promise is mechanical)', () => {
  test('GET is 405 with Allow: POST, whatever the address carries', async () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(await res.text()).toBe('{"error":"method_not_allowed"}');
  });

  test('GET takes no request at all, so it cannot read a ZIP from one', () => {
    expect(GET.length).toBe(0);
  });
});

test.describe('the ZIP-out-of-addresses gate (scripts/check-zip-urls.mjs)', () => {
  const runGate = (...args: string[]) =>
    spawnSync('node', ['scripts/check-zip-urls.mjs', ...args], { cwd: process.cwd(), encoding: 'utf8' });

  test('the tree is clean: no request to our own routes carries a ZIP in its address', () => {
    const result = runGate();
    expect(result.stderr, 'gate must report no violations').toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('zip-urls gate clean');
  });

  test('the gate has teeth: every seeded violation (the six lookups as they shipped among them) is caught', () => {
    const result = runGate('--self-test');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/all \d+ seeded violations caught, \d+ clean samples pass/);
  });
});
