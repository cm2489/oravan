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
 * ONE SECTION, AND ONE ASK — now geometrically, not just in markup. The
 * 2026-07-24 fold made this a single <footer> but left its GEOMETRY split:
 * an internal full-width rule between two near-equal masses, a brand column
 * 60% empty, and the actions scattered through the lower band — it still
 * READ as two stacked sections (owner, 2026-07-25). Now it is one grid: the
 * support link-out (the ask) and the feedback trigger (the utility, never
 * promoted — no ground of its own) sit together in the space under the
 * mission that the tall nav columns create anyway, and provenance compresses
 * to a one-line small-print colophon at the baseline, no rule above it. A
 * colophon reads as a section's last line; a ruled paragraph stack reads as
 * a second section.
 *
 * The `#feedback` id (the correction anchor /citations links to) travels
 * with the action pair: ONE intake, never a parallel one.
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

            {/* The one ask and the one utility, side by side in the space the
                tall nav columns create anyway (owner, 2026-07-25: the old
                layout left this column 60% empty and pushed the actions into
                what read as a second footer below a full-width rule). Support
                keeps the outline weight — the ask; feedback stays ghost — the
                utility. `#feedback` is the correction anchor /citations links
                to: ONE intake, and it travels with this pair.

                The funding line lives in the colophon below; both surfaces
                gate on the same DONATE_URL constant, no second flag. Link-out
                only: never an iframe, never a payment field on our infra. */}
            <div
              id="feedback"
              className="mt-6 flex scroll-mt-20 flex-wrap items-center gap-3"
            >
              {donateUrl && (
                <a
                  href={donateUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  /* No `ring-gap`: that mechanism is for FILLED controls. This
                     outline button's border is already the ring's colour, so
                     the default 2px offset draws the ink gap that keeps the
                     focused state visibly distinct. */
                  className="inline-flex min-h-12 items-center justify-center rounded-control border-2 border-paper px-5 text-md font-bold text-paper no-underline hover:bg-paper hover:text-ink-deep"
                >
                  {t('footer.fundingCta')}
                </a>
              )}
              <FeedbackDialog />
            </div>
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
        {/* THE COLOPHON — one small-print line, no rule above it. The old
            layout put these three facts in a paragraph stack under a
            full-width border, which split the back cover into two near-equal
            masses and read as a second footer (owner, 2026-07-25). A one-line
            colophon reads as the section's baseline instead. The `·`
            separators are decorative — each fact is its own <span>, so a
            screen reader hears three sentences, not soup. The funding line
            still upgrades itself the moment DONATE_URL is set (same constant
            as the CTA above, no second flag) and never claims
            tax-deductibility or nonprofit status. */}
        <p className="mt-10 text-xs text-ink-pale/90">
          <span>{t('footer.sourceNote')}</span>
          <span aria-hidden> · </span>
          <span>{t('footer.aiNote')}</span>
          <span aria-hidden> · </span>
          <span>{donateUrl ? t('footer.fundingLive') : t('footer.funding')}</span>
        </p>
      </div>
    </footer>
  );
}
