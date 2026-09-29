import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { expect, test } from '@playwright/test';
import { NextRequest } from 'next/server';
// Relative imports (not '@/'), as in tests/stripe-webhook.unit.spec.ts. This
// route loads in a unit spec: the installed @anthropic-ai/sdk ships a CommonJS
// build, and `new Anthropic()` does not throw without a key.
import { POST } from '../app/api/brand/route';
import { fetchGuarded } from '../lib/brand-fetch';
import { createRateLimiter } from '../lib/ratelimit';
import { EMBEDS_PAGES_PUBLIC } from '../lib/site';
import { COUNTERS_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * /api/brand is OFF while the /embeds pages are hidden. Owner, 2026-09-29:
 * "brand off". The switch is lib/site.ts's EMBEDS_PAGES_PUBLIC (from #353).
 *
 * The property that matters is ORDER: the route spends money (one Anthropic
 * call per miss, up to 250 a day, about $2/day) and fetches a caller-chosen
 * site, so "off" means the 404 comes before anything else runs. Each of the
 * route's steps gets an instrument here:
 *
 *   - both limiters: the counters database, pointed at MockUpstash the way
 *     the brand-day tests in tests/ratelimit.unit.spec.ts do it, so any
 *     isLimited() call shows up as a request to it;
 *   - any other fetch(): recorded and refused (installUpstashFetch's
 *     passthrough);
 *   - the site fetch (fetchGuarded, which uses node:https): https.request is
 *     replaced with a recorder that fails the request, so even a broken guard
 *     cannot reach the network from this file;
 *   - the model: Anthropic.Messages.prototype.create is replaced with a
 *     recorder that throws, so even a broken guard cannot spend.
 *
 * The first test proves each instrument sees its step. Without it, a zero
 * count below could just mean an instrument that watches nothing.
 */

let restoreEnv: () => void;
let restoreFetch: () => void;
let counters: MockUpstash;
let otherFetches: string[];
let siteRequests: string[];
let modelCalls: number;

const realHttpsRequest = https.request;
const realCreate = Anthropic.Messages.prototype.create;

test.beforeEach(() => {
  restoreEnv = setUpstashEnv();
  counters = new MockUpstash();
  otherFetches = [];
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters }, async (url) => {
    otherFetches.push(url);
    throw new Error('blocked in unit test');
  });

  siteRequests = [];
  (https as { request: unknown }).request = (target: unknown) => {
    siteRequests.push(String(target));
    const req = Object.assign(new EventEmitter(), {
      end: () => setImmediate(() => req.emit('error', new Error('blocked in unit test'))),
    });
    return req;
  };

  modelCalls = 0;
  Anthropic.Messages.prototype.create = function blockedCreate() {
    modelCalls += 1;
    throw new Error('blocked in unit test');
  } as typeof realCreate;
});

test.afterEach(() => {
  restoreFetch();
  restoreEnv();
  (https as { request: unknown }).request = realHttpsRequest;
  Anthropic.Messages.prototype.create = realCreate;
});

function brandRequest(ip: string): NextRequest {
  return new NextRequest('http://localhost/api/brand', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    // A real public site, so the live path would fetch it and call the model.
    body: JSON.stringify({ url: 'https://example.com' }),
  });
}

test('control: each instrument sees the step it watches', async () => {
  await createRateLimiter({ route: 'brand', max: 5, windowSec: 600 }).isLimited('192.168.40.1');
  expect(counters.callsAttempted, 'a limiter check reaches the counters mock').toBeGreaterThan(0);

  const page = await fetchGuarded('https://example.com/', {
    maxBytes: 1024,
    timeoutMs: 1000,
    maxRedirects: 0,
    contentTypes: ['text/html'],
  });
  expect(page.ok).toBe(false);
  expect(siteRequests, 'fetchGuarded goes through the https.request recorder').toEqual([
    'https://example.com/',
  ]);

  const client = new Anthropic({ apiKey: 'unit-test-not-a-key' });
  expect(() =>
    client.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'x' }],
    }),
  ).toThrow('blocked in unit test');
  expect(modelCalls, 'a client call goes through the Messages recorder').toBe(1);
  expect(otherFetches).toEqual([]);
});

test.describe('while the switch is off', () => {
  test.skip(EMBEDS_PAGES_PUBLIC, 'The /embeds pages are public again, so /api/brand is live (tests/embed-brand-route.spec.ts).');

  test('POST answers 404 not_found and touches no limiter, no body, no fetch and no model', async () => {
    const req = brandRequest('192.168.40.2');
    const res = await POST(req);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });

    expect(req.bodyUsed, 'the body is never read').toBe(false);
    expect(counters.callsAttempted, 'neither limiter ran').toBe(0);
    expect(counters.commands).toEqual([]);
    expect(siteRequests, 'no site fetch').toEqual([]);
    expect(otherFetches, 'no other fetch').toEqual([]);
    expect(modelCalls, 'no Anthropic call').toBe(0);
  });

  test('a burst past the per-IP limit still gets 404, never 429: the limiter is never reached', async () => {
    // The per-IP limit is 5 per 10 minutes; a 6th request that reached it
    // would answer 429.
    for (let i = 1; i <= 8; i += 1) {
      const res = await POST(brandRequest('192.168.40.3'));
      expect(res.status, `request ${i}`).toBe(404);
    }
    expect(counters.callsAttempted).toBe(0);
    expect(modelCalls).toBe(0);
  });
});

/*
 * The same order, read from the source. This half holds whichever way the
 * switch is set: the guard is POST's first statement and a bare early return,
 * and nothing else in the route reads the switch, so with the switch on the
 * handler runs exactly the code it ran before.
 */
test('the guard is the first statement in POST, ahead of every step that can spend or fetch', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/brand/route.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  expect(code).toContain("import { EMBEDS_PAGES_PUBLIC } from '@/lib/site';");

  const postOpen = 'export async function POST(req: NextRequest) {';
  const guard =
    "if (!EMBEDS_PAGES_PUBLIC) {\n    return NextResponse.json({ error: 'not_found' }, { status: 404 });\n  }";
  const post = code.indexOf(postOpen);
  const guardAt = code.indexOf(guard);
  expect(post, 'anchor: POST').toBeGreaterThan(-1);
  expect(guardAt, 'anchor: the guard').toBeGreaterThan(post);
  expect(code.slice(post + postOpen.length, guardAt).trim(), 'nothing runs before the guard').toBe('');

  for (const step of [
    'callerIp(req.headers)',
    'limiter.isLimited(ip)',
    'req.json()',
    'cache.get(origin)',
    'fetchGuarded(',
    'dayLimiter.isLimited(GLOBAL_BUCKET)',
    'anthropic.messages.create(',
    'noteBrandPreview()',
  ]) {
    const at = code.indexOf(step, post);
    expect(at, `anchor: ${step}`).toBeGreaterThan(-1);
    expect(at, `${step} must come after the guard`).toBeGreaterThan(guardAt);
  }

  expect(
    code.split('EMBEDS_PAGES_PUBLIC').length - 1,
    'the switch is read in exactly two places: the import and the guard',
  ).toBe(2);
});
