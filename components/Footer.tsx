import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { FeedbackDialog } from '@/components/FeedbackDialog';
import { DONATE_URL } from '@/lib/site';

/*
 * donateUrl defaults to the real DONATE_URL constant - every real call site
 * (there's exactly one, in the root layout) renders unchanged. The prop
 * exists as forward-compatible test infrastructure for injecting a fixture
 * value, since this project's Playwright setup can't currently render a
 * Oravan component directly (its .tsx JSX transform is hijacked for
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
        <nav aria-label={t('footer.navLabel')} className="flex flex-wrap gap-5 pt-2">
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
          {/* S23: reachable from every page's footer (this component IS the
              bill-page footer) - the citability/correction page a newsroom or
              librarian needs: how to cite, the AI-content policy, how to
              report an error. */}
          <Link href="/citations" className="underline underline-offset-2 hover:text-ink">
            {t('footer.citations')}
          </Link>
          {/* S16: the embeds configurator + docs - footer-only, same tier as
              Citations above (a builder/reporter surface, not primary nav). */}
          <Link href="/embeds" className="underline underline-offset-2 hover:text-ink">
            {t('footer.embeds')}
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
        {/* id is the correction-path anchor: /citations links here as "#feedback"
            rather than duplicating this dialog (one intake, not a parallel one -
            see docs/es-spotcheck-redistribution.md's sibling S23 scope note). */}
        <div id="feedback" className="pt-2 scroll-mt-20">
          <FeedbackDialog />
        </div>
      </div>
    </footer>
  );
}
