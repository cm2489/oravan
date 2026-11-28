import { useTranslations, useFormatter } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Chip } from '@/components/system';
import type { Category } from '@/lib/taxonomy';
import type { MomentState } from '@/lib/moments';
import type { StatusLine } from '@/lib/moment-status.mjs';
import { MomentStatusLine } from '@/components/MomentStatusLine';

export interface MomentTeaser {
  id: string;
  name: string;
  dek: string;
  category: Category;
  /** Vehicle counts BY KIND, not one total. See `vehicleCountLine` below:
   *  there is no sentence that is true of a mixed moment and also short. */
  billCount: number;
  nominationCount: number;
  updatedDate: string | null;
  state: MomentState;
  /** The question-level line from the record (lib/moment-status.mjs
   *  questionStatus) — the most advanced live vehicle's, or in explainer mode
   *  the most recent finished one's. Null only when no vehicle resolves. */
  status: StatusLine | null;
}

/**
 * The /questions index card — name, dek, vehicle count, updated date (spec
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
export function MomentCard({ moment, className = '' }: { moment: MomentTeaser; className?: string }) {
  const t = useTranslations();
  const format = useFormatter();

  /*
   * THE COUNT LINE, AND WHY IT IS THREE STRINGS RATHER THAN ONE.
   *
   * `cardVehicleCount` has always read "2 bills". A moment may now carry a
   * Senate nomination as well (lib/moments.ts VEHICLE_KINDS), and on a moment
   * holding one bill and one nomination BOTH of the obvious single strings are
   * false: "2 bills" names a bill that does not exist, and "2 vehicles" is
   * jargon no reader outside this repo uses. So the mixed case gets its own
   * sentence naming both, and the two pure cases keep saying exactly what they
   * hold.
   *
   * Kind-count zero is never printed — the pure branches are the ones that
   * carry no zero at all, rather than a plural rule that has to render "0
   * nominations".
   */
  const countLine =
    moment.billCount > 0 && moment.nominationCount > 0
      ? t('moments.cardMixedCount', {
          bills: moment.billCount,
          nominations: moment.nominationCount,
        })
      : moment.nominationCount > 0
        ? t('moments.cardNominationCount', { count: moment.nominationCount })
        : t('moments.cardVehicleCount', { count: moment.billCount });

  // The status line already prints the record's date; "Updated" repeats it
  // only when the live layer recorded something newer (or there is no line).
  const updatedDate =
    moment.updatedDate && moment.updatedDate !== moment.status?.date ? moment.updatedDate : null;

  /*
   * TITLE FIRST (owner, 2026-11-28: "The Big Question title should be bigger
   * than the chip… That should not lead it should be next to the title or
   * under it and in a smaller font than the title."). The name leads, one
   * type step up (text-xl, 21px), and the topic chip sits under it, so the
   * question is the first and largest thing on the card and the topic reads
   * as a label on it. The DOM follows the same order.
   *
   * THREE ROWS ON THE LIST'S GRID (layout pass round 3, 2026-11-28). The card
   * spans three rows of the list's grid and takes them as its own
   * (`grid-rows-subgrid`): the question (name, chip, dek), the record's status
   * line, the count. So every card in a row is the same height, the status
   * rules line up across the row, and the blank a short dek leaves sits above
   * its status rule instead of as paper under a shorter box. The rows take
   * the list's 16px gap. Where subgrid is missing the card is an ordinary
   * three-row grid of its own height, its rows with no gap between them.
   */
  return (
    <Link
      href={`/questions/${moment.id}`}
      className={`group row-span-3 grid min-w-0 grid-rows-subgrid rounded-control border border-line-strong bg-paper p-5 transition-colors hover:border-ink ${className}`}
    >
      <div className="min-w-0">
        <h3 className="text-xl leading-tight font-bold text-ink group-hover:underline group-hover:decoration-go group-hover:decoration-[3px]">
          {moment.name}
        </h3>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Chip tone="tag">{t(`categories.${moment.category}`)}</Chip>
          {moment.state === 'settled' && <Chip tone="stale">{t('moments.settledBadge')}</Chip>}
          {/* No "Needs review" badge any more (owner, 2026-09-24): a lapsed
              review date is a curation reminder the watcher sends the owner,
              not a caveat on the reader's card. The card's status line below
              is re-derived from the record on every build either way. */}
        </div>
        <p className="mt-3 max-w-read text-sm text-ink-2">{moment.dek}</p>
      </div>
      {/* Where it stands, from the record — hairline above it so the AI-drafted
          dek and the record's own status never read as one passage. The date
          it prints is the record's; the "Updated" line below is the
          question's own freshness and stays. An empty row holds its place
          when the record gives no line, so the count stays on the third row. */}
      {moment.status ? (
        <MomentStatusLine line={moment.status} className="min-w-0 border-t border-line pt-3" />
      ) : (
        <div />
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-2">
        <span>
          {countLine}
          {updatedDate && <span aria-hidden>&nbsp;·</span>}
        </span>
        {updatedDate && (
          <span>
            {t('moments.cardUpdated', {
              // date-only string => format in UTC, or it reads a day early.
              // Year included: a bare "Dec 1" on a card that claims currency
              // reads as this year even when the action is months past.
              date: format.dateTime(new Date(updatedDate), {
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
