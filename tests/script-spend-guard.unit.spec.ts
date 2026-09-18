import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { __resetFallbackLogForTests, counterKey, createTenantRateLimiter } from '../lib/ratelimit';
import { getUpstashErrorCounts } from '../lib/upstash';
import { COUNTERS_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * /api/script's SPEND GUARDS (spend-guards, 2026-09-18).
 *
 * Two changes are pinned here, and they are a pair — neither is safe alone:
 *
 *   1. The per-caller ceiling rose 8 -> 20 per 600s. On its own that is a
 *      strictly larger bill.
 *   2. A GLOBAL daily breaker ('script-day', keyed by the constant
 *      'script-global') now bounds the DAY across every caller at once —
 *      which is what the per-IP number was being asked to do badly, and what
 *      makes (1) safe.
 *
 * The behavioural half of (2) is tested against the MockUpstash exactly the
 * way brand-day's is (tests/ratelimit.unit.spec.ts), because it is the same
 * limiter with a different label.
 *
 * The WIRING half is asserted over route source text, for the reason
 * tests/embed-script-route.spec.ts states in its own header: this route
 * cannot be require()d in a unit spec (it transitively pulls an ESM-only
 * dependency). The properties below are the ones that are invisible in a diff
 * and expensive in production if they drift — fail-closed, the numbers
 * themselves, and the breaker's POSITION relative to the cache read. A cache
 * hit that consumed the breaker would let free traffic dark a paid feature
 * for everyone, and nothing but ordering prevents it. Each assertion anchors
 * itself first, so a rename fails loudly rather than passing vacuously.
 */

const routeSrc = readFileSync(join(process.cwd(), 'app/api/script/route.ts'), 'utf8');
const panelSrc = readFileSync(join(process.cwd(), 'components/ActionPanel.tsx'), 'utf8');
const en = JSON.parse(readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8'));
const es = JSON.parse(readFileSync(join(process.cwd(), 'messages/es.json'), 'utf8'));

/* ------------------------------------------------------------------ *
 * 1 · The numbers, as shipped.
 * ------------------------------------------------------------------ */

test('the per-caller ceiling is 20 per 600s, built from named constants (not inline magic numbers)', () => {
  expect(routeSrc).toMatch(/const SCRIPT_IP_MAX = 20;/);
  expect(routeSrc).toMatch(/const SCRIPT_IP_WINDOW_SEC = 600;/);
  expect(routeSrc).toMatch(
    /route: 'script',\s*\n\s*max: SCRIPT_IP_MAX,\s*\n\s*windowSec: SCRIPT_IP_WINDOW_SEC,/
  );
});

test('the global daily breaker is 1,800, env-overridable, and a junk SCRIPT_DAY_MAX falls back to the default rather than removing the cap', () => {
  expect(routeSrc).toMatch(/const SCRIPT_DAY_MAX_DEFAULT = 1_800;/);
  expect(routeSrc).toMatch(/resolveDayMax\(process\.env\.SCRIPT_DAY_MAX\)/);
  // The guard itself: anything that is not a positive safe integer — unset,
  // '', 'abc', '0', '-5' — must land on the default. A typo'd env var must
  // never be read as "no ceiling", nor as a ceiling of nothing.
  expect(routeSrc).toMatch(
    /Number\.isSafeInteger\(parsed\) && parsed > 0 \? parsed : SCRIPT_DAY_MAX_DEFAULT/
  );
});

test('the breaker is a SPEND guard: failClosed, on the documented global bucket, never a caller or content key', () => {
  expect(routeSrc).toMatch(/const SCRIPT_GLOBAL_BUCKET = 'script-global';/);
  expect(routeSrc).toMatch(
    /createTenantRateLimiter\(\{\s*\n\s*route: 'script-day',\s*\n\s*max: SCRIPT_DAY_MAX,\s*\n\s*windowSec: 86_400,\s*\n\s*failClosed: true,/
  );
  expect(routeSrc).toMatch(/dayBreaker\.isLimited\(SCRIPT_GLOBAL_BUCKET\)/);
});

/* ------------------------------------------------------------------ *
 * 2 · WHERE the breaker sits — the property that keeps a cache hit free.
 * ------------------------------------------------------------------ */

test('a cache HIT can never consume the breaker: the check sits after the cache read and before the model call', () => {
  const cacheGet = routeSrc.indexOf('const cached = await cache.get(key);');
  const cacheHitReturn = routeSrc.indexOf(
    'if (cached) return NextResponse.json({ script: cached, cached: true });'
  );
  const breaker = routeSrc.indexOf('await dayBreaker.isLimited(SCRIPT_GLOBAL_BUCKET)');
  const generate = routeSrc.indexOf('await anthropic.messages.create(');
  expect(cacheGet, 'anchor: the cache read').toBeGreaterThan(-1);
  expect(cacheHitReturn, 'anchor: the cache-hit early return').toBeGreaterThan(-1);
  expect(breaker, 'anchor: the breaker check').toBeGreaterThan(-1);
  expect(generate, 'anchor: the Anthropic call').toBeGreaterThan(-1);

  expect(cacheHitReturn, 'the cache hit must return BEFORE the breaker is consulted').toBeLessThan(
    breaker
  );
  expect(breaker, 'the breaker must be consulted BEFORE any money is spent').toBeLessThan(generate);
});

test('the breaker lives in serveScript, not in POST — so a bad body, an unknown slug, or a not-callable nomination never spends a unit of it', () => {
  const postStart = routeSrc.indexOf('export async function POST(');
  const serveStart = routeSrc.indexOf('async function serveScript(');
  const breaker = routeSrc.indexOf('await dayBreaker.isLimited(SCRIPT_GLOBAL_BUCKET)');
  expect(postStart).toBeGreaterThan(-1);
  expect(serveStart).toBeGreaterThan(postStart);
  expect(breaker, 'the only breaker check must be inside serveScript').toBeGreaterThan(serveStart);
  expect(routeSrc.split('dayBreaker.isLimited').length - 1, 'exactly one breaker check').toBe(1);
});

/* ------------------------------------------------------------------ *
 * 3 · The 429 the reader actually sees.
 * ------------------------------------------------------------------ */

test("a breaker trip answers 429 — bare on the token path, and `scope: 'daily'` on the citizen path so the panel can say something true", () => {
  expect(routeSrc).toMatch(
    /if \(tokenPath\) return NextResponse\.json\(\{ error: 'rate_limited' \}, \{ status: 429 \}\);/
  );
  expect(routeSrc).toMatch(
    /NextResponse\.json\(\{ error: 'rate_limited', scope: 'daily' \}, \{ status: 429 \}\)/
  );
});

test('the panel reads that scope and never borrows the per-caller wording for it', () => {
  // The per-caller copy says the reader asked for several scripts and that it
  // clears in about ten minutes. A reader who asked for one draft and hit a
  // site-wide daily cap was told neither of those things truthfully, which is
  // the whole reason this branch exists.
  expect(panelSrc).toMatch(/if \(b\.scope === 'daily'\) return \{ kind: 'paused' \};/);
  expect(panelSrc).toMatch(/t\('scriptPaused'\)/);
  expect(en.bill.scriptPaused, 'English copy present').toBeTruthy();
  expect(es.bill.scriptPaused, 'Spanish copy present — bilingual parity').toBeTruthy();
  expect(en.bill.scriptPaused).not.toBe(en.bill.rateLimited);
  // No countdown and no retry button ride with it: the reset is hours away,
  // and pressing the button cannot clear a cap the whole site shares.
  expect(panelSrc).toMatch(/error === 'paused' && stance && fallbackPristine && \(/);
  expect(panelSrc).toMatch(/\{error === 'generic' && stance && \(/);
});

/* ------------------------------------------------------------------ *
 * 4 · The breaker's own behaviour, against the mocked counters database.
 * ------------------------------------------------------------------ */

test.describe('script-day breaker behaviour', () => {
  test.describe.configure({ mode: 'serial' }); // shared env + global-fetch swaps

  let restoreFetch: (() => void) | null = null;
  let restoreEnv: (() => void) | null = null;

  test.afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    restoreEnv?.();
    restoreEnv = null;
  });

  test('counts a fixed 24h window on ONE global key and trips at the ceiling', async () => {
    restoreEnv = setUpstashEnv();
    const mock = new MockUpstash();
    restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

    const breaker = createTenantRateLimiter({
      route: 'script-day',
      max: 3,
      windowSec: 86_400,
      failClosed: true,
    });
    for (let i = 1; i <= 3; i += 1) {
      expect(await breaker.isLimited('script-global'), `generation ${i} of 3 must pass`).toBe(false);
    }
    expect(await breaker.isLimited('script-global'), 'the 4th trips the ceiling').toBe(true);

    // ONE key, and it carries the window's TTL from creation — never a
    // TTL-less counter that could outlive its own day.
    expect(mock.keys()).toEqual([counterKey('script-day', 'script-global')]);
    expect(
      mock.commands.some((c) => c[0] === 'SET' && c.includes('NX') && c.includes('86400'))
    ).toBe(true);
  });

  test('is a GLOBAL bound, not a per-caller one: every caller shares the same counter', async () => {
    restoreEnv = setUpstashEnv();
    const mock = new MockUpstash();
    restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

    // Two instances = two serverless instances, the case the pre-S11 in-memory
    // window got wrong. A global spend ceiling that multiplies by instance
    // count is not a ceiling.
    const a = createTenantRateLimiter({
      route: 'script-day',
      max: 2,
      windowSec: 86_400,
      failClosed: true,
    });
    const b = createTenantRateLimiter({
      route: 'script-day',
      max: 2,
      windowSec: 86_400,
      failClosed: true,
    });
    expect(await a.isLimited('script-global')).toBe(false);
    expect(await b.isLimited('script-global')).toBe(false);
    expect(await a.isLimited('script-global'), "instance A sees B's spend").toBe(true);
    expect(await b.isLimited('script-global'), "and instance B sees A's").toBe(true);
  });

  test('the key carries no caller and no content material — only the route label and the documented constant', async () => {
    restoreEnv = setUpstashEnv();
    const mock = new MockUpstash();
    restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

    const breaker = createTenantRateLimiter({
      route: 'script-day',
      max: 5,
      windowSec: 86_400,
      failClosed: true,
    });
    await breaker.isLimited('script-global');

    for (const key of mock.keys()) {
      expect(key).toContain(':rl:script-day:script-global');
      // No slug, stance, locale or caller hash may ever reach a counters key.
      expect(key).not.toMatch(/sjres|support|oppose|undecided|[0-9a-f]{40}/);
    }
    // And no salt was ever read: this limiter is tenant-shaped, so it skips
    // the caller-hash machinery entirely.
    expect(mock.commands.some((c) => c[0] === 'GET' && c[1].endsWith(':salt:current'))).toBe(false);
  });

  test('an unreachable counters database REFUSES the generation (fail-closed), counted and logged', async () => {
    restoreEnv = setUpstashEnv();
    const mock = new MockUpstash();
    mock.failWithStatus = 503;
    restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

    const errorsBefore = getUpstashErrorCounts().counters;
    const realError = console.error;
    console.error = () => {};
    try {
      const breaker = createTenantRateLimiter({
        route: 'script-day',
        max: 1_800,
        windowSec: 86_400,
        failClosed: true,
      });
      // The FIRST call, not the 1,801st: with the day's count unknown there is
      // no headroom to claim. Declining to spend is recoverable; an outage
      // that silently multiplies the ceiling by instance count is not.
      expect(await breaker.isLimited('script-global')).toBe(true);
    } finally {
      console.error = realError;
    }
    expect(getUpstashErrorCounts().counters).toBeGreaterThan(errorsBefore);
  });

  test('an UNCONFIGURED counters database keeps the in-memory fallback, so local dev and CI are not darked', async () => {
    // No setUpstashEnv(): a deployment that opted out of durable counters is a
    // known shape announced by the startup line, not the unknown state an
    // outage creates. Same asymmetry brand-day documents.
    const mock = new MockUpstash();
    restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });
    __resetFallbackLogForTests();

    const realLog = console.log;
    console.log = () => {};
    try {
      const breaker = createTenantRateLimiter({
        route: 'script-day',
        max: 2,
        windowSec: 86_400,
        failClosed: true,
      });
      expect(await breaker.isLimited('script-global')).toBe(false);
      expect(await breaker.isLimited('script-global')).toBe(false);
      expect(await breaker.isLimited('script-global'), 'the in-memory ceiling still applies').toBe(
        true
      );
    } finally {
      console.log = realLog;
    }
    expect(mock.commands, 'must not touch the REST surface without env').toHaveLength(0);
  });
});
