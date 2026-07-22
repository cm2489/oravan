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
      <span aria-hidden className="mt-2 h-2.5 w-2.5 flex-none rounded-full bg-brass" />
      <p className="font-semibold leading-snug md:text-lg">
        {s.tldr}
        {/* AI label at FIRST contact (2026-07 critique, unanimous): this strip
            is the first AI-drafted text a reader meets; the Decoded card's
            disclaimer sits far below the mobile fold. Same wording as the
            walkthrough demo chip, per the citations page's "carries this
            label" promise. */}
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-brass-bright">
          <span className="rounded-full border border-brass-bright/60 px-2 py-0.5 text-xs font-semibold">
            {t('aiChip')}
          </span>
          {t('tldrMeta', { seconds, count })}
        </span>
      </p>
    </div>
  );
}
