import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveJourney,
  floorActionChamber,
  floorCalendarChamber,
  liveCallKey,
  liveCallTarget,
  liveCallTargetForNomination,
  nominationHasCallScript,
  statusKeyFor,
  type LiveCallKey,
} from '../lib/journey';
import type { BillStatus } from '../lib/types';
import type { NominationStatus } from '../lib/core/nominations';
// The nomination vocabulary, from the ONE copy — see lib/nomination-status.mjs's
// header. Imported from the .mjs directly rather than through
// lib/core/nominations so this spec does not pull data/nominations.json.
import {
  NOMINATION_STATUSES,
  TERMINAL_NOMINATION_STATUSES,
} from '../lib/nomination-status.mjs';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { selectFloorVoteFeature } from '../components/system/FloorVotePanel';
// The import-free copies the .mjs report carries — pinned corpus-wide in suite 6.
import {
  floorCalendarChamber as scriptFloorCalendarChamber,
  statusKeyFor as scriptStatusKeyFor,
} from '../scripts/moment-candidates.mjs';

/*
 * THE JOURNEY DERIVATION — fixtures plus the .mjs parity pin (the live-corpus sweep moved to the nightly sync — see below).
 *
 * The sweep is the anti-re-inversion tripwire: the stepper once guessed the
 * chamber from the bill type, so a House bill under Senate cloture printed
 * "House vote — You are here" against a Senate record. deriveJourney reads
 * the record instead, and suite 4 fails CI when the nightly sync lands a
 * floor_vote action-text shape NEITHER matcher classifies — forcing a
 * matcher extension instead of a silent origin-chamber guess. That means a
 * novel legislative week can redden CI on purpose; the alternative
 * (warn-and-guess) is what shipped the original lie.
 */

interface CorpusBill {
  bill_type: string;
  bill_number: number;
  congress_number: number;
  status: string;
  last_action_date: string | null;
  last_action_text: string | null;
  urgency_score: number;
}

