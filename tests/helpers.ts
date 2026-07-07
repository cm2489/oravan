import { createServer, type Server } from 'node:http';
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
  await page.evaluate((z) => localStorage.setItem('oravan.prefs', JSON.stringify({ zip: z })), zip);
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

// Each JSON-RPC call below presents itself as a distinct caller: as of S11
// the MCP route enforces real anonymous rate limits (60/min per caller), and
// this suite's ~50 calls across two projects would trip them from one shared
// address. The limiter itself is pinned separately (tests/ratelimit.unit.
// spec.ts) plus a dedicated same-caller 429 e2e in tests/mcp.spec.ts —
// every other test here states its own caller and tests its own concern.
let mcpCallerCounter = 0;
function nextMcpCallerIp(): string {
  mcpCallerCounter = (mcpCallerCounter % 254) + 1;
  return `198.51.100.${mcpCallerCounter}`; // RFC 5737 TEST-NET-2
}

/** POST one JSON-RPC request at the live MCP route and unwrap the response. */
export async function mcpRpc(
  request: APIRequestContext,
  method: string,
  params: unknown,
  id: number | string = 1
): Promise<JsonRpcResponse> {
  const res = await request.post(MCP_ENDPOINT, {
    headers: {
      'content-type': 'application/json',
      accept: MCP_ACCEPT,
      'x-forwarded-for': nextMcpCallerIp(),
    },
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

/*
 * A throwaway ad-hoc HTTP server on its own ephemeral port - a genuine
 * cross-origin page (127.0.0.1:X) relative to the app under test
 * (localhost:PW_PORT), not a page.setContent() page. That distinction
 * matters for anything exercising frame-ancestors/CSP: WebKit treats a
 * page.setContent() page as an opaque ("null") origin and refuses to frame
 * *anything* from it, including a permissive `frame-ancestors *` carve-out -
 * a real HTTP origin is both the more realistic "third-party host" and the
 * one that actually exercises the policy under test. Shared by
 * tests/embed-loader.spec.ts (the loader/iframe seam) and
 * tests/frame-posture.spec.ts (the site-wide lock, S17).
 */
export function startCrossOriginHost(
  html: string
): Promise<{ url: string; origin: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const origin = `http://127.0.0.1:${port}`;
      resolve({
        url: `${origin}/`,
        origin,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
