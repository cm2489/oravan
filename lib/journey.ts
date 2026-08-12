import type { Bill } from './types';
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
// THE CLOCK, from the ONE copy. lib/urgency.mjs is a pure transform with no
// data imports and no side effects (lib/moments.ts imports it the same way, by
// relative path, for the same reason), so the embed and MCP surfaces that read
// this module pay a few bytes of arithmetic and nothing else. It is
// deliberately the SAME function the bill page's green panel
// (app/[locale]/bills/[id]/page.tsx, via lib/signal-window.ts) and the homepage
// crown (components/system/FloorVotePanel.tsx) gate on: three surfaces, one
// definition of "now", so they cannot disagree about which floor facts are
// still live.
import { isSignalFresh } from './urgency.mjs';

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

/*
 * IS A FLOOR VOTE STILL COMING, AND IN WHICH CHAMBER — the second fact the
 * green panel is allowed to state (owner ruling 2026-08-09).
 *
 * floorCalendarChamber above answers "was it PLACED on a calendar", and that
 * is a pre-action fact: the moment a bill draws real floor action — a cloture
 * motion filed, a motion to proceed made — Congress overwrites
 * `last_action_text` and the placement sentence is gone. The crown was
 * therefore structurally blind to the week's actual floor fights and ran one
 * to two days behind them. This function is the other half: not "it was
 * queued" but "a vote on it is still ahead".
 *
 * THE THREE BUCKETS, over the 26 floor_vote texts in data/bills.json that
 * carry NO calendar placement (counts as of 2026-08-09; the corpus moves
 * nightly — recompute, don't trust):
 *
 *   8  LIVE — a vote is still coming: 2 cloture motions presented, 1 motion
 *      to proceed made in Senate, 2 POSTPONED PROCEEDINGS, 3 Rules Committee
 *      resolutions reported to the House.
 *   18 SETTLED — the vote already happened and went nowhere: rejected motions
 *      to proceed, cloture not invoked, rejected discharge motions. A pending
 *      claim over any of these is a lie, and rule 0 is what stops it.
 *   0  UNCLASSIFIED — every remaining shape returns null and the crown simply
 *      does not consider that bill.
 *
 * WHY AN ALLOW-LIST, ORDERED, WITH THE SETTLED GUARD FIRST. A deny-list would
 * admit an unseen phrasing straight into the full-bleed green panel — the one
 * surface on the site that shouts — and the Senate invents sentences we have
 * never seen every week. Fail-closed means a novel text costs us a quiet
 * week, which is honest; fail-open would cost a false claim of urgency in the
 * loudest place we have. The settled guard runs BEFORE any chamber rule for
 * the same reason: "Cloture on the motion to proceed to the measure NOT
 * INVOKED in Senate" contains a cloture phrase, and matching it first would
 * crown a dead motion.
 *
 * The corpus text "Motion by Senator Schumer to reconsider … the vote by
 * which the third cloture motion … was not invoked … entered in Senate" is a
 * genuinely live motion that rule 0 rejects on its "not invoked" clause. That
 * is DELIBERATE (owner decision D4, 2026-08-09): the sentence is about a vote
 * that already failed, a reader cannot tell from it whether anything is still
 * ahead, and one missed crown is cheaper than one wrong one.
 *
 * NO `$` ANCHORS. Live texts carry trailing Congressional-Record suffixes —
 * "(CR SN)", "(consideration: CR SN)" — so an anchored pattern would match
 * the fixture and miss the record.
 */
/*
 * THE SETTLED VOCABULARY — one constant, because two functions must never
 * disagree about it.
 *
 * floorPendingChamber uses it as its rule-0 guard ("this already resolved, so
 * nothing is pending"); floorSettledChamber below uses it as its ENTRY
 * condition ("this already resolved, so say so"). Those are the two halves of
 * one split, and the whole point of the split is that every floor text lands
 * on exactly one side. Written twice, a word added to one copy would create
 * texts that are neither pending nor settled — which is precisely the silent
 * gap that let a rejected motion print "the Senate is deciding whether to
 * bring it to a vote". Written once, the split stays total by construction.
 *
 * EXPORTED 2026-08-12 for a THIRD reader with the same requirement:
 * lib/core/bills.ts's act-now pool, which must drop a bill whose floor question
 * the record has already answered. That reader deliberately consumes the
 * VOCABULARY rather than calling floorSettledChamber, because that function
 * also requires a readable chamber (floorActionChamber's rule 7 returns null
 * when the record names both chambers or neither) — and WHICH chamber a defeat
 * happened in has no bearing on whether the bill is still worth a call this
 * week. Reusing it would have failed OPEN on exactly the texts we understand
 * least. Nothing here changed but the `export` keyword; the two functions
 * below are untouched.
 */
