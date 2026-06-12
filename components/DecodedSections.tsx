import { useTranslations } from 'next-intl';
import { BillJourney } from './BillJourney';
import type { Bill } from '@/lib/types';

/*
 * A-plus decoded layout: one bolded TL;DR lead, statement subheads with
 * amber markers, a conditional cost section, and the computed journey.
 * Falls back to the legacy paragraph rendering for bills not yet
 * restructured (new bills mid-pipeline, the 2 no-text bills).
 */

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-display text-lg font-bold flex items-center gap-2">
      <span aria-hidden className="h-2 w-2 rounded-[2px] bg-booth" />
      {children}
    </h3>
  );
}

export function DecodedSections({ bill }: { bill: Bill }) {
  const t = useTranslations('bill');
  const s = bill.ai_sections;

  if (!s) {
    // Legacy fallback: the original prose summary
    return (
      <div className="mt-3 max-w-prose space-y-3 leading-relaxed">
        {(bill.ai_summary ?? '').split('\n').filter(Boolean).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-prose">
      <p className="mt-3 text-lg font-bold leading-snug">{s.tldr}</p>

      <div className="mt-5 space-y-5">
        <section>
          <SectionHeading>{t('sec.what')}</SectionHeading>
          <p className="mt-1 leading-relaxed">{s.what}</p>
        </section>
        <section>
          <SectionHeading>{t('sec.who')}</SectionHeading>
          <p className="mt-1 leading-relaxed">{s.who}</p>
        </section>
        <section>
          <SectionHeading>{t('sec.why')}</SectionHeading>
          <p className="mt-1 leading-relaxed">{s.why}</p>
        </section>
        {s.cost && (
          <section>
            <SectionHeading>{t('sec.cost')}</SectionHeading>
            <p className="mt-1 leading-relaxed">{s.cost}</p>
          </section>
        )}
        <section>
          <SectionHeading>{t('sec.journey')}</SectionHeading>
          <BillJourney billType={bill.bill_type} status={bill.status} />
        </section>
      </div>
    </div>
  );
}
