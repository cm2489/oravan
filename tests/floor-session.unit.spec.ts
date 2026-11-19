import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billStatusLine, type StatusLine } from '../lib/moment-status.mjs';
import { chamberSessionFrom } from '../lib/docket.mjs';
import { floorFactSuspended, type ChamberSession } from '../lib/journey';
import { calendarMarkSuspended, floorSuspendedFrom, siteBillStatusLine } from '../lib/floor-session';

/*
 * THE SESSION GATE ON THE BIG QUESTIONS STATUS LINE (2026-11-18;
 * docs/record-truth.md §5). Every input here is FROZEN: the records, the
 * floor-signals metadata and the clock. Nothing reads data/ or Date.now(), so
 * this file cannot turn red as the corpus or the calendar moves on.
 *
 * Before this change `billStatusLine` read no session at all: it printed
 * "Cloture was filed in the Senate…" and "Moving on the House floor, with a
 * vote ahead." for 14 days after the action, whether or not the chamber was
 * meeting. Now, while the chamber the line names is not meeting, the line
 * falls back exactly as it does after 14 days: the record's own words.
 */

type Chamber = 'house' | 'senate';
const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);

/** A session source from a fixed table: the shape lib/docket.ts hands the
 *  site, without the committed file. */
const sessions =
  (house: ChamberSession, senate: ChamberSession) =>
  (chamber: Chamber): ChamberSession =>
    chamber === 'house' ? house : senate;
const gate = (house: ChamberSession, senate: ChamberSession) => floorSuspendedFrom(sessions(house, senate));

/* ---- frozen records ------------------------------------------------- */

const NOW = at('2026-11-20T15:00:00Z');
const daysBefore = (n: number) => new Date(NOW - n * DAY).toISOString().slice(0, 10);

/** Senate cloture filed 3 days before NOW. */
const senateCloture = {
  bill_type: 's',
  status: 'floor_vote' as const,
  last_action_text: 'Cloture motion on the measure presented in Senate. (CR S5701)',
  last_action_date: daysBefore(3),
};
/** A House floor line (H.R. 3495's record of 2026-11-17, re-dated). */
const houseRule = {
  bill_type: 'hr',
  status: 'floor_vote' as const,
  last_action_text:
    'Rules Committee Resolution H. Res. 1665 Reported to House. Rule provides for consideration of H.R. 3495 and H.R. 5267. The resolution provides for consideration of H.R. 3495 and H.R. 5267 under a closed rule with one hour of debate and one motion to recommit on each bill.',
  last_action_date: daysBefore(3),
};
/** A House bill on the Senate floor (H.R. 2347's record of 2026-11-17). */
const senateConsideration = {
  bill_type: 'hr',
  status: 'floor_vote' as const,
  last_action_text: 'Considered by Senate. (consideration: CR S5705)',
  last_action_date: daysBefore(3),
};
/** A House calendar placement (H.R. 4464's record of 2026-11-17). */
const housePlacement = {
  bill_type: 'hr',
  status: 'floor_vote' as const,
  last_action_text: 'Placed on the Union Calendar, Calendar No. 777.',
  last_action_date: daysBefore(3),
};

const LIVE_KEYS = new Set(['onFloor', 'clotureFiled']);

/* ---- words, both languages, through the real message files ---------- */

const tr = {
  en: createTranslator({ locale: 'en', messages: en }),
  es: createTranslator({ locale: 'es', messages: es }),
};
/** The full line as components/MomentStatusLine.tsx prints it. */
function fullWords(line: StatusLine, loc: 'en' | 'es'): string {
  const t = tr[loc] as unknown as (key: string, values?: Record<string, unknown>) => string;
  if (line.key === 'recordStep') return `${t('moments.status.recordStepLabel')} “${line.text}”`;
  return t(`moments.status.line.${line.key}`, { chamber: line.chamber ?? 'other', law: line.law ?? 'none' });
}
/** The short line as app/[locale]/page.tsx prints it (no tally on these). */
function homeWords(line: StatusLine, loc: 'en' | 'es'): string {
  const t = tr[loc] as unknown as (key: string, values?: Record<string, unknown>) => string;
  return t(`homeLine.${line.key}`, {
    chamber: line.chamber ?? 'other',
    law: line.law ?? 'none',
    tally: 'none',
    yeas: 0,
    nays: 0,
  });
}

