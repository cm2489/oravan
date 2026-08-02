import type { ReactNode } from 'react';
import type { BillStatus } from '@/lib/types';
import { floorCalendarChamber } from '@/lib/journey';
import { isSignalFresh } from '@/lib/signal-window';
import { Chip } from './Chip';

/*
 * THE FULL-BLEED GREEN ENAMEL PANEL — the product's signature move, and the
 * easiest thing in the system to get wrong.
 *
 * DATA-GATED LOUDNESS. Exactly ONE bill per page takes this panel, and only a
 * bill that earns the TRIAD can: `status === "floor_vote"`, a fresh printed
 * date, AND the record's own placed-on-calendar sentence (the same gate
 * scripts/moment-candidates.mjs `isOnFloorCalendar` applies — the status
 * alone is looser than the claim, see lib/journey.ts). Never two. A quiet
 * week has no panel at all and the page is an unbroken paper column.
 *
 * The cap is not taste, it is the entire mechanism. The corpus is HOT: 319 of
 * the 2,567 bills in `data/bills.json` carry `floor_vote` (as of the
 * 2026-08-01 sync; the corpus moves nightly — recompute, don't trust). Two
 * panels and both read as wallpaper. At a squint a page changes shape exactly
 * once, and this is that change — so if you are adding a second full-bleed
 * band anywhere on the same page, you are taking meaning away from this one.
 *
 * Use `selectFloorVoteFeature()` below to pick the one. The component gates
 * itself on status and date, but it cannot see the action text or its
 * siblings — the calendar half of the triad and the cap are the caller's to
 * hold, and that helper is how you hold them.
 *
 * ⚠️ THE DATE IS AN OPEN OWNER RULING. `data/bills.json` has no
 * forward-looking scheduled-vote date for ANY bill: `floor_vote` is derived
 * from action text like "Placed on Senate Legislative Calendar under General
 * Orders", and `last_action_date` is always in the past (0 of 319 are
 * future-dated, recomputed 2026-08-02). So "floor vote scheduled
 * Thursday" CANNOT be built from live
 * data. Pass the calendar-PLACEMENT date and a label that claims only that
 * ("On the House floor calendar"). Do not synthesize or imply a scheduled
 * vote date. See DESIGN.md.
 *
 * PARENT CONTRACT — this panel is full-bleed, so it renders full-width with
 * its own inner max-width wrapper. It must be a direct child of a FULL-WIDTH
 * section; do not put it inside `mx-auto max-w-5xl`, or it will not bleed.
 *
 * ⚠️ And it still has to live inside `section[aria-labelledby="top-actions"]`
 * — it carries a callable bill link, and the <=3-click funnel and the
 * freshness specs both read that boundary. So that section must be
 * restructured to be full-width with the `mx-auto max-w-5xl px-4` wrapper
 * INSIDE it, around its other children, rather than around the section's
 * whole contents. That is a required structural change on the home surface.
 *
 * BILINGUAL: every string is a prop, already localized. This primitive never
 * calls `useTranslations`.
 */

export interface FloorVotePanelProps {
  /** The bill's status. Anything but `floor_vote` renders nothing. */
  status: BillStatus;
  /**
   * The printed calendar date, already formatted and localized. REQUIRED —
   * amber without a printed date is illegal, and an empty string renders
   * nothing rather than a dateless panel.
   */
  dateLabel: string;
  /**
   * The claim the date supports, e.g. "On the House floor calendar". Must
   * claim only what the data supports — see the ruling note above.
   */
  calendarLabel: string;
  /** e.g. "H.R. 1234". Set in tabular numerals. */
  identifier: string;
  /** The decoded headline — plain language, not the statutory title. */
  headline: string;
  /** The bill page. */
  href: string;
  /** The action, e.g. "Read it and call". */
  ctaLabel: string;
  /** Optional meta row — tags, sponsor, last action. Rendered in `go-pale`. */
  meta?: ReactNode;
  /** Defaults to 2. Use 3 when the panel sits under a section heading. */
  headingLevel?: 2 | 3;
  /** Set when a parent needs `aria-labelledby` pointed at this headline. */
  headingId?: string;
  /**
   * Renders without the panel's own 3px border-y and with a short top
   * padding, for when a parent GREEN SLAB already carries the slab's edges —
   * the homepage week crown (2026-08-01) fuses its masthead onto this
   * panel's top. The crown is the SAME data-gated ground extended, never a
   * second one: it exists only because this panel rendered.
   */
  flush?: boolean;
  className?: string;
}

