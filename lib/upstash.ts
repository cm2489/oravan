/*
 * Minimal Upstash Redis REST client — plain fetch, no SDK (S11).
 *
 * Why plain fetch instead of @upstash/redis: the command surface here is
 * six commands (GET / SET NX EX / INCR / EXPIRE / TTL / DEL), the repo's
 * test convention already mocks globalThis.fetch (tests/feedback.unit.spec.ts
 * pattern), and a privacy-critical path should carry zero extra supply-chain
 * surface. If the command surface ever grows past trivial, revisit.
 *
 * THREE PHYSICALLY SEPARATE DATABASES — this is the load-bearing design rule
 * (KTD-3, strategy §9.1(c); tenancy added S18), and this file is where all
 * three clients are constructed, so the reason lives here:
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
 *   The tenancy database (lib/tenancy.ts, S18) holds durable institutional
 *   tenant records (domain, org name, tier, logo — Stripe-webhook-issued
 *   capability tokens) and does not fit either existing database's contract:
 *   it is neither short-lived (counters is TTL-bound by design; tenant
 *   config persists until Stripe says otherwise) nor content-free-and-
 *   caller-free (cache and the embed-domain-nomination family are both
 *   deliberately thin; a tenant record is rich and identifying on purpose,
 *   because Stripe already permits it to exist). Putting a tenant lookup and
 *   a content-keyed script fetch in the same database's command log would
 *   recreate, one layer up, the exact "who + what" re-pairing risk that
 *   justified splitting counters from cache in the first place — so tenancy
 *   gets its own physical database for the same reason ratelimit and
 *   scriptcache don't share one. Stripe remains the system of record for
 *   tenant identity/billing; this database is a fast, request-path-readable
 *   CACHE of a subset of Stripe's state, kept in sync by the webhook and
 *   fully reconstructable from Stripe if lost — a different consistency
 *   philosophy from both other databases, which is one more reason it lives
 *   apart from them.
 *
 * GRACEFUL DEGRADATION: all three constructors return null when their env
 * vars are absent (local dev, CI, previews without env) — a uniform CLIENT
 * behavior, so the env/client-confinement CI rules stay uniform across all
 * three registries. What differs is how each REGISTRY module interprets
 * that null: countersClient/cacheClient callers fall back to per-instance
 * in-memory behavior — a route must NEVER hard-fail because Upstash is
 * unreachable, and on request errors those callers fail open the same way
 * (errors counted and logged as status codes only, never response bodies).
 * tenancyClient callers do the OPPOSITE — see lib/tenancy.ts's
 * lookupTenantByToken doc comment for why fail-CLOSED is deliberate there.
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
// each database has failed this instance's lifetime. For counters/cache that
// means "failed open to in-memory"; for tenancy it means "failed closed to
// not-authorized" — the log line's wording below is qualified per scope.
const errorCounts = { counters: 0, cache: 0, tenancy: 0 };

/**
 * `consequenceOverride` (S20): every counters-database WRITE in this repo
 * fails open to in-memory, so that's the right default wording for `scope:
 * 'counters'`. lib/impressions.ts's READ path (readImpressionsWindow) is
 * the one exception — it deliberately fails CLOSED (503, never a
 * silently-degraded number from the per-instance in-memory fallback, which
 * would badly undercount a serverless fleet's real total) — so it passes an
 * accurate override rather than let this call claim "failing open" for a
 * path that doesn't. Every other call site keeps the two-arg form
 * unchanged.
 */
export function noteUpstashError(
  scope: 'counters' | 'cache' | 'tenancy',
  err: unknown,
  consequenceOverride?: string
): void {
  errorCounts[scope] += 1;
  const status = err instanceof UpstashRequestError ? err.status : 0;
  const consequence =
    consequenceOverride ?? (scope === 'tenancy' ? 'failing closed to not-authorized' : 'failing open to in-memory');
  // Status code only — never bodies, never keys, never command args.
  console.error(
    `upstash ${scope}: request failed (status ${status}); ${consequence} (error #${errorCounts[scope]} this instance)`
  );
}

export function getUpstashErrorCounts(): { counters: number; cache: number; tenancy: number } {
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
 * Client for the TENANCY database (S18): durable institutional tenant
 * records and their capability-token reverse index, nothing else.
 * Caller-derived material (IPs, hashes of IPs, addresses, the salt) must
 * never reach this database, same as the cache database's rule — a tenancy
 * lookup is institutional, not a citizen request, and must never blur into
 * the caller-keyed doctrine either.
 * Null when unconfigured — but unlike countersClient/cacheClient, this
 * null is interpreted as FAIL CLOSED by its one caller (lib/tenancy.ts),
 * not "degrade to in-memory". See that file's lookupTenantByToken.
 */
export function tenancyClient(): UpstashClient | null {
  const url = process.env.UPSTASH_TENANCY_REST_URL;
  const token = process.env.UPSTASH_TENANCY_REST_TOKEN;
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
