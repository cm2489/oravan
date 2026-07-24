/*
 * THE STAMP — pressed onto the document, not floated beside it.
 *
 * It straddles a REAL border: the closing rule of the week's last listing on
 * the homepage, the foot of the status tracker on the bill page — the block
 * whose dates it certifies. Half the mark hangs below that rule, punching
 * through it on a paper ground, the way a date stamp lands on a filed page.
 * That overlap is the whole idea: a badge sits beside a block, a stamp
 * certifies one.
 *
 * ONCE PER PAGE, and it is the SOLE printed sync date. If a second date is
 * printed anywhere else on the page, this mark stops carrying information and
 * starts repeating something said 300px away — delete the duplicate, not the
 * stamp.
 *
 * REDUCED MOTION: the tilt is a `transform`, which is STATIC GEOMETRY, not
 * motion. `globals.css` collapses transitions and animations under
 * `prefers-reduced-motion` but deliberately leaves transforms alone, so this
 * mark looks identical with motion off. Never re-express the tilt as an
 * animation, and never gate it behind a motion query.
 *
 * PARENT CONTRACT — the component positions itself absolutely, so:
 *   1. the parent must be `relative`;
 *   2. the parent must carry the border this mark straddles (`border-b`, or
 *      the block's own closing rule);
 *   3. the parent must reserve clearance so the last line of content never
 *      collides with the mark. Roughly 48px: `pb-12`, or scope it with
 *      `[&:has([data-oravan-stamp])]:pb-12` so an unstamped block stays tight.
 *
 * `dateLabel` arrives already formatted and already localized — this primitive
 * never touches Intl and never reads a locale, so EN and ES cannot drift.
 */

export interface StampProps {
  /**
   * The certifying word, e.g. "Data as of" / "Datos al". Set in uppercase
   * with wide tracking — keep it to two or three words.
   */
  label: string;
  /** The printed date, already formatted for the active locale. */
  dateLabel: string;
  /**
   * Accessible sentence for the whole mark. The visual mark is two stacked
   * fragments, which reads as two disconnected phrases to a screen reader —
   * so the caller passes the joined sentence and the fragments are hidden.
   */
  srLabel: string;
  className?: string;
}

export function Stamp({ label, dateLabel, srLabel, className }: StampProps) {
  return (
    <span
      data-oravan-stamp=""
      className={[
        // straddles the parent's closing rule: half the mark hangs below it
        'absolute right-6 bottom-0 z-[1] translate-y-1/2 -rotate-2 origin-[100%_50%]',
        'inline-grid justify-items-center gap-0.5 whitespace-nowrap',
        'rounded-stamp border-2 border-ink-2 bg-paper px-3 py-1',
        'text-2xs font-extrabold tracking-[0.16em] text-ink-2 uppercase leading-tight',
        className ?? '',
      ]
        .join(' ')
        .trim()}
    >
      {/* the inner hairline rule — a stamp's double edge. rounded-hair, which
          is not a component radius: it rounds hairlines and focus rings only */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0.5 rounded-hair border border-ink-2"
      />
      <span className="sr-only">{srLabel}</span>
      <span aria-hidden="true">{label}</span>
      <span
        aria-hidden="true"
        className="mt-0.5 block border-t-[1.5px] border-ink-2 pt-0.5 text-xs tracking-[0.08em] tabular-nums"
      >
        {dateLabel}
      </span>
    </span>
  );
}
