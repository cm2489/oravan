import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * S22 — structural assertions on the JSON-LD this pass adds (lib/jsonld.ts,
 * rendered via components/JsonLd.tsx). Not a full schema.org conformance
 * checker — that's Google's Rich Results Test's job, and it needs a live
 * public URL this repo doesn't have yet (noindex is still active) — but
 * enough to catch the regressions that matter: valid JSON, the right
 * @graph shape, dates that are real (never invented), FAQPage present only
 * when the decode structure supports it, and the AI-content disclosure
 * actually carried in the markup.
 */

const SITE_ORIGIN = 'https://oravan.org';

async function readJsonLd(page: Page, scriptId: string): Promise<Record<string, unknown>> {
  const raw = await page.locator(`script#${scriptId}`).textContent();
  expect(raw, `#${scriptId} must be present`).toBeTruthy();
  return JSON.parse(raw!);
}

test.describe('bill page JSON-LD (@graph: Article + FAQPage)', () => {
  test('decoded bill: Article + FAQPage, real dates, AI disclosure, en', async ({ page }) => {
    await page.goto('/bills/hr-5582-119');
    const doc = await readJsonLd(page, 'bill-jsonld');

    expect(doc['@context']).toBe('https://schema.org');
    const graph = doc['@graph'] as Array<Record<string, unknown>>;
    expect(Array.isArray(graph)).toBe(true);

    const article = graph.find((n) => n['@type'] === 'Article');
    expect(article, 'Article node').toBeTruthy();
    expect(typeof article!.headline).toBe('string');
    expect((article!.headline as string).length).toBeGreaterThan(0);
    expect(article!.url).toBe(`${SITE_ORIGIN}/bills/hr-5582-119`);
    expect(article!.inLanguage).toBe('en');
    expect(article!.publisher).toMatchObject({ '@type': 'Organization', name: 'Oravan' });

    // Dates must be real (present, parseable, and drawn from the corpus —
    // never invented): this bill has both introduced_date and last_action_date.
    expect(typeof article!.datePublished).toBe('string');
    expect(Number.isNaN(Date.parse(article!.datePublished as string))).toBe(false);
    expect(typeof article!.dateModified).toBe('string');
    expect(Number.isNaN(Date.parse(article!.dateModified as string))).toBe(false);

    // AI content is always labeled (hard rule) — carried as an honestly-named
    // additionalProperty since schema.org has no ratified "AI-generated" term.
    expect(article!.additionalProperty).toMatchObject({
      '@type': 'PropertyValue',
      name: 'contentDisclosure',
    });

    // FAQPage: the decode structure (what/who/why/cost) genuinely supports
    // it for this bill, and the question text reuses the exact translated
    // labels DecodedSections renders — not new copy.
    const faq = graph.find((n) => n['@type'] === 'FAQPage');
    expect(faq, 'FAQPage node').toBeTruthy();
    const mainEntity = faq!.mainEntity as Array<Record<string, unknown>>;
    expect(mainEntity.length).toBeGreaterThan(0);
    const names = mainEntity.map((q) => q.name);
    expect(names).toContain(en.bill.sec.what);
    expect(names).toContain(en.bill.sec.who);
    expect(names).toContain(en.bill.sec.why);
    for (const q of mainEntity) {
      expect(q['@type']).toBe('Question');
      const answer = q.acceptedAnswer as Record<string, unknown>;
      expect(answer['@type']).toBe('Answer');
      expect(typeof answer.text).toBe('string');
      expect((answer.text as string).length).toBeGreaterThan(0);
    }
  });

  test('decoded bill: es locale carries es question labels and inLanguage', async ({ page }) => {
    await page.goto('/es/bills/sjres-99-119');
    const doc = await readJsonLd(page, 'bill-jsonld');
    const graph = doc['@graph'] as Array<Record<string, unknown>>;

    const article = graph.find((n) => n['@type'] === 'Article');
    expect(article!.inLanguage).toBe('es');
    expect(article!.url).toBe(`${SITE_ORIGIN}/es/bills/sjres-99-119`);

    const faq = graph.find((n) => n['@type'] === 'FAQPage');
    expect(faq, 'FAQPage node').toBeTruthy();
    const names = (faq!.mainEntity as Array<Record<string, unknown>>).map((q) => q.name);
    expect(names).toContain(es.bill.sec.what);
    expect(names).toContain(es.bill.sec.who);
    expect(names).toContain(es.bill.sec.why);
    // No English question label leaks into the ES graph.
    expect(names).not.toContain(en.bill.sec.what);
  });

  test('undecoded bill: Article only, no fabricated FAQ, still real dates', async ({ page }) => {
    await page.goto('/bills/hr-8553-119');
    const doc = await readJsonLd(page, 'bill-jsonld');
    const graph = doc['@graph'] as Array<Record<string, unknown>>;

    const article = graph.find((n) => n['@type'] === 'Article');
    expect(article, 'Article node').toBeTruthy();
    // introduced_date/last_action_date exist on every bill regardless of
    // decode status, so the Article still carries real, non-invented dates.
    expect(typeof article!.datePublished).toBe('string');
    expect(typeof article!.dateModified).toBe('string');
    // No AI content exists for this bill yet — no disclosure property to make.
    expect(article!.additionalProperty).toBeUndefined();

    // The decode structure does NOT support FAQPage for an undecoded bill —
    // asserting its absence (not just "FAQPage is optional") is the point.
    expect(graph.find((n) => n['@type'] === 'FAQPage')).toBeUndefined();
  });
});

test.describe('homepage + reps page JSON-LD (cheap Organization/WebSite)', () => {
  test('homepage: Organization + WebSite, absolute url, inLanguage', async ({ page }) => {
    await page.goto('/');
    const doc = await readJsonLd(page, 'site-jsonld');
    const graph = doc['@graph'] as Array<Record<string, unknown>>;

    const org = graph.find((n) => n['@type'] === 'Organization');
    expect(org).toMatchObject({ name: 'Oravan', url: SITE_ORIGIN });

    const site = graph.find((n) => n['@type'] === 'WebSite');
    expect(site, 'WebSite node').toBeTruthy();
    // No trailing slash: matches the root-path special case Next's Metadata
    // resolver applies to canonical/alternate URLs (lib/hreflang.ts's
    // absoluteUrl mirrors it on purpose, and buildSiteJsonLd reuses that).
    expect(site!.url).toBe(SITE_ORIGIN);
    expect(site!.inLanguage).toBe('en');
  });

  test('spanish homepage: WebSite url and inLanguage follow the locale', async ({ page }) => {
    await page.goto('/es');
    const doc = await readJsonLd(page, 'site-jsonld');
    const graph = doc['@graph'] as Array<Record<string, unknown>>;
    const site = graph.find((n) => n['@type'] === 'WebSite');
    expect(site!.url).toBe(`${SITE_ORIGIN}/es`);
    expect(site!.inLanguage).toBe('es');
  });

  test('reps page: Organization present, no invented WebSite duplicate', async ({ page }) => {
    await page.goto('/reps');
    const doc = await readJsonLd(page, 'org-jsonld');
    const graph = doc['@graph'] as Array<Record<string, unknown>>;
    expect(graph.find((n) => n['@type'] === 'Organization')).toMatchObject({ name: 'Oravan' });
    expect(graph.find((n) => n['@type'] === 'WebSite')).toBeUndefined();
  });
});
