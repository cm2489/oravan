// Type-only import (erased at compile time, zero runtime cost) — a VALUE
// import from lib/core/mcp.ts would transitively pull in lib/freshness.ts's
// `import 'server-only'`, which only resolves inside Next's own bundler
// (webpack/turbopack), not under plain node or tsx. scripts/daily-metrics.mjs
// (this file's one non-Next caller, via readUsageWindow below) MUST run
// under tsx to resolve lib/upstash.ts's own extensionless imports, so this
// module cannot depend on lib/core/mcp.ts at runtime — see MCP_TOOL_NAMES
// below for the (compile-time-checked) workaround.
import type { ToolName } from './core/mcp';
import { countersClient, keyPrefix, noteUpstashError, type UpstashClient } from './upstash';

/*
 * MCP tool / AI-script usage counters (traffic-watch design, 2026-07).
 * This module is the ONLY place usage-database keys are built — it is the
 * SEVENTH registry scripts/check-key-namespaces.mjs gates on, alongside
 * lib/ratelimit.ts, lib/scriptcache.ts, lib/embed-referrer.ts,
 * lib/tenancy.ts, and lib/impressions.ts.
 *
 * WHAT THIS IS, STATED PLAINLY: a daily, per-tool invocation count and a
 * daily per-client-software initialize-handshake count for the MCP server
 * (app/api/mcp/[transport]/route.ts), plus a daily generation count for
 * /api/script (app/api/script/route.ts) — an internal operating signal for
 * a founder-facing digest (scripts/daily-metrics.mjs), never a per-caller
 * or per-content record. Counts every MCP tool INVOCATION
 * regardless of outcome (a not_found/bad_zip toolError still counts — "how
 * many times was the tool called," not a success-rate metric); a
 * rate-limited (429) request never reaches this module at all, since
 * app/api/mcp/[transport]/route.ts's limitedPost returns before the
 * handler runs. /api/script counts only real cache-miss generations (an
 * actual Anthropic spend), not cache hits.
 *
 * WHY `tool` IS SAFE HERE AND NOWHERE ELSE (the load-bearing property):
 * scripts/check-key-namespaces.mjs's CONTENT_IDENTIFIER list forbids the
 * literal substring "tool" in every OTHER counters-family registry,
 * because for rate-limiting a tool name is content, not identity. This
 * registry is the deliberate exception: `tool` is drawn from `McpToolName`
 * below, a closed 5-member compile-time union the MCP SDK itself supplies
 * to each registerTool callback — it is NEVER caller-controlled input. An
 * unknown tool name never reaches any handler (the SDK dispatches only to
 * its own registered table), so there is no code path through which a
 * request could inject an arbitrary string into a usage key. See the new
 * `usage-content`/`usage-caller` rules in scripts/check-key-namespaces.mjs
 * for how this is CI-enforced (usage-content is the same CONTENT_IDENTIFIER
 * list minus `tool` — a caller's ZIP, bill slug, or search string must
 * still never reach a usage key).
 *
 * Key registry — the only shapes ever written under this family:
 *
 *   <env>:usage:mcp:<tool>:<YYYY-MM-DD>          an INCR'd daily counter per tool
 *   <env>:usage:mcp-client:<client>:<YYYY-MM-DD> an INCR'd daily counter per
 *                                                self-reported MCP client
 *                                                software name — initialize
 *                                                HANDSHAKES, not tool calls
 *                                                (see noteMcpClientHandshake)
 *   <env>:usage:script:<YYYY-MM-DD>              an INCR'd daily counter
 *
 * All three families are content-free (no slug/stance/locale/query/bill)
 * and caller-free (no IP/UA/referer/salt) by construction: noteMcpToolCall's
 * only parameter is a closed-union tool name, noteScriptGeneration takes no
 * parameter at all, and noteMcpClientHandshake's one input is force-
 * sanitized into a bounded software-name alphabet before any key is built —
 * see the CONSTITUTIONAL CONSTRAINT comment at sanitizeMcpClientName.
 */

// 90 days: long enough for month-over-month trend context beyond a single
// week-over-week comparison (scripts/daily-metrics.mjs's own WoW compares
// day-1 against day-8), short enough that this stays an internal operating
// signal, not a durable business record — well short of the impressions
// family's 400d (lib/impressions.ts), which IS a sold, business-facing
// metric. Revisit if the digest ever grows a month-over-month view.
const USAGE_TTL_SECONDS = 90 * 24 * 60 * 60;

export type McpToolName = ToolName;

