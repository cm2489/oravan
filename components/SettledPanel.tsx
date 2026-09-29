'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { usePrefs } from '@/lib/local';
import type { SettledVoteGroup } from '@/lib/settled-votes';
import type { Legislator } from '@/lib/types';
import { VacantSeatCard } from './VacantSeatCard';
import { ZipForm } from './ZipForm';
import { PartyTotals } from './PartyTotals';

/*
 * THE PANEL WHEN NO DECISION IS LEFT — what stands where the call panel
 * stands on a bill whose decision the record shows is over: a law, or a
 * rejected vote to pass it (lib/journey.ts `settledDecision`, read off the
 * stepper's own derivation). The owner's pick (a), 2026-09-29: "Only a law or
 * a failed final vote counts as finished. Procedural failures keep the call
 * panel, with a line saying the last attempt failed." So a failed motion to
 * take it up, cloture not invoked, a rejected discharge motion and a failed
 * two-thirds suspension vote all keep the call panel (with that line), and so
 * does a veto: Congress can still override it.
 *
 * The owner's ruling, 2026-09-28, UX question Q9 answered "a": "A record-only
 * block with no numbers: 'This is law' or 'This was rejected, 49–50', and how
 * your members voted. No stance, no script." And page 1, rule 6: a settled
 * decision shows no call apparatus. So there is no stance control, no script,
 * no dial and no phone number here — only the record's outcome and, once a ZIP
 * is saved, how the reader's members voted. A member's name links to their
 * page, which is where their numbers live.
 *
 * ONE ORDER, ONE CHAMBER PER LIST (owner, 2026-09-28, reviewing
 * /bills/hconres-89-119: "It's talking about the Senate but in the 'no call to
 * make' box it talks about the House vote and then says the senators
 * underneath this. That doesn't make sense and is confusing."). The panel
 * reads top to bottom as: (1) the outcome, one sentence naming the deciding
 * chamber with the record's tally and date; (2) "How your members voted", one
 * group per vote (lib/settled-votes.ts), the deciding vote first, each group
 * headed by its chamber, date and tally, and a member listed only under a
 * vote their own chamber held. A member the roll call does not list says so;
 * a vote the roll-call file does not hold says why. With no ZIP, one line and
 * the ZIP form. The open bill's "your members" strip under the vote record is
 * left off this page, so nothing is printed twice.
 *
 * It keeps the call panel's silhouette (2px ink edge, ink title bar) and its
 * `#act` anchor, the same way the nomination page's closed panel does, so an
 * old "#act" link lands on the answer rather than the page top.
 *
 * THE ZIP LOOKUP is the call panel's own request, made the same way: one
 * same-origin GET /api/reps for the saved ZIP (disclosed on /privacy). The
 * answer is joined here, in the browser, against the positions the server
 * rendered into the page for every visitor alike, and kept only in memory.
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

/** Only what the panel prints about a member — never phones, offices or party. */
type Member = Pick<Legislator, 'bioguide' | 'name' | 'state' | 'type'>;

type Lookup =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; members: Member[]; multiDistrict: boolean; vacancies: number };

/** A vote group as the page hands it over: the record's date (YYYY-MM-DD) and
 *  the same date already formatted for the page's locale. */
export type SettledVoteGroupView = SettledVoteGroup & { dateLabel: string | null };

