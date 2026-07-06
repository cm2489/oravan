import { expect, test } from '@playwright/test';
// Relative import (not '@/'): the route only touches next/server, which
// resolves under the test runner - same pattern as the other unit specs.
import { POST } from '../app/api/feedback/route';

/*
 * Route-level tests for the beta-feedback intake. The GitHub call is mocked
 * by swapping global fetch, so no test touches the network - and every call
 * the route WOULD have made is captured, which is what lets the privacy
 * assertions below pin the exact outbound payload.
 */

const ISSUES_URL = 'https://api.github.com/repos/cm2489/rostra/issues';

// Distinct marker values: if any of these ever shows up in the outbound
// GitHub payload, an identifier leaked.
const CALLER_IP = '198.51.100.77';
const CALLER_UA = 'UnitTestBrowser/1.0 (leak-canary)';
const CALLER_COOKIE = 'session=leak-canary-cookie';

let ipCounter = 0;
function request(body: unknown, headers: Record<string, string> = {}) {
  ipCounter += 1;
  return new Request('http://localhost/api/feedback', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Unique IP per call by default: the route's in-memory rate limiter is
      // module state shared across the tests in this worker.
      'x-forwarded-for': `203.0.113.${ipCounter}`,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

type Captured = { url: string; init: RequestInit };

/** Replace global fetch; returns the captured outbound calls. */
function mockGithub(...responses: { status: number; body?: unknown }[]) {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 201 };
    return new Response(JSON.stringify(next.body ?? { number: 1 }), { status: next.status });
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;
const realToken = process.env.GITHUB_FEEDBACK_TOKEN;

test.beforeEach(() => {
  process.env.GITHUB_FEEDBACK_TOKEN = 'test-token';
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.GITHUB_FEEDBACK_TOKEN;
  else process.env.GITHUB_FEEDBACK_TOKEN = realToken;
});

test('happy path: creates one labeled issue and returns ok', async () => {
  const calls = mockGithub({ status: 201 });
  const res = await POST(request({ category: 'bug', message: 'The ZIP form eats my input.' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(ISSUES_URL);
  const payload = JSON.parse(String(calls[0].init.body));
  expect(payload.title).toBe('[beta:bug] The ZIP form eats my input.');
  expect(payload.labels).toEqual(['beta-feedback', 'bug']);
  expect(payload.body).toContain('The ZIP form eats my input.');
  const headers = calls[0].init.headers as Record<string, string>;
  expect(headers.Authorization).toBe('Bearer test-token');
});

test('the outbound payload contains no identifiers - only volunteered content', async () => {
  const calls = mockGithub({ status: 201 });
  const res = await POST(
    request(
      { category: 'feature', message: 'Please add bill sorting.', page: '/bills' },
      {
        'x-forwarded-for': CALLER_IP,
        'user-agent': CALLER_UA,
        cookie: CALLER_COOKIE,
        referer: 'http://localhost/secret-referer',
      }
    )
  );
  expect(res.status).toBe(200);
  expect(calls).toHaveLength(1);

  // The ENTIRE outbound request - URL, headers, and body - serialized.
  const outbound = JSON.stringify(calls[0]);
  expect(outbound).not.toContain(CALLER_IP);
  expect(outbound).not.toContain('leak-canary');
  expect(outbound).not.toContain('secret-referer');

  // And the issue itself is exactly the volunteered trio, nothing else.
  const payload = JSON.parse(String(calls[0].init.body));
  expect(Object.keys(payload).sort()).toEqual(['body', 'labels', 'title']);
  expect(payload.body).toBe('**Category:** feature\n**Page:** /bills\n\nPlease add bill sorting.');
});

test('honeypot tripped: same success shape as a real submission, nothing created', async () => {
  const calls = mockGithub({ status: 201 });
  const res = await POST(
    request({ category: 'bug', message: 'bot text', website: 'https://spam.example' })
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(calls).toHaveLength(0);
});

test('message length: empty and over-2000 are 400, exactly 2000 is accepted', async () => {
  const calls = mockGithub({ status: 201 }, { status: 201 });
  expect((await POST(request({ category: 'bug', message: '' }))).status).toBe(400);
  expect((await POST(request({ category: 'bug', message: '   ' }))).status).toBe(400);
  expect((await POST(request({ category: 'bug', message: 'x'.repeat(2001) }))).status).toBe(400);
  expect(calls).toHaveLength(0);
  expect((await POST(request({ category: 'bug', message: 'x'.repeat(2000) }))).status).toBe(200);
  expect(calls).toHaveLength(1);
});

test('bad input: unknown category, missing category, non-JSON body are 400', async () => {
  const calls = mockGithub({ status: 201 });
  expect((await POST(request({ category: 'praise', message: 'hi' }))).status).toBe(400);
  expect((await POST(request({ message: 'hi' }))).status).toBe(400);
  expect((await POST(request('not json'))).status).toBe(400);
  expect(calls).toHaveLength(0);
});

test('missing GITHUB_FEEDBACK_TOKEN: neutral 503, no outbound call', async () => {
  const calls = mockGithub({ status: 201 });
  delete process.env.GITHUB_FEEDBACK_TOKEN;
  const res = await POST(request({ category: 'other', message: 'hello' }));
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: 'unavailable' });
  expect(calls).toHaveLength(0);
});

test('label rejection (422): retries once without labels, title prefix is the taxonomy', async () => {
  const calls = mockGithub({ status: 422 }, { status: 201 });
  const res = await POST(request({ category: 'other', message: 'hello there' }));
  expect(res.status).toBe(200);
  expect(calls).toHaveLength(2);
  expect(JSON.parse(String(calls[0].init.body)).labels).toEqual(['beta-feedback', 'other']);
  const retry = JSON.parse(String(calls[1].init.body));
  expect(retry.labels).toBeUndefined();
  expect(retry.title).toBe('[beta:other] hello there');
});

test('GitHub hard failure: 502, and long titles are truncated to ~60 chars', async () => {
  const calls = mockGithub({ status: 500 });
  const longMessage = `${'word '.repeat(30)}tail`;
  const res = await POST(request({ category: 'bug', message: longMessage }));
  expect(res.status).toBe(502);
  const title = JSON.parse(String(calls[0].init.body)).title as string;
  expect(title.startsWith('[beta:bug] word word')).toBe(true);
  expect(title.endsWith('…')).toBe(true);
  expect(title.length).toBeLessThanOrEqual('[beta:bug] '.length + 61);
});

test('rate limit: the 9th request from one IP inside the window is 429', async () => {
  mockGithub(...Array.from({ length: 9 }, () => ({ status: 201 })));
  const sameIp = { 'x-forwarded-for': '192.0.2.200' };
  for (let i = 0; i < 8; i += 1) {
    const res = await POST(request({ category: 'bug', message: `note ${i}` }, sameIp));
    expect(res.status).toBe(200);
  }
  const res = await POST(request({ category: 'bug', message: 'one too many' }, sameIp));
  expect(res.status).toBe(429);
});

test('X-Rostra-Key is recognized but inert (S11 dormant tenancy hook): identical behavior, never forwarded', async () => {
  const calls = mockGithub({ status: 201 }, { status: 201 });
  const body = { category: 'bug', message: 'same message either way.' };

  const without = await POST(request(body));
  const withKey = await POST(request(body, { 'x-rostra-key': 'rk_leak-canary-key' }));
  expect(without.status).toBe(200);
  expect(withKey.status).toBe(200);
  expect(await withKey.json()).toEqual(await without.json());

  // Identical outbound issue payloads - the header changed nothing...
  expect(calls).toHaveLength(2);
  expect(String(calls[1].init.body)).toBe(String(calls[0].init.body));
  // ...and the key value never left the process.
  expect(JSON.stringify(calls[1])).not.toContain('rk_leak-canary-key');
});
