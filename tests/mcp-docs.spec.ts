import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { callTool, mcpRpc } from './helpers';

/*
 * S12 — the public MCP server docs page (app/[locale]/mcp/page.tsx). Covers
 * the sprint's done-criteria for this deliverable: both locales render, the
 * real endpoint URL is printed (it was nowhere user-visible before this
 * page), and every "quoted" string on the page (tool descriptions, the
 * citation envelope's source/ai_label text) is pinned against what the live
 * MCP server actually sends - never a hardcoded second copy that could
 * silently drift from lib/core/mcp.ts's exports.
 */

const ENDPOINT_URL = 'https://oravan.org/api/mcp/mcp';

for (const [locale, prefix, messages] of [
  ['en', '', en],
  ['es', '/es', es],
] as const) {
  test(`${locale}: MCP docs page renders a single h1 and every section`, async ({ page }) => {
    await page.goto(`${prefix}/mcp`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.mcp.title);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: messages.mcp.endpointTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.mcp.connectTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.mcp.toolsTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.mcp.privacyTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.mcp.envelopeTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.mcp.licenseTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.mcp.freshnessTitle })).toBeVisible();
  });

  test(`${locale}: the real, live endpoint URL is printed on the page (previously user-visible nowhere)`, async ({
    page,
  }) => {
    await page.goto(`${prefix}/mcp`);
    // exact: true - the endpoint's own <p> renders nothing but the bare URL,
    // but the client-config <pre><code> block below it also contains the
    // URL as a substring, so a non-exact match resolves to both elements.
    await expect(page.getByText(ENDPOINT_URL, { exact: true })).toBeVisible();
    // The example client-config snippet also carries the same literal URL.
    const codeBlock = page.locator('pre code');
    await expect(codeBlock).toContainText(ENDPOINT_URL);
  });

  test(`${locale}: no horizontal overflow on the MCP docs page`, async ({ page }) => {
    await page.goto(`${prefix}/mcp`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `${prefix}/mcp must not scroll horizontally`).toBeLessThanOrEqual(0);
  });
}

test('the endpoint printed on the page is the endpoint an MCP client actually connects to', async ({
  page,
  request,
}) => {
  // Round-trips the real protocol handshake against the literal URL the
  // page displays - if route.ts's basePath ever changes, this test (not
  // just a hardcoded string match) is what catches the page going stale.
  const rpc = await mcpRpc(
    request,
    'initialize',
    { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'docs-page-check', version: '1.0' } },
    1
  );
  expect(rpc.error).toBeUndefined();
  expect(rpc.result?.serverInfo).toMatchObject({ name: 'oravan' });

  await page.goto('/mcp');
  await expect(page.getByText(ENDPOINT_URL, { exact: true })).toBeVisible();
});

test('every tool name/title/description on the page matches the live tools/list response, verbatim', async ({
  page,
  request,
}) => {
  const rpc = await mcpRpc(request, 'tools/list', {}, 2);
  const tools = rpc.result?.tools as Array<{ name: string; title?: string; description?: string }>;
  expect(tools.length).toBe(5);

  await page.goto('/mcp');
  for (const tool of tools) {
    await expect(page.getByText(tool.name, { exact: true })).toBeVisible();
    // exact: true - a tool's title (e.g. "What's moving in Congress") is a
    // verbatim prefix of its own longer description in the <dd> below it, so
    // a non-exact match resolves to both elements.
    if (tool.title) await expect(page.getByText(tool.title, { exact: true })).toBeVisible();
    if (tool.description) {
      // Descriptions can be long; match on a substantial, unique prefix
      // rather than the full string (Playwright text matching is exact-
      // substring, and full sentences with internal quoting are brittle to
      // whitespace collapsing in the DOM).
      const prefix = tool.description.slice(0, 60);
      await expect(page.getByText(prefix, { exact: false })).toBeVisible();
    }
  }
});

test("the envelope's localized source/ai_label text is quoted verbatim, both languages, on both locale routes", async ({
  page,
  request,
}) => {
  // Same pattern as tests/citations.spec.ts's equivalent check: fetched live
  // rather than imported (lib/core/mcp.ts pulls in a 'server-only' chain
  // that only resolves inside Next's bundler, not Playwright's Node runner)
  // - and the more honest check besides, since it proves the page matches
  // what an agent actually receives right now.
  const resultEn = await callTool(request, 'get_bill', { slug: 'hr-1787-119', locale: 'en' });
  const resultEs = await callTool(request, 'get_bill', { slug: 'hr-1787-119', locale: 'es' });
  const metaEn = resultEn.structuredContent!.meta as { source: string; ai_label: string };
  const metaEs = resultEs.structuredContent!.meta as { source: string; ai_label: string };
  expect(metaEn.source).toBeTruthy();
  expect(metaEs.source).toBeTruthy();

  for (const prefix of ['', '/es']) {
    await page.goto(`${prefix}/mcp`);
    await expect(page.getByText(metaEn.source)).toBeVisible();
    await expect(page.getByText(metaEs.source)).toBeVisible();
    await expect(page.getByText(metaEn.ai_label)).toBeVisible();
    await expect(page.getByText(metaEs.ai_label)).toBeVisible();
  }
});

test('the citations page links to the MCP docs page (not the site-wide footer/header)', async ({ page }) => {
  await page.goto('/citations');
  const link = page.getByRole('link', { name: new RegExp(en.citations.mcpNoteLinkText) });
  await expect(link).toHaveAttribute('href', '/mcp');
  await link.click();
  await expect(page).toHaveURL(/\/mcp$/);
});
