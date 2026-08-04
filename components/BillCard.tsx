import { useTranslations, useFormatter } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Chip } from '@/components/system';
import type { BillTeaser } from '@/lib/types';

/*
 * The bill teaser card — the browse surface's unit, also reused by the
 * homepage, /reps and the news lens. Variant B:
 *
 * SHAPE LAW. The card is hand-sized, so it is `rounded-control` (8px); the
 * topic marks inside it are small marks, so they are the system `Chip`'s 3px.
 * A chip and a card do not share a corner.
 *
 * COLOR LAW. Nothing here is green and nothing here is amber. Green means GO
 * and is spent on actions; a listing is not an action, it is a listing. Amber
 * means one dated floor-calendar fact — and on this surface it would be
 * wallpaper, not a signal: the live corpus ranks `floor_vote` bills to the
 * top, so every one of the six cards in the "Deciding now" band currently
 * carries that status (the whole top-20 by urgency does). Marking all six
 * amber makes amber mean "a card"; marking one implies the other five are not
 * on the calendar, which is false. So the fact is carried in ink by the status
 * label, exactly as the reference does for an un-featured listing, and amber
 * is left to the surfaces where it actually discriminates.
 *
 * `emphasis` keeps its original job (the "Deciding now" band's cards) and its
 * original mechanism — a 2px ink edge, never a new color.
 */
export function BillCard({
  bill,
  coverageCount,
  emphasis = false,
}: {
  bill: BillTeaser;
  coverageCount?: number;
  /** The 2px ink border the ActionPanel already owns — reserved for the
      "Deciding now" band, so "a call lands hardest here" is visible before
      it's read (2026-07 critique round 2). Never a new color, per the
      nonpartisan-palette rule. */
  emphasis?: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <Link
      href={`/bills/${bill.slug}`}
      className={`group block rounded-control bg-paper p-5 transition-colors hover:border-ink ${
        emphasis ? 'border-2 border-ink' : 'border border-line-strong'
      }`}
    >
      {/* Wrapping happens BETWEEN whole chunks, never inside one: long Spanish
          status labels ("APROBADO POR UNA CÁMARA") used to shatter this row
          mid-identifier with orphaned middots leading lines (2026-07 critique,
          verified on live /es). Separators ride at the END of the preceding
          chunk so a wrapped line can never start with a floating "·". */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-tight font-bold tracking-[0.06em] text-ink-2 uppercase">
        {/* tabular figures, not a third typeface: the system has two voices
            and `font-mono` was neither */}
        <span className="whitespace-nowrap tabular-nums normal-case">
          {bill.identifier}
          <span aria-hidden> ·</span>
        </span>
        <span className="whitespace-nowrap">
          {t(`bills.status.${bill.statusKey}`)}
          {coverageCount != null && <span aria-hidden> ·</span>}
        </span>
        {coverageCount != null && (
          <span className="whitespace-nowrap">{t('news.sources', { count: coverageCount })}</span>
        )}
      </div>
      <h3 className="mt-2 text-lg leading-tight font-bold text-ink group-hover:underline group-hover:decoration-go group-hover:decoration-[3px]">
        {bill.headline ?? bill.title}
      </h3>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-2">
        {bill.tags.slice(0, 2).map((tag) => (
          <Chip key={tag} tone="tag">
            {t(`categories.${tag}`)}
          </Chip>
        ))}
        {bill.lastActionDate && (
          <span>
            {t('bills.updated', {
              // `last_action_date` is a date-only string: render it in UTC or
              // it renders a day early for every viewer west of Greenwich
              // (the same fix components/CoverageSection.tsx already carries).
              //
              // The year is NOT optional here. 40% of the corpus last acted in
              // 2025 or earlier, and this card sits under decks that promise
              // "right now" — without a year, "Dec 1" reads as an upcoming date
              // this year rather than an action eight months past. Matches the
              // homepage's own billDate() helper (app/[locale]/page.tsx).
              date: format.dateTime(new Date(bill.lastActionDate), {
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
