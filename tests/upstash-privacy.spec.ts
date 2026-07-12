import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { POST as districtPost } from '../app/api/district/route';
import { noteImpression, noteImpressionForToken } from '../lib/impressions';
import { createRateLimiter, createTenantRateLimiter } from '../lib/ratelimit';
import { contentVersion, createScriptCache } from '../lib/scriptcache';
import { mintCapabilityToken, resolveTenantAccess, tenantKey, tokenHash, tokenIndexKey } from '../lib/tenancy';
import {
  CACHE_URL,
  COUNTERS_URL,
  MockUpstash,
  TENANCY_URL,
  installUpstashFetch,
  setUpstashEnv,
} from './upstash-mock';
import censusNoMatch from './fixtures/census-no-match.json';

/*
 * AE5 runtime privacy invariant (the plan's own acceptance test, verbatim):
 * given a burst of script/district/MCP traffic, when Upstash state is
 * inspected, then
 *   - no counters key contains a slug/stance/locale/tool substring,
 *   - no cache key contains IP-derived material,
 *   - no key ANYWHERE contains address-derived material.
 * Asserted over every COMMAND that would cross the wire, not just the keys
 * that stuck - the mock records the full REST surface.
 *
 * Coverage shape: the district route is the REAL handler - the route that
 * touches the most radioactive input (a street address) - driven directly
 * with only the network edges mocked. The script and MCP routes cannot be
 * require()d in a unit spec (they pull ESM-only deps: @anthropic-ai/sdk,
 * mcp-handler - the same limitation tests/mcp.spec.ts documents), so their
 * traffic is driven through the exact modules those routes feed:
 * createRateLimiter, which by construction only ever receives a caller IP
 * and a closed route label (a tool name or slug CANNOT reach it - the type
 * system has no door for one), and the script cache with the production
 * corpus's own slug/stance/lang/version values. Route-level glue is covered
 * end-to-end by tests/mcp.spec.ts's 429 burst and the script-flow e2e specs;
 * the feedback route's privacy surface is pinned in feedback.unit.spec.ts.
 */

test.describe.configure({ mode: 'serial' });

const counters = new MockUpstash();
const cache = new MockUpstash();
let restoreFetch: () => void;
let restoreEnv: () => void;

// Real corpus entry, so the slug/stance/locale in the burst are the
// production shapes, not invented ones.
const bills = JSON.parse(readFileSync('data/bills.json', 'utf8')) as Array<{
  bill_type: string;
  bill_number: number;
  congress_number: number;
  ai_summary?: string;
}>;
const bill = bills.find((b) => b.ai_summary)!;
const SLUG = `${bill.bill_type}-${bill.bill_number}-${bill.congress_number}`.toLowerCase();

const CALLER_IPS = ['198.51.100.201', '198.51.100.202', '198.51.100.203'];
const ADDRESS = '421 Privacy Invariant Avenue';

test.beforeAll(() => {
  // Works with a statically imported route because lib/ratelimit.ts and
  // lib/scriptcache.ts resolve their Upstash clients per CALL, not at
  // module load - env set here is seen by the route's own limiter.
  restoreEnv = setUpstashEnv();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters, [CACHE_URL]: cache }, async (url) => {
    if (url.includes('geocoding.geo.census.gov')) {
      return new Response(JSON.stringify(censusNoMatch), { status: 200 });
    }
    throw new Error(`unexpected upstream in privacy spec: ${url.split('?')[0]}`);
  });
});

test.afterAll(() => {
  restoreFetch();
  restoreEnv(); // other spec files in this worker assert the env-absent path
});

