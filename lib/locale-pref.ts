/*
 * THE REMEMBERED LANGUAGE CHOICE (2026-08-04 walkthrough P1: "Spanish is a
 * mode you must re-enter" — choosing Español was forgotten the moment a
 * bare URL was opened, so every English entry restarted the negotiation).
 *
 * WHAT THIS IS NOT: a redirect signal. URLs are authoritative (founder
 * decision, S6 persona gate 2026-07-07, pinned in i18n/routing.ts and
 * tests/locale-routing.spec.ts): a bare English URL always renders English,
 * and the server never sees or acts on this value — which is why it lives
 * in localStorage rather than a cookie. The ONLY consumer is
 * LocalePreferenceNote, which turns the stored choice into the same
 * dismissible one-tap suggestion a Spanish-configured browser already gets.
 * Negotiate WITH the visitor, never for them.
 *
 * WHY IT IS NOT IN lib/local's Prefs: same reasoning as the note's own
 * dismissal flag — "Erase all my data" clearing it would flip the site's
 * chrome back to English-only-suggestions for the exact visitor who chose
 * Spanish and then erased their civic data. A language choice is chrome,
 * not civic record.
 *
 * Written ONLY by explicit language controls (the header switcher, the
 * hero's language link, the preference note's own CTA) — never passively
 * from a page view, so patron B on a shared terminal is never haunted by
 * patron A's browsing.
 */

export type LocaleChoice = 'en' | 'es';

const KEY = 'oravan.locale.chosen';

export function rememberLocaleChoice(locale: LocaleChoice) {
  try {
    window.localStorage.setItem(KEY, locale);
  } catch {
    /* storage blocked — the choice lasts the navigation it powers */
  }
}

export function readLocaleChoice(): LocaleChoice | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'en' || v === 'es' ? v : null;
  } catch {
    return null;
  }
}
