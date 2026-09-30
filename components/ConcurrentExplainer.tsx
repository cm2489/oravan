import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { glossaryTag } from '@/components/glossary-tags';
import { CRS_WAR_POWERS_REPORT, type ConcurrentReading } from '@/lib/concurrent-explainer';

/*
 * WHAT AN ADOPTED CONCURRENT RESOLUTION CAN AND CANNOT DO — printed right
 * after its line wherever that line appears: the bill page's record-only
 * panel, its Big Question vehicle card, and the member page's "Right now:"
 * line (the reading and the owner's words are in lib/concurrent-explainer.ts).
 *
 * VERSION 2 (for the owner to compare with version 1, everything visible, on
 * #368's branch `fix/adopted-both-chambers`): the general sentence stays
 * visible, and the War Powers detail folds under a neutral question.
 *   - the general sentence, with "concurrent resolution" opening its
 *     glossary entry in place;
 *   - when the official title invokes section 5(c) of the War Powers
 *     Resolution, a disclosure, "Does this bind the president?", holding what
 *     section 5(c) says, what the Supreme Court held in INS v. Chadha (1983),
 *     the Congressional Research Service's two words on it, and the report
 *     linked. It is a native <details>: it opens without JavaScript, the
 *     summary is a 44px target, and the page's other disclosures (the
 *     official text) draw the same +/– box;
 *   - the AI label, in small print (CLAUDE.md rule 4), always visible: it
 *     labels the sentence above it as much as the folded one.
 *
 * A SERVER COMPONENT. It renders GlossaryTerm, which resolves its definition
 * on the server, so no 'use client' module may import it
 * (tests/glossary.unit.spec.ts). components/SettledPanel.tsx, a client
 * component, receives it already rendered, as a prop.
 */
export function ConcurrentExplainer({
  reading,
  className = '',
}: {
  reading: ConcurrentReading;
  className?: string;
}) {
  const t = useTranslations('bill.concurrent');
  // The CRS's own words stay in English, marked so a Spanish page reads them
  // in an English voice (the record's rule: quoted, never restyled).
  const quote = (chunks: ReactNode) => <q lang="en">{chunks}</q>;
  const cite = (chunks: ReactNode) => (
    <cite lang="en" className="not-italic">
      {chunks}
    </cite>
  );

  return (
    <div
      className={`grid max-w-note gap-2 text-sm text-ink ${className}`}
      data-concurrent-explainer={reading.warPowers5c ? 'war-powers-5c' : 'general'}
    >
      <p data-concurrent-general="">{t.rich('general', { term: glossaryTag('concurrent-resolution') })}</p>
      {reading.warPowers5c && (
        <details className="group border-t border-line" data-concurrent-disclosure="">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-ink hover:underline [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden
              className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-stamp border-[1.5px] border-ink text-xs leading-none font-extrabold"
            >
              <span className="group-open:hidden">+</span>
              <span className="hidden group-open:inline">{'–'}</span>
            </span>
            {t('bindsQuestion')}
          </summary>
          <div className="grid gap-2 pb-1">
            <p data-concurrent-war-powers="">{t.rich('warPowers', { quote })}</p>
            <p className="text-ink-2">
              <a
                href={CRS_WAR_POWERS_REPORT.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-ink underline hover:decoration-[3px]"
                data-concurrent-source="crs"
              >
                <span>{t.rich('crsSource', { report: CRS_WAR_POWERS_REPORT.number, title: cite })}</span>
                <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
              </a>
            </p>
          </div>
        </details>
      )}
      <p className="text-2xs text-ink-2" data-concurrent-ai-note="">
        {t('aiNote')}
      </p>
    </div>
  );
}