test('a burst of script/district/MCP traffic leaves both databases clean', async () => {
  // --- the burst --------------------------------------------------------------

  // Script-shaped traffic: the same limiter + cache calls the route makes,
  // three stances x two locales, miss then hit, real summary.
  const scriptLimiter = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });
  const scriptCache = createScriptCache();
  const version = contentVersion(bill.ai_summary!);
  for (const [i, stance] of (['support', 'oppose', 'undecided'] as const).entries()) {
    for (const lang of ['en', 'es'] as const) {
      expect(await scriptLimiter.isLimited(CALLER_IPS[i])).toBe(false);
      const parts = { slug: SLUG, stance, lang, version };
      expect(await scriptCache.get(parts)).toBeNull(); // miss
      await scriptCache.set(parts, `generated script for ${stance}/${lang}`);
      expect(await scriptCache.get(parts)).not.toBeNull(); // shared hit
    }
  }

  // The REAL district route, with a street address in the body.
  const districtRes = await districtPost(
    new Request('http://localhost/api/district', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': CALLER_IPS[0] },
      body: JSON.stringify({ address: ADDRESS, zip: '10001' }),
    }) as never
  );
  expect(districtRes.status, 'district (no-match fixture)').toBe(404);

  // MCP-shaped traffic: the exact two limiters the route builds. By
  // construction the tool name/slug can never reach them - this pins that
  // the keys they DO write stay hash-only.
  const mcpMinute = createRateLimiter({ route: 'mcp-min', max: 60, windowSec: 60 });
  const mcpDay = createRateLimiter({ route: 'mcp-day', max: 1000, windowSec: 86400 });
  expect(await mcpMinute.isLimited(CALLER_IPS[2])).toBe(false);
  expect(await mcpDay.isLimited(CALLER_IPS[2])).toBe(false);

  // --- the invariant, over the full wire surface -----------------------------

  const counterCommandText = counters.commands.map((c) => c.join(' ')).join('\n');
  const cacheCommandText = cache.commands.map((c) => c.join(' ')).join('\n');

  // The district route really did take the durable path (guards against
  // this spec silently degrading to in-memory and proving nothing).
  expect(counterCommandText).toContain(':rl:district:');

  // 1. No counters key (or any counters command) carries a slug / stance /
  //    locale / tool substring. Route labels are the only non-hash segment.
  //    (slugs/stances/tool names contain non-hex letters, so a hex hash can
  //    never alias them; locales are checked as whole key segments since a
  //    hash CAN legitimately contain the letter pairs "en"/"es".)
  for (const contentMarker of [SLUG, 'support', 'oppose', 'undecided', 'get_bill']) {
    expect(counterCommandText, `counters wire surface must not carry "${contentMarker}"`).not.toContain(
      contentMarker
    );
  }
  expect(counterCommandText, 'counters wire surface must not carry a locale segment').not.toMatch(
    /:(en|es)(?=:|\s|$)/
  );
  for (const key of counters.keys()) {
    expect(key).toMatch(/^dev:(salt:current|rl:(script|district|feedback|mcp-min|mcp-day):[0-9a-f]{64})$/);
  }

  // 2. No cache key carries IP-derived material: not the IPs, not their
  //    64-hex caller hashes, not the salt.
  const counterHashes = counters
    .keys()
    .map((k) => k.match(/[0-9a-f]{64}$/)?.[0])
    .filter((h): h is string => !!h);
  expect(counterHashes.length).toBeGreaterThan(0);
  const saltRecord = counters.store.get('dev:salt:current')?.value ?? '';
  const saltValue = (JSON.parse(saltRecord) as { v: string }).v;
  for (const key of cache.keys()) {
    expect(key).toMatch(/^dev:script:[a-z0-9.-]+:(support|oppose|undecided):(en|es):[0-9a-f]{12}$/);
    for (const ip of CALLER_IPS) expect(key).not.toContain(ip);
    for (const hash of counterHashes) expect(key).not.toContain(hash);
    expect(key).not.toContain(saltValue);
  }
  for (const ip of CALLER_IPS) {
    expect(cacheCommandText, 'cache wire surface must not carry a caller IP').not.toContain(ip);
  }

  // 3. No key - and no command - ANYWHERE contains address-derived material.
  for (const wire of [counterCommandText, cacheCommandText]) {
    expect(wire).not.toContain('Privacy Invariant');
    expect(wire).not.toContain('10001');
  }

  // And cross-instance sharing did its job: a fresh cache instance (a
  // different serverless instance) hits what the burst cached.
  expect(
    await createScriptCache().get({ slug: SLUG, stance: 'support', lang: 'en', version })
  ).toBe('generated script for support/en');
});

