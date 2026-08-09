/*
 * SENATE NOMINATION STATUS — the ONE copy, in the lib/urgency.mjs idiom.
 *
 * Plain .mjs with JSDoc types so the node sync script (scripts/sync-nominations.mjs),
 * the CI gate (scripts/check-nominations.mjs), the TS data layer
 * (lib/core/nominations.ts) and the unit suite all import the SAME
 * implementation rather than three that can drift. Import-free on purpose:
 * nothing here may reach for the filesystem, the network, or a TS-only module.
 *
 * ── NAMING, AND THE COLLISION IT AVOIDS ────────────────────────────────────
 * "Nomination" in this file always means a SENATE NOMINATION — a presidential
 * nomination (PN) referred to the Senate for advice and consent. It has
 * NOTHING to do with the "domain nomination" family in lib/embed-referrer.ts
 * and scripts/check-key-namespaces.mjs, which is an embed-privacy mechanism
 * for referrer domains. Both words were already taken; every symbol here
 * carries the Nomination/nominee/PN qualifier so neither module's doc
 * comments become ambiguous when read side by side.
 *
 * ── WHY NOT REUSE mapStatus() ──────────────────────────────────────────────
 * scripts/congress-fetch.mjs's mapStatus() is a BILL mapper and is actively
 * wrong on nominations — not merely imprecise, but wrong in the one direction
 * that matters. Measured against the live 119th Congress on 2026-08-06:
 *
 *   - 511 of 859 civilian nominations read "Confirmed by the Senate by
 *     Yea-Nay Vote. 51 - 47. Record Vote Number: 547." mapStatus matches
 *     `yea-nay vote` (congress-fetch.mjs:103) and returns `floor_vote` —
 *     a claim that a vote is PENDING on a nomination the Senate finished
 *     months ago. That is the manufactured urgency this product exists to
 *     refuse, on a majority of the corpus.
 *   - "Placed on Senate Executive Calendar. Calendar No. 911." matches
 *     `placed on` and also returns `floor_vote`.
 *
 * Hence a separate mapper, and hence the ordering below: every TERMINAL rule
 * is evaluated before any live-status rule, so a finished nomination can
 * never fall through into one. tests/nomination-status.unit.spec.ts pins that
 * property against the exact live sentences.
 *
 * Note also that lib/journey.ts's floorCalendarChamber() does NOT fire on
 * these texts: its regex requires `(senate legislative|union|house|senate)\s+
 * calendar`, and "Senate Executive Calendar" fails at `\s+calendar`. That is
 * correct — the Executive Calendar is not a legislative calendar — but it
 * means nothing in lib/journey.ts derives a chamber claim for a nomination.
 * Everything a nomination surface says about the Senate must come from here.
 *
 * The vocabulary is pinned by tests/nomination-status.unit.spec.ts — extend
 * it there first.
 */

/**
 * The nine statuses a Senate nomination can be classified into, in rough
 * procedural order. `mapNominationStatus` may ALSO return
 * `UNCLASSIFIED_NOMINATION_STATUS` (see below), which is a tenth STORED value
 * but deliberately not a member of this set: this list is the vocabulary a
 * surface may make a claim from, and "unclassified" is the absence of one.
 *
 * @type {readonly string[]}
 */
export const NOMINATION_STATUSES = [
  'received', //       received in the Senate and referred to a committee
  'hearing', //        the committee of jurisdiction has held hearings
  'reported', //       ordered reported out of committee
  'exec_calendar', //  placed on the Senate Executive Calendar
  'floor', //          a live floor proceeding (cloture, a motion to reconsider)
  'scheduled', //      a unanimous-consent agreement naming a debate date
  'confirmed', //      TERMINAL — the Senate consented
  'returned', //       TERMINAL — returned to the President under Rule XXXI
  'withdrawn', //      TERMINAL — the President withdrew it
];

