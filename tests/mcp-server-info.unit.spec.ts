import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { MCP_SERVER_INFO } from '../lib/core/mcp-server-info';

/*
 * The version drift this pins (B-5): app/api/mcp/[transport]/route.ts
 * declared `serverInfo: { name: 'oravan', version: '0.1.0' }` as a hand-typed
 * literal while lib/mcp-stdio.ts read package.json's version. Both transports
 * serve the identical 5 tools, so the first `npm version` bump would have had
 * them answer the same initialize request with two different numbers - and
 * nothing in CI would have said so, because the only serverInfo assertions
 * that existed (tests/mcp.spec.ts, tests/mcp-docs.spec.ts) matched on the
 * NAME, and tests/mcp-stdio.unit.spec.ts only asserted the version was
 * truthy.
 *
 * Pure Node - readFileSync plus one module import, no `page`, no server: this
 * spec runs under PW_NO_WEBSERVER as happily as it does in the full suite.
 * The source-text scan is the same technique scripts/check-server-json.mjs
 * uses on lib/site.ts: the route itself can't be imported here (it pulls in
 * mcp-handler + the SDK through a path alias - see tests/mcp.spec.ts's header
 * on why that direct import is off the table), so what gets pinned is that
 * the route declares no second copy to drift. The live wire value stays the
 * job of the two transports' own handshake tests.
 */

test("the identity both MCP transports declare carries package.json's version, not a hand-typed literal", () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(MCP_SERVER_INFO.version).toBe(pkg.version);
  // The wire name is deliberately a literal, NOT package.json's "name" - see
  // lib/core/mcp-server-info.ts. Pinned over the real protocol in
  // tests/mcp.spec.ts, tests/mcp-docs.spec.ts and tests/mcp-stdio.unit.spec.ts.
  expect(MCP_SERVER_INFO.name).toBe('oravan');
});

test('the HTTP route hands the SDK that shared identity instead of re-typing one', () => {
  const source = readFileSync('app/api/mcp/[transport]/route.ts', 'utf8');
  expect(source).toContain('serverInfo: MCP_SERVER_INFO');
  // An inline object literal here is the exact regression: it compiles, it
  // serves, and it is wrong the moment the version moves.
  expect(source).not.toMatch(/serverInfo:\s*\{/);
});