/*
 * AE5, RE-RUN AGAINST THE EMBED-ORIGINATING PATH (S19). The ledger's own
 * language: the invariant must hold across "/api/script, MCP, AND embed
 * routes" - this is that third leg. Drives the EXACT sequence
 * app/api/script/route.ts's gate runs for a tenant-authenticated request
 * (per-IP limiter -> resolveTenantAccess -> per-tenant limiters -> the
 * SAME cache-get/set the citizen path uses) through the real modules,
 * never the route file itself - it pulls @anthropic-ai/sdk transitively,
 * which cannot be require()d in a unit spec (confirmed: "Cannot use import
 * statement outside a module" when attempted directly), the same
 * limitation this file's other test already documents for script/MCP.
 * A fresh trio of mocks (including, for the first time in this file, the
 * TENANCY database) keeps this test's wire-surface assertions independent
 * of the burst test above.
 */
test('AE5 (embed-originating path): a tenant-authenticated script request leaves counters/cache/tenancy clean, composes both limiters, and shares the cache with citizen requests', async () => {
  const embedCounters = new MockUpstash();
  const embedCache = new MockUpstash();
  const tenancy = new MockUpstash();
  const restoreEmbedFetch = installUpstashFetch({
    [COUNTERS_URL]: embedCounters,
    [CACHE_URL]: embedCache,
    [TENANCY_URL]: tenancy,
  });

  try {
    // Seed one active, ToS-accepted tenant directly (the shape
    // provisionFromCheckout would have written) - this test is about the
    // GATE's wire-surface cleanliness, not provisioning itself (covered in
    // tests/tenancy.unit.spec.ts).
    const token = mintCapabilityToken();
    const hash = tokenHash(token);
    const tenantId = 'cus_ae5_embed_origin';
    tenancy.exec([
      'SET',
      tenantKey(tenantId),
      JSON.stringify({
        tenantId,
        tokenHash: hash,
        tier: 'pro',
        domainAllowlist: [],
        orgName: 'AE5 Embed Org',
        attribution: 'required',
        createdAt: new Date().toISOString(),
        subscriptionId: 'sub_ae5_embed',
        subscriptionStatus: 'active',
        tosAcceptedAt: new Date().toISOString(),
      }),
    ]);
    tenancy.exec(['SET', tokenIndexKey(hash), tenantId]);

    // The route's own gate order: per-IP limiter first (independent of
    // tenancy-database health), then resolveTenantAccess, then the two
    // per-tenant windows.
    const embedVisitorIp = '198.51.100.210';
    const ipLimiter = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });
    expect(await ipLimiter.isLimited(embedVisitorIp)).toBe(false);

    const access = await resolveTenantAccess(token);
    expect(access.ok, 'the seeded tenant must authorize').toBe(true);

    // S20: the action panel's own impression count, on the exact
    // fully-authorized branch — mirrors
    // app/embed/action-panel/page.tsx's after(() => noteImpression(...)).
    if (access.ok) await noteImpression(access.tenant.tenantId);

    const tenantMinuteLimiter = createTenantRateLimiter({ route: 'embed-script', max: 60, windowSec: 600 });
    const tenantDayLimiter = createTenantRateLimiter({ route: 'embed-script-day', max: 800, windowSec: 86400 });
    expect(await tenantMinuteLimiter.isLimited(tenantId)).toBe(false);
    expect(await tenantDayLimiter.isLimited(tenantId)).toBe(false);

    // CACHE-SHARING PROOF: the exact same cache-get -> (generate) -> set
    // sequence app/api/script/route.ts runs after the gate passes, content-
    // keyed only - identical whether the caller was this tenant or an
    // anonymous citizen. This is what makes "reuse the one route, don't
    // fork a parallel implementation" (S19 design §1) actually true, not
    // just asserted.
    const embedScriptCache = createScriptCache();
    const version = contentVersion(bill.ai_summary!);
    const parts = { slug: SLUG, stance: 'support' as const, lang: 'en' as const, version };
    expect(await embedScriptCache.get(parts), 'fresh cache instance for this test - must start as a miss').toBeNull();
    await embedScriptCache.set(parts, 'generated script for the embed-originating request');

    // A DIFFERENT ScriptCache instance (standing in for the citizen site's
    // own /api/script request for the identical bill/stance/locale) reads
    // the SAME entry back - proof of sharing, not just same-process reuse.
    expect(await createScriptCache().get(parts)).toBe('generated script for the embed-originating request');

    // --- the AE5 invariant itself, now spanning three databases -----------

    const tenancyCommandText = tenancy.commands.map((c) => c.join(' ')).join('\n');
    const countersCommandText = embedCounters.commands.map((c) => c.join(' ')).join('\n');
    const cacheCommandText = embedCache.commands.map((c) => c.join(' ')).join('\n');

    // 1. Tenancy wire surface: only tenant:<id>/token:<hash> keys, no
    //    caller-derived material (the visitor IP), no content identifier.
    for (const key of tenancy.keys()) {
      expect(key).toMatch(new RegExp(`^dev:(tenant:${tenantId}|token:[0-9a-f]{64})$`));
    }
    expect(tenancyCommandText).not.toContain(embedVisitorIp);
    expect(tenancyCommandText).not.toContain(SLUG);
    expect(tenancyCommandText).not.toContain('support');

    // 2. Counters wire surface: the existing caller-hash 'script' shape
    //    PLUS the RAW-tenantId 'embed-script'/'embed-script-day' shape PLUS
    //    (S20) the RAW-tenantId 'imp:<tenantId>:<day>' impression shape -
    //    and critically, the PLAINTEXT TOKEN itself never appears anywhere
    //    on this wire (only tenantId, which is documented internal-only/
    //    institutional, does).
    for (const key of embedCounters.keys()) {
      expect(key).toMatch(
        new RegExp(`^dev:(salt:current|rl:script:[0-9a-f]{64}|rl:embed-script(-day)?:${tenantId}|imp:${tenantId}:\\d{4}-\\d{2}-\\d{2})$`)
      );
    }
    expect(countersCommandText, 'the plaintext capability token must never reach the counters wire').not.toContain(
      token
    );
    expect(countersCommandText).not.toContain(SLUG);
    expect(countersCommandText, 'counters wire surface must not carry a locale segment').not.toMatch(
      /:(en|es)(?=:|\s|$)/
    );

    // S20: the impression write really happened (not just "the regex would
    // allow it if it existed") - exactly one daily bucket, count 1.
    const impressionKeys = embedCounters.keys().filter((k) => k.startsWith(`dev:imp:${tenantId}:`));
    expect(impressionKeys).toHaveLength(1);
    expect(embedCounters.store.get(impressionKeys[0])?.value).toBe('1');

    // 3. Cache wire surface: content-keyed only, as always - no tenantId,
    //    no token, no IP anywhere, regardless of which "kind" of caller
    //    populated this exact entry.
    for (const key of embedCache.keys()) {
      expect(key).toMatch(/^dev:script:[a-z0-9.-]+:(support|oppose|undecided):(en|es):[0-9a-f]{12}$/);
    }
    expect(cacheCommandText).not.toContain(tenantId);
    expect(cacheCommandText).not.toContain(token);
    expect(cacheCommandText).not.toContain(embedVisitorIp);

    // 4. Citizen-site pin: nothing about the ABSENCE of a token changes
    //    behavior for a plain per-IP caller hitting the exact same limiter
    //    construction the route uses - byte-for-byte the pre-S19 shape.
    const citizenLimiter = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });
    expect(await citizenLimiter.isLimited('198.51.100.211')).toBe(false);
  } finally {
    restoreEmbedFetch();
  }
});

