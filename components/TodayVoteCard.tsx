import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { glossaryTagOnce, glossify } from '@/components/glossary-tags';
import type { GlossaryTermId } from '@/lib/glossary';
import { Link } from '@/i18n/navigation';
import { rollCallPage } from '@/lib/roll-call-page';
import type { BriefRollCall } from '@/lib/today';

/*
 * ONE ROLL CALL ON /today, as a card (owner, 2026-09-29: "cards similar to
 * the bills page").
 *
 * TWO LINKS, SO NOT ONE LINK: the headline opens the bill's page (its decoded
 * answer), and "Official tally" opens the chamber's own readable roll-call
 * page in a new tab (lib/roll-call-page.ts). A whole-card link could carry
 * only one of them, so the headline is the card's link and the tally is a
 * second, both at least 44px tall.
 *
 * THE RECORD'S OWN WORDS: the question and the result print exactly as the
 * chamber recorded them, in English on /es too (ruling V4, `lang="en"`), with
 * glossary terms matched as English. One card is one glossary section: the
 * tally's labels are wired by name, sharing the card's `seen` set with the
 * record's lines, so a term opens once per card.
 *
 * The headline is the /bills card's (lib/core/bills.ts `teaserFor`): the AI
 * headline in the reader's language when the bill has one — labelled once for
 * the block by components/TodayBrief.tsx — else the record's English title.
 * Server-rendered; it imports only a type from lib/today.
 */

const LINK =
  'font-semibold text-go underline underline-offset-4 visited:text-go-deep hover:text-go-deep';

export function TodayVoteCard({ vote, chamberName }: { vote: BriefRollCall; chamberName: string }) {
  const t = useTranslations('today');
  const seen = new Set<GlossaryTermId>();
  const headline = vote.teaser?.headline ?? null;

  return (
    <article
      className="flex h-full flex-col rounded-control border border-line-strong bg-paper p-5"
      data-vote-card={vote.id}
    >
      <p className="flex flex-wrap gap-x-2 text-xs leading-tight font-bold tracking-[0.06em] text-ink-2 uppercase">
        <span className="whitespace-nowrap">
          {t('voteRoll', { chamber: chamberName, roll: vote.roll })}
          <span aria-hidden> ·</span>
        </span>
        <span className="whitespace-nowrap tabular-nums normal-case">{vote.bill.citation}</span>
      </p>
      <h3 className="mt-1 text-lg leading-tight font-bold text-ink">
        <Link
          href={`/bills/${vote.bill.slug}`}
          className="inline-flex min-h-11 items-center hover:underline hover:decoration-go hover:decoration-[3px]"
        >
          {headline ?? <span lang="en">{vote.bill.title}</span>}
        </Link>
      </h3>
      <p className="mt-2 text-md text-ink">
        <span lang="en">{glossify(vote.question, 'en', seen)}</span>
        {' — '}
        <span lang="en" className="font-bold">
          {glossify(vote.result, 'en', seen)}
        </span>
      </p>
      <p className="mt-1 text-sm text-ink-2 tabular-nums" data-brief-tally="">
        {t.rich('tally', {
          ...vote.totals,
          yeaTerm: glossaryTagOnce('yea-and-nay', seen),
          presentTerm: glossaryTagOnce('present-vote', seen),
          notVotingTerm: glossaryTagOnce('not-voting', seen),
        })}
      </p>
      <p className="mt-auto pt-2">
        <a
          href={rollCallPage(vote.source)}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex min-h-11 items-center gap-1.5 text-sm ${LINK}`}
        >
          {t('voteSource')}
          <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
        </a>
      </p>
    </article>
  );
}
