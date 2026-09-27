import { createHash, randomBytes } from 'node:crypto';
import { countersClient, keyPrefix, noteUpstashError, type UpstashClient } from './upstash';

/*
 * Short-lived rate-limit counters, durable across instances (S11; KTD-3,
 * F4/F5). This module is the ONLY place counters-database keys are built —
 * it is the registry scripts/check-key-namespaces.mjs gates on.
 *
 * Key registry — the only shapes ever written to the counters database:
 *
 *   <env>:salt:current                the rotating hashing salt (24h TTL)
 *   <env>:rl:<route>:<caller-hash>    one fixed-window counter per caller
 *   <env>:rl:<route>:<tenant-id>      one fixed-window counter per TENANT
 *                                      (S19, §2 — route is 'embed-script'/
 *                                      'embed-script-day'; S20 adds
 *                                      'tenant-impressions-read'. tenantId is
 *                                      used RAW, never hashed — see
 *                                      createTenantRateLimiter's own doc
 *                                      comment for why that's the right call
 *                                      here and not a caller-privacy gap)
 *   <env>:uniques:<YYYY-MM-DD>        ONE HyperLogLog sketch per UTC day for
 *                                      the whole site — the daily distinct-
 *                                      address count (owner ruling
 *                                      2026-09-25). No route, page, or any
 *                                      other dimension, ever. See the
 *                                      DAILY DISTINCT-ADDRESS COUNT section
 *                                      below for the full argument.
 *
 * The caller hash is sha256(ip + salt). These are short-lived rate-limit
 * counters — pseudonymous, NOT anonymous: a 32-bit IPv4 space brute-forces
 * in seconds against a known salt, which is why the salt is ≥128 bits of
 * CSPRNG output (never date-derived), created atomically (SET NX) with a 24h
 * TTL, and watched by a loud-failure age verifier (scripts/verify-salt.mjs,
 * nightly). Rotation bounds every pseudonym's lifetime to ≤24h, so a counter
 * can never quietly become a stable identifier. Each instance memoizes the
 * salt it read rather than re-reading it per request, but that memo expires
 * with the record itself — see SALT_MEMO_MAX_AGE_MS below for its two bounds
 * and the single degenerate case (an unreadable creation timestamp) in which
 * the ceiling becomes 24h + 60s instead of exactly 24h.
 *
 * No slug, stance, locale, tool name, or any other content identifier may
 * ever appear in a counters key. The RouteName union enforces that the one
 * variable key segment besides the hash/tenant-id comes from a closed set of
 * route labels (interest-level at most — the same exposure platform request
 * logs already have, per KTD-3's accepted residual — never a political
 * position). The tenant-keyed shape must never ALSO fold in a caller-hash
 * (`<tenant-id>:<caller-hash>`) — that would start building a per-visitor-
 * within-tenant profile the product never asked for; CI-fixture-tested in
 * scripts/check-key-namespaces.mjs.
 *
 * GRACEFUL DEGRADATION (load-bearing): when the counters database is
 * unconfigured, every limiter runs the same per-instance in-memory sliding
 * window the routes shipped with, announced by a single startup log line.
 * When a live request to Upstash fails, that request fails open to the
 * in-memory window and the error is counted + logged (status code only).
 * A route must never hard-fail because Upstash is unreachable.
 */