// A runtime-safe DUPLICATE of lib/core/mcp.ts's TOOL_NAMES — see the
// import comment above for why this can't be a runtime import instead.
// Compile-time-checked, not just hand-maintained: `_AssertComplete` below
// fails to typecheck (never a silent runtime drift) the moment ToolName
// gains or loses a member and this array isn't updated to match.
export const MCP_TOOL_NAMES = [
  'lookup_representatives',
  'get_bill',
  'search_bills',
  'whats_moving',
  'get_representative',
] as const satisfies readonly ToolName[];

type _AssertMcpToolNamesComplete = ToolName extends (typeof MCP_TOOL_NAMES)[number] ? true : never;
const _mcpToolNamesComplete: _AssertMcpToolNamesComplete = true;
void _mcpToolNamesComplete;

// --- usage-database key builders (the whole registry) -----------------------

export function mcpUsageKey(tool: McpToolName, day: string): string {
  return `${keyPrefix()}:usage:mcp:${tool}:${day}`;
}

export function scriptUsageKey(day: string): string {
  return `${keyPrefix()}:usage:script:${day}`;
}

/** UTC calendar date, YYYY-MM-DD — the daily bucket a usage count lives under. */
export function usageDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// --- MCP client-software handshake counters (2026-07) -----------------------

/*
 * CONSTITUTIONAL CONSTRAINT (CLAUDE.md "no server-side user data"): the
 * <client> key segment is the CLIENT SOFTWARE's self-reported name from the
 * MCP initialize handshake's params.clientInfo.name (e.g. "claude-ai",
 * "glama") — the identity of a PROGRAM, never of a person. Nothing else is
 * ever stored: no clientInfo.version, no User-Agent, no IP, no session
 * correlation — the counter is one integer per software name per UTC day.
 *
 * Unlike `tool` above (a closed compile-time union), this segment IS
 * caller-controlled input, so sanitization is structural, not advisory:
 * mcpClientUsageKey applies sanitizeMcpClientName itself, leaving no code
 * path through which a raw name can reach a key. The sanitized alphabet
 * ([a-z0-9._-], max 32 chars, "unknown" fallback) cannot carry the key
 * separator (":"), a glob character, or meaningful free-text — a hostile
 * clientInfo.name degrades to a short ASCII token, never key-structure
 * injection or an unbounded-length key.
 */

export const UNKNOWN_MCP_CLIENT = 'unknown';
const MCP_CLIENT_NAME_MAX_CHARS = 32;

/**
 * Lowercase, strip everything outside [a-z0-9._-], THEN truncate to 32
 * chars (strip-before-truncate keeps more signal from a name padded with
 * separators); empty/missing/non-string input degrades to "unknown".
 * Idempotent: sanitize(sanitize(x)) === sanitize(x).
 */
export function sanitizeMcpClientName(raw: unknown): string {
  if (typeof raw !== 'string') return UNKNOWN_MCP_CLIENT;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, MCP_CLIENT_NAME_MAX_CHARS);
  return cleaned === '' ? UNKNOWN_MCP_CLIENT : cleaned;
}

export function mcpClientUsageKey(client: string, day: string): string {
  // Sanitization applied HERE, not just at the call site — see the
  // CONSTITUTIONAL CONSTRAINT comment above for why this is structural.
  return `${keyPrefix()}:usage:mcp-client:${sanitizeMcpClientName(client)}:${day}`;
}

// --- the ingestion calls ------------------------------------------------------

// In-memory fallback (env absent — local dev/CI/preview without env): same
// shape as lib/impressions.ts's own fallback map. Nothing here ever
// survives a redeploy — this path only exists so a usage write never
// throws when Upstash isn't configured.
const memoryCounts = new Map<string, number>();
const MEMORY_MAX_ENTRIES = 2000;

let fallbackLogged = false;

/** Test seam only — mirrors lib/impressions.ts's single-startup-line seam. */
export function __resetUsageFallbackLogForTests(): void {
  fallbackLogged = false;
}

/** Test seam only — reads the in-memory fallback count for one key. */
export function __memoryUsageCountForTests(key: string): number {
  return memoryCounts.get(key) ?? 0;
}

function logFallbackOnce(): void {
  if (fallbackLogged) return;
  fallbackLogged = true;
  console.log(
    'usage: counters database not configured (env absent) — using per-instance in-memory usage counts (expected in local dev, CI, and previews without env)'
  );
}