export function SettledPanel({
  outcome,
  kind,
  groups,
  floorLabel,
}: {
  /** The outcome sentence, already translated by the page. */
  outcome: string;
  /** `SettledDecision['kind']` (`law` or `rejected`) — a test hook only. */
  kind: string;
  /** lib/settled-votes.ts `settledVoteGroups`, in print order. */
  groups: SettledVoteGroupView[];
  /** The roll-call file's first date, formatted for the page's locale. */
  floorLabel: string;
}) {
  const t = useTranslations('bill');
  const tReps = useTranslations('reps');
  const tVotes = useTranslations('votes');
  const zip = usePrefs().zip ?? null;
  const hydrated = useHydrated();
  const [lookup, setLookup] = useState<Lookup>({ status: 'idle' });
  // Set by the in-panel ZipForms' onSaved, exactly as in the call panel: the
  // submit unmounts its own form, so focus moves to the result once the
  // lookup settles — and only then, never on an ordinary load.
  const zipJustSaved = useRef(false);
  const membersRef = useRef<HTMLElement>(null);

  const fetchReps = useCallback(() => {
    if (!zip) {
      setLookup({ status: 'idle' });
      return;
    }
    setLookup({ status: 'loading' });
    fetch(`/api/reps?zip=${zip}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { reps: Legislator[]; vacancies?: unknown[]; multiDistrict?: boolean }) => {
        setLookup({
          status: 'ready',
          members: d.reps.map(({ bioguide, name, state, type }) => ({ bioguide, name, state, type })),
          multiDistrict: d.multiDistrict ?? false,
          vacancies: d.vacancies?.length ?? 0,
        });
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
      lookup.status === 'ready' && (lookup.members.length > 0 || lookup.vacancies > 0)
        ? membersRef.current
        : document.querySelector<HTMLElement>('[data-reps-alert]');
    el?.focus();
  }, [lookup]);

  const notFound = lookup.status === 'ready' && lookup.members.length === 0 && lookup.vacancies === 0;

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
        {/* (1) The outcome: the deciding chamber, the record's tally and date. */}
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

        {/* (2) How your members voted: one group per vote, the deciding vote
            first, each member only under a vote their own chamber held. */}
        {lookup.status === 'ready' && !notFound && (
          <section
            ref={membersRef}
            tabIndex={-1}
            aria-labelledby="settled-votes-h"
            className="outline-none"
            data-settled-votes=""
          >
            <h3 id="settled-votes-h" className="text-sm font-extrabold text-ink">
              {t('settled.membersHeading')}
            </h3>
            {groups.length === 0 ? (
              <p className="mt-1 text-sm text-ink-2" data-settled-no-votes="">
                {t('settled.noRollCalls', { floor: floorLabel })}
              </p>
            ) : (
              <div className="mt-3 grid gap-4">
                {groups.map((g) => {
                  const hId = `settled-vote-${g.chamber}-h`;
                  const members = lookup.members.filter((m) =>
                    g.chamber === 'senate' ? m.type === 'sen' : m.type === 'rep' && !lookup.multiDistrict
                  );
                  const unshown = g.source === 'beforeFile' || g.source === 'notInFile';
                  const note =
                    g.source === 'beforeFile'
                      ? t('settled.beforeFileNote', { floor: floorLabel })
                      : g.source === 'notInFile'
                        ? t('settled.notInFileNote')
                        : g.source === 'voice'
                          ? t('settled.voiceNote')
                          : null;
                  return (
                    <section
                      key={g.chamber}
                      aria-labelledby={hId}
                      className="border-t border-line pt-3"
                      data-settled-vote-group={g.chamber}
                      data-settled-vote-source={g.source}
                      data-settled-vote-deciding={g.deciding ? '' : undefined}
                    >
                      <h4 id={hId} className="text-sm font-semibold text-ink-2 tabular-nums">
                        {t('settled.voteIn', { chamber: g.chamber })}
                        {g.date && g.dateLabel && (
                          <>
                            {' · '}
                            <time dateTime={g.date}>{g.dateLabel}</time>
                          </>
                        )}
                        {g.tally && ` · ${g.tally.yeas}–${g.tally.nays}`}
                      </h4>
                      {/* The roll call's count by party, as one line of text
                          (owner's card l12, 2026-09-29). Only for a roll call
                          the file holds; a voice vote or a vote the file does
                          not hold has none, and prints nothing here. */}
                      <PartyTotals totals={g.totalsByParty} muted className="mt-1" />
                      {g.chamber === 'house' && lookup.multiDistrict ? (
                        <p className="mt-1 text-sm text-ink-2">{t('settled.multiDistrict')}</p>
                      ) : members.length === 0 ? (
                        g.chamber === 'house' && lookup.vacancies > 0 ? (
                          // A vacant House seat is why no House member is
                          // listed: the same card the call panel and /reps show.
                          <div className="mt-2">
                            <VacantSeatCard />
                          </div>
                        ) : (
                          <p className="mt-1 text-sm text-ink-2">
                            {t('settled.noMember', { chamber: g.chamber })}
                          </p>
                        )
                      ) : (
                        <ul className="mt-1 divide-y divide-line">
                          {members.map((m) => {
                            const p = g.positions?.[m.bioguide];
                            return (
                              <li
                                key={m.bioguide}
                                className="flex flex-wrap items-center justify-between gap-x-4 py-1"
                                data-vote-delegate={m.bioguide}
                              >
                                <Link
                                  href={`/reps/${m.bioguide}`}
                                  className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                                >
                                  {m.name} ({m.state})
                                </Link>
                                <span className="text-sm text-ink-2" data-settled-position={p ?? 'none'}>
                                  {p ? (
                                    <b className="font-extrabold text-ink">{tVotes(`position.${p}`)}</b>
                                  ) : unshown ? (
                                    t('settled.positionNotShown')
                                  ) : (
                                    t('settled.noRecordedVote')
                                  )}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {note && <p className="mt-2 text-xs text-ink-2">{note}</p>}
                    </section>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
