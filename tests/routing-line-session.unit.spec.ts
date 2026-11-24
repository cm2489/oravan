import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createTranslator } from 'next-intl';
import {
  liveCallKey,
  liveCallTarget,
  settledDecision,
  type Chamber,
  type ChamberSession,
  type LiveCallTarget,
} from '../lib/journey';
import { billRail } from '../lib/bill-rail';
import { buildScriptPrompt, STANCES } from '../lib/scriptprompt';
import type { Bill } from '../lib/types';
import { fixClock } from './fixed-clock';

/*
 * THE CALL PANEL'S ROUTING LINE FOLLOWS THE CHAMBER-SESSION GATE
 * (docs/record-truth.md §5; lib/journey.ts `heldWhileOut`, 2026-11-20).
 *
 * "This bill is before the House right now, so your House member is the one
 * to call." is a floor claim. While the chamber it names reads "out", the line
 * is exactly what the aged path gives the same record (an aged floor fact has
 * no target, so no line), through `floorFactSuspended`: a bill on that
 * chamber's own published schedule is exempt, and `unknown` stays live. Only
 * the line moves: the target, the order of offices, the panel and the script
 * prompt are identical in and out of session (rule 8).
 *
 * Frozen fixtures, an injected session reader, and the clock pinned for the
 * whole file (liveCallTarget, settledDecision and the script prompt read it
 * with no argument).
 */

const NOW = Date.parse('2026-11-20T00:00:00Z');
fixClock(NOW);
const day = (ago: number): string => new Date(NOW - ago * 86_400_000).toISOString().slice(0, 10);

const HOUSE_CALENDAR = 'Placed on the Union Calendar, Calendar No. 219.';
const SENATE_CALENDAR = 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 715.';
const HOUSE_PENDING =
  'Rules Committee Resolution H. Res. 1665 Reported to House. Rule provides for consideration of H.R. 3495 and H.R. 5267.';
const SENATE_PENDING = 'Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4365)';
const SENATE_CLOTURE_INVOKED = 'Cloture on the measure invoked in Senate by Yea-Nay Vote. 61 - 37. Record Vote Number: 280.';
const PASSED_HOUSE = 'Passed/agreed to in House: On passage Passed by recorded vote: 215 - 211 (Roll no. 301).';
const PASSED_SENATE_CHANGES = 'Passed Senate with an amendment by Yea-Nay Vote. 62 - 33. Record Vote Number: 270.';

type Fx = Bill;
const bill = (bill_type: string, status: Bill['status'], text: string, ago: number): Fx =>
  ({
    bill_type,
    bill_number: '1',
    // The 120th: a sitting Congress whichever Congress the ended switch names
    // (ORAVAN_REVIEW_ENDED_CONGRESS=119 ends every 119th bill's call).
    congress_number: 120,
    status,
    title: 'A bill for testing.',
    short_title: 'Testing Act',
    ai_summary: 'It tests things.',
    last_action_text: text,
    last_action_date: day(ago),
  }) as unknown as Fx;

const sessions: Record<string, (c: Chamber) => ChamberSession> = {
  houseOut: (c) => (c === 'house' ? 'out_of_session' : 'in_session'),
  senateOut: (c) => (c === 'senate' ? 'out_of_session' : 'in_session'),
  bothOut: () => 'out_of_session',
  unknown: () => 'unknown',
  bothIn: () => 'in_session',
};
const OUT_CASES = ['houseOut', 'senateOut', 'bothOut'] as const;

/** The announcement the bill page passes, read under a session. */
const ann = (chamber: Chamber | null, sessionOf: (c: Chamber) => ChamberSession) =>
  chamber ? { chamber, published: day(4), session: sessionOf(chamber) } : null;

/** The target and the line as the bill page and ActionPanel compute them. */
function route(fx: Fx, announced: Chamber | null, sessionOf: (c: Chamber) => ChamberSession, gated = true) {
  const target = liveCallTarget(fx, ann(announced, sessionOf), gated ? sessionOf : undefined);
  return { target, key: liveCallKey(target, { hasSenator: true }), keyNoSenator: liveCallKey(target, { hasSenator: false }) };
}
/** The same record once its floor fact is older than the 14-day window. */
const aged = (fx: Fx): Fx => ({ ...fx, last_action_date: day(30) });

/** The order the panel lists offices in reads only these three fields. */
const order = (t: LiveCallTarget | null) => (t ? { chamber: t.chamber, afterVote: t.afterVote, soleChamber: t.soleChamber } : null);

