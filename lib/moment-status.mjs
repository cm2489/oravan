/*
 * THE BIG QUESTIONS STATUS LINE — where each vehicle stands, read from the
 * official record at build time, and nothing else (owner ask, 2026-09-24:
 * "we need to have a more accurate status for things like this ... where it
 * may get called up at any moment").
 *
 * WHAT THIS IS. A pure mapping from one corpus record (status,
 * last_action_text, last_action_date) to ONE key out of a closed vocabulary,
 * plus the record's own date. Every key is backed by a matcher that already
 * reads that sentence elsewhere in this codebase — lib/floor-text.mjs's
 * readers (the same ones the stepper, the crown and the ladder use) and
 * lib/urgency.mjs's clock — or by a matcher added beside them with fixtures.
 * Nothing here is AI-generated and nothing here is prose written at open
 * time: a question's summary stays exactly what its owner merged, and
 * this line sits beside it as the record's own, re-derived on every build.
 *
 * WHAT IT REFUSES TO DO. Guess. The vocabulary is an ALLOW-list, like
 * floorPendingChamber's: a sentence none of the rules below has read falls to
 * `recordStep`, which renders the record's latest action VERBATIM, labelled
 * as the record's own words. A missed reading costs a plainer line; a wrong
 * reading would put a false status on the one surface meant to be the
 * accurate one.
 *
 * WHY .mjs. scripts/moment-watch.mjs diffs these lines nightly under plain
 * node (the "nightly refresh" the owner asked for is a refresh of STATUS,
 * from the record — see diffStatusSnapshots below), and node cannot import
 * TypeScript. Same reason lib/floor-text.mjs exists.
 *
 * WHETHER A VEHICLE IS FINISHED is not this module's reading. A line's
 * `terminal` — which decides whether its card offers a call — is
 * lib/docket.mjs `decisionState`, the MCP envelope's answer, so a card, its
 * bill page and an agent reading get_bill cannot disagree about it (see
 * billStatusLine).
 *
 * ZERO data imports, ZERO fs, ZERO network. Callers hand in the records.
 */
import { decisionState } from './docket.mjs';
import {
  concurrentAdoptedBy,
  statusBasisText,
  floorCalendarChamber,
  floorPendingChamber,
  floorReconsiderPendingChamber,
  floorSettledChamber,
  passageState,
} from './floor-text.mjs';
import { isSignalFresh } from './urgency.mjs';

/**
 * The closed vocabulary. Every member needs `moments.status.line.<key>` in
 * BOTH messages files (tests/moment-status.unit.spec.ts pins that).
 */
export const STATUS_LINE_KEYS = /** @type {const} */ ([
  'signed',
  'vetoed',
  'presented',
  'bothAgreed',
  'passedBack',
  'passedOnCalendar',
  'heldAtDesk',
  'passedWaiting',
  'clotureFiled',
  'onFloor',
  'failedReconsider',
  'onCalendar',
  'failed',
  'inCommittee',
  'recordStep',
]);

/** @typedef {typeof STATUS_LINE_KEYS[number]} StatusLineKey */
/** @typedef {'house' | 'senate'} Chamber */

/**
 * @typedef {object} StatusLine
 * @property {StatusLineKey} key
 * @property {Chamber | null} chamber   the chamber the line names (where it
 *   sits, where it failed, where it waits) — null when the line names none
 * @property {Chamber | null} passedBy  the chamber whose passage the line
 *   reports, on the between-chambers keys only
 * @property {string | null} law       "119-86" on `signed`, when the record
 *   gives the Public Law number
 * @property {string | null} date       the record's last_action_date, verbatim
 * @property {string | null} text       the record's own sentence — rendered
 *   only by `recordStep`, carried on every line for the nightly digest
 * @property {boolean} terminal         the decision on the vehicle is over,
 *   read by lib/docket.mjs `decisionState` and nothing else: a law, a failed
 *   vote to pass it that nobody moved to reconsider, or a concurrent
 *   resolution both chambers adopted — see billStatusLine's TERMINAL note
 * @property {number} rank              how far along — questionStatus's
 *   rank rule reads it (see that function for the rules that outrank it)
 */

