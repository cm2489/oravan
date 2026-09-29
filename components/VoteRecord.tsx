import { ExternalLink } from 'lucide-react';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { GlossaryTerm } from '@/components/GlossaryTerm';
import { glossify } from '@/components/glossary-tags';
import { PartyTotals } from '@/components/PartyTotals';
import type { GlossaryTermId } from '@/lib/glossary';
import { glossaryLocale } from '@/lib/glossary-match';
import { getLegislator } from '@/lib/core';
import type { RollCall, VotePosition } from '@/lib/types';
import { votesCoverage, votesForBill, votingMember } from '@/lib/votes';
import { VoteDelegation, type DelegationVote } from './VoteDelegation';

/*
 * THE VOTE RECORD — every stored roll call on this bill, newest first, as the
 * official record states it (data/votes.json, read through lib/votes.ts).
 *
 * WHAT IT WILL NOT SAY. A member's position is one of the record's four words
 * — Yea / Nay / Present / Not voting (votes.position.*) — and nothing else: no
 * "sided with", no "for/against the bill", no party beside a member, no party
 * color, no green for Yea or alert-red for Nay. Every mark here is ink. The question and the
 * result are the record's own English, verbatim in BOTH locales under an
 * "as recorded" label: a translated question is a paraphrase of an official
 * record, and the record is English.
 *
 * ABSENCE. A bill with no stored roll call renders NOTHING — no heading, no
 * "no votes yet". The coverage line says what window the file covers, so a
 * reader who does see the block knows how far back it reaches.
 *
 * NAMES come from data/legislators.json joined on bioguide, with the roster in
 * votes.json as the fallback for a member who has since left. State follows
 * the name; party never does.
 *
 * GLOSSARY (2026-09-28). The record's own lines are where the jargon is densest
 * ("On Motion to Suspend the Rules and Pass", "Cloture on the Motion to Proceed
 * Rejected"), so the terms in them open in place. They are matched as ENGLISH
 * on both locales, because the words are the record's English; the definition
 * that opens is in the page's language. The words themselves are unchanged —
 * the mark is on the record's text, never a rewrite of it. The four position
 * labels carry their entries too. Each roll call is one section: a term is
 * marked once per card.
 *
 * THE COUNT BY PARTY (2026-09-29, the owner's card l12: "Show me these. I
 * don't see them."). Under each tally, one line of text gives the record's own
 * count party by party (components/PartyTotals.tsx, from the roll call's
 * `totalsByParty`): largest group first, ink like the tally above it, no
 * colour, no member named. It is a count of the roll call, never a label on a
 * person, so the member list below still carries no party.
 */

/** The entry each tally label opens. Yea and Nay share one; Yea carries it. */
const POSITION_TERM: Partial<Record<VotePosition, GlossaryTermId>> = {
  yea: 'yea-and-nay',
  present: 'present-vote',
  notVoting: 'not-voting',
};

const VISIBLE = 3;
const POSITIONS: VotePosition[] = ['yea', 'nay', 'present', 'notVoting'];
const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;

interface Named {
  id: string;
  name: string;
  state: string;
  last: string;
}

function named(id: string): Named {
  const l = getLegislator(id);
  if (l) return { id, name: l.name, state: l.state, last: l.last };
  const m = votingMember(id);
  const name = m?.name ?? id;
  const parts = name.replace(/,/g, '').split(/\s+/).filter((p) => !SUFFIX.test(p));
  return { id, name, state: m?.state ?? '', last: parts[parts.length - 1] ?? name };
}

function byLastName(a: Named, b: Named) {
  return a.last.localeCompare(b.last, 'en') || a.name.localeCompare(b.name, 'en');
}

/**
 * What the "your members on this bill" strip needs: the newest roll call per
 * chamber, reduced to the positions it prints — never the whole file — plus
 * the file's floor date for the "no recorded vote since" line. A settled
 * bill's record-only panel prints its own per-vote groups instead
 * (lib/settled-votes.ts), so the page turns this strip off there.
 */
function delegationVotesFor(
  billId: string,
  fmtDate: (d: string) => string
): { house: DelegationVote | null; senate: DelegationVote | null; floorLabel: string } {
  const rollCalls = votesForBill(billId);
  const newestIn = (chamber: RollCall['chamber']): DelegationVote | null => {
    const r = rollCalls.find((x) => x.chamber === chamber);
    if (!r) return null;
    const positions: Record<string, VotePosition> = {};
    for (const p of POSITIONS) for (const id of r.votes[p]) positions[id] = p;
    return { date: fmtDate(r.date), positions };
  };
  return {
    house: newestIn('house'),
    senate: newestIn('senate'),
    floorLabel: fmtDate(votesCoverage().floor),
  };
}

