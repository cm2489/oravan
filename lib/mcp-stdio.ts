/*
 * Stdio MCP entrypoint (feat/mcp-stdio-entry). A local, single-user
 * transport for the exact same 5 read-only tools app/api/mcp/[transport]/
 * route.ts serves over Streamable HTTP - lib/core/mcp-tools.ts's
 * `registerOravanTools` is the one shared registration, reused byte-for-
 * byte here, not a second hand-copy.
 *
 * WHY THIS EXISTS: Glama's MCP directory listing (glama.ai/mcp/servers/
 * cm2489/oravan, claimed 2026-07-13) runs sandbox quality checks that
 * require the server to BUILD AND RUN LOCALLY in a container and speak
 * stdio - their harness wraps the process's own CMD with
 * punkpeye/mcp-proxy, and explicitly rejects a listing that just proxies to
 * a hosted Streamable HTTP endpoint. This file is that stdio surface,
 * nothing more: the real, canonical, rate-limited server remains the HTTP
 * route; this is a second door onto the exact same room, run via:
 *
 *   npx tsx scripts/mcp-stdio.mjs
 *
 * NO USAGE COUNTING HERE, ON PURPOSE: registerOravanTools takes an
 * `onToolCall` hook so each transport can supply its own concern (see that
 * file's header comment). route.ts wires it to an after()-deferred write
 * into the counters database's usage family (lib/usage.ts) - an internal
 * signal about traffic hitting a public, keyless, rate-limited HTTP
 * endpoint. A stdio process is neither of those things: it's a single local
 * user's own MCP client, spawned and owned by them, with no caller to
 * rate-limit and no abuse surface to watch - counting its calls into that
 * same database would mix a local dev/agent session into a metric meant to
 * describe public network traffic, and would need the Upstash counters
 * client (lib/upstash.ts) reachable from a process that otherwise touches
 * no network and no secret at all. So the hook here is a genuine, permanent
 * no-op - not a placeholder for a future write.
 *
 * REQUIRES ZERO ENV VARS/SECRETS: every one of the 5 tools reads the same
 * build-time-baked JSON under data/ that lib/core already imports
 * statically (verified: registerOravanTools's whole call graph touches no
 * process.env, no fetch, no Upstash client - see lib/core/mcp-tools.ts and
 * lib/core/mcp.ts). Nothing here makes a network call either.
 *
 * NEVER WRITES TO STDOUT except the protocol frames StdioServerTransport
 * itself writes - stdout is the wire format a stdio JSON-RPC client parses
 * byte-for-byte, and a single stray line would corrupt every frame after
 * it. Anything this file logs goes to stderr (console.error) instead.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import packageJson from '../package.json';
import { registerOravanTools } from './core/mcp-tools';

export async function main(): Promise<void> {
  const server = new McpServer({ name: 'oravan', version: packageJson.version });

  registerOravanTools(server, {
    // See this file's header comment: a stdio process has no caller to
    // rate-limit and no abuse surface to watch, so it deliberately never
    // writes to the Upstash usage counters (lib/usage.ts) route.ts uses.
    onToolCall: () => {},
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only - see header comment on why stdout is off-limits here.
  console.error('oravan MCP stdio server ready (5 tools, no usage counting, zero env vars required)');
}