/**
 * Closed set of counter-key route labels. Route names only — never content.
 * 'embed-script'/'embed-script-day' (S19) are the PER-TENANT limiter's two
 * windows — mirrors the existing mcp-min/mcp-day two-window shape, no new
 * pattern invented. They are written by createTenantRateLimiter below, never
 * by createRateLimiter — a tenant-keyed counter and a caller-hash-keyed one
 * never share a route label.
 *
 * 'reps' is the ZIP -> representatives lookup. It is the ONE route label
 * here whose requests fire on PAGE RENDER rather than on an explicit user
 * action (components/ActionPanel.tsx, components/embed/ActionPanelWidget.tsx
 * and components/embed/RepLookupWidget.tsx all fetch it from an effect when
 * a ZIP is already stored), so its ceiling is deliberately the loosest of
 * the per-IP limiters — see app/api/reps/route.ts for the measured sizing.
 * Only the caller hash reaches this key. This is the first route label whose
 * request carries a ZIP, and the ZIP must never reach a counters key — so
 * scripts/check-key-namespaces.mjs's CONTENT_IDENTIFIER gained `\bzip\b`
 * with this change (rule 3 previously listed slug/stance/locale/bill/topic/
 * query but not a ZIP, so interpolating one into a key builder in THIS file
 * would have passed every rule), seeded into that gate's self-test so it
 * stays tested rather than trusted. The gate reads this file's comments too,
 * which is why the hazard is described here in words and never spelled as a
 * template interpolation.
 *
 * S20 adds three: 'embed-impression-token' is a per-IP (createRateLimiter)
 * cap around the tenancy-database lookup that a token param on rep-lookup/
 * bill-card now triggers — cost-containment only (a garbage token is never
 * a security concern, just a free-to-trigger Upstash GET), never a render
 * gate. 'tenant-impressions' (per-IP) and 'tenant-impressions-read'
 * (per-tenant, createTenantRateLimiter) are GET /api/tenant/impressions's
 * own two-limiter gate, composed the same order as /api/script's.
 */
export type RouteName =
  | 'script'
  | 'reps'
  | 'district'
  | 'feedback'
  | 'mcp-min'
  | 'mcp-day'
  | 'embed-script'
  | 'embed-script-day'
  | 'embed-impression-token'
  | 'tenant-impressions'
  | 'tenant-impressions-read'
  // /api/brand (brand-preview build): 'brand' is the per-IP limiter;
  // 'brand-day' is a GLOBAL daily spend breaker — a tenant-limiter keyed by
  // the documented constant 'brand-global' (neither caller nor content
  // material, same class as a route label), because this is an
  // unauthenticated Anthropic-spending endpoint with no cross-user cache to
  // blunt a distributed farm.
  | 'brand'
  | 'brand-day'
  // /api/script (spend-guards build): 'script-day' is a GLOBAL daily spend
  // breaker for the script endpoint — the SECOND user of the brand-day
  // pattern, a tenant-limiter keyed by the documented constant
  // 'script-global' (neither caller nor content material, same class as a
  // route label). It sits alongside, never replaces, the per-IP 'script'
  // label above: that one bounds ONE abusive caller, this one bounds the
  // day's total Anthropic spend across every caller at once. Unlike
  // /api/brand, /api/script has a cross-user cache in front of it, so this
  // breaker is only ever consumed by a real cache-MISS generation — see
  // serveScript in app/api/script/route.ts.
  | 'script-day';

const SALT_TTL_SECONDS = 24 * 60 * 60;
const SALT_BYTES = 16; // 128 bits of CSPRNG output — never date-derived (F5)

/*
 * SALT MEMO WINDOW (fix/dynamic-surface-smalls). Read this next to the
 * rotation semantics above before changing the number.
 *
 * THE COST IT REMOVES: currentSalt used to issue a fresh GET on EVERY
 * request, so the durable path was three serialized REST round-trips —
 * GET salt, SET NX, INCR. /api/reps is the route where that hurts, because
 * it is the one limiter that fires on PAGE RENDER rather than on a user
 * action (components/ActionPanel.tsx fetches it from an effect whenever a
 * ZIP is already stored), so a slow counters database stalled the rep panel
 * for up to three 2s timeouts (lib/upstash.ts's REQUEST_TIMEOUT_MS) before
 * failing open. Memoizing the salt removes the first of the three.
 *
 * WHY 60 SECONDS, AND WHY THAT DOESN'T EXTEND A PSEUDONYM'S LIFE:
 * rotation is the privacy mechanism — a salt lives 24h (SET NX EX 86400),
 * which is what bounds every caller hash's linkable lifetime to ≤24h. A memo
 * is only safe if it cannot push a salt past its own death, so this one is
 * bounded TWICE and always takes the tighter bound:
 *
 *   1. Wall-clock: 60s. Even if bound 2 were defeated entirely (a skewed
 *      clock, an unparseable timestamp), an instance can serve a dead salt
 *      for at most 60s — 0.069% of the 86,400s rotation, i.e. a 24h window
 *      becomes at most 24h 1min. That is immaterial against a bound whose
 *      whole job is "a counter can never quietly become a stable
 *      identifier"; it stays a day, not a week.
 *   2. The record's OWN expiry: the stored record carries `t`, its creation
 *      time, and it was written with a 24h TTL, so it truly dies at
 *      t + SALT_TTL_SECONDS. The memo never outlives that instant, so in the
 *      normal case the extension is exactly ZERO seconds — the memo expires
 *      when the salt does, and the next request re-reads and picks up the
 *      successor.
 *
 * Bound 2 can only ever TIGHTEN the window (it is applied with Math.min), so
 * clock skew between instances cannot lengthen anything: the worst a skewed
 * clock buys is falling back to bound 1.
 *
 * THE ABSENCE SIGNAL: a memo is also dropped on any counters-database error
 * (see createRateLimiter's catch) and on any unparseable/missing record, so
 * a stale memo is never held across a failure that might BE the rotation.
 * That path costs nothing — it degrades to exactly the pre-memo behavior,
 * one GET per request, until the database answers cleanly again.
 *
 * NOT memoized: the counter itself. SET NX + INCR stay two commands because
 * the TTL-at-creation ordering is what keeps a pseudonym from outliving its
 * window (see durableCheck), and this repo's client speaks one command per
 * request — collapsing them would mean teaching lib/upstash.ts Upstash's
 * pipeline endpoint, which is a bigger, less obviously-correct change than
 * the round-trip it saves is worth.
 */
