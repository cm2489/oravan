import { expect, test } from '@playwright/test';
import { MCP_ACCEPT, MCP_ENDPOINT, mcpRpc, readJsonRpc } from './helpers';

/*
 * Protocol-level scaffold checks (S9, still true after S10 lands the 5
 * tools): a real MCP handshake works, and anything else (an unrecognized
 * method, a disallowed HTTP verb, an unregistered tool name) is rejected
 * cleanly - a proper JSON-RPC/tool error, never a crash or a silent extra
 * tool. Per-tool behavior (the 5 tools' data + the citation envelope) is
 * tests/mcp-tools.spec.ts's job, not this file's.
 *
 * Hits the actual built server over HTTP (the `request` fixture), the same
 * way an MCP client would - no direct import of route.ts, since it pulls in
 * mcp-handler/@modelcontextprotocol/sdk and this repo's unit-spec convention
 * (importing a route handler directly) is reserved for routes with no
 * dependency-alias resolution concerns (see feedback.unit.spec.ts).
 */

test('initialize handshake succeeds and identifies the server', async ({ request }) => {
  const res = await request.post(MCP_ENDPOINT, {
    headers: { 'content-type': 'application/json', accept: MCP_ACCEPT },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'rostra-ci-check', version: '1.0' },
      },
    },
  });
  expect(res.status()).toBe(200);
  // No session cookie, no tracking cookie - constitution check, in the test.
  expect(res.headers()['set-cookie']).toBeUndefined();

  const rpc = await readJsonRpc(res);
  expect(rpc.error).toBeUndefined();
  expect(rpc.result?.serverInfo).toMatchObject({ name: 'rostra' });
  expect(rpc.result?.protocolVersion).toBeTruthy();
});

test('an unrecognized method is rejected as a clean JSON-RPC error, not a crash', async ({
  request,
}) => {
  const rpc = await mcpRpc(request, 'definitely/not-a-real-method', {}, 2);
  expect(rpc.result).toBeUndefined();
  expect(rpc.error?.code).toBe(-32601); // JSON-RPC "Method not found"
});

test("tools/list shows exactly the 5 spec'd tools, each read-only and closed-world", async ({
  request,
}) => {
  const rpc = await mcpRpc(request, 'tools/list', {}, 3);
  expect(rpc.error).toBeUndefined();
  const tools = rpc.result?.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
  const names = tools.map((t) => t.name).sort();
  expect(names).toEqual(
    ['get_bill', 'get_representative', 'lookup_representatives', 'search_bills', 'whats_moving'].sort()
  );
  // get_bill_coverage is cut (KTD-6) and draft_call_script was never in
  // scope - neither should ever silently reappear here.
  expect(names).not.toContain('get_bill_coverage');
  expect(names).not.toContain('draft_call_script');
  for (const tool of tools) {
    expect(tool.annotations?.readOnlyHint, `${tool.name} must be readOnlyHint:true`).toBe(true);
    expect(tool.annotations?.openWorldHint, `${tool.name} must be openWorldHint:false`).toBe(false);
  }
});

test('calling an unregistered tool name is a clean error, not a silent 6th tool', async ({
  request,
}) => {
  const rpc = await mcpRpc(
    request,
    'tools/call',
    { name: 'get_bill_coverage', arguments: { slug: 'hr-2701-119' } },
    4
  );
  // Either shape counts as "clean": a protocol-level JSON-RPC error, or a
  // tool-result-level isError - as long as it's never a 5xx crash and the
  // tool never silently runs.
  if (rpc.error) {
    expect(rpc.error.code).toBeLessThan(0);
  } else {
    expect(rpc.result?.isError).toBe(true);
  }
});

test('GET is not a valid Streamable HTTP verb here: rejected with a clean 405, not silently accepted', async ({
  request,
}) => {
  const res = await request.get(MCP_ENDPOINT, { headers: { accept: MCP_ACCEPT } });
  expect(res.status()).toBe(405);
  expect(res.headers()['set-cookie']).toBeUndefined();
  const body = JSON.parse(await res.text());
  expect(body.jsonrpc).toBe('2.0');
  expect(body.error?.message).toMatch(/not allowed/i);
});

test('DELETE is likewise rejected cleanly (stateless: there is no session to end)', async ({
  request,
}) => {
  const res = await request.delete(MCP_ENDPOINT, { headers: { accept: MCP_ACCEPT } });
  expect(res.status()).toBe(405);
  const body = JSON.parse(await res.text());
  expect(body.jsonrpc).toBe('2.0');
  expect(body.error?.message).toMatch(/not allowed/i);
});
