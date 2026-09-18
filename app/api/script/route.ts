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
 * Rate limiting (S11; resized 2026-09-18): 20 requests / 10 min per caller —
 * it was 8 from S11 until the spend-guards change; SCRIPT_IP_MAX below states
 * why the per-caller ceiling moved and what bounds the day's spend instead.
 * Enforced with short-lived rate-limit counters in the caller-keyed Upstash
 * counters database (sha256(ip + rotating salt), TTL = the window), durable
 * across instances. See lib/ratelimit.ts for the salt
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
 * SPEND CEILING (spend-guards, 2026-09-18). The three limiters above are
 * per-CALLER or per-TENANT; none of them bounds the day's total. A launch
 * day with many distinct callers, each comfortably under 20/10min, can still
 * run the Anthropic bill up with nothing in the way. `script-day` below is
 * that missing bound — the same GLOBAL daily breaker /api/brand already runs
 * ('brand-day' keyed by 'brand-global'), applied here to CACHE-MISS
 * GENERATIONS ONLY, inside serveScript. A cache hit costs nothing, so it
 * must never consume the breaker: this endpoint's whole economy is that a
 * popular bill is generated once and served from the shared cache forever
 * after, and charging those hits against a spend cap would let free traffic
 * dark a paid feature.
 *
 * Numbers (60/10min, 800/24h per tenant) are disclosed as tunable, not
 * derived from real per-tenant demand — S18 is dark-shipped, zero live
 * tenant traffic exists yet. See the S19 PR body for the full reasoning.
 */

// 60s: the largest function duration valid on every Vercel plan tier, and
// comfortably above this route's own worst-case generation bound below — so
// serveScript's 502 {error:'generation_failed'} path wins and the panel gets a
// readable body, instead of the platform killing the function into a bodiless
// 504 that no client code here ever authored.
export const maxDuration = 60;

const anthropic = new Anthropic();

/*
 * Bound on ONE generation attempt, and the reason maxDuration alone would not
 * have been enough. The SDK's defaults for a non-streaming create are a
 * 10-MINUTE timeout with 2 retries — up to ~30 minutes of wall clock — so the
 * catch below could never fire first: no function duration Vercel allows comes
 * close, and every slow call would still land as a platform 504.
 *
 * 15s x 3 attempts + the SDK's <=1.5s exponential backoff = <=46.5s worst
 * case, ~13s under maxDuration. A 520-token script (SCRIPT_MAX_TOKENS, thinking
 * disabled) generates in single-digit seconds, so 15s is headroom rather than a
 * leash — and keeping the 2 retries preserves the cover against a transient
 * 429 or an overloaded upstream.
 */
const GENERATION_TIMEOUT_MS = 15_000;
const GENERATION_MAX_RETRIES = 2;

const cache = createScriptCache();

/*
 * PER-CALLER CEILING, raised 8 -> 20 per 600s (spend-guards, 2026-09-18).
 *
 * 8 was sized when nothing else bounded the bill, so the per-IP limiter was
 * doing two jobs at once: keeping one caller from monopolising the endpoint,
 * AND standing in for a spend cap it was never shaped to be. It was tight
 * enough to catch real readers: three stances x two vehicles (a bill and its
 * House-audience script) is already 6, and a reader who compares a couple of
 * bills in one sitting hits the wall on legitimate use — the panel then shows
 * the rate-limited copy and the honest static template instead of the draft
 * they asked for. 20 leaves that reader alone.
 *
 * What makes the raise safe is that the spend job moved to something shaped
 * for it: SCRIPT_DAY_MAX below bounds the DAY globally, so the per-IP number
 * no longer has to. Worst case one caller can now drive 20 cache-miss
 * generations per 10 minutes instead of 8 — and every one of those still
 * counts against the same global daily breaker.
 */
const SCRIPT_IP_MAX = 20;
const SCRIPT_IP_WINDOW_SEC = 600;

/*
 * GLOBAL DAILY SPEND BREAKER — the number, and how to change it.
 *
 * 1,800 cache-miss generations per 24h. Env-overridable (SCRIPT_DAY_MAX) so
 * the ceiling can be lowered — or raised for a known event — without a
 * deploy of this file. An unset, malformed, zero, or negative value falls
 * back to the default rather than being trusted: a typo'd env var must never
 * silently remove the cap or set it to nothing.
 *
 * Read at module scope, like every other limiter constant here. That is the
 * same import-time env read lib/ratelimit.ts warns about for the counters
 * CLIENT, and it is deliberate for a plain number: this value is a
 * deployment-wide constant, not per-request state, and re-reading it per
 * request would let the breaker's ceiling change mid-window.
 */
const SCRIPT_DAY_MAX_DEFAULT = 1_800;
function resolveDayMax(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : SCRIPT_DAY_MAX_DEFAULT;
}
const SCRIPT_DAY_MAX = resolveDayMax(process.env.SCRIPT_DAY_MAX);

/** The global-breaker key: a constant, not caller/content material. */
const SCRIPT_GLOBAL_BUCKET = 'script-global';

