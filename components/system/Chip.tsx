import type { ReactNode } from 'react';

/*
 * THE CHIP FAMILY — five tones, one shape, and a law behind each.
 *
 *   ai      The AI label at first contact. UNBOXED since 2026-08-01 (owner
 *           ruling): the filled marker holding the AI mark plus a small
 *           tracked caption, no outline — the label is a caption on the
 *           content, not a component competing with it. Still always WITH
 *           the AI content it labels, never in a footnote.
 *   urgent  The lamp (#ffc933). Spent on ONE chip: the dated floor notice
 *           on Today (components/TodayFloorCard.tsx; owner, 2026-09-29:
 *           a scheduled vote "needs to have a yellow tag"). Ink text on the
 *           lamp (11.20:1), and the date is PRINTED — the type below makes
 *           `dateLabel` impossible to omit.
 *   floor   The same dated floor fact everywhere else (the bill page's green
 *           panel, the Big Question cards, the nomination page). INK, in the
 *           chip's shape: page 2 says status and date tags are plain text,
 *           and yellow marks only what you can act on (colour direction c,
 *           owner's pick 2026-09-30). The date is printed, as for `urgent`.
 *   stale   Data is past its claim window. INK, never the lamp: a staleness
 *           caveat is not a floor fact.
 *   status  A record's derived status label (bill page credibility block,
 *           2026-09-24). INK, never amber and never green: the label comes
 *           from statusKeyFor / the floor gate, and the chip only prints it.
 *           Amber stays the floor band's; one status chip per page.
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
 * a computed pass: paper-on-ink 16.50 · ink-pale-on-ink 10.33 ·
 * paper-on-go-deep 11.32 · go-pale-on-go-deep 8.26 · ink-on-lamp 11.20 ·
 * ink-2-on-paper 7.56 · line-strong edge on paper 4.24.
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
        tone: 'urgent' | 'floor';
        /**
         * REQUIRED. A floor fact without a printed date is illegal in this
         * system, so the type will not let you build one. Already formatted
         * and localized by the caller.
         */
        dateLabel: string;
      }
    | { tone: 'stale' }
    | { tone: 'status' }
    | { tone: 'tag' }
  );

const SHELL = 'inline-flex w-fit items-center gap-2 rounded-stamp leading-tight';

/** Outline + text tones per ground, for the three outlined tones. */
const OUTLINE: Record<ChipGround, string> = {
  paper: 'border-ink text-ink',
  ink: 'border-ink-pale text-ink-pale',
  go: 'border-go-pale text-go-pale',
};

/** The unboxed AI caption's text tone per ground. Computed passes at 12px
 *  bold: ink-2-on-paper 7.56 · ink-pale-on-ink 10.33 · go-pale-on-go-deep
 *  8.26. */
const AI_TEXT: Record<ChipGround, string> = {
  paper: 'text-ink-2',
  ink: 'text-ink-pale',
  go: 'text-go-pale',
};

const AI_MARKER: Record<ChipGround, string> = {
  paper: 'bg-ink text-paper',
  ink: 'bg-paper text-ink',
  go: 'bg-paper text-go-deep',
};

/**
 * The filled AI mark on its own — for the one surface (the hero credit
 * line) whose caption is multi-line prose rather than a chip. Same colors
 * and stamp radius as the mark inside the chip, exported so the two can
 * never drift.
 */
export function AiMark({ ground = 'paper', children }: ChipBase) {
  return (
    <span
      className={`inline-flex flex-none rounded-stamp px-1 py-0.5 text-2xs font-extrabold tracking-[0.05em] ${AI_MARKER[ground]}`}
    >
      {children}
    </span>
  );
}

const TAG: Record<ChipGround, string> = {
  paper: 'border-line-strong text-ink-2',
  ink: 'border-ink-pale text-ink-pale',
  go: 'border-go-pale text-go-pale',
};

export function Chip(props: ChipProps) {
  const { children, ground = 'paper', className = '' } = props;

  if (props.tone === 'floor') {
    // The dated floor fact in ink: the outline tones of its ground, the same
    // type and the same two spans as `urgent`, so the claim reads the same
    // on the page it links to. `data-floor-chip` is how specs find it.
    return (
      <span
        data-floor-chip
        className={`${SHELL} border-[1.5px] px-3 py-1 text-xs font-bold tracking-[0.04em] uppercase tabular-nums ${OUTLINE[ground]} ${className}`}
      >
        <span>{children}</span>
        <span className="font-extrabold">{props.dateLabel}</span>
      </span>
    );
  }

  if (props.tone === 'urgent') {
    // The lamp is a fill, so it resolves the same on every ground: ink text,
    // 11.20:1, with the date printed beside the claim.
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
    // Unboxed: marker + tracked caption. items-start keeps the mark on the
    // first line when a narrow column wraps the caption.
    return (
      <span
        className={`${SHELL} items-start text-2xs font-bold tracking-[0.08em] uppercase ${AI_TEXT[ground]} ${className}`}
      >
        {props.marker && <AiMark ground={ground}>{props.marker}</AiMark>}
        <span className="pt-0.5">{children}</span>
      </span>
    );
  }

  if (props.tone === 'status') {
    // Sentence case at text-sm so it never reads as the tracked-caps `stale`
    // caveat beside it; the same ink outline, because a status is a fact
    // about the record and never a color.
    return (
      <span
        className={`${SHELL} border-[1.5px] px-3 py-1 text-sm font-bold ${OUTLINE[ground]} ${className}`}
      >
        {children}
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
