import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Chip } from '@/components/system';
import { GlossaryTerm } from '@/components/GlossaryTerm';
import { glossify } from '@/components/glossary-tags';
import { billSlug, getAllBills, localizeBill } from '@/lib/core';
import { formatCitation } from '@/lib/format';
import { rollCallPage } from '@/lib/roll-call-page';
import { deriveJourney } from '@/lib/journey';
import { adoptedConcurrentReading } from '@/lib/concurrent-explainer';
import { ConcurrentExplainer } from '@/components/ConcurrentExplainer';
import type { GlossaryTermId } from '@/lib/glossary';
import { lawRecord } from '@/lib/law-record';
import { getLiveMoments, vehicleKind } from '@/lib/moments';
import { statusWord, type StatusWord } from '@/lib/status-word';
import type { Bill, VotePosition } from '@/lib/types';
import { MEMBER_VOTES_MAX_BILLS, memberVotesByBill, votesCoverage, type MemberVote } from '@/lib/votes';

/*
 * HOW THEY VOTED — the member page's vote record (owner, UX inventory R04,
 * 2026-09-28: "the bill cards with the AI Header and a short summary of the
 * bill should be show with their vote and outcome of the bill"), rebuilt to
 * the decided wireframe (v2, member.html, 2026-09-29).
 *
 * One card per bill the record lists this member on (lib/votes.ts
 * memberVotesByBill), ordered by their newest vote on it. Each card is:
 *
 *   the bill        - citation, and "Big Question: <its name>" when a live
 *                     question claims it as a vehicle (data/moments.json, the
 *                     same backlink rule the bill page uses);
 *   one word        - where the bill stands, from a CLOSED set of five: Open,
 *                     Law, Agreed to, Rejected, Vetoed (lib/status-word.ts,
 *                     read through the bill page's own readers). Ink text in
 *                     small capitals, never a colour (rule 3);
 *   the AI layer    - the headline and the one-line summary, labeled once for
 *                     the block (rule 4), linking to the bill page;
 *   their vote      - one of the record's four words (votes.position.*),
 *                     glossed in place, then the question and result VERBATIM
 *                     in English under the "as recorded" label with the
 *                     record's own tally, the chamber, date and roll call, and
 *                     the official record. A position alone would be a
 *                     narration: "Nay" on a motion to table is not "Nay" on
 *                     the bill, so the question always rides with it. The
 *                     record's own words are glossed where the glossary has
 *                     them ("concurrent resolution", "cloture on the motion
 *                     to proceed"), once per card, as components/VoteRecord.tsx
 *                     does for the same lines;
 *   the record line - only behind a word that says the measure is finished:
 *                     "Became law <date> · Public Law <n>" (lib/law-record.ts)
 *                     under Law, and the bill page's own "Right now:" sentence
 *                     under Rejected, Vetoed and Agreed to, from the same
 *                     reader (lib/journey.ts deriveJourney) and the same
 *                     message key, so the two pages cannot disagree. That is
 *                     where a House member's page learns that the Senate
 *                     rejected the concurrent resolution their chamber passed.
 *                     An adopted concurrent resolution keeps its explainer
 *                     (lib/concurrent-explainer.ts). An Open card has no line:
 *                     the headline leads to the bill page, whose stepper says
 *                     where it stands and whose panel is the call.
 *
 * WHAT IT WILL NOT SAY - the rules components/VoteRecord.tsx already keeps:
 * no party, no party colour, no colour for Yea or Nay, no score, no tally of
 * how often they "side" with anyone, no "agrees with you". Every mark is ink.
 *
 * CAPPED, BY ROLL CALLS. At most the newest MEMBER_VOTES_MAX_BILLS bills
 * (lib/votes.ts): the first SHOWN open, the rest of those under "Show N more".
 * Each card prints ONE roll call, the member's newest on that bill; when they
 * cast more, one link says how many and goes to the bill page's vote record
 * (its `#votes` section), which lists every stored roll call on the bill. So
 * the page prints at most MEMBER_VOTES_MAX_BILLS roll calls, however many a
 * bill collects (2026-09-29: with the 119th Congress back-filled, printing
 * every vote per bill let one bill add 47). Past the bill cap, one plain line
 * counts the bills left out and says each bill's page lists its recorded
 * votes.
 *
 * THE FILTER, All / Big Questions (M05, drawn on member.html), IS HTML AND
 * CSS ONLY: two radio buttons, and `:has()` on this section hides every card
 * that is not a Big Question vehicle while the second is checked. So it works
 * with JavaScript off, and nothing here ships to the browser as a script. The
 * fold cannot be opened by CSS, so under the filter the fold steps aside and
 * a second, short list carries the Big Question cards the fold held (at most
 * the few bills live questions name — 20 across all of them on 2026-09-29);
 * those duplicate cards carry their own data hooks, never the main list's. A
 * member with no Big Question vehicle gets no filter at all.
 *
 * STATIC. A server component; the cards past the first batch sit in a closed
 * <details>, so no corpus crosses into a client module
 * (scripts/check-client-imports.mjs). The glossed terms are the one client
 * island, and each carries only its own two strings.
 *
 * ABSENCE. A member the record lists on no stored roll call gets the section
 * with one plain sentence and its date window, not a hidden section: the rep
 * cards and the call panel link here unconditionally, so the anchor must
 * always land on something true.
 */

