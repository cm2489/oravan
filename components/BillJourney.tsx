import { useTranslations } from 'next-intl';
import { Chip } from '@/components/system';
import type { BillStatus } from '@/lib/types';

/*
 * The path-to-law stepper, computed entirely from data (bill type -> origin
 * chamber, status -> current position). Never AI-generated, so it cannot
 * hallucinate procedure. A single stored status can't distinguish which
 * chamber a floor calendar belongs to, so positions are deliberately
 * conservative: floor_vote pins to the origin-chamber vote step.
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
 * COLOR: reached steps are `go`, unreached are the `line` track — the same
 * pair the Gauge primitive uses (4.70:1 against each other). Position is
 * carried by WEIGHT and by the "Right now:" sentence underneath, never by
 * color alone: the reference tinted the current label green, and green in
 * this system is spent on actions and the gauge, never on a label.
 */

const POSITION: Record<BillStatus, number> = {
  introduced: 0,
  committee: 1,
  markup: 1,
  floor_vote: 2,
  passed_chamber: 3,
  conference: 3,
  signed: 4,
  vetoed: 4,
};

const NOW_KEY: Record<BillStatus, string> = {
  introduced: 'nowIntroduced',
  committee: 'nowCommittee',
  markup: 'nowCommittee',
  floor_vote: 'nowFloor',
  passed_chamber: 'nowPassed',
  conference: 'nowConference',
  signed: 'nowSigned',
  vetoed: 'nowVetoed',
};

/** Statuses where the "changes send it back" trailer is still ahead. */
const TRAILER_STATUSES = new Set<BillStatus>(['introduced', 'committee', 'markup', 'floor_vote', 'passed_chamber']);

interface Props {
  billType: string;
  status: BillStatus;
  /** Short, already-localized introduced date, printed under step 1. */
  introducedLabel?: string;
  /** Short, already-localized last-action date, printed under the current step. */
  currentLabel?: string;
}

export function BillJourney({ billType, status, introducedLabel, currentLabel }: Props) {
  const t = useTranslations('bill.journey');
  const chamber = billType.startsWith('h') ? 'House' : 'Senate';
  const other = chamber === 'House' ? 'Senate' : 'House';

  const labels = [
    t('stepIntroduced'),
    t('stepCommittee', { chamber }),
    t('stepVote', { chamber }),
    t('stepOther', { chamber: other }),
    t('stepPresident'),
  ];
  const here = POSITION[status] ?? 1;
  const isLaw = status === 'signed';
  const isVetoed = status === 'vetoed';

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
          const note = i === 0 ? introducedLabel : current ? currentLabel : undefined;
          return (
            <li
              key={i}
              aria-current={current ? 'step' : undefined}
              className="relative min-w-0 pl-4 md:flex-1 md:pt-3 md:pr-2 md:pl-0"
            >
              <span
                aria-hidden
                className={`absolute top-0.5 bottom-0.5 left-0 w-[6px] rounded-stamp md:top-0 md:right-1 md:bottom-auto md:h-[6px] md:w-auto ${
                  done || current ? 'bg-go' : 'bg-line'
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
                {current && <span className="sr-only"> — {t('youAreHere')}</span>}
              </span>
              {note && <span className="block text-2xs text-ink-2 tabular-nums">{note}</span>}
            </li>
          );
        })}
      </ol>
      <p className="mt-4 flex flex-wrap items-center gap-2 max-w-note text-sm text-ink-2">
        <span>
          <strong className="font-bold text-ink">{t('now')}</strong>{' '}
          {t(NOW_KEY[status] ?? 'nowCommittee', { chamber, other })}
          {TRAILER_STATUSES.has(status) && <> {t('backTrailer', { chamber, other })}</>}
        </span>
        {isLaw && <Chip tone="tag">{t('law')}</Chip>}
      </p>
    </div>
  );
}
