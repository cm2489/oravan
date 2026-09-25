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
import { billSlug, getAllBills, getBill } from '@/lib/core/bills';
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
  signalIsLive,
  type ChamberSession,
} from '@/lib/docket';
import { formatCitation } from '@/lib/format';
import { getMoments, momentClaimsVehicles, vehicleKind } from '@/lib/moments';
import type { Bill, RollCall, RollCallTotals, VotesFile } from '@/lib/types';

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
}

export interface BriefMovedBill extends BriefBillRef {
  status: Bill['status'];
  /** The record's own sentence for the action, English verbatim. */
  actionText: string | null;
  bill: Bill;
}

export interface BriefDay {
  date: string;
  rollCalls: BriefRollCall[];
  moved: BriefMovedBill[];
  /** Bills with a latest action this day that the list does not print. */
  movedMore: number;
}

function rollCallsOn(date: string): BriefRollCall[] {
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
        },
      ];
    });
}

function dayOf(date: string): BriefDay {
  const rollCalls = rollCallsOn(date);
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
      bill: b,
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
}

export interface BriefChamberState {
  chambers: BriefChamber[];
  /** The Daily Digest the verdict came from. */
  source: { url: string | null; published: string | null } | null;
}

function chamberState(): BriefChamberState {
  return {
    chambers: (['senate', 'house'] as const).map((chamber) => ({
      chamber,
      session: chamberSession(chamber),
      nextMeeting: chamberNextMeeting(chamber),
    })),
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

function scheduleAhead(today: string): BriefScheduleItem[] {
  const file = floorSignalsFile();
  const items: BriefScheduleItem[] = [];
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
    });
  }
  const noms = (file as unknown as { nominations?: Record<string, unknown> }).nominations ?? {};
  for (const [citation, signal] of Object.entries(noms)) {
    const nomination = getAllNominations().find((n) => n.citation === citation);
    if (!nomination || isTerminalNominationStatus(nomination.status)) continue;
    if (!signalIsLive(signal, { fetchedAt: file._meta?.fetched_at ?? null })) continue;
    const t0 = (signal as { tier0: BriefScheduleItem & { covers_label?: string | null } }).tier0;
    if (!stillAhead(t0.source, t0.covers, today)) continue;
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
    });
  }
  return items.sort(
    (a, b) => a.chamber.localeCompare(b.chamber) || a.citation.localeCompare(b.citation)
  );
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

export interface Brief {
  date: string;
  isToday: boolean;
  /** Newest day first: the brief's day, then the day before. */
  days: BriefDay[];
  chamber: BriefChamberState | null;
  schedule: BriefScheduleItem[];
  questions: BriefQuestion[];
  stamps: ReturnType<typeof briefStamps>;
  /** Neighbouring permalinks inside the window, when they exist. */
  prev: string | null;
  next: string | null;
}

/** The whole brief for one date. Callers gate `date` with `isBriefDate`. */
export function buildBrief(date: string): Brief {
  const window = briefWindow();
  const isToday = date === window[0];
  const dates = [date, shiftDate(date, -1)];
  const i = window.indexOf(date);
  return {
    date,
    isToday,
    days: dates.map(dayOf),
    chamber: isToday ? chamberState() : null,
    schedule: isToday ? scheduleAhead(date) : [],
    questions: questionsMoved(dates),
    stamps: briefStamps(),
    prev: i >= 0 && i + 1 < window.length ? window[i + 1] : null,
    next: i > 0 ? window[i - 1] : null,
  };
}
