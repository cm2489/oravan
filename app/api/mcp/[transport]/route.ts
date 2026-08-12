import { createMcpHandler } from 'mcp-handler';
import { after, NextResponse } from 'next/server';
import { callerIp, createRateLimiter, readOravanKey } from '@/lib/ratelimit';
import { registerOravanTools } from '@/lib/core/mcp-tools';
import { noteMcpClientHandshake, noteMcpToolCall } from '@/lib/usage';

/*
 * Oravan's MCP server (S10). Five read-only tools over lib/core/mcp.ts's
 * pure functions, which read the same baked JSON the site's own pages read -
 * one corpus, one urgency model, no second copy of the data. No tool here
 * makes an outbound network call; the one the spec allows (Census address
 * refinement inside lookup_representatives) is deliberately deferred - see
 * lib/core/mcp.ts's lookupRepresentatives doc comment.
 *
 * SAME DATA, DIFFERENT CLOCK - and this comment used to get that wrong.
 * It said "an agent's answer and a visitor's page can never disagree",
 * which the `force-dynamic` below makes false. The facts are shared: the
 * corpus, the decodes, and the envelope's `as_of` (lib/freshness.ts reads
 * data/sync-state.json, a baked value) are byte-identical on both surfaces.
 * What is NOT shared is when the clock is read. Every time-dependent
 * derivation here runs at REQUEST time - whats_moving's N-day cutoff, the
 * staleness-decayed urgency get_bill reports as a band and search_bills as
 * a score (lib/urgency.mjs effectiveUrgency), and the quiet_week /
 * data_stale verdict (lib/freshness-state.ts emptyStateVerdict) - while the
 * site's pages are statically generated and evaluated the same functions at
 * BUILD time. So they can disagree, in one direction only: this route's
 * judgment is never older than the last build's. On a stalled pipeline
 * whats_moving reports `data_stale` while a homepage built before the stall
 * still shows a confident panel, and the MCP answer is the honest one.
 *
 * That asymmetry is a property of the wiring, not a promise about it, and
 * closing it (baking the clock, or revalidating the pages) is a behaviour
 * change nobody has decided on. Until someone does, this comment describes
 * what actually runs.
 *
 * HOW BIG IS THE DISAGREEMENT? Measured rather than left to the reader's
 * imagination (owner ruling N11c, 2026-08-12: document the magnitude, change
 * no behaviour). Method: hold the corpus constant and advance ONLY the clock,
 * which is exactly the build-time/request-time gap. Against the committed
 * 2,723-bill corpus on 2026-08-12, with #218's docket-ladder derivation:
 *
 *   urgency_band (get_bill's band, the rung both surfaces read)
 *     +1 day 0 bills · +2d 0 · +3d 0 · +5d 2 (0.07%) · +7d 21 (0.77%)
 *     · +14d 99 (3.6%), which is the plateau - by then everything dated has
 *     left the 14-day signal window and nothing further can change.
 *   whats_moving's population (the T0∪T1∪T2 act-now pool)
 *     19 bills, unchanged through +4 days · 17 at +5d · 7 at +7d.
 *   urgency_score (get_bill, search_bills - the continuous curve)
 *     331 of 2,723 (12.2%) report a different number one day on, none by more
 *     than 0.05. It is a decay: it moves constantly, in tiny increments, and
 *     is the one figure that is never zero.
 *
 * Read those against how long a page actually stays baked. The nightly data
 * commit triggers the deploy, so the site's clock is normally under 24h
 * behind, and the longest no-deploy stretch in the June-August record is 4
 * days - lags at which ZERO bills land in different bands on the two
 * surfaces. The divergence only becomes visible around a week of no deploys,
 * by which point `data_stale` is already the answer whats_moving gives. So
 * the safe-direction claim above is not just directional: at every lag this
 * pipeline actually produces, the two surfaces agree on the band, and where
 * they don't, MCP is the fresher one.
 *
 * (An earlier figure, ~7 bills a day / 0.26%, was measured 2026-08-11 against
 * the PERCENTILE band floors #218 retired the following morning. A continuous
 * score crossing a fixed cutoff nudges a few bills every single day; a rung
 * does not move until a dated fact leaves the signal window, which is why the
 * per-day number went to zero without anything about the clocks changing.
 * Re-measure the same way after any change to the derivation: same corpus,
 * two clocks, count the bills whose band differs.)
 *
 * Exactly these 5, per the project records §2 and the
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
/* The line the header's "different clock" note is about: every request runs
 * the tool handlers fresh, so Date.now() inside them is the caller's now, not
 * the last deploy's. Required anyway - a JSON-RPC POST cannot be prerendered. */
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
/**
 * How many JSON-RPC messages the handshake scan will look at. One: the MCP
 * spec allows a single `initialize` per connection. See the comment inside
 * countClientHandshakes for why this bound is load-bearing — it is what keeps
 * per-request Upstash work O(1) instead of O(batch length).
 */