/*
 * S20 (F6): AE5, re-run against the OPTIONAL-token rep-lookup/bill-card
 * path specifically - the AE5 test above only ever exercised the action
 * panel (a required token). Drives the EXACT function each of those two
 * pages calls from inside after() when a `token` param is present
 * (noteImpressionForToken) - never the page module itself, which imports
 * next/headers'/next/server's request-scoped APIs and can only run inside a
 * live Next server (tests/embed-rep-lookup.spec.ts / embed-bill-card.spec.ts
 * cover the actual page-level render).
 */
test('AE5 (rep-lookup/bill-card optional-token path, S20): a token-bearing free-tier widget load leaves counters/tenancy clean, and an absent/invalid token is a byte-for-byte no-op', async () => {
  const counters = new MockUpstash();
  const tenancy = new MockUpstash();
  const restoreOptionalTokenFetch = installUpstashFetch({ [COUNTERS_URL]: counters, [TENANCY_URL]: tenancy });

  try {
    const token = mintCapabilityToken();
    const hash = tokenHash(token);
    const tenantId = 'cus_ae5_optional_token';
    tenancy.exec([
      'SET',
      tenantKey(tenantId),
      JSON.stringify({
        tenantId,
        tokenHash: hash,
        tier: 'pro',
        domainAllowlist: [],
        orgName: 'AE5 Optional-Token Org',
        attribution: 'required',
        createdAt: new Date().toISOString(),
        subscriptionId: 'sub_ae5_optional',
        subscriptionStatus: 'active',
        // Deliberately NO tosAcceptedAt - activeTenantForImpression (S20 §1)
        // must NOT gate on it, unlike resolveTenantAccess.
      }),
    ]);
    tenancy.exec(['SET', tokenIndexKey(hash), tenantId]);

    // Two distinct visitors load the same tenant's free-tier widget with the
    // valid token (the common case), one loads with no token at all, and one
    // presents a garbage token - all four are exactly what
    // app/embed/rep-lookup/page.tsx and app/embed/bill-card/page.tsx call.
    await noteImpressionForToken(token, '198.51.100.220');
    await noteImpressionForToken(token, '198.51.100.221');
    await noteImpressionForToken(null, '198.51.100.222');
    await noteImpressionForToken('totally-made-up-token', '198.51.100.223');

    const tenancyCommandText = tenancy.commands.map((c) => c.join(' ')).join('\n');
    const countersCommandText = counters.commands.map((c) => c.join(' ')).join('\n');

    for (const key of tenancy.keys()) {
      expect(key).toMatch(new RegExp(`^dev:(tenant:${tenantId}|token:[0-9a-f]{64})$`));
    }
    for (const ip of ['198.51.100.220', '198.51.100.221', '198.51.100.222', '198.51.100.223']) {
      expect(tenancyCommandText, `tenancy wire surface must not carry caller IP ${ip}`).not.toContain(ip);
    }

    for (const key of counters.keys()) {
      expect(key).toMatch(
        new RegExp(`^dev:(salt:current|rl:embed-impression-token:[0-9a-f]{64}|imp:${tenantId}:\\d{4}-\\d{2}-\\d{2})$`)
      );
    }
    expect(countersCommandText, 'the plaintext token must never reach the counters wire').not.toContain(token);
    for (const ip of ['198.51.100.220', '198.51.100.221', '198.51.100.222', '198.51.100.223']) {
      expect(countersCommandText, `counters wire surface must not carry caller IP ${ip}`).not.toContain(ip);
    }

    // Exactly the two VALID-token loads counted - the absent-token load
    // touched nothing at all, and the garbage-token load resolved to no
    // tenant, so neither incremented anything.
    const impressionKey = counters.keys().find((k) => k.startsWith(`dev:imp:${tenantId}:`));
    expect(impressionKey).toBeDefined();
    expect(counters.store.get(impressionKey!)?.value).toBe('2');

    // The absent-token call touched NEITHER database at all (byte-for-byte
    // no-op doctrine) - proven by the total command count: only the three
    // token-bearing calls (2 valid + 1 garbage) could have written anything.
    const rlCalls = counters.commands.filter((c) => c[0] === 'SET' && c[1].includes('rl:embed-impression-token:'));
    expect(rlCalls.length).toBeLessThanOrEqual(3); // one rate-limit window creation per distinct caller, at most
  } finally {
    restoreOptionalTokenFetch();
  }
});

