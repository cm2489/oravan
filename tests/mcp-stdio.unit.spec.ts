import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@playwright/test';
import { SITE_ORIGIN } from '../lib/site';

/*
 * feat/mcp-stdio-entry: the stdio transport (lib/mcp-stdio.ts + scripts/
 * mcp-stdio.mjs) built for Glama's MCP directory listing (glama.ai/mcp/
 * servers/cm2489/oravan), whose sandbox quality checks build-and-run the
 * server locally and speak stdio - proxying to the hosted Streamable HTTP
 * endpoint is explicitly rejected by their harness.
 *
 * Spawns the REAL entrypoint a client config would run - `npx tsx
 * scripts/mcp-stdio.mjs` - exactly as designed, and drives it with the
 * SDK's own Client + StdioClientTransport rather than importing
 * lib/mcp-stdio.ts directly, so this pins the actual child-process command
 * line an MCP client (Claude Desktop, Glama's sandbox, etc.) would be
 * configured with.
 *
 * `env: getDefaultEnvironment()` (not the ambient `process.env`) is
 * deliberate, not incidental: it's the SDK's own curated whitelist (HOME/
 * LOGNAME/PATH/SHELL/TERM/USER, no secrets) - passing it explicitly, rather
 * than relying on inheritance, is what actually proves the server needs
 * ZERO env vars/secrets to run, instead of merely not being tested against
 * a secret-bearing environment by accident.
 *
 * Runtime stays modest: 3 focused assertions on one shared connection
 * (`test.describe.serial` + a single spawned child, closed in
 * `afterAll`) rather than one spawn per test - startup (npx resolving tsx,
 * tsx transpiling the whole lib/core import graph) is the expensive part,
 * not the JSON-RPC calls themselves.
 */

test.describe.serial('MCP stdio entry (scripts/mcp-stdio.mjs)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  test.beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'scripts/mcp-stdio.mjs'],
      cwd: process.cwd(),
      env: getDefaultEnvironment(),
      stderr: 'ignore', // the "server ready" log line (lib/mcp-stdio.ts) - stderr only, never parsed
    });
    client = new Client({ name: 'oravan-stdio-ci-check', version: '1.0' });
    await client.connect(transport);
  });

  test.afterAll(async () => {
    await client?.close();
  });

  test('initialize handshake succeeds and identifies the server', () => {
    const info = client.getServerVersion();
    expect(info).toMatchObject({ name: 'oravan' });
    // Same literal version source as server.json/package.json - see
    // scripts/check-server-json.mjs's cross-check for the other half of
    // this pin.
    expect(info?.version).toBeTruthy();
  });

  test("tools/list returns exactly the 5 spec'd tools, each read-only and closed-world", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['get_bill', 'get_representative', 'lookup_representatives', 'search_bills', 'whats_moving'].sort()
    );
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be readOnlyHint:true`).toBe(true);
      expect(tool.annotations?.openWorldHint, `${tool.name} must be openWorldHint:false`).toBe(false);
    }
  });

  test('a real tools/call (get_bill) against the committed corpus returns the citation envelope', async () => {
    // Same fixture bill as tests/mcp-tools.spec.ts's HTTP-transport
    // coverage: hr-2701-119, a real, currently-decoded bill in
    // data/bills.json with a full ai_sections decode and a resolvable
    // sponsor - proves this transport reads the identical baked corpus,
    // not a second copy.
    const result = await client.callTool({ name: 'get_bill', arguments: { slug: 'hr-2701-119', locale: 'en' } });
    expect(result.isError).toBeFalsy();
    const bill = (result.structuredContent as Record<string, unknown>).bill as Record<string, unknown>;
    expect(bill.slug).toBe('hr-2701-119');
    expect(bill.ai_generated).toBe(true);
    const meta = (result.structuredContent as Record<string, unknown>).meta as Record<string, unknown>;
    expect(meta.source).toContain('Congress.gov');
    expect(meta.canonical_url).toBe(`${SITE_ORIGIN}/bills/hr-2701-119`);
    expect(meta.ai_label).toBeTruthy();
    expect(meta.license).toMatch(/CC BY/);
  });
});
