import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { encodeShortAddressIndex, SHORT_ADDRESS_CONGRESS, type ShortAddressBill } from './lib/short-address';

const withNextIntl = createNextIntlPlugin();

// Short addresses for bills (/hr9340, lib/short-address.ts): which bills of
// the current Congress exist, as a ~3 KB bitset, computed here at BUILD time
// from the committed corpus and inlined into proxy.ts's bundle by `env`
// below. Only the bitset crosses; the corpus stays out of the proxy bundle.
// Not a secret: it says which public bill numbers the public corpus holds.
const bills = JSON.parse(readFileSync(join(process.cwd(), 'data/bills.json'), 'utf8')) as ShortAddressBill[];

const nextConfig: NextConfig = {
  env: {
    SHORT_ADDRESS_INDEX: encodeShortAddressIndex(bills, SHORT_ADDRESS_CONGRESS),
  },
  images: {
    remotePatterns: [
      // Public-domain congressional portraits (unitedstates project)
      { protocol: 'https', hostname: 'unitedstates.github.io', pathname: '/images/congress/**' },
    ],
  },
  async redirects() {
    // Short addresses are NOT listed here (2026-09-29): one config redirect
    // per bill would be ~6,450 rules, past Next's own 1,000-route warning,
    // matched in order on every request, and a config redirect forwards the
    // request's query string, which a short address must drop (rule 1).
    // proxy.ts answers them instead; see lib/short-address.ts.
    //
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
