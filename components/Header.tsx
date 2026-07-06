'use client';

import { Home, ScrollText, Users, Activity, PhoneCall } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { LocaleSwitcher } from './LocaleSwitcher';

const TABS = [
  { href: '/', key: 'home', icon: Home },
  { href: '/bills', key: 'bills', icon: ScrollText },
  { href: '/reps', key: 'reps', icon: Users },
  { href: '/impact', key: 'impact', icon: Activity },
] as const;

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function Header() {
  const t = useTranslations('common');
  const pathname = usePathname();

  return (
    <>
      <header className="bg-night text-paper">
        <div className="mx-auto max-w-5xl px-4 py-3 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2 font-display text-2xl font-bold tracking-tight">
            <span aria-hidden className="inline-flex h-8 w-8 items-center justify-center rounded-control bg-brass text-paper">
              <PhoneCall className="h-4.5 w-4.5" strokeWidth={2.5} />
            </span>
            {t('appName')}
          </Link>
          <nav aria-label="Primary" className="hidden md:flex items-center gap-1">
            {TABS.map(({ href, key }) => (
              <Link
                key={key}
                href={href}
                aria-current={isActive(pathname, href) ? 'page' : undefined}
                className={`px-3 py-2 rounded-control text-sm font-medium transition-colors ${
                  isActive(pathname, href)
                    ? 'bg-brass text-paper'
                    : 'text-paper/85 hover:text-paper hover:bg-white/10'
                }`}
              >
                {t(`nav.${key}`)}
              </Link>
            ))}
            <Link
              href="/why-call"
              aria-current={isActive(pathname, '/why-call') ? 'page' : undefined}
              className={`px-3 py-2 rounded-control text-sm font-medium transition-colors ${
                isActive(pathname, '/why-call')
                  ? 'bg-brass text-paper'
                  : 'text-paper/85 hover:text-paper hover:bg-white/10'
              }`}
            >
              {t('nav.whyCall')}
            </Link>
          </nav>
          <LocaleSwitcher />
        </div>
      </header>

      {/* Mobile bottom tab bar - thumb-reachable, 44px+ targets */}
      <nav
        aria-label="Primary"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-night text-paper border-t border-white/10 pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="grid grid-cols-4">
          {TABS.map(({ href, key, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <li key={key}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex flex-col items-center gap-1 py-2.5 text-xs font-medium ${
                    active ? 'text-brass-bright' : 'text-paper/75'
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