/**
 * The honest verdict when no rule matches. Every consumer must render this as
 * neutral, chamber-free, claim-free copy — the posture of
 * lib/journey.ts's floorActionChamber() rule 7 (owner ruling 2026-08-04):
 * reaching this branch is honest, guessing past it is a lie.
 *
 * This exists because the vocabulary below was derived from a MEASURED corpus
 * (all 2,039 nominations of the 119th Congress, read 2026-08-06 — 33 distinct
 * normalized civilian action shapes), and the Senate is free to invent a
 * thirty-fourth tomorrow. scripts/check-nominations.mjs sweeps for these so
 * the branch stays rare and attributable.
 */
export const UNCLASSIFIED_NOMINATION_STATUS = 'unclassified';

/** Every value that may legitimately be STORED in data/nominations.json. */
export const STORED_NOMINATION_STATUSES = [
  ...NOMINATION_STATUSES,
  UNCLASSIFIED_NOMINATION_STATUS,
];

/**
 * Past the advice-and-consent window: nothing a caller says can change these.
 * A confirmed nomination cannot be un-confirmed by a phone call, a returned
 * one is back with the President under Rule XXXI, and a withdrawn one is
 * gone. Same role TERMINAL_STATUSES plays for bills in lib/urgency.mjs.
 *
 * @type {ReadonlySet<string>}
 */
export const TERMINAL_NOMINATION_STATUSES = new Set(['confirmed', 'returned', 'withdrawn']);

/**
 * The calendar day a unanimous-consent agreement names, as a UTC-midnight
 * timestamp — or `null` when the sentence names none.
 *
 * Exported because two callers outside the mapper need the SAME parse:
 * mapNominationStatus below, and scripts/check-nominations.mjs, which has to
 * tell the one legitimate stored-status drift (a UC date that lapsed since
 * the corpus was written) apart from real code/data divergence. Two parsers
 * would let those two disagree about which records are stale.
 *
 * MEASURED SHAPES (all four read live off /nomination/119/{n}/actions on
 * 2026-08-09, action code S05307):
 *
 *   "By unanimous consent agreement, debate 8/6/2026."
 *   "By unanimous consent agreement, vote 9/17/2025."
 *   "By unanimous consent agreement, debate pursuant to S. Res. 377, 119th
 *    Congress on 9/17/2025."
 *   "By unanimous consent agreement, debate mandatory quorum required under
 *    Rule XXII waived."                              <- NO DATE AT ALL
 *
 * The LAST M/D/YYYY in the sentence wins. The third shape is why: it carries
 * a resolution number and a Congress number before the date, and only the
 * trailing group is the day the Senate agreed to. Taking the last match also
 * degrades safely — a future shape that prefixes another date still ends on
 * the operative one, and the no-date shape yields null rather than a guess.
 *
 * Impossible days ("2/30/2026") return null instead of rolling over into
 * March, because a rolled-over date would silently move a claim about WHEN
 * the Senate acts, which is the one thing this parse exists to pin down.
 *
 * @param {string | null | undefined} actionText
 * @returns {number | null} UTC midnight of the named day, or null
 */
export function ucAgreementDay(actionText) {
  const text = actionText ?? '';
  if (!/\bunanimous consent agreement\b/i.test(text)) return null;
  const all = [...text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)];
  if (all.length === 0) return null;
  const [, mm, dd, yyyy] = all[all.length - 1];
  const m = Number(mm);
  const d = Number(dd);
  const y = Number(yyyy);
  const ts = Date.UTC(y, m - 1, d);
  const back = new Date(ts);
  // Date.UTC happily rolls 2/30 into 3/2; a round-trip is the only way to
  // reject a day the calendar does not have.
  if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ts;
}

/** UTC midnight of the day `now` falls in — the granularity every comparison
 *  in this module works at. A unanimous-consent agreement names a DAY, not an
 *  instant, so it has not lapsed until that whole day is behind us; comparing
 *  raw timestamps would retire an agreement at midnight UTC on its own
 *  morning. UTC on both sides so the verdict cannot depend on which machine
 *  (a GitHub runner, a Vercel build, a laptop) asked the question. */
