import type { ReactNode } from 'react';
import { Phone } from 'lucide-react';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { MomentStatusDate, MomentStatusLine } from '@/components/MomentStatusLine';
import { StalenessNote } from '@/components/StalenessNote';
import { billCallPanelProps } from '@/lib/bill-call-panel';
import { CALL_PANEL_ANCHOR, isInPageTarget } from '@/lib/call-tab';
import { formatCitation } from '@/lib/format';
import { settledDecision } from '@/lib/journey';
import type { Glance, RecordedVote } from '@/lib/question-glance';
import { settledDecisionDate } from '@/lib/settled-votes';
import { settledOutcomeSentence } from '@/lib/status-word';

/*
 * "AT A GLANCE" — the box under a Big Question's title (design of 2026-09-26,
 * owner: "This box is great."). Every row is read from the record by
 * lib/question-glance.ts, which also holds each row's omit rule; this file
 * only prints what it is handed.
 *
 * COLOUR (docs/current-direction.md, Colour and Accessibility): the box is
 * the page's one wash tint; status and dates are plain ink text; the one
 * yellow thing is the call button, because it is the one thing here you can
 * act on; links are underlined. Every pair is already in the ledger at the
 * top of app/globals.css: ink on wash 15.13, ink-2 on wash 6.93, go on wash
 * 6.75, ink on the lamp 11.20 (8.81 on hover), the button's ink edge on wash
 * 15.13, the quiet button's line-strong edge on wash 3.89 and ink on paper
 * 16.50. No new pair.
 *
 * WHAT IT NEVER CARRIES: AI text (the title is the record's own, never the
 * decoded headline, so no AI label is owed), a forecast, or — on a settled
 * question — anything that dials (page 1, rule 6).
 *
 * ORDER (review of 2026-11-22): why this bill leads, then the bill — its
 * number, linked, with its latest-action date, and its title held to two
 * lines — and only then its status sentence, so the sentence's "it" always
 * has its bill right above it. The call follows the rows; the link to the
 * question's other bills sits under the call, so on a 390×844 phone the call
 * is on the first screen for every live question
 * (tests/question-glance-shots.spec.ts holds that).
 */

/* Below 26rem a row runs its label and value on one line when both fit and
   wraps when they do not; from 26rem the label takes a 10rem column. */
const ROW =
  'flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-[26rem]:grid min-[26rem]:grid-cols-[10rem_minmax(0,1fr)] min-[26rem]:gap-x-4';
const DT = 'text-sm text-ink-2';
const DD = 'min-w-0 flex-1 basis-48 text-md font-semibold text-ink';
const SUB = 'mt-0.5 block text-sm font-normal text-ink-2';
const LINK = 'text-go underline transition-colors hover:text-go-deep';

