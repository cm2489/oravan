import { useTranslations } from 'next-intl';
import { Chip } from '@/components/system';
import type { JourneyEnding, JourneyState } from '@/lib/journey';

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
 * WHERE THE PATH ENDS — and the two vehicles that never reach the President.
 *
 * The decision itself lives in lib/journey.ts (`journeyEnding`, and the long
 * header above it) and arrives here as `journey.ending`, because as of
 * 2026-08-12 it is read off the record's own title and this component's first
 * header promises that every derivation the strip renders lives there. What
 * is left here is the mapping from that answer to the two strings the fifth
 * step and the trailer print:
 *
 *   'president'     → step "President's desk", the ordinary trailer
 *   'bothChambers'  → concurrent resolutions (#199, 2026-08-09)
 *   'states'        → Article V amendment proposals (D5, 2026-08-12) — the
 *                     class #199 documented as its known limit and declined
 *                     to guess at
 *
 * Every branch is a closed constitutional fact, so the mapping is exhaustive
 * by TYPE: a fourth ending cannot be added to JourneyEnding without failing
 * the build right here rather than silently reusing the President's desk.
 */
const STEP_KEY: Record<JourneyEnding, string> = {
  president: 'stepPresident',
  bothChambers: 'stepBothChambers',
  states: 'stepStates',
};

const TRAILER_KEY: Record<JourneyEnding, string> = {
  president: 'backTrailer',
  bothChambers: 'backTrailerBothChambers',
  states: 'backTrailerStates',
};

interface Props {
  journey: JourneyState;
  /** Short, already-localized introduced date, printed under step 1. */
  introducedLabel?: string;
  /** Short, already-localized last-action date, printed under the current step. */
  currentLabel?: string;
}

export function BillJourney({ journey, introducedLabel, currentLabel }: Props) {
  const t = useTranslations('bill.journey');
  const { ending } = journey;
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
    t(STEP_KEY[ending]),
  ];
  const here = journey.step;
  const { isLaw, isVetoed } = journey;

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
          {t(journey.nowKey, { chamber: nowChamber, other })}
          {journey.showTrailer && <> {t(TRAILER_KEY[ending], { chamber, other })}</>}
        </span>
        {isLaw && <Chip tone="tag">{t('law')}</Chip>}
      </p>
    </div>
  );
}
