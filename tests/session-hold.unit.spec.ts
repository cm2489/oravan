import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  SESSION_HOLD_MAX_DAYS,
  SIGNAL_STALE_HOURS,
  chamberNextMeetingFrom,
  chamberSessionFrom,
  floorSessionSourceFrom,
  floorSignalsHealthy,
  meetingInstant,
  sessionHoldActive,
  sessionHoldFrom,
} from '../lib/docket.mjs';
import { floorFactSuspended } from '../lib/journey';
import { materialFingerprint, nextSessionHold, shouldWrite, verifyFloorSignals } from '../scripts/floor-signals-parse.mjs';

/*
 * "AWAY UNTIL THE MEETING IT NAMED" (owner, 2026-11-19; docs/record-truth.md
 * §5). Every input is FROZEN: the floor-signals files are fixtures (four real
 * commits of October 2026 under tests/fixtures/floor-signals-2026-10/, the
 * rest built here) and every clock is passed in. Nothing reads data/ or
 * Date.now(), so this file cannot turn red as the calendar moves on.
 */

type Chamber = 'house' | 'senate';
/** Fixtures here are deliberately loose: half the cases are malformed files. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (iso: string) => Date.parse(iso);

/** The rule as it stood before 2026-11-19, copied verbatim, so a test can
 *  prove the new one only ever ADDS an out-of-session reading. */
function chamberSessionBefore(meta: Json, chamber: Chamber, now: number, checked: Json = null) {
  const stamp = Date.parse(floorSignalsHealthy(meta, checked).fetched_at ?? '');
  if (!Number.isFinite(stamp) || now - stamp > SIGNAL_STALE_HOURS * 3_600_000) return 'unknown';
  const value = meta?.in_session?.[chamber];
  return value === 'in_session' || value === 'out_of_session' ? value : 'unknown';
}

/** A file whose last write was at `fetchedAt`, with an optional verdict and holds. */
function meta(opts: {
  fetchedAt: string;
  senate?: string;
  house?: string;
  holdSenate?: Json;
  holdHouse?: Json;
  nextMeeting?: Json;
  source?: Json;
}) {
  return {
    fetched_at: opts.fetchedAt,
    sources: { 'daily-digest': opts.source ?? { status: 'error', url: null, published: null } },
    in_session: { senate: opts.senate ?? 'unknown', house: opts.house ?? 'unknown', basis: 'Daily Digest "Program for" blocks' },
    next_meeting: opts.nextMeeting ?? { senate: null, house: null },
    session_hold: { senate: opts.holdSenate ?? null, house: opts.holdHouse ?? null },
  };
}

/* A Friday Digest naming a Tuesday pro forma session, the Thanksgiving shape. */
const DIGEST = '2026-11-20';
const URL = 'https://www.govinfo.gov/content/pkg/CREC-2026-11-20/html/CREC-2026-11-20-pt1-PgD1040.htm';
const TUESDAY = { digest: DIGEST, url: URL, date: '2026-11-24', label: '11 a.m., Tuesday, November 24' };
// 11 a.m. EST on 2026-11-24 is 16:00 UTC.
const TUESDAY_MEETS = at('2026-11-24T16:00:00Z');

