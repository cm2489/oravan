/*
 * /today — the daily brief, derived. Pure reads over files that already exist;
 * nothing here writes, fetches, or calls a model, and nothing here renders a
 * string (the page maps every field to a message key).
 *
 * NO NEW TRUTH. Every fact below is one another surface already reads, through
 * the same helper it reads it with:
 *   chamber state + next meeting  lib/docket.ts  chamberSession / chamberNextMeeting
 *                                 (the homepage's quiet-week note and the bill
 *                                 page's FloorRecessNote read the same pair)
 *   the published floor schedule  lib/docket.ts  announcementFor (bills: the
 *                                 crown's own gate) / signalIsLive (nominations)
 *   roll calls                    data/votes.json, as lib/votes.ts reads it
 *   bills that moved              data/bills.json `last_action_date`
 *   Big Questions that moved      lib/moments.ts + the vehicles' own records
 *   each bill's card              lib/core/bills.ts teaserFor — the card /bills
 *                                 prints, AI headline included (the page
 *                                 labels it; components/TodayBrief.tsx)
 *
 * WHICH DAY IS "TODAY". Not the build machine's clock: the date of the newest
 * stamp the data itself carries (floor schedule re-check, votes update, bill
 * sync), in Eastern time, because that is the calendar the record dates its
 * actions in. Two consequences, both deliberate:
 *   1. the window of dated permalinks is a function of the committed files, so
 *      a page rendered on demand can never compute a different window than the
 *      build did — and can never print an empty "nothing happened" day for a
 *      date the data never reached;
 *   2. when the pipeline stalls, /today keeps saying the last day it can vouch
 *      for, under a heading that names that day, rather than presenting a
 *      silent day as a quiet one.
 *
 * WHAT A PAST DAY CAN SHOW. data/bills.json keeps each bill's LATEST action
 * only, so a dated page lists bills whose latest action is still that day —
 * the headings say exactly that. The floor schedule is re-read hourly and not
 * archived, so the chamber line and the schedule block exist on the current
 * day only. Roll calls are kept whole, so every past day shows all of them.
 */
import votesJson from '@/data/votes.json';
import syncState from '@/data/sync-state.json';
import { billSlug, getAllBills, getBill, teaserFor } from '@/lib/core/bills';
import {
  getAllNominations,
  isTerminalNominationStatus,
  nominationSlug,
} from '@/lib/core/nominations';
import {
  announcementFor,
  chamberNextMeeting,
  chamberSession,
  floorSessionSource,
  floorSignalsCheckedAt,
  floorSignalsFile,
  floorSourcesPosture,
  signalIsLive,
  type ChamberSession,
  type FloorSignalTier0,
} from '@/lib/docket';
import { formatCitation } from '@/lib/format';
import { getMoments, momentClaimsVehicles, vehicleKind } from '@/lib/moments';
import type { Bill, FeedTeaser, RollCall, RollCallTotals, VotesFile } from '@/lib/types';

const VOTES = votesJson as unknown as VotesFile;

