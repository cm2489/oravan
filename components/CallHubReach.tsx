'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { usePrefs } from '@/lib/local';
import { shareRepLookup, useSharedRepLookup } from '@/lib/rep-lookup-share';

/*
 * THE CALL HUB'S PER-VISITOR HALF (wireframes v2, call-hub.html): who a call
 * from this device would reach, once a ZIP is saved — and nothing at all
 * before one is (the wireframe's reading of "your members once a ZIP is
 * saved"; the bill's own call panel asks for the ZIP in place, BP12).
 *
 * THE SAME TRIP THE CALL PANEL MAKES, AND NO OTHER. The ZIP is read from this
 * browser (lib/local.ts) and sent only to the stateless /api/reps lookup,
 * exactly as components/ActionPanel.tsx does on every bill page when a ZIP is
 * saved (privacy, p2). Nothing new is stored; the answer lives in memory and
 * is shared through lib/rep-lookup-share.ts so each bill row's routing line
 * (`CallHubRouting` below) names the members without a second request.
 *
 * NO NUMBERS HERE, on purpose (wireframe, "What is deliberately not here"):
 * the hub never lands a caller on a number list with no script. Each name
 * opens the member's own page, which carries their numbers, and each bill's
 * "Read + call" opens its panel, where the numbers sit under the script.
 *
 * The page around this is prerendered; this part renders only in the browser,
 * so with JavaScript off the hub is the bill list alone — still a working path
 * to every call panel.
 */

interface HubRep {
  bioguide: string;
  name: string;
  type: 'sen' | 'rep';
  state: string;
  district: number | null;
}

type Lookup =
  | { status: 'ready'; zip: string; reps: HubRep[]; multiDistrict: boolean; vacancies: { state: string; district: number }[] }
  | { status: 'error'; zip: string };

/** Jurisdictions whose House member is a non-voting delegate — the same set
 *  components/RepCard.tsx's `repRoleKey` reads. Kept here rather than
 *  imported, because RepCard's module reaches lib/core, which must never
 *  enter a client bundle (scripts/check-client-bundle.mjs). */
const DELEGATE_JURISDICTIONS = new Set(['DC', 'PR', 'GU', 'VI', 'AS', 'MP']);

function roleKey(rep: Pick<HubRep, 'type' | 'state'>): 'senator' | 'delegate' | 'representative' {
  if (rep.type === 'sen') return 'senator';
  return DELEGATE_JURISDICTIONS.has(rep.state) ? 'delegate' : 'representative';
}

/** A five-digit saved ZIP, or null. */
function useSavedZip(): string | null {
  const { zip } = usePrefs();
  return zip && /^\d{5}$/.test(zip) ? zip : null;
}