test.describe('the named meeting, as an instant', () => {
  test('the label’s own time, read in Eastern time, on both sides of the clock change', () => {
    expect(meetingInstant('2026-11-24', '11 a.m., Tuesday, November 24')).toBe(TUESDAY_MEETS);
    // EDT (UTC-4) before November 1, 2026.
    expect(meetingInstant('2026-10-22', '9 a.m., Thursday, October 22')).toBe(at('2026-10-22T13:00:00Z'));
    expect(meetingInstant('2026-10-22', '3 p.m., Thursday, October 22')).toBe(at('2026-10-22T19:00:00Z'));
    // EST (UTC-5) after it.
    expect(meetingInstant('2026-11-02', '4:30 p.m., Monday, November 2')).toBe(at('2026-11-02T21:30:00Z'));
    expect(meetingInstant('2026-10-29', '12 noon, Thursday, October 29')).toBe(at('2026-10-29T16:00:00Z'));
    expect(meetingInstant('2026-11-09', '12 p.m., Monday, November 9')).toBe(at('2026-11-09T17:00:00Z'));
    expect(meetingInstant('2026-11-30', '12:30 a.m., Monday, November 30')).toBe(at('2026-11-30T05:30:00Z'));
  });

  test('no readable time: the start of the named day, Eastern, so the whole day counts as a possible meeting', () => {
    expect(meetingInstant('2026-11-24', 'Tuesday, November 24')).toBe(at('2026-11-24T05:00:00Z'));
    expect(meetingInstant('2026-11-24', null)).toBe(at('2026-11-24T05:00:00Z'));
    expect(meetingInstant('2026-11-24', '25 p.m., Tuesday')).toBe(at('2026-11-24T05:00:00Z'));
    expect(meetingInstant('2026-11-24', '11:75 a.m., Tuesday')).toBe(at('2026-11-24T05:00:00Z'));
  });

  test('no usable date: no instant', () => {
    expect(meetingInstant('2026-11-2', '11 a.m.')).toBeNull();
    expect(meetingInstant('November 24', '11 a.m.')).toBeNull();
    expect(meetingInstant(null as Json, '11 a.m.')).toBeNull();
    expect(meetingInstant('2026-13-40', '11 a.m.')).toBeNull();
  });
});

