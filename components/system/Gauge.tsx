import type { ReactNode } from 'react';

/*
 * THE GO-MARK, used as a gauge.
 *
 * One 6px green bar capped at 3px (`rounded-stamp`), and it is used in exactly
 * two ways across the whole product. As a SEGMENT it is drawn to scale and
 * MEASURES something true — the five minutes on the homepage, a bill's
 * progress on the bill page. As a STROKE it sits under the hero's promise, at
 * the same weight and the same cap, because the promise is the thing being
 * measured (that one is a two-line CSS pseudo-element on the h1, not this
 * component).
 *
 * It never tops a card, never underlines a link, and never decorates anything
 * else. If the widths you are about to pass are not real proportions of a real
 * quantity, you do not want this component — you want a rule.
 *
 * Segment widths are computed from `value` as a share of the total, so the bar
 * cannot drift from the numbers beside it: change a duration and the drawing
 * changes with it. `spent` renders an inert leading stub in the track tone
 * (time already gone), and any remainder between the segments and `total`
 * renders as bare track — which is what makes the gauge honest rather than
 * decorative.
 *
 * A11y: the segments are a list, named by `label`. The visible per-segment
 * labels are the accessible content; when they are hidden (narrow viewports,
 * `hideLabels`) the caller MUST pass `summary`, which names the same steps in
 * one line that cannot be sliced. The bar itself is aria-hidden — it is a
 * drawing of numbers the reader already has.
 */

export interface GaugeSegment {
  /** Relative weight. Segment width = value / total. Same unit across all. */
  value: number;
  /** Visible label under the segment. Already localized by the caller. */
  label?: ReactNode;
  /** Right-aligned figure (a duration, a count). Set in tabular numerals. */
  meta?: ReactNode;
  /** Makes the segment a link — the bill page's rail steps do this. */
  href?: string;
  /** Stable key. Falls back to the index. */
  id?: string;
}

export interface GaugeProps {
  /**
   * What the gauge measures. Rendered as a visible kicker unless
   * `hideLabel` is set, and it names the list either way.
   */
  label: string;
  /** Rendered left to right. Widths are proportional to `value`. */
  segments: GaugeSegment[];
  /**
   * Quantity already consumed before the first segment, in the same unit.
   * Drawn as an inert stub in the track tone.
   */
  spent?: number;
  /**
   * The whole the track represents. Defaults to `spent` + the segment sum.
   * Pass it explicitly when the track should show unfilled remainder — that
   * remainder is the honest part.
   */
  total?: number;
  /**
   * One line naming the same steps, for viewports where the per-segment
   * labels would clip mid-glyph. REQUIRED when `hideLabels` is true.
   */
  summary?: ReactNode;
  /** Drop the per-segment labels and show `summary` instead. */
  hideLabels?: boolean;
  /** Keep `label` as the accessible name without printing it. */
  hideLabel?: boolean;
  /** Unique per page — used to wire `aria-labelledby`. */
  id: string;
  className?: string;
}

export function Gauge({
  label,
  segments,
  spent = 0,
  total,
  summary,
  hideLabels = false,
  hideLabel = false,
  id,
  className,
}: GaugeProps) {
  const segmentSum = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  // A zero-width track cannot measure anything; refuse rather than draw a lie.
  const whole = Math.max(total ?? spent + segmentSum, spent + segmentSum);
  if (whole <= 0 || segments.length === 0) return null;

  const labelId = `${id}-label`;
  const showLabels = !hideLabels;

  return (
    <div className={className}>
      {!hideLabel && (
        <p
          id={labelId}
          className="mb-2 text-xs font-bold tracking-[0.06em] text-ink-2 uppercase leading-tight"
        >
          {label}
        </p>
      )}
      <ol
        className="flex list-none gap-1"
        {...(hideLabel ? { 'aria-label': label } : { 'aria-labelledby': labelId })}
      >
        {spent > 0 && (
          <li
            aria-hidden="true"
            className="min-w-0 self-start"
            style={{ flex: `${spent} 1 0%` }}
          >
            <span className="block h-[6px] rounded-stamp bg-line" />
          </li>
        )}
        {segments.map((segment, i) => {
          const body = (
            <>
              <span className="block h-[6px] rounded-stamp bg-go" aria-hidden="true" />
              {showLabels && (segment.label || segment.meta) && (
                <span className="mt-1 flex min-h-11 items-center gap-2 overflow-hidden text-xs font-semibold text-ink-2 tabular-nums">
                  {segment.label && (
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                      {segment.label}
                    </span>
                  )}
                  {segment.meta && <span className="flex-none">{segment.meta}</span>}
                </span>
              )}
            </>
          );

          return (
            <li
              key={segment.id ?? i}
              className="min-w-0"
              style={{ flex: `${Math.max(0, segment.value)} 1 0%` }}
            >
              {segment.href ? (
                <a
                  href={segment.href}
                  className="block no-underline hover:text-go-deep hover:underline"
                >
                  {body}
                </a>
              ) : (
                body
              )}
            </li>
          );
        })}
        {whole > spent + segmentSum && (
          <li
            aria-hidden="true"
            className="min-w-0 self-start"
            style={{ flex: `${whole - spent - segmentSum} 1 0%` }}
          >
            <span className="block h-[6px] rounded-stamp bg-line" />
          </li>
        )}
      </ol>
      {summary && (
        <p className={`mt-2 text-xs text-ink-2 ${showLabels ? 'sr-only' : ''}`}>{summary}</p>
      )}
    </div>
  );
}