/*
 * The two concurrent-resolution types, whose path ENDS when both chambers
 * agree (no presentment). The same two members as lib/journey.ts's
 * NO_PRESENTMENT, which this .mjs cannot import; tests/moment-status.unit
 * .spec.ts pins the two against journeyEnding() so they cannot drift.
 */
export const CONCURRENT_TYPES = new Set(['hconres', 'sconres']);

/* Ranks. Higher = further along its path. Gaps leave room for a new key. */
const RANK = {
  signed: 100,
  vetoed: 100,
  presented: 95,
  bothAgreed: 90,
  passedBack: 85,
  passedOnCalendar: 80,
  heldAtDesk: 75,
  passedWaiting: 70,
  clotureFiled: 60,
  onFloor: 55,
  failedReconsider: 50,
  onCalendar: 40,
  failed: 30,
  inCommittee: 20,
};

/* A verbatim fallback still knows the record's STATUS bucket, so a
   passed-chamber record whose sentence we cannot read still outranks a bill
   sitting in committee when the question-level line is chosen. The rank never
   reaches the reader; only the ordering does. */
const RECORD_STEP_RANK = { passed_chamber: 65, floor_vote: 35 };

/*
 * "In committee" is a claim, so it needs a committee sentence, not just a
 * committee status: the corpus's status bucket lags the record (s-4668-119
 * reads `committee` over "Considered by Senate."), and hconres-38-119 reads
 * `committee` over a House floor disposition. Read shapes, measured over the
 * committed corpus 2026-09-24: "Referred to …", "Read twice and referred to
 * …", "… Hearings held.", "Subcommittee Hearings Held", "Forwarded by
 * Subcommittee to Full Committee …", "Ordered to be Reported …", "Committee
 * Consideration and Mark-up Session Held". A sentence saying the bill was
 * REPORTED by, or DISCHARGED from, a committee has left it, so it never reads
 * as in committee. ("Ordered to be Reported by the Yeas and Nays" is the
 * committee's own vote to report — the bill is still there — which is why the
 * exclusion names the committee rather than matching the bare words
 * "reported by".)
 */
const COMMITTEE_TEXT =
  /\b(?:referred to|hearings? held|forwarded by subcommittee|ordered to be reported|mark-?up session held)\b/i;
const LEFT_COMMITTEE =
  /^\s*reported\b|\breported (?:\([^)]*\) )?by the committee\b|\breported to (?:house|senate)\b|\bdischarged\b/i;

/* The three FLOOR_SETTLED words that describe a VOTE that failed. The other
   two ("withdrawn", "indefinitely postponed") settle a question without a
   failed vote, so "a vote failed" would be false over them — they fall to the
   record's own words instead. */
const FAILED_VOTE = /\b(?:rejected|not invoked|failed)\b/i;

const PUBLIC_LAW = /\bPublic Law No:?\s*(\d+-\d+)/i;

/**
 * @param {Pick<StatusLine, 'key'> & Partial<StatusLine>} partial
 * @param {{ last_action_date?: string | null, last_action_text?: string | null }} bill
 * @returns {StatusLine}
 */
function line(partial, bill) {
  return {
    chamber: null,
    passedBy: null,
    law: null,
    terminal: false,
    rank: partial.key === 'recordStep' ? 10 : RANK[/** @type {keyof typeof RANK} */ (partial.key)],
    ...partial,
    date: bill.last_action_date ?? null,
    text: bill.last_action_text ?? null,
  };
}

