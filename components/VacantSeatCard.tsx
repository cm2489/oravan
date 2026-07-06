import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * Renders in the rep grid, in the House-member slot, when a district's seat
 * currently has no occupant (S24 groundwork,
 * docs/ideation/2026-07-05-build-gtm-strategy.md §9.1(f) — GovTrack's
 * plain-vacancy pattern). Never shows the departed member and never invents
 * an "election pending" claim: a seat can be vacant with no successor
 * scheduled at all (the FL-20 case, whose new map eliminates the district
 * outright) — this says the one true thing and stops.
 */
export function VacantSeatCard() {
  const t = useTranslations('reps');
  return (
    <article className="rounded-card border border-line bg-surface p-5 shadow-lift">
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
        <div className="min-w-0">
          <p className="font-display text-lg font-bold leading-tight">{t('vacantSeat')}</p>
          <p className="mt-1 text-sm text-ink-soft">{t('vacantSeatBody')}</p>
          <a
            href="https://www.house.gov/representatives/find-your-representative"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center text-sm text-ink-soft underline underline-offset-2 hover:text-ink"
          >
            {t('vacantSeatLink')}
          </a>
        </div>
      </div>
    </article>
  );
}
