'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

/*
 * THE LANGUAGE SWITCH — both languages, always visible, in their own words.
 *
 * A one-way "En español" toggle names the other language but never shows you
 * which one you are in. The segmented pair does both jobs at once: it is a
 * state display and a control, and a Spanish reader recognises "Español"
 * without reading English first.
 *
 * SHAPE: a small mark, so it is stamped at 3px (`rounded-stamp`) — the shape
 * law assigns radius by SCALE. The two links round their own outer corners at
 * the same 3px, so no derived radius appears anywhere.
 *
 * COLOR: ink fill = "you are here". That is this switch's own convention in
 * the reference, and the header nav borrows it, so one mark means one thing
 * across the whole bar. No green: the action green is spent on actions, and
 * changing language is navigation.
 *
 * WIDTH is set by the LONGER (Spanish) label, per the bilingual rule —
 * "Español" sizes the cell and "English" sits inside it.
 *
 * The link that LEAVES the current locale carries `switchLocale` as its
 * accessible name ("En español" / "In English"): the announced name states the
 * action, the visible label states the destination, and the visible text is
 * contained in the accessible name, so WCAG 2.5.3 (Label in Name) holds.
 */

/** Endonyms — a language names itself the same way in every locale. */
const LOCALE_NAME: Record<string, string> = { en: 'English', es: 'Español' };

export function LocaleSwitcher() {
  const t = useTranslations('common');
  const locale = useLocale();
  const pathname = usePathname();

  return (
    <div
      role="group"
      aria-label={t('localeGroupLabel')}
      // `inline-grid` + `grid-cols-2` makes BOTH cells the width of the wider
      // label, which is what the note above always claimed and the flex
      // version never did (measured: English 72.8px vs Español 76.7px, so the
      // ink fill changed width when you switched language).
      className="inline-grid grid-cols-2 rounded-stamp border-[1.5px] border-ink"
    >
      {routing.locales.map((code) => {
        const current = code === locale;
        return (
          <Link
            key={code}
            href={pathname}
            locale={code}
            lang={code}
            hrefLang={code}
            aria-current={current ? 'page' : undefined}
            aria-label={current ? undefined : t('switchLocale')}
            className={[
              'inline-flex min-h-11 items-center justify-center px-3 text-sm font-semibold no-underline transition-colors',
              // NESTED-CORNER MATH, derived from the parent token rather than
              // hardcoded, so it can never drift from it. The parent's 3px
              // radius is drawn OUTSIDE a 1.5px border, so the inner corner it
              // leaves is 1.5px. Giving the fill the parent's full 3px made the
              // ink corner larger than the box containing it, and it bled at
              // the rounding — this is the same calc() the reference mockup
              // used and the port dropped.
              'first:rounded-l-[calc(var(--radius-stamp)-1.5px)]',
              'last:rounded-r-[calc(var(--radius-stamp)-1.5px)]',
              current ? 'bg-ink text-paper' : 'text-ink hover:bg-wash active:bg-wash',
            ].join(' ')}
          >
            {LOCALE_NAME[code] ?? code}
          </Link>
        );
      })}
    </div>
  );
}
