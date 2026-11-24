import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createTranslator } from 'next-intl';
import {
  billFloorBand,
  deriveJourney,
  liveCallKey,
  liveCallTarget,
  settledDecision,
  type Chamber,
  type ChamberSession,
  type JourneyNowKey,
  type JourneySession,
} from '../lib/journey';
import { billRail } from '../lib/bill-rail';
import { journeySessionAt, journeySessionFrom } from '../lib/floor-session';
import { docketRung } from '../lib/docket.mjs';
import type { Bill } from '../lib/types';
import { fixClock } from './fixed-clock';

/*
 * THE STEPPER'S "Right now:" SENTENCE FOLLOWS THE CHAMBER-SESSION GATE
 * (docs/record-truth.md §5; lib/journey.ts `JourneySession`, 2026-11-20).
 *
 * While the chamber a present-tense floor sentence names reads "out", the
 * sentence takes the stale variant it already takes after the 14-day window,
 * so the page cannot print "this page shows no live floor claim today" over
 * "Right now: the House is deciding whether to bring it to a vote".
 *
 * Frozen fixtures, a frozen clock and an injected session reader only: no live
 * data file and no real clock is read here (the shift runs at +14, +60 and
 * +400 days return the same results).
 */

// Midnight UTC, so an action dated 14 days back sits exactly on the window's
// last day (lib/urgency.mjs isSignalFresh: days <= 14).
const NOW = Date.parse('2026-11-20T00:00:00Z');
// liveCallTarget takes no clock: through recordCallTarget, isSignalFresh reads
// Date.now(). Without this the rule 8 tests compare fixtures dated from NOW
// against the real day and start failing 13 days later.
fixClock(NOW);
const day = (ago: number): string => new Date(NOW - ago * 86_400_000).toISOString().slice(0, 10);

// Verbatim record sentences, one per floor shape the stepper can call live.
const HOUSE_CALENDAR = 'Placed on the Union Calendar, Calendar No. 219.';
const SENATE_CALENDAR = 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.';
// H.R. 3495's and H.R. 5267's last action on 2026-11-17.
const HOUSE_PENDING =
  'Rules Committee Resolution H. Res. 1665 Reported to House. Rule provides for consideration of H.R. 3495 and H.R. 5267.';
const SENATE_PENDING = 'Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4365)';
const SENATE_CLOTURE_INVOKED = 'Cloture on the measure invoked in Senate by Yea-Nay Vote. 61 - 37. Record Vote Number: 280.';

type Fixture = Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'>;
const bill = (bill_type: string, status: Bill['status'], text: string, ago = 3): Fixture => ({
  bill_type,
  status,
  last_action_text: text,
  last_action_date: day(ago),
});

const sessions: Record<string, (c: Chamber) => ChamberSession> = {
  houseOut: (c) => (c === 'house' ? 'out_of_session' : 'in_session'),
  senateOut: (c) => (c === 'senate' ? 'out_of_session' : 'in_session'),
  bothOut: () => 'out_of_session',
  unknown: () => 'unknown',
  bothIn: () => 'in_session',
};
const under = (name: keyof typeof sessions, announced: Chamber | null = null): JourneySession => ({
  sessionOf: sessions[name],
  announced,
});

/** The keys that claim, in the present tense, that a chamber is acting on the
 *  floor or that the bill can be called up there now. */
const LIVE_FLOOR_KEYS: ReadonlySet<JourneyNowKey> = new Set(['nowFloor', 'nowFloorActivity', 'nowFloorClotureInvoked']);

/*
 * EVERY "Right now:" KEY, CLASSIFIED. A key added to messages/en.json without
 * a line here fails the test below, so a new present-tense floor sentence
 * cannot arrive without someone deciding whether the session gate covers it.
 * `handoff`: "now goes to" / "so it goes back to" name where the bill is
 * headed, not a chamber acting on the floor; the page shows no recess note on
 * them (the floor band exists only at floor_vote) and §5 does not cover them.
 */