/* ---- the cases ------------------------------------------------------- */

test.describe('the status line stands down while its chamber is not meeting', () => {
  test('Senate out, cloture filed 3 days ago: the record’s own words, not "that vote comes within days"', () => {
    expect(billStatusLine(senateCloture, NOW, gate('in_session', 'in_session')).key).toBe('clotureFiled');
    const out = billStatusLine(senateCloture, NOW, gate('in_session', 'out_of_session'));
    expect(out.key).toBe('recordStep');
    expect(out.text).toBe(senateCloture.last_action_text);
    expect(out.date).toBe(senateCloture.last_action_date);
  });

  test('House out, a House floor line: the record’s own words', () => {
    expect(billStatusLine(houseRule, NOW, gate('in_session', 'in_session'))).toMatchObject({
      key: 'onFloor',
      chamber: 'house',
    });
    expect(billStatusLine(houseRule, NOW, gate('out_of_session', 'in_session')).key).toBe('recordStep');
  });

  test('one chamber out, the other in: only the out chamber’s line stands down', () => {
    const houseOutSenateIn = gate('out_of_session', 'in_session');
    expect(billStatusLine(houseRule, NOW, houseOutSenateIn).key).toBe('recordStep');
    expect(billStatusLine(senateConsideration, NOW, houseOutSenateIn)).toMatchObject({
      key: 'onFloor',
      chamber: 'senate',
    });
    expect(billStatusLine(senateCloture, NOW, houseOutSenateIn).key).toBe('clotureFiled');

    const senateOutHouseIn = gate('in_session', 'out_of_session');
    expect(billStatusLine(houseRule, NOW, senateOutHouseIn).key).toBe('onFloor');
    expect(billStatusLine(senateConsideration, NOW, senateOutHouseIn).key).toBe('recordStep');
  });

  test('session unknown keeps the live line (fails safe to live, as the bill page does)', () => {
    const unknown = gate('unknown', 'unknown');
    expect(billStatusLine(senateCloture, NOW, unknown).key).toBe('clotureFiled');
    expect(billStatusLine(houseRule, NOW, unknown).key).toBe('onFloor');

    // And "unknown" as the real reader produces it: a floor-signals file
    // fetched more than 48 hours before the build reads as unknown, even when
    // it last said out_of_session.
    const meta = {
      fetched_at: new Date(NOW - 49 * 3_600_000).toISOString(),
      in_session: { senate: 'out_of_session', house: 'out_of_session' },
    };
    const fromFile = floorSuspendedFrom((c) => chamberSessionFrom(meta, c, NOW, null) as ChamberSession);
    expect(billStatusLine(senateCloture, NOW, fromFile).key).toBe('clotureFiled');
  });

  test('the 14-day edge is unchanged, and the session gate never revives an aged line', () => {
    const inSession = gate('in_session', 'in_session');
    // Midnight UTC, so the ages are whole days: isSignalFresh keeps a line
    // exactly 14 days old and drops one 15 days old.
    const EDGE = at('2026-11-20T00:00:00Z');
    const day14 = { ...houseRule, last_action_date: '2026-11-06' };
    const day15 = { ...houseRule, last_action_date: '2026-11-05' };
    expect(billStatusLine(day14, EDGE, inSession).key).toBe('onFloor');
    expect(billStatusLine(day15, EDGE, inSession).key).toBe('recordStep');
    // Out of session, the 14-day line falls back to the same key and words
    // the 15-day line already shows.
    const out = gate('out_of_session', 'out_of_session');
    const fell = billStatusLine(day14, EDGE, out);
    const aged = billStatusLine(day15, EDGE, inSession);
    expect(fell.key).toBe(aged.key);
    expect(fell.text).toBe(aged.text);
    // And the gate never revives an aged line when the chamber meets.
    expect(billStatusLine(day15, EDGE, gate('in_session', 'in_session')).key).toBe('recordStep');
  });

  test('the fallback is exactly the aged fallback (same key, text and date), and adds no words', () => {
    const aged = { ...senateCloture, last_action_date: daysBefore(20) };
    const outLine = billStatusLine(
      { ...senateCloture, last_action_date: daysBefore(20) },
      NOW - 17 * DAY,
      gate('in_session', 'out_of_session')
    );
    const agedLine = billStatusLine(aged, NOW, gate('in_session', 'in_session'));
    expect(outLine.key).toBe(agedLine.key);
    expect(outLine.text).toBe(agedLine.text);
    expect(outLine.date).toBe(agedLine.date);
  });

  test('a calendar placement line is not touched (it says what CAN happen, not what is happening)', () => {
    expect(billStatusLine(housePlacement, NOW, gate('out_of_session', 'out_of_session'))).toMatchObject({
      key: 'onCalendar',
      chamber: 'house',
    });
  });

  test('the gate is the bill page’s own function, for every session value', () => {
    for (const s of ['in_session', 'out_of_session', 'unknown'] as const) {
      for (const kind of ['pending', 'calendar'] as const) {
        expect(gate(s, s)(kind, 'house')).toBe(floorFactSuspended(kind, s));
      }
    }
  });
});

