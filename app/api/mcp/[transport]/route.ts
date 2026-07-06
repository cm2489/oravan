import { createMcpHandler } from 'mcp-handler';

/*
 * Rostra's MCP server — S9 scaffold only. This route answers a bare MCP
 * handshake (initialize / tools-list-of-nothing) and NOTHING else. The 5
 * read-only tools (lookup_representatives, get_bill, search_bills,
 * whats_moving, get_representative), the citation envelope, and the actual
 * lib/core wiring for tool handlers land in S10 (docs/ideation/
 * 2026-07-02-mcp-spec.md §2). Registering zero tools here is deliberate
 * scope discipline, not an oversight — do not add a tool to this file
 * without also landing the envelope from the spec.
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
 *  - No content identifiers in caller-originating query strings: this
 *    route takes no query params at all (Streamable HTTP is POST-body
 *    JSON-RPC, same "never a query string" posture as app/api/district's
 *    house pattern) - and with zero tools registered, there is no content
 *    identifier to carry regardless.
 */
// A JSON-RPC dispatch must never be served from a static cache. Next already
// infers this route as dynamic today, but the inference is over an opaque
// third-party handler - pin it explicitly rather than trust the heuristic to
// hold across Next upgrades.
export const dynamic = 'force-dynamic';

const handler = createMcpHandler(
  () => {
    // Intentionally empty: zero tools, zero resources, zero prompts.
  },
  {
    serverInfo: { name: 'rostra', version: '0.1.0' },
  },
  {
    basePath: '/api/mcp',
    disableSse: true,
    verboseLogs: false,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
