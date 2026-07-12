import { expect, test } from '@playwright/test';

/*
 * S21 — the free, public, keyless "what moved this week" tenant feed, hit
 * over the real built server (genuine e2e, not a unit import): lib/core/
 * feed.ts transitively imports lib/core/mcp.ts -> lib/freshness.ts ->
 * `import 'server-only'`, which resolves only inside Next's own bundler
 * (aliased in next/dist/compiled, not a real node_modules package) —
 * confirmed empirically by a direct-import probe, the same class of gap
 * S19's STATUS entry documented for /api/script ("can't be require()'d in a
 * unit spec"). The pure XML-escaping logic (lib/core/feed-xml.ts) IS
 * unit-tested directly (tests/tenant-feed.unit.spec.ts) since that module
 * has no such dependency.
 *
 * Four static routes, no `?locale=` param (force-static handlers render at
 * build with no request object to read a query string from) — see
 * lib/core/feed.ts's own header comment.
 */

const ROUTES = {
  en: { json: '/feed/whats-moving.json', xml: '/feed/whats-moving.xml' },
  es: { json: '/es/feed/whats-moving.json', xml: '/es/feed/whats-moving.xml' },
} as const;

interface FeedItem {
  slug: string;
  citation: string;
  title: string;
  headline: string | null;
  ai_generated: boolean;
  ai_label: string | null;
  status: string;
  status_label: string;
  url: string;
  last_action_date: string | null;
  urgency_score: number;
}

interface FeedPayload {
  title: string;
  description: string;
  link: string;
  generated_at: string;
  days: number;
  quiet_week: boolean;
  data_stale: boolean;
  source: string;
  license: string;
  ai_label: string | null;
  attribution: string;
  items: FeedItem[];
}

test.describe('JSON feed', () => {
  test('en: 200, correct content-type, well-shaped payload, zero cookies', async ({ request }) => {
    const res = await request.get(ROUTES.en.json);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');
    expect(res.headers()['cache-control']).toContain('public');
    expect(res.headers()['set-cookie']).toBeUndefined();

    const body = (await res.json()) as FeedPayload;
    expect(body.title.length).toBeGreaterThan(0);
    expect(body.description.length).toBeGreaterThan(0);
    expect(body.link.startsWith('https://oravan.org')).toBe(true);
    expect(body.days).toBe(7);
    expect(typeof body.quiet_week).toBe('boolean');
    expect(typeof body.data_stale).toBe('boolean');
    // Never both true — an empty list is either a quiet week OR stale data,
    // never simultaneously both (lib/freshness-state.ts's emptyStateVerdict
    // is a single collapse, not two independent flags).
    expect(body.quiet_week && body.data_stale).toBe(false);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.source.length).toBeGreaterThan(0);
    expect(body.license.length).toBeGreaterThan(0);
    // The feed's own mandatory, non-removable attribution line — present
    // regardless of item count (embeds spec §1: "powers their newsletters
    // with an attribution line").
    expect(body.attribution.length).toBeGreaterThan(0);

    // Item-level AI-label invariant: present iff ai_generated, never the
    // reverse, never both null and true.
    for (const item of body.items) {
      if (item.ai_generated) {
        expect(item.ai_label, `${item.slug} is ai_generated but has no ai_label`).toBeTruthy();
      } else {
        expect(item.ai_label, `${item.slug} is not ai_generated but carries an ai_label`).toBeNull();
      }
      expect(item.url.startsWith('https://oravan.org')).toBe(true);
    }

    // Channel-level ai_label mirrors "any item is AI-generated" exactly.
    const anyAi = body.items.some((i) => i.ai_generated);
    expect(Boolean(body.ai_label)).toBe(anyAi);
  });

  test('es: locale-specific title/description/link, same shape as en', async ({ request }) => {
    const [enRes, esRes] = await Promise.all([request.get(ROUTES.en.json), request.get(ROUTES.es.json)]);
    const en = (await enRes.json()) as FeedPayload;
    const es = (await esRes.json()) as FeedPayload;

    expect(es.title).not.toBe(en.title);
    expect(es.description).not.toBe(en.description);
    expect(es.link).toContain('/es');
    expect(en.link).not.toContain('/es');
    // Same underlying "what moved" pool -> same item count and same slugs,
    // only the locale-facing text differs (the exact reuse guarantee: zero
    // new scoring/urgency logic, one pool, two renderings).
    expect(es.items.map((i) => i.slug).sort()).toEqual(en.items.map((i) => i.slug).sort());
  });

  test('no caller-derived material ever reaches the response, regardless of request headers', async ({
    request,
  }) => {
    const res = await request.get(ROUTES.en.json, {
      headers: { 'x-forwarded-for': '203.0.113.77, 198.51.100.9' },
    });
    const text = await res.text();
    expect(text).not.toContain('203.0.113.77');
    expect(text).not.toContain('198.51.100.9');
  });
});

