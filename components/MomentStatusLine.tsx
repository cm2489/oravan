import { useTranslations, useFormatter } from 'next-intl';
import type { StatusLine } from '@/lib/moment-status.mjs';

/**
 * ONE STATUS LINE, from the record (lib/moment-status.mjs). Used on the
 * /questions card, the question page's header, and each vehicle card, so the
 * three can never phrase the same record three ways.
 *
 * Ink text, no colour: a status is a fact about the record, and the colour
 * law spends amber on exactly one dated floor fact (the vehicle card's own
 * calendar chip) and green on actions. Nothing here is AI-written, so nothing
 * here carries the AI chip — the chip over a sentence a model did not write
 * is over-labeling, which erodes the label (constitution-08).
 *
 * `recordStep` is the honest fallback: the record's latest action VERBATIM,
 * introduced as the record's own words and marked `lang="en"` because
 * Congress.gov writes in English whatever the reader's locale.
 */
export function MomentStatusLine({
  line,
  size = 'sm',
  className = '',
}: {
  line: StatusLine;
  /** `md` on the question page header, `sm` on cards. */
  size?: 'sm' | 'md';
  className?: string;
}) {
  const t = useTranslations('moments.status');
  const format = useFormatter();
  const date = line.date
    ? format.dateTime(new Date(line.date), {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        // date-only string: format in UTC or it reads a day early.
        timeZone: 'UTC',
      })
    : null;
  const text = size === 'md' ? 'text-md' : 'text-sm';

  return (
    <div className={className}>
      {line.key === 'recordStep' ? (
        line.text ? (
          <p className={`max-w-read ${text} text-ink`}>
            <span className="text-ink-2">{t('recordStepLabel')}</span>{' '}
            <q lang="en" className="font-semibold">
              {line.text}
            </q>
          </p>
        ) : (
          <p className={`max-w-read ${text} text-ink`}>{t('recordStepEmpty')}</p>
        )
      ) : (
        <p className={`max-w-read ${text} font-semibold text-ink`}>
          {t(`line.${line.key}`, {
            chamber: line.chamber ?? 'other',
            law: line.law ?? 'none',
          })}
        </p>
      )}
      {date && (
        <p className="mt-1 text-xs text-ink-2 tabular-nums">
          <time dateTime={line.date ?? undefined}>{t('latestAction', { date })}</time>
        </p>
      )}
    </div>
  );
}
