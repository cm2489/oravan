import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { glossaryTag } from '@/components/glossary-tags';
import { Link } from '@/i18n/navigation';
import type { Brief, BriefChamber, BriefScheduleItem } from '@/lib/today';

/*
 * THE DAILY BRIEF — one renderer for /today and /today/[date].
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
              <li key={c.chamber} className="text-md text-ink" data-chamber={c.chamber} data-session={c.session}>
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

      {/* (b) THE RECORD — the brief's day, then the day before. */}
      {hasRecord && brief.days.map((d) => (
        <section
          key={d.date}
          className="mt-12 border-t border-line-strong pt-4"
          aria-labelledby={`today-day-${d.date}`}
          data-day={d.date}
        >
          <h2 id={`today-day-${d.date}`} className="text-h3 font-extrabold text-ink tabular-nums">
            {longDay(d.date)}
          </h2>

          {d.rollCalls.length === 0 && d.moved.length === 0 && (
            <p className="mt-3 max-w-read text-sm text-ink-2">{t('dayEmpty')}</p>
          )}

          {d.rollCalls.length > 0 && (
            <div className="mt-6" data-block="votes">
              <h3 className="text-md font-bold text-ink">{t('votesHeading')}</h3>
              <ul className="mt-3 grid gap-4">
                {d.rollCalls.map((r) => (
                  <li key={r.id} className="max-w-read border-t border-line pt-3">
                    <p className="text-xs font-semibold text-ink-2">
                      {t('voteRoll', { chamber: chamberName(r.chamber), roll: r.roll })}
                    </p>
                    <p className="mt-1 text-md text-ink">
                      <Verbatim>{r.question}</Verbatim>
                      {' — '}
                      <Verbatim className="font-bold">{r.result}</Verbatim>
                    </p>
                    <p className="mt-1 text-sm text-ink-2 tabular-nums">{t('tally', { ...r.totals })}</p>
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
                ))}
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

      {/* (c) ON THE FLOOR SCHEDULE NEXT — quoted, dated, attributed; never a
          vote date. Current day only, like the chamber line. */}
      {brief.schedule.length > 0 && (
        <section className="mt-12 border-t border-line-strong pt-4" aria-labelledby="today-schedule">
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

      {/* (d) BIG QUESTIONS THAT MOVED — a vehicle's latest action falls on one
          of the brief's two days. The name is the owner-reviewed Moment name. */}
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

      {!hasRecord && (
        <p role="status" className="mt-12 max-w-read border-t-[3px] border-ink bg-wash p-6 text-md text-ink">
          {t('empty', { date: day(brief.date) })}
        </p>
      )}

      {!brief.isToday && <p className="mt-8 max-w-read text-sm text-ink-2">{t('pastNote')}</p>}

      {/* Day-to-day: the permalinks either side, inside the 14-day window. */}
      <nav aria-label={t('navLabel')} className="mt-12 flex flex-wrap gap-3 border-t border-line-strong pt-4">
        {brief.prev && (
          <Link
            href={`/today/${brief.prev}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-control border-2 border-ink px-4 text-sm font-bold text-ink hover:bg-ink hover:text-paper"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            <span className="tabular-nums">{day(brief.prev)}</span>
          </Link>
        )}
        {brief.next && (
          <Link
            href={`/today/${brief.next}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-control border-2 border-ink px-4 text-sm font-bold text-ink hover:bg-ink hover:text-paper"
          >
            <span className="tabular-nums">{day(brief.next)}</span>
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        )}
        {brief.isToday ? (
          <Link href={`/today/${brief.date}`} className={`inline-flex min-h-11 items-center text-sm ${LINK}`}>
            {t('permalink')}
          </Link>
        ) : (
          <Link href="/today" className={`inline-flex min-h-11 items-center text-sm ${LINK}`}>
            {t('navToday')}
          </Link>
        )}
      </nav>

      {/* (e) FRESHNESS — the stamp each block was read at, printed plainly. */}
      {stampParts.length > 0 && (
        <p className="mt-6 max-w-read text-xs text-ink-2 tabular-nums" data-stamps>
          {t('stampsLead')} {stampParts.join(' · ')}
        </p>
      )}
    </div>
  );
}