test.describe('both languages', () => {
  test('in a recess, the card and the home row print the record’s words in English and Spanish', () => {
    const line = billStatusLine(senateCloture, NOW, gate('out_of_session', 'out_of_session'));
    expect(fullWords(line, 'en')).toBe(
      'The record\'s latest step, in its own words: “Cloture motion on the measure presented in Senate. (CR S5701)”'
    );
    expect(fullWords(line, 'es')).toBe(
      'El último paso del registro, en sus propias palabras (en inglés): “Cloture motion on the measure presented in Senate. (CR S5701)”'
    );
    expect(homeWords(line, 'en')).toBe('Latest action on the record');
    expect(homeWords(line, 'es')).toBe('Última acción en el registro');
  });

  test('in session, the same records keep their live words in both languages (the gate takes nothing away then)', () => {
    const line = billStatusLine(houseRule, NOW, gate('in_session', 'in_session'));
    expect(homeWords(line, 'en')).toBe('On the House floor, a vote ahead');
    expect(homeWords(line, 'es')).toBe('En el pleno de la Cámara, con una votación por delante');
  });
});

test.describe('the home page’s week rows in a recess', () => {
  /*
   * The four rows the home page listed on 2026-11-18 (H.R. 3495, H.R. 5267,
   * H.R. 2347, H.R. 4464), frozen. With both chambers out, no row may say a
   * vote is ahead. The rows stay: the recess note under them, owner-approved
   * 2026-08-15 (commit c0af4345) and reworded in #420, says "Bills below show
   * their last status in the record", which is what they then show.
   */
  const rows = [houseRule, { ...houseRule }, senateConsideration, housePlacement];

  test('no row reads live while both chambers are out, in either language', () => {
    const out = gate('out_of_session', 'out_of_session');
    for (const r of rows) {
      const line = siteBillStatusLine(r, NOW, out);
      expect(LIVE_KEYS.has(line.key), `${r.last_action_text}`).toBe(false);
      for (const loc of ['en', 'es'] as const) {
        expect(homeWords(line, loc)).not.toMatch(/vote ahead|votación por delante|within days|en pocos días/);
      }
    }
  });

  test('the same rows read live while both chambers meet (so the test above proves the gate)', () => {
    const live = rows.map((r) => siteBillStatusLine(r, NOW, gate('in_session', 'in_session')).key);
    expect(live.filter((k) => LIVE_KEYS.has(k))).toHaveLength(3);
  });
});

