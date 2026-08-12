import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { GlossaryTerm } from '@/components/GlossaryTerm';
import { Chip } from '@/components/system';
import type { GlossaryTermId } from '@/lib/glossary';
import { endsAtPresident, type FloorCalendar, type JourneyState } from '@/lib/journey';

/*
 * The path-to-law stepper — PRESENTATIONAL ONLY. All position/chamber
 * derivation lives in lib/journey.ts (`deriveJourney`), the one derivation
 * the bill page and the homepage panel both consume: the current chamber is
 * read out of the bill's own last-action sentence where the record says,
 * never guessed from the bill type. Never AI-generated, so it cannot
 * hallucinate procedure.
 *
 * SHAPE: the same 6px bar the gauge is drawn with, capped at rounded-stamp.
 * It is NOT the Gauge primitive, and that is deliberate: Gauge draws every
 * segment in `go` because a gauge measures a quantity already spent, while
 * this strip has to say "reached" AND "not reached yet" for six named steps
 * and keep a label on both kinds. Passing only the reached steps to Gauge
 * would collapse "Passed" and "President's desk" into one anonymous stub,
 * which is exactly the information a first-time caller is looking for. The
 * reference mockup hand-writes this block for the same reason.
 *
 * COLOR: completed steps are `go`, the CURRENT step is a hollow `go` outline
 * on paper (reached, not completed — a solid fill read as a finished stage
 * that was simultaneously announced as current), unreached are the `line`
 * track — the same go/line gauge pair, no new color. Position is carried by
 * WEIGHT, by the visible "You are here" caption under the current label, and
 * by the "Right now:" sentence underneath, never by color alone: the
 * reference tinted the current label green, and green in this system is
 * spent on actions and the gauge, never on a label.
 */

/*
 * WHERE THE PATH ENDS — `endsAtPresident` MOVED TO lib/journey.ts (2026-08-12).
 *
 * It was defined here and imported by tests/bill-journey.unit.spec.ts, and that
 * import is what makes the move necessary rather than tidy: this file now
 * renders a glossary trigger, the trigger imports `@/i18n/navigation`, and that
 * chain does not resolve inside Playwright's plain-Node runner. So a spec that
 * reaches into a COMPONENT for a pure function breaks the moment the component
 * grows any UI dependency — which it always eventually does.
 *
 * The function belonged next door anyway. This file's own header says all
 * derivation lives in lib/journey.ts, and presentment is exactly that kind of
 * fact: constitutional, fixed by the KIND of vehicle, never read out of a
 * record. Its full reasoning and its known limit travelled with it.
 */

/*
 * THE GLOSSARY LINK ON THE PLACEMENT PHRASE (issue #181).
 *
 * `nowFloor` / `nowFloorStale` are the only two "Right now:" sentences that
 * name a calendar, and both wrap that phrase in a `<floorCalendar>` tag in
 * BOTH languages. The tag is one name; WHICH entry it resolves to is decided
 * here, from what the record actually said.
 *
 * THE HOUSE CALENDAR HAS NO ENTRY, AND SO GETS NO LINK. The House keeps two
 * calendars and the record names both: measured 2026-08-12 on the committed
 * corpus, 148 House placements say "Union Calendar" and 2 say "House
 * Calendar". The first batch of glossary terms (issue #181) covers the Union
 * Calendar and not the other, so those 2 render the identical sentence with no
 * trigger in it rather than a link to an entry that is about a different list.
 * Absence is a finding; a link that is 98.7% right is a false claim on the
 * rest. See lib/journey.ts's floorCalendarName for the full split.
 */
const CALENDAR_TERM: Record<FloorCalendar, GlossaryTermId | null> = {
  'senate-legislative': 'legislative-calendar',
  union: 'union-calendar',
  house: null,
};

