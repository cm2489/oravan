import { expect, test } from '@playwright/test';
import { getAllBills } from '../lib/core';
import { getAllNominations, nominationSlug } from '../lib/core/nominations';
import { getMoments, getMomentsForNomination, momentClaimsVehicles, vehicleKind } from '../lib/moments';

/*
 * S22 — sitemap.ts, robots.ts, and llms.txt didn't exist before this PR.
 * Structural smoke tests (no XML-parser dependency in this repo, so this
 * asserts on well-known substrings/counts rather than a full DOM parse) that
 * they render, cover both locales, and keep the permissive-crawl posture
 * that lets the sitemap do real work now that the site is indexable
 * (soft-public lift, 2026-07-08).
 */

const SITE_ORIGIN = 'https://oravan.org';
const STATIC_PATH_COUNT = 14; // '/', '/bills', '/reps', '/about', '/privacy', '/terms', '/why-call', '/record', '/citations', '/embeds', '/embeds/terms', '/partners', '/mcp', '/questions'

/**
 * The nomination slugs app/sitemap.ts actually lists: ONLY those a moment in a
 * vehicle-claiming state cites, de-duplicated (two moments may cite one
 * nomination; the sitemap's Map collapses them to one pair of entries).
 *
 * Derived here the same way the route derives it rather than hardcoded, so
 * this arithmetic tracks the file. Until 2026-08-06 the loc-count assertion
 * below simply omitted this term, and the first nomination vehicle to land
 * would have turned it red — reporting a sitemap defect where the sitemap was
 * doing exactly what its own comment says it does.
 *
 * AMENDED 2026-08-09: this said `m.state === 'retired'` too, which is how the
 * route's bug got past it — the test reproduced the defect instead of
 * catching it. A SETTLED moment's nominations were listed in sitemap.xml
 * while their own pages served `robots: { index: false }`, because the page
 * computes that from getMomentsForNomination, which counts live + stale only.
 * Both now read momentClaimsVehicles, and the test below asserts the
 * agreement directly rather than trusting two copies of a rule to match.
 */
function citedNominationSlugs(): Set<string> {
  const slugs = new Set<string>();
  for (const m of getMoments()) {
    if (!momentClaimsVehicles(m)) continue;
    for (const v of m.vehicles) {
      if (vehicleKind(v) === 'nomination') slugs.add(v.slug);
    }
  }
  return slugs;
}

