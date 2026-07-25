import { useTranslations, useFormatter } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Chip } from '@/components/system';
import type { Category } from '@/lib/taxonomy';
import type { MomentState } from '@/lib/moments';

export interface MomentTeaser {
  id: string;
  name: string;
  dek: string;
  category: Category;
  vehicleCount: number;
  updatedDate: string | null;
  state: MomentState;
}

/**
 * The /moments index card — name, dek, vehicle count, updated date (spec
 * §4.2 index anatomy). Settled and stale states get a quieter pill instead
 * of the ordinary category pill's neighbor being silent about it — never a
 * lean label, never a stance (moments carry neither, per spec §3.3).
 *
 * Variant B: the card is `rounded-control` (8px, hand-sized), the marks
 * inside it are the system `Chip` at 3px. Every mark is ink — the category
 * is a TAG, and a tag is ink in every state; the lifecycle badge takes the
 * `stale` tone, which is precisely the system's "an ink outline mark for a
 * status caveat, never amber" and so is reused rather than forked. There is
 * no green and no amber on this card: a moment asks a question, and neither
 * asking nor having settled is a floor-calendar fact.
 */
export function MomentCard({ moment }: { moment: MomentTeaser }) {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <Link
      href={`/moments/${moment.id}`}
      className="group block rounded-control border border-line-strong bg-paper p-5 transition-colors hover:border-ink"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="tag">{t(`categories.${moment.category}`)}</Chip>
        {moment.state === 'settled' && <Chip tone="stale">{t('moments.settledBadge')}</Chip>}
        {moment.state === 'stale' && <Chip tone="stale">{t('moments.staleBadge')}</Chip>}
      </div>
      <h3 className="mt-3 text-lg leading-tight font-bold text-ink group-hover:underline group-hover:decoration-go group-hover:decoration-[3px]">
        {moment.name}
      </h3>
      <p className="mt-2 max-w-read text-sm text-ink-2">{moment.dek}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-2">
        <span>
          {t('moments.cardVehicleCount', { count: moment.vehicleCount })}
          {moment.updatedDate && <span aria-hidden> ·</span>}
        </span>
        {moment.updatedDate && (
          <span>
            {t('moments.cardUpdated', {
              // date-only string => format in UTC, or it reads a day early.
              // Year included: a bare "Dec 1" on a card that claims currency
              // reads as this year even when the action is months past.
              date: format.dateTime(new Date(moment.updatedDate), {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                timeZone: 'UTC',
              }),
            })}
          </span>
        )}
      </div>
    </Link>
  );
}
