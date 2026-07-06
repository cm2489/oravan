/*
 * Minimal Upstash Redis REST client — plain fetch, no SDK (S11).
 *
 * Why plain fetch instead of @upstash/redis: the command surface here is
 * six commands (GET / SET NX EX / INCR / EXPIRE / TTL / DEL), the repo's
 * test convention already mocks globalThis.fetch (tests/feedback.unit.spec.ts
 * pattern), and a privacy-critical path should carry zero extra supply-chain
 * surface. If the command surface ever grows past trivial, revisit.
 *
 * TWO PHYSICALLY SEPARATE DATABASES — this is the load-bearing design rule
 * (KTD-3, strategy §9.1(c)), and this file is where both clients are
 * constructed, so the reason lives here:
 *
 *   Caller-keyed, short-lived rate-limit counters (lib/ratelimit.ts) and the
 *   content-keyed script cache (lib/scriptcache.ts) must live in two separate
 *   Upstash databases, not two namespaces of one — because a single
 *   database's command/REST log would temporally re-pair caller and content
 *   even when the key design keeps them apart. A "who" entry and a "what"
 *   entry milliseconds apart in one log is a link; in two databases' logs it
 *   is not. The counters database only ever sees hashed callers; the cache
 *   database only ever sees bill content keys. CI enforces the separation
 *   (scripts/check-key-namespaces.mjs).
 *
 * GRACEFUL DEGRADATION: both constructors return null when their env vars
 * are absent (local dev, CI, previews without env). Callers fall back to the
 * per-instance in-memory behavior the routes shipped with — a route must
 * NEVER hard-fail because Upstash is unreachable. On request errors, callers
 * fail open the same way; errors are counted and logged as status codes
 * only, never response bodies.
 */

export class UpstashRequestError extends Error {
  /** HTTP status, or 0 for network/timeout/protocol failures. */
  readonly status: number;
  constructor(status: number) {
    // Status code only — never a response body, never a command echo.
    super(`upstash request failed (status ${status})`);
    this.name = 'UpstashRequestError';
    this.status = status;
  }
}

export interface UpstashClient {
  /** Run one Redis command, e.g. ['SET', key, value, 'NX', 'EX', '600']. */
  cmd(command: string[]): Promise<unknown>;
}

const REQUEST_TIMEOUT_MS = 2000;

// Visible error counters (graceful-degradation observability): how many times
// each database has failed open to in-memory this instance's lifetime.
const errorCounts = { counters: 0, cache: 0 };

export function noteUpstashError(scope: 'counters' | 'cache', err: unknown): void {
  errorCounts[scope] += 1;
  const status = err instanceof UpstashRequestError ? err.status : 0;
  // Status code only — never bodies, never keys, never command args.
  console.error(
    `upstash ${scope}: request failed (status ${status}); failing open to in-memory (error #${errorCounts[scope]} this instance)`
  );
}

export function getUpstashErrorCounts(): { counters: number; cache: number } {
  return { ...errorCounts };
}

function restClient(url: string, token: string): UpstashClient {
  return {
    async cmd(command: string[]): Promise<unknown> {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          cache: 'no-store',
        });
      } catch {
        // Timeout or network failure. The caught error can embed the request
        // URL; log nothing here — the caller notes a status-0 error.
        throw new UpstashRequestError(0);
      }
      if (!res.ok) throw new UpstashRequestError(res.status);
      let data: { result?: unknown; error?: string };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        throw new UpstashRequestError(res.status);
      }
      if (data.error) throw new UpstashRequestError(res.status);
      return data.result;
    },
  };
}

/**
 * Client for the COUNTERS database: caller-keyed, short-lived rate-limit
 * counters and the rotating salt, nothing else. Content identifiers
 * (slug/stance/locale/tool) must never reach this database.
 * Null when unconfigured — callers degrade to in-memory.
 */
export function countersClient(): UpstashClient | null {
  const url = process.env.UPSTASH_COUNTERS_REST_URL;
  const token = process.env.UPSTASH_COUNTERS_REST_TOKEN;
  if (!url || !token) return null;
  return restClient(url, token);
}

/**
 * Client for the CACHE database: content-keyed generated scripts, nothing
 * else. Caller-derived material (IPs, hashes of IPs, addresses, the salt)
 * must never reach this database.
 * Null when unconfigured — callers degrade to in-memory.
 */
export function cacheClient(): UpstashClient | null {
  const url = process.env.UPSTASH_CACHE_REST_URL;
  const token = process.env.UPSTASH_CACHE_REST_TOKEN;
  if (!url || !token) return null;
  return restClient(url, token);
}

/**
 * Keyspace prefix so preview and production never share keys even though the
 * owner provisioned the same databases for both environments (the plan's
 * "preview and prod must not share Upstash keyspace" rule). 'production' |
 * 'preview' on Vercel; 'dev' everywhere else. scripts/verify-salt.mjs checks
 * the same literals — keep them in sync.
 */
export function keyPrefix(): string {
  return process.env.VERCEL_ENV ?? 'dev';
}
