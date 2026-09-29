'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { voteMembersPath, type VoteMembersFile } from '@/lib/vote-members-path';

/*
 * "HOW MEMBERS VOTED" on one roll call — the member-by-member list, loaded
 * when the reader opens it.
 *
 * WHY IT IS FETCHED. Printed into the page, the list was every member of the
 * chamber on every roll call; after the 119th Congress back-fill that made
 * /bills/hr-1-119 about 3.95 MB of HTML. Everything else about the roll call
 * (the question, result, tally, date and official record) is still printed by
 * the server in components/VoteRecord.tsx, and so is "Your members on this
 * bill". Only this list moved: the build writes one static file per roll call
 * (app/votes/[file]/route.ts) and this disclosure fetches that one file, from
 * this site, the first time it opens. Nothing else is requested.
 *
 * NO USER DATA (rule 1). The request names a roll call every visitor of this
 * page already has, goes to this site only, and is sent without credentials.
 *
 * WITHOUT JAVASCRIPT the <details> still opens and says, truthfully, that the
 * official record lists how each member voted, with the link. The same line
 * stands if the fetch fails, beside a retry button.
 *
 * WHAT IT WILL NOT SAY — components/VoteRecord.tsx's rules: the record's four
 * words only, no party, no party colour, no colour for Yea or Nay.
 */

type State = { status: 'idle' | 'loading' | 'error' } | { status: 'ready'; file: VoteMembersFile };

function isMembersFile(value: unknown, id: string): value is VoteMembersFile {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<VoteMembersFile>;
  return v.id === id && Array.isArray(v.groups);
}

export function VoteMembers({
  rollCallId,
  source,
  headingId,
}: {
  rollCallId: string;
  /** The chamber's readable page for the roll call (lib/roll-call-page.ts),
   *  for the fallback line: never the XML data file. */
  source: string;
  /** The roll call's heading id; each group's heading id extends it. */
  headingId: string;
}) {
  const t = useTranslations('votes');
  const [state, setState] = useState<State>({ status: 'idle' });
  const details = useRef<HTMLDetailsElement>(null);
  const busy = useRef(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setState({ status: 'loading' });
    try {
      const res = await fetch(voteMembersPath(rollCallId), { credentials: 'omit' });
      if (!res.ok) throw new Error(String(res.status));
      const body: unknown = await res.json();
      if (!isMembersFile(body, rollCallId)) throw new Error('unexpected shape');
      if (alive.current) setState({ status: 'ready', file: body });
    } catch {
      busy.current = false;
      if (alive.current) setState({ status: 'error' });
    }
  }, [rollCallId]);

  // A reader who opened the disclosure before this component hydrated missed
  // the toggle event; load for them now.
  useEffect(() => {
    alive.current = true;
    if (details.current?.open) void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const onRecord = (
    <a
      href={source}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline hover:text-go-deep"
    >
      {t('source')}
      <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
    </a>
  );

  return (
    <details
      ref={details}
      className="group border-t border-line"
      data-vote-members=""
      data-vote-members-state={state.status}
      onToggle={(e) => {
        // Once per disclosure: `load` ignores a second call while one is in
        // flight or after the list arrived, so only a failed load retries.
        if (e.currentTarget.open) void load();
      }}
    >
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-ink hover:text-go-deep [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-stamp border-[1.5px] border-ink text-xs font-extrabold leading-none"
        >
          <span className="group-open:hidden">+</span>
          <span className="hidden group-open:inline">{'–'}</span>
        </span>
        {t('membersToggle')}
      </summary>
      <div className="pb-3">
        {/* Short status text only: the list itself is never announced as it
            arrives, since a whole chamber read aloud would bury the page. */}
        <p role="status" className="text-sm text-ink-2" data-vote-members-status="">
          {state.status === 'loading' ? t('membersLoading') : state.status === 'error' ? t('membersError') : ''}
        </p>

        {state.status === 'ready' ? (
          state.file.groups.map(({ position, members }) => (
            <section
              key={position}
              aria-labelledby={`${headingId}-${position}`}
              className="mt-3"
              data-vote-group={position}
            >
              <h4 id={`${headingId}-${position}`} className="text-sm font-extrabold text-ink tabular-nums">
                {t('group', { position: t(`position.${position}`), count: members.length })}
              </h4>
              <ul className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-x-4">
                {members.map(([id, name, stateCode]) => (
                  <li key={id}>
                    <Link
                      href={`/reps/${id}`}
                      className="inline-flex min-h-11 items-center text-sm text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                    >
                      {name}
                      {stateCode && ` (${stateCode})`}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
        ) : state.status === 'loading' ? null : (
          <>
            {state.status === 'error' && (
              <button
                type="button"
                onClick={() => void load()}
                className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-control border-[1.5px] border-line-strong px-3 py-2 text-sm font-semibold text-ink hover:border-ink"
                data-vote-members-retry=""
              >
                <RotateCcw className="h-4 w-4 flex-none" aria-hidden />
                {t('membersRetry')}
              </button>
            )}
            <p className="mt-2 flex flex-wrap items-center gap-x-1 text-sm text-ink" data-vote-members-fallback="">
              <span>{t('membersOnRecord')}</span>
              {onRecord}
            </p>
          </>
        )}
      </div>
    </details>
  );
}
