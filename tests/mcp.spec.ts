import { expect, test, type APIResponse } from '@playwright/test';

/*
 * S9 scope: the MCP route is a bare scaffold — zero tools registered. These
 * tests pin exactly what that scaffold promises: a real MCP handshake works,
 * and anything else (an unrecognized method, a disallowed HTTP verb) is
 * rejected cleanly - a proper JSON-RPC error, never a crash or a silent
 * tool that shouldn't exist yet. Tool-surface behavior (the 5 tools, the
 * citation envelope) is S10's test surface, not this file's.
 *
 * Hits the actual built server over HTTP (the `request` fixture), the same
 * way an MCP client would - no direct import of route.ts, since it pulls in
 * mcp-handler/@modelcontextprotocol/sdk and this repo's unit-spec convention
 * (importing a route handler directly) is reserved for routes with no
 * dependency-alias resolution concerns (see feedback.unit.spec.ts).
 */

const ENDPOINT = '/api/mcp/mcp';
// Streamable HTTP requires the client to accept both shapes; the SDK
// rejects anything narrower with 406 (verified against the live handler).
const MCP_ACCEPT = 'application/json, text/event-stream';

/** The handler replies as one SSE `event: message` frame; unwrap its JSON. */
async function readJsonRpc(res: APIResponse): Promise<{
  jsonrpc: string;
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}> {
  const body = await res.text();
  const dataLine = body.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice('data: '.length) : body);
}

test('initialize handshake succeeds and identifies the server', async ({ request }) => {
  const res = await request.post(ENDPOINT, {
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
  const res = await request.post(ENDPOINT, {
    headers: { 'content-type': 'application/json', accept: MCP_ACCEPT },
    data: { jsonrpc: '2.0', id: 2, method: 'definitely/not-a-real-method', params: {} },
  });
  expect(res.status()).toBeLessThan(500);
  const rpc = await readJsonRpc(res);
  expect(rpc.result).toBeUndefined();
  expect(rpc.error?.code).toBe(-32601); // JSON-RPC "Method not found"
});

test('zero tools registered: tools/list is refused the same clean way (S10 adds the surface, not this scaffold)', async ({
  request,
}) => {
  const res = await request.post(ENDPOINT, {
    headers: { 'content-type': 'application/json', accept: MCP_ACCEPT },
    data: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
  });
  expect(res.status()).toBeLessThan(500);
  const rpc = await readJsonRpc(res);
  expect(rpc.result).toBeUndefined();
  expect(rpc.error?.code).toBe(-32601);
});

test('GET is not a valid Streamable HTTP verb here: rejected with a clean 405, not silently accepted', async ({
  request,
}) => {
  const res = await request.get(ENDPOINT, { headers: { accept: MCP_ACCEPT } });
  expect(res.status()).toBe(405);
  expect(res.headers()['set-cookie']).toBeUndefined();
  const body = JSON.parse(await res.text());
  expect(body.jsonrpc).toBe('2.0');
  expect(body.error?.message).toMatch(/not allowed/i);
});

test('DELETE is likewise rejected cleanly (stateless: there is no session to end)', async ({
  request,
}) => {
  const res = await request.delete(ENDPOINT, { headers: { accept: MCP_ACCEPT } });
  expect(res.status()).toBe(405);
  const body = JSON.parse(await res.text());
  expect(body.jsonrpc).toBe('2.0');
  expect(body.error?.message).toMatch(/not allowed/i);
});
