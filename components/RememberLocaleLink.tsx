'use client';

import type { ComponentProps } from 'react';
import { Link } from '@/i18n/navigation';
import { rememberLocaleChoice, type LocaleChoice } from '@/lib/locale-pref';

/**
 * An i18n Link that records the explicit language choice on click
 * (lib/locale-pref.ts) — the write that lets "¿Prefieres español?" offer
 * the one-tap way back on the next bare-URL entry. Exists so server
 * components (the home hero's "Ver en español" line) can render a
 * choice-remembering link without becoming client components themselves.
 * Same Link contract otherwise; never a redirect.
 */
export function RememberLocaleLink({
  locale,
  ...props
}: Omit<ComponentProps<typeof Link>, 'locale'> & { locale: LocaleChoice }) {
  return <Link {...props} locale={locale} onClick={() => rememberLocaleChoice(locale)} />;
}
