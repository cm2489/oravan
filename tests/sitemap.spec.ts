import { expect, test } from '@playwright/test';
import { getAllBills } from '../lib/core';

/*
 * S22 — sitemap.ts, robots.ts, and llms.txt didn't exist before this PR.
 * Structural smoke tests (no XML-parser dependency in this repo, so this
 * asserts on well-known substrings/counts rather than a full DOM parse) that
 * they render, cover both locales, and keep the permissive-crawl posture
 * that lets the sitemap do real work now that the site is indexable
 * (soft-public lift, 2026-07-08).
 */

const SITE_ORIGIN = 'https://oravan.org';
const STATIC_PATH_COUNT = 13; // '/', '/bills', '/reps', '/about', '/privacy', '/terms', '/why-call', '/impact', '/citations', '/embeds', '/embeds/terms', '/partners', '/mcp'

test.describe('sitemap.xml', () => {
  test('renders both locales for every static path and every bill', async ({ request }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('xml');
    const body = await res.text();

    const totalBills = getAllBills().length;
    const locCount = (body.match(/<loc>/g) ?? []).length;
    expect(locCount).toBe((STATIC_PATH_COUNT + totalBills) * 2);

    // Homepage, both locales. The en entry has no trailing slash — Next's
    // Metadata URL resolution collapses a bare "/" to the origin, and
    // lib/hreflang.ts's absoluteUrl() (reused here) matches that on purpose
    // so this sitemap entry is byte-identical to the page's own canonical.
    expect(body).toContain(`<loc>${SITE_ORIGIN}</loc>`);
    expect(body).toContain(`<loc>${SITE_ORIGIN}/es</loc>`);

    // A representative bill page, both locales.
    expect(body).toContain(`<loc>${SITE_ORIGIN}/bills/hr-5582-119</loc>`);
    expect(body).toContain(`<loc>${SITE_ORIGIN}/es/bills/hr-5582-119</loc>`);

    // Reciprocal hreflang alternates ship per entry, both languages present.
    expect(body).toContain('hreflang="en"');
    expect(body).toContain('hreflang="es"');
  });
});

test.describe('robots.txt', () => {
  test('keeps the permissive-crawl posture and points at the sitemap', async ({
    request,
  }) => {
    const res = await request.get('/robots.txt');
    expect(res.status()).toBe(200);
    const body = await res.text();

    // Crawling stays open — always has, by design. Post-lift the site is
    // indexable, so open crawl is exactly what lets Googlebot read and index
    // the pages; /api/ stays disallowed as it never should be crawled.
    expect(body).toMatch(/User-agent:\s*\*/i);
    expect(body).toMatch(/Allow:\s*\/\s*$/im);
    expect(body).toMatch(/Disallow:\s*\/api\//i);
    expect(body).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });
});

test.describe('llms.txt', () => {
  test('renders a minimal, honest description with no traffic/citation claims', async ({ request }) => {
    const res = await request.get('/llms.txt');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/plain');
    const body = await res.text();

    expect(body).toContain('# Oravan');
    expect(body).toContain(`${SITE_ORIGIN}/bills`);
    expect(body).toContain(`${SITE_ORIGIN}/es`);
    expect(body).toContain(String(getAllBills().length));
    // Explicitly no confirmed-support or traffic-outcome claim.
    expect(body.toLowerCase()).toContain('not confirmed');
  });

  test('S12: names the MCP server, its real endpoint, and the docs page', async ({ request }) => {
    const res = await request.get('/llms.txt');
    const body = await res.text();
    expect(body).toContain(`${SITE_ORIGIN}/mcp`);
    expect(body).toContain(`${SITE_ORIGIN}/api/mcp/mcp`);
    expect(body).toMatch(/MCP/);
  });

  test('S21: names the free "what moved" feed, both formats', async ({ request }) => {
    const res = await request.get('/llms.txt');
    const body = await res.text();
    expect(body).toContain(`${SITE_ORIGIN}/feed/whats-moving.json`);
    expect(body).toContain(`${SITE_ORIGIN}/feed/whats-moving.xml`);
  });
});
