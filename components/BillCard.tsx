import { useTranslations, useFormatter } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { BillTeaser } from '@/lib/types';

export function BillCard({ bill }: { bill: BillTeaser }) {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <Link
      href={`/bills/${bill.slug}`}
      className="group block rounded-card border border-line bg-surface p-5 shadow-lift transition-transform hover:-translate-y-0.5"
    >
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        <span className="font-mono normal-case">{bill.identifier}</span>
        <span aria-hidden>·</span>
        <span>{t(`bills.status.${bill.status}`)}</span>
      </div>
      <h3 className="mt-2 font-display text-lg font-semibold leading-snug group-hover:underline underline-offset-2">
        {bill.headline ?? bill.title}
      </h3>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
        {bill.tags.slice(0, 2).map((tag) => (
          <span key={tag} className="rounded-full bg-booth-soft px-2.5 py-1 font-medium text-ink">
            {t(`categories.${tag}`)}
          </span>
        ))}
        {bill.lastActionDate && (
          <span className="text-ink-faint">
            {t('bills.updated', {
              date: format.dateTime(new Date(bill.lastActionDate), { month: 'short', day: 'numeric' }),
            })}
          </span>
        )}
      </div>
    </Link>
  );
}
