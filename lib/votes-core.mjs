/**
 * Roll-call votes: the pure half. Parsers for the three official record
 * shapes, the bill-id resolution, and the gate's judgement over
 * data/votes.json. No I/O, no secrets, no network: scripts/sync-votes.mjs
 * supplies the bytes, scripts/check-votes.mjs supplies the files and the exit
 * code, and tests/votes.unit.spec.ts drives everything here directly. Same
 * split as lib/verify-moment-updates.mjs vs. scripts/check-moment-updates.mjs.
 *
 * WHAT THE FILE IS. For every roll call in either chamber whose vote question
 * references a bill in the corpus (data/bills.json), the record's own
 * question text, result, date, tally and every member's position. Record data
 * only. Nothing here is written by a model, and nothing here says anything the
 * record does not: a position is Yea, Nay, Present or Not voting — the House
 * record's "Aye"/"No" on a recorded vote are counted by the Clerk under the
 * same yea/nay totals, so they are stored as the same two codes. No party is
 * stored at all; data/legislators.json already carries it and a vote record
 * has no reason to repeat it.
 *
 * SOURCES (verified 2026-09-24):
 *   House, primary  — Congress.gov API `/house-vote/{congress}/{session}`
 *                     (list), `/{roll}` (detail, party totals) and
 *                     `/{roll}/members` (bioguideID + voteCast, all ~433
 *                     members in one page).
 *   House, fallback — clerk.house.gov `evs/{year}/roll{NNN}.xml`, which
 *                     carries the same roll call with `name-id` = bioguide.
 *   Senate          — senate.gov `LIS/roll_call_lists/vote_menu_{c}_{s}.xml`
 *                     (the per-session list; the `roll_call_votes/` path for
 *                     the menu 301s to a "not available" page) and
 *                     `LIS/roll_call_votes/vote{c}{s}/vote_{c}_{s}_{NNNNN}.xml`
 *                     per vote. Senators are identified by `lis_member_id`
 *                     only, joined to bioguide through data/legislators.json's
 *                     `lis` field.
 */
import { findCitations } from '../scripts/newsdesk-match.mjs';

export const VOTES_PATH = 'data/votes.json';
export const VOTES_SCHEMA = 1;
/** How far back the FIRST run reaches. After that the floor is fixed in the
 *  file and the record only grows forward. */
export const LOOKBACK_DAYS = 120;
/** A committed votes file larger than this is a runaway write, not a busy
 *  Congress: ~150 House and ~100 Senate corpus roll calls measured ~0.6 MB. */
export const VOTES_MAX_BYTES = 6_000_000;

/** Position codes, in the order the record's totals list them. */
export const POSITIONS = /** @type {const} */ (['yea', 'nay', 'present', 'notVoting']);

/** `119-2-309`: congress, session, the highest roll number examined. A date
 *  is NOT a valid cursor here — roll numbers are the record's own sequence. */
export const CURSOR_RE = /^\d{3}-[12]-\d{1,5}$/;
const ISO_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class VoteParseError extends Error {}

/**
 * @typedef {{ roll: import('./types').RollCall, members: Array<{ id: string, name: string, state: string }> }} ParsedRollCall
 */

/**
 * The record's vote cast → our position key. Anything unrecognized THROWS:
 * a novel cast (an impeachment trial's "Guilty", a Speaker election's names)
 * is a roll call we do not know how to state, and a guessed position is worse
 * than a missing roll call.
 */
export function positionOf(cast) {
  const c = String(cast ?? '').trim().toLowerCase();
  if (c === 'yea' || c === 'aye') return 'yea';
  if (c === 'nay' || c === 'no') return 'nay';
  if (c === 'present' || c.startsWith('present,')) return 'present';
  if (c === 'not voting') return 'notVoting';
  throw new VoteParseError(`unrecognized vote cast ${JSON.stringify(cast)}`);
}

export const rollCallId = (chamber, congress, session, roll) =>
  `${chamber === 'house' ? 'h' : 's'}-${congress}-${session}-${roll}`;