test.describe('the August replay, frozen (S. 4668 and H.R. 3633 on 2026-08-18)', () => {
  /*
   * origin/main fdbd73ad (2026-08-18 23:03 UTC, "hot-bill refresh"): both
   * bills' records and the floor-signals metadata, verbatim. The Senate's own
   * Daily Digest gave its next meeting as a pro forma session (in_session:
   * out_of_session). Replayed with the code before this change, both lines
   * read "Cloture was filed in the Senate. Under Senate rules, that vote
   * comes within days." — 13 and 10 days after the filings, in a week the
   * Senate held no business. (The status line shipped 2026-09-24, so these
   * were never actually shown.)
   */
  const BUILD = at('2026-08-18T23:03:17Z');
  const meta = {
    fetched_at: '2026-08-18T08:50:46.679Z',
    in_session: { senate: 'out_of_session', house: 'out_of_session', basis: 'Daily Digest "Program for" blocks' },
    next_meeting: {
      senate: { date: '2026-08-20', label: '11:30 a.m., Thursday, August 20' },
      house: { date: '2026-08-20', label: '10 a.m., Thursday, August 20' },
    },
  };
  const s4668 = {
    full_identifier: 's-4668-119',
    bill_type: 's',
    bill_number: 4668,
    congress_number: 119,
    status: 'floor_vote' as const,
    last_action_text: 'Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4449)',
    last_action_date: '2026-08-05',
    status_basis_text: null,
  };
  const hr3633 = {
    full_identifier: 'hr-3633-119',
    bill_type: 'hr',
    bill_number: 3633,
    congress_number: 119,
    status: 'floor_vote' as const,
    last_action_text: 'Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4557)',
    last_action_date: '2026-08-08',
    status_basis_text: null,
  };
  const fromFile = floorSuspendedFrom((c) => chamberSessionFrom(meta, c, BUILD, null) as ChamberSession);

  for (const bill of [s4668, hr3633]) {
    test(`${bill.full_identifier}: live words before the gate, the record’s words with it`, () => {
      expect(chamberSessionFrom(meta, 'senate', BUILD, null)).toBe('out_of_session');
      expect(billStatusLine(bill, BUILD).key).toBe('clotureFiled');
      const line = siteBillStatusLine(bill, BUILD, fromFile);
      expect(line.key).toBe('recordStep');
      expect(fullWords(line, 'en')).toBe(`The record's latest step, in its own words: “${bill.last_action_text}”`);
      expect(fullWords(line, 'es')).toBe(
        `El último paso del registro, en sus propias palabras (en inglés): “${bill.last_action_text}”`
      );
    });
  }
});

test.describe('the vehicle card’s amber calendar mark', () => {
  const placement = { ...housePlacement, bill_type: 'hr', congress_number: 119 };
  test('stands down while the House is out, stays while it meets or the session is unknown', () => {
    expect(calendarMarkSuspended(placement, NOW, sessions('out_of_session', 'in_session'))).toBe(true);
    expect(calendarMarkSuspended(placement, NOW, sessions('in_session', 'out_of_session'))).toBe(false);
    expect(calendarMarkSuspended(placement, NOW, sessions('unknown', 'unknown'))).toBe(false);
  });
  test('reads nothing for a record that is not a fresh floor fact', () => {
    const aged = { ...placement, last_action_date: daysBefore(30) };
    expect(calendarMarkSuspended(aged, NOW, sessions('out_of_session', 'out_of_session'))).toBe(false);
  });
});

test.describe('one decision, every surface', () => {
  /*
   * The proof that no page prints a status line around the gate: the only
   * site file that may call `billStatusLine` is lib/floor-session.ts (and the
   * module that defines it). Every Big Question surface reads its lines from
   * lib/moments-ui.ts `vehicleStatuses` (the /questions cards through
   * momentStatus, the question page's header, vehicle cards and still-open
   * rail through questionVehicles, the home band through lib/home.ts), which
   * calls siteBillStatusLine; the home page's week rows call it directly.
   * scripts/moment-watch.mjs (the owner's nightly digest, not a page) is
   * outside app/, components/ and lib/ and stays ungated on purpose.
   */
  const ROOTS = ['app', 'components', 'lib'];
  const ALLOWED = new Set(['lib/moment-status.mjs', 'lib/floor-session.ts']);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(p.split(path.sep).join('/'));
    }
  };
  for (const r of ROOTS) walk(r);

  test('no app/, components/ or lib/ file calls billStatusLine around the session gate', () => {
    const offenders = files.filter(
      (f) => !ALLOWED.has(f) && /\bbillStatusLine\s*\(/.test(readFileSync(f, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  test('vehicleStatuses and the home page read the gated line', () => {
    expect(readFileSync('lib/moments-ui.ts', 'utf8')).toMatch(/siteBillStatusLine\(b, now\)/);
    expect(readFileSync('app/[locale]/page.tsx', 'utf8')).toMatch(/siteBillStatusLine\(b\)/);
    expect(readFileSync('app/[locale]/questions/[id]/page.tsx', 'utf8')).toMatch(
      /floorSuspended=\{calendarMarkSuspended\(raw\)\}/
    );
  });
});
