'use client';

import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { seatSlug, type FinderRow } from '@/lib/house-finder';

/*
 * THE SPLIT-ZIP HOUSE FINDER, VERSION A: one button, then every House member
 * whose district touches the saved ZIP, each beside their position on the
 * House roll call the group above is about. No address is asked; the rows are
 * built from the ZIP lookup the panel already made (lib/house-finder.ts).
 *
 * Owner, 2026-09-29, reviewing /bills/hconres-89-119 with a split ZIP: "This
 * would be a use of a subtle yellow button (I know color comes later) but
 * there should be a way for them to find those votes in this box here."
 *
 * THE AMBER, SCOPED. app/globals.css's COLOR LAW still reads that `urgent`
 * "is spent on exactly ONE fact: a bill standing on the floor calendar", and
 * /reps's header says "your ZIP spans two districts" is not that fact. The
 * owner's later direction (docs/current-direction.md, 2026-09-26 / 09-27:
 * "yellow ... marks only what you can act on") and his words above put a
 * light amber fill on this one control. It is a FILL, never text and never a
 * boundary: ink text on it (the mix sits between paper and `urgent`, so ink
 * clears 11.44:1 at the least), and the control's findable edge is the 1.5px
 * `line-strong` border (3.24:1 on the panel's paper). No gate enforces the
 * one-fact law (searched tests/ and scripts/ 2026-09-29), so nothing was
 * loosened to let this in; the conflict is named in the PR for the owner.
 *
 * A DISCLOSURE, per the ARIA pattern: a real <button> with aria-expanded and
 * aria-controls, the label unchanged when open (the chevron turns), focus
 * left on the button. 44px tall, the 8px control radius, the site's own
 * focus ring.
 */

const FINDER_BUTTON =
  'inline-flex min-h-11 items-center gap-2 rounded-control border-[1.5px] border-line-strong bg-urgent/30 px-3 py-2 text-left text-sm font-semibold text-ink hover:border-ink';

const NAME_LINK =
  'inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink';

export function HouseFinder({ zip, rows }: { zip: string; rows: FinderRow[] }) {
  const t = useTranslations('bill');
  const tVotes = useTranslations('votes');
  const [open, setOpen] = useState(false);
  const regionId = useId();

  if (rows.length === 0) return null;
  const vacant = rows.some((r) => r.member === null);

  return (
    <div className="mt-2" data-house-finder="">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((o) => !o)}
        className={FINDER_BUTTON}
        data-house-finder-toggle=""
      >
        {t('settled.finderShow', { zip })}
        <ChevronDown
          className={`h-4 w-4 flex-none ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      <div id={regionId} hidden={!open} className="mt-3" data-house-finder-list="">
        <p className="text-sm font-semibold text-ink" data-house-finder-split="">
          {t('settled.finderSplit', { count: rows.length, vacant: vacant ? 'yes' : 'no' })}
        </p>
        <ul className="mt-1 divide-y divide-line">
          {rows.map((r) => {
            const seat = `${r.state}-${r.district}`;
            return (
              <li
                key={seat}
                className="flex flex-wrap items-center justify-between gap-x-4 py-1"
                data-house-finder-row={seat}
                data-finder-member={r.member?.bioguide}
              >
                <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2">
                  <span className="rounded-stamp border-[1.5px] border-line-strong px-1.5 text-xs font-bold text-ink tabular-nums">
                    {t('settled.finderDistrict', { state: r.state, district: String(r.district) })}
                  </span>
                  {r.member ? (
                    <Link href={`/reps/${r.member.bioguide}`} className={NAME_LINK}>
                      {r.member.name}
                    </Link>
                  ) : (
                    <Link href={`/reps/${seatSlug(r)}`} className={NAME_LINK}>
                      {t('settled.finderVacant')}
                    </Link>
                  )}
                </span>
                {r.member && (
                  <span className="text-sm text-ink-2" data-settled-position={r.position ?? 'none'}>
                    {r.position ? (
                      <b className="font-extrabold text-ink">{tVotes(`position.${r.position}`)}</b>
                    ) : (
                      t('settled.noRecordedVote')
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {/* Optional, and the version works without it: /reps already holds
            the street-address form (components/AddressForm.tsx), which sends
            the address once in a POST body and keeps only the derived
            district, in that page's own URL. Nothing is asked here. */}
        <Link
          href={`/reps?zip=${zip}`}
          className="mt-1 inline-flex min-h-11 items-center text-sm text-ink-2 underline underline-offset-2 hover:text-ink"
          data-house-finder-refine=""
        >
          {t('settled.finderRefine')}
        </Link>
      </div>
    </div>
  );
}
