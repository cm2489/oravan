import createProxy from 'next-intl/middleware';
import { routing } from './i18n/routing';

// Next.js 16: middleware.ts -> proxy.ts. next-intl's handler only does
// locale negotiation/redirects here - no auth, no tracking, nothing stored.
export default createProxy(routing);

export const config = {
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)',
};
