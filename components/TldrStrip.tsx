import { useLocale, useTranslations } from 'next-intl';
import type { Bill } from '@/lib/types';

/*
 * The 5-second layer, and the reading column's lede.
 *
 * It used to be a dark card with an amber dot and its own AI chip, sitting
 * ABOVE the decoded card. In variant B it is what it always was in
 * substance: the first sentence of the decoding. So it is set in the
 * reading voice (Besley, one rung up the ladder) on paper, and the AI label
 * that used to ride here now sits in the bill header, above it and above
 * the fold at 390px — one label, at first contact, instead of two.
 *
 * The meta line stays honest and computed: reading time from the actual
 * section word count, question count from which sections exist (4 or 5).
 */

export function TldrStrip({ bill }: { bill: Bill }) {
  const t = useTranslations('bill');
  const locale = useLocale();
  const s = bill.ai_sections;
  if (!s) return null;

  const words = [s.tldr, s.what, s.who, s.why, s.cost ?? '']
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
  // Per-language reading speed, rounded up to a friendly 5s step, floor 15s
  const wpm = locale === 'es' ? 190 : 220;
  const seconds = Math.max(15, Math.ceil((words / wpm) * 60 / 5) * 5);
  const count = s.cost ? 5 : 4;

  return (
    <div className="mt-4">
      <p className="font-reading text-lg text-ink">{s.tldr}</p>
      <p className="mt-2 text-xs font-semibold text-ink-2 tabular-nums">
        {t('tldrMeta', { seconds, count })}
      </p>
    </div>
  );
}
