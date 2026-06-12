'use client';

import { Languages } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';

export function LocaleSwitcher() {
  const t = useTranslations('common');
  const locale = useLocale();
  const pathname = usePathname();
  const other = locale === 'en' ? 'es' : 'en';

  return (
    <Link
      href={pathname}
      locale={other}
      className="inline-flex items-center gap-1.5 rounded-control border border-paper/30 px-3 py-1.5 text-sm font-medium text-paper hover:bg-white/10"
    >
      <Languages className="h-4 w-4" aria-hidden />
      {t('switchLocale')}
    </Link>
  );
}
