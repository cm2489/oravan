import type { ReactNode } from 'react';
import type { BillStatus } from '@/lib/types';
import { floorCalendarChamber, floorPendingChamber, type Chamber } from '@/lib/journey';
import { effectiveUrgency, isSignalFresh } from '@/lib/signal-window';
import { Chip } from './Chip';

/*
 * THE FULL-BLEED GREEN ENAMEL PANEL — the product's signature move, and the
 * easiest thing in the system to get wrong.
 *
 * DATA-GATED LOUDNESS. Exactly ONE bill per page takes this panel, and only a
 * bill that earns the TRIAD can: `status === "floor_vote"`, a fresh printed
 * date, AND one of the record's own FLOOR facts — a placed-on-calendar
 * sentence (floorCalendarChamber) or a still-pending floor vote
 * (floorPendingChamber). Never two. A quiet week has no panel at all and the
 * page is an unbroken paper column.
 *
 * THE PENDING HALF IS NEW (owner ruling 2026-08-09) and it exists because the
 * calendar half alone was structurally backward-looking: Congress overwrites
 * `last_action_text`, so the moment a bill drew REAL floor action — cloture
 * filed, motion to proceed made — its placement sentence vanished and the
 * crown dropped it, one to two days behind the week's actual votes. The
 * status alone is still looser than either claim (it also covers rejected
 * motions and cloture not invoked), so the gate stays a gate; it now just
 * admits both true facts instead of only the earlier one. See lib/journey.ts.
 * scripts/moment-candidates.mjs `isOnFloorCalendar` is unchanged and still
 * calendar-only — the Moments watcher asks a different question.
 *
 * The cap is not taste, it is the entire mechanism. The corpus is HOT: 339 of
 * the 2,666 bills in `data/bills.json` carry `floor_vote` (as of the
 * 2026-08-09 sync; the corpus moves nightly — recompute, don't trust). Two
 * panels and both read as wallpaper. At a squint a page changes shape exactly
 * once, and this is that change — so if you are adding a second full-bleed
 * band anywhere on the same page, you are taking meaning away from this one.
 *
 * Use `selectFloorVoteFeature()` below to pick the one. The component gates
 * itself on status and date, but it cannot see the action text or its
 * siblings — the floor-fact half of the triad and the cap are the caller's to
 * hold, and that helper is how you hold them.
 *
 * ⚠️ THE DATE IS AN OPEN OWNER RULING, and the 2026-08-09 pending ruling did
 * NOT reopen it. `data/bills.json` still has no forward-looking scheduled-vote
 * date for ANY bill: `floor_vote` is derived from action text like "Placed on
 * Senate Legislative Calendar under General Orders" or "Cloture motion …
 * presented in Senate", and `last_action_date` is always in the past (0 of 339
 * are future-dated, recomputed 2026-08-09). So "floor vote scheduled Thursday"
 * CANNOT be built from live data. Pass the date of the action itself — the
 * calendar PLACEMENT, or the day the pending motion was filed — with a label
 * that claims only that ("On the House floor calendar" / "Floor vote pending in
 * the Senate"). "Pending" says a vote is still ahead, which the record
 * supports; it never says WHEN, which the record does not. Do not synthesize or
 * imply a scheduled vote date. See DESIGN.md.
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
   * The claim the date supports, e.g. "On the House floor calendar" or
   * "Floor vote pending in the Senate". Must claim only what the data
   * supports — see the ruling note above. The prop name is historical: it
   * carries whichever of the two floor facts `selectFloorVoteFeature`
   * actually found, and the caller reads that from the returned `kind`.
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
          {/* data-call-cta: FloatingCallButton's stand-down contract — on a
              floor-calendar bill page both CTAs were visible at once, and at
              320px the floating button overlapped this one (Phase-1 P1).
              Harmless on surfaces with no floating button. */}
          <a
            href={href}
            data-call-cta=""
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
 * WHICH FLOOR FACT the crowned bill stands on. `calendar` is a placement the
 * record printed ("Placed on … Calendar"); `pending` is a floor vote still
 * ahead of it (cloture filed, motion to proceed made, proceedings postponed,
 * a rule reported). Two different sentences, and the caller must print the
 * one that matches.
 */
