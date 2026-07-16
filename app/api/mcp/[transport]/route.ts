import { createMcpHandler } from 'mcp-handler';
import { after, NextResponse } from 'next/server';
import { callerIp, createRateLimiter, readOravanKey } from '@/lib/ratelimit';
import { registerOravanTools } from '@/lib/core/mcp-tools';
import { noteMcpClientHandshake, noteMcpToolCall } from '@/lib/usage';

/*
 * Oravan's MCP server (S10). Five read-only tools over lib/core/mcp.ts's
 * pure functions, which read the same baked JSON the site's own pages read -
 * an agent's answer and a visitor's page can never disagree. No tool here
 * makes an outbound network call; the one the spec allows (Census address
 * refinement inside lookup_representatives) is deliberately deferred - see
 * lib/core/mcp.ts's lookupRepresentatives doc comment.
 *
 * Exactly these 5, per docs/ideation/2026-07-02-mcp-spec.md §2 and the
 * settled S10 scope call (KTD-6, closed under R16): lookup_representatives,
 * get_bill, search_bills, whats_moving, get_representative.
 *   - get_bill_coverage is cut. Not registered, not aliased - a request for
 *     it is simply an unknown tool, same as any other.
 *   - draft_call_script is never exposed here. get_bill's `act_url` link-out
 *     is the deliberate replacement (see lib/core/mcp.ts).
 * Every tool is readOnlyHint + openWorldHint:false (the spec's own design
 * rule, §2) - true here in the most literal sense: nothing in this file
 * performs I/O beyond reading process-local, build-time-baked JSON.
 *
 * Tool DEFINITIONS (zod schemas, annotations, TOOL_INFO title/description,
 * pure handler bodies) live in lib/core/mcp-tools.ts's `registerOravanTools`
 * (feat/mcp-stdio-entry) - extracted so lib/mcp-stdio.ts's stdio transport
 * (built for Glama's MCP directory, which sandbox-validates a server by
 * building and running it locally over stdio - proxying to this hosted
 * endpoint is explicitly rejected by their harness) can register the exact
 * same 5 tools without a second hand-copy. This file keeps every HTTP-only
 * concern: mcp-handler's Streamable HTTP wiring, rate limiting (below), and
 * the after()-deferred usage-counter write threaded into
 * registerOravanTools via `onToolCall`. tests/mcp.spec.ts + tests/
 * mcp-tools.spec.ts hit this route over real HTTP unchanged and are the
 * pinning proof that the extraction changed WHERE the registration code
 * lives, never WHAT it does.
 *
 * Streamable HTTP only (SSE is disabled: the 2025-03-26 MCP spec deprecated
 * SSE-only transports), and stateless: no sessionIdGenerator, so every
 * request gets a fresh McpServer/transport pair and nothing survives
 * between requests. That statelessness is what makes this safe to run on
 * serverless compute with zero coordination - the same reasoning the rest
 * of the API surface already follows (see app/api/district/route.ts).
 *
 * Constitution check (CLAUDE.md "no server-side user data"), verified here
 * in code, not just in review:
 *  - No cookies: neither this handler nor mcp-handler's stateless path sets
 *    any Set-Cookie header.
 *  - No logging of request bodies or IPs: `verboseLogs` stays false (the
 *    library's default - set explicitly so a future edit can't flip it by
 *    accident) and `onEvent` is left unset, so no request/response/session
 *    detail is ever captured, let alone written anywhere.
 *  - No content identifiers in caller-originating query strings: this route
 *    takes no query params at all (Streamable HTTP is POST-body JSON-RPC,
 *    same "never a query string" posture as app/api/district's house
 *    pattern) - every tool argument arrives in the POST body.
 *  - Every argument that reaches a tool handler is the caller's own lookup
 *    key (a ZIP, a slug, a bioguide, a search string) - nothing here writes
 *    it anywhere; it's read once, used to look up baked JSON, and discarded
 *    when the response is returned.
 *  - The one pre-handler body read (countClientHandshakes below) extracts
 *    exactly one field - initialize's params.clientInfo.name, the calling
 *    SOFTWARE's self-reported name - and nothing else; see that function's
 *    own constitutional-constraint comment.
 *
 * Bilingual-parity scope note (the fix that closed the envelope/refine_hint/
 * tool-error gap PR #46 pinned): the `title`/`description` each
 * registerTool call in lib/core/mcp-tools.ts pulls from lib/core/mcp.ts's
 * TOOL_INFO (S12 - relocated there, not duplicated, so the public /mcp docs
 * page can quote the same literal strings), and every zod `.describe()`
 * schema string (including localeSchema's own "en (default) or es" line),
 * stay English-only, deliberately. Those strings are tool/schema metadata
 * the calling agent's model reads to decide how to call the tool - they are
 * never returned in a response payload and never relayed to the end user
 * verbatim, unlike `meta`'s envelope fields or a toolError() message. Every
 * string that IS returned to a caller - the citation envelope
 * (lib/core/mcp.ts), lookup_representatives' `refine_hint`, and every
 * toolError() message in lib/core/mcp-tools.ts - is now locale-paired.
 */
