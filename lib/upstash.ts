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

/*
 * ENV-VALUE PASTE-MISTAKE TOLERANCE — added after a verified eight-night
 * failure: a workflow step that pings each Upstash REST URL and prints only
 * the first 8 hostname characters found that the CACHE database's
 * UPSTASH_CACHE_REST_URL GitHub Actions secret VALUE begins with the literal
 * text `UPSTASH_` — someone pasted a whole `UPSTASH_CACHE_REST_URL=https://…`
 * env line (or just the bare variable name) as the secret's value, not the
 * URL itself. Every cache request from the nightly pregen then failed with
 * status 0 ("upstash cache: request failed (status 0); failing open to
 * in-memory"), and pregen paid for scripts it could never store
 * (lib/pregen-runner.ts's whole reason for existing is to catch that). The
 * token secret can be pasted the same wrong way.
 *
 * normalizeEnvValue is the pure cleanup: trim whitespace, strip one layer of
 * surrounding quotes (a value pasted as `"https://…"`), and — if what's left
 * still starts with the variable's OWN name followed by `=` — strip that
 * prefix once (quotes are stripped again afterward, in case the mistake was
 * `NAME="value"` rather than `"NAME=value"`). Never strips a SECOND `NAME=`
 * — a value that still starts with the prefix after one strip is left alone
 * rather than looped over, so this can never eat into a legitimate value
 * that happens to start with its own variable name twice.
 *
 * Callers below (readUrlEnv/readTokenEnv) log exactly ONE console.warn per
 * process per malformed variable — never its value, only its NAME — so a
 * misconfigured secret is loud without ever leaking into logs the thing
 * CLAUDE.md forbids logging. readUrlEnv additionally requires https:// (a
 * bare `NAME=` prefix stripped down to nothing, or a non-URL paste, must
 * never reach fetch() as a URL) and otherwise treats the database as
 * unconfigured, logging which variable — never the value — the same way.
 */

/** One layer of matching `"..."` or `'...'` around a value, else unchanged. */
function stripSurroundingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export interface NormalizedEnvValue {
  /** Cleaned value, or null when absent/empty after cleanup. */
  value: string | null;
  /** Surrounding quotes had to be stripped (before and/or after the prefix strip). */
  strippedQuotes: boolean;
  /** A leading `${name}=` — the whole-env-line paste mistake — had to be stripped. */
  strippedPrefix: boolean;
}

/**
 * Pure. Trims whitespace and one layer of surrounding quotes; if what
 * remains starts with `${name}=` (the pasted-a-whole-env-line, or
 * pasted-the-variable-name, mistake), strips that prefix once and re-trims
 * quotes around what's left; returns `value: null` for empty/absent.
 */
export function normalizeEnvValue(name: string, raw: string | undefined): NormalizedEnvValue {
  if (raw === undefined) return { value: null, strippedQuotes: false, strippedPrefix: false };

  let value = raw.trim();
  let strippedQuotes = false;
  const unquoted = stripSurroundingQuotes(value);
  if (unquoted !== value) {
    strippedQuotes = true;
    value = unquoted.trim();
  }

  let strippedPrefix = false;
  const prefix = `${name}=`;
  if (value.startsWith(prefix)) {
    strippedPrefix = true;
    value = value.slice(prefix.length).trim();
    const reUnquoted = stripSurroundingQuotes(value);
    if (reUnquoted !== value) {
      strippedQuotes = true;
      value = reUnquoted.trim();
    }
  }

  return { value: value === '' ? null : value, strippedQuotes, strippedPrefix };
}

// One console.warn per process per malformed variable NAME — never the
// value. Module-level, so it survives across calls within one instance but
// never repeats per-request (matches lib/scriptcache.ts's logFallbackOnce
// seam, one flag per variable instead of one flag total).
const warnedEnvVars = new Set<string>();

/** Test seam only — mirrors lib/ratelimit.ts's __resetSaltMemoForTests. */
export function __resetUpstashEnvWarningsForTests(): void {
  warnedEnvVars.clear();
}

