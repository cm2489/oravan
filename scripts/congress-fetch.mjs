/**
 * Congress.gov fetch + status/urgency/category-mapping helpers shared by the
 * nightly bill sync (scripts/sync-bills.mjs: fetch + AI decode + commit) and
 * the twice-daily hot-bill refresh (scripts/hot-bills.mjs: fetch + refresh
 * only, zero AI cost) - extracted 2026-07-16 (audit §4 Alt B / §5 item 3) so
 * the two scripts share one implementation of "talk to Congress.gov" and
 * "map a bill-detail payload onto our fields" instead of maintaining two
 * copies that can drift (the same "one copy" discipline lib/urgency.mjs's
 * own doc comment already applies to the urgency curve).
 *
 * Needs CONGRESS_API_KEY in the importing process's env.
 */
import { STATUS_BASE } from '../lib/urgency.mjs';
// The one copy of the committee-text-on-the-floor vocabulary (2026-09-25):
// lib/floor-text.mjs is import-free, so this module reading it adds no data
// and no secret to anything that imports mapStatus.
import { COMMITTEE_TEXT_ON_FLOOR } from '../lib/floor-text.mjs';

export const CONGRESS = 119;
// hconres/sconres added 2026-07-23: concurrent resolutions carry War Powers
// fights and budget resolutions — their exclusion made H.Con.Res.38 (the
// Iran war-powers resolution everyone was talking about) STRUCTURALLY
// unfetchable. Simple resolutions (hres/sres) stay excluded: they are
// chamber-internal and almost never call-worthy.
export const BILL_TYPES = new Set(['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres']);

const API = 'https://api.congress.gov/v3';
// Key is READ and checked at first fetch, not at import: this module also
// exports pure functions (mapStatus, urgencyScore, readableAction, ...) that
// unit tests import without any secrets. Sync scripts still fail on their
// first cg() call with the same message. It used to be read at module scope
// (`const KEY = process.env.CONGRESS_API_KEY`) and only CHECKED here, which
// made the sentence above half true and forced any test driving a cg() caller
// to win a module-evaluation-order race to set the env var first. Reading it
// per call costs nothing - the value never changes inside a run.

/** GET one Congress.gov endpoint, retrying on a bad status or a thrown/timed
 *  out request (a hung socket must retry, not kill the whole run - the
 *  2026-06-13 crash). */
export async function cg(path, params = {}) {
  const KEY = process.env.CONGRESS_API_KEY;
  if (!KEY) throw new Error('CONGRESS_API_KEY missing');
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', KEY);
  url.searchParams.set('format', 'json');
  let lastErr;
  for (let attempt = 0; attempt <= 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      // 30s per-request ceiling: a hung socket fails fast and retries instead
      // of hanging on undici's ~5min headers timeout (the 2026-06-13 crash).
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      // await inside the try: the 30s abort can fire mid-body-read, and an
      // un-awaited res.json() rejection would escape the catch and kill the
      // run uncaught instead of retrying (the 2026-07-04 crash).
      if (res.ok) return await res.json();
      lastErr = new Error(`Congress.gov ${res.status} for ${path}`);
    } catch (e) {
      lastErr = e; // network error / timeout - retry rather than kill the run
    }
  }
  throw lastErr;
}

/** The N most-recently-updated bills across the whole corpus (no fromDateTime
 *  floor - literally "what changed most recently"), of our 4 tracked types.
 *  Used by sync-bills.mjs's recent-first pass and the whole of hot-bills.mjs;
 *  see the audit's two-pass fetch design (§5 item 2 / §4 Alt B): the
 *  ascending "since cursor" scan structurally reaches the newest bills LAST,
 *  so both freshness-sensitive callers fetch this descending window instead. */
export async function fetchRecentlyUpdated(limit) {
  // The sort value must reach Congress.gov as "updateDate+desc" ON THE WIRE,
  // where "+" is the URL encoding of a SPACE. URLSearchParams percent-encodes
  // a literal "+" to %2B, which the API silently IGNORES - with 'updateDate+desc'
  // here, every "recent-first" fetch since 2026-07-16 actually returned the
  // OLDEST bills of the Congress (live-verified 2026-07-23: %2B -> Jan-2025
  // resolutions; space -> today's floor bills). A space in the JS string
  // serializes to "+" and restores the documented syntax.
  const page = await cg(`/bill/${CONGRESS}`, { sort: 'updateDate desc', limit });
  const items = page.bills ?? [];
  return items.filter((b) => BILL_TYPES.has((b.type ?? '').toLowerCase()));
}

/**
 * How stale the NEWEST bill in a "most recently updated" window may be before
 * the window itself is treated as broken rather than the Congress as quiet.
 *
 * 30 days, and the generosity is deliberate. Congress recesses for weeks at a
 * time, and this window spans the whole 119th Congress, so a real lull can
 * push the newest updateDate out by days. But it cannot push it out by a
 * month: `updateDate` moves on cosponsor additions, committee referrals, and
 * text publication across ~19,000 bills, none of which stop entirely for
 * thirty days. The failure this guards against was never subtle — see below.
 */
export const RECENT_WINDOW_MAX_STALE_DAYS = Number(
  process.env.CONGRESS_RECENT_MAX_STALE_DAYS ?? 30
);