test.describe('sitemap.xml', () => {
  test('renders both locales for every static path, every bill, and every cited nomination', async ({
    request,
  }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('xml');
    const body = await res.text();

    const totalBills = getAllBills().length;
    // Moments (v2 slice S5): every non-retired moment ships, both locales.
    const totalMoments = getMoments().filter((m) => m.state !== 'retired').length;
    const cited = citedNominationSlugs();
    const locCount = (body.match(/<loc>/g) ?? []).length;
    expect(locCount).toBe((STATIC_PATH_COUNT + totalBills + totalMoments + cited.size) * 2);

    // Every cited nomination is listed, both locales…
    for (const slug of cited) {
      expect(body).toContain(`<loc>${SITE_ORIGIN}/nominations/${slug}</loc>`);
      expect(body).toContain(`<loc>${SITE_ORIGIN}/es/nominations/${slug}</loc>`);
    }
    // …and an UNCITED one is not, which is the half that matters: 857 records
    // have reachable pages and every uncited one self-reports noindex, so
    // listing them would be a sitemap arguing with its own pages.
    const uncited = getAllNominations()
      .map(nominationSlug)
      .find((slug) => !cited.has(slug));
    expect(uncited, 'the corpus should hold at least one uncited nomination').toBeDefined();
    expect(body).not.toContain(`<loc>${SITE_ORIGIN}/nominations/${uncited}</loc>`);

    /*
     * THE SITEMAP MAY NEVER LIST A PAGE THAT SAYS NOINDEX.
     *
     * Asserted against the page's OWN predicate — getMomentsForNomination is
     * literally what app/[locale]/nominations/[slug]/page.tsx computes
     * `robots: { index: cited }` from — rather than against a second copy of
     * the rule. That is the check that would have caught the settled-moment
     * bug: any nomination this sitemap lists must be one the page itself
     * claims, whatever states exist now or get added later.
     */
    for (const slug of cited) {
      expect(
        getMomentsForNomination(slug).length,
        `${slug} is in sitemap.xml but its page self-reports noindex`
      ).toBeGreaterThan(0);
    }
    for (const nomination of getAllNominations()) {
      const slug = nominationSlug(nomination);
      if (getMomentsForNomination(slug).length > 0) {
        expect(cited.has(slug), `${slug} is indexable but missing from sitemap.xml`).toBe(true);
      }
    }

    // A representative moment page, both locales.
    expect(body).toContain(`<loc>${SITE_ORIGIN}/questions/iran-war-powers</loc>`);
    expect(body).toContain(`<loc>${SITE_ORIGIN}/es/questions/iran-war-powers</loc>`);

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

/*
 * 2026-08-06 — the claim-truth pass. llms.txt is written for machines that
 * redistribute what it says, and it carried the retired "human-reviewed"
 * claim in TWO places: the corpus sentence at the top and the /bills note
 * under "Notes for automated and AI systems". The original 2026-07-25 audit
 * found and fixed neither. Both are pinned now.
 */
test.describe('llms.txt states the provenance the pipeline actually has', () => {
  test('neither the corpus sentence nor the /bills note claims human review', async ({ request }) => {
    const body = await (await request.get('/llms.txt')).text();

    expect(body, 'no retired human-review claim anywhere in llms.txt').not.toMatch(
      /human[\s-]?review|reviewed by (a|the) (human|person)/i
    );

    // Both sentences, individually, must say what actually guards a publish.
    const corpusSentence = body.split('\n').find((l) => l.startsWith('Oravan publishes a plain-language'));
    expect(corpusSentence, 'the corpus sentence must exist').toBeTruthy();
    expect(corpusSentence!).toContain('AI-drafted and automatically checked');

    const billsNote = body.split('\n').find((l) => l.startsWith('- Content under /bills'));
    expect(billsNote, 'the /bills note must exist').toBeTruthy();
    expect(billsNote!).toContain('automatically checked before publication');

    // Unchanged and still true: the official source is linked from every page.
    expect(billsNote!).toContain('the official source is linked from every bill page');
  });

  /*
   * 2026-08-09. A third sentence, missed by the 2026-08-06 pass because it
   * makes a provenance claim about the SPANISH corpus rather than about
   * review: "The same corpus, decoded independently in Spanish". There has
   * never been an independent Spanish decode — scripts/bill-decode.mjs
   * produces every Spanish field as a translation of the English summary in
   * its second prompt ("ES_SUMMARY is the full summary translation"), and
   * the one backfill that ever wrote Spanish on its own,
   * scripts/translate-summaries.mjs, is EN→ES too. llms.txt is written to be
   * copied by machines that will not come back to check.
   */
  test('the Spanish section says the Spanish layer is a translation, not a second decode', async ({ request }) => {
    const body = await (await request.get('/llms.txt')).text();

    expect(body, 'the retired independent-Spanish-decode claim must be gone').not.toMatch(
      /decoded independently in Spanish|independent(ly)? decoded in Spanish/i
    );

    const spanishSection = body.split('\n').find((l) => l.startsWith('The same corpus'));
    expect(spanishSection, 'the Spanish section must exist').toBeTruthy();
    expect(spanishSection!).toContain('AI translation of the English decode');
    // And it must still name the mechanism that IS real, per the same rule
    // the other two sentences follow (scripts/check-claim-truth.mjs R1).
    expect(spanishSection!).toContain('automated checks');
  });
});