/**
 * One bill's status line. Pure; `now` is injectable for the clocked keys.
 *
 * TERMINAL IS lib/docket.mjs `decisionState`, read once for every key
 * (2026-09-29). Until that day each rule below set its own flag, and rule 4
 * set it on EVERY failed floor vote: a motion to proceed rejected, cloture
 * not invoked, a motion to discharge a committee rejected, a failed
 * two-thirds suspension vote. The owner's pick (a) that day (artifact
 * 7BuRDMkWu9zigDE1u2XPLJ: "Only a law or a failed final vote counts as
 * finished. Procedural failures keep the call panel, with a line saying the
 * last attempt failed.") kept the bill page's call panel on every one of
 * them, and the MCP envelope's decision_state with it, while the Big
 * Question card for the same record still said "Read the bill" — the four
 * S.J.Res. vehicles on /questions/iran-war-powers whose discharge motion or
 * motion to proceed was rejected. So the flag is no longer this module's own reading. It is
 * `decisionState(bill).state !== 'pending'`, which is true on exactly:
 *   - a law (status `signed`);
 *   - a failed vote to PASS the measure ("Failed of passage in Senate by
 *     Yea-Nay Vote. 49 - 50." — H.Con.Res. 89), no motion to reconsider
 *     entered;
 *   - a concurrent resolution both chambers agreed to in one form
 *     (lib/floor-text.mjs concurrentAdoptedBy, #360 — H.Con.Res. 86).
 * Everything else is live, a veto included: an override vote is still
 * possible (decisionState's own note), and the bill page keeps its call for
 * the same reason.
 *
 * THE LINE ITSELF DOES NOT MOVE. A failed motion still reads `failed` ("A
 * Senate floor vote on it failed."), which is as true of a failed motion as
 * of a failed passage vote. Only the button under it changes.
 *
 * THE INVARIANT, pinned over the committed corpus by
 * tests/moment-status.unit.spec.ts: `terminal` equals decisionState's answer
 * on every bill, and every record lib/journey.ts `settledDecision` settles
 * (the bill page's record-only panel) is terminal here — so a card never
 * offers a call its bill page does not have. The converse has
 * decisionState's two stated gaps (settledDecision's header in
 * lib/journey.ts): on those the card reads "Read the bill" over a page that
 * still shows the call panel.
 *
 * ORDER IS THE CONTRACT — first rule that reads the sentence wins:
 *  1. signed / vetoed           the status bucket, which for these two IS the
 *                               record ("Became Public Law No: 119-86.")
 *     bothAgreed                a concurrent resolution the second chamber
 *                               agreed to without amendment — the end of its
 *                               path (lib/floor-text.mjs concurrentAdoptedBy,
 *                               2026-09-28, H.Con.Res. 86: "Resolution agreed
 *                               to in Senate without amendment …")
 *  2. presented                 "Presented to President." — passageState
 *                               would call this 'first' and print "waiting on
 *                               the other chamber", which is false
 *  3. failedReconsider          lib/floor-text.mjs floorReconsiderPendingChamber
 *  4. failed                    floorSettledChamber, restricted to the three
 *                               failed-VOTE words — a failed motion and a
 *                               failed passage vote alike; which of the two
 *                               it was is decisionState's to say (above)
 *  5. passedOnCalendar /        floorCalendarChamber — a dated placement is
 *     onCalendar                a durable fact until the chamber acts on it,
 *                               so it is NOT clocked: the line says the date
 *                               it was placed and what the chamber CAN do,
 *                               never that a vote is scheduled
 *  6. clotureFiled / onFloor    floorPendingChamber — CLOCKED by
 *                               isSignalFresh, because "a vote is ahead" is a
 *                               claim about this week; aged, the record's own
 *                               words print instead. Since 2026-09-27 (owner
 *                               card a5) also "Cloture on the measure …
 *                               invoked in Senate" (floorPendingChamber rule
 *                               1b): debate is closing and the vote on the
 *                               measure is still ahead, so it reads `onFloor`
 *  7. heldAtDesk /              passed_chamber records whose sentence says
 *     passedWaiting /           where the bill went: "Held at the desk.",
 *     passedBack / bothAgreed   "Received in the {chamber}…", or Congress's
 *                               "Passed {chamber} …" boilerplate read by
 *                               passageState (unchanged, now in floor-text)
 *  8. inCommittee               committee status AND a committee sentence
 *  9. recordStep                everything else, verbatim
 *
 * @param {{ bill_type: string, status: string, last_action_text?: string | null, last_action_date?: string | null }} bill
 * @param {number} [now]
 * @returns {StatusLine}
 */