function memoryIncrement(key: string): void {
  if (memoryCounts.size >= MEMORY_MAX_ENTRIES) memoryCounts.clear(); // crude memory cap
  memoryCounts.set(key, (memoryCounts.get(key) ?? 0) + 1);
}

async function durableIncrement(client: UpstashClient, key: string): Promise<void> {
  // SET NX EX before INCR: the TTL is attached at creation, mirroring
  // lib/impressions.ts's durableIncrement, so a crash between commands can
  // never leave a TTL-less (effectively permanent) usage counter.
  const created = await client.cmd(['SET', key, '0', 'NX', 'EX', String(USAGE_TTL_SECONDS)]);
  const count = await client.cmd(['INCR', key]);
  if (count === 1 && created !== 'OK') {
    // The key expired between SET and INCR and INCR recreated it bare —
    // rare window-boundary race; re-attach the TTL.
    await client.cmd(['EXPIRE', key, String(USAGE_TTL_SECONDS)]);
  }
}

async function noteUsage(key: string): Promise<void> {
  const client = countersClient();
  if (!client) {
    logFallbackOnce();
    memoryIncrement(key);
    return;
  }
  try {
    await durableIncrement(client, key);
  } catch (err) {
    noteUpstashError('counters', err);
    memoryIncrement(key); // fail open — never blocks or fails the request
  }
}

/**
 * Record one MCP tool invocation. Called via `after()` (or, if `after()`'s
 * AsyncLocalStorage propagation through mcp-handler's callback dispatch
 * turns out not to hold, a direct unawaited call — see this file's PR
 * notes) from inside each registerTool callback in
 * app/api/mcp/[transport]/route.ts, so a slow or failed write can never
 * delay the tool's own response. Never throws.
 */
export async function noteMcpToolCall(tool: McpToolName): Promise<void> {
  await noteUsage(mcpUsageKey(tool, usageDayKey()));
}

/**
 * Record one real (cache-miss) script generation. Called via `after()` from
 * app/api/script/route.ts immediately after a successful cache.set, so a
 * slow or failed write can never delay the response. Never throws.
 */
export async function noteScriptGeneration(): Promise<void> {
  await noteUsage(scriptUsageKey(usageDayKey()));
}

/**
 * Record one MCP initialize HANDSHAKE — a client software connecting, NOT a
 * tool call. Handshakes are the honest unit for this family: the HTTP route
 * is deliberately stateless (fresh McpServer per POST), so the SDK's
 * initialize-time clientInfo (server.server.getClientVersion()) is always
 * undefined by the time a separate tools/call POST arrives — verified
 * empirically against mcp-handler@1.1.0 + @modelcontextprotocol/sdk@1.26.0.
 * The initialize request's own body is the one place the name exists, so
 * that is what gets counted, once per handshake.
 *
 * Called via `after()` from app/api/mcp/[transport]/route.ts's limitedPost
 * (rate-limited requests never reach it), so a slow or failed write can
 * never delay the response. Takes the RAW caller-controlled
 * params.clientInfo.name as `unknown` and sanitizes before any key is
 * built (see sanitizeMcpClientName). Never throws.
 */
export async function noteMcpClientHandshake(clientName: unknown): Promise<void> {
  await noteUsage(mcpClientUsageKey(sanitizeMcpClientName(clientName), usageDayKey()));
}

// --- the digest read path (scripts/daily-metrics.mjs, via tsx) --------------

export type UsageWindowResult =
  | { ok: true; mcp: Record<McpToolName, number[]>; script: number[] }
  | { ok: false };

/**
 * Read `days.length` days' worth of counts for all 5 MCP tools + script
 * generations, ONE Upstash round trip via MGET, never N sequential GETs —
 * mirrors lib/impressions.ts's readImpressionsWindow. `days` is caller-
 * supplied (scripts/daily-metrics.mjs's trailingWindowDays, from
 * lib/traffic-metrics.mjs) and this function is order-agnostic beyond
 * "index i in `days` maps back to index i in each returned array."
 *
 * DELIBERATE WRITE/READ ASYMMETRY (same reasoning as
 * readImpressionsWindow): the write path above fails open and silent. This
 * read fails LOUD instead — `{ ok: false }` on an unconfigured counters
 * client, an Upstash request error, or a malformed MGET result, never a
 * silently-degraded number. The per-instance in-memory fallback the write
 * path uses would badly undercount here too (this read runs once, from a
 * short-lived GitHub Actions process, not a long-lived serverless
 * instance — there is no meaningful in-memory fallback to fall back TO),
 * so the caller (scripts/daily-metrics.mjs) turns `{ ok: false }` into a
 * loud CI failure, never a digest with an invented number in it.
 */
