import type { ReactNode } from 'react';

/*
 * THE CHIP FAMILY — four tones, one shape, and a law behind each.
 *
 *   ai      The AI label at first contact. Ink outline, ink text, with a
 *           filled marker holding the AI mark. Always ABOVE the AI content it
 *           labels, never in a footnote.
 *   urgent  The ONLY amber in the product. One fact: a bill standing on the
 *           floor calendar. Ink text on amber (11.44:1), and the date is
 *           PRINTED — the type below makes `dateLabel` impossible to omit.
 *   stale   Data is past its claim window. INK, never amber: amber means a
 *           dated floor-calendar fact, and a staleness caveat is not one.
 *   tag     Topic and policy tags. Ink in EVERY state — rest, hover, active,
 *           visited. A topic tag never turns green, never takes `tint`, and
 *           is never category-colored. Nonpartisan by construction.
 *
 * SHAPE: 3px (`rounded-stamp`) on all four. A chip is a small mark, and small
 * marks are stamped at 3px — not because a chip is or is not interactive, but
 * because of its SCALE. See DESIGN.md, shape law.
 *
 * GROUND: `ground` names the surface the chip is standing on, because the
 * two dark grounds do not resolve the same way — an ink ground takes
 * `ink-pale`, the green enamel panel takes `go-pale`. Pass the same ground
 * the wrapper's `on-dark` / `on-go` class names. Every combination below is
 * a computed pass: paper-on-ink 17.66 · ink-pale-on-ink 10.82 ·
 * paper-on-go-deep 9.75 · go-pale-on-go-deep 6.86 · ink-on-amber 11.44 ·
 * ink-2-on-paper 7.87 · line-strong edge on paper 3.24.
 *
 * BILINGUAL: every string is a prop, already localized. That includes
 * `marker` — the AI mark is "AI" in English and "IA" in Spanish, so it is NOT
 * locale-invariant and must come from `messages/*.json`. This primitive never
 * calls `useTranslations`, so the two locales cannot drift apart inside it.
 */

export type ChipGround = 'paper' | 'ink' | 'go';

type ChipBase = {
  children: ReactNode;
  /** The surface this chip stands on. Defaults to `paper`. */
  ground?: ChipGround;
  className?: string;
};

export type ChipProps = ChipBase &
  (
    | {
        tone: 'ai';
        /**
         * The AI mark, from messages — "AI" (en) / "IA" (es). Omit only if
         * the children already carry the mark.
         */
        marker?: ReactNode;
      }
    | {
        tone: 'urgent';
        /**
         * REQUIRED. Amber without a printed date is illegal in this system,
         * so the type will not let you build one. Already formatted and
         * localized by the caller.
         */
        dateLabel: string;
      }
    | { tone: 'stale' }
    | { tone: 'tag' }
  );

const SHELL = 'inline-flex w-fit items-center gap-2 rounded-stamp leading-tight';

/** Outline + text tones per ground, for the three outlined tones. */
const OUTLINE: Record<ChipGround, string> = {
  paper: 'border-ink text-ink',
  ink: 'border-ink-pale text-ink-pale',
  go: 'border-go-pale text-go-pale',
};

/** The AI chip keeps a full-strength outline on every ground. */
const AI_OUTLINE: Record<ChipGround, string> = {
  paper: 'border-ink text-ink',
  ink: 'border-paper text-paper',
  go: 'border-paper text-paper',
};

const AI_MARKER: Record<ChipGround, string> = {
  paper: 'bg-ink text-paper',
  ink: 'bg-paper text-ink',
  go: 'bg-paper text-go-deep',
};

const TAG: Record<ChipGround, string> = {
  paper: 'border-line-strong text-ink-2',
  ink: 'border-ink-pale text-ink-pale',
  go: 'border-go-pale text-go-pale',
};

export function Chip(props: ChipProps) {
  const { children, ground = 'paper', className = '' } = props;

  if (props.tone === 'urgent') {
    // Amber is a fill, so it resolves the same on every ground: ink text,
    // 11.44:1, with the date printed beside the claim.
    return (
      <span
        className={`${SHELL} bg-urgent px-3 py-1 text-xs font-bold tracking-[0.04em] text-ink uppercase tabular-nums ${className}`}
      >
        <span>{children}</span>
        <span className="font-extrabold">{props.dateLabel}</span>
      </span>
    );
  }

  if (props.tone === 'ai') {
    return (
      <span
        className={`${SHELL} items-start border-[1.5px] px-3 py-1 text-xs font-semibold ${AI_OUTLINE[ground]} ${className}`}
      >
        {props.marker && (
          <span
            className={`flex-none rounded-stamp px-1 py-0.5 text-2xs font-extrabold tracking-[0.05em] ${AI_MARKER[ground]}`}
          >
            {props.marker}
          </span>
        )}
        <span>{children}</span>
      </span>
    );
  }

  if (props.tone === 'stale') {
    return (
      <span
        className={`${SHELL} border-[1.5px] px-3 py-1 text-xs font-bold tracking-[0.04em] uppercase ${OUTLINE[ground]} ${className}`}
      >
        {children}
      </span>
    );
  }

  return (
    <span
      className={`${SHELL} border px-3 py-1 text-sm font-semibold ${TAG[ground]} ${className}`}
    >
      {children}
    </span>
  );
}
