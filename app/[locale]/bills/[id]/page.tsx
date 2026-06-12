import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import { setRequestLocale, getTranslations, getFormatter } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { ActionPanel } from '@/components/ActionPanel';
import { billSlug, getAllBills, getBill } from '@/lib/data';
import { formatCitation } from '@/lib/format';

export function generateStaticParams() {
  return routing.locales.flatMap((locale) =>
    getAllBills().map((b) => ({ locale, id: billSlug(b) }))
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const bill = getBill(id);
  if (!bill) return {};
  return {
    title: `${formatCitation(bill.bill_type, bill.bill_number)} — ${bill.ai_headline ?? bill.short_title ?? bill.title}`,
    description: bill.ai_summary?.slice(0, 160),
  };
}

export default async function BillPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const bill = getBill(id);
  if (!bill) notFound();

  const t = await getTranslations();
  const format = await getFormatter();
  const fmtDate = (d: string) => format.dateTime(new Date(d), { year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink-faint">
        <span className="font-mono">{formatCitation(bill.bill_type, bill.bill_number)}</span>
        <span aria-hidden>·</span>
        <span>{t(`bills.status.${bill.status}`)}</span>
        {(bill.issue_tags ?? []).slice(0, 2).map((tag) => (
          <span key={tag} className="rounded-full bg-booth-soft px-2.5 py-1 text-xs font-medium text-ink">
            {t(`categories.${tag}`)}
          </span>
        ))}
      </p>

      <h1 className="mt-3 font-display text-3xl md:text-4xl font-bold leading-tight">
        {bill.ai_headline ?? bill.short_title ?? bill.title}
      </h1>

      {/* Decoded - the plain-language translation is the hero */}
      <section aria-labelledby="decoded" className="mt-8 rounded-card bg-paper-deep border border-line p-6 md:p-8">
        <h2 id="decoded" className="font-display text-2xl font-bold">
          {t('bill.decoded')}
        </h2>
        {bill.ai_summary ? (
          <>
            <div className="mt-3 max-w-prose space-y-3 leading-relaxed">
              {bill.ai_summary.split('\n').filter(Boolean).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
            <p className="mt-5 text-xs font-medium text-ink-soft">{t('bill.aiDisclaimer')}</p>
          </>
        ) : (
          <p className="mt-3 text-ink-soft">{t('bills.decodedPending')}</p>
        )}
      </section>

      {/* Official record */}
      <section className="mt-8 space-y-3 text-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {t('bill.officialTitle')}
        </h2>
        <p className="max-w-prose italic text-ink-soft leading-relaxed">{bill.title}</p>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 pt-2">
          {bill.introduced_date && (
            <div className="flex gap-2">
              <dt className="font-semibold">{t('bill.introduced')}:</dt>
              <dd className="text-ink-soft">{fmtDate(bill.introduced_date)}</dd>
            </div>
          )}
          {bill.last_action_date && (
            <div className="flex gap-2">
              <dt className="font-semibold">{t('bill.lastAction')}:</dt>
              <dd className="text-ink-soft">{fmtDate(bill.last_action_date)}</dd>
            </div>
          )}
        </dl>
        {bill.last_action_text && <p className="max-w-prose text-ink-soft">{bill.last_action_text}</p>}
        {bill.congress_gov_url && (
          <a
            href={bill.congress_gov_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-semibold underline underline-offset-4"
          >
            {t('bill.viewOfficial')}
            <ExternalLink className="h-4 w-4" aria-hidden />
          </a>
        )}
      </section>

      <ActionPanel
        slug={id}
        identifier={formatCitation(bill.bill_type, bill.bill_number)}
        title={bill.ai_headline ?? bill.short_title ?? bill.title}
      />
    </article>
  );
}
