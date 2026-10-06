import type { Bill, StatusLabelKey } from './types';
// TYPE-ONLY, and it must stay type-only: lib/moments.ts imports
// data/moments.json and the whole bill corpus behind it, and this module is
// read by the embed and MCP surfaces that must not pull either. `import type`
// is erased at compile time, so VOTING_CHAMBERS below costs nothing at
// runtime and still fails the build if VEHICLE_KINDS grows a member.
import type { VehicleKind } from './moments';
// TYPE-ONLY for the same reason, and a stricter one: lib/core/nominations.ts
// imports data/nominations.json (~520 KB) at module scope, and that module's
// own header says it is deliberately kept out of the lib/core barrel so no
// surface pays for the corpus by accident. `import type` is erased, so
// liveCallTargetForNomination below can name a Nomination's status field
// without any of this module's readers — embed, MCP, the bill page — pulling
// a byte of the nomination corpus.
import type { Nomination } from './core/nominations';
// TYPE-ONLY, hardest of the three: lib/docket.ts imports data/floor-signals
// .json at module scope, and this module is read by the embed and MCP surfaces
// that must pull no data file at all. `import type` is erased at compile time,
// so `floorFactSuspended` below can name the ONE ChamberSession vocabulary
// (owner ruling of 2026-08-14, shipped in #230) instead of declaring a second,
// drifting copy of the same three literals — and nothing that reads this
// module pays a byte for it. Re-exported below so a design primitive can name
// the type without importing lib/docket at all.
import type { ChamberSession } from './docket';
// THE CLOCK, from the ONE copy. lib/urgency.mjs is a pure transform with no
// data imports and no side effects (lib/moments.ts imports it the same way, by
// relative path, for the same reason), so the embed and MCP surfaces that read
// this module pay a few bytes of arithmetic and nothing else. It is
// deliberately the SAME function the bill page's green panel
// (app/[locale]/bills/[id]/page.tsx, via lib/signal-window.ts) and the homepage
// crown (components/system/FloorVotePanel.tsx) gate on: three surfaces, one
// definition of "now", so they cannot disagree about which floor facts are
// still live.
import { isSignalFresh, TERMINAL_STATUSES } from './urgency.mjs';
/*
 * THE FLOOR-TEXT VOCABULARY, from the ONE copy — and the reason it moved out
 * of this file rather than being copied into a second one.
 *
 * FLOOR_SETTLED and the four chamber readers below are the shared vocabulary
 * of "what does this floor sentence say", and as of 2026-08-12 they have a
 * reader that cannot import TypeScript: lib/docket.mjs's ladder, which ranks
 * the site AND is imported by scripts/sync-coverage.mjs and
 * scripts/moment-candidates.mjs under plain node. The functions are unchanged
 * — same regexes, same order, same headers, now in lib/floor-text.mjs — and
 * they are re-exported here because this module is where every existing
 * caller looks for them and where the derivation that consumes them lives.
 * scripts/floor-signals-parse.mjs's private FLOOR_SETTLED copy was deleted in
 * the same change and now reads lib/docket.mjs's rung.
 */
export {
  FLOOR_SETTLED,
  floorActionChamber,
  floorCalendarChamber,
  floorMakesNoClaim,
  floorPassageRejectedChamber,
  floorPendingChamber,
  floorSettledChamber,
  statusBasisText,
} from './floor-text.mjs';
// floorActionChamber is re-exported above, and since 2026-08-12 nothing in
// this file's derivation asks "which chamber does this sentence belong to"
// without also asking what that chamber did. Its one use here since
// 2026-09-29, pointOfOrderUpheldChamber, asks it only AFTER
// procedureEndedConsideration has read what the chamber did.
// floorSettledChamber still calls it internally (lib/floor-text.mjs), and
// scripts/check-journey-corpus.mjs still sweeps with it — that is where a
// chamber-nameable-but-unread sentence gets found now.
import {
  CLOTURE_INVOKED_ON_MEASURE,
  concurrentAdoptedBy,
  floorCalendarChamber,
  floorPassageRejectedChamber,
  floorPendingChamber,
  floorReconsiderPendingChamber,
  floorSettledChamber,
  passageState as passageStateMjs,
  // Read together, and only by pointOfOrderUpheldChamber below.
  floorActionChamber,
  procedureEndedConsideration,
  recordedTally,
  statusBasisText,
} from './floor-text.mjs';
// The date of the sentence the stepper reads: the one reader the call panel
// already uses for it (`import`, not a copy, so the two cannot drift).
import { settledDecisionDate } from './settled-votes';

/** The optional pipeline field every chamber/tense derivation below reads
 *  through `statusBasisText` (lib/floor-text.mjs), and its date, which the
 *  one dated "Right now:" sentence reads through `settledDecisionDate`. */
type Basis = { status_basis_text?: string | null; status_basis_date?: string | null };

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
 * WHICH CHAMBERS CAN VOTE ON A VEHICLE, BY KIND — and why this is a constant
 * rather than a stored field.
 *
 * A bill's chamber is a fact about the RECORD and is read out of the record:
 * floorCalendarChamber() below parses it from Congress's own sentence, and
 * deriveJourney() refuses to guess when the sentence is silent (rule 7 /
 * lines 227-243). Nothing about a bill's type tells you where it stands, so
 * nothing about a bill's chamber may be written down in advance.
 *
 * A nomination's is the opposite kind of fact. Advice and consent belongs to
 * the Senate alone — Article II, Section 2, Clause 2 — so "the Senate" is not
 * an observation about any particular nomination, it is the shape of the
 * power. The House has no vote, ever, on any of them.
 *
 * Storing a `chamber` on the vehicle would erase that difference: it would
 * invite a hand-authored `chamber: "house"` on a nomination and give the gate
 * nothing to reject it with, because a stored field is just a string. Derived
 * from the kind, "House" is unrepresentable.
 *
 * NOTHING READS THIS YET (the discriminator ships one step ahead of the
 * surface that renders it, the same way data/nominations.json did). It is
 * declared here, beside the bill-side derivation it contrasts with, so the
 * next reader finds both halves of the rule in one place.
 */
export const VOTING_CHAMBERS: Record<VehicleKind, readonly Chamber[]> = {
  bill: ['house', 'senate'],
  nomination: ['senate'],
};

/*
 * WHERE THE PATH ENDS — the fifth step's destination, and the two vehicles
 * that never reach the President.
 *
 * This lookup moved here from components/BillJourney.tsx on 2026-08-12,
 * unchanged in what it decided about concurrent resolutions and widened by
 * one class. It belongs in this module for the reason the stepper's own
 * header states: every derivation the strip renders lives in lib/journey.ts,
 * and as of this change the answer is no longer readable from the bill TYPE
 * alone — it needs the record's title — so it is a derivation, not a prop.
 *
 * 1 · CONCURRENT resolutions (hconres / sconres) — the 2026-08-09 fix (#199).
 * Not presented to the President and cannot become law. It is the two
 * chambers speaking to each other: budget resolutions, War Powers directives,
 * adjournment. Both chambers adopt it and that is the end of the road;
 * Article I, Section 7's presentment requirement never engages.
 *
 * 2 · ARTICLE V amendment proposals (hjres / sjres whose title proposes an
 * amendment to the Constitution) — this change. Congress proposes by
 * two-thirds of both chambers and the proposal goes to the STATES; three
 * fourths of them must ratify. The President has no role — no signature, no
 * veto — and the measure never becomes a law. #199 named this exact class as
 * its documented known limit and declined to guess at it; the ruling that
 * closed it (owner, D5, 2026-08-12) attached a flag-first condition, so the
 * heuristic below was swept against the whole corpus before it was written
 * and the sweep is pinned as an invariant in tests/bill-journey.unit.spec.ts.
 *
 * WHY A TITLE MATCH IS ADMISSIBLE HERE, when this file's whole discipline is
 * to read the record rather than guess. It is not a guess about a bill's
 * POSITION — those still come from Congress's own last-action sentence and
 * still refuse to answer when the sentence is silent. It is a reading of the
 * record's own official title, which for this class is a formula Congress
 * writes the same way every time, and it was verified exhaustively rather
 * than assumed: on the 2026-08-12 corpus, of 97 joint resolutions exactly 16
 * carry the word "Constitution" in their title and all 16 are Article V
 * proposals — 12 in the "Proposing an amendment to the Constitution…" shape
 * and 4 in the "Proposing a balanced budget amendment to the Constitution…"
 * shape, which is why the regex allows a qualifier between the verb and the
 * noun. There are no false positives in that set and no Article V proposal
 * outside it.
 *
 * FAIL TOWARD EXCLUSION. One record sits on the line and is deliberately NOT
 * matched: hjres-80-119, "Establishing the ratification of the Equal Rights
 * Amendment." It concerns a constitutional amendment but does not PROPOSE one
 * under Article V, and what such a measure's path actually is has been
 * litigated rather than settled. The default — presentment — is the ordinary
 * rule, so a record this predicate is unsure about keeps the ordinary ending
 * instead of acquiring a states step nobody verified. Same reason `''` and any
 * unrecognized type return 'president'.
 */
const NO_PRESENTMENT = new Set(['hconres', 'sconres']);

/*
 * The Article V title formula. `propos…` and "amendment to the Constitution"
 * both required, within one sentence, allowing the qualifier Congress
 * sometimes writes between them ("a balanced budget amendment to the
 * Constitution"). `[^.]{0,60}` keeps the two halves inside the same clause so
 * a title that merely mentions the Constitution somewhere after a proposing
 * verb cannot drift into a match.
 */
const ARTICLE_V_TITLE = /\bpropos\w+\b[^.]{0,60}\bamendment to the Constitution\b/i;

/** The fifth step's destination. Exhaustive: every vehicle ends at exactly
 *  one of these. */
export type JourneyEnding = 'president' | 'bothChambers' | 'states';

/**
 * Which of the three endings a vehicle has. `title` is optional and only ever
 * consulted for joint resolutions; omitting it yields the ordinary presented
 * path, which is what every non-Article-V joint resolution (CRA disapprovals,
 * continuing resolutions, War Powers directives) genuinely has.
 */
export function journeyEnding(billType: string, title?: string | null): JourneyEnding {
  const type = billType.toLowerCase();
  if (NO_PRESENTMENT.has(type)) return 'bothChambers';
  if ((type === 'hjres' || type === 'sjres') && ARTICLE_V_TITLE.test(title ?? '')) {
    return 'states';
  }
  return 'president';
}

/*
 * The four chamber readers and FLOOR_SETTLED used to sit here; they are
 * re-exported at the top of this file from lib/floor-text.mjs (see that
 * import's header for why). Everything below reads them exactly as it did.
 */

/*
 * `endsAtPresident` LIVED HERE FOR ONE DAY AND IS GONE (2026-08-12).
 *
 * This branch moved it out of components/BillJourney.tsx because the stepper
 * grew a glossary link, which pulls in `@/i18n/navigation`, and
 * tests/bill-journey.unit.spec.ts was importing a pure function straight out
 * of that component — a dependency on the component never acquiring a UI
 * import. #220 made the same move for a better reason and generalized the
 * function on the way: `journeyEnding` above answers all THREE endings, the
 * Article V states path included, and the boolean cannot express that. So the
 * boolean is deleted rather than kept beside its own successor, and the spec
 * reads `journeyEnding` from this module — which satisfies the import problem
 * completely.
 */

/** Which named calendar the record put the bill on. */
export type FloorCalendar = 'union' | 'house' | 'senate-legislative';

