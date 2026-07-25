import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { FeedbackDialog } from '@/components/FeedbackDialog';
import { OravanLockup } from '@/components/brand/OravanLockup';
import { DONATE_URL } from '@/lib/site';

/*
 * THE BACK COVER.
 *
 * The footer takes the ink ground because nothing follows it: it is the one
 * place a dark mass reads as the end of the document rather than as a band
 * across it. At a squint a page changes shape exactly once for its content
 * (the green floor-vote panel, if the week earns one) and once for its
 * ending — this.
 *
 * Light type on an ink ground takes `leading-dark` + `tracking-dark`, always
 * together; `.on-dark` retunes the focus ring to paper.
 *
 * ONE SECTION, AND ONE ASK. The back cover is a single block: brand and
 * navigation, then one ruled row carrying provenance, the support link-out and
 * the correction path. The correction path used to sit on its own paper slip
 * below that row, which read as a second footer stuck on the end (owner,
 * 2026-07-24) — it is folded in now.
 *
 * Folded in, but NOT promoted: it stays a utility with no styled CTA and no
 * ground of its own, so the support link-out remains the footer's only call to
 * action. Its `#feedback` id is the anchor /citations links to, so this stays
 * the ONE intake, never a parallel one.
 *
 * Nothing here prints the sync DATE: the Stamp owns that, once per page. This
 * block carries the provenance, which the Stamp does not.
 *
 * donateUrl defaults to the real DONATE_URL constant — every real call site
 * (there is exactly one, in the root layout) renders unchanged. The prop is
 * forward-compatible test infrastructure for injecting a fixture value, since
 * this project's Playwright setup can't currently render an Oravan component
 * directly (see tests/donate.unit.spec.ts for what it verifies instead: the
 * source-level wiring, not a live render).
 */

const SITE_LINKS = [
  { href: '/why-call', key: 'nav.whyCall' },
  { href: '/about', key: 'footer.about' },
  { href: '/partners', key: 'footer.partners' },
  { href: '/embeds', key: 'footer.embeds' },
] as const;

const TRUST_LINKS = [
  { href: '/privacy', key: 'footer.privacy' },
  { href: '/terms', key: 'footer.terms' },
  { href: '/citations', key: 'footer.citations' },
] as const;

export function Footer({ donateUrl = DONATE_URL }: { donateUrl?: string | null } = {}) {
  const t = useTranslations('common');

  const linkClass =
    'inline-flex min-h-11 items-center text-paper underline decoration-go-bright underline-offset-4 hover:text-go-bright';

  return (
    <footer className="on-dark mt-16 bg-ink-deep text-ink-pale">
      {/* pb clears the fixed thumb bar so footer links stay tappable on phones */}
      <div className="mx-auto max-w-5xl px-4 pt-8 pb-16 text-sm leading-dark tracking-dark md:pt-12 md:pb-12">
        <div className="grid gap-8 md:grid-cols-[2fr_1fr_1fr]">
          <div>
            <OravanLockup markRem={1.5} className="text-paper" />
            {/* One paragraph, not two: the name's origin ("lore") moved to the
                About page, where someone is actually asking what Oravan is —
                it was ~120px of brand poetry on the tail of all ~1,000 pages. */}
            <p className="mt-4 max-w-note">{t('footer.mission')}</p>
          </div>

          {/* One landmark, two columns: a screen reader hears a single footer
              navigation, sighted readers get the site / trust split. */}
          <nav
            aria-label={t('footer.navLabel')}
            className="grid grid-cols-2 gap-8 md:col-span-2"
          >
            <div>
              <h2 className="text-xs font-bold tracking-[0.08em] text-paper uppercase">
                {t('footer.colSite')}
              </h2>
              <ul className="mt-2 grid">
                {SITE_LINKS.map(({ href, key }) => (
                  <li key={href}>
                    <Link href={href} className={linkClass}>
                      {t(key)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="text-xs font-bold tracking-[0.08em] text-paper uppercase">
                {t('footer.colTrust')}
              </h2>
              <ul className="mt-2 grid">
                {TRUST_LINKS.map(({ href, key }) => (
                  <li key={href}>
                    <Link href={href} className={linkClass}>
                      {t(key)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        </div>

        {/* Provenance, the AI note, and the ONE ask. The funding line upgrades
            itself the moment DONATE_URL is set — one constant, no second flag —
            and it never claims tax-deductibility or nonprofit status. Link-out
            only: never an iframe, never a payment field on Oravan's infra. */}
        <div className="mt-8 grid gap-6 border-t border-ink-pale/20 pt-6 text-xs md:grid-cols-[1fr_auto] md:items-center">
          <div className="max-w-note space-y-2">
            <p>{t('footer.sourceNote')}</p>
            <p>{t('footer.aiNote')}</p>
            <p>{donateUrl ? t('footer.fundingLive') : t('footer.funding')}</p>
          </div>
          {donateUrl && (
            <a
              href={donateUrl}
              target="_blank"
              rel="noopener noreferrer"
              /* No `ring-gap` here: that mechanism is for FILLED controls,
                 where the ring must not touch the fill. This one is an outline
                 button whose border is already the ring's own colour, so
                 swapping the border to the gap tone would make the focused
                 state look exactly like the resting state. Keeping the default
                 2px offset draws an ink gap between the white border and the
                 white ring — a visibly doubled edge. */
              className="inline-flex min-h-12 items-center justify-center justify-self-start rounded-control border-2 border-paper px-5 text-md font-bold text-paper no-underline hover:bg-paper hover:text-ink-deep"
            >
              {t('footer.fundingCta')}
            </a>
          )}

          {/* The correction path, folded INTO this block rather than sitting on
              its own paper slip below it (owner, 2026-07-24: the back cover is
              one section, not two). It stays a UTILITY, not a second ask — no
              styled CTA, no ground of its own — so the support link-out above
              is still the footer's only call to action. The dialog itself is
              paper and now carries its own focus tones, so it survives being
              triggered from this ink ground.

              `#feedback` is the correction anchor /citations links to. It must
              travel with this block: it is the ONE intake, never a parallel. */}
          <div
            id="feedback"
            className="flex scroll-mt-20 flex-wrap items-center gap-x-3 gap-y-2 md:col-span-2"
          >
            <p className="max-w-note">{t('footer.corrections')}</p>
            <FeedbackDialog />
          </div>
        </div>
      </div>
    </footer>
  );
}