test.describe('the reading, with an injected clock', () => {
  test('out with a future date stays out past the 48-hour ceiling and past the 5-day ceiling', () => {
    const m = meta({ fetchedAt: '2026-11-20T15:00:00Z', senate: 'out_of_session', holdSenate: TUESDAY });
    // Fresh: today's rule already says out.
    expect(chamberSessionFrom(m, 'senate', at('2026-11-21T12:00:00Z'))).toBe('out_of_session');
    // Past 48 hours: today's rule said unknown; the hold keeps it out.
    expect(chamberSessionBefore(m, 'senate', at('2026-11-22T16:00:00Z'))).toBe('unknown');
    expect(chamberSessionFrom(m, 'senate', at('2026-11-22T16:00:00Z'))).toBe('out_of_session');
    // Past 5 days from the Digest, on a meeting named 7 days out.
    const far = { ...TUESDAY, date: '2026-11-27', label: '10 a.m., Friday, November 27' };
    const m2 = meta({ fetchedAt: '2026-11-20T15:00:00Z', senate: 'out_of_session', holdSenate: far });
    expect(chamberSessionFrom(m2, 'senate', at('2026-11-26T12:00:00Z'))).toBe('out_of_session');
    expect(chamberSessionFrom(m2, 'senate', at('2026-11-27T14:59:00Z'))).toBe('out_of_session');
    expect(chamberSessionFrom(m2, 'senate', at('2026-11-27T15:00:00Z'))).toBe('unknown');
  });

  test('a run that read no Digest (a fetch error) keeps the hold: fresh file, unknown verdict, still out', () => {
    const m = meta({ fetchedAt: '2026-11-22T12:00:00Z', holdSenate: TUESDAY });
    expect(chamberSessionBefore(m, 'senate', at('2026-11-22T13:00:00Z'))).toBe('unknown');
    expect(chamberSessionFrom(m, 'senate', at('2026-11-22T13:00:00Z'))).toBe('out_of_session');
  });

  test('the named day itself: out until the printed time, a meeting from it', () => {
    const m = meta({ fetchedAt: '2026-11-20T15:00:00Z', holdSenate: TUESDAY });
    expect(chamberSessionFrom(m, 'senate', at('2026-11-24T05:00:00Z'))).toBe('out_of_session'); // midnight Eastern
    expect(chamberSessionFrom(m, 'senate', TUESDAY_MEETS - 60_000)).toBe('out_of_session'); // 10:59 a.m.
    expect(chamberSessionFrom(m, 'senate', TUESDAY_MEETS)).toBe('unknown'); // 11:00 a.m.
    expect(floorFactSuspended('pending', chamberSessionFrom(m, 'senate', TUESDAY_MEETS))).toBe(false);
  });

  test('the named day with no printed time: the whole day is a possible meeting', () => {
    const untimed = { ...TUESDAY, label: 'Tuesday, November 24' };
    const m = meta({ fetchedAt: '2026-11-20T15:00:00Z', holdSenate: untimed });
    expect(chamberSessionFrom(m, 'senate', at('2026-11-24T04:59:00Z'))).toBe('out_of_session'); // 11:59 p.m. Monday
    expect(chamberSessionFrom(m, 'senate', at('2026-11-24T05:00:00Z'))).toBe('unknown');
  });

  test('the day after, with no newer Digest: unknown, which counts as meeting', () => {
    const m = meta({ fetchedAt: '2026-11-20T15:00:00Z', holdSenate: TUESDAY });
    const wed = at('2026-11-25T15:00:00Z');
    expect(chamberSessionFrom(m, 'senate', wed)).toBe('unknown');
    expect(floorFactSuspended('pending', chamberSessionFrom(m, 'senate', wed))).toBe(false);
    expect(floorFactSuspended('calendar', chamberSessionFrom(m, 'senate', wed))).toBe(false);
  });

  test('a newer Digest saying in session before the named date wins at once', () => {
    // The reader: a fresh in-session verdict answers before Json hold is asked.
    const m = meta({ fetchedAt: '2026-11-22T12:00:00Z', senate: 'in_session', holdSenate: TUESDAY });
    expect(chamberSessionFrom(m, 'senate', at('2026-11-22T13:00:00Z'))).toBe('in_session');
    // The writer: that Digest clears the hold in the same run.
    const held = { senate: TUESDAY, house: null };
    const next = nextSessionHold({
      previous: held,
      floorMeta: { stale: false, in_session: { senate: 'in_session', house: 'unknown' }, next_meeting: { senate: { date: '2026-11-23', label: '3 p.m., Monday, November 23' }, house: null } },
      issueDate: '2026-11-21',
      url: URL,
      now: at('2026-11-22T12:00:00Z'),
    });
    expect(next.senate).toBeNull();
  });

  test('a stale file whose last reading was in session: unknown, as before', () => {
    const m = meta({ fetchedAt: '2026-11-20T15:00:00Z', senate: 'in_session' });
    for (const h of [49, 72, 24 * 10]) {
      const now = at('2026-11-20T15:00:00Z') + h * HOUR;
      expect(chamberSessionFrom(m, 'senate', now)).toBe('unknown');
      expect(chamberSessionFrom(m, 'senate', now)).toBe(chamberSessionBefore(m, 'senate', now));
    }
  });

  test('a dead pipeline for 10 days: away until the named meeting, a meeting every hour after it', () => {
    const fetchedAt = '2026-11-20T15:00:00Z';
    const m = meta({ fetchedAt, senate: 'out_of_session', holdSenate: TUESDAY });
    for (let t = at(fetchedAt); t <= at(fetchedAt) + 10 * DAY; t += HOUR) {
      expect(chamberSessionFrom(m, 'senate', t)).toBe(t < TUESDAY_MEETS ? 'out_of_session' : 'unknown');
    }
  });

  test('a dead pipeline after "away until tomorrow": the hold adds nothing past tomorrow’s meeting', () => {
    // The last write says the Senate meets in a pro forma session tomorrow at
    // 10 a.m. Before this change the fresh verdict already read out for 48
    // hours after the write; that window is unchanged (the hold never extends
    // it), and from the later of the two the reading is a meeting, for good.
    const fetchedAt = '2026-11-20T15:00:00Z';
    const tomorrow = { digest: DIGEST, url: URL, date: '2026-11-21', label: '10 a.m., Saturday, November 21' };
    const m = meta({ fetchedAt, senate: 'out_of_session', holdSenate: tomorrow });
    const ceiling = at(fetchedAt) + SIGNAL_STALE_HOURS * HOUR;
    for (let t = at(fetchedAt); t <= at(fetchedAt) + 10 * DAY; t += HOUR) {
      expect(chamberSessionFrom(m, 'senate', t)).toBe(chamberSessionBefore(m, 'senate', t));
      if (t > ceiling) expect(chamberSessionFrom(m, 'senate', t)).toBe('unknown');
    }
    // With the fresh verdict gone (a fetch error was the last write), the hold
    // alone ends at the named meeting itself.
    const m2 = meta({ fetchedAt, holdSenate: tomorrow });
    expect(chamberSessionFrom(m2, 'senate', at('2026-11-21T14:59:00Z'))).toBe('out_of_session');
    expect(chamberSessionFrom(m2, 'senate', at('2026-11-21T15:00:00Z'))).toBe('unknown');
  });

  test('missing, malformed, past, backwards and far dates: unknown, which counts as meeting', () => {
    const now = at('2026-11-22T12:00:00Z');
    const bad = [
      null,
      'away',
      {},
      { ...TUESDAY, date: null },
      { ...TUESDAY, date: undefined },
      { ...TUESDAY, date: 'Tuesday' },
      { ...TUESDAY, date: '2026-11-2' },
      { ...TUESDAY, date: '2026-11-21', label: '10 a.m., Saturday, November 21' }, // past
      { ...TUESDAY, date: '2026-11-19' }, // before its own Digest
      { ...TUESDAY, digest: '2026-11-25' }, // its Digest dated after the meeting it names, the meeting still ahead
      { ...TUESDAY, date: 20261124 },
      { ...TUESDAY, digest: '2026-11-20T05:00' },
      { ...TUESDAY, date: '2026-11-28' }, // 8 days out: past SESSION_HOLD_MAX_DAYS
      { ...TUESDAY, date: '2027-06-08' }, // a year fill-in gone wrong
      { ...TUESDAY, digest: null },
      { ...TUESDAY, digest: 'Nov 20' },
    ];
    for (const hold of bad) {
      const m = meta({ fetchedAt: '2026-11-20T15:00:00Z', holdSenate: hold });
      expect(sessionHoldActive(hold, now), JSON.stringify(hold)).toBe(false);
      expect(chamberSessionFrom(m, 'senate', now), JSON.stringify(hold)).toBe('unknown');
    }
    expect(SESSION_HOLD_MAX_DAYS).toBe(7);
    const edge = { ...TUESDAY, date: '2026-11-27', label: '10 a.m., Friday, November 27' }; // exactly 7
    expect(sessionHoldActive(edge, now)).toBe(true);
  });

  test('a file with no session_hold at all (every file before this change) reads exactly as before', () => {
    const old = {
      fetched_at: '2026-10-20T11:27:50.134Z',
      in_session: { senate: 'out_of_session', house: 'out_of_session', basis: 'x' },
      next_meeting: { senate: { date: '2026-10-22', label: '9 a.m., Thursday, October 22' }, house: null },
    };
    for (let t = at('2026-10-20T12:00:00Z'); t < at('2026-10-28T00:00:00Z'); t += HOUR) {
      for (const c of ['senate', 'house'] as const) {
        expect(chamberSessionFrom(old, c, t)).toBe(chamberSessionBefore(old, c, t));
      }
    }
  });

  test('the two chambers are held separately', () => {
    const house = { ...TUESDAY, date: '2026-11-23', label: '12 noon, Monday, November 23' };
    const m = meta({ fetchedAt: '2026-11-20T15:00:00Z', holdSenate: TUESDAY, holdHouse: house });
    const mon = at('2026-11-23T18:00:00Z'); // 1 p.m. Monday Eastern
    expect(chamberSessionFrom(m, 'senate', mon)).toBe('out_of_session');
    expect(chamberSessionFrom(m, 'house', mon)).toBe('unknown');
    const m2 = meta({ fetchedAt: '2026-11-20T15:00:00Z', holdSenate: TUESDAY });
    expect(chamberSessionFrom(m2, 'senate', mon)).toBe('out_of_session');
    expect(chamberSessionFrom(m2, 'house', mon)).toBe('unknown');
  });

  test('an announced schedule is exempt: the chamber named the bill on its own schedule, so it is meeting', () => {
    const m = meta({ fetchedAt: '2026-11-20T15:00:00Z', holdSenate: TUESDAY });
    const session = chamberSessionFrom(m, 'senate', at('2026-11-22T16:00:00Z'));
    expect(session).toBe('out_of_session');
    expect(floorFactSuspended('announced', session)).toBe(false);
    expect(floorFactSuspended('pending', session)).toBe(true);
    expect(floorFactSuspended('calendar', session)).toBe(true);
  });
});