export const dynamic = 'force-dynamic';

const handler = createMcpHandler(
  (server) => {
    /*
     * Usage-counting wrapper (traffic-watch design, 2026-07): one call site
     * instead of five edits scattered through each handler body. Counts
     * every INVOCATION regardless of outcome (a toolError result still
     * counts — "how many times was the tool called," not a success-rate
     * metric) via `after()`, so a slow or failed counter write can never
     * delay the tool's own response — see lib/usage.ts's header comment for
     * the full key-safety argument (`tool` here is always one of ToolName's
     * five compile-time literals lib/core/mcp-tools.ts itself supplies,
     * never caller-controlled input). Rate-limited (429) requests never
     * reach this wrapper at all — limitedPost below returns before
     * `handler(req)` runs.
     */
    registerOravanTools(server, {
      onToolCall: (tool) => {
        after(() => noteMcpToolCall(tool));
      },
    });
  },
  {
    serverInfo: { name: 'oravan', version: '0.1.0' },
  },
  {
    basePath: '/api/mcp',
    disableSse: true,
    verboseLogs: false,
  }
);

/*
 * Anonymous (keyless) rate limits per the S11 spec: 60 requests/min and
 * 1,000/day per caller, enforced with the same short-lived rate-limit
 * counters as the rest of the API surface (lib/ratelimit.ts — hashed
 * caller only; a tool name never reaches a counter key, by construction:
 * the limiter API only accepts a caller IP and a closed route label).
 * Only POST carries JSON-RPC work, so only POST is limited; GET/DELETE
 * are the transport's cheap 405s. Degrades to per-instance in-memory
 * counters when Upstash is unconfigured or unreachable, like every route.
 */
const minuteLimiter = createRateLimiter({ route: 'mcp-min', max: 60, windowSec: 60 });
const dayLimiter = createRateLimiter({ route: 'mcp-day', max: 1000, windowSec: 86400 });

/*
 * MCP client-software handshake counter (2026-07). WHY HANDSHAKES, NOT TOOL
 * CALLS: this route is deliberately stateless (no sessionIdGenerator — see
 * the header comment), so mcp-handler builds a FRESH McpServer per POST and
 * the SDK's initialize-time clientInfo (server.server.getClientVersion())
 * is always undefined by the time a separate tools/call POST arrives —
 * verified empirically against mcp-handler@1.1.0 + SDK 1.26.0. The
 * initialize request's own body is the one place the name exists, so this
 * route counts THAT: one increment per initialize handshake, keyed by the
 * client software's self-reported name.
 *
 * CONSTITUTIONAL CONSTRAINT (CLAUDE.md "no server-side user data"): the
 * ONLY thing read out of the body here is params.clientInfo.name — the
 * calling SOFTWARE's self-chosen name (e.g. "claude-ai", "glama"), the
 * identity of a program, never of a person. No clientInfo.version, no
 * User-Agent, no IP reaches the counter (lib/usage.ts force-sanitizes the
 * name structurally before any key is built). The body is parsed from a
 * clone() — the original stream stays untouched for the transport — and
 * the parsed value is discarded immediately: never logged, never stored.
 *
 * Counting must never break request handling: every parse failure is
 * swallowed (the transport below produces the real JSON-RPC error for a
 * malformed body) and the write itself is after()-deferred, exactly like
 * onToolCall's tool counters. Handles both a single JSON-RPC object and a
 * batch array (batches exist in pre-2025-06-18 protocol revisions and the
 * SDK transport still parses them — handled defensively here so a batched
 * initialize is neither missed nor a crash).
 */
async function countClientHandshakes(req: Request): Promise<void> {
  try {
    const body: unknown = await req.clone().json();
    for (const raw of Array.isArray(body) ? body : [body]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const msg = raw as { method?: unknown; params?: unknown };
      if (msg.method !== 'initialize') continue;
      const params =
        typeof msg.params === 'object' && msg.params !== null
          ? (msg.params as { clientInfo?: unknown })
          : {};
      const info =
        typeof params.clientInfo === 'object' && params.clientInfo !== null
          ? (params.clientInfo as { name?: unknown })
          : {};
      const name = info.name; // raw + caller-controlled; sanitized in lib/usage.ts
      after(() => noteMcpClientHandshake(name));
    }
  } catch {
    // Non-JSON or malformed body: nothing to count, deliberately silent —
    // the transport returns the real JSON-RPC parse error to the caller.
  }
}

async function limitedPost(req: Request): Promise<Response> {
  readOravanKey(req.headers); // dormant tenancy hook (S18/S19): recognized, no behavior yet

  const ip = callerIp(req.headers);
  if (await minuteLimiter.isLimited(ip)) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': '60' } }
    );
  }
  if (await dayLimiter.isLimited(ip)) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': '3600' } }
    );
  }
  // AFTER the rate-limit gates on purpose: a 429'd request never counts,
  // the same posture as the per-tool counters (see the wrapper comment in
  // the createMcpHandler callback above).
  await countClientHandshakes(req);
  return handler(req);
}

export { handler as GET, limitedPost as POST, handler as DELETE };