/**
 * Is a fetchRecentlyUpdated() page actually recent? (2026-08-09)
 *
 * THE INCIDENT THIS EXISTS FOR (documented in fetchRecentlyUpdated's own
 * comment, lines 65-71 above): from 2026-07-16 to 2026-07-23 the sort value
 * reached Congress.gov percent-encoded as `updateDate%2Bdesc`, which the API
 * silently IGNORES — no error, no warning, a 200 with a full page of bills.
 * Every "recent-first" fetch for a week returned the OLDEST bills of the
 * Congress instead of the newest (live-verified: Jan-2025 resolutions where
 * today's floor bills belonged). scripts/hot-bills.mjs consumed that page
 * blind, dutifully refreshed a hundred eighteen-month-old resolutions twice a
 * day, reported "100 refreshed", and exited 0 green the entire time. Nothing
 * in the pipeline was capable of noticing, because a wrong-but-well-formed
 * page is indistinguishable from a right one unless someone reads the DATES.
 *
 * So read the dates. Pure and I/O-free; pinned by
 * tests/hot-bill-visibility.unit.spec.ts.
 *
 * @returns {{ok: boolean, newest: string|null, staleDays: number|null, reason: string|null}}
 */
export function assessRecentWindow(items, {
  maxStaleDays = RECENT_WINDOW_MAX_STALE_DAYS,
  now = Date.now(),
} = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return { ok: false, newest: null, staleDays: null, reason: 'the window came back empty' };
  }
  let newestMs = -Infinity;
  let newest = null;
  for (const b of list) {
    const raw = b?.updateDate;
    // Congress.gov emits both 'YYYY-MM-DD' and full ISO timestamps here;
    // normalize the bare date so it parses as UTC rather than local.
    const ms = Date.parse(typeof raw === 'string' && !raw.includes('T') ? `${raw}T00:00:00Z` : raw);
    if (Number.isFinite(ms) && ms > newestMs) { newestMs = ms; newest = raw; }
  }
  if (newest === null) {
    return { ok: false, newest: null, staleDays: null, reason: 'no parseable updateDate in the window' };
  }
  // Negative (a future-dated update) is fine — clamp so it can never read as
  // stale; the check is one-directional by design.
  const staleDays = Math.max(0, Math.floor((now - newestMs) / 86_400_000));
  if (staleDays > maxStaleDays) {
    return {
      ok: false,
      newest,
      staleDays,
      reason: `the newest updateDate in the window is ${staleDays} days old (limit ${maxStaleDays}) - this window is not sorted newest-first`,
    };
  }
  return { ok: true, newest, staleDays, reason: null };
}

/**
 * Normalize any date-ish string into the ONLY shape Congress.gov's
 * `fromDateTime` accepts: seconds-precision ISO-8601.
 *
 * It is picky in BOTH directions, and each direction has already cost a
 * multi-day outage:
 *   - A bare date ("2026-06-04", the shape its own bill-list `updateDate`
 *     uses) 400s — the 2026-06-25/07-01 outage.
 *   - A fractional-seconds timestamp ("2026-07-16T17:54:26.862Z", the shape
 *     Date.toISOString() emits) ALSO 400s — the 2026-07-17/07-22 outage,
 *     triggered the first time a clean (unfrozen) run persisted raw runStart
 *     as the cursor.
 * Live-verified 2026-07-22 on /bill: .862Z -> 400, seconds-precision -> 200.
 * Re-verified 2026-08-06 on /nomination, which behaves identically:
 * "2026-08-05" -> 400, "2026-08-05T00:00:00Z" -> 200.
 *
 * Always normalize before anything becomes a persisted cursor. Lifted here
 * from scripts/sync-bills.mjs (unchanged, byte for byte) on 2026-08-06 so
 * the nomination sync shares this one copy instead of carrying a second that
 * can re-learn the outage independently.
 *
 * @param {string} d
 * @returns {string} seconds-precision ISO-8601
 */
export function toISODateTime(d) {
  return /T/.test(d) ? d.replace(/\.\d+(?=Z$|[+-]\d\d:\d\d$)/, '') : `${d}T00:00:00Z`;
}

