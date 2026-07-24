import { PhoneCall } from 'lucide-react';
import { useTranslations, useFormatter } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { BillStatus } from '@/lib/types';

/**
 * A Moment's vehicle card — BillCard's teaser idiom (cite · status ·
 * coverage, headline link, category + updated) plus the moment-specific
 * "role" line: what a yes vote does and what a no vote does, in the data's
 * own words (spec §3.3's both-directions guarantee). The headline and the
 * "Read + call" CTA both land on the real /bills/[slug] page, where support
 * and oppose scripts are equally one tap away — this card never carries a
 * stance of its own. `ctaLabel` swaps to a neutral "Read the bill" once the
 * moment has settled (still linking to the same page, in its real, current
 * status — never implying a live vote that's already over).
 */
export function MomentVehicleCard({
  slug,
  identifier,
  headline,
  title,
  status,
  tags,
  lastActionDate,
  coverageCount,
  role,
  ctaLabel,
}: {
  slug: string;
  identifier: string;
  headline: string | null;
  title: string;
  status: BillStatus;
  tags: string[];
  lastActionDate: string | null;
  coverageCount?: number;
  /** The both-directions yes/no framing, already localized. */
  role: string;
  ctaLabel: string;
}) {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <article className="flex flex-col rounded-card border border-line bg-surface p-5 shadow-lift transition-transform hover:-translate-y-0.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        <span className="whitespace-nowrap font-mono normal-case">
          {identifier}
          <span aria-hidden> ·</span>
        </span>
        <span className="whitespace-nowrap">
          {t(`bills.status.${status}`)}
          {coverageCount != null && coverageCount > 0 && <span aria-hidden> ·</span>}
        </span>
        {coverageCount != null && coverageCount > 0 && (
          <span className="whitespace-nowrap text-brass">{t('news.sources', { count: coverageCount })}</span>
        )}
      </div>
      <h3 className="mt-2 font-display text-lg font-semibold leading-snug">
        <Link href={`/bills/${slug}`} className="hover:underline underline-offset-2">
          {headline ?? title}
        </Link>
      </h3>
      <p className="mt-3 border-t border-line pt-3 text-sm text-ink-soft">{role}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
        {tags.slice(0, 2).map((tag) => (
          <span key={tag} className="rounded-full bg-brass-soft px-2.5 py-1 font-medium text-ink">
            {t(`categories.${tag}`)}
          </span>
        ))}
        {lastActionDate && (
          <span className="text-ink-faint">
            {t('bills.updated', {
              date: format.dateTime(new Date(lastActionDate), { month: 'short', day: 'numeric' }),
            })}
          </span>
        )}
      </div>
      <p className="mt-auto pt-4">
        <Link
          href={`/bills/${slug}`}
          className="inline-flex min-h-11 items-center gap-2 rounded-control border border-brass px-4 font-semibold text-brass-deep transition-colors hover:bg-brass-soft"
        >
          <PhoneCall className="h-4 w-4" aria-hidden />
          {ctaLabel}
        </Link>
      </p>
    </article>
  );
}
