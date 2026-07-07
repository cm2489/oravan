'use client';

import { ArrowUpRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

/*
 * §6's donations leg, isolated into its own component so the ask copy and
 * link-out live in one place: donateUrl is a plain prop, and the About
 * page's one real call site passes the DONATE_URL constant from lib/site.ts.
 * Dark by construction whenever donateUrl is null/undefined - no heading,
 * no ask copy, no link, nothing.
 *
 * The prop also doubles as forward-compatible test infrastructure for
 * injecting a fixture value - not currently exercised as a live render,
 * since this project's Playwright setup can't render a Oravan component
 * directly (see tests/donate.unit.spec.ts, which instead checks the
 * source-level wiring). tests/donate.spec.ts covers what IS live-verified:
 * today's real dark state, end to end in a browser.
 *
 * Link-out only: target="_blank" + rel="noopener noreferrer", never an
 * iframe, never a payment field rendered on Oravan's own infra.
 */
export function DonateSupport({ donateUrl }: { donateUrl: string | null }) {
  const t = useTranslations('about');
  if (!donateUrl) return null;

  return (
    <section className="mt-10 rounded-card border-2 border-ink bg-surface p-6 shadow-lift md:p-8">
      <h2 className="font-display text-2xl font-bold">{t('supportTitle')}</h2>
      <p className="mt-3 max-w-prose leading-relaxed">{t('supportBody')}</p>
      <a
        href={donateUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-5 inline-flex items-center gap-1.5 rounded-control bg-brass px-5 py-3 font-semibold text-paper hover:bg-brass-deep"
      >
        {t('donateCta')}
        <ArrowUpRight className="h-4 w-4" aria-hidden />
      </a>
    </section>
  );
}
