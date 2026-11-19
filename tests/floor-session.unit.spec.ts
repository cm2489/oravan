import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billStatusLine, type StatusLine } from '../lib/moment-status.mjs';
import { chamberSessionFrom } from '../lib/docket.mjs';
import { floorFactSuspended, type ChamberSession } from '../lib/journey';
import { calendarMarkSuspended, floorSuspendedAt, floorSuspendedFrom, siteBillStatusLine } from '../lib/floor-session';
import { calendarMarkShows } from '../lib/calendar-mark';
import { renderStatusDigest, statusRun } from '../scripts/moment-watch.mjs';

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

/*
 * EVERY FIXTURE SAYS CONGRESS 120. A bill of an ended Congress carries no
 * floor fact at all (docs/record-truth.md §8), so a fixture in the 119th
 * would change meaning on the review build that marks it ended
 * (ORAVAN_REVIEW_ENDED_CONGRESS=119) and, after January 3, 2027, for real.
 * No list names the 120th, so these cases hold either way.
 */
const CONGRESS = 120;

const NOW = at('2026-11-20T15:00:00Z');
const daysBefore = (n: number) => new Date(NOW - n * DAY).toISOString().slice(0, 10);

/** Senate cloture filed 3 days before NOW. */
const senateCloture = {
  congress_number: CONGRESS,
  bill_type: 's',
  status: 'floor_vote' as const,
  last_action_text: 'Cloture motion on the measure presented in Senate. (CR S5701)',
  last_action_date: daysBefore(3),
};
/** A House floor line (H.R. 3495's record of 2026-11-17, re-dated). */
const houseRule = {
  congress_number: CONGRESS,
  bill_type: 'hr',
  status: 'floor_vote' as const,
  last_action_text:
    'Rules Committee Resolution H. Res. 1665 Reported to House. Rule provides for consideration of H.R. 3495 and H.R. 5267. The resolution provides for consideration of H.R. 3495 and H.R. 5267 under a closed rule with one hour of debate and one motion to recommit on each bill.',
  last_action_date: daysBefore(3),
};
/** A House bill on the Senate floor (H.R. 2347's record of 2026-11-17). */
const senateConsideration = {
  congress_number: CONGRESS,
  bill_type: 'hr',
  status: 'floor_vote' as const,
  last_action_text: 'Considered by Senate. (consideration: CR S5705)',
  last_action_date: daysBefore(3),
};
/** A House calendar placement (H.R. 4464's record of 2026-11-17). */
const housePlacement = {
  congress_number: CONGRESS,
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
  test('Senate out, cloture filed 3 days ago: the record’s own words, not the cloture line', () => {
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

  /*
   * The whole line, not only its words: `rank` decides which vehicle's line
   * leads the question's header (questionStatus), and `terminal` decides the
   * card's button. A recess must not move either differently from age.
   */
  const sameLine = (a: StatusLine, b: StatusLine) => {
    expect(a.key).toBe(b.key);
    expect(a.text).toBe(b.text);
    expect(a.date).toBe(b.date);
    expect(a.rank).toBe(b.rank);
    expect(a.chamber).toBe(b.chamber);
    expect(a.passedBy).toBe(b.passedBy);
    expect(a.terminal).toBe(b.terminal);
  };

  test('the fallback is exactly the aged fallback (key, text, date, rank and the rest), and adds no words', () => {
    const fresh = { ...senateCloture, last_action_date: daysBefore(3) };
    const aged = { ...senateCloture, last_action_date: daysBefore(20) };
    const outLine = billStatusLine(fresh, NOW, gate('in_session', 'out_of_session'));
    const agedLine = billStatusLine(aged, NOW, gate('in_session', 'in_session'));
    expect(outLine.key).toBe('recordStep');
    sameLine(outLine, { ...agedLine, date: fresh.last_action_date });
  });

  test('a bill that passed one chamber, now on the other’s floor: the recess fallback runs the same rules as age', () => {
    // A House bill the House passed, whose latest sentence is a pending Senate
    // floor step. Rule 7 (the passed-one-chamber readings) is skipped while a
    // pending floor step is read, in both fallbacks, so neither may turn it
    // into "Passed the House; waiting on the Senate".
    const passed = {
      congress_number: CONGRESS,
      bill_type: 'hr',
      status: 'passed_chamber' as const,
      last_action_text: 'Considered by Senate. (consideration: CR S5705)',
      last_action_date: daysBefore(3),
    };
    const live = billStatusLine(passed, NOW, gate('in_session', 'in_session'));
    expect(live).toMatchObject({ key: 'onFloor', chamber: 'senate' });
    const out = billStatusLine(passed, NOW, gate('in_session', 'out_of_session'));
    const aged = billStatusLine(passed, NOW + 13 * DAY, gate('in_session', 'in_session'));
    expect(aged.key).toBe('recordStep');
    sameLine(out, aged);
    // And it keeps the passed-chamber rank, so a question's header ranks it
    // above a bill in committee exactly as it did when aged.
    expect(out.rank).toBe(65);
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
   * read as the cloture line ("Cloture was filed in the Senate."; until #526
   * it also said when the vote would come) — 13 and 10 days after the
   * filings, in a week the Senate held no business. On Big Question pages
   * these were never shown: the status line shipped there on 2026-09-24
   * (#281).
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
  // Verbatim from that commit apart from the Congress number (see CONGRESS
  // above); the label keeps the real citation.
  const s4668 = {
    label: 'S. 4668 (s-4668-119)',
    bill_type: 's',
    bill_number: 4668,
    congress_number: CONGRESS,
    status: 'floor_vote' as const,
    last_action_text: 'Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4449)',
    last_action_date: '2026-08-05',
    status_basis_text: null,
  };
  const hr3633 = {
    label: 'H.R. 3633 (hr-3633-119)',
    bill_type: 'hr',
    bill_number: 3633,
    congress_number: CONGRESS,
    status: 'floor_vote' as const,
    last_action_text: 'Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4557)',
    last_action_date: '2026-08-08',
    status_basis_text: null,
  };
  const fromFile = floorSuspendedFrom((c) => chamberSessionFrom(meta, c, BUILD, null) as ChamberSession);

  for (const bill of [s4668, hr3633]) {
    test(`${bill.label}: live words before the gate, the record’s words with it`, () => {
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
  const placement = housePlacement;
  test('stands down while the House is out, stays while it meets or the session is unknown', () => {
    expect(calendarMarkSuspended(placement, NOW, sessions('out_of_session', 'in_session'))).toBe(true);
    expect(calendarMarkSuspended(placement, NOW, sessions('in_session', 'out_of_session'))).toBe(false);
    expect(calendarMarkSuspended(placement, NOW, sessions('unknown', 'unknown'))).toBe(false);
  });
  test('reads nothing for a record that is not a fresh floor fact', () => {
    const aged = { ...placement, last_action_date: daysBefore(30) };
    expect(calendarMarkSuspended(aged, NOW, sessions('out_of_session', 'out_of_session'))).toBe(false);
  });

  /*
   * THE CARD ITSELF (components/MomentVehicleCard.tsx). The card cannot be
   * rendered here (next-intl's navigation does not load under Node; see
   * tests/card-title-lang.unit.spec.ts), so its rule lives in
   * lib/calendar-mark.ts and the card is held to calling it with the flag.
   */
  test('the mark’s rule: a suspended placement shows no mark, a live one does', () => {
    const fresh = { statusKey: 'floor_vote' as const, lastActionDate: daysBefore(3), now: NOW };
    expect(calendarMarkShows(fresh)).toBe(true);
    expect(calendarMarkShows({ ...fresh, floorSuspended: false })).toBe(true);
    expect(calendarMarkShows({ ...fresh, floorSuspended: true })).toBe(false);
    expect(calendarMarkShows({ ...fresh, statusKey: 'floor_vote_stale' })).toBe(false);
    expect(calendarMarkShows({ ...fresh, lastActionDate: daysBefore(15) })).toBe(false);
  });

  test('the card decides the mark through that rule, passing its own flag straight through', () => {
    // Code only, so a comment cannot satisfy or defeat the checks below.
    const src = readFileSync('components/MomentVehicleCard.tsx', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // The prop is REQUIRED (no `?`) and has NO default, so the typechecker
    // refuses a caller that leaves it out (tsc --noEmit, in CI's build).
    expect(src).toMatch(/^\s*floorSuspended: boolean;$/m);
    expect(src).toMatch(/^\s*floorSuspended,$/m);
    // Its value reaches the rule untouched: the shorthand, nothing else. A
    // `floorSuspended: false && floorSuspended`, a default or a reassignment
    // would each change what the rule is told.
    expect(src).toMatch(/const onCalendar = calendarMarkShows\(\{ statusKey, lastActionDate, floorSuspended \}\);/);
    expect(src.match(/\bfloorSuspended\b/g)).toHaveLength(3); // the binding, the type, the call
    // ... and the chip renders on that decision alone.
    expect(src.match(/\{onCalendar && \(/g)).toHaveLength(1);
    expect(src).not.toMatch(/isSignalFresh/);
  });
});

test.describe('floorSuspendedAt reads the session at the clock it is given', () => {
  test('the instant passed in is the instant the session is read at', () => {
    const asked: number[] = [];
    const read = (_chamber: Chamber, at: number): ChamberSession => {
      asked.push(at);
      return at === NOW ? 'out_of_session' : 'in_session';
    };
    expect(floorSuspendedAt(NOW, read)('pending', 'senate')).toBe(true);
    expect(floorSuspendedAt(NOW + DAY, read)('pending', 'senate')).toBe(false);
    expect(asked).toEqual([NOW, NOW + DAY]);
  });
});

test.describe('the owner’s nightly digest says what it is', () => {
  /*
   * scripts/moment-watch.mjs reads the line WITHOUT the session check, on
   * purpose: its stored snapshot must not flip at the start and end of every
   * recess. So its header may not claim to be "the same status lines the
   * question pages render"; while a chamber is out, a page shows the record's
   * own words where the digest still shows the floor or cloture line.
   */
  const NIGHT = at('2026-08-18T23:03:17Z');
  const s4668 = {
    full_identifier: 's-4668-120',
    congress_number: CONGRESS,
    bill_type: 's',
    status: 'floor_vote' as const,
    last_action_text: 'Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4449)',
    last_action_date: '2026-08-05',
  };
  const moments = { q: { status: 'live', review_by: '2026-12-31', vehicles: [{ slug: 's-4668-120' }] } };

  test('the digest’s line is the ungated one, so a recess cannot flip its snapshot', () => {
    const run = statusRun({ moments, bills: [s4668], nominations: [], prev: null, now: NIGHT });
    expect(run.snapshot.q.vehicles['s-4668-120'].fingerprint).toMatch(/^clotureFiled\|senate\|/);
  });

  test('its header says the pages differ while the chamber is out', () => {
    const body = renderStatusDigest({
      changes: [{ id: 'q', slug: 's-4668-120', from: null, to: 'clotureFiled|senate||2026-08-05', text: s4668.last_action_text }],
      past: [],
      newlyPast: [],
      now: NIGHT,
    });
    expect(body).not.toMatch(/the same status lines the question pages render/);
    // It names the READING, not the fact: with a stale session file the
    // reading is "unknown" and the pages keep the floor line (§5).
    expect(body).toMatch(
      /while the Daily Digest reads a chamber as out of session, the pages show the record's own words in place of that chamber's floor or cloture line/
    );
  });
});

test.describe('one decision, every surface', () => {
  /*
   * The proof that no page prints a status line around the gate.
   *
   * Every Big Question surface reads its lines from lib/moments-ui.ts
   * `vehicleStatuses` (the /questions cards through momentStatus, the question
   * page's header, vehicle cards and still-open rail through questionVehicles,
   * the home band through lib/home.ts), which calls siteBillStatusLine; the
   * home page's week rows call it directly.
   *
   * So outside lib/floor-session.ts, no file in app/, components/, lib/ or
   * scripts/ may reach `billStatusLine` at all: not by name in code (an
   * import, renamed or not, a re-export, or `ns['billStatusLine']`), and not
   * through a namespace import, `export *`, a dynamic import or a require of
   * lib/moment-status.mjs, any of which could reach it without naming it in an
   * import. scripts/moment-watch.mjs is the one allowed script: the owner's
   * nightly digest reads the line without the session check on purpose, so
   * its stored snapshot does not flip at the start and end of every recess.
   */
  const ROOTS = ['app', 'components', 'lib', 'scripts'];
  const ALLOWED = new Set(['lib/moment-status.mjs', 'lib/floor-session.ts', 'scripts/moment-watch.mjs']);
  const MODULE = String.raw`['"][^'"]*moment-status(?:\.mjs)?['"]`;
  const NAMESPACE = new RegExp(String.raw`import\s+(?:type\s+)?(?:\w+\s*,\s*)?\*\s+as\s+\w+\s+from\s+${MODULE}`);
  const EXPORT_ALL = new RegExp(String.raw`export\s+\*\s+(?:as\s+\w+\s+)?from\s+${MODULE}`);
  const DYNAMIC = new RegExp(String.raw`(?:\bimport|\brequire)\s*\(\s*${MODULE}`);
  /** Code only: block and line comments removed (a `//` right after a colon
   *  is a URL, not a comment), so a file may still mention the name in prose. */
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

  /** Does this source reach billStatusLine (or could it, without naming it)? */
  function reaches(src: string): boolean {
    const c = code(src);
    return /billStatusLine/.test(c) || NAMESPACE.test(c) || EXPORT_ALL.test(c) || DYNAMIC.test(c);
  }
  function offendersIn(files: string[]): string[] {
    return files.filter((f) => !ALLOWED.has(f) && reaches(readFileSync(f, 'utf8')));
  }
  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js|cjs)$/.test(name)) out.push(p.split(path.sep).join('/'));
      }
    };
    for (const r of ROOTS) walk(r);
    return out;
  }

  test('nothing outside lib/floor-session.ts reaches billStatusLine around the session gate', () => {
    expect(offendersIn(sourceFiles())).toEqual([]);
  });

  test('the guard catches every bypass shape it names', () => {
    const shapes: Record<string, string> = {
      plain: `import { billStatusLine } from '@/lib/moment-status.mjs';\nbillStatusLine(b);`,
      renamed: `import { questionStatus, billStatusLine as read } from './moment-status.mjs';\nread(b);`,
      reexport: `export { billStatusLine as line } from '../lib/moment-status.mjs';`,
      namespace: `import * as ms from '@/lib/moment-status.mjs';\nms[k](b);`,
      exportAll: `export * from './moment-status.mjs';`,
      dynamic: `const ms = await import('@/lib/moment-status.mjs');`,
      require: `const ms = require("../lib/moment-status.mjs");`,
      bracket: `import { questionStatus } from './moment-status.mjs';\nconst f = mod['billStatusLine'];`,
    };
    const hit = reaches;
    for (const [name, src] of Object.entries(shapes)) expect(hit(src), name).toBe(true);
    // The shapes the site legitimately uses stay allowed.
    expect(hit(`import { questionStatus } from '@/lib/moment-status.mjs';`)).toBe(false);
    expect(hit(`import type { StatusLine } from '@/lib/moment-status.mjs';`)).toBe(false);
    expect(hit(`// billStatusLine is read through lib/floor-session.ts\nconst u = 'https://x.y/billStatus';`)).toBe(false);
  });

  test('vehicleStatuses and the home page read the gated line', () => {
    expect(readFileSync('lib/moments-ui.ts', 'utf8')).toMatch(/siteBillStatusLine\(b, now\)/);
    expect(readFileSync('app/[locale]/page.tsx', 'utf8')).toMatch(/siteBillStatusLine\(b\)/);
    expect(readFileSync('app/[locale]/questions/[id]/page.tsx', 'utf8')).toMatch(
      /floorSuspended=\{calendarMarkSuspended\(raw\)\}/
    );
  });
});
