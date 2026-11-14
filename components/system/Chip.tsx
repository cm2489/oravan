import type { ReactNode } from 'react';

/*
 * THE CHIP FAMILY — five tones, one shape, and a law behind each.
 *
 *   ai      The AI label at first contact. UNBOXED since 2026-08-01 (owner
 *           ruling): the filled marker holding the AI mark plus a small
 *           tracked caption, no outline — the label is a caption on the
 *           content, not a component competing with it. Still always WITH
 *           the AI content it labels, never in a footnote.
 *   urgent  The lamp (#ffc933). Spent on TWO chips, both the dated floor
 *           fact: the floor notice on Today (components/TodayFloorCard.tsx;
 *           owner, 2026-09-29: a scheduled vote "needs to have a yellow
 *           tag"), and the floor panel's date label, on the home page and on
 *           a bill page (components/system/FloorVotePanel.tsx; owner's click,
 *           2026-11-13 12:40 PM ET: "Yellow label, as on the live site").
 *           Ink text on the lamp (11.20:1), and the date is PRINTED — the
 *           type below makes `dateLabel` impossible to omit. No ink edge: it
 *           is a label, not a control, so the fill is not a boundary (the
 *           lamp is 1.16:1 on the panel's stone; docs/accessibility.md).
 *   floor   The same dated floor fact everywhere else (the Big Question
 *           cards, the nomination page). INK, in the chip's shape: page 2
 *           says status and date tags are plain text, and yellow marks only
 *           what you can act on (colour direction c, owner's pick
 *           2026-09-30); the owner's look draws it warm grey. The date is
 *           printed, as for `urgent`.
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
 * grounds do not resolve the same way — an ink ground takes `ink-pale`, the
 * stone floor panel takes `ink-2`. Pass the same ground the wrapper's
 * `on-dark` / `on-stone` class names. Every combination below is a computed
 * pass: ink-pale-on-ink 10.33 · ink-2-on-paper 7.56 · ink-2-on-stone 5.95 ·
 * paper-on-ink-2 (the AI mark) 7.56 · ink-on-lamp 11.20 · line-strong edge
 * on paper 4.24.
 *
 * GREY (the owner's pick 6, 2026-11-13): the AI mark is warm grey with cream
 * type on every ground, and the outlined status, stale and floor labels are
 * warm grey (`ink-2`) on paper and on stone. On an ink ground they keep
 * `ink-pale`, because ink-2 there would be 2.18:1.
 *
 * BILINGUAL: every string is a prop, already localized. That includes
 * `marker` — the AI mark is "AI" in English and "IA" in Spanish, so it is NOT
 * locale-invariant and must come from `messages/*.json`. This primitive never
 * calls `useTranslations`, so the two locales cannot drift apart inside it.
 */

export type ChipGround = 'paper' | 'ink' | 'stone';

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

/** Outline + text tones per ground, for the two bordered tones. */
const OUTLINE: Record<ChipGround, string> = {
  paper: 'border-ink-2 text-ink-2',
  ink: 'border-ink-pale text-ink-pale',
  stone: 'border-ink-2 text-ink-2',
};

/** The `floor` tone's outline, drawn INSIDE the chip as a 1.5px inset shadow
 *  rather than a border, so the chip keeps exactly the box of the `urgent`
 *  chip it replaces (a border would grow it 3px each way). */
const FLOOR: Record<ChipGround, string> = {
  paper: 'text-ink-2 shadow-[inset_0_0_0_1.5px_var(--color-ink-2)]',
  ink: 'text-ink-pale shadow-[inset_0_0_0_1.5px_var(--color-ink-pale)]',
  stone: 'text-ink-2 shadow-[inset_0_0_0_1.5px_var(--color-ink-2)]',
};

/** The unboxed AI caption's text tone per ground. Computed passes at 12px
 *  bold: ink-2-on-paper 7.56 · ink-pale-on-ink 10.33 · ink-2-on-stone 5.95. */
const AI_TEXT: Record<ChipGround, string> = {
  paper: 'text-ink-2',
  ink: 'text-ink-pale',
  stone: 'text-ink-2',
};

/** The AI mark: warm grey with cream type on every ground (paper on ink-2,
 *  7.56). It is a fill carrying its own text, so it needs no edge against
 *  the ground. */
const AI_MARKER: Record<ChipGround, string> = {
  paper: 'bg-ink-2 text-paper',
  ink: 'bg-ink-2 text-paper',
  stone: 'bg-ink-2 text-paper',
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
  stone: 'border-ink-2 text-ink-2',
};

/**
 * The two dated floor labels' classes, one function so they can only differ
 * in colour: the same shell, padding and type, the lamp fill for `urgent`,
 * the grey inset outline for `floor`. Exported for
 * tests/colour-states.spec.ts, which proves the two boxes match to the
 * pixel.
 */
export function datedChipClass(tone: 'urgent' | 'floor', ground: ChipGround = 'paper'): string {
  const colour = tone === 'urgent' ? 'bg-urgent text-ink' : FLOOR[ground];
  return `${SHELL} px-3 py-1 text-xs font-bold tracking-[0.04em] uppercase tabular-nums ${colour}`;
}

export function Chip(props: ChipProps) {
  const { children, ground = 'paper', className = '' } = props;

  if (props.tone === 'floor') {
    // The dated floor fact in grey: the same box, type and two spans as
    // `urgent`, so the claim reads the same on the page it links to; only
    // the colour differs (an inset outline instead of the lamp fill).
    return (
      <span className={`${datedChipClass('floor', ground)} ${className}`}>
        <span>{children}</span>
        <span className="font-extrabold">{props.dateLabel}</span>
      </span>
    );
  }

  if (props.tone === 'urgent') {
    // The lamp is a fill, so it resolves the same on every ground: ink text,
    // 11.20:1, with the date printed beside the claim.
    return (
      <span className={`${datedChipClass('urgent', ground)} ${className}`}>
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
