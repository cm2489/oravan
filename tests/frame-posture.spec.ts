import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startCrossOriginHost } from './helpers';

/*
 * S17 - the frame-ancestors split posture (docs/ideation/2026-07-05-build-
 * gtm-strategy.md, ledger items F1 and F2; see also
 * docs/plans/2026-07-03-001-feat-oravan-launch-buildout-plan.md's U15 unit).
 *
 * S13 shipped the embed route's OWN minimal CSP (`frame-ancestors *`, tight
 * everywhere else) but deliberately deferred the other half: the rest of the
 * site set NO clickjacking header at all, which meant the whole non-embed
 * surface (call modal, stance selection, the address-refinement flow) was
 * silently frameable by anyone. next.config.ts now adds a second `headers()`
 * block locking every route EXCEPT `app/embed/*` to `frame-ancestors 'self'`
 * - this file is what proves that split actually holds against a built
 * server, not just what the config file claims.
 *
 * Two things this file has to get right that are easy to get subtly wrong:
 *  1. The two header blocks must never both apply to the same path. They're
 *     mutually exclusive by construction (`/embed/:path*` vs. the
 *     negative-lookahead `/((?!embed).*)`), which matters because browsers
 *     enforce multiple CSP headers as an intersection - if both ever
 *     matched the same path, the site-wide 'self' would silently re-narrow
 *     the embed carve-out. Confirmed against a built server (curl, then the
 *     "split holds under a single request" test below), not assumed from
 *     reading path-to-regexp docs.
 *  2. A brand-new top-level route segment must not be able to ship with no
 *     frame-ancestors decision at all. The "regression guard" describe
 *     block below discovers segments from the app/ tree at test-run time
 *     (not a hand-maintained list) and fails loudly if one has no
 *     registered check.
 */

const SITE_LOCK = "frame-ancestors 'self'";
const EMBED_CARVEOUT = 'frame-ancestors *';

function csp(res: { headers(): Record<string, string> }) {
  return res.headers()['content-security-policy'] ?? '';
}

test.describe('F1: site-wide frame-ancestors lock, app/embed/* the sole carve-out', () => {
  test("bill page returns frame-ancestors 'self'", async ({ request }) => {
    // Same stable slug tests/flow.spec.ts and tests/es-parity.spec.ts drive.
    const res = await request.get('/bills/sjres-99-119');
    expect(csp(res)).toContain(SITE_LOCK);
  });

  test("homepage returns frame-ancestors 'self'", async ({ request }) => {
    const res = await request.get('/');
    expect(csp(res)).toContain(SITE_LOCK);
  });

  test('the embed route returns its own permissive carve-out, never the site lock', async ({
    request,
  }) => {
    const res = await request.get('/embed/rep-lookup?locale=en');
    const policy = csp(res);
    expect(policy).toContain(EMBED_CARVEOUT);
    expect(policy).not.toContain(SITE_LOCK);
    // The carve-out is still tight everywhere else (S13) - a third-party
    // request from inside the widget stays blocked by the browser itself.
    expect(policy).toContain("connect-src 'self'");
  });

  test('the split holds under a single request: /embed/* never also carries the site lock header', async ({
    request,
  }) => {
    // Guards against the two headers() blocks both matching and Next
    // appending a second Content-Security-Policy line - browsers enforce
    // multiple CSP headers as an intersection, which would silently
    // re-narrow the embed carve-out back to 'self' and break every host
    // page's iframe with no visible error in this app's own code.
    const res = await request.get('/embed/rep-lookup?locale=en');
    const raw = res.headersArray().filter((h) => h.name.toLowerCase() === 'content-security-policy');
    expect(raw).toHaveLength(1);
  });
});