test.describe('it only ever adds "away"', () => {
  test('every reading the old rule called out is still out, and every new out is a standing hold', () => {
    const verdicts = ['in_session', 'out_of_session', 'unknown', 'bogus', undefined];
    const holds = [null, TUESDAY, { ...TUESDAY, date: '2026-11-21', label: '10 a.m.' }, { ...TUESDAY, date: '2027-01-01' }];
    const stamps = ['2026-11-20T15:00:00Z', '2026-11-18T00:00:00Z', 'garbage'];
    let compared = 0;
    for (const v of verdicts)
      for (const hold of holds)
        for (const fetchedAt of stamps)
          for (let t = at('2026-11-19T00:00:00Z'); t < at('2026-11-27T00:00:00Z'); t += 5 * HOUR) {
            const m = { ...meta({ fetchedAt, holdSenate: hold }), in_session: { senate: v } };
            const before = chamberSessionBefore(m, 'senate', t);
            const after = chamberSessionFrom(m, 'senate', t);
            if (before !== 'unknown') expect(after).toBe(before);
            if (after !== before) {
              expect(before).toBe('unknown');
              expect(after).toBe('out_of_session');
              expect(sessionHoldActive(hold, t)).toBe(true);
            }
            compared++;
          }
    expect(compared).toBeGreaterThan(1000);
  });
});

