import { useTranslations } from 'next-intl';
import { Chip } from '@/components/system';
import type { JourneyState } from '@/lib/journey';

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
 * WHERE THE PATH ENDS, AND THE ONE VEHICLE THAT NEVER REACHES THE PRESIDENT.
 *
 * A CONCURRENT resolution — hconres / sconres — is not presented to the
 * President and cannot become law. It is the two chambers speaking to each
 * other: budget resolutions, War Powers directives, adjournment. Both chambers
 * adopt it and that is the end of the road, Article I, Section 7's
 * presentment requirement never engages. Until 2026-08-09 this stepper printed
 * "President's desk" as the fifth step on every one of them, and the trailer
 * underneath promised the bill would go back to its origin chamber "before
 * reaching the President" — a false procedural fact on the 6 con-res pages in
 * the corpus (hconres-113-119, sconres-38-119, sconres-39-119, hconres-38-119,
 * hconres-89-119, hconres-96-119), in both languages, in the one component
 * whose own header promises it cannot hallucinate procedure.
 *
 * WHY THIS IS A LOOKUP AND NOT A DERIVATION. It is the same distinction
 * lib/journey.ts draws for nominations (VOTING_CHAMBERS): a bill's CHAMBER is
 * an observation about the record and must be read from it, but presentment is
 * a fact about the KIND of vehicle — constitutional, fixed in advance, true of
 * every concurrent resolution that has ever existed. Nothing in any record can
 * change it, so nothing needs to be parsed.
 *
 * KNOWN LIMIT, deliberately not built (flagged to the owner rather than
 * guessed): a JOINT resolution proposing a constitutional amendment also skips
 * the President — it goes to the states for ratification. 16 of the 94 joint
 * resolutions in the corpus are amendment proposals. Detecting them means
 * pattern-matching the title ("Proposing an amendment to the Constitution…"),
 * which is a text heuristic this codebase has not verified, and an unverified
 * heuristic in a truth component is the class of thing this file exists to
 * refuse. Every other hjres/sjres — CRA disapprovals, continuing resolutions —
 * genuinely IS presented to the President, so the default is right for them.
 */
const NO_PRESENTMENT = new Set(['hconres', 'sconres']);

/** False only for vehicles the Constitution never presents to the President.
 *  Exported for tests/bill-journey.unit.spec.ts. */
export function endsAtPresident(billType: string): boolean {
  return !NO_PRESENTMENT.has(billType.toLowerCase());
}

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
          {journey.showTrailer && (
            <> {t(toPresident ? 'backTrailer' : 'backTrailerBothChambers', { chamber, other })}</>
          )}
        </span>
        {isLaw && <Chip tone="tag">{t('law')}</Chip>}
      </p>
    </div>
  );
}
