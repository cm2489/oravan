import { useTranslations } from 'next-intl';

/**
 * Renders in the rep grid, in the House-member slot, when a district's seat
 * currently has no occupant (S24 groundwork,
 * docs/ideation/2026-07-05-build-gtm-strategy.md §9.1(f) — GovTrack's
 * plain-vacancy pattern). Never shows the departed member and never invents
 * an "election pending" claim: a seat can be vacant with no successor
 * scheduled at all (the FL-20 case, whose new map eliminates the district
 * outright) — this says the one true thing and stops.
 *
 * It is the same card silhouette as RepCard, minus the dial: a vacancy is a
 * fact about this district, not a failure, so it takes no alert tone and no
 * amber. It carries no green either, because there is nothing here to press.
 * The heading is an h3 so it sits at the same outline level as the rep names
 * beside it rather than dropping out of the document outline entirely.
 */
export function VacantSeatCard() {
  const t = useTranslations('reps');
  return (
    <article className="rounded-control border-[1.5px] border-line-strong bg-paper p-5">
      <h3 className="text-xl font-extrabold">{t('vacantSeat')}</h3>
      <p className="mt-2 text-sm text-ink-2">{t('vacantSeatBody')}</p>
      <a
        href="https://www.house.gov/representatives/find-your-representative"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-ink underline underline-offset-2"
      >
        {t('vacantSeatLink')}
      </a>
    </article>
  );
}