// ---- status mapping (ported from the reference implementation) ----
export function mapStatus(actionText) {
  const text = (actionText ?? '').toLowerCase().trim();
  if (!text) return 'committee';
  if (text.includes('became public law') || text.includes('signed by president')) return 'signed';
  if (text.includes('vetoed')) return 'vetoed';
  if (text.includes('conference report') || text.includes('conference committee')) return 'conference';
  // A RULE RESOLUTION PASSING THE HOUSE IS NOT THE BILL PASSING, and this guard
  // has to run BEFORE the passage branch below, whose `passed house` substring
  // it matches. "Rule H. Res. 988 passed House." is the House adopting the
  // TERMS of a debate that has not happened yet — the bill's own floor vote is
  // still ahead, which is `floor_vote`, and reading it as `passed_chamber`
  // retired the bill's floor claim on the exact day it reached the floor.
  // lib/docket.mjs's `floorAnsweredChamber` carries the same guard, one layer
  // up, for the same sentence.
  if (/\brule h\.? ?res\.? ?\d+ passed house/.test(text)) return 'floor_vote';
  // A COMMITTEE'S TEXT, DISPOSED OF ON THE FLOOR (2026-09-25, S. 4668). "The
  // committee substitute withdrawn by Voice Vote." is the Senate acting on its
  // own floor on the substitute a committee reported — Congress.gov types it
  // "Floor" — and it matched no rule here, so it fell through to the
  // `committee` default at the bottom and the live page said "In committee"
  // over a bill whose cloture vote had carried 74-25 the same day. `floor_vote`
  // is the stage the sentence is written in. It is only the DEFAULT reading:
  // the sentence does not say whether the measure's own vote is still ahead
  // or has already happened (eight of the nine read in the record sit directly
  // before "Passed Senate with an amendment…" on the same day), so it is listed in
  // AMBIGUOUS_WITHOUT_CONTEXT below and every write path reads the action
  // before it. Runs BEFORE the defeat and passage branches: the subject is an
  // amendment, so no "agreed to" or "not agreed to" in it is the measure's.
  // The vocabulary and the real-record shapes live in lib/floor-text.mjs's
  // COMMITTEE_TEXT_ON_FLOOR.
  if (COMMITTEE_TEXT_ON_FLOOR.test(text)) return 'floor_vote';
  // A DEFEAT IS NOT A PASSAGE (2026-09-24). "Failed of passage/not agreed to
  // in House On agreeing to the resolution Failed by the Yeas and Nays: 212 -
  // 219" (the House's own summary line for H.Con.Res. 38's defeat) contains
  // "agreed to in", which the passage branch below matches. It has to be
  // caught first. `floor_vote` is the stage a recorded failure already maps
  // to ("Failed of passage in Senate by Yea-Nay Vote", "... Failed by the
  // Yeas and Nays"), so the settled guard in lib/docket.mjs can read it.
  if (/\bfailed of passage\b|\bnot agreed to in (?:the )?(?:house|senate)\b/.test(text)) return 'floor_vote';
  if (
    text.includes('passed house') || text.includes('passed senate') ||
    text.includes('passed/agreed to') || text.includes('agreed to in') ||
    text.includes('received in the senate') || text.includes('received in the house') ||
    text.includes('held at the desk') ||
    // THE POST-PASSAGE MOTION (2026-09-18). "Motion to reconsider laid on the
    // table Agreed to without objection." is what a chamber does immediately
    // AFTER passing a measure, and it is the sentence Congress leaves as the
    // last action on a large share of a busy week's bills — 24 of the corpus
    // on 2026-09-18, every one of them reading as plain `committee`, which is
    // the stage the bill left. It says nothing about which chamber, so nothing
    // here claims one; `passed_chamber` is the stage, and the chamber-level
    // claim stays with lib/journey.ts's passage derivation.
    // AMENDED 2026-09-24: the motion is laid after a FAILED vote too
    // (H.Con.Res. 38, H.R. 2262), so this reading is only the default. It is
    // listed in AMBIGUOUS_WITHOUT_CONTEXT below, and no write path stores it
    // without resolveAmbiguousStatus reading the action before it.
    text.includes('motion to reconsider laid on the table') ||
    // BOTH CHAMBERS ARE DONE. "Presented to President." is the enrolled bill
    // going to the desk; it derived `committee` until now, which put a measure
    // awaiting signature at the same stage as one awaiting a hearing. The
    // status vocabulary has no `presented` rung and this change does not invent
    // one — `passed_chamber` is the nearest true stage, and `signed` remains
    // the only status that claims an outcome.
    text.includes('presented to president') ||
    // THE MESSAGE THAT FOLLOWS A CHAMBER'S PASSAGE (2026-09-24, H.Con.Res. 86).
    // "Message on Senate action sent to the House." / "Message on House action
    // sent to the Senate." is the formal notice one chamber sends the other
    // after it has acted on the measure, and Congress writes it OVER the
    // passage sentence as the last action. hconres-86-119 was agreed to in the
    // Senate by a 50-48 Yea-Nay vote after the House had already agreed to it,
    // and still read `committee` from this sentence. Like the post-passage
    // motion above, `passed_chamber` is the stage and nothing more: the
    // vocabulary has no "both agreed" rung, and which chamber acted (and so
    // who, if anyone, is next) is lib/journey.ts's `passageState`, which reads
    // the same sentence and fails closed to 'second' when the acting chamber
    // is not the originating one. The notice does not say WHAT the chamber
    // did, so this is only the default: it is in AMBIGUOUS_WITHOUT_CONTEXT
    // below, and no write path stores it without resolveAmbiguousStatus.
    /\bmessage on (?:house|senate) action sent to the (?:house|senate)\b/.test(text)
  ) return 'passed_chamber';
  // A DISCHARGE PETITION FILED IS NOT FLOOR ACTION (owner ruling 2026-09-24,
  // issue #268). In the House, "Motion to Discharge Committee filed by
  // Mr. Kiley (CA). Petition No: 119-21. (Discharge petition text with
  // signatures.)" opens a signature drive — 218 Members must sign before the
  // motion can even be called up. Nothing has happened on the floor; the bill
  // is still in committee, so it stays at `committee`. This must run BEFORE
  // the floor-activity branch below, whose `motion to discharge` substring it
  // matches. BOTH the "filed by" verb and the "Petition No" citation are
  // required, so a Senate discharge motion that was actually VOTED ON
  // ("Motion to discharge Senate Committee on Foreign Relations rejected by
  // Yea-Nay Vote. 47 - 48.") keeps `floor_vote`, and "Committee discharged"
  // sentences never reach this line. lib/floor-text.mjs's floorMakesNoClaim
  // records the same reading one layer up, for records already stored at
  // `floor_vote`.
  if (/\bmotion to discharge committee filed by\b/.test(text) && /\bpetition no\b/.test(text)) {
    return 'committee';
  }
  // Floor activity. The scheduling signals (calendar/cloture/rule) were the
  // original set; the recorded-vote and live-consideration signals were added
  // 2026-07-23 after H.Con.Res. 89 — a war-powers resolution in active House
  // debate that week — read as plain 'committee', which both buried it below
  // the urgency floors and gated it out of decoding entirely. A "Yea-Nay
  // Vote" with a "Record Vote Number", a postponed/resumed proceeding, a
  // discharge motion, or the Chair putting the question are all chamber-floor
  // events by definition; committee roll calls use the distinct "Yeas and
  // Nays" phrasing and are caught by the markup branch below.
  if (
    text.includes('placed on') || text.includes('calendar') ||
    text.includes('cloture') || text.includes('rule provid') ||
    text.includes('motion to proceed') ||
    text.includes('yea-nay vote') || text.includes('record vote number') ||
    text.includes('roll call') || text.includes('postponed proceedings') ||
    text.includes('motion to discharge') || text.includes('put the question') ||
    text.includes('unfinished business') ||
    // A SUSPENSION VOTE THAT FAILED IS A FLOOR VOTE (2026-09-18). "On motion to
    // suspend the rules and pass Failed by the Yeas and Nays: (2/3 required):
    // 212 - 206 (Roll no. 293)." is a recorded vote of the full House, and it
    // derived `committee` — so the one sentence in the corpus that says the
    // floor ANSWERED could not reach the settled guard that reads
    // `status === 'floor_vote'` (lib/docket.mjs's `isSettledFloor`), and the
    // bill kept ranking as if the vote were still ahead. The committee roll
    // call uses the same "Yeas and Nays" phrasing, so the match is on the
    // outcome verb, not on the vote form: "Ordered to be Reported by the Yeas
    // and Nays" is untouched and still `markup`.
    text.includes('failed by the yeas and nays') ||
    // A MEASURE UNDER FLOOR CONSIDERATION (2026-09-24, S. 4668). "Considered
    // by Senate. (consideration: CR S4851)" is the chamber debating the
    // measure on its own floor, and it derived `committee` — so on the
    // morning of a scheduled cloture vote the bill read as sitting in
    // committee and could never reach the crown. These are the sentences
    // Congress writes while a measure is on the floor (Congress.gov action
    // text, read 2026-09-24): the Senate lays the measure before itself and
    // considers it; the House considers it under a special rule, under
    // suspension, as unfinished business, or under a previous order.
    // "Considered as unfinished business." is already caught by the
    // `unfinished business` line above. `includes`, never an anchored match:
    // live texts carry "(consideration: CR …)" tails. The passage and
    // rule-resolution guards above still run first, so "Passed Senate …
    // (consideration: CR S…)" stays `passed_chamber`. A committee sentence
    // does not reach this: "Committee Consideration and Mark-up Session Held"
    // says "consideration", never "considered by/under/pursuant", and it
    // stays `markup` below.
    text.includes('measure laid before senate') ||
    /\bconsidered by senate\b(?!\s+committee)/.test(text) ||
    /\bconsidered under the provisions of rule h\.? ?res\b/.test(text) ||
    text.includes('considered under suspension of the rules') ||
    text.includes('considered pursuant to a previous order')
  ) return 'floor_vote';
  // 'mark-up': Congress.gov action text uses both spellings ("Mark-up
  // Session Held") — the hyphenated form alone covers 133 live corpus bills
  // that would otherwise read as mere 'committee' and be gated out of
  // decoding (measured 2026-07-16; see scripts/decode-gate.mjs header).
  if (
    text.includes('markup') || text.includes('mark-up') ||
    text.includes('ordered to be reported') || text.includes('reported by')
  ) return 'markup';
  return 'committee';
}