/*
 * WHICH CALENDAR, not just which chamber — the finer grain, added for the
 * procedural glossary (issue #181) and deliberately built ON TOP of
 * floorCalendarChamber rather than beside it.
 *
 * The reason it exists: "on the House floor calendar" is not one fact. The
 * House keeps two, and the placement regex accepts both. Measured 2026-08-12
 * over every `floor_vote` bill in the committed corpus whose
 * `last_action_text` matches that regex: 180 Senate Legislative, 148 Union
 * Calendar, 2 House Calendar. A glossary link that sent all 150 House
 * placements to the Union Calendar entry would be a quiet false claim on 2 of
 * them, which is the exact class of thing the surrounding module refuses to
 * make. So the caller gets the real answer and links only what the record
 * named. (The corpus moves nightly — recompute rather than trust these
 * figures.)
 *
 * NO SECOND COPY OF THE PINNED REGEX. The `/placed on …/i` literal lives once,
 * in lib/floor-text.mjs, and is drift-pinned byte-for-byte against
 * scripts/moment-candidates.mjs (tests/moment-candidates.unit.spec.ts §2). A
 * second copy here would be a second thing to keep in sync — the very defect
 * that pin exists to catch. This delegates the placement question entirely and
 * asks only the one extra thing the chamber answer throws away.
 *
 * IT STAYS IN TypeScript, next to its consumer. #218 moved the four chamber
 * readers to lib/floor-text.mjs because lib/docket.mjs's ladder has to read
 * them under plain node; nothing under plain node asks WHICH calendar, and the
 * `FloorCalendar` union is a type the stepper's lookup table is keyed on.
 */
export function floorCalendarName(actionText: string | null): FloorCalendar | null {
  const chamber = floorCalendarChamber(actionText);
  if (!chamber || !actionText) return null;
  if (chamber === 'senate') return 'senate-legislative';
  return /union calendar/i.test(actionText) ? 'union' : 'house';
}


/*
 * THE THIRD GATE: THE CLOCK — which floor facts this module may speak about in
 * the PRESENT TENSE (owner ruling 2026-08-11, decision D3).
 *
 * The two gates above ask what the record SAYS. This one asks when it said it,
 * and it exists because every sentence the floor branch produces is written in
 * the present: "it's on the Senate floor calendar", "the Senate is deciding
 * whether to bring it to a vote", "this bill is in the Senate's hands right
 * now — your senators are the live call." A placement is a one-time EVENT. It
 * does not renew itself, and after a few weeks of silence the present tense is
 * the only false word in an otherwise accurate sentence.
 *
 * MEASURED ON THE COMMITTED CORPUS, 2026-08-12 (re-measured after #210 purged
 * the corpus's only two previous-Congress records): of 348 floor_vote bills,
 * 322 carry a dated calendar placement and 305 of those placements are outside
 * the 14-day window — a median age of 140 days, a maximum of 553 (s-347-119,
 * placed on the Senate calendar 2025-02-05). Six more carry pending-but-aged
 * floor motions. So the stepper's live-floor copy and the rail's live-call
 * routing were, on 311 of 348 bills, claims their own printed date refuted.
 *
 * PR #198 gave exactly this clock to the bill page's full-bleed green panel
 * and stopped there — one render site. The derivation underneath it kept
 * answering "on the floor calendar, right now" to everyone else who asked,
 * which is how the same page could drop the loud panel and still print the
 * loud sentence three lines further down. The clock belongs here, where the
 * question is answered once.
 *
 * WHAT DEMOTION MEANS, AND WHAT IT DOES NOT. The FACT survives; only the tense
 * moves. An aged placement still sits at its calendar step, still names the
 * chamber the record named, still says it was placed on that chamber's
 * calendar — it simply also says the record has shown nothing since
 * (`nowFloorStale`). Nothing is hidden, nothing is greyed out, and the call
 * apparatus is untouched: liveCallTarget returning null only stops the rail
 * from REORDERING the offices and printing "your senators are the live call",
 * exactly as it already does for every committee-stage bill. Every dial, the
 * script, and the call dialog stay where they are, which is what funnel
 * invariant I2 pins.
 *
 * statusKeyFor is clocked TOO, as of the same ruling's second pass (N3,
 * 2026-08-11) — see its own header for the shape the demotion takes there,
 * which is a THIRD key rather than a silenced one.
 *
 * THE PASSAGE BRANCH IS CLOCKED IN THE STEPPER ONLY, as of the ruling's third
 * pass (N5, 2026-08-12) — and the asymmetry is the whole design, so read it
 * before changing either half:
 *
 *   liveCallTarget's `passed_chamber` branch is STILL NOT CLOCKED. "The House
 *   has already voted, so the Senate decides next" names a TARGET, and the
 *   target is right at any age: a chamber that voted stays voted, and the
 *   chamber that has not yet acted is still the one that would. #208 declined
 *   to clock it for exactly that reason and this change does not reverse it.
 *   Every dial, the routing sentence, the reordering and the script are
 *   untouched — funnel invariant I2 never sees a different value here.
 *
 *   deriveJourney's `passed_chamber` branch IS clocked, because its sentences
 *   do not name a target, they name a HAPPENING: "it passed the House and now
 *   goes to the Senate", "so it goes back to the House". "now goes to" is a
 *   claim about this week, and on 2026-08-12 it was being made over 280 of the
 *   corpus's 295 passage records — median 120 days, oldest hr-30-119 at 573
 *   days (last action 2025-01-17, "Received in the Senate and Read twice and
 *   referred to the Committee…"). The dishonesty flagged in #208's own
 *   follow-up note was never the target; it was the implied LIVENESS, and the
 *   liveness lives in this sentence alone.
 *
 * ONLY THE TWO STAGES THAT NAME A NEXT CHAMBER ARE CLOCKED — 'first' and
 * 'back', which are exactly the two `passageState` gives a non-null `next`.
 * 'both' ("both chambers have passed it. It goes to the President next.") and
 * 'second' ("the official record doesn't say yet whether the two versions
 * match") name no chamber as deciding, route nowhere already, and say what
 * Article I requires rather than what is about to happen — the same reason
 * `nowFloorMotionFailed` and `nowFloorActivityNeutral` are not clocked either.
 */

/**
 * THE STATUS-LABEL GATE (owner ruling 2026-08-04, Wave B #1; clocked by the
 * owner's N3 ruling, 2026-08-11). The corpus derives `floor_vote` looser than
 * the label "On the floor calendar" claims: 26 of 348 carry cloture/
 * rejected-motion texts, not placements. Every surface that prints a status
 * label routes through this key so the label can never outrun the record —
 * citizen site, embeds and MCP alike — and it now answers THREE keys, not two:
 *
 *   `floor_vote`        a calendar placement, still inside the signal window.
 *                       "On the floor calendar" — present tense, and earned.
 *   `floor_vote_stale`  a calendar placement the record has shown nothing
 *                       since. "Placed on the calendar" — the same specific
 *                       fact, in the past tense the date supports.
 *   `floor_activity`    no placement at all (cloture, a failed procedural
 *                       motion, a Rules resolution). Unchanged, and
 *                       deliberately NOT clocked — see the last paragraph.
 *
 * And a fourth, read before the three (2026-09-29): `rejected`, see "THE
 * REJECTION READING" at the end of this header.
 *
 * WHY THE CLOCK CAME HERE AFTER ALL, AND WHAT THE PREVIOUS HEADER GOT WRONG.
 * This function used to argue itself out of a clock on two grounds, and the
 * owner overruled both:
 *
 *   1. "The key is a CATEGORY, not a sentence — a bill placed on the Union
 *      Calendar in March is still on it in August." True, and beside the
 *      point: "On the floor calendar" is read as a present-tense claim about
 *      where a bill stands THIS WEEK, which is exactly the reading the whole
 *      product is built to deserve. The old argument also assumed the only
 *      available demotion was `floor_activity` — a vaguer label, less
 *      information — and that framing is what made the trade look bad. It was
 *      a false choice. A third key keeps every word of the specific fact and
 *      moves only the tense, so nothing is blurred and nothing is lost.
 *   2. "Every citizen-site surface prints the date beside it." Nearly true,
 *      and the exception was the load-bearing one: the embed card printed the
 *      label alone and its `BillCardData` did not even carry the date. That is
 *      fixed in this same change (N4) rather than flagged again — the card now
 *      carries `lastActionDate` and prints it with the status line. The date
 *      beside a label is a good second signal; it was never a substitute for
 *      the label being true on its own.
 *
 * MEASURED ON THE COMMITTED CORPUS, 2026-08-12T02:46Z, by calling this
 * function over every bill: of 2,700 records, 348 are `floor_vote` and they
 * split 17 `floor_vote` / 305 `floor_vote_stale` / 26 `floor_activity`. So 305
 * bills — 11.3% of the whole corpus — change label with this change, and the
 * aged placements run to a median of 140 days and a maximum of 553 (s-347-119,
 * placed on the Senate calendar 2025-02-05). 0 placements are undated.
 *
 * RECOMPUTE, DON'T TRUST — and note the fresh bucket is genuinely allowed to
 * reach zero. A fortnight in which Congress places nothing on a calendar is a
 * quiet week, not a broken gate, which is why tests/journey.unit.spec.ts
 * asserts ranges here and never a count.
 *
 * FAIL CLOSED ON THE DATE. An undated or unparseable `last_action_date` is
 * never fresh (isSignalFresh's own rule, and the rule amber has always run
 * on), so a placement we cannot date reads `floor_vote_stale`. The weaker
 * claim is the safe one in both directions.
 *
 * WHAT THE CLOCK IS NOT DOING, carried forward from the header it replaced: it
 * is NOT standing in for a previous-Congress check. A placement from a Congress
 * that has ended is on a calendar that no longer exists, and that class is
 * excluded structurally, one layer up in the corpus — #210 purged the two
 * 118th-Congress records, `offCongressBills()` (scripts/congress-fetch.mjs)
 * drops any a fetch tries to re-add, a force-slug congress check in
 * scripts/sync-bills.mjs refuses them by hand, and scripts/verify-sync.mjs
 * hard-fails the whole nightly run if one is ever committed. Every record this
 * function reads is a current-Congress record (2,700 of 2,700 on 2026-08-12).
 * So this window is measuring one thing only: how long the record has been
 * silent.
 *
 * `floor_activity` IS NOT CLOCKED, and the distinction is the same one #208
 * drew in the rail: a placement is an EVENT that ages, while "floor activity"
 * is already a tenseless description of what the record contains. There is
 * nothing to demote it to and nothing present-tense in it to demote. Aged
 * pending motions therefore keep today's label here, and the rail — not this
 * label — carries their tense.
 *
 * THE DESIGN LAW THAT GOVERNS THE NEW KEY: stale is INK, never amber. The
 * colour law spends `urgent` on ONE DATED FLOOR FACT with the date printed
 * beside it, and `floor_vote_stale` is by construction the case where that
 * fact has aged out. No surface may give this key the amber/urgent treatment.
 * MomentVehicleCard's chip gate reads `statusKey === 'floor_vote'` and so
 * excludes it by construction; the embed card has no amber at all.
 *
 * `now` is injectable for the same reason effectiveUrgency's is: the corpus
 * sweeps in tests/journey.unit.spec.ts must evaluate this and the .mjs twin at
 * ONE instant, or a sweep that straddles midnight UTC can disagree with itself.
 * Every production caller takes the default.
 *
 * THE PASSAGE READINGS (2026-09-29). `passed_chamber` printed "Passed one
 * chamber" on every record the status covers, and on two shapes that is
 * false, because the SECOND chamber has acted too:
 *
 *   `adopted`      a concurrent resolution both chambers agreed to in one form
 *                  (lib/floor-text.mjs `concurrentAdoptedBy`): H.Con.Res. 86,
 *                  agreed to by the House 215–208 on 2026-06-03 and by the
 *                  Senate "without amendment" 50–48 on 2026-06-23. It goes to
 *                  no president, so its path has ended. "Adopted by both
 *                  chambers".
 *   `passed_both`  a bill or joint resolution the second chamber passed
 *                  without amendment (`passageState` stage 'both' — H.R. 4467,
 *                  "Passed Senate without amendment by Unanimous Consent.").
 *                  It goes to the president next. "Passed both chambers".
 *
 * Both are read by the SAME readers the stepper reads (deriveJourney's
 * `nowAdoptedBoth` and `nowPassedBoth`), so the label and the "Right now:"
 * sentence cannot disagree. That is why this takes the bill, not three
 * fields: the passage readers need the bill type and the status basis
 * (`status_basis_text`, which "Message on Senate action sent to the House."
 * writes over). Not clocked: both are durable facts about votes that
 * happened, like the rail's passage routing ("THE THIRD GATE" above).
 *
 *   `passed_both` also covers a second-chamber passage whose amendment
 *                  clause the record does not give (`passageState` 'second' —
 *                  four Senate bills and S.Con.Res. 29 the House passed, on
 *                  2026-09-29). Both chambers DID pass it, so "Passed one
 *                  chamber" was false; the stepper's `nowPassedSecond` says the
 *                  record doesn't show yet whether the two versions match, so
 *                  the chip claims only what the record shows.
 *
 * NOT READ, stated rather than guessed at: a measure the second chamber
 * passed WITH amendments ('back'; none in the corpus on 2026-09-29). It keeps
 * `passed_chamber`.
 *
 * THE REJECTION READING (2026-09-29). A `floor_vote` record whose own
 * sentence says the chamber voted the measure down on passage or adoption
 * ("Failed of passage in Senate by Yea-Nay Vote. 49 - 50." — H.Con.Res. 89)
 * printed "Floor activity" beside a call panel that said "No call to make"
 * and a "Right now:" sentence that said "the Senate voted on it and rejected
 * it, 49–50". It now reads `rejected` ("Rejected", the word lib/status-word.ts
 * already printed for the same record on Big Question rows and member pages).
 *
 * WHICH RECORDS: exactly the ones settledDecision calls `rejected`, read off
 * the same stepper derivation, so the chip, the stepper and the panel cannot
 * disagree. That is docs/record-truth.md §7's "failed final vote", and nothing
 * wider. Every failed PROCEDURAL vote keeps `floor_activity`, as §7 rules for
 * the call panel: a failed motion to proceed, cloture not invoked, a rejected
 * motion to discharge, a failed two-thirds vote under suspension of the
 * House's rules, and a failed vote with a motion to reconsider entered. None
 * of those is the chamber's final answer on the measure. Not clocked: a vote
 * that happened does not go stale.
 *
 * scripts/moment-candidates.mjs carries an import-free copy of this function
 * (it reads the passage readings only when its caller hands it the bill);
 * tests/journey.unit.spec.ts pins the two corpus-wide at a shared `now`.
 */
