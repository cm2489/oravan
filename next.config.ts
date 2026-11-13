import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      // Public-domain congressional portraits (unitedstates project)
      { protocol: 'https', hostname: 'unitedstates.github.io', pathname: '/images/congress/**' },
    ],
  },
  async redirects() {
    // Route rename (owner decision, 2026-08): /moments → /questions,
    // /impact → /record. `:path*` matches zero segments, so the bare paths
    // are covered by the same rules as their children (and #fragments
    // survive client-side). The /es sources must be explicit because these
    // config redirects run BEFORE proxy.ts's locale negotiation; /en/*
    // resolves transitively (proxy strips /en → bare path → 308) in two
    // hops, accepted. permanent:true issues 308.
    return [
      { source: '/moments/:path*', destination: '/questions/:path*', permanent: true },
      { source: '/es/moments/:path*', destination: '/es/questions/:path*', permanent: true },
      { source: '/impact/:path*', destination: '/record/:path*', permanent: true },
      { source: '/es/impact/:path*', destination: '/es/record/:path*', permanent: true },
    ];
  },
  async headers() {
    /*
     * THE MEMBERS PAGE'S REFERER CARRIES NO ADDRESS (2026-11-12). An old
     * link, /reps?zip=NNNNN (or /es/reps?zip=…&district=…), still reaches
     * this page, and with the browser's default policy every request that
     * page load makes to this site (scripts, styles, portraits, the
     * manifest, prefetches), and with JavaScript off the next page clicked,
     * repeated that address, ZIP included, in its Referer header. So /reps
     * answers with a policy that sends at most the origin.
     *
     * `strict-origin`, which is `origin` (the scheme and host only, never the
     * path or query) that also sends nothing when a link leaves HTTPS for
     * HTTP. Not `same-origin`: it sends the FULL address to this site's own
     * requests, which are exactly the ones in the host's log. Not
     * `no-referrer`: under it the browser sends `Origin: null` on a form's
     * native POST (the Fetch standard's origin serialization), and the
     * no-JavaScript ZIP form on /reps posts to a server action, which
     * Next.js aborts when the Origin does not match the host
     * (server/app-render/action-handler.js, 16.2.12). Nothing on the site
     * reads a Referer from /reps: the only Referer readers are the embed
     * routes (app/embed/layout.tsx, app/embed/action-panel/page.tsx), which
     * read a partner page's, and /reps frames no embed.
     *
     * In development too, unlike the CSP blocks below: it costs dev nothing,
     * and the page behaves the same in both. Pinned by
     * tests/reps-zip-address.spec.ts.
     */
    const membersPage = ['/reps', '/es/reps'].map((source) => ({
      source,
      headers: [{ key: 'Referrer-Policy', value: 'strict-origin' }],
    }));
    // Dev/HMR wants 'unsafe-eval' and other looseness this policy doesn't
    // grant - scope it to production (the same mode Playwright's webServer
    // builds and starts) so `npm run dev` on the embed route is unaffected.
    if (process.env.NODE_ENV !== 'production') return membersPage;
    return [
      ...membersPage,
      {
        // The embed route's OWN minimal CSP (S13). Deliberately permissive
        // on frame-ancestors - the entire point of this route is to be
        // framed by any host page - but tight everywhere else, so a
        // third-party request from inside the widget is blocked by the
        // browser itself, not just caught after the fact by CI.
        //
        // This is the SOLE carve-out from the site-wide lock below (S17,
        // ledger item F1). The two `source` patterns are mutually exclusive
        // by construction - this one matches only /embed/*, the site-wide
        // block's negative-lookahead regex matches everything BUT /embed/*
        // - so exactly one block's headers land on any given path. That
        // matters because browsers enforce multiple CSP headers as an
        // intersection: if both blocks ever matched the same path, the
        // site-wide 'self' would silently re-narrow this carve-out and
        // break every host page's iframe with no visible error in this
        // app's own code. Verified against a built server, not assumed from
        // reading path-to-regexp docs - see tests/frame-posture.spec.ts.
        source: '/embed/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self'",
              "font-src 'self'",
              "connect-src 'self'",
              'frame-ancestors *',
              "base-uri 'none'",
              "form-action 'self'",
            ].join('; '),
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      {
        // Site-wide frame lock (S17, ledger item F1). Next.js sets no
        // clickjacking header by default, so absent this, the entire site
        // (call modal, stance selection) is silently frameable by anyone.
        // `app/embed/*` is the SOLE carve-out - matched and answered by the
        // block above - everything else (every [locale] page, every
        // app/api/* route, static/meta files) gets locked to same-origin
        // framing only. X-Frame-Options rides alongside CSP's
        // frame-ancestors for the pre-CSP3 browser floor; both say the same
        // thing.
        //
        // The exclusion is `embed/|embed$` - the exact /embed segment (bare
        // /embed stays excluded too, because the carve-out's
        // `/embed/:path*` also matches it, and both blocks landing on one
        // path would re-narrow the carve-out via CSP intersection) - NOT
        // the bare prefix `embed`. The original prefix form also swallowed
        // S16's /embeds configurator page, leaving a normal [locale] route
        // with NO frame-ancestors header at all; tests/frame-posture.
        // spec.ts's tree-discovery guard is what caught it.
        source: '/((?!embed/|embed$).*)',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
