import type { Metadata } from 'next';
import { PhoneCall, MapPin, FileText, MessageSquareText, Voicemail, ShieldCheck, ArrowRight } from 'lucide-react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { JsonLd } from '@/components/JsonLd';
import { ZipForm } from '@/components/ZipForm';
import { BillCard } from '@/components/BillCard';
import { CallWalkthrough } from '@/components/call-walkthrough/CallWalkthrough';
import { NewsLens } from '@/components/NewsLens';
import { StalenessNote } from '@/components/StalenessNote';
import { UrgencyEmptyState } from '@/components/UrgencyEmptyState';
import { billSlug, getAllBills, getNewsBills, getTopActions, hasActNow } from '@/lib/core';
import { formatCitation } from '@/lib/format';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { buildSiteJsonLd } from '@/lib/jsonld';
import { getLiveMoments } from '@/lib/moments';
import { momentDek } from '@/lib/moments-ui';
import { DONATE_URL, SITE_ORIGIN } from '@/lib/site';

const STEPS = [
  { icon: MapPin, key: 1 },
  { icon: FileText, key: 2 },
  { icon: MessageSquareText, key: 3 },
  { icon: Voicemail, key: 4 },
] as const;

// Homepage had zero metadata override before this pass — no canonical, no
// hreflang alternates — so every locale's title/description fell through to
// the root layout's generic default, silently, and only the bill detail page
// (PR #30) had any alternates at all. Returning only `alternates` here lets
// the layout's title/description keep flowing through unchanged.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  // S21: the "what moved this week" feed (lib/core/feed.ts) mirrors this
  // page's own "Act now" section, so the RSS discovery link lives here —
  // one <link rel="alternate" type="application/rss+xml"> per locale,
  // pointing at that locale's own static feed route
  // (app/feed/whats-moving.xml or app/es/feed/whats-moving.xml).
  const feedPath = locale === 'es' ? '/es/feed/whats-moving.xml' : '/feed/whats-moving.xml';
  return {
    alternates: {
      ...hreflangAlternates(locale, '/'),
      types: { 'application/rss+xml': `${SITE_ORIGIN}${feedPath}` },
    },
  };
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('home');
  const top = getTopActions(4, locale);
  const news = getNewsBills(locale, 6);
  const total = getAllBills().length;
  const freshness = getFreshness();
  const dataAsOf = await dataAsOfString(locale);
  // AE3: the quiet-week claim keys on the floor alone. In the rare state
  // where a bill clears the floor but isn't decoded yet, the shortlist is
  // empty AND the week is not quiet — render neither cards nor a false
  // claim; /bills (linked in this section) shows it under "Act now".
  const quiet = !hasActNow();
  const jsonLd = await buildSiteJsonLd(locale);
  // Small, conservative homepage strip (spec §4.2) — only when a live
  // Moment exists, so a quiet moments week shows nothing rather than a
  // stale-feeling empty band. Never touches the "Worth a call" section
  // above it; this renders strictly after it.
  const liveMoments = getLiveMoments();

  return (
    <div>
      <JsonLd id="site-jsonld" data={jsonLd} />
      {/* Hero */}
      <section className="bg-night text-paper">
        <div className="mx-auto max-w-5xl px-4 py-16 md:py-24 grid gap-10 md:grid-cols-[3fr_2fr] md:items-center">
          <div className="min-w-0">
            <h1 className="font-display text-4xl md:text-6xl font-bold leading-[1.05] tracking-tight">
              {t('heroTitle')}
            </h1>
            <p className="mt-5 max-w-prose text-lg text-paper/85">{t('heroSub')}</p>
            {/* Thumb-reachable language switch (2026-07 critique round 2):
                the header pill sits in the least reachable corner on mobile,
                and the one control a Spanish-dominant visitor needs most
                shouldn't. The link text is in the TARGET language — the EN
                page says "Ver en español" — hence lang/hreflang on the link,
                not the page. Complements the header pill, never replaces it. */}
            <Link
              href="/"
              locale={locale === 'es' ? 'en' : 'es'}
              lang={locale === 'es' ? 'en' : 'es'}
              hrefLang={locale === 'es' ? 'en' : 'es'}
              className="mt-4 inline-flex min-h-11 items-center gap-1.5 font-semibold text-paper underline underline-offset-4 hover:text-brass-bright"
            >
              {t('heroLocaleLink')}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
          <div className="min-w-0 rounded-card bg-paper p-6 text-ink shadow-lift">
            <ZipForm />
            {/* The funnel's other entry point: someone who already knows why
                they're here shouldn't have to scroll past the ZIP card to
                find it. Same page, no navigation - just a jump to the
                callable bills below. */}
            <a
              href="#top-actions"
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-ink-soft underline underline-offset-4 hover:text-ink"
            >
              {t('heroJump')}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </a>
          </div>
        </div>
      </section>

      {/* In the news - coverage-led discovery leads the first impression */}
      {news.length > 0 && (
        <section className="mx-auto max-w-5xl px-4 pt-14">
          <NewsLens bills={news} />
        </section>
      )}

      {/* Top actions */}
      <section className="mx-auto max-w-5xl px-4 py-14" aria-labelledby="top-actions">
        <div>
          <h2 id="top-actions" className="font-display text-3xl font-bold">
            {t('topTitle')}
          </h2>
          <p className="mt-1 text-ink-soft">{t('topSub')}</p>
          {/* R2: the client-side stale caveat continues the stamp's own
              sentence — one line, one date; renders nothing while fresh */}
          <p className="mt-1 max-w-prose text-xs text-ink-faint">
            {dataAsOf}
            <StalenessNote checkedAt={freshness.checkedAt} />
          </p>
        </div>
        {top.length > 0 ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {top.map((b) => (
              <BillCard
                key={billSlug(b)}
                bill={{
                  slug: billSlug(b),
                  identifier: formatCitation(b.bill_type, b.bill_number),
                  headline: b.ai_headline,
                  title: b.short_title ?? b.title,
                  status: b.status,
                  tags: b.issue_tags ?? [],
                  lastActionDate: b.last_action_date,
                }}
              />
            ))}
          </div>
        ) : quiet ? (
          <div className="mt-6">
            <UrgencyEmptyState {...freshness} />
          </div>
        ) : null}
        {/* The section closes with its exit (2026-07 critique round 2): a
            full-width row under the grid, not a link floating beside the
            intro where it reads as decoration — and odd card counts never
            end the band on a visible hole. */}
        <Link
          href="/bills"
          className="mt-4 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-control border-2 border-ink/15 bg-surface px-4 py-3 font-semibold hover:border-ink/40"
        >
          {t('seeAll', { count: total })}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </section>

      {/* Moments strip — small, conservative, homepage-shared-surface band
          (spec §4.2). Sits after "Worth a call," never displacing it, and
          disappears entirely when no Moment currently reads as live. */}
      {liveMoments.length > 0 && (
        <section className="mx-auto max-w-5xl px-4 pb-14" aria-labelledby="moments-strip-title">
          <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-line pt-10">
            <h2 id="moments-strip-title" className="font-display text-2xl font-bold">
              {t('momentsTitle')}
            </h2>
            <Link
              href="/moments"
              className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold underline underline-offset-4"
            >
              {t('momentsCta')}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
          <p className="mt-1 max-w-prose text-sm text-ink-soft">{t('momentsSub')}</p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {liveMoments.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/moments/${m.id}`}
                  className="block rounded-control border border-line bg-surface p-4 transition-colors hover:border-ink/40"
                >
                  <p className="font-display font-semibold">{locale === 'es' ? m.name.es : m.name.en}</p>
                  <p className="mt-1 text-sm text-ink-soft">
                    {momentDek(locale === 'es' ? m.summary.es : m.summary.en)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* See how a call works - the bills above lead here; the demo de-risks
          the ask before the informational sections make the fuller case */}
      <section className="mx-auto max-w-5xl px-4 pb-14" aria-labelledby="walkthrough-title">
        <h2 id="walkthrough-title" className="font-display text-3xl font-bold">
          {t('walkthroughTitle')}
        </h2>
        <p className="mt-1 max-w-prose text-ink-soft">{t('walkthroughSub')}</p>
        <div className="mt-8">
          <CallWalkthrough />
        </div>
      </section>

      {/* How it works */}
      <section className="bg-paper-deep border-y border-line" aria-labelledby="how">
        <div className="mx-auto max-w-5xl px-4 py-14">
          <h2 id="how" className="font-display text-3xl font-bold">
            {t('howTitle')}
          </h2>
          <ol className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map(({ icon: Icon, key }, i) => (
              <li key={key} className="relative">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brass text-paper font-display font-bold">
                    {i + 1}
                  </span>
                  <Icon className="h-5 w-5 text-ink-soft" aria-hidden />
                </div>
                <h3 className="mt-3 font-display text-lg font-semibold">{t(`how${key}Title`)}</h3>
                <p className="mt-1 text-sm text-ink-soft">{t(`how${key}Body`)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Why call: the persuasion moment gets the card; privacy reads as a quiet pledge */}
      <section className="mx-auto max-w-5xl px-4 py-14 grid gap-10 md:grid-cols-[3fr_2fr] md:items-start">
        <div className="rounded-card bg-night p-8 text-paper shadow-lift">
          <PhoneCall className="h-6 w-6 text-brass-bright" aria-hidden />
          <h2 className="mt-3 font-display text-3xl font-bold">{t('whyTitle')}</h2>
          <p className="mt-2 text-paper/85">{t('whyBody')}</p>
          <Link
            href="/why-call"
            className="mt-5 inline-flex items-center gap-1.5 rounded-control bg-brass px-5 py-3 font-semibold text-paper hover:bg-brass-deep"
          >
            {t('whyCta')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
        <div className="border-t-2 border-moss pt-5 md:border-t-0 md:border-l-0 md:pt-1">
          <ShieldCheck className="h-6 w-6 text-moss" aria-hidden />
          <h2 className="mt-3 font-display text-2xl font-bold">{t('privacyTitle')}</h2>
          <p className="mt-2 text-ink-soft">{t('privacyBody')}</p>
          <Link
            href="/privacy"
            className="mt-4 inline-flex items-center gap-1.5 font-semibold underline underline-offset-4"
          >
            {t('privacyCta')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </section>

      {/* §6 support band — gated on the same DONATE_URL constant as every
          donate affordance (setting it back to null darkens all of them at
          once). Link-out only, never a payment field here; copy leads with
          the no-tracking mission, and the not-tax-deductible line is the
          required truthful framing. Note color is ink-soft, not ink-faint:
          ink-faint is only 4.33:1 on paper-deep — below AA. */}
      {DONATE_URL && (
        <section className="bg-paper-deep border-t border-line" aria-labelledby="support-title">
          <div className="mx-auto max-w-5xl px-4 py-12 flex flex-wrap items-center justify-between gap-8">
            <div className="max-w-prose">
              <h2 id="support-title" className="font-display text-3xl font-bold">
                {t('supportTitle')}
              </h2>
              <p className="mt-2 text-ink-soft">{t('supportBody')}</p>
            </div>
            <div>
              <a
                href={DONATE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-control bg-brass px-5 py-3 font-semibold text-paper hover:bg-brass-deep"
              >
                {t('supportCta')}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
              <p className="mt-2 text-sm text-ink-soft">{t('supportNote')}</p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
