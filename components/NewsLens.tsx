import type { ReactNode } from 'react';
import { Newspaper } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { BillCard } from './BillCard';
import { HeadlineOrTitle } from './HeadlineOrTitle';
import type { NewsCaption } from '@/lib/conversation';
import type { NewsBill } from '@/lib/types';

/*
 * The "In the news" band — bills the press corroborated this week, or that
 * congress.gov's own readers are on. Selection lives in lib/core/bills.ts's
 * getNewsBills (the conversation lamp, with #215's stored-coverage gate as the
 * fallback); this file renders it and says WHY each card is here.
 *
 * COLOR: everything here is ink. The outlet count used to be set in the old
 * accent; under the color law an accent that means GO cannot also mean "four
 * outlets covered this". The bill links themselves are content links, so
 * those — and only those — carry `go`.
 *
 * THE CAPTION IS THE HONESTY HALF, and it is built ONLY from counted facts the
 * card was selected on (lib/conversation.ts's `NewsCaption`): how many RATED
 * outlets published inside the seven-day window and which leans they carry, or
 * how many consecutive weeks congress.gov's own most-viewed list has carried
 * the bill. Nothing here is inferred, nothing is rounded, and no caption says
 * anything about what will happen next — this band is a lens on what is being
 * read and written about, never a claim about the floor.
 *
 * A CARD WITHOUT A CAPTION IS THE FALLBACK STATE, not a bug: when the lamp's
 * evidence file is missing, unreadable by this build, or has not been refreshed
 * recently enough to speak in the present tense, the band degrades to exactly
 * the selection it made before the lamp shipped and the captions DROP rather
 * than guess. The subhead changes with it, so the deck never describes a
 * selection the cards did not come from.
 */

/** The counted facts, turned into one localized sentence. The lean list uses
 *  the locale's own conjunction ("left, center, and right" · "izquierda,
 *  centro y derecha") rather than a hand-joined string. */
function captionText(
  t: Awaited<ReturnType<typeof getTranslations<'news'>>>,
  format: Awaited<ReturnType<typeof getFormatter>>,
  caption: NewsCaption
): string {
  const leans = format.list(
    caption.leans.map((lean) => t(`lean.${lean}` as 'lean.left')),
    { type: 'conjunction' }
  );
  switch (caption.kind) {
    case 'corroborated':
      return t('captionCorroborated', { count: caption.outlets, leans });
    case 'corroborated_center':
      return t('captionCorroboratedCenter', { count: caption.outlets });
    case 'most_viewed':
      return t('captionMostViewed', { weeks: caption.weeks });
    case 'most_viewed_this_week':
      // No outlet count, no lean: a most-viewed card carries at most ONE rated
      // outlet, and one outlet is never a claim this band makes (B-1). The
      // article that admitted it is evidence, not copy.
      return t('captionMostViewedThisWeek');
  }
}