export async function readUsageWindow(days: string[]): Promise<UsageWindowResult> {
  const client = countersClient();
  if (!client) return { ok: false };

  const allKeys = [
    ...MCP_TOOL_NAMES.flatMap((tool) => days.map((day) => mcpUsageKey(tool, day))),
    ...days.map((day) => scriptUsageKey(day)),
  ];

  let raw: unknown;
  try {
    raw = await client.cmd(['MGET', ...allKeys]);
  } catch (err) {
    noteUpstashError('counters', err, 'failing closed to a digest read error (usage window, never a degraded number)');
    return { ok: false };
  }
  if (!Array.isArray(raw) || raw.length !== allKeys.length) return { ok: false };

  const toNum = (v: unknown): number => (typeof v === 'string' ? Number(v) || 0 : 0);
  const mcp = {} as Record<McpToolName, number[]>;
  let cursor = 0;
  for (const tool of MCP_TOOL_NAMES) {
    mcp[tool] = raw.slice(cursor, cursor + days.length).map(toNum);
    cursor += days.length;
  }
  const script = raw.slice(cursor, cursor + days.length).map(toNum);

  return { ok: true, mcp, script };
}

export type McpClientDayResult =
  | { ok: true; clients: Array<{ client: string; count: number }> }
  | { ok: false };

// SCAN page budget for readMcpClientDay. The sanitized-name alphabet caps
// the family at one key per distinct 32-char token per day, so a day's
// worth of client keys is small; 50 pages × COUNT 100 is orders of
// magnitude of headroom. If the cursor still hasn't exhausted by then,
// something is wrong — fail closed rather than under-report.
const MCP_CLIENT_SCAN_MAX_PAGES = 50;

/**
 * Read ONE day's MCP client-handshake counts, every client name seen that
 * day. Client names are open-ended (self-reported), so unlike
 * readUsageWindow there is no fixed key list to MGET directly — this SCANs
 * the day's `usage:mcp-client:*` pattern first (cursor loop, bounded), then
 * MGETs the found keys in one round trip. Returns clients sorted by count
 * descending, ties alphabetical.
 *
 * Same DELIBERATE WRITE/READ ASYMMETRY as readUsageWindow above: fails
 * LOUD (`{ ok: false }`) on an unconfigured client, a request error, a
 * malformed reply, or an unexhausted scan — never a silently-degraded
 * list. A day with genuinely no handshakes is `{ ok: true, clients: [] }`,
 * which the digest renders as an honest "none recorded".
 */
export async function readMcpClientDay(day: string): Promise<McpClientDayResult> {
  const client = countersClient();
  if (!client) return { ok: false };

  const prefix = `${keyPrefix()}:usage:mcp-client:`;
  const suffix = `:${day}`;

  const found = new Set<string>(); // SCAN may return a key more than once
  let scanCursor = '0';
  try {
    for (let page = 0; page < MCP_CLIENT_SCAN_MAX_PAGES; page += 1) {
      const raw = await client.cmd(['SCAN', scanCursor, 'MATCH', `${prefix}*${suffix}`, 'COUNT', '100']);
      if (!Array.isArray(raw) || raw.length !== 2 || !Array.isArray(raw[1])) return { ok: false };
      for (const key of raw[1]) {
        if (typeof key === 'string') found.add(key);
      }
      scanCursor = String(raw[0]);
      if (scanCursor === '0') break;
    }
  } catch (err) {
    noteUpstashError(
      'counters',
      err,
      'failing closed to a digest read error (MCP client handshakes, never a degraded number)'
    );
    return { ok: false };
  }
  if (scanCursor !== '0') return { ok: false }; // never exhausted — refuse to under-report

  const keys = [...found];
  if (keys.length === 0) return { ok: true, clients: [] };

  let counts: unknown;
  try {
    counts = await client.cmd(['MGET', ...keys]);
  } catch (err) {
    noteUpstashError(
      'counters',
      err,
      'failing closed to a digest read error (MCP client handshakes, never a degraded number)'
    );
    return { ok: false };
  }
  if (!Array.isArray(counts) || counts.length !== keys.length) return { ok: false };

  const clients = keys
    .map((key, i) => ({
      client: key.slice(prefix.length, key.length - suffix.length),
      count: typeof counts[i] === 'string' ? Number(counts[i]) || 0 : 0,
    }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || (a.client < b.client ? -1 : a.client > b.client ? 1 : 0));

  return { ok: true, clients };
}