export type FloorFeatureKind = 'calendar' | 'pending';

export interface FloorFeature<T> {
  bill: T;
  kind: FloorFeatureKind;
  /** Read out of the record's own sentence, never guessed from the bill type
   *  — a House bill can stand on the Senate's calendar. */
  chamber: Chamber;
}

/**
 * Picks the ONE bill that may take the panel, or null on a quiet week.
 *
 * The cap-to-one is load-bearing and no component can enforce it alone, so
 * enforce it here, at the data layer: call this once per page and render at
 * most what it returns.
 *
 * ONE CALL, ONE TRUTH. It returns the bill together with the fact it earned
 * the panel on and the chamber that fact names, because the caller must never
 * re-derive either: the homepage used to re-run floorCalendarChamber over the
 * winner's text to label the chip, which meant two functions had to agree
 * forever about a bill only one of them had chosen.
 *
 * RANKING IS READ-TIME AND DATE-FIRST (2026-08-09):
 *   (a) `last_action_date` descending — the newest genuine floor signal wins.
 *       This is the whole point of the change: the crown must track the week.
 *   (b) an exact-date tie goes to `calendar` over `pending` — a printed
 *       placement is the stronger, plainer claim.
 *   (c) still tied → `effectiveUrgency(status, last_action_date)`, recomputed
 *       here. It replaced a read of the STORED `urgency_score`, which is
 *       frozen at sync time (docs/solutions/stale-urgency-freeze.md) and
 *       disagreed with the read-time score on 304 of the corpus's 339
 *       floor_vote bills as of 2026-08-09. NOTE: with eligibility fixed at
 *       `floor_vote`, (c) is a formality — the curve is a pure function of
 *       status and date, so anything reaching it is already equal on both.
 *       It stays as the explicit total order, and so that widening
 *       eligibility later cannot silently fall through to input order.
 */
export function selectFloorVoteFeature<T extends { status: BillStatus }>(
  bills: readonly T[]
): FloorFeature<T> | null {
  let best: FloorFeature<T> | null = null;
  for (const bill of bills) {
    if (bill.status !== 'floor_vote') continue;
    // The panel asserts the bill's floor fact is true *now*. Past the
    // published 14-day window that assertion stops being true, and the honest
    // quiet week is the correct output. See lib/urgency.mjs.
    if (!isSignalFresh(billDateOf(bill))) continue;
    // And the record itself must say one of the two things: `floor_vote` also
    // covers rejected motions to proceed and cloture NOT invoked, where both
    // "on the floor calendar" and "a vote is pending" would be false claims.
    const text = billActionTextOf(bill);
    const calendar = floorCalendarChamber(text);
    const chamber = calendar ?? floorPendingChamber(text);
    if (chamber === null) continue;
    const candidate: FloorFeature<T> = {
      bill,
      kind: calendar ? 'calendar' : 'pending',
      chamber,
    };
    if (best === null || beats(candidate, best)) best = candidate;
  }
  return best;
}

/** Strictly better than the incumbent on the three ordered keys above. */
function beats<T extends { status: BillStatus }>(a: FloorFeature<T>, b: FloorFeature<T>): boolean {
  const dateA = billDateOf(a.bill) ?? '';
  const dateB = billDateOf(b.bill) ?? '';
  if (dateA !== dateB) return dateA > dateB;
  if (a.kind !== b.kind) return a.kind === 'calendar';
  return urgencyOf(a.bill) > urgencyOf(b.bill);
}

function billDateOf(bill: unknown): string | null {
  const b = bill as { last_action_date?: string | null; lastActionDate?: string | null };
  return b.last_action_date ?? b.lastActionDate ?? null;
}

function billActionTextOf(bill: unknown): string | null {
  const b = bill as { last_action_text?: string | null; lastActionText?: string | null };
  return b.last_action_text ?? b.lastActionText ?? null;
}

function urgencyOf(bill: { status: BillStatus }): number {
  return effectiveUrgency(bill.status, billDateOf(bill));
}
