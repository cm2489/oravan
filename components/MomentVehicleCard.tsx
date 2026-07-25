import type { ReactNode } from 'react';
import { PhoneCall } from 'lucide-react';
import { useTranslations, useFormatter } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Chip } from '@/components/system';
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
 *
 * ── Variant B, and the two laws ──────────────────────────────────────────
 *
 * AMBER LIVES HERE, and only here on the browse-and-moments surfaces. A
 * moment lists a handful of vehicles at deliberately uniform weight, and the
 * one fact that genuinely separates them is whether a bill is standing on
 * the floor calendar — in the live corpus a moment's vehicles really are
 * mixed (e.g. two `floor_vote`, two `committee`), so the mark discriminates
 * instead of tiling. It is drawn with the system `Chip`, whose type makes a
 * dateless amber unbuildable, and the date printed is `last_action_date` —
 * the day the bill reached the calendar. The corpus holds NO forward-looking
 * scheduled-vote date for any bill, so the label claims only calendar
 * placement and never a scheduled vote.
 *
 * The chip also REPLACES the status label and the "last action" line for
 * that card, because all three would be restating the same field: one fact,
 * one mark.
 *
 * Uniform weight is about the question's two directions, which the `role`
 * line carries identically on every card — not about hiding a scheduling
 * fact from the reader of the card it is true about.
 *
 * GREEN is spent on the action, and on this page the vehicles ARE the
 * action: every card's CTA is the same filled `go` button, at the same
 * weight, so none of them reads as the recommended one.
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
  calendarLabel,
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
  /** "On the floor calendar", already localized. Claims placement, not a
      scheduled vote — the corpus cannot support the latter. */
  calendarLabel: string;
}) {
  const t = useTranslations();
  const format = useFormatter();

  // The gate: the status earns the mark, the printed date earns the amber.
  const onCalendar = status === 'floor_vote' && !!lastActionDate;

  // Separators ride at the END of the preceding chunk, so a wrapped line can
  // never start with a floating "·" (the /es long-status failure shape).
  const meta: { key: string; node: ReactNode }[] = [
    { key: 'id', node: <span className="tabular-nums normal-case">{identifier}</span> },
  ];
  if (!onCalendar) meta.push({ key: 'status', node: t(`bills.status.${status}`) });
  if (coverageCount != null && coverageCount > 0) {
    meta.push({ key: 'coverage', node: t('news.sources', { count: coverageCount }) });
  }

  return (
    <article className="flex flex-col rounded-control border border-line-strong bg-paper p-5">
      {onCalendar && (
        <p className="mb-3">
          <Chip
            tone="urgent"
            // date-only string => UTC, or the certifying date prints a day
            // early for every US viewer — and a printed date is the whole
            // reason this mark is allowed to be amber.
            dateLabel={format.dateTime(new Date(lastActionDate!), {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              timeZone: 'UTC',
            })}
          >
            {calendarLabel}
          </Chip>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-tight font-bold tracking-[0.06em] text-ink-2 uppercase">
        {meta.map((part, i) => (
          <span key={part.key} className="whitespace-nowrap">
            {part.node}
            {i < meta.length - 1 && <span aria-hidden> ·</span>}
          </span>
        ))}
      </div>
      <h3 className="mt-2 text-lg leading-tight font-bold text-ink">
        <Link href={`/bills/${slug}`} className="hover:underline hover:decoration-go hover:decoration-[3px]">
          {headline ?? title}
        </Link>
      </h3>
      <p className="mt-3 max-w-read border-t border-line pt-3 text-sm text-ink-2">{role}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-2">
        {tags.slice(0, 2).map((tag) => (
          <Chip key={tag} tone="tag">
            {t(`categories.${tag}`)}
          </Chip>
        ))}
        {!onCalendar && lastActionDate && (
          <span>
            {t('bills.updated', {
              date: format.dateTime(new Date(lastActionDate), {
                month: 'short',
                day: 'numeric',
                timeZone: 'UTC',
              }),
            })}
          </span>
        )}
      </div>
      <p className="mt-auto pt-5">
        <Link
          href={`/bills/${slug}`}
          className="ring-gap inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-go bg-go px-5 font-bold text-paper transition-colors hover:border-go-deep hover:bg-go-deep"
        >
          <PhoneCall className="h-4 w-4" aria-hidden />
          {ctaLabel}
        </Link>
      </p>
    </article>
  );
}