/** How many dated permalinks exist, counting today. Older dates 404. */
export const BRIEF_WINDOW_DAYS = 14;
/** How many bills a day's "moved" list prints before it becomes a count. */
export const MOVED_BILLS_SHOWN = 8;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** A full instant → its calendar date in Eastern time, `YYYY-MM-DD`. */
export function easternDate(instant: string | number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

/** `YYYY-MM-DD` shifted by whole days (calendar arithmetic, UTC-pinned). */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The three stamps the brief is built from, newest first by kind. */
export function briefStamps(): { floor: string | null; votes: string | null; bills: string | null } {
  const ok = (s: unknown) => (typeof s === 'string' && Number.isFinite(Date.parse(s)) ? s : null);
  return {
    floor: floorSignalsCheckedAt(),
    votes: ok(VOTES._meta?.updatedAt),
    bills: ok(syncState.lastRun),
  };
}

/** The brief's "today": the Eastern date of the newest data stamp. */
export function briefToday(): string {
  const stamps = Object.values(briefStamps()).filter((s): s is string => s !== null);
  const newest = stamps.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  return easternDate(newest);
}

/** Every date with a permalink, newest first: today and the 13 days before. */
export function briefWindow(): string[] {
  const today = briefToday();
  return Array.from({ length: BRIEF_WINDOW_DAYS }, (_, i) => shiftDate(today, -i));
}

export function isBriefDate(date: string): boolean {
  return DATE_RE.test(date) && briefWindow().includes(date);
}

// ---- the blocks -------------------------------------------------------------

export interface BriefBillRef {
  slug: string;
  citation: string;
  /** The official title, English verbatim — the record's own words. */
  title: string;
}

function billRef(bill: Bill): BriefBillRef {
  return {
    slug: billSlug(bill),
    citation: formatCitation(bill.bill_type, bill.bill_number),
    title: (bill.short_title || bill.title).trim(),
  };
}

export interface BriefRollCall {
  id: string;
  chamber: 'house' | 'senate';
  roll: number;
  question: string;
  result: string;
  totals: RollCallTotals;
  source: string;
  bill: BriefBillRef;
  /** The bill's /bills card data (lib/core/bills.ts `teaserFor`), in the
   *  brief's locale. Present when the brief was built for a locale. */
  teaser?: FeedTeaser;
}

export interface BriefMovedBill extends BriefBillRef {
  status: Bill['status'];
  /** The record's own sentence for the action, English verbatim. */
  actionText: string | null;
  /** The bill's /bills card data, in the brief's locale (see BriefRollCall). */
  teaser?: FeedTeaser;
}

export interface BriefDay {
  date: string;
  rollCalls: BriefRollCall[];
  moved: BriefMovedBill[];
  /** Bills with a latest action this day that the list does not print. */
  movedMore: number;
}

/**
 * `locale` is set only when a page prints the day: then each bill carries its
 * card data (`teaser`). The "Other days" counts read the same function without
 * it, so the counts never pay for cards they do not print.
 */
function rollCallsOn(date: string, locale?: string): BriefRollCall[] {
  return VOTES.rollCalls
    .filter((r: RollCall) => r.date === date)
    .sort((a, b) => a.chamber.localeCompare(b.chamber) || a.roll - b.roll)
    .flatMap((r) => {
      const bill = getBill(r.bill);
      if (!bill) return [];
      return [
        {
          id: r.id,
          chamber: r.chamber,
          roll: r.roll,
          question: r.question,
          result: r.result,
          totals: r.totals,
          source: r.source,
          bill: billRef(bill),
          ...(locale ? { teaser: teaserFor(bill, locale) } : {}),
        },
      ];
    });
}

function dayOf(date: string, locale?: string): BriefDay {
  const rollCalls = rollCallsOn(date, locale);
  // A bill already shown under a roll call that day is not listed twice.
  const voted = new Set(rollCalls.map((r) => r.bill.slug));
  const moved = getAllBills()
    .filter((b) => b.last_action_date === date && !voted.has(billSlug(b)))
    .sort((a, b) => (b.urgency_score ?? 0) - (a.urgency_score ?? 0) || billSlug(a).localeCompare(billSlug(b)));
  return {
    date,
    rollCalls,
    moved: moved.slice(0, MOVED_BILLS_SHOWN).map((b) => ({
      ...billRef(b),
      status: b.status,
      actionText: b.last_action_text?.trim() || null,
      ...(locale ? { teaser: teaserFor(b, locale) } : {}),
    })),
    movedMore: Math.max(0, moved.length - MOVED_BILLS_SHOWN),
  };
}

export interface BriefChamber {
  chamber: 'house' | 'senate';
  session: ChamberSession;
  /** The Daily Digest's own next-meeting line (English verbatim), or our
   *  derived ISO date when it printed none; null when no meeting ahead. */
  nextMeeting: { iso: string | null; label: string | null } | null;
  /** True when the verdict is `in_session` but the chamber's next sitting
   *  falls after the brief's day — see `meetsAfterDay`. */
  meetsLater: boolean;
}

/**
 * "IN SESSION" IS A CLAIM ABOUT A DAY (audit 2026-09-27, SY-31).
 *
 * `_meta.in_session` is read off the Daily Digest's "Program for" blocks: a
 * program that is not pro forma makes the verdict `in_session`, whatever day
 * that program is FOR (scripts/floor-signals-parse.mjs `sessionFromProgram`).
 * So on Saturday, Sep 26, 2026 the brief printed "Senate: in session" off the
 * program for 3 p.m., Monday, September 28 — while quoting that same Monday
 * meeting in its schedule block. The verdict is not wrong about the program;
 * it is wrong as a sentence about the brief's day.
 *
 * True when the verdict is `in_session` AND the next meeting's derived date
 * is strictly after `day`; the page then says when the chamber next meets
 * instead. A meeting ON the brief's day keeps "in session", and so does a
 * next meeting with no derivable date — a label alone cannot be ordered
 * against the day, so nothing is claimed about it. The stored verdict itself
 * is untouched: other surfaces read it with their own rules.
 */
export function meetsAfterDay(
  c: Pick<BriefChamber, 'session' | 'nextMeeting'>,
  day: string,
): boolean {
  const iso = c.nextMeeting?.iso ?? null;
  return c.session === 'in_session' && iso !== null && DATE_RE.test(iso) && DATE_RE.test(day) && iso > day;
}

export interface BriefChamberState {
  chambers: BriefChamber[];
  /** The Daily Digest the verdict came from. */
  source: { url: string | null; published: string | null } | null;
}

function chamberState(day: string): BriefChamberState {
  return {
    chambers: (['senate', 'house'] as const).map((chamber) => {
      const session = chamberSession(chamber);
      const nextMeeting = chamberNextMeeting(chamber);
      return { chamber, session, nextMeeting, meetsLater: meetsAfterDay({ session, nextMeeting }, day) };
    }),
    source: floorSessionSource(),
  };
}

export interface BriefScheduleItem {
  kind: 'bill' | 'nomination';
  chamber: 'house' | 'senate';
  /** The chamber's own sentence, English verbatim. */
  quote: string;
  url: string;
  published: string;
  coversLabel: string | null;
  covers: string | null;
  source: 'daily-digest' | 'billsthisweek';
  href: string;
  citation: string;
  /** Which verb the chamber used — see `floorTagFor`. */
  certainty: FloorSignalTier0['certainty'];
  /** The tag the card prints over the quote, or null for none. */
  tag: FloorTag | null;
  /** A bill item's /bills card data, in the brief's locale. Nominations have
   *  no teaser: their card is headed by the citation. */
  teaser?: FeedTeaser;
}

/**
 * THE FLOOR-NOTICE TAG (owner, 2026-09-29: "if there is a vote this week
 * scheduled it needs to have a yellow tag or something that explicitly draws
 * attention to it").
 *
 * WHAT IT MAY SAY (page 1, rule 6; docs/record-truth.md: "A schedule names
 * measures for a session; it does not schedule votes, and neither does
 * Oravan"). The tag names the chamber's own notice and the date of the meeting
 * it covers — never "vote scheduled". The chamber's words are quoted under it.
 *
 *   scheduled_vote  the Senate's program says "will vote on"  → the yellow
 *                   (`urgent`) chip, dated with `covers`
 *   consideration   the Senate program's other verbs, and every House weekly
 *                   item                                      → ink, dated
 *                   (the House item says "week of")
 *   conditional     "If Senator …" / "If cloture …"           → ink, no date
 *
 * FAILS CLOSED. Yellow needs all three: the "will vote on" verb, a `covers`
 * date to print (the chip's type will not build a dateless yellow), and the
 * chamber `in_session` on the brief — rule 6 lets a floor claim present as
 * live only while that chamber is meeting. Missing any one, the same notice
 * prints in ink. A dated past brief has no schedule, so never a tag.
 */
export interface FloorTag {
  tone: 'urgent' | 'status';
  /** A message key from the catalogue root. */
  key: 'bill.floor.announcedSenate' | 'bill.floor.announcedHouse' | 'today.tagConditional';
  /** `covers`, formatted by the page in the reader's locale; null prints no date. */
  dateIso: string | null;
  /** True when the date is the first day of a weekly schedule ("week of"). */
  week: boolean;
}

export function floorTagFor(item: {
  certainty: FloorSignalTier0['certainty'];
  chamber: 'house' | 'senate';
  covers: string | null;
  source: 'daily-digest' | 'billsthisweek';
  session: ChamberSession;
}): FloorTag | null {
  const covers = item.covers && DATE_RE.test(item.covers) ? item.covers : null;
  const key = item.chamber === 'senate' ? 'bill.floor.announcedSenate' : 'bill.floor.announcedHouse';
  if (item.certainty === 'conditional') {
    return { tone: 'status', key: 'today.tagConditional', dateIso: null, week: false };
  }
  const week = item.source === 'billsthisweek';
  if (item.certainty === 'scheduled_vote' && covers && !week && item.session === 'in_session') {
    return { tone: 'urgent', key, dateIso: covers, week: false };
  }
  return { tone: 'status', key, dateIso: covers, week: week && covers !== null };
}

/**
 * STILL AHEAD, NOT MERELY STILL LIVE. `signalIsLive` keeps a Senate program
 * live for two days past the meeting it covers (so the crown survives the
 * night the next digest has not yet arrived). The brief's schedule block is
 * titled "next", so it additionally drops an announcement whose meeting is
 * before today: a Senate program covers ONE meeting (`covers` must be today or
 * later); the House weekly schedule covers its week (`covers` + 6 days).
 */
function stillAhead(source: string, covers: string | null, today: string): boolean {
  if (!covers || !DATE_RE.test(covers)) return true;
  const last = source === 'billsthisweek' ? shiftDate(covers, 6) : covers;
  return last >= today;
}

function scheduleAhead(today: string, locale: string): BriefScheduleItem[] {
  const file = floorSignalsFile();
  const items: BriefScheduleItem[] = [];
  const session = (chamber: 'house' | 'senate') => chamberSession(chamber);
  for (const slug of Object.keys(file.signals ?? {})) {
    const bill = getBill(slug);
    if (!bill) continue;
    // The crown's own gate: a spent, pulled, or aged announcement is null.
    const a = announcementFor(bill, slug);
    if (!a || !stillAhead(a.source, a.covers, today)) continue;
    items.push({
      kind: 'bill',
      chamber: a.chamber,
      quote: a.quote,
      url: a.url,
      published: a.published,
      coversLabel: a.coversLabel,
      covers: a.covers,
      source: a.source,
      href: `/bills/${slug}`,
      citation: formatCitation(bill.bill_type, bill.bill_number),
      certainty: a.certainty,
      tag: floorTagFor({ ...a, session: session(a.chamber) }),
      teaser: teaserFor(bill, locale),
    });
  }
  const noms = (file as unknown as { nominations?: Record<string, unknown> }).nominations ?? {};
  for (const [citation, signal] of Object.entries(noms)) {
    const nomination = getAllNominations().find((n) => n.citation === citation);
    if (!nomination || isTerminalNominationStatus(nomination.status)) continue;
    if (!signalIsLive(signal, { fetchedAt: file._meta?.fetched_at ?? null })) continue;
    const t0 = (signal as { tier0: FloorSignalTier0 }).tier0;
    if (!stillAhead(t0.source, t0.covers, today)) continue;
    const certainty = t0.certainty ?? 'consideration';
    items.push({
      kind: 'nomination',
      chamber: 'senate',
      quote: t0.quote,
      url: t0.url,
      published: t0.published,
      coversLabel: t0.covers_label ?? null,
      covers: t0.covers ?? null,
      source: t0.source,
      href: `/nominations/${nominationSlug(nomination)}`,
      citation,
      certainty,
      tag: floorTagFor({
        certainty,
        chamber: 'senate',
        covers: t0.covers ?? null,
        source: t0.source,
        session: session('senate'),
      }),
    });
  }
  return yellowTagFirst(
    items.sort((a, b) => a.chamber.localeCompare(b.chamber) || a.citation.localeCompare(b.citation))
  );
}

/**
 * THE YELLOW-TAGGED NOTICE COMES FIRST. A tag meant to draw the eye has to be
 * where the eye lands: on a phone the band's third card sat about two screens
 * down (independent check, 2026-09-29). A notice whose tag `floorTagFor` made
 * `urgent` moves ahead of every notice it did not; the test is the tag that
 * function already produced, never a second one. The partition is stable: the
 * yellow notices keep their order among themselves, and so do the rest, so
 * with no yellow notice the band reads exactly as before. Only the /today
 * schedule block reads this order (`scheduleAhead`).
 */
export function yellowTagFirst<T extends { tag: FloorTag | null }>(items: T[]): T[] {
  const yellow = items.filter((i) => i.tag?.tone === 'urgent');
  const rest = items.filter((i) => i.tag?.tone !== 'urgent');
  return [...yellow, ...rest];
}

export interface BriefQuestion {
  id: string;
  name: { en: string; es: string };
  /** The vehicles whose latest action falls on one of the brief's days. */
  vehicles: { citation: string; date: string }[];
}

function questionsMoved(days: string[]): BriefQuestion[] {
  const out: BriefQuestion[] = [];
  for (const m of getMoments()) {
    if (!momentClaimsVehicles(m)) continue;
    const vehicles = m.vehicles.flatMap((v) => {
      if (vehicleKind(v) === 'nomination') {
        const n = getAllNominations().find((x) => nominationSlug(x) === v.slug);
        return n?.last_action_date && days.includes(n.last_action_date)
          ? [{ citation: n.citation, date: n.last_action_date }]
          : [];
      }
      const b = getBill(v.slug);
      return b?.last_action_date && days.includes(b.last_action_date)
        ? [{ citation: formatCitation(b.bill_type, b.bill_number), date: b.last_action_date }]
        : [];
    });
    if (vehicles.length > 0) out.push({ id: m.id, name: m.name, vehicles });
  }
  return out;
}

// ---- the day list ("Other days") -------------------------------------------

/**
 * ONE DATE'S COUNTS, for the "Other days" list (wireframes v2, 2026-09-29,
 * today.html). Mechanical, never a judgment: each number is the length of a
 * block that date's own page prints, read through the same `dayOf` that page
 * reads, so a row can never promise more or less than the page it links to.
 */
export interface BriefDaySummary {
  date: string;
  /** Roll calls on a bill we track, dated this day: the day's votes block. */
  votes: number;
  /** Bills whose LATEST action is dated this day and that no roll call that
   *  day already lists: the day's bills block, printed rows plus its "more"
   *  count. data/bills.json keeps the latest action only, so an earlier
   *  action on a bill that has moved again since is not counted here — the
   *  same limit the day's own heading states. */
  bills: number;
  /** Big Questions with a vehicle whose latest action is dated this day. */
  questions: number;
}

export function daySummary(date: string): BriefDaySummary {
  const d = dayOf(date);
  return {
    date,
    votes: d.rollCalls.length,
    bills: d.moved.length + d.movedMore,
    questions: questionsMoved([date]).length,
  };
}

/** True when the date's own page has anything to print from the record. */
export function dayHasRecord(s: BriefDaySummary): boolean {
  return s.votes > 0 || s.bills > 0 || s.questions > 0;
}

export type DayCountKey = 'dayCountVotes' | 'dayCountBills' | 'dayCountQuestions';

/**
 * The parts of a row's count label, in print order: votes, then bills. A day
 * with neither prints its Big Questions count instead (only a nomination
 * vehicle can move a Big Question on a day with no bill on file), and a day
 * with nothing at all returns no parts — the row then says it has no record.
 */
export function dayCountParts(s: BriefDaySummary): { key: DayCountKey; count: number }[] {
  const parts: { key: DayCountKey; count: number }[] = [];
  if (s.votes > 0) parts.push({ key: 'dayCountVotes', count: s.votes });
  if (s.bills > 0) parts.push({ key: 'dayCountBills', count: s.bills });
  if (parts.length === 0 && s.questions > 0) parts.push({ key: 'dayCountQuestions', count: s.questions });
  return parts;
}

/** Every date in the window with its counts, newest first. */
export function briefDays(): BriefDaySummary[] {
  return briefWindow().map(daySummary);
}

/**
 * THE LATEST DAY WITH RECORD — where a quiet brief points (funnel I3: a quiet
 * day is admitted, and it does not dead-end). The newest date in the window,
 * other than the ones in `except`, whose own page prints something from the
 * record. Newest in the whole window, not merely older than the brief: on a
 * past dated page a newer day can be the latest, and the label says "latest".
 * Null when no other date in the window has any record.
 */
export function latestRecordDay(days: BriefDaySummary[], except: string[]): string | null {
  return days.find((s) => !except.includes(s.date) && dayHasRecord(s))?.date ?? null;
}

export interface Brief {
  date: string;
  isToday: boolean;
  /** Newest day first: the brief's day, then the day before. */
  days: BriefDay[];
  chamber: BriefChamberState | null;
  schedule: BriefScheduleItem[];
  /**
   * What the schedule's sources say about themselves (lib/docket.ts
   * `floorSourcesPosture`), on the current day only. `quiet` is the one
   * posture that lets an empty schedule block say so; `unknown` means our own
   * reading may be why it is empty, so the page says nothing about Congress.
   * Null on a dated past brief, which has no schedule block.
   */
  schedulePosture: 'quiet' | 'unknown' | null;
  questions: BriefQuestion[];
  stamps: ReturnType<typeof briefStamps>;
  /** Every date with a permalink and its counts, newest first. */
  window: BriefDaySummary[];
  /** The latest other day with record, for a brief whose two days are empty. */
  latestRecord: string | null;
}

/**
 * The whole brief for one date, with every bill's card data in `locale`.
 * Callers gate `date` with `isBriefDate`.
 */
export function buildBrief(date: string, locale = 'en'): Brief {
  const window = briefWindow();
  const isToday = date === window[0];
  const dates = [date, shiftDate(date, -1)];
  const days = briefDays();
  return {
    date,
    isToday,
    days: dates.map((d) => dayOf(d, locale)),
    chamber: isToday ? chamberState(date) : null,
    schedule: isToday ? scheduleAhead(date, locale) : [],
    schedulePosture: isToday ? floorSourcesPosture() : null,
    questions: questionsMoved(dates),
    stamps: briefStamps(),
    window: days,
    latestRecord: latestRecordDay(days, dates),
  };
}