export function billStatusLine(bill, now = Date.now()) {
  // TERMINAL — see the header: the MCP envelope's reader, never a rule below.
  return { ...readBillLine(bill, now), terminal: decisionState(bill).state !== 'pending' };
}

/**
 * The rules, in the order the header above lists them. Every line leaves
 * here with `terminal: false`; billStatusLine sets it.
 *
 * @param {Parameters<typeof billStatusLine>[0]} bill
 * @param {number} now
 * @returns {StatusLine}
 */
function readBillLine(bill, now) {
  // The sentence the status was READ from (#286): behind an ambiguous last
  // action ("Motion to reconsider laid on the table…", "Message on … action
  // sent to …") the nightly stores the decisive sentence before it, and every
  // chamber/tense reader uses that. The verbatim fallback still quotes the
  // record's latest step (last_action_text) — that one IS the latest step.
  const text = statusBasisText(bill) ?? '';
  const date = bill.last_action_date ?? null;
  /** @type {Chamber} */
  const origin = bill.bill_type.startsWith('h') ? 'house' : 'senate';
  /** @type {Chamber} */
  const other = origin === 'house' ? 'senate' : 'house';

  // 1
  if (bill.status === 'signed') {
    const law = PUBLIC_LAW.exec(text)?.[1] ?? null;
    return line({ key: 'signed', law }, bill);
  }
  if (bill.status === 'vetoed') return line({ key: 'vetoed' }, bill);
  // A concurrent resolution both chambers agreed to in one form has reached
  // the end of its path. Read before the floor rules because it IS an
  // outcome, like the two above; until 2026-09-28 it was read only inside
  // rule 7, whose opening test ("Passed …") never matched the Senate's own
  // "Resolution agreed to in Senate without amendment …", so H.Con.Res. 86
  // printed the raw "Message on Senate action sent to the House." and its
  // card still offered a call. (Terminal through decisionState, which reads
  // the same concurrentAdoptedBy.)
  if (concurrentAdoptedBy(bill)) return line({ key: 'bothAgreed' }, bill);

  // 2
  if (/^\s*Presented to President\b/i.test(text)) return line({ key: 'presented' }, bill);

  // 3
  const reconsider = floorReconsiderPendingChamber(text);
  if (reconsider) return line({ key: 'failedReconsider', chamber: reconsider }, bill);

  // 4
  const settled = floorSettledChamber(text);
  if (settled && FAILED_VOTE.test(text)) {
    // Terminal only on a failed vote to pass it (decisionState, header).
    return line({ key: 'failed', chamber: settled }, bill);
  }

  // 5
  const calendar = floorCalendarChamber(text);
  if (calendar) {
    if (bill.status === 'passed_chamber' && calendar === other) {
      return line({ key: 'passedOnCalendar', chamber: calendar, passedBy: origin }, bill);
    }
    return line({ key: 'onCalendar', chamber: calendar }, bill);
  }

  // 6 — floorPendingChamber reads cloture invoked on the measure itself
  // (rule 1b, owner card a5), so this line and the stepper cannot disagree.
  const pending = floorPendingChamber(text);
  if (pending && isSignalFresh(date, now)) {
    const cloture = /cloture motion .*presented in senate/i.test(text);
    return line({ key: cloture ? 'clotureFiled' : 'onFloor', chamber: pending }, bill);
  }

  // 7
  if (bill.status === 'passed_chamber' && !pending) {
    if (/^\s*held at the desk\.?\s*$/i.test(text)) {
      return line({ key: 'heldAtDesk', chamber: other, passedBy: origin }, bill);
    }
    const received = /^\s*Received in the (House|Senate)\b/i.exec(text);
    if (received) {
      /** @type {Chamber} */
      const at = received[1].toLowerCase() === 'senate' ? 'senate' : 'house';
      if (at === other) return line({ key: 'passedWaiting', chamber: other, passedBy: origin }, bill);
    }
    if (/^\s*Passed(?:\/agreed to in)? (?:House|Senate)\b/i.test(text)) {
      const ps = passageState(bill);
      if (ps.stage === 'first' && ps.next) {
        return line({ key: 'passedWaiting', chamber: ps.next, passedBy: ps.passedBy }, bill);
      }
      if (ps.stage === 'back') {
        return line({ key: 'passedBack', chamber: origin, passedBy: ps.passedBy }, bill);
      }
      if (ps.stage === 'both') {
        // A bill or joint resolution: the president is next, so it is live
        // (decisionState: pending). passageState never says 'both' of a
        // concurrent resolution — see below.
        return line({ key: 'bothAgreed' }, bill);
      }
      // A concurrent resolution agreed to by the second chamber "without
      // amendment" is 'second' from passageState (#286: 'both' would say it
      // goes to the President, and a concurrent resolution never does). It
      // never reaches this line: rule 1 read it (concurrentAdoptedBy).
      // 'second': both acted and the sentence does not say how — verbatim.
    }
  }

  // 8
  if (
    (bill.status === 'committee' || bill.status === 'markup') &&
    COMMITTEE_TEXT.test(text) &&
    !LEFT_COMMITTEE.test(text)
  ) {
    return line({ key: 'inCommittee' }, bill);
  }

  // 9
  return line(
    {
      key: 'recordStep',
      rank: RECORD_STEP_RANK[/** @type {keyof typeof RECORD_STEP_RANK} */ (bill.status)] ?? 10,
    },
    bill,
  );
}