export type StatusKeyBill = Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'> & Basis;

export function statusKeyFor(bill: StatusKeyBill, now: number = Date.now()): StatusLabelKey {
  const { status } = bill;
  if (status === 'passed_chamber') {
    if (concurrentAdoptedBy(bill)) return 'adopted';
    const { stage } = passageState(bill);
    return stage === 'both' || stage === 'second' ? 'passed_both' : 'passed_chamber';
  }
  if (status !== 'floor_vote') return status;
  if (settledDecision(bill)?.kind === 'rejected') return 'rejected';
  if (!floorCalendarChamber(bill.last_action_text)) return 'floor_activity';
  return isSignalFresh(bill.last_action_date, now) ? 'floor_vote' : 'floor_vote_stale';
}

/**
 * WHICH DATED FLOOR FACT THE BILL PAGE'S GREEN BAND STANDS ON — the page's
 * whole gate, in one pure function, so it can be pinned with fixtures instead
 * of only observed on whatever the corpus happens to hold today.
 *
 * THE SEAM THIS CLOSED (2026-08-12). The bill page hard-gated its band on
 * `status === 'floor_vote'` and never looked at the chamber's own schedule, so
 * an ANNOUNCED bill — the T0 rung, the chamber naming a measure for floor
 * action in its own published words — wore the crown on the homepage and then
 * showed no band at all on its own page one click later. That is not an edge
 * case: `committee` is the normal derived status of a measure in the middle of
 * passing, because Congress overwrites `last_action_text` the moment a bill
 * reaches the floor ("Message on Senate action sent to the House."), which is
 * the entire reason ruling V1 exempted `announced` from the status gate. It is
 * the same seam class #207 closed for `pending`, and the general lesson is the
 * one the crown's own header states: two surfaces reading one record must run
 * one gate, not two hand-kept copies of it.
 *
 * THE ANNOUNCEMENT IS PASSED IN, ALREADY GATED — this module holds no data
 * import and no clock of the schedule's own. The caller resolves it through
 * lib/docket.ts (`rungFor` → `rung.announced`, which is terminal-first and
 * `signalIsLive`-gated: a signed law is never announced, and a bill the chamber
 * pulls stops being announced within the hour). Pass null and this function
 * behaves exactly as the page did before the seam was closed.
 *
 * ORDER, AND WHY THE RECORD HALF IS UNTOUCHED: `announced` outranks both record
 * facts, exactly as the ladder ranks T0 over T1/T2 and the crown ranks its
 * kinds. Below it, the page's existing preference stands — a placement is the
 * plainer claim and wins its (near-impossible) tie with a pending motion. That
 * tie is decided the other way in `selectFloorVoteFeature`, where the question
 * is which of MANY bills to crown rather than which sentence to print about
 * ONE; the two only disagree on a record that states both facts at once, which
 * the corpus holds no example of.
 */
export type FloorBandKind = 'announced' | 'calendar' | 'pending';

export interface FloorBand {
  kind: FloorBandKind;
  chamber: Chamber;
  /** The date the band's chip prints — the ANNOUNCEMENT's own publication day
   *  on `announced`, the bill's own action date otherwise. Never a vote date:
   *  neither the corpus nor the schedule carries one. */
  date: string;
  /** THE CHAMBER IS NOT MEETING, so the record fact this band stands on cannot
   *  become a vote today. The band is still RETURNED — see the note on
   *  `floorFactSuspended` for why the alternative (returning null) would break
   *  the status label this same result derives. */
  suspended: boolean;
}

/** The ONE session vocabulary, re-exported so a design primitive can name it
 *  without importing lib/docket (which reads data/floor-signals.json). */
export type { ChamberSession };

/**
 * IS THIS FLOOR FACT SUSPENDED BY THE CHAMBER NOT MEETING? (owner rulings
 * D1+D2, 2026-08-15.)
 *
 * The two record facts — a calendar PLACEMENT and a PENDING motion — are both
 * claims that something can happen next. Both are read out of the bill's own
 * record and neither knows whether the chamber is in the building: through a
 * district work period the record simply stops moving, so a cloture motion
 * filed the day before the chambers went out keeps clearing the 14-day signal
 * window and keeps asserting, in the present tense, that a vote is still ahead
 * of it *now*. It is not; nothing is ahead of anything until the chamber
 * meets. So an amber surface additionally requires the chamber to be meeting.
 *
 * `announced` IS EXEMPT BY CONSTRUCTION, and the exemption lives in this
 * function's `kind` clause rather than in caller discipline: a chamber that
 * published a schedule NAMING THIS BILL is, by the act of publishing it,
 * meeting. Reading a session verdict over that fact could only ever subtract a
 * bill from the loudest surface on the strength of a second document
 * disagreeing with the first one's own words.
 *
 * FAIL-SAFE, IN THE DIRECTION THAT KEEPS AMBER. `unknown` — a stale file, a
 * dead workflow, a digest that stopped parsing — returns false for every kind.
 * A pipeline that has gone dark must never be able to suppress a true floor
 * claim; the same rule lib/docket.ts's `chamberSession` header states from the
 * other end.
 */
export function floorFactSuspended(kind: FloorBandKind, session: ChamberSession): boolean {
  if (kind === 'announced') return false;
  return session === 'out_of_session';
}

/**
 * `sessionOf` is the fourth argument and the LAST one, so every existing call
 * site keeps its meaning: omit it and `suspended` is false on every band, which
 * is byte-for-byte the behavior this function had before the session gate
 * existed. It is a resolver rather than a data read for the same reason
 * `announcement` is passed in — this module holds no data import.
 *
 * IT RETURNS THE BAND, NEVER NULL, WHEN THE FACT IS SUSPENDED. The bill page's
 * status label is derived from this same result (`FLOOR_COPY[kind][chamber]
 * .status` → "Floor vote pending"), so a null here would silently regress that
 * label to the weaker shared key "Floor activity" — the exact seam #207 closed.
 * The band and the label are two different claims about one record: the label
 * says what the record IS, which a recess does not change, and the band says
 * what is happening on the floor, which is what stops. The caller reads
 * `suspended` and swaps the loud band for the ruled note; nothing else moves.
 */
export function billFloorBand(
  bill: {
    status: Bill['status'];
    last_action_text?: string | null;
    last_action_date?: string | null;
    status_basis_text?: string | null;
  },
  announcement: { chamber: Chamber; published: string } | null,
  now: number = Date.now(),
  sessionOf?: (chamber: Chamber) => ChamberSession
): FloorBand | null {
  const suspendedFor = (kind: FloorBandKind, chamber: Chamber): boolean =>
    sessionOf ? floorFactSuspended(kind, sessionOf(chamber)) : false;
  if (announcement) {
    return {
      kind: 'announced',
      chamber: announcement.chamber,
      date: announcement.published,
      // Routed through the same function as the record facts on purpose: the
      // announced exemption is a RULE, held in one place, not a branch a caller
      // could forget to take.
      suspended: suspendedFor('announced', announcement.chamber),
    };
  }
  const date = bill.last_action_date ?? null;
  if (bill.status !== 'floor_vote' || !date || !isSignalFresh(date, now)) return null;
  const record = statusBasisText(bill);
  const calendar = floorCalendarChamber(record);
  const pending = calendar ? null : floorPendingChamber(record);
  const chamber = calendar ?? pending;
  if (!chamber) return null;
  const kind: FloorBandKind = calendar ? 'calendar' : 'pending';
  return { kind, chamber, date, suspended: suspendedFor(kind, chamber) };
}

/**
 * Where the live decision sits, for the rep list to route on.
 *
 * TWO BOOLEANS, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE POINT.
 *
 * `afterVote` is RELATIONAL: it says the OTHER chamber has already had its
 * turn. Every one of the four bill routing keys is relational in exactly that
 * way — "the House has already voted, the Senate decides next" only means
 * anything because both chambers get a turn on a bill.
 *
 * `soleChamber` is NON-RELATIONAL: the other chamber has no vote on this
 * object AT ALL. Not "not yet" — not ever. On a nomination the House never
 * gets a turn (VOTING_CHAMBERS above, Article II §2 cl. 2), so every
 * relational sentence is false about it forever, and a fifth relational
 * branch would have been a fifth way to imply a House turn that is not
 * coming. Hence a third field rather than a fifth branch.
 *
 * Every BILL caller gets `soleChamber: false`, so the four relational keys
 * are untouched — tests/journey.unit.spec.ts asserts that on every bill case
 * it already pinned, which is the regression guard on this field.
 */
