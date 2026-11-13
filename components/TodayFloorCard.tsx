import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Chip } from '@/components/system';
import type { BriefScheduleItem } from '@/lib/today';

/*
 * ONE FLOOR NOTICE ON /today, as a card (owner, 2026-09-29: "The actual
 * Today page needs to have cards similar to the bills page and if there is a
 * vote this week scheduled it needs to have a yellow tag or something that
 * explicitly draws attention to it").
 *
 * TOP TO BOTTOM: the tag (lib/today.ts `floorTagFor` decides it, this card
 * only prints it), the headline as a link to the bill's page — its decoded
 * answer, one click away — the chamber's own sentence quoted in English
 * (ruling V4, `lang="en"`), the source and dates, and the official record.
 *
 * THE TAG NAMES THE NOTICE, NEVER A VOTE (page 1, rule 6). Its words are the
 * bill page's own approved floor-schedule strings, with the date of the
 * meeting the notice covers. Yellow is the system `Chip`'s `urgent` tone,
 * whose type will not build it without a printed date.
 *
 * A LINK INSIDE THE CARD, never a whole-card link (the MomentVehicleCard
 * rule): the card carries a second link, to the record, and a card-sized link
 * would swallow it. Server-rendered; it imports only a type from lib/today.
 */

const LINK =
  'font-semibold text-ink underline underline-offset-4 visited:text-ink-2 hover:decoration-[3px]';

export function TodayFloorCard({
  item,
  meta,
  tagDate,
}: {
  item: BriefScheduleItem;
  /** The source · published · covers line, already localized. */
  meta: ReactNode;
  /** `item.tag.dateIso`, formatted in the reader's locale; null for none. */
  tagDate: string | null;
}) {
  const t = useTranslations();
  const tag = item.tag;
  const tagLabel = tag ? t(tag.key) : null;
  const tagDateText = tag && tagDate ? (tag.week ? t('today.tagWeekOf', { date: tagDate }) : tagDate) : null;
  const headline = item.teaser?.headline ?? null;

  return (
    <article
      className="flex h-full flex-col rounded-control border border-line-strong bg-paper p-5"
      data-floor-card={item.citation}
    >
      {tag && tagLabel && (
        <p className="mb-3" data-floor-tag={item.certainty} data-floor-tone={tag.tone}>
          {tag.tone === 'urgent' && tagDateText ? (
            <Chip tone="urgent" dateLabel={tagDateText} className="max-w-full flex-wrap">
              {tagLabel}
            </Chip>
          ) : (
            <Chip tone="status" className="max-w-full flex-wrap">
              {tagLabel}
              {tagDateText && (
                <>
                  <span aria-hidden> ·</span> <span className="tabular-nums">{tagDateText}</span>
                </>
              )}
            </Chip>
          )}
        </p>
      )}
      <p className="text-xs leading-tight font-bold tracking-[0.06em] text-ink-2 uppercase">
        <span className="tabular-nums normal-case">{item.citation}</span>
      </p>
      <h3 className="mt-1 text-lg leading-tight font-bold text-ink">
        <Link
          href={item.href}
          className="inline-flex min-h-11 items-center underline hover:decoration-[3px]"
        >
          {headline ?? (
            <span lang="en">{item.kind === 'bill' ? (item.teaser?.title ?? item.citation) : item.citation}</span>
          )}
        </Link>
      </h3>
      <blockquote className="mt-2 border-l-[3px] border-line-strong pl-3 text-md text-ink">
        <span lang="en">“{item.quote}”</span>
      </blockquote>
      <p className="mt-2 text-xs text-ink-2 tabular-nums">{meta}</p>
      <p className="mt-auto pt-2">
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex min-h-11 items-center gap-1.5 text-sm ${LINK}`}
        >
          {t('home.evidenceLink')}
          <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
        </a>
      </p>
    </article>
  );
}