const CLASS: Record<string, 'live-floor' | 'past-or-structural' | 'handoff'> = {
  nowIntroduced: 'past-or-structural',
  nowCommittee: 'past-or-structural',
  nowFloor: 'live-floor',
  nowFloorStale: 'past-or-structural',
  nowFloorActivity: 'live-floor',
  nowFloorActivityStale: 'past-or-structural',
  nowFloorActivityNeutral: 'past-or-structural',
  nowFloorMotionFailed: 'past-or-structural',
  nowFloorSuspensionFailed: 'past-or-structural',
  nowFloorPassageRejected: 'past-or-structural',
  nowFloorClotureInvoked: 'live-floor',
  nowPointOfOrderUpheld: 'past-or-structural',
  nowPassed: 'handoff',
  nowPassedStale: 'past-or-structural',
  nowPassedBack: 'handoff',
  nowPassedBackStale: 'past-or-structural',
  nowPassedBoth: 'past-or-structural',
  nowPassedSecond: 'past-or-structural',
  nowAdoptedBoth: 'past-or-structural',
  nowConference: 'past-or-structural',
  nowSigned: 'past-or-structural',
  nowVetoed: 'past-or-structural',
};

const messages = (locale: 'en' | 'es') =>
  JSON.parse(readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'));

/** The sentence as components/BillJourney.tsx prints it, tags flattened. */
function sentence(locale: 'en' | 'es', fx: Fixture, session?: JourneySession): string {
  const j = deriveJourney(fx, NOW, session);
  const t = createTranslator({ locale, messages: messages(locale), namespace: 'bill.journey' }) as unknown as {
    (key: string): string;
    markup: (key: string, values: Record<string, unknown>) => string;
  };
  const cap = (c: Chamber) => (c === 'house' ? 'House' : 'Senate');
  const other = j.origin === 'house' ? 'Senate' : 'House';
  const body = t.markup(j.nowKey, {
    chamber: cap(j.nowChamber),
    other,
    floorCalendar: (chunks: string) => chunks,
    tally: j.tally ? 'yes' : 'none',
    yeas: j.tally?.yeas ?? 0,
    nays: j.tally?.nays ?? 0,
    hasDate: 'none',
    date: '',
  });
  return `${t('now')} ${body}`;
}

test.describe('the "Right now:" sentence under the chamber-session gate', () => {
  test('House out: the House sentences take their stale variants; the Senate ones stay live', () => {
    const s = under('houseOut');
    expect(deriveJourney(bill('hr', 'floor_vote', HOUSE_CALENDAR), NOW, s)).toMatchObject({
      nowKey: 'nowFloorStale',
      onCalendar: false,
    });
    expect(deriveJourney(bill('hr', 'floor_vote', HOUSE_PENDING), NOW, s).nowKey).toBe('nowFloorActivityStale');
    expect(deriveJourney(bill('s', 'floor_vote', SENATE_CALENDAR), NOW, s)).toMatchObject({
      nowKey: 'nowFloor',
      onCalendar: true,
    });
    expect(deriveJourney(bill('s', 'floor_vote', SENATE_PENDING), NOW, s).nowKey).toBe('nowFloorActivity');
  });

  test('Senate out: the Senate sentences take their stale variants, cloture invoked included', () => {
    const s = under('senateOut');
    expect(deriveJourney(bill('s', 'floor_vote', SENATE_CALENDAR), NOW, s).nowKey).toBe('nowFloorStale');
    expect(deriveJourney(bill('hr', 'floor_vote', SENATE_PENDING), NOW, s).nowKey).toBe('nowFloorActivityStale');
    expect(deriveJourney(bill('s', 'floor_vote', SENATE_CLOTURE_INVOKED), NOW, s).nowKey).toBe('nowFloorActivityStale');
    expect(deriveJourney(bill('hr', 'floor_vote', HOUSE_PENDING), NOW, s).nowKey).toBe('nowFloorActivity');
  });

  test('both out: no live floor sentence anywhere', () => {
    const s = under('bothOut');
    for (const fx of [
      bill('hr', 'floor_vote', HOUSE_CALENDAR),
      bill('s', 'floor_vote', SENATE_CALENDAR),
      bill('hr', 'floor_vote', HOUSE_PENDING),
      bill('hr', 'floor_vote', SENATE_PENDING),
      bill('s', 'floor_vote', SENATE_CLOTURE_INVOKED),
    ]) {
      expect(LIVE_FLOOR_KEYS.has(deriveJourney(fx, NOW, s).nowKey), fx.last_action_text ?? '').toBe(false);
    }
  });

  test('unknown and in session read exactly as the clock alone does (the recorded fail-safe)', () => {
    for (const fx of [
      bill('hr', 'floor_vote', HOUSE_CALENDAR),
      bill('s', 'floor_vote', SENATE_CALENDAR),
      bill('hr', 'floor_vote', HOUSE_PENDING),
      bill('s', 'floor_vote', SENATE_CLOTURE_INVOKED),
    ]) {
      const alone = deriveJourney(fx, NOW);
      expect(LIVE_FLOOR_KEYS.has(alone.nowKey)).toBe(true);
      expect(deriveJourney(fx, NOW, under('unknown'))).toEqual(alone);
      expect(deriveJourney(fx, NOW, under('bothIn'))).toEqual(alone);
    }
  });

  test('the 14-day edge: in session the clock decides; out, every day is stale', () => {
    let sawLive = false;
    let sawStale = false;
    for (let ago = 0; ago <= 20; ago++) {
      for (const fx of [bill('hr', 'floor_vote', HOUSE_CALENDAR, ago), bill('hr', 'floor_vote', HOUSE_PENDING, ago)]) {
        const alone = deriveJourney(fx, NOW).nowKey;
        if (LIVE_FLOOR_KEYS.has(alone)) sawLive = true;
        else sawStale = true;
        expect(deriveJourney(fx, NOW, under('bothIn')).nowKey, `${ago} days, in session`).toBe(alone);
        expect(LIVE_FLOOR_KEYS.has(deriveJourney(fx, NOW, under('houseOut')).nowKey), `${ago} days, House out`).toBe(false);
      }
    }
    // Day 14 is the window's last day and day 15 is past it (lib/urgency.mjs).
    expect(deriveJourney(bill('hr', 'floor_vote', HOUSE_PENDING, 14), NOW).nowKey).toBe('nowFloorActivity');
    expect(deriveJourney(bill('hr', 'floor_vote', HOUSE_PENDING, 15), NOW).nowKey).toBe('nowFloorActivityStale');
    expect(sawLive && sawStale).toBe(true);
  });

  test("a bill on the chamber's own published schedule keeps its exemption, for that chamber only", () => {
    const pending = bill('hr', 'floor_vote', HOUSE_PENDING);
    expect(deriveJourney(pending, NOW, under('houseOut', 'house')).nowKey).toBe('nowFloorActivity');
    expect(deriveJourney(pending, NOW, under('houseOut', 'senate')).nowKey).toBe('nowFloorActivityStale');
    expect(deriveJourney(bill('s', 'floor_vote', SENATE_CALENDAR), NOW, under('senateOut', 'senate')).nowKey).toBe(
      'nowFloor'
    );
  });

  test('both languages: the exact sentences before and after, H.R. 3495 and a Senate placement', () => {
    const hr3495 = bill('hr', 'floor_vote', HOUSE_PENDING);
    const senate = bill('s', 'floor_vote', SENATE_CALENDAR);
    expect(sentence('en', hr3495)).toBe('Right now: the House is deciding whether to bring it to a vote.');
    expect(sentence('en', hr3495, under('houseOut'))).toBe(
      'Right now: the House has taken floor action on it, and the official record shows nothing new since.'
    );
    expect(sentence('es', hr3495)).toBe('Ahora mismo: la Cámara está decidiendo si lo somete a votación.');
    expect(sentence('es', hr3495, under('houseOut'))).toBe(
      'Ahora mismo: la Cámara ha actuado en el pleno, y el registro oficial no muestra nada nuevo desde entonces.'
    );
    expect(sentence('en', senate, under('senateOut'))).toBe(
      'Right now: it was placed on the Senate floor calendar, and the official record shows no floor action on it since.'
    );
    expect(sentence('es', senate, under('senateOut'))).toBe(
      'Ahora mismo: se incluyó en el calendario del pleno del Senado, y el registro oficial no muestra ninguna acción en el pleno desde entonces.'
    );
  });

  test('every "Right now:" key is classified, and the live-floor class is exactly the gated set', () => {
    const keys = Object.keys(messages('en').bill.journey).filter((k) => /^now[A-Z]/.test(k));
    expect(keys.sort()).toEqual(Object.keys(CLASS).sort());
    expect(Object.keys(messages('es').bill.journey).filter((k) => /^now[A-Z]/.test(k)).sort()).toEqual(keys);
    expect(new Set(Object.keys(CLASS).filter((k) => CLASS[k] === 'live-floor'))).toEqual(LIVE_FLOOR_KEYS);
  });

  test('property: a bill whose named chamber is out never gets a live floor sentence', () => {
    const texts = [
      HOUSE_CALENDAR,
      SENATE_CALENDAR,
      HOUSE_PENDING,
      SENATE_PENDING,
      SENATE_CLOTURE_INVOKED,
      'Placed on the House Calendar, Calendar No. 8.',
      'Motion to proceed to consideration of measure made in Senate. (CR S5112)',
      'Considered as unfinished business. (consideration: CR H4410)',
      'Passed House (Amended) by recorded vote: 215 - 211 (Roll no. 301).',
      'Received in the Senate and Read twice and referred to the Committee on Finance.',
      'Passed Senate with an amendment by Yea-Nay Vote. 62 - 33. Record Vote Number: 270.',
      'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 88.',
      'Referred to the House Committee on Ways and Means.',
      'Became Public Law No: 119-60.',
    ];
    const statuses: Bill['status'][] = ['introduced', 'committee', 'floor_vote', 'passed_chamber', 'signed'];
    let checked = 0;
    let gated = 0;
    for (const bill_type of ['hr', 's', 'hjres', 'sconres']) {
      for (const status of statuses) {
        for (const text of texts) {
          for (const ago of [0, 7, 14, 15, 60]) {
            const fx = bill(bill_type, status, text, ago);
            const alone = deriveJourney(fx, NOW);
            for (const name of Object.keys(sessions) as (keyof typeof sessions)[]) {
              for (const announced of [null, 'house', 'senate'] as const) {
                const j = deriveJourney(fx, NOW, under(name, announced));
                checked++;
                const out = sessions[name](j.nowChamber) === 'out_of_session' && announced !== j.nowChamber;
                if (LIVE_FLOOR_KEYS.has(j.nowKey)) {
                  expect(out, `${bill_type} ${status} "${text}" ${ago}d ${name} ann=${announced}`).toBe(false);
                }
                if (LIVE_FLOOR_KEYS.has(alone.nowKey) && !LIVE_FLOOR_KEYS.has(j.nowKey)) gated++;
                // Only the tense moves: where the bill stands is the record's.
                expect({ step: j.step, current: j.current, nowChamber: j.nowChamber, showTrailer: j.showTrailer }).toEqual({
                  step: alone.step,
                  current: alone.current,
                  nowChamber: alone.nowChamber,
                  showTrailer: alone.showTrailer,
                });
                // A sentence that was not live never changes.
                if (!LIVE_FLOOR_KEYS.has(alone.nowKey)) expect(j).toEqual(alone);
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
    expect(gated).toBeGreaterThan(0);
  });

  test('the recess note and the sentence agree: a held band means a stale sentence', () => {
    for (const text of [HOUSE_CALENDAR, SENATE_CALENDAR, HOUSE_PENDING, SENATE_PENDING, SENATE_CLOTURE_INVOKED]) {
      for (const bill_type of ['hr', 's']) {
        const fx = bill(bill_type, 'floor_vote', text);
        for (const name of ['houseOut', 'senateOut', 'bothOut'] as const) {
          const band = billFloorBand(fx, null, NOW, sessions[name]);
          if (band?.suspended) expect(LIVE_FLOOR_KEYS.has(deriveJourney(fx, NOW, under(name)).nowKey), text).toBe(false);
        }
      }
    }
  });
});

/*
 * RULE 8: A RECESS MOVES THE SENTENCE, NEVER THE CALL.
 *
 * The call apparatus a bill page shows, computed the way the page computes it
 * (app/[locale]/bills/[id]/page.tsx and components/ActionPanel.tsx): the panel
 * from lib/bill-rail.ts `billRail`, the call target from `liveCallTarget` with
 * the bill's announcement CARRYING THE CHAMBER'S SESSION (the one call-side
 * function that reads it), and the routing sentence from `liveCallKey`, printed
 * in both languages. With the chamber out it must be exactly what it is with
 * the chamber in, for every fixture.
 *
 * NOT IN THE SET, on purpose, because main already routes them differently in
 * and out of session and this change does not touch that: a bill on a
 * chamber's published schedule whose own record is OLDER than the 14-day
 * window, or names the other chamber. Its routing line comes only from the
 * announcement, and `announcedCallTarget` gives it only while the announcing
 * chamber meets (SY-06, 2026-09-27), so in a recess the line "This bill is
 * before the House right now…" is not shown (the dials stay). Measured while
 * writing this test, 2026-11-20; reported, not changed here.
 */
test.describe('rule 8: the call panel, the call target and the routing sentence ignore a recess', () => {
  const ANN_DAY = day(2);
  const FIXTURES: { name: string; fx: Fixture; announced: Chamber | null }[] = [];
  for (const [name, bill_type, status, text] of [
    ['House pending', 'hr', 'floor_vote', HOUSE_PENDING],
    ['House calendar', 'hr', 'floor_vote', HOUSE_CALENDAR],
    ['Senate calendar', 's', 'floor_vote', SENATE_CALENDAR],
    ['Senate pending on a House bill', 'hr', 'floor_vote', SENATE_PENDING],
    ['Senate cloture invoked', 's', 'floor_vote', SENATE_CLOTURE_INVOKED],
    ['passed the House', 'hr', 'passed_chamber', 'Passed House (Amended) by recorded vote: 215 - 211 (Roll no. 301).'],
    ['passed the Senate with changes', 'hr', 'passed_chamber', 'Passed Senate with an amendment by Yea-Nay Vote. 62 - 33. Record Vote Number: 270.'],
    ['in committee', 's', 'committee', 'Read twice and referred to the Committee on Finance.'],
  ] as const) {
    for (const ago of [2, 30]) {
      const fx = bill(bill_type, status, text, ago);
      FIXTURES.push({ name: `${name}, ${ago}d`, fx, announced: null });
      const recordChamber = deriveJourney(fx, NOW).nowChamber;
      // On its own chamber's schedule, while the record is fresh (see above).
      if (status === 'floor_vote' && ago < 14) {
        FIXTURES.push({ name: `${name}, ${ago}d, on its chamber's schedule`, fx, announced: recordChamber });
      }
    }
  }

  const tr = (locale: 'en' | 'es') =>
    createTranslator({ locale, messages: messages(locale), namespace: 'bill' }) as unknown as (key: string) => string;

  function apparatus(fx: Fixture, announced: Chamber | null, sessionOf: (c: Chamber) => ChamberSession) {
    const full = { ...fx, bill_number: '1', congress_number: 119 } as unknown as Bill;
    const target = liveCallTarget(
      full,
      announced ? { chamber: announced, published: ANN_DAY, session: sessionOf(announced) } : null
    );
    const keys = [liveCallKey(target, { hasSenator: true }), liveCallKey(target, { hasSenator: false })];
    const rail = billRail(full);
    return {
      panel: rail.panel,
      floatingCall: rail.floatingCall,
      settled: settledDecision(full),
      target,
      keys,
      en: keys.map((k) => (k ? tr('en')(k) : null)),
      es: keys.map((k) => (k ? tr('es')(k) : null)),
    };
  }

  test('identical with each chamber in and out, for every fixture, in both languages', () => {
    let routed = 0;
    for (const { name, fx, announced } of FIXTURES) {
      const inSession = apparatus(fx, announced, sessions.bothIn);
      if (inSession.keys[0]) routed++;
      for (const out of ['houseOut', 'senateOut', 'bothOut'] as const) {
        expect(apparatus(fx, announced, sessions[out]), `${name}, ${out}`).toEqual(inSession);
      }
    }
    // The set exercises a routed call, including through a schedule announcement.
    expect(routed).toBeGreaterThan(4);
    expect(FIXTURES.some((f) => f.announced && apparatus(f.fx, f.announced, sessions.bothIn).keys[0])).toBe(true);
  });
});

/*
 * THE PUBLISHED-SCHEDULE EXEMPTION, THROUGH THE REAL RUNG.
 *
 * lib/floor-session.ts `journeySessionFrom` reads the exemption out of the
 * bill's docket rung (tier t0, `announced`), the way the bill page's band does.
 * Here the rung is lib/docket.mjs `docketRung` over a frozen copy of H.R.
 * 3495's schedule entry as data/floor-signals.json held it on 2026-11-20, so
 * no live file decides the result.
 */
test.describe('journeySessionFrom: a bill on its chamber’s own published schedule keeps its exemption', () => {
  const AT = Date.parse('2026-11-20T21:00:00Z');
  const HR3495 = {
    bill_type: 'hr',
    status: 'floor_vote' as const,
    last_action_date: '2026-11-17',
    last_action_text: HOUSE_PENDING,
  };
  const SIGNAL = {
    tier0: {
      source: 'billsthisweek',
      chamber: 'house',
      quote: 'Direct Seller and Real Estate Agent Harmonization Act',
      quote_lang: 'en',
      quote_kind: 'floor_text',
      announcement: 'Items that may be considered pursuant to a rule',
      url: 'https://docs.house.gov/billsthisweek/20261116/20261116.xml',
      published: '2026-11-13',
      covers: '2026-11-16',
      covers_label: null,
      track: 'rule',
      certainty: 'consideration',
    },
    fetched_at: '2026-11-20T20:04:22.363Z',
    first_seen: '2026-11-16T11:02:12.090Z',
    stale: false,
  };

  test('on the schedule: the live sentence, and no suspension, with the House out', () => {
    const rung = docketRung(HR3495, SIGNAL, { now: AT });
    expect(rung.tier).toBe('t0');
    const s = journeySessionFrom(rung, sessions.houseOut);
    expect(s.announced).toBe('house');
    expect(deriveJourney(HR3495, AT, s).nowKey).toBe('nowFloorActivity');
    const band = billFloorBand(HR3495, rung.announced, AT, s.sessionOf);
    expect(band).toMatchObject({ kind: 'announced', suspended: false });
  });

  test('not on the schedule: the stale sentence, and the band suspended, with the House out', () => {
    const rung = docketRung(HR3495, null, { now: AT });
    expect(rung.tier).not.toBe('t0');
    const s = journeySessionFrom(rung, sessions.houseOut);
    expect(s.announced).toBeNull();
    expect(deriveJourney(HR3495, AT, s).nowKey).toBe('nowFloorActivityStale');
    expect(billFloorBand(HR3495, null, AT, s.sessionOf)).toMatchObject({ kind: 'pending', suspended: true });
  });

  test('a schedule entry not at tier t0 grants no exemption', () => {
    const s = journeySessionFrom({ tier: 't1', announced: { chamber: 'house' } }, sessions.houseOut);
    expect(s.announced).toBeNull();
  });

  test('journeySessionAt is journeySessionFrom over the committed rung, read at the given clock', () => {
    const seen: number[] = [];
    const s = journeySessionAt(bill('hr', 'committee', 'Referred to the House Committee on Ways and Means.'), 'hr-1-119', NOW, (c, at) => {
      seen.push(at);
      return c === 'house' ? 'out_of_session' : 'in_session';
    });
    expect(s.sessionOf('house')).toBe('out_of_session');
    expect(s.sessionOf('senate')).toBe('in_session');
    expect(seen).toEqual([NOW, NOW]);
    // Its body hands the rung for this bill, at this clock, to journeySessionFrom.
    const body = code(readFileSync('lib/floor-session.ts', 'utf8')).split('export function journeySessionAt(')[1] ?? '';
    expect(body).toMatch(/journeySessionFrom\(\s*rungFor\(\s*bill\s*,\s*slug\s*,\s*now\s*\)/);
  });
});

/*
 * EVERY SURFACE THAT ASKS FOR THE SENTENCE ASKS UNDER THE SESSION READING.
 *
 * Three files outside lib/journey.ts call deriveJourney: the bill page (its
 * stepper prints the sentence), a member's votes list (prints it) and the
 * shared-name list (does not print it; it reads the key only to decide whether
 * its own status line agrees with the bill page). None of the three is
 * callable from a unit test with its wiring intact (two are server components,
 * and the shared-name list's agreement check cannot change its output, because
 * its status line already stands down wherever the sentence does), so the
 * wiring is pinned at the source, comments stripped: every call passes a third
 * argument that is the session reading, built the way that file must build it,
 * and no other file may call deriveJourney without being added here.
 */
/** Code only: block and line comments removed (a `//` right after a colon is a
 *  URL), as in tests/floor-session.unit.spec.ts. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** The top-level arguments of every `deriveJourney(` call in a source. */
function journeyCalls(src: string): string[][] {
  const c = code(src);
  const out: string[][] = [];
  const re = /\bderiveJourney\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c))) {
    if (/function\s+$/.test(c.slice(0, m.index))) continue; // the definition
    let depth = 1;
    let i = m.index + m[0].length;
    let arg = '';
    const args: string[] = [];
    for (; i < c.length && depth > 0; i++) {
      const ch = c[i];
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) depth--;
      if (depth === 0) break;
      if (ch === ',' && depth === 1) {
        args.push(arg.trim());
        arg = '';
      } else arg += ch;
    }
    if (arg.trim()) args.push(arg.trim());
    out.push(args);
  }
  return out;
}

const SURFACES: Record<string, RegExp> = {
  'app/[locale]/bills/[id]/page.tsx': /^journeySessionFrom\(\s*rung\s*,/,
  'components/MemberVotes.tsx': /^journeySessionAt\(\s*bill\s*,\s*billSlug\(bill\)\s*\)$/,
  'lib/shared-names.ts': /^sessionOf\s*\?\s*\{\s*sessionOf\s*,\s*announced:\s*announcement\?\.chamber\s*\?\?\s*null\s*\}\s*:\s*undefined$/,
};

/** What is wrong with a surface's calls, or [] when every call is wired. */
function wiringFaults(src: string, session: RegExp): string[] {
  const c = code(src);
  const faults: string[] = [];
  if (/\bderiveJourney\s+as\s+\w+/.test(c)) faults.push('renamed import');
  const calls = journeyCalls(src);
  if (calls.length === 0) faults.push('no call');
  for (const args of calls) {
    if (args.length < 3) faults.push(`a call without the session reading: (${args.join(', ')})`);
    else if (!session.test(args[2])) faults.push(`a call with some other third argument: ${args[2]}`);
  }
  return faults;
}

test.describe('one sentence, every surface: the wiring', () => {
  test('each surface passes the session reading on every call', () => {
    for (const [file, session] of Object.entries(SURFACES)) {
      expect(wiringFaults(readFileSync(file, 'utf8'), session), file).toEqual([]);
    }
  });

  test('no other file calls deriveJourney; inside lib/journey.ts only the two settled readers do', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js|cjs)$/.test(name)) files.push(p.split(sep).join('/'));
      }
    };
    for (const root of ['app', 'components', 'lib', 'scripts']) walk(root);
    const callers = files.filter((f) => f !== 'lib/journey.ts' && journeyCalls(readFileSync(f, 'utf8')).length > 0);
    expect(callers.sort()).toEqual(Object.keys(SURFACES).sort());
    // settledDecision and lastFailedVote read only settled keys, which no
    // session reading changes; a third internal caller must be looked at.
    expect(journeyCalls(readFileSync('lib/journey.ts', 'utf8'))).toEqual([['bill'], ['bill']]);
  });

  test('the guard catches each way of dropping the session reading', () => {
    const page = SURFACES['app/[locale]/bills/[id]/page.tsx'];
    const members = SURFACES['components/MemberVotes.tsx'];
    const names = SURFACES['lib/shared-names.ts'];
    const bad: [string, RegExp][] = [
      ['journey={deriveJourney(bill)}', page],
      ['journey={deriveJourney(bill, undefined, undefined)}', page],
      ['journey={deriveJourney(bill, undefined, { sessionOf: (c) => chamberSession(c) })}', page],
      ['const journey = deriveJourney(bill, undefined, journeySessionFrom({ tier: "t4", announced: null }, s));', members],
      ['const journey = deriveJourney(bill);', members],
      ['import { deriveJourney as dj } from "@/lib/journey";\nconst journey = dj(bill, undefined, journeySessionAt(bill, billSlug(bill)));', members],
      ['deriveJourney(bill, now, sessionOf ? { sessionOf } : undefined).nowKey', names],
      ['deriveJourney(bill, now).nowKey', names],
    ];
    for (const [src, session] of bad) expect(wiringFaults(src, session).length, src).toBeGreaterThan(0);
    // The shapes the three files use pass, a comment mentioning the bare call included.
    expect(wiringFaults('// deriveJourney(bill)\nx = deriveJourney(bill, undefined, journeySessionFrom(rung, (c) => chamberSession(c)))', page)).toEqual([]);
    expect(wiringFaults('const journey = deriveJourney(bill, undefined, journeySessionAt(bill, billSlug(bill)));', members)).toEqual([]);
  });
});
