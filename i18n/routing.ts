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
  // English link silently served Spanish).
  localeDetection: false,
  // No NEXT_LOCALE cookie AT ALL (2026-08-04). With detection off the cookie
  // was written but never read — pure vestige — and it was written WRONG:
  // measured on the production build, an explicit Español toggle left it at
  // 'en' (only a later full-page /es load corrected it). An explicit
  // language choice is remembered on-device instead (lib/locale-pref.ts,
  // consumed only by the dismissible LocalePreferenceNote suggestion), so
  // the main site now sets the same number of cookies as the embeds: zero.
  localeCookie: false,
});
