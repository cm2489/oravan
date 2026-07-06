import { expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';

/**
 * Wait for the bills feed to hydrate before driving its controlled inputs.
 * Filling the search box (or clicking a chip) before React attaches wedges the
 * page: the interaction lands in the DOM but its handler never fires, and the
 * controlled input never recovers within that page load. The "/" accelerator
 * is installed by the same effect that makes the feed interactive, so a focus
 * from it proves we're hydrated - and unlike fill(), pressing "/" can't wedge.
 */
export async function waitForFeedHydrated(page: Page) {
  const search = page.getByRole('searchbox');
  await expect(async () => {
    await page.keyboard.press('/');
    await expect(search).toBeFocused({ timeout: 250 });
  }).toPass({ timeout: 15_000 });
}

/** Seed a saved ZIP the way the app stores it (must run after first navigation). */
export async function seedZip(page: Page, zip: string) {
  await page.evaluate((z) => localStorage.setItem('rostra.prefs', JSON.stringify({ zip: z })), zip);
}

/** Mock the AI script endpoint so tests are free, fast, and deterministic. */
export async function mockScriptApi(page: Page) {
  await page.route('**/api/script', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        script:
          "Hi, my name is [YOUR NAME], and I'm a constituent from [YOUR TOWN OR ZIP]. I'm calling about S.J.Res. 99. MOCKED SCRIPT BODY. Thank you for your time.",
        cached: false,
      }),
    })
  );
}

/*
 * MCP JSON-RPC test helpers, shared by tests/mcp.spec.ts (protocol-level
 * scaffold checks) and tests/mcp-tools.spec.ts (the 5 tools themselves).
 * Streamable HTTP requires the client to accept both shapes; the SDK
 * rejects anything narrower with 406 (verified against the live handler).
 * The handler replies as one SSE `event: message` frame even with SSE
 * "disabled" at the transport-negotiation level, so every read unwraps it.
 */
export const MCP_ENDPOINT = '/api/mcp/mcp';
export const MCP_ACCEPT = 'application/json, text/event-stream';

export interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

export async function readJsonRpc(res: APIResponse): Promise<JsonRpcResponse> {
  const body = await res.text();
  const dataLine = body.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice('data: '.length) : body);
}

/** POST one JSON-RPC request at the live MCP route and unwrap the response. */
export async function mcpRpc(
  request: APIRequestContext,
  method: string,
  params: unknown,
  id: number | string = 1
): Promise<JsonRpcResponse> {
  const res = await request.post(MCP_ENDPOINT, {
    headers: { 'content-type': 'application/json', accept: MCP_ACCEPT },
    data: { jsonrpc: '2.0', id, method, params },
  });
  return readJsonRpc(res);
}

/** Call one tool and return its CallToolResult (`result`), not the outer envelope. */
export async function callTool(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown> = {}
) {
  const rpc = await mcpRpc(request, 'tools/call', { name, arguments: args });
  expect(rpc.error, `tools/call "${name}" returned a protocol-level error`).toBeUndefined();
  return rpc.result!;
}
