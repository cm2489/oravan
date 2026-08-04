import type { Bill } from './types';

/*
 * THE ONE "WHERE IS THIS BILL" DERIVATION.
 *
 * Before this module existed, three code paths answered that question and
 * only one of them read the record: the bill page's amber gate parsed the
 * chamber out of the last-action sentence, while the stepper guessed it from
 * the bill type and the homepage panel never checked at all. On a House bill
 * sitting on the SENATE floor calendar the page contradicted itself — green
 * band saying "On the Senate floor calendar" over a stepper saying "House
 * vote — You are here". Both the bill-page stepper and the homepage feature
 * panel now consume this module, so the record always beats the guess.
 *
 * Everything here is computed from stored data — never AI-generated, so it
 * cannot hallucinate procedure.
 */

export type Chamber = 'house' | 'senate';

/*
 * THE AMBER GATE, and why it is narrower than the status field.
 *
 * `status: "floor_vote"` is DERIVED from action text
 * (scripts/congress-fetch.mjs keyword bucket), and the corpus proves the
 * derivation is looser than the claim amber makes. Of the 319 bills carrying
 * `floor_vote` at the time of writing, 296 say "Placed on <the Union / the
 * House / Senate Legislative> Calendar" — a real, dated calendar placement.
 * The other 23 do not: most read like "Motion to proceed to consideration of
 * measure REJECTED in Senate" or a cloture motion. Printing "On the Senate
 * floor calendar · Apr 29 2026" over a rejected motion is a false claim, and
 * the color law's "no date, no amber" rule exists to stop exactly this class
 * of lie. (The counts move nightly; tests/journey.unit.spec.ts sweeps the
 * live corpus so the split can never silently invalidate this gate.)
 *
 * So the band renders only when the bill's own last action says, in
 * Congress's words, that it was placed on a calendar — and the chamber is
 * read out of that same sentence rather than guessed from the bill type
 * (a House bill can sit on the Senate Legislative Calendar). Everything
 * else gets a paper page, which is the honest result.
 *
 * `last_action_date` is the PLACEMENT date. Nothing here claims a scheduled
 * vote date; the corpus holds none (see the ⚠️ ruling in DESIGN.md).
 *
 * scripts/moment-candidates.mjs carries an import-free copy of this function
 * (it must run under plain node); tests/journey.unit.spec.ts pins the two
 * against each other across every floor_vote action text in the corpus.
 */
export function floorCalendarChamber(actionText: string | null): Chamber | null {
  if (!actionText) return null;
  const match = /placed on (?:the )?(senate legislative|union|house|senate)\s+calendar/i.exec(
    actionText
  );
  if (!match) return null;
  return /senate/i.test(match[1]) ? 'senate' : 'house';
}

/*
 * The activity matcher for floor_vote bills WITHOUT a calendar placement —
 * cloture motions, rejected motions to proceed, House rule resolutions,
 * postponed proceedings. Ordered rules, first hit wins; every live corpus
 * text is pinned by fixture in tests/journey.unit.spec.ts. Novel shapes are
 * caught by the NIGHTLY corpus check (scripts/check-journey-corpus.mjs,
 * wired into sync-bills.yml — it fires where the data changes, never on
 * unrelated PRs), and until a matcher rule lands the stepper renders
 * chamber-free neutral copy instead of a guess.
 */
