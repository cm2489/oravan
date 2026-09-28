/*
 * Special-election dates for vacant House seats - pure core. Plain .mjs with
 * JSDoc types and no side effects, like lib/redistricting-watch.mjs, so the
 * weekly script (scripts/sync-special-elections.mjs) and the unit spec
 * (tests/special-elections.unit.spec.ts) run the same logic.
 *
 * SOURCE. The Federal Election Commission's election-dates API (OpenFEC,
 * /v1/election-dates/). Checked 2026-09-28: it held rows for the special
 * elections behind all eleven House vacancies the 119th Congress has filled
 * (FL-01, FL-06, TX-18, AZ-07, VA-11, TN-07, NJ-11, GA-14, CA-01, CA-14,
 * GA-13), each added no later than 37 days after the seat fell vacant, and
 * none yet for FL-20 or TX-23, which the FEC's own "Dates and deadlines" page
 * and the House Clerk's vacancies page both list as "TBD" the same day. The
 * House Clerk publishes no election date in machine-readable form
 * (clerk.house.gov/xml/lists/MemberData.xml has none), and neither source
 * names a winner before the oath, so this records dates only - never a
 * member-elect.
 *
 * WHAT IS RECORDED. Only what the FEC row states: the date and the FEC's
 * election-type code, per seat, with the day we asked. Nothing is inferred:
 * a seat with no row gets an empty list, never a guessed date, and a failed
 * fetch keeps the last good answer with its OLD `checked` date, so the page
 * prints how stale it is instead of pretending to be current.
 *
 * KEY. api.data.gov's public DEMO_KEY - rate-limited, needs no signup and is
 * not a secret. One request per vacant seat per week sits well inside it; if
 * the limit is ever hit, that seat keeps its last answer and the run warns.
 */

export const FEC_ELECTION_DATES_URL = 'https://api.open.fec.gov/v1/election-dates/';
export const FEC_DEMO_KEY = 'DEMO_KEY';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_CODE = /^[A-Z]{1,4}$/;

/** @typedef {{ state: string, district: number, since: string }} Vacancy */
/** @typedef {{ date: string, type: string }} ElectionDate */
/** @typedef {{ checked: string, dates: ElectionDate[] }} SeatElections */

/** Same key as lib/core/reps.ts vacancySlug: "fl-20". */
export function seatSlug(seat) {
  return `${seat.state}-${seat.district}`.toLowerCase();
}

/** The FEC's two-digit district, "00" for an at-large seat. */
export function fecDistrict(district) {
  return String(district).padStart(2, '0');
}

/**
 * One seat's query: House rows for this state and district dated on or after
 * the day the seat was first seen vacant. `since` is the floor because a row
 * from an EARLIER vacancy of the same seat is dated before the member who
 * filled it was sworn in, so before this vacancy began. The cost: an election
 * already held before the seat was first seen vacant is not listed (FL-06's
 * special primary fell eight days after its vacancy in 2025).
 *
 * @param {Vacancy} seat
 * @param {string} [apiKey]
 */
export function electionDatesUrl(seat, apiKey = FEC_DEMO_KEY) {
  const u = new URL(FEC_ELECTION_DATES_URL);
  u.searchParams.set('api_key', apiKey);
  u.searchParams.set('office_sought', 'H');
  u.searchParams.set('election_state', seat.state);
  u.searchParams.set('election_district', fecDistrict(seat.district));
  u.searchParams.set('min_election_date', seat.since);
  u.searchParams.set('sort', 'election_date');
  u.searchParams.set('per_page', '100');
  return u.toString();
}

/** A special election, by the FEC's own code (SP, SG, SR, SGR, ...) or label. */
export function isSpecialRow(row) {
  return /^S/.test(row?.election_type_id ?? '') || /^special/i.test(row?.election_type_full ?? '');
}

/**
 * The special-election dates in one API response for one seat. The API's
 * filters are re-checked here rather than trusted, and a row that does not
 * parse is dropped, never repaired.
 *
 * @param {unknown} body the parsed JSON response
 * @param {Vacancy} seat
 * @returns {ElectionDate[] | null} null when the body is not the expected shape
 */
export function specialDatesFrom(body, seat) {
  const results = /** @type {any} */ (body)?.results;
  if (!Array.isArray(results)) return null;
  // More than one page would mean rows we did not read; treat it as a failed
  // fetch rather than record a partial list.
  if ((/** @type {any} */ (body)?.pagination?.pages ?? 1) > 1) return null;
  const seen = new Set();
  const out = [];
  for (const row of results) {
    if (!isSpecialRow(row)) continue;
    if (row.office_sought !== 'H') continue;
    if (row.election_state !== seat.state) continue;
    if (row.election_district !== fecDistrict(seat.district)) continue;
    if (!ISO_DATE.test(row.election_date ?? '') || row.election_date < seat.since) continue;
    if (!TYPE_CODE.test(row.election_type_id ?? '')) continue;
    const key = `${row.election_date}|${row.election_type_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date: row.election_date, type: row.election_type_id });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
}

/**
 * This run's file: one entry per seat still vacant, keyed by slug. A seat
 * whose fetch failed keeps its previous entry unchanged (old `checked` and
 * all); a seat with no previous entry and a failed fetch is left out, so the
 * page says nothing rather than something unchecked. A seat that is no longer
 * vacant drops off.
 *
 * @param {Vacancy[]} vacancies data/vacancies.json as this run wrote it
 * @param {Map<string, ElectionDate[] | null>} fetched slug -> dates, or null on failure
 * @param {Record<string, SeatElections>} prev the committed file
 * @param {string} today YYYY-MM-DD
 * @returns {Record<string, SeatElections>}
 */
export function buildSpecialElections(vacancies, fetched, prev, today) {
  /** @type {Record<string, SeatElections>} */
  const out = {};
  for (const seat of [...vacancies].sort((a, b) => seatSlug(a).localeCompare(seatSlug(b)))) {
    const slug = seatSlug(seat);
    const dates = fetched.get(slug);
    if (Array.isArray(dates)) out[slug] = { checked: today, dates };
    else if (prev?.[slug]) out[slug] = prev[slug];
  }
  return out;
}