export const FLOOR_SETTLED = /\b(rejected|not invoked|failed|withdrawn|indefinitely postponed)\b/i;

export function floorPendingChamber(actionText: string | null): Chamber | null {
  if (!actionText) return null;
  // (0) THE SETTLED GUARD, first and unconditional: the record says this
  //     already resolved, so nothing is pending no matter what else it says.
  if (FLOOR_SETTLED.test(actionText)) {
    return null;
  }
  // (1) A cloture motion PRESENTED is the Senate scheduling its own vote.
  if (/cloture motion .*presented in senate/i.test(actionText)) return 'senate';
  // (2) A motion to proceed MADE (not rejected — rule 0 caught those).
  if (/motion to proceed to consideration of (?:the )?measure made in senate/i.test(actionText)) {
    return 'senate';
  }
  // (3) "POSTPONED PROCEEDINGS" (House rule XIX): the vote was deferred to a
  //     later point in the same week's business — it is still ahead.
  if (/postponed proceedings/i.test(actionText)) return 'house';
  // (4) A Rules Committee resolution reported to the House sets the terms of
  //     a floor debate that has not happened yet.
  if (/rules committee resolution .*reported to house/i.test(actionText)) return 'house';
  // Everything else: the record did not say a vote is coming, so we do not.
  return null;
}

/*
 * THE OTHER HALF OF THE SPLIT — has the floor ALREADY answered, and where?
 *
 * floorPendingChamber says "a vote is still ahead". This says the opposite in
 * the record's own words: the chamber took up the question of bringing this
 * measure to a vote and the answer was no. Rejected motions to proceed,
 * rejected discharge motions, cloture not invoked.
 *
 * WHY THIS FUNCTION HAD TO EXIST RATHER THAN REUSING floorActionChamber.
 * deriveJourney used to print "the {chamber} is deciding whether to bring it
 * to a vote" for every floor text floorActionChamber could pin a chamber on —
 * and floorActionChamber answers a different question entirely. It asks
 * "WHICH chamber does this sentence belong to", never "what did that chamber
 * DO", so it happily classified all 18 of the corpus's failed-motion texts and
 * the stepper announced a live deliberation over each one. S.J.Res. 172 —
 * itself a vehicle of a live Big Question — printed "Right now: the Senate is
 * deciding whether to bring it to a vote" three lines above its own record
 * saying the discharge motion was rejected 47–48 on 2026-06-16. The chamber
 * was right; the verb was a fabrication.
 *
 * THE GATE IS THE VOCABULARY, NOT THE CHAMBER. A text only reaches the chamber
 * lookup once FLOOR_SETTLED has matched, so "Considered by Senate" — readable
 * chamber, no settled word — does NOT get called a failed motion. It falls
 * through to the caller's residual branch, exactly as it does today. Both
 * directions fail closed: we never claim a vote is coming, and we never claim
 * one died.
 *
 * MUTUALLY EXCLUSIVE WITH BOTH ITS NEIGHBOURS, by construction rather than by
 * promise. Against floorPendingChamber: FLOOR_SETTLED is that function's
 * rule 0, so a text cannot be both. Against floorCalendarChamber: the explicit
 * guard below, so a live placement that happens to mention a rejected
 * amendment somewhere in its sentence stays a placement. tests/journey.unit
 * .spec.ts pins all three pairings over the live corpus.
 */
