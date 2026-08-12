import { GlossaryTerm } from '@/components/GlossaryTerm';
import { NOMINATION_STATUS_TERMS } from '@/lib/glossary';

/*
 * One nomination status label, glossed where the label IS a procedural term
 * (issue #181).
 *
 * WHY A COMPONENT AND NOT TWO COPIES OF A TERNARY. The label renders on two
 * surfaces — the nomination page's provenance line and a Big Question's
 * nomination card — and a status glossed on one and bare on the other is a
 * reader learning that the underline means something and then finding it does
 * not. The mapping lives once in lib/glossary.ts; this is the one renderer.
 *
 * PRE-LOCALIZED `label` IN, exactly like the `components/system` primitives:
 * the two callers already resolve `nominations.status.<status>` themselves
 * (the key is dynamic on both), so passing the string keeps this file out of
 * the translation lookup entirely and neither locale can drift.
 *
 * NOT A CHIP, and the distinction is the one that decides where a trigger is
 * allowed at all: this label is plain text inside a meta line, so wrapping it
 * in a button changes nothing about what it is. `moments.signalType.*` — the
 * one other place a status string is a term verbatim — renders INSIDE the
 * `Chip` primitive, which is a mark rather than prose, and a mark that is
 * secretly a control is a worse object than an unglossed one. That surface is
 * deliberately left for the next pass.
 */
export function NominationStatusLabel({ status, label }: { status: string; label: string }) {
  const term = NOMINATION_STATUS_TERMS[status];
  if (!term) return <>{label}</>;
  return <GlossaryTerm id={term}>{label}</GlossaryTerm>;
}
