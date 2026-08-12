import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveJourney,
  floorActionChamber,
  floorCalendarChamber,
  floorPendingChamber,
  floorSettledChamber,
  liveCallKey,
  liveCallTarget,
  liveCallTargetForNomination,
  nominationHasCallScript,
  passageState,
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
// The freshness half of the panel's triad, from the ONE copy — the corpus
// sweep below has to apply the same window the selector does.
import { isSignalFresh, SIGNAL_WINDOW_DAYS } from '../lib/urgency.mjs';
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

/* A genuine, verbatim calendar placement. MODULE scope since N3 (2026-08-11):
   it was local to the deriveJourney suite, and the status-label suite now
   needs the identical sentence — the whole point of both clocks is that they
   read one record the same way, so they must be pinned against one string. */
const CALENDAR_PLACEMENT =
  'Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.';

/*
 * THE CLOCK'S TWO FIXTURE DATES (D3, 2026-08-11). deriveJourney and
 * liveCallTarget now read `last_action_date` as well as the sentence, so every
 * fixture below carries one — and it has to be RELATIVE to the run, never a
 * literal, or the whole suite would quietly invert the day it aged past the
 * window. `FRESH` is inside the 14-day window by a wide margin; `STALE` is a
 * long way outside it, near the corpus's median demoted placement (140 days on
 * the day this landed).
 */
const DAY_MS = 86_400_000;
const dateDaysAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
const FRESH = dateDaysAgo(2);
const STALE = dateDaysAgo(140);

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
 * 2b · floorPendingChamber — "is a floor vote still COMING, and where"
 *      (owner ruling 2026-08-09). The gate the green crown gained so it
 *      could stop running a day or two behind the week's real floor
 *      fights. An ordered ALLOW-LIST with the settled guard first, so
 *      the two failures it must never have are the two pinned hardest:
 *      a dead motion reading as live, and a novel sentence walking
 *      straight into the full-bleed panel.
 * ------------------------------------------------------------------ */
