import { useTranslations } from 'next-intl';
import { Chip } from '@/components/system';
import type { Bill } from '@/lib/types';

/*
 * The decoded body: question-form subheads with their answers in the READING
 * VOICE (Besley, one rung up the ladder — a serif reads a size small at
 * Franklin's metrics). Both languages take the same voice; the questions
 * themselves are Oravan talking, so they stay in Franklin.
 *
 * The answers are always open. They are three or four short paragraphs, and
 * a disclosure that hides a two-line answer costs a click to save nothing.
 *
 * "Where does it stand?" used to live here. It now sits BELOW the reading
 * column as the status tracker, with the stamp pressed onto its foot: it
 * describes the bill's history, and the decode and the call are the job.
 */

export function DecodedSections({ bill }: { bill: Bill }) {
  const t = useTranslations('bill');
  const s = bill.ai_sections;

  if (!s) {
    return (
      <div className="mt-6 space-y-4 font-reading text-lg text-ink">
        {(bill.ai_summary ?? '').split('\n').filter(Boolean).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    );
  }

  return (
    // One bordered stack, hairline-ruled between answers — no nested cards.
    // `line-strong` is the edge (3.24:1 on paper); `line` never is.
    <div className="mt-6 divide-y-[1.5px] divide-line-strong rounded-control border-[1.5px] border-line-strong">
      <section className="p-4 md:p-5">
        <h3 className="text-md font-bold text-ink">{t('sec.what')}</h3>
        <p className="mt-2 font-reading text-lg text-ink-2">{s.what}</p>
      </section>
      <section className="p-4 md:p-5">
        <h3 className="text-md font-bold text-ink">{t('sec.who')}</h3>
        <p className="mt-2 font-reading text-lg text-ink-2">{s.who}</p>
      </section>
      <section className="p-4 md:p-5">
        <h3 className="text-md font-bold text-ink">{t('sec.why')}</h3>
        <p className="mt-2 font-reading text-lg text-ink-2">{s.why}</p>
      </section>
      {s.cost && (
        <section className="p-4 md:p-5">
          <h3 className="text-md font-bold text-ink">{t('sec.cost')}</h3>
          {s.costChips?.length ? (
            <ul className="mt-2 flex list-none flex-wrap gap-2">
              {s.costChips.map((chip) => (
                <li key={chip}>
                  <Chip tone="tag">{chip}</Chip>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 font-reading text-lg text-ink-2">{s.cost}</p>
          )}
        </section>
      )}
    </div>
  );
}
