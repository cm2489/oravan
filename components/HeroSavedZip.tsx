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
 *
 * THE SHAPE ON A PHONE (MEASURED 2026-09-29, WebKit, 390 wide). The hero must
 * keep every control clear of the thumb bar at scroll 0, at 390×664 (bar at
 * 615–664) and 390×844 (bar at 795–844): tests/home-fold.spec.ts, which now
 * runs four saved ZIPs as well. The first version of this block put the ZIP
 * line and Change ZIP code LAST, so where they landed depended on the names,
 * the language and the split-district line, and 8 of 16 saved-ZIP cases
 * failed.
 * Two things hold it now:
 *   1. Every control comes first. Change ZIP code sits on the label row,
 *      always at the block's top; the names and the split-district or
 *      vacant-seat link follow. The ZIP line has no control, so it goes last,
 *      and it may run past the bar.
 *   2. Below md the block keeps at least the form's height (166px, 10.375rem:
 *      label, field row and help line). "Ver en español" / "View in English"
 *      then starts where it does with no ZIP saved (676px EN, 696px ES):
 *      below the 664 fold and above the 844 bar. A taller block pushes it
 *      lower. The tallest blocks measured, in Spanish, end at 652px, which
 *      puts the link at 738–782: 10001 (a split district, with the longest
 *      senator names in data/) and 76936 (a vacant seat).
 * A ZIP that crosses a state line names nobody (lib/home-zip.ts), so it keeps
 * the form. The owner's wireframe draws the ZIP line and Change ZIP code
 * together, after the names. Kept last, with a smaller names line, Change
 * ZIP code still sat under the bar in Spanish 10001 (616–660 at 390×664).
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
    // Controls first, the ZIP line last, and at least the form's height below
    // md: THE SHAPE ON A PHONE, above.
    <div data-saved-zip={zip} className="max-w-[30rem] max-md:min-h-[10.375rem]">
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <p className="text-sm font-bold">{t('homeZip.members')}</p>
        <Link
          href="/reps?change=1"
          className="inline-flex min-h-11 items-center text-sm font-semibold text-go underline underline-offset-4 hover:text-go-deep"
        >
          {t('reps.changeZip')}
        </Link>
      </div>
      <p className="text-lg font-semibold text-ink">{names}.</p>
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
      <p className="mt-2 text-sm text-ink-2 tabular-nums">
        {t('homeZip.where', { zip, hasPlace: place ? 'yes' : 'no', place })}
      </p>
    </div>
  );
}
