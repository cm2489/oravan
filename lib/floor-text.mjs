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
 * there gates a RANKING position and admits two further sentences Congress
 * writes once a measure is physically on the floor. Neither may be swapped
 * for the other — see that function's own header.
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