/**
 * SENTENCES THAT CANNOT BE READ FROM THE LAST ACTION ALONE (2026-09-24).
 *
 * `mapStatus` files both of these as `passed_chamber`, because that is what
 * they follow most of the time. But not always, and the exceptions are a
 * false passage claim:
 *
 *   - "Motion to reconsider laid on the table Agreed to without objection."
 *     is laid after ANY recorded House vote, won or lost. H.Con.Res. 38
 *     failed in the House 212-219 on 2026-03-05 and H.R. 2262 failed 209-215
 *     on 2026-01-13; this sentence is the last action on both.
 *   - "Message on Senate action sent to the House." (and the mirror) is the
 *     notice that follows the acting chamber's action on the measure. Usually
 *     that action is passage, but the notice does not say so.
 *
 * AND ONE THAT `mapStatus` FILES AS `floor_vote` (2026-09-25, S. 4668):
 *
 *   - "The committee substitute withdrawn by Voice Vote." and its siblings
 *     (lib/floor-text.mjs's COMMITTEE_TEXT_ON_FLOOR) are the chamber disposing
 *     of a committee's text on its floor. They say the measure is on the
 *     floor and nothing about where it stands — eight of the nine read in
 *     the record sit directly before a same-day "Passed Senate with an
 *     amendment…", and S. 4668's follows a cloture vote on the bill. Read on
 *     their own they were worse than ambiguous: no rule matched, so they
 *     fell to `committee`.
 *
 * So no write path may store a status for one of these without first reading
 * the action BEFORE it (see `resolveAmbiguousStatus`). One missed passage is
 * cheaper than one wrong one.
 */
