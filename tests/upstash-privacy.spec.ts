import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { POST as districtPost } from '../app/api/district/route';
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
    //    PLUS the new RAW-tenantId 'embed-script'/'embed-script-day' shape
    //    - and critically, the PLAINTEXT TOKEN itself never appears
    //    anywhere on this wire (only tenantId, which is documented
    //    internal-only/institutional, does).
    for (const key of embedCounters.keys()) {
      expect(key).toMatch(new RegExp(`^dev:(salt:current|rl:script:[0-9a-f]{64}|rl:embed-script(-day)?:${tenantId})$`));
    }
    expect(countersCommandText, 'the plaintext capability token must never reach the counters wire').not.toContain(
      token
    );
    expect(countersCommandText).not.toContain(SLUG);
    expect(countersCommandText, 'counters wire surface must not carry a locale segment').not.toMatch(
      /:(en|es)(?=:|\s|$)/
    );

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
