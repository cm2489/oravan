import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import {
  billFloorBand,
  deriveJourney,
  liveCallTarget,
  settledDecision,
  type Chamber,
  type ChamberSession,
  type JourneyNowKey,
  type JourneySession,
} from '../lib/journey';
import { billRail } from '../lib/bill-rail';
import { journeySessionAt } from '../lib/floor-session';
import type { Bill } from '../lib/types';

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

  test('rule 8: the call panel and the call target are the same with and without a recess', () => {
    for (const text of [HOUSE_CALENDAR, SENATE_CALENDAR, HOUSE_PENDING, SENATE_PENDING, SENATE_CLOTURE_INVOKED]) {
      for (const bill_type of ['hr', 's']) {
        const fx = { ...bill(bill_type, 'floor_vote', text), bill_number: '1', congress_number: 119 } as unknown as Bill;
        const rail = billRail(fx);
        expect(['call', 'ended'], text).toContain(rail.panel);
        expect(settledDecision(fx)).toBeNull();
        for (const name of ['houseOut', 'senateOut', 'bothOut'] as const) {
          // The gate changes only the sentence: the inputs to the panel and the
          // routing are read without it, so a recess cannot move them.
          const before = { rail: billRail(fx), target: liveCallTarget(fx, null), settled: settledDecision(fx) };
          deriveJourney(fx, NOW, under(name));
          expect({ rail: billRail(fx), target: liveCallTarget(fx, null), settled: settledDecision(fx) }).toEqual(before);
          // And the recess note and the sentence agree: a held band means a stale sentence.
          const band = billFloorBand(fx, null, NOW, sessions[name]);
          if (band?.suspended) expect(LIVE_FLOOR_KEYS.has(deriveJourney(fx, NOW, under(name)).nowKey)).toBe(false);
        }
      }
    }
  });

  test('journeySessionAt reads through the injected reader at the given clock', () => {
    const seen: number[] = [];
    const s = journeySessionAt(bill('hr', 'committee', 'Referred to the House Committee on Ways and Means.'), 'hr-1-119', NOW, (c, at) => {
      seen.push(at);
      return c === 'house' ? 'out_of_session' : 'in_session';
    });
    expect(s.sessionOf('house')).toBe('out_of_session');
    expect(s.sessionOf('senate')).toBe('in_session');
    expect(seen).toEqual([NOW, NOW]);
  });
});
