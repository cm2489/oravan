import Anthropic from '@anthropic-ai/sdk';
import { after, NextRequest, NextResponse } from 'next/server';
import { getBill } from '@/lib/core';
// Imported DIRECTLY, never through the lib/core barrel — that module's header
// forbids the barrel so no bundle pays for data/nominations.json (~520 KB)
// by accident. This route is one of the few that genuinely needs it.
import { getNomination } from '@/lib/core/nominations';
import { liveCallTargetForNomination } from '@/lib/journey';
import {
  buildNominationScriptPrompt,
  NOMINATION_AUDIENCES,
  type NominationAudience,
} from '@/lib/nomination-script';
import { callerIp, createRateLimiter, createTenantRateLimiter, readOravanKey } from '@/lib/ratelimit';
import { contentVersion, createScriptCache, nominationContentVersion } from '@/lib/scriptcache';
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
 * TWO VEHICLE KINDS, ONE ENDPOINT (2026-08-06). A `pn-…` slug is a Senate
 * nomination and takes the fork below: a different corpus, a liveness check
 * the bill path does not need, an `audience` the bill path does not have, and
 * lib/nomination-script.ts's prompt instead of lib/scriptprompt.ts's. Every
 * shared concern — the two limiters, the tenant gate, the cache, the spend
 * counter, the response shape — stays shared, because a second route would be
 * a second place for a rate limit or a cache key to drift. The bill path runs
 * first and is byte-for-byte what it was.
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
 *      abusive visitor whether or not a token is present. A CITIZEN-path
 *      trip (no X-Oravan-Key) answers 429 with a Retry-After header and a
 *      retryAfterSec body field — seconds-to-reset of the already-keyed
 *      counter, nothing user-linkable — so the panel can degrade honestly;
 *      a token-path trip stays the uniform bare 429 (see 4).
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
 *      tenant limiter's threshold. Citizen 429s carry Retry-After;
 *      token-path 429s remain uniform and bare, whether the per-IP or the
 *      tenant limiter tripped.
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
  // Hoisted above the per-IP gate (a pure header parse): the 429 shape below
  // depends on whether this is the citizen path or the token path.
  const oravanKey = readOravanKey(req.headers);
  const gate = await limiter.check(ip);
  if (gate.limited) {
    // Token path: uniform bare 429 — indistinguishable from the tenant
    // limiter's own trip below, by doctrine (§4 above).
    if (oravanKey !== null) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
    // Citizen path: expose the reset so the panel can degrade honestly.
    const retryAfterSec = gate.retryAfterSec ?? 600;
    return NextResponse.json(
      { error: 'rate_limited', retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } }
    );
  }

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

  let body: { slug?: string; stance?: Stance; locale?: string; audience?: string };
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

  /*
   * WHICH CORPUS THE SLUG BELONGS TO. The `pn-…` namespace is structurally
   * disjoint from every bill slug (lib/moments.ts VEHICLE_KINDS), so the two
   * lookups can never both hit and the order below is not load-bearing — but
   * the bill lookup stays FIRST anyway, so the citizen path this route shipped
   * with is byte-for-byte the first thing that runs for every bill request.
   *
   * Before 2026-08-06 a `pn-…` slug fell straight through getBill() into the
   * 404 below, which is why a nomination had no call to make at all.
   */
  const bill = getBill(slug);
  if (bill) {
    // Content-version key component (§9.1(d)): a corrected ai_summary changes
    // the version, so a stale script can never be served against it.
    const version = contentVersion(bill.ai_summary ?? bill.title);
    // Prompt builder lives in lib/scriptprompt (shared by other trusted
    // server-side callers of this exact bill/stance/locale shape) so there
    // is only ever one script prompt in the codebase, never a second copy
    // drifting out of sync with this one.
    return serveScript({ slug, stance, lang, version }, () =>
      buildScriptPrompt({ bill, stance, lang })
    );
  }

  /* ── THE NOMINATION PATH ───────────────────────────────────────────────
   *
   * Everything below the corpus lookup is the bill path's own machinery,
   * unchanged: the same cache, the same key shape, the same model call, the
   * same spend counter. What differs is the three things that MUST differ —
   * which corpus the slug resolves in, whether a call can still bear on the
   * record at all, and which prompt writes the script. */
  const nomination = getNomination(slug);
  if (!nomination) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  /*
   * A CONFIRMED NOMINATION HAS NO CALL TO MAKE, and this route says so rather
   * than spending a model call to write one. The predicate is
   * liveCallTargetForNomination — the SAME one the panel routes on and the
   * unit suite pins (lib/journey.ts suite 7) — so the route and the surface
   * can never disagree about whether a nomination is still live. It returns
   * null for the three terminal statuses (nothing a caller says moves them)
   * and for `unclassified` (the record did not say, so nothing is claimed).
   *
   * 422, not 404: the record exists and this endpoint found it. Saying
   * "not found" about a nomination a reader can see on Congress.gov would be
   * a small lie told by an error code.
   */
  if (!liveCallTargetForNomination(nomination)) {
    return NextResponse.json({ error: 'not_callable' }, { status: 422 });
  }

  /*
   * No description, no script. 14 of the 859 civilian records (all Foreign
   * Service promotion lists) carry no description sentence, and that sentence
   * is the ONLY substantive grounding a nomination script has — there is no
   * decode to fall back on, by design (lib/nomination-script.ts's header).
   * Generating anyway would be asking a model to write a call script about a
   * named person from nothing but a citation number.
   */
  if (!nomination.nominee_description) {
    return NextResponse.json({ error: 'not_callable' }, { status: 422 });
  }

  /*
   * The audience — the axis a bill script does not have (senator votes,
   * representative does not; see NOMINATION_AUDIENCES). ABSENT MEANS
   * 'senator', which is the owner's 2026-08-06 ruling expressed as a default:
   * the Senate is the call, so a caller that says nothing gets the Senate
   * script. A present-but-unrecognized value is rejected rather than
   * defaulted — silently downgrading "hosue" to the Senate script would hand
   * back a script for the wrong chamber with a 200.
   */
  const audience: NominationAudience = body.audience === undefined ? 'senator' : (body.audience as NominationAudience);
  if (!NOMINATION_AUDIENCES.includes(audience)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  // The audience rides INSIDE the version hash, so the key shape stays the
  // one shape check-key-namespaces.mjs gates on — see nominationContentVersion.
  const version = nominationContentVersion(nomination.nominee_description, audience);
  return serveScript({ slug, stance, lang, version }, () =>
    buildNominationScriptPrompt({ nomination, stance, audience, lang })
  );
}

/**
 * Cache-get → generate → cache-set → respond. Extracted 2026-08-06 when the
 * nomination path landed, and extracted rather than copied for one reason:
 * this is the block that spends money and the block that writes the shared
 * cache, and two copies of it would be two places for a cache-key bug or an
 * uncounted generation to hide. Both kinds get the identical response shape
 * (`{script, cached}`), the identical 502 on failure, and the identical
 * cache-miss-only spend count.
 *
 * `buildPrompt` is a thunk so the prompt is never built on a cache hit — the
 * common case, and the one that must stay cheapest.
 */
async function serveScript(
  key: { slug: string; stance: string; lang: 'en' | 'es'; version: string },
  buildPrompt: () => string
): Promise<NextResponse> {
  const cached = await cache.get(key);
  if (cached) return NextResponse.json({ script: cached, cached: true });

  try {
    const msg = await anthropic.messages.create({
      model: SCRIPT_MODEL,
      max_tokens: SCRIPT_MAX_TOKENS,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: buildPrompt() }],
    });
    const script = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    if (!script) throw new Error('empty');
    await cache.set(key, script); // never throws
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