export const AMBIGUOUS_WITHOUT_CONTEXT = [
  /\bmotion to reconsider laid on the table\b/i,
  /\bmessage on (?:house|senate) action sent to the (?:house|senate)\b/i,
  COMMITTEE_TEXT_ON_FLOOR,
];

/** @param {string | null | undefined} text */
export function isAmbiguousAction(text) {
  const t = String(text ?? '');
  return AMBIGUOUS_WITHOUT_CONTEXT.some((re) => re.test(t));
}

/** A sentence that records the measure's own floor defeat. */
const RECORDED_FAILURE = /\bfailed\b|\bnot agreed to\b/i;

/**
 * The status an ambiguous last action stands for, read from the action list
 * (newest first, Congress.gov's own order; same-timestamp siblings such as
 * "On passage Failed..." and "Failed of passage/not agreed to in House..."
 * say the same thing, so their relative order does not matter). Pure.
 *
 * Skips every ambiguous sentence and reads the first one that is not, and
 * returns the sentence it read (`basis`) and that action's date
 * (`basisDate`), which every write path stores as `status_basis_text` /
 * `status_basis_date` (writeStatusBasis below):
 *   - Congress.gov's DEFEAT summary ("Failed of passage/not agreed to in
 *     House ...") -> `floor_vote`, the stage every recorded failure already
 *     maps to. Since 2026-09-24 this is safe to write because the defeat is
 *     STORED as the basis: the journey, the ladder and the floor matchers
 *     read it (lib/floor-text.mjs's statusBasisText), so the settled branch
 *     says the chamber voted it down. (#285 wrote `committee` here, because
 *     without a stored basis `floor_vote` over the bare reconsider sentence
 *     rendered "it's moving on the floor".)
 *   - any other recorded FAILURE with no chamber-naming summary ->
 *     `committee`, for #285's reason: nothing downstream could read a
 *     chamber out of it, so `floor_vote` would still render the neutral
 *     "moving on the floor", and `committee` is the missed claim, not a new
 *     one.
 *   - a passage -> `passed_chamber`; anything else -> mapStatus of it.
 * Returns null when no readable, unambiguous action exists.
 *
 * @param {Array<{ text?: string, actionDate?: string, actionTime?: string }> | null | undefined} actions
 * @returns {{ status: string, basis: string, basisDate: string | null } | null}
 */
export function statusFromActions(actions) {
  const list = (actions ?? []).filter((a) => a?.text);
  const i = list.findIndex((a) => !isAmbiguousAction(a.text));
  if (i === -1) return null;
  const first = list[i];
  // THE VOTE IS RECORDED AS A GROUP. The House writes one vote as two
  // sentences with the same timestamp: the vote itself ("On passage Passed by
  // the Yeas and Nays: ...", which no mapStatus rule reads as passage) and
  // Congress.gov's summary line ("Passed/agreed to in House: On passage ..."
  // or "Failed of passage/not agreed to in House ..."). Their relative order
  // is not guaranteed, so the verdict is read from the whole group: every
  // action sharing the first one's date and time (date alone when Congress
  // gives no time, as the Senate usually does not).
  const key = (a) => `${a.actionDate ?? ''}|${a.actionTime ?? ''}`;
  const group = list.slice(i).filter((a) => key(a) === key(first) && !isAmbiguousAction(a.text));
  const out = (status, a) => ({ status, basis: a.text, basisDate: isoDate(a.actionDate) });
  const defeat = group.find((a) => /^\s*failed of passage\b|\bnot agreed to in (?:the )?(?:house|senate)\b/i.test(a.text));
  if (defeat) return out(mapStatus(defeat.text), defeat);
  const passage = group.find((a) => mapStatus(a.text) === 'passed_chamber');
  if (passage) return out('passed_chamber', passage);
  if (RECORDED_FAILURE.test(first.text)) return out('committee', first);
  return out(mapStatus(first.text), first);
}

/** A YYYY-MM-DD prefix, or null. */
function isoDate(v) {
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(v ?? ''));
  return m ? m[0] : null;
}

/**
 * Store (or clear) the sentence a bill's status was read from. The ONE writer
 * of `status_basis_text` / `status_basis_date`, used by refreshBillFields, the
 * new-bill path (scripts/bill-decode.mjs) and scripts/rederive-status.mjs.
 * `null` DELETES both fields: a record whose latest step is readable on its
 * own carries no basis at all, never an empty one.
 * @param {Record<string, any>} bill
 * @param {{ text: string, date?: string | null } | null} basis
 */
