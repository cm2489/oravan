import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { FeedbackDialog } from '@/components/FeedbackDialog';
import { DONATE_URL } from '@/lib/site';

/*
 * donateUrl defaults to the real DONATE_URL constant - every real call site
 * (there's exactly one, in the root layout) renders unchanged. The prop
 * exists as forward-compatible test infrastructure for injecting a fixture
 * value, since this project's Playwright setup can't currently render a
 * Rostra component directly (its .tsx JSX transform is hijacked for
 * Playwright's own component-testing runtime - see tests/donate.unit.spec.ts
 * for what that test actually verifies instead: the source-level wiring,
 * not a live "lit" render).
 */
export function Footer({ donateUrl = DONATE_URL }: { donateUrl?: string | null } = {}) {
  const t = useTranslations('common');

  return (
    <footer className="mt-16 border-t border-line bg-paper-deep">
      {/* pb clears the fixed mobile tab bar so footer links stay tappable */}
      <div className="mx-auto max-w-5xl px-4 pt-10 pb-28 md:pb-10 text-sm text-ink-soft space-y-3">
        <p className="max-w-prose italic text-ink-faint">{t('footer.lore')}</p>
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
          <Link href="/about" className="underline underline-offset-2 hover:text-ink">
            {t('footer.about')}
          </Link>
          {/* §6: quiet, persistent, never a banner or modal - link only, dark
              until HCB onboarding completes (DONATE_URL flips from null). */}
          {donateUrl && (
            <a
              href={donateUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-ink"
            >
              {t('footer.donate')}
            </a>
          )}
        </nav>
        <div className="pt-2">
          <FeedbackDialog />
        </div>
      </div>
    </footer>
  );
}
