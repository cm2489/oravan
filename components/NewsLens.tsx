import { Newspaper } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { BillCard } from './BillCard';
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
    case 'most_viewed_covered':
      return t('captionMostViewedCovered', { count: caption.outlets, leans });
  }
}

export async function NewsLens({ bills, compact = false }: { bills: NewsBill[]; compact?: boolean }) {
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
  // without competing with the browser above it.
  if (compact) {
    return (
      <section aria-labelledby="news">
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
                className="flex min-h-11 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2.5 text-ink no-underline visited:text-ink-2 hover:text-go-deep hover:underline"
              >
                <span className="whitespace-nowrap text-xs font-bold text-ink-2 tabular-nums">
                  {b.identifier}
                </span>
                <span className="font-semibold">{b.headline ?? b.title}</span>
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

  return (
    <section aria-labelledby="news">
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