test.describe('floorPendingChamber', () => {
  test('all four live shapes, with and without the Congressional-Record suffix', () => {
    // Rule 1 — cloture presented. Both live variants: one bare, one with the
    // "(CR SN)" tail that would defeat any `$`-anchored pattern.
    expect(floorPendingChamber('Cloture motion on the motion to proceed to the measure presented in Senate.')).toBe('senate');
    expect(floorPendingChamber(CLOTURE_TEXT)).toBe('senate');
    expect(floorPendingChamber('Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4449)')).toBe('senate');
    // Rule 2 — a motion to proceed MADE (not rejected).
    expect(floorPendingChamber('Motion to proceed to consideration of measure made in Senate. (CR S4276)')).toBe('senate');
    // Rule 3 — House rule XIX: the vote was deferred, not decided.
    expect(floorPendingChamber('POSTPONED PROCEEDINGS - Pursuant to clause 1(c) of rule XIX, the Chair announced further proceedings on H.R. 8872 is postponed.')).toBe('house');
    // Rule 4 — a rule reported sets the terms of a debate not yet held.
    expect(floorPendingChamber('Rules Committee Resolution H. Res. 916 Reported to House. Rule provides for consideration of H.R. 4312, H.R. 1005, H.R. 1049, H.R. 1069, H.R. 2965 and H.R. 4305. The resolution provides for consideration of H.R. 4312, H.R. 1005, H.R. 1049, H.R. 1069, H.R. 2965, and H.R. 4305 under a closed rule with one hour of general debate and one motion to recommit on each bill.')).toBe('house');
  });

  test('THE SETTLED GUARD: a vote that already failed is never pending', () => {
    // Every one of these is a real corpus sentence, and every one of them
    // would be a lie under a green "a floor vote is pending" chip.
    expect(floorPendingChamber('Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 47 - 45. Record Vote Number: 12. (CR S286)')).toBeNull();
    expect(floorPendingChamber('Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 111. (CR S2106)')).toBeNull();
    expect(floorPendingChamber('Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 46 - 48. Record Vote Number: 173. (consideration: CR S2816)')).toBeNull();
    expect(floorPendingChamber('Motion to proceed to consideration of the House message to accompany S. 1318 rejected in Senate by Yea-Nay Vote. 47 - 52. Record Vote Number: 164.')).toBeNull();
    expect(floorPendingChamber('Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 48. Record Vote Number: 174.')).toBeNull();
    // The guard's other three words, on invented texts — the corpus holds no
    // instance yet, and the rule must be pinned before one arrives.
    expect(floorPendingChamber('Cloture motion on the motion to proceed to the measure presented in Senate, then withdrawn.')).toBeNull();
    expect(floorPendingChamber('Motion to proceed to consideration of measure made in Senate; motion failed.')).toBeNull();
    expect(floorPendingChamber('Measure indefinitely postponed by Unanimous Consent in Senate.')).toBeNull();
  });

  test('THE SCHUMER MOTION is fail-closed on purpose (owner decision D4)', () => {
    // A genuinely live motion to reconsider — but its sentence is ABOUT a
    // cloture vote that was not invoked, and no reader could tell from it
    // that anything is still ahead. Rule 0 catches it on "not invoked", and
    // that is the ruling: one missed crown is cheaper than one wrong one.
    expect(floorPendingChamber('Motion by Senator Schumer to reconsider, under the order of 10/9/2025, not having voted on the prevailing side, the vote by which the third cloture motion on the motion to proceed to S. 2882 was not invoked (Record Vote No. 557) entered in Senate.')).toBeNull();
  });

  test('FAIL-CLOSED on everything else — a deny-list would admit these', () => {
    expect(floorPendingChamber(null)).toBeNull();
    expect(floorPendingChamber('')).toBeNull();
    expect(floorPendingChamber('Considered as unfinished business.')).toBeNull();
    expect(floorPendingChamber('Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.')).toBeNull();
    // Cloture ALONE is not enough: the allow-list wants the presented form.
    expect(floorPendingChamber('Cloture invoked in Senate by Yea-Nay Vote. 60 - 40.')).toBeNull();
    // A shape nobody has seen. The whole design decision in one assertion.
    expect(floorPendingChamber('Senate began consideration of the measure under a time agreement.')).toBeNull();
  });

  /*
   * CORPUS-WIDE PIN. floorPendingChamber is a narrower reading of the same
   * sentences floorActionChamber already parses, so wherever it speaks it
   * must agree with the chamber that function reads — a pending claim
   * pointed at the wrong chamber would put the crown's call in the wrong
   * building. Runs over the live corpus so a nightly sync cannot break the
   * agreement silently.
   */
  test('over the live corpus it is either silent or agrees with floorActionChamber', () => {
    for (const b of floorVote) {
      const pending = floorPendingChamber(b.last_action_text);
      if (pending !== null) {
        expect(pending, slugOf(b)).toBe(floorActionChamber(b.last_action_text));
      }
    }
  });

  /*
   * MUTUAL EXCLUSIVITY. The crown prints ONE chip, and `kind` picks which
   * sentence it says. If a text could satisfy both gates the label would be
   * decided by the order of two `if`s rather than by the record.
   */
  test('no corpus text satisfies both the calendar gate and the pending gate', () => {
    for (const b of corpus) {
      if (floorCalendarChamber(b.last_action_text) !== null) {
        expect(floorPendingChamber(b.last_action_text), slugOf(b)).toBeNull();
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2b · floorSettledChamber — the other half of the pending split
 *      (2026-08-09 floor-truth fix). Where floorPendingChamber says a
 *      vote is still ahead, this says the chamber already answered and
 *      the answer was no.
 * ------------------------------------------------------------------ */
// S.J.Res. 172's exact live sentence — a vehicle of the live iran-war-powers
// Big Question, whose page printed "the Senate is deciding whether to bring it
// to a vote" three lines above this record refuting it.
const DISCHARGE_REJECTED_TEXT =
  'Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 48. Record Vote Number: 174.';
// S.J.Res. 103's exact live sentence — the strongest live-call sentence on the
// site used to print over this.
const MOTION_REJECTED_TEXT =
  'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 48 - 50. Record Vote Number: 72.';

test.describe('floorSettledChamber', () => {
  test('the corpus texts that report a dead motion, with the chamber the record names', () => {
    expect(floorSettledChamber(DISCHARGE_REJECTED_TEXT)).toBe('senate');
    expect(floorSettledChamber(MOTION_REJECTED_TEXT)).toBe('senate');
    expect(
      floorSettledChamber(
        'Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 47 - 45. Record Vote Number: 301.'
      )
    ).toBe('senate');
  });

  test('a live text is never called settled', () => {
    expect(floorSettledChamber(CLOTURE_TEXT)).toBeNull();
    expect(floorSettledChamber('Motion to proceed to consideration of measure made in Senate. (CR S4276)')).toBeNull();
    expect(floorSettledChamber(null)).toBeNull();
  });

  /*
   * THE GATE IS THE VOCABULARY, NOT THE CHAMBER — the distinction that keeps
   * this function from repeating floorActionChamber's mistake in reverse.
   * "Considered by Senate" has a perfectly readable chamber and says nothing
   * about anything dying, so it must NOT be called a failed motion.
   */
  test('a readable chamber alone never earns the settled claim', () => {
    expect(floorActionChamber('Considered by Senate.')).toBe('senate');
    expect(floorSettledChamber('Considered by Senate.')).toBeNull();
  });

  /*
   * TOTALITY AND EXCLUSIVITY, over the live corpus. The whole point of
   * splitting one matcher into two is that every floor text lands on exactly
   * one side — a text that is neither pending nor settled is the silent gap
   * the old code fell into. FLOOR_SETTLED being shared between the two
   * functions is what makes this hold; these assertions are what prove it did
   * not get copy-pasted apart again.
   */
  test('no corpus text is both pending and settled, or both settled and on a calendar', () => {
    for (const b of corpus) {
      const settled = floorSettledChamber(b.last_action_text);
      if (settled !== null) {
        expect(floorPendingChamber(b.last_action_text), slugOf(b)).toBeNull();
        expect(floorCalendarChamber(b.last_action_text), slugOf(b)).toBeNull();
      }
    }
  });

  /*
   * TOTALITY — "every classifiable floor text is pending or settled" — is
   * deliberately NOT asserted here. It is a claim about DATA, and the owner
   * ruling of 2026-08-04 (see suite 4's note) moved data sweeps to the
   * nightly sync so a novel action text landed by a sync cannot redden the CI
   * of unrelated PRs. It lives in scripts/check-journey-corpus.mjs, beside the
   * classifiability sweep it extends. The exclusivity assertions above stay,
   * because those are claims about CODE: they hold whatever the sync lands.
   */
});

/* ------------------------------------------------------------------ *
 * 2c · passageState — which passage a `passed_chamber` record reports
 *      (2026-08-09 floor-truth fix). The bill TYPE used to answer this,
 *      which is a fact about where a bill started, not where it stands.
 * ------------------------------------------------------------------ */
test.describe('passageState', () => {
  const p = (bill_type: string, last_action_text: string | null) =>
    passageState({ bill_type, last_action_text } as Parameters<typeof passageState>[0]);

  /*
   * THE FLAGSHIP. H.R. 1276's own last action on 2026-08-07 says the SECOND
   * chamber passed it without changes — both chambers are done — and the page
   * printed "the Senate decides next. Your senators are the live call."
   */
  test('a House bill the Senate passed without amendment has no next chamber', () => {
    expect(p('hr', 'Passed Senate without amendment by Unanimous Consent.')).toEqual({
      stage: 'both',
      passedBy: 'senate',
      next: null,
    });
  });

  /*
   * THE CASE THAT WAS EXACTLY BACKWARDS, not merely stale: the Senate amended
   * it, so the HOUSE holds the next decision, and the old code named the
   * Senate. H.R. 6500's and H.R. 5334's exact shape.
   */
  test('an amended second-chamber passage routes BACK to the originating chamber', () => {
    expect(
      p('hr', 'Passed Senate with an amendment and an amendment to the Title by Yea-Nay Vote. 90 - 6. Record Vote Number: 228.')
    ).toEqual({ stage: 'back', passedBy: 'senate', next: 'house' });
    // The mirror direction, which the corpus does not currently hold.
    expect(p('s', 'Passed House with an amendment by Voice Vote.')).toEqual({
      stage: 'back',
      passedBy: 'house',
      next: 'senate',
    });
  });

  /*
   * THE ORDINARY CASE, AND THE REGRESSION GUARD ON 268 RECORDS. An amendment
   * clause on the ORIGINATING chamber's own passage is just its own floor
   * amendment and must not trigger the return-trip reading.
   */
  test('origin-chamber passage keeps the other chamber as next, amended or not', () => {
    expect(p('s', 'Passed Senate without amendment by Voice Vote.')).toEqual({
      stage: 'first',
      passedBy: 'senate',
      next: 'house',
    });
    expect(p('s', 'Passed Senate with an amendment by Unanimous Consent. (text: CR S4493-4494)')).toEqual({
      stage: 'first',
      passedBy: 'senate',
      next: 'house',
    });
    expect(p('hr', 'Received in the Senate.')).toMatchObject({ stage: 'first', next: 'senate' });
    expect(p('s', 'Held at the desk.')).toMatchObject({ stage: 'first', next: 'house' });
    expect(p('hr', null)).toMatchObject({ stage: 'first', next: 'senate' });
  });

  /*
   * ANCHORED. "Rule H. Res. 988 passed House." (h.r. 4366's live text) reports
   * a RULE resolution's passage, not this bill's — an unanchored match would
   * read it as a second-chamber event on a House bill and invert the routing.
   */
  test('a passage sentence about something else is not read as this bill passing', () => {
    expect(p('hr', 'Rule H. Res. 988 passed House.')).toMatchObject({
      stage: 'first',
      passedBy: null,
      next: 'senate',
    });
  });

  /*
   * FAIL-CLOSED on the sentence Congress has not written yet: both chambers
   * have acted, the amendment clause is unreadable, so we name no next step
   * rather than guessing between the President and a trip back.
   */
  test('an unreadable second-chamber passage claims no next chamber', () => {
    expect(p('hr', 'Passed Senate by Unanimous Consent.')).toEqual({
      stage: 'second',
      passedBy: 'senate',
      next: null,
    });
  });

  /*
   * CORPUS SWEEP, narrow and cheap: whatever else moves nightly, a record
   * whose text reports the SECOND chamber passing must never route to that
   * same chamber. That is the precise shape of the shipped bug.
   */
  test('no corpus record routes the live call to the chamber that just passed it', () => {
    for (const b of corpus.filter((x) => x.status === 'passed_chamber')) {
      const state = passageState(b as Parameters<typeof passageState>[0]);
      if (state.passedBy && state.next) {
        expect(state.next, slugOf(b)).not.toBe(state.passedBy);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3 · deriveJourney — the full status behavior table.
 * ------------------------------------------------------------------ */
test.describe('deriveJourney', () => {
  /* `last_action_date` defaults to FRESH: every fixture written before the
     clock landed was implicitly asking "what does the record say about a bill
     that is moving", and answering it with an undated record would have made
     the whole suite assert the stale branch. The stale cases pass STALE
     explicitly, right where they are read. */
  const j = (
    bill_type: string,
    status: string,
    last_action_text: string | null = null,
    last_action_date: string | null = FRESH
  ) =>
    deriveJourney({ bill_type, status, last_action_text, last_action_date } as Parameters<
      typeof deriveJourney
    >[0]);

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

  /*
   * FINDING 3 (2026-08-09). Every chamber-classifiable non-calendar floor text
   * used to get "the {chamber} is deciding whether to bring it to a vote",
   * including the 18 whose own words say the motion FAILED. S.J.Res. 172 is a
   * vehicle of the live iran-war-powers Big Question, so this sentence sat on
   * a surfaced page directly above the record refuting it.
   */
  test('a failed motion never reads as a live deliberation', () => {
    const journey = j('sjres', 'floor_vote', DISCHARGE_REJECTED_TEXT);
    expect(journey).toMatchObject({
      nowKey: 'nowFloorMotionFailed',
      nowChamber: 'senate',
      onCalendar: false,
    });
    expect(journey.nowKey).not.toBe('nowFloorActivity');
    // S.J.Res. 103's shape, the same verdict.
    expect(j('sjres', 'floor_vote', MOTION_REJECTED_TEXT).nowKey).toBe('nowFloorMotionFailed');
  });

  test('a genuinely pending floor vote keeps the live deliberation copy', () => {
    expect(j('hr', 'floor_vote', CLOTURE_TEXT).nowKey).toBe('nowFloorActivity');
    expect(
      j('s', 'floor_vote', 'Motion to proceed to consideration of measure made in Senate. (CR S4276)').nowKey
    ).toBe('nowFloorActivity');
  });

  /* ---------------------------------------------------------------- *
   * D3 (2026-08-11) — THE CLOCK. #198 gave the bill page's green panel
   * the freshness window and stopped at that one render site; the
   * derivation underneath kept answering "it's on the Senate floor
   * calendar" for placements of unlimited age. 305 of the corpus's 322
   * dated placements are outside the window (re-measured 2026-08-12),
   * median 140 days.
   *
   * The fixture sentence itself lives at module scope (see CALENDAR_PLACEMENT
   * near the top) — suite 6's status-label clock is pinned against the very
   * same string, which is the only way to prove the two clocks read one
   * record identically.
   * ---------------------------------------------------------------- */

  test('THE D3 FLAGSHIP: an aged placement keeps its step and its chamber, and loses the present tense', () => {
    const stale = j('hr', 'floor_vote', CALENDAR_PLACEMENT, STALE);
    expect(stale).toMatchObject({
      // The POSITION is a fact about the record and does not move…
      step: 3,
      current: 'senate',
      nowChamber: 'senate',
      // …only the tense and the urgency permission do.
      onCalendar: false,
      nowKey: 'nowFloorStale',
    });
    // The same record, two days old, is untouched — the gate is age, not text.
    expect(j('hr', 'floor_vote', CALENDAR_PLACEMENT, FRESH)).toMatchObject({
      step: 3,
      current: 'senate',
      onCalendar: true,
      nowKey: 'nowFloor',
    });
  });

  test('an aged pending motion stops reading as a live deliberation', () => {
    expect(j('hr', 'floor_vote', CLOTURE_TEXT, STALE)).toMatchObject({
      step: 3,
      current: 'senate',
      nowChamber: 'senate',
      nowKey: 'nowFloorActivityStale',
    });
  });

  test('the window is the ONE window — SIGNAL_WINDOW_DAYS, not a second number', () => {
    /*
     * Read through the same constant the green panel and the homepage crown
     * gate on: a literal 14 here would be a second definition of "now".
     *
     * ONE DAY EITHER SIDE, never the edge itself. Corpus dates are date-only
     * (midnight UTC) while isSignalFresh measures in milliseconds, so a
     * placement dated exactly SIGNAL_WINDOW_DAYS ago is inside the window only
     * at exactly 00:00 UTC and outside it for the rest of the day — asserting
     * that instant would be a clock-dependent coin flip, which is the flake
     * class tests/corpus.ts's stability guard exists for.
     */
    expect(j('s', 'floor_vote', CALENDAR_PLACEMENT, dateDaysAgo(SIGNAL_WINDOW_DAYS - 1)).nowKey).toBe(
      'nowFloor'
    );
    expect(j('s', 'floor_vote', CALENDAR_PLACEMENT, dateDaysAgo(SIGNAL_WINDOW_DAYS + 1)).nowKey).toBe(
      'nowFloorStale'
    );
  });

  test('an undated floor record is never live — the same rule amber has always run on', () => {
    expect(j('s', 'floor_vote', CALENDAR_PLACEMENT, null).nowKey).toBe('nowFloorStale');
  });

  test('a settled motion is unaffected by the clock — it was already past tense', () => {
    // FLOOR_SETTLED texts read "the last motion to do so failed", which is
    // true at any age. Clocking them would say the same thing twice.
    expect(j('sjres', 'floor_vote', DISCHARGE_REJECTED_TEXT, STALE).nowKey).toBe('nowFloorMotionFailed');
    expect(j('sjres', 'floor_vote', MOTION_REJECTED_TEXT, STALE).nowKey).toBe('nowFloorMotionFailed');
  });

  test('nothing outside the floor and passage branches is clocked', () => {
    // A committee referral and an enacted law carry no present-tense claim
    // that ages: "a committee is reviewing it" is what the record says at any
    // date, and a law does not stop being one. The passage branch DID gain a
    // clock (N5, 2026-08-12) and is pinned in its own block below.
    expect(j('hr', 'committee', 'Referred to the Subcommittee on Health.', STALE).nowKey).toBe(
      'nowCommittee'
    );
    expect(j('hr', 'signed', 'Became Public Law No: 119-1.', STALE).nowKey).toBe('nowSigned');
    expect(j('hr', 'conference', 'Conference held.', STALE).nowKey).toBe('nowConference');
  });

  /*
   * FINDING 1 (2026-08-09), stepper half. The rail and the stepper read the
   * same record, and both were telling the same untruth about it.
   */
  test('a bill both chambers have passed goes to the desk, not back across the Capitol', () => {
    const journey = j('hr', 'passed_chamber', 'Passed Senate without amendment by Unanimous Consent.');
    expect(journey).toMatchObject({
      step: 4,
      nowKey: 'nowPassedBoth',
      showTrailer: false,
    });
    expect(journey.nowKey).not.toBe('nowPassed');
  });

  /* ---------------------------------------------------------------- *
   * N5 (2026-08-12) — THE CLOCK REACHES THE PASSAGE SENTENCE.
   *
   * #208 clocked the floor branch and deliberately left `passed_chamber`
   * alone, because a passage is a durable fact and the ROUTING TARGET
   * stays right at any age. Its own follow-up note named what that
   * missed: the stepper's sentence does not name a target, it narrates a
   * handoff — "it passed the House and now goes to the Senate" — and on
   * 2026-08-12 that "now" was printed over 280 of the corpus's 295
   * passage records, median 120 days old, oldest hr-30-119 at 573.
   *
   * The split this block pins: the stepper's TENSE moves, the rail's
   * TARGET does not. liveCallTarget's half is pinned explicitly in
   * suite 5 ('passed_chamber routing is STILL not clocked').
   * ---------------------------------------------------------------- */

  const RECEIVED_IN_SENATE = 'Received in the Senate and Read twice and referred to the Committee on Finance.';

  test('THE N5 FLAGSHIP: an aged passage keeps the passage, the step and the chambers, and loses the handoff', () => {
    const stale = j('hr', 'passed_chamber', RECEIVED_IN_SENATE, STALE);
    expect(stale).toMatchObject({
      // Where the record puts the bill does NOT move — a quiet fortnight does
      // not carry it back across the Capitol.
      step: 3,
      origin: 'house',
      current: 'senate',
      nowChamber: 'house',
      // The conditional Article I trailer is not a tense claim, so it stays.
      showTrailer: true,
      // Only the sentence changes.
      nowKey: 'nowPassedStale',
    });
    // The same record, two days old, is untouched — the gate is age, not text.
    expect(j('hr', 'passed_chamber', RECEIVED_IN_SENATE, FRESH)).toMatchObject({
      step: 3,
      current: 'senate',
      nowChamber: 'house',
      showTrailer: true,
      nowKey: 'nowPassed',
    });
  });

  test('an aged amended passage stops narrating the trip back', () => {
    const AMENDED = 'Passed Senate with an amendment and an amendment to the Title by Yea-Nay Vote. 86 - 11. Record Vote Number: 224.';
    expect(j('hr', 'passed_chamber', AMENDED, STALE)).toMatchObject({
      step: 3,
      current: 'house',
      nowChamber: 'house',
      showTrailer: false,
      nowKey: 'nowPassedBackStale',
    });
    expect(j('hr', 'passed_chamber', AMENDED, FRESH).nowKey).toBe('nowPassedBack');
  });

  test('the passage clock is the ONE window — SIGNAL_WINDOW_DAYS, not a second number', () => {
    /*
     * ONE DAY EITHER SIDE, NEVER THE EDGE — the same idiom and the same reason
     * as the floor-branch boundary test above: corpus dates are date-only
     * (midnight UTC) while isSignalFresh measures milliseconds, so a passage
     * dated exactly SIGNAL_WINDOW_DAYS ago is inside the window only at 00:00
     * UTC and outside it the rest of the day. Asserting that instant would be
     * a clock-dependent coin flip.
     */
    expect(
      j('hr', 'passed_chamber', RECEIVED_IN_SENATE, dateDaysAgo(SIGNAL_WINDOW_DAYS - 1)).nowKey
    ).toBe('nowPassed');
    expect(
      j('hr', 'passed_chamber', RECEIVED_IN_SENATE, dateDaysAgo(SIGNAL_WINDOW_DAYS + 1)).nowKey
    ).toBe('nowPassedStale');
  });

  test('an undated passage fails closed to the weaker claim', () => {
    // isSignalFresh's own rule, and the rule amber has always run on. 0 of the
    // corpus's 295 passage records are undated (2026-08-12), so this is the
    // shape we refuse to be surprised by rather than one we render today.
    expect(j('hr', 'passed_chamber', RECEIVED_IN_SENATE, null).nowKey).toBe('nowPassedStale');
    expect(j('hr', 'passed_chamber', RECEIVED_IN_SENATE, 'not-a-date').nowKey).toBe('nowPassedStale');
  });

  test('the two passage states that name NO next chamber are not clocked', () => {
    // 'both' says what Article I, Section 7 requires — presentment — and names
    // no chamber as deciding; 'second' claims only that the record has not
    // said. Neither has a tense that can go stale, so neither gains a key.
    expect(j('hr', 'passed_chamber', 'Passed Senate without amendment by Unanimous Consent.', STALE).nowKey).toBe(
      'nowPassedBoth'
    );
    expect(j('hr', 'passed_chamber', 'Passed Senate by Voice Vote.', STALE).nowKey).toBe(
      'nowPassedSecond'
    );
  });

  test('an amended second-chamber passage sends it back to the originating chamber', () => {
    expect(
      j('hr', 'passed_chamber', 'Passed Senate with an amendment and an amendment to the Title by Yea-Nay Vote. 86 - 11. Record Vote Number: 224.')
    ).toMatchObject({
      step: 3,
      current: 'house',
      // The DESTINATION, not the chamber that just acted — see deriveJourney's
      // comment on this branch, and the rendered-sentence pins below.
      nowChamber: 'house',
      nowKey: 'nowPassedBack',
      showTrailer: false,
    });
  });

  /* ---------------------------------------------------------------- *
   * THE RENDERED SENTENCE, not just the state behind it.
   *
   * Every assertion above checks a JourneyState. None of them can see the
   * defect this block exists for: nowPassedBack's first draft read "the
   * {chamber} passed it with changes, so it goes back to the {other}", which
   * renders as "the Senate passed it with changes, so it goes back to the
   * Senate." The state was correct; the template read the wrong variable.
   * BillJourney feeds ICU `{ chamber: nowChamber, other }` where `other` is
   * the opposite of ORIGIN — never of nowChamber — and that asymmetry is
   * invisible from the state object alone.
   * ---------------------------------------------------------------- */

  /** Mirror of components/BillJourney.tsx lines 42-47 + 107 — the exact
   *  parameters the stepper hands the catalog. Drift here is the bug. */
  const icuParams = (state: ReturnType<typeof deriveJourney>) => ({
    chamber: state.nowChamber === 'house' ? 'House' : 'Senate',
    other: state.origin === 'house' ? 'Senate' : 'House',
  });

  /** A minimal ICU `select` resolver: enough for this catalog's
   *  `{name, select, House {…} Senate {…} other {…}}` shape and nothing more.
   *  A few lines beats leaning on next-intl's formatter (a transitive dep),
   *  and re-testing ICU is not the point — rendering the REAL catalog strings
   *  with the REAL parameters is. */
  const render = (template: string, params: Record<string, string>): string => {
    let out = '';
    for (let i = 0; i < template.length; ) {
      if (template[i] !== '{') {
        out += template[i++];
        continue;
      }
      let depth = 0;
      let j = i;
      for (; j < template.length; j++) {
        if (template[j] === '{') depth++;
        else if (template[j] === '}' && --depth === 0) break;
      }
      const [name, , ...rest] = template.slice(i + 1, j).split(',');
      const arms: Record<string, string> = {};
      for (const m of rest.join(',').matchAll(/(\w+)\s*\{([^{}]*)\}/g)) arms[m[1]] = m[2];
      out += arms[params[name.trim()]] ?? arms.other ?? '';
      i = j + 1;
    }
    return out;
  };

  const sentence = (
    catalog: typeof en | typeof es,
    bill_type: string,
    status: string,
    text: string | null,
    date: string | null = FRESH
  ) => {
    const state = j(bill_type, status, text, date);
    const journey = catalog.bill.journey as Record<string, string>;
    return render(journey[state.nowKey], icuParams(state));
  };

  test('the resolver itself agrees with a sentence the catalog already shipped', () => {
    // nowPassed is untouched by this change, so it is the control: if the
    // resolver were wrong, this would be wrong too.
    expect(sentence(en, 's', 'passed_chamber', 'Received in the House.')).toBe(
      'it passed the Senate and now goes to the House.'
    );
  });

  test('an amended passage names the amending chamber and the destination — never the same one twice', () => {
    expect(
      sentence(en, 'hr', 'passed_chamber', 'Passed Senate with an amendment by Voice Vote.')
    ).toBe('the Senate passed it with changes, so it goes back to the House.');
    // The mirror direction, so a fix that merely hardcodes the common case fails.
    expect(
      sentence(en, 's', 'passed_chamber', 'Passed House with an amendment by Voice Vote.')
    ).toBe('the House passed it with changes, so it goes back to the Senate.');
    // …and in Spanish, where the same defect would ship silently.
    expect(
      sentence(es, 'hr', 'passed_chamber', 'Passed Senate with an amendment by Voice Vote.')
    ).toBe('el Senado lo aprobó con cambios, así que regresa a la Cámara.');
  });

  test('a bill past both chambers points at the desk in both languages, naming no chamber as next', () => {
    const text = 'Passed Senate without amendment by Unanimous Consent.';
    expect(sentence(en, 'hr', 'passed_chamber', text)).toBe(
      'both chambers have passed it. It goes to the President next.'
    );
    expect(sentence(es, 'hr', 'passed_chamber', text)).toBe(
      'ambas cámaras lo han aprobado. Ahora pasa al Presidente.'
    );
  });

  test('a failed motion reads as failed, in both languages, with the chamber the record named', () => {
    expect(sentence(en, 'sjres', 'floor_vote', DISCHARGE_REJECTED_TEXT)).toBe(
      'the Senate has not agreed to take it up — the last motion to do so failed.'
    );
    expect(sentence(es, 'sjres', 'floor_vote', DISCHARGE_REJECTED_TEXT)).toBe(
      'el Senado no ha aceptado considerarlo — la última moción para hacerlo fracasó.'
    );
  });

  /*
   * THE TWO NEW SENTENCES, rendered — 311 bills read one of these on
   * 2026-08-12, so a template that names the wrong chamber or reads as a
   * present-tense claim would be the defect this change exists to end,
   * shipped in its own fix. Both languages: the ES pair is an unreviewed
   * draft, and a draft that renders wrong is worse than one that reads oddly.
   */
  test('an aged placement still names the calendar and the chamber, in the past tense, in both languages', () => {
    expect(sentence(en, 'hr', 'floor_vote', CALENDAR_PLACEMENT, STALE)).toBe(
      'it was placed on the Senate floor calendar, and the official record shows no floor action on it since.'
    );
    expect(sentence(es, 'hr', 'floor_vote', CALENDAR_PLACEMENT, STALE)).toBe(
      'se incluyó en el calendario del pleno del Senado, y el registro oficial no muestra ninguna acción en el pleno desde entonces.'
    );
    // The House side, so a template that hardcodes one chamber fails.
    expect(sentence(en, 'hr', 'floor_vote', 'Placed on the Union Calendar, Calendar No. 219.', STALE)).toBe(
      'it was placed on the House floor calendar, and the official record shows no floor action on it since.'
    );
  });

  test('an aged pending motion says the chamber acted, never that it is acting', () => {
    expect(sentence(en, 'hr', 'floor_vote', CLOTURE_TEXT, STALE)).toBe(
      'the Senate has taken floor action on it, and the official record shows nothing new since.'
    );
    expect(sentence(es, 'hr', 'floor_vote', CLOTURE_TEXT, STALE)).toBe(
      'el Senado ha actuado en el pleno, y el registro oficial no muestra nada nuevo desde entonces.'
    );
  });

  /*
   * THE TWO N5 SENTENCES, rendered — 280 bills read one of these on
   * 2026-08-12. The state assertions above cannot see the failure mode that
   * matters here: a template that keeps a "now goes to" clause, or names the
   * wrong chamber through the icuParams asymmetry (`other` is the opposite of
   * ORIGIN, never of nowChamber — the defect nowPassedBack shipped with in
   * draft). Both languages: the ES pair is an unreviewed draft, and a draft
   * that renders wrong is worse than one that reads oddly.
   */
  test('an aged passage still says which chamber passed it, and claims nothing about this week', () => {
    expect(sentence(en, 'hr', 'passed_chamber', RECEIVED_IN_SENATE, STALE)).toBe(
      'it passed the House, and the official record shows nothing new since.'
    );
    expect(sentence(es, 'hr', 'passed_chamber', RECEIVED_IN_SENATE, STALE)).toBe(
      'fue aprobado por la Cámara, y el registro oficial no muestra nada nuevo desde entonces.'
    );
    // The mirror direction, so a template that hardcodes one chamber fails.
    expect(sentence(en, 's', 'passed_chamber', 'Received in the House.', STALE)).toBe(
      'it passed the Senate, and the official record shows nothing new since.'
    );
    expect(sentence(es, 's', 'passed_chamber', 'Received in the House.', STALE)).toBe(
      'fue aprobado por el Senado, y el registro oficial no muestra nada nuevo desde entonces.'
    );
    // …and the SAME records inside the window keep every word of the live copy.
    expect(sentence(en, 's', 'passed_chamber', 'Received in the House.', FRESH)).toBe(
      'it passed the Senate and now goes to the House.'
    );
    expect(sentence(es, 's', 'passed_chamber', 'Received in the House.', FRESH)).toBe(
      'fue aprobado por el Senado y ahora pasa a la Cámara.'
    );
  });

  test('an aged amended passage names the amending chamber and no destination, in both languages', () => {
    const AMENDED = 'Passed Senate with an amendment by Voice Vote.';
    expect(sentence(en, 'hr', 'passed_chamber', AMENDED, STALE)).toBe(
      'the Senate passed it with changes, and the official record shows nothing new since.'
    );
    expect(sentence(es, 'hr', 'passed_chamber', AMENDED, STALE)).toBe(
      'el Senado lo aprobó con cambios, y el registro oficial no muestra nada nuevo desde entonces.'
    );
    // Mirror direction: a House amendment to a Senate bill.
    expect(sentence(en, 's', 'passed_chamber', 'Passed House with an amendment by Voice Vote.', STALE)).toBe(
      'the House passed it with changes, and the official record shows nothing new since.'
    );
    // Fresh keeps the destination clause — the gate is age, not text.
    expect(sentence(en, 'hr', 'passed_chamber', AMENDED, FRESH)).toBe(
      'the Senate passed it with changes, so it goes back to the House.'
    );
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
 * 5 · HOMEPAGE GATE — the green panel's claim ("this bill is on the
 *     floor calendar, or a floor vote on it is pending" — home.weekNote's
 *     own words since the 2026-08-09 ruling) must be TRUE, and the crown
 *     must sit on the NEWEST such fact rather than the highest frozen
 *     score.
 * ------------------------------------------------------------------ */
const DAY = 86_400_000;
const dayOffset = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

/** A candidate in the shape selectFloorVoteFeature reads. `urgency_score` is
 *  present on every one deliberately: it is the STORED field the ranking used
 *  to trust, and these fixtures set it to disagree with the read-time score so
 *  a reintroduction of that read fails here. */
const candidate = (
  last_action_date: string,
  last_action_text: string,
  urgency_score = 0.5
) => ({ status: 'floor_vote' as const, urgency_score, last_action_date, last_action_text });

const CALENDAR_TEXT = 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.';
const CLOTURE_NOT_INVOKED =
  'Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 47 - 45. Record Vote Number: 12. (CR S286)';

test.describe('selectFloorVoteFeature floor gate', () => {
  /*
   * THE REGRESSION FIXTURE. Before the 2026-08-09 change this returned the
   * DAY-OLD calendar placement, because the newest bill's placement sentence
   * had already been overwritten by the cloture motion that is the actual
   * news — the crown structurally lagged the floor by a day or two. It must
   * now return the cloture-filed bill, labeled `pending`.
   */
  test('THE FLAGSHIP: a cloture motion filed TODAY outranks yesterday\'s calendar placement', () => {
    const clotureFiled = candidate(dayOffset(0), CLOTURE_TEXT, 0.1);
    const clotureDead = candidate(dayOffset(0), CLOTURE_NOT_INVOKED, 1);
    const calendared = candidate(dayOffset(1), CALENDAR_TEXT, 1);
    const pick = selectFloorVoteFeature([clotureFiled, clotureDead, calendared]);
    expect(pick).not.toBeNull();
    expect(pick?.bill).toBe(clotureFiled);
    expect(pick?.kind).toBe('pending');
    expect(pick?.chamber).toBe('senate');
  });

  /*
   * THE HONESTY GUARD — never relax this one. A cloture motion that was NOT
   * INVOKED is a vote that already failed; crowning it would put the loudest
   * surface on the site behind a false claim of live urgency.
   */
  test('a settled floor vote is never crowned, even alone and even today', () => {
    expect(selectFloorVoteFeature([candidate(dayOffset(0), CLOTURE_NOT_INVOKED, 1)])).toBeNull();
    expect(
      selectFloorVoteFeature([
        candidate(dayOffset(0), 'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 111. (CR S2106)'),
      ])
    ).toBeNull();
  });

  /*
   * PIN MOVED 2026-08-12, deliberately. This test used to assert the reverse —
   * "an exact-date tie goes to the calendar placement, the plainer claim" —
   * and the docket ladder reverses it: the RUNG decides before the date does,
   * everywhere, and a pending floor motion (T1) outranks a placement (T2).
   *
   * The reason is measured rather than aesthetic. A placement is a queue
   * position, and the corpus's own median wait from placement to a vote is 22
   * days; a cloture motion or a motion to proceed is a chamber acting this
   * week. The crown must track the week, and this is the tiebreak where the two
   * readings disagree.
   */
  test('the RUNG beats the date: a pending motion outranks a same-day placement', () => {
    const today = dayOffset(0);
    const pending = candidate(today, CLOTURE_TEXT, 0.1);
    const calendared = candidate(today, CALENDAR_TEXT, 1);
    // Both orders, because a tie-break that only works one way is input order
    // wearing a comment.
    expect(selectFloorVoteFeature([pending, calendared])?.bill).toBe(pending);
    expect(selectFloorVoteFeature([calendared, pending])?.bill).toBe(pending);
    expect(selectFloorVoteFeature([calendared, pending])?.kind).toBe('pending');
  });

  /*
   * THE ANNOUNCED KIND (owner ruling V1) — the chamber's own published floor
   * schedule, reaching this design primitive through a resolver so it never
   * imports data. Three pins: it outranks both record facts, it is the ONLY
   * kind exempt from the `floor_vote` status gate, and omitting the resolver
   * leaves the selector behaving exactly as it did before the ruling.
   */
  test.describe('the announced kind', () => {
    const announcement = (over: Record<string, unknown> = {}) => ({
      quote: 'Senator Thune: the Senate will vote on the motion to invoke cloture on H.R. 3633.',
      url: 'https://www.congress.gov/119/crec/2026/08/10/d10au6-1.htm',
      published: dayOffset(1),
      covers: dayOffset(-1),
      source: 'daily-digest' as const,
      chamber: 'senate' as const,
      ...over,
    });

    test('an announcement outranks a fresher pending motion and a fresher placement', () => {
      const announced = candidate(dayOffset(9), 'Referred to the Committee on Finance.', 0.1);
      const pending = candidate(dayOffset(0), CLOTURE_TEXT, 1);
      const calendared = candidate(dayOffset(0), CALENDAR_TEXT, 1);
      const pick = selectFloorVoteFeature([pending, calendared, announced], (b) =>
        b === announced ? announcement() : null
      );
      expect(pick?.bill).toBe(announced);
      expect(pick?.kind).toBe('announced');
      expect(pick?.chamber).toBe('senate');
      expect(pick?.announcement?.quote).toContain('will vote on');
    });

    test('it is the one kind that does not need `floor_vote` — which is the point of it', () => {
      // THE MEASURED CASE: when a measure reaches the floor Congress overwrites
      // the action text and the sync derives `committee` from what is left, so
      // a status gate made the week's biggest bills uncrownable.
      const overwritten = {
        status: 'committee' as const,
        last_action_date: dayOffset(4),
        last_action_text: 'Message on Senate action sent to the House.',
        urgency_score: 0.45,
      };
      expect(selectFloorVoteFeature([overwritten])).toBeNull();
      const pick = selectFloorVoteFeature([overwritten], () => announcement());
      expect(pick?.bill).toBe(overwritten);
      expect(pick?.kind).toBe('announced');
    });

    test('a daily program beats a weekly list on an identical publication date', () => {
      const a = candidate(dayOffset(0), CALENDAR_TEXT, 1);
      const b = candidate(dayOffset(0), CALENDAR_TEXT, 1);
      const pick = selectFloorVoteFeature([b, a], (bill) =>
        bill === a
          ? announcement()
          : announcement({ source: 'billsthisweek', chamber: 'house' })
      );
      expect(pick?.bill).toBe(a);
    });

    test('the newer announcement wins, whatever the bills\' own dates say', () => {
      const older = candidate(dayOffset(0), CALENDAR_TEXT, 1);
      const newer = candidate(dayOffset(9), CALENDAR_TEXT, 0.1);
      const pick = selectFloorVoteFeature([older, newer], (bill) =>
        bill === newer ? announcement({ published: dayOffset(0) }) : announcement({ published: dayOffset(3) })
      );
      expect(pick?.bill).toBe(newer);
    });

    test('with no resolver the selector is byte-for-byte the pre-ruling behavior', () => {
      const pending = candidate(dayOffset(0), CLOTURE_TEXT, 1);
      const pick = selectFloorVoteFeature([pending]);
      expect(pick?.kind).toBe('pending');
      expect(pick?.announcement).toBeNull();
    });
  });

  /*
   * POOL INDEPENDENCE. The cap-to-one belongs to this function, never to a
   * short candidate list: until 2026-08-09 the homepage handed it
   * getTopActions(4), so a busy floor day could push the one eligible bill
   * past rank 4 and the page showed NO crown at all.
   */
  test('an eligible bill at rank 9 still wins over eight settled ones', () => {
    const settled = Array.from({ length: 8 }, (_, i) =>
      candidate(dayOffset(0), CLOTURE_NOT_INVOKED, 1 - i * 0.01)
    );
    const eligible = candidate(dayOffset(3), CALENDAR_TEXT, 0.05);
    const pick = selectFloorVoteFeature([...settled, eligible]);
    expect(pick?.bill).toBe(eligible);
    expect(pick?.kind).toBe('calendar');
  });

  test('the freshness half of the triad still holds: a stale floor fact is a quiet week', () => {
    // 15 days: one past SIGNAL_WINDOW_DAYS.
    expect(selectFloorVoteFeature([candidate(dayOffset(15), CALENDAR_TEXT, 1)])).toBeNull();
    expect(selectFloorVoteFeature([candidate(dayOffset(15), CLOTURE_TEXT, 1)])).toBeNull();
  });

  test('a non-floor_vote status never takes the panel, whatever its text says', () => {
    expect(
      selectFloorVoteFeature([
        { status: 'passed_chamber' as const, last_action_date: dayOffset(0), last_action_text: CALENDAR_TEXT },
      ])
    ).toBeNull();
  });

  /*
   * THE LIVE-CORPUS SWEEP. Whatever today's data elects has to pass one of
   * the two gates AND be the newest eligible fact in the corpus — the second
   * half is what pins the ranking change against real data rather than
   * fixtures.
   */
  test('whatever the live corpus elects passes a gate and carries the newest eligible date', () => {
    const pick = selectFloorVoteFeature(corpus as ReadonlyArray<CorpusBill & { status: BillStatus }>);
    if (pick === null) return;
    const winner = pick.bill;
    const calendar = floorCalendarChamber(winner.last_action_text);
    const pending = floorPendingChamber(winner.last_action_text);
    expect(calendar ?? pending, slugOf(winner)).not.toBeNull();
    expect(pick.kind).toBe(calendar ? 'calendar' : 'pending');
    expect(pick.chamber).toBe(calendar ?? pending);

    for (const b of floorVote) {
      const eligible =
        isSignalFresh(b.last_action_date) &&
        (floorCalendarChamber(b.last_action_text) !== null ||
          floorPendingChamber(b.last_action_text) !== null);
      if (!eligible) continue;
      // ISO dates, so lexical order IS chronological order.
      expect(
        (winner.last_action_date ?? '') >= (b.last_action_date ?? ''),
        `${slugOf(winner)} (${winner.last_action_date}) must not be older than ${slugOf(b)} (${b.last_action_date})`
      ).toBe(true);
    }
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
   * surface. The sweep is corpus-wide, and the test below asserts a RANGE
   * rather than a count, because the split it turns on moves nightly: 23 of
   * 319 floor_vote records when this pin was written, 26 of 339 on the corpus
   * it merged onto. Naming a number here would make a quiet night red.
   *
   * ONE `now`, INJECTED (N3, 2026-08-11). Both copies read the clock now, and
   * a sweep of ~2,700 records takes long enough that two independent
   * `Date.now()` calls can straddle a boundary — a bill whose placement ages
   * out mid-loop would make the two copies "disagree" about a rule they
   * implement identically. The instant is a parameter, so the comparison is
   * of the FUNCTIONS and never of the moment they were called.
   */
  const SWEEP_NOW = Date.now();

  test('statusKeyFor: the two answer identically over the WHOLE corpus', () => {
    for (const b of corpus) {
      expect(
        scriptStatusKeyFor(b.status, b.last_action_text, b.last_action_date, SWEEP_NOW),
        slugOf(b)
      ).toBe(
        statusKeyFor(b.status as BillStatus, b.last_action_text, b.last_action_date, SWEEP_NOW)
      );
    }
  });

  /*
   * THE SPLIT-STILL-EXISTS GUARD, re-reasoned for THREE buckets (N3).
   *
   * It used to assert one thing: that at least one floor_vote bill is demoted
   * to `floor_activity` and not all of them are, because a pin between two
   * copies proves nothing if the copies agree by never disagreeing with
   * anything. The gate now has three outputs and the same argument applies to
   * each — a clock that never fires, or one that fires on everything, would
   * both leave the parity pin above vacuous on the axis that matters most.
   *
   * RANGES, NEVER COUNTS, for the same reason as before and one more: the
   * fresh bucket is the smallest and the most volatile (17 of 348 at
   * 2026-08-12T02:46Z), and it is legitimately allowed to reach zero on a genuinely
   * quiet fortnight — Congress can go two weeks without placing anything on a
   * calendar, and that is a true quiet week, not a broken gate. So the fresh
   * bucket is asserted only as "not everything", while the two buckets that
   * cannot honestly empty on this corpus are asserted non-zero.
   */
  test('statusKeyFor still splits this corpus three ways — placement, aged placement, activity', () => {
    const keyed = floorVote.map((b) =>
      scriptStatusKeyFor(b.status, b.last_action_text, b.last_action_date, SWEEP_NOW)
    );
    const fresh = keyed.filter((k) => k === 'floor_vote');
    const stale = keyed.filter((k) => k === 'floor_vote_stale');
    const activity = keyed.filter((k) => k === 'floor_activity');

    // Every floor_vote bill lands in exactly one bucket — no fourth answer.
    expect(fresh.length + stale.length + activity.length).toBe(floorVote.length);
    // Aged placements are the population this ruling exists for; a corpus
    // reaching back past a year cannot honestly have none.
    expect(stale.length).toBeGreaterThan(0);
    // The 2026-08-04 gate's own guard, unchanged.
    expect(activity.length).toBeGreaterThan(0);
    // The clock must not have swallowed the category whole: a run where EVERY
    // placement is stale is possible; one where every floor_vote bill is would
    // mean the placement matcher stopped matching.
    expect(stale.length).toBeLessThan(floorVote.length);
    // …and it must not be a no-op either: if nothing is ever demoted the
    // parity pin above is testing an unclocked function under a clocked name.
    expect(fresh.length).toBeLessThan(floorVote.length);
  });

  /*
   * THE FIXTURE PINS — one per output, at a fixed instant, so the three keys
   * are nailed down independently of whatever the corpus happens to hold.
   * These are the two copies asserted TOGETHER: a drift in either fails here.
   */
  test('statusKeyFor: all three outputs, pinned by fixture in both copies', () => {
    const both = (text: string | null, date: string | null) => {
      const ts = statusKeyFor('floor_vote', text, date);
      expect(scriptStatusKeyFor('floor_vote', text, date), 'the .mjs copy agrees').toBe(ts);
      return ts;
    };
    // A placement inside the window: the present-tense claim is earned.
    expect(both(CALENDAR_PLACEMENT, FRESH)).toBe('floor_vote');
    // The SAME sentence, aged out: the fact survives, the tense moves.
    expect(both(CALENDAR_PLACEMENT, STALE)).toBe('floor_vote_stale');
    // No placement at all — not clocked, so the date cannot change it.
    expect(both(CLOTURE_TEXT, FRESH)).toBe('floor_activity');
    expect(both(CLOTURE_TEXT, STALE)).toBe('floor_activity');
    // Every other status passes through untouched, clock or no clock.
    expect(statusKeyFor('committee', CALENDAR_PLACEMENT, STALE)).toBe('committee');
    expect(statusKeyFor('signed', null, null)).toBe('signed');
  });

  test('statusKeyFor: an undated placement fails closed to the weaker claim', () => {
    // isSignalFresh's own rule, and the rule amber has always run on: no date,
    // no present-tense claim. 0 of the corpus's 322 placements are undated
    // (2026-08-12), so this is the shape we refuse to be surprised by rather
    // than one we currently render.
    expect(statusKeyFor('floor_vote', CALENDAR_PLACEMENT, null)).toBe('floor_vote_stale');
    expect(scriptStatusKeyFor('floor_vote', CALENDAR_PLACEMENT, null)).toBe('floor_vote_stale');
    // An unparseable date is the same answer, for the same reason.
    expect(statusKeyFor('floor_vote', CALENDAR_PLACEMENT, 'not-a-date')).toBe('floor_vote_stale');
  });

  test('statusKeyFor reads the ONE window — SIGNAL_WINDOW_DAYS, not a second number', () => {
    /*
     * ONE DAY EITHER SIDE, NEVER THE EDGE — the same idiom, and the same
     * reason, as the deriveJourney boundary test in suite 3: corpus dates are
     * date-only (midnight UTC) while isSignalFresh measures in milliseconds,
     * so a placement dated exactly SIGNAL_WINDOW_DAYS ago is inside the window
     * only at exactly 00:00 UTC and outside it for the rest of the day.
     * Asserting that instant would be a clock-dependent coin flip.
     */
    expect(statusKeyFor('floor_vote', CALENDAR_PLACEMENT, dateDaysAgo(SIGNAL_WINDOW_DAYS - 1))).toBe(
      'floor_vote'
    );
    expect(statusKeyFor('floor_vote', CALENDAR_PLACEMENT, dateDaysAgo(SIGNAL_WINDOW_DAYS + 1))).toBe(
      'floor_vote_stale'
    );
  });

  /*
   * THE COPY EXISTS, IN BOTH LANGUAGES. The bilingual hard rule is enforced
   * globally by scripts/check-messages-parity.mjs, but this key is reached by
   * a TEMPLATE (`bills.status.${key}`) — no static reference anywhere for a
   * reader or a tool to follow — so the one place that names it out loud
   * should be the suite that produces it.
   */
  test('every key statusKeyFor can return has a label in EN and ES', () => {
    const keys = new Set(
      corpus.map((b) =>
        statusKeyFor(b.status as BillStatus, b.last_action_text, b.last_action_date, SWEEP_NOW)
      )
    );
    keys.add('floor_vote');
    keys.add('floor_vote_stale');
    keys.add('floor_activity');
    for (const key of keys) {
      expect((en.bills.status as Record<string, string>)[key], `EN ${key}`).toBeTruthy();
      expect((es.bills.status as Record<string, string>)[key], `ES ${key}`).toBeTruthy();
    }
    // And the aged-placement label is not a copy of the live one — the whole
    // point is that a reader can tell them apart.
    expect(en.bills.status.floor_vote_stale).not.toBe(en.bills.status.floor_vote);
    expect(es.bills.status.floor_vote_stale).not.toBe(es.bills.status.floor_vote);
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
  /* Fresh by default, for the same reason deriveJourney's fixture helper is —
     these fixtures were all written to ask "where does the record put this
     bill", and the clock (D3) is a separate question, asked explicitly below. */
  const bill = (
    bill_type: string,
    status: BillStatus,
    last_action_text: string | null,
    last_action_date: string | null = FRESH
  ) => ({
    bill_type,
    status,
    last_action_text,
    last_action_date,
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

  /*
   * FINDING 2 (2026-08-09). The floor branch fell back to floorActionChamber,
   * which only ever knew WHICH chamber a sentence was about — so all 18 of the
   * corpus's settled texts drew "This bill is in the Senate's hands right now
   * — your senators are the live call.", the strongest sentence on the page,
   * over a motion the Senate had already voted down.
   */
  test('a settled floor motion makes NO live-floor claim', () => {
    expect(liveCallTarget(bill('sjres', 'floor_vote', MOTION_REJECTED_TEXT))).toBeNull();
    expect(liveCallTarget(bill('sjres', 'floor_vote', DISCHARGE_REJECTED_TEXT))).toBeNull();
    expect(
      liveCallTarget(
        bill('s', 'floor_vote', 'Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 51 - 48. Record Vote Number: 88.')
      )
    ).toBeNull();
  });

  test('a pending floor vote still earns it — a cloture motion filed is a live call', () => {
    expect(liveCallTarget(bill('hr', 'floor_vote', CLOTURE_TEXT))).toEqual({
      chamber: 'senate',
      afterVote: false,
      soleChamber: false,
    });
  });

  /*
   * D3 (2026-08-11). The routing sentence is the strongest claim on the page —
   * "this bill is in the Senate's hands right now — your senators are the live
   * call" — and it was firing off 311 floor records outside the 14-day window
   * (2026-08-12), the oldest a placement dated 2025-02-05. Demote, never bury:
   * null here only drops the routing sentence and the reordering; every dial,
   * the script and the call dialog are untouched (tests/call-action.spec.ts
   * owns that half).
   */
  test('THE D3 GUARD: an aged floor signal routes NOWHERE, whatever the sentence says', () => {
    const CAL = 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.';
    expect(liveCallTarget(bill('hr', 'floor_vote', CAL, STALE))).toBeNull();
    expect(liveCallTarget(bill('hr', 'floor_vote', CLOTURE_TEXT, STALE))).toBeNull();
    // An undated floor record is never live.
    expect(liveCallTarget(bill('s', 'floor_vote', CAL, null))).toBeNull();
    // …and the same records inside the window still route, so the gate is age.
    expect(liveCallTarget(bill('hr', 'floor_vote', CAL, FRESH))).toEqual({
      chamber: 'senate',
      afterVote: false,
      soleChamber: false,
    });
  });

  test('the routing clock is the SAME window the stepper reads', () => {
    // One day either side of SIGNAL_WINDOW_DAYS, never the edge — see the
    // stepper's own boundary test for why the exact day is unassertable.
    const CAL = 'Placed on the Union Calendar, Calendar No. 219.';
    expect(liveCallTarget(bill('hr', 'floor_vote', CAL, dateDaysAgo(SIGNAL_WINDOW_DAYS - 1)))).toEqual({
      chamber: 'house',
      afterVote: false,
      soleChamber: false,
    });
    expect(liveCallTarget(bill('hr', 'floor_vote', CAL, dateDaysAgo(SIGNAL_WINDOW_DAYS + 1)))).toBeNull();
  });

  /*
   * THE N5 ASYMMETRY, PINNED FROM THE OTHER SIDE (2026-08-12). The stepper's
   * passage sentence IS clocked now (suite 3) and this branch is deliberately
   * NOT — the owner's N5 ruling confirmed #208's call rather than reversing
   * it. TARGET here, TENSE there: a chamber that voted stays voted, and the
   * chamber that has not yet acted is still the one a caller would reach.
   *
   * This test is the guard on a plausible wrong fix: clocking BOTH halves
   * would silence 280 of the corpus's 295 passage routings (2026-08-12) and
   * strip the routing sentence and the rep reordering off nearly every bill
   * that has cleared a chamber. Every assertion below is spelled out with
   * `toEqual`, so a null — or a flipped `afterVote` — fails loudly.
   */
  test('passed_chamber routing is STILL not clocked — the stepper moved, the target did not', () => {
    const stale = { chamber: 'senate', afterVote: true, soleChamber: false };
    // The corpus's dominant shape, aged well past the window.
    expect(liveCallTarget(bill('hr', 'passed_chamber', 'Received in the Senate.', STALE))).toEqual(stale);
    expect(
      liveCallTarget(
        bill('hr', 'passed_chamber', 'Received in the Senate and Read twice and referred to the Committee on Finance.', STALE)
      )
    ).toEqual(stale);
    // hr-30-119's age on the day N5 landed: 573 days, and it still routes.
    expect(liveCallTarget(bill('hr', 'passed_chamber', 'Received in the Senate.', dateDaysAgo(573)))).toEqual(stale);
    // The mirror direction, and the amended case whose target is the ORIGIN
    // chamber — the one the old bill_type derivation got backwards.
    expect(liveCallTarget(bill('sjres', 'passed_chamber', 'Received in the House.', STALE))).toEqual({
      chamber: 'house',
      afterVote: true,
      soleChamber: false,
    });
    expect(
      liveCallTarget(bill('hr', 'passed_chamber', 'Passed Senate with an amendment by Voice Vote.', STALE))
    ).toEqual({ chamber: 'house', afterVote: true, soleChamber: false });
    // An undated passage routes too: unlike the floor branch, this one has no
    // date gate at all, so there is nothing to fail closed to.
    expect(liveCallTarget(bill('hr', 'passed_chamber', 'Received in the Senate.', null))).toEqual(stale);
    // The window boundary changes NOTHING here — the same answer either side.
    expect(
      liveCallTarget(bill('hr', 'passed_chamber', 'Received in the Senate.', dateDaysAgo(SIGNAL_WINDOW_DAYS - 1)))
    ).toEqual(stale);
    expect(
      liveCallTarget(bill('hr', 'passed_chamber', 'Received in the Senate.', dateDaysAgo(SIGNAL_WINDOW_DAYS + 1)))
    ).toEqual(stale);
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

  /*
   * FINDING 1 (2026-08-09). H.R. 1276's exact text: the bill TYPE said "route
   * to the Senate", the RECORD said the Senate had already passed it without
   * changes. No chamber is a live call on a measure headed for the desk.
   */
  test('a bill both chambers have passed routes NOWHERE — the President is next', () => {
    expect(
      liveCallTarget(bill('hr', 'passed_chamber', 'Passed Senate without amendment by Unanimous Consent.'))
    ).toBeNull();
  });

  /*
   * …and the case the old code got exactly backwards rather than merely
   * stale: the Senate amended it, so the HOUSE decides next.
   */
  test('an amended second-chamber passage routes to the ORIGINATING chamber', () => {
    expect(
      liveCallTarget(
        bill('hr', 'passed_chamber', 'Passed Senate with an amendment and an amendment to the Title by Yea-Nay Vote. 90 - 6. Record Vote Number: 228.')
      )
    ).toEqual({ chamber: 'house', afterVote: true, soleChamber: false });
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
        last_action_date: b.last_action_date,
      });
      if (target) expect(target.soleChamber, slugOf(b)).toBe(false);
    }
  });

  /* ---------------------------------------------------------------- *
   * THE LIVE-CORPUS INVARIANT (D3). The fixtures above pin the shapes
   * we know; this pins every record tomorrow's sync lands. Stated as an
   * invariant rather than a count, because the count moves nightly —
   * 311 demotions on 2026-08-12 (305 placements + 6 pending motions),
   * and a number here would redden CI on a quiet legislative week.
   * ---------------------------------------------------------------- */
  test('no bill outside the signal window makes a live-floor claim, anywhere in the corpus', () => {
    let demoted = 0;
    for (const b of floorVote) {
      const input = {
        bill_type: b.bill_type,
        status: b.status as BillStatus,
        last_action_text: b.last_action_text,
        last_action_date: b.last_action_date,
      };
      const { nowKey } = deriveJourney(input);
      const fresh = isSignalFresh(b.last_action_date);
      if (!fresh) {
        // The stepper never speaks in the present tense…
        expect(nowKey, slugOf(b)).not.toBe('nowFloor');
        expect(nowKey, slugOf(b)).not.toBe('nowFloorActivity');
        // …and the rail never routes a live decision.
        expect(liveCallTarget(input), slugOf(b)).toBeNull();
        if (nowKey === 'nowFloorStale' || nowKey === 'nowFloorActivityStale') demoted += 1;
      }
    }
    /*
     * The loop must actually have demoted something, or it passes vacuously —
     * the same discipline the statusKeyFor split pin uses (suite 6). Only this
     * side is asserted: aged placements only accumulate (305 of 322 on
     * 2026-08-12, oldest 553 days), while the FRESH side legitimately empties
     * out over a recess and asserting it here would redden the CI of unrelated
     * PRs on a quiet legislative week. The fresh branch is pinned by fixture
     * in suite 3 instead, where no data can silence it.
     */
    expect(demoted, 'no aged floor placement in the corpus — has the gate stopped firing?').toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------- *
   * THE N5 LIVE-CORPUS INVARIANT (2026-08-12). Same discipline as the
   * D3 sweep above — an invariant plus a non-vacuity floor, never a
   * count, because the count moves nightly (280 of 295 passage records
   * demoted on the day this landed) and a number here would redden the
   * CI of unrelated PRs on a quiet legislative week.
   *
   * It asserts BOTH halves of the split, which is the only way to catch
   * the two opposite wrong fixes: a stepper that keeps narrating the
   * handoff, and a rail that stops routing the call.
   * ---------------------------------------------------------------- */
  test('no aged passage narrates a handoff — and every one of them still routes a call', () => {
    const passed = corpus.filter((b) => b.status === 'passed_chamber');
    let aged = 0;
    let live = 0;
    for (const b of passed) {
      const input = {
        bill_type: b.bill_type,
        status: b.status as BillStatus,
        last_action_text: b.last_action_text,
        last_action_date: b.last_action_date,
      };
      const { nowKey } = deriveJourney(input);
      const target = liveCallTarget(input);
      /*
       * THE HALF THAT MUST NOT MOVE. Every stage that names a next chamber
       * routes, at every age — a passage is a durable fact and the target
       * stays right. The two stages that name none ('both' → the President,
       * 'second' → the record has not said) route nowhere at every age too,
       * so `next` and the routing decision are pinned against each other
       * rather than against the clock.
       */
      const { next } = passageState(input);
      if (next) {
        expect(target, `${slugOf(b)} must still route`).toEqual({
          chamber: next,
          afterVote: true,
          soleChamber: false,
        });
      } else {
        expect(target, `${slugOf(b)} names no next chamber`).toBeNull();
      }

      if (isSignalFresh(b.last_action_date)) continue;
      aged += 1;
      // THE HALF THAT MOVES: no aged passage may claim the handoff is underway.
      expect(nowKey, slugOf(b)).not.toBe('nowPassed');
      expect(nowKey, slugOf(b)).not.toBe('nowPassedBack');
      if (nowKey === 'nowPassedStale' || nowKey === 'nowPassedBackStale') live += 1;
    }
    /*
     * NON-VACUITY, on both counts. `passed` empty would make every assertion
     * above pass without executing; `live` at zero would mean the aged records
     * are all landing in the two unclocked stages, i.e. the demotion this
     * change exists for never fires. Only the STALE side is floored — aged
     * passages only accumulate (280 of 295 on 2026-08-12, oldest 573 days),
     * while the FRESH side legitimately empties over a recess. The fresh
     * branch is pinned by fixture in suite 3, where no data can silence it.
     */
    expect(passed.length, 'no passed_chamber records at all — is the corpus loaded?').toBeGreaterThan(0);
    expect(aged, 'no aged passage in the corpus — has the window changed?').toBeGreaterThan(0);
    expect(live, 'aged passages exist but none demoted — has the gate stopped firing?').toBeGreaterThan(0);
    // …and the clock must not have swallowed the category whole: a run where
    // EVERY passage is aged is possible, one where every passage record is
    // demoted AND none is fresh would still be legal, but `aged` exceeding the
    // population would mean the filter above stopped filtering.
    expect(aged).toBeLessThanOrEqual(passed.length);
    expect(live).toBeLessThanOrEqual(aged);
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
    expect(
      liveCallTarget({
        bill_type: 'hr',
        status: 'committee',
        last_action_text: null,
        // Dated TODAY, so this reads as the structural refusal it is and not
        // as the D3 freshness gate answering for it.
        last_action_date: new Date().toISOString().slice(0, 10),
      })
    ).toBeNull();
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
