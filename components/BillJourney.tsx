import { useTranslations } from 'next-intl';
import type { BillStatus } from '@/lib/types';

/*
 * The path-to-law stepper, computed entirely from data (bill type -> origin
 * chamber, status -> current position). Never AI-generated, so it cannot
 * hallucinate procedure. A single stored status can't distinguish which
 * chamber a floor calendar belongs to, so positions are deliberately
 * conservative: floor_vote pins to the origin-chamber vote step.
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

export function BillJourney({ billType, status }: { billType: string; status: BillStatus }) {
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
    <div className="mt-3 border-t border-line pt-4">
      <ol className="grid grid-cols-5">
        {labels.map((label, i) => {
          const done = isLaw || i < here;
          const current = !isLaw && !isVetoed && i === here;
          return (
            <li key={i} className="relative pt-6 text-center">
              {/* connector */}
              {i > 0 && (
                <span
                  aria-hidden
                  className={`absolute left-[-50%] top-[0.55rem] h-0.5 w-full ${
                    done || current ? 'bg-moss' : 'bg-line'
                  }`}
                />
              )}
              {/* dot */}
              <span
                aria-hidden
                className={`absolute left-1/2 top-1 z-10 h-3 w-3 -translate-x-1/2 rounded-full ${
                  current ? 'bg-booth ring-4 ring-booth-soft' : done ? 'bg-moss' : 'bg-line'
                }`}
              />
              <span
                className={`block px-0.5 text-xs leading-tight ${
                  current ? 'font-bold text-ink' : done ? 'font-medium text-ink-soft' : 'text-ink-faint'
                }`}
              >
                {label}
                {current && <span className="sr-only"> — {t('youAreHere')}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-sm text-ink-soft">
        <strong className="text-ink">{t('now')}</strong> {t(NOW_KEY[status] ?? 'nowCommittee', { chamber, other })}
        {TRAILER_STATUSES.has(status) && <> {t('backTrailer', { chamber, other })}</>}
        {isLaw && (
          <span className="ml-2 rounded-full bg-moss-soft px-2 py-0.5 text-xs font-semibold text-ink">
            {t('law')}
          </span>
        )}
      </p>
    </div>
  );
}
