import { PhoneCall, MapPin, FileText, MessageSquareText, Voicemail, ShieldCheck, ArrowRight } from 'lucide-react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { ZipForm } from '@/components/ZipForm';
import { BillCard } from '@/components/BillCard';
import { billSlug, getAllBills, getTopActions } from '@/lib/data';
import { formatCitation } from '@/lib/format';

const STEPS = [
  { icon: MapPin, key: 1 },
  { icon: FileText, key: 2 },
  { icon: MessageSquareText, key: 3 },
  { icon: Voicemail, key: 4 },
] as const;

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('home');
  const top = getTopActions(4, locale);
  const total = getAllBills().length;

  return (
    <div>
      {/* Hero */}
      <section className="bg-night text-paper">
        <div className="mx-auto max-w-5xl px-4 py-16 md:py-24 grid gap-10 md:grid-cols-[3fr_2fr] md:items-center">
          <div className="min-w-0">
            <h1 className="font-display text-4xl md:text-6xl font-bold leading-[1.05] tracking-tight">
              {t('heroTitle')}
            </h1>
            <p className="mt-5 max-w-prose text-lg text-paper/85">{t('heroSub')}</p>
          </div>
          <div className="min-w-0 rounded-card bg-paper p-6 text-ink shadow-lift">
            <ZipForm />
          </div>
        </div>
      </section>

      {/* Top actions */}
      <section className="mx-auto max-w-5xl px-4 py-14" aria-labelledby="top-actions">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h2 id="top-actions" className="font-display text-3xl font-bold">
              {t('topTitle')}
            </h2>
            <p className="mt-1 text-ink-soft">{t('topSub')}</p>
          </div>
          <Link
            href="/bills"
            className="inline-flex items-center gap-1.5 font-semibold text-ink underline underline-offset-4 hover:text-night"
          >
            {t('seeAll', { count: total })}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
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
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-booth text-night font-display font-bold">
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
          <PhoneCall className="h-6 w-6 text-booth-bright" aria-hidden />
          <h2 className="mt-3 font-display text-3xl font-bold">{t('whyTitle')}</h2>
          <p className="mt-2 text-paper/85">{t('whyBody')}</p>
          <Link
            href="/why-call"
            className="mt-5 inline-flex items-center gap-1.5 rounded-control bg-booth px-5 py-3 font-semibold text-night hover:bg-booth-bright"
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
    </div>
  );
}
