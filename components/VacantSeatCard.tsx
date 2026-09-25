import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

/**
 * Renders in the rep grid, in the House-member slot, when a district's seat
 * currently has no occupant (S24 groundwork,
 * the project records §9.1(f) — the established
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
export function VacantSeatCard({ href }: { href?: string } = {}) {
  const t = useTranslations('reps');
  return (
    <article className="rounded-control border-[1.5px] border-line-strong bg-paper p-5">
      {/* `href` is the seat's own page (/reps/fl-20), passed by the caller
          rather than computed here, so this card never pulls the roster JSON
          into a client bundle (ActionPanel renders it too, without a link).
          Same hit-area rule as RepCard's name link: an ::after overlay adds a
          44px target without moving anything or widening the focus ring. */}
      <h3 className="text-xl font-extrabold">
        {href ? (
          <Link
            href={href}
            className="relative inline-block text-ink underline decoration-line-strong underline-offset-4 after:absolute after:inset-x-0 after:-inset-y-2 hover:decoration-ink"
          >
            {t('vacantSeat')}
          </Link>
        ) : (
          t('vacantSeat')
        )}
      </h3>
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
