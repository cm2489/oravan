import { useTranslations, useFormatter } from 'next-intl';
import { Link } from '@/i18n/navigation';
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
 */
export function MomentCard({ moment }: { moment: MomentTeaser }) {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <Link
      href={`/moments/${moment.id}`}
      className="group block rounded-card border border-line bg-surface p-5 shadow-lift transition-transform hover:-translate-y-0.5"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        <span className="rounded-full bg-brass-soft px-2.5 py-1 font-medium normal-case text-ink">
          {t(`categories.${moment.category}`)}
        </span>
        {moment.state === 'settled' && (
          <span className="rounded-full bg-paper-deep px-2.5 py-1 font-medium normal-case text-ink-soft">
            {t('moments.settledBadge')}
          </span>
        )}
        {moment.state === 'stale' && (
          <span className="rounded-full bg-paper-deep px-2.5 py-1 font-medium normal-case text-ink-soft">
            {t('moments.staleBadge')}
          </span>
        )}
      </div>
      <h3 className="mt-2 font-display text-lg font-semibold leading-snug group-hover:underline underline-offset-2">
        {moment.name}
      </h3>
      <p className="mt-1.5 text-sm text-ink-soft">{moment.dek}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-faint">
        <span>{t('moments.cardVehicleCount', { count: moment.vehicleCount })}</span>
        {moment.updatedDate && (
          <>
            <span aria-hidden>·</span>
            <span>
              {t('moments.cardUpdated', {
                date: format.dateTime(new Date(moment.updatedDate), { month: 'short', day: 'numeric' }),
              })}
            </span>
          </>
        )}
      </div>
    </Link>
  );
}
