'use client';

import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { ZipForm, repsPermalink } from '@/components/ZipForm';
import { SavedZipLookup, ZipKeptNote } from '@/components/SavedZipLookup';
import { AddressForm } from '@/components/AddressForm';
import { RepCard } from '@/components/RepCard';
import { VacantSeatCard } from '@/components/VacantSeatCard';
import { lookupMembers } from '@/lib/members-action';
import type { MembersResult } from '@/lib/members';
import { currentEntry, entryFor, readEntry, rememberMembers, sameEntry, type MembersEntry } from '@/lib/members-entry';

/*
 * THE MEMBERS, LOOKED UP WITHOUT AN ADDRESS (owner, 2026-11-12; CLAUDE.md
 * rule 1). Until that day this page rendered from /reps?zip=NNNNN, so every
 * lookup put the reader's ZIP in the host's request log, the browser's
 * history and any link they shared. Now the address stays /reps (or
 * /es/reps) and the ZIP travels only in a POST body, to the server action in
 * lib/members-action.ts, which answers with plain data (lib/members.ts) that
 * this component renders. What a reader sees is unchanged; the markup below
 * is the page's own, moved here from app/[locale]/reps/page.tsx.
 *
 * THREE WAYS THE MEMBERS ARRIVE:
 *   1. JavaScript on: the ZIP form, the saved ZIP on arrival
 *      (SavedZipLookup), the street-address refinement (AddressForm) and
 *      "Show all districts" call `lookup()`, which calls the server action.
 *   2. JavaScript off: the ZIP form POSTs natively to this page (its action is
 *      lookupMembers with the permalink /reps), Next.js runs the action and
 *      renders this page with the answer as `useActionState`'s state.
 *   3. An old link, /reps?zip=NNNNN (bookmarks, shared links, search
 *      results): the page reads it on the server once, renders the members
 *      as `initial`, and once the page runs this component drops the ZIP from
 *      the address bar with history.replaceState (no new history entry). That
 *      one request's address, with the ZIP in it, is still in the host's log;
 *      the page cannot un-send it. The page's responses carry a
 *      Referrer-Policy (next.config.ts) so that address is not repeated in
 *      the Referer of the requests the page makes next.
 *
 * RELOAD AND BACK KEEP WHAT WAS SHOWN (2026-11-12). Each lookup's ZIP, and
 * its refined district, are kept in this tab's own history entry
 * (lib/members-entry.ts), never in the address, web storage, a cookie or the
 * server. Reload looks that entry up again; a refinement, and "Show all
 * districts", make a new entry, so Back returns to the view before it, as it
 * did while both sat in the address.
 *
 * THE OLD LINK'S CLEANUP WAITS ONE TICK. Next.js hooks history.replaceState
 * so the router learns the new address, but installs that hook in an effect
 * of its own root, which on the first render runs after this component's
 * effects. Called from this component's first effect, replaceState reached
 * the browser's own method: the router kept the old address, so every later
 * lookup POSTed to /reps?zip=…, and the entry lost the router's state, so
 * Back from a bill left the bill on screen. One tick later the hook is in
 * place (lib/members-entry.ts has the detail).
 *
 * "Change ZIP code" stays /reps?change=1: it carries nothing about the
 * reader. The prompt shows while the address holds `change`, and a lookup
 * from there drops it, so a reload opens on the members just saved.
 */

type Props = {
  /** The members an old /reps?zip= link asked for, rendered on the server. */
  initial: MembersResult | null;
  /** The address arrived with a zip or district parameter to drop. */
  legacy: boolean;
  /** The preview of the three cards, under the prompt (server-rendered). */
  preview: ReactNode;
  /** The Capitol switchboard block, for a ZIP that matched nothing. */
  switchboard: ReactNode;
  /** "Now you know who to call" and the bills worth a call. */
  continuation: ReactNode;
};

