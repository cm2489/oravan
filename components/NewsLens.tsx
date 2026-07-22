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
          <Newspaper className="h-4 w-4 text-brass" aria-hidden />
          <h2 id="news" className="font-display text-xl font-bold">
            {t('heading')}
          </h2>
        </div>
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {bills.map((b) => (
            <li key={b.slug}>
              <Link
                href={`/bills/${b.slug}`}
                className="flex min-h-11 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2.5 hover:underline underline-offset-2"
              >
                <span className="whitespace-nowrap font-mono text-xs font-semibold text-ink-faint">{b.identifier}</span>
                <span className="font-medium leading-snug">{b.headline ?? b.title}</span>
                <span className="whitespace-nowrap text-xs font-medium text-brass">
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
        <Newspaper className="h-5 w-5 text-brass" aria-hidden />
        <h2 id="news" className="font-display text-3xl font-bold">
          {t('heading')}
        </h2>
      </div>
      <p className="mt-1 max-w-prose text-ink-soft">{t('subhead')}</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {bills.map((b) => (
          <BillCard key={b.slug} bill={b} coverageCount={b.sourceCount} />
        ))}
      </div>
    </section>
  );
}