export async function QuestionGlance({
  glance,
  panelSlug,
  dataAsOf,
  checkedAt,
}: {
  glance: Glance;
  /** The bill whose call panel sits on this page, if one does. */
  panelSlug: string | null;
  /** The page's "Data as of …" sentence (lib/freshness.ts dataAsOfString). */
  dataAsOf: string;
  checkedAt: string;
}) {
  const t = await getTranslations();
  const format = await getFormatter();
  const locale = await getLocale();
  // The status line's own date style (components/MomentStatusLine.tsx).
  const fmtDate = (d: string) =>
    format.dateTime(new Date(d), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

  const { bill, slug, line, votes, passage, next } = glance;
  const citation = formatCitation(bill.bill_type, bill.bill_number);
  // The record's own title, never the decoded headline (no AI text here): its
  // short title where the stored record has one, else its title, which the
  // box holds to two lines (line-clamp clips the paint only, so a screen
  // reader still reads all of it; the bill's page prints it whole). The
  // record is English, so a Spanish page marks it.
  const title = bill.short_title ?? bill.title;
  const titleLang = locale === 'en' ? undefined : 'en';

  /* The call: to the lead bill's call panel — this page's own when it carries
     that bill's panel, else the bill page's — worded for the chamber the
     panel itself routes to (lib/journey.ts liveCallTarget). Where the panel
     names no chamber (an aged floor fact, a committee stage), the chamber
     whose passage the record says comes next (the "If it passes" row,
     lib/question-glance.ts ifItPasses), which is a fact of the bill type and
     the stage, not a forecast. Neither: every member, and so does the label. */
  const panel = glance.settled ? null : billCallPanelProps(slug, locale, { t, fmtDate });
  const callHref = panelSlug === slug ? CALL_PANEL_ANCHOR : `/bills/${slug}${CALL_PANEL_ANCHOR}`;
  const callChamber = panel?.liveTarget?.chamber ?? glance.next?.chamber ?? 'other';

  const settled = glance.settled ? settledDecision(bill) : null;
  const settledDate = settled ? settledDecisionDate(bill) : null;

  const quoted = (v: RecordedVote, label: string) => (
    <span className="block">
      <span className="text-ink-2">{label}</span>{' '}
      <q lang="en">{v.result}</q>,{' '}
      <span className="tabular-nums">
        {v.yeas}–{v.nays}
      </span>
    </span>
  );

  const rows: { key: string; label: string; value: ReactNode }[] = [];
  if (votes) {
    const counts = [
      votes.house > 0 ? t('moments.glance.votesHouse', { count: votes.house }) : null,
      votes.senate > 0 ? t('moments.glance.votesSenate', { count: votes.senate }) : null,
    ].filter(Boolean);
    rows.push({
      key: 'votes',
      label: t('moments.glance.votesLabel'),
      value: (
        <>
          <span className="tabular-nums">{counts.join(', ')}</span>
          <span className={SUB}>
            {quoted(votes.newest, t('moments.glance.votesNewest', { date: fmtDate(votes.newest.date) }))}
          </span>
        </>
      ),
    });
  }
  if (passage) {
    rows.push({
      key: 'passage',
      label: t('moments.glance.passageLabel'),
      value:
        passage.kind === 'notYet' ? (
          t('moments.glance.passageNotYet')
        ) : (
          <span className="font-normal">
            {passage.votes.map((v) => (
              <span key={v.chamber} className="block">
                {quoted(v, t('moments.glance.passageVote', { chamber: v.chamber, date: fmtDate(v.date) }))}
              </span>
            ))}
          </span>
        ),
    });
  }
  if (next) {
    rows.push({
      key: 'next',
      label: t('moments.glance.nextLabel'),
      value: t(`moments.glance.next.${next.step}`, { chamber: next.chamber, then: next.then }),
    });
  }

  const membersHref = glance.membersAnchor ? `/bills/${slug}${glance.membersAnchor}` : null;

  return (
    <section
      aria-labelledby="glance-h"
      className="mt-6 max-w-read rounded-control bg-wash p-4"
      data-question-glance={glance.settled ? 'settled' : 'live'}
      data-glance-lead={slug}
    >
      <h2 id="glance-h" className="sr-only">
        {t('moments.glance.heading')}
      </h2>

      {/* 1 · Which bill this is and why it leads, then the bill: its number
             (linked) with its latest-action date, and its title. */}
      <p className="text-sm text-ink-2" data-glance-row="reason">
        {t('moments.glance.lead', { reason: glance.reason })}
      </p>
      <div className="mt-1" data-glance-row="bill">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <Link href={`/bills/${slug}`} className={`${LINK} -my-3 inline-block py-3 text-md font-semibold`}>
            {citation}
          </Link>
          {!glance.settled && <MomentStatusDate date={line.date} inline />}
        </p>
        <p className="mt-0.5 line-clamp-2 text-sm text-ink-2" lang={titleLang} data-glance-title>
          {title}
        </p>
      </div>

      {/* 2 · Where that bill stands. A settled bill shows the record's
             outcome, with its date, as its record row and its bill page do. */}
      {settled ? (
        <p className="mt-2 max-w-read text-md font-semibold text-ink" data-glance-row="status">
          {settledOutcomeSentence(t, settled, settledDate ? fmtDate(settledDate) : null)}
        </p>
      ) : (
        <MomentStatusLine line={line} size="md" dateless className="mt-2" />
      )}
      {glance.settled && <p className="mt-2 text-sm text-ink-2">{t('moments.status.explainer')}</p>}

      <dl className="mt-3 grid gap-2.5">
        {rows.map((r) => (
          <div key={r.key} className={ROW} data-glance-row={r.key}>
            <dt className={DT}>{r.label}</dt>
            <dd className={DD}>{r.value}</dd>
          </div>
        ))}
      </dl>

      {(panel || membersHref) && (
        <div className="mt-4 grid gap-2 min-[48rem]:grid-cols-2">
          {panel &&
            (() => {
              const cls =
                'ring-edge inline-flex min-h-12 items-center justify-center gap-2 rounded-control border-2 border-ink bg-urgent px-5 py-3 text-center font-bold text-ink no-underline hover:bg-urgent-deep';
              const body = (
                <>
                  <Phone className="h-5 w-5 flex-none" aria-hidden />
                  <span>
                    {t('moments.glance.call', { chamber: callChamber })}
                    <span className="sr-only"> {t('moments.glance.callAbout', { citation })}</span>
                  </span>
                </>
              );
              return isInPageTarget(callHref) ? (
                <a href={callHref} className={cls} data-glance-call>
                  {body}
                </a>
              ) : (
                <Link href={callHref} className={cls} data-glance-call>
                  {body}
                </Link>
              );
            })()}
          {membersHref && (
            <Link
              href={membersHref}
              className="inline-flex min-h-12 items-center justify-center rounded-control border border-line-strong bg-paper px-5 py-3 text-center font-bold text-ink no-underline transition-colors hover:border-ink"
              data-glance-members
            >
              {t('moments.glance.members')}
              <span className="sr-only"> {t('moments.glance.membersAbout', { citation })}</span>
            </Link>
          )}
        </div>
      )}

      {glance.otherBills > 0 && (
        <p className="mt-2">
          <a href="#vehicles-h" className={`${LINK} inline-flex min-h-11 items-center text-sm font-semibold`}>
            {t('moments.glance.more', { count: glance.otherBills })}
          </a>
        </p>
      )}

      {/* 8 · Whose words these are, and how old the data is. The staleness
             sentinel rides here, beside the one data date on the page. */}
      <p className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
        <span className="font-semibold">{t('moments.status.label')}</span>
        <span>
          {dataAsOf}
          <StalenessNote checkedAt={checkedAt} />
        </span>
      </p>
    </section>
  );
}