/** First year of a Congress: the 119th began in 2025. */
export const congressFirstYear = (congress) => 1789 + 2 * (congress - 1);

/** The session a calendar year falls in, or null when the year is outside
 *  that Congress. */
export function sessionForYear(congress, year) {
  const s = year - congressFirstYear(congress) + 1;
  return s === 1 || s === 2 ? s : null;
}

/**
 * Resolve a vote to ONE corpus bill id, or null. Candidates are tried in the
 * order given (the caller puts the record's structured fields first and its
 * question text last); the first candidate that names a tracked bill type
 * decides, and it counts only if that bill is in the corpus. A simple
 * resolution (H.Res./S.Res.) — which is what a House rule vote is on — is not
 * a tracked type, so a rule vote never attaches to the bill it schedules: the
 * rule is its own measure, and lib/docket.mjs already refuses to read a rule
 * passing as the bill passing.
 *
 * @param {Array<string|null|undefined>} candidates
 * @param {Set<string>} corpus  bill ids like `hr-3633-119`
 * @param {number} congress
 */
export function resolveBillId(candidates, corpus, congress) {
  for (const text of candidates) {
    const hits = findCitations(text ?? '');
    if (hits.length === 0) continue;
    // findCitations builds its slug for the 119th; rebuild it for the vote's
    // own Congress so a future bump cannot silently cross-wire Congresses.
    const id = `${hits[0].type}-${hits[0].number}-${congress}`;
    return corpus.has(id) ? id : null;
  }
  return null;
}

/** "HR" + "5334" → "H.R. 5334"-ish text findCitations reads. */
export const legislationText = (type, number) =>
  type && number ? `${String(type).toUpperCase()} ${number}` : null;

// ---- House: Congress.gov API ------------------------------------------------

/**
 * One House roll call from the Congress.gov API's detail + members replies.
 * Totals come from the DETAIL reply's party tallies — an independent count
 * from the per-member listing, which is what lets the gate check one against
 * the other.
 *
 * @returns {ParsedRollCall}
 */
