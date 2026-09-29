import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Chip } from '@/components/system';
import { billSlug, getAllBills, localizeBill } from '@/lib/core';
import { formatCitation } from '@/lib/format';
import { deriveJourney } from '@/lib/journey';
import type { Bill } from '@/lib/types';
import { MEMBER_VOTES_MAX_BILLS, memberVotesByBill, votesCoverage, type MemberVote } from '@/lib/votes';

/*
 * HOW THEY VOTED — the member page's vote record (owner, UX inventory R04,
 * 2026-09-28: "the bill cards with the AI Header and a short summary of the
 * bill should be show with their vote and outcome of the bill").
 *
 * One row per bill the record lists this member on (lib/votes.ts
 * memberVotesByBill), ordered by their newest vote on it. Each row is:
 *
 *   the bill        - citation, the AI headline and the AI one-line summary
 *                     (labeled once for the block, rule 4), linking to the
 *                     bill page;
 *   where it stands - the bill page's own "Right now:" sentence, from the same
 *                     reader (lib/journey.ts deriveJourney) and the same
 *                     message key, so the two pages cannot disagree about
 *                     whether it passed, failed or is still pending;
 *   their vote      - one of the record's four words (votes.position.*), then
 *                     the question and result VERBATIM in English under the
 *                     "as recorded" label, the chamber, date and roll call,
 *                     and the official record. A position alone would be a
 *                     narration: "Nay" on a motion to table is not "Nay" on
 *                     the bill, so the question always rides with it.
 *
 * WHAT IT WILL NOT SAY - the rules components/VoteRecord.tsx already keeps:
 * no party, no party colour, no colour for Yea or Nay, no score, no tally of
 * how often they "side" with anyone, no "agrees with you". Every mark is ink.
 *
 * CAPPED. At most the newest MEMBER_VOTES_MAX_BILLS bills (lib/votes.ts): the
 * first SHOWN open, the rest of those under "Show all". Past the cap, one
 * plain line counts the bills left out and says each bill's page lists its
 * recorded votes, which is true: components/VoteRecord.tsx shows every stored
 * roll call on the bill and every member's position on it.
 *
 * STATIC. A server component; the rows past the first batch sit in a closed
 * <details>, so nothing here ships to the browser as JavaScript and no corpus
 * crosses into a client module (scripts/check-client-imports.mjs).
 *
 * ABSENCE. A member the record lists on no stored roll call gets the section
 * with one plain sentence and its date window, not a hidden section: the rep
 * cards and the call panel link here unconditionally, so the anchor must
 * always land on something true.
 */

/** Bills shown before the rest fold into a disclosure. */
const SHOWN = 6;

let bySlug: Map<string, Bill> | null = null;
function billFor(slug: string): Bill | undefined {
  bySlug ??= new Map(getAllBills().map((b) => [billSlug(b), b]));
  return bySlug.get(slug);
}