export function floorActionChamber(actionText: string | null): Chamber | null {
  if (!actionText) return null;
  // (1) Cloture exists only in the Senate.
  if (/cloture/i.test(actionText)) return 'senate';
  // (2) "POSTPONED PROCEEDINGS" is a House floor idiom (rule XIX) — covers
  //     the texts that never name a chamber at all.
  if (/postponed proceedings/i.test(actionText)) return 'house';
  // (3) Rules Committee resolutions reported to the House.
  if (/reported to house\b/i.test(actionText)) return 'house';
  // (4) Congressional Record page prefix: S-pages are the Senate section,
  //     H-pages the House section, e.g. "(CR S4365)".
  const cr = /\(CR ([SH])\d/.exec(actionText);
  if (cr) return cr[1] === 'S' ? 'senate' : 'house';
  // (5) An explicit venue phrase. Must precede rule 6: "House message …
  //     rejected in Senate" names both chambers but happened in one.
  if (/\bin senate\b|\bby senator\b/i.test(actionText)) return 'senate';
  if (/\bin house\b/i.test(actionText)) return 'house';
  // (6) Exactly one chamber named anywhere in the sentence.
  const hasSenate = /senate/i.test(actionText);
  const hasHouse = /house/i.test(actionText);
  if (hasSenate !== hasHouse) return hasSenate ? 'senate' : 'house';
  // (7) The record does not say — and deriveJourney renders the
  //     chamber-free neutral copy rather than guessing (owner ruling
  //     2026-08-04). The nightly corpus check
  //     (scripts/check-journey-corpus.mjs) flags novel shapes so this
  //     branch stays rare, but reaching it is honest, never a lie.
  return null;
}

/** The message key the stepper's "Right now:" sentence reads. */
export type JourneyNowKey =
  | 'nowIntroduced'
  | 'nowCommittee'
  | 'nowFloor'
  | 'nowFloorActivity'
  | 'nowFloorActivityNeutral'
  | 'nowPassed'
  | 'nowConference'
  | 'nowSigned'
  | 'nowVetoed';

export interface JourneyState {
  /** Index into the five stepper steps: introduced · origin committee ·
   *  origin vote · other chamber · President's desk. */
  step: 0 | 1 | 2 | 3 | 4;
  /** The chamber the bill started in (from the bill type). */
  origin: Chamber;
  /** The chamber the bill stands in NOW, read from the record where the
   *  record says (floor stages). For stages past both chambers it carries
   *  the last chamber before the President's desk. */
  current: Chamber;
  /** The chamber the `nowKey` sentence speaks about: `current` for the two
   *  floor keys, `origin` for everything else (nowPassed's copy is "it
   *  passed the {origin} and now goes to the {other}"). */
  nowChamber: Chamber;
  nowKey: JourneyNowKey;
  /** True only when the record's own sentence says "Placed on … Calendar". */
  onCalendar: boolean;
  isLaw: boolean;
  isVetoed: boolean;
  /** Whether the "changes send it back" trailer is still ahead. */
  showTrailer: boolean;
}

/**
 * The full status → position behavior table. Chamber for committee/markup
 * texts is not reliably derivable from referral text, so those stages stay
 * deliberately conservative (origin chamber). An unmapped status (the JSON
 * is untyped at load) falls back to the committee step — the same defensive
 * default the stepper's old `POSITION[status] ?? 1` carried.
 */
export function deriveJourney(
  bill: Pick<Bill, 'bill_type' | 'status' | 'last_action_text'>
): JourneyState {
  const origin: Chamber = bill.bill_type.startsWith('h') ? 'house' : 'senate';
  const other: Chamber = origin === 'house' ? 'senate' : 'house';
  const base = {
    origin,
    current: origin,
    nowChamber: origin,
    onCalendar: false,
    isLaw: false,
    isVetoed: false,
    showTrailer: true,
  };
  switch (bill.status) {
    case 'introduced':
      return { ...base, step: 0, nowKey: 'nowIntroduced' };
    case 'committee':
    case 'markup':
      return { ...base, step: 1, nowKey: 'nowCommittee' };
    case 'floor_vote': {
      const cal = floorCalendarChamber(bill.last_action_text);
      if (cal) {
        return {
          ...base,
          step: cal === origin ? 2 : 3,
          current: cal,
          nowChamber: cal,
          onCalendar: true,
          nowKey: 'nowFloor',
        };
      }
      const act = floorActionChamber(bill.last_action_text);
      // NEVER GUESS A CHAMBER (owner ruling 2026-08-04). An unclassifiable
      // floor text used to fall back to the ORIGIN chamber — the silent-lie
      // class the whole derivation exists to end. Now it renders the
      // chamber-free key instead: the step math stays at the origin slot
      // (structure needs a position) but no rendered sentence names a
      // chamber the record did not. The corpus tripwire that catches novel
      // shapes moved to the nightly sync (scripts/check-journey-corpus.mjs)
      // — it fires where the data changes, never on unrelated PRs.
      if (act === null) {
        return {
          ...base,
          step: 2,
          current: origin,
          nowChamber: origin,
          nowKey: 'nowFloorActivityNeutral',
        };
      }
      return {
        ...base,
        step: act === origin ? 2 : 3,
        current: act,
        nowChamber: act,
        nowKey: 'nowFloorActivity',
      };
    }
    case 'passed_chamber':
      // Corpus-verified copy: nearly all passed_chamber actions read
      // "Received in the Senate…" — origin passage, headed to the other
      // chamber — so nowChamber stays origin and current is the other.
      return { ...base, step: 3, current: other, nowKey: 'nowPassed' };
    case 'conference':
      return { ...base, step: 3, current: other, nowKey: 'nowConference', showTrailer: false };
    case 'signed':
      return { ...base, step: 4, current: other, isLaw: true, nowKey: 'nowSigned', showTrailer: false };
    case 'vetoed':
      return { ...base, step: 4, current: other, isVetoed: true, nowKey: 'nowVetoed', showTrailer: false };
    default:
      return { ...base, step: 1, nowKey: 'nowCommittee', showTrailer: false };
  }
}
