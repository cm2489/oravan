import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { BillCard } from '@/components/BillCard';
import { glossaryTag } from '@/components/glossary-tags';
import { RecordWords } from '@/components/RecordWords';
import { formatInstant } from '@/lib/format';
import { Chip } from '@/components/system';
import { TodayFloorCard } from '@/components/TodayFloorCard';
import { TodayVoteCard } from '@/components/TodayVoteCard';
import { Link } from '@/i18n/navigation';
import { CARD_GRID, INTRO_ROW } from '@/lib/layout';
import { dayCountParts, type Brief, type BriefChamber, type BriefScheduleItem } from '@/lib/today';

/*
 * THE DAILY BRIEF — one renderer for /today and /today/[date].
 *
 * THE ORDER (wireframes v2, today.html, 2026-09-29; the floor band moved
 * first on 2026-09-30, owner: "31 a but add floor first"). The two same-day
 * facts sit together at the top: the floor schedule next, then the chambers.
 * Then the record — the brief's day and the day before, or, when both are
 * empty, one role="status" line that says so and links to the latest day that
 * has any record, so a quiet Monday never dead-ends (funnel I3). Then the Big
 * Questions that moved. "Other days" lists every dated permalink with its
 * counts, full width under the record, and the per-source "Record as of:"
 * line closes the page.
 *
 * CARDS ON THE BILLS PAGE'S GRID (owner, 2026-09-29: "The actual Today page
 * needs to have cards similar to the bills page"). The page takes the full
 * page shell with no side rail, and each band is the shared card grid (one
 * column on a phone, two from `sm`, three from `xl`): a floor notice is a
 * TodayFloorCard, a roll call a TodayVoteCard, a bill that moved the /bills
 * BillCard itself, and a Big Question a small card with its name and the
 * vehicles that moved. Prose stays at the reading measure.
 *
 * FILL THE SCREEN (layout pass 2026-11-28; owner, that day: "SOOO much empty
 * white space… Especially the today in Congress page"). The title sits left
 * with the date and the note beside it from `lg`. The short facts of a quiet
 * day — the floor's one quiet line, the chambers, the record's quiet line —
 * share one row from `lg` (two or three cells), each still its own section
 * with its own rule and heading, in the same DOM order. Alone in its row, the
 * chambers set Senate and House side by side. "Other days" is a strip of
 * seven columns from `lg`, so a quiet day fits on one laptop screen. Below
 * `lg` every block stacks in the same order as before.
 *
 * WHAT IS OURS, WHAT IS THE RECORD'S, WHAT IS AI'S. Every interface sentence
 * is a message key with record values interpolated. The record's own words —
 * bill titles, roll-call questions and results, the chamber's schedule lines,
 * a bill's latest-action sentence — print as written, English on /es too
 * (ruling V4: a translated quote is a paraphrase in quotation marks), marked
 * `lang="en"`. The cards' headlines are the /bills cards' AI-decoded
 * headlines, and a Big Question's name is AI-drafted (page 1, rule 4), so the
 * page labels them: one quiet AI label per band that carries AI text, with
 * its "How this is made" link (docs/current-direction.md, Copy: "one quiet
 * label per block"), at the top of that band. Every element carrying AI text is
 * marked `data-ai-text` so tests/today.spec.ts can hold the label in front
 * of it.
 *
 * WHAT IT NEVER SAYS: a vote date, the word "recess", or how long a chamber
 * will be away. The Daily Digest names one next meeting and whether it is pro
 * forma, and that is all the chamber line repeats (the FloorRecessNote rules).
 * A floor notice's tag names the chamber's notice and the meeting's date,
 * never "vote scheduled" (lib/today.ts `floorTagFor`).
 *
 * COLOUR: links are `go`, everything else ink, and the one yellow is the
 * floor-notice tag for a "will vote on" notice (owner, 2026-09-29: "a yellow
 * tag or something that explicitly draws attention to it").
 */

// The first section on the page carries the heavy rule, the rest the thin one.
// 32px between bands (layout pass 2026-11-28; it was 48).
const HEAVY_RULE = 'mt-8 border-t-[3px] border-ink pt-4';
const THIN_RULE = 'mt-8 border-t border-line-strong pt-4';

const LINK =
  'font-semibold text-go underline underline-offset-4 visited:text-go-deep hover:text-go-deep';

/* The record's own English words: `lang="en"`, and «» on the Spanish edition
   (components/RecordWords.tsx). */
function Verbatim({ children, locale }: { children: ReactNode; locale: string }) {
  return <RecordWords locale={locale}>{children}</RecordWords>;
}