export function writeStatusBasis(bill, basis) {
  if (basis?.text) {
    bill.status_basis_text = basis.text;
    if (basis.date) bill.status_basis_date = basis.date;
    else delete bill.status_basis_date;
  } else {
    delete bill.status_basis_text;
    delete bill.status_basis_date;
  }
}

/**
 * THE BASIS FIELDS' INTEGRITY RULES, for scripts/verify-sync.mjs (pre-commit):
 *   - a basis exists ONLY behind an ambiguous latest step (it is cleared on
 *     every other write, so one sitting behind a readable sentence is stale
 *     and would make the page reason from an older action than it shows);
 *   - it is a non-empty string and is not itself ambiguous;
 *   - a basis date is YYYY-MM-DD and never present without the text.
 * An ambiguous latest step WITHOUT a basis is legal: it is the "could not
 * look" state, and its status is whatever was stored before.
 * Returns one "slug: reason" line per problem. Pure.
 * @param {Array<Record<string, any>>} bills
 * @returns {string[]}
 */
export function statusBasisProblems(bills) {
  const out = [];
  for (const b of Array.isArray(bills) ? bills : []) {
    const hasText = !!b && Object.prototype.hasOwnProperty.call(b, 'status_basis_text');
    const hasDate = !!b && Object.prototype.hasOwnProperty.call(b, 'status_basis_date');
    if (!hasText && !hasDate) continue;
    const slug = slugOf(b);
    if (!hasText) {
      out.push(`${slug}: status_basis_date without status_basis_text`);
      continue;
    }
    const t = b.status_basis_text;
    if (typeof t !== 'string' || !t.trim()) out.push(`${slug}: status_basis_text is empty or not a string`);
    else if (isAmbiguousAction(t)) out.push(`${slug}: status_basis_text is itself an ambiguous sentence`);
    if (!isAmbiguousAction(b.last_action_text)) out.push(`${slug}: status_basis_text behind a latest step that is readable on its own`);
    if (hasDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.status_basis_date))) out.push(`${slug}: status_basis_date is not YYYY-MM-DD`);
  }
  return out;
}

/**
 * Fetch a bill's action list (newest first). Null, never a throw, when the
 * key is absent or Congress.gov will not answer, so every caller has exactly
 * one "could not look" branch.
 * @param {{ bill_type: string, bill_number: number | string }} bill
 * @returns {Promise<Array<{ text?: string }> | null>}
 */
export async function fetchBillActions(bill) {
  if (!process.env.CONGRESS_API_KEY) return null;
  try {
    const r = await cg(`/bill/${CONGRESS}/${String(bill.bill_type).toLowerCase()}/${bill.bill_number}/actions`, { limit: '50' });
    return Array.isArray(r?.actions) ? r.actions : null;
  } catch {
    return null;
  }
}

/**
 * THE ONE RESOLUTION every write path uses for an ambiguous last action
 * (refreshBillFields below, the new-bill path in scripts/bill-decode.mjs,
 * scripts/rederive-status.mjs). Null means "could not tell": the caller must
 * then keep what it has and never fall back to mapStatus's passage reading.
 * `fetchActions` is injectable for tests.
 * @param {{ bill_type: string, bill_number: number | string }} bill
 * @param {{ fetchActions?: (bill: any) => Promise<Array<{ text?: string }> | null> }} [opts]
 * @returns {Promise<{ status: string, basis: string } | null>}
 */
export async function resolveAmbiguousStatus(bill, { fetchActions = fetchBillActions } = {}) {
  const actions = await fetchActions(bill);
  return actions ? statusFromActions(actions) : null;
}

/**
 * The status a write path with NOTHING stored may give an ambiguous latest
 * action when the action before it could not be read — the new-bill path in
 * scripts/bill-decode.mjs, the only such caller (refreshBillFields and the
 * re-derivation pass keep the status they already hold). Pure.
 *
 * #285's rule stands: a default reading that claims a PASSAGE is never
 * stored unread ("Motion to reconsider laid on the table…", "Message on …
 * action sent to …"), so those enter at `committee` — a missed passage,
 * never a wrong one. But `committee` is not the safe miss for every
 * ambiguous sentence. "The committee substitute withdrawn by Voice Vote." is
 * only ever written on the floor (2026-09-25, S. 4668), so entering it at
 * `committee` is exactly the false claim this exists to prevent; its default
 * reading, `floor_vote`, claims no outcome and is what it enters at.
 * @param {string | null | undefined} actionText
 * @returns {string}
 */
export function unresolvedAmbiguousStatus(actionText) {
  const status = mapStatus(actionText);
  return status === 'passed_chamber' ? 'committee' : status;
}

// Stored sync-time score (freshness bonus, no decay) - the FEED never ranks
// by this; read-time effectiveUrgency in lib/urgency.mjs does the ranking.
// The base table is shared so the two curves can't drift apart.
export function urgencyScore(status, lastActionDate) {
  const base = STATUS_BASE[status] ?? 0.2;
  let bonus = 0;
  if (lastActionDate) {
    const days = (Date.now() - new Date(lastActionDate).getTime()) / 86_400_000;
    if (Number.isFinite(days)) bonus = days < 3 ? 0.1 : days < 7 ? 0.05 : 0;
  }
  return Math.round(Math.min(1, Math.max(0, base + bonus)) * 1000) / 1000;
}