const FIXTURES: { name: string; fx: Fx }[] = [];
for (const [name, type, status, text] of [
  ['House calendar', 'hr', 'floor_vote', HOUSE_CALENDAR],
  ['House pending (H.R. 3495 shape)', 'hr', 'floor_vote', HOUSE_PENDING],
  ['Senate calendar, Senate bill', 's', 'floor_vote', SENATE_CALENDAR],
  ['Senate calendar, House bill (H.R. 7618 shape)', 'hr', 'floor_vote', SENATE_CALENDAR],
  ['Senate pending on a House bill', 'hr', 'floor_vote', SENATE_PENDING],
  ['Senate cloture invoked', 's', 'floor_vote', SENATE_CLOTURE_INVOKED],
  ['passed the House', 'hr', 'passed_chamber', PASSED_HOUSE],
  ['passed the Senate with changes', 'hr', 'passed_chamber', PASSED_SENATE_CHANGES],
  ['in committee', 's', 'committee', 'Read twice and referred to the Committee on Finance.'],
] as const) {
  for (const ago of [0, 3, 14, 15, 30]) FIXTURES.push({ name: `${name}, ${ago}d`, fx: bill(type, status, text, ago) });
}

const messages = (locale: 'en' | 'es') => JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'));
const line = (locale: 'en' | 'es', key: string | null) =>
  key ? (createTranslator({ locale, messages: messages(locale), namespace: 'bill' }) as unknown as (k: string) => string)(key) : null;

test.describe('the routing line under the chamber-session gate', () => {
  test('Senate out: the Senate floor line goes; the House one stays', () => {
    const s = sessions.senateOut;
    const senate = route(bill('s', 'floor_vote', SENATE_CALENDAR, 3), null, s);
    expect(senate.key).toBeNull();
    expect(order(senate.target)).toEqual({ chamber: 'senate', afterVote: false, soleChamber: false });
    expect(route(bill('hr', 'floor_vote', SENATE_PENDING, 3), null, s).key).toBeNull();
    expect(route(bill('s', 'floor_vote', SENATE_CLOTURE_INVOKED, 3), null, s).key).toBeNull();
    expect(route(bill('hr', 'floor_vote', HOUSE_CALENDAR, 3), null, s).key).toBe('liveHouseFloor');
  });

  test('House out: the House floor line goes; the Senate one stays', () => {
    const s = sessions.houseOut;
    const house = route(bill('hr', 'floor_vote', HOUSE_PENDING, 3), null, s);
    expect(house.key).toBeNull();
    expect(order(house.target)).toEqual({ chamber: 'house', afterVote: false, soleChamber: false });
    expect(route(bill('hr', 'floor_vote', HOUSE_CALENDAR, 3), null, s).key).toBeNull();
    expect(route(bill('s', 'floor_vote', SENATE_CALENDAR, 3), null, s).key).toBe('liveSenateFloor');
  });

  test('both out: no "right now" line on any floor fixture', () => {
    for (const { name, fx } of FIXTURES) {
      const { key } = route(fx, null, sessions.bothOut);
      expect(key === 'liveHouseFloor' || key === 'liveSenateFloor', name).toBe(false);
    }
  });

  test('unknown and in session read exactly as with no session reader (the recorded fail-safe)', () => {
    for (const { name, fx } of FIXTURES) {
      for (const announced of [null, 'house', 'senate'] as const) {
        for (const n of ['unknown', 'bothIn'] as const) {
          expect(route(fx, announced, sessions[n]), `${name} ${n} ann=${announced}`).toEqual(route(fx, announced, sessions[n], false));
        }
      }
    }
  });

  test("a bill on the named chamber's own published schedule keeps its line", () => {
    const fx = bill('hr', 'floor_vote', HOUSE_PENDING, 3);
    expect(route(fx, 'house', sessions.houseOut).key).toBe('liveHouseFloor');
    // A schedule of the OTHER chamber exempts nothing here: with both out, the
    // House record's line is held. (With the Senate meeting, main already routes
    // to the announcing Senate, whose line is then true.)
    expect(route(fx, 'senate', sessions.bothOut).key).toBeNull();
    expect(route(fx, 'senate', sessions.houseOut).key).toBe('liveSenateFloor');
  });

  test('the passage line ("…has already voted…") is not a floor fact and never moves', () => {
    for (const text of [PASSED_HOUSE, PASSED_SENATE_CHANGES]) {
      const fx = bill('hr', 'passed_chamber', text, 3);
      const inSession = route(fx, null, sessions.bothIn);
      expect(inSession.key).toMatch(/AfterHouse|AfterSenate/);
      for (const n of OUT_CASES) expect(route(fx, null, sessions[n]), `${text} ${n}`).toEqual(inSession);
    }
  });

  test('both languages: the exact words in and out of session', () => {
    const house = bill('hr', 'floor_vote', HOUSE_PENDING, 3);
    const senate = bill('s', 'floor_vote', SENATE_CALENDAR, 3);
    const five = bill('hr', 'floor_vote', SENATE_CALENDAR, 3);
    expect(line('en', route(house, null, sessions.bothIn).key)).toBe(
      'This bill is before the House right now, so your House member is the one to call.'
    );
    expect(line('es', route(house, null, sessions.bothIn).key)).toBe('Este proyecto está ahora ante la Cámara, así que llama a tu representante.');
    expect(line('en', route(senate, null, sessions.bothIn).key)).toBe(
      'This bill is before the Senate right now, so your senators are the ones to call.'
    );
    expect(line('es', route(senate, null, sessions.bothIn).key)).toBe('Este proyecto está ahora ante el Senado, así que llama a tus senadores.');
    for (const locale of ['en', 'es'] as const) {
      expect(line(locale, route(house, null, sessions.houseOut).key)).toBeNull();
      expect(line(locale, route(senate, null, sessions.senateOut).key)).toBeNull();
      expect(line(locale, route(five, null, sessions.senateOut).key)).toBeNull();
    }
  });

  test('property: out of session, the line is the aged line, for every fixture, session and schedule', () => {
    let held = 0;
    for (const { name, fx } of FIXTURES) {
      for (const n of OUT_CASES) {
        for (const announced of [null, 'house', 'senate'] as const) {
          const out = route(fx, announced, sessions[n]);
          if (out.target?.held) {
            held++;
            expect(out.key, `${name} ${n} ann=${announced}`).toBe(route(aged(fx), announced, sessions[n], false).key);
            expect(out.keyNoSenator).toBe(route(aged(fx), announced, sessions[n], false).keyNoSenator);
          }
          // And no "right now" line names a chamber that is out, unless that
          // chamber's own schedule names the bill.
          const named = out.key === 'liveHouseFloor' ? 'house' : out.key === 'liveSenateFloor' ? 'senate' : null;
          if (named && sessions[n](named) === 'out_of_session') expect(announced, `${name} ${n}`).toBe(named);
        }
      }
    }
    expect(held).toBeGreaterThan(20);
  });

  test('rule 8: panel, order of offices, call target and script prompt are identical in and out of session', () => {
    for (const { name, fx } of FIXTURES) {
      for (const announced of [null, 'house', 'senate'] as const) {
        const apparatus = (sessionOf: (c: Chamber) => ChamberSession) => {
          const rail = billRail(fx);
          const { target } = route(fx, announced, sessionOf);
          return {
            panel: rail.panel,
            floatingCall: rail.floatingCall,
            settled: settledDecision(fx),
            order: order(target),
            prompts: STANCES.flatMap((stance) => (['en', 'es'] as const).map((lang) => buildScriptPrompt({ bill: fx, stance, lang }))),
          };
        };
        // Compared with main's reading (no session reader) under the same
        // session, so the only thing that can differ is this change.
        for (const n of [...OUT_CASES, 'unknown', 'bothIn'] as const) {
          const mainReading = { ...apparatus(sessions[n]), order: order(route(fx, announced, sessions[n], false).target) };
          expect(apparatus(sessions[n]), `${name} ${n} ann=${announced}`).toEqual(mainReading);
        }
        // And in vs out, wherever main already agrees with itself (H.R. 7254's
        // schedule-only target is main's own difference, left as it is).
        if (!announced) {
          for (const n of OUT_CASES) expect(apparatus(sessions[n]), `${name} ${n}`).toEqual(apparatus(sessions.bothIn));
        }
      }
    }
  });
});