export function parseHouseApi(detail, members, { corpus, sourceUrl } = {}) {
  const d = detail?.houseRollCallVote;
  const m = members?.houseRollCallVoteMemberVotes;
  if (!d || !m) throw new VoteParseError('house API reply is missing houseRollCallVote / houseRollCallVoteMemberVotes');
  if (d.rollCallNumber !== m.rollCallNumber) throw new VoteParseError('house detail and members replies are for different roll calls');
  const totals = { yea: 0, nay: 0, present: 0, notVoting: 0 };
  for (const p of d.votePartyTotal ?? []) {
    totals.yea += Number(p.yeaTotal ?? 0);
    totals.nay += Number(p.nayTotal ?? 0);
    totals.present += Number(p.presentTotal ?? 0);
    totals.notVoting += Number(p.notVotingTotal ?? 0);
  }
  const votes = { yea: [], nay: [], present: [], notVoting: [] };
  const roster = [];
  for (const r of m.results ?? []) {
    if (!r.bioguideID) throw new VoteParseError('house member row without a bioguideID');
    votes[positionOf(r.voteCast)].push(r.bioguideID);
    roster.push({ id: r.bioguideID, name: `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim(), state: r.voteState });
  }
  const bill = resolveBillId(
    [legislationText(d.legislationType, d.legislationNumber), d.voteQuestion],
    corpus ?? new Set(),
    d.congress
  );
  return {
    roll: finishRoll({
      chamber: 'house',
      congress: d.congress,
      session: d.sessionNumber,
      roll: d.rollCallNumber,
      date: String(d.startDate ?? '').slice(0, 10),
      question: d.voteQuestion,
      result: d.result,
      bill,
      totals,
      votes,
      source: sourceUrl ?? d.sourceDataURL ?? null,
    }),
    members: roster,
  };
}

// ---- House: clerk.house.gov XML (fallback) ---------------------------------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const pad = (n) => String(n).padStart(2, '0');

const tag = (src, name) => {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(src);
  return m ? decodeXml(m[1]).replace(/\s+/g, ' ').trim() : null;
};
const attr = (src, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(src);
  return m ? decodeXml(m[1]) : null;
};
function decodeXml(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
const intOr0 = (s) => (s == null || s === '' ? 0 : Number.parseInt(s, 10));

/** "15-Sep-2026" → "2026-09-15". */
export function houseClerkDate(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s ?? '').trim());
  if (!m || !MONTHS[m[2].toLowerCase()]) throw new VoteParseError(`unreadable House action-date ${JSON.stringify(s)}`);
  return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
}

/** One House roll call from the Clerk's XML. Same output as parseHouseApi.
 *  @returns {ParsedRollCall} */
export function parseHouseClerkXml(xml, { corpus, sourceUrl } = {}) {
  const src = String(xml ?? '');
  const meta = tag(src, 'vote-metadata');
  if (!meta) throw new VoteParseError('clerk XML has no <vote-metadata>');
  const congress = intOr0(tag(meta, 'congress'));
  const session = intOr0(tag(meta, 'session')); // "2nd" → 2
  const byVote = /<totals-by-vote>([\s\S]*?)<\/totals-by-vote>/i.exec(src)?.[1] ?? '';
  const totals = {
    yea: intOr0(tag(byVote, 'yea-total')),
    nay: intOr0(tag(byVote, 'nay-total')),
    present: intOr0(tag(byVote, 'present-total')),
    notVoting: intOr0(tag(byVote, 'not-voting-total')),
  };
  const votes = { yea: [], nay: [], present: [], notVoting: [] };
  const roster = [];
  for (const rv of src.matchAll(/<recorded-vote>([\s\S]*?)<\/recorded-vote>/gi)) {
    const leg = /<legislator\b([^>]*)>([\s\S]*?)<\/legislator>/i.exec(rv[1]);
    const id = leg ? attr(leg[1], 'name-id') : null;
    if (!id) throw new VoteParseError('clerk <recorded-vote> without a name-id');
    votes[positionOf(tag(rv[1], 'vote'))].push(id);
    roster.push({ id, name: attr(leg[1], 'unaccented-name') ?? decodeXml(leg[2]).trim(), state: attr(leg[1], 'state') });
  }
  const legis = tag(meta, 'legis-num');
  return {
    roll: finishRoll({
      chamber: 'house',
      congress,
      session,
      roll: intOr0(tag(meta, 'rollcall-num')),
      date: houseClerkDate(tag(meta, 'action-date')),
      question: tag(meta, 'vote-question'),
      result: tag(meta, 'vote-result'),
      bill: resolveBillId([legis, tag(meta, 'vote-question')], corpus ?? new Set(), congress),
      totals,
      votes,
      source: sourceUrl ?? null,
    }),
    members: roster,
  };
}

// ---- Senate: senate.gov XML -------------------------------------------------

/** "September 15, 2026,  02:19 PM" → "2026-09-15". */
export function senateDate(s) {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(String(s ?? '').trim());
  const mon = m ? MONTHS[m[1].toLowerCase()] : null;
  if (!m || !mon) throw new VoteParseError(`unreadable Senate vote_date ${JSON.stringify(s)}`);
  return `${m[3]}-${pad(mon)}-${pad(m[2])}`;
}

/**
 * The per-session vote menu → [{roll, date, issue, question}]. `date` is
 * built from the menu's "15-Sep" plus its <congress_year>.
 */
export function parseSenateMenu(xml) {
  const src = String(xml ?? '');
  const year = intOr0(tag(src, 'congress_year'));
  if (!year) throw new VoteParseError('senate vote menu has no <congress_year>');
  const out = [];
  for (const v of src.matchAll(/<vote>([\s\S]*?)<\/vote>/gi)) {
    const d = /^(\d{1,2})-([A-Za-z]{3})$/.exec(tag(v[1], 'vote_date') ?? '');
    out.push({
      roll: intOr0(tag(v[1], 'vote_number')),
      date: d && MONTHS[d[2].toLowerCase()] ? `${year}-${pad(MONTHS[d[2].toLowerCase()])}-${pad(d[1])}` : null,
      issue: tag(v[1], 'issue'),
      question: tag(v[1], 'question'),
    });
  }
  return out;
}

/**
 * One Senate roll call. `lisToBioguide(lis)` maps a senator's LIS id to a
 * bioguide id or returns null; an unmapped senator THROWS, because a position
 * we cannot attach to a person is a position we must not store.
 * @returns {ParsedRollCall}
 */
export function parseSenateXml(xml, { corpus, sourceUrl, lisToBioguide } = {}) {
  const src = String(xml ?? '');
  if (!/<roll_call_vote>/i.test(src)) throw new VoteParseError('senate XML has no <roll_call_vote>');
  const congress = intOr0(tag(src, 'congress'));
  const count = tag(src, 'count') ?? '';
  const totals = {
    yea: intOr0(tag(count, 'yeas')),
    nay: intOr0(tag(count, 'nays')),
    present: intOr0(tag(count, 'present')),
    notVoting: intOr0(tag(count, 'absent')),
  };
  const votes = { yea: [], nay: [], present: [], notVoting: [] };
  const roster = [];
  for (const mm of src.matchAll(/<member>([\s\S]*?)<\/member>/gi)) {
    const lis = tag(mm[1], 'lis_member_id');
    const id = lis && lisToBioguide ? lisToBioguide(lis) : null;
    if (!id) throw new VoteParseError(`senator ${lis ?? '(no lis_member_id)'} does not resolve to a bioguide id`);
    votes[positionOf(tag(mm[1], 'vote_cast'))].push(id);
    roster.push({ id, name: `${tag(mm[1], 'first_name') ?? ''} ${tag(mm[1], 'last_name') ?? ''}`.trim(), state: tag(mm[1], 'state') });
  }
  const doc = tag(src, 'document') ?? '';
  const docCongress = intOr0(tag(doc, 'document_congress')) || congress;
  const amendment = tag(src, 'amendment') ?? '';
  const questionText = tag(src, 'vote_question_text');
  const bill =
    docCongress === congress
      ? resolveBillId(
          [
            legislationText(tag(doc, 'document_type'), tag(doc, 'document_number')),
            tag(amendment, 'amendment_to_document_number'),
            questionText,
          ],
          corpus ?? new Set(),
          congress
        )
      : null;
  const tieVote = tag(tag(src, 'tie_breaker') ?? '', 'tie_breaker_vote');
  const roll = finishRoll({
    chamber: 'senate',
    congress,
    session: intOr0(tag(src, 'session')),
    roll: intOr0(tag(src, 'vote_number')),
    date: senateDate(tag(src, 'vote_date')),
    question: questionText,
    result: tag(src, 'vote_result'),
    bill,
    totals,
    votes,
    source: sourceUrl ?? null,
  });
  // The Vice President is not a member and is never in <members>; the record
  // carries a tie-breaking vote separately, and so do we.
  if (tieVote) roll.tieBreaker = { by: tag(tag(src, 'tie_breaker') ?? '', 'by_whom'), position: positionOf(tieVote) };
  return { roll, members: roster };
}

function finishRoll(r) {
  if (!r.congress || !r.session || !r.roll) throw new VoteParseError('roll call without congress/session/number');
  for (const k of POSITIONS) r.votes[k].sort();
  return {
    id: rollCallId(r.chamber, r.congress, r.session, r.roll),
    chamber: r.chamber,
    congress: r.congress,
    session: r.session,
    roll: r.roll,
    date: r.date,
    question: r.question ?? null,
    result: r.result ?? null,
    bill: r.bill,
    totals: r.totals,
    source: r.source,
    votes: r.votes,
  };
}

/** Stable order for the file: chamber, then congress/session/roll. */
export const compareRollCalls = (a, b) =>
  a.chamber.localeCompare(b.chamber) || a.congress - b.congress || a.session - b.session || a.roll - b.roll;

// ---- the gate ---------------------------------------------------------------

/**
 * Judge a votes document. Pure; returns failures (block the commit),
 * warnings, and notes. Callers: scripts/check-votes.mjs (CI and the nightly,
 * pre-commit) and scripts/sync-votes.mjs (refuses to WRITE a failing file).
 *
 * @param {{ data: any, fileBytes?: number, corpus: Set<string>,
 *           legislators: Array<{bioguide:string,type:string,state:string}>,
 *           vacancies: Array<{state:string,district:number}>, now?: number }} input
 */
export function verifyVotes({ data, fileBytes = 0, corpus, legislators, vacancies, now = Date.now() }) {
  const failures = [];
  const warnings = [];
  const notes = [];
  const fail = (m) => failures.push(m);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { failures: ['votes file is not a JSON object'], warnings, notes, resolution: { current: 0, vacancy: 0, departed: 0 } };
  }
  const meta = data._meta ?? {};
  if (meta.schema !== VOTES_SCHEMA) fail(`_meta.schema is ${JSON.stringify(meta.schema)}, this build reads ${VOTES_SCHEMA}`);
  if (fileBytes > VOTES_MAX_BYTES) fail(`file is ${fileBytes} bytes, over the ${VOTES_MAX_BYTES}-byte ceiling`);
  if (!DATE_RE.test(meta.floor ?? '')) fail(`_meta.floor ${JSON.stringify(meta.floor)} is not a YYYY-MM-DD date`);
  if (!ISO_SECONDS_RE.test(meta.updatedAt ?? '') || Number.isNaN(Date.parse(meta.updatedAt))) {
    fail(`_meta.updatedAt ${JSON.stringify(meta.updatedAt)} is not a seconds-precision ISO-8601 datetime`);
  } else if (Date.parse(meta.updatedAt) > now + 5 * 60_000) {
    fail(`_meta.updatedAt ${meta.updatedAt} is in the future`);
  }
  for (const chamber of ['house', 'senate']) {
    const c = meta.cursor?.[chamber];
    if (typeof c !== 'string' || !CURSOR_RE.test(c)) {
      fail(`_meta.cursor.${chamber} ${JSON.stringify(c)} is not CONGRESS-SESSION-ROLL (e.g. "119-2-309") — a date is not a roll-call cursor`);
    }
  }

  const roster = new Map();
  if (!Array.isArray(data.members)) fail('members is not an array');
  for (const m of data.members ?? []) {
    if (!m || typeof m.id !== 'string' || !/^[A-Z]\d{6}$/.test(m.id)) { fail(`roster entry with a malformed bioguide id: ${JSON.stringify(m)}`); continue; }
    if (roster.has(m.id)) fail(`roster lists ${m.id} twice`);
    if (!m.name || typeof m.name !== 'string') fail(`roster entry ${m.id} has no name`);
    if (!/^[A-Z]{2}$/.test(m.state ?? '')) fail(`roster entry ${m.id} has no two-letter state`);
    roster.set(m.id, m);
  }

  const current = new Map((legislators ?? []).map((l) => [l.bioguide, l]));
  const statesByChamber = { house: new Set(), senate: new Set() };
  for (const l of legislators ?? []) statesByChamber[l.type === 'sen' ? 'senate' : 'house'].add(l.state);
  const houseVacantStates = new Set((vacancies ?? []).map((v) => v.state));
  for (const s of houseVacantStates) statesByChamber.house.add(s);

  const referenced = new Set();
  const resolution = { current: 0, vacancy: 0, departed: 0 };
  const seenIds = new Set();
  if (!Array.isArray(data.rollCalls)) fail('rollCalls is not an array');
  for (const r of data.rollCalls ?? []) {
    const where = r?.id ?? '(no id)';
    if (!r || typeof r !== 'object') { fail('a roll call is not an object'); continue; }
    if (r.chamber !== 'house' && r.chamber !== 'senate') { fail(`${where}: chamber ${JSON.stringify(r.chamber)}`); continue; }
    if (r.id !== rollCallId(r.chamber, r.congress, r.session, r.roll)) fail(`${where}: id does not match chamber/congress/session/roll`);
    if (seenIds.has(r.id)) fail(`${where}: listed twice`);
    seenIds.add(r.id);
    if (!DATE_RE.test(r.date ?? '')) fail(`${where}: date ${JSON.stringify(r.date)} is not YYYY-MM-DD`);
    else {
      if (DATE_RE.test(meta.floor ?? '') && r.date < meta.floor) fail(`${where}: dated ${r.date}, before the file's floor ${meta.floor}`);
      if (Date.parse(`${r.date}T00:00:00Z`) > now + 86_400_000) fail(`${where}: dated in the future (${r.date})`);
    }
    if (!r.question) fail(`${where}: no question text`);
    if (!r.result) fail(`${where}: no result`);
    if (!corpus.has(r.bill)) fail(`${where}: bill ${JSON.stringify(r.bill)} is not in data/bills.json`);
    if (!/^https:\/\/(clerk\.house\.gov|www\.senate\.gov)\//.test(r.source ?? '')) fail(`${where}: source ${JSON.stringify(r.source)} is not the official record URL`);
    const seatCap = r.chamber === 'house' ? 441 : 100;
    let members = 0;
    const inThisRoll = new Set();
    for (const k of POSITIONS) {
      const ids = r.votes?.[k];
      if (!Array.isArray(ids)) { fail(`${where}: votes.${k} is not an array`); continue; }
      const t = r.totals?.[k];
      if (!Number.isInteger(t)) fail(`${where}: totals.${k} is not an integer`);
      else if (t !== ids.length) fail(`${where}: totals.${k} is ${t} but ${ids.length} member(s) are recorded ${k}`);
      members += ids.length;
      for (const id of ids) {
        if (inThisRoll.has(id)) fail(`${where}: ${id} is recorded twice`);
        inThisRoll.add(id);
        referenced.add(id);
        const m = roster.get(id);
        if (!m) { fail(`${where}: ${id} is not in the members roster`); continue; }
        if (m.chamber !== r.chamber) fail(`${where}: ${id} is a ${m.chamber} roster entry voting in the ${r.chamber}`);
      }
    }
    if (members === 0) fail(`${where}: no member positions`);
    if (members > seatCap) fail(`${where}: ${members} positions, more than the ${r.chamber}'s ${seatCap} seats`);
    if (r.tieBreaker && !POSITIONS.includes(r.tieBreaker.position)) fail(`${where}: tieBreaker.position ${JSON.stringify(r.tieBreaker.position)}`);
  }

  // Every member id resolves: to a current legislator; else (departed,
  // replaced, or sworn in after the last weekly legislators refresh) to its
  // own roster record, whose seat must be one the chamber actually has — a
  // House state with a recorded vacancy counts as `vacancy`.
  for (const id of referenced) {
    const m = roster.get(id);
    if (!m) continue; // already failed above
    if (current.has(id)) { resolution.current++; continue; }
    if (!statesByChamber[m.chamber]?.has(m.state)) {
      fail(`${id} (${m.name}) resolves to no legislator and to no ${m.chamber} seat in ${m.state}`);
      continue;
    }
    if (m.chamber === 'house' && houseVacantStates.has(m.state)) resolution.vacancy++;
    else resolution.departed++;
  }
  for (const id of roster.keys()) if (!referenced.has(id)) warnings.push(`roster entry ${id} is referenced by no roll call`);
  notes.push(
    `${(data.rollCalls ?? []).length} roll call(s) (${(data.rollCalls ?? []).filter((r) => r?.chamber === 'house').length} House, ${(data.rollCalls ?? []).filter((r) => r?.chamber === 'senate').length} Senate) across ${new Set((data.rollCalls ?? []).map((r) => r?.bill)).size} bill(s); members resolve: ${resolution.current} current, ${resolution.vacancy} in a vacant-seat state, ${resolution.departed} departed/replaced`
  );
  return { failures, warnings, notes, resolution };
}