const HANDSHAKE_SCAN_CAP = 1;

/*
 * The two windows, named once so a Retry-After header can never disagree
 * with the window it is reporting on. That is not hypothetical: the day
 * limiter's 429 shipped a hardcoded `retry-after: 3600` against an 86,400s
 * window, telling a throttled agent to come back in an hour when the counter
 * would not reset for up to a day — so it retried, uselessly, all day.
 */
const MCP_MINUTE_WINDOW_SEC = 60;
/*
 * "DAY" IS THE WINDOW LENGTH, NOT A CALENDAR GUARANTEE (noted 2026-08-12).
 * Counter keys are salt-derived (lib/ratelimit.ts counterKey + callerHash),
 * and the hashing salt rotates on its own 24h clock, so a caller who straddles
 * a rotation gets a fresh counter mid-window: up to ~2,000 requests inside one
 * 24h span, ~1,000 per salt epoch after. That is the accepted price of the
 * ≤24h pseudonym bound — see the ROTATION RESETS EVERY COUNTER note in
 * lib/ratelimit.ts for why no fix exists that keeps the privacy property. The
 * published copy says "per counter window" for this reason; if this route ever
 * needs a true per-day ceiling, halve `max` rather than lengthen the key.
 */
const MCP_DAY_WINDOW_SEC = 86400;

const minuteLimiter = createRateLimiter({ route: 'mcp-min', max: 60, windowSec: MCP_MINUTE_WINDOW_SEC });
const dayLimiter = createRateLimiter({ route: 'mcp-day', max: 1000, windowSec: MCP_DAY_WINDOW_SEC });

/**
 * Seconds-to-reset as an HTTP header value: the limiter's own computed reset
 * when it has one, the full window when it doesn't (the fail-open paths never
 * compute one), clamped into (0, window] so the header can never promise a
 * reset later than the window itself or a nonsensical 0.
 */
function retryAfterHeader(retryAfterSec: number | null, windowSec: number): string {
  return String(Math.max(1, Math.min(retryAfterSec ?? windowSec, windowSec)));
}

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
    // ONE handshake per request, and the work is bounded BEFORE the counter.
    // This scan runs ahead of handler(), so it happened even for a request
    // the transport then rejected with 400 — and it scheduled one Upstash
    // write per batch element while the limiters count REQUESTS. A single
    // 5,000-element batch measured 10,008 counters-DB commands and 5,003 new
    // 90-day keys for one unit of a caller's 60/min budget (pre-launch audit,
    // 2026-07-25). The MCP spec permits at most one `initialize` per
    // connection, so 1 is the protocol's own cap, not a heuristic: a batch
    // carrying more is malformed, and counting the first is generous.
    const messages = (Array.isArray(body) ? body : [body]).slice(0, HANDSHAKE_SCAN_CAP);
    for (const raw of messages) {
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
      // At most one write per request — belt to the slice() braces above.
      return;
    }
  } catch {
    // Non-JSON or malformed body: nothing to count, deliberately silent —
    // the transport returns the real JSON-RPC parse error to the caller.
  }
}

async function limitedPost(req: Request): Promise<Response> {
  readOravanKey(req.headers); // dormant tenancy hook (S18/S19): recognized, no behavior yet

  const ip = callerIp(req.headers);
  // The minute window keeps isLimited(): its window IS 60s, so the constant
  // and the truth already agree to within one window, and check()'s extra
  // TTL read would buy at most 59 seconds of precision on the route's
  // hottest limiter. The day window is the opposite trade — a caller told
  // the wrong hour on an 86,400s window retries all day for nothing — so it
  // pays the one TTL read (limited path only) to answer accurately.
  if (await minuteLimiter.isLimited(ip)) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': String(MCP_MINUTE_WINDOW_SEC) } }
    );
  }
  const day = await dayLimiter.check(ip);
  if (day.limited) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: { 'retry-after': retryAfterHeader(day.retryAfterSec, MCP_DAY_WINDOW_SEC) },
      }
    );
  }
  // AFTER the rate-limit gates on purpose: a 429'd request never counts,
  // the same posture as the per-tool counters (see the wrapper comment in
  // the createMcpHandler callback above).
  await countClientHandshakes(req);
  return handler(req);
}

export { handler as GET, limitedPost as POST, handler as DELETE };