export function floorSettledChamber(actionText: string | null): Chamber | null {
  if (!actionText) return null;
  if (!FLOOR_SETTLED.test(actionText)) return null;
  // A dated calendar placement is a live fact, whatever else the sentence says.
  if (floorCalendarChamber(actionText)) return null;
  return floorActionChamber(actionText);
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
 *   `floor_activity`    no placement at all (cloture, a rejected motion, a
 *                       Rules resolution). Unchanged, and deliberately NOT
 *                       clocked — see the last paragraph.
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
 * scripts/moment-candidates.mjs carries an import-free copy of this function;
 * tests/journey.unit.spec.ts pins the two corpus-wide at a shared `now`.
 */
export function statusKeyFor(
  status: Bill['status'],
  lastActionText: string | null,
  lastActionDate: string | null,
  now: number = Date.now()
): Bill['status'] | 'floor_activity' | 'floor_vote_stale' {
  if (status !== 'floor_vote') return status;
  if (!floorCalendarChamber(lastActionText)) return 'floor_activity';
  return isSignalFresh(lastActionDate, now) ? 'floor_vote' : 'floor_vote_stale';
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
 * corpus on a weaker claim), conference (both chambers again), signed/
 * vetoed (Congress is done), and the unclassifiable floor texts (NEVER
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
 * "with an amendment and an amendment to the Title", so 'second' is
 * unreachable on today's corpus and exists for the sentence Congress has not
 * written yet.
 */
export type PassageStage = 'first' | 'back' | 'both' | 'second';

export interface PassageState {
  stage: PassageStage;
  /** The chamber whose passage the last action reports, when it says. */
  passedBy: Chamber | null;
  /** The chamber that must act next — null when no chamber does. */
  next: Chamber | null;
}

export function passageState(
  bill: Pick<Bill, 'bill_type' | 'last_action_text'>
): PassageState {
  const origin: Chamber = bill.bill_type.startsWith('h') ? 'house' : 'senate';
  const other: Chamber = origin === 'house' ? 'senate' : 'house';
  const text = bill.last_action_text ?? '';
  // Anchored: "Rule H. Res. 988 passed House." reports a RULE's passage, not
  // this bill's, and an unanchored match would read it as one.
  const passage = /^\s*Passed (House|Senate)\b/i.exec(text);
  if (!passage) return { stage: 'first', passedBy: null, next: other };
  const passedBy: Chamber = passage[1].toLowerCase() === 'senate' ? 'senate' : 'house';
  // The originating chamber passing its own bill is the ordinary case, and an
  // amendment adopted during that passage is just its own floor amendment —
  // it changes nothing about who acts next.
  if (passedBy === origin) return { stage: 'first', passedBy, next: other };
  // Past here the SECOND chamber has passed it, and only the amendment clause
  // decides between the President and a trip back.
  if (/\bwithout amendment\b/i.test(text)) {
    return { stage: 'both', passedBy, next: null };
  }
  if (/\bwith (?:an? )?amendments?\b/i.test(text)) {
    return { stage: 'back', passedBy, next: origin };
  }
  return { stage: 'second', passedBy, next: null };
}

export function liveCallTarget(
  bill: Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'>
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
     * `passed_chamber` below is deliberately NOT clocked: "the House has
     * already voted" is a durable relational fact about a vote that happened,
     * not a claim about this week, and all 275 of the corpus's 275
     * passed_chamber records are outside the window (2026-08-12) — clocking it
     * would silence that routing entirely, on a much weaker argument.
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
      floorCalendarChamber(bill.last_action_text) ?? floorPendingChamber(bill.last_action_text);
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
  | 'nowPassed'
  | 'nowPassedBack'
  | 'nowPassedBoth'
  | 'nowPassedSecond'
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
  /** True only when the record's own sentence says "Placed on … Calendar"
   *  AND that placement is still inside the signal window — i.e. the
   *  present-tense claim "it is on the calendar right now" is defensible.
   *  An aged placement keeps `nowKey: 'nowFloorStale'` (which still names the
   *  placement, in the past tense) and sets this false, so a future reader
   *  cannot re-light an urgency treatment off a two-year-old event. */
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
  bill: Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'>
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
      const cal = floorCalendarChamber(bill.last_action_text);
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
          nowKey: live ? 'nowFloor' : 'nowFloorStale',
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
      const settled = floorSettledChamber(bill.last_action_text);
      if (settled) {
        return {
          ...base,
          step: settled === origin ? 2 : 3,
          current: settled,
          nowChamber: settled,
          nowKey: 'nowFloorMotionFailed',
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
        /*
         * NOT CLOCKED, and the reason is that there is nothing here to demote
         * TO. This branch's sentence names no chamber and no calendar — it
         * says only that the record has not said yet — so a stale variant
         * would be new copy in two languages for a state that is EMPTY on the
         * corpus (0 bills on 2026-08-12: every unclassified floor text is
         * caught by the nightly tripwire long before it reaches here). If that
         * ever stops being true, this branch wants its own key, not a reused
         * one.
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
       */
      return {
        ...base,
        step: act === origin ? 2 : 3,
        current: act,
        nowChamber: act,
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
       */
      const { stage, passedBy } = passageState(bill);
      if (stage === 'first') {
        // Corpus-verified copy: nearly all passed_chamber actions read
        // "Received in the Senate…" — origin passage, headed to the other
        // chamber — so nowChamber stays origin and current is the other.
        return { ...base, step: 3, current: other, nowKey: 'nowPassed' };
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
         */
        return {
          ...base,
          step: 3,
          current: origin,
          nowChamber: origin,
          nowKey: 'nowPassedBack',
          showTrailer: false,
        };
      }
      if (stage === 'both') {
        // Identical text out of both chambers: the only step left is the desk.
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
      // names no next step. Unreachable on today's corpus (see passageState).
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
