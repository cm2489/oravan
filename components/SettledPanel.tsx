'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePrefs } from '@/lib/local';
import { shareRepLookup } from '@/lib/rep-lookup-share';
import type { Legislator } from '@/lib/types';
import { VacantSeatCard } from './VacantSeatCard';
import { VoteDelegation, type DelegationVote } from './VoteDelegation';
import { ZipForm } from './ZipForm';

/*
 * THE PANEL WHEN NO DECISION IS LEFT — what stands where the call panel
 * stands on a bill whose decision the record shows is over: a law, a
 * rejected passage vote, a failed two-thirds vote to pass it, a failed motion
 * to take it up (lib/journey.ts `settledDecision`, read off the stepper's own
 * derivation). A veto is not one of them: Congress can still override it, so
 * a vetoed bill keeps the call panel.
 *
 * The owner's ruling, 2026-09-28, UX question Q9 answered "a": "A record-only
 * block with no numbers: 'This is law' or 'This was rejected, 49–50', and how
 * your members voted. No stance, no script." And page 1, rule 6: a settled
 * decision shows no call apparatus. So there is no stance control, no script,
 * no dial and no phone number here — only the record's outcome and, once a ZIP
 * is saved, each of the reader's members beside their position on the newest
 * roll call in their own chamber (the same strip the vote record carries on an
 * open bill, which the page leaves out below so it is not printed twice). A
 * member's name links to their page, which is where their numbers live.
 *
 * It keeps the call panel's silhouette (2px ink edge, ink title bar) and its
 * `#act` anchor, the same way the nomination page's closed panel does, so an
 * old "#act" link lands on the answer rather than the page top.
 *
 * THE ZIP LOOKUP is the call panel's own request, made the same way: one
 * same-origin GET /api/reps for the saved ZIP (disclosed on /privacy), shared
 * in memory with the strip (lib/rep-lookup-share.ts). Nothing is stored.
 */

/** The call panel's title-bar geometry (components/ActionPanel.tsx). */
const INNER_RADIUS = 'calc(var(--radius-control)-2px)';

/** The call panel's quiet control (components/ActionPanel.tsx GHOST). */
const GHOST =
  'inline-flex min-h-11 items-center gap-1.5 rounded-control border-[1.5px] border-line-strong px-3 py-2 text-sm font-semibold text-ink hover:border-ink';

/* The saved ZIP lives in this browser only, so the server render (and the
   hydration pass) cannot know it. Until hydration the members slot stays
   empty, so a returning reader never sees the ZIP prompt flash up and vanish
   (the OfficeHoursNote idiom). */
const emptySubscribe = () => () => {};
const useHydrated = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

type Lookup =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; reps: number; vacancies: number };