const SALT_MEMO_MAX_AGE_MS = 60_000;

/*
 * ROTATION RESETS EVERY COUNTER, AND THAT IS THE ACCEPTED TRADE (2026-08-12).
 * The other side of the arithmetic above, written down here because the memo
 * comment is where the next reader does rotation math.
 *
 * A counter key is `<env>:rl:<route>:sha256(ip + salt)` (counterKey +
 * callerHash), so the key itself is salt-derived. When the salt rotates the
 * caller's hash changes: the old counter is orphaned — still holding its own
 * TTL, now unreachable — and a brand-new counter starts at 0, mid-window. The
 * counter does NOT reset because it expired; it resets because its NAME
 * changed. A longer counter TTL therefore fixes nothing.
 *
 * CONSEQUENCE, stated honestly: a caller's budget is per counter window, not
 * per wall-clock day. Straddle the rotation and a window's worth can be spent
 * on each side of it — for the 86,400s mcp-day window (max 1,000, see
 * app/api/mcp/[transport]/route.ts) that is up to ~2,000 requests inside one
 * 24h span, then ~1,000 per salt epoch after. Short windows barely notice: a
 * 600s window can straddle a rotation at most once a day, costing one extra
 * ten-minute budget.
 *
 * WHY IT IS NOT "FIXED": every fix needs a caller key that outlives the
 * rotation (keeping salt N-1 and counting against both keys is the only
 * variant that actually works), which lengthens a pseudonym's linkable life
 * from ≤24h to ≤48h — the exact property rotation exists to bound, that
 * lib/salt.mjs's MAX_SALT_AGE_MS = 25h dead-man's switch polices nightly, and
 * that the header comment above promises ("a counter can never quietly become
 * a stable identifier"). Privacy wins; the ceiling is the price.
 *
 * SO THE CLAIM MUST MATCH, not the code: the published figures say "per
 * counter window" rather than "a day" (`privacyRateLimit` in messages/en.json
 * + messages/es.json, docs/mcp-server-readme.md). Pinned as intended
 * behavior in tests/ratelimit.unit.spec.ts ("rotation mints a new counter").
 * If a hard per-day ceiling is ever required, the honest lever is a smaller
 * max, not a longer-lived caller key.
 */

// --- counters-database key builders (the whole registry) --------------------

export function saltKey(): string {
  return `${keyPrefix()}:salt:current`;
}

export function counterKey(route: RouteName, callerHash: string): string {
  return `${keyPrefix()}:rl:${route}:${callerHash}`;
}

/**
 * The daily distinct-address sketch's key. ONE argument, the UTC day, on
 * purpose: there is no second parameter through which a route, a page, or a
 * bill could ever reach it. scripts/check-key-namespaces.mjs pins this exact
 * literal (rule distinct-shape) and confines the family to this file.
 */