/** The informational register: a hairline rule over a recessed ground. */
const NOTE = 'border-t-[1.5px] border-line-strong bg-wash p-4 text-sm text-ink-2';

export function RepsLookup({ initial, legacy, preview, switchboard, continuation }: Props) {
  const t = useTranslations('reps');
  const locale = useLocale();
  // The no-JS answer (way 2) arrives as this state; with JavaScript the
  // dispatcher is only ever the native form's action, never called here.
  const [formState, formAction] = useActionState(lookupMembers, initial, repsPermalink(locale));
  // Lookups made with JavaScript (way 1). `undefined` until the first one.
  const [live, setLive] = useState<MembersResult | null | undefined>(undefined);
  const result = live === undefined ? formState : live;
  const asking = useSearchParams().has('change');
  const latest = useRef(0);
  const scrollToHash = useRef(false);

  // On the page's first render with members already in it (way 3, or a
  // remount from the router's cache on Back): when this tab's history entry
  // remembers something else (a refinement made after the old link), look
  // that up; otherwise, for an old link, keep its lookup in the entry and
  // drop it from the address, one tick later (see above).
  useEffect(() => {
    if (!initial) return; // the prompt's arrival (SavedZipLookup) reads the entry
    const entry = currentEntry();
    if (entry && !sameEntry(entry, entryFor(initial))) {
      void lookup(entry, 'none');
      return;
    }
    if (!legacy) return;
    const id = setTimeout(() => rememberMembers(entryFor(initial), 'replace'), 0);
    return () => clearTimeout(id);
    // Once, when the page opens: `lookup` is a new function on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back and Forward between two of this page's own entries (a refinement and
  // the view before it): the router keeps this component mounted, so the
  // entry the browser moved to is looked up here.
  useEffect(() => {
    function onPopState(e: PopStateEvent) {
      const entry = readEntry(e.state);
      if (entry) void lookup(entry, 'none');
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // A saved-ZIP arrival at /reps#your-calls: the router scrolled to the hash
  // before the members were in, so scroll again once they are.
  useEffect(() => {
    if (!result || !scrollToHash.current) return;
    scrollToHash.current = false;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [result]);

  /**
   * Way 1. Resolves false when the lookup could not be made (offline).
   * `history` says what happens to this tab's history entry once the members
   * are in: 'replace' keeps them in the current entry, 'push' makes a new one
   * (Back returns to the view before it), 'none' leaves it alone (the entry
   * is where they came from: Reload, Back, Forward).
   */
  async function lookup(
    { zip, district }: MembersEntry,
    history: 'push' | 'replace' | 'none',
    fromArrival = false
  ): Promise<boolean> {
    const ticket = ++latest.current;
    // A POST body, built field by field: the ZIP is never in an address.
    const body = new FormData();
    for (const [name, value] of Object.entries({ zip, district })) if (value) body.append(name, value);
    try {
      const next = await lookupMembers(null, body);
      if (ticket !== latest.current) return true;
      scrollToHash.current = fromArrival;
      setLive(next);
      if (history !== 'none') rememberMembers(entryFor(next), history);
      return true;
    } catch {
      return false;
    }
  }

  const zipForm = (autoFocus: boolean) => (
    <ZipForm autoFocus={autoFocus} formAction={formAction} onSaved={(zip) => void lookup({ zip }, 'replace')} />
  );
  const prompt = (
    <div className="max-w-xl rounded-control border-[1.5px] border-line-strong bg-paper p-6">
      <p className="mb-4 text-lg font-bold">{t('noZip')}</p>
      {zipForm(true)}
    </div>
  );

  if (!result || asking) {
    return (
      /* A SAVED ZIP ANSWERS THIS PROMPT ON ITS OWN (owner, Q8 "a",
         2026-09-28): SavedZipLookup reads it in the browser and looks it up.
         `?change=1` is the "Change ZIP code" link's way in, so there the
         prompt stays put and the saved ZIP only pre-fills it. */
      <div className="mt-8">
        {asking ? (
          prompt
        ) : (
          <SavedZipLookup arrival={currentEntry} onLookup={(entry) => lookup(entry, 'replace', true)}>
            {prompt}
          </SavedZipLookup>
        )}
        {preview}
      </div>
    );
  }

  const { zip, districts, refined, refinedOutsideZip } = result;

  return (
    <>
      {/* WHICH ZIP, AND THE WAY TO CHANGE IT, UP TOP (owner, Q8 "a",
          2026-09-28: "The Reps tab opens on your members, with 'Change
          ZIP'"). The members may now appear without the reader typing
          anything, so the ZIP they came from is named before them, not after
          the continuation. "kept on this device only" is printed only when
          this browser really holds that ZIP (ZipKeptNote): an old shared
          /reps?zip= link keeps nothing. min-h-11: the link's hit box is 44px;
          the text stays text-sm. */}
      {districts.length > 0 && (
        <p data-zip-line="" className="mt-4 text-sm text-ink-2">
          {/* The no-break space keeps the "·" at the end of a wrapped line,
              never at the start of the next (BillCard's rule). */}
          {t('zipLine', { zip })}
          <ZipKeptNote zip={zip} />
          {' ·'}{' '}
          <Link href="/reps?change=1" className="inline-flex min-h-11 items-center underline underline-offset-2">
            {t('changeZip')}
          </Link>
        </p>
      )}

      {districts.length === 0 && (
        <div className="mt-8 max-w-xl border-t-[3px] border-ink bg-wash p-4" role="alert">
          <p className="text-2xs font-extrabold tracking-[0.1em] text-alert uppercase">{t('errorLabel')}</p>
          <p className="mt-1 font-semibold text-ink">{t('zipNotFound')}</p>
          <div className="mt-4">{zipForm(false)}</div>
        </div>
      )}

      {districts.length === 0 && switchboard}

      {refined && (
        <div className={`mt-6 max-w-read ${NOTE}`}>
          <p>
            {t('refinedNote')}
            {refinedOutsideZip && <> {t('refinedOutsideZip', { zip })}</>}
          </p>
          <p>
            {/* With JavaScript the click looks the ZIP up again, unrefined;
                without it (only an old ?district= link reaches this view with
                JavaScript off) it opens the bare page. */}
            <Link
              href="/reps"
              onClick={(e) => {
                e.preventDefault();
                void lookup({ zip }, 'push');
              }}
              className="inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-2"
            >
              {t('showAllDistricts', { zip })}
            </Link>
          </p>
        </div>
      )}

      {!refined && districts.length > 1 && (
        <>
          {/* {count}: 841 ZIPs map to 3-6 districts, and the old copy said
              "both" under six district headings (Phase-1 P1 — a miscount on
              the truth surface). The message pluralizes on the real count. */}
          <p data-multi-district className={`mt-6 max-w-read ${NOTE}`}>
            {t('multiDistrict', { count: districts.length })}
          </p>
          <AddressForm zip={zip} onRefined={(district) => lookup({ zip, district }, 'push')} />
        </>
      )}

      {districts.map((d) => {
        const noSenators = d.reps.every((r) => r.type !== 'sen');
        return (
          <section key={`${d.state}-${d.district}`} className="mt-12" aria-label={`${d.state} ${d.district}`}>
            <h2 className="text-h2 font-extrabold">
              {d.district === 0
                ? t('atLargeHeading', { state: d.state })
                : t('districtHeading', { state: d.state, district: d.district })}
            </h2>
            {noSenators && <p className={`mt-4 max-w-read ${NOTE}`}>{t('delegateNote', { state: d.state })}</p>}
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              {d.reps.map((r) => (
                <RepCard key={r.bioguide} rep={r} />
              ))}
              {d.vacancyHref && <VacantSeatCard href={d.vacancyHref} elections={d.elections} />}
            </div>
          </section>
        );
      })}

      {districts.length > 0 && continuation}
    </>
  );
}
