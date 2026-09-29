import { expect, test } from '@playwright/test';
import { callableBillSlug, firstHouseRepName, splitZip } from './corpus-samples';
import { startCrossOriginHost } from './helpers';
import {
  API_PROBES,
  appTopLevelDirs,
  embedProbes,
  localeProbes,
  unresolvedLocaleRoutes,
} from './routes';

/*
 * S17 - the frame-ancestors split posture (the project records, ledger items F1 and F2; see also
 * the project records U15 unit).
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
    // A bill page with the full call panel on it — the surface a frame
    // would target (tests/corpus-samples.ts).
    const res = await request.get(`/bills/${callableBillSlug()}`);
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
  "regression guard: every app/ route has a registered frame-ancestors check",
  () => {
    /*
     * Every route under app/[locale] — each page, the per-locale PWA manifest
     * handler and the locale catch-all's 404 — is read off the tree by
     * tests/routes.ts and takes the site-wide lock, with no list to forget to
     * extend: a new page is checked the day it lands. A new DYNAMIC route
     * fails the coverage test below until tests/routes.ts gives it a corpus
     * probe (a real record, so the check can never pass on a 404 that happens
     * to carry the right header). The CSP headers are path-pattern-based
     * (next.config.ts), never status- or render-state-based, so the 404, the
     * 405s and the unauthorized states below still prove the posture.
     *
     * The call surfaces are why this matters: the bill page and the Senate
     * nomination page mount the same ActionPanel — stance selection, the
     * generated script, the dials — and a framed call surface is a
     * clickjacking target.
     *
     * app/api/* and app/embed/* are listed per segment in tests/routes.ts
     * (API_PROBES, embedProbes()); a segment absent there fails the coverage
     * test FIRST — a new route class can't ship silently; someone has to add
     * an entry and so state what its frame-ancestors answer is: the lock for
     * every API, the carve-out for every embed.
     */
    const LOCALE_PROBES = localeProbes(['en']);
    const EMBED_PROBES = embedProbes();

    test('coverage maps match the actual app/ tree - no undecided segment slipped in', () => {
      expect(
        unresolvedLocaleRoutes(),
        'app/[locale] routes with no corpus probe - add one to DYNAMIC_ROUTE_PROBES in tests/routes.ts'
      ).toEqual([]);
      // Never vacuous: the tree always holds the homepage (tests/routes.unit.spec.ts
      // cross-checks the walker against an independent listing of the tree).
      expect(LOCALE_PROBES.map((p) => p.route.pattern)).toContain('/');
      for (const name of appTopLevelDirs('api')) {
        expect(
          Object.keys(API_PROBES),
          `app/api/${name} shipped with no registered frame-ancestors check - add one to API_PROBES in tests/routes.ts`
        ).toContain(name);
      }
      for (const name of appTopLevelDirs('embed')) {
        expect(
          Object.keys(EMBED_PROBES),
          `app/embed/${name} shipped with no registered frame-ancestors check - add one to embedProbes() in tests/routes.ts`
        ).toContain(name);
      }
    });

    // Titles name the route, not the probe URL: a dynamic route's probe is a
    // corpus record that turns over, and a test's identity should not.
    for (const { route, url } of LOCALE_PROBES) {
      test(`app/[locale]${route.pattern}: frame-ancestors 'self'`, async ({ request }) => {
        const res = await request.get(url);
        expect(csp(res), url).toContain(SITE_LOCK);
      });
    }

    for (const [name, url] of Object.entries(API_PROBES)) {
      test(`app/api/${name} -> ${url}: frame-ancestors 'self' (even on a non-2xx response)`, async ({
        request,
      }) => {
        const res = await request.get(url);
        expect(csp(res)).toContain(SITE_LOCK);
      });
    }

    for (const [name, url] of Object.entries(EMBED_PROBES)) {
      test(`app/embed/${name}: the permissive carve-out, never 'self'`, async ({ request }) => {
        const res = await request.get(url);
        const policy = csp(res);
        expect(policy, url).toContain(EMBED_CARVEOUT);
        expect(policy, url).not.toContain(SITE_LOCK);
      });
    }
  }
);

test.describe('F2: street-address refinement is unreachable inside an iframe', () => {
  /*
   * The embed widget itself is ZIP-only by construction (no address field
   * exists in components/embed/RepLookupWidget.tsx at all - pinned in
   * tests/embed-rep-lookup.spec.ts). This test covers the other half of F2:
   * even the real, address-capable /reps page - where AddressForm renders
   * from the URL alone - cannot be embedded in a third-party iframe in the
   * first place, because F1's site-wide lock refuses the framing outright.
   * (The settled bill panel's House finder renders it too, but only for a ZIP
   * saved in this origin's storage, and F1 locks every bill page the same.)
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
    // A real split ZIP from the committed Census table (tests/corpus-samples.ts)
    // - the one URL on the site that renders AddressForm by itself.
    const zip = splitZip();
    const target = `${baseURL}/reps?zip=${zip}`;
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
      // not just the address form selectively hidden. The name is the ZIP's
      // own House member, read from the roster, so this can never pass
      // because the member changed.
      await expect(frame.locator('body')).not.toContainText(firstHouseRepName(zip));

      expect(
        cspViolations,
        'expected the browser to log a frame-ancestors refusal for this cross-origin iframe'
      ).not.toHaveLength(0);
    } finally {
      await host.close();
    }
  });
});