export function distinctAddressKey(day: string): string {
  return `${keyPrefix()}:uniques:${day}`;
}

// --- caller identity ---------------------------------------------------------

/** First hop of x-forwarded-for, the same derivation the routes always used. */
export function callerIp(headers: Headers): string {
  return (headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
}

export function callerHash(ip: string, salt: string): string {
  return createHash('sha256').update(ip + salt).digest('hex');
}

/**
 * Dormant tenancy hook (S18/S19): the X-Oravan-Key header is recognized as
 * of S11 so embed/tenant callers can begin sending it, but NOTHING reads the
 * result yet — its presence or absence must not change any response
 * (test-enforced). It is never logged and never written to either database.
 */
export function readOravanKey(headers: Headers): string | null {
  const raw = headers.get('x-oravan-key');
  const trimmed = raw?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

// --- salt lifecycle ----------------------------------------------------------

type SaltRecord = { v: string; t: string };

/** Stored as JSON so the nightly verifier can check age without guessing. */
export function parseSaltRecord(raw: string): SaltRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SaltRecord>;
    if (typeof parsed.v !== 'string' || typeof parsed.t !== 'string') return null;
    if (!/^[0-9a-f]{32,}$/.test(parsed.v)) return null; // ≥128 bits, hex
    return { v: parsed.v, t: parsed.t };
  } catch {
    return null;
  }
}

/**
 * Per-instance memo of the current salt. Keyed by the salt key itself, so a
 * keyPrefix change (dev / preview / production) can never be served a
 * neighbour's salt. Module scope = per serverless instance, exactly like the
 * in-memory fallback window below: nothing here is ever written anywhere.
 */
let saltMemo: { key: string; value: string; expiresAtMs: number } | null = null;

/** Test seam only — module scope outlives a spec file's mocks otherwise. */
export function __resetSaltMemoForTests(): void {
  saltMemo = null;
}

/**
 * Memoize a salt for at most SALT_MEMO_MAX_AGE_MS, and never past the
 * record's own 24h death (t + SALT_TTL_SECONDS). Math.min means bound 2 can
 * only tighten the window, never lengthen it — a record with an unreadable
 * or skewed `t` falls back to the 60s wall-clock bound rather than gaining
 * anything from the confusion.
 */
function rememberSalt(key: string, record: SaltRecord): string {
  const createdMs = Date.parse(record.t);
  const recordDiesAtMs = Number.isFinite(createdMs)
    ? createdMs + SALT_TTL_SECONDS * 1000
    : Number.POSITIVE_INFINITY;
  saltMemo = {
    key,
    value: record.v,
    expiresAtMs: Math.min(Date.now() + SALT_MEMO_MAX_AGE_MS, recordDiesAtMs),
  };
  return record.v;
}

/** Drop the memo: the salt may be gone, and a guess is never better than a read. */
function forgetSalt(): void {
  saltMemo = null;
}

async function currentSalt(client: UpstashClient): Promise<string> {
  const key = saltKey();
  const memo = saltMemo;
  if (memo && memo.key === key && memo.expiresAtMs > Date.now()) return memo.value;

  const existing = await client.cmd(['GET', key]);
  if (typeof existing === 'string') {
    const parsed = parseSaltRecord(existing);
    if (parsed) return rememberSalt(key, parsed);
    // Unparseable record: don't guess, don't overwrite (the verifier will
    // fail loudly on it tonight). Treat as an error → fail open to memory.
    forgetSalt();
    throw new Error('unusable salt record');
  }
  // No salt yet: create one atomically. SET NX means exactly one instance
  // wins a concurrent race; everyone else reads the winner's salt.
  const fresh: SaltRecord = {
    v: randomBytes(SALT_BYTES).toString('hex'),
    t: new Date().toISOString(),
  };
  const created = await client.cmd([
    'SET',
    key,
    JSON.stringify(fresh),
    'NX',
    'EX',
    String(SALT_TTL_SECONDS),
  ]);
  if (created === 'OK') return rememberSalt(key, fresh);
  const raced = await client.cmd(['GET', key]);
  const parsed = typeof raced === 'string' ? parseSaltRecord(raced) : null;
  if (parsed) return rememberSalt(key, parsed);
  forgetSalt();
  throw new Error('salt create raced and re-read failed');
}

