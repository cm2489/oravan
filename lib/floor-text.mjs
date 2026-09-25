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
 * Usually that is `last_action_text`. But two last-action sentences cannot be
 * read on their own — "Motion to reconsider laid on the table…" follows a
 * failed vote as readily as a passage, and "Message on Senate action sent to
 * the House." does not say what the Senate did (scripts/congress-fetch.mjs's
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
 */
export const FLOOR_SETTLED = /\b(rejected|not invoked|failed|withdrawn|indefinitely postponed)\b/i;

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
 * once a measure is physically on the floor ("cloture … invoked", "Motion to
 * proceed to measure considered in Senate", and a chamber-silent
 * consideration sentence with no page citation). Neither may be swapped for
 * the other — see that function's own header.
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
  // Anchored: "Rule H. Res. 988 passed House." reports a RULE's passage, not
  // this bill's, and an unanchored match would read it as one.
  // "Passed/agreed to in House: …" is Congress.gov's own summary line for a
  // chamber's passage (2026-09-24): it names the chamber, and its amendment
  // clause is read below exactly like a "Passed House …" sentence's.
  const passage = /^\s*Passed(?:\/agreed to in)? (House|Senate)\b/i.exec(text);
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
    const concurrent = /conres$/i.test(bill.bill_type);
    return { stage: concurrent ? 'second' : 'both', passedBy, next: null };
  }
  if (/\bwith (?:an? )?amendments?\b/i.test(text)) {
    return { stage: 'back', passedBy, next: origin };
  }
  return { stage: 'second', passedBy, next: null };
}