export function FloorVotePanel({
  status,
  dateLabel,
  calendarLabel,
  identifier,
  headline,
  href,
  ctaLabel,
  meta,
  headingLevel = 2,
  headingId,
  flush = false,
  className = '',
}: FloorVotePanelProps) {
  // THE GATE. Both halves are load-bearing: the status earns the loudness,
  // the printed date earns the amber.
  if (status !== 'floor_vote') return null;
  if (!dateLabel.trim()) {
    if (process.env.NODE_ENV !== 'production') {
      // Silent non-render is the correct behavior but a confusing one to
      // debug, so say why once, in dev only. No user data in this message.
      console.warn(
        `[FloorVotePanel] ${identifier}: floor_vote with no dateLabel — panel suppressed. Amber requires a printed date.`
      );
    }
    return null;
  }

  const Heading = headingLevel === 3 ? 'h3' : 'h2';

  return (
    // `on-go` retunes the focus indicator for this ground: white ring, go-deep
    // gap. The ring is never green, because the buttons here are green-filled.
    <section
      className={`on-go bg-go-deep text-paper ${
        flush ? 'pt-5 pb-8 md:pb-12' : 'border-y-[3px] border-go py-8 md:py-12'
      } ${className}`}
    >
      <div className="mx-auto grid max-w-5xl gap-3 px-4">
        <Chip tone="urgent" ground="go" dateLabel={dateLabel}>
          {calendarLabel}
        </Chip>

        {/* text-h2, one rung under the section masthead it can sit beneath
            (owner, 2026-08-01: the loudness is the ground and the amber, not
            a headline outshouting its own section title). */}
        <Heading id={headingId} className="max-w-[36ch] text-h2 font-extrabold text-paper">
          <a
            href={href}
            className="inline-flex min-h-11 items-center text-paper no-underline hover:underline hover:decoration-[3px]"
          >
            {headline}
          </a>
        </Heading>

        {/* The identifier rides the meta row, under the headline — the same
            headline → citation → meta order every plain listing uses (owner,
            2026-08-01: it sat alone above the headline before). */}
        <div className="flex flex-wrap items-center gap-4 text-sm leading-dark tracking-dark text-go-pale">
          <span className="font-semibold tabular-nums">{identifier}</span>
          {meta}
        </div>

        <div>
          {/* white fill on the enamel: `ring-gap` swaps this button's own
              border to go-deep on focus, so the white ring never touches the
              white fill. 9.75:1 at every adjacency. */}
          <a
            href={href}
            className="ring-gap inline-flex min-h-12 items-center justify-center gap-2 rounded-control border-2 border-paper bg-paper px-6 py-3 font-bold text-go-deep no-underline hover:border-tint hover:bg-tint"
          >
            {ctaLabel}
          </a>
        </div>
      </div>
    </section>
  );
}

/**
 * Picks the ONE bill that may take the panel, or null on a quiet week.
 *
 * The cap-to-one is load-bearing and no component can enforce it alone, so
 * enforce it here, at the data layer: call this once per page and render at
 * most what it returns. Ranking defaults to `urgency_score` (higher wins),
 * falling back to the most recent last-action date, then to input order.
 */
export function selectFloorVoteFeature<T extends { status: BillStatus }>(
  bills: readonly T[],
  rank: (bill: T) => number = defaultRank
): T | null {
  let best: T | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const bill of bills) {
    if (bill.status !== 'floor_vote') continue;
    // The panel asserts the bill is standing on the floor calendar *now*.
    // Past the published 14-day window that assertion stops being true, and
    // the honest quiet week is the correct output. See lib/urgency.mjs.
    if (!isSignalFresh(billDateOf(bill))) continue;
    // And the record itself must say so: `floor_vote` also covers cloture
    // motions and REJECTED motions to proceed, where "on the floor calendar"
    // would be a false claim. Only a genuine "Placed on … Calendar" sentence
    // earns the panel — the same triad the bill page's amber gate and
    // scripts/moment-candidates.mjs `isOnFloorCalendar` apply.
    if (floorCalendarChamber(billActionTextOf(bill)) === null) continue;
    const score = rank(bill);
    if (score > bestScore) {
      bestScore = score;
      best = bill;
    }
  }
  return best;
}

function billDateOf(bill: unknown): string | null {
  const b = bill as { last_action_date?: string | null; lastActionDate?: string | null };
  return b.last_action_date ?? b.lastActionDate ?? null;
}

function billActionTextOf(bill: unknown): string | null {
  const b = bill as { last_action_text?: string | null; lastActionText?: string | null };
  return b.last_action_text ?? b.lastActionText ?? null;
}

function defaultRank(bill: unknown): number {
  const b = bill as {
    urgency_score?: number;
    last_action_date?: string | null;
    lastActionDate?: string | null;
  };
  if (typeof b.urgency_score === 'number') return b.urgency_score;
  const date = b.last_action_date ?? b.lastActionDate;
  const ms = date ? Date.parse(date) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}
