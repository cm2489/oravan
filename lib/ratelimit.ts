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
  | 'brand-day';

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

// --- counters-database key builders (the whole registry) --------------------

export function saltKey(): string {
  return `${keyPrefix()}:salt:current`;
}

export function counterKey(route: RouteName, callerHash: string): string {
  return `${keyPrefix()}:rl:${route}:${callerHash}`;
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

export function createTenantRateLimiter(opts: {
  route: RouteName;
  max: number;
  windowSec: number;
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
        return core.memoryCheck(tenantId).limited;
      }
    },
  };
}
