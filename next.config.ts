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
};

export default withNextIntl(nextConfig);