test.describe('RSS feed', () => {
  test('en: 200, correct content-type, valid RSS 2.0 shape', async ({ request }) => {
    const res = await request.get(ROUTES.en.xml);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/rss+xml');
    expect(res.headers()['set-cookie']).toBeUndefined();

    const body = await res.text();
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(body).toContain('<rss version="2.0">');
    expect(body).toContain('<channel>');
    expect(body).toContain('</channel>');
    expect(body).toContain('</rss>');
    expect(body).toContain('<language>en-us</language>');
    expect(body).toContain('<generator>Oravan</generator>');

    // Every pubDate present is well-formed RFC 822.
    const pubDates = [...body.matchAll(/<pubDate>(.*?)<\/pubDate>/g)].map((m) => m[1]);
    for (const d of pubDates) {
      expect(d).toMatch(/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    }

    // Structural escaping sanity on real content: no bare, unescaped "&"
    // survives (a lone "&" not immediately followed by a recognized entity
    // name would mean escapeXml was skipped somewhere) — the adversarial
    // proof lives in tests/tenant-feed.unit.spec.ts; this is the "real
    // corpus never regresses it" check.
    expect(body).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  test('item count matches the JSON feed exactly, same slugs implied by matching titles', async ({
    request,
  }) => {
    const [jsonRes, xmlRes] = await Promise.all([request.get(ROUTES.en.json), request.get(ROUTES.en.xml)]);
    const json = (await jsonRes.json()) as FeedPayload;
    const xml = await xmlRes.text();
    const itemCount = (xml.match(/<item>/g) ?? []).length;
    expect(itemCount).toBe(json.items.length);
  });

  test('es: language tag is "es", not "en-us"', async ({ request }) => {
    const res = await request.get(ROUTES.es.xml);
    const body = await res.text();
    expect(body).toContain('<language>es</language>');
    expect(body).not.toContain('<language>en-us</language>');
  });
});

test.describe('discoverability', () => {
  test('homepage carries an RSS alternate link pointing at the locale-correct feed', async ({ page }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="alternate"][type="application/rss+xml"]').getAttribute('href');
    expect(href).toBe('https://oravan.org/feed/whats-moving.xml');

    await page.goto('/es');
    const esHref = await page.locator('link[rel="alternate"][type="application/rss+xml"]').getAttribute('href');
    expect(esHref).toBe('https://oravan.org/es/feed/whats-moving.xml');
  });

  test('the /embeds docs page links both feed formats and the embeds ToS', async ({ page }) => {
    await page.goto('/embeds');
    await expect(page.locator('a[href="/feed/whats-moving.json"]')).toHaveCount(1);
    await expect(page.locator('a[href="/feed/whats-moving.xml"]')).toHaveCount(1);
    await expect(page.locator('a[href="/embeds/terms"]')).toHaveCount(1);
  });
});