export async function TodayBrief({ brief, locale }: { brief: Brief; locale: string }) {
  const t = await getTranslations('today');
  const tHome = await getTranslations('home');
  const tCommon = await getTranslations('common');
  const format = await getFormatter();

  /* Bare YYYY-MM-DD values are record dates: parsed as UTC midnight, so they
     are formatted in UTC or a negative-offset zone prints the day before. */
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  const longDay = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
  /* A record day's own heading: the year is already in the lede above it. */
  const dayHeading = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
  /* "Sep 28" — the quiet line names both of the brief's days. */
  const shortDay = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), { month: 'short', day: 'numeric', timeZone: 'UTC' });
  /* "Mon, Sep 28" — one row of the day list, and the floor tag's date. */
  const rowDay = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  /* "Friday, Sep 25" — the quiet line's way out. */
  const latestDay = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  /* The newest date is the brief itself, so it links to /today. */
  const dayHref = (iso: string) => (iso === brief.window[0]?.date ? '/today' : `/today/${iso}`);
  /* Full instants keep their zone and print it — the FloorRecessNote rule. */
  // es-US in the Spanish edition: "12:00 p.m. EST", not "12:00 GMT-5" (lib/format.ts).
  const instant = (value: string) => formatInstant(value, locale, { year: false });

  const chamberName = (c: 'house' | 'senate') => t(c === 'senate' ? 'senate' : 'house');
  const strong = (chunks: ReactNode) => <strong className="font-bold text-ink">{chunks}</strong>;

  const chamberLine = (c: BriefChamber, published: string | null) => {
    const name = chamberName(c.chamber);
    if (c.session === 'unknown' || !published) return t.rich('chamberUnknown', { chamber: name, name: strong });
    /* In session, but not on the brief's day (SY-31, lib/today.ts
       meetsAfterDay): say when it next meets, from the same Digest line the
       schedule block quotes, rather than "in session" on a day it is not. */
    if (c.meetsLater && c.nextMeeting?.iso) {
      return t.rich('chamberInNext', {
        chamber: name,
        published: day(published),
        meeting: c.nextMeeting.label ?? day(c.nextMeeting.iso),
        when: c.nextMeeting.label
          ? (chunks: ReactNode) => <Verbatim locale={locale}>{chunks}</Verbatim>
          : (chunks: ReactNode) => <span className="tabular-nums">{chunks}</span>,
        name: strong,
      });
    }
    if (c.session === 'in_session') {
      return t.rich('chamberIn', { chamber: name, published: day(published), name: strong });
    }
    const meeting = c.nextMeeting;
    if (!meeting || (!meeting.label && !meeting.iso)) {
      return t.rich('chamberOutNoMeeting', {
        chamber: name,
        published: day(published),
        name: strong,
        term: glossaryTag('pro-forma-session'),
      });
    }
    return t.rich('chamberOut', {
      chamber: name,
      published: day(published),
      /* The Digest's own line, verbatim and English (ruling V4), or — only when
         it printed none — our derived date in the reader's locale. */
      meeting: meeting.label ?? day(meeting.iso!),
      when: meeting.label
        ? (chunks: ReactNode) => <Verbatim locale={locale}>{chunks}</Verbatim>
        : (chunks: ReactNode) => <span className="tabular-nums">{chunks}</span>,
      name: strong,
      term: glossaryTag('pro-forma-session'),
    });
  };

  const scheduleMeta = (item: BriefScheduleItem) => {
    const source = tHome(item.source === 'daily-digest' ? 'evidenceSourceDigest' : 'evidenceSourceWeekly');
    if (item.coversLabel || item.covers) {
      return t.rich('scheduleMeta', {
        source,
        published: day(item.published),
        covers: item.coversLabel ?? day(item.covers!),
        when: item.coversLabel
          ? (chunks: ReactNode) => <Verbatim locale={locale}>{chunks}</Verbatim>
          : (chunks: ReactNode) => <span className="tabular-nums">{chunks}</span>,
      });
    }
    return t('scheduleMetaNoCovers', { source, published: day(item.published) });
  };

  const hasRecord =
    brief.days.some((d) => d.rollCalls.length > 0 || d.moved.length > 0) || brief.questions.length > 0;

  /* ONE AI LABEL PER BAND that carries AI text, at the top of that band.
     `cls` is its top margin: a record day's head sets it beside the day's
     heading from lg, with no margin there. */
  const aiLabel = (key: 'aiHeadlines' | 'aiNames', cls = 'mt-3') => (
    <p className={`${cls} flex flex-wrap items-center gap-x-3`} data-today-ai="">
      <Chip tone="ai" marker={tCommon('aiMarker')}>
        {t(key)}
      </Chip>
      <Link
        href="/citations#ai-policy"
        className="inline-flex min-h-11 items-center text-2xs text-ink-2 underline decoration-line-strong underline-offset-4 hover:decoration-ink"
      >
        {tHome('aiHowMade')}
      </Link>
    </p>
  );

  const stampParts = [
    brief.stamps.bills ? t('stampBills', { date: instant(brief.stamps.bills) }) : null,
    brief.stamps.votes ? t('stampVotes', { date: instant(brief.stamps.votes) }) : null,
    brief.stamps.floor ? t('stampFloor', { date: instant(brief.stamps.floor) }) : null,
  ].filter((p): p is string => p !== null);

  /* The schedule block prints on the current day only: with notices, as
     cards; with none and sources that vouch for themselves (`quiet`), one
     status line that says so; with none and a posture of `unknown`, nothing
     about Congress at all — our own reading may be why it is empty. */
  const showSchedule = brief.schedule.length > 0 || brief.schedulePosture === 'quiet';

  /* The shared card grid (lib/layout.ts): one column, two from sm, three
     from xl (layout pass 2026-11-28; it stopped at two). */
  const GRID = `mt-4 ${CARD_GRID}`;

  /* THE FACTS ROW (layout pass 2026-11-28). The short same-day facts share
     one row from lg: the floor band only when it is its one quiet line (its
     notice cards keep the full width), the chambers, and the record only when
     it is its quiet line. Two cells take half each; three take a third each
     from xl. One cell, or none, and the wrapper is a plain div. */
  const scheduleInRow = showSchedule && brief.schedule.length === 0; // the one quiet line
  const rowCount = (scheduleInRow ? 1 : 0) + (brief.chamber ? 1 : 0) + (!hasRecord ? 1 : 0);
  const FACTS_ROW =
    rowCount >= 2
      ? `lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8 lg:*:min-w-0 ${rowCount === 3 ? 'xl:grid-cols-3' : ''}`
      : '';

  /* The blocks are declared in the order the page prints them
     (tests/today.unit.spec.ts reads that order from this file). */

  /* (a) ON THE FLOOR SCHEDULE NEXT — first on the page, above the
     chambers (owner, 2026-09-30: "31 a but add floor first"), so a
     yellow-tagged notice is on a phone's first screen. Quoted, dated,
     attributed; never a vote date. */
  const scheduleBlock = (
    <section className={HEAVY_RULE} aria-labelledby="today-schedule" data-block="schedule">
      <h2 id="today-schedule" className="text-h3 font-extrabold text-ink">
        {t('scheduleHeading')}
      </h2>
      {brief.schedule.length > 0 ? (
        <>
          <p className="mt-2 max-w-read text-sm text-ink-2">{t('scheduleNote')}</p>
          {brief.schedule.some((i) => i.teaser?.headline) && aiLabel('aiHeadlines')}
          <ul className={GRID}>
            {brief.schedule.map((item) => (
              <li key={`${item.kind}-${item.citation}`} data-ai-text={item.teaser?.headline ? '' : undefined}>
                <TodayFloorCard
                  item={item}
                  meta={scheduleMeta(item)}
                  tagDate={item.tag?.dateIso ? rowDay(item.tag.dateIso) : null}
                />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p role="status" className="mt-4 max-w-read text-md text-ink" data-schedule-quiet="">
          {t('scheduleQuiet')}
        </p>
      )}
    </section>
  );

  /* (b) THE CHAMBERS — after the floor band, the current day only: the
     schedule file is re-read hourly and not archived, so a past day has
     no honest chamber line. Alone in its row, Senate and House sit side by
     side from lg; inside the facts row they stack. */
  const chambersBlock = brief.chamber && (
    <section className={showSchedule ? THIN_RULE : HEAVY_RULE} aria-labelledby="today-chambers">
      <h2 id="today-chambers" className="text-h3 font-extrabold text-ink">
        {t('chambersHeading')}
      </h2>
      <ul className={`mt-4 grid gap-3 ${rowCount === 1 ? 'lg:grid-cols-2 lg:gap-x-8' : ''}`}>
        {brief.chamber.chambers.map((c) => (
          <li
            key={c.chamber}
            className="max-w-read min-w-0 text-md text-ink"
            data-chamber={c.chamber}
            data-session={c.session}
            data-meets-later={c.meetsLater ? 'true' : undefined}
          >
            {chamberLine(c, brief.chamber!.source?.published ?? null)}
          </li>
        ))}
      </ul>
      {brief.chamber.source?.url && (
        <p className="mt-2">
          <a href={brief.chamber.source.url} target="_blank" rel="noopener noreferrer" className={`inline-flex min-h-11 items-center gap-1.5 text-sm ${LINK}`}>
            {tHome('evidenceLink')}
            <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
          </a>
        </p>
      )}
    </section>
  );

  /* (c) THE RECORD — the brief's day, then the day before: vote cards,
     then bill cards, each on the grid. The day's heading and its AI label
     share one row from lg. */
  const daysBlock = brief.days.map((d) => (
    <section
      key={d.date}
      className="mt-8 border-t border-line-strong pt-4"
      aria-labelledby={`today-day-${d.date}`}
      data-day={d.date}
    >
      <div className="lg:flex lg:flex-wrap lg:items-center lg:justify-between lg:gap-x-6">
        <h2 id={`today-day-${d.date}`} className="text-h3 font-extrabold text-ink tabular-nums">
          {dayHeading(d.date)}
        </h2>
        {(d.rollCalls.some((r) => r.teaser?.headline) || d.moved.some((b) => b.teaser?.headline)) &&
          aiLabel('aiHeadlines', 'mt-3 lg:mt-0')}
      </div>

      {d.rollCalls.length === 0 && d.moved.length === 0 && (
        <p className="mt-3 max-w-read text-sm text-ink-2">{t('dayEmpty')}</p>
      )}

      {d.rollCalls.length > 0 && (
        <div className="mt-4" data-block="votes">
          <h3 className="text-md font-bold text-ink">{t('votesHeading')}</h3>
          <ul className={GRID}>
            {d.rollCalls.map((r) => (
              <li key={r.id} data-ai-text={r.teaser?.headline ? '' : undefined}>
                <TodayVoteCard vote={r} chamberName={chamberName(r.chamber)} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.moved.length > 0 && (
        <div className="mt-6" data-block="moved">
          <h3 className="text-md font-bold text-ink">{t('movedHeading')}</h3>
          <ul className={GRID}>
            {d.moved.map((b) => (
              <li key={b.slug} data-ai-text={b.teaser?.headline ? '' : undefined}>
                {b.teaser ? (
                  <BillCard
                    bill={b.teaser}
                    caption={b.actionText ? <Verbatim locale={locale}>{b.actionText}</Verbatim> : undefined}
                  />
                ) : (
                  <Link href={`/bills/${b.slug}`} className={`inline-flex min-h-11 items-center text-md ${LINK}`}>
                    {b.citation}
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {d.movedMore > 0 && (
            <p className="mt-4 max-w-read text-sm text-ink-2">{t('movedMore', { count: d.movedMore })}</p>
          )}
        </div>
      )}
    </section>
  ));

  /* A QUIET DAY, ADMITTED (funnel I3). Both of the brief's days are
     empty: one status line says so for the two dates by name, and the
     latest day in the window that has any record is one tap away — so
     the page never dead-ends on a Monday. */
  const recordEmptyBlock = (
    <section className="mt-8 border-t border-line-strong pt-4" aria-labelledby="today-record" data-record-empty="">
      <h2 id="today-record" className="text-h3 font-extrabold text-ink">
        {t('recordHeading')}
      </h2>
      <p role="status" className="mt-4 max-w-read bg-wash p-6 text-md text-ink">
        {t('empty', { date: shortDay(brief.date), prev: shortDay(brief.days[1]?.date ?? brief.date) })}
      </p>
      {brief.latestRecord && (
        <p className="mt-2">
          <Link
            href={dayHref(brief.latestRecord)}
            className={`inline-flex min-h-11 items-center text-sm tabular-nums ${LINK}`}
            data-latest-record={brief.latestRecord}
          >
            {t('latestRecord', { date: latestDay(brief.latestRecord) })}
          </Link>
        </p>
      )}
    </section>
  );

  return (
    <div className="mx-auto max-w-page px-4 pt-6 pb-12 md:pt-8">
      {/* THE TITLE ROW (layout pass 2026-11-28): the title left, the date
          and the note beside it from lg; stacked below lg, as before. */}
      <div className={INTRO_ROW}>
        <h1 className="min-w-0 text-h1-bill font-extrabold text-ink">
          {brief.isToday ? t('title') : t('titleDated', { date: day(brief.date) })}
        </h1>
        <div className="min-w-0">
          <p className="mt-3 max-w-read text-lede text-ink-2 lg:mt-0">
            <span className="tabular-nums">{longDay(brief.date)}</span>
          </p>
          <p className="mt-2 max-w-read text-sm text-ink-2">{t('recordNote')}</p>
        </div>
      </div>

      {/* The floor's notice cards keep the full width, above the facts row. */}
      {showSchedule && !scheduleInRow && scheduleBlock}
      <div className={FACTS_ROW}>
        {scheduleInRow && scheduleBlock}
        {chambersBlock}
        {!hasRecord && recordEmptyBlock}
      </div>
      {hasRecord && daysBlock}

      {/* (d) BIG QUESTIONS THAT MOVED — a vehicle's latest action falls on one
          of the brief's two days. The name is the Moment's own name, which AI
          drafted from the record (page 1, rule 4), so the band is labelled. */}
      {brief.questions.length > 0 && (
        <section className="mt-8 border-t border-line-strong pt-4" aria-labelledby="today-questions">
          <h2 id="today-questions" className="text-h3 font-extrabold text-ink">
            {t('questionsHeading')}
          </h2>
          {aiLabel('aiNames')}
          <ul className={GRID}>
            {brief.questions.map((q) => (
              <li key={q.id} data-ai-text="">
                <article className="h-full rounded-control border border-line-strong bg-paper p-5">
                  <h3 className="text-lg leading-tight font-bold text-ink">
                    <Link
                      href={`/questions/${q.id}`}
                      className="inline-flex min-h-11 items-center hover:underline hover:decoration-go hover:decoration-[3px]"
                    >
                      {locale === 'es' ? q.name.es : q.name.en}
                    </Link>
                  </h3>
                  <p className="mt-1 text-sm text-ink-2 tabular-nums">
                    {q.vehicles
                      .map((v) => t('questionVehicle', { citation: v.citation, date: day(v.date) }))
                      .join(' · ')}
                  </p>
                </article>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!brief.isToday && <p className="mt-6 max-w-read text-sm text-ink-2">{t('pastNote')}</p>}

      {/* (e) OTHER DAYS — every dated permalink inside the 14-day window,
          newest first, each with its own counts (lib/today.ts `daySummary`:
          the lengths of the blocks that day's page prints, never a judgment).
          Full width under the record: no side rail, so nothing is ever
          clipped by a sticky box taller than the screen. From lg it is a
          calendar strip of seven columns, two rows for the 14 days, the date
          over its counts in each cell (layout pass 2026-11-28); below lg,
          44px rows, in two columns from sm, read row by row. */}
      <nav aria-labelledby="today-days" data-days="" className="mt-8 border-t border-line-strong pt-4">
        <h2 id="today-days" className="text-h3 font-extrabold text-ink">
          {t('navLabel')}
        </h2>
        <ul className="mt-3 grid sm:grid-cols-2 sm:gap-x-8 lg:grid-cols-7 lg:gap-2">
          {brief.window.map((s) => {
            const current = s.date === brief.date;
            const parts = dayCountParts(s);
            return (
              <li key={s.date} className="min-w-0 border-t border-line">
                <Link
                  href={dayHref(s.date)}
                  aria-current={current ? 'page' : undefined}
                  data-day-row={s.date}
                  className={`flex min-h-11 items-center justify-between gap-3 text-md text-ink underline-offset-2 hover:underline lg:h-full lg:flex-col lg:items-start lg:justify-start lg:gap-0.5 lg:py-2 ${current ? 'border-l-4 border-ink pl-3 font-bold' : ''}`}
                >
                  <span className="tabular-nums">{rowDay(s.date)}</span>
                  <span className="text-right text-sm text-ink-2 tabular-nums lg:text-left">
                    {parts.length > 0
                      ? parts.map((p) => t(p.key, { count: p.count })).join(' · ')
                      : t('dayNoRecord')}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="mt-2">
          {brief.isToday ? (
            <Link href={`/today/${brief.date}`} className={`inline-flex min-h-11 items-center text-sm ${LINK}`}>
              {t('permalink')}
            </Link>
          ) : (
            <Link href="/today" className={`inline-flex min-h-11 items-center text-sm ${LINK}`}>
              {t('navToday')}
            </Link>
          )}
        </p>
      </nav>

      {/* (f) FRESHNESS — the stamp each block was read at, printed plainly. */}
      {stampParts.length > 0 && (
        <p className="mt-6 max-w-read text-xs text-ink-2 tabular-nums" data-stamps>
          {t('stampsLead')} {stampParts.join(' · ')}
        </p>
      )}
    </div>
  );
}