const corpus: CorpusBill[] = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'bills.json'), 'utf8')
);
const floorVote = corpus.filter((b) => b.status === 'floor_vote');
const slugOf = (b: CorpusBill) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`;

// hr-6500-119's exact live sentence — the flagship shape of the original bug:
// a Senate-only procedure on a House bill.
const CLOTURE_TEXT =
  'Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4365)';

/* ------------------------------------------------------------------ *
 * 1 · floorCalendarChamber fixtures (moved verbatim from the bill
 *     page — behavior must not change).
 * ------------------------------------------------------------------ */
test.describe('floorCalendarChamber', () => {
  test('reads the chamber out of a genuine calendar placement', () => {
    expect(floorCalendarChamber('Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.')).toBe('senate');
    expect(floorCalendarChamber('Read twice. Placed on Senate Legislative Calendar under General Orders. Calendar No. 87.')).toBe('senate');
    expect(floorCalendarChamber('Placed on the Union Calendar, Calendar No. 219.')).toBe('house');
    expect(floorCalendarChamber('Placed on the House Calendar, Calendar No. 8.')).toBe('house');
  });

  test('refuses everything that is not a placement', () => {
    expect(floorCalendarChamber('Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 51.')).toBeNull();
    expect(floorCalendarChamber(CLOTURE_TEXT)).toBeNull();
    expect(floorCalendarChamber(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 2 · floorActionChamber — one fixture per real corpus shape, verbatim.
 * ------------------------------------------------------------------ */
test.describe('floorActionChamber', () => {
  test('cloture is Senate-only', () => {
    expect(floorActionChamber(CLOTURE_TEXT)).toBe('senate');
    expect(floorActionChamber('Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 47 - 45. Record Vote Number: 12. (CR S286)')).toBe('senate');
  });

  test('postponed proceedings is a House floor idiom (names no chamber)', () => {
    expect(floorActionChamber('POSTPONED PROCEEDINGS - Pursuant to clause 1(c) of rule XIX, the Chair announced further proceedings on H.R. 8872 is postponed.')).toBe('house');
  });

  test('Rules Committee resolutions reported to the House', () => {
    expect(floorActionChamber('Rules Committee Resolution H. Res. 916 Reported to House. Rule provides for consideration of H.R. 4312, H.R. 1005, H.R. 1049, H.R. 1069, H.R. 2965 and H.R. 4305. The resolution provides for consideration of H.R. 4312, H.R. 1005, H.R. 1049, H.R. 1069, H.R. 2965, and H.R. 4305 under a closed rule with one hour of general debate and one motion to recommit on each bill.')).toBe('house');
  });

  test('Congressional Record page prefix: S-pages are the Senate section', () => {
    expect(floorActionChamber('Motion to proceed to consideration of measure made in Senate. (CR S4276)')).toBe('senate');
    expect(floorActionChamber('Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 111. (CR S2106)')).toBe('senate');
  });

  test('explicit venue phrases, including the both-chambers-named case', () => {
    expect(floorActionChamber('Motion by Senator Schumer to reconsider, under the order of 10/9/2025, not having voted on the prevailing side, the vote by which the third cloture motion on the motion to proceed to S. 2882 was not invoked (Record Vote No. 557) entered in Senate.')).toBe('senate');
    // "House message … rejected in Senate": the venue phrase must beat the
    // exactly-one-chamber rule, or this reads as ambiguous.
    expect(floorActionChamber('Motion to proceed to consideration of the House message to accompany S. 1318 rejected in Senate by Yea-Nay Vote. 47 - 52. Record Vote Number: 164.')).toBe('senate');
  });

  test('exactly one chamber named anywhere decides', () => {
    expect(floorActionChamber('Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 48. Record Vote Number: 174.')).toBe('senate');
  });

  test('no evidence, no claim', () => {
    expect(floorActionChamber(null)).toBeNull();
    expect(floorActionChamber('Considered as unfinished business.')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 3 · deriveJourney — the full status behavior table.
 * ------------------------------------------------------------------ */
test.describe('deriveJourney', () => {
  const j = (bill_type: string, status: string, last_action_text: string | null = null) =>
    deriveJourney({ bill_type, status, last_action_text } as Parameters<typeof deriveJourney>[0]);

  test('THE FLAGSHIP: a House bill under Senate cloture is at the Senate step, not on a calendar', () => {
    // This exact assertion fails on the pre-fix stepper, which pinned
    // floor_vote to the origin-chamber vote step and claimed a calendar.
    const journey = j('hr', 'floor_vote', CLOTURE_TEXT);
    expect(journey.step).toBe(3);
    expect(journey.current).toBe('senate');
    expect(journey.onCalendar).toBe(false);
    expect(journey.nowKey).toBe('nowFloorActivity');
    expect(journey.nowChamber).toBe('senate');
  });

  test('a House bill on the Senate calendar sits at the Senate step, on calendar', () => {
    const journey = j('hr', 'floor_vote', 'Received in the Senate. Read twice. Placed on Senate Legislative Calendar under General Orders. Calendar No. 87.');
    expect(journey).toMatchObject({ step: 3, current: 'senate', onCalendar: true, nowKey: 'nowFloor', nowChamber: 'senate' });
  });

  test('an unclassifiable floor text NEVER guesses a chamber (owner ruling 2026-08-04)', () => {
    // Neither matcher classifies this invented text. The old behavior fell
    // back to the origin chamber — a guess rendered as fact. Now: neutral
    // key, no chamber claim in the sentence, origin slot for structure only.
    const journey = j('hr', 'floor_vote', 'Considered as unfinished business.');
    expect(journey).toMatchObject({
      step: 2,
      onCalendar: false,
      nowKey: 'nowFloorActivityNeutral',
    });
  });

  test('origin-chamber calendar placements stay at the origin vote step', () => {
    expect(j('hr', 'floor_vote', 'Placed on the Union Calendar, Calendar No. 219.')).toMatchObject({ step: 2, current: 'house', onCalendar: true, nowKey: 'nowFloor' });
    expect(j('s', 'floor_vote', 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.')).toMatchObject({ step: 2, current: 'senate', onCalendar: true, nowKey: 'nowFloor' });
  });

  test('one pin per status', () => {
    expect(j('hr', 'introduced')).toMatchObject({ step: 0, nowKey: 'nowIntroduced', showTrailer: true });
    expect(j('hr', 'committee')).toMatchObject({ step: 1, nowKey: 'nowCommittee', current: 'house' });
    expect(j('s', 'markup')).toMatchObject({ step: 1, nowKey: 'nowCommittee', current: 'senate' });
    expect(j('s', 'passed_chamber', 'Passed Senate without amendment by Voice Vote.')).toMatchObject({ step: 3, current: 'house', nowChamber: 'senate', nowKey: 'nowPassed', showTrailer: true });
    expect(j('hr', 'conference')).toMatchObject({ step: 3, nowKey: 'nowConference', showTrailer: false });
    expect(j('hr', 'signed')).toMatchObject({ step: 4, isLaw: true, nowKey: 'nowSigned' });
    expect(j('hr', 'vetoed')).toMatchObject({ step: 4, isVetoed: true, nowKey: 'nowVetoed' });
    // Untyped JSON can carry a status this module has never heard of.
    expect(j('hr', 'no-such-status')).toMatchObject({ step: 1, nowKey: 'nowCommittee' });
  });
});

/* ------------------------------------------------------------------ *
 * 4 · CORPUS SWEEP — the tripwire. Runs over the live data/bills.json,
 *     so nightly data movement cannot silently re-invert the chamber
 *     derivation: a novel floor text fails here, loudly.
 * ------------------------------------------------------------------ */
/* The live-corpus sweep MOVED to the nightly sync (owner ruling
 * 2026-08-04): scripts/check-journey-corpus.mjs, wired into
 * sync-bills.yml. It tests DATA, and data changes nightly — in this
 * PR-blocking suite a novel floor text landed by the sync could red the
 * CI of unrelated PRs. The fixtures above and the parity pin below test
 * CODE and stay. deriveJourney's neutral no-chamber branch (an
 * unclassified text renders nowFloorActivityNeutral, never a guessed
 * chamber) is pinned in suite 3.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 5 · HOMEPAGE GATE — the green panel's claim ("this bill stands on the
 *     floor calendar, dated" — home.weekNote's own words) must be TRUE.
 * ------------------------------------------------------------------ */
test.describe('selectFloorVoteFeature calendar gate', () => {
  test('whatever the live corpus elects, it carries a genuine calendar placement', () => {
    const pick = selectFloorVoteFeature(corpus as Parameters<typeof selectFloorVoteFeature>[0]);
    if (pick !== null) {
      expect(floorCalendarChamber((pick as CorpusBill).last_action_text)).not.toBeNull();
    }
  });

  test('a fresh cloture bill is never featured; a fresh calendar-placed bill is', () => {
    const fresh = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const cloture = {
      status: 'floor_vote' as const,
      urgency_score: 1,
      last_action_date: fresh,
      last_action_text: CLOTURE_TEXT,
    };
    const calendared = {
      status: 'floor_vote' as const,
      urgency_score: 0.5,
      last_action_date: fresh,
      last_action_text: 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.',
    };
    expect(selectFloorVoteFeature([cloture])).toBeNull();
    expect(selectFloorVoteFeature([cloture, calendared])).toBe(calendared);
  });
});

/* ------------------------------------------------------------------ *
 * 6 · PARITY PIN — the .mjs import-free copy vs. lib/journey.ts, over
 *     every floor_vote action text in the corpus (the fixture-only pin
 *     lives in tests/moment-candidates.unit.spec.ts; this is the
 *     corpus-wide drift guard the script's header names).
 * ------------------------------------------------------------------ */
test.describe('scripts/moment-candidates.mjs copy is pinned to lib/journey.ts', () => {
  test('the two answer identically on every floor_vote action text', () => {
    for (const b of floorVote) {
      expect(scriptFloorCalendarChamber(b.last_action_text), slugOf(b)).toBe(
        floorCalendarChamber(b.last_action_text)
      );
    }
  });

  /*
   * THE STATUS-LABEL GATE, same pin, added 2026-08-09 with the copy itself.
   *
   * scripts/moment-draft.mjs prints a status label into the prompt it sends
   * the drafting model, and it used to read `bills.status[c.status]` straight
   * out of messages/*.json — bypassing the gate every other status-printing
   * surface routes through. On s-4668-119 (status floor_vote, last action a
   * cloture motion) the record block therefore said BOTH "where it stands: On
   * the floor calendar" and "floor calendar: not on a floor calendar", and the
   * draft resolved toward the label: a false "sitting on the Senate floor
   * calendar" sentence published in both languages. A prompt is a printing
   * surface. The sweep is corpus-wide because the 23-of-319 split it turns on
   * moves nightly.
   */
  test('statusKeyFor: the two answer identically over the WHOLE corpus', () => {
    for (const b of corpus) {
      expect(scriptStatusKeyFor(b.status, b.last_action_text), slugOf(b)).toBe(
        statusKeyFor(b.status as BillStatus, b.last_action_text)
      );
    }
  });

  test('statusKeyFor still separates a placement from floor activity in this corpus', () => {
    // If this ever hits zero the pin above proves nothing — the two copies
    // would agree by never disagreeing with anything.
    const downgraded = floorVote.filter(
      (b) => scriptStatusKeyFor(b.status, b.last_action_text) === 'floor_activity'
    );
    expect(downgraded.length).toBeGreaterThan(0);
    expect(downgraded.length).toBeLessThan(floorVote.length);
  });
});

/* ------------------------------------------------------------------ *
 * 5 · liveCallTarget — chamber-aware call routing (2026-08 benchmark
 *     2026-08). Non-null ONLY where the record places the bill in a
 *     chamber's hands today; everything else renders the rep list
 *     exactly as before. Never guesses (owner ruling 2026-08-04).
 *
 *     EVERY non-null assertion here spells out `soleChamber: false` —
 *     `toEqual` is exact, so this suite is the regression guard on the
 *     2026-08-06 additive field: a bill that ever came back
 *     soleChamber:true would print a nomination's "the House has no vote"
 *     framing over a bill the House votes on, and this is what stops it.
 * ------------------------------------------------------------------ */
test.describe('liveCallTarget', () => {
  const bill = (bill_type: string, status: BillStatus, last_action_text: string | null) => ({
    bill_type,
    status,
    last_action_text,
  });

  test('floor calendar placement routes to that chamber, wherever the bill started', () => {
    expect(
      liveCallTarget(bill('hr', 'floor_vote', 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.'))
    ).toEqual({ chamber: 'senate', afterVote: false, soleChamber: false });
    expect(
      liveCallTarget(bill('hr', 'floor_vote', 'Placed on the Union Calendar, Calendar No. 219.'))
    ).toEqual({ chamber: 'house', afterVote: false, soleChamber: false });
  });

  test('floor activity routes by the record sentence, not the bill type', () => {
    expect(liveCallTarget(bill('hr', 'floor_vote', CLOTURE_TEXT))).toEqual({
      chamber: 'senate',
      afterVote: false,
      soleChamber: false,
    });
  });

  test('an unclassifiable floor text routes NOWHERE — never a guess', () => {
    expect(liveCallTarget(bill('hr', 'floor_vote', 'Considered as unfinished business.'))).toBeNull();
    expect(liveCallTarget(bill('s', 'floor_vote', null))).toBeNull();
  });

  test('passed_chamber: the OTHER chamber is the live call, and the vote already happened', () => {
    expect(liveCallTarget(bill('hr', 'passed_chamber', 'Received in the Senate.'))).toEqual({
      chamber: 'senate',
      afterVote: true,
      soleChamber: false,
    });
    expect(liveCallTarget(bill('sjres', 'passed_chamber', 'Received in the House.'))).toEqual({
      chamber: 'house',
      afterVote: true,
      soleChamber: false,
    });
  });

  test('every other stage renders the list untouched: committee, conference, signed, vetoed, introduced', () => {
    for (const status of ['introduced', 'committee', 'markup', 'conference', 'signed', 'vetoed'] as const) {
      expect(liveCallTarget(bill('hr', status, 'whatever the record says'))).toBeNull();
    }
  });

  /*
   * The sweep, not just the fixtures: NO bill in the live corpus may ever
   * come back non-relational. The fixtures above pin the shapes we know; this
   * pins the ones tomorrow's sync invents.
   */
  test('no bill in the live corpus routes as soleChamber — the field is nomination-only', () => {
    for (const b of corpus) {
      const target = liveCallTarget({
        bill_type: b.bill_type,
        status: b.status as BillStatus,
        last_action_text: b.last_action_text,
      });
      if (target) expect(target.soleChamber, slugOf(b)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 7 · liveCallTargetForNomination + liveCallKey — the Senate-default
 *     routing (owner ruling 2026-08-06: "nominations should be directed
 *     to senate only … the focus should be on the senator as a default").
 *
 *     The two things this suite exists to stop:
 *       (a) a FINISHED nomination reading as a live Senate call — the
 *           exact failure lib/nomination-status.mjs was split off from the
 *           bill mapper to prevent, re-entering through the routing layer;
 *       (b) a nomination sentence being shown to a reader who has no
 *           senator to call (DC, PR, VI, GU, AS, MP).
 * ------------------------------------------------------------------ */
test.describe('liveCallTargetForNomination', () => {
  const SENATE_CALL = { chamber: 'senate', afterVote: false, soleChamber: true };

  test('every live stage is the Senate, non-relational, and never "after" a vote', () => {
    for (const status of ['received', 'hearing', 'reported', 'exec_calendar', 'floor', 'scheduled'] as const) {
      expect(liveCallTargetForNomination({ status }), status).toEqual(SENATE_CALL);
    }
  });

  test('committee stages route too — unlike a bill, because there is no other chamber to demote', () => {
    // The bill rule (suite 5) returns null at committee stage to avoid
    // demoting the other chamber's offices on a weak claim. A nomination has
    // no other chamber, and `received`/`hearing`/`reported` ARE Senate
    // committee stages, so naming the Senate there is a fact, not a guess.
    expect(liveCallTargetForNomination({ status: 'received' })).toEqual(SENATE_CALL);
    expect(liveCallTarget({ bill_type: 'hr', status: 'committee', last_action_text: null })).toBeNull();
  });

  test('terminal statuses route NOWHERE — a confirmed nomination can never read as live', () => {
    for (const status of ['confirmed', 'returned', 'withdrawn'] as const) {
      expect(liveCallTargetForNomination({ status }), status).toBeNull();
    }
  });

  test('unclassified routes NOWHERE — the record did not say, so nothing is claimed', () => {
    expect(liveCallTargetForNomination({ status: 'unclassified' })).toBeNull();
  });

  /*
   * THE DRIFT PIN. lib/journey.ts enumerates the live statuses by hand
   * (import-free-at-runtime posture) rather than importing the .mjs set. If
   * the Senate's vocabulary grows a tenth member and only one of the two
   * files learns it, this fails — and it fails toward the safe answer being
   * asserted, not assumed: a new status must route nowhere until someone
   * decides it should.
   */
  test('the routing set is exactly NOMINATION_STATUSES minus the terminal ones', () => {
    const routed = NOMINATION_STATUSES.filter(
      (s) => liveCallTargetForNomination({ status: s as NominationStatus }) !== null
    );
    const expected = NOMINATION_STATUSES.filter((s) => !TERMINAL_NOMINATION_STATUSES.has(s));
    expect(routed).toEqual(expected);
  });
});

/* ------------------------------------------------------------------ *
 * 7b · nominationHasCallScript — what a surface may PROMISE, as
 *      opposed to where a call would go.
 *
 *      The defect it was extracted for: /nominations/[slug]'s
 *      generateMetadata returned "…and the call that goes with it"
 *      unconditionally, on 686 of 857 records with no dial, no stance
 *      control and no script. robots noindex does not reach a link
 *      preview or a share card, so that sentence shipped anyway.
 *
 *      It must equal app/api/script's own refusal conjunction, or a
 *      page will promise a script the route refuses.
 * ------------------------------------------------------------------ */
test.describe('nominationHasCallScript', () => {
  const DESCRIBED = 'Jane Doe, of Ohio, to be United States District Judge.';

  test('true only where the route would actually answer with one', () => {
    for (const status of ['received', 'hearing', 'reported', 'exec_calendar', 'floor', 'scheduled'] as const) {
      expect(
        nominationHasCallScript({ status, nominee_description: DESCRIBED }),
        status
      ).toBe(true);
    }
  });

  test('a finished nomination has none — the record, not the rail, decides', () => {
    for (const status of ['confirmed', 'returned', 'withdrawn'] as const) {
      expect(nominationHasCallScript({ status, nominee_description: DESCRIBED }), status).toBe(false);
    }
  });

  test('a record with no description has none, at every live stage', () => {
    for (const status of ['received', 'exec_calendar', 'scheduled'] as const) {
      expect(nominationHasCallScript({ status, nominee_description: null }), status).toBe(false);
    }
  });

  /*
   * THE `unclassified` CASE IS THE WHOLE REASON THIS IS NOT `closed ||
   * noScript`. That record KEEPS its call rail on the page (deliberately — the
   * route's 422 refusal is the honest answer there, and the rail is what keeps
   * the refusal state reachable), so a predicate written off the panel branch
   * would have called it callable and promised a script that never arrives.
   */
  test('unclassified has none even though its page still renders the rail', () => {
    expect(nominationHasCallScript({ status: 'unclassified', nominee_description: DESCRIBED })).toBe(false);
  });

  /* The drift pin, in the same shape suite 7 uses: this must stay the
     conjunction of the routing set and a present description, so a tenth
     status cannot quietly become callable. */
  test('it is exactly liveCallTargetForNomination ∧ a description', () => {
    for (const s of NOMINATION_STATUSES) {
      const status = s as NominationStatus;
      const routed = liveCallTargetForNomination({ status }) !== null;
      expect(nominationHasCallScript({ status, nominee_description: DESCRIBED }), s).toBe(routed);
      expect(nominationHasCallScript({ status, nominee_description: null }), s).toBe(false);
    }
  });
});

test.describe('liveCallKey', () => {
  const withSenator = { hasSenator: true };
  const noSenator = { hasSenator: false };

  test('the four relational bill keys are unchanged by the new field', () => {
    expect(liveCallKey({ chamber: 'senate', afterVote: false, soleChamber: false }, withSenator)).toBe('liveSenateFloor');
    expect(liveCallKey({ chamber: 'house', afterVote: false, soleChamber: false }, withSenator)).toBe('liveHouseFloor');
    expect(liveCallKey({ chamber: 'senate', afterVote: true, soleChamber: false }, withSenator)).toBe('liveSenateAfterHouse');
    expect(liveCallKey({ chamber: 'house', afterVote: true, soleChamber: false }, withSenator)).toBe('liveHouseAfterSenate');
    expect(liveCallKey(null, withSenator)).toBeNull();
  });

  test('a nomination gets its own non-relational key, never one of the four', () => {
    const key = liveCallKey({ chamber: 'senate', afterVote: false, soleChamber: true }, withSenator);
    expect(key).toBe('liveSenateNomination');
    expect(key).not.toBe('liveSenateFloor');
    expect(key).not.toBe('liveSenateAfterHouse');
  });

  /*
   * THE GATE COVERS ALL FIVE KEYS, not just the nomination one.
   *
   * N3 gated only `liveSenateNomination` on `hasSenator`, and the four
   * relational bill keys — which shipped long before it — kept telling a DC
   * reader "your senators are the live call" on every bill page. The two HOUSE
   * keys are gated on the same boolean deliberately: the six jurisdictions with
   * no senator are exactly the six that send a non-voting delegate or resident
   * commissioner (data/legislators.json, 2026-08-06: DC, PR, VI, GU, AS, MP
   * have zero senators and one House-type member each; no state has one), so
   * "your House member is the live call" names an office with no vote on
   * passage. All four sentences are false for that reader, and the boolean that
   * identifies them is the one already here.
   *
   * Enumerated exhaustively rather than sampled: the failure this stops is a
   * branch keeping its key when the gate moves, and a sample cannot see that.
   */
  test('NO routing sentence is offered to a reader with no senator (DC, PR, VI, GU, AS, MP)', () => {
    for (const chamber of ['senate', 'house'] as const) {
      for (const afterVote of [false, true]) {
        for (const soleChamber of [false, true]) {
          expect(
            liveCallKey({ chamber, afterVote, soleChamber }, noSenator),
            `${chamber}/afterVote=${afterVote}/soleChamber=${soleChamber}`
          ).toBeNull();
        }
      }
    }
  });

  test('the same reader WITH a senator still gets every one of them', () => {
    // The other half of the gate: it must key on the reader, never quietly
    // retire a sentence for everybody.
    expect(liveCallKey({ chamber: 'senate', afterVote: false, soleChamber: false }, withSenator)).toBe('liveSenateFloor');
    expect(liveCallKey({ chamber: 'house', afterVote: false, soleChamber: false }, withSenator)).toBe('liveHouseFloor');
    expect(liveCallKey({ chamber: 'senate', afterVote: true, soleChamber: false }, withSenator)).toBe('liveSenateAfterHouse');
    expect(liveCallKey({ chamber: 'house', afterVote: true, soleChamber: false }, withSenator)).toBe('liveHouseAfterSenate');
    expect(liveCallKey({ chamber: 'senate', afterVote: false, soleChamber: true }, withSenator)).toBe('liveSenateNomination');
  });

  /*
   * The keys are message keys, so they have to EXIST — in both locales, or
   * the panel renders a raw key at the highest-intent moment on one of them.
   * check-messages-parity guards en/es against each other; nothing guarded
   * either against this union until here.
   */
  test('every key in the union resolves in both locales', () => {
    const keys: LiveCallKey[] = [
      'liveSenateFloor',
      'liveHouseFloor',
      'liveSenateAfterHouse',
      'liveHouseAfterSenate',
      'liveSenateNomination',
    ];
    for (const k of keys) {
      expect(typeof en.bill[k], `en.bill.${k}`).toBe('string');
      expect(typeof es.bill[k], `es.bill.${k}`).toBe('string');
    }
    // The nomination annex copy the panel renders beside the routing line.
    for (const k of ['nominationHow', 'nominationHousePress'] as const) {
      expect(typeof en.bill[k], `en.bill.${k}`).toBe('string');
      expect(typeof es.bill[k], `es.bill.${k}`).toBe('string');
    }
  });
});
