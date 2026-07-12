import Anthropic from '@anthropic-ai/sdk';
import { after, NextRequest, NextResponse } from 'next/server';
import { getBill } from '@/lib/core';
import { callerIp, createRateLimiter, createTenantRateLimiter, readOravanKey } from '@/lib/ratelimit';
import { contentVersion, createScriptCache } from '@/lib/scriptcache';
import { buildScriptPrompt, SCRIPT_MAX_TOKENS, SCRIPT_MODEL, STANCES } from '@/lib/scriptprompt';
import { resolveTenantAccess } from '@/lib/tenancy';
import type { Stance } from '@/lib/types';
import { noteScriptGeneration } from '@/lib/usage';

/*
 * The only Anthropic-calling endpoint in Oravan. Stateless by design:
 * nothing about the caller is stored. Scripts are cached per
 * (bill, stance, locale, content-version) — shared across all visitors —
 * so popular bills cost one generation total, now across ALL instances
 * (S11: the cache lives in the content-keyed Upstash cache database, with
 * an in-memory fallback when unconfigured).
 *
 * Rate limiting (S11): 8 requests / 10 min per caller — the same limit as
 * always, now enforced with short-lived rate-limit counters in the
 * caller-keyed Upstash counters database (sha256(ip + rotating salt), TTL =
 * the window), durable across instances. See lib/ratelimit.ts for the salt
 * rules and lib/upstash.ts for why counters and cache are two physically
 * separate databases. Unconfigured or unreachable Upstash degrades to the
 * per-instance in-memory limiter — this route never hard-fails on it.
 *
 * S19 — X-Oravan-Key goes LIVE (was recognized-but-inert since S11).
 * EXTENDS this same route rather than forking a tenant-scoped one, so cache
 * sharing between a tenant request and a citizen request for the same
 * (bill, stance, locale) is true by construction, not something a second
 * route could accidentally break (S19 design §1). The gate, in order:
 *
 *   1. Per-IP limiter (below) — unconditional, runs FIRST, independent of
 *      tenancy-database health. The visitor's browser still makes this
 *      fetch directly (the iframe boundary doesn't change which machine
 *      originates the HTTP request), so this protects against a single
 *      abusive visitor whether or not a token is present.
 *   2. `X-Oravan-Key` ABSENT -> today's citizen path, byte-for-byte
 *      unchanged. Must never regress — this is the site's own
 *      components/ActionPanel.tsx flow.
 *   3. `X-Oravan-Key` PRESENT -> resolveTenantAccess (lib/tenancy.ts, the
 *      ONE gate this route shares with app/embed/action-panel/page.tsx) —
 *      bad/revoked/unresolvable token AND an inactive subscription both
 *      collapse to the SAME `403 {error:'unauthorized'}` (fail-closed
 *      doctrine: deliberately not distinguished, so there's nothing here
 *      that helps token-probing). No ToS on file -> a DISTINCT
 *      `403 {error:'tos_required'}` — actionable by the tenant, leaks
 *      nothing exploitable. A present-but-invalid token is NEVER treated
 *      as absent and silently downgraded to the citizen path — that would
 *      make token revocation meaningless as defense-in-depth.
 *   4. Valid tenant -> the PER-TENANT limiter (lib/ratelimit.ts,
 *      createTenantRateLimiter) ADDITIONALLY applies — a different threat
 *      model than the per-IP check (many distinct visitors on one popular
 *      tenant page, each individually well under the per-IP limit, still
 *      driving excessive aggregate Anthropic spend). Composing both is the
 *      correct answer, not redundant belt-and-suspenders. Same uniform
 *      `429 {error:'rate_limited'}` regardless of which of the two
 *      limiters tripped — revealing which would help a prober map the
 *      tenant limiter's threshold.
 *   5. Passes every check -> the EXISTING cache-get -> generate -> cache-set
 *      path below, completely unchanged. Response shape stays
 *      `{script, cached}` — no tenant metadata ever added to it.
 *
 * Numbers (60/10min, 800/24h per tenant) are disclosed as tunable, not
 * derived from real per-tenant demand — S18 is dark-shipped, zero live
 * tenant traffic exists yet. See the S19 PR body for the full reasoning.
 */

const anthropic = new Anthropic();

const cache = createScriptCache();

const limiter = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });
const tenantMinuteLimiter = createTenantRateLimiter({ route: 'embed-script', max: 60, windowSec: 600 });
const tenantDayLimiter = createTenantRateLimiter({ route: 'embed-script-day', max: 800, windowSec: 86400 });

export async function POST(req: NextRequest) {
  const ip = callerIp(req.headers);
  if (await limiter.isLimited(ip)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const oravanKey = readOravanKey(req.headers);
  if (oravanKey !== null) {
    const access = await resolveTenantAccess(oravanKey);
    if (!access.ok) {
      return NextResponse.json({ error: access.reason }, { status: 403 });
    }
    const tenantId = access.tenant.tenantId;
    const tenantLimited =
      (await tenantMinuteLimiter.isLimited(tenantId)) || (await tenantDayLimiter.isLimited(tenantId));
    if (tenantLimited) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  }

  let body: { slug?: string; stance?: Stance; locale?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const { slug, stance, locale } = body;
  if (!slug || !stance || !STANCES.includes(stance)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const lang = locale === 'es' ? 'es' : 'en';

  const bill = getBill(slug);
  if (!bill) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Content-version key component (§9.1(d)): a corrected ai_summary changes
  // the version, so a stale script can never be served against it.
  const version = contentVersion(bill.ai_summary ?? bill.title);
  const cached = await cache.get({ slug, stance, lang, version });
  if (cached) return NextResponse.json({ script: cached, cached: true });

  // Prompt builder lives in lib/scriptprompt (shared by other trusted
  // server-side callers of this exact bill/stance/locale shape) so there
  // is only ever one script prompt in the codebase, never a second copy
  // drifting out of sync with this one.
  const prompt = buildScriptPrompt({ bill, stance, lang });

  try {
    const msg = await anthropic.messages.create({
      model: SCRIPT_MODEL,
      max_tokens: SCRIPT_MAX_TOKENS,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }],
    });
    const script = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    if (!script) throw new Error('empty');
    await cache.set({ slug, stance, lang, version }, script); // never throws
    // traffic-watch (2026-07): counts only real cache-miss generations (an
    // actual Anthropic spend), not cache hits — see lib/usage.ts. after()
    // so a slow/failed counter write never delays this response.
    after(() => noteScriptGeneration());
    return NextResponse.json({ script, cached: false });
  } catch (err) {
    console.error('script generation failed', err);
    return NextResponse.json({ error: 'generation_failed' }, { status: 502 });
  }
}
