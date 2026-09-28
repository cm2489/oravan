import { useLocale, useTranslations } from 'next-intl';
import type { Bill } from '@/lib/types';
import { glossify } from '@/components/glossary-tags';
import { glossaryLocale } from '@/lib/glossary-match';
import type { GlossaryTermId } from '@/lib/glossary';

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
 *
 * GLOSSARY TERMS already in the answers open in place (owner, 2026-09-28:
 * readers "shouldn't feel dumb if they don't know something"). Each answer is
 * its own section, so a term is marked at most once per answer, and never in
 * the question headings (lib/glossary-match.ts).
 */

export function DecodedSections({ bill }: { bill: Bill }) {
  const t = useTranslations('bill');
  const lang = glossaryLocale(useLocale());
  const s = bill.ai_sections;

  if (!s) {
    // The whole summary is one section.
    const seen = new Set<GlossaryTermId>();
    return (
      <div className="mt-6 space-y-4 font-reading text-lg text-ink">
        {(bill.ai_summary ?? '').split('\n').filter(Boolean).map((p, i) => (
          <p key={i}>{glossify(p, lang, seen)}</p>
        ))}
      </div>
    );
  }

  // The cost answer is one section whether it prints as lines or a paragraph.
  const costSeen = new Set<GlossaryTermId>();

  return (
    // One bordered stack, hairline-ruled between answers — no nested cards.
    // `line-strong` is the edge (3.24:1 on paper); `line` never is.
    <div className="mt-6 divide-y-[1.5px] divide-line-strong rounded-control border-[1.5px] border-line-strong">
      <section className="p-4 md:p-5">
        <h3 className="text-md font-bold text-ink">{t('sec.what')}</h3>
        <p className="mt-2 font-reading text-lg text-ink-2">{glossify(s.what, lang, new Set())}</p>
      </section>
      <section className="p-4 md:p-5">
        <h3 className="text-md font-bold text-ink">{t('sec.who')}</h3>
        <p className="mt-2 font-reading text-lg text-ink-2">{glossify(s.who, lang, new Set())}</p>
      </section>
      <section className="p-4 md:p-5">
        <h3 className="text-md font-bold text-ink">{t('sec.why')}</h3>
        <p className="mt-2 font-reading text-lg text-ink-2">{glossify(s.why, lang, new Set())}</p>
      </section>
      {s.cost && (
        <section className="p-4 md:p-5">
          <h3 className="text-md font-bold text-ink">{t('sec.cost')}</h3>
          {s.costChips?.length ? (
            // Plain answer lines in the reading voice, not chips (B6,
            // 2026-09-24): on the bill page a chip means status, and a cost
            // is part of the answer, not a label on it.
            <ul className="mt-2 list-disc space-y-1 pl-5 font-reading text-lg text-ink-2 marker:text-ink-2">
              {s.costChips.map((chip) => (
                <li key={chip}>{glossify(chip, lang, costSeen)}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 font-reading text-lg text-ink-2">{glossify(s.cost, lang, costSeen)}</p>
          )}
        </section>
      )}
    </div>
  );
}
