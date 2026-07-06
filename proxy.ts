import createProxy from 'next-intl/middleware';
import { routing } from './i18n/routing';

// Next.js 16: middleware.ts -> proxy.ts. next-intl's handler only does
// locale negotiation/redirects here - no auth, no tracking, nothing stored.
export default createProxy(routing);

// /embed is excluded (S13): those routes have no [locale] URL segment (see
// app/embed/layout.tsx) - locale there is a widget-local query param + an
// in-widget toggle, not a path prefix. Letting next-intl's middleware match
// /embed/* would try to locale-redirect a path structure that doesn't have
// one, and would risk setting next-intl's locale cookie on a route whose
// whole privacy claim is zero cookies, ever.
export const config = {
  matcher: '/((?!api|_next|_vercel|embed|.*\\..*).*)',
};
