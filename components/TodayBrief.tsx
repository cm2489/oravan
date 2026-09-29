import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { glossaryTag, glossaryTagOnce, glossify } from '@/components/glossary-tags';
import type { GlossaryTermId } from '@/lib/glossary';
import { Link } from '@/i18n/navigation';
import { dayCountParts, type Brief, type BriefChamber, type BriefScheduleItem } from '@/lib/today';

/*
 * THE DAILY BRIEF — one renderer for /today and /today/[date].
 *
 * THE ORDER (wireframes v2, today.html, 2026-09-29). The two same-day facts
 * sit together at the top: the chambers, then the floor schedule next. Then
 * the record — the brief's day and the day before, or, when both are empty,
 * one role="status" line that says so and links to the latest day that has
 * any record, so a quiet Monday never dead-ends (funnel I3). Then the Big
 * Questions that moved. "Other days" lists every dated permalink with its
 * counts (a rail beside the reading column on a wide screen), and the
 * per-source "Record as of:" line closes the page.
 *
 * MECHANICAL BY CONSTRUCTION. Every sentence on this page is a message key
 * with record values interpolated, or the record's own words printed as they
 * were written: bill titles, roll-call questions and results, the chamber's
 * published schedule lines, a bill's latest-action sentence. Those stay
 * English on /es (ruling V4: a translated quote is a paraphrase in quotation
 * marks) and carry `lang="en"`; the page says once, at the top, that they do.
 * No AI-written text is printed here, so the page carries no AI label; every
 * bill links to its own page, where the decoded answer is labelled.
 *
 * WHAT IT NEVER SAYS: a vote date, the word "recess", or how long a chamber
 * will be away. The Daily Digest names one next meeting and whether it is pro
 * forma, and that is all the chamber line repeats (the FloorRecessNote rules).
 *
 * Ruled paper throughout: no green ground, no amber — nothing here is the one
 * dated floor fact the colour law spends amber on, and a second green band
 * would take meaning from the homepage's. Links are `go`, everything else ink.
 */

const LINK =
  'font-semibold text-go underline underline-offset-4 visited:text-go-deep hover:text-go-deep';

function Verbatim({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span lang="en" className={className}>
      {children}
    </span>
  );
}