export async function VoteRecord({
  billId,
  className = '',
  delegation = true,
}: {
  billId: string;
  className?: string;
  /** False on a settled bill, whose record-only panel shows how the
   *  reader's members voted, one vote at a time. */
  delegation?: boolean;
}) {
  const rollCalls = votesForBill(billId);
  if (rollCalls.length === 0) return null;

  const t = await getTranslations('votes');
  const format = await getFormatter();
  const lang = glossaryLocale(await getLocale());
  const fmtDate = (d: string) =>
    format.dateTime(new Date(d), { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const { house, senate, floorLabel } = delegationVotesFor(billId, fmtDate);

  const entry = (r: RollCall) => {
    const hId = `vote-${r.id}`;
    const seen = new Set<GlossaryTermId>();
    return (
      <li
        key={r.id}
        className="rounded-control border border-line-strong px-4 pt-3 pb-2"
        data-vote-roll={r.id}
      >
        <h3 id={hId} className="text-sm font-semibold text-ink-2 tabular-nums">
          {t(`chamber.${r.chamber}`)} · <time dateTime={r.date}>{fmtDate(r.date)}</time> ·{' '}
          {t('roll', { roll: r.roll })}
        </h3>

        <p className="mt-2 text-xs font-semibold text-ink-2" data-vote-as-recorded="">
          {t('asRecorded')}
        </p>
        <dl className="mt-1 grid gap-1 text-ink">
          <div>
            <dt className="sr-only">{t('question')}</dt>
            <dd lang="en" className="font-semibold" data-vote-question="">
              {glossify(r.question, 'en', seen)}
            </dd>
          </div>
          <div className="text-sm">
            <dt className="inline font-semibold">{t('result')}: </dt>
            <dd lang="en" className="inline" data-vote-result="">
              {glossify(r.result, 'en', seen)}
            </dd>
          </div>
        </dl>

        <dl
          aria-label={t('tally')}
          className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-3 text-sm min-[30rem]:grid-cols-4"
        >
          {POSITIONS.map((p) => {
            // A label joins the card's section like any other term: marked
            // once, so the tie-breaker line below does not mark "Yea" again.
            const term = POSITION_TERM[p];
            const mark = term && !seen.has(term) ? term : null;
            if (mark) seen.add(mark);
            return (
              <div key={p} className="flex items-baseline justify-between gap-2 min-[30rem]:block">
                <dt className="text-ink-2">
                  {mark ? (
                    <GlossaryTerm id={mark}>{t(`position.${p}`)}</GlossaryTerm>
                  ) : (
                    t(`position.${p}`)
                  )}
                </dt>
                <dd className="font-extrabold text-ink tabular-nums" data-vote-total={p}>
                  {r.totals[p]}
                </dd>
              </div>
            );
          })}
        </dl>

        <PartyTotals totals={r.totalsByParty} className="mt-2" />

        {r.tieBreaker && (
          <p className="mt-2 text-sm text-ink">
            {glossify(t('tieBreaker', { position: t(`position.${r.tieBreaker.position}`) }), lang, seen)}
          </p>
        )}

        <a
          href={r.source}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-go underline hover:text-go-deep"
        >
          {t('source')}
          <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
        </a>

        <details className="group border-t border-line" data-vote-members="">
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
            {POSITIONS.filter((p) => r.votes[p].length > 0).map((p) => {
              const members = r.votes[p].map(named).sort(byLastName);
              return (
                <section key={p} aria-labelledby={`${hId}-${p}`} className="mt-3" data-vote-group={p}>
                  <h4 id={`${hId}-${p}`} className="text-sm font-extrabold text-ink tabular-nums">
                    {t('group', { position: t(`position.${p}`), count: members.length })}
                  </h4>
                  <ul className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-x-4">
                    {members.map((m) => (
                      <li key={m.id}>
                        <Link
                          href={`/reps/${m.id}`}
                          className="inline-flex min-h-11 items-center text-sm text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                        >
                          {m.name}
                          {m.state && ` (${m.state})`}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </details>
      </li>
    );
  };

  const shown = rollCalls.slice(0, VISIBLE);
  const earlier = rollCalls.slice(VISIBLE);

  return (
    <section aria-labelledby="votes-h" className={className} data-vote-record="">
      <h2 id="votes-h" className="text-h3 font-extrabold text-ink">
        {t('heading')}
      </h2>
      <p className="mt-1 text-sm text-ink-2 tabular-nums">{t('coverage', { date: floorLabel })}</p>

      {delegation && <VoteDelegation house={house} senate={senate} floorLabel={floorLabel} />}

      <ol className="mt-4 grid gap-3">{shown.map(entry)}</ol>

      {earlier.length > 0 && (
        <details className="group/earlier mt-3">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-ink hover:text-go-deep [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden
              className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-stamp border-[1.5px] border-ink text-xs font-extrabold leading-none"
            >
              <span className="group-open/earlier:hidden">+</span>
              <span className="hidden group-open/earlier:inline">{'–'}</span>
            </span>
            {t('earlier', { count: earlier.length })}
          </summary>
          <ol className="mt-2 grid gap-3">{earlier.map(entry)}</ol>
        </details>
      )}
    </section>
  );
}
