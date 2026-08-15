/*
 * The ONE MCP server identity, declared once and reused by both transports.
 *
 * WHY THIS FILE EXISTS: app/api/mcp/[transport]/route.ts declared
 * `serverInfo: { name: 'oravan', version: '0.1.0' }` as a hand-typed literal
 * while lib/mcp-stdio.ts read package.json's version - two doors onto the
 * exact same 5 tools (lib/core/mcp-tools.ts's registerOravanTools), which
 * would have reported DIFFERENT versions in their initialize handshake the
 * first time anyone bumped package.json, with nothing in CI to notice. Same
 * reasoning as the tool extraction next door: one declaration, reused, in
 * place of a second hand-copy that can silently drift.
 *
 * THE NAME IS WIRE FORMAT, NOT A LABEL: `oravan` is the literal string an
 * MCP client reads out of the initialize response, and three specs pin it
 * (tests/mcp.spec.ts, tests/mcp-docs.spec.ts, tests/mcp-stdio.unit.spec.ts).
 * It stays a hardcoded literal here on purpose - it is deliberately NOT
 * package.json's "name" field. The two happen to agree today; if the package
 * were ever renamed, this file is what keeps the published wire name steady
 * instead of silently republishing the server under a new identity.
 *
 * THE VERSION is package.json's, which scripts/check-server-json.mjs already
 * holds equal to server.json's "version" - so the registry entry, the stdio
 * handshake and the HTTP handshake all report one number, bumped in exactly
 * one place. This module deliberately reads nothing else out of package.json.
 *
 * Server-side only, both callers: the HTTP route handler and the stdio
 * entrypoint. Nothing in a client bundle imports this (it is not re-exported
 * from lib/core/index.ts), so package.json never reaches the browser.
 */
import packageJson from '../../package.json';

/** The `serverInfo` both transports hand to the MCP SDK. Treated as
 *  read-only by every consumer: mcp-handler destructures it and the SDK
 *  stores it verbatim to echo back in the initialize result (verified
 *  against mcp-handler@1.1.0 + @modelcontextprotocol/sdk@1.26.0), so a
 *  single shared instance is safe. */
export const MCP_SERVER_INFO: { name: string; version: string } = {
  name: 'oravan',
  version: packageJson.version,
};