// --- the limiter --------------------------------------------------------------

export interface RateLimiter {
  /** True when this caller is over the window's limit (request should 429). */
  isLimited(ip: string): Promise<boolean>;
  /**
   * Single counted check. retryAfterSec is non-null only when limited:
   * seconds until the window resets (durable: TTL of the counter key;
   * memory: oldest-hit expiry).
   */
  check(ip: string): Promise<{ limited: boolean; retryAfterSec: number | null }>;
}

let fallbackLogged = false;

/** Test seam only — lets the unit spec pin the single-startup-line behavior. */
export function __resetFallbackLogForTests(): void {
  fallbackLogged = false;
}

function logFallbackOnce(): void {
  if (fallbackLogged) return;
  fallbackLogged = true;
  console.log(
    'rate-limit: counters database not configured (env absent) — using per-instance in-memory counters (expected in local dev, CI, and previews without env)'
  );
}

/*
 * Shared fixed-window counter core (S11, extended S19): the actual
 * SET-NX-EX-then-INCR durable path and the in-memory fallback window, kept
 * in exactly one place so createRateLimiter (caller-hash-keyed) and
 * createTenantRateLimiter (tenant-id-keyed, below) can never drift into two
 * slightly different implementations of "count within a window". Callers
 * supply the already-built Upstash key and an arbitrary in-memory map key
 * (never itself written anywhere) — this core has no opinion on WHAT
 * identifies a caller, only on how a window is counted once something does.
 */
type WindowCheck = { limited: boolean; retryAfterSec: number | null };

function windowedCounterCore(opts: { max: number; windowSec: number }) {
  // In-memory fallback: the exact sliding-window the routes shipped with.
  // Raw identifiers here are compliant only because this never leaves
  // process memory (KTD-3's own note on the pre-S11 code) — nothing in this
  // Map is ever written anywhere.
  const hits = new Map<string, number[]>();
  const windowMs = opts.windowSec * 1000;

  function memoryCheck(memKey: string): WindowCheck {
    const now = Date.now();
    const recent = (hits.get(memKey) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= opts.max) {
      // Sliding window: a slot frees the moment the oldest recorded hit
      // ages out of the window.
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
      return { limited: true, retryAfterSec };
    }
    recent.push(now);
    hits.set(memKey, recent);
    if (hits.size > 5000) hits.clear(); // crude memory cap
    return { limited: false, retryAfterSec: null };
  }

  async function durableCheck(upstash: UpstashClient, key: string): Promise<WindowCheck> {
    // SET NX EX before INCR: the TTL is attached at creation, so a crash
    // between commands can never leave a TTL-less counter (which would let a
    // pseudonym outlive its window).
    const created = await upstash.cmd(['SET', key, '0', 'NX', 'EX', String(opts.windowSec)]);
    const count = await upstash.cmd(['INCR', key]);
    if (count === 1 && created !== 'OK') {
      // The key expired between SET and INCR and INCR recreated it bare —
      // rare window-boundary race; re-attach the TTL.
      await upstash.cmd(['EXPIRE', key, String(opts.windowSec)]);
    }
    if (typeof count === 'number' && count > opts.max) {
      // Fixed window ⇒ the counter key's remaining TTL IS the reset. This
      // extra read fires ONLY on the limited path — zero extra commands for
      // passing requests. Privacy: a read of an existing route+caller-hash
      // key; nothing new stored, nothing logged.
      const ttl = await upstash.cmd(['TTL', key]);
      return {
        limited: true,
        retryAfterSec: typeof ttl === 'number' && ttl > 0 ? ttl : opts.windowSec,
      };
    }
    return { limited: false, retryAfterSec: null };
  }

  return { memoryCheck, durableCheck };
}

