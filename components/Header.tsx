'use client';

import { Home, ScrollText, Users, Activity } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { OravanLockup } from './brand/OravanLockup';
import { LocaleSwitcher } from './LocaleSwitcher';

/*
 * THE SITE BAR — the most-seen surface in the product, so it is held to a
 * budget: at 390px it is ONE row, 56px tall, and it is the only thing between
 * the top of the screen and the page's own headline.
 *
 * GROUND: paper, closed by a `line` rule. `line` (1.37:1) is legal here
 * because it SEPARATES two paper areas — it is not a component edge, and it is
 * not the only thing making a control findable.
 *
 * "YOU ARE HERE" IS AN INK FILL, and nothing else. That is the language
 * switch's own convention in the reference, so the nav borrows it and one mark
 * means one thing across the whole bar. The action green is spent on actions;
 * navigating is not an action, and the go-mark (the 6px bar) never underlines
 * a link.
 *
 * SHAPE: nav items are hand-sized, so 8px (`rounded-control`). The language
 * switch is a small mark, so 3px. That is the shape law — radius by scale.
 *
 * TWO NAVS, ONE AT A TIME: the row nav is display:none below 48rem and the
 * thumb bar is display:none above it, so exactly one "Primary" navigation
 * landmark is ever in the accessibility tree. Home is dropped from the row nav
 * because the lockup already is the home link; the thumb bar keeps it, because
 * a lockup is not thumb-reachable.
 */

/** The thumb bar (phones): four destinations, home included. */
const TABS = [
  { href: '/', key: 'home', icon: Home },
  { href: '/bills', key: 'bills', icon: ScrollText },
  { href: '/reps', key: 'reps', icon: Users },
  { href: '/impact', key: 'impact', icon: Activity },
] as const;

/**
 * The row nav (48rem and up): no Home — the lockup carries it.
 *
 * `wide` holds an item back until 64rem. Spanish runs ~40% longer than
 * English here ("Mis representantes", "¿Por qué llamar?"), and the bar is
 * sized for the LONGER language: at 48–64rem all four ES labels plus the
 * language switch overrun the gutter, measured. "Why call?" is the one that
 * yields, because it is also a footer link on every page — nothing becomes
 * unreachable at any width.
 */
const LINKS = [
  { href: '/bills', key: 'bills', wide: false },
  { href: '/reps', key: 'reps', wide: false },
  { href: '/impact', key: 'impact', wide: false },
  { href: '/why-call', key: 'whyCall', wide: true },
] as const;

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function Header() {
  const t = useTranslations('common');
  const pathname = usePathname();

  return (
    <>
      <header className="border-b border-line bg-paper">
        <div className="mx-auto flex min-h-14 max-w-5xl items-center gap-3 px-4 md:min-h-16">
          <Link href="/" className="inline-flex min-h-11 items-center text-ink">
            {/* Sized AGAINST the language switch, not by eye: the switch box
                measures 46px tall, and the lockup's art height is the mark
                times RAVAN_SCALE (1.0657). 2.5rem puts the art at ~42.6px, so
                the two objects read as a matched pair inside both the 56px
                mobile bar and the 64px desktop one. */}
            <OravanLockup markRem={2.5} markClassName="text-go" />
          </Link>

          <nav
            aria-label={t('nav.primaryLabel')}
            className="ml-auto hidden items-center gap-0.5 md:flex lg:gap-1"
          >
            {LINKS.map(({ href, key, wide }) => {
              const active = isActive(pathname, href);
              return (
                <Link
                  key={key}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`min-h-11 items-center rounded-control px-2 text-sm font-semibold whitespace-nowrap transition-colors lg:px-3 ${
                    wide ? 'hidden lg:inline-flex' : 'inline-flex'
                  } ${active ? 'bg-ink text-paper' : 'text-ink hover:bg-wash active:bg-wash'}`}
                >
                  {t(`nav.${key}`)}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto md:ml-0">
            <LocaleSwitcher />
          </div>
        </div>
      </header>

      {/* The thumb bar. Paper, not ink: the footer is the page's only dark
          mass, and a permanent dark band across the bottom of every phone
          screen would take that meaning away from it. Its top rule is
          `line-strong` (3.24:1 on paper) because THAT rule is a real
          boundary — the only thing separating a fixed bar from the content
          scrolling underneath it — and `line` would not clear 1.4.11. */}
      <nav
        aria-label={t('nav.primaryLabel')}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line-strong bg-paper pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="mx-auto grid max-w-5xl grid-cols-4">
          {TABS.map(({ href, key, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <li key={key}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex min-h-12 flex-col items-center justify-center gap-0.5 px-2 text-2xs leading-tight ${
                    active
                      ? 'font-bold text-ink after:absolute after:inset-x-0 after:top-0 after:h-[3px] after:bg-ink'
                      : 'font-semibold text-ink-2'
                  }`}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                  {t(`navShort.${key}`)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
