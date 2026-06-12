import { useTranslations } from 'next-intl';
import { BillJourney } from './BillJourney';
import type { Bill } from '@/lib/types';

/*
 * C-style decoded layout: question-form subheads, cost as fact chips
 * (prose fallback), and the computed journey stepper. The TL;DR strip
 * lives above the card (TldrStrip). Falls back to legacy paragraphs for
 * bills not yet restructured.
 */

export function DecodedSections({ bill }: { bill: Bill }) {
  const t = useTranslations('bill');
  const s = bill.ai_sections;

  if (!s) {
    return (
      <div className="mt-3 max-w-prose space-y-3 leading-relaxed">
        {(bill.ai_summary ?? '').split('\n').filter(Boolean).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-prose mt-2 space-y-5">
      <section>
        <h3 className="font-display text-lg font-bold">{t('sec.what')}</h3>
        <p className="mt-1 leading-relaxed">{s.what}</p>
      </section>
      <section>
        <h3 className="font-display text-lg font-bold">{t('sec.who')}</h3>
        <p className="mt-1 leading-relaxed">{s.who}</p>
      </section>
      <section>
        <h3 className="font-display text-lg font-bold">{t('sec.why')}</h3>
        <p className="mt-1 leading-relaxed">{s.why}</p>
      </section>
      {s.cost && (
        <section>
          <h3 className="font-display text-lg font-bold">{t('sec.cost')}</h3>
          {s.costChips?.length ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {s.costChips.map((chip) => (
                <li
                  key={chip}
                  className="rounded-full border border-line bg-white px-3 py-1.5 text-sm font-semibold"
                >
                  {chip}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 leading-relaxed">{s.cost}</p>
          )}
        </section>
      )}
      <section>
        <h3 className="font-display text-lg font-bold">{t('sec.journey')}</h3>
        <BillJourney billType={bill.bill_type} status={bill.status} />
      </section>
    </div>
  );
}
