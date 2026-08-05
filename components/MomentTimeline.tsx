import { ExternalLink } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Chip } from '@/components/system';
import { collapseQuietDays, linkHost, timelineDays } from '@/lib/moments-ui';
import { getUpdates, type MomentUpdate, VERBATIM_MODE } from '@/lib/moment-updates';

/*
 * "What's moved" — the dated timeline of a Moment's recorded activity
 * (the project records §3, §7). A SERVER component: it
 * ships zero client JavaScript, because a ledger of days that already
 * happened has nothing to react to. The one clock-dependent sentence on this
 * surface ("we have not been able to check since…") lives in its own client
 * sentinel, components/MomentQuietNote.tsx.
 *
 * ---------------------------------------------------------------------------
 * THE EDITORIAL LAW this component renders under (owner-settled 2026-07-25,
 * v2 spec §2):
 *
 *   "Truth about the record, attribution about the spin. When the record
 *    speaks, we say it plainly — numbers, dates, tallies, text — even when
 *    plainness lands harder on one side. Balance is not achieved by blunting
 *    facts. When the record is silent — motive, likelihood, what it really
 *    means — Oravan's voice stops, and named sources speak or nobody does.
 *    Speculation never wears our voice."
 *
 * The law is ENFORCED at write time (lib/moment-updates-gate.mjs lints both
 * languages). What this component owes it is three structural promises:
 *
 *  1. THE RECORD SHIPS BESIDE THE VOICE (§2.4). Every non-press update
 *     carries `record.action_text`, and every update carries its `refs`. The
 *     source links below are how a wrong decode gets falsified in one click.
 *     The kill-switch `MOMENT_UPDATES_VERBATIM=1` (read at BUILD time, since
 *     these pages are static) renders the government's verbatim text INSTEAD
 *     of Oravan's one-liner, with no data migration and no redeploy of the
 *     data file — flip the env var, rebuild, and the voice is gone.
 *  2. ATTRIBUTION, NEVER LEAN. `source.leans` exists in the data (the press
 *     guardrail needs it at write time) and is DELIBERATELY never rendered
 *     here — no lean labels, no AllSides chrome, no party-coded anything on a
 *     Moment surface (v1 spec §3.3, pinned by tests/moments.spec.ts). A press
 *     cluster names its outlets in the sentence itself, because the gate's
 *     attribution lint refuses to let it not.
 *  3. A QUIET DAY IS A FIRST-CLASS RENDER (§3). Days with nothing in them are
 *     computed by the reader, never stored as fake updates, and they print as
 *     a plain dated line. Today's silence and last Tuesday's silence are
 *     different sentences, so they use different strings.
 *
 * ── The two design laws ──────────────────────────────────────────────────
 *
 * NO NEW AMBER. A `scheduled` update prints its date in INK like every other
 * class. Amber stays exactly where DESIGN.md put it: the one dated
 * floor-calendar fact on the vehicle card. A timeline of things that already
 * happened has no amber in it at all.
 *
 * NO NEW GREEN SURFACES. Green appears only as links — the bill citation and
 * the source refs — because green means GO and a link goes somewhere. No
 * green panel, no green rule, no CTA: the call-to-action stays exclusively on
 * the hand-authored vehicle cards (v2 spec §6, the "an update never drives a
 * call" posture that keeps this inside the AI-review rule).
 *
 * INK carries the section; the day headings, the class marks, and the quiet
 * lines are all ink. Marks are `rounded-stamp` (the system Chip); nothing
 * here is a panel, so nothing here is `rounded-control`.
 */

/** The ordinary frame: two weeks of days, quiet ones included. */
const WINDOW_DAYS = 14;

/**
 * The build-time kill-switch (§2.4). Read once at module scope: these pages
 * are statically generated, so this is a property of the BUILD, not of a
 * request, and pretending otherwise would imply a per-visitor toggle that
 * does not exist.
 */
const VERBATIM = VERBATIM_MODE; // re-exported from lib so ONE flag governs every AI surface