function utcDay(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Classify a Senate nomination's latest-action text.
 *
 * ORDERED RULES, FIRST HIT WINS. The order is the safety property, not a
 * style choice — see the header. Each rule cites the live sentence(s) it was
 * written against; all counts are civilian nominations of the 119th Congress
 * measured 2026-08-06 unless noted.
 *
 * @param {string | null | undefined} actionText
 * @param {number} [now] epoch ms, for the one time-dependent rule (4). Defaults
 *   to the current clock; injected by tests and by the corpus gates so a
 *   verdict can be reproduced for a fixed day.
 * @returns {string} a member of STORED_NOMINATION_STATUSES
 */
export function mapNominationStatus(actionText, now = Date.now()) {
  const text = (actionText ?? '').trim();
  if (!text) return UNCLASSIFIED_NOMINATION_STATUS;

  /* ---- TERMINAL RULES FIRST. Non-negotiable ordering. ---- */

  // (1) "Confirmed by the Senate by Yea-Nay Vote. 51 - 47. Record Vote
  //     Number: 547." (511) and "Confirmed by the Senate by Voice Vote."
  //     (18; 1,010 more on the military side). This rule MUST precede every
  //     rule that could read a vote as pending — it is the whole reason the
  //     bill mapper is unusable here.
  if (/\bconfirmed by the senate\b/i.test(text)) return 'confirmed';

  // (2) "Returned to the President under the provisions of Senate Rule XXXI,
  //     paragraph 6 of the Standing Rules of the Senate." (91)
  if (/\breturned to the president\b/i.test(text)) return 'returned';

  // (3) "Received message of withdrawal of nomination from the President."
  //     (67). Matched on "withdrawal", not on "received": the sentence opens
  //     with "Received message of", which rule 10 would otherwise claim.
  if (/\bwithdrawal\b/i.test(text)) return 'withdrawn';

  // (3b) "Motion by Senator Thune to reconsider tabled in Senate by Yea-Nay
  //      Vote. 52 - 47. Record Vote Number: 38." (1 — PN11-22, Russell
  //      Vought, OMB). TABLING A MOTION TO RECONSIDER IS THE SENATE'S
  //      CONFIRMATION-LOCKING RITUAL: the majority enters a motion to
  //      reconsider the vote just taken, then moves to table it, and tabling
  //      it puts the question permanently beyond reopening.
  //
  //      VERIFIED, because this rule asserts a completed confirmation from a
  //      sentence that never uses the word. Read live off
  //      /nomination/119/11-22/actions on 2026-08-09 (14 actions; the two
  //      newest, both 2025-02-06, in Congress.gov's own newest-first order):
  //
  //        S05360  Motion by Senator Thune to reconsider tabled in Senate by
  //                Yea-Nay Vote. 52 - 47. Record Vote Number: 38.   <- latest
  //        S05310  Confirmed by the Senate by Yea-Nay Vote. 53 - 47.
  //                Record Vote Number: 37.
  //
  //      The confirmation IMMEDIATELY precedes the tabling, and nothing
  //      follows it. Until this rule existed the sentence fell through to
  //      rule 6 and PN11-22 was stored `floor` — a full call rail urging
  //      senators to vote on a confirmation the Senate finished 18 months
  //      earlier, an /api/script spend to write that script, and a record the
  //      Moments gate would have accepted as a live vehicle.
  //
  //      THE CLOTURE EXCLUSION IS LOAD-BEARING, not defensive. The 119th
  //      carries a SECOND S05360 shape, on PN22-2 / PN26-1 / PN141-37 (read
  //      the same day): "Motion by Senator Thune to reconsider the vote
  //      (Record Vote No. 522), by which cloture was not invoked on the
  //      nominations en bloc agreed to in Senate by Yea-Nay Vote. 51 - 47.
  //      Record Vote Number: 523." That one reopens a FAILED CLOTURE, and the
  //      record kept moving after it — a point of order, a ruling of the
  //      chair, "Upon reconsideration, cloture invoked", "Considered by
  //      Senate". Reading it as a confirmation would be a fabricated claim
  //      about a named private citizen. It carries no "tabled" today, so the
  //      first half of this test already misses it; the explicit `cloture`
  //      exclusion is what keeps that true if the Senate ever tables one.
  //
  //      Stated as one self-contained test rather than by sitting below the
  //      cloture rule, so the header's "every TERMINAL rule is evaluated
  //      before any live-status rule" stays literally true and this rule's
  //      safety does not depend on where in the list it happens to be.
  if (/\bto reconsider\b[^.]*\btabled\b/i.test(text) && !/\bcloture\b/i.test(text)) {
    return 'confirmed';
  }

  /* ---- LIVE RULES, most specific first. ---- */

  // (4) "By unanimous consent agreement, debate 8/6/2026." (74) — the Senate
  //     has agreed a date. This is the only shape in the corpus that names a
  //     calendar date, so it must not be flattened into `floor`... while that
  //     date is still ahead.
  //
  //     THE DATE IS COMPARED, NOT JUST PARSED. `scheduled` renders as
  //     "Scheduled for a Senate vote" (nominations.status.scheduled, both
  //     locales) — a claim about the FUTURE. A UC agreement is a fact about
  //     one named day, so that claim expires with the day; without this
  //     comparison the sentence asserted an upcoming Senate vote forever, and
  //     a nomination whose debate date passed in 2025 would still be telling
  //     readers in 2027 that a vote is coming.
  //
  //     THE FALLBACK IS `floor`, AND IT IS A NARROWER CLAIM, NEVER A GUESS.
  //     Entering a unanimous-consent agreement IS Senate floor business about
  //     this nomination, and `floor` renders as "Senate floor activity" —
  //     backward-looking, no date, no promise. So a lapsed or date-less
  //     agreement still says the true thing (this reached the Senate floor)
  //     and stops saying the false one (a vote is coming). It stays
  //     non-terminal because it IS non-terminal: no confirmation, return or
  //     withdrawal has been recorded, so the nomination is still pending and
  //     still callable. `unclassified` was the alternative and is wrong here
  //     — the record does say where this stands, it just stopped saying when.
  //
  //     A date-less agreement takes the same branch, for the same reason:
  //     "By unanimous consent agreement, debate mandatory quorum required
  //     under Rule XXII waived." is real, live, and names no day (see
  //     ucAgreementDay above for all four measured shapes).
  //
  //     This is the ONE rule in this file that reads a clock. See the corpus
  //     note in scripts/check-nominations.mjs for what that costs: a stored
  //     `scheduled` is a verdict about the day it was written, so it goes
  //     stale by design and the gates treat exactly that drift as expected.
  if (/\bunanimous consent agreement\b/i.test(text)) {
    const day = ucAgreementDay(text);
    return day !== null && day >= utcDay(now) ? 'scheduled' : 'floor';
  }

  // (5) "Cloture motion presented in Senate." (1). Cloture exists only in the
  //     Senate and only on the floor (same reasoning as lib/journey.ts's
  //     floorActionChamber rule 1).
  if (/\bcloture\b/i.test(text)) return 'floor';

  // (6) A motion to reconsider that was NOT tabled — the question is open
  //     again, which is live floor business and reads as such.
  //
  //     WHAT IS LEFT FOR THIS RULE, after rule 3b took the tabled case and
  //     rule 5 took every sentence naming cloture: on the corpus of
  //     2026-08-09, nothing. Both measured S05360 shapes are claimed earlier
  //     (see rule 3b for both, verbatim). It is kept rather than deleted
  //     because a bare pending motion to reconsider is a real Senate action
  //     and `floor` is the true reading of it — the Senate has the question
  //     before it, which is exactly what "a live floor proceeding" means.
  //     Rule 3b's evidence is the reason to trust that split: on PN22-2 the
  //     un-tabled reconsider was followed by four more floor actions, while
  //     on PN11-22 the tabled one was followed by nothing, ever.
  //
  //     Deliberately narrow: a generic `yea-nay vote` rule here would
  //     re-create exactly the bill mapper's failure for any future sentence
  //     shape, so anything with a recorded vote that is neither a
  //     confirmation nor a reconsideration falls through to `unclassified`
  //     rather than being asserted as live floor business.
  if (/\bto reconsider\b/i.test(text)) return 'floor';

  // (7) "Placed on Senate Executive Calendar. Calendar No. 911." (4), the
  //     same plus "Subject to nominee's commitment to respond to requests to
  //     appear and testify..." (6), and "Placed on Senate Executive Calendar
  //     in the Privileged Nomination section with nominee information
  //     requested by the Committee on Agriculture, Nutrition, and Forestry,
  //     pursuant to S.Res. 116, 112th Congress." (1) — note that last one
  //     carries NO calendar number at all, which is why the number lives in
  //     execCalendarNumber() and never gates this status.
  if (/\bsenate executive calendar\b/i.test(text)) return 'exec_calendar';

  // (8) "Committee on Finance. Ordered to be reported favorably." (1).
  //     `reported by` mirrors the bill mapper's markup branch for the same
  //     phrasing. Must precede rule 10: the sequential-referral sentences
  //     contain "when reported by the Committee on ..." while describing a
  //     REFERRAL, so the negative lookahead keeps them out of here.
  if (/\bordered to be reported\b/i.test(text)) return 'reported';
  if (/\breported by\b/i.test(text) && !/\bwhen reported by\b/i.test(text)) return 'reported';

  // (9) "Committee on Foreign Relations. Hearings held." (7 + 5 Judiciary +
  //     4 Banking + 2 Veterans' Affairs + 1 Armed Services).
  if (/\bhearings? held\b/i.test(text)) return 'hearing';

  // (10) "Received in the Senate and referred to the Committee on Foreign
  //      Relations." (19, plus ~30 more across other committees), "Referred
  //      to the Committee on Foreign Relations as requested by Senator
  //      Murphy." (2 + Booker + Kaine — note these do NOT start with
  //      "Received in the Senate"), and the two sequential-referral
  //      sentences. Congress.gov's own text carries a typo in one of them
  //      ("squentially referred"), which is why this matches on `referred`
  //      and never on the adverb.
  if (/\breferred\b/i.test(text)) return 'received';

  // (11) A bare receipt with no referral named. Not present in the 2026-08-06
  //      corpus, but the Senate's own vocabulary allows it and reading it as
  //      anything other than "it has arrived" would be an invention.
  if (/\breceived in the senate\b/i.test(text)) return 'received';

  // (12) The record does not say, in words this mapper knows. Callers render
  //      neutral copy; scripts/check-nominations.mjs reports it so a rule can
  //      be added. Reaching here is honest — guessing is not.
  return UNCLASSIFIED_NOMINATION_STATUS;
}

/**
 * The Executive Calendar number from a placement sentence, or null.
 *
 * `null` is returned for THREE distinct real cases, all of which mean "we
 * cannot print a calendar number", and none of which may be papered over:
 *
 *   1. "Placed on Senate Executive Calendar. Calendar No. DESK." — the
 *      Senate's literal placeholder for a nomination on the Executive
 *      Calendar that has not been assigned a number yet (19 live records on
 *      2026-08-06, all military; the civilian set has none TODAY, but the
 *      string is the Senate's, not the military's, and a civilian nomination
 *      can carry it). `Number('DESK')` is NaN, so a naive parse would print
 *      "Calendar No. NaN" — this is the rule that stops it.
 *   2. The Privileged-Nomination-section placement, which carries no number.
 *   3. Any non-placement sentence.
 *
 * @param {string | null | undefined} actionText
 * @returns {number | null}
 */
export function execCalendarNumber(actionText) {
  const m = /\bCalendar No\.\s*(\d+)\b/i.exec(actionText ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

/**
 * Is this nomination past the advice-and-consent window?
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalNominationStatus(status) {
  return TERMINAL_NOMINATION_STATUSES.has(status);
}
