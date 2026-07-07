import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['en', 'es'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  // URLs are authoritative (founder decision, S6 persona gate 2026-07-07). A
  // stored NEXT_LOCALE cookie must never 307-redirect a bare English URL to
  // its /es twin: an English link always renders English, Spanish lives at
  // /es. This keeps per-locale canonical URLs / hreflang (S22) honest and
  // fixes the shared-terminal trap (patron A picks Spanish, patron B's
  // English link silently served Spanish). The language switcher still writes
  // the cookie on an explicit toggle - only passive detection is disabled.
  localeDetection: false,
});