export function SettledPanel({
  outcome,
  kind,
  house,
  senate,
  floorLabel,
}: {
  /** The outcome sentence, already translated by the page. */
  outcome: string;
  /** `SettledDecision['kind']` — a test hook only. */
  kind: string;
  house: DelegationVote | null;
  senate: DelegationVote | null;
  floorLabel: string;
}) {
  const t = useTranslations('bill');
  const tReps = useTranslations('reps');
  const zip = usePrefs().zip ?? null;
  const hydrated = useHydrated();
  const [lookup, setLookup] = useState<Lookup>({ status: 'idle' });
  // Set by the in-panel ZipForms' onSaved, exactly as in the call panel: the
  // submit unmounts its own form, so focus moves to the result once the
  // lookup settles — and only then, never on an ordinary load.
  const zipJustSaved = useRef(false);
  const membersRef = useRef<HTMLDivElement>(null);

  const fetchReps = useCallback(() => {
    shareRepLookup(null);
    if (!zip) {
      setLookup({ status: 'idle' });
      return;
    }
    setLookup({ status: 'loading' });
    fetch(`/api/reps?zip=${zip}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { reps: Legislator[]; vacancies?: unknown[]; multiDistrict?: boolean }) => {
        shareRepLookup({ zip, reps: d.reps, multiDistrict: d.multiDistrict ?? false });
        setLookup({ status: 'ready', reps: d.reps.length, vacancies: d.vacancies?.length ?? 0 });
      })
      .catch(() => setLookup({ status: 'error' }));
  }, [zip]);

  // Deferred a tick, as in the call panel: fetchReps sets 'loading'
  // synchronously, which react-hooks/set-state-in-effect forbids inside the
  // effect's own commit.
  useEffect(() => {
    const id = setTimeout(fetchReps, 0);
    return () => clearTimeout(id);
  }, [fetchReps]);

  const onZipSaved = useCallback(() => {
    zipJustSaved.current = true;
  }, []);

  useEffect(() => {
    if (!zipJustSaved.current) return;
    if (lookup.status === 'idle' || lookup.status === 'loading') return;
    zipJustSaved.current = false;
    const el =
      lookup.status === 'ready' && lookup.reps > 0
        ? membersRef.current
        : document.querySelector<HTMLElement>('[data-reps-alert]');
    el?.focus();
  }, [lookup]);

  const notFound = lookup.status === 'ready' && lookup.reps === 0 && lookup.vacancies === 0;

  return (
    <section
      aria-labelledby="act"
      data-settled-panel={kind}
      className="w-full rounded-control border-2 border-ink bg-paper"
    >
      <h2
        id="act"
        className="bg-ink-deep px-5 py-3 text-xs leading-tight font-bold tracking-[0.06em] text-paper uppercase"
        style={{ borderRadius: `${INNER_RADIUS} ${INNER_RADIUS} 0 0` }}
      >
        {t('settled.title')}
      </h2>
      <div className="grid gap-5 p-4 md:p-6">
        <p className="max-w-note text-lg font-bold text-ink" data-settled-outcome="">
          {outcome}
        </p>

        {hydrated && !zip && (
          <div className="rounded-control border-[1.5px] border-line-strong bg-paper p-4">
            <p className="mb-3 text-sm font-semibold text-ink">{t('settled.needZip')}</p>
            <ZipForm onSaved={onZipSaved} />
          </div>
        )}

        {lookup.status === 'loading' && (
          <p role="status" className="text-sm text-ink-2">
            {t('repsLoading')}
          </p>
        )}

        {/* The call panel's failure register: a 3px rule, a bold label and
            role="alert", the alert colour never the only carrier. */}
        {lookup.status === 'error' && (
          <div
            data-reps-alert
            tabIndex={-1}
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-control border-l-[3px] border-alert bg-wash px-4 py-3 text-sm"
          >
            <span className="font-bold text-alert">{t('repsError')}</span>
            <button type="button" onClick={fetchReps} className={GHOST}>
              <RotateCcw className="h-4 w-4 flex-none" aria-hidden />
              {t('retry')}
            </button>
          </div>
        )}

        {/* A saved ZIP that matched nothing: /reps's own words, and the form
            again so it can be corrected here. */}
        {notFound && (
          <div data-reps-alert tabIndex={-1} role="alert" className="border-t-[3px] border-ink bg-wash p-4">
            <p className="text-2xs font-extrabold tracking-[0.1em] text-alert uppercase">
              {tReps('errorLabel')}
            </p>
            <p className="mt-1 text-sm font-semibold text-ink">{tReps('zipNotFound')}</p>
            <div className="mt-3">
              <ZipForm onSaved={onZipSaved} />
            </div>
          </div>
        )}

        {lookup.status === 'ready' && !notFound && (
          <div ref={membersRef} tabIndex={-1} className="outline-none">
            <VoteDelegation house={house} senate={senate} floorLabel={floorLabel} variant="panel" />
            {/* A vacant House seat is why no House member is listed — the
                same ink card the call panel and /reps show. */}
            {lookup.vacancies > 0 && (
              <div className="mt-3">
                <VacantSeatCard />
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
