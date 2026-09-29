'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { savedZip } from '@/lib/local';
import {
  memberRole,
  namedMembers,
  readLookup,
  savedZipDistrict,
  type LookupAnswer,
} from '@/lib/home-zip';

/*
 * THE HERO WITH A SAVED ZIP (Home option B, v2 wireframe 2026-09-29, Claude's
 * ruling 4, which the owner may overrule: "Home with a saved ZIP: the same
 * layout. … Only the hero's ZIP block changes: the ZIP field, its button and
 * its help line give way to one line naming the three members, then the saved
 * ZIP with Change ZIP code.").
 *
 * WHERE THE NAMES COME FROM. The ZIP saved in this browser (lib/local.ts,
 * rule 1: personalization lives in localStorage), sent to the stateless
 * /api/reps lookup — the same trip the bill page's call panel already makes
 * for a saved ZIP on every bill page, and the one the owner's Q8 ruling
 * describes: "The ZIP is kept only on the device and sent only to the
 * stateless lookup, as the bill panel already does." Nothing new is stored.
 *
 * READ ONCE, AT OPEN (the idiom of components/SavedZipLookup.tsx). A ZIP
 * typed into the form below is saved by the form itself and then navigates to
 * /reps; subscribing here would swap the form out from under that submit. So
 * the block decides once, after hydration, and the next visit shows members.
 *
 * THE FORM IS THE FALLBACK, never an empty slot: with no saved ZIP, while the
 * lookup runs, and on any failure (a rate limit, a network error, an answer
 * that names nobody), the children — the ZIP form, server-rendered, working
 * with JavaScript off — are what renders.
 */
export function HeroSavedZip({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const format = useFormatter();
  const [saved, setSaved] = useState<{ zip: string; answer: LookupAnswer } | null>(null);

  useEffect(() => {
    const zip = savedZip();
    if (!zip) return;
    let live = true;
    fetch(`/api/reps?zip=${zip}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((body: unknown) => {
        const answer = readLookup(body);
        if (live && answer && namedMembers(answer).length > 0) setSaved({ zip, answer });
      })
      .catch(() => {
        /* the form stays: a lookup that did not go through names nobody */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!saved) return <>{children}</>;

  const { zip, answer } = saved;
  const members = namedMembers(answer);
  const district = savedZipDistrict(answer);
  const place = district
    ? district.district === 0
      ? t('reps.atLargeHeading', { state: district.state })
      : t('reps.districtHeading', { state: district.state, district: district.district })
    : '';
  const names = format.list(
    members.map((m) => (
      <Link
        key={m.bioguide}
        href={`/reps/${m.bioguide}`}
        className="font-bold text-ink underline underline-offset-4 hover:text-go-deep"
      >
        {t('homeZip.member', { role: memberRole(m), name: m.name })}
      </Link>
    )),
    { type: 'conjunction' }
  );
  const lookupHref = `/reps?zip=${zip}`;
  const inlineLink = (chunks: ReactNode) => (
    <Link href={lookupHref} className="font-semibold text-go underline underline-offset-4 hover:text-go-deep">
      {chunks}
    </Link>
  );

  return (
    <div data-saved-zip={zip} className="max-w-[30rem]">
      <p className="text-lg font-semibold text-ink">
        {t('homeZip.members')} {names}.
      </p>
      {answer.multiDistrict && (
        <p className="mt-2 max-w-note text-sm text-ink-2">
          {t.rich('homeZip.multi', { link: inlineLink })}
        </p>
      )}
      {!answer.multiDistrict && answer.vacancies.length > 0 && (
        <p className="mt-2 max-w-note text-sm text-ink-2">
          {t.rich('homeZip.vacant', { link: inlineLink })}
        </p>
      )}
      {/* The separator rides at the END of the chunk before it, so a wrapped
          line never starts with a floating "·" (the BillCard rule). */}
      <p className="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
        <span className="tabular-nums">
          {t('homeZip.where', { zip, hasPlace: place ? 'yes' : 'no', place })}
          <span aria-hidden="true"> ·</span>
        </span>
        <Link
          href="/reps?change=1"
          className="inline-flex min-h-11 items-center font-semibold text-go underline underline-offset-4 hover:text-go-deep"
        >
          {t('reps.changeZip')}
        </Link>
      </p>
    </div>
  );
}