/* Content links are green — green means GO, and a link goes somewhere. Same
   token as the Moment page's own links, restated here rather than exported
   across files, because a shared "link class" constant is how a design system
   quietly grows a second button. */
const CONTENT_LINK =
  'inline-flex min-h-11 items-center gap-1.5 font-bold text-go underline transition-colors hover:text-go-deep';

export interface TimelineVehicle {
  /** Display citation, e.g. "H.R. 9770" — already built by the caller. */
  citation: string;
  /** The bill's Congress.gov all-actions page, for the honest overflow line. */
  actionsUrl: string | null;
}

/** A per-day anchor, so a correction can point at the day it corrects. */
const dayAnchor = (day: string) => `moment-day-${day}`;

export function MomentTimeline({
  momentId,
  locale,
  vehicles,
  now,
}: {
  momentId: string;
  locale: string;
  /** vehicle slug → citation + actions URL, resolved by the page. */
  vehicles: Record<string, TimelineVehicle | undefined>;
  /** Injectable clock so a test can pin the frame; defaults inside the lib
   *  helper, which is where every clock in this codebase lives. */
  now?: number;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const lang = locale === 'es' ? 'es' : 'en';

  const all = getUpdates(momentId);
  // The frame — 14 days of ledger plus any older day carrying a real action.
  // See lib/moments-ui.ts's `timelineDays` for why the tail is kept.
  const days = timelineDays(momentId, WINDOW_DAYS, now);

  const dayOfUpdate = new Map(all.map((u) => [u.id, u.day]));
  const renderedDays = new Set(days.map((d) => d.day));

  // AI labeling is DATA-GATED: the chip appears only when a model actually
  // wrote one of the sentences on screen (hand-authored or verbatim-record
  // text is not AI content, and a permanent chip over non-AI text is a label
  // that has stopped meaning anything). One chip for the section, above the
  // content it labels — the first-contact rule.
  const hasAi = !VERBATIM && days.some((d) => d.rendered.some((u) => u.ai));

  // Day strings are date-only ("YYYY-MM-DD"), so they format in UTC — in any
  // other zone a July 23 legislative day prints as July 22 for every viewer
  // west of Greenwich.
  const fmtDay = (day: string) =>
    format.dateTime(new Date(day), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });

  // A quiet run's span, oldest day first — chronological reading order
  // ("July 24 – August 1, 2026"), even though the ledger itself stays newest
  // first: the run row sits where its newest day sat. Same UTC pinning as
  // fmtDay, for the same west-of-Greenwich reason.
  const fmtRange = (from: string, to: string) =>
    format.dateTimeRange(new Date(from), new Date(to), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });

  return (
    <div className="mt-6">
      {hasAi && (
        <p className="mb-6">
          <Chip tone="ai" marker={t('common.aiMarker')} className="max-w-read">
            {t('moments.updates.timelineAiChip')}
          </Chip>
        </p>
      )}

      {collapseQuietDays(days).map((row) => {
        if (row.kind === 'quietRun') {
          /* A quiet RUN: two or more consecutive quiet, non-today days folded
             into one spanned ink line (see collapseQuietDays for the rules —
             today never folds, a singleton stays a plain quiet day). Same
             non-shape as the quiet day: NOT a heading, NOT interactive, no
             id — a quiet stretch still earns no rung in the outline and adds
             no focus stop. The sentence carries the day count so the span
             survives screen readers even if the dash range reads awkwardly. */
          return (
            <p
              key={`${row.from}--${row.to}`}
              className="flex flex-wrap items-baseline gap-x-3 border-t border-line py-1 text-sm text-ink-2"
            >
              <span className="font-semibold tabular-nums">{fmtRange(row.from, row.to)}</span>
              <span>{t('moments.updates.quietRun', { count: row.count })}</span>
            </p>
          );
        }
        const day = row.day;
        return day.quiet ? (
          /* A quiet day: one ink line, computed at render, never a stored
             fake update. No heading — a day with nothing in it does not earn
             a rung in the document outline. */
          <p
            key={day.day}
            className="flex flex-wrap items-baseline gap-x-3 border-t border-line py-1 text-sm text-ink-2"
          >
            <span className="font-semibold tabular-nums">{fmtDay(day.day)}</span>
            <span>{day.isToday ? t('moments.updates.quietToday') : t('moments.updates.quietDay')}</span>
          </p>
        ) : (
          <div key={day.day} id={dayAnchor(day.day)} className="border-t border-line pt-4 pb-2">
            <h3 className="text-md leading-tight font-bold text-ink tabular-nums">{fmtDay(day.day)}</h3>

            <ol className="mt-3 list-none">
              {day.rendered.map((update) => (
                <TimelineItem
                  key={update.id}
                  update={update}
                  lang={lang}
                  vehicle={vehicles[update.vehicle]}
                  correctsDay={
                    update.corrects && renderedDays.has(dayOfUpdate.get(update.corrects) ?? '')
                      ? dayOfUpdate.get(update.corrects)
                      : undefined
                  }
                />
              ))}
            </ol>

            {/* The honest overflow line (§3): the store keeps every qualified
                event, the render caps at five, and the count of what the cap
                held back is printed rather than swallowed. It points at the
                first held-back update's own vehicle actions page, which is
                where the full list actually lives. */}
            {day.overflow > 0 && (
              <p className="mt-3 text-sm">
                <OverflowLine
                  count={day.overflow}
                  vehicle={vehicles[day.updates[day.rendered.length]?.vehicle ?? '']}
                />
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OverflowLine({ count, vehicle }: { count: number; vehicle?: TimelineVehicle }) {
  const t = useTranslations();
  const label = t('moments.updates.overflow', { count });
  // No actions URL (a vehicle the corpus lost) still prints the COUNT — the
  // number is the honest part; the link is the convenience.
  if (!vehicle?.actionsUrl) return <span className="text-ink-2">{label}</span>;
  return (
    <a href={vehicle.actionsUrl} target="_blank" rel="noopener noreferrer" className={CONTENT_LINK}>
      {label} →<ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

function TimelineItem({
  update,
  lang,
  vehicle,
  correctsDay,
}: {
  update: MomentUpdate;
  lang: 'en' | 'es';
  vehicle?: TimelineVehicle;
  correctsDay?: string;
}) {
  const t = useTranslations();

  // The kill-switch swaps the voice for the record on every class that HAS a
  // record; a press cluster has none (record === null by schema), so it keeps
  // its attributed sentence either way.
  const verbatim = VERBATIM && update.record !== null;
  const body = verbatim ? update.record!.action_text : update.text[lang];

  return (
    <li className="border-t border-line py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* A correction takes the `stale` tone — a full ink outline mark, the
            system's existing "this is a caveat about the record" shape. Never
            amber: amber is one dated floor-calendar fact and a correction is
            not one. Every other class takes the ordinary ink tag. */}
        <Chip tone={update.class === 'correction' ? 'stale' : 'tag'}>
          {t(`moments.updates.class.${update.class}`)}
        </Chip>
        {vehicle && (
          <Link href={`/bills/${update.vehicle}`} className={`${CONTENT_LINK} text-sm tabular-nums`}>
            {vehicle.citation}
          </Link>
        )}
      </div>

      {verbatim && (
        <p className="mt-2 text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase">
          {t('moments.updates.verbatimLabel')}
        </p>
      )}
      <p className="mt-2 max-w-read text-md text-ink">{body}</p>

      {update.class === 'correction' && correctsDay && (
        <p className="mt-1 text-sm">
          <a href={`#${dayAnchor(correctsDay)}`} className={`${CONTENT_LINK} text-sm`}>
            {t('moments.updates.correctionLink')} ↑
          </a>
        </p>
      )}

      {update.source.refs.length > 0 && (
        <p className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase">
            {t('moments.updates.sourcesLabel')}
          </span>
          {update.source.refs.map((ref) => (
            <a
              key={ref}
              href={ref}
              target="_blank"
              rel="noopener noreferrer"
              className={`${CONTENT_LINK} text-sm`}
            >
              {linkHost(ref)}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ))}
        </p>
      )}
    </li>
  );
}