const limiter = createRateLimiter({
  route: 'script',
  max: SCRIPT_IP_MAX,
  windowSec: SCRIPT_IP_WINDOW_SEC,
});
const tenantMinuteLimiter = createTenantRateLimiter({ route: 'embed-script', max: 60, windowSec: 600 });
const tenantDayLimiter = createTenantRateLimiter({ route: 'embed-script-day', max: 800, windowSec: 86400 });
// failClosed, for the reason lib/ratelimit.ts's doctrine comment states and
// /api/brand's breaker already follows: this guards SPEND, not availability.
// An unreachable counters database leaves the day's count unknown, and the
// honest answer for a money guard with unknown state is to decline the paid
// call — otherwise one Upstash outage turns a single global ceiling into one
// ceiling PER serverless instance. The caller-visible outcome is the 429 the
// breaker already returns, and the panel's honest template rides with it.
const dayBreaker = createTenantRateLimiter({
  route: 'script-day',
  max: SCRIPT_DAY_MAX,
  windowSec: 86_400,
  failClosed: true,
});

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
    // Content-version key component (§9.1(d)): a corrected ai_summary — or a
    // status move, which reaches the generated prompt as `Current status:` —
    // changes the version, so a stale script can never be served against it.
    // The whole bill goes in: contentVersion picks the fields, so this call
    // site and the nightly warmer's cannot drift onto different key material.
    const version = contentVersion(bill);
    // Prompt builder lives in lib/scriptprompt (shared by other trusted
    // server-side callers of this exact bill/stance/locale shape) so there
    // is only ever one script prompt in the codebase, never a second copy
    // drifting out of sync with this one.
    return serveScript(
      { slug, stance, lang, version },
      () => buildScriptPrompt({ bill, stance, lang }),
      oravanKey !== null
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
  // The whole record goes in, not just the description: the prompt also reads
  // the status and the last recorded action, and those are the fields that
  // MOVE. nominationContentVersion picks them, so this call site cannot drift
  // out of agreement with the key material any future caller writes.
  const version = nominationContentVersion(nomination, audience);
  return serveScript(
    { slug, stance, lang, version },
    () => buildNominationScriptPrompt({ nomination, stance, audience, lang }),
    oravanKey !== null
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
 *
 * `tokenPath` says which 429 shape a breaker trip gets, and nothing else —
 * the breaker itself applies identically to citizen and tenant traffic,
 * because a dollar spent on either is the same dollar.
 */
async function serveScript(
  key: { slug: string; stance: string; lang: 'en' | 'es'; version: string },
  buildPrompt: () => string,
  tokenPath: boolean
): Promise<NextResponse> {
  const cached = await cache.get(key);
  if (cached) return NextResponse.json({ script: cached, cached: true });

  /*
   * THE GLOBAL DAILY SPEND BREAKER, and the reason it sits exactly HERE.
   *
   * Above this line the request has cost nothing: a cache hit, a bad body, a
   * slug that resolves to no vehicle, a nomination with no call to make. None
   * of those spend an Anthropic call, so none of them may consume a cap whose
   * whole job is to bound spend — charging them would let free traffic dark a
   * paid feature for everyone. Below this line a generation is about to
   * happen. So the breaker counts attempts at the only place an attempt is
   * real, exactly as /api/brand's does.
   *
   * The counter is consumed by the CHECK, not by success: a generation that
   * then fails at Anthropic has still occupied the machinery, and a route
   * that refunded failures would let a persistent upstream error spin the
   * breaker forever. Same semantics as brand-day.
   */
  if (await dayBreaker.isLimited(SCRIPT_GLOBAL_BUCKET)) {
    // Token path: the uniform bare 429, per §4's doctrine above.
    if (tokenPath) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    /*
     * Citizen path: `scope: 'daily'` — NOT a hint about the breaker's
     * threshold, and not the retryAfterSec the per-IP limiter discloses.
     * It exists so the panel can tell the reader something TRUE. The per-IP
     * copy says "You've requested several scripts in a short time… this
     * usually clears within about ten minutes", and a reader who requested
     * nothing and is waiting on a day-long window is owed neither of those
     * sentences. No Retry-After rides with it: the honest reset is up to 24h
     * away and the fallback template works right now, so a countdown would
     * only invite the reader to sit and wait for it.
     */
    return NextResponse.json({ error: 'rate_limited', scope: 'daily' }, { status: 429 });
  }

  try {
    const msg = await anthropic.messages.create(
      {
        model: SCRIPT_MODEL,
        max_tokens: SCRIPT_MAX_TOKENS,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: buildPrompt() }],
      },
      // Without this the SDK waits out its 10-minute default and the platform
      // kills the function first — see GENERATION_TIMEOUT_MS above. A timeout
      // throws here, which is what routes a slow upstream into the 502 below.
      { timeout: GENERATION_TIMEOUT_MS, maxRetries: GENERATION_MAX_RETRIES }
    );
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