// CRS Policy Area -> our 12 flat categories (1:1, all 32 areas covered)
const POLICY_AREA_TO_CATEGORY = {
  'Labor and Employment': 'jobs_economy', 'Commerce': 'jobs_economy',
  'Finance and Financial Sector': 'jobs_economy', 'Taxation': 'jobs_economy',
  'Economics and Public Finance': 'jobs_economy', 'Agriculture and Food': 'jobs_economy',
  'Transportation and Public Works': 'jobs_economy',
  'Science, Technology, Communications': 'ai_technology',
  'Health': 'health',
  'Housing and Community Development': 'housing',
  'Immigration': 'immigration',
  'Government Operations and Politics': 'government_democracy', 'Congress': 'government_democracy',
  'Emergency Management': 'government_democracy',
  'Crime and Law Enforcement': 'crime_justice', 'Law': 'crime_justice',
  'Education': 'education', 'Sports and Recreation': 'education',
  'Social Sciences and History': 'education',
  'Environmental Protection': 'environment_energy', 'Energy': 'environment_energy',
  'Public Lands and Natural Resources': 'environment_energy',
  'Water Resources Development': 'environment_energy', 'Animals': 'environment_energy',
  'Civil Rights and Liberties, Minority Issues': 'rights_liberties',
  'Armed Forces and National Security': 'national_security',
  'International Affairs': 'national_security',
  'Foreign Trade and International Finance': 'national_security',
  'Families': 'family_community', 'Social Welfare': 'family_community',
  'Native Americans': 'family_community', 'Arts, Culture, Religion': 'family_community',
};

export function tagBill(policyArea) {
  const cat = POLICY_AREA_TO_CATEGORY[policyArea ?? ''];
  return cat ? [cat] : [];
}

export function slugOf(b) {
  return `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
}

/**
 * Every corpus record whose `congress_number` is not the Congress this build
 * tracks - the corpus-uniformity gate scripts/verify-sync.mjs fails on
 * (2026-08-11). Returns the offending records' slugs, so a failure names the
 * bills rather than a count.
 *
 * WHY THE CHECK EXISTS. Two 118th-Congress records (s-1776-118, s-5110-118)
 * rode in with the original seed commit (ad6668f, 2026-06-12) and survived
 * two months of nightly syncs, because nothing ever LOOKED: every write path
 * since is pinned to CONGRESS, so no code could add one, and no check could
 * notice one already sitting there. They rendered live pages that asserted
 * present-tense floor activity for a Congress that ended in Jan 2025 (the
 * s-1776-118 green-panel defect, tests/freshness.spec.ts R2b).
 *
 * WHY IT LIVES HERE rather than in verify-sync.mjs, which runs it: this
 * module owns CONGRESS and is import-clean by contract (no secrets read at
 * import - see the header and cg()'s comment), so a unit test can import the
 * judgement without the file-reading, git-shelling, process.exit-ing script
 * body around it. Same split as lib/verify-moment-updates.mjs vs.
 * scripts/check-moment-updates.mjs.
 *
 * Strict equality on purpose: a string "119" is not what any write path
 * produces, and a corpus that silently changed the field's TYPE is exactly
 * the kind of drift this gate is for.
 */
export function offCongressBills(bills, congress = CONGRESS) {
  if (!Array.isArray(bills)) return [];
  return bills.filter((b) => b?.congress_number !== congress).map(slugOf);
}

/** Slug for a Congress.gov bill-list item ({type, number}), not yet a corpus
 *  bill object - the shape sync-bills.mjs's `updated`/recent-pass arrays and
 *  hot-bills.mjs's fetch results are in. */
export function updateSlug(u, congress = CONGRESS) {
  return `${u.type.toLowerCase()}-${u.number}-${congress}`.toLowerCase();
}

/** Congress.gov's URL path segment per bill type. The old inline ternary
 *  only knew the four original types, so a decoded hconres/sconres got a
 *  senate-joint-resolution URL (2026-07-23). One map, all six types. */
const CHAMBER_PATHS = {
  hr: 'house-bill',
  s: 'senate-bill',
  hjres: 'house-joint-resolution',
  sjres: 'senate-joint-resolution',
  hconres: 'house-concurrent-resolution',
  sconres: 'senate-concurrent-resolution',
};

export function congressGovUrl(type, number) {
  return `https://www.congress.gov/bill/${CONGRESS}th-congress/${CHAMBER_PATHS[type] ?? 'house-bill'}/${number}`;
}

/** The `latestAction` we are willing to write a record from, or null when the
 *  payload can't be read. ONE definition of "readable", shared by the refresh
 *  path (refreshBillFields, below) and the new-bill path (syncOneBill in
 *  scripts/bill-decode.mjs), so the two can't drift into disagreeing about
 *  which payloads are trustworthy - the same "one copy" discipline this file
 *  already enforces for status mapping and URL building.
 *
 *  Readable means it carries action TEXT. Everything either path derives -
 *  status via mapStatus, the priority gate's verdict, urgency - is computed
 *  from that text, so a payload without it supports no conclusion at all,
 *  about either an existing bill or a new one. A bare actionDate with no text
 *  is NOT readable: it can't produce a status, and pairing it with text we
 *  didn't get would overstate freshness. */
