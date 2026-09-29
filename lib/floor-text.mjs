/*
 * THE FLOOR-TEXT VOCABULARY — the ONE copy, in the ONE language both halves
 * of this codebase can read.
 *
 * Every function here used to live in lib/journey.ts, which re-exports all of
 * them unchanged (its headers still describe them; this file carries the same
 * text so the rules and their reasons stay together). Nothing about them
 * changed in the move except the file extension, and the extension is the
 * whole point: lib/docket.ts's ladder is read by the live site AND by two
 * node scripts (scripts/sync-coverage.mjs's head order,
 * scripts/moment-candidates.mjs's comparator), and node cannot import
 * TypeScript. The alternatives were both worse:
 *
 *   - a fourth hand-copied FLOOR_SETTLED in .mjs land (there were already
 *     three: lib/journey.ts, scripts/moment-scaffold.mjs's floor-action copy,
 *     and scripts/floor-signals-parse.mjs's — this change deletes the last of
 *     those and points it here);
 *   - passing the derived facts into the ladder from every caller, which
 *     moves the vocabulary into six call sites instead of one file.
 *
 * Same shape as lib/urgency.mjs and the lib/signal-window.ts door beside it:
 * plain .mjs with JSDoc types, imported by node scripts directly and by React
 * through the TS module that re-exports it.
 *
 * ZERO data imports, ZERO fs, ZERO network — the embed and MCP surfaces read
 * lib/journey.ts and must not pull the corpus by accident.
 */

/**
 * THE SENTENCE A BILL'S STATUS WAS READ FROM (2026-09-24).
 *
 * Usually that is `last_action_text`. But some last-action sentences cannot be
 * read on their own — "Motion to reconsider laid on the table…" follows a
 * failed vote as readily as a passage, "Message on Senate action sent to
 * the House." does not say what the Senate did, and "The committee substitute
 * withdrawn by Voice Vote." (COMMITTEE_TEXT_ON_FLOOR, 2026-09-25) says the
 * measure is on the floor but not where it stands (scripts/congress-fetch.mjs's
 * AMBIGUOUS_WITHOUT_CONTEXT). For those, the pipeline reads the action BEFORE
 * them and stores it as `status_basis_text`. Every chamber and tense
 * derivation reads THIS, so the page cannot say "the House decides next"
 * about a Senate bill the House has just passed, which is what the bare
 * reconsider sentence produced. The page still SHOWS `last_action_text` as the
 * record's latest step; this is only what the derivations reason from.
 *
 * @param {{ status_basis_text?: string | null, last_action_text?: string | null } | null | undefined} bill
 * @returns {string | null}
 */
export function statusBasisText(bill) {
  return bill?.status_basis_text || bill?.last_action_text || null;
}

/**
 * THE AMBER GATE, and why it is narrower than the status field.
 *
 * `status: "floor_vote"` is DERIVED from action text
 * (scripts/congress-fetch.mjs keyword bucket), and the corpus proves the
 * derivation is looser than the claim amber makes: most `floor_vote` bills
 * say "Placed on <the Union / the House / Senate Legislative> Calendar" — a
 * real, dated calendar placement — and the rest do not, reading instead like
 * "Motion to proceed to consideration of measure REJECTED in Senate" or a
 * cloture motion. Printing "On the Senate floor calendar · Apr 29 2026" over
 * a rejected motion is a false claim, and the color law's "no date, no amber"
 * rule exists to stop exactly this class of lie. (The counts move nightly;
 * tests/journey.unit.spec.ts sweeps the live corpus so the split can never
 * silently invalidate this gate.)
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
 *
 * @param {string | null | undefined} actionText
 * @returns {'house' | 'senate' | null}
 */
export function floorCalendarChamber(actionText) {
  if (!actionText) return null;
  const match = /placed on (?:the )?(senate legislative|union|house|senate)\s+calendar/i.exec(
    actionText
  );
  if (!match) return null;
  return /senate/i.test(match[1]) ? 'senate' : 'house';
}

/**
 * The activity matcher for floor_vote bills WITHOUT a calendar placement —
 * cloture motions, rejected motions to proceed, House rule resolutions,
 * postponed proceedings. Ordered rules, first hit wins; every live corpus
 * text is pinned by fixture in tests/journey.unit.spec.ts. Novel shapes are
 * caught by the NIGHTLY corpus check (scripts/check-journey-corpus.mjs,
 * wired into sync-bills.yml — it fires where the data changes, never on
 * unrelated PRs), and until a matcher rule lands the stepper renders
 * chamber-free neutral copy instead of a guess.
 *
 * NOTE WHAT THIS FUNCTION IS AND IS NOT, since 2026-08-12 (N9-A2). It answers
 * "WHICH chamber does this sentence belong to" and it is deliberately
 * permissive — rule 6 pins a chamber on any floor text naming exactly one.
 * That is fine for a SWEEP (it is how the tripwire tells "nobody can read
 * this" apart from "nobody has read this yet") and it was never a licence to
 * SPEAK. deriveJourney used to hand its answer to "the {chamber} is deciding
 * whether to bring it to a vote"; it reads floorPendingChamber for that now.
 * Only floorSettledChamber still calls this, and only after FLOOR_SETTLED has
 * already decided what the sentence says.
 *
 * @param {string | null | undefined} actionText
 * @returns {'house' | 'senate' | null}
 */
