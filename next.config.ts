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
  async headers() {
    // Dev/HMR wants 'unsafe-eval' and other looseness this policy doesn't
    // grant - scope it to production (the same mode Playwright's webServer
    // builds and starts) so `npm run dev` on the embed route is unaffected.
    if (process.env.NODE_ENV !== 'production') return [];
    return [
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
        source: '/((?!embed).*)',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