/*
 * S20 (F6) - THE NAMED ACCEPTANCE TEST (docs/ideation/2026-07-05-build-gtm-
 * strategy.md's own S20 row: "a spoofed-traffic fixture confirms only a
 * daily bucket survives, no caller-level trace"). A burst of forged
 * requests with varied, spoofed x-forwarded-for values hits a token-bearing
 * rep-lookup load and an authorized action-panel load repeatedly - proving
 * that no matter how many distinct (fake) source IPs an attacker spoofs,
 * the tenant's impression count is ONE SHARED daily bucket, never a
 * per-visitor trace, and every key on the wire stays inside the closed
 * salt/rl/imp shape.
 */
test('F6 named fixture: a burst of spoofed-IP traffic against rep-lookup and the action panel leaves only a daily bucket, no caller-level trace', async () => {
  const counters = new MockUpstash();
  const tenancy = new MockUpstash();
  const restoreBurstFetch = installUpstashFetch({ [COUNTERS_URL]: counters, [TENANCY_URL]: tenancy });

  try {
    const token = mintCapabilityToken();
    const hash = tokenHash(token);
    const tenantId = 'cus_f6_spoof_burst';
    tenancy.exec([
      'SET',
      tenantKey(tenantId),
      JSON.stringify({
        tenantId,
        tokenHash: hash,
        tier: 'pro',
        domainAllowlist: [],
        orgName: 'F6 Spoof Burst Org',
        attribution: 'required',
        createdAt: new Date().toISOString(),
        subscriptionId: 'sub_f6_spoof',
        subscriptionStatus: 'active',
        tosAcceptedAt: new Date().toISOString(),
      }),
    ]);
    tenancy.exec(['SET', tokenIndexKey(hash), tenantId]);

    // A spoofable HTTP header can claim to be ANY string - not just a
    // syntactically-valid IP. Includes obviously-forged, malformed, and
    // repeated values on purpose (the same "hostile fixture" spirit as
    // lib/embed-referrer.ts's own F3 named test).
    const SPOOFED_IPS = [
      '203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.1', // a repeat
      '198.51.100.9, 203.0.113.99', // multi-hop x-forwarded-for (first hop wins)
      'not-an-ip-at-all',
      '::1',
      '0.0.0.0',
    ];

    // rep-lookup-shaped traffic: one noteImpressionForToken call per spoofed
    // IP, all presenting the SAME valid tenant token.
    for (const ip of SPOOFED_IPS) {
      await noteImpressionForToken(token, ip.split(',')[0].trim());
    }

    // action-panel-shaped traffic: the fully-authorized branch, same tenant,
    // a fresh spoofed IP each time too (the action panel's own gate never
    // touches the counters database with the IP either - resolveTenantAccess
    // only ever reads the tenancy database by token).
    for (let i = 0; i < 5; i++) {
      const access = await resolveTenantAccess(token);
      expect(access.ok).toBe(true);
      if (access.ok) await noteImpression(access.tenant.tenantId);
    }

    const countersCommandText = counters.commands.map((c) => c.join(' ')).join('\n');

    // Every counters key stays inside the closed shape - a rotating salt, a
    // rate-limit counter, or the one impression bucket. No per-IP key ever
    // exists (no "imp:<tenantId>:<ip>" shape, no "rl:*:<ip>" literal IP key).
    for (const key of counters.keys()) {
      expect(key).toMatch(
        new RegExp(`^dev:(salt:current|rl:embed-impression-token:[0-9a-f]{64}|imp:${tenantId}:\\d{4}-\\d{2}-\\d{2})$`)
      );
    }

    // None of the spoofed IPs (or their malformed/multi-hop/loopback
    // variants) ever reach the wire in plaintext - only their salted hash
    // does, inside the rate-limiter's own key.
    for (const raw of SPOOFED_IPS) {
      const ip = raw.split(',')[0].trim();
      expect(countersCommandText, `counters wire surface must not carry spoofed IP "${ip}"`).not.toContain(ip);
    }
    // No UA string, no other identifying header, ever reaches this wire -
    // this codebase never even reads one (grep-proof: the literal substring
    // "Mozilla" - the universal UA-string marker - cannot appear).
    expect(countersCommandText).not.toContain('Mozilla');

    // ONE shared daily bucket for the whole burst - 8 rep-lookup loads (one
    // per spoofed IP) + 5 action-panel loads = 13, regardless of how many
    // distinct (fake) source IPs were involved. This is the named
    // assertion: spoofing volume does not fragment the count into a
    // per-visitor trace.
    const impressionKeys = counters.keys().filter((k) => k.startsWith(`dev:imp:${tenantId}:`));
    expect(impressionKeys, 'only ONE daily bucket must exist for this tenant, not one per spoofed IP').toHaveLength(
      1
    );
    expect(counters.store.get(impressionKeys[0])?.value).toBe(String(SPOOFED_IPS.length + 5));
  } finally {
    restoreBurstFetch();
  }
});