/*
 * Nominations carry no status-line vocabulary of their own yet — none is a
 * Big Question vehicle today — so the line is the record's own sentence,
 * verbatim, with terminality read from the nomination status set the caller
 * passes (lib/nomination-status.mjs TERMINAL_NOMINATION_STATUSES). The
 * Senate-calendar and floor states rank above committee ones, so a mixed
 * question still leads with the vehicle closest to a vote.
 *
 * @param {{ status: string, last_action_text?: string | null, last_action_date?: string | null }} nomination
 * @param {ReadonlySet<string>} terminalStatuses
 * @returns {StatusLine}
 */
export function nominationStatusLine(nomination, terminalStatuses) {
  const terminal = terminalStatuses.has(nomination.status);
  const floorish = ['exec_calendar', 'floor', 'scheduled'].includes(nomination.status);
  return line(
    {
      key: 'recordStep',
      chamber: 'senate',
      terminal,
      rank: terminal ? 100 : floorish ? 45 : 15,
    },
    nomination,
  );
}

/**
 * How many days newer a floor event must be than the most advanced live
 * vehicle's line before it takes the question-level lead. "A few days" in the
 * owner-approved recommendation (card a5, 2026-09-27); three keeps two
 * vehicles that moved in the same floor week ordered by how far along they
 * are, and lets a decisive vote a week later lead.
 */
export const RECENCY_GAP_DAYS = 3;