test.describe('the writer', () => {
  const outMeta = (date: string, label: string) => ({
    stale: false,
    in_session: { senate: 'out_of_session', house: 'out_of_session' },
    next_meeting: { senate: { date, label }, house: { date, label } },
  });
  const errorMeta = { stale: false, in_session: { senate: 'unknown', house: 'unknown' }, next_meeting: { senate: null, house: null } };
  const staleMeta = { stale: true, in_session: { senate: 'unknown', house: 'unknown' }, next_meeting: null };

  test('a pro forma chain: each Digest replaces the hold, error runs carry it, and it lapses at each named meeting', () => {
    let hold: Json = null;
    const run = (floorMeta: Json, issueDate: string | null, nowIso: string) =>
      (hold = nextSessionHold({ previous: hold, floorMeta, issueDate, url: issueDate ? URL : null, now: at(nowIso) }));

    run(outMeta('2026-11-24', '11 a.m., Tuesday, November 24'), '2026-11-20', '2026-11-21T13:00:00Z');
    expect(hold.senate).toEqual({ digest: '2026-11-20', url: URL, date: '2026-11-24', label: '11 a.m., Tuesday, November 24' });
    run(errorMeta, null, '2026-11-22T13:00:00Z'); // a fetch error: carried
    expect(hold.senate?.date).toBe('2026-11-24');
    run(staleMeta, '2026-11-20', '2026-11-23T13:00:00Z'); // past the age ceiling: carried
    expect(hold.senate?.date).toBe('2026-11-24');
    run(errorMeta, null, '2026-11-24T16:00:00Z'); // the meeting has begun: dropped
    expect(hold).toEqual({ senate: null, house: null });
    run(outMeta('2026-11-27', '9 a.m., Friday, November 27'), '2026-11-24', '2026-11-25T13:00:00Z'); // the next link
    expect(hold.senate).toEqual({ digest: '2026-11-24', url: URL, date: '2026-11-27', label: '9 a.m., Friday, November 27' });
    run(
      { stale: false, in_session: { senate: 'in_session', house: 'in_session' }, next_meeting: { senate: { date: '2026-11-30', label: '3 p.m., Monday, November 30' }, house: null } },
      '2026-11-27',
      '2026-11-28T13:00:00Z'
    ); // the return
    expect(hold).toEqual({ senate: null, house: null });
  });

  test('a Digest past the age ceiling never replaces a hold, whatever verdict it carries', () => {
    const staleOut = { stale: true, in_session: { senate: 'out_of_session', house: 'in_session' }, next_meeting: { senate: { date: '2026-11-27', label: '9 a.m.' }, house: null } };
    const next = nextSessionHold({ previous: { senate: TUESDAY, house: TUESDAY }, floorMeta: staleOut, issueDate: '2026-11-13', url: URL, now: at('2026-11-22T13:00:00Z') });
    expect(next).toEqual({ senate: TUESDAY, house: TUESDAY });
  });

  test('the hourly script hands the previous file’s hold to the writer, and the note asks for its own chamber', () => {
    const ROOT = path.join(__dirname, '..');
    const script = readFileSync(path.join(ROOT, 'scripts', 'floor-signals.mjs'), 'utf8');
    expect(script).toMatch(/session_hold:\s*nextSessionHold\(\{\s*previous:\s*previous\?\._meta\?\.session_hold \?\? null,/);
    const door = readFileSync(path.join(ROOT, 'lib', 'docket.ts'), 'utf8');
    expect(door).toMatch(/floorSessionSourceFrom\(FILE\._meta, now, chamber\)/);
    const note = readFileSync(path.join(ROOT, 'components', 'FloorRecessNote.tsx'), 'utf8');
    expect(note).toMatch(/floorSessionSource\(undefined, chamber\)/);
  });

  test('an out verdict with no named date, or a date already past, stores no hold', () => {
    const noDate = { stale: false, in_session: { senate: 'out_of_session', house: 'out_of_session' }, next_meeting: { senate: { date: null, label: 'Monday' }, house: null } };
    expect(nextSessionHold({ previous: { senate: TUESDAY, house: TUESDAY }, floorMeta: noDate, issueDate: '2026-11-21', url: URL, now: at('2026-11-21T13:00:00Z') })).toEqual({ senate: null, house: null });
    const past = outMeta('2026-11-24', '11 a.m., Tuesday, November 24');
    expect(nextSessionHold({ previous: null, floorMeta: past, issueDate: DIGEST, url: URL, now: TUESDAY_MEETS })).toEqual({ senate: null, house: null });
  });

  test('the named meeting arriving changes the fingerprint, so the hourly run commits it with no new data', () => {
    const file = (session_hold: Json) => ({ _meta: { sources: {}, in_session: { senate: 'unknown', house: 'unknown' }, next_meeting: { senate: null, house: null }, session_hold, fetched_at: '2026-11-22T12:00:00Z' }, signals: {}, nominations: {} });
    const previous = file({ senate: TUESDAY, house: null });
    const lapsed = nextSessionHold({ previous: previous._meta.session_hold, floorMeta: errorMeta, now: TUESDAY_MEETS + HOUR });
    const next = file(lapsed);
    expect(materialFingerprint(previous)).not.toBe(materialFingerprint(next));
    expect(shouldWrite({ previous, next, now: TUESDAY_MEETS + HOUR })).toBe(true);
    // And an hour that changes nothing still writes nothing.
    const same = nextSessionHold({ previous: previous._meta.session_hold, floorMeta: errorMeta, now: at('2026-11-22T13:00:00Z') });
    expect(shouldWrite({ previous, next: file(same), now: at('2026-11-22T13:00:00Z') })).toBe(false);
  });

  test('the gate warns on an unusable hold and never fails on one', () => {
    const base = { _meta: { schema: 'floor-signals/v1', fetched_at: '2026-11-22T12:00:00Z', sources: {} }, signals: {}, nominations: {} };
    const good = verifyFloorSignals({ data: { ...base, _meta: { ...base._meta, session_hold: { senate: TUESDAY, house: null } } }, now: at('2026-11-22T13:00:00Z') });
    expect(good.failures).toEqual([]);
    expect(good.warnings).toEqual([]);
    const bad = verifyFloorSignals({ data: { ...base, _meta: { ...base._meta, session_hold: { senate: { digest: '2026-11-20', date: '2026-11-19' }, house: 'x' } } }, now: at('2026-11-22T13:00:00Z') });
    expect(bad.failures).toEqual([]);
    expect(bad.warnings).toHaveLength(2);
  });
});

test.describe('what the quiet note quotes while a hold stands', () => {
  test('the hold’s own Digest: its meeting, its date and its link', () => {
    const m = meta({ fetchedAt: '2026-11-22T12:00:00Z', holdSenate: TUESDAY });
    const now = at('2026-11-22T13:00:00Z');
    expect(sessionHoldFrom(m, 'senate', now)).toEqual(TUESDAY);
    expect(sessionHoldFrom(m, 'house', now)).toBeNull();
    expect(chamberNextMeetingFrom(m, 'senate', now)).toEqual({ iso: '2026-11-24', label: '11 a.m., Tuesday, November 24' });
    expect(floorSessionSourceFrom(m, now, 'senate')).toEqual({ url: URL, published: DIGEST });
    expect(floorSessionSourceFrom(m, now)).toEqual({ url: URL, published: DIGEST });
    // No hold for the House, and the run read no Digest: nothing to quote.
    expect(chamberNextMeetingFrom(m, 'house', now)).toBeNull();
    expect(floorSessionSourceFrom(m, now, 'house')).toBeNull();
    // Once the meeting begins the hold quotes nothing either.
    expect(chamberNextMeetingFrom(m, 'senate', TUESDAY_MEETS)).toBeNull();
    expect(floorSessionSourceFrom(m, TUESDAY_MEETS, 'senate')).toBeNull();
  });

  test('a run that read a Digest quotes that Digest, exactly as before', () => {
    const live = { status: 'quiet', url: 'https://example.gov/d', published: '2026-11-21' };
    const nm = { senate: { date: '2026-11-24', label: '11 a.m., Tuesday, November 24' }, house: { date: '2026-11-24', label: '2 p.m., Tuesday, November 24' } };
    const m = meta({ fetchedAt: '2026-11-22T12:00:00Z', senate: 'out_of_session', house: 'out_of_session', holdSenate: TUESDAY, nextMeeting: nm, source: live });
    const now = at('2026-11-22T13:00:00Z');
    expect(floorSessionSourceFrom(m, now)).toEqual({ url: live.url, published: live.published });
    expect(floorSessionSourceFrom(m, now, 'senate')).toEqual({ url: live.url, published: live.published });
    expect(chamberNextMeetingFrom(m, 'house', now)).toEqual({ iso: '2026-11-24', label: '2 p.m., Tuesday, November 24' });
  });
});

test.describe('October 2026, replayed from the commits', () => {
  const DIR = path.join(__dirname, 'fixtures', 'floor-signals-2026-10');
  const load = (tag: string) => ({
    file: JSON.parse(readFileSync(path.join(DIR, `floor-signals-${tag}.json`), 'utf8')),
    checked: JSON.parse(readFileSync(path.join(DIR, `floor-signals-checked-${tag}.json`), 'utf8')),
  });
  /** What the writer would have stored had this change been live: each commit
   *  in order, through `nextSessionHold`, at that commit's own clock. */
  function replay(tags: string[]) {
    let hold: Json = null;
    return tags.map((tag) => {
      const { file, checked } = load(tag);
      const m = file._meta;
      const now = Date.parse(m.fetched_at);
      const floorMeta = { stale: false, in_session: m.in_session, next_meeting: m.next_meeting };
      const digest = m.sources['daily-digest'];
      hold = nextSessionHold({ previous: hold, floorMeta, issueDate: digest.published, url: digest.url, now });
      return { tag, meta: { ...m, session_hold: hold }, checked };
    });
  }
  const read = (s: { meta: Json; checked: Json }, c: Chamber, iso: string) => chamberSessionFrom(s.meta, c, at(iso), s.checked);

  test('the Oct 19 Digest holds both chambers until the pro forma sessions it named on Oct 22', () => {
    const [oct20] = replay(['2026-10-20T1128Z']);
    expect(oct20.meta.session_hold.senate).toMatchObject({ digest: '2026-10-19', date: '2026-10-22', label: '9 a.m., Thursday, October 22' });
    expect(oct20.meta.session_hold.house).toMatchObject({ digest: '2026-10-19', date: '2026-10-22', label: '3 p.m., Thursday, October 22' });
    // Fresh: out, as before.
    expect(read(oct20, 'senate', '2026-10-21T12:00:00Z')).toBe('out_of_session');
    // Had the pipeline died after this commit: out until each meeting began.
    expect(read(oct20, 'senate', '2026-10-22T12:59:00Z')).toBe('out_of_session');
    expect(read(oct20, 'house', '2026-10-22T18:59:00Z')).toBe('out_of_session');
  });

  test('Oct 25 to 27: the Digest could not be read, and the meeting it last named had passed, so it still reads as meeting', () => {
    const [, oct25, oct27a, oct27b] = replay(['2026-10-20T1128Z', '2026-10-25T0043Z', '2026-10-27T0147Z', '2026-10-27T1633Z']);
    // The Oct 22 meetings had begun before the first failed run: no hold is carried.
    expect(oct25.meta.session_hold).toEqual({ senate: null, house: null });
    for (const c of ['senate', 'house'] as const) {
      expect(read(oct25, c, '2026-10-25T01:00:00Z')).toBe('unknown');
      expect(read(oct27a, c, '2026-10-27T02:00:00Z')).toBe('unknown');
    }
    // The Oct 26 Digest arrives: out again, and held until Oct 29.
    expect(oct27b.meta.session_hold.senate).toMatchObject({ digest: '2026-10-26', date: '2026-10-29', label: '2 p.m., Thursday, October 29' });
    expect(read(oct27b, 'senate', '2026-10-27T17:00:00Z')).toBe('out_of_session');
    expect(read(oct27b, 'senate', '2026-10-29T17:59:00Z')).toBe('out_of_session');
    expect(chamberSessionFrom({ ...oct27b.meta, fetched_at: '2026-10-27T16:33:00Z' }, 'senate', at('2026-10-29T18:00:00Z'), null)).toBe('unknown');
  });

  test('the same failure arriving before the named meeting keeps both chambers out until it', () => {
    const { file: good } = load('2026-10-20T1128Z');
    const { file: failed } = load('2026-10-25T0043Z');
    const hold1 = nextSessionHold({ previous: null, floorMeta: { stale: false, ...good._meta }, issueDate: '2026-10-19', url: good._meta.sources['daily-digest'].url, now: at('2026-10-20T11:28:00Z') });
    const failedAt = '2026-10-21T00:43:00Z';
    const hold2 = nextSessionHold({ previous: hold1, floorMeta: { stale: false, ...failed._meta }, issueDate: null, url: null, now: at(failedAt) });
    const m = { ...failed._meta, fetched_at: failedAt, session_hold: hold2 };
    expect(chamberSessionBefore(m, 'senate', at('2026-10-21T01:00:00Z'))).toBe('unknown');
    expect(chamberSessionFrom(m, 'senate', at('2026-10-21T01:00:00Z'))).toBe('out_of_session');
    expect(chamberSessionFrom(m, 'house', at('2026-10-22T18:59:00Z'))).toBe('out_of_session');
    expect(chamberSessionFrom(m, 'senate', at('2026-10-22T13:00:00Z'))).toBe('unknown');
    expect(chamberSessionFrom(m, 'house', at('2026-10-22T19:00:00Z'))).toBe('unknown');
    expect(floorSessionSourceFrom(m, at('2026-10-21T01:00:00Z'), 'senate')?.published).toBe('2026-10-19');
  });
});

test.describe('one reader', () => {
  test('no page, component or library outside lib/docket reads the stored verdict or the hold', () => {
    const ROOT = path.join(__dirname, '..');
    const ALLOWED = new Set(['lib/docket.mjs', 'lib/docket.ts']);
    const READ = /\bsession_hold\b|\.in_session\b|\[\s*['"]in_session['"]\s*\]/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'node_modules') walk(full);
          continue;
        }
        if (!/\.(m?js|tsx?)$/.test(name)) continue;
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        if (ALLOWED.has(rel)) continue;
        // Code only: a comment that names the field is documentation, not a read.
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (READ.test(code)) offenders.push(rel);
      }
    };
    for (const dir of ['app', 'components', 'lib']) walk(path.join(ROOT, dir));
    expect(offenders).toEqual([]);
  });
});