export function CallHubReach() {
  const t = useTranslations('call');
  const tReps = useTranslations('reps');
  const tBill = useTranslations('bill');
  const zip = useSavedZip();
  const [lookup, setLookup] = useState<Lookup | null>(null);

  useEffect(() => {
    if (!zip) return;
    let cancelled = false;
    // State is set only from the lookup's own callbacks, never in the effect
    // body (react-hooks/set-state-in-effect); a lookup for an older ZIP is
    // ignored at render time by comparing `lookup.zip`.
    fetch(`/api/reps?zip=${zip}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { reps?: HubRep[]; multiDistrict?: boolean; vacancies?: { state: string; district: number }[] }) => {
        if (cancelled) return;
        const reps = d.reps ?? [];
        const multiDistrict = d.multiDistrict ?? false;
        setLookup({ status: 'ready', zip, reps, multiDistrict, vacancies: d.vacancies ?? [] });
        shareRepLookup({ zip, reps, multiDistrict });
      })
      .catch(() => {
        if (!cancelled) setLookup({ status: 'error', zip });
      });
    return () => {
      cancelled = true;
    };
  }, [zip]);

  // No ZIP saved: the section is not drawn at all. Still loading, or an
  // answer for a ZIP that has since changed: nothing yet, rather than a
  // flash of the wrong members.
  if (!zip || !lookup || lookup.zip !== zip) return null;

  const zipLine = (
    <p data-zip-line="" className="mt-2 text-sm text-ink-2">
      {tReps('zipLine', { zip })} ·{' '}
      <Link href="/reps?change=1" className="inline-flex min-h-11 items-center underline underline-offset-2 hover:text-ink">
        {tReps('changeZip')}
      </Link>
    </p>
  );

  if (lookup.status === 'error') {
    return (
      <section aria-labelledby="reach-h" data-call-reach="error">
        <h2 id="reach-h" className="text-h2 font-extrabold text-ink">
          {t('reachTitle')}
        </h2>
        {zipLine}
        <p role="status" className="mt-3 max-w-note text-sm text-ink-2">
          {t('reachFailed')}
        </p>
      </section>
    );
  }

  // The House member first, then the senators: with no bill in context there
  // is no voting chamber to put first (wireframe guess, "House member first
  // when no bill is in context"; the bill panel orders by the live chamber).
  const reps = [...lookup.reps].sort((a, b) => (a.type === b.type ? 0 : a.type === 'rep' ? -1 : 1));
  const nobody = reps.length === 0 && lookup.vacancies.length === 0;

  return (
    <section aria-labelledby="reach-h" data-call-reach="ready">
      <h2 id="reach-h" className="text-h2 font-extrabold text-ink">
        {t('reachTitle')}
      </h2>
      {zipLine}
      {nobody ? (
        <p className="mt-3 max-w-note text-sm text-ink-2">{tReps('zipNotFound')}</p>
      ) : (
        <>
          {lookup.multiDistrict && (
            <p className="mt-3 max-w-note text-sm text-ink-2">
              {tBill('callWhoMulti')}{' '}
              <Link
                href={`/reps?zip=${zip}`}
                className="inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-2"
              >
                {tBill('refineDistrictCta')}
              </Link>
            </p>
          )}
          <ul className="mt-3 grid list-none border-t border-line">
            {reps.map((rep) => (
              <li key={rep.bioguide} className="border-b border-line py-2">
                <Link
                  href={`/reps/${rep.bioguide}`}
                  className="inline-flex min-h-11 items-center font-bold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                >
                  {rep.name}
                </Link>
                <p className="text-sm text-ink-2">
                  {tReps(roleKey(rep))} ·{' '}
                  {rep.type === 'rep' && rep.district ? `${rep.state}-${rep.district}` : rep.state}
                </p>
              </li>
            ))}
            {lookup.vacancies.map((v) => (
              <li key={`${v.state}-${v.district}`} className="border-b border-line py-3">
                <p className="font-bold text-ink">
                  {v.district === 0
                    ? tReps('atLargeHeading', { state: v.state })
                    : tReps('districtHeading', { state: v.state, district: v.district })}
                </p>
                <p className="text-sm text-ink-2">{tReps('vacantSeat')}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 max-w-note text-sm text-ink-2">{t('reachNote')}</p>
        </>
      )}
    </section>
  );
}

/**
 * One bill's routing line: the voting chamber's members, by name, once the
 * lookup above has answered (BP15). The chamber is the server's reading of
 * the SAME `liveCallTarget` the bill page's panel routes on, so the hub and
 * the panel can never name different live calls for one bill. Nothing prints
 * when there is no live chamber, no saved ZIP, or no member to name — and the
 * House line never prints over a split ZIP (which member is theirs is the
 * reader's to confirm) or over a non-voting delegate.
 */
export function CallHubRouting({ chamber }: { chamber: 'senate' | 'house' }) {
  const t = useTranslations('call');
  const format = useFormatter();
  const zip = useSavedZip();
  const shared = useSharedRepLookup();
  if (!zip || !shared || shared.zip !== zip) return null;
  if (chamber === 'house' && shared.multiDistrict) return null;
  const names = shared.reps
    .filter((r) => (chamber === 'senate' ? r.type === 'sen' : r.type === 'rep' && !DELEGATE_JURISDICTIONS.has(r.state)))
    .map((r) => r.name);
  if (names.length === 0) return null;
  return (
    <p data-call-routing={chamber} className="mt-2 text-sm font-semibold text-ink">
      {t(chamber === 'senate' ? 'routingSenate' : 'routingHouse', {
        names: format.list(names, { type: 'conjunction' }),
      })}
    </p>
  );
}