export function readableAction(detail) {
  const action = detail?.latestAction;
  return action?.text ? action : null;
}

/** Mutate an existing corpus bill's refreshable fields in place from a
 *  Congress.gov bill-detail payload (`cg('/bill/{congress}/{type}/{number}')`'s
 *  `.bill`). Free, no AI cost - the one place both scripts' "refresh" branch
 *  lives, so it can't drift between the nightly sync and the hot-bill pass.
 *
 *  Returns 'refreshed' when the payload was readable and the fields were
 *  written, or 'skipped_partial' when it wasn't and NOTHING was touched. The
 *  sentinel doubles as syncOneBill's outcome string (scripts/bill-decode.mjs),
 *  so the refresh vocabulary can't drift apart from the sync vocabulary
 *  either - every caller counts the skip and says so in its own run log.
 *
 *  A 200 whose `latestAction` carries no readable text is NOT a bill that
 *  went quiet; it's a reply we can't read (a mid-update record, or a degraded
 *  Congress.gov response). Every action-derived field below is computed from
 *  that text, so writing them from an absent one silently REWROTE the record:
 *  mapStatus(undefined) falls through to 'committee' and last_action_date was
 *  assigned unconditionally to null, while last_action_text alone had a
 *  `?? existing` fallback and kept its old value. That asymmetry is what made
 *  the damage invisible - a bill sitting on the Senate calendar came out as
 *  'committee', dated null, still carrying "Placed on Senate Legislative
 *  Calendar" as its text: internally inconsistent, below every urgency floor,
 *  dropped from the homepage "Act now" band, and shown to visitors as a quiet
 *  week. Nothing in hot-bills.yml verifies the refresh afterwards, so nothing
 *  would have caught it. So: no readable action, no write at all.
 *
 *  The one present-but-partial payload still written is text WITHOUT an
 *  actionDate - the text is the record and maps to a status on its own. Its
 *  date is PRESERVED rather than nulled, because the stored date is the date
 *  of an action that really happened: keeping it can only understate this
 *  bill's freshness (urgencyScore's recency bonus, lib/freshness.ts's
 *  newestAction scan), never overstate it, while null erases the signal
 *  outright. The mirror case - a date with NO text - deliberately gets no
 *  such path: it can't produce a status, and pinning a newer date onto the
 *  older stored text would overstate freshness, the one direction this file
 *  must never err in. It skips with everything else.
 *
 *  ASYNC since 2026-09-24: an ambiguous latest action (see
 *  AMBIGUOUS_WITHOUT_CONTEXT) costs one /actions request to resolve, and
 *  every caller awaits the outcome. `resolve` is injectable for tests. */
export async function refreshBillFields(existing, detail, { resolve = resolveAmbiguousStatus } = {}) {
  const action = readableAction(detail);
  if (!action) return 'skipped_partial';
  // An ambiguous last action (AMBIGUOUS_WITHOUT_CONTEXT above) is resolved
  // from the action BEFORE it. The detail payload carries only latestAction,
  // so this is one extra request, made only for these sentences. When it
  // cannot be made the stored status stands (never mapStatus's passage
  // reading) and the nightly re-derivation pass retries it.
  //
  // THE BASIS travels with the status (writeStatusBasis): the sentence the
  // status was read from, stored when the latest step is ambiguous and
  // deleted when it is not. When the lookup fails the kept status came from
  // the PREVIOUS reading: its stored basis if it had one, else the previous
  // latest step, provided that step was readable on its own.
  let status = mapStatus(action.text);
  let basis = null;
  if (isAmbiguousAction(action.text)) {
    const resolved = await resolve(existing);
    if (resolved) {
      status = resolved.status;
      basis = { text: resolved.basis, date: resolved.basisDate ?? null };
    } else {
      console.warn(`WARN ${slugOf(existing)}: ambiguous last action ("${action.text}") and the action before it could not be read; status kept at ${existing.status}`);
      status = existing.status ?? 'committee';
      if (existing.status_basis_text) {
        basis = { text: existing.status_basis_text, date: existing.status_basis_date ?? null };
      } else if (existing.last_action_text && !isAmbiguousAction(existing.last_action_text)) {
        basis = { text: existing.last_action_text, date: existing.last_action_date ?? null };
      }
    }
  }
  writeStatusBasis(existing, basis);
  const lastActionDate = action.actionDate ?? existing.last_action_date ?? null;
  existing.status = status;
  existing.last_action_date = lastActionDate;
  existing.last_action_text = action.text;
  existing.urgency_score = urgencyScore(status, lastActionDate);
  const tags = tagBill(detail.policyArea?.name);
  if (tags.length) existing.issue_tags = tags;
  existing.policy_area = detail.policyArea?.name ?? existing.policy_area;
  // Recompute rather than trust the stored value: bills decoded while the
  // URL builder was wrong (hconres/sconres, 2026-07-23) self-heal on their
  // next refresh.
  existing.congress_gov_url = congressGovUrl(existing.bill_type, existing.bill_number);
  return 'refreshed';
}
