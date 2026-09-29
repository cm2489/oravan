import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { SeatElections } from '@/lib/types';

/** The FEC page that lists every scheduled House special election (or "TBD"). */
const FEC_DATES_PAGE = 'https://www.fec.gov/help-candidates-and-committees/dates-and-deadlines/';

/**
 * Renders in the rep grid, in the House-member slot, when a district's seat
 * currently has no occupant (S24 groundwork,
 * the project records §9.1(f) — the established
 * plain-vacancy pattern). Never shows the departed member.
 *
 * Election dates are printed only as the FEC's calendar states them
 * (data/special-elections.json, refreshed weekly), with the day they were
 * checked and a link to the FEC. No date is ever inferred: a seat the FEC
 * lists nothing for says exactly that, and a seat the sync has not checked
 * yet (`elections` absent) says nothing about an election at all. Nothing here
 * names a member-elect — no official machine-readable source does before the
 * oath (lib/special-elections.mjs).
 *
 * It is the same card silhouette as RepCard, minus the dial: a vacancy is a
 * fact about this district, not a failure, so it takes no alert tone and no
 * amber. It carries no green either, because there is nothing here to press.
 * The heading is an h3 so it sits at the same outline level as the rep names
 * beside it rather than dropping out of the document outline entirely.
 */
export function VacantSeatCard({ href, elections }: { href?: string; elections?: SeatElections } = {}) {
  const t = useTranslations('reps');
  const format = useFormatter();
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return (
    <article className="rounded-control border-[1.5px] border-line-strong bg-paper p-5">
      {/* `href` is the seat's own page (/reps/fl-20), passed by the caller
          rather than computed here, so this card never pulls the roster JSON
          into a client bundle (ActionPanel renders it too, without a link).
          `elections` is passed the same way, for the same reason.
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
      {elections && (
        <div data-seat-elections>
          {elections.dates.length > 0 ? (
            <>
              <ul className="mt-2 text-sm text-ink">
                {elections.dates.map((e) => (
                  <li key={`${e.type}-${e.date}`} data-seat-election-date={e.date}>
                    {t('seatElectionDate', { type: e.type, date: day(e.date) })}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-sm text-ink-2">{t('seatElectionChecked', { date: day(elections.checked) })}</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-ink-2" data-seat-election-none>
              {t('seatElectionNone', { date: day(elections.checked) })}
            </p>
          )}
          <a
            href={FEC_DATES_PAGE}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-ink underline underline-offset-2"
          >
            {t('seatElectionLink')}
          </a>
        </div>
      )}
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
