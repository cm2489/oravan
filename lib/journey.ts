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
export function floorPendingChamber(actionText: string | null): Chamber | null {
  if (!actionText) return null;
  // (0) THE SETTLED GUARD, first and unconditional: the record says this
  //     already resolved, so nothing is pending no matter what else it says.
  if (/\b(rejected|not invoked|failed|withdrawn|indefinitely postponed)\b/i.test(actionText)) {
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

/**
 * THE STATUS-LABEL GATE (owner ruling 2026-08-04, Wave B #1). The corpus
 * derives `floor_vote` looser than the label "On the floor calendar"
 * claims: 23 of 319 carry cloture/rejected-motion texts, not placements.
 * Every surface that prints a status label routes through this key so the
 * label can never outrun the record: genuinely placed bills keep
 * `floor_vote` ("On the floor calendar"), activity-only bills print
 * `floor_activity` ("Floor activity"). Same gate, citizen site, embeds,
 * and MCP alike.
 */
export function statusKeyFor(
  status: Bill['status'],
  lastActionText: string | null
): Bill['status'] | 'floor_activity' {
  if (status !== 'floor_vote') return status;
  return floorCalendarChamber(lastActionText) ? 'floor_vote' : 'floor_activity';
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
export function liveCallTarget(
  bill: Pick<Bill, 'bill_type' | 'status' | 'last_action_text'>
): LiveCallTarget | null {
  if (bill.status === 'floor_vote') {
    const chamber =
      floorCalendarChamber(bill.last_action_text) ?? floorActionChamber(bill.last_action_text);
    return chamber ? { chamber, afterVote: false, soleChamber: false } : null;
  }
  if (bill.status === 'passed_chamber') {
    const other: Chamber = bill.bill_type.startsWith('h') ? 'senate' : 'house';
    return { chamber: other, afterVote: true, soleChamber: false };
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