export async function NewsLens({
  bills,
  compact = false,
  rows = false,
  note,
}: {
  bills: NewsBill[];
  compact?: boolean;
  /** The homepage's rows (Home option B, 2026-09-29): see below. */
  rows?: boolean;
  /** The block's one quiet AI line, from the caller (rows only). */
  note?: ReactNode;
}) {
  if (bills.length === 0) return null;
  const t = await getTranslations('news');
  const format = await getFormatter();
  // Under the lamp every selected card carries its evidence; in the fallback
  // none does. Deriving the mode from the cards themselves means the deck and
  // the cards can never disagree about which selection produced them.
  const captioned = bills.some((b) => b.caption);
  const captionOf = (b: NewsBill) => (b.caption ? captionText(t, format, b.caption) : null);

  // Compact rows (2026-07 critique, majority): on /bills the full card grid
  // duplicated the homepage verbatim and pushed the page's stated purpose -
  // search and browse - screens below the fold. Rows keep the discovery lens
  // without competing with the browser above it. No page renders them since
  // 2026-09-28, when the owner cut the band from /bills (UX inventory B05);
  // they stay so it can come back without rebuilding them.
  if (compact) {
    return (
      <section aria-labelledby="news" data-news-band="">
        {/* text-h2, not text-xl: an outside craft review (2026-08-02) caught
            this compact variant's heading rendering 21px beside 34px sibling
            h2s on /bills — same rank in the outline, same rung on the
            ladder. Compactness stays in the rows, not the heading. */}
        <div className="flex items-center gap-3">
          <Newspaper className="h-5 w-5 flex-none text-ink-2" aria-hidden />
          <h2 id="news" className="text-h2 font-extrabold text-ink">
            {t('heading')}
          </h2>
        </div>
        <ul className="mt-3 list-none border-y-[1.5px] border-line">
          {bills.map((b) => (
            <li key={b.slug} className="border-t-[1.5px] border-line first:border-t-0">
              <Link
                href={`/bills/${b.slug}`}
                className="flex min-h-11 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2.5 text-ink underline visited:text-ink-2 hover:decoration-[3px]"
              >
                <span className="whitespace-nowrap text-xs font-bold text-ink-2 tabular-nums">
                  {b.identifier}
                </span>
                <span className="font-semibold">
                  <HeadlineOrTitle headline={b.headline} title={b.title} />
                </span>
                {/* The same reason, in the same words as the homepage card —
                    a row is a card here, and it owes the reader the same
                    account of why it is on the page. */}
                <span className="text-xs font-semibold text-ink-2 tabular-nums">
                  {captionOf(b) ?? t('sources', { count: b.sourceCount })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  /*
   * THE HOMEPAGE'S ROWS (Home option B, v2 wireframe 2026-09-29): a short
   * ruled list, unboxed (card a9), each row ONE whole-row link — so none is a
   * 21px text target — carrying the reason first, then the headline, then the
   * record's metadata ("H.R. 6529 · In markup · Last action Jul 21 ·
   * Environment & energy"). The reason sits INSIDE the link on purpose: a row
   * owes the reader the same account of why it is here as the card did, and
   * tests/news.spec.ts reads it from the link's own text. The block's AI line
   * arrives from the caller as `note`, in place of the deck.
   */
  if (rows) {
    const tAll = await getTranslations();
    const day = (iso: string) =>
      format.dateTime(new Date(iso), {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        // A bare YYYY-MM-DD: formatted in UTC or it reads a day early.
        timeZone: 'UTC',
      });
    return (
      <section aria-labelledby="news" data-news-band="">
        <div className="flex items-center gap-2">
          <Newspaper className="h-5 w-5 flex-none text-ink-2" aria-hidden />
          <h2 id="news" className="text-h2 font-extrabold text-ink">
            {t('heading')}
          </h2>
        </div>
        {note}
        <ul className="mt-4 list-none border-t-[1.5px] border-line-strong md:grid md:grid-cols-3 md:gap-x-10">
          {bills.map((b) => {
            const meta = [
              b.identifier,
              tAll(`bills.status.${b.statusKey}`),
              b.lastActionDate ? tAll('bills.updated', { date: day(b.lastActionDate) }) : null,
              b.tags[0] ? tAll(`categories.${b.tags[0]}`) : null,
            ].filter(Boolean);
            return (
              <li key={b.slug} className="border-b-[1.5px] border-line-strong">
                <Link
                  href={`/bills/${b.slug}`}
                  className="group block py-4 text-ink no-underline visited:text-ink-2"
                >
                  <span className="block text-sm font-semibold text-ink-2">
                    {captionOf(b) ?? t('sources', { count: b.sourceCount })}
                  </span>
                  <h3 className="mt-1 text-lg leading-tight font-bold group-hover:underline group-hover:decoration-ink group-hover:decoration-[3px]">
                    <HeadlineOrTitle headline={b.headline} title={b.title} />
                  </h3>
                  <span className="mt-1 block text-sm text-ink-2 tabular-nums">{meta.join(' · ')}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  return (
    <section aria-labelledby="news" data-news-band="">
      <div className="flex items-center gap-2">
        <Newspaper className="h-5 w-5 flex-none text-ink-2" aria-hidden />
        <h2 id="news" className="text-h2 font-extrabold text-ink">
          {t('heading')}
        </h2>
      </div>
      <p className="mt-2 max-w-read text-ink-2">{t(captioned ? 'subheadEvidence' : 'subhead')}</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {bills.map((b) => {
          const caption = captionOf(b);
          return (
            <BillCard
              key={b.slug}
              bill={b}
              {...(caption ? { caption } : { coverageCount: b.sourceCount })}
            />
          );
        })}
      </div>
    </section>
  );
}
