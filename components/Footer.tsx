import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

export function Footer() {
  const t = useTranslations('common');

  return (
    <footer className="mt-16 border-t border-line bg-paper-deep">
      {/* pb clears the fixed mobile tab bar so footer links stay tappable */}
      <div className="mx-auto max-w-5xl px-4 pt-10 pb-28 md:pb-10 text-sm text-ink-soft space-y-3">
        <p className="max-w-prose">{t('footer.mission')}</p>
        <p className="max-w-prose">{t('footer.aiNote')}</p>
        <nav aria-label="Footer" className="flex flex-wrap gap-5 pt-2">
          <Link href="/privacy" className="underline underline-offset-2 hover:text-ink">
            {t('footer.privacy')}
          </Link>
          <Link href="/terms" className="underline underline-offset-2 hover:text-ink">
            {t('footer.terms')}
          </Link>
          <Link href="/why-call" className="underline underline-offset-2 hover:text-ink">
            {t('nav.whyCall')}
          </Link>
        </nav>
      </div>
    </footer>
  );
}