export async function TodayBrief({ brief, locale }: { brief: Brief; locale: string }) {
  const t = await getTranslations('today');
  const tHome = await getTranslations('home');
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
  /* "Mon, Sep 28" — one row of the day list. */
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
  const instant = (value: string) =>
    format.dateTime(new Date(value), {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });

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
          ? (chunks: ReactNode) => <Verbatim>{chunks}</Verbatim>
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
        ? (chunks: ReactNode) => <Verbatim>{chunks}</Verbatim>
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
          ? (chunks: ReactNode) => <Verbatim>{chunks}</Verbatim>
          : (chunks: ReactNode) => <span className="tabular-nums">{chunks}</span>,
      });
    }
    return t('scheduleMetaNoCovers', { source, published: day(item.published) });
  };

  const hasRecord =
    brief.days.some((d) => d.rollCalls.length > 0 || d.moved.length > 0) || brief.questions.length > 0;

  const stampParts = [
    brief.stamps.bills ? t('stampBills', { date: instant(brief.stamps.bills) }) : null,
    brief.stamps.votes ? t('stampVotes', { date: instant(brief.stamps.votes) }) : null,
    brief.stamps.floor ? t('stampFloor', { date: instant(brief.stamps.floor) }) : null,
  ].filter((p): p is string => p !== null);

  return (
    <div className="mx-auto max-w-5xl px-4 pt-12 pb-16">
      {/* Phone: one column, in reading order — the brief, "Other days", the
          stamps. Wide screen (the bill page's 62rem desk): the brief and its
          stamps in the reading column, and the day list as a rail beside
          them, so a quiet day points straight at the busy ones. Row 2 is
          `1fr` so a rail taller than the brief grows the stamp's row, never
          the brief's, and the stamps stay right under the record. */}
      <div className="grid min-[62rem]:grid-cols-[minmax(0,var(--measure-read))_minmax(20rem,22rem)] min-[62rem]:grid-rows-[auto_1fr] min-[62rem]:justify-between min-[62rem]:gap-x-[clamp(2rem,4vw,4rem)]">
        <div className="min-w-0 min-[62rem]:col-start-1 min-[62rem]:row-start-1">
          <h1 className="text-h1-bill font-extrabold text-ink">
            {brief.isToday ? t('title') : t('titleDated', { date: day(brief.date) })}
          </h1>
          <p className="mt-4 max-w-read text-lede text-ink-2">
            <span className="tabular-nums">{longDay(brief.date)}</span>
          </p>
          <p className="mt-3 max-w-read text-sm text-ink-2">{t('recordNote')}</p>

          {/* (a) THE CHAMBERS — the current day only: the schedule file is re-read
              hourly and not archived, so a past day has no honest chamber line. */}
          {brief.chamber && (
            <section className="mt-12 border-t-[3px] border-ink pt-4" aria-labelledby="today-chambers">
              <h2 id="today-chambers" className="text-h3 font-extrabold text-ink">
                {t('chambersHeading')}
              </h2>
              <ul className="mt-4 grid max-w-read gap-3">
                {brief.chamber.chambers.map((c) => (
                  <li
                    key={c.chamber}
                    className="text-md text-ink"
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
          )}

          {/* (b) ON THE FLOOR SCHEDULE NEXT — quoted, dated, attributed; never a
              vote date. Current day only, like the chamber line, and beside it:
              the two same-day facts sit together at the top. */}
          {brief.schedule.length > 0 && (
            <section className="mt-12 border-t border-line-strong pt-4" aria-labelledby="today-schedule" data-block="schedule">
              <h2 id="today-schedule" className="text-h3 font-extrabold text-ink">
                {t('scheduleHeading')}
              </h2>
              <p className="mt-2 max-w-read text-sm text-ink-2">{t('scheduleNote')}</p>
              <ul className="mt-4 grid gap-4">
                {brief.schedule.map((item) => (
                  <li key={`${item.kind}-${item.citation}`} className="max-w-read border-t border-line pt-3">
                    <blockquote className="text-md text-ink">
                      <Verbatim>“{item.quote}”</Verbatim>
                    </blockquote>
                    <p className="mt-1 text-xs text-ink-2 tabular-nums">{scheduleMeta(item)}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-4">
                      <Link href={item.href} className={`inline-flex min-h-11 items-center text-sm ${LINK}`}>
                        {item.citation}
                      </Link>
                      <a href={item.url} target="_blank" rel="noopener noreferrer" className={`inline-flex min-h-11 items-center gap-1.5 text-sm ${LINK}`}>
                        {tHome('evidenceLink')}
                        <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
                      </a>
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* (c) THE RECORD — the brief's day, then the day before. */}
          {hasRecord && brief.days.map((d) => (
            <section
              key={d.date}
              className="mt-12 border-t border-line-strong pt-4"
              aria-labelledby={`today-day-${d.date}`}
              data-day={d.date}
            >
              <h2 id={`today-day-${d.date}`} className="text-h3 font-extrabold text-ink tabular-nums">
                {dayHeading(d.date)}
              </h2>

              {d.rollCalls.length === 0 && d.moved.length === 0 && (
                <p className="mt-3 max-w-read text-sm text-ink-2">{t('dayEmpty')}</p>
              )}

              {d.rollCalls.length > 0 && (
                <div className="mt-6" data-block="votes">
                  <h3 className="text-md font-bold text-ink">{t('votesHeading')}</h3>
                  <ul className="mt-3 grid gap-4">
                    {d.rollCalls.map((r) => {
                      // One roll call is one section for the glossary: the
                      // record's English lines are matched as English on /es
                      // too, and the tally's labels are wired by name.
                      const seen = new Set<GlossaryTermId>();
                      return (
                      <li key={r.id} className="max-w-read border-t border-line pt-3">
                        <p className="text-xs font-semibold text-ink-2">
                          {t('voteRoll', { chamber: chamberName(r.chamber), roll: r.roll })}
                        </p>
                        <p className="mt-1 text-md text-ink">
                          <Verbatim>{glossify(r.question, 'en', seen)}</Verbatim>
                          {' — '}
                          <Verbatim className="font-bold">{glossify(r.result, 'en', seen)}</Verbatim>
                        </p>
                        {/* The tally's labels are wired by name in both
                            languages ("A favor" is no phrase a matcher could
                            safely find), and share the card's section. */}
                        <p className="mt-1 text-sm text-ink-2 tabular-nums" data-brief-tally="">
                          {t.rich('tally', {
                            ...r.totals,
                            yeaTerm: glossaryTagOnce('yea-and-nay', seen),
                            presentTerm: glossaryTagOnce('present-vote', seen),
                            notVotingTerm: glossaryTagOnce('not-voting', seen),
                          })}
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-4">
                          <Link href={`/bills/${r.bill.slug}`} className={`inline-flex min-h-11 items-center text-sm ${LINK}`}>
                            {r.bill.citation}
                          </Link>
                          <a href={r.source} target="_blank" rel="noopener noreferrer" className={`inline-flex min-h-11 items-center gap-1.5 text-sm ${LINK}`}>
                            {t('voteSource')}
                            <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
                          </a>
                        </p>
                        <p className="line-clamp-2 text-xs text-ink-2">
                          <Verbatim>{r.bill.title}</Verbatim>
                        </p>
                      </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {d.moved.length > 0 && (
                <div className="mt-8" data-block="moved">
                  <h3 className="text-md font-bold text-ink">{t('movedHeading')}</h3>
                  <ul className="mt-3 grid gap-4">
                    {d.moved.map((b) => (
                      <li key={b.slug} className="max-w-read border-t border-line pt-3">
                        <Link href={`/bills/${b.slug}`} className={`inline-flex min-h-11 items-center text-md ${LINK}`}>
                          {b.citation}
                        </Link>
                        <p className="line-clamp-2 text-xs text-ink-2">
                          <Verbatim>{b.title}</Verbatim>
                        </p>
                        {b.actionText && (
                          <p className="mt-1 text-sm text-ink">
                            <Verbatim>{b.actionText}</Verbatim>
                          </p>
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
          ))}

          {/* A QUIET DAY, ADMITTED (funnel I3). Both of the brief's days are
              empty: one status line says so for the two dates by name, and
              the latest day in the window that has any record is one tap
              away — so the page never dead-ends on a Monday. */}
          {!hasRecord && (
            <section className="mt-12 border-t border-line-strong pt-4" aria-labelledby="today-record" data-record-empty="">
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
          )}

          {/* (d) BIG QUESTIONS THAT MOVED — a vehicle's latest action falls on one
              of the brief's two days. The name is the Moment's own name. */}
          {brief.questions.length > 0 && (
            <section className="mt-12 border-t border-line-strong pt-4" aria-labelledby="today-questions">
              <h2 id="today-questions" className="text-h3 font-extrabold text-ink">
                {t('questionsHeading')}
              </h2>
              <ul className="mt-4 grid gap-4">
                {brief.questions.map((q) => (
                  <li key={q.id} className="max-w-read border-t border-line pt-3">
                    <Link href={`/questions/${q.id}`} className={`inline-flex min-h-11 items-center text-md ${LINK}`}>
                      {locale === 'es' ? q.name.es : q.name.en}
                    </Link>
                    <p className="text-sm text-ink-2 tabular-nums">
                      {q.vehicles
                        .map((v) => t('questionVehicle', { citation: v.citation, date: day(v.date) }))
                        .join(' · ')}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!brief.isToday && <p className="mt-8 max-w-read text-sm text-ink-2">{t('pastNote')}</p>}
        </div>

        {/* (e) OTHER DAYS — every dated permalink inside the 14-day window,
            newest first, each with its own counts (lib/today.ts
            `daySummary`: the lengths of the blocks that day's page prints,
            never a judgment). The brief's own day is the current page. */}
        <nav
          aria-labelledby="today-days"
          data-days=""
          className="mt-12 min-w-0 border-t border-line-strong pt-4 min-[62rem]:sticky min-[62rem]:top-4 min-[62rem]:col-start-2 min-[62rem]:mt-0 min-[62rem]:self-start min-[62rem]:[grid-row:1/span_2]"
        >
          <h2 id="today-days" className="text-h3 font-extrabold text-ink">
            {t('navLabel')}
          </h2>
          <ul className="mt-3">
            {brief.window.map((s) => {
              const current = s.date === brief.date;
              const parts = dayCountParts(s);
              return (
                <li key={s.date} className="border-t border-line first:border-t-0">
                  <Link
                    href={dayHref(s.date)}
                    aria-current={current ? 'page' : undefined}
                    data-day-row={s.date}
                    className={`flex min-h-11 items-center justify-between gap-3 text-md text-ink underline-offset-2 hover:underline ${current ? 'border-l-4 border-ink pl-3 font-bold' : ''}`}
                  >
                    <span className="tabular-nums">{rowDay(s.date)}</span>
                    <span className="text-right text-sm text-ink-2 tabular-nums">
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
          <p
            className="mt-6 max-w-read self-start text-xs text-ink-2 tabular-nums min-[62rem]:col-start-1 min-[62rem]:row-start-2 min-[62rem]:mt-8"
            data-stamps
          >
            {t('stampsLead')} {stampParts.join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
}