export function createRateLimiter(opts: {
  route: RouteName;
  max: number;
  windowSec: number;
}): RateLimiter {
  const core = windowedCounterCore(opts);

  return {
    async isLimited(ip: string): Promise<boolean> {
      return (await this.check(ip)).limited;
    },
    async check(ip: string) {
      // Resolved per call, not captured at construction: route modules build
      // their limiters at import time, and env-at-import is a test-only
      // accident waiting to happen. Per-call resolution is two env reads -
      // noise next to the network round-trip it precedes.
      const client = countersClient();
      if (!client) {
        logFallbackOnce();
        return core.memoryCheck(ip);
      }
      try {
        const salt = await currentSalt(client);
        const key = counterKey(opts.route, callerHash(ip, salt));
        return await core.durableCheck(client, key);
      } catch (err) {
        // Fail open to in-memory for this request; never hard-fail the route.
        // Drop the salt memo first (the absence signal): whatever just failed
        // might BE the rotation, and holding a memo across it is the one way
        // a memoized salt could outlive the record it came from.
        forgetSalt();
        noteUpstashError('counters', err);
        return core.memoryCheck(ip);
      }
    },
  };
}

/**
 * Per-tenant rate limiter (S19, §2): the counters database's SECOND
 * identity shape, alongside the caller-hash one createRateLimiter builds.
 * `tenantId` (a Stripe customer id, cus_...) is used RAW — never
 * salted/hashed — a deliberate divergence from createRateLimiter, stated
 * explicitly: hashing tenantId with the rotating 24h salt would buy zero
 * privacy benefit (tenantId is already documented in lib/tenancy.ts as
 * "internal-only, never in a URL" — institutional data, not a citizen
 * identifier) and would actively break the limiter's own job, since salt
 * rotation would make a stable tenant look like a "new" identity mid-
 * window. A tenantId-keyed counter is structurally the same kind of thing
 * as the plaintext route-name segment already sitting in every counter
 * key, not like a caller hash — so this skips currentSalt/callerHash
 * entirely and calls counterKey(route, tenantId) directly.
 *
 * Same in-memory-fallback pattern, same graceful-degradation doctrine, no
 * new database — this and createRateLimiter share windowedCounterCore
 * above and the same logFallbackOnce() startup line (both are the SAME
 * counters database being unconfigured; one line covers either).
 */
export interface TenantRateLimiter {
  /** True when this tenant is over the window's limit (request should 429). */
  isLimited(tenantId: string): Promise<boolean>;
}

/*
 * RATE LIMITS FAIL OPEN. SPEND BREAKERS FAIL CLOSED. (fix/dynamic-surface-smalls)
 *
 * Everything else in this module fails OPEN when the counters database
 * errors — a route must never hard-fail because Upstash is unreachable, and
 * the thing being protected is availability against a noisy caller. Letting
 * a request through during an outage costs, at worst, some extra work.
 *
 * A SPEND breaker is not that. `brand-day` is a GLOBAL daily cap on an
 * unauthenticated endpoint that spends real money per call (~$2/day at 250
 * calls, app/api/brand/route.ts), and `script-day` is the same shape on
 * /api/script. Failing either open substitutes a per-INSTANCE
 * in-memory counter for the global one, so during an Upstash outage the
 * documented ~$2/day cap silently becomes ~$2/day PER SERVERLESS INSTANCE,
 * multiplied by however many instances a distributed caller can cause to
 * exist — precisely when nobody is watching. The honest answer for a guard
 * whose state is unknown is to refuse the paid call: declining to spend is
 * recoverable, and the caller-visible outcome is the same 429 the breaker
 * already returns when it legitimately trips (the /embeds UI's existing
 * "set the colors manually" path), so this costs no new copy in either
 * language.
 *
 * `failClosed` applies to the ERROR path only — "configured, but this
 * request could not reach it", which is the outage this exists for. The
 * UNCONFIGURED path (no env at all: local dev, CI, previews without env)
 * deliberately keeps the in-memory fallback: that is not an unknown state,
 * it is a deployment that has opted out of durable counters entirely, it is
 * already announced by logFallbackOnce()'s single startup line, and making
 * it refuse would dark the feature on every developer's machine and in CI
 * to guard against a misconfiguration that would equally have disabled every
 * other limiter in the product. That asymmetry is a judgment call, so it is
 * written down here rather than left to be rediscovered.
 */
