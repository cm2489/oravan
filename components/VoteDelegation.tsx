'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { usePrefs } from '@/lib/local';
import { useSharedRepLookup, type SharedRep } from '@/lib/rep-lookup-share';
import type { VotePosition } from '@/lib/types';

/*
 * "YOUR MEMBERS ON THIS BILL" — the visitor's own House member and senators,
 * each beside their position on the newest roll call in THEIR chamber.
 *
 * PRIVACY CONSTRUCTION. This component makes no request. It renders only when
 * BOTH hold: a ZIP is saved in this browser (lib/local.ts `oravan.prefs`), and
 * the call rail has already resolved that same ZIP to members
 * (lib/rep-lookup-share.ts — the rail's existing /api/reps answer, shared in
 * memory). The join against the record happens here, in the browser, over the
 * positions the server rendered into the page for every visitor alike. With no
 * saved ZIP it renders nothing — no prompt; the call rail already asks.
 *
 * PER CHAMBER, NOT "THE" NEWEST. A senator has no position on a House roll
 * call. Each row reads the newest roll call in its own member's chamber and
 * prints that vote's date, or says plainly that the chamber has no recorded
 * vote on this bill inside the file's window.
 */

export interface DelegationVote {
  /** Already formatted for the page's locale. */
  date: string;
  positions: Record<string, VotePosition>;
}

export function VoteDelegation({
  house,
  senate,
  floorLabel,
}: {
  house: DelegationVote | null;
  senate: DelegationVote | null;
  floorLabel: string;
}) {
  const t = useTranslations('votes');
  const zip = usePrefs().zip ?? null;
  const lookup = useSharedRepLookup();
  if (!zip || !lookup || lookup.zip !== zip) return null;

  // A split ZIP cannot say which House member is this visitor's; the
  // senators are certain either way.
  const members: SharedRep[] = lookup.reps
    .filter((r) => !lookup.multiDistrict || r.type === 'sen')
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'rep' ? -1 : 1));
  if (members.length === 0) return null;

  const line = (r: SharedRep) => {
    if (r.type === 'sen') {
      if (!senate) return { position: null, meta: t('delegation.noSenateVote', { date: floorLabel }) };
      const p = senate.positions[r.bioguide];
      return {
        position: p ? t(`position.${p}`) : t('delegation.notListed'),
        meta: t('delegation.onSenateVote', { date: senate.date }),
      };
    }
    if (!house) return { position: null, meta: t('delegation.noHouseVote', { date: floorLabel }) };
    const p = house.positions[r.bioguide];
    return {
      position: p ? t(`position.${p}`) : t('delegation.notListed'),
      meta: t('delegation.onHouseVote', { date: house.date }),
    };
  };

  return (
    <section
      aria-labelledby="votes-yours-h"
      className="mt-4 rounded-control border border-line-strong px-4 py-3"
      data-vote-delegation=""
    >
      <h3 id="votes-yours-h" className="text-sm font-extrabold text-ink">
        {t('delegation.heading')}
      </h3>
      <ul className="mt-1 divide-y divide-line">
        {members.map((r) => {
          const { position, meta } = line(r);
          return (
            <li
              key={r.bioguide}
              className="flex flex-wrap items-center justify-between gap-x-4 py-1"
              data-vote-delegate={r.bioguide}
            >
              <Link
                href={`/reps/${r.bioguide}`}
                className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
              >
                {r.name} ({r.state})
              </Link>
              <span className="text-sm text-ink-2 tabular-nums">
                {position && <b className="mr-2 font-extrabold text-ink">{position}</b>}
                {meta}
              </span>
            </li>
          );
        })}
      </ul>
      {lookup.multiDistrict && (
        <p className="mt-2 text-sm text-ink-2">{t('delegation.multiDistrict')}</p>
      )}
      <p className="mt-2 text-xs text-ink-2">{t('delegation.note')}</p>
    </section>
  );
}
