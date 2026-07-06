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
        // This is NOT the site-wide frame-ancestors lock: that's S17
        // (docs/ideation/2026-07-05-build-gtm-strategy.md, ledger item F1),
        // deliberately deferred - the rest of the site sets no clickjacking
        // header yet, and shipping the lock here-and-only-here risks it
        // quietly becoming "done" without the app/embed/* carve-out review
        // S17 is scoped to do properly.
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
    ];
  },
};

export default withNextIntl(nextConfig);