export function createTenantRateLimiter(opts: {
  route: RouteName;
  max: number;
  windowSec: number;
  /** Spend breakers only: an unreachable counters database means REFUSE. */
  failClosed?: boolean;
}): TenantRateLimiter {
  const core = windowedCounterCore(opts);

  return {
    async isLimited(tenantId: string): Promise<boolean> {
      const client = countersClient();
      if (!client) {
        logFallbackOnce();
        return core.memoryCheck(tenantId).limited;
      }
      try {
        const key = counterKey(opts.route, tenantId);
        return (await core.durableCheck(client, key)).limited;
      } catch (err) {
        noteUpstashError('counters', err);
        // The one place in this module that does NOT fail open — see the
        // doctrine comment above. Reported as "limited" because that is what
        // the caller must do about it: not spend.
        if (opts.failClosed) return true;
        return core.memoryCheck(tenantId).limited;
      }
    },
  };
}

// --- daily distinct-address count (owner ruling 2026-09-25) -------------------

/*
 * WHAT THIS IS, STATED PLAINLY: one number a day for the whole site — how
 * many different network addresses requested at least one HTML page during a
 * UTC day, bots included. It answers "how many daily users" more honestly
 * than page views can, and it is NOT a count of people: a household, office,
 * or carrier NAT shares one address (undercount), a phone that changes
 * networks shows several (overcount).
 *
 * THE RULING. Card 15 (D4), answered "a" by the owner on 2026-09-25T02:50Z:
 * "Count each day's unique visitors with HyperLogLog, built from the salted
 * hash the rate limiter already makes." docs/constitution-log.md carries the
 * entry; privacy.p9 is the public sentence, in both languages.
 *
 * WHAT IS STORED — AND WHAT IS NOT. Each counted request PFADDs callerHash
 * (sha256 of the address plus the rotating salt above — the exact value the
 * rate limiter already computes, from the same salt record) into the day's
 * ONE key. A HyperLogLog does not store its elements: it keeps 2^14 six-bit
 * registers (per bucket, the longest run of zero bits any element's own
 * hash produced), so neither an address nor a hash is stored by this path,
 * and the sketch cannot be enumerated or reversed. The address itself never leaves
 * this process — only the hash crosses the wire, inside the PFADD command,
 * the same way it already does inside every rate-limit key.
 *
 * THE HONEST LIMIT (stated, not waved away): while the salt that fed a sketch
 * is still alive, anyone holding BOTH the counters database and a candidate
 * address can compute that address's hash and ask whether adding it would
 * change the sketch. At low daily counts that test is fairly reliable. That
 * is the same exposure the rate-limit keys above already carry (they are
 * discrete, per-caller keys, which is strictly more testable), not a new
 * class of it — though it reaches more people, since the rate-limit keys
 * exist only for callers of a limited route and the sketch covers every page
 * load. It ends when the salt rotates: the salt is ≤24h old by
 * construction and lib/salt.mjs's 25h dead-man's switch polices it nightly.
 * After that the sketch is inert — there is no hash left to test with.
 *
 * NO DIMENSION, EVER. One key per UTC day, no route, no page, no locale, no
 * bill. A per-page or per-bill sketch would pair an address-derived token
 * with a political interest — precisely what CLAUDE.md's "no logs linking
 * network addresses to political positions" forbids — so the key builder
 * takes the day and nothing else, and scripts/check-key-namespaces.mjs pins
 * the literal (distinct-shape), confines the family and the HLL commands to
 * this file (distinct-confinement), and forbids the raw address as a PFADD
 * element (distinct-raw-address; a raw element would be hashed by the
 * database's own UNSALTED function and stay testable forever).
 *
 * LIFETIME. The key dies at a fixed instant: 48 hours after its UTC day ends
 * (EXPIREAT, an absolute deadline, so every re-assertion sets the same time
 * and never extends it). The digest (scripts/daily-metrics.mjs) reads
 * yesterday's sketch once each morning; the extra day lets a late or re-run
 * digest still read it. The last salt that fed day D is dead within ~24h of
 * D's end, so the sketch holds nothing testable for most of that tail.
 *
 * KNOWN OVERCOUNT, KEPT ON PURPOSE: the salt rotates 24h after it was
 * created, not at UTC midnight. An address seen on both sides of that day's
 * rotation hashes to two different elements and counts twice. Removing it
 * needs a second, midnight-aligned salt — a new stored secret-like value the
 * ruling did not ask for — so it is disclosed in the digest caveat instead.
 *
 * BEST-EFFORT, NEVER IN THE WAY: called from proxy.ts inside
 * event.waitUntil, after the response is dispatched. It never throws. With
 * the counters database unconfigured it does NOTHING — deliberately no
 * in-memory fallback, because a per-instance set of addresses would be the
 * one thing here that really is a list of addresses. On an error the count
 * for that request is dropped and the error counted, status code only.
 */

