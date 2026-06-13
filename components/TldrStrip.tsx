import { useLocale, useTranslations } from 'next-intl';
import type { Bill } from '@/lib/types';

/*
 * The 5-second layer: night strip, amber dot, the TL;DR sentence, and an
 * honest meta line - reading time computed from the actual section word
 * count, question count computed from which sections exist (4 or 5).
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
    <div className="mt-6 flex items-start gap-3 rounded-card bg-night p-4 text-paper md:p-5">
      <span aria-hidden className="mt-2 h-2.5 w-2.5 flex-none rounded-full bg-booth" />
      <p className="font-semibold leading-snug md:text-lg">
        {s.tldr}
        <span className="mt-1 block text-sm font-medium text-booth-bright">
          {t('tldrMeta', { seconds, count })}
        </span>
      </p>
    </div>
  );
}