interface Props {
  journey: JourneyState;
  /** The vehicle's type (`hr`, `s`, `hjres`, `sconres`, …) — decides whether
   *  the path ends at the President's desk or at adoption by both chambers.
   *  See NO_PRESENTMENT above. */
  billType: string;
  /** Short, already-localized introduced date, printed under step 1. */
  introducedLabel?: string;
  /** Short, already-localized last-action date, printed under the current step. */
  currentLabel?: string;
}

export function BillJourney({ journey, billType, introducedLabel, currentLabel }: Props) {
  const t = useTranslations('bill.journey');
  const toPresident = endsAtPresident(billType);
  // Display strings for the ICU selects: origin chamber and its opposite.
  const chamber = journey.origin === 'house' ? 'House' : 'Senate';
  const other = chamber === 'House' ? 'Senate' : 'House';
  // The chamber the "Right now" sentence speaks about — the CURRENT chamber
  // for the floor keys (a House bill can stand on the Senate's calendar).
  const nowChamber = journey.nowChamber === 'house' ? 'House' : 'Senate';

  const labels = [
    t('stepIntroduced'),
    t('stepCommittee', { chamber }),
    t('stepVote', { chamber }),
    t('stepOther', { chamber: other }),
    toPresident ? t('stepPresident') : t('stepBothChambers'),
  ];
  const here = journey.step;
  const { isLaw, isVetoed } = journey;

  // Supplied on every key: the tag only exists inside the two placement
  // messages, and next-intl ignores a handler a message never opens.
  const calendarTerm = journey.floorCalendar ? CALENDAR_TERM[journey.floorCalendar] : null;
  const floorCalendar = (chunks: ReactNode) =>
    calendarTerm ? <GlossaryTerm id={calendarTerm}>{chunks}</GlossaryTerm> : <>{chunks}</>;

  return (
    <div>
      {/* Below 48rem the strip stands up and runs DOWN the page rather than
          scrolling sideways: a region that scrolls needs a tab stop, and a
          tab stop on a region that does not scroll is dead weight every
          keyboard user pays for on every visit. So it never scrolls. */}
      <ol className="grid list-none gap-3 md:flex md:gap-1">
        {labels.map((label, i) => {
          const done = isLaw || i < here;
          const current = !isLaw && !isVetoed && i === here;
          const note = !current && i === 0 ? introducedLabel : undefined;
          return (
            <li
              key={i}
              aria-current={current ? 'step' : undefined}
              className="relative min-w-0 pl-4 md:flex-1 md:pt-3 md:pr-2 md:pl-0"
            >
              <span
                aria-hidden
                className={`absolute top-0.5 bottom-0.5 left-0 w-[6px] rounded-stamp md:top-0 md:right-1 md:bottom-auto md:h-[6px] md:w-auto ${
                  done ? 'bg-go' : current ? 'border-2 border-go bg-paper' : 'bg-line'
                }`}
              />
              <span
                className={`block text-xs break-words ${
                  current
                    ? 'font-extrabold text-ink'
                    : done
                      ? 'font-semibold text-ink'
                      : 'font-semibold text-ink-2'
                }`}
              >
                {label}
              </span>
              {current && (
                <span className="block text-2xs font-bold text-ink">
                  {t('youAreHere')}
                  {currentLabel ? ` · ${currentLabel}` : ''}
                </span>
              )}
              {note && <span className="block text-2xs text-ink-2 tabular-nums">{note}</span>}
            </li>
          );
        })}
      </ol>
      <p className="mt-4 flex flex-wrap items-center gap-2 max-w-note text-sm text-ink-2">
        <span>
          <strong className="font-bold text-ink">{t('now')}</strong>{' '}
          {t.rich(journey.nowKey, { chamber: nowChamber, other, floorCalendar })}
          {journey.showTrailer && (
            <> {t(toPresident ? 'backTrailer' : 'backTrailerBothChambers', { chamber, other })}</>
          )}
        </span>
        {isLaw && <Chip tone="tag">{t('law')}</Chip>}
      </p>
    </div>
  );
}