/** How long a day's sketch outlives the end of its UTC day. */
export const DISTINCT_ADDRESS_GRACE_SECONDS = 48 * 60 * 60;

/** UTC calendar date, YYYY-MM-DD — the day a request's address is counted under. */
export function distinctAddressDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Unix seconds at which `day`'s sketch dies: the end of that UTC day plus
 * DISTINCT_ADDRESS_GRACE_SECONDS. Absolute, so re-asserting it is idempotent.
 */
export function distinctAddressExpiresAt(day: string): number {
  const dayStartSec = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  return dayStartSec + 24 * 60 * 60 + DISTINCT_ADDRESS_GRACE_SECONDS;
}

/**
 * Count one request's network address toward today's distinct-address
 * sketch. `ip` is callerIp(headers) — the rate limiter's own derivation. An
 * absent address ('unknown', the callerIp default) is not an address and is
 * not counted. Never throws; see the section comment above for everything
 * else.
 */
export async function noteDistinctAddress(ip: string, now: Date = new Date()): Promise<void> {
  const address = ip.trim();
  if (address === '' || address === 'unknown') return;
  const client = countersClient();
  if (!client) return; // unconfigured: nothing at all, not even in memory
  const day = distinctAddressDay(now);
  const key = distinctAddressKey(day);
  try {
    const hash = callerHash(address, await currentSalt(client));
    const altered = await client.cmd(['PFADD', key, hash]);
    // PFADD answers 1 whenever the sketch changed, which always includes the
    // call that CREATED the key — so the deadline is attached at creation and
    // re-asserted (same instant) whenever the sketch grows, which also heals a
    // key whose first EXPIREAT was lost. A repeat address changes nothing and
    // costs one command, not two.
    if (altered === 1) {
      await client.cmd(['EXPIREAT', key, String(distinctAddressExpiresAt(day))]);
    }
  } catch (err) {
    // Same absence signal as the limiter: whatever failed might BE the
    // rotation, so never hold a memoized salt across it.
    forgetSalt();
    noteUpstashError('counters', err, "dropping this request's distinct-address count (best-effort; the page is unaffected)");
  }
}

export type DistinctAddressCountResult =
  | {
      ok: true;
      /** The sketch's estimate, or null when no sketch exists for that day. */
      count: number | null;
      /** True when the key exists but carries no expiry — it would never age out. */
      noExpiry: boolean;
    }
  | { ok: false };

/**
 * Read ONE day's distinct-address estimate for the digest: TTL (to tell an
 * absent sketch from a real zero, and to catch a key that lost its
 * deadline), then PFCOUNT. Read-only — it never writes, never repairs.
 *
 * Fails CLOSED like every digest read in this repo (`{ ok: false }` on an
 * unconfigured database, a request error, or a malformed reply), so the
 * caller can say "not read" instead of printing an invented number.
 */
export async function readDistinctAddressCount(day: string): Promise<DistinctAddressCountResult> {
  const client = countersClient();
  if (!client) return { ok: false };
  const key = distinctAddressKey(day);
  let ttl: unknown;
  let count: unknown;
  try {
    ttl = await client.cmd(['TTL', key]);
    if (ttl === -2) return { ok: true, count: null, noExpiry: false };
    count = await client.cmd(['PFCOUNT', key]);
  } catch (err) {
    noteUpstashError(
      'counters',
      err,
      'failing closed to a digest read error (distinct addresses, never a degraded number)'
    );
    return { ok: false };
  }
  if (typeof ttl !== 'number' || typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    return { ok: false };
  }
  return { ok: true, count, noExpiry: ttl === -1 };
}