export interface LiveCallTarget {
  chamber: Chamber;
  /** RELATIONAL: the other chamber has already had its turn. */
  afterVote: boolean;
  /** NON-RELATIONAL: the other chamber has no vote on this object at all —
   *  not "not yet". True only for nominations. */
  soleChamber: boolean;
}

/**
 * CHAMBER-AWARE CALL ROUTING (2026-08). Answers ONE question for the rep
 * list: whose phone is the live decision right now?
 *
 * Deliberately narrower than deriveJourney — it returns non-null ONLY where
 * the record itself places the bill in a chamber's hands TODAY:
 *
 *   floor_vote with a readable chamber → that chamber (the record's own
 *     sentence), afterVote=false.
 *   passed_chamber → the OTHER chamber (corpus-verified: these actions read
 *     "Received in the Senate…"), afterVote=true — "the House has already
 *     voted; your senators are the live call."
 *
 * Everything else is null and the rep list renders exactly as before:
 * committee/markup/introduced (a committee holds it, not a floor — demoting
 * senators on every committee-stage House bill would re-shape most of the
 * corpus on a weaker claim), conference (both chambers again), signed
 * (Congress is done), vetoed (an override needs two-thirds of BOTH chambers,
 * so neither one is the live call), and the unclassifiable floor texts (NEVER
 * guess a chamber — owner ruling 2026-08-04). Demote, never bury: consumers
 * reorder and annotate; no office ever loses its dial.
 */
/**
 * WHICH PASSAGE IS THIS — the four states `passed_chamber` collapses into,
 * and the reason a bill type can no longer answer for them.
 *
 *   'first'  the ORIGINATING chamber passed it; the other chamber is next.
 *            250 of the corpus's 274 passed_chamber records ("Received in the
 *            Senate.", "Held at the desk.") plus the 18 that report the
 *            origin chamber's own passage.
 *   'back'   the SECOND chamber passed it WITH CHANGES, so it returns to the
 *            originating chamber to concur before it can go anywhere.
 *   'both'   the second chamber passed it WITHOUT amendment. The two chambers
 *            hold identical text, Congress is finished, and the next signature
 *            is the President's. NO chamber is a live call.
 *   'second' the second chamber passed it and the sentence does not say
 *            whether it was amended. We know both chambers have acted and
 *            nothing more, so we claim nothing more.
 *
 * WHAT THIS REPLACED, AND WHY IT WAS WRONG. liveCallTarget derived the target
 * chamber from `bill_type` alone: an `hr` bill routed to the Senate, always.
 * That is a statement about where a bill STARTED masquerading as one about
 * where it stands. H.R. 1276's last action on 2026-08-07 reads "Passed Senate
 * without amendment by Unanimous Consent." — both chambers were done with it —
 * and the page still printed "The House has already voted on this bill — the
 * Senate decides next. Your senators are the live call." in the rail and in
 * the call dialog, in both languages. Six corpus records passed by the second
 * chamber were being described by the type of the paper they were written on;
 * on the two amended ones (H.R. 6500, H.R. 5334) the named chamber was not
 * merely stale but exactly backwards — the Senate had acted and the HOUSE held
 * the next decision.
 *
 * FAIL-CLOSED, the same discipline as floorPendingChamber. Only a sentence
 * that OPENS with Congress's own passage boilerplate is read at all; anything
 * else returns 'first' and keeps the corpus-verified default that 250 records
 * depend on. And a second-chamber passage whose amendment clause we cannot
 * read returns 'second' — never 'both' — because "it goes to the President"
 * and "it goes back to the House" are opposite claims and guessing between
 * them is how this defect happened the first time. Every one of the 24 real
 * passage sentences carries "without amendment", "with an amendment(s)", or
 * "with an amendment and an amendment to the Title", so no PASSAGE sentence
 * reaches 'second'. Since 2026-09-24 the second-chamber "Message on {chamber}
 * action sent to the {other}." notice does (see the message read below): it
 * names the acting chamber and never the amendment.
 */
export type PassageStage = 'first' | 'back' | 'both' | 'second';

export interface PassageState {
  stage: PassageStage;
  /** The chamber whose passage the last action reports, when it says. */
  passedBy: Chamber | null;
  /** The chamber that must act next — null when no chamber does. */
  next: Chamber | null;
}

/*
 * THE BODY LIVES IN lib/floor-text.mjs since 2026-09-24 (unchanged — same
 * regexes, same order), because scripts/moment-watch.mjs now diffs the Big
 * Questions status lines under plain node and needs the same reading. The
 * header above still describes it; the types above still name its shape.
 */
export function passageState(
  bill: Pick<Bill, 'bill_type' | 'last_action_text'> & Basis
): PassageState {
  return passageStateMjs(bill);
}

/**
 * THE CHAMBER'S OWN SCHEDULE, AS A ROUTING SOURCE (2026-09-27 audit, SY-06).
 *
 * THE SEAM. The bill page's green band has read the T0 announcement since
 * 2026-08-12 (`billFloorBand` above), and the rail never did: routing read the
 * bill's record alone. So on S. 4668 — the one measure the Senate's own
 * program named for its next meeting ("Senate will resume consideration of
 * S. 4668 … post-cloture") — the header said "On the floor schedule" and the
 * panel one screen down listed the reader's House member FIRST, with no line
 * saying the senators were the live call. The record half returned null
 * because Congress had overwritten the last action with a procedural step
 * that names no chamber ("The committee substitute tabled by Voice Vote."),
 * which is the exact reason the band learned to read the schedule in the
 * first place. Two surfaces reading one bill now run one fact.
 *
 * THE ANNOUNCEMENT IS PASSED IN, ALREADY GATED — the same contract
 * `billFloorBand` states. This module holds no data import and no clock of the
 * schedule's own; the caller resolves it through lib/docket.ts (`rungFor` →
 * `rung.announced`), which is terminal-first, `signalIsLive`-gated (a pulled
 * bill stops being announced within the hour, a dead workflow within
 * SIGNAL_STALE_HOURS, a covered meeting a few days after it), and retired by
 * `announcementAnswered` the moment the record shows the announcing chamber
 * has voted.
 *
 * TWO MORE GATES HERE, and both only ever SUBTRACT a routing claim:
 *
 *   1. DATED. The announcement's own publication day must be a real
 *      YYYY-MM-DD. The band prints that date beside the chamber's quote; a
 *      routing sentence may not stand on a fact that cannot be dated.
 *   2. MEETING. The announcing chamber's session verdict must be
 *      `in_session` (lib/docket.ts `chamberSession`, read out of the Daily
 *      Digest's own "Program for" blocks). `out_of_session` is the digest
 *      saying the chamber is gaveling in and out; `unknown` is us not being
 *      able to say. Both return null here, which is stricter than the band:
 *      `floorFactSuspended` exempts `announced` because a published schedule
 *      is itself evidence of a sitting, and that is the right rule for a
 *      label that quotes the schedule. "Your senators are the live call" is
 *      a stronger sentence than the quote, so it waits for the stronger
 *      evidence. The cost of that asymmetry is the quiet path every
 *      committee-stage bill already takes — no reordering, no sentence, every
 *      dial and the script untouched — never a false claim.
 *
 * NEVER A NOMINATION. The bill ladder's signals and the Senate's nominations
 * are separate maps in data/floor-signals.json by construction (owner ruling
 * V3), `floorSignalFor` reads only the first, and the target built here is
 * relational (`soleChamber: false`) — so nothing on this path can ever print
 * the nomination framing, and a House announcement only ever speaks about a
 * bill the House votes on.
 */
