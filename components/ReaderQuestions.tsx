import { ChevronDown, ExternalLink } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { AiMark } from '@/components/system';
import { readerQuestionsFor, type ReaderClaim } from '@/lib/reader-questions';
import { rollCallPage } from '@/lib/roll-call-page';

/**
 * READER QUESTIONS — a few questions from the fixed bank
 * (data/reader-questions-bank.json), each answered from official sources,
 * as native <details> rows: they open and close with no JavaScript.
 *
 * Provenance, which the block states once at its top and once at its foot:
 * AI picks the questions from the fixed bank and they are shown in the bank's
 * own words (the bank was drafted with AI; no question is written for one
 * page); the answers are written by AI once, on the date printed, from quoted
 * official sources, and no nightly job rewrites them (data/reader-questions.json,
 * `rewritten_nightly: false`, enforced by scripts/check-reader-questions.mjs).
 * Absence lines come in two kinds: a `not_found` line (we searched the named
 * records and found none) is a checked finding and prints as a plain
 * sentence, its searched sources listed with the others; a `not_checked` line
 * is printed after "We couldn't check this." so a gap in what we checked never
 * reads as a finding.
 *
 * Renders nothing for a Big Question with no entry in the file.
 */
export async function ReaderQuestions({
  id,
  locale,
  className,
}: {
  id: string;
  locale: string;
  /** Placement classes from the page's desk (layout only, appended). */
  className?: string;
}) {
  const entry = readerQuestionsFor(id);
  if (!entry) return null;
  const t = await getTranslations({ locale, namespace: 'readerQuestions' });
  const tc = await getTranslations({ locale, namespace: 'common' });
  const format = await getFormatter({ locale });
  const lang = locale === 'es' ? 'es' : 'en';
  const written = format.dateTime(new Date(`${entry.written}T12:00:00Z`), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

  const sentence = (c: ReaderClaim, i: number) =>
    c.kind === 'absence' && c.absence_kind === 'not_checked' ? (
      <p key={i} className="max-w-read text-sm text-ink" data-rq-silent="">
        <strong className="font-bold">{t('couldntCheck')}</strong> {c[lang]}
      </p>
    ) : (
      <p key={i} className="max-w-read font-reading text-md text-ink" data-rq-not-found={c.kind === 'absence' ? '' : undefined}>
        {c[lang]}
      </p>
    );

  return (
    <section
      className={`mt-8 border-t border-line pt-4${className ? ` ${className}` : ''}`}
      aria-labelledby="reader-questions-h"
      data-reader-questions=""
    >
      <h2 id="reader-questions-h" className="text-h2 font-extrabold text-ink">
        {t('heading')}
      </h2>
      <p className="mt-3 flex max-w-read items-start gap-2 text-xs text-ink-2" data-rq-ai-label="">
        <AiMark>{tc('aiMarker')}</AiMark>
        <span className="pt-0.5">
          {t('aiLabel')}{' '}
          <Link
            href="/citations#reader-questions"
            className="font-semibold text-go underline underline-offset-4 hover:text-go-deep"
          >
            {t('howMade')}
          </Link>
        </span>
      </p>
      <p className="mt-2 max-w-note text-sm text-ink-2">{t('intro')}</p>

      <div className="mt-4 border-b border-line">
        {entry.picks.map((p) => {
          const srcIds = [
            ...new Set(p.claims.flatMap((c) => (c.kind === 'absence' ? (c.searched ?? []) : (c.cites ?? []).map((x) => x.src)))),
          ];
          return (
            <details key={p.bank_id} className="group border-t border-line" data-rq-item={p.bank_id}>
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-2 [&::-webkit-details-marker]:hidden">
                <span className="text-md leading-snug font-bold text-ink group-hover:underline">{p.q[lang]}</span>
                <ChevronDown aria-hidden className="h-5 w-5 flex-none text-ink-2 group-open:rotate-180" />
              </summary>
              <div className="grid gap-3 pb-4" data-rq-answer="">
                {p.claims.map(sentence)}
                <div className="text-sm text-ink-2">
                  <h3 className="text-2xs font-semibold tracking-[0.08em] uppercase">{t('sources')}</h3>
                  <ul className="list-none">
                    {srcIds.map((sid) => {
                      const s = entry.sources[sid];
                      return (
                        <li key={sid}>
                          {/* A roll call is stored as the data file its quote was
                              checked against; the reader lands on the chamber's
                              readable page for the same vote (lib/roll-call-page.ts,
                              tests/timeline-record-links.spec.ts). Every other
                              source is linked as stored. */}
                          <a
                            href={rollCallPage(s.url)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex min-h-11 items-center gap-1.5 text-ink-2 underline underline-offset-4 hover:text-ink"
                          >
                            <span>{s.title[lang]}</span>
                            <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </details>
          );
        })}
      </div>

      <p className="mt-3 max-w-note text-xs text-ink-2" data-rq-written="">
        {t('written', { date: written })}
      </p>
      {lang === 'es' && <p className="mt-1 max-w-note text-xs text-ink-2">{t('esQuotesNote')}</p>}
    </section>
  );
}