export function floorActionChamber(actionText) {
  if (!actionText) return null;
  // (1) Cloture exists only in the Senate.
  if (/cloture/i.test(actionText)) return 'senate';
  // (2) "POSTPONED PROCEEDINGS" is a House floor idiom (rule XIX) — covers
  //     the texts that never name a chamber at all.
  if (/postponed proceedings/i.test(actionText)) return 'house';
  // (3) Rules Committee resolutions reported to the House.
  if (/reported to house\b/i.test(actionText)) return 'house';
  // (4) Congressional Record page prefix: S-pages are the Senate section,
  //     H-pages the House section, e.g. "(CR S4365)". Since 2026-09-24 the
  //     "(consideration: CR H1234-1240)" form is read too — the same citation
  //     with a label in front, and the only chamber evidence a House
  //     "Considered as unfinished business." sentence carries (see
  //     CHAMBER_SILENT_CONSIDERATION below).
  const cr = CR_PAGE.exec(actionText);
  if (cr) return cr[1] === 'S' ? 'senate' : 'house';
  // (5) An explicit venue phrase. Must precede rule 6: "House message …
  //     rejected in Senate" names both chambers but happened in one.
  if (/\bin senate\b|\bby senator\b/i.test(actionText)) return 'senate';
  if (/\bin house\b/i.test(actionText)) return 'house';
  // (5b) A SUSPENSION VOTE, which names no chamber at all (issue #258).
  //      s-2503-119's sentence, verbatim: "On motion to suspend the rules and
  //      pass the bill Failed by the Yeas and Nays: (2/3 required): 264 - 133
  //      (Roll no. 72)." Two House-only signatures are required TOGETHER, so
  //      neither can drift onto a Senate sentence by itself:
  //        · suspending the rules to pass a measure by two-thirds is the
  //          HOUSE's fast track (rule XV); and
  //        · "Roll no. N" is the House Clerk's roll-call form — the Senate
  //          numbers its own votes "Record Vote Number: N", on all 25 of the
  //          corpus's Senate roll calls, none of which says "Roll no."
  //          (measured over 3,041 bills, 2026-09-19; the 3 "Roll no." texts
  //          are all suspension motions and none names a chamber).
  //      MUST PRECEDE RULE 6, which is why it is here rather than appended:
  //      the House regularly takes up SENATE bills under suspension, and a
  //      sentence reading "…and pass the Senate bill…" names exactly one
  //      chamber — the wrong one. Reading the procedure beats counting the
  //      chamber words, the same reason rule 5 outranks rule 6.
  //      WHAT THIS RULE DOES NOT SAY: only which chamber the sentence belongs
  //      to. Whether that suspension motion carried or failed is
  //      FLOOR_SETTLED's question, and floorSettledChamber asks it first.
  if (/\bsuspend the rules\b/i.test(actionText) && /\broll no\.\s*\d/i.test(actionText)) {
    return 'house';
  }
  // (5c) A House CONSIDERATION sentence (2026-09-24). "Considered under the
  //      provisions of rule H. Res. N." and "Considered under suspension of
  //      the rules." name no chamber, but each names a procedure only the
  //      House has — a special rule is an H. Res., and suspension is the
  //      House's two-thirds track. Read here so floorPendingChamber's
  //      matching rule, which says 'house' for the same sentences, always
  //      agrees with this function (tests/journey.unit.spec.ts pins that
  //      agreement over the live corpus).
  if (HOUSE_CONSIDERATION.test(actionText)) return 'house';
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

/**
 * READ, AND DELIBERATELY SILENT — the third answer the tripwire needed.
 *
 * The nightly journey-corpus sweep (scripts/check-journey-corpus.mjs) splits
 * every `floor_vote` sentence into three buckets: no chamber readable, chamber
 * readable but no tense, or classified. Its whole job is to tell "nobody CAN
 * read this shape" apart from "nobody HAS read it yet", and until this
 * function existed it had no way to record the third real outcome: somebody
 * read the shape, and the honest classification is that it makes no floor
 * claim in either direction.
 *
 * S. 1602 (issue #241) is that case, verbatim from the record:
 *
 *   "Referred sequentially to the Committee on Commerce, Science, and
 *    Transportation, pursuant to the order of March 3, 1988, for 30 calendar
 *    days ... and if not reported by that day, the Committee be discharged
 *    from further consideration thereof, and the bill be placed on the
 *    calendar."
 *
 * That is a COMMITTEE order with a conditional future consequence, and the
 * bill's `status: "floor_vote"` comes from scripts/congress-fetch.mjs's
 * keyword bucket catching "placed on the calendar" inside the conditional
 * clause. Neither existing matcher can take it truthfully:
 *
 *   - floorPendingChamber would print "the Senate is deciding whether to bring
 *     it to a vote", crown it, and route the live call at it. The bill is in
 *     committee. That is the false-urgency class this whole module exists to
 *     prevent, in the loudest place on the site.
 *   - FLOOR_SETTLED would print "the last motion to do so failed". Nothing
 *     failed, nothing was rejected, and FLOOR_SETTLED is read by four callers
 *     including the act-now pool's exclusion — widening it for a non-defeat
 *     would silently drop live bills out of the pool.
 *
 * So the answer is neither, and this function says so out loud instead of
 * leaving the sweep to re-file the same issue every night. NOTHING RENDERS
 * DIFFERENTLY: these texts already fall to deriveJourney's residual branch and
 * its chamber-free `nowFloorActivityNeutral` copy, and they still do. The only
 * consumer is the sweep, which stops counting a read shape as unread.
 *
 * FAIL-CLOSED LIKE ITS NEIGHBOURS: an ordered allow-list of shapes somebody has
 * actually read, each pinned by a verbatim fixture in
 * tests/journey.unit.spec.ts. A novel sentence returns false and files its
 * issue, exactly as before. This is a place to record a reading, never a place
 * to silence one.
 *
 * @param {string | null | undefined} actionText
 * @returns {boolean}
 */
export function floorMakesNoClaim(actionText) {
  if (!actionText) return false;
  // (1) A Senate sequential-referral order (the order of March 3, 1988): the
  //     bill goes to a second committee for a fixed count of session days, and
  //     the discharge and the calendar placement are the CONDITIONAL
  //     consequence of that clock running out, not events that happened. All
  //     three clauses are required so a plain sequential referral, or a real
  //     discharge that already occurred, still reaches the sweep unread.
  if (
    /\breferred sequentially\b/i.test(actionText) &&
    /\bif not reported\b/i.test(actionText) &&
    /\bbe discharged\b/i.test(actionText)
  ) {
    return true;
  }
  // (2) A House discharge petition FILED (owner ruling 2026-09-24, issue
  //     #268). H.R. 4889's record, verbatim: "Motion to Discharge Committee
  //     filed by Mr. Kiley (CA). Petition No: 119-21. (<a href=…>Discharge
  //     petition</a> text with signatures.)" A filing opens a signature
  //     drive; the motion cannot even be called up until 218 Members sign.
  //     Nothing has happened on the floor, so "a vote is coming" and "the
  //     motion failed" are both false, and the owner's ruling is that the
  //     site makes no floor claim about it at all. scripts/congress-fetch.mjs's
  //     mapStatus now keeps this sentence at `committee`; this rule covers the
  //     records already stored at `floor_vote` until their next refresh.
  //     BOTH the "filed by" verb and the "Petition No" citation are required:
  //     a Senate discharge motion that was actually voted on ("Motion to
  //     discharge Senate Committee on Foreign Relations rejected by Yea-Nay
  //     Vote. 47 - 48.") is a real floor event, FLOOR_SETTLED reads it, and it
  //     must never land here.
  if (
    /\bmotion to discharge committee filed by\b/i.test(actionText) &&
    /\bpetition no\b/i.test(actionText)
  ) {
    return true;
  }
  // Everything else is still unread, and the nightly sweep still says so.
  return false;
}

/**
 * A CHAMBER DISPOSING OF A COMMITTEE'S TEXT ON ITS OWN FLOOR (2026-09-25).
 *
 * S. 4668 is why this exists. On 2026-09-24 the Senate adopted S.Amdt. 6776
 * 77-23 (roll 242), invoked cloture on the bill, as amended, 74-25 (roll 243),
 * and then wrote, verbatim:
 *
 *   "The committee substitute withdrawn by Voice Vote."
 *
 * That sentence names a committee, but it is the SENATE acting, on its floor,
 * on the substitute the Commerce Committee reported in June — Congress.gov
 * types it "Floor". scripts/congress-fetch.mjs's mapStatus had no rule for it,
 * fell through to its `committee` default, and the live page printed "In
 * committee" beside the Senate's own floor program.
 *
 * The shapes read in the record (Congress.gov /actions, sampled 2026-09-25
 * over 319 bills that reached a floor; every one typed "Floor"):
 *
 *   "The committee substitute withdrawn by Unanimous Consent."   (s-1199-119, s-2503-119, s-3023-119, s-3897-119, s-434-119)
 *   "The committee substitute withdrawn by Voice Vote."          (s-4668-119)
 *   "The committee substitute agreed to by Unanimous Consent."   (s-331-119)
 *   "The committee substitute as amended agreed to by Unanimous Consent. (text of amendment in the nature of a substitute: CR S7-10)" (s-320-119)
 *   "The committee amendment withdrawn by Unanimous Consent."    (s-688-119)
 *   "The committee amendment as amended agreed to by Unanimous Consent. (text of amendment in the nature of a substitute: CR S13-16)" (s-1626-119)
 *
 * WHAT THE SENTENCE SAYS, AND WHAT IT DOES NOT. It says the measure is on the
 * floor. It does not say where the measure stands: in eight of those nine
 * records it sits directly before "Passed Senate with an amendment…" on the
 * same day, and in S. 4668's it follows a cloture vote on the bill. So
 * scripts/congress-fetch.mjs lists it in AMBIGUOUS_WITHOUT_CONTEXT and every
 * write path reads the action before it, the same way #285/#286 treat the
 * post-passage motion and the chamber message.
 *
 * THE SUBJECT IS THE COMMITTEE'S TEXT, NOT THE MEASURE. Whatever verb follows
 * — "withdrawn", "agreed to", or a "not agreed to" nobody has seen yet — it is
 * about an amendment, never about the measure's own floor question. That is
 * why FLOOR_SETTLED below refuses to read it: "withdrawn" is one of its five
 * words, and without the guard S. 4668's sentence reads as the floor having
 * answered wherever it is read directly (lib/docket.mjs's
 * floorAnsweredChamber returns 'unknown' for it, which announcementAnswered
 * counts as an outcome and which can retire a live T0 announcement; and at
 * `floor_vote` isSettledFloor would file the bill as "just decided").
 *
 * ANCHORED ON THE SUBJECT, and "The" is required: every read shape opens with
 * it, while a committee's OWN report opens "Committee on Commerce, Science,
 * and Transportation. Reported by Senator Cruz with an amendment in the
 * nature of a substitute." — a committee-stage sentence this must never touch.
 */
const COMMITTEE_TEXT_SUBJECT = String.raw`\s*the committee (?:substitute|amendments?)\b`;
export const COMMITTEE_TEXT_ON_FLOOR = new RegExp(`^${COMMITTEE_TEXT_SUBJECT}`, 'i');

/**
 * THE SETTLED VOCABULARY — one constant, because four readers must never
 * disagree about it.
 *
 * floorPendingChamber uses it as its rule-0 guard ("this already resolved, so
 * nothing is pending"); floorSettledChamber below uses it as its ENTRY
 * condition ("this already resolved, so say so"); lib/core/bills.ts's act-now
 * pool uses it to drop a bill whose floor question the record has already
 * answered; and lib/docket.mjs's T1 rung uses it for the same reason one rung
 * further up. Those are the halves of one split, and the whole point of the
 * split is that every floor text lands on exactly one side. Written twice, a
 * word added to one copy would create texts that are neither pending nor
 * settled — which is precisely the silent gap that let a rejected motion
 * print "the Senate is deciding whether to bring it to a vote". Written once,
 * the split stays total by construction.
 *
 * The act-now pool deliberately consumes the VOCABULARY rather than calling
 * floorSettledChamber, because that function also requires a readable chamber
 * (floorActionChamber's rule 7 returns null when the record names both
 * chambers or neither) — and WHICH chamber a defeat happened in has no bearing
 * on whether the bill is still worth a call this week. Reusing it would have
 * failed OPEN on exactly the texts we understand least.
 *
 * ONE EXCLUSION (2026-09-25): a sentence whose subject is a committee's text
 * (COMMITTEE_TEXT_ON_FLOOR above) is never settled. "The committee substitute
 * withdrawn by Voice Vote." withdraws an amendment; the measure's own floor
 * question is still open, and on S. 4668 its cloture vote had just carried.
 * The exclusion is a leading lookahead on the SAME constant, so all four
 * readers inherit it at once and the split stays total.
 */
export const FLOOR_SETTLED = new RegExp(
  String.raw`^(?!${COMMITTEE_TEXT_SUBJECT})[\s\S]*?\b(rejected|not invoked|failed|withdrawn|indefinitely postponed)\b`,
  'i'
);

/**
 * A REJECTED PASSAGE VOTE — the settled class that is NOT a failed motion
 * (2026-09-27, the 2026-09-27 audit SY-01; owner card a5).
 *
 * FLOOR_SETTLED above is one vocabulary for "the floor already answered, and
 * the answer was no". Every reader of it treated that answer as a failed
 * MOTION — the stepper printed "the Senate has not agreed to take it up — the
 * last motion to do so failed" — and on most of the corpus that is right: a
 * motion to proceed rejected, cloture not invoked, a discharge motion
 * rejected. It is wrong on the sentences where the chamber took up the
 * MEASURE ITSELF and voted it down. H.Con.Res. 89, verbatim:
 *
 *   "Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244."
 *
 * The Senate did take it up; it voted on adopting it and the answer was no.
 * The House writes the same outcome as Congress.gov's own summary line:
 *
 *   "Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: 209 - 215 (Roll no. 19)."
 *   "Failed of passage/not agreed to in House On agreeing to the resolution Failed by the Yeas and Nays: 212 - 219 (Roll no. 85)."
 *
 * A SUBSET OF FLOOR_SETTLED, BY CONSTRUCTION. Every sentence here opens
 * "Failed", which is one of FLOOR_SETTLED's words, so the four readers of the
 * settled vocabulary (the crown's rule 0, the act-now pool, the T1 guard, the
 * T0 answered guard) are untouched: this splits what the settled side SAYS,
 * never which side a sentence lands on.
 *
 * ANCHORED ON THE SUBJECT. "Failed of passage" has to open the sentence, so
 * "Rule H. Res. 1175 failed passage of House." — a RULE failing, not the
 * measure — never reads as the measure's defeat, and neither does a failed
 * motion that merely mentions passage.
 *
 * TWO EXCLUSIONS, both kept on the failed-motion side where they were:
 *   - a VETO OVERRIDE that fails ("… over veto …") is a two-thirds vote on
 *     overriding the President, not the chamber rejecting the measure — a
 *     majority can have voted for it;
 *   - a House SUSPENSION vote ("On motion to suspend the rules and pass …
 *     Failed … (2/3 required): 212 - 206") never opens "Failed of passage":
 *     it is a motion, a majority often voted yes, and the House can still take
 *     the bill up under a rule. It stays on the motion side and is not read
 *     here.
 *
 * NOT READ, DELIBERATELY: a Senate "Resolution not agreed to in Senate …"
 * sentence. Nobody has seen that shape in this corpus (measured 2026-09-27
 * over 3,222 bills: every "not agreed to" on a measure sits inside the House's
 * "Failed of passage/not agreed to" line), and FLOOR_SETTLED does not hold its
 * words either — so it reaches the nightly journey-corpus tripwire as
 * "chamber readable, tense is not" and gets read by a person, rather than
 * being guessed at here.
 */
export const FLOOR_PASSAGE_REJECTED = /^\s*failed of passage\b(?![\s\S]*\bover (?:the )?veto\b)/i;

/**
 * Which chamber voted the measure down, when the record says the measure's own
 * passage vote failed — else null. Sits INSIDE floorSettledChamber (defined
 * below): a sentence must first be settled, not a calendar placement, and name
 * its chamber, exactly like every other settled reading, and only then does
 * this say which KIND of settled it is.
 *
 * @param {string | null | undefined} actionText
 * @returns {'house' | 'senate' | null}
 */
export function floorPassageRejectedChamber(actionText) {
  if (!actionText || !FLOOR_PASSAGE_REJECTED.test(actionText)) return null;
  return floorSettledChamber(actionText);
}

/**
 * THE TALLY, READ OUT OF THE RECORD'S OWN SENTENCE — never computed, never
 * looked up. Both chambers print a recorded vote yeas first:
 *
 *   Senate  "… by Yea-Nay Vote. 49 - 50. Record Vote Number: 244."
 *   House   "… by the Yeas and Nays: 209 - 215 (Roll no. 19)."
 *           "… by the Yeas and Nays: (2/3 required): 264 - 133 (Roll no. 72)."
 *           "… by recorded vote: 200 - 220 (Roll no. 5)."
 *
 * A voice vote or unanimous consent carries no tally, and this returns null —
 * the caller then prints no numbers at all rather than inventing any.
 *
 * @param {string | null | undefined} actionText
 * @returns {{ yeas: number, nays: number } | null}
 */
export function recordedTally(actionText) {
  const m =
    /\b(?:yea-nay vote|yeas and nays|recorded vote)\b\s*[.:]?\s*(?:\(\s*2\/3 required\s*\)\s*:?\s*)?(\d{1,3})\s*-\s*(\d{1,3})\b/i.exec(
      actionText ?? ''
    );
  if (!m) return null;
  return { yeas: Number(m[1]), nays: Number(m[2]) };
}

/**
 * CLOTURE INVOKED ON THE MEASURE ITSELF — a Senate vote still ahead (owner
 * card a5, 2026-09-27, which answers the question PR #304 left open: "should
 * floorPendingChamber read 'Cloture on the measure … invoked in Senate' as a
 * Senate vote still ahead?" — yes).
 *
 * S. 4668's record, verbatim (2026-09-24):
 *
 *   "Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 25. Record Vote Number: 243."
 *
 * The Senate has voted to end debate on the bill; what cloture buys is a
 * limit on further debate, after which the vote on the measure comes. So a
 * vote of the full Senate is still ahead, in the Senate, which is the whole of
 * what floorPendingChamber says. lib/docket.mjs's T1 rung has admitted
 * "cloture … invoked" since the SEED Act backtest (2026-07-28), so the crown's
 * gate stays a subset of the ladder's.
 *
 * WHO READS IT. floorPendingChamber's rule 1b — and through it the crown,
 * the bill-page band, the call rail, the stepper and the Big Questions status
 * line, all at once ("one reader, one answer", lib/journey.ts). The stepper
 * gives it its own sentence (`nowFloorClotureInvoked`): the usual pending one,
 * "the Senate is deciding whether to bring it to a vote", would be false after
 * the Senate has voted to end debate. floorClotureInvokedChamber below stays
 * as the named predicate for the reading.
 *
 * NARROW ON PURPOSE:
 *   - anchored on the subject "Cloture on the measure", so cloture on the
 *     MOTION TO PROCEED ("Cloture on the motion to proceed to the measure
 *     invoked …") is not read here — that sentence has a different next step
 *     (the motion to proceed itself), and nobody has read it for this surface
 *     yet;
 *   - "not invoked" is FLOOR_SETTLED's, and floorPendingChamber's rule 0 runs
 *     first; the pattern below also needs "invoked" to follow the subject
 *     directly, so it could not match "not invoked" even alone;
 *   - a reconsider motion that MENTIONS such a vote ("Motion by Senator … to
 *     reconsider the vote by which cloture on the measure was invoked …")
 *     opens with "Motion", so the anchor refuses it.
 */
export const CLOTURE_INVOKED_ON_MEASURE =
  /^\s*cloture on the measure\b(?:\s*,?\s*as amended\s*,?)?\s+invoked in senate\b/i;

/**
 * 'senate' when the record says cloture on the measure itself was invoked,
 * else null. The settled guard runs first, as it does in floorPendingChamber,
 * so a sentence carrying any settled word can never read as a vote ahead.
 *
 * @param {string | null | undefined} actionText
 * @returns {'senate' | null}
 */
export function floorClotureInvokedChamber(actionText) {
  if (!actionText) return null;
  if (FLOOR_SETTLED.test(actionText)) return null;
  return CLOTURE_INVOKED_ON_MEASURE.test(actionText) ? 'senate' : null;
}

/**
 * A MEASURE UNDER FLOOR CONSIDERATION — the sentences Congress writes while a
 * chamber is debating the measure on its own floor (2026-09-24).
 *
 * S. 4668 is why these exist. On the morning the Senate was set to vote on
 * cloture on it, its last action read "Considered by Senate. (consideration:
 * CR S4851)", which no rule here read: scripts/congress-fetch.mjs's mapStatus
 * filed it as `committee`, and even at `floor_vote` floorPendingChamber would
 * have stayed silent. A measure under consideration has its vote still AHEAD,
 * in the chamber considering it — that is the whole of what these say.
 *
 * Three groups, because the sentences carry three different amounts of
 * chamber evidence:
 *
 *   SENATE_CONSIDERATION  the Senate names itself: "Measure laid before
 *                         Senate by motion." / "… by unanimous consent." /
 *                         "Considered by Senate."
 *   HOUSE_CONSIDERATION   no chamber is named, but the procedure is the
 *                         House's alone: "Considered under the provisions of
 *                         rule H. Res. N." / "Considered under suspension of
 *                         the rules."
 *   CHAMBER_SILENT_CONSIDERATION
 *                         no chamber and no chamber-only procedure:
 *                         "Considered as unfinished business." / "Considered
 *                         pursuant to a previous order." These were read in
 *                         House records, but the words themselves are not
 *                         House-only, so the chamber comes from the record's
 *                         own page citation (floorActionChamber rule 4, the
 *                         "(consideration: CR H…)" tail) and a bare sentence
 *                         still says nothing. One missed crown is cheaper than
 *                         one wrong one.
 *
 * NO `$` ANCHORS, for the reason floorPendingChamber's header gives: live
 * texts end in "(consideration: CR …)" tails.
 */
/**
 * The Congressional Record page citation — "(CR S4365)" or "(consideration:
 * CR H1234-1240)". S-pages are the Senate section, H-pages the House section.
 * Case-sensitive on purpose: the record writes the prefix upper-case.
 */
export const CR_PAGE = /\((?:consideration: ?)?CR ([SH])\d/;
export const SENATE_CONSIDERATION = /\bmeasure laid before senate\b|\bconsidered by senate\b(?!\s+committee)/i;
export const HOUSE_CONSIDERATION =
  /\bconsidered under the provisions of rule h\.? ?res\b|\bconsidered under suspension of the rules\b/i;
export const CHAMBER_SILENT_CONSIDERATION =
  /\bconsidered as unfinished business\b|\bconsidered pursuant to a previous order\b/i;

/**
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
 *
 * NOTE THE DELIBERATE NARROWNESS AGAINST lib/docket.mjs's T1 RUNG. This
 * function gates the CROWN's "a vote is pending" sentence; `entersFloorWatch`
 * there gates a RANKING position and admits further sentences Congress writes
 * once a measure is physically on the floor ("cloture … invoked" on anything,
 * "Motion to proceed to measure considered in Senate", and a chamber-silent
 * consideration sentence with no page citation). Neither may be swapped for
 * the other — see that function's own header. Since 2026-09-27 (owner card
 * a5) this function reads ONE of those — cloture invoked on the MEASURE, rule
 * 1b — and the ladder's wider "cloture … invoked" still contains it.
 *
 * THE CONSIDERATION RULE (5), added 2026-09-24. A measure the record says is
 * under consideration — "Considered by Senate.", "Measure laid before Senate
 * by motion.", "Considered under the provisions of rule H. Res. N." — has its
 * vote still ahead in the chamber considering it. Until this rule S. 4668 read
 * as sitting in committee on the morning of its cloture vote. See
 * SENATE_CONSIDERATION's header for why the three groups carry different
 * amounts of chamber evidence.
 *
 * @param {string | null | undefined} actionText
 * @returns {'house' | 'senate' | null}
 */
export function floorPendingChamber(actionText) {
  if (!actionText) return null;
  // (0) THE SETTLED GUARD, first and unconditional: the record says this
  //     already resolved, so nothing is pending no matter what else it says.
  if (FLOOR_SETTLED.test(actionText)) {
    return null;
  }
  // (1) A cloture motion PRESENTED is the Senate scheduling its own vote.
  if (/cloture motion .*presented in senate/i.test(actionText)) return 'senate';
  // (1b) CLOTURE INVOKED ON THE MEASURE (owner card a5, 2026-09-27, the #304
  //      question): debate is closing and the vote on the measure is still
  //      ahead. See CLOTURE_INVOKED_ON_MEASURE for what it does not read, and
  //      lib/journey.ts for the stepper sentence that comes with it.
  if (CLOTURE_INVOKED_ON_MEASURE.test(actionText)) return 'senate';
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
  // (5) THE HOUSE ADOPTING THAT RULE (issue #268, awaiting owner ruling). The
  //     next step after rule 4: "Rule H. Res. 988 passed House." is the House
  //     agreeing to the TERMS of a floor debate, which is what puts the bill
  //     itself in order for its own vote — that vote is still ahead. This is
  //     the reading the pipeline already makes of the same sentence twice:
  //     scripts/congress-fetch.mjs's mapStatus keeps it at `floor_vote`
  //     rather than `passed_chamber`, and lib/docket.mjs's
  //     floorAnsweredChamber refuses to read it as a passage. It is NOT
  //     settled: floorSettledChamber would print "the last motion to do so
  //     failed", and the rule passed.
  //     THE SUBJECT IS PINNED TO THE RULE, as in scripts/moment-scaffold.mjs's
  //     floor-action pattern: the citation of the resolution is required
  //     between "Rule" and the verb, so a bill that genuinely passes the House
  //     ("Passed House ...") never reads as pending here. The defeated sibling
  //     "Rule H. Res. 1175 failed passage of House." is stopped twice — rule 0
  //     catches "failed", and "failed passage of" does not fit this pattern.
  //     A STALE adopted rule never crowns: billFloorBand's freshness gate
  //     (isSignalFresh) runs before this function is asked, and deriveJourney
  //     renders the stale sentence for it instead.
  if (/\brule\s+h\.\s?res\.\s*\d+\s+passed\s+house\b/i.test(actionText)) return 'house';
  // (6) THE MEASURE IS UNDER CONSIDERATION (2026-09-24, S. 4668): the chamber
  //     is debating it on its own floor, so its vote there is still ahead.
  //     See SENATE_CONSIDERATION's header for the three groups.
  if (SENATE_CONSIDERATION.test(actionText)) return 'senate';
  if (HOUSE_CONSIDERATION.test(actionText)) return 'house';
  // The chamber-silent sentences take their chamber from the record's own
  // page citation or not at all — a bare "Considered as unfinished business."
  // stays silent.
  if (CHAMBER_SILENT_CONSIDERATION.test(actionText)) {
    // The SAME citation floorActionChamber's rule 4 reads, and that rule runs
    // before any chamber-word rule there — so the two functions cannot
    // disagree about these sentences.
    const cr = CR_PAGE.exec(actionText);
    if (cr) return cr[1] === 'S' ? 'senate' : 'house';
    return null;
  }
  // Everything else: the record did not say a vote is coming, so we do not.
  return null;
}

/**
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
 * DO", so it happily classified all of the corpus's failed-motion texts and
 * the stepper announced a live deliberation over each one. S.J.Res. 172 —
 * itself a vehicle of a live Big Question — printed "Right now: the Senate is
 * deciding whether to bring it to a vote" three lines above its own record
 * saying the discharge motion was rejected 47–48 on 2026-06-16. The chamber
 * was right; the verb was a fabrication.
 *
 * THE GATE IS THE VOCABULARY, NOT THE CHAMBER. A text only reaches the chamber
 * lookup once FLOOR_SETTLED has matched, so "Considered by Senate" — readable
 * chamber, no settled word — does NOT get called a failed motion. (Since
 * 2026-09-24 floorPendingChamber reads it as a vote still ahead; before that
 * it fell to the caller's residual branch.) Both directions fail closed: we
 * never claim a vote is coming, and we never claim one died, without the
 * record's own words for it.
 *
 * MUTUALLY EXCLUSIVE WITH BOTH ITS NEIGHBOURS, by construction rather than by
 * promise. Against floorPendingChamber: FLOOR_SETTLED is that function's
 * rule 0, so a text cannot be both. Against floorCalendarChamber: the explicit
 * guard below, so a live placement that happens to mention a rejected
 * amendment somewhere in its sentence stays a placement. tests/journey.unit
 * .spec.ts pins all three pairings over the live corpus.
 *
 * @param {string | null | undefined} actionText
 * @returns {'house' | 'senate' | null}
 */
export function floorSettledChamber(actionText) {
  if (!actionText) return null;
  if (!FLOOR_SETTLED.test(actionText)) return null;
  // A dated calendar placement is a live fact, whatever else the sentence says.
  if (floorCalendarChamber(actionText)) return null;
  return floorActionChamber(actionText);
}

/**
 * A FAILED SENATE VOTE WITH A MOTION TO RECONSIDER ENTERED — the one reading
 * rule 0 above cannot give, added 2026-09-24 for the Big Questions status line.
 *
 * The record, verbatim (hr-3633-119, 2026-09-15):
 *
 *   "Motion by Senator Tillis to reconsider the vote by which cloture on the
 *    motion to proceed to the measure was not invoked (Record Vote No. 234)
 *    entered in Senate."
 *
 * floorPendingChamber's rule 0 settles this sentence as FAILED on its "not
 * invoked" clause, and that stays exactly as it is: owner decision D4
 * (2026-08-09) says the crown never wears it, and nothing here changes what
 * floorPendingChamber, floorSettledChamber, the crown, the ladder or the
 * stepper answer. The settled reading is TRUE — the vote did fail. It is also
 * incomplete: a senator who voted on the prevailing side has entered a motion
 * to reconsider, so the same question can come back to the floor. This
 * function exists so ONE surface — the per-vehicle status line on a Big
 * Question (lib/moment-status.mjs) — can say both halves, and no other reader
 * consults it.
 *
 * FAIL-CLOSED, all four clauses required together:
 *   · "Motion by Senator …" — the Senate's form for a named senator's motion
 *     (the House's routine "Motion to reconsider laid on the table Agreed to
 *     without objection." is the OPPOSITE fact: reconsideration closed, and it
 *     never names a senator);
 *   · "to reconsider";
 *   · "the vote by which … was not invoked / was rejected / failed" — the
 *     motion is aimed at a vote that FAILED (a reconsider aimed at a vote that
 *     carried is a different story and is not read here);
 *   · "entered in Senate" — the motion was entered, not tabled, withdrawn or
 *     disposed of.
 * And an explicit exclusion for any sentence that also says the motion was
 * tabled, withdrawn, or agreed to / rejected, so a compound disposition line
 * can never read as still pending.
 *
 * Both live corpus shapes are pinned by verbatim fixture in
 * tests/moment-status.unit.spec.ts, including s-2882-119's longer form
 * ("…to reconsider, under the order of 10/9/2025, not having voted on the
 * prevailing side, the vote by which the third cloture motion … was not
 * invoked (Record Vote No. 557) entered in Senate.").
 *
 * @param {string | null | undefined} actionText
 * @returns {'senate' | null}
 */
export function floorReconsiderPendingChamber(actionText) {
  if (!actionText) return null;
  if (!/^\s*motion by senator\b/i.test(actionText)) return null;
  if (!/\bto reconsider\b/i.test(actionText)) return null;
  if (!/\bthe vote by which\b[\s\S]*\b(?:was not invoked|was rejected|failed)\b/i.test(actionText)) return null;
  if (!/\bentered in senate\b/i.test(actionText)) return null;
  if (/\b(?:laid on the table|tabled|withdrawn|motion to reconsider (?:agreed to|rejected))\b/i.test(actionText)) {
    return null;
  }
  return 'senate';
}

/**
 * A POINT OF ORDER OR A MOTION IS THE SENTENCE'S SUBJECT, NOT THE MEASURE
 * (2026-09-29, S.J.Res. 98).
 *
 * S.J.Res. 98's last action, verbatim from the record:
 *
 *   "Point of order that the measure is not entitled to expedited procedures
 *    under 50 U.S.C. 1546(a) raised against the measure agreed to in Senate
 *    by Yea-Nay Vote. 50 - 50. Record Vote Number: 9."
 *
 * The Senate agreed to the POINT OF ORDER, which took the resolution off its
 * expedited track. It never voted on the resolution itself. The motion to
 * proceed is written the same way, and there the Senate has agreed to START
 * debating the measure, the opposite of being done with it
 * (data/moment-updates.json quotes it for H.R. 6500 on 2026-08-05 and for
 * S. 4668 on 2026-09-17):
 *
 *   "Motion to proceed to consideration of measure agreed to in Senate by
 *    Yea-Nay Vote. 77 - 22. Record Vote Number: 236."
 *
 * A sentence that OPENS with "Point of order" or "Motion" records what the
 * chamber did with the point or the motion. Whatever passage words it carries
 * ("agreed to in Senate", "passed House", "received in the Senate") are never
 * a PASSAGE of the measure. lib/docket.mjs's floorAnsweredChamber reads this
 * before its passage rules, so those words never speak for the measure there.
 *
 * WHETHER THE CHAMBER ANSWERED IS A SEPARATE QUESTION (refined 2026-09-29).
 * S.J.Res. 98's sentence is not a passage, but it IS the Senate's answer for
 * that day: a point of order against the measure, sustained, ends the
 * measure's consideration on its expedited track. That reading is
 * `procedureEndedConsideration` below, which floorAnsweredChamber asks FIRST.
 * This reader stays exactly as it was, because it answers the passage
 * question, and it is the same text as the pipeline's (see the last
 * paragraph).
 *
 * STILL THE MEASURE, on purpose: a motion to concur, to recede, to agree to
 * the other chamber's amendment, or to suspend the rules and pass. Carrying
 * one of those IS the chamber agreeing to the measure's text. None opens a
 * sentence in the corpus (measured 2026-09-29 over every string in data/*.json);
 * they are carved out so this reader can only take a false answer away, never
 * a true one. Congress.gov's summary lines ("Passed/agreed to in House: On
 * motion to suspend the rules and pass the bill …") and the House's own "On
 * motion …" sentences do not open with "Motion", so they never reach it.
 *
 * WHAT IT DOES NOT CHANGE. A DEFEATED motion ("Motion to proceed to
 * consideration of measure rejected in Senate …") is FLOOR_SETTLED's, and the
 * post-vote notice ("Motion to reconsider laid on the table Agreed to without
 * objection.") has its own rule in floorAnsweredChamber. Both are read exactly
 * as before; this reader only stops passage words from speaking for the
 * measure.
 *
 * THE SAME TEXT AS THE PIPELINE'S. PR #363 (open as this is written) adds
 * `isProceduralAgreedTo` to scripts/congress-fetch.mjs with these two
 * patterns, so mapStatus stops filing these sentences as `passed_chamber`.
 * tests/procedural-answer.unit.spec.ts pins the two readers against each other
 * once both are on main.
 */
const PROCEDURAL_OPENING = /^\s*(?:point of order|motion)\b/i;
const PASSAGE_MOTION =
  /^\s*motion(?:\s+by\s+senator(?:\s+(?!to\b)\S+)+)?\s+(?:to|that the (?:house|senate))\s+(?:concur|recede|agree to the (?:house|senate) amendment|suspend the rules and (?:pass|agree|concur))\b/i;

/**
 * True when the sentence's subject is a point of order or a motion other than
 * one of the passage motions above, so nothing in it answers for the measure.
 *
 * @param {string | null | undefined} actionText
 * @returns {boolean}
 */
export function procedureIsTheSubject(actionText) {
  const t = String(actionText ?? '');
  return PROCEDURAL_OPENING.test(t) && !PASSAGE_MOTION.test(t);
}

/*
 * The shapes procedureEndedConsideration reads (its header says where each
 * was read). Every outcome is read AFTER the subject, so the point's own
 * wording ("that the measure is NOT entitled to expedited procedures") can
 * never count as its outcome.
 */
const POINT_AGAINST_THE_MEASURE = /^\s*point of order\b[\s\S]*?\bagainst the measure\b([\s\S]*)$/i;
const POINT_UPHELD = /\b(?:agreed to|sustained|well taken)\b/i;
const OUTCOME_NEGATED = /\bnot\s+(?:(?:been|was|is)\s+)?(?:agreed to|sustained|well taken|tabled)\b|\brejected\b/i;
const ADVANCING_MOTION_FELL_ON_POINT =
  /^\s*the motion to (?:discharge|proceed)\b[\s\S]*?\bfell when the point of order was (?:well taken|sustained)\b/i;
const ADVANCING_MOTION_TABLED = /^\s*(?:the\s+)?motion to (?:discharge|proceed)\b([^.]*?\btabled\b[\s\S]*)$/i;
const TABLE_ADVANCING_MOTION =
  /^\s*(?:table motion|motion(?:\s+by\s+senator(?:\s+(?!to\b)\S+)+)?\s+to table the motion) to (?:discharge|proceed)\b([\s\S]*)$/i;

/**
 * A PROCEDURAL OUTCOME THAT ENDED THE MEASURE'S CONSIDERATION — the ones that
 * ARE the chamber answering, though never a passage (2026-09-29, S.J.Res. 98,
 * S.J.Res. 124 and H.J.Res. 117).
 *
 * The records, verbatim (Congress.gov bill status, 119th Congress):
 *
 *   S.J.Res. 98, 2026-01-14, its last action:
 *     "Point of order that the measure is not entitled to expedited procedures
 *      under 50 U.S.C. 1546(a) raised against the measure agreed to in Senate
 *      by Yea-Nay Vote. 50 - 50. Record Vote Number: 9."
 *
 *   S.J.Res. 124, 2026-04-28, its last two actions, oldest first:
 *     "Point of order that the measure is not entitled to expedited procedures
 *      under 50 U.S.C. 1546a raised against the measure agreed to in Senate by
 *      Yea-Nay Vote. 51 - 47. Record Vote Number: 108."
 *     "The motion to discharge fell when the point of order was well taken."
 *
 *   H.J.Res. 117, 2025-09-15, the House's privileged discharge motion:
 *     "Table Motion to Discharge Agreed to by the Yeas and Nays: 200 - 198
 *      (Roll no. 265)."
 *     "Motion to discharge tabled."  (its last action)
 *
 * None is a passage (procedureIsTheSubject above, and PR #363's
 * `isProceduralAgreedTo` in scripts/congress-fetch.mjs, which stops mapStatus
 * filing S.J.Res. 98 as `passed_chamber`). But each is the chamber taking the
 * question up and ending it: S.J.Res. 98 lost its expedited track, S.J.Res.
 * 124's motion to discharge fell, and H.J.Res. 117's was tabled. That is
 * lib/types.ts's `just_decided`, "the floor took the question up and the
 * answer was no", and it is the answer the ladder already reads from a
 * REJECTED motion to discharge ("Motion to discharge Senate Committee on
 * Foreign Relations rejected by Yea-Nay Vote. 47 - 48.", S.J.Res. 172, through
 * FLOOR_SETTLED). So lib/docket.mjs's floorAnsweredChamber returns the chamber
 * for these sentences, and a live announcement over the measure retires the
 * day it happens, instead of keeping a "Deciding now" crown for up to two days
 * after the chamber said no.
 *
 * WHAT IS NOT AN ANSWER, read over 3,893 distinct action sentences on
 * 2026-09-29 (data/*.json plus the Congress.gov bill-status files saved from
 * earlier fact-checks; the verbatim list is in
 * tests/procedural-answer.unit.spec.ts):
 *   - a motion that ADVANCES the measure, agreed to: "Motion to proceed to
 *     consideration of measure agreed to in Senate …" (34 sentences). The
 *     Senate has agreed to START debating it;
 *   - a motion to TABLE something aimed AT the measure, agreed to. Each one in
 *     the record kept the measure alive or left it alone: the point of order
 *     against H.J.Res. 140 was tabled 51 - 48 and the measure became law, an
 *     appeal on S.J.Res. 55 was tabled, amendments SA 6777 and SA 6779 to S.
 *     4668 were tabled. Tabling is an answer only when what is tabled is the
 *     measure's OWN advancing motion (H.J.Res. 117 above), which is why shape 3
 *     below names the motion to discharge or to proceed and nothing else;
 *   - a point of order about the chamber's PROCEDURE rather than against the
 *     measure: "Point of order by Senator Thune: Shall points of order be in
 *     order under the Congressional Review Act? agreed to in Senate …" (two on
 *     S.J.Res. 55, both of which kept the review track open), and "Ruling of
 *     the Chair that the point of order … sustained." on the same record;
 *   - a point of order against an AMENDMENT ("Point of order that the
 *     amendment violates section 305(b)(2) of the CBA raised in Senate with
 *     respect to amendment SA 130."): the amendment falls, not the measure;
 *   - a point of order RAISED with no outcome yet ("… raised in Senate.
 *     (CR S1780)", H.J.Res. 140), or one NOT sustained, not agreed to or not
 *     well taken; a motion MADE ("Mr. Mast moved to table the motion to
 *     discharge"); and "Motion by Senator Thune to commit … fell when cloture on
 *     amendment SA 6732 was invoked in Senate." (H.R. 6500), a motion that
 *     "fell" with no point of order while the measure stayed before the
 *     Senate.
 *
 * THREE SHAPES, each anchored on the sentence's subject and fail-closed like
 * the readers around them. Each is pinned by its verbatim sentence in
 * tests/procedural-answer.unit.spec.ts. A few variants are constructed and
 * labelled there ("sustained" in shape 1, "the motion to proceed" in shapes 2
 * and 3, the Senate's "Motion to table the motion to discharge agreed to in
 * Senate" in shape 3), because the record has not printed them yet:
 *   1. It OPENS with "Point of order", names "against the measure", and after
 *      that says the point was agreed to, sustained or well taken.
 *   2. It OPENS with "The motion to discharge" (or "to proceed") and says it
 *      "fell when the point of order was well taken" (or sustained).
 *   3. The motion to discharge (or to proceed) was TABLED: "Motion to discharge
 *      tabled.", "Table Motion to Discharge Agreed to …", or "Motion to table
 *      the motion to discharge agreed to …".
 * In every shape a "not" in front of the outcome, or "rejected", means the
 * chamber did NOT do it, and the sentence is no answer.
 *
 * WHICH CHAMBER is floorAnsweredChamber's to say: it reads floorActionChamber,
 * the attribution floorSettledChamber uses. S.J.Res. 124's and H.J.Res. 117's
 * sentences name no chamber, so they answer 'unknown', the ladder's existing
 * word for an outcome the sentence does not attribute.
 *
 * @param {string | null | undefined} actionText
 * @returns {boolean}
 */
export function procedureEndedConsideration(actionText) {
  const t = String(actionText ?? '');
  const point = POINT_AGAINST_THE_MEASURE.exec(t);
  if (point) return POINT_UPHELD.test(point[1]) && !OUTCOME_NEGATED.test(point[1]);
  if (ADVANCING_MOTION_FELL_ON_POINT.test(t)) return true;
  const tabled = ADVANCING_MOTION_TABLED.exec(t);
  if (tabled) return !OUTCOME_NEGATED.test(tabled[1]);
  const table = TABLE_ADVANCING_MOTION.exec(t);
  if (table) return /\bagreed to\b/i.test(table[1]) && !OUTCOME_NEGATED.test(table[1]);
  return false;
}

/*
 * A CHAMBER'S OWN PASSAGE SENTENCE — anchored, and naming the chamber that
 * acted. Anchored because "Rule H. Res. 988 passed House." reports a RULE's
 * passage, not this bill's, and an unanchored match would read it as one.
 * Three openings, each copied from the record:
 *
 *   "Passed Senate without amendment by Unanimous Consent."  (bills, joint
 *       resolutions; H.R. 1276)
 *   "Passed/agreed to in House: On agreeing to the resolution …"
 *       Congress.gov's own summary line for a chamber's passage (2026-09-24)
 *   "Resolution agreed to in Senate without amendment by Yea-Nay Vote.
 *       50 - 48. Record Vote Number: 184."  the Senate's own sentence for
 *       agreeing to a resolution (2026-09-28, H.Con.Res. 86). It was not read
 *       before, so whenever it was the latest step — H.Con.Res. 86's for the
 *       day before "Message on Senate action sent to the House." was written
 *       over it — an hconres the Senate had just agreed to fell to the
 *       'first' default: "it passed the House and now goes to the Senate",
 *       with the call routed to the senators who had just voted.
 *
 * The amendment clause of each is read by passageState exactly the same way.
 */
const PASSAGE_OPENING = /^\s*(?:Passed(?:\/agreed to in)?|Resolution agreed to in) (House|Senate)\b/i;

/** @param {string} type @returns {'house' | 'senate'} */
const originOf = (type) => (String(type).toLowerCase().startsWith('h') ? 'house' : 'senate');

/**
 * A CONCURRENT RESOLUTION BOTH CHAMBERS HAVE AGREED TO IN ONE FORM — which is
 * the end of its path (2026-09-28, H.Con.Res. 86).
 *
 * A concurrent resolution is never presented to the President
 * (lib/journey.ts `journeyEnding`: 'bothChambers'). Once the second chamber
 * agrees to the first chamber's text WITHOUT AMENDMENT, both chambers hold the
 * same text and nothing is left to decide: no chamber votes on it again, and
 * no one signs it. The record says so in the second chamber's own sentence —
 * H.Con.Res. 86: the House agreed 215–208 on 2026-06-03 (Roll no. 199), then
 * "Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48.
 * Record Vote Number: 184." on 2026-06-23.
 *
 * WHY passageState DOES NOT SAY THIS. Its 'both' stage renders "It goes to the
 * President next", which a concurrent resolution never does, so it fails
 * closed to 'second' for hconres/sconres — and the stepper's 'second'
 * sentence says "the official record doesn't say yet whether the two versions
 * match", which the record DOES say. The vocabulary has no stored status for
 * "agreed to by both chambers", and the stepper has no sentence for it yet, so
 * this is the one reader every surface that can say it reads: the Big
 * Questions line (lib/moment-status.mjs `bothAgreed`, terminal), the MCP
 * envelope (lib/docket.mjs `decisionState`: settled, no act_url) and the
 * ladder (lib/docket.mjs `docketRung`: terminal).
 *
 * Returns the chamber whose agreement completed it, or null. Null unless ALL
 * of these hold, so a record this cannot read keeps whatever it said before:
 *   - a concurrent resolution (hconres / sconres), stored at `passed_chamber`
 *     (the status the passage sentence maps to — the one the stepper's
 *     passage branch reads, so the two can never disagree about the record);
 *   - the sentence the status was read from (statusBasisText) is a passage
 *     sentence (PASSAGE_OPENING) by the chamber that did NOT originate it;
 *   - it says "without amendment", and names no amendment besides.
 *
 * FAIL-CLOSED on the House form, stated rather than guessed at. The House's
 * sentences for agreeing to a Senate concurrent resolution ("Passed/agreed to
 * in House: On agreeing to the resolution Agreed to without objection." —
 * S.Con.Res. 29, 2026-04-20) carry no amendment clause at all, so they are
 * not read as agreement in one form, even where the record's text version is
 * "Enrolled Bill". A missed ending is cheaper than a wrong one.
 *
 * @param {{ bill_type?: string | null, status?: string | null, last_action_text?: string | null, status_basis_text?: string | null } | null | undefined} bill
 * @returns {'house' | 'senate' | null}
 */
export function concurrentAdoptedBy(bill) {
  const type = String(bill?.bill_type ?? '').toLowerCase();
  if (type !== 'hconres' && type !== 'sconres') return null;
  if (bill?.status !== 'passed_chamber') return null;
  const text = statusBasisText(bill) ?? '';
  const passage = PASSAGE_OPENING.exec(text);
  if (!passage) return null;
  /** @type {'house' | 'senate'} */
  const by = passage[1].toLowerCase() === 'senate' ? 'senate' : 'house';
  if (by === originOf(type)) return null;
  if (!/\bwithout amendment\b/i.test(text)) return null;
  if (/\bwith (?:an? )?amendments?\b/i.test(text)) return null;
  return by;
}

/**
 * WHERE A PASSED BILL STANDS BETWEEN THE CHAMBERS — moved here from
 * lib/journey.ts on 2026-09-24, unchanged, for the same reason the floor
 * readers above moved on 2026-08-12: a node script now needs it.
 * scripts/moment-watch.mjs diffs the Big Questions status lines nightly, and
 * node cannot import TypeScript. lib/journey.ts re-exports it, so every
 * existing caller (and its header, which still explains the stages) is
 * untouched.
 *
 * @param {{ bill_type: string, last_action_text?: string | null }} bill
 * @returns {{ stage: 'first' | 'back' | 'both' | 'second', passedBy: 'house' | 'senate' | null, next: 'house' | 'senate' | null }}
 */
export function passageState(bill) {
  /** @type {'house' | 'senate'} */
  const origin = bill.bill_type.startsWith('h') ? 'house' : 'senate';
  /** @type {'house' | 'senate'} */
  const other = origin === 'house' ? 'senate' : 'house';
  // The sentence the status was READ from (statusBasisText, #286): for a bill
  // whose last action is "Motion to reconsider laid on the table…", that is
  // the vote before it, e.g. "Passed/agreed to in House: On motion to suspend
  // the rules and pass the bill Agreed to by voice vote." The message read
  // below stays on last_action_text, because the message IS that sentence.
  const text = statusBasisText(bill) ?? '';
  // The chamber's own passage sentence, read by PASSAGE_OPENING below.
  const passage = PASSAGE_OPENING.exec(text);
  // THE NOTICE THAT FOLLOWS A PASSAGE (2026-09-24, H.Con.Res. 86). "Message
  // on Senate action sent to the House." is what Congress writes OVER the
  // passage sentence once the acting chamber notifies the other; since that
  // date mapStatus files it as `passed_chamber`. Read here so the routing does
  // not fall to the 'first' default (which would print "the Senate decides
  // next" about the chamber that had just decided). A second-chamber notice
  // is 'second' (both have acted, no next step named), never 'both' or 'back'.
  const message = /^\s*Message on (House|Senate) action sent to the (?:House|Senate)\b/i.exec(
    bill.last_action_text ?? ''
  );
  if (!passage && message) {
    /** @type {'house' | 'senate'} */
    const actedBy = message[1].toLowerCase() === 'senate' ? 'senate' : 'house';
    return actedBy === origin
      ? { stage: 'first', passedBy: actedBy, next: other }
      : { stage: 'second', passedBy: actedBy, next: null };
  }
  if (!passage) return { stage: 'first', passedBy: null, next: other };
  /** @type {'house' | 'senate'} */
  const passedBy = passage[1].toLowerCase() === 'senate' ? 'senate' : 'house';
  if (passedBy === origin) return { stage: 'first', passedBy, next: other };
  if (/\bwithout amendment\b/i.test(text)) {
    // 'both' renders "It goes to the President next", and a CONCURRENT
    // resolution never goes to the President (it binds only Congress), so
    // hconres/sconres fail closed to 'second' — both chambers acted, no next.
    // That the path has ENDED is concurrentAdoptedBy's answer, above.
    const concurrent = /conres$/i.test(bill.bill_type);
    return { stage: concurrent ? 'second' : 'both', passedBy, next: null };
  }
  if (/\bwith (?:an? )?amendments?\b/i.test(text)) {
    return { stage: 'back', passedBy, next: origin };
  }
  return { stage: 'second', passedBy, next: null };
}
