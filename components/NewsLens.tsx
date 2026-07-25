import { Newspaper } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { BillCard } from './BillCard';
import type { NewsBill } from '@/lib/types';

/*
 * The "In the news" discovery lens — bills drawing real cross-spectrum or
 * neutral coverage, surfaced first so a newcomer lands on what matters, not a
 * random niche bill. Urgency-based bands stay untouched below; one-sided
 * coverage is never boosted here (see getNewsBills).
 *
 * COLOR: everything here is ink. The outlet count used to be set in the old
 * accent; under the color law an accent that means GO cannot also mean "four
 * outlets covered this". The bill links themselves are content links, so
 * those — and only those — carry `go`.
 */
export async function NewsLens({ bills, compact = false }: { bills: NewsBill[]; compact?: boolean }) {
  if (bills.length === 0) return null;
  const t = await getTranslations('news');

  // Compact rows (2026-07 critique, majority): on /bills the full card grid
  // duplicated the homepage verbatim and pushed the page's stated purpose -
  // search and browse - screens below the fold. Rows keep the discovery lens
  // without competing with the browser above it.
  if (compact) {
    return (
      <section aria-labelledby="news">
        <div className="flex items-center gap-2">
          <Newspaper className="h-4 w-4 flex-none text-ink-2" aria-hidden />
          <h2 id="news" className="text-xl font-extrabold text-ink">
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
                <span className="whitespace-nowrap text-xs font-semibold text-ink-2 tabular-nums">
                  {t('sources', { count: b.sourceCount })}
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
      <p className="mt-2 max-w-read text-ink-2">{t('subhead')}</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {bills.map((b) => (
          <BillCard key={b.slug} bill={b} coverageCount={b.sourceCount} />
        ))}
      </div>
    </section>
  );
}
