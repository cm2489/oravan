import { expect, test } from '@playwright/test';

/*
 * /api/brand driven at the real running server (request fixture, same
 * pattern as tests/embed-script-route.spec.ts). What CI can prove here is
 * exactly what matters most: the SSRF guard REJECTS hostile targets (400,
 * refused before any socket opens), the input taxonomy holds, and the
 * per-IP limiter trips. The happy path (a real external fetch + a real
 * Anthropic call) is deliberately NOT e2e-tested: the sandbox has no
 * ANTHROPIC_API_KEY, no hermetic external site, and adding a guard-bypass
 * test seam would BE the vulnerability. Extraction and mapping correctness
 * live in the unit layer (brand-extract/brandprompt/brand-guard specs); the
 * full path is item 1 of the PR's manual verification checklist.
 *
 * Distinct synthetic x-forwarded-for per test so this file's own limiter
 * traffic never interferes with itself across parallel workers (mirrors
 * embed-script-route's nextIp, in a different private /16).
 */

function nextIp(): string {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `192.168.${octet()}.${octet()}`;
}

async function post(
  request: import('@playwright/test').APIRequestContext,
  data: unknown,
  ip = nextIp()
) {
  return request.post('/api/brand', {
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    data: data as Record<string, unknown>,
  });
}

test('malformed JSON body -> 400 bad_request', async ({ request }) => {
  const res = await request.post('/api/brand', {
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    data: 'not json{{',
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ error: 'bad_request' });
});

test('missing / non-string / oversized url -> 400 bad_request', async ({ request }) => {
  for (const body of [{}, { url: 42 }, { url: null }, { url: 'https://x.com/' + 'a'.repeat(2100) }]) {
    const res = await post(request, body);
    expect(res.status(), JSON.stringify(body).slice(0, 60)).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
  }
});

test('SSRF guard: private/loopback/metadata/localhost/userinfo/port targets are refused with 400', async ({
  request,
}) => {
  for (const url of [
    'https://10.1.2.3/',
    'https://127.0.0.1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/',
    'https://[fd00::1]/',
    'http://localhost:3300/',
    'https://intranet/',
    'https://nas.local/',
    'https://user:pass@example.com/',
    'https://example.com:8443/',
    'file:///etc/passwd',
    'javascript:alert(1)',
  ]) {
    const res = await post(request, { url });
    expect(res.status(), url).toBe(400);
    expect(await res.json(), url).toEqual({ error: 'bad_request' });
  }
});

test('per-IP limiter: the 6th request from one caller is 429, uniform body', async ({
  request,
}) => {
  const ip = nextIp();
  for (let i = 0; i < 5; i++) {
    const res = await post(request, { url: 'https://10.0.0.1/' }, ip);
    expect(res.status(), `request ${i + 1} should still be judged on its merits`).toBe(400);
  }
  const sixth = await post(request, { url: 'https://10.0.0.1/' }, ip);
  expect(sixth.status()).toBe(429);
  expect(await sixth.json()).toEqual({ error: 'rate_limited' });
});

test('a fresh caller is unaffected by another IP hitting its limit', async ({ request }) => {
  const res = await post(request, { url: 'https://10.9.9.9/' });
  expect(res.status()).toBe(400); // judged on the merits, not rate_limited
});