export async function MemberVotes({
  bioguide,
  name,
  locale,
}: {
  bioguide: string;
  name: string;
  locale: string;
}) {
  const t = await getTranslations('rep');
  const tVotes = await getTranslations('votes');
  const tJourney = await getTranslations('bill.journey');
  const tCommon = await getTranslations('common');
  const format = await getFormatter();
  const fmtDate = (d: string) =>
    format.dateTime(new Date(d), { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const since = fmtDate(votesCoverage().floor);

  const groups = memberVotesByBill(bioguide);

  /** The bill page's "Right now:" sentence (components/BillJourney.tsx),
   *  without its "if the other chamber changes it" trailer and without the
   *  glossary link on the calendar phrase: same key, same values. */
  const rightNow = (bill: Bill) => {
    const journey = deriveJourney(bill);
    const chamber = journey.origin === 'house' ? 'House' : 'Senate';
    const other = chamber === 'House' ? 'Senate' : 'House';
    const nowChamber = journey.nowChamber === 'house' ? 'House' : 'Senate';
    const tally = journey.tally
      ? { tally: 'yes', yeas: journey.tally.yeas, nays: journey.tally.nays }
      : { tally: 'none', yeas: 0, nays: 0 };
    return {
      key: journey.nowKey,
      text: tJourney.rich(journey.nowKey, {
        chamber: nowChamber,
        other,
        floorCalendar: (chunks: ReactNode) => <>{chunks}</>,
        ...tally,
      }),
    };
  };

  const vote = ({ rollCall: r, position }: MemberVote) => (
    <div data-member-vote-roll={r.id}>
      <p className="text-sm text-ink">
        <span className="font-semibold text-ink-2">{t('votesTheirVote')}</span>{' '}
        <strong className="font-extrabold" data-member-vote-position={position}>
          {tVotes(`position.${position}`)}
        </strong>
      </p>
      <p className="mt-2 text-xs font-semibold text-ink-2">{tVotes('asRecorded')}</p>
      <dl className="mt-1 grid gap-1 text-ink">
        <div>
          <dt className="sr-only">{tVotes('question')}</dt>
          <dd lang="en" className="text-sm font-semibold" data-member-vote-question="">
            {r.question}
          </dd>
        </div>
        <div className="text-sm">
          <dt className="inline font-semibold">{tVotes('result')}: </dt>
          <dd lang="en" className="inline">
            {r.result}
          </dd>
        </div>
      </dl>
      <p className="mt-1 flex flex-wrap items-center gap-x-1 text-sm text-ink-2 tabular-nums">
        <span>
          {tVotes(`chamber.${r.chamber}`)} · <time dateTime={r.date}>{fmtDate(r.date)}</time> ·{' '}
          {tVotes('roll', { roll: r.roll })} ·
        </span>
        <a
          href={r.source}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline hover:text-go-deep"
        >
          {tVotes('source')}
          <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
        </a>
      </p>
    </div>
  );

  const row = ({ bill: id, votes }: (typeof groups)[number]) => {
    const raw = billFor(id);
    const bill = raw ? localizeBill(raw, locale) : undefined;
    const [newest, ...earlier] = votes;
    const now = bill ? rightNow(bill) : null;
    return (
      <li
        key={id}
        className="rounded-control border border-line-strong bg-paper p-5"
        data-member-vote-bill={id}
      >
        {bill && (
          <>
            <p className="text-xs leading-tight font-bold tracking-[0.06em] text-ink-2 tabular-nums">
              {formatCitation(bill.bill_type, bill.bill_number)}
            </p>
            <h3 className="mt-1 text-lg leading-tight font-bold">
              <Link
                href={`/bills/${id}`}
                className="inline-flex min-h-11 items-center text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
              >
                {bill.ai_headline ?? bill.short_title ?? bill.title}
              </Link>
            </h3>
            {bill.ai_sections?.tldr && (
              <p className="mt-1 max-w-read text-sm text-ink-2">{bill.ai_sections.tldr}</p>
            )}
            {now && (
              <p className="mt-2 max-w-read text-sm text-ink-2" data-member-vote-now={now.key}>
                <strong className="font-bold text-ink">{tJourney('now')}</strong> {now.text}
              </p>
            )}
          </>
        )}
        <div className="mt-3 border-t border-line pt-3">{vote(newest)}</div>
        {earlier.length > 0 && (
          <details className="group mt-2 border-t border-line">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-ink hover:text-go-deep [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden
                className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-stamp border-[1.5px] border-ink text-xs font-extrabold leading-none"
              >
                <span className="group-open:hidden">+</span>
                <span className="hidden group-open:inline">{'–'}</span>
              </span>
              {t('votesMoreOnBill', { count: earlier.length })}
            </summary>
            <ol className="grid gap-3 pb-1">
              {earlier.map((v) => (
                <li key={v.rollCall.id} className="border-t border-line pt-3 first:border-t-0 first:pt-1">
                  {vote(v)}
                </li>
              ))}
            </ol>
          </details>
        )}
      </li>
    );
  };

  const listed = groups.slice(0, MEMBER_VOTES_MAX_BILLS);
  const olderBills = groups.length - listed.length;
  const shown = listed.slice(0, SHOWN);
  const rest = listed.slice(SHOWN);

  return (
    <section id="votes" aria-labelledby="rep-votes" className="mt-12" data-member-votes="">
      <div className="border-t-[3px] border-ink pt-4">
        <h2 id="rep-votes" className="text-h2 font-extrabold">
          {t('votesHeading')}
        </h2>
      </div>
      {groups.length > 0 ? (
        <>
          <p className="mt-3 max-w-read text-sm text-ink-2 tabular-nums">
            {t('votesNote', { count: groups.length, date: since })}
          </p>
          <p className="mt-3">
            <Chip tone="ai" marker={tCommon('aiMarker')}>
              {t('votesAiNote')}
            </Chip>
          </p>
          <ol className="mt-4 grid gap-4">{shown.map(row)}</ol>
          {rest.length > 0 && (
            <details className="mt-4 border-t border-line pt-2" data-member-votes-all="">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-bold select-none">
                {t('showAll', { count: listed.length })}
              </summary>
              <ol className="mt-2 grid gap-4">{rest.map(row)}</ol>
            </details>
          )}
          {olderBills > 0 && (
            <p className="mt-4 max-w-read text-sm text-ink-2 tabular-nums" data-member-votes-older={olderBills}>
              {t('votesOlder', { count: olderBills })}
            </p>
          )}
        </>
      ) : (
        <p className="mt-3 max-w-read text-sm text-ink-2" data-member-votes-none="">
          {t('votesNone', { name, date: since })}
        </p>
      )}
    </section>
  );
}