export interface RoutingAnnouncement {
  chamber: Chamber;
  /** The announcing document's own date (`FloorSignalTier0.published`). */
  published: string;
  /** The announcing chamber's session verdict, as `chamberSession` answers it. */
  session: ChamberSession;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function announcedCallTarget(
  announcement: RoutingAnnouncement | null | undefined
): LiveCallTarget | null {
  if (!announcement) return null;
  const { chamber, published, session } = announcement;
  if (chamber !== 'house' && chamber !== 'senate') return null;
  if (typeof published !== 'string' || !ISO_DAY.test(published)) return null;
  if (!Number.isFinite(Date.parse(`${published}T00:00:00Z`))) return null;
  if (session !== 'in_session') return null;
  // `afterVote: false`: a schedule says who acts NEXT, never that the other
  // chamber has already had its turn. The record says that, when it does —
  // see the same-chamber merge in liveCallTarget below.
  return { chamber, afterVote: false, soleChamber: false };
}

/**
 * `announcement` is the SECOND argument and optional, so every existing caller
 * keeps its meaning exactly: omit it (or pass null) and this returns
 * byte-for-byte what the record half always returned. The page passes the T0
 * announcement it already resolved for the band.
 *
 * ORDER, WHEN BOTH SPEAK. The announcement names the chamber — it is the
 * chamber's own statement about this week, and it outranks the record exactly
 * as the ladder ranks T0 over T1–T3 and the band ranks `announced` over both
 * record facts. When the record names the SAME chamber, the record's reading
 * is returned instead, because it can carry the one thing a schedule cannot:
 * `afterVote` ("the House has already voted on this bill — the Senate decides
 * next"). When the record names the OTHER chamber, the schedule wins: an
 * unclocked passage months old ("Received in the Senate.") cannot outvote the
 * House's own program for this week, and the band on the same page is already
 * quoting that program.
 *
 * A SETTLED BILL IGNORES ANY ANNOUNCEMENT. `rungFor` is terminal-first and
 * never hands a signed or vetoed bill an announcement, so this is belt and
 * braces rather than the gate — but "a settled decision shows no call
 * apparatus" is a promise about THIS function's output, and it should hold
 * whatever a future caller passes in.
 */
export function liveCallTarget(
  bill: Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'> & Basis,
  announcement: RoutingAnnouncement | null = null
): LiveCallTarget | null {
  const record = recordCallTarget(bill);
  if (TERMINAL_STATUSES.has(bill.status)) return record;
  const announced = announcedCallTarget(announcement);
  if (!announced) return record;
  if (record && record.chamber === announced.chamber) return record;
  return announced;
}

/** The record half — where the bill's OWN last action places the live
 *  decision. Unchanged from the body `liveCallTarget` carried before the
 *  announcement could reach it; every header above still describes it. */
function recordCallTarget(
  bill: Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'> & Basis
): LiveCallTarget | null {
  if (bill.status === 'floor_vote') {
    /*
     * THE CLOCK, before any sentence is read (owner ruling 2026-08-11 — see
     * "THE THIRD GATE" above). Everything this branch can return prints "this
     * bill is in the {chamber}'s hands right now", and on 2026-08-12 that
     * sentence was routing off 305 placements and 6 motions older than the
     * 14-day window — median 140 days, up to a placement dated 2025-02-05, 553
     * days old. An undated floor record is never fresh, which is the same rule
     * the amber gate has always run on.
     *
     * DEMOTE, NEVER BURY: null here does not remove a single dial. It is the
     * quiet path every committee-stage bill already takes — the rep list
     * renders in its ordinary order with no routing sentence over it, the call
     * script and the call dialog are untouched, and funnel invariant I2 (a
     * completed script within 2 interactions) never sees this value.
     *
     * `passed_chamber` below is deliberately NOT clocked, and the owner's N5
     * ruling (2026-08-12) CONFIRMED that rather than reversing it. "The House
     * has already voted" is a durable relational fact about a vote that
     * happened, not a claim about this week, and 280 of the corpus's 295
     * passage records are outside the window (2026-08-12) — clocking it would
     * silence that routing entirely, on a much weaker argument. What the
     * ruling changed is the STEPPER's sentence, which claimed the handoff was
     * happening now; see deriveJourney's passed_chamber case and "THE THIRD
     * GATE" above. Target here, tense there.
     */
    if (!isSignalFresh(bill.last_action_date)) return null;
    // floorPendingChamber, NOT floorActionChamber. This is the strongest
    // sentence on the page — "this bill is in the Senate's hands right now" —
    // and floorActionChamber only ever knew WHICH chamber the sentence was
    // about, never whether that chamber still had a decision to make. It
    // therefore handed the live-call line to all 18 of the corpus's settled
    // texts: S.J.Res. 103's own record says the motion to proceed was
    // rejected 48–50 on 2026-03-25, and the rail called it live. A settled or
    // unreadable text now falls through to null and the panel renders its
    // ordinary who-to-call framing — the same quiet path a committee-stage
    // bill has always taken.
    const chamber =
      floorCalendarChamber(statusBasisText(bill)) ?? floorPendingChamber(statusBasisText(bill));
    return chamber ? { chamber, afterVote: false, soleChamber: false } : null;
  }
  if (bill.status === 'passed_chamber') {
    // `afterVote` stays true for every routed passage: in 'first' the
    // originating chamber has voted, in 'back' the second chamber has. Both
    // are the relational claim the copy makes ("the {other} has already
    // voted"). 'both' and 'second' route nowhere — see passageState.
    const { next } = passageState(bill);
    return next ? { chamber: next, afterVote: true, soleChamber: false } : null;
  }
  return null;
}

/**
 * THE SAME QUESTION, ASKED OF A NOMINATION — and it has only one answer.
 *
 * A bill's routing has to be read out of the record because a bill can be in
 * either chamber's hands. A nomination cannot: advice and consent is the
 * Senate's alone from the moment the President sends it until it is
 * confirmed, returned, or withdrawn. So this function derives NOTHING about
 * the chamber — the chamber is the shape of the power, not an observation —
 * and the only thing it has to decide is whether the nomination is still
 * live.
 *
 * WHY EVERY LIVE STAGE ROUTES, INCLUDING COMMITTEE. liveCallTarget above
 * returns null for a bill in committee, because routing a committee-stage
 * bill to a chamber would demote the OTHER chamber's offices on a claim the
 * record does not support. There is no other chamber here. `received`,
 * `hearing` and `reported` are all Senate committee stages, and naming the
 * Senate at those stages is not a guess about which chamber is acting — it is
 * the only chamber there is. `afterVote` is false at every stage for the same
 * structural reason: there is no prior chamber vote to be after.
 *
 * WHY `unclassified` ROUTES NOWHERE. lib/nomination-status.mjs returns it
 * when no rule matches the Senate's own sentence, and its header is explicit
 * that reaching that branch is honest while guessing past it is a lie. An
 * unmatched sentence may well be a thirty-fourth shape that means the
 * nomination is FINISHED; calling it a live Senate call would be the
 * manufactured urgency this product refuses. Null, and the rep list renders
 * exactly as it always has.
 *
 * TERMINAL statuses (confirmed / returned / withdrawn) route nowhere for the
 * plain reason that nothing a caller says can move them.
 *
 * The switch enumerates the LIVE statuses and defaults to null — never the
 * other way round. lib/nomination-status.mjs's own header says the Senate is
 * free to invent a thirty-fourth action shape tomorrow, and when the
 * vocabulary grows, a new member must default to NO routing claim rather than
 * silently inheriting "your senators are the live call". The list is
 * enumerated here rather than imported from the .mjs so this module keeps its
 * import-free-at-runtime posture; tests/journey.unit.spec.ts pins the two
 * against each other over NOMINATION_STATUSES so they cannot drift.
 */
export function liveCallTargetForNomination(
  nomination: Pick<Nomination, 'status'>
): LiveCallTarget | null {
  switch (nomination.status) {
    case 'received':
    case 'hearing':
    case 'reported':
    case 'exec_calendar':
    case 'floor':
    case 'scheduled':
      return { chamber: 'senate', afterVote: false, soleChamber: true };
    // confirmed | returned | withdrawn (past advice and consent) and
    // unclassified (the record did not say) — see the header.
    default:
      return null;
  }
}

/*
 * IS A CALL SCRIPT EVER COMING BACK FOR THIS NOMINATION — the predicate that
 * answers what a surface may PROMISE, as distinct from where a call would go.
 *
 * It is app/api/script's nomination branch stated as one expression, so a meta
 * description, a card's button and the route can never answer differently. The
 * route refuses (422 `not_callable`) on exactly these two conditions, in this
 * order, each with its own comment there:
 *
 *   1. liveCallTargetForNomination is null — the record shows no decision the
 *      Senate can still make. That covers confirmed / returned / withdrawn AND
 *      `unclassified`.
 *   2. the record carries no `nominee_description` — Congress.gov's own
 *      sentence is the ONLY thing a nomination script is ever grounded in
 *      (lib/nomination-script.ts's header; there is no decode to fall back on,
 *      by design), and 14 of the 857 civilian records carry none.
 *
 * DELIBERATELY WIDER THAN THE NOMINATION PAGE'S OWN `closed || noScript` PANEL
 * BRANCH, and the whole gap is `unclassified`: that record KEEPS the call rail
 * on purpose (see that page's comment — the route's refusal is the honest
 * answer there, and the rail is the only thing that keeps the refusal state
 * reachable), yet no script can ever arrive in it. So "does the rail render"
 * is not the question a share card or a CTA label is asking. This is.
 *
 * Added 2026-08-06 after the page description promised "…and the call that
 * goes with it" unconditionally, on 686 records where no call script exists.
 */
export function nominationHasCallScript(
  nomination: Pick<Nomination, 'status' | 'nominee_description'>
): boolean {
  return liveCallTargetForNomination(nomination) !== null && !!nomination.nominee_description;
}

/** The message keys a surface may print for a live call target. */
export type LiveCallKey =
  | 'liveSenateFloor'
  | 'liveHouseFloor'
  | 'liveSenateAfterHouse'
  | 'liveHouseAfterSenate'
  | 'liveSenateNomination';

/**
 * THE ROUTING-COPY GATE — the same job statusKeyFor does for status labels:
 * one place where a message key is chosen, so no surface can print a sentence
 * the record (or the reader's own delegation) does not support.
 *
 * `hasSenator` is not a nicety. Every Senate-side sentence in this set is a
 * claim about THE READER'S OWN SENATORS, and six jurisdictions — DC, PR, VI,
 * GU, AS, MP — send a delegate to the House and no senator at all (537 rows
 * in data/legislators.json = 431 seated representatives + 100 senators + 6
 * delegates; 57 DC ZIPs alone in data/zip-districts.json). "Your senators are
 * the live call" is simply false for those readers, and on a NOMINATION it is
 * false in the worst way: the Senate is the only chamber that acts, so the
 * sentence would name the one set of offices that reader does not have while
 * their delegate's dial sits underneath it.
 *
 * THE GATE COVERS ALL FIVE KEYS as of 2026-08-06, and this note replaces the
 * one that deferred it. The four bill keys had shipped ungated since 2026-08:
 * a DC reader on a Senate-held bill was told "your senators are the live call"
 * on every bill page, which is the same defect as the nomination one and
 * strictly larger, since every reader with a ZIP reaches a bill page. It is
 * fixed in the same change as the nomination work because it lives in this
 * function and in components/ActionPanel.tsx — landing it separately would
 * have been a guaranteed conflict in one component for no gain.
 *
 * WHY THE TWO HOUSE KEYS ARE GATED ON `hasSenator` TOO, which reads odd until
 * you check the data: the six jurisdictions with no senator are exactly the six
 * that send a non-voting delegate or resident commissioner. Verified against
 * data/legislators.json on 2026-08-06 — DC, PR, VI, GU, AS and MP each hold
 * zero senators and one House-type member, and no state holds fewer than two
 * senators, so `hasSenator === false` identifies a delegate jurisdiction and
 * nothing else. "Your House member is the live call" names an office with no
 * vote on passage there, so all four relational sentences are false for that
 * reader, for one underlying reason, and one boolean is the honest gate for all
 * of them.
 *
 * WHAT THOSE READERS GET INSTEAD: nothing new, deliberately. `bill.callWhoOne`
 * — "Your delegate is your voice in the House. One call to their office
 * counts." — already renders for exactly this reader (ActionPanel picks it when
 * no senator is in the resolved list) and is the honest who-to-call sentence.
 * The WHEN is not lost either: the journey stepper on the bill page is
 * server-rendered from the record and knows nothing about the ZIP, so the stage
 * still shows. A delegate-specific routing sentence was considered and NOT
 * written, because it would have to make a claim about what a delegate can and
 * cannot vote on — a rule with real exceptions (committee votes, the Committee
 * of the Whole) that this codebase has never verified. Absence is a finding;
 * an unverified constitutional claim in a reader's highest-intent moment is
 * not.
 */
export function liveCallKey(
  target: LiveCallTarget | null,
  reader: { hasSenator: boolean }
): LiveCallKey | null {
  if (!target) return null;
  // The reader gate runs BEFORE the record gate, because it is the stronger
  // claim: every key below names an office, and a sentence about an office the
  // reader does not have is false no matter what the record says.
  if (!reader.hasSenator) return null;
  if (target.soleChamber) return 'liveSenateNomination';
  if (target.chamber === 'senate') {
    return target.afterVote ? 'liveSenateAfterHouse' : 'liveSenateFloor';
  }
  return target.afterVote ? 'liveHouseAfterSenate' : 'liveHouseFloor';
}

/** The message key the stepper's "Right now:" sentence reads. */
export type JourneyNowKey =
  | 'nowIntroduced'
  | 'nowCommittee'
  | 'nowFloor'
  | 'nowFloorStale'
  | 'nowFloorActivity'
  | 'nowFloorActivityStale'
  | 'nowFloorActivityNeutral'
  | 'nowFloorMotionFailed'
  | 'nowFloorSuspensionFailed'
  | 'nowFloorPassageRejected'
  | 'nowFloorClotureInvoked'
  | 'nowPointOfOrderUpheld'
  | 'nowPassed'
  | 'nowPassedStale'
  | 'nowPassedBack'
  | 'nowPassedBackStale'
  | 'nowPassedBoth'
  | 'nowPassedSecond'
  | 'nowAdoptedBoth'
  | 'nowConference'
  | 'nowSigned'
  | 'nowVetoed';

export interface JourneyState {
  /** Index into the five stepper steps: introduced · origin committee ·
   *  origin vote · other chamber · the ending below. */
  step: 0 | 1 | 2 | 3 | 4;
  /** What the fifth step IS for this vehicle — the President's desk, adoption
   *  by both chambers, or ratification by the states. See journeyEnding. */
  ending: JourneyEnding;
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
  /** True only when the record's own sentence says "Placed on … Calendar"
   *  AND that placement is still inside the signal window — i.e. the
   *  present-tense claim "it is on the calendar right now" is defensible.
   *  An aged placement keeps `nowKey: 'nowFloorStale'` (which still names the
   *  placement, in the past tense) and sets this false, so a future reader
   *  cannot re-light an urgency treatment off a two-year-old event. */
  onCalendar: boolean;
  /** WHICH calendar the record named, when it named one — set on the two
   *  placement keys (`nowFloor` / `nowFloorStale`) and null everywhere else.
   *  Read by components/BillJourney.tsx to decide which glossary entry the
   *  placement phrase links to, and to link nothing when the record said
   *  "House Calendar" (there is no glossary entry for that one yet). */
  floorCalendar: FloorCalendar | null;
  isLaw: boolean;
  isVetoed: boolean;
  /** True only when a chamber voted the measure down on passage or adoption
   *  and no motion to reconsider is entered — exactly settledDecision's
   *  `rejected` (2026-09-29). The stepper then marks `step` as where the
   *  path ended, with `date`, and the steps after it as not reached. A failed
   *  procedural vote never sets it. */
  isRejected: boolean;
  /** Whether the "changes send it back" trailer is still ahead. */
  showTrailer: boolean;
  /** The recorded vote the `nowKey` sentence cites, read out of the record's
   *  own sentence (lib/floor-text.mjs recordedTally) — set ONLY on
   *  `nowFloorPassageRejected`, `nowFloorSuspensionFailed`,
   *  `nowFloorClotureInvoked` and `nowPointOfOrderUpheld`, and null wherever
   *  the record carries no tally (a voice vote) or the numbers would mislead
   *  (see those branches). Never computed, never looked up. */
  tally: { yeas: number; nays: number } | null;
  /** The record's own date (YYYY-MM-DD) for the sentence the `nowKey`
   *  sentence cites — set ONLY on `nowPointOfOrderUpheld`, the one "Right
   *  now:" sentence that prints a date, and on a rejected measure
   *  (`isRejected`), where the stepper prints it on the step the path ended
   *  at; null there too when the record gives none (lib/settled-votes.ts
   *  `settledDecisionDate`: never another action's date). Formatted by
   *  components/BillJourney.tsx. */
  date: string | null;
}

/**
 * A FAILED TWO-THIRDS VOTE TO PASS THE MEASURE — the House's suspension track,
 * whose vote is on passing the measure itself ("On motion to suspend the rules
 * and pass the bill Failed by the Yeas and Nays: (2/3 required): 264 - 133
 * (Roll no. 72)." — S. 2503). lib/floor-text.mjs keeps it off
 * FLOOR_PASSAGE_REJECTED (that constant's header says why: it is a motion, a
 * majority often voted yes, and the House can still take the measure up under
 * a rule), so it is not a finished decision. Since 2026-09-29 the stepper
 * gives it its own sentence, `nowFloorSuspensionFailed`, instead of the
 * failed-motion one, which said "has not agreed to take it up" about a vote
 * the House did take.
 *
 * Only the vote to pass (or, for a resolution, to agree to it). A failed
 * suspension motion to concur in the other chamber's amendment is a different
 * question and stays on the failed-motion side; no record in the corpus has
 * that shape on 2026-09-29.
 */
const SUSPENSION_PASSAGE_FAILED = /\bmotion to suspend the rules and (?:pass|agree to)\b[\s\S]*?\bfailed\b/i;

/**
 * A POINT OF ORDER AGAINST THE MEASURE, UPHELD — and the chamber that upheld
 * it, read out of the same sentence (2026-09-29, S.J.Res. 98).
 *
 * S.J.Res. 98's last action, verbatim (Congress.gov, 119th Congress,
 * 2026-01-14):
 *
 *   "Point of order that the measure is not entitled to expedited procedures
 *    under 50 U.S.C. 1546(a) raised against the measure agreed to in Senate
 *    by Yea-Nay Vote. 50 - 50. Record Vote Number: 9."
 *
 * The Senate never voted on the resolution: it agreed to the POINT OF ORDER,
 * which took the resolution off its expedited track. PR #363 stops the
 * pipeline filing this as `passed_chamber`; at `floor_vote` it fell through to
 * the chamber-free "it's moving on the floor — the official record hasn't
 * said yet which chamber acts next", with "If the House changes it, it goes
 * back to the Senate" after it. Neither is what happened: nothing is moving,
 * the record names the chamber, and the House never received it.
 *
 * WHAT IT READS. lib/floor-text.mjs `procedureEndedConsideration` (#370) is
 * the reading, reused rather than restated. Of its three shapes this sentence
 * is only the first, "Point of order … against the measure … agreed to /
 * sustained / well taken", which is the only one that OPENS with "Point of
 * order" (the other two open with "The motion to …", "Motion to …" or "Table
 * Motion to …"). So an opening check picks out that shape without a second
 * copy of its pattern. A point of order that was NOT agreed to, one against an
 * amendment, or one about the chamber's procedure is not read by
 * procedureEndedConsideration, so it never reaches this sentence.
 *
 * THE CHAMBER comes from the same sentence (floorActionChamber, the
 * attribution every floor reader uses), asked only after the reading above
 * has said what that chamber did. When the sentence names no chamber this
 * returns null and the bill keeps the chamber-free neutral sentence: never a
 * guessed chamber (owner ruling 2026-08-04).
 *
 * NOT READ HERE, stated rather than guessed at: S.J.Res. 124's last action,
 * "The motion to discharge fell when the point of order was well taken."
 * (procedureEndedConsideration's second shape). It names no chamber and no
 * tally, and it does not say what the point of order was raised against; the
 * earlier action that does ("… raised against the measure agreed to in Senate
 * by Yea-Nay Vote. 51 - 47. Record Vote Number: 108.") is not stored with the
 * bill. It keeps the neutral sentence until it has one of its own.
 *
 * @returns the chamber that upheld the point of order, or null.
 */
export function pointOfOrderUpheldChamber(actionText: string | null | undefined): Chamber | null {
  const t = actionText ?? '';
  if (!/^\s*point of order\b/i.test(t)) return null;
  if (!procedureEndedConsideration(t)) return null;
  return floorActionChamber(t);
}

/**
 * The full status → position behavior table. Chamber for committee/markup
 * texts is not reliably derivable from referral text, so those stages stay
 * deliberately conservative (origin chamber). An unmapped status (the JSON
 * is untyped at load) falls back to the committee step — the same defensive
 * default the stepper's old `POSITION[status] ?? 1` carried.
 */
export function deriveJourney(
  bill: Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'> & Basis & {
    /** OPTIONAL, and only ever read by journeyEnding — a joint resolution's
     *  official title is what says whether it is an Article V amendment
     *  proposal headed for the states. Every other field of the derivation
     *  ignores it. Omitted, a joint resolution keeps the ordinary presented
     *  ending, which is the right answer for all but that one class. */
    title?: string | null;
  }
): JourneyState {
  const origin: Chamber = bill.bill_type.startsWith('h') ? 'house' : 'senate';
  const other: Chamber = origin === 'house' ? 'senate' : 'house';
  const base = {
    origin,
    current: origin,
    nowChamber: origin,
    onCalendar: false,
    floorCalendar: null,
    isLaw: false,
    isVetoed: false,
    isRejected: false,
    showTrailer: true,
    tally: null,
    date: null,
    ending: journeyEnding(bill.bill_type, bill.title),
  };
  switch (bill.status) {
    case 'introduced':
      return { ...base, step: 0, nowKey: 'nowIntroduced' };
    case 'committee':
    case 'markup':
      return { ...base, step: 1, nowKey: 'nowCommittee' };
    case 'floor_vote': {
      /*
       * THE CLOCK (owner ruling 2026-08-11 — see "THE THIRD GATE" above).
       * Every sentence this branch can produce is present tense, and the step
       * math below is deliberately NOT gated by it: where a bill stands in the
       * five-step structure is a fact about the record, and an aged placement
       * still stands at its calendar step. Only the TENSE moves — the same
       * discipline the settled-motion split used in #198, where the chamber
       * was right and the verb was the lie.
       */
      const live = isSignalFresh(bill.last_action_date);
      // Every sentence below reads the record the status was read from
      // (statusBasisText) — for a defeated House vote under "Motion to
      // reconsider laid on the table…", that is the defeat, so the settled
      // branch can say so instead of the neutral "moving on the floor".
      const record = statusBasisText(bill);
      const cal = floorCalendarChamber(record);
      if (cal) {
        return {
          ...base,
          step: cal === origin ? 2 : 3,
          current: cal,
          nowChamber: cal,
          // `onCalendar` is the surfaces' urgency permission, not the record's
          // claim — an aged placement is still ON the calendar and the
          // demoted sentence still says so.
          onCalendar: live,
          floorCalendar: floorCalendarName(record),
          nowKey: live ? 'nowFloor' : 'nowFloorStale',
        };
      }
      /*
       * A POINT OF ORDER AGAINST THE MEASURE, UPHELD (2026-09-29, S.J.Res.
       * 98; the reader is pointOfOrderUpheldChamber above). The chamber took
       * the measure up and ended its consideration on that track, so no
       * sentence below fits: it is not a failed motion to take it up, not a
       * vote still ahead, and not a sentence nobody has read.
       *
       * The sentence says what the record says and then that nothing has
       * followed: "the Senate upheld a point of order against it, 50–50, on
       * January 14, 2026. The official record shows nothing new on it
       * since." The tally and the date are the record's own (recordedTally,
       * settledDecisionDate); either one is left out when the record gives
       * none. The tally prints as the record gives it, a tie included: the
       * action sentence says "agreed to … 50 - 50" and nothing more, so this
       * sentence adds nothing about how the tie was decided. The page already
       * shows that from its own record: the "Latest action" line under the
       * stepper quotes the sentence in full, and the vote record below it
       * prints Senate roll call 9 from data/votes.json ("Point of Order Well
       * Taken", with the vice president's tie-breaking vote).
       *
       * No trailer: "if the House changes it, it goes back to the Senate"
       * warns about a step still ahead, and the House never received it. NOT
       * CLOCKED: a dated past-tense sentence cannot go stale.
       *
       * NOT FINISHED. The owner's pick (a) (2026-09-29): "Only a law or a
       * failed final vote counts as finished." A point of order is
       * procedural, so settledDecision returns null here and the call panel
       * stays; lastFailedVote does too (it reads failed motions only).
       */
      const upheldBy = pointOfOrderUpheldChamber(record);
      if (upheldBy) {
        return {
          ...base,
          step: upheldBy === origin ? 2 : 3,
          current: upheldBy,
          nowChamber: upheldBy,
          nowKey: 'nowPointOfOrderUpheld',
          showTrailer: false,
          tally: recordedTally(record),
          date: settledDecisionDate(bill),
        };
      }
      /*
       * SETTLED BEFORE ACTIVE. `nowFloorActivity` says "the {chamber} is
       * deciding whether to bring it to a vote", and until 2026-08-09 every
       * chamber-classifiable floor text got it — including the 18 whose own
       * words report that the deciding already happened and the answer was no.
       * The chamber was never the problem; floorActionChamber reads it
       * correctly off all of them. The tense was. So the settled texts branch
       * out here, keeping the SAME step slot (the bill's position in the
       * five-step structure did not change — only the sentence about it did).
       */
      const settled = floorSettledChamber(record);
      if (settled) {
        /*
         * WHICH KIND OF "NO" (2026-09-27, the 2026-09-27 audit SY-01; owner
         * card a5). The settled branch used to print one sentence for every
         * settled text — "the Senate has not agreed to take it up — the last
         * motion to do so failed" — and on H.Con.Res. 89 that was false: the
         * Senate DID take it up and voted it down, 49–50 ("Failed of passage
         * in Senate by Yea-Nay Vote. 49 - 50."). A rejected passage vote now
         * says so, with the record's own tally. Every failed MOTION (to
         * proceed, to discharge, cloture not invoked) keeps the sentence that
         * was written for it.
         *
         * The trailer goes: "if the Senate changes it, it goes back to the
         * House" is a warning about something still ahead, and nothing is.
         *
         * The tally prints only when it reads the way the sentence does —
         * yeas no more than nays. A measure that needed two-thirds can fail
         * with a majority voting yes; printing "rejected it, 290–140" would be
         * true and misleading, so the numbers are left to the "Latest action"
         * line below the stepper, which quotes the record in full.
         */
        const passage = floorPassageRejectedChamber(record);
        if (passage) {
          const t = recordedTally(record);
          /*
           * THE PATH ENDED HERE (2026-09-29). The stepper used to draw this
           * step as "You are here", with the ending still ahead, beside a
           * panel that said "No call to make". `isRejected` lets it mark the
           * step where the measure was voted down, with the record's own date
           * for that action, and the steps after it as not reached. Same
           * reconsider guard as settledDecision, so the two cannot disagree.
           */
          const ended = !floorReconsiderPendingChamber(record);
          return {
            ...base,
            step: passage === origin ? 2 : 3,
            current: passage,
            nowChamber: passage,
            nowKey: 'nowFloorPassageRejected',
            showTrailer: false,
            tally: t && t.yeas <= t.nays ? t : null,
            isRejected: ended,
            date: ended ? settledDecisionDate(bill) : null,
          };
        }
        /*
         * A FAILED TWO-THIRDS VOTE TO PASS IT (2026-09-29, the owner's pick
         * (a) on the settled-panel follow-up). Until now a failed suspension
         * vote printed the failed-motion sentence, "the House has not agreed
         * to take it up — the last motion to do so failed", and that is false
         * on all three records of that shape: the House DID take the measure
         * up, on a vote to pass it that needed two-thirds, and a majority
         * voted yes (S. 2503: "On motion to suspend the rules and pass the
         * bill Failed by the Yeas and Nays: (2/3 required): 264 - 133"). So
         * the sentence now says what the vote was, with the record's own
         * tally, whichever way it falls: the sentence itself says two-thirds
         * were needed, so a majority voting yes cannot mislead here.
         *
         * The trailer STAYS, as it does on a failed motion: the vote failed
         * under the House's fast-track rules, the measure is still in that
         * chamber's hands, and "if the House changes it, it goes back to the
         * Senate" is still ahead of it.
         */
        if (SUSPENSION_PASSAGE_FAILED.test(record ?? '')) {
          return {
            ...base,
            step: settled === origin ? 2 : 3,
            current: settled,
            nowChamber: settled,
            nowKey: 'nowFloorSuspensionFailed',
            tally: recordedTally(record),
          };
        }
        return {
          ...base,
          step: settled === origin ? 2 : 3,
          current: settled,
          nowChamber: settled,
          nowKey: 'nowFloorMotionFailed',
        };
      }
      /*
       * THE RESIDUAL BRANCH READS floorPendingChamber, NOT floorActionChamber
       * (owner ruling 2026-08-12, N9-A2) — the last place on this page where a
       * sentence could outrun the record.
       *
       * floorActionChamber answers "WHICH chamber does this sentence belong
       * to". It never answers "what did that chamber DO", and it is
       * deliberately permissive: its rule 6 pins a chamber on any floor text
       * that names exactly one. So every chamber-nameable floor sentence used
       * to arrive here and get "the {chamber} is deciding whether to bring it
       * to a vote" — a live-deliberation claim, asserted over a sentence no
       * matcher in this repo has ever read. That is the same defect class #198
       * removed from 18 settled texts (the S.J.Res. 172 case above): the
       * chamber was right and the verb was a fabrication.
       *
       * floorPendingChamber is the fail-closed answer to the question this
       * sentence actually makes: it is an ordered ALLOW-list guarded by
       * FLOOR_SETTLED, so it says "a vote is still ahead, in this chamber"
       * only for shapes somebody has read. Everything else returns null and
       * falls to the chamber-free neutral copy below. That is D4's crown logic
       * ("one missed crown is cheaper than one wrong one") extended from the
       * crown to the stepper, and it is what let the nightly journey-corpus
       * tripwire stop costing a whole night: with no surface able to speak
       * about an unread text, a novel shape is an issue to file, not a run to
       * kill (scripts/check-journey-corpus.mjs).
       *
       * MEASURED BEFORE AND AFTER on the committed corpus, 2026-08-12: of
       * 2,723 bills, 356 are floor_vote and 8 reach this branch — and all 8
       * match floorPendingChamber, so ZERO rendered sentences change today.
       * They are 3 Rules Committee resolutions reported to the House, 2
       * cloture motions presented in the Senate, 2 postponed proceedings, and
       * 1 motion to proceed made in the Senate — one per rule 1-4. The
       * untensed set is empty and the unclassified set is empty. This is a
       * change of what CAN happen, not of what does. Re-measure rather than
       * trust the number: the corpus moves nightly.
       */
      const pending = floorPendingChamber(record);
      // NEVER GUESS A CHAMBER (owner ruling 2026-08-04). An unreadable floor
      // text used to fall back to the ORIGIN chamber — the silent-lie class
      // the whole derivation exists to end. Now it renders the chamber-free
      // key instead: the step math stays at the origin slot (structure needs a
      // position) but no rendered sentence names a chamber the record did not.
      if (pending === null) {
        /*
         * NOT CLOCKED, and the reason is that there is nothing here to demote
         * TO. This branch's sentence names no chamber and no calendar — it
         * says only that the record has not said yet — so a stale variant
         * would be new copy in two languages for a state that is EMPTY on the
         * corpus (0 bills on 2026-08-12, both classes of it: nothing
         * unclassified, nothing chamber-readable-but-untensed). If that ever
         * stops being true, this branch wants its own key, not a reused one.
         */
        return {
          ...base,
          step: 2,
          current: origin,
          nowChamber: origin,
          nowKey: 'nowFloorActivityNeutral',
        };
      }
      /*
       * The same clock as the calendar branch above, for the same reason and
       * one more: `nowFloorActivity` says "the {chamber} is DECIDING whether
       * to bring it to a vote", which is a stronger present-tense claim than
       * the placement sentence, and liveCallTarget has just stopped routing
       * these six aged records (2026-08-11). Leaving the stepper saying "is
       * deciding" while the rail beside it had gone quiet would be the page
       * contradicting itself in a quieter voice — the exact failure the
       * passed_chamber split was written to end.
       *
       * ONE READER, ONE ANSWER: this is the SAME function liveCallTarget gates
       * on (`floorCalendarChamber ?? floorPendingChamber`) and the same one
       * FloorVotePanel's crown gate uses, so the stepper, the rail and the
       * crown can no longer disagree about whether a vote is ahead.
       */
      /*
       * CLOTURE INVOKED ON THE MEASURE (owner card a5, 2026-09-27 — the #304
       * question). floorPendingChamber reads it as a Senate vote still ahead,
       * and that is right; its usual sentence is not. "The Senate is deciding
       * whether to bring it to a vote" is false once the Senate has voted to
       * end debate on the measure itself. So a fresh one gets its own
       * sentence — the Senate voted to end debate, with the record's tally,
       * and the final vote is still ahead — and an aged one takes the same
       * dated past-tense sentence as every other aged floor action.
       */
      if (live && CLOTURE_INVOKED_ON_MEASURE.test(record ?? '')) {
        return {
          ...base,
          step: pending === origin ? 2 : 3,
          current: pending,
          nowChamber: pending,
          nowKey: 'nowFloorClotureInvoked',
          tally: recordedTally(record),
        };
      }
      return {
        ...base,
        step: pending === origin ? 2 : 3,
        current: pending,
        nowChamber: pending,
        nowKey: live ? 'nowFloorActivity' : 'nowFloorActivityStale',
      };
    }
    case 'passed_chamber': {
      /*
       * THE SAME RECORD THE RAIL READS (passageState), because the stepper was
       * telling the same lie three lines further down the page. On H.R. 1276 —
       * "Passed Senate without amendment", both chambers finished — the rail
       * said "the Senate decides next" and the stepper said "it passed the
       * House and now goes to the Senate". Fixing one and leaving the other
       * would have left the page contradicting the record in a quieter voice.
       *
       * `showTrailer` is off for every second-chamber state: the trailer says
       * "if the {other} changes it, it goes back to the {origin}" — a warning
       * about something still ahead. Once the second chamber has acted that is
       * either finished business or the thing that just happened.
       *
       * THE CLOCK, ON THE TENSE ONLY (owner ruling 2026-08-12, N5 — the full
       * argument, including why liveCallTarget's twin branch stays UNCLOCKED,
       * is in "THE THIRD GATE" at the top of this file). The passage itself is
       * durable and survives every demotion below: the step, the chambers and
       * the words "it passed the {chamber}" are identical either way. What
       * moves is the clause that said the handoff was underway — "and now goes
       * to the {other}", "so it goes back to the {chamber}" — which on
       * 2026-08-12 was printed over 280 of 295 passage records, median 120 days
       * old and up to 573. The stale keys replace that clause with the dated
       * silence itself ("the official record shows nothing new since"), which
       * is the same shape #208 gave `nowFloorStale`: absence is a finding.
       *
       * `showTrailer` is NOT touched by the clock. It renders "If the {other}
       * changes it, it goes back to the {origin} before reaching the
       * President" — a conditional statement of what Article I requires, with
       * no tense to demote, true of a passage of any age.
       */
      /*
       * A CONCURRENT RESOLUTION BOTH CHAMBERS AGREED TO IN ONE FORM — the end
       * of its path (2026-09-29; the reader is lib/floor-text.mjs
       * `concurrentAdoptedBy`, #360). passageState answers 'second' for it,
       * because its 'both' sentence says the measure goes to the president
       * next and a concurrent resolution never does. So the stepper printed
       * the 'second' sentence, "the official record doesn't say yet whether
       * the two versions match", over a record that DOES say: H.Con.Res. 86,
       * "Resolution agreed to in Senate without amendment by Yea-Nay Vote.
       * 50 - 48.", after the House's 215–208. Read first, so no other passage
       * reading can speak for it.
       *
       * Step 4, the ending this vehicle has (`bothChambers`: "Adopted by both
       * chambers"), and no trailer: "if the Senate changes it, it goes back"
       * warns about something still ahead, and nothing is. NOT CLOCKED, for
       * the reason 'both' is not: it says what happened and what is left to
       * happen, which is nothing.
       */
      const adoptedBy = concurrentAdoptedBy(bill);
      if (adoptedBy) {
        return {
          ...base,
          step: 4,
          current: adoptedBy,
          nowChamber: adoptedBy,
          nowKey: 'nowAdoptedBoth',
          showTrailer: false,
        };
      }
      const live = isSignalFresh(bill.last_action_date);
      const { stage, passedBy } = passageState(bill);
      if (stage === 'first') {
        // Corpus-verified copy: nearly all passed_chamber actions read
        // "Received in the Senate…" — origin passage, headed to the other
        // chamber — so nowChamber stays origin and current is the other.
        // `current` is NOT clocked for the same reason `step` is not: it is
        // where the record puts the bill, and a quiet fortnight does not move
        // it back across the Capitol.
        return {
          ...base,
          step: 3,
          current: other,
          nowKey: live ? 'nowPassed' : 'nowPassedStale',
        };
      }
      if (stage === 'back') {
        /*
         * Back in the originating chamber's hands to concur in the second
         * chamber's changes. Not step 4: the President is not next, the
         * origin chamber is.
         *
         * `nowChamber` is the DESTINATION (the origin chamber), not the
         * chamber that just acted — the one place in this switch where those
         * differ, and it is forced by how the stepper feeds ICU.
         * BillJourney passes `{ chamber: nowChamber, other }` where `other` is
         * always the opposite of ORIGIN, not of nowChamber. In this state the
         * amending chamber is by definition the non-origin one, so `other`
         * already names it and `chamber` is free to carry the destination.
         * nowPassedBack is written to that shape. Setting nowChamber to
         * `passedBy` here instead renders "the Senate passed it with changes,
         * so it goes back to the Senate."
         *
         * The stale twin keeps the amending chamber and drops the destination
         * clause, because THAT clause is the imminence: `nowPassedBackStale`
         * reads "the {other} passed it with changes, and the official record
         * shows nothing new since." The destination is not lost from the page
         * — the stepper still stands the bill at this step and the rail still
         * routes the call to the origin chamber (liveCallTarget is unclocked
         * here, deliberately).
         */
        return {
          ...base,
          step: 3,
          current: origin,
          nowChamber: origin,
          nowKey: live ? 'nowPassedBack' : 'nowPassedBackStale',
          showTrailer: false,
        };
      }
      if (stage === 'both') {
        // Identical text out of both chambers: the only step left is the desk.
        // NOT CLOCKED (N5): "It goes to the President next" is Article I,
        // Section 7's presentment requirement, not a forecast — it names no
        // chamber as deciding and nothing about it becomes less true with age.
        return {
          ...base,
          step: 4,
          current: passedBy ?? other,
          nowChamber: passedBy ?? other,
          nowKey: 'nowPassedBoth',
          showTrailer: false,
        };
      }
      // 'second' — both chambers have passed it and the record does not say
      // whether the versions match, so the sentence says exactly that and
      // names no next step. Reached by a second-chamber "Message on … action
      // sent to the …" notice (see passageState).
      // NOT CLOCKED (N5), for the same reason `nowFloorActivityNeutral` is
      // not: it already claims only that the record has not said, which is a
      // statement about the record's silence and cannot go stale.
      return {
        ...base,
        step: 3,
        current: passedBy ?? other,
        nowChamber: passedBy ?? other,
        nowKey: 'nowPassedSecond',
        showTrailer: false,
      };
    }
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

/** What the record says ended the decision, in the shape the call panel's
 *  record-only block prints it. Only two things end one (owner, 2026-09-29,
 *  pick (a)): a law, or a failed vote to pass the measure itself — and, for
 *  the one vehicle that never becomes law, its own ending: a concurrent
 *  resolution both chambers agreed to in one form (`chamber` is the SECOND
 *  chamber, whose agreement completed it). */
export type SettledDecision =
  | { kind: 'law' }
  | { kind: 'rejected'; chamber: Chamber; tally: { yeas: number; nays: number } | null }
  | { kind: 'adopted'; chamber: Chamber };

/**
 * NO DECISION LEFT — what the bill page shows where the call panel stands
 * (owner, 2026-09-28, UX question Q9 answered "a": "A record-only block with
 * no numbers: 'This is law' or 'This was rejected, 49–50', and how your
 * members voted. No stance, no script.").
 *
 * WHICH RECORDS COUNT AS FINISHED (owner, 2026-09-29, reviewing the
 * settled-panel follow-up, artifact 7BuRDMkWu9zigDE1u2XPLJ: "For the options,
 * go with your pick (a) but we need to update the MCP server too if
 * possible."). Pick (a), verbatim: "Only a law or a failed final vote counts
 * as finished. Procedural failures keep the call panel, with a line saying
 * the last attempt failed." So this returns exactly two things, read off the
 * STEPPER's own derivation so the panel and "Where does it stand?" agree:
 *
 *   'law'       a signed law;
 *   'rejected'  a failed vote to pass the measure, or to agree to it (the
 *               stepper's `nowFloorPassageRejected`), with the record's
 *               tally when deriveJourney kept one.
 *
 * And a third, which is the same "finished" for the one vehicle that never
 * becomes law (2026-09-29):
 *
 *   'adopted'   a concurrent resolution both chambers agreed to in one form
 *               (the stepper's `nowAdoptedBoth`, read by lib/floor-text.mjs
 *               `concurrentAdoptedBy`). It goes to no president, so nothing
 *               is left to decide: H.Con.Res. 86. `chamber` is the one whose
 *               agreement completed it. Never printed as law.
 *
 * NOT FINISHED, and the call panel stays, with `lastFailedVote` below
 * supplying its one line about the failure:
 *   - a failed MOTION — to proceed to the measure, cloture not invoked, a
 *     motion to discharge a committee rejected. The measure was never voted
 *     on; the chamber declined to take it up that time.
 *   - a failed two-thirds vote to pass it under suspension of the House's
 *     rules. That is a vote on passage, but under a fast-track procedure, and
 *     failing it leaves the measure eligible under the House's regular rules,
 *     so it is not the chamber's final answer.
 *   - a VETO. Congress can still vote to override it, with two-thirds of both
 *     chambers, and the stepper's own veto sentence says so (`nowVetoed`).
 *   - a failed vote with a motion to reconsider ENTERED ("Motion by Senator
 *     Tillis to reconsider the vote by which cloture … was not invoked …
 *     entered in Senate." — H.R. 3633): the same question can come back. Same
 *     reader as lib/docket.mjs `decisionState`, `floorReconsiderPendingChamber`
 *     (it cannot reach a `nowFloorPassageRejected` sentence today, which opens
 *     "Failed of passage"; the guard stays so a future shape cannot slip by).
 *   - a point of order against the measure, upheld (the stepper's
 *     `nowPointOfOrderUpheld`, S.J.Res. 98, 2026-09-29). It is procedural:
 *     the chamber never voted on the measure itself. `decisionState` reads it
 *     as pending as well, so the page and the envelope agree.
 *
 * THE INVARIANT WITH THE MCP ENVELOPE. lib/docket.mjs `decisionState` reads
 * the same rule (pick (a) asked for the MCP server too), so the two agree in
 * one direction by construction: everything this calls settled, the envelope
 * calls settled or enacted, and `get_bill` withholds `act_url`. The converse
 * has one gap, stated rather than hidden: a failed passage vote whose chamber
 * the record does not name. `decisionState` reads the vocabulary alone and
 * calls it settled, while the stepper prints its chamber-free "moving on the
 * floor" sentence and the panel follows the stepper and keeps the call. On
 * 2026-09-29 the corpus holds no record of that shape. (The second gap, a
 * concurrent resolution both chambers agreed to in one form, which #360 made
 * settled in the envelope on 2026-09-29, closed the same day with 'adopted'.)
 * tests/settled-panel.unit.spec.ts pins both directions over the committed
 * corpus.
 *
 * Returns null whenever a decision is still open — every committee, floor,
 * passage and conference stage, a failed motion, a failed suspension vote and
 * a veto.
 */
export function settledDecision(
  bill: Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'> & Basis
): SettledDecision | null {
  const journey = deriveJourney(bill);
  if (journey.isLaw) return { kind: 'law' };
  // The same reading decisionState makes for the MCP envelope, and like it
  // with no reconsider guard: this key is only ever read off a status basis
  // that IS the second chamber's agreement sentence, which a reconsider
  // motion's sentence ("… entered in Senate.") never is.
  if (journey.nowKey === 'nowAdoptedBoth') return { kind: 'adopted', chamber: journey.nowChamber };
  if (journey.nowKey !== 'nowFloorPassageRejected') return null;
  if (floorReconsiderPendingChamber(statusBasisText(bill))) return null;
  return { kind: 'rejected', chamber: journey.nowChamber, tally: journey.tally };
}

/**
 * WHICH FLOOR PROCEDURE FAILED — the call panel's "last attempt failed" line
 * (owner's pick (a), 2026-09-29: "Procedural failures keep the call panel,
 * with a line saying the last attempt failed.").
 *
 *   proceed         a motion to proceed to the measure, rejected ("Motion to
 *                   proceed to consideration of measure rejected in Senate by
 *                   Yea-Nay Vote. 47 - 50." — S.J.Res. 185), or to the other
 *                   chamber's message on it (S. 1318);
 *   clotureProceed  cloture on that motion to proceed, not invoked ("Cloture
 *                   on the motion to proceed to the measure not invoked in
 *                   Senate by Yea-Nay Vote. 51 - 48." — S. 3386);
 *   clotureMeasure  cloture on the measure itself, not invoked (no record in
 *                   the corpus on 2026-09-29; the shape is the one S. 4668's
 *                   invoked cloture takes, with "not invoked");
 *   discharge       a motion to discharge a committee, rejected ("Motion to
 *                   discharge Senate Committee on Foreign Relations rejected
 *                   by Yea-Nay Vote. 47 - 48." — S.J.Res. 172);
 *   suspension      a two-thirds vote to pass it under suspension of the
 *                   rules, failed (SUSPENSION_PASSAGE_FAILED — S. 2503).
 *
 * WHAT THE LINE NEVER SAYS: that the measure "can come back". That is certain
 * for some of these procedures and not for others — a discharge motion under
 * a statute's expedited procedure (50 U.S.C. 1546a, which borrows section
 * 601(b) of the International Security Assistance and Arms Export Control Act
 * of 1976) runs on the statute's own clock — so no procedure gets the clause,
 * and the line says only what happened: the chamber, the record's tally and
 * the record's date.
 *
 * FAIL-CLOSED. Anchored on each sentence's own subject, so a reconsider motion
 * that merely MENTIONS a failed vote ("Motion by Senator … to reconsider the
 * vote by which cloture … was not invoked …") matches none of them, and a
 * failed-motion sentence nobody has read here returns null: the call panel
 * then prints no line, and the stepper's own failed-motion sentence still
 * stands below it.
 */
export type FailedVoteProcedure = 'proceed' | 'clotureProceed' | 'clotureMeasure' | 'discharge' | 'suspension';

const FAILED_VOTE_PROCEDURES: ReadonlyArray<readonly [FailedVoteProcedure, RegExp]> = [
  ['suspension', SUSPENSION_PASSAGE_FAILED],
  [
    'proceed',
    /^\s*motion to proceed to consideration of (?:(?:the )?measure\b|the (?:house|senate) message to accompany\b)[\s\S]*?\brejected\b/i,
  ],
  ['clotureProceed', /^\s*cloture on the motion to proceed to (?:the )?measure\b[^.]*?\bnot invoked\b/i],
  ['clotureMeasure', /^\s*cloture on the measure\b[^.]*?\bnot invoked\b/i],
  ['discharge', /^\s*motion to discharge\b[^.]*?\bcommittee\b[^.]*?\brejected\b/i],
];

export interface LastFailedVote {
  procedure: FailedVoteProcedure;
  /** The chamber the stepper reads the failed vote in (`nowChamber`). */
  chamber: Chamber;
  /** The record sentence's own yeas–nays; null on a voice vote. */
  tally: { yeas: number; nays: number } | null;
}

/**
 * The failed vote the call panel names, or null. Non-null only where the
 * stepper itself says a floor vote failed and the decision is still open
 * (`nowFloorMotionFailed` or `nowFloorSuspensionFailed`, no motion to
 * reconsider entered), and only on a procedure read above. The DATE is the
 * caller's to add, from the same record (lib/settled-votes.ts
 * `settledDecisionDate`: the status basis's own date, never another
 * action's).
 */
export function lastFailedVote(
  bill: Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'> & Basis
): LastFailedVote | null {
  const journey = deriveJourney(bill);
  if (journey.nowKey !== 'nowFloorMotionFailed' && journey.nowKey !== 'nowFloorSuspensionFailed') return null;
  const record = statusBasisText(bill);
  if (!record || floorReconsiderPendingChamber(record)) return null;
  const hit = FAILED_VOTE_PROCEDURES.find(([, re]) => re.test(record));
  if (!hit) return null;
  return { procedure: hit[0], chamber: journey.nowChamber, tally: recordedTally(record) };
}
