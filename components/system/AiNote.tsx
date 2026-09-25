import type { ReactNode } from 'react';
import { AI_TEXT, AiMark, type ChipGround } from './Chip';

/*
 * AI NOTE — the AI disclosure as a CAPTION: the filled AI mark, then
 * sentence-case text at `text-xs`, in the ground's secondary ink. It is the
 * hero credit line's pattern (owner pick 6C, 2026-08-01), made one primitive
 * so every surface that owes a disclosure sentence prints it the same way.
 *
 * WHY THIS EXISTS. `Chip tone="ai"` is a label voice — tracked capitals —
 * and five surfaces had been feeding it whole disclosure sentences, which
 * shipped as 5–8 lines of shouting capitals (/bills, /questions, every
 * question page, the member pages). The owner's 2026-08-01 ruling had
 * already demoted exactly that paragraph: "truth-labeling obligations
 * survive, but as captions, not components". A disclosure longer than the
 * chip's short-label budget (./ai-label.ts) renders here instead.
 *
 * THE RULE IT CARRIES (CLAUDE.md, DESIGN.md "Bilingual parity"): exactly one
 * AI label per content block, WITH the content, at first contact — never in
 * a footnote. This is a demotion of the label's FORM, never of its presence:
 * a caller swapping a Chip for an AiNote keeps the same position.
 *
 * TWO SLOTS, both optional, both already localized:
 *   label     a short first line in label weight (600) — the block's own
 *             name for the provenance ("AI-decoded"). Its own element, so a
 *             spec can find the exact string.
 *   children  the caption sentence(s), in body weight.
 * With both, they stack as two lines beside one mark (the hero's two-line
 * credit), so a label and its caveat are ONE disclosure, not two.
 *
 * GROUND: the same three grounds as Chip, resolved through Chip's own
 * AI_TEXT map (ink-2 on paper 7.87 · ink-pale on ink 10.82 · go-pale on
 * go-deep 6.86 — AA at 13px regular). On a dark ground the caption takes
 * `leading-dark tracking-dark` together, as DESIGN.md requires of light
 * copy on ink or green.
 *
 * BILINGUAL: every string is a prop, including `marker` ("AI" / "IA"). This
 * primitive never calls `useTranslations`.
 */
export type AiNoteProps = {
  /** The AI mark, from messages — "AI" (en) / "IA" (es). */
  marker: ReactNode;
  /** Optional short first line, in label weight. */
  label?: string;
  /** The caption sentence(s). */
  children?: ReactNode;
  /** The surface this note stands on. Defaults to `paper`. */
  ground?: ChipGround;
  /** Spacing and measure from the caller (`mt-*`, `max-w-read` …). */
  className?: string;
};

const DARK = 'leading-dark tracking-dark';

export function AiNote({ marker, label, children, ground = 'paper', className = '' }: AiNoteProps) {
  return (
    <p
      className={`flex items-start gap-2 text-xs text-pretty ${AI_TEXT[ground]} ${
        ground === 'paper' ? '' : DARK
      } ${className}`}
    >
      <AiMark ground={ground}>{marker}</AiMark>
      {/* pt-0.5 seats the caption's first line on the mark's own line box,
          exactly as the hero credit line does. min-w-0 lets a long word wrap
          inside a flex row instead of pushing the row wider. */}
      <span className="min-w-0 pt-0.5">
        {label && <span className="block font-semibold">{label}</span>}
        {/* The label and the caption are two LINES on screen but one run of
            text to a screen reader, which read them as "AI-decoded Verify it
            against…" with no break between. A visually hidden full stop ends
            the label as a sentence. It sits BETWEEN the two spans, never
            inside the label, so each span still holds its message verbatim
            (funnel I1 and the moments specs match them exactly). Punctuation
            only, the same in both locales, so there is no string to translate. */}
        {label && children && <span className="sr-only">. </span>}
        {children && (label ? <span className="block">{children}</span> : children)}
      </span>
    </p>
  );
}