/** Bills shown before the rest fold into a disclosure (member.html: "five
 *  shown, then Show more"). */
const SHOWN = 5;

/** The entry each position word opens. Yea and Nay share one (the same map
 *  components/VoteRecord.tsx keeps for its tally labels). */
const POSITION_TERM: Record<VotePosition, GlossaryTermId> = {
  yea: 'yea-and-nay',
  nay: 'yea-and-nay',
  present: 'present-vote',
  notVoting: 'not-voting',
};

/** The words behind which a card prints the bill page's own sentence. */
const SETTLED_SENTENCE: ReadonlySet<StatusWord> = new Set(['rejected', 'vetoed', 'agreed']);

/** Hidden while "Big Questions" is the checked filter (see the header). */
const HIDE_UNDER_BQ = 'group-has-[#member-votes-bq:checked]/votes:hidden';

/** One filter option: components/EmbedConfigurator.tsx's radio label, at the
 *  44px floor. */
const FILTER_OPTION =
  'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-control border-[1.5px] border-line-strong bg-paper px-3 text-sm font-semibold text-ink tabular-nums has-[:checked]:border-ink has-[:checked]:bg-tint';

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
  const tBills = await getTranslations('bills');
  const tCommon = await getTranslations('common');
  const format = await getFormatter();
  const fmtDate = (d: string) =>
    format.dateTime(new Date(d), { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  // The window the vote file covers and when it last changed: the data's
  // span and its age, printed (rule 6; member.html: "since … Updated …").
  const coverage = votesCoverage();
  const since = fmtDate(coverage.floor);
  const updated = fmtDate(coverage.updatedAt);
  const lang = locale === 'es' ? 'es' : 'en';

  const groups = memberVotesByBill(bioguide);

  // The Big Question each bill is a vehicle of, by the bill page's own
  // backlink rule (live and past-review questions; lib/moments.ts
  // momentClaimsVehicles). Its name is the question's own.
  const questionOf = new Map<string, string>();
  for (const m of getLiveMoments()) {
    for (const v of m.vehicles) {
      if (vehicleKind(v) === 'bill' && !questionOf.has(v.slug)) questionOf.set(v.slug, m.name[lang]);
    }
  }

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
    // The one dated sentence (`nowPointOfOrderUpheld`) opens {hasDate}; supply
    // it on every key, formatted as BillJourney formats it (long month, UTC),
    // or the member page prints the raw key instead of the sentence.
    const when = journey.date
      ? { hasDate: 'yes', date: fmtDate(journey.date) }
      : { hasDate: 'none', date: '' };
    return {
      key: journey.nowKey,
      text: tJourney.rich(journey.nowKey, {
        chamber: nowChamber,
        other,
        floorCalendar: (chunks: ReactNode) => <>{chunks}</>,
        ...tally,
        ...when,
      }),
    };
  };

  /** The record's word for a position, glossed the first time the card
   *  prints its entry. */
  const positionWord = (position: VotePosition, seen: Set<GlossaryTermId>) => {
    const term = POSITION_TERM[position];
    const word = tVotes(`position.${position}`);
    if (seen.has(term)) return word;
    seen.add(term);
    return <GlossaryTerm id={term}>{word}</GlossaryTerm>;
  };

  /** One vote. `dup` marks a card in the Big Questions list, which repeats a
   *  folded card: it carries none of the main list's data hooks. */
  const vote = ({ rollCall: r, position }: MemberVote, seen: Set<GlossaryTermId>, dup: boolean) => (
    <div data-member-vote-roll={dup ? undefined : r.id}>
      <p className="text-sm text-ink">
        <span className="font-semibold text-ink-2">{t('votesTheirVote')}</span>{' '}
        <strong className="font-extrabold" data-member-vote-position={dup ? undefined : position}>
          {positionWord(position, seen)}
        </strong>
      </p>
      <p className="mt-2 text-xs font-semibold text-ink-2">{tVotes('asRecorded')}</p>
      <dl className="mt-1 grid gap-1 text-ink">
        <div>
          <dt className="sr-only">{tVotes('question')}</dt>
          <dd lang="en" className="text-sm font-semibold" data-member-vote-question={dup ? undefined : ''}>
            {glossify(r.question, 'en', seen)}
          </dd>
        </div>
        <div className="text-sm">
          <dt className="inline font-semibold">{tVotes('result')}: </dt>
          <dd lang="en" className="inline">
            {glossify(r.result, 'en', seen)}
            {/* The record's own tally, as the settled box prints it. Inside
                the <dd>: a <dl>'s <div> group holds only <dt> and <dd>. */}
            <span className="tabular-nums" data-member-vote-tally={dup ? undefined : ''}>
              {' '}
              · {r.totals.yea}–{r.totals.nay}
            </span>
          </dd>
        </div>
      </dl>
      <p className="mt-1 flex flex-wrap items-center gap-x-1 text-sm text-ink-2 tabular-nums">
        <span>
          {tVotes(`chamber.${r.chamber}`)} · <time dateTime={r.date}>{fmtDate(r.date)}</time> ·{' '}
          {tVotes('roll', { roll: r.roll })} ·
        </span>
        <a
          href={rollCallPage(r.source)}
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

  const card = ({ bill: id, votes }: (typeof groups)[number], dup = false) => {
    const raw = billFor(id);
    const bill = raw ? localizeBill(raw, locale) : undefined;
    const [newest] = votes;
    // Their other votes on this bill: counted here, listed on the bill page.
    const more = votes.length - 1;
    const word = raw ? statusWord(raw) : null;
    const law = raw && word === 'law' ? lawRecord(raw) : null;
    const now = bill && word && SETTLED_SENTENCE.has(word) ? rightNow(bill) : null;
    // An adopted concurrent resolution: what it can and cannot do, as on its
    // bill page (lib/concurrent-explainer.ts). Null on every other bill.
    const concurrent = raw ? adoptedConcurrentReading(raw) : null;
    const question = questionOf.get(id);
    // One set per card: a term is glossed once in it (the position word,
    // then the record's own lines).
    const seen = new Set<GlossaryTermId>();
    return (
      <li
        key={id}
        className={`rounded-control border border-line-strong bg-paper p-5 ${question || dup ? '' : HIDE_UNDER_BQ}`}
        data-member-vote-bill={dup ? undefined : id}
        data-member-vote-bq-bill={dup ? id : undefined}
      >
        {bill && (
          <>
            <p className="text-xs leading-tight font-bold tracking-[0.06em] text-ink-2">
              <span className="tabular-nums">{formatCitation(bill.bill_type, bill.bill_number)}</span>
              {question && (
                <span data-member-vote-question-name="">
                  {' '}
                  · {t('votesBigQuestion', { name: question })}
                </span>
              )}
            </p>
            {word && (
              <p
                className="mt-1 text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink uppercase"
                data-member-bill-word={word}
              >
                {tBills(`statusWord.${word}`)}
              </p>
            )}
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
          </>
        )}
        <div className="mt-3 border-t border-line pt-3">{vote(newest, seen, dup)}</div>
        {law?.date && (
          <p className="mt-2 max-w-read text-sm text-ink tabular-nums" data-member-vote-law="">
            {t('votesLaw', {
              date: fmtDate(law.date),
              law: law.number ?? 'none',
            })}
          </p>
        )}
        {now && (
          <p className="mt-2 max-w-read text-sm text-ink-2" data-member-vote-now={dup ? undefined : now.key}>
            <strong className="font-bold text-ink">{tJourney('now')}</strong> {now.text}
          </p>
        )}
        {concurrent && <ConcurrentExplainer reading={concurrent} className="mt-2" />}
        {more > 0 && (
          <p className="mt-2 border-t border-line pt-1">
            <Link
              href={`/bills/${id}#votes`}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
              data-member-vote-more={dup ? undefined : more}
            >
              {t('votesMoreOnBillLink', { count: more })}
            </Link>
          </p>
        )}
      </li>
    );
  };

  const listed = groups.slice(0, MEMBER_VOTES_MAX_BILLS);
  const olderBills = groups.length - listed.length;
  const shown = listed.slice(0, SHOWN);
  const rest = listed.slice(SHOWN);
  // Every Big Question vehicle the record lists them on, capped or not, so
  // the filter's count is every such bill; the ones not already open in the
  // first batch get the second list.
  const bigQuestions = groups.filter((g) => questionOf.has(g.bill));
  const bqFolded = bigQuestions.filter((g) => !shown.includes(g));

  return (
    <section
      id="votes"
      aria-labelledby="rep-votes"
      className="group/votes mt-12 first:mt-0"
      data-member-votes=""
    >
      <div className="border-t-[3px] border-ink pt-4">
        <h2 id="rep-votes" className="text-h2 font-extrabold">
          {t('votesHeading')}
        </h2>
      </div>
      {groups.length > 0 ? (
        <>
          <p className="mt-3 max-w-read text-sm text-ink-2 tabular-nums">
            {t('votesNote', { count: groups.length, date: since, updated })}
          </p>
          {bigQuestions.length > 0 && (
            <fieldset className="mt-3 flex flex-wrap items-center gap-2" data-member-votes-filter="">
              {/* The /embeds configurator's radio idiom: `tint` is what the
                  reader picked, and the edge steps to ink with it, so the
                  choice is never carried by a fill alone. */}
              <legend className="sr-only">{t('votesFilterLegend')}</legend>
              <span aria-hidden className="mr-1 text-sm font-semibold text-ink-2">
                {t('votesFilterLegend')}
              </span>
              <label className={FILTER_OPTION}>
                <input
                  type="radio"
                  name="member-votes-filter"
                  id="member-votes-all"
                  defaultChecked
                  className="h-5 w-5 accent-ink"
                />
                {t('votesFilterAll', { count: groups.length })}
              </label>
              <label className={FILTER_OPTION}>
                <input type="radio" name="member-votes-filter" id="member-votes-bq" className="h-5 w-5 accent-ink" />
                {t('votesFilterBigQuestions', { count: bigQuestions.length })}
              </label>
            </fieldset>
          )}
          <p className="mt-3">
            <Chip tone="ai" marker={tCommon('aiMarker')}>
              {t('votesAiNote')}
            </Chip>
          </p>
          <ol className="mt-4 grid gap-4">{shown.map((g) => card(g))}</ol>
          {rest.length > 0 && (
            <details className={`mt-4 border-t border-line pt-2 ${HIDE_UNDER_BQ}`} data-member-votes-all="">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-bold select-none">
                {t('votesShowMore', { count: rest.length })}
              </summary>
              <ol className="mt-2 grid gap-4">{rest.map((g) => card(g))}</ol>
            </details>
          )}
          {bqFolded.length > 0 && (
            <ol
              className="mt-4 hidden gap-4 group-has-[#member-votes-bq:checked]/votes:grid"
              data-member-votes-bq=""
            >
              {bqFolded.map((g) => card(g, true))}
            </ol>
          )}
          {olderBills > 0 && (
            <p
              className={`mt-4 max-w-read text-sm text-ink-2 tabular-nums ${HIDE_UNDER_BQ}`}
              data-member-votes-older={olderBills}
            >
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
