import { Newspaper } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { BillCard } from './BillCard';
import type { NewsBill } from '@/lib/types';

/*
 * The "In the news" discovery lens — bills drawing real cross-spectrum or
 * neutral coverage, surfaced first so a newcomer lands on what matters, not a
 * random niche bill. Urgency-based bands stay untouched below; one-sided
 * coverage is never boosted here (see getNewsBills).
 */
export async function NewsLens({ bills }: { bills: NewsBill[] }) {
  if (bills.length === 0) return null;
  const t = await getTranslations('news');

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