/**
 * THE QUESTION-LEVEL STATUS — the one line the /questions card and the
 * question page's header print for the whole question.
 *
 * Until 2026-09-27 this was simply the most advanced LIVE vehicle's line, and
 * on the three loudest questions that hid the news (the 2026-09-27 audit,
 * SY-05; owner card a5 approved the three rules below):
 *   - Iran war powers read "Passed the House; waiting on the Senate · Sep 16"
 *     two days after the Senate rejected H.Con.Res. 89, 49–50, on Sep 24 —
 *     a failed vote ranks below a passage, and a terminal vehicle never led;
 *   - the funding question read "waiting on the Senate" for a stopgap made
 *     moot by a law signed Sep 2 — an enacted vehicle never led;
 *   - a line the matchers could not read printed the record's procedural
 *     sentence verbatim as the headline.
 *
 * THE RULES, in order:
 *   1. ENACTED LEADS. When any vehicle is law, the newest such line leads, in
 *      either mode. A law is the answer to the question.
 *   2. EXPLAINER MODE when every vehicle has reached the end of its path: the
 *      question stays up, its vehicles read as what happened, no card
 *      promises a call. The lead is the most recent line.
 *   3. RANK, among the live vehicles: the most advanced, ties to the newer.
 *   4. RECENCY BEATS RANK when they disagree by days: a FLOOR-OR-BEYOND line
 *      (anything a chamber did on its floor or later — a failed vote, a
 *      calendar placement, a passage; never a committee referral, which is
 *      how a question grows, not news about it) dated more than
 *      RECENCY_GAP_DAYS after the rank lead takes the lead, terminal or not.
 *   Throughout, a readable line beats a verbatim `recordStep` one: the
 *   record's raw procedural sentence is never the question's headline while
 *   any vehicle has a line in our own vocabulary. Only a question whose every
 *   line is unread still leads with the record's words — there is nothing
 *   else true to print.
 *
 * `mode` is unchanged by rules 1 and 4: a question with a live vehicle stays
 * live even when a finished one leads, so the cards below keep their calls.
 *
 * @param {StatusLine[]} lines  one per RESOLVED vehicle (unresolved skipped)
 * @returns {{ mode: 'live' | 'explainer', lead: StatusLine | null }}
 */
export function questionStatus(lines) {
  if (lines.length === 0) return { mode: 'live', lead: null };
  const byDate = (/** @type {StatusLine} */ a, /** @type {StatusLine} */ b) =>
    (b.date ?? '').localeCompare(a.date ?? '');
  /** @param {StatusLine[]} pool */
  const readable = (pool) => {
    const read = pool.filter((l) => l.key !== 'recordStep');
    return read.length > 0 ? read : pool;
  };
  const live = lines.filter((l) => !l.terminal);
  const mode = live.length === 0 ? 'explainer' : 'live';

  // 1
  const enacted = lines.filter((l) => l.key === 'signed').sort(byDate);
  if (enacted.length > 0) return { mode, lead: enacted[0] };

  // 2
  if (mode === 'explainer') return { mode, lead: [...readable(lines)].sort(byDate)[0] };

  // 3
  const rankLead = [...readable(live)].sort((a, b) => b.rank - a.rank || byDate(a, b))[0];

  // 4
  const newest = lines
    .filter((l) => l.key !== 'recordStep' && l.rank >= RANK.failed && l.date)
    .sort(byDate)[0];
  if (newest && newest !== rankLead && daysAfter(rankLead.date, newest.date) > RECENCY_GAP_DAYS) {
    return { mode, lead: newest };
  }
  return { mode, lead: rankLead };
}

/**
 * Whole days from `from` to `to` (YYYY-MM-DD). An undated `from` is treated
 * as infinitely old, so a dated floor event always outranks an undated line.
 *
 * @param {string | null} from
 * @param {string | null} to
 * @returns {number}
 */
function daysAfter(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(b)) return -Infinity;
  if (!Number.isFinite(a)) return Infinity;
  return (b - a) / 86_400_000;
}

/** @typedef {'house' | 'senate' | 'enacted'} VehicleGroup */
export const VEHICLE_GROUPS = /** @type {const} */ (['house', 'senate', 'enacted']);

/**
 * WHICH STORY A VEHICLE BELONGS TO on a question page. Bills group by the
 * chamber they STARTED in — the one fact about a bill that never moves — so a
 * House resolution and its Senate twin read as two halves of one question,
 * each half in the order its chamber wrote them. A signed bill is `enacted`,
 * whichever chamber wrote it. A nomination is the Senate's alone (Article II).
 *
 * @param {{ kind: 'bill' | 'nomination', bill_type?: string, status?: string }} v
 * @returns {VehicleGroup}
 */
export function vehicleGroup(v) {
  if (v.kind === 'nomination') return 'senate';
  if (v.status === 'signed') return 'enacted';
  return (v.bill_type ?? '').startsWith('h') ? 'house' : 'senate';
}