test.describe('the wiring: the two call panels pass the session reader, the hub does not need it', () => {
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  /** The top-level arguments of every liveCallTarget( call in a source. */
  function calls(src: string): string[][] {
    const c = code(src);
    const out: string[][] = [];
    const re = /\bliveCallTarget\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(c))) {
      if (/function\s+$/.test(c.slice(0, m.index))) continue;
      let depth = 1;
      let arg = '';
      const args: string[] = [];
      for (let i = m.index + m[0].length; i < c.length && depth > 0; i++) {
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
  const PANELS: Record<string, RegExp> = {
    'app/[locale]/bills/[id]/page.tsx': /^\(c\)\s*=>\s*chamberSession\(c\)$/,
    'lib/bill-call-panel.ts': /^\(c\)\s*=>\s*chamberSession\(c,\s*now\)$/,
  };

  test('each call panel passes the session reader on every call', () => {
    for (const [file, reader] of Object.entries(PANELS)) {
      const found = calls(readFileSync(file, 'utf8'));
      expect(found.length, file).toBeGreaterThan(0);
      for (const args of found) expect(reader.test(args[2] ?? ''), `${file}: (${args.join(', ')})`).toBe(true);
    }
  });

  test('the /call hub reads only the chamber, which the gate never changes', () => {
    const src = code(readFileSync('app/[locale]/call/page.tsx', 'utf8'));
    expect(calls(src).length).toBe(1);
    expect(src).toMatch(/liveChamber:\s*live\?\.chamber\s*\?\?\s*null/);
  });

  test('the guard catches a panel that drops the reader', () => {
    const page = PANELS['app/[locale]/bills/[id]/page.tsx'];
    for (const src of [
      'const t = liveCallTarget(bill, announcement ? { chamber: a } : null);',
      'const t = liveCallTarget(bill, null, undefined);',
      'const t = liveCallTarget(bill, null, () => "in_session");',
    ]) {
      expect(calls(src).every((args) => page.test(args[2] ?? '')), src).toBe(false);
    }
    expect(calls('liveCallTarget(bill, a ? { chamber: a.c } : null, (c) => chamberSession(c))').every((args) => page.test(args[2] ?? ''))).toBe(true);
  });
});
