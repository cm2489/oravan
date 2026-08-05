import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveJourney, floorActionChamber, floorCalendarChamber, liveCallTarget } from '../lib/journey';
import type { BillStatus } from '../lib/types';
import { selectFloorVoteFeature } from '../components/system/FloorVotePanel';
// The import-free copy the .mjs report carries — pinned corpus-wide in suite 6.
import { floorCalendarChamber as scriptFloorCalendarChamber } from '../scripts/moment-candidates.mjs';

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
});

/* ------------------------------------------------------------------ *
 * 5 · liveCallTarget — chamber-aware call routing (2026-08 benchmark
 *     2026-08). Non-null ONLY where the record places the bill in a
 *     chamber's hands today; everything else renders the rep list
 *     exactly as before. Never guesses (owner ruling 2026-08-04).
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
    ).toEqual({ chamber: 'senate', afterVote: false });
    expect(
      liveCallTarget(bill('hr', 'floor_vote', 'Placed on the Union Calendar, Calendar No. 219.'))
    ).toEqual({ chamber: 'house', afterVote: false });
  });

  test('floor activity routes by the record sentence, not the bill type', () => {
    expect(liveCallTarget(bill('hr', 'floor_vote', CLOTURE_TEXT))).toEqual({
      chamber: 'senate',
      afterVote: false,
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
    });
    expect(liveCallTarget(bill('sjres', 'passed_chamber', 'Received in the House.'))).toEqual({
      chamber: 'house',
      afterVote: true,
    });
  });

  test('every other stage renders the list untouched: committee, conference, signed, vetoed, introduced', () => {
    for (const status of ['introduced', 'committee', 'markup', 'conference', 'signed', 'vetoed'] as const) {
      expect(liveCallTarget(bill('hr', status, 'whatever the record says'))).toBeNull();
    }
  });
});