function warnIfMalformed(name: string, result: NormalizedEnvValue): void {
  if (!result.strippedPrefix && !result.strippedQuotes) return;
  if (warnedEnvVars.has(name)) return;
  warnedEnvVars.add(name);
  const reason = result.strippedPrefix
    ? "was set as a `NAME=value` line; using the value after '='"
    : 'was set with surrounding quotes; using the value with them stripped';
  console.warn(`upstash: ${name} ${reason} — re-set the secret cleanly`);
}

/**
 * https:// is required — with ONE narrow, sanctioned exception:
 * tests/e2e-server.mjs's in-process fake Upstash backend for the TENANCY
 * database, which the CI e2e job (and any local full `playwright test` run)
 * points UPSTASH_TENANCY_REST_URL at over plain http://127.0.0.1 — test-only
 * infra, documented there as "never part of the shipped app". Every other
 * UPSTASH_*_REST_URL in this repo (real Upstash, or tests/upstash-mock.ts's
 * https://*.mock.test fixtures) is already https://, so this exception
 * never widens what a real, live database's URL is allowed to be.
 */
function isAcceptableUrl(value: string): boolean {
  return value.startsWith('https://') || value.startsWith('http://127.0.0.1:');
}

/** Read + clean a *_REST_URL var; https:// (see isAcceptableUrl) is required or it's treated as unconfigured. */
function readUrlEnv(name: string): string | null {
  const result = normalizeEnvValue(name, process.env[name]);
  warnIfMalformed(name, result);
  if (result.value === null) return null;
  if (!isAcceptableUrl(result.value)) {
    // Variable name only — never the value — same discipline as noteUpstashError above.
    console.error(`upstash: ${name} does not start with https:// — treating the database as not configured`);
    return null;
  }
  return result.value;
}

/** Read + clean a *_REST_TOKEN var. No format beyond non-empty is enforced. */
function readTokenEnv(name: string): string | null {
  const result = normalizeEnvValue(name, process.env[name]);
  warnIfMalformed(name, result);
  return result.value;
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
  const url = readUrlEnv('UPSTASH_COUNTERS_REST_URL');
  const token = readTokenEnv('UPSTASH_COUNTERS_REST_TOKEN');
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
  const url = readUrlEnv('UPSTASH_CACHE_REST_URL');
  const token = readTokenEnv('UPSTASH_CACHE_REST_TOKEN');
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
  const url = readUrlEnv('UPSTASH_TENANCY_REST_URL');
  const token = readTokenEnv('UPSTASH_TENANCY_REST_TOKEN');
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

/**
 * CLI-only configuration checks (S21, scripts/tenant-admin.mjs via
 * lib/tenant-admin.ts): every route caller in this repo treats an
 * unconfigured database as "degrade gracefully" (counters/cache: fall back
 * to in-memory; tenancy: fail closed to not-authorized) — never a loud
 * refusal, because a request-serving route must never crash a visitor's
 * page load over a missing env var. An interactive owner CLI has the
 * opposite obligation: silently operating on an empty/wrong keyspace would
 * waste the owner's time and could look like "no tenants exist" when the
 * real problem is a missing token. These two functions exist ONLY so
 * lib/tenant-admin.ts can refuse loudly (nonzero exit) before running a
 * command — they deliberately live here, not in lib/tenant-admin.ts itself,
 * so the env var literals stay confined to this one file
 * (scripts/check-key-namespaces.mjs's env-confinement rule).
 */
export function tenancyConfigured(): boolean {
  return Boolean(readUrlEnv('UPSTASH_TENANCY_REST_URL') && readTokenEnv('UPSTASH_TENANCY_REST_TOKEN'));
}

export function countersConfigured(): boolean {
  return Boolean(readUrlEnv('UPSTASH_COUNTERS_REST_URL') && readTokenEnv('UPSTASH_COUNTERS_REST_TOKEN'));
}