test.describe(
  "regression guard: every top-level app/ route segment has a registered frame-ancestors check",
  () => {
    const APP_DIR = path.join(process.cwd(), 'app');

    function topLevelDirs(rel: string): string[] {
      const dir = path.join(APP_DIR, rel);
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
        .map((e) => e.name);
    }

    // One concrete, fetchable URL per known app/[locale]/*, app/api/*, and
    // app/embed/* segment, reusing fixtures other suites already depend on
    // (tests/flow.spec.ts's bill slug, tests/district.spec.ts's split ZIP).
    // A segment absent from these maps fails the coverage test below FIRST
    // - a new route class can't ship silently; someone has to add an entry
    // here and state what its frame-ancestors answer is.
    const LOCALE_ROUTES: Record<string, string> = {
      about: '/about',
      bills: '/bills/sjres-99-119',
      citations: '/citations',
      partners: '/partners', // S5b's partner GTM page - standard locked-down posture
      embeds: '/embeds', // S16's configurator + docs page
      impact: '/impact',
      mcp: '/mcp', // S12's MCP server docs page - standard locked-down posture
      // S6: per-locale PWA manifest (a route handler, not a page). Non-embed,
      // so next.config.ts's site-wide block locks it to 'self' like everything
      // else - a JSON manifest is never framed, but the guard still demands an
      // explicit frame-ancestors decision for every new app/[locale]/ segment.
      'manifest.webmanifest': '/en/manifest.webmanifest',
      privacy: '/privacy',
      reps: '/reps',
      terms: '/terms',
      'why-call': '/why-call',
    };
    const API_ROUTES: Record<string, string> = {
      district: '/api/district',
      feedback: '/api/feedback',
      mcp: '/api/mcp/mcp',
      reps: '/api/reps?zip=78501',
      script: '/api/script',
    };
    const EMBED_ROUTES: Record<string, string> = {
      'rep-lookup': '/embed/rep-lookup?locale=en',
      'bill-card': '/embed/bill-card?locale=en&slug=hr-5582-119',
      // S15: same-origin portrait proxy. 404s in the shipped (no Blob store
      // yet) state - see tests/embed-portrait.unit.spec.ts for that behavior
      // and the Owner enable checklist for what lights it up. Still under
      // /embed/:path*, so next.config.ts's embed CSP block applies
      // regardless of the response's status code.
      portrait: '/embed/portrait/C000127',
    };

    test('coverage maps match the actual app/ tree - no undecided segment slipped in', () => {
      for (const name of topLevelDirs('[locale]')) {
        expect(
          Object.keys(LOCALE_ROUTES),
          `app/[locale]/${name} shipped with no registered frame-ancestors check - add one to tests/frame-posture.spec.ts`
        ).toContain(name);
      }
      for (const name of topLevelDirs('api')) {
        expect(
          Object.keys(API_ROUTES),
          `app/api/${name} shipped with no registered frame-ancestors check - add one to tests/frame-posture.spec.ts`
        ).toContain(name);
      }
      for (const name of topLevelDirs('embed')) {
        expect(
          Object.keys(EMBED_ROUTES),
          `app/embed/${name} shipped with no registered frame-ancestors check - add one to tests/frame-posture.spec.ts`
        ).toContain(name);
      }
    });

    for (const [name, url] of Object.entries(LOCALE_ROUTES)) {
      test(`app/[locale]/${name} -> ${url}: frame-ancestors 'self'`, async ({ request }) => {
        const res = await request.get(url);
        expect(csp(res)).toContain(SITE_LOCK);
      });
    }

    for (const [name, url] of Object.entries(API_ROUTES)) {
      test(`app/api/${name} -> ${url}: frame-ancestors 'self' (even on a non-2xx response)`, async ({
        request,
      }) => {
        const res = await request.get(url);
        expect(csp(res)).toContain(SITE_LOCK);
      });
    }

    for (const [name, url] of Object.entries(EMBED_ROUTES)) {
      test(`app/embed/${name} -> ${url}: the permissive carve-out, never 'self'`, async ({
        request,
      }) => {
        const res = await request.get(url);
        const policy = csp(res);
        expect(policy).toContain(EMBED_CARVEOUT);
        expect(policy).not.toContain(SITE_LOCK);
      });
    }
  }
);

test.describe('F2: street-address refinement is unreachable inside an iframe', () => {
  /*
   * The embed widget itself is ZIP-only by construction (no address field
   * exists in components/embed/RepLookupWidget.tsx at all - pinned in
   * tests/embed-rep-lookup.spec.ts). This test covers the other half of F2:
   * even the real, address-capable /reps page - the one place AddressForm
   * actually renders - cannot be embedded in a third-party iframe in the
   * first place, because F1's site-wide lock refuses the framing outright.
   * Real cross-origin host, not page.setContent(): see helpers.ts's
   * startCrossOriginHost comment for why that distinction matters under
   * WebKit specifically (the only browser this suite runs, per
   * playwright.config.ts).
   */
  // Same headroom as tests/embed-loader.spec.ts's cross-origin-host group:
  // a real HTTP server + full iframe round-trip runs measurably slower than
  // the 30s file default under this suite's parallel worker count.
  test.describe.configure({ timeout: 60_000 });

  test('a cross-origin iframe pointed at the split-ZIP address flow never renders the address field', async ({
    page,
    baseURL,
  }) => {
    // 10001 is the real split ZIP (NY-10/NY-12) tests/district.spec.ts
    // drives - the one URL on the whole site where AddressForm renders.
    const target = `${baseURL}/reps?zip=10001`;
    const host = await startCrossOriginHost(
      `<!doctype html><html><body><iframe id="probe" src="${target}" title="probe"></iframe></body></html>`
    );
    const cspViolations: string[] = [];
    page.on('console', (msg) => {
      if (/content security policy|frame-ancestors/i.test(msg.text())) cspViolations.push(msg.text());
    });
    try {
      // domcontentloaded, not the default 'load': a refused/blocked iframe
      // navigation never fires its own 'load' event, and the top document's
      // 'load' event doesn't fire until every subframe's does either - with
      // the default waitUntil this goto() stalls for ~30s (observed) before
      // the browser gives up on the stuck subframe, right at this suite's
      // own test-timeout edge. domcontentloaded only needs the host page's
      // own (trivial, same-process) HTML parsed, which is instant.
      await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      // Give the (refused) iframe navigation a beat to settle either way.
      await page.waitForTimeout(1000);

      const frame = page.frameLocator('#probe');
      // The one non-negotiable assertion, regardless of how the browser
      // chooses to render a frame-ancestors refusal: the address field
      // never appears in this iframe.
      await expect(frame.locator('input[name="street-address"]')).toHaveCount(0);
      // Nor does any of the page's real content - the framing was refused,
      // not just the address form selectively hidden.
      await expect(frame.locator('body')).not.toContainText('Daniel S. Goldman');

      expect(
        cspViolations,
        'expected the browser to log a frame-ancestors refusal for this cross-origin iframe'
      ).not.toHaveLength(0);
    } finally {
      await host.close();
    }
  });
});
