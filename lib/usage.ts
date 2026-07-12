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
 * WHAT THIS IS, STATED PLAINLY: a daily, per-tool invocation count for the
 * MCP server (app/api/mcp/[transport]/route.ts) and a daily generation
 * count for /api/script (app/api/script/route.ts) — an internal operating
 * signal for a founder-facing digest (scripts/daily-metrics.mjs), never a
 * per-caller or per-content record. Counts every MCP tool INVOCATION
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
 *   <env>:usage:mcp:<tool>:<YYYY-MM-DD>     an INCR'd daily counter per tool
 *   <env>:usage:script:<YYYY-MM-DD>         an INCR'd daily counter
 *
 * Both families are content-free (no slug/stance/locale/query/bill) and
 * caller-free (no IP/UA/referer/salt) by construction: noteMcpToolCall's
 * only parameter is a closed-union tool name, and noteScriptGeneration
 * takes no parameter at all.
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
