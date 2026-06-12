import { useTranslations } from 'next-intl';
import type { BillStatus } from '@/lib/types';

/*
 * The path-to-law list, computed entirely from data (bill type -> origin
 * chamber, status -> current position). Never AI-generated, so it cannot
 * hallucinate procedure. A single stored status can't distinguish which
 * chamber a floor calendar belongs to, so positions are deliberately
 * conservative: floor_vote pins to the origin-chamber vote step unless the
 * bill has already passed a chamber.
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

export function BillJourney({ billType, status }: { billType: string; status: BillStatus }) {
  const t = useTranslations('bill.journey');
  const origin = billType.startsWith('h') ? 'House' : 'Senate';
  const other = origin === 'House' ? 'Senate' : 'House';

  const steps = [
    { key: 'introducedIn', chamber: origin },
    { key: 'committee', chamber: origin },
    { key: 'vote', chamber: origin },
    { key: 'otherChamber', chamber: other },
    { key: 'president', chamber: origin },
  ] as const;

  const here = POSITION[status] ?? 1;
  const isLaw = status === 'signed';
  const isVetoed = status === 'vetoed';

  return (
    <div>
      <ol className="mt-1 space-y-0.5">
        {steps.map((s, i) => {
          const done = isLaw || i < here;
          const current = !isLaw && !isVetoed && i === here;
          return (
            <li
              key={s.key}
              className={`relative pl-7 py-0.5 text-sm md:text-base ${
                current ? 'font-bold text-ink' : done ? 'text-ink-soft' : 'text-ink-faint'
              }`}
            >
              <span
                aria-hidden
                className={`absolute left-1 top-1.5 h-2.5 w-2.5 rounded-full ${
                  current ? 'bg-booth ring-4 ring-booth-soft' : done ? 'bg-moss' : 'bg-line'
                }`}
              />
              {t(s.key, { chamber: s.chamber })}
              {current && (
                <span className="ml-2 align-middle text-xs font-bold uppercase tracking-wide text-booth">
                  {t('youAreHere')}
                </span>
              )}
              {s.key === 'president' && isLaw && (
                <span className="ml-2 rounded-full bg-moss-soft px-2 py-0.5 text-xs font-semibold text-ink">
                  {t('law')}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {isVetoed && <p className="mt-2 text-sm text-ink-soft">{t('vetoed')}</p>}
    </div>
  );
}