/* ------------------------------------------------------------------------
 * THE NIGHTLY REFRESH — of status, from the record, never of prose.
 *
 * scripts/moment-watch.mjs builds a snapshot of every non-retired question's
 * derived lines after each nightly sync, diffs it against the snapshot the
 * last run committed (data/moment-status-seen.json), and posts what moved —
 * plus any question newly past its review date — to the standing
 * moment-review issue. The owner then decides whether the question's
 * summary needs a new PR. Nothing here writes data/moments.json.
 * --------------------------------------------------------------------- */

/**
 * The comparable identity of a line. The date is part of it on purpose: a
 * new action of the same kind (a second cloture filing) is still movement.
 *
 * @param {StatusLine} l
 */
export function statusFingerprint(l) {
  return [l.key, l.chamber ?? '', l.law ?? '', l.date ?? ''].join('|');
}

/**
 * @typedef {object} SnapshotVehicle
 * @property {string} fingerprint
 * @property {string | null} text
 */
/**
 * @typedef {Record<string, { review_by: string, vehicles: Record<string, SnapshotVehicle> }>} StatusSnapshot
 */

/**
 * @param {{
 *   moments: Record<string, { status: string, review_by: string, vehicles: { slug: string, kind?: string }[] }>,
 *   lineFor: (vehicle: { slug: string, kind?: string }) => StatusLine | null,
 * }} input
 * @returns {StatusSnapshot}
 */
export function buildStatusSnapshot({ moments, lineFor }) {
  /** @type {StatusSnapshot} */
  const out = {};
  for (const [id, m] of Object.entries(moments)) {
    if (id.startsWith('_') || !m || m.status === 'retired') continue;
    /** @type {Record<string, SnapshotVehicle>} */
    const vehicles = {};
    for (const v of m.vehicles ?? []) {
      const l = lineFor(v);
      vehicles[v.slug] = l
        ? { fingerprint: statusFingerprint(l), text: l.text }
        : { fingerprint: 'unresolved', text: null };
    }
    out[id] = { review_by: m.review_by, vehicles };
  }
  return out;
}

/**
 * Every vehicle whose derived line moved between two snapshots, including
 * vehicles added to or dropped from a question (a content PR landed) and
 * whole questions opened or retired. `from`/`to` are fingerprints or null.
 *
 * @param {StatusSnapshot | null} prev
 * @param {StatusSnapshot} next
 * @returns {{ id: string, slug: string | null, from: string | null, to: string | null, text: string | null }[]}
 */
export function diffStatusSnapshots(prev, next) {
  /** @type {{ id: string, slug: string | null, from: string | null, to: string | null, text: string | null }[]} */
  const changes = [];
  if (!prev) return changes;
  const ids = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort();
  for (const id of ids) {
    const a = prev[id];
    const b = next[id];
    if (!a || !b) {
      changes.push({ id, slug: null, from: a ? 'question' : null, to: b ? 'question' : null, text: null });
      continue;
    }
    const slugs = [...new Set([...Object.keys(a.vehicles), ...Object.keys(b.vehicles)])].sort();
    for (const slug of slugs) {
      const from = a.vehicles[slug]?.fingerprint ?? null;
      const to = b.vehicles[slug]?.fingerprint ?? null;
      if (from !== to) changes.push({ id, slug, from, to, text: b.vehicles[slug]?.text ?? null });
    }
  }
  return changes;
}

/**
 * Questions whose review date has passed — a CURATION reminder for the owner,
 * never a hide switch on the site (owner, 2026-09-24). Same boundary as
 * lib/moments.ts computeMomentState: the review_by day itself still counts.
 *
 * @param {StatusSnapshot} snapshot
 * @param {number} now
 * @returns {{ id: string, review_by: string, daysPast: number }[]}
 */
export function pastReview(snapshot, now) {
  const out = [];
  for (const [id, m] of Object.entries(snapshot)) {
    const t = Date.parse(`${m.review_by}T00:00:00Z`);
    const daysPast = Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : Infinity;
    if (daysPast >= 1) out.push({ id, review_by: m.review_by, daysPast });
  }
  return out.sort((a, b) => b.daysPast - a.daysPast || a.id.localeCompare(b.id));
}
