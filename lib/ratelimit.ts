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
 *
 * The caller hash is sha256(ip + salt). These are short-lived rate-limit
 * counters — pseudonymous, NOT anonymous: a 32-bit IPv4 space brute-forces
 * in seconds against a known salt, which is why the salt is ≥128 bits of
 * CSPRNG output (never date-derived), created atomically (SET NX) with a 24h
 * TTL, and watched by a loud-failure age verifier (scripts/verify-salt.mjs,
 * nightly). Rotation bounds every pseudonym's lifetime to ≤24h, so a counter
 * can never quietly become a stable identifier.
 *
 * No slug, stance, locale, tool name, or any other content identifier may
 * ever appear in a counters key. The RouteName union enforces that the one
 * variable key segment besides the hash comes from a closed set of route
 * labels (interest-level at most — the same exposure platform request logs
 * already have, per KTD-3's accepted residual — never a political position).
 *
 * GRACEFUL DEGRADATION (load-bearing): when the counters database is
 * unconfigured, every limiter runs the same per-instance in-memory sliding
 * window the routes shipped with, announced by a single startup log line.
 * When a live request to Upstash fails, that request fails open to the
 * in-memory window and the error is counted + logged (status code only).
 * A route must never hard-fail because Upstash is unreachable.
 */

/** Closed set of counter-key route labels. Route names only — never content. */
export type RouteName = 'script' | 'district' | 'feedback' | 'mcp-min' | 'mcp-day';

const SALT_TTL_SECONDS = 24 * 60 * 60;
const SALT_BYTES = 16; // 128 bits of CSPRNG output — never date-derived (F5)

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
 * Dormant tenancy hook (S18/S19): the X-Rostra-Key header is recognized as
 * of S11 so embed/tenant callers can begin sending it, but NOTHING reads the
 * result yet — its presence or absence must not change any response
 * (test-enforced). It is never logged and never written to either database.
 */
export function readRostraKey(headers: Headers): string | null {
  const raw = headers.get('x-rostra-key');
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

async function currentSalt(client: UpstashClient): Promise<string> {
  const existing = await client.cmd(['GET', saltKey()]);
  if (typeof existing === 'string') {
    const parsed = parseSaltRecord(existing);
    if (parsed) return parsed.v;
    // Unparseable record: don't guess, don't overwrite (the verifier will
    // fail loudly on it tonight). Treat as an error → fail open to memory.
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
    saltKey(),
    JSON.stringify(fresh),
    'NX',
    'EX',
    String(SALT_TTL_SECONDS),
  ]);
  if (created === 'OK') return fresh.v;
  const raced = await client.cmd(['GET', saltKey()]);
  const parsed = typeof raced === 'string' ? parseSaltRecord(raced) : null;
  if (parsed) return parsed.v;
  throw new Error('salt create raced and re-read failed');
}

// --- the limiter --------------------------------------------------------------

export interface RateLimiter {
  /** True when this caller is over the window's limit (request should 429). */
  isLimited(ip: string): Promise<boolean>;
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

export function createRateLimiter(opts: {
  route: RouteName;
  max: number;
  windowSec: number;
}): RateLimiter {
  // In-memory fallback: the exact sliding-window the routes shipped with.
  // Raw IPs here are compliant only because this never leaves process memory
  // (KTD-3's own note on the pre-S11 code) — nothing in this Map is ever
  // written anywhere.
  const hits = new Map<string, number[]>();
  const windowMs = opts.windowSec * 1000;

  function memoryLimited(ip: string): boolean {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= opts.max) return true;
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear(); // crude memory cap
    return false;
  }

  async function durableLimited(upstash: UpstashClient, ip: string): Promise<boolean> {
    const salt = await currentSalt(upstash);
    const key = counterKey(opts.route, callerHash(ip, salt));
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
    return typeof count === 'number' && count > opts.max;
  }

  return {
    async isLimited(ip: string): Promise<boolean> {
      // Resolved per call, not captured at construction: route modules build
      // their limiters at import time, and env-at-import is a test-only
      // accident waiting to happen. Per-call resolution is two env reads -
      // noise next to the network round-trip it precedes.
      const client = countersClient();
      if (!client) {
        logFallbackOnce();
        return memoryLimited(ip);
      }
      try {
        return await durableLimited(client, ip);
      } catch (err) {
        // Fail open to in-memory for this request; never hard-fail the route.
        noteUpstashError('counters', err);
        return memoryLimited(ip);
      }
    },
  };
}
